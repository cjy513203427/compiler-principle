import { afterAll, describe, expect, it } from 'vitest';
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// Run the real CLI in isolated workspaces. The preload replaces fetch entirely;
// these tests must never touch the source website.
const cacheRoot = resolve(process.cwd(), '.cache');
mkdirSync(cacheRoot, { recursive: true });
const sandboxes: string[] = [];
function fixture(status = '200', retryAfter = '') {
  const root = mkdtempSync(resolve(cacheRoot, 'limiter-test-'));
  sandboxes.push(root);
  const sourceDir = resolve(root, 'scripts');
  mkdirSync(sourceDir);
  const script = resolve(sourceDir, 'fetch-source.mjs');
  copyFileSync(resolve(process.cwd(), 'scripts/fetch-source.mjs'), script);
  const hook = resolve(root, 'mock-fetch.mjs');
  const log = resolve(root, 'requests.log');
  writeFileSync(
    hook,
    `
    import { appendFileSync } from 'node:fs';
    globalThis.fetch = async () => {
      appendFileSync(process.env.COMPILER_MOCK_LOG, 'request\\n');
      if (process.env.COMPILER_MOCK_STATUS === 'network') throw new Error('Mock network failure');
      return new Response('<html>' + 'x'.repeat(650) + '</html>', {
        status: Number(process.env.COMPILER_MOCK_STATUS),
        headers: { 'content-type': 'text/html', 'retry-after': process.env.COMPILER_MOCK_RETRY }
      });
    };
  `,
  );
  const run = (args = ['--chapter', '02']) =>
    spawnSync(process.execPath, ['--import', pathToFileURL(hook).href, script, ...args], {
      cwd: root,
      encoding: 'utf8',
      timeout: 5000,
      env: {
        ...process.env,
        COMPILER_MOCK_LOG: log,
        COMPILER_MOCK_STATUS: status,
        COMPILER_MOCK_RETRY: retryAfter,
      },
    });
  const requests = () =>
    existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').length : 0;
  const statePath = resolve(root, '.cache/sources/request-state.json');
  const state = () =>
    JSON.parse(readFileSync(statePath, 'utf8')) as { nextAllowedAt: number; failures: number };
  return { root, run, requests, statePath, state };
}
afterAll(() => {
  for (const root of sandboxes) {
    if (!resolve(root).startsWith(cacheRoot + sep)) throw new Error('Unsafe test cleanup target');
    rmSync(root, { recursive: true, force: true });
  }
});
// Each case starts several child processes. Their individual 5s limits still apply.
describe('source CLI request discipline (mocked network)', () => {
  it('makes no request without an explicit chapter and reuses successful cache', () => {
    const f = fixture();
    expect(f.run([]).status).toBe(0);
    expect(f.requests()).toBe(0);
    const start = Date.now();
    expect(f.run().status).toBe(0);
    expect(f.requests()).toBe(1);
    expect(f.state().nextAllowedAt).toBeGreaterThanOrEqual(start + 15000);
    expect(f.run().stdout).toContain('使用本地缓存');
    expect(f.requests()).toBe(1);
  }, 25_000);
  it('honors persisted cooldowns without sending or automatically retrying', () => {
    const f = fixture();
    expect(f.run().status).toBe(0);
    writeFileSync(f.statePath, JSON.stringify({ nextAllowedAt: Date.now() + 120000, failures: 1 }));
    const result = f.run(['--chapter', '02', '--refresh']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('冷却');
    expect(f.requests()).toBe(1);
  }, 25_000);
  it('records long Retry-After on 429 and stops after one attempt', () => {
    const f = fixture('429', '7200');
    const start = Date.now();
    const result = f.run();
    expect(result.status).toBe(1);
    expect(f.requests()).toBe(1);
    expect(f.state().nextAllowedAt).toBeGreaterThanOrEqual(start + 7200000);
    expect(f.run().status).toBe(1);
    expect(f.requests()).toBe(1);
  }, 25_000);
  it('backs off after forbidden responses and network failures', () => {
    for (const status of ['403', 'network']) {
      const f = fixture(status);
      const start = Date.now();
      expect(f.run().status).toBe(1);
      expect(f.requests()).toBe(1);
      expect(f.state().nextAllowedAt).toBeGreaterThanOrEqual(
        start + (status === '403' ? 3600000 : 30000),
      );
      expect(f.run().status).toBe(1);
      expect(f.requests()).toBe(1);
    }
  }, 25_000);
  it('refuses concurrent locks and corrupt state instead of bypassing them', () => {
    const f = fixture();
    const sourceCache = resolve(f.root, '.cache/sources');
    mkdirSync(sourceCache, { recursive: true });
    const lock = resolve(sourceCache, 'request.lock');
    appendFileSync(lock, '');
    expect(f.run().status).toBe(1);
    expect(f.requests()).toBe(0);
    rmSync(lock);
    writeFileSync(f.statePath, JSON.stringify({ nextAllowedAt: 'bad', failures: 0 }));
    expect(f.run().status).toBe(1);
    expect(f.requests()).toBe(0);
  }, 25_000);
});
