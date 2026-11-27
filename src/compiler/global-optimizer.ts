import { T } from '../i18n';
import {
  analyzeConstants,
  analyzeLiveness,
  operandFact,
  referencedVariables,
  transfer,
} from './dataflow';
import {
  constant,
  type Instruction,
  type Operand,
  type OptimizationOptions,
  type OptimizationStep,
} from './model';
import { evaluateBinary } from './operations';

export function optimizeControlFlow(
  original: Instruction[],
  options: OptimizationOptions,
  analysis = analyzeConstants(original),
): OptimizationStep[] {
  const steps: OptimizationStep[] = [
    {
      title: T('原始三地址代码'),
      detail: T('以未改写的 IR 为基线，先求解原始 CFG 上的常量事实。'),
      instructions: original,
    },
  ];
  if (!analysis.converged)
    return [
      ...steps,
      {
        title: T('分析尚未完成'),
        detail: T('没有取得完整不动点；保留原始 IR，不删除尚未分析的路径。'),
        instructions: original,
      },
    ];
  const rewritten: Instruction[] = [];
  let replacements = 0;
  let folds = 0;
  for (const block of analysis.graph.blocks) {
    const environment = { ...analysis.blocks[block.id].input };
    const resolve = (operand: Operand): Operand => {
      const fact = operandFact(operand, environment);
      if (
        options.propagate &&
        operand.kind === 'ref' &&
        fact?.kind === 'constant' &&
        analysis.blocks[block.id].reachable
      ) {
        replacements++;
        return constant(fact.value);
      }
      return operand;
    };
    for (const instruction of block.instructions) {
      let updated = instruction;
      if (instruction.op === 'move' || instruction.op === 'print')
        updated = { ...instruction, value: resolve(instruction.value) };
      else if (instruction.op === 'branch')
        updated = { ...instruction, condition: resolve(instruction.condition) };
      else if (instruction.op === 'binary') {
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
            folds++;
          } catch {
            /* Keep the faulting operation in its original order. */
          }
        }
      }
      rewritten.push(updated);
      transfer(instruction, environment);
    }
  }
  steps.push({
    title: T('跨块传播与折叠'),
    detail: T(
      '使用 {#0} 轮求得的固定事实，替换 {#1} 处常量，折叠 {#2} 个表达式。分析不依赖本次 VM 走过的路径。',
      analysis.iterations,
      replacements,
      folds,
    ),
    instructions: rewritten,
  });
  let reachable = rewritten;
  let removedBlocks = 0;
  let simplified = 0;
  if (options.dead) {
    reachable = [];
    for (const block of analysis.graph.blocks) {
      if (!analysis.blocks[block.id].reachable) {
        removedBlocks++;
        continue;
      }
      const environment = { ...analysis.blocks[block.id].input };
      block.instructions.forEach((instruction, index) => {
        const updated = rewritten[block.start + index];
        if (instruction.op === 'branch') {
          const fact = operandFact(instruction.condition, environment);
          if (fact?.kind === 'constant' && typeof fact.value === 'boolean') {
            if (!fact.value)
              reachable.push({
                op: 'jump',
                target: instruction.target,
                nodeId: instruction.nodeId,
              });
            simplified++;
          } else reachable.push(updated);
        } else reachable.push(updated);
        transfer(instruction, environment);
      });
    }
  }
  steps.push({
    title: T('简化分支与不可达块'),
    detail: options.dead
      ? T(
          '证明条件后简化 {#0} 个跳转，移除 {#1} 个不可达块。执行器本次未经过一条边，并不能成为删除它的依据。',
          simplified,
          removedBlocks,
        )
      : T('清理选项未启用：保留分支和所有块。'),
    instructions: reachable,
  });
  let final = reachable;
  let livenessRounds = 0;
  if (options.dead) {
    for (let round = 0; round < original.length + 1; round++) {
      const live = analyzeLiveness(final);
      livenessRounds += live.iterations;
      if (!live.converged) break;
      const kept: Instruction[] = [];
      for (const block of live.graph.blocks) {
        const needed = new Set(live.output[block.id]);
        const reversed: Instruction[] = [];
        for (const instruction of [...block.instructions].reverse()) {
          if (instruction.op === 'move' && !needed.has(instruction.dest)) continue;
          // All non-folded binary operations are kept: even an unused result can trap.
          if ('dest' in instruction) needed.delete(instruction.dest);
          referencedVariables(instruction).forEach((name) => needed.add(name));
          reversed.push(instruction);
        }
        kept.push(...reversed.reverse());
      }
      if (kept.length === final.length) break;
      final = kept;
    }
    // A jump to the immediately following label has the same control flow as falling through.
    final = final.filter((instruction, index) => {
      const next = final[index + 1];
      return instruction.op !== 'jump' || next?.op !== 'label' || next.name !== instruction.target;
    });
    const targets = new Set(
      final.flatMap((instruction) =>
        instruction.op === 'branch' || instruction.op === 'jump' ? [instruction.target] : [],
      ),
    );
    final = final.filter(
      (instruction) => instruction.op !== 'label' || targets.has(instruction.name),
    );
  }
  steps.push({
    title: T('跨块活跃性与清理'),
    detail: options.dead
      ? T(
          '逆向求解活跃变量，累计 {#0} 轮，去掉 {#1} 条无用复制或标签。未折叠的算术仍保留，以维持异常和输出顺序。',
          livenessRounds,
          reachable.length - final.length,
        )
      : T('清理选项未启用，保留全部写入。'),
    instructions: final,
  });
  return steps;
}
