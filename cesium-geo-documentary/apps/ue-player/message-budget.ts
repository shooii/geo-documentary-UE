// PixelStreaming 用 uint16 存储 JSON 的 UTF-16 码元数，超限会回绕并截断消息。
export const UI_INTERACTION_MAX_UTF16 = 0xffff;
export const ENVELOPE_BUDGET_UTF16 = 60_000;

export class UiInteractionTooLargeError extends Error {
  constructor(readonly length: number, readonly limit: number) {
    super(`UE 消息 ${length} UTF-16 码元，超过长度限制 ${limit}`);
    this.name = 'UiInteractionTooLargeError';
  }
}

export function buildEnvelope(requestId: string, action: string, payload: Record<string, unknown> = {}) {
  return { type: 'geo-video-ue', version: 1, requestId, action, ...payload };
}

export function envelopeLength(envelope: unknown): number {
  return JSON.stringify(envelope).length;
}

export function assertUiInteractionSize(envelope: unknown): void {
  const length = envelopeLength(envelope);
  if (length > UI_INTERACTION_MAX_UTF16) throw new UiInteractionTooLargeError(length, UI_INTERACTION_MAX_UTF16);
}

export function* captureBatches(
  count: number,
  frame: (index: number) => unknown,
  requestId: () => string
): Generator<{ requestId: string; frames: unknown[] }> {
  let index = 0;
  while (index < count) {
    const id = requestId();
    const frames: unknown[] = [];
    while (index < count) {
      frames.push(frame(index));
      // 完整计入 envelope、真实 requestId、数组分隔符和 JSON 转义后的长度。
      const length = envelopeLength(buildEnvelope(id, 'capture-batch', { frames }));
      if (length > ENVELOPE_BUDGET_UTF16) {
        if (frames.length === 1) throw new UiInteractionTooLargeError(length, ENVELOPE_BUDGET_UTF16);
        frames.pop();
        break;
      }
      index++;
    }
    yield { requestId: id, frames };
  }
}
