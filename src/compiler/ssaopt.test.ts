import { describe, expect, it } from 'vitest';
import { compile } from './index';
import { compareAllSsaOptRuns, coalesceCopies, optimizeSSA, runSCCP } from './ssaopt';
import { presets } from '../content/lessons';
import { ssaOptPresets } from '../content/ssaopt';

const rawOptions = { fold: false, propagate: false, dead: false };

function analyze(source: string) {
  const result = compile(source, rawOptions, { ssaOpt: true });
  expect(result.ir).toBeDefined();
  expect(result.ssa?.valid).toBe(true);
  expect(result.ssaopt?.issues).toEqual([]);
  expect(result.ssaopt?.valid).toBe(true);
  return result;
}

describe('SSA optimization (SCCP, copy propagation, sparse DCE) and conservative coalescing', () => {
  it('prunes unreachable branches without letting them pollute phi lattice values', () => {
    const result = analyze(ssaOptPresets[0].code);
    const opt = result.ssaopt!;
    expect(opt.removedBlocks.length).toBeGreaterThan(0);
    expect(opt.simplifiedPhis).toBeGreaterThan(0);
    expect(opt.foldedConstants).toBeGreaterThan(0);
    expect(opt.optimizedBlocks.flatMap((block) => block.phis)).toEqual([]);
    expect(opt.optimizedSsaExecution!.output).toEqual([15]);
    expect(opt.coalescedRun!.execution.output).toEqual([15]);
    expect(compareAllSsaOptRuns(result.baseline!, result.ssa!.execution!, opt)).toBe('same');
  });

  it('merges non-interfering loop phi copies and reduces copy instructions', () => {
    const result = analyze(ssaOptPresets[1].code);
    const opt = result.ssaopt!;
    expect(opt.mergedPairs).toBeGreaterThan(0);
    expect(opt.coalescedRun!.moveCount).toBeLessThan(opt.uncoalescedRun!.moveCount);
    expect(opt.coalescedRun!.execution.output).toEqual([6]);
    expect(compareAllSsaOptRuns(result.baseline!, result.ssa!.execution!, opt)).toBe('same');
  });

  it('detects interference on the Briggs lost-copy loop and preserves 4, 3 output', () => {
    const result = analyze(ssaOptPresets[2].code);
    const opt = result.ssaopt!;
    expect(opt.blockedPairs).toBeGreaterThan(0);
    expect(opt.coalesceDecisions.some((item) => item.status === 'interferes' && Boolean(item.conflict))).toBe(true);
    expect(opt.optimizedSsaExecution!.output).toEqual([4, 3]);
    expect(opt.uncoalescedRun!.execution.output).toEqual([4, 3]);
    expect(opt.coalescedRun!.execution.output).toEqual([4, 3]);
    expect(compareAllSsaOptRuns(result.baseline!, result.ssa!.execution!, opt)).toBe('same');
  });

  it('creates a real swap cycle after SSA copy propagation and preserves swap results via temp', () => {
    const result = analyze(ssaOptPresets[3].code);
    const opt = result.ssaopt!;
    expect(opt.optimizedLowered!.plans.some((plan) => plan.temporaries.length > 0)).toBe(true);
    expect(opt.blockedPairs).toBeGreaterThan(0);
    expect(opt.optimizedSsaExecution!.output).toEqual([2, 1]);
    expect(opt.coalescedRun!.execution.output).toEqual([2, 1]);
    expect(compareAllSsaOptRuns(result.baseline!, result.ssa!.execution!, opt)).toBe('same');
  });

  it('removes dead loop phis and non-trapping dead computations via sparse DCE', () => {
    const result = analyze(ssaOptPresets[4].code);
    const opt = result.ssaopt!;
    expect(opt.dceRemovals.some((item) => item.kind === 'phi')).toBe(true);
    expect(opt.dceRemovals.some((item) => item.kind === 'inst')).toBe(true);
    expect(opt.optimizedBlocks.flatMap((block) => block.phis).map((phi) => phi.variable)).toEqual(['v0_i', 'v1_keep']);
    expect(opt.coalescedRun!.execution.output).toEqual([9]);
    expect(compareAllSsaOptRuns(result.baseline!, result.ssa!.execution!, opt)).toBe('same');
  });

  it('joins equal constants across two executable branches and folds downstream arithmetic', () => {
    const result = analyze(ssaOptPresets[5].code);
    const opt = result.ssaopt!;
    expect(opt.simplifiedPhis).toBeGreaterThan(0);
    expect(opt.foldedConstants).toBeGreaterThanOrEqual(3);
    expect(opt.coalescedRun!.execution.output).toEqual([14]);
    expect(compareAllSsaOptRuns(result.baseline!, result.ssa!.execution!, opt)).toBe('same');
  });

  it('retains dead trapping divisions and overflows in exact output order', () => {
    const divZero = analyze(ssaOptPresets[6].code);
    expect(divZero.ssaopt!.optimizedSsaExecution!.output).toEqual([5]);
    expect(divZero.ssaopt!.optimizedSsaExecution!.error).toBe('整数除法的除数不能为 0。');
    expect(divZero.ssaopt!.coalescedRun!.execution.output).toEqual([5]);
    expect(divZero.ssaopt!.coalescedRun!.execution.error?.message).toBe('整数除法的除数不能为 0。');
    expect(compareAllSsaOptRuns(divZero.baseline!, divZero.ssa!.execution!, divZero.ssaopt!)).toBe('same');

    const overflow = analyze('print(1); int unused = 9007199254740991 + 1; print(2);');
    expect(overflow.ssaopt!.coalescedRun!.execution.output).toEqual([1]);
    expect(overflow.ssaopt!.coalescedRun!.execution.error?.message).toContain('超出安全整数范围');
    expect(compareAllSsaOptRuns(overflow.baseline!, overflow.ssa!.execution!, overflow.ssaopt!)).toBe('same');
  });

  it('matches baseline VM across all existing presets and all ssaopt presets without mutating input SSA', () => {
    for (const preset of [...presets, ...ssaOptPresets]) {
      const result = compile(preset.code, rawOptions, { ssaOpt: true });
      if (!result.ir) continue;
      const before = structuredClone(result.ssa!.blocks);
      const rerun = optimizeSSA(result.ssa!, result.dominance!, result.dataflow);
      expect(result.ssa!.blocks).toEqual(before);
      expect(rerun.issues, preset.id).toEqual([]);
      expect(rerun.valid, preset.id).toBe(true);
      expect(rerun.optimizedValidationIssues, preset.id).toEqual([]);
      const verdict = compareAllSsaOptRuns(result.baseline!, result.ssa!.execution!, rerun);
      const anyLimited =
        result.baseline!.limited ||
        result.ssa!.execution!.limited ||
        rerun.optimizedSsaExecution!.limited ||
        rerun.uncoalescedRun!.execution.limited ||
        rerun.coalescedRun!.execution.limited;
      expect(verdict, preset.id).toBe(anyLimited ? 'unknown' : 'same');
    }
  });

  it('preserves exact behavior on 60 seeded random programs with branches, loops, swaps and traps', () => {
    let seed = 20261126;
    const rand = (limit: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % limit;
    };
    const vars = ['a', 'b', 'c'];
    const ops = ['+', '-', '*', '/'];

    for (let index = 0; index < 60; index++) {
      const lines: string[] = [
        `int a = ${rand(7) - 2};`,
        `int b = ${rand(7) - 2};`,
        `int c = ${rand(5) + 1};`,
        `bool flag = ${rand(2) === 0};`,
        'int i = 0;',
      ];
      // Add a branch (sometimes constant, sometimes runtime-dependent)
      const branchCond = rand(3) === 0 ? 'flag' : rand(2) === 0 ? 'a < b' : 'a == 0';
      lines.push(`if (${branchCond}) {`);
      lines.push(`  a = b ${ops[rand(3)]} ${rand(4) + 1};`);
      if (rand(2) === 0) lines.push('  c = a;');
      lines.push('} else {');
      lines.push(`  a = ${rand(6)};`);
      if (rand(2) === 0) lines.push(`  b = b + ${rand(3)};`);
      lines.push('}');

      // Add a bounded loop with lost-copy / swap / dead computations / occasional division
      const trips = rand(5);
      lines.push(`while (i < ${trips}) {`);
      const bodyKind = rand(4);
      if (bodyKind === 0) {
        lines.push('  b = a;');
        lines.push('  a = a + 1;');
      } else if (bodyKind === 1) {
        lines.push('  int t = a;');
        lines.push('  a = b;');
        lines.push('  b = t;');
      } else if (bodyKind === 2) {
        const rhs = vars[rand(3)];
        const op = ops[rand(4)];
        lines.push(`  c = ${rhs} ${op} ${rand(3)};`);
      } else {
        lines.push('  bool dead = i < 10;');
        lines.push(`  a = a + c;`);
      }
      lines.push('  i = i + 1;');
      lines.push('}');
      lines.push('print(a);', 'print(b);', 'print(c);');

      const source = lines.join('\n');
      const result = compile(source, rawOptions, { ssaOpt: true });
      expect(result.ssaopt?.valid, `program #${index}\n${source}`).toBe(true);
      expect(result.ssaopt?.optimizedValidationIssues, `program #${index}`).toEqual([]);
      const verdict = compareAllSsaOptRuns(result.baseline!, result.ssa!.execution!, result.ssaopt!);
      expect(verdict, `program #${index}\n${source}`).toBe('same');
    }
  });

  it('rejects invalid SSA, handles empty programs and marks budget exhaustion as unknown', () => {
    const empty = analyze('');
    expect(empty.ssaopt!.coalescedRun!.execution.halted).toBe(true);
    expect(empty.ssaopt!.coalescedRun!.execution.output).toEqual([]);

    const invalid = optimizeSSA(
      { blocks: [], placements: [], steps: [], issues: ['bad'], valid: false, traceTruncated: false },
      empty.dominance!,
    );
    expect(invalid.valid).toBe(false);
    expect(invalid.issues.length).toBeGreaterThan(0);

    const infinite = analyze('int x = 0; while (true) { x = x + 1; } print(x);');
    expect(compareAllSsaOptRuns(infinite.baseline!, infinite.ssa!.execution!, infinite.ssaopt!)).toBe('unknown');

    // Direct SCCP & coalesceCopies sanity checks
    const simple = analyze('int a = 2; int b = a + 3; print(b);');
    const sccp = runSCCP(simple.ssa!, simple.dominance!);
    expect(sccp.converged).toBe(true);
    expect(sccp.edgeVisits).toBeGreaterThan(0);

    const coalesced = coalesceCopies(simple.ssaopt!.uncoalescedRun!.instructions);
    expect(coalesced.code.length).toBeLessThanOrEqual(simple.ssaopt!.uncoalescedRun!.instructions.length);
    expect(compile('print(1);', rawOptions).ssaopt).toBeUndefined();
  });
});
