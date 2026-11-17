import { readFile, mkdir, readdir, copyFile, writeFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { chromium } from 'playwright';
import sharp from 'sharp';
import ffmpeg from 'ffmpeg-static';

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
  await mkdir(dirname(output), { recursive: true });
  await mkdir(output); // 独立槽：已有目录直接失败，不覆盖任何旧图。
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
  const playerAsset = { path: join(publicRoot, 'player.js'), sha256: createHash('sha256').update(playerBytes).digest('hex'), sourceMtime: (await stat(join(root, 'apps/ue-player/public/player.js'))).mtime.toISOString(), compiledInQa: phase === 'after' };
  const projectPath = resolve(root, option('project', 'workspace/projects/project-mw9i0ssu.v000013.json'));
  const project = JSON.parse(await readFile(projectPath, 'utf8'));
  const runtime = JSON.parse((await readFile(join(root, 'workspace/ue-runtime.json'), 'utf8')).replace(/^\uFEFF/, ''));
  const region = option('region', '440882112');
  const width = Number(option('width', '1080')), height = Number(option('height', '1920'));
  const returnDuration = Number(option('return-duration', '4.4'));
  let cursor = 0;
  const stops = project.scenes.filter((scene: any) => scene.section === 'child' && scene.childId && scene.camera).map((scene: any) => {
    const duration = Math.max(.001, Number(scene.duration) || .001);
    const start = cursor; cursor += duration;
    return { id: scene.childId, name: scene.childName || scene.title, start, end: cursor,
      flightDuration: Math.min(4.2, Math.max(3.2, duration - Number(scene.timing?.mapHoldSeconds || 0))),
      cameraPreset: scene.camera, cameraProfiles: { portrait: scene.camera } };
  });
  if (!stops.length) throw new Error('项目无可捕获的巡游站点');
  const focus = stops[Math.min(5, stops.length - 1)]!;
  const samples: { name: string; time: number; subtitleBounds?: { left: number; top: number; right: number; bottom: number }; annotationWindows?: { sceneId: string; start: number; end: number }[] }[] = [
    { name: 'tour-near', time: focus.start + focus.flightDuration + .9 },
    { name: 'tour-mid', time: focus.start + focus.flightDuration * .5 },
    { name: 'closing-mid', time: cursor + returnDuration * .5 },
    { name: 'closing-end', time: cursor + returnDuration }
  ];
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
    if (![start, end].every(value => value !== undefined && Number.isFinite(value)) || end! <= start!) throw new Error('--annotation-window需提供start,end两个递增秒数');
    const probeTime = Number(option('annotation-time', String(start! + 1)));
    samples.push({ name: 'annotation-on', time: probeTime, annotationWindows: [{ sceneId: 'probe', start: start!, end: end! }] });
    samples.push({ name: 'annotation-off', time: probeTime, annotationWindows: [] });
  }
  const imageryProvider = option('imagery', 'tianditu-imagery');
  const manifest: any = { phase, region, project: projectPath, imagery: imageryProvider, width, height, playerAsset,
    createdAt: new Date().toISOString(), tourEnd: cursor, returnDuration, stops, samples: [], status: 'running' };
  const saveManifest = () => writeFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2));
  await saveManifest();
  const port = await usablePort(Number(option('port', '5674')));
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
    await page.goto(`http://127.0.0.1:${port}/?region=${region}&profile=portrait&imagery=${imageryProvider}&capture=1`);
    await page.waitForFunction(() => Boolean((window as any).geoVideo?.getDiagnostics().ready), {}, { timeout: 240000 });
    await page.evaluate(payload => (window as any).geoVideo.prepareStudioTour(payload), { tourStops: stops, returnDuration });
    for (const sample of samples) {
      if (sample.subtitleBounds) await page.evaluate(payload => (window as any).geoVideo.setSubtitleWindows([{ start: payload.time, end: payload.time + .01, bounds: payload.subtitleBounds }]), sample);
      if (sample.annotationWindows) {
        await page.evaluate(windows => (window as any).geoVideo.setAnnotationWindows(windows), sample.annotationWindows);
        if (sample.annotationWindows.length > 0) {
          // 注记瓦片是异步 HTTP 队列：开关切换后立即截图会拍到"瓦片还在路上"的
          // 空注记层。等一拍让队列落地（真实预览持续渲染，不存在这个问题）。
          await page.waitForTimeout(2500);
          // 再渲染一次同样本帧，让新到的注记瓦片有机会贴到网格上。
          await page.evaluate(time => (window as any).geoVideo.renderFrame(time), sample.time).catch(() => undefined);
          await page.waitForTimeout(800);
        }
      }
      const previous = new Set(await readdir(frames));
      for (let attempt = 1; ; attempt++) {
        try { await page.evaluate(time => (window as any).geoVideo.renderFrame(time), sample.time); break; }
        catch (error) { if (attempt >= 4) throw error; await page.evaluate(() => (window as any).geoVideo?.waitForStream?.(60000)); }
      }
      let added: string[] = [];
      await until(async () => { added = (await readdir(frames)).filter(name => /^frame-\d{6}\.png$/.test(name) && !previous.has(name)); return added.length > 0; }, 60000, 'UE未输出截图文件');
      const file = `${sample.name}.png`;
      await copyFile(join(frames, added.sort().at(-1)!), join(output, file));
      const renderer = await page.evaluate(() => (window as any).geoVideo.getRendererStatus()).catch(() => null);
      manifest.samples.push({ ...sample, file, sourceFrame: added.at(-1), renderer });
      await saveManifest();
      console.log(`已捕获 ${phase} ${sample.name} t=${sample.time.toFixed(3)}`);
    }
    manifest.status = 'complete';
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
