import { mkdir, readFile, writeFile, open, unlink } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// This helper is deliberately single-page and opt-in. The app never imports it.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cache = resolve(root, '.cache', 'sources');
const files = {
  '02': '02 词法分析：用两种方式构造有限自动机.md',
  '03': '03 语法分析：两个基本功和两种算法思路.md',
  '04': '04 语义分析：让程序符合语义规则.md',
  '06': '06 中间代码：不是只有一副面孔.md',
  '07': '07 代码优化：跟编译器做朋友，让你的代码飞起来.md',
  '08': '08 代码生成：如何实现机器相关的优化？.md',
  15: '15 Java JIT编译器（三）：探究内联和逃逸分析的算法原理.md',
  16: '16 Java JIT编译器（四）：Graal的后端是如何工作的？.md',
  32: '32 运行时（二）：垃圾收集与语言的特性有关吗？.md',
  34: '34 并发中的编译技术（二）：如何从语言层面支持协程？.md',
  38: '38 综合实现（一）：如何实现面向对象编程？.md',
  39: '39 综合实现（二）：如何实现函数式编程？.md',
};
const args = process.argv.slice(2);
const index = args.indexOf('--chapter');
const chapter = index >= 0 ? args[index + 1] : undefined;
if (!chapter || !files[chapter]) {
  console.log(
    '用法：npm run sources:fetch -- --chapter 02 [--refresh]\n一次只读取一个已选章节：02、03、04、06、07、08、15、16、32、34、38、39。默认优先使用缓存。',
  );
  process.exit(chapter ? 1 : 0);
}
await mkdir(cache, { recursive: true });
const output = resolve(cache, `${chapter}.html`);
if (!args.includes('--refresh')) {
  try {
    await readFile(output);
    console.log(`使用本地缓存：${output}`);
    process.exit(0);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
const lockPath = resolve(cache, 'request.lock');
let lock;
try {
  lock = await open(lockPath, 'wx');
} catch (error) {
  if (error.code === 'EEXIST') {
    console.error(
      '已有资料请求正在进行。请等待；若进程意外退出，请确认后删除 .cache/sources/request.lock。',
    );
    process.exit(1);
  }
  throw error;
}
const statePath = resolve(cache, 'request-state.json');
let state = { nextAllowedAt: 0, failures: 0 };
try {
  try {
    state = JSON.parse(await readFile(statePath, 'utf8'));
    if (
      !Number.isFinite(state.nextAllowedAt) ||
      state.nextAllowedAt < 0 ||
      !Number.isInteger(state.failures) ||
      state.failures < 0
    ) {
      throw new Error('Invalid rate-limit state');
    }
  } catch (error) {
    if (error.code !== 'ENOENT')
      throw new Error('限流状态文件损坏；为避免重复请求，已停止。请手动检查缓存。');
  }
  const wait = Math.max(0, state.nextAllowedAt - Date.now());
  if (wait > 15000)
    throw new Error(
      `来源站点仍在冷却中，请在 ${new Date(state.nextAllowedAt).toISOString()} 之后手动重试。`,
    );
  if (wait) {
    console.log(`遵守请求间隔，等待 ${Math.ceil(wait / 1000)} 秒。`);
    await new Promise((resolveWait) => setTimeout(resolveWait, wait));
  }
  // Persist before sending. A killed process must not cause an immediate re-request.
  state.nextAllowedAt = Date.now() + 15000;
  await writeFile(statePath, JSON.stringify(state, null, 2));
  const url = `https://learn.lianglianglee.com/专栏/编译原理实战课/${encodeURIComponent(files[chapter])}`;
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'CompilerNotebook/0.1 (manual single-page reference; local cache)',
      Accept: 'text/html',
    },
    signal: AbortSignal.timeout(30000),
    redirect: 'error',
  });
  if (!response.ok) {
    state.failures++;
    const retry = response.headers.get('retry-after');
    const retryMs = retry
      ? /^\d+$/.test(retry)
        ? Number(retry) * 1000
        : Math.max(0, Date.parse(retry) - Date.now())
      : 0;
    const delay =
      response.status === 403
        ? 3600000
        : response.status === 429
          ? 900000
          : Math.min(3600000, 30000 * 2 ** Math.min(state.failures, 6));
    state.nextAllowedAt = Date.now() + Math.max(delay, Number.isFinite(retryMs) ? retryMs : 0);
    await writeFile(statePath, JSON.stringify(state, null, 2));
    throw new Error(
      `HTTP ${response.status}，已停止，不自动重试。冷却至 ${new Date(state.nextAllowedAt).toISOString()}。`,
    );
  }
  const body = await response.text();
  if (!response.headers.get('content-type')?.includes('text/html') || body.length < 500)
    throw new Error('响应不是预期的文章 HTML，未保存。请手动检查来源。');
  await writeFile(output, body, 'utf8');
  await writeFile(
    resolve(cache, `${chapter}.json`),
    JSON.stringify({ url, cachedAt: new Date().toISOString(), status: response.status }, null, 2),
  );
  state.failures = 0;
  state.nextAllowedAt = Date.now() + 15000;
  await writeFile(statePath, JSON.stringify(state, null, 2));
  console.log(`已缓存单个章节：${output}。缓存仅供本地参考，不参与构建。`);
} catch (error) {
  // Also back off for timeouts, redirects, malformed responses and network errors.
  if (state.nextAllowedAt < Date.now() + 15000) {
    state.failures++;
    state.nextAllowedAt = Date.now() + Math.min(3600000, 30000 * 2 ** Math.min(state.failures, 6));
    await writeFile(statePath, JSON.stringify(state, null, 2));
  }
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await lock.close();
  await unlink(lockPath);
}
