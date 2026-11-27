import { T } from '../i18n';
import { buildCFG, type ControlFlowGraph } from './cfg';
import { evaluateBinary } from './operations';
import type { Instruction, Operand, Value } from './model';

export type Fact = { kind: 'constant'; value: Value } | { kind: 'overdefined' };
// An absent key represents bottom (not enough information), never a runtime value.
export type Environment = Record<string, Fact>;
export interface BlockFacts {
  reachable: boolean;
  input: Environment;
  output: Environment;
}
export interface DataflowStep {
  kind: 'initial' | 'visit' | 'complete';
  iteration: number;
  block: string;
  message: string;
  input: Environment;
  output: Environment;
  previous: Environment;
  changed: string[];
  predecessors: { block: string; edge: string; enabled: boolean; output: Environment }[];
  enabledEdges: string[];
}
export interface DataflowAnalysis {
  graph: ControlFlowGraph;
  variables: string[];
  blocks: Record<string, BlockFacts>;
  enabledEdges: string[];
  steps: DataflowStep[];
  iterations: number;
  converged: boolean;
  traceTruncated: boolean;
}
export const MAX_ANALYSIS_PASSES = 200;
export const MAX_ANALYSIS_TRACE = 240;
const TOP: Fact = Object.freeze({ kind: 'overdefined' });
export const factText = (fact: Fact | undefined): string =>
  !fact ? '⊥' : fact.kind === 'overdefined' ? '⊤' : String(fact.value);
export const sameFact = (left: Fact | undefined, right: Fact | undefined) =>
  left?.kind === right?.kind &&
  (left?.kind !== 'constant' || (right?.kind === 'constant' && Object.is(left.value, right.value)));
export function joinFact(left: Fact | undefined, right: Fact | undefined): Fact | undefined {
  if (!left) return right;
  if (!right) return left;
  return sameFact(left, right) ? left : TOP;
}
export const operandFact = (operand: Operand, environment: Environment): Fact | undefined =>
  operand.kind === 'constant'
    ? { kind: 'constant', value: operand.value }
    : environment[operand.name];
export function transfer(instruction: Instruction, environment: Environment): void {
  if (instruction.op === 'move') {
    const value = operandFact(instruction.value, environment);
    if (value) environment[instruction.dest] = value;
    else delete environment[instruction.dest];
  } else if (instruction.op === 'binary') {
    const left = operandFact(instruction.left, environment);
    const right = operandFact(instruction.right, environment);
    if (!left || !right) delete environment[instruction.dest];
    else if (left.kind === 'constant' && right.kind === 'constant') {
      try {
        environment[instruction.dest] = {
          kind: 'constant',
          value: evaluateBinary(instruction.operator, left.value, right.value),
        };
      } catch {
        environment[instruction.dest] = TOP;
      } // A trap is retained in IR, never executed by the analyzer.
    } else environment[instruction.dest] = TOP;
  }
}
export function referencedVariables(instruction: Instruction): string[] {
  const operands =
    instruction.op === 'binary'
      ? [instruction.left, instruction.right]
      : instruction.op === 'move' || instruction.op === 'print'
        ? [instruction.value]
        : instruction.op === 'branch'
          ? [instruction.condition]
          : [];
  return operands.flatMap((operand) => (operand.kind === 'ref' ? [operand.name] : []));
}
export function analyzeConstants(
  instructions: Instruction[],
  settings: { reverse?: boolean; maxPasses?: number } = {},
): DataflowAnalysis {
  const graph = buildCFG(instructions);
  const variables = [
    ...new Set(
      instructions.flatMap((instruction) => [
        ...referencedVariables(instruction),
        ...('dest' in instruction ? [instruction.dest] : []),
      ]),
    ),
  ].sort();
  const blocks: DataflowAnalysis['blocks'] = Object.fromEntries(
    graph.blocks.map((block) => [block.id, { reachable: false, input: {}, output: {} }]),
  );
  const first = graph.blocks[0].id;
  blocks[first].reachable = true;
  // No program inputs exist in Mini C. Unknown entry facts safely cover values before their writes.
  const boundary: Environment = Object.fromEntries(variables.map((name) => [name, TOP]));
  const enabled = new Set<string>();
  const predecessors = new Map(
    graph.blocks.map((block) => [block.id, graph.edges.filter((edge) => edge.to === block.id)]),
  );
  const successors = new Map(
    graph.blocks.map((block) => [block.id, graph.edges.filter((edge) => edge.from === block.id)]),
  );
  const sameEnvironment = (a: Environment, b: Environment) =>
    variables.every((name) => sameFact(a[name], b[name]));
  const steps: DataflowStep[] = [
    {
      kind: 'initial',
      iteration: 0,
      block: first,
      message: T(
        '从入口开始。⊥ 表示尚无信息，常量居中，⊤ 表示无法确定唯一常量；这里只做静态分析，不运行程序。',
      ),
      input: {},
      output: {},
      previous: {},
      changed: [],
      predecessors: [],
      enabledEdges: [],
    },
  ];
  const order = settings.reverse ? [...graph.blocks].reverse() : graph.blocks;
  let iterations = 0;
  let converged = false;
  let traceTruncated = false;
  const maxPasses = Math.max(
    1,
    Math.min(MAX_ANALYSIS_PASSES, settings.maxPasses ?? MAX_ANALYSIS_PASSES),
  );
  for (let pass = 1; pass <= maxPasses; pass++) {
    iterations = pass;
    let changedPass = false;
    for (const block of order) {
      if (!blocks[block.id].reachable) continue;
      const incoming = predecessors.get(block.id)!;
      const predecessorSnapshots = incoming.map((edge) => ({
        block: edge.from,
        edge: edge.id,
        enabled: enabled.has(edge.id),
        output: { ...blocks[edge.from].output },
      }));
      const sources = incoming
        .filter((edge) => enabled.has(edge.id))
        .map((edge) => blocks[edge.from].output);
      if (block.id === first) sources.unshift(boundary);
      const input: Environment = {};
      for (const name of variables) {
        let fact: Fact | undefined;
        for (const source of sources) fact = joinFact(fact, source[name]);
        if (fact) input[name] = fact;
      }
      const output = { ...input };
      block.instructions.forEach((instruction) => transfer(instruction, output));
      const previous = blocks[block.id];
      if (!sameEnvironment(input, previous.input) || !sameEnvironment(output, previous.output))
        changedPass = true;
      blocks[block.id] = { reachable: true, input, output };
      const last = block.instructions.at(-1);
      const condition = last?.op === 'branch' ? operandFact(last.condition, output) : undefined;
      for (const edge of successors.get(block.id)!) {
        const executable =
          last?.op !== 'branch' ||
          condition?.kind === 'overdefined' ||
          (condition?.kind === 'constant' &&
            (typeof condition.value !== 'boolean' ||
              edge.kind === (condition.value ? 'true' : 'false')));
        if (executable && !enabled.has(edge.id)) {
          enabled.add(edge.id);
          blocks[edge.to].reachable = true;
          changedPass = true;
        }
      }
      if (steps.length <= MAX_ANALYSIS_TRACE)
        steps.push({
          kind: 'visit',
          iteration: pass,
          block: block.id,
          message: T(
            '第 {#0} 轮处理 {#1}：合并当前可能执行的前驱 OUT，得到 IN，再顺序执行传递函数得到 OUT。',
            pass,
            block.id,
          ),
          input: { ...input },
          output: { ...output },
          previous: { ...previous.output },
          changed: variables.filter((name) => !sameFact(previous.output[name], output[name])),
          predecessors: predecessorSnapshots,
          enabledEdges: [...enabled],
        });
      else traceTruncated = true;
    }
    if (!changedPass) {
      converged = true;
      break;
    }
  }
  // Unknown bottom conditions are not proof that outgoing edges are dead.
  for (const block of graph.blocks) {
    const last = block.instructions.at(-1);
    if (
      blocks[block.id].reachable &&
      last?.op === 'branch' &&
      !operandFact(last.condition, blocks[block.id].output)
    )
      converged = false;
  }
  steps.push({
    kind: 'complete',
    iteration: iterations,
    block: first,
    message: converged
      ? traceTruncated
        ? T(
            '已在 {#0} 轮后达到不动点。再处理各块不会改变事实或可执行边；这不是运行时的变量快照。中间回放仅保留前 240 次处理，最终表仍显示完整收敛结果。',
            iterations,
          )
        : T(
            '已在 {#0} 轮后达到不动点。再处理各块不会改变事实或可执行边；这不是运行时的变量快照。',
            iterations,
          )
      : T('分析在限定轮数内尚未完成；不能把未分析到的路径当成不可达，优化器将保留原始 IR。'),
    input: { ...blocks[first].input },
    output: { ...blocks[first].output },
    previous: {},
    changed: [],
    predecessors: [],
    enabledEdges: [...enabled],
  });
  return {
    graph,
    variables,
    blocks,
    enabledEdges: [...enabled],
    steps,
    iterations,
    converged,
    traceTruncated,
  };
}

export interface LivenessAnalysis {
  graph: ControlFlowGraph;
  input: Record<string, string[]>;
  output: Record<string, string[]>;
  iterations: number;
  converged: boolean;
}
export function analyzeLiveness(instructions: Instruction[]): LivenessAnalysis {
  const graph = buildCFG(instructions);
  const uses: Record<string, Set<string>> = {};
  const defs: Record<string, Set<string>> = {};
  const input: Record<string, Set<string>> = {};
  const output: Record<string, Set<string>> = {};
  for (const block of graph.blocks) {
    uses[block.id] = new Set();
    defs[block.id] = new Set();
    input[block.id] = new Set();
    output[block.id] = new Set();
    for (const instruction of block.instructions) {
      referencedVariables(instruction).forEach((name) => {
        if (!defs[block.id].has(name)) uses[block.id].add(name);
      });
      if ('dest' in instruction) defs[block.id].add(instruction.dest);
    }
  }
  let iterations = 0;
  let converged = false;
  const same = (a: Set<string>, b: Set<string>) =>
    a.size === b.size && [...a].every((name) => b.has(name));
  for (let pass = 1; pass <= MAX_ANALYSIS_PASSES; pass++) {
    iterations = pass;
    let changed = false;
    for (const block of [...graph.blocks].reverse()) {
      const nextOut = new Set(
        graph.edges.filter((edge) => edge.from === block.id).flatMap((edge) => [...input[edge.to]]),
      );
      const nextIn = new Set([
        ...uses[block.id],
        ...[...nextOut].filter((name) => !defs[block.id].has(name)),
      ]);
      if (!same(nextIn, input[block.id]) || !same(nextOut, output[block.id])) changed = true;
      input[block.id] = nextIn;
      output[block.id] = nextOut;
    }
    if (!changed) {
      converged = true;
      break;
    }
  }
  return {
    graph,
    input: Object.fromEntries(graph.blocks.map((block) => [block.id, [...input[block.id]].sort()])),
    output: Object.fromEntries(
      graph.blocks.map((block) => [block.id, [...output[block.id]].sort()]),
    ),
    iterations,
    converged,
  };
}
