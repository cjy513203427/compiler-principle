import { describe, expect, it } from 'vitest';
import { compile } from './index';
import { analyzeLiveness } from './dataflow';
import {
  allocateRegisters, checkAssignment, compareExecutions, executeRegisters, instructionLiveness,
  normalizeRegisterSettings, sweepRegisters, MAX_REGISTERS, MIN_REGISTERS, type AllocationAlgorithm,
} from './regalloc';
import { presets } from '../content/lessons';
import { regallocPresets } from '../content/regalloc';

const options = { fold: false, propagate: false, dead: false };
const prepare = (source: string) => {
  const result = compile(source, options);
  if (!result.ir || !result.dominance || !result.baseline) throw new Error(result.diagnostic?.message);
  return result;
};
const preset = (id: string) => regallocPresets.find((item) => item.id === id)!.code;
const allocate = (source: string, count: number, algorithm: AllocationAlgorithm) => {
  const result = prepare(source);
  return { result, allocation: allocateRegisters(result.ir!, result.dominance!, { count, algorithm }) };
};

function verifyEverywhere(source: string) {
  const result = prepare(source);
  for (let count = MIN_REGISTERS; count <= MAX_REGISTERS; count++)
    for (const algorithm of ['color', 'linear'] as const) {
      const allocation = allocateRegisters(result.ir!, result.dominance!, { count, algorithm }, { record: false });
      const label = `${algorithm} K=${count}\n${source}`;
      expect(allocation.issues, label).toEqual([]);
      expect(allocation.valid, label).toBe(true);
      expect(checkAssignment(allocation.finalCode.map((item) => item.instruction), allocation.assignment, count), label).toEqual([]);
      expect(Object.values(allocation.assignment).every((register) => register >= 0 && register < count), label).toBe(true);
      const outcome = compareExecutions(result.baseline!, allocation.execution!);
      if (outcome === 'unknown') expect(result.baseline!.limited || allocation.execution!.limited, label).toBe(true);
      else expect(outcome, label).toBe('same');
    }
}

describe('instruction-level liveness', () => {
  it('agrees with the block-level liveness analysis at every block entry and exit', () => {
    for (const { code } of [...presets, ...regallocPresets]) {
      const result = compile(code, options);
      if (!result.ir) continue;
      const blocks = analyzeLiveness(result.ir);
      const live = instructionLiveness(result.ir);
      expect(live.converged).toBe(true);
      for (const block of blocks.graph.blocks.filter((item) => item.instructions.length)) {
        expect(live.liveIn[block.start], `${block.id} IN\n${code}`).toEqual(blocks.input[block.id]);
        expect(live.liveOut[block.end - 1], `${block.id} OUT\n${code}`).toEqual(blocks.output[block.id]);
      }
    }
  });
});

describe('register allocation keeps behaviour', () => {
  it('passes the independent assignment check and matches the VM for every preset, K and algorithm', () => {
    for (const { code } of [...presets, ...regallocPresets]) {
      const result = compile(code, options);
      if (result.ir) verifyEverywhere(code);
    }
  });

  it('matches the VM on seeded random programs with loops, copies and traps', () => {
    let seed = 20261122;
    const random = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    for (let round = 0; round < 40; round++) {
      const names = Array.from({ length: 3 + random(4) }, (_, index) => `v${index}`);
      const expression = (depth: number): string => {
        if (depth <= 0 || random(3) === 0) return random(2) ? names[random(names.length)] : String(random(9));
        const op = ['+', '-', '*', '+', '/'][random(5)];
        return `(${expression(depth - 1)} ${op} ${expression(depth - 1)})`;
      };
      const lines = names.map((name, index) => `int ${name} = ${index + random(5)};`);
      for (let statement = 0; statement < 3 + random(3); statement++) {
        if (random(3) === 0) {
          const counter = `c${statement}`;
          lines.push(`int ${counter} = 0;`, `while (${counter} < ${1 + random(3)}) {`,
            `  ${names[random(names.length)]} = ${expression(2)};`, `  print(${expression(1)});`,
            `  ${counter} = ${counter} + 1;`, '}');
        } else if (random(2)) lines.push(`${names[random(names.length)]} = ${expression(2)};`);
        else lines.push(`print(${expression(2)});`);
      }
      verifyEverywhere(lines.join('\n'));
    }
  });
});

describe('teaching claims hold for the presets', () => {
  it('keeps loop variables in registers with graph coloring, while linear scan spills more', () => {
    const color = allocate(preset('ra-loop'), 3, 'color').allocation;
    const linear = allocate(preset('ra-loop'), 3, 'linear').allocation;
    expect(Object.keys(color.slots).sort()).toEqual(['v0_offset', 'v1_scale']);
    expect(Object.keys(linear.slots).sort()).toEqual(['v0_offset', 'v1_scale', 'v3_sum']);
    const memory = (item: typeof color) => item.execution!.loads + item.execution!.stores;
    expect(memory(color)).toBeLessThan(memory(linear));
  });

  it('shows the live-range hole: coloring fits K = 2, linear scan must spill t', () => {
    const color = allocate(preset('ra-holes'), 2, 'color').allocation;
    const linear = allocate(preset('ra-holes'), 2, 'linear').allocation;
    expect(color.rounds[0].graph.adjacency.v0_t).not.toContain('v1_a');
    expect(Object.keys(color.slots)).toEqual([]);
    expect(Object.keys(linear.slots)).toEqual(['v0_t']);
    expect(linear.rounds[0].intervals.find((item) => item.name === 'v0_t')).toMatchObject({ start: 1, end: 14 });
  });

  it('gives both ends of a copy the same register and deletes the copies', () => {
    const { allocation } = allocate(preset('ra-copy'), 2, 'color');
    expect(allocation.rounds[0].graph.edges).toEqual([]);
    expect(new Set(Object.values(allocation.assignment)).size).toBe(1);
    expect(allocation.removedMoves).toBe(2);
    expect(allocation.program.map((item) => item.op)).toEqual(['move', 'print']);
  });

  it('needs no spill once K reaches the peak pressure', () => {
    const result = prepare(preset('ra-pressure'));
    const pressure = Math.max(...instructionLiveness(result.ir!).liveOut.map((set) => set.length));
    expect(pressure).toBe(6);
    for (const algorithm of ['color', 'linear'] as const) {
      expect(Object.keys(allocateRegisters(result.ir!, result.dominance!, { count: pressure, algorithm }).slots)).toEqual([]);
      expect(Object.keys(allocateRegisters(result.ir!, result.dominance!, { count: pressure - 1, algorithm }).slots).length).toBeGreaterThan(0);
    }
  });

  it('keeps output before a trap and stops at the same error after spilling', () => {
    const { result, allocation } = allocate(preset('ra-trap'), 2, 'color');
    expect(Object.keys(allocation.slots).length).toBeGreaterThan(0);
    expect(allocation.execution!.output).toEqual([17]);
    expect(allocation.execution!.error?.message).toBe(result.baseline!.error?.message);
  });

  it('weights spill cost by loop depth', () => {
    const { allocation } = allocate(preset('ra-nested'), 3, 'color');
    const costs = allocation.rounds[0].costs;
    expect(costs.v2_unused).toBe(2);
    expect(costs.v1_total).toBeGreaterThan(100);
    expect(Object.keys(allocation.slots)).toContain('v2_unused');
    expect(Object.keys(allocation.slots)).not.toContain('v1_total');
  });
});

describe('trace, limits and machine', () => {
  it('records a bounded replay that starts with liveness and ends with a check', () => {
    const { allocation } = allocate(preset('ra-nested'), 3, 'linear');
    expect(allocation.frames[0].kind).toBe('liveness');
    expect(allocation.frames.at(-1)!.kind).toBe('complete');
    expect(allocation.frames.filter((frame) => ['liveness', 'graph', 'event', 'rewrite'].includes(frame.kind)).length).toBeLessThanOrEqual(240);
    expect(allocation.frames.some((frame) => frame.kind === 'rewrite')).toBe(true);
    expect(allocation.frames.filter((frame) => frame.kind === 'assigned')).toHaveLength(1);
  });

  it('reports the VM limit as inconclusive rather than equal', () => {
    const { result, allocation } = allocate('int i = 0;\nwhile (i < 100000) {\n  i = i + 1;\n}\nprint(i);', 2, 'color');
    expect(result.baseline!.limited).toBe(true);
    expect(compareExecutions(result.baseline!, allocation.execution!)).toBe('unknown');
  });

  it('normalizes untrusted settings', () => {
    expect(normalizeRegisterSettings('5', 'linear')).toEqual({ count: 5, algorithm: 'linear' });
    expect(normalizeRegisterSettings('1', 'x')).toEqual({ count: 3, algorithm: 'color' });
    expect(normalizeRegisterSettings('9', 'color').count).toBe(3);
    expect(normalizeRegisterSettings('2.5', undefined).count).toBe(3);
  });

  it('the independent check catches a register shared by two live values', () => {
    const { allocation } = allocate(preset('ra-loop'), 3, 'color');
    const code = allocation.finalCode.map((item) => item.instruction);
    const collapsed = Object.fromEntries(Object.keys(allocation.assignment).map((name) => [name, 0]));
    expect(checkAssignment(code, collapsed, 3).join(' ')).toContain('覆盖仍要使用的');
    expect(checkAssignment(code, { ...allocation.assignment, v2_i: 7 }, 3).join(' ')).toContain('不存在的寄存器');
  });

  it('rejects reads of registers that were never written', () => {
    const run = executeRegisters([{ op: 'print', value: { kind: 'register', index: 1 }, origin: 0, comment: '' }], 2, 0);
    expect(run.error?.message).toContain('r1');
    expect(run.halted).toBe(false);
  });

  it('sweeps every K with both algorithms', () => {
    const result = prepare(preset('ra-loop'));
    const rows = sweepRegisters(result.ir!, result.dominance!, result.baseline!);
    expect(rows).toHaveLength((MAX_REGISTERS - MIN_REGISTERS + 1) * 2);
    expect(rows.every((row) => row.outcome === 'same')).toBe(true);
    expect(rows.filter((row) => row.count >= 5).every((row) => row.spilled === 0)).toBe(true);
  });
});
