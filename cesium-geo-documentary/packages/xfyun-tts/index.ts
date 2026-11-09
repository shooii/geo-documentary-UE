import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

/**
 * 讯飞在线语音合成（流式版 v2）。
 *
 * 只做一件事：把一段中文文本合成成 mp3 字节。鉴权、分片、错误码都收在这里，
 * 调用方（旁白生成、Studio 试听）不需要知道 WebSocket 协议细节。
 */
export type XfyunCredentials = { appId: string; apiKey: string; apiSecret: string };

export type XfyunSynthesisOptions = {
  /** 发音人，见 `XFYUN_VOICES`。 */
  voice: string;
  /** 0.5 - 2.0，1 为正常语速。 */
  speed?: number;
  volume?: number;
  pitch?: number;
};

export type XfyunVoice = { id: string; name: string; gender: '男声' | '女声' | '童声'; note: string };

/**
 * 地理科普解说常用的发音人：两个男声（沉稳 / 讲述）、两个女声（亲和 / 知性），
 * 都是 v2 接口可直接调用的在线发音人。`id` 前加 `xfyun:` 即为项目里的 voiceId。
 */
export const XFYUN_VOICES: XfyunVoice[] = [
  { id: 'xfyun:aisjiuxu', name: '讯飞·许久', gender: '男声', note: '沉稳男声，纪录片旁白' },
  { id: 'xfyun:xiaoyan', name: '讯飞·小燕', gender: '女声', note: '标准女声，科普解说' },
  { id: 'xfyun:aisxping', name: '讯飞·小萍', gender: '女声', note: '亲和女声，娓娓道来' },
  { id: 'xfyun:aisjinger', name: '讯飞·小婧', gender: '女声', note: '知性女声，节奏清晰' },
  { id: 'xfyun:aisbabyxu', name: '讯飞·许小宝', gender: '童声', note: '童声，亲子科普' }
];

export function isXfyunVoice(voiceId: string | undefined | null): boolean {
  return typeof voiceId === 'string' && voiceId.startsWith('xfyun:');
}

export function xfyunVoiceName(voiceId: string): string {
  return XFYUN_VOICES.find((voice) => voice.id === voiceId)?.name ?? voiceId.replace(/^xfyun:/, '');
}

const HOST = 'tts-api.xfyun.cn';
const PATH = '/v2/tts';

/** 讯飞的鉴权串必须逐字节还原，日期格式与签名原文都不能“顺手”改写。 */
function authorizationUrl({ apiKey, apiSecret }: XfyunCredentials) {
  const date = new Date().toUTCString();
  const origin = `host: ${HOST}\ndate: ${date}\nGET ${PATH} HTTP/1.1`;
  const signature = createHmac('sha256', apiSecret).update(origin).digest('base64');
  const authorization = Buffer.from(
    `api_key="${apiKey}", algorithm="hmac-sha256", headers="host date request-line", signature="${signature}"`
  ).toString('base64');
  const url = new URL(`wss://${HOST}${PATH}`);
  url.searchParams.set('authorization', authorization);
  url.searchParams.set('date', date);
  url.searchParams.set('host', HOST);
  return url.toString();
}

/** v2 单次请求正文上限按字节算，超过会被拒；按句切到 400 字以内留足余量。 */
function splitText(text: string, limit = 400): string[] {
  const paragraphs = text.split(/\n+/).map((part) => part.trim()).filter(Boolean);
  const pieces: string[] = [];
  for (const paragraph of paragraphs) {
    if (Buffer.byteLength(paragraph, 'utf8') <= limit * 3) { pieces.push(paragraph); continue; }
    let buffer = '';
    for (const sentence of paragraph.split(/(?<=[。！？；;…])/)) {
      if (Buffer.byteLength(buffer + sentence, 'utf8') > limit * 3 && buffer) { pieces.push(buffer); buffer = ''; }
      buffer += sentence;
    }
    if (buffer) pieces.push(buffer);
  }
  return pieces.length ? pieces : [text];
}

type Frame = { code: number; message?: string; sid?: string; data?: { audio?: string; status?: number; ced?: string } };

async function synthesizeChunk(text: string, credentials: XfyunCredentials, options: XfyunSynthesisOptions): Promise<Buffer> {
  const socket = new WebSocket(authorizationUrl(credentials));
  const chunks: Buffer[] = [];
  return await new Promise<Buffer>((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new Error('讯飞语音合成超时')); }, 30000);
    const fail = (error: Error) => { clearTimeout(timer); try { socket.close(); } catch { /* already closed */ } reject(error); };
    socket.onopen = () => {
      socket.send(JSON.stringify({
        common: { app_id: credentials.appId },
        business: { aue: 'lame', sfl: 1, auf: 'audio/L16;rate=16000', vcn: options.voice.replace(/^xfyun:/, ''), speed: options.speed ?? 50, volume: options.volume ?? 50, pitch: options.pitch ?? 50, tte: 'UTF8' },
        data: { status: 2, text: Buffer.from(text, 'utf8').toString('base64') }
      }));
    };
    socket.onerror = () => fail(new Error('讯飞语音合成连接失败'));
    socket.onclose = () => { if (!chunks.length) fail(new Error('讯飞语音合成连接提前关闭')); };
    socket.onmessage = (event) => {
      let frame: Frame;
      try { frame = JSON.parse(String(event.data)) as Frame; } catch { return fail(new Error('讯飞语音合成返回了无法解析的数据')); }
      if (frame.code !== 0) return fail(new Error(`讯飞语音合成失败（${frame.code}）：${frame.message || '未知错误'}`));
      if (frame.data?.audio) chunks.push(Buffer.from(frame.data.audio, 'base64'));
      if (frame.data?.status === 2) {
        clearTimeout(timer);
        try { socket.close(); } catch { /* server already closed */ }
        if (!chunks.length) return reject(new Error('讯飞语音合成没有返回音频'));
        resolve(Buffer.concat(chunks));
      }
    };
  });
}

/** 长文本按段合成后顺序拼接：mp3 帧可以首尾相接，不重新编码。 */
export async function synthesizeXfyun(text: string, credentials: XfyunCredentials, options: XfyunSynthesisOptions): Promise<Buffer> {
  const pieces = splitText(text);
  const buffers: Buffer[] = [];
  for (const piece of pieces) buffers.push(await synthesizeChunk(piece, credentials, options));
  return Buffer.concat(buffers);
}

export function xfyunCredentials(env: NodeJS.ProcessEnv = process.env): XfyunCredentials | null {
  const appId = env.XFYUN_APP_ID?.trim();
  const apiKey = env.XFYUN_API_KEY?.trim();
  const apiSecret = env.XFYUN_API_SECRET?.trim();
  return appId && apiKey && apiSecret ? { appId, apiKey, apiSecret } : null;
}

/**
 * 项目把密钥放在 `.env.local`（不入库）。生成脚本和 Studio 都不是用 dotenv 拉起的，
 * 所以这里显式读一次；同名的真实环境变量优先级更高。
 */
export function xfyunCredentialsFromEnvFile(path: string, env: NodeJS.ProcessEnv = process.env): XfyunCredentials | null {
  let local: Record<string, string | undefined> = {};
  try { local = parseEnv(readFileSync(path, 'utf8')) as Record<string, string | undefined>; } catch { /* no local file */ }
  return xfyunCredentials({ ...local, ...env } as NodeJS.ProcessEnv);
}
