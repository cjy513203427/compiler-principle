import type { DominanceAnalysis } from './dominance';
import { referencedVariables, type LivenessAnalysis } from './dataflow';
import { instructionText } from './ir';
import { evaluateBinary } from './operations';
import type { Instruction, Operand, Value } from './model';
import type { Execution } from './vm';

export interface Phi {
  variable: string;
  dest: string;
  inputs: { predecessor: string; name: string }[];
}
export interface SsaBlock {
  id: string;
  phis: Phi[];
  instructions: Instruction[];
}
export interface PhiSelection {
  dest: string;
  source: string;
  value: Value;
}
export interface SsaStep {
  kind: 'initial' | 'place' | 'enter' | 'rename' | 'edge' | 'leave' | 'validated' | 'execute' | 'complete';
  block: string;
  message: string;
  original?: string;
  renamed?: string;
  stacks?: Record<string, string[]>;
  predecessor?: string;
  selections?: PhiSelection[];
  write?: { name: string; value: Value };
  output?: Value[];
}
export interface SsaExecution {
  block: string;
  steps: SsaStep[];
  output: Value[];
  halted: boolean;
  limited: boolean;
  error?: string;
  traceTruncated: boolean;
}
export interface SsaAnalysis {
  blocks: SsaBlock[];
  placements: { variable: string; block: string; retained: boolean }[];
  steps: SsaStep[];
  issues: string[];
  valid: boolean;
  traceTruncated: boolean;
  execution?: SsaExecution;
}
const MAX_TRACE = 240;
const MAX_EXECUTION = 2000;

export function phiText(phi: Phi): string {
  return `${phi.dest} = φ(${phi.inputs.map((input) => `[${input.predecessor}: ${input.name}]`).join(', ')})`;
}

/** Check SSA uses at instruction positions, and phi uses at predecessor ends. */
export function validateSSA(blocks: SsaBlock[], dominance: DominanceAnalysis): string[] {
  const issues: string[] = [];
  const definitions = new Map<string, { block: string; index: number }>();
  const define = (name: string, block: string, index: number) => {
    if (definitions.has(name)) issues.push(`${name} 存在重复定义。`);
    definitions.set(name, { block, index });
  };
  for (const block of blocks) {
    block.phis.forEach((phi) => define(phi.dest, block.id, -1));
    block.instructions.forEach((instruction, index) => {
      if ('dest' in instruction) define(instruction.dest, block.id, index);
    });
  }
  const use = (name: string, block: string, index: number) => {
    const definition = definitions.get(name);
    if (!definition) issues.push(`${block} 使用了没有定义的版本 ${name}。`);
    else if (
      !dominance.dominators[block]?.includes(definition.block) ||
      (definition.block === block && definition.index >= index)
    ) issues.push(`${name} 的定义没有支配 ${block} 中的这次使用。`);
  };
  for (const block of blocks) {
    const predecessors = [...new Set(dominance.graph.edges
      .filter((edge) => edge.to === block.id && dominance.reachable.includes(edge.from))
      .map((edge) => edge.from))];
    for (const phi of block.phis) {
      if (phi.inputs.length !== predecessors.length ||
          new Set(phi.inputs.map((input) => input.predecessor)).size !== predecessors.length ||
          phi.inputs.some((input) => !predecessors.includes(input.predecessor)))
        issues.push(`${block.id} 的 φ 输入没有与可达前驱一一对应。`);
      for (const input of phi.inputs) use(input.name, input.predecessor, Infinity);
    }
    block.instructions.forEach((instruction, index) => {
      referencedVariables(instruction).forEach((name) => use(name, block.id, index));
    });
  }
  return issues;
}

/** Pruned iterated-frontier insertion and dominator-tree stack renaming. Original IR is untouched. */
export function buildSSA(dominance: DominanceAnalysis, liveness: LivenessAnalysis): SsaAnalysis {
  const blocks: SsaBlock[] = dominance.graph.blocks
    .filter((block) => dominance.reachable.includes(block.id))
    .map((block) => ({ id: block.id, phis: [], instructions: [] }));
  const byId = new Map(blocks.map((block) => [block.id, block]));
  const originalById = new Map(dominance.graph.blocks.map((block) => [block.id, block]));
  const steps: SsaStep[] = [];
  let traceTruncated = false;
  const record = (frame: SsaStep) => {
    if (steps.length < MAX_TRACE) steps.push(frame);
    else traceTruncated = true;
  };
  const placements: SsaAnalysis['placements'] = [];
  record({ kind: 'initial', block: dominance.entry,
    message: '从原始 CFG 出发：先按活跃性裁剪 φ 位置，再沿支配树重命名，最后校验并执行。这里保留全部结构边。' });
  if (!dominance.converged || !liveness.converged) {
    const issues = ['支配分析或活跃性尚未收敛，停止构造 SSA。'];
    steps.push({ kind: 'complete', block: dominance.entry, message: issues[0] });
    return { blocks, placements, steps, issues, valid: false, traceTruncated };
  }
  for (const [variable, sites] of Object.entries(dominance.definitions)) {
    const inserted = new Set<string>();
    const visited = new Set<string>();
    const pending = [...sites];
    for (let i = 0; i < pending.length; i++) {
      const site = pending[i];
      if (visited.has(site)) continue;
      visited.add(site);
      for (const target of dominance.frontier[site]) {
        if (inserted.has(target) || !liveness.input[target].includes(variable)) continue;
        inserted.add(target);
        byId.get(target)!.phis.push({ variable, dest: variable, inputs: [] });
        pending.push(target);
      }
    }
    for (const block of dominance.phiCandidates[variable]) {
      const retained = inserted.has(block);
      placements.push({ variable, block, retained });
      record({ kind: 'place', block,
        original: `${block}: ${variable} 的 φ 候选`,
        renamed: retained ? `${variable} = φ(待补齐前驱版本)` : '裁掉这个 φ',
        message: retained
          ? `${variable} 在 ${block} 入口活跃：保留 φ，并把它当作新定义继续传播。`
          : `${variable} 在此处不需要合并到达定义：活跃性裁剪后不插入 φ。` });
    }
  }
  const stacks = new Map<string, string[]>();
  const counters = new Map<string, number>();
  const snapshot = () => Object.fromEntries([...stacks].filter(([, stack]) => stack.length)
    .map(([name, stack]) => [name, [...stack]]));
  const fresh = (name: string) => {
    const count = (counters.get(name) || 0) + 1;
    counters.set(name, count);
    const version = `${name}.${count}`;
    if (!stacks.has(name)) stacks.set(name, []);
    stacks.get(name)!.push(version);
    return version;
  };
  const current = (name: string) => stacks.get(name)?.at(-1) || `缺失:${name}`;
  const operand = (value: Operand): Operand => value.kind === 'constant'
    ? value : { kind: 'ref', name: current(value.name) };
  const pending: { id: string; leaving?: string[] }[] = [{ id: dominance.entry }];
  while (pending.length) {
    const event = pending.pop()!;
    const block = byId.get(event.id)!;
    if (event.leaving) {
      for (const name of event.leaving) stacks.get(name)!.pop();
      record({ kind: 'leave', block: block.id, stacks: snapshot(),
        message: `离开 ${block.id} 的支配子树，弹出本块定义；兄弟子树恢复进入前的版本。版本计数器不会回退。` });
      continue;
    }
    const pushed: string[] = [];
    for (const phi of block.phis) {
      phi.dest = fresh(phi.variable);
      pushed.push(phi.variable);
    }
    record({ kind: 'enter', block: block.id, stacks: snapshot(),
      message: `沿支配树进入 ${block.id}，先给块首 ${block.phis.length} 个 φ 分配新版本。` });
    for (const instruction of originalById.get(block.id)!.instructions) {
      // Read the old stack top before pushing the assignment's new version (x = x + 1).
      let renamed: Instruction = instruction.op === 'binary'
        ? { ...instruction, left: operand(instruction.left), right: operand(instruction.right) }
        : instruction.op === 'move' || instruction.op === 'print'
          ? { ...instruction, value: operand(instruction.value) }
          : instruction.op === 'branch'
            ? { ...instruction, condition: operand(instruction.condition) } : { ...instruction };
      if ('dest' in renamed) {
        const variable = renamed.dest;
        renamed = { ...renamed, dest: fresh(variable) };
        pushed.push(variable);
      }
      block.instructions.push(renamed);
      record({ kind: 'rename', block: block.id, original: instructionText(instruction),
        renamed: instructionText(renamed), stacks: snapshot(),
        message: `${block.id}：先从版本栈读取操作数，再为写入创建唯一名字。` });
    }
    for (const target of new Set(dominance.graph.edges.filter((edge) => edge.from === block.id)
      .map((edge) => edge.to))) {
      for (const phi of byId.get(target)!.phis) {
        const name = current(phi.variable);
        phi.inputs.push({ predecessor: block.id, name });
        record({ kind: 'edge', block: block.id, original: `${block.id} → ${target}`,
          renamed: `${phi.variable} 的输入 = ${name}`, stacks: snapshot(),
          message: `给 ${target} 的 φ 补上前驱 ${block.id} 对应的栈顶版本。循环回边也按同样的规则填写。` });
      }
    }
    pending.push({ id: block.id, leaving: pushed });
    const children = dominance.reachable.filter((id) => dominance.immediate[id] === block.id);
    for (const id of children.reverse()) pending.push({ id });
  }
  const issues = validateSSA(blocks, dominance);
  const valid = issues.length === 0;
  steps.push({ kind: 'validated', block: dominance.entry,
    message: valid ? 'SSA 校验通过：版本定义唯一，普通使用由定义支配，φ 输入覆盖每个可达前驱，且其定义支配对应前驱。'
      : `SSA 校验失败：${issues.join(' ')}` });
  const execution = valid ? executeSSA(blocks, dominance) : undefined;
  if (execution) steps.push(...execution.steps);
  steps.push({ kind: 'complete', block: execution?.block || dominance.entry,
    output: execution?.output,
    message: !valid ? '构造结果未通过校验，不执行。'
      : execution?.limited ? 'SSA 执行达到 2000 次操作上限；输出仅为前缀，不能判定行为一致。'
      : execution?.error ? `SSA 执行停止：${execution.error}`
      : 'SSA 执行结束。静态版本名可以在循环的多次动态执行中重复获得值；每个名字仍只有一处静态定义。' });
  return { blocks, placements, steps, issues, valid, traceTruncated, execution };
}

/** Interpret phi nodes simultaneously on entry, before ordinary instructions. */
export function executeSSA(blocks: SsaBlock[], dominance: DominanceAnalysis): SsaExecution {
  const byId = new Map(blocks.map((block) => [block.id, block]));
  const memory = new Map<string, Value>();
  const output: Value[] = [];
  const steps: SsaStep[] = [];
  let traceTruncated = false;
  let count = 0;
  let id = dominance.entry;
  let predecessor: string | undefined;
  const read = (name: string) => {
    if (!memory.has(name)) throw new Error(`读取未初始化版本 ${name}。`);
    return memory.get(name)!;
  };
  const value = (operand: Operand) => operand.kind === 'constant' ? operand.value : read(operand.name);
  const record = (frame: SsaStep) => {
    if (steps.length < MAX_TRACE) steps.push({ ...frame, output: [...output] });
    else traceTruncated = true;
  };
  const result = (halted: boolean, limited: boolean, error?: string): SsaExecution =>
    ({ block: id, steps, output, halted, limited, error, traceTruncated });
  try {
    while (count < MAX_EXECUTION) {
      const block = byId.get(id);
      if (!block) throw new Error(`SSA 缺少基本块 ${id}。`);
      count++;
      const selections = block.phis.map((phi) => {
        const input = phi.inputs.find((item) => item.predecessor === predecessor);
        if (!input) throw new Error(`${id} 的 φ 缺少前驱 ${predecessor}。`);
        return { dest: phi.dest, source: input.name, value: read(input.name) };
      });
      // All incoming values must be read before any phi writes: loop-carried swaps depend on it.
      selections.forEach((selection) => memory.set(selection.dest, selection.value));
      record({ kind: 'execute', block: id, predecessor, selections,
        message: `执行进入 ${id}${predecessor ? `，来自 ${predecessor}` : '（入口）'}。${selections.length ? '按这条前驱边读取全部 φ 输入，然后同时写入。' : '本块没有 φ。'}` });
      let branch: boolean | undefined;
      for (const instruction of block.instructions) {
        if (count >= MAX_EXECUTION) return result(false, true);
        count++;
        let write: SsaStep['write'];
        if (instruction.op === 'move' || instruction.op === 'binary') {
          const computed = instruction.op === 'move' ? value(instruction.value)
            : evaluateBinary(instruction.operator, value(instruction.left), value(instruction.right));
          memory.set(instruction.dest, computed);
          write = { name: instruction.dest, value: computed };
        } else if (instruction.op === 'print') output.push(value(instruction.value));
        else if (instruction.op === 'branch') {
          const condition = value(instruction.condition);
          if (typeof condition !== 'boolean') throw new Error('条件跳转需要 bool 值。');
          branch = condition;
        }
        record({ kind: 'execute', block: id, original: instructionText(instruction), write,
          message: `执行 ${instructionText(instruction)}。${write ? `得到 ${write.value}。` : ''}` });
      }
      const edges = dominance.graph.edges.filter((edge) => edge.from === id);
      if (!edges.length) return result(true, false);
      const edge = branch === undefined ? edges[0]
        : edges.find((edge) => edge.kind === (branch ? 'true' : 'false'));
      if (!edge) throw new Error(`${id} 缺少对应的控制流边。`);
      predecessor = id;
      id = edge.to;
    }
    return result(false, true);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    record({ kind: 'execute', block: id, message: `运行时错误：${message}` });
    return result(false, false, message);
  }
}

export function compareSSA(baseline: Execution, execution: SsaExecution): 'same' | 'different' | 'unknown' {
  if (baseline.limited || execution.limited) return 'unknown';
  return baseline.halted === execution.halted && baseline.error?.message === execution.error &&
    baseline.output.length === execution.output.length &&
    baseline.output.every((value, index) => Object.is(value, execution.output[index]))
    ? 'same' : 'different';
}
