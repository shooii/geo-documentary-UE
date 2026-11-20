import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

/**
 * 豆包语音合成大模型 2.0（单向流式 HTTP）。
 *
 * 只做一件事：把一段中文文本合成成 mp3 字节及逐字时间戳。
 * 鉴权、流式分帧解码、错误码、时间轴校验都收在这里，调用方不需要知道 NDJSON
 * 分块协议，也不需要接触 API Key。
 */

/** 官方固定端点：不允许调用方传入自定义 url，避免密钥被发往第三方。 */
export const DOUBAO_TTS_URL = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional';
const DEFAULT_RESOURCE_ID = 'seed-tts-2.0';

/** 只允许官方 2.0 资源 ID：8 个音色均为 uranus_bigtts，其他 ID 一律不发请求。 */
export const DOUBAO_ALLOWED_RESOURCE_IDS: readonly string[] = [DEFAULT_RESOURCE_ID];

/** 官方文档与实测一致：20000000 是「正常结束」信息帧，data 为 null，不是错误。 */
export const DOUBAO_END_CODE = 20000000;

/** 单次请求正文上限（按 Unicode 码点计）。未拿到官方确认前宁可明确报错。 */
export const DOUBAO_MAX_TEXT_CHARS = 1000;

const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_OBJECT_CHARS = 4 * 1024 * 1024;
const MAX_FRAMES = 5000;
const DEFAULT_TIMEOUT_MS = 120_000;
const MONOTONIC_TOLERANCE_SECONDS = 0.05;

export type DoubaoCredentials = {
  apiKey: string;
  /** 默认 seed-tts-2.0。 */
  resourceId?: string;
};

export type DoubaoVoice = { id: string; name: string; gender: '男声' | '女声'; note: string };

/** 豆包语音合成模型 2.0 音色（speaker 均为官方 uranus_bigtts 系列）。 */
export const DOUBAO_VOICES: DoubaoVoice[] = [
  { id: 'doubao:zh_male_m191_uranus_bigtts', name: '云舟', gender: '男声', note: '通用男声，节奏自然' },
  { id: 'doubao:zh_male_taocheng_uranus_bigtts', name: '小天', gender: '男声', note: '通用男声，亲和清晰' },
  { id: 'doubao:zh_female_vv_uranus_bigtts', name: 'Vivi', gender: '女声', note: '通用女声，自然亲切' },
  { id: 'doubao:zh_female_xiaohe_uranus_bigtts', name: '小何', gender: '女声', note: '通用女声，干净利落' },
  { id: 'doubao:zh_male_jieshuoxiaoming_uranus_bigtts', name: '解说小明', gender: '男声', note: '解说男声，纪录片旁白' },
  { id: 'doubao:zh_male_ruyayichen_uranus_bigtts', name: '儒雅逸辰', gender: '男声', note: '儒雅男声，人文地理' },
  { id: 'doubao:zh_female_cancan_uranus_bigtts', name: '知性灿灿', gender: '女声', note: '知性女声，知识科普' },
  { id: 'doubao:zh_female_qingxinnvsheng_uranus_bigtts', name: '清新女声', gender: '女声', note: '清新女声，轻松叙述' }
];

export function isDoubaoVoice(voiceId: string | undefined | null): boolean {
  return typeof voiceId === 'string' && voiceId.startsWith('doubao:');
}

export function doubaoVoiceName(voiceId: string): string {
  return DOUBAO_VOICES.find((voice) => voice.id === voiceId)?.name ?? voiceId.replace(/^doubao:/, '');
}

export type DoubaoWord = { start: number; end: number; text: string };

export type DoubaoSynthesizeOptions = {
  /** `doubao:<speaker>` 或裸 speaker id。 */
  voice: string;
  /** 0.5 - 2.0，1 为正常；映射到官方 speech_rate [-50,100]。 */
  speed?: number;
  /** 默认 true：没有逐字时间戳就拒绝，不静默产出无字幕音频。 */
  requireTimestamps?: boolean;
  signal?: AbortSignal;
  /** 仅供测试注入；无论实现如何，url 始终是官方端点。 */
  fetchImpl?: typeof fetch;
  /** 防无限流，默认 120 秒。 */
  timeoutMs?: number;
};

export type DoubaoSynthesizeResult = {
  audio: Buffer;
  words: DoubaoWord[];
  requestId: string;
  logId?: string;
};

function doubaoCredentials(env: NodeJS.ProcessEnv): DoubaoCredentials | null {
  const apiKey = env.DOUBAO_TTS_API_KEY?.trim();
  if (!apiKey) return null;
  const resourceId = env.DOUBAO_TTS_RESOURCE_ID?.trim();
  const credentials: DoubaoCredentials = { apiKey };
  if (resourceId) credentials.resourceId = assertResourceId(resourceId, apiKey);
  return credentials;
}

export { doubaoCredentials };

/**
 * 项目把密钥放在 `.env.local`（不入库）；生成脚本和 Studio 不是用 dotenv 拉起的，
 * 所以这里显式读一次。真实环境变量优先，返回值只含 apiKey/resourceId。
 */
export function doubaoCredentialsFromEnvFile(path: string, env: NodeJS.ProcessEnv = process.env): DoubaoCredentials | null {
  let local: Record<string, string | undefined> = {};
  try { local = parseEnv(readFileSync(path, 'utf8')) as Record<string, string | undefined>; } catch { /* no local file */ }
  return doubaoCredentials({ ...local, ...env });
}

/** 任何错误信息都要过这里：绝不回显 headers，且把 key 本身抹掉。 */
function redact(message: unknown, apiKey: string): string {
  let text = typeof message === 'string' ? message : message == null ? '' : String(message);
  if (apiKey.length >= 4) text = text.split(apiKey).join('[REDACTED]');
  // 兜底：即使服务端用 X-Api-Key / api_key= 等形式回显，也不让凭据原样漏出。
  text = text.replace(/((?:X-Api-Key|api[_-]?key)\s*[:=]\s*["']?)[A-Za-z0-9_-]{8,}/gi, '$1[REDACTED]');
  return text.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 300) || '未知错误';
}

function fail(apiKey: string, message: string): never {
  throw new Error(redact(message, apiKey));
}

function assertResourceId(resourceId: string | undefined, apiKey: string): string {
  const value = resourceId?.trim() || DEFAULT_RESOURCE_ID;
  if (!DOUBAO_ALLOWED_RESOURCE_IDS.includes(value)) {
    fail(apiKey, `豆包资源 ID 不在白名单（仅允许 ${DOUBAO_ALLOWED_RESOURCE_IDS.join(' / ')}）：${value}`);
  }
  return value;
}

function speakerFrom(voice: string | undefined): string {
  if (typeof voice !== 'string') return '';
  const speaker = voice.startsWith('doubao:') ? voice.slice('doubao:'.length) : voice;
  return speaker.trim();
}

/** speed 1 -> 0，0.5 -> -50，2 -> 100，与官方 speech_rate 区间线性对应。 */
function speechRateFrom(speed: number | undefined): number {
  const value = speed ?? 1;
  if (!Number.isFinite(value) || value < 0.5 || value > 2) {
    throw new Error('豆包语速 speed 必须在 0.5 - 2 之间');
  }
  return Math.round((value - 1) * 100);
}

/**
 * 从任意长度的文本缓冲里取出所有「完整」的顶层 JSON 对象。
 * 既吃 NDJSON（每行一个对象），也吃无换行的连续 JSON 对象；
 * 字符串内的 `{}` 与转义引号不会被误判为对象边界。
 */
function drainJsonObjects(buffer: string): { objects: string[]; rest: string } {
  const objects: string[] = [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  let start = -1;
  let consumed = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    const ch = buffer[i] ?? '';
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }
    if (ch === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        objects.push(buffer.slice(start, i + 1));
        consumed = i + 1;
        start = -1;
      }
    }
  }
  return { objects, rest: buffer.slice(consumed) };
}

/** 新建一个增量文本解码器：字节 chunk 切断 UTF-8 多字节、字符串 chunk 切断代理对都能跨 chunk 还原。 */
function createIncrementalDecoder() {
  const bytes = new TextDecoder('utf-8', { fatal: true });
  let highSurrogate = '';
  return {
    push(chunk: Uint8Array | string): string {
      let text = typeof chunk === 'string' ? chunk : bytes.decode(chunk, { stream: true });
      if (highSurrogate) { text = highSurrogate + text; highSurrogate = ''; }
      if (typeof chunk === 'string') {
        const last = text.charCodeAt(text.length - 1);
        if (last >= 0xd800 && last <= 0xdbff) {
          highSurrogate = text.slice(-1);
          text = text.slice(0, -1);
        }
      }
      return text;
    },
    flush(): string {
      const tail = highSurrogate + bytes.decode();
      highSurrogate = '';
      return tail;
    }
  };
}

function toBytes(chunk: unknown): Uint8Array | string {
  if (typeof chunk === 'string') return chunk;
  if (chunk instanceof Uint8Array) return chunk;
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  if (chunk && typeof chunk === 'object' && 'buffer' in chunk) {
    const view = chunk as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  throw new Error('豆包语音合成响应 chunk 类型无法识别');
}

async function* iterateBody(body: unknown): AsyncGenerator<Uint8Array | string> {
  const stream = body as {
    getReader?: () => { read: () => Promise<{ done?: boolean; value?: unknown }>; cancel?: (reason?: unknown) => Promise<void>; releaseLock?: () => void };
    [Symbol.asyncIterator]?: () => AsyncIterator<unknown>;
  } | null | undefined;
  if (!stream) throw new Error('豆包语音合成响应没有可读取的 body');
  if (typeof stream.getReader === 'function') {
    const reader = stream.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        if (value !== undefined) yield toBytes(value);
      }
    } finally {
      try { reader.releaseLock?.(); } catch { /* already released */ }
    }
  }
  if (typeof stream[Symbol.asyncIterator] === 'function') {
    for await (const value of stream as AsyncIterable<unknown>) yield toBytes(value);
    return;
  }
  throw new Error('豆包语音合成响应体不可流式读取');
}

function headerValue(headers: unknown, name: string): string | undefined {
  if (!headers) return undefined;
  const source = headers as { get?: (key: string) => string | null } & Record<string, unknown>;
  if (typeof source.get === 'function') return source.get(name) ?? undefined;
  const key = Object.keys(source).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  const value = key ? source[key] : undefined;
  return typeof value === 'string' ? value : undefined;
}

type DoubaoFrame = {
  code?: unknown;
  message?: unknown;
  data?: unknown;
  sentence?: { text?: unknown; words?: unknown };
};

function addWords(frame: DoubaoFrame, words: DoubaoWord[], requireTimestamps: boolean, apiKey: string): void {
  const rawWords = frame.sentence?.words;
  if (!Array.isArray(rawWords)) return;
  for (const raw of rawWords) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const start = Number(item.startTime);
    const end = Number(item.endTime);
    const text = typeof item.word === 'string' ? item.word : '';
    if (!text) continue;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) {
      if (requireTimestamps) fail(apiKey, '豆包返回了无效的逐字时间戳（startTime/endTime）');
      continue;
    }
    const previous = words[words.length - 1];
    if (previous && start + MONOTONIC_TOLERANCE_SECONDS < previous.end) {
      if (requireTimestamps) {
        fail(apiKey, '豆包分句时间戳非单调：疑似返回了句内相对时间，无法安全推断全局偏移；请按句分别合成后再拼接音频');
      }
      continue;
    }
    words.push({ start, end, text });
  }
}

/**
 * 单次合成：把文本 POST 到官方端点，流式收集 mp3 分片与逐字时间戳。
 *
 * 不盲目重试；任何非 0 且非 20000000 的 code 都当作服务端错误立即中止，
 * 且不采纳错误帧里的 data。流提前结束 / 无音频 / 尾包截断一律失败。
 */
export async function synthesizeDoubao(
  text: string,
  credentials: DoubaoCredentials,
  options: DoubaoSynthesizeOptions
): Promise<DoubaoSynthesizeResult> {
  const apiKey = credentials?.apiKey?.trim() ?? '';
  if (!apiKey) throw new Error('缺少豆包 DOUBAO_TTS_API_KEY');
  if (typeof text !== 'string' || !text.trim()) fail(apiKey, '豆包合成文本不能为空');
  if ([...text].length > DOUBAO_MAX_TEXT_CHARS) {
    fail(apiKey, `豆包单次合成文本超过 ${DOUBAO_MAX_TEXT_CHARS} 字上限；请按句分段合成后拼接音频`);
  }
  const speaker = speakerFrom(options?.voice);
  if (!speaker) fail(apiKey, '豆包合成缺少 voice（doubao:<speaker> 或裸 speaker id）');

  const requestId = randomUUID();
  const resourceId = assertResourceId(credentials.resourceId, apiKey);
  const requireTimestamps = options.requireTimestamps ?? true;
  const speed = options.speed ?? 1;
  let speechRate = 0;
  try { speechRate = speechRateFrom(speed); } catch (error) { fail(apiKey, (error as Error).message); }

  const controller = new AbortController();
  const onExternalAbort = () => controller.abort(options.signal?.reason);
  if (options.signal) {
    if (options.signal.aborted) controller.abort(options.signal.reason);
    else options.signal.addEventListener('abort', onExternalAbort, { once: true });
  }
  const timer = setTimeout(
    () => controller.abort(new Error('豆包语音合成超时')),
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  );

  try {
    const response = await (options.fetchImpl ?? fetch)(DOUBAO_TTS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': apiKey,
        'X-Api-Resource-Id': resourceId,
        'X-Api-Request-Id': requestId
      },
      body: JSON.stringify({
        req_params: {
          text,
          speaker,
          audio_params: {
            format: 'mp3',
            sample_rate: 48000,
            bit_rate: 160000,
            speech_rate: speechRate,
            enable_subtitle: true
          }
        }
      }),
      signal: controller.signal
    });

    const ok = response.ok ?? (response.status >= 200 && response.status < 300);
    if (!ok) fail(apiKey, `豆包语音合成 HTTP ${response.status} ${redact(response.statusText, apiKey)}`);

    const decoder = createIncrementalDecoder();
    const audioChunks: Buffer[] = [];
    const words: DoubaoWord[] = [];
    let totalBytes = 0;
    let frameCount = 0;
    let sawEndFrame = false;

    const consumeObject = (object: string): void => {
      let frame: DoubaoFrame;
      try { frame = JSON.parse(object) as DoubaoFrame; } catch { fail(apiKey, '豆包返回了无法解析的 JSON 分片'); }
      if (!frame || typeof frame !== 'object') fail(apiKey, '豆包返回了无效的 JSON 分片');

      if (typeof frame.code === 'number' && frame.code !== 0 && frame.code !== DOUBAO_END_CODE) {
        const detail = redact(frame.message, apiKey);
        fail(apiKey, `豆包语音合成失败（code=${frame.code}）：${detail}`);
      }

      addWords(frame, words, requireTimestamps, apiKey);

      if (typeof frame.data === 'string' && frame.data) {
        if (!/^[A-Za-z0-9+/=\s]+$/.test(frame.data)) fail(apiKey, '豆包返回了非法的 base64 音频分片');
        const audio = Buffer.from(frame.data.replace(/\s+/g, ''), 'base64');
        if (audio.length) audioChunks.push(audio);
        else fail(apiKey, '豆包返回了无法解码的音频分片');
      }
      if (frame.code === DOUBAO_END_CODE) sawEndFrame = true;
    };

    let buffer = '';
    for await (const chunk of iterateBody(response.body)) {
      if (controller.signal.aborted) {
        const reason = controller.signal.reason;
        fail(apiKey, reason instanceof Error ? reason.message : '豆包语音合成已取消');
      }
      totalBytes += typeof chunk === 'string' ? Buffer.byteLength(chunk, 'utf8') : chunk.byteLength;
      if (totalBytes > MAX_RESPONSE_BYTES) fail(apiKey, '豆包语音合成响应超过大小上限');
      buffer += decoder.push(chunk);
      if (buffer.length > MAX_OBJECT_CHARS) fail(apiKey, '豆包语音合成单个分片过大或响应格式异常');

      const { objects, rest } = drainJsonObjects(buffer);
      buffer = rest;
      frameCount += objects.length;
      if (frameCount > MAX_FRAMES) fail(apiKey, '豆包语音合成分片数量超过上限');
      for (const object of objects) consumeObject(object);
    }

    buffer += decoder.flush();
    const tail = drainJsonObjects(buffer);
    frameCount += tail.objects.length;
    if (frameCount > MAX_FRAMES) fail(apiKey, '豆包语音合成分片数量超过上限');
    for (const object of tail.objects) consumeObject(object);
    if (tail.rest.trim()) fail(apiKey, '豆包语音合成流被截断：最后一个分片不完整');

    if (!sawEndFrame) fail(apiKey, `豆包语音合成流被截断：未收到结束帧（code=${DOUBAO_END_CODE}）`);
    const audio = Buffer.concat(audioChunks);
    if (!audio.length) fail(apiKey, '豆包语音合成没有返回音频');
    if (requireTimestamps && words.length === 0) {
      fail(apiKey, '豆包未返回逐字时间戳；请确认音色支持 enable_subtitle，或显式设置 requireTimestamps:false');
    }

    const result: DoubaoSynthesizeResult = { audio, words, requestId };
    const logId = headerValue(response.headers, 'x-tt-logid');
    if (logId) result.logId = logId;
    return result;
  } catch (error) {
    // fetch / 流实现抛出的原始异常也可能带出请求信息，统一再过一次脱敏。
    if (error instanceof Error) throw new Error(redact(error.message, apiKey));
    if (controller.signal.aborted) fail(apiKey, '豆包语音合成已取消');
    throw error;
  } finally {
    clearTimeout(timer);
    if (options.signal) options.signal.removeEventListener('abort', onExternalAbort);
  }
}
