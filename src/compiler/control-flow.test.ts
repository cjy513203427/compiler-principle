import { describe, expect, it } from 'vitest';
import { compile, type Program, type Expr, type Stmt, type Value } from './index';
import { instructionText } from './ir';
import { flowPresets, defaultOptions } from '../content/lessons';
import { MAX_VM_STEPS } from './vm';

// Independent tree interpreter: no generated IR, labels, VM, or optimizer helpers.
function interpret(program: Program): Value[] {
  const environments: Map<string, Value>[] = [new Map()];
  const output: Value[] = [];
  let fuel = 500;
  const find = (name: string) => [...environments].reverse().find((scope) => scope.has(name))!;
  function expression(node: Expr): Value {
    if (node.kind === 'literal') return node.value;
    if (node.kind === 'identifier') return find(node.name).get(node.name)!;
    if (node.kind === 'unary') return -(expression(node.operand) as number);
    const left = expression(node.left);
    const right = expression(node.right);
    switch (node.op) {
      case '+':
        return Number(left) + Number(right);
      case '-':
        return Number(left) - Number(right);
      case '*':
        return Number(left) * Number(right);
      case '/':
        return Math.trunc(Number(left) / Number(right));
      case '<':
        return Number(left) < Number(right);
      case '<=':
        return Number(left) <= Number(right);
      case '>':
        return Number(left) > Number(right);
      case '>=':
        return Number(left) >= Number(right);
      case '==':
        return left === right;
      case '!=':
        return left !== right;
      default:
        throw new Error('Unknown tree operator');
    }
  }
  function statement(node: Stmt): void {
    if (--fuel <= 0) throw new Error('Reference interpreter budget exhausted');
    switch (node.kind) {
      case 'declare': {
        const value = expression(node.init);
        environments.at(-1)!.set(node.name, value);
        break;
      }
      case 'assign':
        find(node.name).set(node.name, expression(node.value));
        break;
      case 'print':
        output.push(expression(node.value));
        break;
      case 'block':
        environments.push(new Map());
        node.body.forEach(statement);
        environments.pop();
        break;
      case 'if':
        if (expression(node.condition)) statement(node.then);
        else if (node.otherwise) statement(node.otherwise);
        break;
      case 'while':
        while (expression(node.condition)) statement(node.body);
        break;
    }
  }
  program.body.forEach(statement);
  return output;
}
const run = (source: string) => compile(source, defaultOptions);
describe('control flow semantics and code generation', () => {
  it('executes selected branches, skips untaken traps and respects optional else', () => {
    expect(run(flowPresets[0].code).execution?.output).toEqual([1]);
    expect(run(flowPresets[0].code.replace('75', '40')).execution?.output).toEqual([2]);
    expect(run(flowPresets[4].code).execution?.output).toEqual([42]);
    expect(run('if (false) { print(1); } print(2);').execution?.output).toEqual([2]);
    expect(run('if (true) { print(1); } print(2);').execution?.output).toEqual([1, 2]);
    expect(run('if (false) {} print(9);').controlTrace?.[1].message).toContain('false');
    expect(run(flowPresets[4].code.replace('false', 'true')).diagnostic?.message).toContain('除数');
  });
  it('rechecks loop conditions, handles zero iterations and nested branches', () => {
    expect(run(flowPresets[1].code).execution?.output).toEqual([6]);
    expect(run(flowPresets[1].code.replace('i < 4', 'i <= 4')).execution?.output).toEqual([10]);
    expect(run(flowPresets[2].code).execution?.output).toEqual([99]);
    expect(run(flowPresets[3].code).execution?.output).toEqual([1, 20, 3]);
    expect(
      run('int i = 0; while (i < 3) { int local = i + 2; print(local); i = i + 1; }').execution
        ?.output,
    ).toEqual([2, 3, 4]);
  });
  it('checks bool conditions, both static branches and block scoping', () => {
    for (const source of [
      'if (1) {}',
      'while (2) {}',
      'if (true) { int local = 2; } print(local);',
      'if (false) { print(missing); }',
      'print(true < false);',
      'print(1 == true);',
    ]) {
      expect(run(source).diagnostic?.stage, source).toBe('semantic');
    }
    expect(run('if (true) print(1);').diagnostic?.stage).toBe('parse');
    expect(run('print(2 + 3 * 4 >= 14); print(true != false);').execution?.output).toEqual([
      true,
      true,
    ]);
  });
  it('agrees with an independent AST interpreter for changing branch outcomes and nested loops', () => {
    for (let limit = 0; limit < 6; limit++) {
      const source = `int i = 0; int total = 0; while (i < ${limit}) { int j = 0; while (j < 2) { if (i == j) { total = total + 10; } else { total = total + i; } j = j + 1; } i = i + 1; } print(total); print(i);`;
      const result = run(source);
      expect(result.diagnostic).toBeUndefined();
      expect(result.execution?.output).toEqual(interpret(result.syntax!.ast));
      expect(result.execution?.halted).toBe(true);
    }
  });
  it('preserves raw IR across all optimization flag combinations when control flow is present', () => {
    const source =
      'int x = 0; if (true) { x = 2; } else { x = 5; } while (x < 4) { x = x + 1; } print(x);';
    for (let flags = 0; flags < 8; flags++) {
      const result = compile(source, {
        fold: !!(flags & 1),
        propagate: !!(flags & 2),
        dead: !!(flags & 4),
      });
      expect(result.optimization?.at(-1)?.instructions.map(instructionText)).toEqual(
        result.ir?.map(instructionText),
      );
      expect(result.execution?.output).toEqual([4]);
    }
  });
  it('bounds unfinished execution without reporting a false runtime error or halt', () => {
    const result = run(flowPresets[5].code);
    expect(result.execution?.steps).toHaveLength(MAX_VM_STEPS + 1);
    expect(result.execution?.limited).toBe(true);
    expect(result.execution?.halted).toBe(false);
    expect(result.execution?.error).toBeUndefined();
    expect(result.execution?.output).toEqual([]);
    expect(result.controlTrace?.at(-1)?.message).toContain('上限');
  });
});
describe('CFG structure and actual path snapshots', () => {
  it('partitions every IR instruction exactly once and has valid edges and jump mappings', () => {
    for (const preset of flowPresets.slice(0, 5)) {
      const result = run(preset.code);
      const graph = result.cfg!;
      expect(graph.blocks.flatMap((block) => block.instructions)).toEqual(result.ir);
      expect(graph.instructionBlock).toHaveLength(result.ir!.length + 1);
      for (const edge of graph.edges) {
        expect(graph.blocks.some((block) => block.id === edge.from)).toBe(true);
        expect(graph.blocks.some((block) => block.id === edge.to)).toBe(true);
      }
      for (const code of result.baselineBytecode!)
        if ('target' in code) expect(result.baselineBytecode![code.target].op).toBe('LABEL');
      for (const frame of result.controlTrace!.slice(1))
        if (frame.edge)
          expect(
            graph.edges.some(
              (edge) =>
                edge.id === frame.edge && edge.from === frame.block && edge.to === frame.nextBlock,
            ),
          ).toBe(true);
    }
  });
  it('records true, back and false edges in order and keeps prior states immutable', () => {
    const result = run(flowPresets[1].code);
    const graph = result.cfg!;
    const kinds = result
      .controlTrace!.map((frame) => graph.edges.find((edge) => edge.id === frame.edge)?.kind)
      .filter(Boolean);
    expect(kinds.filter((kind) => kind === 'true')).toHaveLength(3);
    expect(kinds.filter((kind) => kind === 'false')).toHaveLength(1);
    expect(kinds.filter((kind) => kind === 'jump')).toHaveLength(3);
    const state = result.baseline!.steps[result.controlTrace![1].vmStep];
    expect(state.memory.v0_i).toBe(1);
    expect(state.memory.v1_sum).toBe(0);
    expect(result.baseline!.steps.at(-1)?.memory.v0_i).toBe(4);
    expect(state.memory.v0_i).toBe(1);
  });
  it('tokenizes comparison operators using longest match and identifies their ranges', () => {
    const result = run('bool ok = 12 >= 9; print(ok == true);');
    const operator = result.lex!.tokens.find((token) => token.text === '>=')!;
    expect(operator.end - operator.start).toBe(2);
    expect(result.execution?.output).toEqual([true]);
  });
});
