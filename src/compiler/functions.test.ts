import { describe, expect, it } from 'vitest';
import { analyzeFunctions, compileFunctions, MAIN_FUNCTION } from './functions';
import { executeFunctions, MAX_CALL_DEPTH, MAX_CALL_FRAMES } from './functions-vm';
import { compile } from './index';
import { functionPresets } from '../content/functions';

function run(source: string) {
  const result = analyzeFunctions(source);
  if (!result.ok) throw new Error(result.issue.message);
  return result.analysis;
}
describe('function compilation and stack frames', () => {
  it('computes independent golden results for every executable preset', () => {
    const outputs: Record<string, (number | boolean)[]> = {
      'call-add': [7, 3], 'call-fact': [24], 'call-value': [5, 4], 'call-order': [7, 2, 5],
      'call-mutual': [true], 'call-loop': [10], 'call-trap': [1, 3], 'call-depth': [],
    };
    for (const preset of functionPresets) {
      if (!(preset.id in outputs)) continue;
      const result = run(preset.code);
      expect(result.output, preset.id).toEqual(outputs[preset.id]);
      expect(result.halted, preset.id).toBe(!['call-trap', 'call-depth'].includes(preset.id));
    }
  });
  it('keeps recursive locals, pending operands and return addresses independent', () => {
    const result = run(functionPresets.find((p) => p.id === 'call-fact')!.code);
    expect(result.calls).toBe(4); expect(result.maxDepth).toBe(5);
    const deepest = result.frames.find((f) => f.activations.length === 5)!;
    const slot = result.program.functions.get('fact')!.params[0].key;
    expect(deepest.activations.slice(1).map((f) => f.locals[slot])).toEqual([4, 3, 2, 1]);
    expect(deepest.activations.slice(1).map((f) => f.stack)).toEqual([[4], [3], [2], []]);
    expect(new Set(deepest.activations.map((f) => f.id)).size).toBe(5);
    for (const activation of deepest.activations.slice(1)) {
      const caller = deepest.activations[deepest.activations.indexOf(activation) - 1];
      expect(activation.returnTo).toEqual({ name: caller.name, pc: caller.pc });
      expect(result.program.functions.get(caller.name)!.code[caller.pc - 1].op).toBe('CALL');
    }
    expect(result.events.filter((event) => event.kind === 'return').map((event) => event.value)).toEqual([1, 2, 6, 24]);
    expect(result.frames.at(-1)!.activations).toHaveLength(1);
    // Later execution must not mutate older snapshots.
    expect(deepest.activations.at(-1)!.locals[slot]).toBe(1);
  });
  it('evaluates argument expressions once, left to right, before entering the callee', () => {
    const result = run('int mark(int x) { print(x); return x; } int add(int a, int b) { print(9); return a + b; } print(10 + add(mark(1), mark(2)));');
    expect(result.output).toEqual([1, 2, 9, 13]);
    expect(result.events.filter((event) => event.kind === 'call').map((event) => event.name)).toEqual(['mark', 'mark', 'add']);
    const inAdd = result.frames.find((frame) => frame.activations.at(-1)!.name === 'add')!;
    expect(inAdd.activations[0].stack).toEqual([10]);
    expect(Object.values(inAdd.activations.at(-1)!.locals)).toEqual([1, 2]);
  });
  it('binds lexical block slots and parameters by value, including shadowing initializers', () => {
    const result = run('int bump(int x) { { int x = x + 10; print(x); } x = x + 1; return x; } int x = 4; print(bump(x)); print(x);');
    expect(result.output).toEqual([14, 5, 4]);
    expect(result.program.functions.get('bump')!.locals.filter((local) => local.name === 'x')).toHaveLength(2);
  });
  it('supports forward calls, mutual recursion, zero arguments and discarded call results', () => {
    expect(run('int a() { return b(2); } int b(int x) { return x + 1; } a(); print(a());').output).toEqual([3]);
    const code = functionPresets.find((preset) => preset.id === 'call-mutual')!.code;
    expect(run(code.replace('even(6)', 'even(5)')).output).toEqual([false]);
  });
  it('returns early out of nested loops without executing later effects', () => {
    const result = run('int f(int n) { while (n > 0) { if (n == 2) { return n; } n = n - 1; } return 0; print(99); } print(f(5)); print(f(0));');
    expect(result.output).toEqual([2, 0]); expect(result.maxDepth).toBe(2);
  });
  it('keeps safe integer, unary and strict bool semantics consistent with the base compiler', () => {
    const source = 'int x = -7 / 2; print(x); print((x < 0) == true);';
    expect(run(source).output).toEqual(compile(source, { fold: false, propagate: false, dead: false }).execution!.output);
    expect(run('bool f(bool b) { return b != false; } print(f(true));').output).toEqual([true]);
  });
  it('treats prototype-like identifiers as ordinary user names', () => {
    expect(run('int constructor(int __proto__) { return __proto__ + 1; } print(constructor(2));').output).toEqual([3]);
  });
});
describe('static diagnostics and isolation from the old pipeline', () => {
  it.each([
    ['int f(int x) { return x; } print(f());', '需要 1 个实参'],
    ['int f(int x) { return x; } print(f(true));', '类型不匹配'],
    ['int f() { return true; }', '类型不匹配'],
    ['print(missing(1));', '未定义'],
    ['return 1;', '顶层程序不能'],
    ['int f(bool b) { if (b) { return 1; } }', '可能到达末尾'],
    ['int f() { while (true) { return 1; } }', '可能到达末尾'],
    ['int f() { return 1; } int f() { return 2; }', '重复定义'],
    ['int f(int x, int x) { return x; }', '重复声明'],
    ['int f(int x) { int x = 2; return x; }', '重复声明'],
    ['int f() { return x; } int x = 3; print(f());', '未在当前函数'],
    ['int f() { { int x = 2; } return x; }', '未在当前函数'],
    ['int f() { return true + 1; }', '类型不匹配'],
    ['int f() { if (1) { return 1; } return 0; }', '类型不匹配'],
    ['int f() { int g() { return 1; } return 0; }', '期望「=」'],
    ['int f() { return 1; } print(f(1,));', '期望表达式'],
  ])('rejects invalid source: %s', (source, message) => {
    const result = analyzeFunctions(source);
    expect(result.ok).toBe(false);
    if (!result.ok) { expect(result.issue.message).toContain(message); expect(result.issue.start).toBeGreaterThanOrEqual(0); expect(result.issue.end).toBeLessThanOrEqual(source.length); }
  });
  it('does not reserve return or accept calls in existing Mini C labs', () => {
    const options = { fold: true, propagate: true, dead: true };
    expect(compile('int return = 3; print(return);', options).execution!.output).toEqual([3]);
    expect(compile('int f(int x) { return x; } print(f(1));', options).diagnostic!.stage).toBe('parse');
  });
  it('limits source, syntax depth, parameters and definitions before execution', () => {
    expect(analyzeFunctions(' '.repeat(2001)).ok).toBe(false);
    expect(analyzeFunctions('print(' + '('.repeat(70) + '1' + ')'.repeat(70) + ');').ok).toBe(false);
    expect(analyzeFunctions('int f(' + Array.from({ length: 9 }, (_, i) => `int a${i}`).join(',') + ') { return 0; }').ok).toBe(false);
    expect(analyzeFunctions(Array.from({ length: 25 }, (_, i) => `int f${i}(){return 0;}`).join('')).ok).toBe(false);
  });
});
describe('observable errors and execution limits', () => {
  it('preserves output and the full calling chain at a trap; later arguments do not run', () => {
    const result = run('int fail() { print(3); return 1 / 0; } int later() { print(9); return 0; } int add(int a, int b) { return a + b; } print(1); print(add(fail(), later())); print(8);');
    expect(result.output).toEqual([1, 3]); expect(result.error).toContain('除数不能为 0');
    expect(result.events.filter((event) => event.kind === 'call').map((event) => event.name)).toEqual(['fail']);
    const last = result.frames.at(-1)!;
    expect(last.status).toBe('error'); expect(last.activations.at(-1)!.stack).toEqual([1, 0]);
    expect(last.activations.map((frame) => frame.name)).toEqual([MAIN_FUNCTION, 'fail']);
  });
  it('uses checked arithmetic in called functions', () => {
    const result = run('int f(int n) { return n + 1; } print(2); print(f(9007199254740991));');
    expect(result.output).toEqual([2]); expect(result.error).toContain('超出安全整数范围');
    expect(analyzeFunctions('print(9007199254740992);').ok).toBe(false);
  });
  it('allows the exact depth bound and pauses before creating one extra frame', () => {
    const source = 'int down(int n) { if (n == 0) { return 0; } return down(n - 1); } print(down(30));';
    const within = run(source); expect(within.halted).toBe(true); expect(within.maxDepth).toBe(MAX_CALL_DEPTH);
    const over = run(source.replace('down(30)', 'down(31)'));
    expect(over.limited).toBe(true); expect(over.error).toBeUndefined(); expect(over.maxDepth).toBe(MAX_CALL_DEPTH);
    expect(over.frames.at(-1)!.activations).toHaveLength(MAX_CALL_DEPTH);
  });
  it('bounds execution and preserves a complete final scene when intermediate trace is capped', () => {
    const looping = run('int loop() { while (true) {} return 1; } print(5); print(loop());');
    expect(looping.executed).toBe(2000); expect(looping.limited).toBe(true); expect(looping.output).toEqual([5]);
    expect(looping.frames).toHaveLength(MAX_CALL_FRAMES + 1);
    expect(looping.frames.at(-1)!.executed).toBe(2000); expect(looping.frames.at(-1)!.status).toBe('limit');
    const terminating = run('int i = 0; while (i < 80) { i = i + 1; } print(i);');
    expect(terminating.truncated).toBe(true); expect(terminating.halted).toBe(true);
    expect(terminating.frames.at(-1)!.output).toEqual([80]);
    const oneStep = executeFunctions(compileFunctions('print(7);'), 1);
    expect(oneStep.limited).toBe(true); expect(oneStep.output).toEqual([]);
  });
});
