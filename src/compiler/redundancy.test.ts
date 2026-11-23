import { describe, expect, it } from 'vitest';
import { compile } from './index';
import { compareVmExecutions } from './outssa';
import { referencedVariables } from './dataflow';
import { analyzeRedundancy, expressionKey } from './redundancy';
import { redundancyPresets } from '../content/redundancy';
import { presets } from '../content/lessons';

const options = { fold: false, propagate: false, dead: false };
const analyze = (source: string) => {
  const result = compile(source, options);
  if (!result.ir) throw new Error(result.diagnostic?.message);
  return { result, analysis: analyzeRedundancy(result.ir, result.dominance!) };
};
const preset = (id: string) => redundancyPresets.find((item) => item.id === id)!.code;

function verify(source: string) {
  const { result, analysis } = analyze(source);
  expect(analysis.issues, source).toEqual([]);
  const original = analysis.runs!.original.execution;
  for (const run of [analysis.runs!.cse, analysis.runs!.licm]) {
    const outcome = compareVmExecutions(original, run.execution);
    if (outcome === 'unknown') expect(original.limited || run.execution.limited, source).toBe(true);
    else expect(outcome, source).toBe('same');
    if (run === analysis.runs!.cse) expect(run.operations, source).toBeLessThanOrEqual(analysis.runs!.original.operations);
    // LICM may add work: a hoisted safe computation still runs once when the loop runs zero times.
  }
  // Dynamic availability, independent of the static analysis: replay the original run's stores and
  // require every replaced computation to find its expression still valid with the same value.
  const ir = result.ir!;
  const replaced = new Map(analysis.replacements.map((item) => [item.index, item.key]));
  const bytecode = result.baselineBytecode!;
  const valid = new Map<string, number | boolean>();
  for (const step of result.baseline!.steps) {
    const instruction = bytecode[step.pc];
    if (!instruction || instruction.op !== 'STORE') continue;
    const ins = ir[instruction.irIndex!];
    const dest = instruction.name;
    const value = step.memory[dest];
    if (ins.op === 'binary') {
      const key = expressionKey(ins);
      if (replaced.has(instruction.irIndex!)) {
        expect(valid.has(key), `#${instruction.irIndex} ${key} not available at runtime\n${source}`).toBe(true);
        expect(valid.get(key), source).toBe(value);
      }
    }
    for (const key of [...valid.keys()]) {
      const holder = ir.find((item) => item.op === 'binary' && expressionKey(item) === key)!;
      if (referencedVariables(holder).includes(dest)) valid.delete(key);
    }
    if (ins.op === 'binary' && !referencedVariables(ins).includes(dest)) valid.set(expressionKey(ins), value);
  }
  return analysis;
}

describe('common subexpressions and loop-invariant code motion', () => {
  it('reuses the first a + b in the book example', () => {
    const analysis = verify(preset('cse-book'));
    expect(analysis.replacements).toMatchObject([{ index: 4, source: 2, holder: 't0', after: 't1 = t0' }]);
    expect(analysis.runs!.cse.operations).toBe(analysis.runs!.original.operations - 1);
  });

  it('does not reuse across a write to an operand', () => {
    expect(verify(preset('cse-kill')).replacements).toEqual([]);
  });

  it('reuses after a merge only when every path computed it, through a saved variable', () => {
    const analysis = verify(preset('cse-branch'));
    expect(analysis.replacements).toHaveLength(1);
    expect(analysis.replacements[0]).toMatchObject({ holder: 'cse0', source: undefined });
    const partial = verify(preset('cse-branch').replace('x = a * b + 1;', 'x = 1;'));
    expect(partial.replacements).toEqual([]);
  });

  it('hoists an invariant from the loop condition and saves one operation per extra check', () => {
    const analysis = verify(preset('licm-header'));
    expect(analysis.loops[0].hoisted).toEqual(['t0 = v0_limit * 2']);
    expect(analysis.runs!.original.operations - analysis.runs!.licm.operations).toBe(8);
  });

  it('keeps a possibly trapping invariant inside the body but hoists safe comparisons', () => {
    const analysis = verify(preset('licm-body'));
    const status = Object.fromEntries(analysis.loops[0].decisions.map((item) => [item.text, item.status]));
    expect(status['t1 = v0_k > 2']).toBe('hoisted');
    expect(status['v3_big = t1']).toBe('hoisted');
    expect(status['t2 = v0_k * 2']).toBe('trap');
  });

  it('a hoisted safe comparison still runs once when the loop runs zero times', () => {
    const analysis = verify('int k = 3;\nint i = 0;\nint n = 0;\nwhile (i < 0) {\n  bool big = k > 2;\n  if (big) {\n    n = n + 1;\n  }\n  i = i + 1;\n}\nprint(n);');
    expect(analysis.loops[0].hoisted).toContain('t1 = v0_k > 2');
    expect(analysis.runs!.licm.operations).toBe(analysis.runs!.original.operations + 1);
    expect(analysis.runs!.licm.execution.output).toEqual([0]);
  });

  it('would introduce an error if body arithmetic were hoisted from a zero-trip loop; it is not', () => {
    const source = 'int big = 9007199254740991;\nint i = 0;\nwhile (i < 0) {\n  print(big * 2);\n  i = i + 1;\n}\nprint(7);';
    const analysis = verify(source);
    expect(analysis.runs!.licm.execution.error).toBeUndefined();
    expect(analysis.runs!.licm.execution.output).toEqual([7]);
  });

  it('keeps the division by zero at the same place after reuse', () => {
    const analysis = verify(preset('cse-trap'));
    expect(analysis.replacements).toHaveLength(1);
    expect(analysis.runs!.cse.execution.output).toEqual([1]);
    expect(analysis.runs!.cse.execution.error?.message).toContain('除数不能为 0');
  });

  it('value numbering finds equal values that name-based CSE misses', () => {
    const analysis = verify(preset('lvn-book'));
    expect(analysis.replacements).toEqual([]);
    expect(analysis.valueNumbers).toMatchObject([{ text: 't1 = v0_w + 4', equalTo: 't0', cse: false }]);
  });

  it('holds for every Mini C preset', () => {
    for (const { code } of [...presets, ...redundancyPresets]) if (compile(code, options).ir) verify(code);
  });

  it('holds on seeded random programs with branches, zero-trip loops and divisions', () => {
    let seed = 99;
    const random = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    for (let round = 0; round < 60; round++) {
      const names = ['a', 'b', 'c', 'd'].slice(0, 2 + random(3));
      const atom = () => random(2) ? names[random(names.length)] : String(random(4));
      const expression = (depth: number): string => depth <= 0 || random(3) === 0 ? atom()
        : `(${expression(depth - 1)} ${['+', '-', '*', '/', '+'][random(5)]} ${expression(depth - 1)})`;
      const lines = names.map((name) => `int ${name} = ${random(4)};`);
      for (let statement = 0; statement < 5; statement++) {
        const choice = random(5);
        if (choice === 0) lines.push(`int k${statement} = 0;`, `while (k${statement} < ${random(3)} + ${expression(1)} * 0) {`,
          `  print(${expression(2)});`, `  ${names[random(names.length)]} = ${expression(1)};`, `  k${statement} = k${statement} + 1;`, '}');
        else if (choice === 1) lines.push(`if (${expression(1)} < ${expression(1)}) {`, `  print(${expression(2)});`, '} else {',
          `  ${names[random(names.length)]} = ${expression(2)};`, '}');
        else if (choice === 2) lines.push(`${names[random(names.length)]} = ${expression(2)};`);
        else lines.push(`print(${expression(2)});`);
      }
      verify(lines.join('\n'));
    }
  });
});
