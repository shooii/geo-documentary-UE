// 暂停保留每个回调的剩余时间；清空后旧回调即使已进入事件队列也失效。
export function createPlaybackClock({ now = () => Date.now(), schedule = setTimeout, cancel = clearTimeout } = {}) {
  let paused = false, heldAt = 0, offset = 0, nextId = 0;
  const jobs = new Map();
  const time = () => (paused ? heldAt : now()) - offset;
  function arm(id, job) {
    const token = job.token = {};
    job.handle = schedule(() => {
      if (paused || jobs.get(id) !== job || job.token !== token) return;
      jobs.delete(id);
      job.callback();
    }, Math.max(0, job.at - time()));
  }
  return {
    now: time,
    setTimeout(callback, delay = 0) {
      const id = ++nextId, job = { callback, at: time() + Math.max(0, delay), handle: undefined };
      jobs.set(id, job);
      if (!paused) arm(id, job);
      return id;
    },
    clearTimeout(id) { const job = jobs.get(id); if (job) cancel(job.handle); jobs.delete(id); },
    pause() {
      if (paused) return;
      heldAt = now(); paused = true;
      for (const job of jobs.values()) cancel(job.handle);
    },
    resume() {
      if (!paused) return;
      offset += now() - heldAt; paused = false;
      for (const [id, job] of jobs) arm(id, job);
    },
    clear() { for (const job of jobs.values()) cancel(job.handle); jobs.clear(); },
  };
}
