import { T } from '../i18n';
import type { Bytecode, Instruction } from './model';
import type { Execution } from './vm';
export interface BasicBlock {
  id: string;
  start: number;
  end: number;
  instructions: Instruction[];
}
export interface ControlEdge {
  id: string;
  from: string;
  to: string;
  kind: 'true' | 'false' | 'jump' | 'next';
}
export interface ControlFlowGraph {
  blocks: BasicBlock[];
  edges: ControlEdge[];
  instructionBlock: string[];
}
export interface ControlStep {
  block: string;
  nextBlock?: string;
  edge?: string;
  vmStep: number;
  message: string;
}
export function buildCFG(instructions: Instruction[]): ControlFlowGraph {
  const leaders = new Set<number>([0]);
  const labels = new Map<string, number>();
  instructions.forEach((instruction, index) => {
    if (instruction.op === 'label') {
      leaders.add(index);
      labels.set(instruction.name, index);
    }
    if (instruction.op === 'jump' || instruction.op === 'branch') leaders.add(index + 1);
  });
  const starts = [...leaders].filter((i) => i < instructions.length).sort((a, b) => a - b);
  const blocks: BasicBlock[] = starts.map((start, index) => {
    const end = starts[index + 1] ?? instructions.length;
    return { id: `B${index}`, start, end, instructions: instructions.slice(start, end) };
  });
  const instructionBlock: string[] = [];
  blocks.forEach((block) => {
    for (let i = block.start; i < block.end; i++) instructionBlock[i] = block.id;
  });
  const exit: BasicBlock = {
    id: 'Exit',
    start: instructions.length,
    end: instructions.length,
    instructions: [],
  };
  instructionBlock[instructions.length] = exit.id;
  const edges: ControlEdge[] = [];
  const add = (from: string, to: string, kind: ControlEdge['kind']) =>
    edges.push({ id: `${from}-${kind}-${to}`, from, to, kind });
  blocks.forEach((block, index) => {
    const last = block.instructions.at(-1)!;
    const next = blocks[index + 1]?.id ?? exit.id;
    if (last.op === 'jump' || last.op === 'branch') {
      const address = labels.get(last.target);
      if (address === undefined) throw new Error(T('CFG 缺少标签 {#0}。', last.target));
      add(block.id, instructionBlock[address], last.op === 'branch' ? 'false' : 'jump');
      if (last.op === 'branch') add(block.id, next, 'true');
    } else add(block.id, next, 'next');
  });
  return { blocks: [...blocks, exit], edges, instructionBlock };
}
export function traceCFG(
  graph: ControlFlowGraph,
  code: Bytecode[],
  execution: Execution,
): ControlStep[] {
  const first = graph.blocks[0].id;
  const trace: ControlStep[] = [
    {
      block: first,
      nextBlock: first,
      vmStep: 0,
      message: T('从 {#0} 出发。每一步执行一个基本块，检查块末尾选择哪条边。', first),
    },
  ];
  for (let i = 1; i < execution.steps.length; i++) {
    const state = execution.steps[i];
    const instruction = code[state.pc];
    const block = graph.instructionBlock[instruction.irIndex ?? graph.instructionBlock.length - 1];
    const nextInstruction = code[state.nextPc];
    const nextBlock = nextInstruction
      ? graph.instructionBlock[nextInstruction.irIndex ?? graph.instructionBlock.length - 1]
      : undefined;
    const last = i === execution.steps.length - 1;
    if (nextBlock !== block || last) {
      const edge = graph.edges.find(
        (item) =>
          item.from === block &&
          item.to === nextBlock &&
          (instruction.op !== 'BR_FALSE' || item.kind === (state.condition ? 'true' : 'false')),
      );
      const label =
        edge?.kind === 'true'
          ? T('条件 true')
          : edge?.kind === 'false'
            ? T('条件 false')
            : edge?.kind === 'jump'
              ? T('无条件跳转')
              : T('顺序流转');
      trace.push({
        block,
        nextBlock,
        edge: edge?.id,
        vmStep: i,
        message:
          last && (execution.limited || execution.error)
            ? T('在 {#0} 停止。{#1}', block, state.message)
            : instruction.op === 'HALT'
              ? T('到达 Exit 并执行 HALT，程序结束。')
              : T('执行 {#0}，{#1} → {#2}。观察局部变量和输出的变化。', block, label, nextBlock),
      });
    }
  }
  return trace;
}
