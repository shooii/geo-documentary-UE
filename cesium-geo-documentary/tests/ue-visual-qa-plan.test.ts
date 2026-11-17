import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { buildTourPlan } from '../packages/render-spec/tour-plan.js';
import { buildQaSampling, captureMetrics, comparableRuns, identity, mapQaSamples, qaClock, qaProfileSupport, targetShapes } from '../scripts/ue-visual-qa-plan.js';

const plan = buildTourPlan({ scenes: [0, 1, 2].map((index) => ({ id: `scene-${index}`, section: 'child', childId: `target-${index}`, duration: index === 1 ? 3 : 10,
  camera: { longitude: 110 + index, latitude: 30, height: 10000, heading: 0, pitch: -80 } })) });

test('采样由冻结计划确定，覆盖航段、紧预算、累计标签、收尾与三画幅', () => {
  const result = buildQaSampling(plan, 4, [{ id: 'target-0', aspectRatio: 4, polygonCount: 1 }, { id: 'target-2', aspectRatio: 1, polygonCount: 2 }]);
  assert.deepEqual(result, buildQaSampling(JSON.parse(JSON.stringify(plan)), 4, [{ id: 'target-0', aspectRatio: 4, polygonCount: 1 }, { id: 'target-2', aspectRatio: 1, polygonCount: 2 }]));
  for (const name of ['first-arrival', 'near-flight-start', 'near-flight-mid', 'near-flight-end', 'far-flight-mid', 'short-budget', 'labels-early', 'labels-middle', 'labels-late', 'target-slender', 'target-multipart', 'closing-mid', 'closing-end']) assert.ok(result.samples.some(sample => sample.name === name), name);
  assert.equal(result.samples.find(sample => sample.name === 'short-budget')?.stopId, 'target-1');
  for (const sample of result.samples.filter(item => item.stopId)) {
    const stop = plan.tourStops.find(item => item.id === sample.stopId)!;
    assert.ok(sample.time >= stop.start && sample.time <= stop.end);
  }
  assert.deepEqual(result.matrix.map(({ width, height }) => [width, height]), [[1080, 1920], [1920, 1080], [1080, 1080]]);
  assert.equal(result.samples.at(-1)?.time, plan.tourStops.at(-1)!.end + 4);
});
test('没有真实几何时不冒充已覆盖细长及多块目标', () => {
  assert.deepEqual(buildQaSampling(plan, 4).coverage, { slender: 'not-measured', multipart: 'not-measured' });
  assert.throws(() => buildQaSampling(plan, NaN));
});
test('冻结几何识别真实多块目标与细长目标', () => {
  const shapes = targetShapes({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: { id: 'a' }, geometry: { type: 'MultiPolygon', coordinates: [[[[110, 30], [111, 30], [111, 30.1], [110, 30]]], [[[110, 30], [110.1, 30], [110, 30.1], [110, 30]]]] } }] });
  assert.equal(shapes[0]?.polygonCount, 2);
  assert.ok(shapes[0]!.aspectRatio > 3);
});
test('平滑均值不能生成逐帧分位数或内存实测', () => {
  const metrics = captureMetrics({ frameMs: 16.7, fps: 60 });
  assert.equal(metrics.ueSmoothedFrameMs, 16.7);
  assert.equal(metrics.frameTimeP95.status, 'not-measured');
  assert.equal(metrics.frameTimeP99.value, null);
  assert.equal(metrics.ueMemoryBytes.status, 'not-measured');
  assert.equal(captureMetrics({ frameMs: NaN }).ueSmoothedFrameMs, null);
});
test('比较受机器、分辨率、计划、采样与影像来源约束', () => {
  const run = { machine: { id: 'machine' }, width: 1080, height: 1920, profile: 'portrait', planIdentity: 'plan', imagery: 'tianditu-imagery', samplingIdentity: 'samples', geometryIdentity: 'geometry', renderSpecIdentity: 'spec', sceneIdentity: 'scene' };
  assert.equal(comparableRuns(run, { ...run }), true);
  for (const change of [{ machine: { id: 'other' } }, { width: 1920 }, { profile: 'square' }, { planIdentity: 'other' }, { imagery: 'other' }, { samplingIdentity: 'other' }, { geometryIdentity: 'other' }, { renderSpecIdentity: 'other' }, { sceneIdentity: 'other' }, { geometryIdentity: null }]) assert.equal(comparableRuns(run, { ...run, ...change }), false);
  assert.equal(comparableRuns({}, {}), false);
  assert.equal(identity({ a: 1, b: 2 }), identity({ b: 2, a: 1 }));
});
test('region与layers相同但context变化时实际场景身份不可比', async () => {
  const source = await readFile(new URL('../scripts/ue-visual-qa.ts', import.meta.url), 'utf8');
  const assignment = source.split('\n').find(line => line.includes('manifest.sceneIdentity = identity('));
  assert.ok(assignment);
  const scene = { region: { id: 'town' }, layers: [{ id: 'children' }], context: { id: 'county', geometry: [1, 2] } };
  const sceneId = (loadedScene: unknown) => {
    const manifest = { sceneIdentity: '' };
    runInNewContext(assignment, { manifest, loadedScene, identity });
    return manifest.sceneIdentity;
  };
  const run = { machine: { id: 'machine' }, width: 1080, height: 1920, profile: 'portrait', planIdentity: 'plan', imagery: 'tianditu-imagery', samplingIdentity: 'samples', geometryIdentity: 'geometry', renderSpecIdentity: 'spec', sceneIdentity: sceneId(scene) };
  assert.equal(comparableRuns(run, { ...run, sceneIdentity: sceneId(JSON.parse(JSON.stringify(scene))) }), true);
  assert.equal(comparableRuns(run, { ...run, sceneIdentity: sceneId({ ...scene, context: { ...scene.context, geometry: [1, 3] } }) }), false);
});
test('实际场景descent映射与收尾clamp，不重复累加旁白偏移', () => {
  const clock = qaClock({ openingDescent: { seconds: .5 }, tourReturnStart: 50 }, 1, 20);
  assert.deepEqual(clock, { descentSeconds: 2, returnSeconds: 3.8, returnStart: 50 });
  assert.equal(mapQaSamples([{ name: 'probe', time: 10.35 }], clock)[0]!.captureTime, 12.35);
  assert.equal(qaClock({ openingDescent: { seconds: 90 } }, 20, 30).descentSeconds, 16);
  assert.equal(qaClock({ openingDescent: { enabled: false, seconds: 10 } }, 20, 30).descentSeconds, 0);
  const sampled = buildQaSampling(plan, 1, [], { openingDescent: { seconds: .5 }, tourReturnStart: 50 });
  assert.equal(sampled.samples.at(-1)!.time, 53.8);
  assert.equal(sampled.samples.at(-1)!.captureTime, 55.8);
});
test('缺失画幅相机明确unsupported而非假装三画幅已覆盖', () => {
  assert.equal(qaProfileSupport(plan, 'portrait').status, 'supported');
  assert.equal(qaProfileSupport(plan, 'landscape').status, 'unsupported');
  assert.equal(buildQaSampling(plan, 4).matrix.find(item => item.profile === 'square')!.status, 'unsupported');
});
test('plan-only先返回，之后才读取runtime、构建及启动UE；输出目录排他创建', async () => {
  const source = await readFile(new URL('../scripts/ue-visual-qa.ts', import.meta.url), 'utf8');
  const exit = source.indexOf("if (args.includes('--plan-only')) return;");
  assert.ok(exit > 0);
  for (const statement of ["const runtime =", "const frames =", "const playerBytes =", 'const port = await usablePort']) assert.ok(source.indexOf(statement) > exit, statement);
  assert.ok(source.includes('await mkdir(output);'));
  assert.ok(!source.includes('project-mw9i0ssu'));
  assert.ok(source.includes("formalGate: { status: 'not-measured'"));
  assert.ok(source.includes('formalParity: false'));
  assert.ok(source.indexOf("timingSource === 'estimated'") < source.indexOf('await mkdir(output)'));
});

test('plan-only在无runtime和player的目录可执行，非法输入不创建输出', async t => {
  const root = await mkdtemp(join(tmpdir(), 'qa-plan-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = fileURLToPath(new URL('..', import.meta.url));
  const script = resolve(repo, 'scripts/ue-visual-qa.ts');
  const tsx = resolve(repo, 'node_modules/tsx/dist/cli.mjs');
  const project = { id: 'qa-test', revision: 1, regionId: 'test' };
  const spec = { projectId: project.id, projectRevision: 1, regionId: 'test', output: { profile: 'portrait', width: 1080, height: 1920 },
    opening: { descentSeconds: 0 }, outro: { duration: 4 }, tourPlan: plan, geometrySignature: 'signature', annotationWindows: [] };
  await writeFile(join(root, 'project.json'), JSON.stringify(project));
  await writeFile(join(root, 'spec.json'), JSON.stringify(spec));
  const run = (argv: string[]) => spawnSync(process.execPath, [tsx, script, '--project=project.json', '--plan-only', ...argv], { cwd: root, encoding: 'utf8', timeout: 30000 });
  const result = run(['--render-spec=spec.json', '--output=valid']);
  assert.equal(result.status, 0, result.stderr);
  const manifest = JSON.parse(await readFile(join(root, 'valid/manifest.json'), 'utf8'));
  assert.equal(manifest.status, 'planned');
  assert.equal(manifest.formalParity, false);
  assert.equal(manifest.coverage.subtitleOverlay, 'not-measured');
  assert.equal(manifest.coverage.sceneParity, 'not-measured');
  assert.equal(manifest.matrix[1].status, 'unsupported');
  for (const argv of [ ['--formal'], ['--render-spec=spec.json', '--times=NaN'], ['--render-spec=spec.json', '--width=0'], ['--render-spec=spec.json', '--subtitle-bounds=0,0,2,1'], ['--render-spec=spec.json', '--imagery=invalid'] ]) {
    const invalid = run([...argv, '--output=should-not-exist']);
    assert.notEqual(invalid.status, 0, argv.join(' '));
    assert.equal(existsSync(join(root, 'should-not-exist')), false, argv.join(' '));
  }
  await mkdir(join(root, 'existing'));
  const collision = run(['--render-spec=spec.json', '--output=existing']);
  assert.notEqual(collision.status, 0);
});
