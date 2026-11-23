import { describe, expect, it } from 'vitest';
import { analyzeGc, parseHeap, type GcAnalysis } from './gc';
import { gcPresets } from '../content/gc';

const preset = (id: string) => gcPresets.find((item) => item.id === id)!.code;
function run(text: string): GcAnalysis {
  const outcome = analyzeGc(text);
  if (!outcome.ok) throw new Error(outcome.issue.message);
  return outcome.analysis;
}
const collector = (analysis: GcAnalysis, name: string) => analysis.collectors.find((item) => item.name === name)!;

/** Invariants checked without reusing the collectors' own code. */
function verify(analysis: GcAnalysis) {
  const refs = analysis.finalRefs;
  const seen = new Set<string>();
  const visit = (name: string) => { if (seen.has(name)) return; seen.add(name); refs[name].forEach(visit); };
  analysis.finalRoots.forEach(visit);
  expect([...seen].sort()).toEqual([...analysis.reachable].sort());
  for (const item of analysis.collectors) {
    expect(item.safe, item.name).toBe(true);
    const cells = Array(item.space).fill(0);
    for (const block of item.layout) for (let cell = block.address; cell < block.address + block.size; cell++) cells[cell]++;
    if (item.name !== '停止-拷贝' || analysis.copyFits) expect(cells.every((count) => count <= 1), item.name).toBe(true);
    expect(item.totalFree + item.layout.reduce((sum, block) => sum + block.size, 0)).toBe(item.space);
  }
  for (const name of ['标记-清除', '标记-整理', '停止-拷贝', '引用计数 + 循环检测'])
    expect(collector(analysis, name).complete, name).toBe(true);
  // Mark-sweep never moves objects; compaction leaves one contiguous free block at the end.
  const original = new Map(analysis.program.objects.map((item) => [item.name, item.address]));
  collector(analysis, '标记-清除').layout.forEach((block) => expect(block.address).toBe(original.get(block.name)));
  const compact = collector(analysis, '标记-整理');
  expect(compact.free.length).toBeLessThanOrEqual(1);
  // Reference counting: freed objects are unreachable, and surviving counts equal the real incoming references.
  for (const name of analysis.rcFreed) expect(seen.has(name), name).toBe(false);
  const last = analysis.rc.at(-1)!;
  const survivors = analysis.program.objects.map((item) => item.name).filter((name) => !analysis.rcFreed.includes(name));
  for (const name of survivors) {
    const incoming = survivors.filter((from) => refs[from].includes(name)).length + (analysis.finalRoots.includes(name) ? 1 : 0);
    expect(last.counts[name], name).toBe(incoming);
  }
  expect(analysis.cycleGarbage.every((name) => !seen.has(name))).toBe(true);
}

describe('garbage collection', () => {
  it('collects A and C but keeps D, as in figure 2 of chapter 32', () => {
    const analysis = run(preset('gc-book'));
    verify(analysis);
    expect(analysis.reachable.sort()).toEqual(['B', 'D']);
    expect(analysis.rcFreed).toEqual(['A', 'C']);
  });

  it('reference counting leaks a cycle that cycle detection and tracing recover', () => {
    const analysis = run(preset('gc-cycle'));
    verify(analysis);
    expect(analysis.rcFreed).toEqual([]);
    expect(analysis.cycleGarbage).toEqual(['a', 'b', 'c', 'd']);
    expect(collector(analysis, '只用引用计数').complete).toBe(false);
  });

  it('a cut turns a subgraph into garbage: counting frees the head, the cycle leaks', () => {
    const analysis = run(preset('gc-mutate'));
    verify(analysis);
    expect(analysis.rcFreed).toEqual(['cache']);
    expect(analysis.cycleGarbage).toEqual(['node1', 'node2']);
  });

  it('fragmentation blocks a request after mark-sweep that compaction satisfies; copying needs half the heap', () => {
    const analysis = run(preset('gc-fragment'));
    verify(analysis);
    expect(collector(analysis, '标记-清除').free.map((range) => range.size)).toEqual([3, 3, 4]);
    expect(collector(analysis, '标记-清除').request.fits).toBe(false);
    expect(collector(analysis, '标记-整理')).toMatchObject({ largestFree: 10, request: { fits: true, address: 6 } });
    expect(analysis.copyFits).toBe(false);
  });

  it('tri-color marking leaves exactly the unreachable objects white', () => {
    const analysis = run(preset('gc-tricolor'));
    verify(analysis);
    const black = analysis.mark.filter((event) => event.kind === 'black').map((event) => event.object);
    expect(black.sort()).toEqual(['A', 'B', 'C', 'D', 'F']);
    expect(collector(analysis, '标记-清除').reclaimed).toEqual(['E', 'G', 'H']);
  });

  it('frees objects as soon as the program drops the last reference', () => {
    const analysis = run(preset('gc-ops'));
    verify(analysis);
    expect(analysis.rcFreed).toEqual(['a', 'b']);
    expect(analysis.finalRoots).toEqual(['c']);
  });

  it('validates input and only lets the program touch reachable objects', () => {
    const issue = (text: string) => { const outcome = parseHeap(text); return outcome.ok ? '' : outcome.issue.message; };
    expect(issue('root x\na 2')).toContain('没有名为 x');
    expect(issue('a 9')).toContain('1–8');
    expect(issue('heap 4\na 3\nb 3')).toContain('超过堆容量');
    expect(issue('a 2 -> b, b\nb 1')).toContain('只写一次');
    expect(issue('a 2\n%%\nfly a')).toContain('%% 下方');
    expect(issue('x'.repeat(1201))).toContain('1200');
    const outcome = analyzeGc('root a\na 2\nb 2\n%%\nlink a -> b');
    expect(outcome.ok ? '' : outcome.issue.message).toContain('当前可达');
    const dropped = analyzeGc('root a\na 2\n%%\ndrop b');
    expect(dropped.ok).toBe(false);
  });

  it('every preset and seeded random heap keeps the invariants', () => {
    for (const item of gcPresets) verify(run(item.code));
    let seed = 5;
    const random = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    for (let round = 0; round < 80; round++) {
      const names = Array.from({ length: 3 + random(8) }, (_, index) => `o${index}`);
      const lines = [`heap ${names.length * 8}`, `request ${1 + random(6)}`, `root ${names.filter(() => random(3) === 0).join(', ') || names[0]}`];
      for (const name of names) {
        const targets = [...new Set(Array.from({ length: random(3) }, () => names[random(names.length)]))];
        lines.push(`${name} ${1 + random(4)}${targets.length ? ` -> ${targets.join(', ')}` : ''}`);
      }
      const analysis = run(lines.join('\n'));
      verify(analysis);
    }
  });
});
