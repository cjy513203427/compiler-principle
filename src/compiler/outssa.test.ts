import { describe, expect, it } from 'vitest';
import { compile } from './index';
import { analyzeCopyExperiment, compareVmExecutions, lowerSSA, scheduleParallelCopies, type ParallelCopy } from './outssa';
import { compareSSA, executeSSA } from './ssa';
import { presets } from '../content/lessons';
import { copyPresets, outSsaPresets } from '../content/outssa';

const options = { fold: false, propagate: false, dead: false };
const analyze = (source: string) => {
  const result = compile(source, options, { outOfSSA: true });
  expect(result.ssa?.valid).toBe(true);
  expect(result.outssa?.issues).toEqual([]);
  expect(result.outssa?.valid).toBe(true);
  return result;
};

describe('parallel-copy scheduling', () => {
  function verify(copies: ParallelCopy[]) {
    const names = [...new Set(copies.flatMap((copy) => [copy.dest, copy.source]))];
    const initial = new Map(names.map((name, index) => [name, index + 10]));
    const expected = new Map(initial), actual = new Map(initial);
    copies.forEach((copy) => expected.set(copy.dest, initial.get(copy.source)!));
    const before = structuredClone(copies);
    const scheduled = scheduleParallelCopies(copies);
    for (const move of scheduled.moves) {
      expect(actual.has(move.source)).toBe(true);
      actual.set(move.dest, actual.get(move.source)!);
    }
    for (const name of names) expect(actual.get(name), name).toBe(expected.get(name));
    expect(copies).toEqual(before);
    return scheduled;
  }

  it('preserves a swap with a temporary and orders acyclic chains before overwrites', () => {
    const swap = verify([{ dest: 'a', source: 'b' }, { dest: 'b', source: 'a' }]);
    expect(swap.temporaries).toEqual(['__phi_tmp0']);
    expect(swap.steps[0].kind).toBe('save');
    expect(swap.moves).toEqual([
      { dest: '__phi_tmp0', source: 'a' }, { dest: 'a', source: 'b' }, { dest: 'b', source: '__phi_tmp0' },
    ]);
    const chain = verify([{ dest: 'b', source: 'c' }, { dest: 'a', source: 'b' }]);
    expect(chain.moves).toEqual([{ dest: 'a', source: 'b' }, { dest: 'b', source: 'c' }]);
    expect(chain.temporaries).toEqual([]);
  });

  it('handles fanout, identities, several cycles and temporary-name collisions', () => {
    verify([{ dest: 'a', source: 'b' }, { dest: 'b', source: 'c' }, { dest: 'c', source: 'a' }, { dest: 'd', source: 'a' }]);
    const identities = verify([{ dest: 'a', source: 'a' }, { dest: 'b', source: 'a' }]);
    expect(identities.steps[0].kind).toBe('identity');
    expect(identities.moves).toHaveLength(1);
    const cycles = verify([{ dest: 'a', source: 'b' }, { dest: 'b', source: 'a' },
      { dest: 'c', source: 'd' }, { dest: 'd', source: 'c' }]);
    expect(cycles.temporaries).toHaveLength(2);
    const collision = verify([{ dest: '__phi_tmp0', source: 'b' }, { dest: 'b', source: '__phi_tmp0' }]);
    expect(collision.temporaries).toEqual(['__phi_tmp1']);
    expect(() => scheduleParallelCopies([{ dest: 'a', source: 'b' }, { dest: 'a', source: 'c' }])).toThrow('一次');
  });

  it('matches an independent simultaneous-assignment oracle for generated permutations and fanouts', () => {
    let seed = 842;
    const random = (limit: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % limit; };
    for (let count = 2; count <= 12; count++) for (let example = 0; example < 20; example++) {
      const sources = Array.from({ length: count }, (_, index) => index);
      for (let i = count - 1; i > 0; i--) {
        const j = random(i + 1); [sources[i], sources[j]] = [sources[j], sources[i]];
      }
      verify(sources.map((source, dest) => ({ dest: `x${dest}`, source: `x${source}` })));
      verify(sources.map((_, dest) => ({ dest: `x${dest}`, source: `x${random(count)}` })));
    }
  });
});

describe('SSA elimination into existing stack VM', () => {
  it('splits the critical false edge and executes its copies only when that edge is taken', () => {
    for (const choose of [false, true]) {
      const result = analyze(outSsaPresets[0].code.replace('false', String(choose)));
      const lowered = result.outssa!;
      const critical = lowered.plans.find((plan) => plan.placement === 'split')!;
      expect(critical).toMatchObject({ from: 'B0', to: 'B2', host: 'E0' });
      expect(lowered.edges).toContainEqual({ id: 'B0-false-B2', from: 'B0', to: 'E0', kind: 'false' });
      expect(lowered.edges).toContainEqual({ id: 'E0-next-B2', from: 'E0', to: 'B2', kind: 'next' });
      expect(lowered.execution!.output).toEqual([choose ? 7 : 1]);
      expect(lowered.visitedBlocks.includes('E0')).toBe(!choose);
      expect(compareVmExecutions(result.baseline!, lowered.execution!)).toBe('same');
      expect(compareSSA(lowered.execution!, result.ssa!.execution!)).toBe('same');
    }
  });

  it('uses predecessor copies for diamonds, loop entry and backedges; retains zero-trip structure', () => {
    const diamond = analyze(outSsaPresets[1].code).outssa!;
    expect(diamond.plans.every((plan) => plan.placement === 'predecessor')).toBe(true);
    expect(diamond.blocks.filter((block) => !block.original)).toEqual([]);
    const loop = analyze(outSsaPresets[2].code).outssa!;
    expect(loop.execution!.output).toEqual([6]);
    expect(loop.plans.map((plan) => plan.from)).toEqual(['B0', 'B2']);
    const zero = analyze(outSsaPresets[4].code).outssa!;
    expect(zero.execution!.output).toEqual([0]);
    expect(zero.plans.some((plan) => plan.from === 'B2')).toBe(true);
    expect(zero.visitedBlocks).not.toContain('B2');
  });

  it('can place a manually added one-predecessor phi at its successor entry', () => {
    const source = 'bool c = true; int x = 5; if (c) { print(x); } else { print(9); }';
    const result = analyze(source);
    const blocks = structuredClone(result.ssa!.blocks);
    const thenBlock = blocks.find((block) => block.id === 'B1')!;
    const print = thenBlock.instructions.find((instruction) => instruction.op === 'print')!;
    if (print.op !== 'print' || print.value.kind !== 'ref') throw new Error('fixture');
    thenBlock.phis.push({ variable: 'q', dest: 'q.1', inputs: [{ predecessor: 'B0', name: print.value.name }] });
    print.value = { kind: 'ref', name: 'q.1' };
    const lower = lowerSSA({ valid: true, blocks }, result.dominance!);
    expect(lower.issues).toEqual([]);
    expect(lower.plans[0]).toMatchObject({ placement: 'successor', host: 'B1' });
    expect(lower.execution!.output).toEqual([5]);
  });

  it('preserves successful presets and exception order independently of optimizer flags', () => {
    for (const preset of presets) {
      const result = compile(preset.code, options, { outOfSSA: true });
      if (!result.ir) continue;
      expect(result.outssa?.issues, preset.id).toEqual([]);
      expect(compareVmExecutions(result.baseline!, result.outssa!.execution!), preset.id)
        .toBe(result.baseline!.limited || result.outssa!.execution!.limited ? 'unknown' : 'same');
    }
    expect(analyze(outSsaPresets[3].code).outssa!.execution!.output).toEqual([2, 1]);
    const trapped = analyze(outSsaPresets[6].code).outssa!.execution!;
    expect(trapped.output).toEqual([5]);
    expect(trapped.error?.message).toBe('整数除法的除数不能为 0。');
    const overflow = analyze('print(5); int unused = 9007199254740991 + 1; print(6);');
    expect(compareVmExecutions(overflow.baseline!, overflow.outssa!.execution!)).toBe('same');
  });

  it('executes a cyclic loop phi bundle in the original VM using a saved temporary', () => {
    const source = 'int a = 1; int b = 2; int i = 0; while (i < 3) { i = i + 1; } print(a); print(b);';
    const result = analyze(source);
    const blocks = structuredClone(result.ssa!.blocks);
    const header = blocks.find((block) => block.id === 'B1')!;
    header.phis.push(
      { variable: 'v0_a', dest: 'a.loop', inputs: [{ predecessor: 'B0', name: 'v0_a.1' }, { predecessor: 'B2', name: 'b.loop' }] },
      { variable: 'v1_b', dest: 'b.loop', inputs: [{ predecessor: 'B0', name: 'v1_b.1' }, { predecessor: 'B2', name: 'a.loop' }] },
    );
    for (const block of blocks) for (const instruction of block.instructions) {
      if (instruction.op !== 'print' || instruction.value.kind !== 'ref') continue;
      if (instruction.value.name === 'v0_a.1') instruction.value = { kind: 'ref', name: 'a.loop' };
      if (instruction.value.name === 'v1_b.1') instruction.value = { kind: 'ref', name: 'b.loop' };
    }
    const interpreted = executeSSA(blocks, result.dominance!);
    const lower = lowerSSA({ valid: true, blocks }, result.dominance!);
    expect(lower.issues).toEqual([]);
    expect(lower.plans.find((plan) => plan.from === 'B2')!.temporaries).toHaveLength(1);
    expect(interpreted.output).toEqual([2, 1]);
    expect(lower.execution!.output).toEqual([2, 1]);
    expect(compareSSA(lower.execution!, interpreted)).toBe('same');
  });

  it('handles empty/no-phi programs, rejects invalid SSA, and leaves the source representation untouched', () => {
    const empty = analyze('');
    expect(empty.outssa!.execution!.halted).toBe(true);
    expect(empty.outssa!.plans).toEqual([]);
    expect(analyze(outSsaPresets[5].code).outssa!.plans).toEqual([]);
    const result = analyze(outSsaPresets[0].code);
    const before = structuredClone(result.ssa!.blocks);
    lowerSSA(result.ssa!, result.dominance!);
    expect(result.ssa!.blocks).toEqual(before);
    const invalid = structuredClone(result.ssa!);
    invalid.blocks.find((block) => block.phis.length)!.phis[0].inputs.pop();
    expect(lowerSSA(invalid, result.dominance!).execution).toBeUndefined();
    expect(lowerSSA({ valid: false, blocks: [] }, result.dominance!).valid).toBe(false);
    expect(lowerSSA({ valid: true, blocks: before.slice(1) }, result.dominance!).valid).toBe(false);
    expect(compile('print(1);', options).outssa).toBeUndefined();
  });

  it('keeps final results after trace truncation and reports execution exhaustion as unknown', () => {
    const large = analyze('int x = 0;' + 'x=x+1;'.repeat(150) + 'print(x);');
    expect(large.outssa!.traceTruncated).toBe(true);
    expect(large.outssa!.execution!.output).toEqual([150]);
    expect(large.outssa!.frames.at(-1)?.vmStep).toBe(large.outssa!.execution!.steps.length - 1);
    expect(large.outssa!.frames.at(-1)?.block).toBe('HALT');
    const infinite = analyze('while (true) {}');
    expect(infinite.outssa!.execution!.limited).toBe(true);
    expect(compareVmExecutions(infinite.baseline!, infinite.outssa!.execution!)).toBe('unknown');
  });

  it('does not execute a partially generated IR when the expansion budget is exceeded', () => {
    const result = analyze('print(1);');
    const blocks = structuredClone(result.ssa!.blocks);
    blocks[0].instructions = Array.from({ length: 10001 }, (_, index) => ({
      op: 'move', dest: `x.${index}`, value: { kind: 'constant', value: index }, nodeId: 0,
    }));
    const lower = lowerSSA({ valid: true, blocks }, result.dominance!);
    expect(lower.valid).toBe(false);
    expect(lower.issues.join(' ')).toContain('10000');
    expect(lower.bytecode).toBeUndefined();
    expect(lower.execution).toBeUndefined();
  });
});

describe('editable parallel-copy workbench', () => {
  it('computes preset outcomes from actual simultaneous, naive and scheduled assignments', () => {
    for (const preset of copyPresets) {
      const outcome = analyzeCopyExperiment(preset.code);
      if (!outcome.ok) throw new Error(outcome.issue);
      expect(outcome.experiment.scheduledCorrect).toBe(true);
      expect(outcome.experiment.naiveCorrect).toBe(preset.id === 'identity');
    }
    const swap = analyzeCopyExperiment(copyPresets[0].code);
    if (!swap.ok) throw new Error(swap.issue);
    expect(swap.experiment.rows).toEqual([
      { name: 'a', initial: 1, parallel: 2, naive: 2, scheduled: 2 },
      { name: 'b', initial: 2, parallel: 1, naive: 2, scheduled: 1 },
    ]);
  });

  it('validates copy syntax, size, destinations, initialization and safe integers', () => {
    for (const text of ['x'.repeat(501), 'a <- b', 'a = b\n%%\nb = 1',
      'a <- b\na <- c\n%%\nb = 1\nc = 2', 'a <- b\n%%\nc = 1',
      'a <- b\n%%\nb = 9007199254740992', 'a <- b\n%%\nb = 1\nb = 2'])
      expect(analyzeCopyExperiment(text).ok).toBe(false);
  });
});
