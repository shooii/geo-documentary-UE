export function createFramePlayback(deps: {
  now: () => number;
  request: (callback: () => void) => number;
  cancel: (id: number) => void;
  draw: (time: number, force: boolean) => void;
  notify: (event: string, details: Record<string, unknown>) => void;
}) {
  let generation = 0, raf = 0, paused = false, disconnected = false;
  let run: { start: number; end: number; time: number; anchor: number; done: string; details: Record<string, unknown>; flightSeconds: number; flightSent: boolean } | undefined;
  function stop() { generation++; deps.cancel(raf); raf = 0; run = undefined; paused = false; disconnected = false; }
  function arm() {
    const token = generation;
    raf = deps.request(() => {
      if (token !== generation || paused || disconnected || !run) return;
      const current = run;
      current.time = Math.min(current.end, current.time + (deps.now() - current.anchor) / 1000);
      if (current.end - current.time < 1e-9) current.time = current.end;
      current.anchor = deps.now();
      deps.draw(current.time, current.time >= current.end);
      if (current.flightSeconds && !current.flightSent && current.time + 1e-9 >= current.start + current.flightSeconds) {
        current.flightSent = true;
        deps.notify('tour-flight-complete', current.details);
      }
      if (current.time < current.end) arm();
      else { raf = 0; run = undefined; deps.notify(current.done, current.details); }
    });
  }
  return {
    stop,
    get active() { return Boolean(run) && !paused; },
    play(start: number, end: number, done: string, details: Record<string, unknown> = {}, flightSeconds = 0) {
      stop();
      run = { start, end, time: start, anchor: deps.now(), done, details, flightSeconds, flightSent: false };
      deps.draw(start, true); arm();
    },
    pause() {
      if (!run || paused) return;
      // 冻结最后真正发给地图的帧，恢复不补跳暂停前尚未绘制的时间。
      generation++; deps.cancel(raf); raf = 0; paused = true;
    },
    resume() { if (!run || !paused) return; paused = false; run.anchor = deps.now(); if (!disconnected) arm(); },
    disconnect() { generation++; deps.cancel(raf); raf = 0; disconnected = true; },
    reconnect() {
      if (!disconnected) return;
      disconnected = false;
      if (!run) return;
      run.anchor = deps.now();
      deps.draw(run.time, true);
      if (!paused) arm();
    },
  };
}
