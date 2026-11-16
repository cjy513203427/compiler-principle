import { describe, expect, it } from 'vitest';
import { compile, type Instruction } from './index';
import { analyzeConstants, analyzeLiveness, joinFact, sameFact } from './dataflow';
import { optimizeControlFlow } from './global-optimizer';
import { instructionText } from './ir';
import { defaultOptions, dataflowPresets, flowPresets } from '../content/lessons';
const run = (code: string) => compile(code, defaultOptions);
const printFact = (result: ReturnType<typeof run>, name: string) => {
  const index = result.ir!.map((i) => i.op === 'print').lastIndexOf(true);
  return result.dataflow!.blocks[result.dataflow!.graph.instructionBlock[index]].output[name];
};
describe('constant facts and fixed points', () => {
  it('joins bottom, equal constants, different constants and different runtime types', () => {
    const seven = { kind: 'constant', value: 7 } as const;
    expect(joinFact(undefined, seven)).toEqual(seven);
    expect(joinFact(seven, { ...seven })).toEqual(seven);
    expect(joinFact(seven, { kind: 'constant', value: 9 })).toEqual({ kind: 'overdefined' });
    expect(joinFact({ kind: 'constant', value: true }, { kind: 'constant', value: 1 })).toEqual({
      kind: 'overdefined',
    });
    expect(joinFact(seven, { kind: 'overdefined' })).toEqual({ kind: 'overdefined' });
  });
  it('retains equal constants at a join but cannot choose between differing predecessor values', () => {
    const equal = run(dataflowPresets[0].code);
    const different = run(dataflowPresets[1].code);
    expect(printFact(equal, 'v1_value')).toEqual({ kind: 'constant', value: 7 });
    expect(printFact(different, 'v1_value')).toEqual({ kind: 'overdefined' });
    expect(equal.execution?.output).toEqual([7]);
    expect(different.execution?.output).toEqual([7]);
    expect(
      equal.optimization
        ?.at(-1)
        ?.instructions.some(
          (i) => i.op === 'print' && i.value.kind === 'constant' && i.value.value === 7,
        ),
    ).toBe(true);
    expect(
      different.optimization
        ?.at(-1)
        ?.instructions.some((i) => i.op === 'print' && i.value.kind === 'ref'),
    ).toBe(true);
  });
  it('revises loop-carried facts while preserving independent invariant constants', () => {
    const result = run(dataflowPresets[3].code);
    expect(printFact(result, 'v0_i')).toEqual({ kind: 'overdefined' });
    expect(printFact(result, 'v1_fixed')).toEqual({ kind: 'constant', value: 5 });
    expect(result.dataflow!.iterations).toBeGreaterThan(1);
    expect(
      result.dataflow!.steps.some(
        (s) => s.changed.includes('v0_i') && s.output.v0_i?.kind === 'overdefined',
      ),
    ).toBe(true);
    expect(result.execution?.output).toEqual([8]);
  });
  it('reaches the same facts and executable edges in reverse block-processing order', () => {
    for (const preset of [...dataflowPresets, ...flowPresets.slice(0, 4)]) {
      const result = run(preset.code);
      const reversed = analyzeConstants(result.ir!, { reverse: true });
      expect(reversed.converged).toBe(true);
      expect(reversed.blocks).toEqual(result.dataflow!.blocks);
      expect([...reversed.enabledEdges].sort()).toEqual([...result.dataflow!.enabledEdges].sort());
    }
  });
  it('keeps immutable analysis snapshots and checks every enabled predecessor used in a merge', () => {
    const result = run(dataflowPresets[0].code);
    const analysis = result.dataflow!;
    for (const frame of analysis.steps.filter(
      (s) => s.kind === 'visit' && s.block !== analysis.graph.blocks[0].id,
    )) {
      for (const name of analysis.variables) {
        const merged = frame.predecessors
          .filter((p) => p.enabled)
          .reduce<ReturnType<typeof joinFact>>(
            (value, predecessor) => joinFact(value, predecessor.output[name]),
            undefined,
          );
        expect(sameFact(merged, frame.input[name])).toBe(true);
      }
    }
    const first = analysis.steps.find((s) => s.output.v0_i?.kind === 'constant');
    expect(first?.output.v0_i).toEqual({ kind: 'constant', value: 0 });
    expect(analysis.steps.at(-1)?.kind).toBe('complete');
  });
  it('limits recorded steps without stopping the full fixed-point computation', () => {
    const code: Instruction[] = [
      { op: 'move', dest: 'v0_value', value: { kind: 'constant', value: 7 }, nodeId: 0 },
    ];
    for (let index = 0; index < 260; index++) {
      code.push(
        { op: 'jump', target: `L${index}`, nodeId: index },
        { op: 'label', name: `L${index}`, nodeId: index },
      );
    }
    code.push({ op: 'print', value: { kind: 'ref', name: 'v0_value' }, nodeId: 300 });
    const analysis = analyzeConstants(code);
    expect(analysis.traceTruncated).toBe(true);
    expect(analysis.converged).toBe(true);
    expect(analysis.steps.length).toBeLessThanOrEqual(242);
    expect(analysis.steps.at(-1)?.kind).toBe('complete');
    expect(analysis.blocks.Exit.input.v0_value).toEqual({ kind: 'constant', value: 7 });
  });
  it('never optimizes based on a deliberately incomplete analysis', () => {
    const result = run(dataflowPresets[0].code);
    const incomplete = analyzeConstants(result.ir!, { maxPasses: 1 });
    expect(incomplete.converged).toBe(false);
    expect(
      optimizeControlFlow(result.ir!, defaultOptions, incomplete).at(-1)?.instructions,
    ).toEqual(result.ir);
  });
});
describe('global transformations and liveness', () => {
  it('removes proven unreachable traps but retains selected traps, overflow and output ordering', () => {
    const skipped = run(dataflowPresets[2].code);
    expect(skipped.execution?.output).toEqual([7]);
    expect(skipped.optimization?.at(-1)?.instructions.map(instructionText)).toEqual(['print 7']);
    expect(
      skipped.optimization
        ?.at(-1)
        ?.instructions.some((i) => i.op === 'binary' && i.operator === '/'),
    ).toBe(false);
    for (const source of [
      dataflowPresets[2].code.replace('false', 'true'),
      'print(1); if (true) { int unused = 9007199254740991 + 1; } print(2);',
    ]) {
      const result = run(source);
      expect(result.execution?.error?.message).toBe(result.baseline?.error?.message);
      expect(result.execution?.output).toEqual(result.baseline?.output);
      expect(result.optimization?.at(-1)?.instructions.some((i) => i.op === 'binary')).toBe(true);
    }
  });
  it('keeps writes needed on another block or a loop backedge while removing unused copies', () => {
    const result = compile(dataflowPresets[4].code, { fold: false, propagate: false, dead: true });
    const text = result.optimization!.at(-1)!.instructions.map(instructionText).join('\n');
    expect(text).toContain('v0_value = 7');
    expect(text).not.toContain('v1_dead');
    expect(text).toContain('v2_i');
    expect(result.execution?.output).toEqual([7]);
    const live = analyzeLiveness(result.ir!);
    expect(live.converged).toBe(true);
    expect(Object.values(live.output).some((values) => values.includes('v0_value'))).toBe(true);
  });
  it('preserves calculated behavior under every option combination for generated nested programs', () => {
    for (let flags = 0; flags < 8; flags++)
      for (let limit = 0; limit <= 5; limit++) {
        const source = `int i = 0; int sum = 0; while (i < ${limit}) { if (i < 2) { sum = sum + 10; } else { sum = sum + i; } i = i + 1; } print(sum); print(i);`;
        const result = compile(source, {
          fold: !!(flags & 1),
          propagate: !!(flags & 2),
          dead: !!(flags & 4),
        });
        const expected = [
          Array.from({ length: limit }, (_, i) => (i < 2 ? 10 : i)).reduce((sum, x) => sum + x, 0),
          limit,
        ];
        expect(result.execution?.output, source).toEqual(expected);
        expect(result.baseline?.output).toEqual(expected);
        expect(result.execution?.halted).toBe(true);
        expect(result.dataflow?.converged).toBe(true);
        if (!flags) expect(result.optimization?.at(-1)?.instructions).toEqual(result.ir);
      }
  });
  it('agrees with each actual block exit on every constant that the static analyzer proves', () => {
    for (const preset of [...dataflowPresets, ...flowPresets.slice(0, 5)]) {
      const result = run(preset.code);
      for (const frame of result.controlTrace!.slice(1)) {
        const facts = result.dataflow!.blocks[frame.block].output;
        const state = result.baseline!.steps[frame.vmStep];
        for (const [name, fact] of Object.entries(facts))
          if (fact.kind === 'constant' && name in state.memory)
            expect(state.memory[name], `${preset.id}/${frame.block}/${name}`).toBe(fact.value);
      }
    }
  });
  it('preserves nontermination and does not treat the VM instruction budget as a language effect', () => {
    const result = run('while (true) { print(1); } print(99);');
    expect(result.execution?.limited).toBe(true);
    expect(result.baseline?.limited).toBe(true);
    expect(result.execution?.halted).toBe(false);
    expect(result.execution?.output.every((value) => value === 1)).toBe(true);
    expect(
      result.optimization
        ?.at(-1)
        ?.instructions.some(
          (i) => i.op === 'print' && i.value.kind === 'constant' && i.value.value === 99,
        ),
    ).toBe(false);
  });
  it('terminates a liveness cycle with uses and no exit and does not invent live-in values', () => {
    const code: Instruction[] = [
      { op: 'label', name: 'L0', nodeId: 0 },
      { op: 'print', value: { kind: 'ref', name: 'v0_x' }, nodeId: 1 },
      { op: 'jump', target: 'L0', nodeId: 2 },
    ];
    const live = analyzeLiveness(code);
    expect(live.converged).toBe(true);
    expect(live.input.B0).toEqual(['v0_x']);
    expect(live.output.B0).toEqual(['v0_x']);
    expect(live.input.Exit).toEqual([]);
  });
});
