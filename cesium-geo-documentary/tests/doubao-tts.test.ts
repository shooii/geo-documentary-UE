import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DOUBAO_TTS_URL,
  DOUBAO_VOICES,
  DOUBAO_END_CODE,
  DOUBAO_MAX_TEXT_CHARS,
  DOUBAO_ALLOWED_RESOURCE_IDS,
  doubaoCredentialsFromEnvFile,
  isDoubaoVoice,
  synthesizeDoubao
} from '../packages/doubao-tts/index.js';

/** 假 key，仅用于验证脱敏；绝不接触真实 .env.local。 */
const FAKE_KEY = 'sk-TESTONLY-9f8e7d6c4b2a';
const credentials = { apiKey: FAKE_KEY };
const defaultVoice = 'doubao:zh_female_vv_uranus_bigtts';

const A1 = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00]);
const A2 = Buffer.from([0xff, 0xfb, 0x90, 0x64, 0x00, 0x0f]);

function frame(options: Record<string, unknown> = {}): Record<string, unknown> {
  return { code: 0, message: 'OK', ...options };
}

function audioFrames(): Array<Record<string, unknown>> {
  return [
    frame({
      data: A1.toString('base64'),
      sentence: {
        text: '你好，',
        words: [
          { word: '你', startTime: 0.1, endTime: 0.3, confidence: 0.91 },
          { word: '好，', startTime: 0.3, endTime: 0.6, confidence: 0.88 }
        ]
      }
    }),
    frame({
      data: A2.toString('base64'),
      sentence: {
        text: '世界。',
        words: [
          { word: '世', startTime: 0.6, endTime: 0.9, confidence: 0.9 },
          { word: '界。', startTime: 0.9, endTime: 1.25, confidence: 0.87 }
        ]
      }
    }),
    { code: DOUBAO_END_CODE, message: 'OK', data: null }
  ];
}

type FetchCall = { url: string; init: RequestInit };

function mockFetch(
  chunks: Array<Uint8Array | string>,
  meta: { status?: number; statusText?: string; headers?: Record<string, string> } = {}
): { fetchImpl: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
        }
        controller.close();
      }
    });
    return {
      ok: (meta.status ?? 200) >= 200 && (meta.status ?? 200) < 300,
      status: meta.status ?? 200,
      statusText: meta.statusText ?? 'OK',
      headers: new Headers(meta.headers ?? {}),
      body
    } as Response;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function ndjson(frames: Array<Record<string, unknown>>, trailingNewline = false): Uint8Array {
  return Buffer.from(frames.map((item) => JSON.stringify(item)).join('\n') + (trailingNewline ? '\n' : ''), 'utf8');
}

function sliceBytes(buffer: Uint8Array, size: number): Uint8Array[] {
  const result: Uint8Array[] = [];
  for (let offset = 0; offset < buffer.length; offset += size) result.push(buffer.subarray(offset, offset + size));
  return result;
}

test('音色表与识别函数：8 个官方 2.0 uranus_bigtts 音色，id 前缀 doubao:', () => {
  assert.equal(DOUBAO_VOICES.length, 8);
  for (const voice of DOUBAO_VOICES) {
    assert.ok(voice.id.startsWith('doubao:'));
    assert.ok(voice.id.endsWith('_uranus_bigtts'));
    assert.equal(isDoubaoVoice(voice.id), true);
  }
  assert.equal(isDoubaoVoice('xfyun:aisjiuxu'), false);
  assert.equal(isDoubaoVoice(undefined), false);
});

test('凭证读取：本地文件 + 真实环境变量优先，缺文件时返回 null', async () => {
  const root = await mkdtemp(join(tmpdir(), 'doubao-tts-'));
  const path = join(root, '.env.local');
  await writeFile(path, `DOUBAO_TTS_API_KEY=${FAKE_KEY}\nDOUBAO_TTS_RESOURCE_ID=seed-tts-2.0\n`, 'utf8');
  assert.deepEqual(doubaoCredentialsFromEnvFile(path, {}), { apiKey: FAKE_KEY, resourceId: 'seed-tts-2.0' });
  assert.deepEqual(doubaoCredentialsFromEnvFile(path, { DOUBAO_TTS_API_KEY: 'env-key-1234' }), {
    apiKey: 'env-key-1234',
    resourceId: 'seed-tts-2.0'
  });
  assert.equal(doubaoCredentialsFromEnvFile(join(root, 'missing'), {}), null);
});

test('成功合成：官方 url/headers/请求体、音频拼接、逐字时间、logId', async () => {
  const { fetchImpl, calls } = mockFetch(sliceBytes(ndjson(audioFrames(), true), 11), {
    headers: { 'x-tt-logid': 'log-abc-123' }
  });
  const result = await synthesizeDoubao('你好，世界。', credentials, { voice: defaultVoice, fetchImpl });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, DOUBAO_TTS_URL);
  const init = calls[0]?.init as RequestInit & { headers: Record<string, string> };
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['X-Api-Key'], FAKE_KEY);
  assert.equal(init.headers['X-Api-Resource-Id'], 'seed-tts-2.0');
  assert.match(init.headers['X-Api-Request-Id'] ?? '', /^[0-9a-f-]{36}$/);
  assert.equal(init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(String(init.body)), {
    req_params: {
      text: '你好，世界。',
      speaker: 'zh_female_vv_uranus_bigtts',
      audio_params: { format: 'mp3', sample_rate: 48000, bit_rate: 160000, speech_rate: 0, enable_subtitle: true }
    }
  });

  assert.deepEqual(result.audio, Buffer.concat([A1, A2]));
  assert.deepEqual(result.words, [
    { start: 0.1, end: 0.3, text: '你' },
    { start: 0.3, end: 0.6, text: '好，' },
    { start: 0.6, end: 0.9, text: '世' },
    { start: 0.9, end: 1.25, text: '界。' }
  ]);
  assert.equal(result.requestId, init.headers['X-Api-Request-Id']);
  assert.equal(result.logId, 'log-abc-123');
});

test('流解码：中文按 UTF-8 字节切断、无换行尾包、连续 JSON 对象都能还原', async () => {
  const textFrame = frame({
    data: A1.toString('base64'),
    sentence: { text: '汉字🌏测试', words: [{ word: '🌏', startTime: 0.2, endTime: 0.5, confidence: 0.8 }] }
  });
  const frames = [textFrame, { code: DOUBAO_END_CODE, message: 'OK', data: null }];

  const byByte = mockFetch(sliceBytes(ndjson(frames), 5));
  const first = await synthesizeDoubao('汉字测试', credentials, { voice: defaultVoice, fetchImpl: byByte.fetchImpl });
  assert.deepEqual(first.words, [{ start: 0.2, end: 0.5, text: '🌏' }]);

  const concatenated = Buffer.from(frames.map((item) => JSON.stringify(item)).join(''), 'utf8');
  const byConcat = mockFetch(sliceBytes(concatenated, 7));
  const second = await synthesizeDoubao('汉字测试', credentials, { voice: defaultVoice, fetchImpl: byConcat.fetchImpl });
  assert.deepEqual(second.audio, A1);

  // 字符串 chunk 恰好切断 emoji 的代理对。
  const json = JSON.stringify(textFrame) + '\n' + JSON.stringify(frames[1]);
  const emojiIndex = json.indexOf('\u{1f30f}');
  assert.ok(emojiIndex > 0);
  const split = emojiIndex + 1;
  const byString = mockFetch([json.slice(0, split), json.slice(split)]);
  const third = await synthesizeDoubao('汉字测试', credentials, { voice: defaultVoice, fetchImpl: byString.fetchImpl });
  assert.deepEqual(third.words, [{ start: 0.2, end: 0.5, text: '🌏' }]);
});

test('语速映射：0.5/1/2 对应 speech_rate -50/0/100，越界拒绝', async () => {
  for (const [speed, expected] of [[0.5, -50], [1, 0], [2, 100]] as const) {
    const { fetchImpl, calls } = mockFetch(sliceBytes(ndjson(audioFrames()), 9));
    await synthesizeDoubao('你好', credentials, { voice: defaultVoice, speed, fetchImpl });
    const body = JSON.parse(String((calls[0]?.init as RequestInit).body));
    assert.equal(body.req_params.audio_params.speech_rate, expected);
  }
  const { fetchImpl } = mockFetch(sliceBytes(ndjson(audioFrames()), 9));
  await assert.rejects(
    synthesizeDoubao('你好', credentials, { voice: defaultVoice, speed: 3, fetchImpl }),
    /0\.5 - 2/
  );
});

test('服务端错误：非 0/20000000 的 code 立即失败，message 中的 key 被脱敏，错误帧 data 不采纳', async () => {
  const frames = [
    audioFrames()[0]!,
    { code: 30000000, message: `鉴权失败 key=${FAKE_KEY} 请检查`, data: A2.toString('base64') },
    { code: DOUBAO_END_CODE, message: 'OK', data: null }
  ];
  const { fetchImpl } = mockFetch(sliceBytes(ndjson(frames), 8));
  await assert.rejects(
    synthesizeDoubao('你好，世界。', credentials, { voice: defaultVoice, fetchImpl }),
    (error: unknown) => {
      const message = (error as Error).message;
      assert.match(message, /30000000/);
      assert.match(message, /\[REDACTED\]/);
      assert.equal(message.includes(FAKE_KEY), false);
      return true;
    }
  );
});

test('HTTP 错误：只报状态码，不回显含 key 的 statusText/headers', async () => {
  const { fetchImpl } = mockFetch([], { status: 401, statusText: `Unauthorized ${FAKE_KEY}` });
  await assert.rejects(
    synthesizeDoubao('你好', credentials, { voice: defaultVoice, fetchImpl }),
    (error: unknown) => {
      const message = (error as Error).message;
      assert.match(message, /HTTP 401/);
      assert.equal(message.includes(FAKE_KEY), false);
      return true;
    }
  );
});

test('无逐字时间戳：默认拒绝，requireTimestamps:false 才放行', async () => {
  const frames = [frame({ data: A1.toString('base64') }), { code: DOUBAO_END_CODE, message: 'OK', data: null }];
  const first = mockFetch(sliceBytes(ndjson(frames), 7));
  await assert.rejects(
    synthesizeDoubao('你好', credentials, { voice: defaultVoice, fetchImpl: first.fetchImpl }),
    /未返回逐字时间戳/
  );
  const second = mockFetch(sliceBytes(ndjson(frames), 7));
  const result = await synthesizeDoubao('你好', credentials, {
    voice: defaultVoice,
    requireTimestamps: false,
    fetchImpl: second.fetchImpl
  });
  assert.deepEqual(result.words, []);
  assert.deepEqual(result.audio, A1);
});

test('流截断：缺少结束帧、尾包 JSON 不完整都失败', async () => {
  const noEnd = mockFetch(sliceBytes(ndjson([audioFrames()[0]!]), 10));
  await assert.rejects(
    synthesizeDoubao('你好', credentials, { voice: defaultVoice, fetchImpl: noEnd.fetchImpl }),
    /未收到结束帧/
  );

  const partial = Buffer.concat([
    ndjson(audioFrames()),
    Buffer.from('{"code":0,"data":"YW', 'utf8')
  ]);
  const truncated = mockFetch(sliceBytes(partial, 13));
  await assert.rejects(
    synthesizeDoubao('你好', credentials, { voice: defaultVoice, fetchImpl: truncated.fetchImpl }),
    /分片不完整/
  );
});

test('逐句相对时间戳：检测到非单调立即拒绝，不猜全局偏移', async () => {
  const frames = [
    frame({
      data: A1.toString('base64'),
      sentence: { text: '第一句。', words: [{ word: '一', startTime: 1, endTime: 2, confidence: 0.9 }] }
    }),
    frame({
      data: A2.toString('base64'),
      sentence: { text: '第二句。', words: [{ word: '二', startTime: 0.1, endTime: 0.5, confidence: 0.9 }] }
    }),
    { code: DOUBAO_END_CODE, message: 'OK', data: null }
  ];
  const { fetchImpl } = mockFetch(sliceBytes(ndjson(frames), 9));
  await assert.rejects(
    synthesizeDoubao('第一句。第二句。', credentials, { voice: defaultVoice, fetchImpl }),
    /非单调.*按句分别合成/
  );
});

test('输入边界：空文本、超长文本明确报错，1000 字边界可用', async () => {
  const { fetchImpl } = mockFetch(sliceBytes(ndjson(audioFrames()), 9));
  await assert.rejects(
    synthesizeDoubao('', credentials, { voice: defaultVoice, fetchImpl }),
    /不能为空/
  );
  await assert.rejects(
    synthesizeDoubao('汉'.repeat(DOUBAO_MAX_TEXT_CHARS + 1), credentials, { voice: defaultVoice, fetchImpl }),
    /超过 1000 字上限.*按句分段/
  );
  const ok = mockFetch(sliceBytes(ndjson(audioFrames()), 9));
  const result = await synthesizeDoubao('汉'.repeat(DOUBAO_MAX_TEXT_CHARS), credentials, {
    voice: defaultVoice,
    fetchImpl: ok.fetchImpl
  });
  assert.equal(result.audio.length > 0, true);
});

test('取消：已 abort 的 AbortSignal 会被拒绝，且不会调用真实网络', async () => {
  const controller = new AbortController();
  controller.abort();
  const { fetchImpl, calls } = mockFetch(sliceBytes(ndjson(audioFrames()), 9));
  await assert.rejects(
    synthesizeDoubao('你好', credentials, { voice: defaultVoice, signal: controller.signal, fetchImpl })
  );
  assert.equal(calls.length, 1);
});

test('资源 ID 白名单：非官方 seed-tts-2.0 在发请求前被拒绝', async () => {
  assert.deepEqual(DOUBAO_ALLOWED_RESOURCE_IDS, ['seed-tts-2.0']);
  const root = await mkdtemp(join(tmpdir(), 'doubao-tts-resource-'));
  const path = join(root, '.env.local');
  await writeFile(path, `DOUBAO_TTS_API_KEY=${FAKE_KEY}\nDOUBAO_TTS_RESOURCE_ID=attacker-controlled\n`, 'utf8');
  assert.throws(() => doubaoCredentialsFromEnvFile(path, {}), /资源 ID 不在白名单/);

  const { fetchImpl, calls } = mockFetch(sliceBytes(ndjson(audioFrames()), 9));
  await assert.rejects(
    synthesizeDoubao('你好', { apiKey: FAKE_KEY, resourceId: 'attacker-controlled' }, { voice: defaultVoice, fetchImpl }),
    /资源 ID 不在白名单/
  );
  assert.equal(calls.length, 0, '非法资源 ID 不得发出任何请求');

  // 显式合法 ID 正常放行，header 与请求体都不受影响。
  const ok = mockFetch(sliceBytes(ndjson(audioFrames()), 9));
  await synthesizeDoubao('你好', { apiKey: FAKE_KEY, resourceId: 'seed-tts-2.0' }, { voice: defaultVoice, fetchImpl: ok.fetchImpl });
  assert.equal((ok.calls[0]?.init as RequestInit & { headers: Record<string, string> }).headers['X-Api-Resource-Id'], 'seed-tts-2.0');
});

test('错误遮蔽：fetch 原生异常、服务端 X-Api-Key 回显形式都不泄 key', async () => {
  const failingFetch = (async () => {
    throw new Error(`connect failed, X-Api-Key: ${FAKE_KEY}`);
  }) as typeof fetch;
  await assert.rejects(
    synthesizeDoubao('你好', credentials, { voice: defaultVoice, fetchImpl: failingFetch }),
    (error: unknown) => {
      const message = (error as Error).message;
      assert.equal(message.includes(FAKE_KEY), false);
      assert.match(message, /\[REDACTED\]/);
      return true;
    }
  );

  const frames = [
    { code: 30000000, message: `X-Api-Key=${FAKE_KEY} 无效`, data: A1.toString('base64'),
      sentence: { text: '你好', words: [{ word: '你', startTime: 0, endTime: 0.3, confidence: 0.9 }] } },
    { code: DOUBAO_END_CODE, message: 'OK', data: null }
  ];
  const { fetchImpl } = mockFetch(sliceBytes(ndjson(frames), 9));
  await assert.rejects(
    synthesizeDoubao('你好', credentials, { voice: defaultVoice, fetchImpl }),
    (error: unknown) => {
      const message = (error as Error).message;
      assert.equal(message.includes(FAKE_KEY), false);
      assert.match(message, /\[REDACTED\]/);
      return true;
    }
  );
});

test('回归 fixture：主线程回报的响应形态（40365 字节、9 个词、0~1.685 秒）可被正确解析', async () => {
  // 该 fixture 的形状来自主线程真实调用后的回报；本测试本身是 mock，不含真实网络请求。
  const pcm = Buffer.alloc(40365, 0x5a);
  const words = ['你', '好，', '欢', '迎', '来', '到', '镇', '隆', '镇。'].map((word, index) => ({
    word,
    startTime: Number((index * 1.685 / 9).toFixed(3)),
    endTime: Number(((index + 1) * 1.685 / 9).toFixed(3)),
    confidence: 0.9
  }));
  words[0]!.startTime = 0;
  words[words.length - 1]!.endTime = 1.685;
  const frames = [
    frame({ data: pcm.toString('base64'), sentence: { text: '你好，欢迎来到镇隆镇。', words } }),
    { code: DOUBAO_END_CODE, message: 'OK', data: null }
  ];
  const { fetchImpl } = mockFetch(sliceBytes(ndjson(frames), 4096));
  const result = await synthesizeDoubao('你好，欢迎来到镇隆镇。', credentials, { voice: 'doubao:zh_male_m191_uranus_bigtts', fetchImpl });
  assert.equal(result.audio.length, 40365);
  assert.equal(result.words.length, 9);
  assert.equal(result.words[0]?.start, 0);
  assert.equal(result.words[result.words.length - 1]?.end, 1.685);
  assert.equal(result.words[8]?.text, '镇。');
  assert.deepEqual(result.audio, pcm);
});
