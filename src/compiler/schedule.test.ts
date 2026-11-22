import { describe, expect, it } from 'vitest';
import { compile } from './index';
import {
  allocateRegisters, compareExecutions, executeRegisters, MAX_REGISTERS, MIN_REGISTERS,
  type AllocationAlgorithm, type RegisterInstruction,
} from './regalloc';
import {
  buildDependences, checkOrder, latencyOf, listSchedule, peephole, scheduleAllocation, scheduleLength, splitBlocks,
} from './schedule';
import { presets } from '../content/lessons';
import { schedulePresets } from '../content/schedule';

const options = { fold: false, propagate: false, dead: false };
const reg = (index: number) => ({ kind: 'register' as const, index });
const imm = (value: number) => ({ kind: 'constant' as const, value });
const at = { origin: 0, comment: '' };
const preset = (id: string) => schedulePresets.find((item) => item.id === id)!.code;
function analyze(source: string, count: number, algorithm: AllocationAlgorithm = 'color') {
  const result = compile(source, options, { registers: { count, algorithm }, schedule: true });
  if (!result.schedule) throw new Error(result.diagnostic?.message);
  return { result, analysis: result.schedule };
}

describe('dependences and timing', () => {
  const block: RegisterInstruction[] = [
    { op: 'load', dest: 0, slot: 0, ...at },
    { op: 'binary', dest: 1, operator: '+', left: reg(0), right: imm(1), ...at },
    { op: 'move', dest: 0, value: imm(5), ...at },
    { op: 'print', value: reg(1), ...at },
  ];
  it('labels true, anti and output dependences with latency-aware weights', () => {
    const edges = buildDependences(block);
    expect(edges).toContainEqual({ from: 0, to: 1, kind: 'raw', weight: 3, via: 'r0' });
    expect(edges).toContainEqual({ from: 1, to: 2, kind: 'war', weight: 1, via: 'r0' });
    expect(edges).toContainEqual({ from: 0, to: 2, kind: 'waw', weight: 3, via: 'r0' });
    expect(edges).toContainEqual({ from: 1, to: 3, kind: 'order', weight: 1, via: '输出' });
  });

  it('fills the load delay with independent work and the machine counts the same cycles', () => {
    const independent: RegisterInstruction[] = [
      { op: 'load', dest: 0, slot: 0, ...at },
      { op: 'binary', dest: 1, operator: '+', left: reg(0), right: imm(1), ...at },
      { op: 'move', dest: 2, value: imm(7), ...at },
      { op: 'move', dest: 3, value: imm(8), ...at },
    ];
    const edges = buildDependences(independent);
    const { order } = listSchedule(independent, edges);
    expect(order).toEqual([0, 2, 3, 1]);
    expect(scheduleLength(edges, [0, 1, 2, 3])).toBe(6);
    expect(scheduleLength(edges, order)).toBe(4);
    const setup: RegisterInstruction[] = [{ op: 'move', dest: 0, value: imm(4), ...at }, { op: 'store', slot: 0, value: 0, ...at }];
    const timed = (body: RegisterInstruction[]) =>
      executeRegisters([...setup, ...body], 4, 1, { record: false, latency: latencyOf });
    const before = timed(independent), after = timed(order.map((node) => independent[node]));
    expect(before.stalls! - after.stalls!).toBe(2);
    expect(after.cycles).toBeLessThan(before.cycles!);
  });

  it('the independent order check rejects moves across a reuse, a slot or an output', () => {
    expect(checkOrder(block, [0, 2, 1, 3]).join('')).toContain('被移到了');
    expect(checkOrder(block, [0, 1, 3, 2])).toEqual([]);
    const outputs: RegisterInstruction[] = [
      { op: 'print', value: imm(1), ...at },
      { op: 'binary', dest: 0, operator: '/', left: imm(1), right: reg(1), ...at },
    ];
    expect(checkOrder(outputs, [1, 0])).not.toEqual([]);
    expect(checkOrder(block, [0, 1, 2])).toEqual(['排序结果不是原指令的排列。']);
  });

  it('keeps branches at the end of their block', () => {
    const program: RegisterInstruction[] = [
      { op: 'label', name: 'L0', ...at },
      { op: 'binary', dest: 0, operator: '<', left: reg(1), right: imm(5), ...at },
      { op: 'move', dest: 2, value: imm(1), ...at },
      { op: 'branch', condition: reg(0), target: 'L1', ...at },
      { op: 'label', name: 'L1', ...at },
    ];
    const blocks = splitBlocks(program);
    expect(blocks.map((item) => item.body.length)).toEqual([3, 0]);
    const { order } = listSchedule(blocks[0].body, buildDependences(blocks[0].body));
    expect(order.at(-1)).toBe(2);
  });
});

describe('peephole', () => {
  it('drops a load that reads back the register just stored, as in chapter 08', () => {
    const { program, rewrites } = peephole([
      { op: 'store', slot: 0, value: 0, ...at }, { op: 'load', dest: 0, slot: 0, ...at }, { op: 'print', value: reg(0), ...at },
    ]);
    expect(rewrites.map((item) => item.rule)).toEqual(['redundant-load']);
    expect(program.map((item) => item.op)).toEqual(['store', 'print']);
  });

  it('forwards to a different register, removes dead stores, self copies and jumps to the next label', () => {
    const { program, rewrites } = peephole([
      { op: 'store', slot: 0, value: 1, ...at }, { op: 'store', slot: 0, value: 2, ...at }, { op: 'load', dest: 0, slot: 0, ...at },
      { op: 'move', dest: 3, value: reg(3), ...at }, { op: 'jump', target: 'L9', ...at }, { op: 'label', name: 'L9', ...at },
    ]);
    expect(rewrites.map((item) => item.rule).sort()).toEqual(['dead-store', 'forward', 'jump-next', 'self-move']);
    expect(program).toMatchObject([{ op: 'store', value: 2 }, { op: 'move', dest: 0, value: reg(2) }, { op: 'label', name: 'L9' }]);
  });

  it('does not look across a label, where another path may enter', () => {
    const { rewrites } = peephole([
      { op: 'store', slot: 0, value: 0, ...at }, { op: 'label', name: 'L0', ...at }, { op: 'load', dest: 0, slot: 0, ...at },
    ]);
    expect(rewrites).toEqual([]);
  });
});

describe('scheduling keeps behaviour', () => {
  function verify(source: string) {
    const base = compile(source, options);
    if (!base.ir) return;
    for (let count = MIN_REGISTERS; count <= MAX_REGISTERS; count++)
      for (const algorithm of ['color', 'linear'] as const) {
        const allocation = allocateRegisters(base.ir, base.dominance!, { count, algorithm }, { record: false });
        const analysis = scheduleAllocation(allocation, { record: false });
        const label = `${algorithm} K=${count}\n${source}`;
        expect(analysis.issues, label).toEqual([]);
        expect(analysis.checkIssues, label).toEqual([]);
        for (const run of [analysis.runs!.peephole, analysis.runs!.scheduled]) {
          const outcome = compareExecutions(base.baseline!, run);
          if (outcome === 'unknown') expect(base.baseline!.limited || run.limited, label).toBe(true);
          else expect(outcome, label).toBe('same');
        }
        expect(analysis.scheduled.length, label).toBe(analysis.afterPeephole.length);
      }
  }
  it('matches the VM for every Mini C preset, K and algorithm', () => {
    for (const { code } of [...presets, ...schedulePresets]) verify(code);
  });
  it('matches the VM on seeded random programs', () => {
    let seed = 7;
    const random = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    for (let round = 0; round < 30; round++) {
      const names = Array.from({ length: 3 + random(4) }, (_, index) => `v${index}`);
      const expression = (depth: number): string => depth <= 0 || random(3) === 0
        ? (random(2) ? names[random(names.length)] : String(random(9)))
        : `(${expression(depth - 1)} ${['+', '-', '*', '/'][random(4)]} ${expression(depth - 1)})`;
      const lines = names.map((name, index) => `int ${name} = ${index + random(5)};`);
      for (let statement = 0; statement < 4; statement++) {
        if (random(3) === 0) lines.push(`int c${statement} = 0;`, `while (c${statement} < ${1 + random(3)}) {`,
          `  ${names[random(names.length)]} = ${expression(2)};`, `  print(${expression(1)});`, `  c${statement} = c${statement} + 1;`, '}');
        else if (random(2)) lines.push(`${names[random(names.length)]} = ${expression(2)};`);
        else lines.push(`print(${expression(2)});`);
      }
      verify(lines.join('\n'));
    }
  });
});

describe('teaching claims hold for the presets', () => {
  it('hoists the first load in the params example and saves cycles', () => {
    const { analysis } = analyze(preset('sc-params'), 3);
    const block = analysis.blocks[0];
    expect([block.originalLength, block.scheduledLength]).toEqual([29, 27]);
    expect(analysis.runs!.scheduled.cycles).toBeLessThan(analysis.runs!.allocated.cycles!);
    expect(analyze(preset('sc-params'), 6).analysis.runs!.scheduled.cycles).toBe(analyze(preset('sc-params'), 6).analysis.runs!.allocated.cycles);
  });

  it('finds the store-then-reload pair at K = 3', () => {
    const { analysis } = analyze(preset('sc-peephole'), 3);
    expect(analysis.rewrites.map((item) => item.rule)).toEqual(['redundant-load']);
    expect(analysis.runs!.peephole.loads).toBe(analysis.runs!.allocated.loads - 1);
  });

  it('gains nothing in the K = 3 loop but does at K = 2, and false dependences fall as K grows', () => {
    const { result, analysis } = analyze(preset('sc-loop'), 3);
    expect(analysis.runs!.scheduled.cycles).toBe(analysis.runs!.allocated.cycles);
    const two = analyze(preset('sc-loop'), 2).analysis.runs!;
    expect(two.scheduled.cycles).toBeLessThan(two.allocated.cycles!);
    const sweep = result.scheduleSweep!;
    expect(sweep[0].falseDependences).toBeGreaterThan(sweep.at(-1)!.falseDependences);
    expect(sweep.every((row) => row.outcome === 'same')).toBe(true);
  });

  it('never moves the trapping division above the first print', () => {
    const { analysis } = analyze(preset('sc-trap'), 3);
    const order = analysis.scheduled.map((item) => item.op === 'binary' ? item.operator : item.op);
    expect(order.indexOf('/')).toBeGreaterThan(order.indexOf('print'));
    expect(analysis.runs!.scheduled.output).toEqual([70]);
    expect(analysis.runs!.scheduled.error?.message).toContain('除数不能为 0');
  });

  it('records a bounded replay and stops cleanly when allocation failed', () => {
    const { analysis } = analyze(preset('sc-params'), 3);
    expect(analysis.frames[0].kind).toBe('initial');
    expect(analysis.frames.at(-1)!.kind).toBe('complete');
    expect(analysis.frames.length).toBeLessThanOrEqual(242);
    const allocation = allocateRegisters([], { converged: false } as never, { count: 3, algorithm: 'color' });
    expect(scheduleAllocation(allocation).issues[0]).toContain('没有完成');
  });
});
