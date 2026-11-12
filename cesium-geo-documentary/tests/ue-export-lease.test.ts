import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { acquireExportLease, exportRecordingActive, tryAcquireExportGuard } from '../apps/ue-player/export-lease.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'geo-export-lease-'));
  await mkdir(join(root, 'workspace'));
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return { root, port, path: join(root, 'workspace/export-recording.lock'), cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('长片超过90分钟仍有互斥保护，释放后预览可恢复', async () => {
  const f = await fixture();
  const lease = await acquireExportLease(f.root, () => false, f.port);
  try {
    const old = new Date(Date.now() - 91 * 60_000);
    await utimes(f.path, old, old);
    assert.equal(await exportRecordingActive(f.root, f.port), true);
    assert.equal(await tryAcquireExportGuard(f.port), null);
    const owner = JSON.parse(await readFile(f.path, 'utf8'));
    assert.equal(owner.ownerPid, process.pid);
    assert.equal(owner.token, lease.token);
  } finally { await lease.release(); await lease.release(); }
  assert.equal(await exportRecordingActive(f.root, f.port), false);
  await f.cleanup();
});

test('同进程两个导出互斥等待，第二个仅在第一个释放后取得租约', async () => {
  const f = await fixture();
  const first = await acquireExportLease(f.root, () => false, f.port);
  let acquired = false;
  const waiting = acquireExportLease(f.root, () => false, f.port).then(lease => { acquired = true; return lease; });
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(acquired, false);
    await first.release();
    const second = await waiting;
    try {
      assert.notEqual(first.token, second.token);
      assert.equal(await exportRecordingActive(f.root, f.port), true);
      await first.release();
      assert.equal(await exportRecordingActive(f.root, f.port), true);
    } finally { await second.release(); }
  } finally { await first.release(); await f.cleanup(); }
});

test('不是文件所有者的finally不删除替代租约，等待支持取消', async () => {
  const f = await fixture();
  const lease = await acquireExportLease(f.root, () => false, f.port);
  const replacement = { version: 1, ownerPid: process.pid, token: 'other-owner' };
  try {
    await assert.rejects(acquireExportLease(f.root, () => true, f.port), /Render cancelled/);
    await writeFile(f.path, JSON.stringify(replacement));
    await lease.release();
    assert.deepEqual(JSON.parse(await readFile(f.path, 'utf8')), replacement);
  } finally { await lease.release(); await f.cleanup(); }
});

test('兼容旧时间戳锁，旧锁过期及新格式孤锁可恢复', async () => {
  const f = await fixture();
  try {
    await writeFile(f.path, String(Date.now()));
    assert.equal(await exportRecordingActive(f.root, f.port), true);
    let cancel = false;
    const pending = acquireExportLease(f.root, () => cancel, f.port);
    cancel = true;
    await assert.rejects(pending, /Render cancelled/);
    const old = new Date(Date.now() - 21 * 60_000);
    await utimes(f.path, old, old);
    assert.equal(await exportRecordingActive(f.root, f.port), false);
    await writeFile(f.path, JSON.stringify({ version: 1, ownerPid: process.pid, token: 'crashed-owner' }));
    assert.equal(await exportRecordingActive(f.root, f.port), false);
    await writeFile(f.path, '{"version":1,"ownerPid":');
    assert.equal(await exportRecordingActive(f.root, f.port), false);
    const lease = await acquireExportLease(f.root, () => false, f.port);
    await lease.release();
  } finally { await f.cleanup(); }
});

test('跨进程租约在拥有者退出后由内核自动恢复，不依赖PID或mtime', async () => {
  const f = await fixture();
  const child = spawn(process.execPath, ['--import', new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url).href, '--input-type=module', '-e', `import { acquireExportLease } from ${JSON.stringify(new URL('../apps/ue-player/export-lease.ts', import.meta.url).href)}; await acquireExportLease(process.env.LEASE_ROOT, () => false, Number(process.env.LEASE_PORT)); process.stdout.write('READY\\n'); process.stdin.resume();`], { env: { ...process.env, LEASE_ROOT: f.root, LEASE_PORT: String(f.port) }, stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    const readiness = await Promise.race([
      once(child.stdout!, 'data').then(([chunk]) => String(chunk)),
      once(child, 'exit').then(([code]) => { throw new Error(`租约子进程提前退出 ${code}`); })
    ]);
    assert.match(readiness, /READY/);
    assert.equal(await exportRecordingActive(f.root, f.port), true);
    const exited = once(child, 'exit');
    child.kill();
    await exited;
    assert.equal(await exportRecordingActive(f.root, f.port), false);
    const lease = await acquireExportLease(f.root, () => false, f.port);
    await lease.release();
  } finally { child.kill(); await f.cleanup(); }
});
