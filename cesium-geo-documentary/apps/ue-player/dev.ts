import { startPreviewRuntime } from './runtime.js';

// Studio 是完整入口的唯一所有者，避免 studio:web 只启动 HTTP、studio 又重复拉起 UE。
if (process.argv.includes('--runtime-only') || process.argv.includes('--renderer-only')) {
  const runtime = startPreviewRuntime(process.cwd(), process.argv.includes('--renderer-only'));
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => runtime.stop());
} else {
  await import('../studio/server.js');
}
