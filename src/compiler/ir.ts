import { evaluateBinary } from './operations';
import { optimizeControlFlow } from './global-optimizer';
import type { DataflowAnalysis } from './dataflow';
import {
  constant,
  reference,
  type Program,
  type Expr,
  type Stmt,
  type Analysis,
  type Instruction,
  type Operand,
  type Value,
  type OptimizationOptions,
  type OptimizationStep,
  type ValueInstruction,
} from './model';

export { arithmetic, evaluateBinary } from './operations';
export const hasControlFlow = (instructions: Instruction[]) =>
  instructions.some((i) => i.op === 'branch' || i.op === 'jump' || i.op === 'label');
export function generateIR(ast: Program, analysis: Analysis): Instruction[] {
  const code: Instruction[] = [];
  let temp = 0;
  let label = 0;
  const nextLabel = () => `L${label++}`;
  function expression(node: Expr): Operand {
    if (node.kind === 'literal') return constant(node.value);
    if (node.kind === 'identifier') return reference(analysis.references.get(node.id)!);
    const left = node.kind === 'unary' ? constant(0) : expression(node.left);
    const right = expression(node.kind === 'unary' ? node.operand : node.right);
    const dest = `t${temp++}`;
    code.push({
      op: 'binary',
      dest,
      operator: node.kind === 'unary' ? '-' : node.op,
      left,
      right,
      nodeId: node.id,
    });
    return reference(dest);
  }
  function statement(node: Stmt) {
    if (node.kind === 'block') node.body.forEach(statement);
    else if (node.kind === 'if') {
      const otherwise = nextLabel();
      const end = node.otherwise ? nextLabel() : otherwise;
      code.push({
        op: 'branch',
        condition: expression(node.condition),
        target: otherwise,
        nodeId: node.id,
      });
      statement(node.then);
      if (node.otherwise) {
        code.push(
          { op: 'jump', target: end, nodeId: node.id },
          { op: 'label', name: otherwise, nodeId: node.id },
        );
        statement(node.otherwise);
      }
      code.push({ op: 'label', name: end, nodeId: node.id });
    } else if (node.kind === 'while') {
      const test = nextLabel();
      const end = nextLabel();
      code.push({ op: 'label', name: test, nodeId: node.id });
      code.push({
        op: 'branch',
        condition: expression(node.condition),
        target: end,
        nodeId: node.id,
      });
      statement(node.body);
      code.push(
        { op: 'jump', target: test, nodeId: node.id },
        { op: 'label', name: end, nodeId: node.id },
      );
    } else if (node.kind === 'print')
      code.push({ op: 'print', value: expression(node.value), nodeId: node.id });
    else {
      const value = expression(node.kind === 'declare' ? node.init : node.value);
      code.push({ op: 'move', dest: analysis.references.get(node.id)!, value, nodeId: node.id });
    }
  }
  ast.body.forEach(statement);
  return code;
}
export function operandText(value: Operand): string {
  return value.kind === 'constant' ? String(value.value) : value.name;
}
export function instructionText(instruction: Instruction): string {
  if (instruction.op === 'label') return `${instruction.name}:`;
  if (instruction.op === 'jump') return `goto ${instruction.target}`;
  if (instruction.op === 'branch')
    return `ifFalse ${operandText(instruction.condition)} goto ${instruction.target}`;
  if (instruction.op === 'print') return `print ${operandText(instruction.value)}`;
  if (instruction.op === 'move') return `${instruction.dest} = ${operandText(instruction.value)}`;
  return `${instruction.dest} = ${operandText(instruction.left)} ${instruction.operator} ${operandText(instruction.right)}`;
}
export function optimize(
  original: Instruction[],
  options: OptimizationOptions,
  facts?: DataflowAnalysis,
): OptimizationStep[] {
  const steps: OptimizationStep[] = [
    {
      title: '原始三地址代码',
      detail: '先保留原始指令，作为语义等价的比较基线。',
      instructions: original,
    },
  ];
  if (hasControlFlow(original)) return optimizeControlFlow(original, options, facts);
  const linear = original as ValueInstruction[];
  const known = new Map<string, Value>();
  let changes = 0;
  const resolve = (operand: Operand): Operand => {
    if (options.propagate && operand.kind === 'ref' && known.has(operand.name)) {
      changes++;
      return constant(known.get(operand.name)!);
    }
    return operand;
  };
  const transformed = linear.map((instruction): ValueInstruction => {
    if (instruction.op === 'print') return { ...instruction, value: resolve(instruction.value) };
    let updated: ValueInstruction;
    if (instruction.op === 'move') updated = { ...instruction, value: resolve(instruction.value) };
    else {
      const left = resolve(instruction.left);
      const right = resolve(instruction.right);
      updated = { ...instruction, left, right };
      if (options.fold && left.kind === 'constant' && right.kind === 'constant') {
        try {
          updated = {
            op: 'move',
            dest: instruction.dest,
            value: constant(evaluateBinary(instruction.operator, left.value, right.value)),
            nodeId: instruction.nodeId,
          };
          changes++;
        } catch {
          /* Keep potentially trapping arithmetic for runtime, including overflow. */
        }
      }
    }
    // Kill old information on every write. This matters for mutable variables.
    known.delete(instruction.dest);
    if (updated.op === 'move' && updated.value.kind === 'constant')
      known.set(updated.dest, updated.value.value);
    return updated;
  });
  steps.push({
    title: '传播与折叠',
    detail: `替换已知常量，并计算合法的常量表达式。本轮发生 ${changes} 次变换；每次赋值都会更新或清除旧常量信息。`,
    instructions: transformed,
  });
  let final = transformed;
  if (options.dead) {
    const live = new Set<string>();
    const kept: ValueInstruction[] = [];
    const read = (operand: Operand) => {
      if (operand.kind === 'ref') live.add(operand.name);
    };
    for (let i = transformed.length - 1; i >= 0; i--) {
      const instruction = transformed[i];
      if (instruction.op === 'print') {
        kept.push(instruction);
        read(instruction.value);
        continue;
      }
      // Arithmetic can trap (zero divisor / overflow), so preserve it even if its value is dead.
      if (!live.has(instruction.dest) && instruction.op === 'move') continue;
      live.delete(instruction.dest);
      kept.push(instruction);
      if (instruction.op === 'move') read(instruction.value);
      else {
        read(instruction.left);
        read(instruction.right);
      }
    }
    final = kept.reverse();
  }
  steps.push({
    title: '清理无用写入',
    detail: options.dead
      ? `从 print 等可观察操作反向分析，去掉 ${transformed.length - final.length} 条无用写入。可能发生异常的算术操作仍然保留。`
      : '未启用清理；保留全部写入。',
    instructions: final,
  });
  return steps;
}
