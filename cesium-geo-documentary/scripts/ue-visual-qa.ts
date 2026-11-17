import { readFile, mkdir, readdir, copyFile, writeFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { chromium } from 'playwright';
import sharp from 'sharp';
import { parseSrt, type RenderSpec } from '../packages/render-spec/index.js';
import { assertTourPlanExportable } from '../packages/render-spec/tour-plan.js';
import ffmpeg from 'ffmpeg-static';
import { hostname, platform, arch, cpus } from 'node:os';
import { performance } from 'node:perf_hooks';
import { buildQaSampling, captureMetrics, comparableRuns, identity, mapQaSamples, qaClock, qaProfileSupport, targetShapes, type QaProfile, type QaSample } from './ue-visual-qa-plan.js';

const root = resolve(process.cwd());
const args = process.argv.slice(2);
function option(name: string, fallback: string) {
  const inline = args.find(arg => arg.startsWith(`--${name}=`));
  const index = args.indexOf(`--${name}`);
  return inline?.slice(name.length + 3) ?? (index >= 0 ? args[index + 1] : undefined) ?? fallback;
}
// 复用现有服务，但禁用其启动时写入player.js的构建；不改动源文件。
if (args.includes('--serve-existing')) {
  const source = join(root, 'apps/ue-player/server.ts');
  let code = await readFile(source, 'utf8');
  code = code.replace(/^await build\([^\n]+\);\r?\n/m, '');
  if (process.env.UE_QA_PUBLIC_ROOT) code = code.replace("const publicRoot = resolve(root, 'apps/ue-player/public');", `const publicRoot = ${JSON.stringify(process.env.UE_QA_PUBLIC_ROOT)};`);
  code = code.replace(/from '(\.[^']+)'/g, (_match, specifier: string) => {
    const target = resolve(dirname(source), specifier.replace(/\.js$/, '.ts'));
    return `from '${pathToFileURL(target).href}'`;
  });
  const { transform } = await import('esbuild');
  const result = await transform(code, { loader: 'ts', format: 'esm', target: 'es2022' });
  // data:模块无法从磁盘解析裸包名，因此将实际依赖解析为绝对文件URL。
  const executable = result.code.replace(/from "([^".][^"]*)"/g, (match, specifier: string) => {
    if (specifier.startsWith('node:') || specifier.startsWith('file:')) return match;
    return `from ${JSON.stringify(import.meta.resolve(specifier))}`;
  });
  await import(`data:text/javascript;base64,${Buffer.from(executable).toString('base64')}`);
} else {
  await run();
}

async function run() {
  const phase = option('phase', 'before');
  if (!['before', 'after'].includes(phase)) throw new Error('--phase仅支持before或after');
  const output = resolve(root, option('output', `outputs/visual-qa/${phase}`));
  const projectOption = option('project', '');
  if (!projectOption) throw new Error('请用--project显式选择正式job对应的项目快照');
  const projectPath = resolve(root, projectOption);
  const project = JSON.parse(await readFile(projectPath, 'utf8'));
  const region = option('region', project.regionId);
  const frozenSpecPath = option('render-spec', '');
  const measuredCuesPath = option('cues', '');
  const timingSource = frozenSpecPath ? 'frozen-render-spec' : measuredCuesPath ? 'measured-cues' : 'estimated';
  if (args.includes('--formal') && timingSource === 'estimated') throw new Error('正式QA必须提供--render-spec或--cues实测文件，不接受估算计划');
  const spec: RenderSpec = frozenSpecPath
    ? JSON.parse(await readFile(resolve(root, frozenSpecPath), 'utf8'))
    : await (await import('../apps/studio/project-service.js')).buildProjectRenderSpec(root, project, measuredCuesPath ? parseSrt(await readFile(resolve(root, measuredCuesPath), 'utf8')) : undefined);
  if (spec.projectId !== project.id || spec.projectRevision !== project.revision || spec.regionId !== region) throw new Error('QA计划与项目快照的ID、修订或区域不一致');
  if (!spec.tourPlan) throw new Error('冻结RenderSpec缺少共享巡游计划，请重新导出');
  if (args.includes('--formal') || (timingSource !== 'estimated' && !args.includes('--plan-only'))) assertTourPlanExportable(spec.tourPlan);
  const profile = option('profile', spec.output.profile);
  if (!['portrait', 'landscape', 'square'].includes(profile)) throw new Error('--profile仅支持portrait/landscape/square');
  const width = Number(option('width', String(profile === spec.output.profile ? spec.output.width : profile === 'landscape' ? 1920 : 1080)));
  const height = Number(option('height', String(profile === spec.output.profile ? spec.output.height : profile === 'portrait' ? 1920 : 1080)));
  if (![width, height].every(value => Number.isInteger(value) && value > 0)) throw new Error('截图尺寸必须为正整数');
  const returnDuration = Number(option('return-duration', String(spec.outro.duration)));
  if (frozenSpecPath && returnDuration !== spec.outro.duration) throw new Error('冻结计划不允许覆盖收尾时长');
  const stops = spec.tourPlan.tourStops;
  const cursor = stops.at(-1)?.end ?? 0;
  if (!stops.length) throw new Error('项目无可捕获的巡游站点');
  const focus = stops[Math.min(5, stops.length - 1)]!;
  const geometryPath = option('geometry', '');
  const geometry = geometryPath ? JSON.parse(await readFile(resolve(root, geometryPath), 'utf8')) : null;
  const plannedRegion = { openingDescent: { enabled: spec.opening.descentSeconds > 0, seconds: spec.opening.descentSeconds } };
  const sampling = buildQaSampling(spec.tourPlan, returnDuration, geometry ? targetShapes(geometry) : [], plannedRegion);
  const profileSupport = qaProfileSupport(spec.tourPlan, profile as QaProfile);
  if (profileSupport.status === 'unsupported' && !args.includes('--plan-only')) throw new Error(`画幅${profile} unsupported：缺少冻结相机${profileSupport.missingStopIds.join('、')}`);
  const samples: QaSample[] = [...sampling.samples];
  const customTimes = option('times', '');
  if (customTimes) samples.splice(0, samples.length, ...customTimes.split(',').map((time, i) => ({ name: `custom-${i}`, time: Number(time) })));
  if (samples.some(sample => !Number.isFinite(sample.time) || sample.time < 0)) throw new Error('截图时间必须为非负有限数');
  const subtitleOption = option('subtitle-bounds', '');
  if (subtitleOption) {
    const [left, top, right, bottom] = subtitleOption.split(',').map(Number);
    if (![left, top, right, bottom].every(value => value !== undefined && Number.isFinite(value)) || left! < 0 || top! < 0 || right! > 1 || bottom! > 1 || left! >= right! || top! >= bottom!) throw new Error('--subtitle-bounds需提供有效归一化矩形left,top,right,bottom');
    samples.push({ name: 'tour-near-subtitle', time: focus.start + focus.flightDuration + .9, subtitleBounds: { left: left!, top: top!, right: right!, bottom: bottom! } });
  }
  // 注记层验收：同一个时间点各出一张「开注记 / 关注记」，像素差异就是这一层画上去的
  // 内容。没有这个对照，一张"看起来没变化"的图无法区分"没启用"和"启用但没画"。
  const annotationWindow = option('annotation-window', '');
  if (annotationWindow) {
    const [start, end] = annotationWindow.split(',').map(Number);
    if (![start, end].every(value => value !== undefined && Number.isFinite(value)) || start! < 0 || end! <= start!) throw new Error('--annotation-window需提供start,end两个递增秒数');
    const probeTime = Number(option('annotation-time', String(start! + 1)));
    samples.push({ name: 'annotation-on', time: probeTime, annotationWindows: [{ sceneId: 'probe', start: start!, end: end! }] });
    samples.push({ name: 'annotation-off', time: probeTime, annotationWindows: [] });
  }
  if (samples.some(sample => !Number.isFinite(sample.time) || sample.time < 0)) throw new Error('截图时间必须为非负有限数');
  const imageryProvider = option('imagery', 'tianditu-imagery');
  if (!['tianditu-imagery', 'tianditu-vector'].includes(imageryProvider)) throw new Error('QA截图只允许现有天地图影像或矢量代理');
  const portOption = Number(option('port', '5674'));
  if (!Number.isInteger(portOption) || portOption < 1 || portOption > 65233) throw new Error('--port必须为1到65233的整数');
  samples.splice(0, samples.length, ...mapQaSamples(samples, sampling.clock));
  await mkdir(dirname(output), { recursive: true });
  await mkdir(output); // 校验通过后排他创建，不覆盖已有目录。
  await writeFile(join(output, 'tour-plan.json'), JSON.stringify(spec.tourPlan, null, 2), 'utf8');
  const manifest: any = { phase, region, project: projectPath, projectId: spec.projectId, projectRevision: spec.projectRevision,
    timingSource, formalParity: false, parity: { status: 'not-measured', reason: '计划输入不等于运行场景；真实scene仍由实时接口加载，且没有正式合成字幕覆盖证据' }, sceneSource: 'live-api/scene', sceneIdentity: null, profileSupport, renderSpecPath: frozenSpecPath || null, measuredCuesPath: measuredCuesPath || null, profile, imagery: imageryProvider, width, height,
    planIdentity: identity(spec.tourPlan), renderSpecIdentity: identity(spec), cacheSignature: spec.cacheSignature,
    samplingIdentity: identity(samples), geometryPath: geometryPath || null, geometryIdentity: geometry ? identity(geometry) : null, frozenGeometrySignature: spec.geometrySignature,
    machine: { id: identity({ host: hostname(), platform: platform(), arch: arch(), cpu: cpus()[0]?.model }), platform: platform(), arch: arch(), cpu: cpus()[0]?.model },
    clock: { map: '共享tourPlan秒坐标（已含narrationOffsetSeconds，不重复加偏移）', capture: 'mapTime + 实际场景descentSeconds', ...sampling.clock, source: 'render-spec-planned-not-measured', wall: 'UTC ISO-8601', elapsed: 'node performance.now 单调毫秒' },
    coverage: { ...sampling.coverage, sceneParity: 'not-measured', subtitleOverlay: 'not-measured' }, measurement: captureMetrics(null), formalGate: { status: 'not-measured', reason: '尚无截图、逐帧p95/p99、UE内存和三画幅人工验收证据' },
    createdAt: new Date().toISOString(), tourEnd: cursor, returnDuration, stops, plannedSamples: samples,
    matrix: sampling.matrix.map(item => ({ ...item, samples })), samples: [], status: args.includes('--plan-only') ? 'planned' : 'running' };
  const saveManifest = () => writeFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2));
  await saveManifest();
  if (args.includes('--plan-only')) return;
  const runtime = JSON.parse((await readFile(join(root, 'workspace/ue-runtime.json'), 'utf8')).replace(/^\uFEFF/, ''));
  const frames = join(output, 'frames');
  await mkdir(frames);
  const publicRoot = join(output, 'player');
  await mkdir(publicRoot);
  await copyFile(join(root, 'apps/ue-player/public/index.html'), join(publicRoot, 'index.html'));
  if (phase === 'after') {
    const { build } = await import('esbuild');
    await build({ entryPoints: [join(root, 'apps/ue-player/client.ts')], outfile: join(publicRoot, 'player.js'), bundle: true, format: 'esm', sourcemap: true, target: 'es2022' });
  } else await copyFile(join(root, 'apps/ue-player/public/player.js'), join(publicRoot, 'player.js'));
  const playerBytes = await readFile(join(publicRoot, 'player.js'));
  manifest.playerAsset = { path: join(publicRoot, 'player.js'), sha256: createHash('sha256').update(playerBytes).digest('hex'), sourceMtime: (await stat(join(root, 'apps/ue-player/public/player.js'))).mtime.toISOString(), compiledInQa: phase === 'after' };
  const engineBinary = join(runtime.engineRoot, 'Engine/Binaries/Win64/UnrealEditor.exe');
  const projectBinary = join(dirname(runtime.project), 'Binaries/Win64/UnrealEditor-GeoDocumentary.dll');
  const binaryIdentity = async (path: string) => ({ path, sha256: createHash('sha256').update(await readFile(path)).digest('hex') });
  manifest.runtimeAssets = { engine: await binaryIdentity(engineBinary), project: await binaryIdentity(projectBinary).catch(() => ({ path: projectBinary, status: 'not-measured' })), projectConfig: await binaryIdentity(runtime.project) };
  manifest.runPackageIdentity = identity({ player: manifest.playerAsset.sha256, runtime: manifest.runtimeAssets, plan: manifest.planIdentity });
  await saveManifest();
  const port = await usablePort(portOption);
  const signallingPort = port + 1, streamerPort = port + 2;
  const children: ChildProcess[] = [];
  const launch = (exe: string, argv: string[], env: NodeJS.ProcessEnv = {}) => {
    const child = spawn(exe, argv, { cwd: root, windowsHide: true, stdio: 'ignore', env: { ...process.env, ...env, GEO_ACCESS_LOG: '' } });
    children.push(child);
    child.on('error', () => { manifest.processFailure = '子进程启动失败，请检查本地运行依赖'; });
    return child;
  };
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let cleaning: Promise<void> | undefined;
  const cleanup = () => cleaning ??= (async () => {
    await browser?.close().catch(() => {});
    for (const child of [...children].reverse()) {
      if (child.exitCode !== null || child.signalCode !== null || !child.pid) continue;
      if (process.platform === 'win32') {
        // 仅清理脚本创建的PID及其子树，不按镜像名结束其他UE实例。
        await new Promise<void>(done => {
          const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
          killer.once('error', () => done()); killer.once('exit', () => done());
        });
      } else child.kill('SIGTERM');
    }
  })();
  const interrupt = () => { void cleanup().finally(() => process.exit(130)); };
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  try {
    const tsx = join(root, 'node_modules/tsx/dist/cli.mjs');
    launch(process.execPath, [tsx, join(root, 'apps/ue-player/signalling.ts')], { UE_SIGNALLING_PORT: String(signallingPort), UE_STREAMER_PORT: String(streamerPort) });
    launch(process.execPath, [tsx, join(root, 'scripts/ue-visual-qa.ts'), '--serve-existing', `--port=${port}`], { UE_SIGNALLING_URL: `ws://127.0.0.1:${signallingPort}`, UE_QA_PUBLIC_ROOT: publicRoot });
    await until(async () => { try { return (await fetch(`http://127.0.0.1:${port}/runtime-config.json`)).ok; } catch { return false; } }, 30000, '本地播放器启动超时');
    // 只检查代理返回的影像响应，不读取或打印任何凭证。
    const test = await fetch(`http://127.0.0.1:${port}/api/imagery/${imageryProvider}/0/0/0?session=visual-qa`);
    if (!test.ok) throw new Error(`天地图本地代理不可用（HTTP ${test.status}），请检查已有本地天地图配置或网络`);
    await test.arrayBuffer();
    const unrealLog = join(output, 'unreal.log');
    const unreal = launch(join(runtime.engineRoot, 'Engine/Binaries/Win64/UnrealEditor.exe'), [runtime.project, '/Engine/Maps/Entry', '-game', '-RenderOffscreen', '-Unattended', '-NoSplash', '-AudioMixer',
      `-PixelStreamingURL=ws://127.0.0.1:${streamerPort}`, `-GeoCaptureRoot=${frames}`, `-ResX=${width}`, `-ResY=${height}`, '-ForceRes', `-abslog=${unrealLog}`]);
    await until(async () => {
      if (unreal.exitCode !== null) throw new Error(`UE启动失败，退出码${unreal.exitCode}`);
      const log = await readFile(unrealLog, 'utf8').catch(() => '');
      return log.includes(`Websocket connection made to ws://127.0.0.1:${streamerPort}`) || log.includes(`Websocket connection made to: ws://127.0.0.1:${streamerPort}`);
    }, 240000, 'UE串流启动超时');
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width, height } });
    // 记录浏览器镜头计算实际使用的实时scene；UE另行加载几何，正式场景一致性仍未实测。
    let loadedScene: any;
    await page.route('**/api/scene?*', async route => {
      if (!loadedScene) {
        const response = await route.fetch();
        if (!response.ok()) throw new Error(`QA场景读取失败${response.status()}`);
        loadedScene = await response.json();
      }
      await route.fulfill({ json: loadedScene });
    });
    await page.goto(`http://127.0.0.1:${port}/?region=${encodeURIComponent(region)}&profile=${profile}&imagery=${imageryProvider}&capture=1`);
    await page.waitForFunction(() => Boolean((window as any).geoVideo?.getDiagnostics().ready), {}, { timeout: 240000 });
    const actualClock = qaClock(loadedScene.region, returnDuration || 4.4, cursor);
    for (const sample of samples) {
      if (sample.name === 'closing-mid') sample.time = actualClock.returnStart + actualClock.returnSeconds / 2;
      if (sample.name === 'closing-end') sample.time = actualClock.returnStart + actualClock.returnSeconds;
    }
    samples.splice(0, samples.length, ...mapQaSamples(samples, actualClock));
    manifest.clock = { ...manifest.clock, ...actualClock, source: 'actual-loaded-scene' };
    manifest.sceneIdentity = identity({ region: loadedScene.region, layers: loadedScene.layers, context: loadedScene.context });
    manifest.samplingIdentity = identity(samples);
    await saveManifest();
    await page.evaluate(payload => (window as any).geoVideo.prepareStudioTour(payload), { tourStops: stops, returnDuration, parentCamera: spec.tourPlan.parentCamera });
    await page.evaluate(windows => (window as any).geoVideo.setAnnotationWindows(windows), spec.annotationWindows);
    await page.evaluate(windows => (window as any).geoVideo.setSubtitleWindows(windows), []);
    for (const sample of samples) {
      if (sample.subtitleBounds) await page.evaluate(payload => (window as any).geoVideo.setSubtitleWindows([{ start: payload.captureTime!, end: payload.captureTime! + .01, bounds: payload.subtitleBounds }]), sample);
      if (sample.annotationWindows) {
        await page.evaluate(windows => (window as any).geoVideo.setAnnotationWindows(windows), sample.annotationWindows);
        if (sample.annotationWindows.length > 0) {
          // 注记瓦片是异步 HTTP 队列：开关切换后立即截图会拍到"瓦片还在路上"的
          // 空注记层。等一拍让队列落地（真实预览持续渲染，不存在这个问题）。
          await page.waitForTimeout(2500);
          // 再渲染一次同样本帧，让新到的注记瓦片有机会贴到网格上。
          await page.evaluate(time => (window as any).geoVideo.renderFrame(time), sample.captureTime!).catch(() => undefined);
          await page.waitForTimeout(800);
        }
      }
      const captureStartedAt = new Date().toISOString();
      const captureStarted = performance.now();
      const previous = new Set(await readdir(frames));
      for (let attempt = 1; ; attempt++) {
        try { await page.evaluate(time => (window as any).geoVideo.renderFrame(time), sample.captureTime!); break; }
        catch (error) { if (attempt >= 4) throw error; await page.evaluate(() => (window as any).geoVideo?.waitForStream?.(60000)); }
      }
      let added: string[] = [];
      await until(async () => { added = (await readdir(frames)).filter(name => /^frame-\d{6}\.png$/.test(name) && !previous.has(name)); return added.length > 0; }, 60000, 'UE未输出截图文件');
      const file = `${sample.name}.png`;
      await copyFile(join(frames, added.sort().at(-1)!), join(output, file));
      const renderer = await page.evaluate(() => (window as any).geoVideo.getRendererStatus()).catch(() => null);
      const image = await sharp(join(output, file)).metadata();
      manifest.samples.push({ ...sample, file, sourceFrame: added.sort().at(-1),
        coordinates: { mapTimeSeconds: sample.time, captureTimeSeconds: sample.captureTime, pixelOrigin: 'top-left', width: image.width, height: image.height, subtitleBounds: sample.subtitleBounds ?? null },
        captureStartedAt, captureFinishedAt: new Date().toISOString(), captureRoundTripMs: performance.now() - captureStarted,
        screenshotSha256: createHash('sha256').update(await readFile(join(output, file))).digest('hex'),
        metrics: captureMetrics(renderer), renderer });
      await saveManifest();
      console.log(`已捕获 ${phase} ${sample.name} t=${sample.time.toFixed(3)}`);
    }
    manifest.status = 'complete';
    manifest.formalGate = { status: 'not-measured', reason: '已捕获当前画幅；现有UE接口只提供平滑帧时，缺逐帧p95/p99、进程内存与三画幅人工验收证据' };
    await saveManifest();
    if (phase === 'after') await comparison(output, option('before', 'outputs/visual-qa/before'));
  } catch (error) {
    manifest.status = 'failed'; manifest.error = error instanceof Error ? error.message : '视觉验收失败';
    await saveManifest(); throw error;
  } finally {
    await cleanup(); process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
  }
}
async function until(check: () => Promise<boolean>, timeout: number, message: string) {
  const deadline = Date.now() + timeout;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise(done => setTimeout(done, 250));
  }
}
async function usablePort(start: number) {
  const free = (port: number) => new Promise<boolean>(done => {
    const server = createServer(); server.once('error', () => done(false));
    server.listen(port, '127.0.0.1', () => server.close(() => done(true)));
  });
  for (let port = start; port < start + 300; port += 3) if ((await Promise.all([0, 1, 2].map(offset => free(port + offset)))).every(Boolean)) return port;
  throw new Error('无空闲本地QA端口');
}
async function comparison(after: string, beforeOption: string) {
  const before = resolve(root, beforeOption);
  const manifest = JSON.parse(await readFile(join(after, 'manifest.json'), 'utf8'));
  const files: string[] = [];
  const baseline = JSON.parse(await readFile(join(before, 'manifest.json'), 'utf8'));
  if (!comparableRuns(baseline, manifest)) {
    await writeFile(join(after, 'comparison-gate.json'), JSON.stringify({ status: 'not-measured', reason: '仅允许同机器、同分辨率、同画幅、同RenderSpec、同几何、同实际场景、同计划、同采样与同影像来源比较' }, null, 2), { flag: 'wx' });
    return;
  }
  for (const sample of manifest.samples.filter((item: any) => baseline.samples.some((entry: any) => entry.name === item.name))) {
    const name = `comparison-${sample.name}.png`;
    const images = await Promise.all([before, after].map(directory => sharp(join(directory, sample.file)).resize(540, 960).toBuffer()));
    const header = Buffer.from('<svg width="1080" height="48"><style>text{font-family:Microsoft YaHei,sans-serif;font-size:26px;fill:white}</style><text x="270" y="33" text-anchor="middle">修改前</text><text x="810" y="33" text-anchor="middle">修改后</text></svg>');
    await sharp({ create: { width: 1080, height: 1008, channels: 3, background: '#111111' } }).composite([{ input: header, left: 0, top: 0 }, ...images.map((input, index) => ({ input, left: index * 540, top: 48 }))]).png().toFile(join(after, name));
    files.push(name);
  }
  const ffmpegPath = ffmpeg as unknown as string | null;
  if (ffmpegPath) {
    const list = join(after, 'comparison.ffconcat');
    await writeFile(list, `ffconcat version 1.0\n${files.map(file => `file '${file}'\nduration 2`).join('\n')}\nfile '${files.at(-1)}'\n`);
    await new Promise<void>((done, reject) => {
      const process = spawn(ffmpegPath, ['-n', '-safe', '0', '-i', list, '-vf', 'fps=24', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(after, 'before-after.mp4')], { windowsHide: true, stdio: 'ignore' });
      process.once('error', reject); process.once('exit', code => code === 0 ? done() : reject(new Error(`对比视频编码失败${code}`)));
    });
  }
}
