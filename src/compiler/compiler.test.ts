import { describe, it, expect } from 'vitest';
import { compile, tokenize, parse, children, type AstNode } from './index';
import { instructionText } from './ir';
import { presets, defaultOptions } from '../content/lessons';

const noOptimization = { fold: false, propagate: false, dead: false };
const run = (source: string, options = defaultOptions) => compile(source, options);
describe('scanner and parser', () => {
  it('uses longest match and only then classifies keywords', () => {
    const { tokens } = tokenize('int integer = 123; // int x\nprint(integer);');
    expect(tokens.map((token) => token.text)).toEqual([
      'int',
      'integer',
      '=',
      '123',
      ';',
      'print',
      '(',
      'integer',
      ')',
      ';',
      'EOF',
    ]);
    expect(tokens[0].kind).toBe('keyword');
    expect(tokens[1].kind).toBe('identifier');
    expect(tokens[3]).toMatchObject({ start: 14, end: 17 });
  });
  it('constructs precedence, parentheses and left associativity correctly', () => {
    expect(run(presets[0].code).execution?.output).toEqual([14]);
    expect(run(presets[1].code).execution?.output).toEqual([20]);
    expect(run(presets[2].code).execution?.output).toEqual([5]);
    expect(run('print(10 - (3 - 2));').execution?.output).toEqual([9]);
    const ast = parse(tokenize('print(2 + 3 * 4);').tokens).ast;
    const statement = ast.body[0];
    expect(statement.kind).toBe('print');
    if (statement.kind !== 'print' || statement.value.kind !== 'binary')
      throw new Error('Unexpected tree');
    expect(statement.value.op).toBe('+');
    expect(statement.value.right.kind).toBe('binary');
  });
  it('rejects illegal characters, missing semicolons and trailing tokens at the right stage', () => {
    expect(run('int x = @;').diagnostic?.stage).toBe('lex');
    expect(run('int x = 1 print(x);').diagnostic?.stage).toBe('parse');
    expect(run('print(2) 3;').diagnostic?.stage).toBe('parse');
    expect(run('int x = 9007199254740992;').diagnostic?.stage).toBe('parse');
    expect(run(`print(${'('.repeat(100)}1${')'.repeat(100)});`).diagnostic?.message).toContain(
      '嵌套',
    );
    expect(run(' '.repeat(2001)).diagnostic?.message).toContain('2000');
  });
  it('assigns unique node identifiers and valid source ranges', () => {
    const code = presets[4].code;
    const ast = run(code).syntax!.ast;
    const ids: number[] = [];
    const visit = (node: AstNode) => {
      ids.push(node.id);
      expect(node.start).toBeLessThanOrEqual(node.end);
      expect(node.end).toBeLessThanOrEqual(code.length);
      children(node).forEach(visit);
    };
    visit(ast);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
describe('scope and type rules', () => {
  it('resolves shadowed declarations and mutation of outer bindings', () => {
    const shadow = run(presets[4].code);
    expect(shadow.execution?.output).toEqual([20, 10]);
    expect(shadow.semantic?.symbols.map((symbol) => symbol.key)).toEqual(['v0_x', 'v1_x']);
    expect(run('int x = 10; { x = 20; print(x); } print(x);').execution?.output).toEqual([20, 20]);
    expect(run('int x = 10; { int x = x + 1; print(x); } print(x);').execution?.output).toEqual([
      11, 10,
    ]);
  });
  it('checks declaration visibility, duplicates, assignment and arithmetic types', () => {
    for (const code of [
      'int x = x;',
      '{ int x = 2; } print(x);',
      'int x = 1; int x = 2;',
      'bool x = true; x = 2;',
      'int x = true;',
      'print(true + 1);',
    ]) {
      const result = run(code);
      expect(result.syntax).toBeDefined();
      expect(result.diagnostic?.stage, code).toBe('semantic');
    }
    expect(run('bool ready = true; print(ready);').execution?.output).toEqual([true]);
  });
});
describe('IR, optimization and runtime', () => {
  it('lowers dependencies before their users', () => {
    expect(run(presets[0].code).ir?.map(instructionText)).toEqual([
      't0 = 3 * 4',
      't1 = 2 + t0',
      'v0_result = t1',
      'print v0_result',
    ]);
  });
  it('folds and propagates while invalidating overwritten values', () => {
    expect(run(presets[0].code).optimization?.at(-1)?.instructions.map(instructionText)).toEqual([
      'print 14',
    ]);
    expect(run(presets[5].code).execution?.output).toEqual([15]);
    expect(run('int x = 2; int y = x; x = 5; print(y); print(x);').execution?.output).toEqual([
      2, 5,
    ]);
  });
  it('preserves errors in unused expressions and earlier printed output', () => {
    for (const code of [
      'int unused = 1 / 0; print(42);',
      'print(1); int unused = 9007199254740991 + 1; print(42);',
    ]) {
      const result = run(code);
      expect(result.diagnostic?.stage).toBe('vm');
      expect(result.execution?.error?.message).toBe(result.baseline?.error?.message);
      expect(result.execution?.output).toEqual(result.baseline?.output);
      expect(
        result.optimization
          ?.at(-1)
          ?.instructions.some((instruction) => instruction.op === 'binary'),
      ).toBe(true);
    }
    expect(run('print(1); int x = 1 / 0; print(2);').execution?.output).toEqual([1]);
  });
  it('uses correct operand order and truncates integer division toward zero', () => {
    expect(
      run('print(10 - 3); print(10 / 3); print(-10 / 3); print(10 / -3);', noOptimization).execution
        ?.output,
    ).toEqual([7, 3, -3, -3]);
    const result = run('print(10 - 3);', noOptimization);
    expect(result.execution?.steps[2].stack).toEqual([10, 3]);
    expect(result.execution?.steps[3].stack).toEqual([7]);
    expect(result.execution?.steps[2].stack).toEqual([10, 3]); // snapshots are independent
  });
  it('agrees with independently calculated results under all eight option combinations', () => {
    for (let flags = 0; flags < 8; flags++) {
      const options = { fold: !!(flags & 1), propagate: !!(flags & 2), dead: !!(flags & 4) };
      for (let a = -6; a <= 6; a++) {
        const b = a + 9;
        const c = 3;
        const source = `int a = ${a}; int b = ${b}; int unused = 9; int x = a + b * ${c}; a = a + 2; print(x - a); { int a = 100; print(a); } print(a);`;
        const expected = [a + b * c - (a + 2), 100, a + 2];
        const result = run(source, options);
        expect(result.diagnostic, source).toBeUndefined();
        expect(result.execution?.output).toEqual(expected);
        expect(result.baseline?.output).toEqual(expected);
      }
    }
  });
  it('handles empty input and every preset without uncaught exceptions', () => {
    expect(run('').execution?.output).toEqual([]);
    expect(run('').execution?.steps.at(-1)?.message).toContain('HALT');
    for (const preset of presets) expect(() => run(preset.code)).not.toThrow();
  });
});
