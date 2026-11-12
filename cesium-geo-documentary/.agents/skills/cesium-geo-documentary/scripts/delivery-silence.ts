export interface SilenceWindow { start: number; end: number }

export function unexpectedSilenceEvents(events: string[], allowedCoverSeconds: number, outroWindow?: SilenceWindow): string[] {
  const unexpected: string[] = [];
  let pending: { start: number; line: string } | undefined;
  for (const line of events) {
    const start = line.match(/silence_start:\s*([0-9.]+)/)?.[1];
    if (start !== undefined) {
      if (pending) unexpected.push(pending.line);
      pending = { start: Number(start), line };
      continue;
    }
    const end = line.match(/silence_end:\s*([0-9.]+)/)?.[1];
    if (end === undefined || !pending) {
      unexpected.push(line);
      continue;
    }
    const allowedCover = pending.start <= 0.05 && Number(end) <= allowedCoverSeconds + 0.3;
    // 插入静音前后仍有TTS句尾/句首留白，只放行完整落在计划窗口附近的事件。
    const allowedOutro = outroWindow !== undefined && outroWindow.end > outroWindow.start
      && pending.start >= outroWindow.start - 0.5 && Number(end) <= outroWindow.end + 0.5;
    if (!allowedCover && !allowedOutro) unexpected.push(pending.line, line);
    pending = undefined;
  }
  if (pending) unexpected.push(pending.line);
  return unexpected;
}
