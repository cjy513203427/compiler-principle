import { describe, expect, it } from 'vitest';
import { compileFunctions, MAIN_FUNCTION } from './functions';
import {
  analyzeInterproc, buildCallGraph, lowerProgram, pInstructionText, runProgram, summarizeEffects,
  type InterprocAnalysis, type PProgram,
} from './interproc';
import { functionPresets } from '../content/functions';
import { interprocPresets } from '../content/interproc';
import { instructionText } from './ir';

const analyze = (source: string): InterprocAnalysis => {
  const result = analyzeInterproc(source);
  if (!result.ok) throw new Error(result.issue.message);
  return result.analysis;
};
const preset = (id: string) => interprocPresets.find((item) => item.id === id)!.code;
const text = (program: PProgram, name = MAIN_FUNCTION) => program.get(name)?.code.filter((item) => item.op !== 'label').map(pInstructionText) ?? [];

function verify(source: string) {
  const analysis = analyze(source);
  for (const row of analysis.runs) {
    const label = `${row.id}\n${source}`;
    if (row.outcome === 'skipped') { expect(analysis.remainingCalls.length, label).toBeGreaterThan(0); continue; }
    if (row.outcome === 'unknown') expect(analysis.baseline.limited || row.execution!.limited, label).toBe(true);
    else expect(row.outcome, label).toBe('same');
  }
  return analysis;
}

describe('every version behaves like the function VM', () => {
  it('holds for all function and interprocedural presets', () => {
    for (const { code } of [...functionPresets, ...interprocPresets]) {
      const result = analyzeInterproc(code);
      if (result.ok) verify(code);
    }
  });

  it('holds on seeded random programs with calls, loops, prints, recursion and traps', () => {
    let seed = 2611;
    const random = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    let traps = 0, inlined = 0, folded = 0, minic = 0;
    for (let round = 0; round < 60; round++) {
      const count = 2 + random(3);
      const lines: string[] = [];
      const recursive = random(3) === 0;
      if (recursive) lines.push('int rec(int n) {', '  if (n <= 0) {', '    return 1;', '  }', '  return rec(n - 1) + 2;', '}');
      for (let index = 0; index < count; index++) {
        const atom = (names: string[]) => (random(3) ? names[random(names.length)] : String(random(7)));
        const expression = (names: string[], depth: number): string => {
          if (depth <= 0 || random(3) === 0) {
            if (index > 0 && random(5) === 0) return `f${random(index)}(${atom(names)}, ${atom(names)})`;
            if (recursive && random(8) === 0) return `rec(${random(4)})`;
            return atom(names);
          }
          const op = ['+', '-', '*', '/', '+'][random(5)];
          return `(${expression(names, depth - 1)} ${op} ${expression(names, depth - 1)})`;
        };
        const names = ['a', 'b'];
        lines.push(`int f${index}(int a, int b) {`, `  int r = ${expression(names, 2)};`);
        names.push('r');
        if (random(2)) lines.push(`  if (${expression(names, 1)} < ${expression(names, 1)}) {`, `    r = ${expression(names, 2)};`, '  }');
        if (random(3) === 0) lines.push('  int c = 0;', `  while (c < ${1 + random(3)}) {`, `    r = r + ${expression(names, 1)};`, '    c = c + 1;', '  }');
        if (random(4) === 0) lines.push(`  print(${expression(names, 1)});`);
        if (random(3) === 0) lines.push(`  if (a == ${random(4)}) {`, `    return ${expression(names, 1)};`, '  }');
        lines.push(`  return ${expression(names, 2)};`, '}');
      }
      lines.push(`int x = ${random(6)};`);
      for (let statement = 0; statement < 2 + random(3); statement++) {
        const f = `f${random(count)}`;
        const arg = () => (random(2) ? 'x' : String(random(6)));
        if (random(3) === 0) lines.push(`${f}(${arg()}, ${arg()});`);
        else if (random(2)) lines.push(`x = ${f}(${arg()}, ${arg()});`);
        else lines.push(`print(${f}(${arg()}, ${arg()}));`);
      }
      lines.push('print(x);');
      const analysis = verify(lines.join('\n'));
      if (analysis.baseline.error) traps++;
      inlined += analysis.inlineEvents.filter((event) => event.inlined).length;
      folded += analysis.transformEvents.filter((event) => event.kind === 'fold-call' || event.kind === 'dead-call').length;
      if (analysis.minic) minic++;
    }
    // The generator must exercise every path, not only trivially equal programs.
    expect(traps).toBeGreaterThan(3);
    expect(inlined).toBeGreaterThan(20);
    expect(folded).toBeGreaterThan(3);
    expect(minic).toBeGreaterThan(10);
  });
});

describe('lowering, call graph and effect summaries', () => {
  it('lowers stack bytecode with a symbolic stack and drops the result of a discarded call', () => {
    const lowered = lowerProgram(compileFunctions('int id(int x) {\n  return x;\n}\nid(3);\nprint(id(4) + 1);'));
    expect(text(lowered)).toEqual(['call id(3)', 't1 = call id(4)', 't2 = t1 + 1', 'print t2']);
    expect(text(lowered, 'id')).toEqual(['return x#0']);
    expect(runProgram(lowered).output).toEqual([5]);
  });

  it('finds mutual recursion as one strongly connected component', () => {
    const lowered = lowerProgram(compileFunctions(functionPresets.find((item) => item.id === 'call-mutual')!.code));
    const graph = buildCallGraph(lowered);
    expect(graph.recursive.sort()).toEqual(['even', 'odd']);
    expect(graph.sccs.find((component) => component.includes('even'))!.sort()).toEqual(['even', 'odd']);
    expect(graph.sccs.at(-1)).toEqual([MAIN_FUNCTION]);
  });

  it('treats negation and division by a non-zero constant as safe, but not other arithmetic', () => {
    const source = 'int neg(int x) {\n  return -x;\n}\nint half(int x) {\n  return x / 2;\n}\nint twice(int x) {\n  return x * 2;\n}\nint cut(int x, int y) {\n  return x / y;\n}\nprint(neg(1) + half(2) + twice(3) + cut(4, 1));';
    const lowered = lowerProgram(compileFunctions(source));
    const summaries = summarizeEffects(lowered, buildCallGraph(lowered));
    expect(summaries.neg.pure).toBe(true);
    expect(summaries.half.pure).toBe(true);
    expect(summaries.twice.reasons).toContain('加减乘可能溢出');
    expect(summaries.cut.reasons).toContain('除法可能除零');
    expect(summaries[MAIN_FUNCTION].prints).toBe(true);
  });
});

describe('teaching claims hold for the presets', () => {
  it('book example: atLeastTen(3) always returns 10 and the call disappears', () => {
    const analysis = analyze(preset('ip-book'));
    expect(analysis.ipcp.returns.atLeastTen).toEqual({ kind: 'constant', value: 10 });
    expect(analysis.summaries.atLeastTen.pure).toBe(true);
    expect(text(analysis.optimized)).toEqual(['print 10']);
    expect(analysis.optimized.has('atLeastTen')).toBe(false);
  });

  it('two call sites: propagation gives ⊤, inlining plus the lab 05 optimizer computes both', () => {
    const analysis = analyze(preset('ip-two-sites'));
    expect(analysis.ipcp.params.atLeastTen).toEqual([{ kind: 'overdefined' }]);
    expect(analysis.inlineEvents.filter((event) => event.inlined)).toHaveLength(2);
    const final = analysis.minic!.steps.at(-1)!.instructions.filter((item) => item.op !== 'label').map(instructionText);
    expect(final).toEqual(['print 10', 'print 20']);
  });

  it('effects: the printing call stays though its result is known; the pure call goes', () => {
    const analysis = analyze(preset('ip-effects'));
    expect(text(analysis.optimized)).toEqual(['call log(5)', 'print 1']);
    expect(analysis.transformEvents.some((event) => event.kind === 'kept-call' && event.text.includes('log'))).toBe(true);
    expect(analysis.transformEvents.some((event) => event.kind === 'dead-call' && event.text.includes('same'))).toBe(true);
  });

  it('specializes the parameter that is the same at every call site', () => {
    const analysis = analyze(preset('ip-specialize'));
    expect(analysis.ipcp.params.scale).toEqual([{ kind: 'overdefined' }, { kind: 'constant', value: 10 }]);
    expect(text(analysis.optimized, 'scale')).toEqual(['t0 = x#0 * 10', 'return t0']);
    expect(analysis.minic!.execution.output).toEqual([30, 70]);
  });

  it('a second round makes pick pure after its loop becomes unreachable; never is deleted', () => {
    const analysis = analyze(preset('ip-rounds'));
    expect(analysis.summaries.pick.pure).toBe(false);
    expect(analysis.finalSummaries.pick).toBeUndefined();
    expect(analysis.rounds).toBeGreaterThanOrEqual(2);
    expect(text(analysis.optimized)).toEqual(['print 4']);
    expect(analysis.transformEvents.some((event) => event.kind === 'dead-function' && event.fn === 'never')).toBe(true);
  });

  it('keeps a call whose unused result would divide by zero', () => {
    const analysis = analyze(preset('ip-trap'));
    expect(text(analysis.optimized)).toEqual(['print 1', 'call ratio(8, 0)', 'print 2']);
    expect(analysis.transformEvents.some((event) => event.kind === 'kept-call' && event.text.includes('除法可能除零'))).toBe(true);
    expect(analysis.baseline.output).toEqual([1]);
    expect(analysis.baseline.error?.message).toBe('整数除法的除数不能为 0。');
  });

  it('inlines square but not the recursive fact, so lab 05 is skipped', () => {
    const analysis = analyze(preset('ip-recursion'));
    expect(analysis.inlineEvents.find((event) => event.callee === 'square')!.inlined).toBe(true);
    expect(analysis.inlineEvents.find((event) => event.callee === 'fact')!.inlined).toBe(false);
    expect(analysis.remainingCalls).toEqual(['fact']);
    expect(analysis.minic).toBeUndefined();
    expect(analysis.runs.find((row) => row.id === 'minic')!.outcome).toBe('skipped');
  });

  it('records frames from lowering to the final comparison', () => {
    const analysis = analyze(preset('ip-two-sites'));
    expect(analysis.frames[0].kind).toBe('lower');
    expect(analysis.frames.some((frame) => frame.kind === 'ipcp')).toBe(true);
    expect(analysis.frames.some((frame) => frame.kind === 'inline')).toBe(true);
    expect(analysis.frames.at(-1)!.kind).toBe('complete');
  });
});
