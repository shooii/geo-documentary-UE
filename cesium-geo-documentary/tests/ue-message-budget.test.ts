import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  UI_INTERACTION_MAX_UTF16, ENVELOPE_BUDGET_UTF16, UiInteractionTooLargeError,
  buildEnvelope, envelopeLength, assertUiInteractionSize, captureBatches
} from '../apps/ue-player/message-budget.js';
import { frameAt } from '../apps/ue-player/presentation.js';

const pad = (length: number) => 'x'.repeat(length);

test('数据通道上限是 uint16：65535 通过，65536 立即失败', () => {
  assert.equal(UI_INTERACTION_MAX_UTF16, 65535);
  const exact = { type: 'geo-video-ue', version: 1, requestId: 'r', action: 'get-status', blob: '' };
  const overhead = envelopeLength({ ...exact, blob: '' });
  const fitted = { ...exact, blob: pad(UI_INTERACTION_MAX_UTF16 - overhead) };
  assert.equal(envelopeLength(fitted), 65535);
  assert.doesNotThrow(() => assertUiInteractionSize(fitted));
  const overflowing = { ...exact, blob: pad(UI_INTERACTION_MAX_UTF16 - overhead + 1) };
  assert.equal(envelopeLength(overflowing), 65536);
  assert.throws(() => assertUiInteractionSize(overflowing), error =>
    error instanceof UiInteractionTooLargeError && error.length === 65536 && error.limit === 65535);
});

test('长度按 UTF-16 码元计，emoji 与生僻字各算两个', () => {
  assert.equal(envelopeLength({ v: '\u{1F600}' }), '{"v":"\u{1F600}"}'.length);
  assert.equal('\u{1F600}'.length, 2);
  assert.equal(envelopeLength({ v: '𠀾' }), 2 + '{"v":""}'.length);
  // 用代理对把长度推到上限之上，按 Unicode 码点计数会低估而误放行。
  const overhead = envelopeLength({ type: 'geo-video-ue', version: 1, requestId: 'r', action: 'capture-batch', frames: [] });
  const frame = '\u{1F600}'.repeat(Math.ceil((UI_INTERACTION_MAX_UTF16 - overhead) / 2) + 1);
  const envelope = buildEnvelope('r', 'capture-batch', { frames: [frame] });
  assert.ok(envelopeLength(envelope) > UI_INTERACTION_MAX_UTF16);
  assert.throws(() => assertUiInteractionSize(envelope), UiInteractionTooLargeError);
});

test('拆包预算按完整 envelope 计，每批都带 type/action/requestId 且不超 60000', () => {
  assert.equal(ENVELOPE_BUDGET_UTF16, 60_000);
  const ids = ['req-1', 'req-2', 'req-3', 'req-4'];
  let cursor = 0;
  const batches = [...captureBatches(10, i => ({ i, text: pad(9_000) }), () => ids[cursor++]!)];
  assert.ok(batches.length >= 2, '10×9000 字符必须被拆开');
  const sent: number[] = [];
  for (const batch of batches) {
    const envelope = buildEnvelope(batch.requestId, 'capture-batch', { frames: batch.frames });
    const length = envelopeLength(envelope);
    assert.equal(envelope.type, 'geo-video-ue');
    assert.equal(envelope.action, 'capture-batch');
    assert.ok(batch.requestId.startsWith('req-'), '每批独立 requestId');
    assert.ok(length <= ENVELOPE_BUDGET_UTF16, `批次 ${length} 超过预算`);
    for (const frame of batch.frames as { i: number }[]) sent.push(frame.i);
  }
  assert.deepEqual(sent, Array.from({ length: 10 }, (_, i) => i), '顺序不变、不丢帧、不重复');
});

test('接近英利 27 村 return 的长浮点批次不再触发回绕', () => {
  // 真实故障：回卷开始 563.84s、27 个村名 scale 从 0.9 变成长浮点。16 帧完整 JSON
  // 共 69588 字符，uint16 回绕成 4052，UE 只读到截断 JSON 后静默丢弃整批。
  // 这里用同样形态的 27 站长中文村名 + 长浮点相机，交给真实的 frameAt 生成帧。
  const cameraPreset = { longitude: 109.91234567890123, latitude: 20.31234567890123, height: 5123.456789012345, heading: 182.34567890123, pitch: -63.987654321 };
  const scene = { region: { cameraPreset, villageFill: '#339933' } };
  const stops = Array.from({ length: 27 }, (_, i) => ({
    id: `英利镇第${String(i + 1).padStart(2, '0')}村民委员会`,
    start: i * 9.77, end: i * 9.77 + 8.63, flightDuration: 3.25,
    cameraPreset: { ...cameraPreset, longitude: cameraPreset.longitude + i * 0.00789123456789, height: cameraPreset.height - i * 9.123456789 }
  }));
  const base = Number(stops.at(-1)!.end) + 0.5;
  const frames = Array.from({ length: 16 }, (_, i) => ({
    ...frameAt(scene, stops, base + i / 30, 'portrait', 4.4),
    subtitleBounds: null
  }));
  const raw = frames.reduce((sum, frame) => sum + JSON.stringify(frame).length, 0);
  assert.ok(raw > UI_INTERACTION_MAX_UTF16, `旧实现必然回绕的批次（实际 ${raw} 字符）`);
  assert.equal(Object.keys(frames[0]!.labels).length, 27, '必须覆盖 27 个村名的真实长浮点批次');
  assert.ok(Object.values(frames[0]!.labels).every(label => String(label.scale).length > 10), '回卷比例必须是长浮点');
  let cursor = 0;
  const batches = [...captureBatches(frames.length, i => frames[i]!, () => `b${cursor++}`)];
  assert.ok(batches.length >= 2, '超过 65535 的批次必须被拆开');
  const seen: number[] = [];
  for (const batch of batches) {
    const length = envelopeLength(buildEnvelope(batch.requestId, 'capture-batch', { frames: batch.frames }));
    assert.ok(length <= ENVELOPE_BUDGET_UTF16 && length <= UI_INTERACTION_MAX_UTF16, `批次 ${length}`);
    seen.push(...(batch.frames as { time: number }[]).map(frame => frame.time));
  }
  assert.deepEqual(seen, frames.map(frame => frame.time), '拆包后顺序与帧全集完全一致');
});

test('完整 envelope 恰好 60000 通过，多一个码元立即报错', () => {
  const id = '00000000-0000-4000-8000-000000000000';
  const overhead = envelopeLength(buildEnvelope(id, 'capture-batch', { frames: [{ text: '' }] }));
  const exact = { text: pad(ENVELOPE_BUDGET_UTF16 - overhead) };
  const batches = [...captureBatches(2, () => exact, () => id)];
  assert.equal(batches.length, 2, '第二帧连同逗号必须拆到下一包');
  for (const batch of batches) assert.equal(envelopeLength(buildEnvelope(batch.requestId, 'capture-batch', { frames: batch.frames })), 60000);
  assert.throws(() => [...captureBatches(1, () => ({ text: exact.text + 'x' }), () => id)], UiInteractionTooLargeError);
});

test('转义后的 JSON 长度和长 requestId 都计入拆包预算', () => {
  const id = 'request-'.repeat(100);
  const frame = { text: '\\"\\n\\t'.repeat(4000) };
  const batches = [...captureBatches(5, () => frame, () => id)];
  assert.ok(batches.length > 1);
  for (const batch of batches) assert.ok(envelopeLength(buildEnvelope(batch.requestId, 'capture-batch', { frames: batch.frames })) <= 60000);
  assert.deepEqual(batches.flatMap(batch => batch.frames), Array(5).fill(frame));
  assert.deepEqual([...captureBatches(0, () => assert.fail('空批次不生成帧'), () => assert.fail('空批次不创建 requestId'))], []);
});

test('单帧自身超预算时快速报错，不发出半批', () => {
  let consumed = 0;
  const iterator = captureBatches(3, () => { consumed++; return { text: pad(ENVELOPE_BUDGET_UTF16) }; }, () => 'only');
  assert.throws(() => iterator.next(), error => error instanceof UiInteractionTooLargeError && error.limit === ENVELOPE_BUDGET_UTF16);
  assert.equal(consumed, 1, '第一帧就判定超限，不做后续组合');
});

test('client 的 send 硬校验上限，renderBatch 使用 envelope 预算而非字符累加', async () => {
  const source = await readFile(new URL('../apps/ue-player/client.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /MAX_MESSAGE/);
  // 旧的 120000 字符预算已删除；仅 waitForStream 的默认超时可保留同值数字。
  const batch = source.slice(source.indexOf('renderBatch: async'), source.indexOf('seek: async'));
  assert.doesNotMatch(batch, /120_000|120000|JSON\.stringify\(frame\)\.length/);
  assert.match(source, /assertUiInteractionSize\(envelope\)/);
  assert.match(source, /captureBatches\(times\.length/);
  assert.match(batch, /send\('capture-batch', \{ frames: batch\.frames \}, batch\.requestId\)/);
  // send 必须在发送前就拒绝超限消息，而不是把 Promise 挂在超时上。
  const send = source.slice(source.indexOf('function send('), source.indexOf('function draw('));
  assert.ok(send.indexOf('assertUiInteractionSize') < send.indexOf('emitUIInteraction'));
  assert.match(send, /reject\(error as Error\); return;/);
});
