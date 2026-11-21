import { describe, expect, it } from 'vitest';
import { compile } from './index';
import { buildCFG } from './cfg';
import { analyzeDominance } from './dominance';
import { analyzeLiveness } from './dataflow';
import { buildSSA, compareSSA, executeSSA, validateSSA, type SsaBlock } from './ssa';
import { ssaPresets } from '../content/ssa';
import { presets, defaultOptions } from '../content/lessons';
import type { Instruction } from './model';

const options = { fold: false, propagate: false, dead: false };
const analyze = (source: string) => {
  const result = compile(source, options);
  expect(result.ir).toBeDefined();
  expect(result.ssa?.issues).toEqual([]);
  expect(result.ssa?.valid).toBe(true);
  return result;
};

describe('pruned SSA construction and independent execution', () => {
  it('gives every assignment one version and reads the old version before writing', () => {
    const result = analyze('int x = 1; x = x + 1; x = x + 2; print(x);');
    const code = result.ssa!.blocks.flatMap((block) => block.instructions);
    expect(code.filter((instruction) => 'dest' in instruction).map((instruction) => instruction.dest))
      .toEqual(['v0_x.1', 't0.1', 'v0_x.2', 't1.1', 'v0_x.3']);
    expect(code[1]).toMatchObject({ left: { name: 'v0_x.1' } });
    expect(code[3]).toMatchObject({ left: { name: 'v0_x.2' } });
    expect(result.ssa!.execution!.output).toEqual([4]);
  });

  it('fills both diamond inputs without using a single execution to remove an edge', () => {
    for (const condition of ['true', 'false']) {
      const source = ssaPresets[0].code.replace('true', condition);
      const result = analyze(source);
      const phi = result.ssa!.blocks.flatMap((block) => block.phis)[0];
      expect(phi.variable).toBe('v1_value');
      expect(phi.inputs.map((input) => input.predecessor)).toEqual(['B1', 'B2']);
      expect(new Set(phi.inputs.map((input) => input.name)).size).toBe(2);
      expect(result.ssa!.execution!.output).toEqual([condition === 'true' ? 7 : 9]);
      const chosen = result.ssa!.execution!.steps.find((step) => step.selections?.length);
      expect(chosen?.predecessor).toBe(condition === 'true' ? 'B1' : 'B2');
      expect(compareSSA(result.baseline!, result.ssa!.execution!)).toBe('same');
    }
  });

  it('prunes overwritten values and loop-local temporaries using live-in sets', () => {
    const result = analyze(ssaPresets[2].code);
    expect(result.ssa!.placements).toContainEqual({ variable: 'v1_value', block: 'B3', retained: false });
    expect(result.ssa!.blocks.flatMap((block) => block.phis)).toEqual([]);
    expect(result.ssa!.execution!.output).toEqual([11]);
    const loop = analyze(ssaPresets[1].code);
    expect(loop.ssa!.blocks.flatMap((block) => block.phis).map((phi) => phi.variable)).toEqual(['v0_i', 'v1_total']);
    expect(loop.ssa!.execution!.output).toEqual([6]);
    const selections = loop.ssa!.execution!.steps.filter((step) => step.selections?.length);
    expect(selections).toHaveLength(5);
    expect(selections[0].predecessor).toBe('B0');
    expect(selections[1].predecessor).toBe('B2');
  });

  it('preserves all successful presets, nested loops, shadowing and zero iterations', () => {
    for (const preset of presets) {
      const result = compile(preset.code, defaultOptions);
      if (!result.ir) continue;
      expect(result.ssa?.issues, preset.id).toEqual([]);
      expect(compareSSA(result.baseline!, result.ssa!.execution!), preset.id)
        .toBe(result.baseline!.limited || result.ssa!.execution!.limited ? 'unknown' : 'same');
    }
    expect(analyze(ssaPresets[3].code).ssa!.execution!.output).toEqual([8, 3]);
    expect(analyze(ssaPresets[4].code).ssa!.execution!.output).toEqual([2, 1]);
    expect(analyze(ssaPresets[1].code.replace('i < 4', 'i < 0')).ssa!.execution!.output).toEqual([0]);
  });

  it('matches independent arithmetic expectations across branches and loop counts', () => {
    for (let n = 0; n < 7; n++) for (const flag of [true, false]) {
      const result = analyze(`int i = 0; int total = 0; bool flag = ${flag};
        while (i < ${n}) { if (flag) { total = total + i; } else { total = total - i; } i = i + 1; }
        print(total);`);
      const sum = n < 2 ? 0 : n * (n - 1) / 2;
      expect(result.ssa!.execution!.output).toEqual([flag ? sum : (sum === 0 ? 0 : -sum)]);
      expect(compareSSA(result.baseline!, result.ssa!.execution!)).toBe('same');
    }
  });

  it('keeps output and exception order for division and overflow, including dead results', () => {
    for (const source of [ssaPresets[5].code,
      'print(5); int unused = 9007199254740991 + 1; print(6);',
      'if (false) { int unused = 1 / 0; } print(7);']) {
      const result = analyze(source);
      expect(compareSSA(result.baseline!, result.ssa!.execution!)).toBe('same');
    }
    const trapped = analyze(ssaPresets[5].code).ssa!.execution!;
    expect(trapped.output).toEqual([5]);
    expect(trapped.error).toBe('整数除法的除数不能为 0。');
  });

  it('handles empty programs and reports budget exhaustion without declaring equality', () => {
    expect(analyze('').ssa!.execution!.halted).toBe(true);
    const result = analyze('while (true) { print(1); }');
    expect(result.ssa!.execution!.limited).toBe(true);
    expect(result.ssa!.execution!.traceTruncated).toBe(true);
    expect(result.ssa!.steps.at(-1)?.output).toEqual(result.ssa!.execution!.output);
    expect(compareSSA(result.baseline!, result.ssa!.execution!)).toBe('unknown');
  });

  it('caps construction records without losing final definitions or validation', () => {
    const source = 'int x = 0;' + 'x=x+1;'.repeat(160) + 'print(x);';
    const result = analyze(source);
    expect(result.ssa!.traceTruncated).toBe(true);
    expect(result.ssa!.execution!.output).toEqual([160]);
    expect(result.ssa!.steps.some((step) => step.kind === 'validated')).toBe(true);
    expect(result.ssa!.steps.at(-1)?.kind).toBe('complete');
  });

  it('refuses to publish SSA when prerequisite analysis did not converge', () => {
    const result = analyze(ssaPresets[0].code);
    const stalled = analyzeDominance(result.cfg!, { maxPasses: 0 });
    expect(buildSSA(stalled, result.liveness!).valid).toBe(false);
    expect(buildSSA(stalled, result.liveness!).execution).toBeUndefined();
    expect(buildSSA(result.dominance!, { ...result.liveness!, converged: false }).valid).toBe(false);
  });
});

describe('SSA structure validation', () => {
  it('rejects duplicate definitions, undefined uses and same-block use before definition', () => {
    const result = analyze('int x = 1; print(x);');
    const bad = structuredClone(result.ssa!.blocks);
    bad[0].instructions.push(bad[0].instructions[0]);
    expect(validateSSA(bad, result.dominance!).join(' ')).toContain('重复定义');
    bad[0].instructions = [{ op: 'print', value: { kind: 'ref', name: 'missing' }, nodeId: 0 }];
    expect(validateSSA(bad, result.dominance!).join(' ')).toContain('没有定义');
    bad[0].instructions = [...result.ssa!.blocks[0].instructions].reverse();
    expect(validateSSA(bad, result.dominance!).join(' ')).toContain('没有支配');
  });

  it('rejects missing/duplicate phi predecessors and non-dominating incoming definitions', () => {
    const result = analyze(ssaPresets[0].code);
    const bad = structuredClone(result.ssa!.blocks);
    const phi = bad.flatMap((block) => block.phis)[0];
    phi.inputs[1].name = phi.inputs[0].name;
    expect(validateSSA(bad, result.dominance!).join(' ')).toContain('没有支配');
    phi.inputs[1].predecessor = phi.inputs[0].predecessor;
    expect(validateSSA(bad, result.dominance!).join(' ')).toContain('一一对应');
    phi.inputs.pop();
    expect(validateSSA(bad, result.dominance!).join(' ')).toContain('一一对应');
  });

  it('reads all loop phi inputs before writing any output (parallel swap)', () => {
    const raw: Instruction[] = [
      { op: 'move', dest: 'a', value: { kind: 'constant', value: 1 }, nodeId: 0 },
      { op: 'label', name: 'loop', nodeId: 1 },
      { op: 'jump', target: 'loop', nodeId: 2 },
    ];
    const dominance = analyzeDominance(buildCFG(raw));
    const blocks: SsaBlock[] = [
      { id: 'B0', phis: [], instructions: [
        { op: 'move', dest: 'a.1', value: { kind: 'constant', value: 1 }, nodeId: 0 },
        { op: 'move', dest: 'b.1', value: { kind: 'constant', value: 2 }, nodeId: 0 },
      ] },
      { id: 'B1', instructions: [], phis: [
        { variable: 'a', dest: 'a.2', inputs: [{ predecessor: 'B0', name: 'a.1' }, { predecessor: 'B1', name: 'b.2' }] },
        { variable: 'b', dest: 'b.2', inputs: [{ predecessor: 'B0', name: 'b.1' }, { predecessor: 'B1', name: 'a.2' }] },
      ] },
    ];
    expect(validateSSA(blocks, dominance)).toEqual([]);
    const execution = executeSSA(blocks, dominance);
    expect(execution.error).toBeUndefined();
    const entries = execution.steps.filter((step) => step.selections?.length);
    expect(entries.slice(0, 3).map((step) => step.selections!.map((selection) => selection.value)))
      .toEqual([[1, 2], [2, 1], [1, 2]]);
    expect(execution.limited).toBe(true);
  });

  it('does not mutate the original mutable-variable IR', () => {
    const result = analyze(ssaPresets[1].code);
    const before = structuredClone(result.ir);
    buildSSA(result.dominance!, analyzeLiveness(result.ir!));
    expect(result.ir).toEqual(before);
    expect(result.ir!.some((instruction) => 'dest' in instruction && instruction.dest.includes('.'))).toBe(false);
  });
});
