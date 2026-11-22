import { referencedVariables, MAX_ANALYSIS_PASSES } from './dataflow';
import { evaluateBinary } from './operations';
import { instructionText } from './ir';
import { MAX_VM_STEPS, type Execution } from './vm';
import type { DominanceAnalysis } from './dominance';
import type { Instruction, Operand, Value } from './model';

export type AllocationAlgorithm = 'color' | 'linear';
export interface RegisterSettings { count: number; algorithm: AllocationAlgorithm }
export const MIN_REGISTERS = 2;
export const MAX_REGISTERS = 8;
export const defaultRegisterSettings: RegisterSettings = { count: 3, algorithm: 'color' };
export const algorithmNames: Record<AllocationAlgorithm, string> = { color: '图着色', linear: '线性扫描' };
export function normalizeRegisterSettings(count: unknown, algorithm: unknown): RegisterSettings {
  const number = Number(count);
  return {
    count: Number.isInteger(number) && number >= MIN_REGISTERS && number <= MAX_REGISTERS
      ? number : defaultRegisterSettings.count,
    algorithm: algorithm === 'linear' || algorithm === 'color' ? algorithm : defaultRegisterSettings.algorithm,
  };
}

/** Spill code is kept as IR-level pseudo instructions until the final register mapping. */
export type SpillInstruction =
  | { op: 'reload'; dest: string; slot: number; variable: string; nodeId: number }
  | { op: 'spill'; value: string; slot: number; variable: string; nodeId: number };
export type AllocInstruction = Instruction | SpillInstruction;
/** `origin` is the index of the original IR instruction this one came from. */
export interface Located { instruction: AllocInstruction; origin: number }

export const usesOf = (instruction: AllocInstruction): string[] =>
  instruction.op === 'reload' ? [] : instruction.op === 'spill' ? [instruction.value]
    : [...new Set(referencedVariables(instruction))];
export const defOf = (instruction: AllocInstruction): string | undefined =>
  instruction.op === 'reload' ? instruction.dest : instruction.op === 'spill' ? undefined
    : 'dest' in instruction ? instruction.dest : undefined;
const moveSource = (instruction: AllocInstruction) =>
  instruction.op === 'move' && instruction.value.kind === 'ref' ? instruction.value.name : undefined;
export const slotText = (slot: number) => `s${slot}`;
export const registerText = (index: number) => `r${index}`;
export function allocInstructionText(instruction: AllocInstruction): string {
  if (instruction.op === 'reload') return `${instruction.dest} = load [${slotText(instruction.slot)}]`;
  if (instruction.op === 'spill') return `store [${slotText(instruction.slot)}], ${instruction.value}`;
  return instructionText(instruction);
}

export interface InstructionLiveness { liveIn: string[][]; liveOut: string[][]; iterations: number; converged: boolean }
/** Backward liveness per instruction. Independent of the block-level analysis in dataflow.ts. */
export function instructionLiveness(code: AllocInstruction[]): InstructionLiveness {
  const labels = new Map<string, number>();
  code.forEach((instruction, index) => { if (instruction.op === 'label') labels.set(instruction.name, index); });
  const target = (name: string) => {
    const index = labels.get(name);
    if (index === undefined) throw new Error(`寄存器分配缺少标签 ${name}。`);
    return index;
  };
  const successors = code.map((instruction, index) => {
    if (instruction.op === 'jump') return [target(instruction.target)];
    const next = index + 1 < code.length ? [index + 1] : [];
    return instruction.op === 'branch' ? [...next, target(instruction.target)] : next;
  });
  const uses = code.map(usesOf);
  const defs = code.map(defOf);
  const liveIn = code.map(() => new Set<string>());
  const liveOut = code.map(() => new Set<string>());
  let iterations = 0, converged = false;
  for (let pass = 1; pass <= MAX_ANALYSIS_PASSES; pass++) {
    iterations = pass;
    let changed = false;
    for (let index = code.length - 1; index >= 0; index--) {
      const out = new Set<string>();
      for (const next of successors[index]) for (const name of liveIn[next]) out.add(name);
      const input = new Set(uses[index]);
      for (const name of out) if (name !== defs[index]) input.add(name);
      if (out.size !== liveOut[index].size || input.size !== liveIn[index].size) changed = true;
      liveOut[index] = out;
      liveIn[index] = input;
    }
    if (!changed) { converged = true; break; }
  }
  // Sets only grow from empty, so equal sizes in a whole pass mean equal sets.
  return { liveIn: liveIn.map((set) => [...set].sort()), liveOut: liveOut.map((set) => [...set].sort()), iterations, converged };
}

export interface InterferenceGraph {
  nodes: string[];
  edges: [string, string][];
  adjacency: Record<string, string[]>;
  moves: [string, string][];
}
export function buildInterference(code: AllocInstruction[], liveness: InstructionLiveness): InterferenceGraph {
  const nodes: string[] = [];
  const seen = new Set<string>();
  const note = (name: string) => { if (!seen.has(name)) { seen.add(name); nodes.push(name); } };
  code.forEach((instruction) => {
    usesOf(instruction).forEach(note);
    const def = defOf(instruction);
    if (def) note(def);
  });
  const adjacency = new Map(nodes.map((name) => [name, new Set<string>()]));
  const edges: [string, string][] = [];
  const moves: [string, string][] = [];
  const add = (a: string, b: string) => {
    if (a === b || adjacency.get(a)!.has(b)) return;
    adjacency.get(a)!.add(b);
    adjacency.get(b)!.add(a);
    edges.push([a, b]);
  };
  code.forEach((instruction, index) => {
    const def = defOf(instruction);
    if (!def) return;
    const source = moveSource(instruction);
    if (source && source !== def) moves.push([def, source]);
    // A def conflicts with everything still needed afterwards; a copy may share with its source.
    for (const name of liveness.liveOut[index]) if (name !== source) add(def, name);
  });
  return { nodes, edges, adjacency: Object.fromEntries(nodes.map((name) => [name, [...adjacency.get(name)!]])), moves };
}

export interface LiveInterval { name: string; start: number; end: number }
/** Points: 2i is just before instruction i, 2i+1 just after it. Holes are ignored. */
export function liveIntervals(code: AllocInstruction[], liveness: InstructionLiveness, order: string[]): LiveInterval[] {
  const range = new Map<string, [number, number]>();
  const cover = (name: string, point: number) => {
    const current = range.get(name);
    range.set(name, current ? [Math.min(current[0], point), Math.max(current[1], point)] : [point, point]);
  };
  code.forEach((instruction, index) => {
    liveness.liveIn[index].forEach((name) => cover(name, 2 * index));
    liveness.liveOut[index].forEach((name) => cover(name, 2 * index + 1));
    const def = defOf(instruction);
    if (def) cover(def, 2 * index + 1); // even a dead result needs somewhere to be written
  });
  const rank = new Map(order.map((name, index) => [name, index]));
  return [...range].map(([name, [start, end]]) => ({ name, start, end }))
    .sort((a, b) => a.start - b.start || rank.get(a.name)! - rank.get(b.name)!);
}
export const pointText = (point: number) => `${point % 2 ? '后' : '前'} #${Math.floor(point / 2)}`;

export type AllocationEvent =
  | { kind: 'simplify'; node: string; degree: number }
  | { kind: 'potential'; node: string; degree: number; cost: number }
  | { kind: 'select'; node: string; register?: number; reason: 'bias' | 'lowest' | 'spill'; blocked: number[]; partner?: string }
  | { kind: 'expire'; node: string; register: number; at: number }
  | { kind: 'assign'; node: string; register: number; start: number; end: number }
  | { kind: 'spill'; node: string; start: number; end: number; stolenBy?: string; register?: number };

export interface AllocationRound {
  index: number;
  code: Located[];
  liveness: InstructionLiveness;
  graph: InterferenceGraph;
  costs: Record<string, number>;
  unspillable: string[];
  intervals: LiveInterval[];
  events: AllocationEvent[];
  assignment: Record<string, number>;
  spilled: string[];
  failure?: string;
}

function colorRound(graph: InterferenceGraph, count: number, costs: Record<string, number>, unspillable: Set<string>) {
  const events: AllocationEvent[] = [];
  const remaining = new Set(graph.nodes);
  const degree = new Map(graph.nodes.map((name) => [name, graph.adjacency[name].length]));
  const stack: string[] = [];
  const remove = (name: string) => {
    remaining.delete(name);
    stack.push(name);
    for (const other of graph.adjacency[name]) if (remaining.has(other)) degree.set(other, degree.get(other)! - 1);
  };
  while (remaining.size) {
    const easy = graph.nodes.find((name) => remaining.has(name) && degree.get(name)! < count);
    if (easy) {
      events.push({ kind: 'simplify', node: easy, degree: degree.get(easy)! });
      remove(easy);
      continue;
    }
    let best: string | undefined;
    for (const name of graph.nodes) {
      if (!remaining.has(name) || unspillable.has(name)) continue;
      const score = costs[name] / degree.get(name)!, bestScore = best ? costs[best] / degree.get(best)! : Infinity;
      if (score < bestScore) best = name;
    }
    if (!best) return { events, assignment: {}, spilled: [],
      failure: `剩余的值都是溢出产生的短临时值，${count} 个寄存器仍不够同时容纳它们。` };
    events.push({ kind: 'potential', node: best, degree: degree.get(best)!, cost: costs[best] });
    remove(best);
  }
  const assignment: Record<string, number> = {};
  const spilled: string[] = [];
  const partners = new Map(graph.nodes.map((name) => [name, [] as string[]]));
  for (const [a, b] of graph.moves) { partners.get(a)!.push(b); partners.get(b)!.push(a); }
  while (stack.length) {
    const node = stack.pop()!;
    const blocked = [...new Set(graph.adjacency[node].flatMap((other) => other in assignment ? [assignment[other]] : []))].sort((a, b) => a - b);
    const partner = partners.get(node)!.find((other) => other in assignment && !blocked.includes(assignment[other]));
    if (partner) {
      assignment[node] = assignment[partner];
      events.push({ kind: 'select', node, register: assignment[node], reason: 'bias', blocked, partner });
      continue;
    }
    const free = Array.from({ length: count }, (_, index) => index).find((index) => !blocked.includes(index));
    if (free === undefined) {
      spilled.push(node);
      events.push({ kind: 'select', node, reason: 'spill', blocked });
    } else {
      assignment[node] = free;
      events.push({ kind: 'select', node, register: free, reason: 'lowest', blocked });
    }
  }
  return { events, assignment, spilled };
}

function linearRound(intervals: LiveInterval[], count: number, unspillable: Set<string>) {
  const events: AllocationEvent[] = [];
  const assignment: Record<string, number> = {};
  const spilled: string[] = [];
  let active: { name: string; end: number; register: number }[] = [];
  for (const current of intervals) {
    const expired = active.filter((item) => item.end < current.start).sort((a, b) => a.end - b.end);
    for (const item of expired) events.push({ kind: 'expire', node: item.name, register: item.register, at: current.start });
    active = active.filter((item) => item.end >= current.start);
    const free = Array.from({ length: count }, (_, index) => index).find((index) => !active.some((item) => item.register === index));
    if (free !== undefined) {
      assignment[current.name] = free;
      active.push({ name: current.name, end: current.end, register: free });
      events.push({ kind: 'assign', node: current.name, register: free, start: current.start, end: current.end });
      continue;
    }
    // Poletto & Sarkar: give up the interval that ends last; reload temps must stay in registers.
    const victim = active.filter((item) => !unspillable.has(item.name)).sort((a, b) => b.end - a.end)[0];
    const keepCurrent = unspillable.has(current.name) || (victim && victim.end > current.end);
    if (keepCurrent && victim) {
      active = active.filter((item) => item !== victim);
      delete assignment[victim.name];
      spilled.push(victim.name);
      assignment[current.name] = victim.register;
      active.push({ name: current.name, end: current.end, register: victim.register });
      const interval = intervals.find((item) => item.name === victim.name)!;
      events.push({ kind: 'spill', node: victim.name, start: interval.start, end: interval.end, stolenBy: current.name, register: victim.register });
    } else if (!unspillable.has(current.name)) {
      spilled.push(current.name);
      events.push({ kind: 'spill', node: current.name, start: current.start, end: current.end });
    } else return { events, assignment: {}, spilled: [],
      failure: `活跃区间里都是溢出产生的短临时值，${count} 个寄存器仍不够同时容纳它们。` };
  }
  return { events, assignment, spilled };
}

function renameOperand(operand: Operand, names: Map<string, string>): Operand {
  return operand.kind === 'ref' && names.has(operand.name) ? { kind: 'ref', name: names.get(operand.name)! } : operand;
}
function renameUses(instruction: AllocInstruction, names: Map<string, string>): AllocInstruction {
  switch (instruction.op) {
    case 'move': case 'print': return { ...instruction, value: renameOperand(instruction.value, names) };
    case 'binary': return { ...instruction, left: renameOperand(instruction.left, names), right: renameOperand(instruction.right, names) };
    case 'branch': return { ...instruction, condition: renameOperand(instruction.condition, names) };
    case 'spill': return { ...instruction, value: names.get(instruction.value) ?? instruction.value };
    default: return instruction;
  }
}

export type RegOperand = { kind: 'register'; index: number } | { kind: 'constant'; value: Value };
export type RegisterInstruction = (
  | { op: 'move'; dest: number; value: RegOperand }
  | { op: 'binary'; dest: number; operator: string; left: RegOperand; right: RegOperand }
  | { op: 'print'; value: RegOperand }
  | { op: 'label'; name: string }
  | { op: 'jump'; target: string }
  | { op: 'branch'; condition: RegOperand; target: string }
  | { op: 'load'; dest: number; slot: number }
  | { op: 'store'; slot: number; value: number }
) & { origin: number; comment: string };
const regOperandText = (operand: RegOperand) => operand.kind === 'register' ? registerText(operand.index) : String(operand.value);
export function registerInstructionText(instruction: RegisterInstruction): string {
  switch (instruction.op) {
    case 'move': return `${registerText(instruction.dest)} = ${regOperandText(instruction.value)}`;
    case 'binary': return `${registerText(instruction.dest)} = ${regOperandText(instruction.left)} ${instruction.operator} ${regOperandText(instruction.right)}`;
    case 'print': return `print ${regOperandText(instruction.value)}`;
    case 'label': return `${instruction.name}:`;
    case 'jump': return `goto ${instruction.target}`;
    case 'branch': return `ifFalse ${regOperandText(instruction.condition)} goto ${instruction.target}`;
    case 'load': return `${registerText(instruction.dest)} = load [${slotText(instruction.slot)}]`;
    case 'store': return `store [${slotText(instruction.slot)}], ${registerText(instruction.value)}`;
  }
}

/** Independent check of an assignment on the final code: no write may clobber a value still needed. */
export function checkAssignment(code: AllocInstruction[], assignment: Record<string, number>, count: number): string[] {
  const issues: string[] = [];
  const liveness = instructionLiveness(code);
  if (!liveness.converged) return ['逐条活跃性没有收敛，无法核对分配。'];
  const names = new Set(code.flatMap((instruction) => [...usesOf(instruction), ...(defOf(instruction) ? [defOf(instruction)!] : [])]));
  for (const name of names) {
    const register = assignment[name];
    if (register === undefined) issues.push(`${name} 没有寄存器。`);
    else if (!Number.isInteger(register) || register < 0 || register >= count) issues.push(`${name} 使用了不存在的寄存器。`);
  }
  if (liveness.liveIn[0]?.length) issues.push(`入口处仍有未定义就使用的值：${liveness.liveIn[0].join(', ')}。`);
  code.forEach((instruction, index) => {
    const def = defOf(instruction);
    if (!def) return;
    const source = moveSource(instruction);
    for (const name of liveness.liveOut[index])
      if (name !== def && name !== source && assignment[name] === assignment[def])
        issues.push(`#${index} 写入 ${def} 会覆盖仍要使用的 ${name}（同在 ${registerText(assignment[def])}）。`);
  });
  return issues;
}

export interface RegisterStep {
  pc: number;
  nextPc: number;
  message: string;
  registers: (Value | undefined)[];
  slots: (Value | undefined)[];
  output: Value[];
  written?: string;
  memory?: 'load' | 'store';
}
export interface RegisterExecution extends Pick<Execution, 'output' | 'halted' | 'limited' | 'error'> {
  steps: RegisterStep[];
  executed: number;
  loads: number;
  stores: number;
}
export function executeRegisters(code: RegisterInstruction[], count: number, slotCount: number,
  settings: { record?: boolean; budget?: number } = {}): RegisterExecution {
  const record = settings.record ?? true;
  const registers: (Value | undefined)[] = Array(count).fill(undefined);
  const slots: (Value | undefined)[] = Array(slotCount).fill(undefined);
  const output: Value[] = [];
  const steps: RegisterStep[] = record ? [{ pc: -1, nextPc: 0, message: `寄存器机就绪：${count} 个寄存器、${slotCount} 个栈槽，全部尚未写入。`,
    registers: [...registers], slots: [...slots], output: [] }] : [];
  const labels = new Map<string, number>();
  code.forEach((instruction, index) => { if (instruction.op === 'label') labels.set(instruction.name, index); });
  const read = (operand: RegOperand): Value => {
    if (operand.kind === 'constant') return operand.value;
    const value = registers[operand.index];
    if (value === undefined) throw new Error(`读取未写入的寄存器 ${registerText(operand.index)}。`);
    return value;
  };
  const jump = (name: string) => {
    const target = labels.get(name);
    if (target === undefined) throw new Error(`不存在的跳转标签 ${name}。`);
    return target;
  };
  let pc = 0, executed = 0, loads = 0, stores = 0;
  const limit = Math.max(1, Math.min(MAX_VM_STEPS, Math.floor(settings.budget ?? MAX_VM_STEPS) || MAX_VM_STEPS));
  const finish = (extra: Partial<RegisterExecution>): RegisterExecution =>
    ({ steps, output, halted: false, limited: false, executed, loads, stores, ...extra });
  while (pc < code.length) {
    if (executed >= limit) {
      if (record) steps.at(-1)!.message += ` 已达到 ${limit} 条指令的回放上限，执行被暂停；这不等于证明程序不会终止。`;
      return finish({ limited: true });
    }
    const instruction = code[pc];
    let nextPc = pc + 1, message = '', written: string | undefined, memory: RegisterStep['memory'];
    executed++;
    try {
      switch (instruction.op) {
        case 'label': message = `到达标签 ${instruction.name}。`; break;
        case 'jump': nextPc = jump(instruction.target); message = `跳转到 ${instruction.target}。`; break;
        case 'branch': {
          const condition = read(instruction.condition);
          if (typeof condition !== 'boolean') throw new Error('条件跳转需要 bool 值。');
          if (!condition) nextPc = jump(instruction.target);
          message = `条件为 ${condition}，${condition ? '顺序进入下一条' : `跳转到 ${instruction.target}`}。`;
          break;
        }
        case 'print': { const value = read(instruction.value); output.push(value); message = `输出 ${value}。`; break; }
        case 'move': case 'binary': {
          const value = instruction.op === 'move' ? read(instruction.value)
            : evaluateBinary(instruction.operator, read(instruction.left), read(instruction.right));
          registers[instruction.dest] = value;
          written = registerText(instruction.dest);
          message = `写入 ${written} = ${value}。`;
          break;
        }
        case 'load': {
          const value = slots[instruction.slot];
          if (value === undefined) throw new Error(`读取未写入的栈槽 ${slotText(instruction.slot)}。`);
          registers[instruction.dest] = value;
          loads++; memory = 'load'; written = registerText(instruction.dest);
          message = `内存读取：从 ${slotText(instruction.slot)} 取回 ${value} 放入 ${written}。`;
          break;
        }
        case 'store': {
          const value = registers[instruction.value];
          if (value === undefined) throw new Error(`读取未写入的寄存器 ${registerText(instruction.value)}。`);
          slots[instruction.slot] = value;
          stores++; memory = 'store'; written = slotText(instruction.slot);
          message = `内存写入：把 ${registerText(instruction.value)} 的 ${value} 存进 ${written}。`;
          break;
        }
      }
      if (record) steps.push({ pc, nextPc, message: `执行 ${registerInstructionText(instruction)}：${message}`,
        registers: [...registers], slots: [...slots], output: [...output], written, memory });
      pc = nextPc;
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      if (record) steps.push({ pc, nextPc: pc, message: `运行时错误：${text}`, registers: [...registers], slots: [...slots], output: [...output] });
      return finish({ error: { message: text, pc } });
    }
  }
  if (record) steps.push({ pc, nextPc: pc, message: '执行到程序末尾，结束。', registers: [...registers], slots: [...slots], output: [...output] });
  return finish({ halted: true });
}

export interface AllocationFrame {
  kind: 'liveness' | 'graph' | 'event' | 'rewrite' | 'assigned' | 'execute' | 'complete';
  round?: number;
  event?: number;
  vmStep?: number;
  message: string;
}
export interface RegisterAllocation {
  settings: RegisterSettings;
  valid: boolean;
  issues: string[];
  rounds: AllocationRound[];
  slots: Record<string, number>;
  finalCode: Located[];
  assignment: Record<string, number>;
  program: RegisterInstruction[];
  removedMoves: number;
  checkIssues: string[];
  execution?: RegisterExecution;
  frames: AllocationFrame[];
  traceTruncated: boolean;
  staticLoads: number;
  staticStores: number;
}
export const MAX_ALLOCATION_ROUNDS = 16;
const MAX_TRACE = 240;
const MAX_CODE = 10000;

function eventMessage(event: AllocationEvent, count: number, costs: Record<string, number>): string {
  switch (event.kind) {
    case 'simplify': return `${event.node} 当前只有 ${event.degree} 个未移出的邻居，少于 K = ${count}：之后一定能找到颜色，先压栈移出。`;
    case 'potential': return `剩下的值度数都 ≥ ${count}。选择溢出代价 / 度数最小的 ${event.node}（代价 ${costs[event.node]}，度数 ${event.degree}）作为“可能溢出”压栈；它在着色时也许仍有空寄存器。`;
    case 'select': return event.reason === 'spill'
      ? `弹出 ${event.node}：邻居已占满 ${event.blocked.map(registerText).join(', ')}，没有空寄存器，真正溢出到栈。`
      : event.reason === 'bias'
        ? `弹出 ${event.node}：与 ${event.partner} 之间是复制，且 ${registerText(event.register!)} 未被邻居占用，优先同一寄存器，复制之后可以删去。`
        : `弹出 ${event.node}：邻居占用 ${event.blocked.map(registerText).join(', ') || '无'}，分配编号最小的空寄存器 ${registerText(event.register!)}。`;
    case 'expire': return `${event.node} 的区间已在 ${pointText(event.at)} 之前结束，释放 ${registerText(event.register)}。`;
    case 'assign': return `${event.node} 的区间 [${pointText(event.start)}, ${pointText(event.end)}] 开始，${registerText(event.register)} 空闲，直接分配。`;
    case 'spill': return event.stolenBy
      ? `寄存器全部占用。活跃区间中 ${event.node} 结束得最晚（${pointText(event.end)}），把它整个溢出，${registerText(event.register!)} 让给 ${event.stolenBy}。`
      : `寄存器全部占用，且 ${event.node} 自己结束得最晚（${pointText(event.end)}），溢出 ${event.node}。`;
  }
}

export function allocateRegisters(ir: Instruction[], dominance: DominanceAnalysis, requested: RegisterSettings,
  settings: { record?: boolean } = {}): RegisterAllocation {
  const record = settings.record ?? true;
  const options = normalizeRegisterSettings(requested.count, requested.algorithm);
  const K = options.count;
  const result: RegisterAllocation = { settings: options, valid: false, issues: [], rounds: [], slots: {}, finalCode: [],
    assignment: {}, program: [], removedMoves: 0, checkIssues: [], frames: [], traceTruncated: false, staticLoads: 0, staticStores: 0 };
  const push = (frame: AllocationFrame) => {
    if (!record) return;
    if (result.frames.length < MAX_TRACE) result.frames.push(frame);
    else result.traceTruncated = true;
  };
  const fail = (message: string) => {
    result.issues.push(message);
    if (record) result.frames.push({ kind: 'complete', round: result.rounds.length - 1, message });
    return result;
  };
  if (!dominance.converged) return fail('支配分析未收敛，无法确定循环深度，不进行分配。');
  if (ir.length > MAX_CODE) return fail('IR 超过 10000 条，不进行分配。');
  const depth = ir.map((_, index) => {
    const block = dominance.graph.instructionBlock[index];
    return dominance.loops.filter((loop) => loop.nodes.includes(block)).length;
  });
  let code: Located[] = ir.map((instruction, origin) => ({ instruction, origin }));
  const unspillable = new Set<string>();
  const counters = new Map<string, number>();
  const fresh = (name: string) => {
    const next = (counters.get(name) ?? 0) + 1;
    counters.set(name, next);
    return `${name}~${next}`;
  };
  for (let round = 0; ; round++) {
    if (round >= MAX_ALLOCATION_ROUNDS) return fail(`溢出重写超过 ${MAX_ALLOCATION_ROUNDS} 轮，停止分配。`);
    const plain = code.map((item) => item.instruction);
    const liveness = instructionLiveness(plain);
    if (!liveness.converged) return fail('逐条活跃性在限定轮数内没有收敛，不进行分配。');
    const graph = buildInterference(plain, liveness);
    const costs: Record<string, number> = Object.fromEntries(graph.nodes.map((name) => [name, 0]));
    code.forEach(({ instruction, origin }) => {
      const weight = 10 ** Math.min(depth[origin] ?? 0, 6);
      for (const name of new Set([...usesOf(instruction), ...(defOf(instruction) ? [defOf(instruction)!] : [])])) costs[name] += weight;
    });
    const intervals = liveIntervals(plain, liveness, graph.nodes);
    const outcome = options.algorithm === 'color' ? colorRound(graph, K, costs, unspillable) : linearRound(intervals, K, unspillable);
    const current: AllocationRound = { index: round, code, liveness, graph, costs, unspillable: [...unspillable], intervals,
      events: outcome.events, assignment: outcome.assignment, spilled: outcome.spilled, failure: outcome.failure };
    result.rounds.push(current);
    const maxLive = Math.max(0, ...liveness.liveOut.map((set) => set.length), ...liveness.liveIn.map((set) => set.length));
    push({ kind: 'liveness', round, message: round === 0
      ? `第 1 轮：从最后一条指令往前，逐条求“之后仍要读取”的值（live-out）。IR 共 ${plain.length} 条，同时活跃的值最多 ${maxLive} 个，寄存器 K = ${K}。`
      : `第 ${round + 1} 轮：溢出代码改变了程序，重新逐条求活跃性。现在共 ${plain.length} 条，同时活跃的值最多 ${maxLive} 个。` });
    push({ kind: 'graph', round, message: options.algorithm === 'color'
      ? `建立干涉图：${graph.nodes.length} 个值，${graph.edges.length} 条边。写入某值时，它与此后仍活跃的值连边；复制 x = y 不与 y 连边。`
      : `把每个值的活跃位置合成一个连续区间，共 ${intervals.length} 个，按起点排序。区间之间的空洞被忽略，所以比干涉图更保守。` });
    outcome.events.forEach((event, index) => push({ kind: 'event', round, event: index, message: eventMessage(event, K, costs) }));
    if (outcome.failure) return fail(outcome.failure);
    if (!outcome.spilled.length) break;
    for (const name of outcome.spilled) if (!(name in result.slots)) result.slots[name] = Object.keys(result.slots).length;
    const spilled = new Set(outcome.spilled);
    const rewritten: Located[] = [];
    for (const { instruction, origin } of code) {
      const names = new Map<string, string>();
      for (const name of usesOf(instruction).filter((item) => spilled.has(item))) {
        const temp = fresh(name);
        unspillable.add(temp);
        names.set(name, temp);
        rewritten.push({ origin, instruction: { op: 'reload', dest: temp, slot: result.slots[name], variable: name, nodeId: instruction.nodeId } });
      }
      let next = renameUses(instruction, names);
      const def = defOf(next);
      if (def && spilled.has(def) && (next.op === 'move' || next.op === 'binary' || next.op === 'reload')) {
        const temp = fresh(def);
        unspillable.add(temp);
        next = { ...next, dest: temp };
        rewritten.push({ origin, instruction: next },
          { origin, instruction: { op: 'spill', value: temp, slot: result.slots[def], variable: def, nodeId: instruction.nodeId } });
      } else rewritten.push({ origin, instruction: next });
    }
    if (rewritten.length > MAX_CODE) return fail('溢出代码使 IR 超过 10000 条，停止分配。');
    code = rewritten;
    push({ kind: 'rewrite', round, message: `真正溢出 ${outcome.spilled.join(', ')}：每次读取前插入 load，每次写入后插入 store，变量本身改放栈槽。新出现的 x~n 只活到下一条指令，标记为不可再溢出，然后重新分析。` });
  }
  const last = result.rounds.at(-1)!;
  result.finalCode = code;
  result.assignment = last.assignment;
  const plain = code.map((item) => item.instruction);
  result.checkIssues = checkAssignment(plain, last.assignment, K);
  if (result.checkIssues.length) return fail(`分配核对失败：${result.checkIssues.slice(0, 3).join(' ')}`);
  const reg = (name: string) => last.assignment[name];
  const operand = (value: Operand): RegOperand => value.kind === 'constant' ? value : { kind: 'register', index: reg(value.name) };
  for (const { instruction, origin } of code) {
    const comment = allocInstructionText(instruction);
    let lowered: RegisterInstruction;
    switch (instruction.op) {
      case 'move': {
        const value = operand(instruction.value);
        if (value.kind === 'register' && value.index === reg(instruction.dest)) { result.removedMoves++; continue; }
        lowered = { op: 'move', dest: reg(instruction.dest), value, origin, comment };
        break;
      }
      case 'binary': lowered = { op: 'binary', dest: reg(instruction.dest), operator: instruction.operator,
        left: operand(instruction.left), right: operand(instruction.right), origin, comment }; break;
      case 'print': lowered = { op: 'print', value: operand(instruction.value), origin, comment }; break;
      case 'label': lowered = { op: 'label', name: instruction.name, origin, comment }; break;
      case 'jump': lowered = { op: 'jump', target: instruction.target, origin, comment }; break;
      case 'branch': lowered = { op: 'branch', condition: operand(instruction.condition), target: instruction.target, origin, comment }; break;
      case 'reload': result.staticLoads++; lowered = { op: 'load', dest: reg(instruction.dest), slot: instruction.slot, origin, comment }; break;
      case 'spill': result.staticStores++; lowered = { op: 'store', slot: instruction.slot, value: reg(instruction.value), origin, comment }; break;
    }
    result.program.push(lowered);
  }
  result.valid = true;
  const used = new Set(Object.values(last.assignment)).size;
  const spilledNames = Object.keys(result.slots);
  if (record) result.frames.push({ kind: 'assigned', round: last.index, message: spilledNames.length
    ? `分配完成：共 ${result.rounds.length} 轮，用到 ${used} 个寄存器，${spilledNames.length} 个值溢出到栈槽（${spilledNames.join(', ')}），插入 ${result.staticLoads} 条 load、${result.staticStores} 条 store。${result.removedMoves ? `另有 ${result.removedMoves} 条复制两端同一寄存器，已删除。` : ''}`
    : `分配完成：用到 ${used} 个寄存器，没有溢出。${result.removedMoves ? `${result.removedMoves} 条复制两端同一寄存器，已删除。` : ''}现在用寄存器名替换每个值，交给寄存器机执行。` });
  result.execution = executeRegisters(result.program, K, spilledNames.length, { record });
  if (record) {
    const steps = result.execution.steps;
    steps.slice(0, MAX_TRACE).forEach((step, index) => result.frames.push({ kind: 'execute', round: last.index, vmStep: index, message: step.message }));
    if (steps.length > MAX_TRACE) result.traceTruncated = true;
    const execution = result.execution;
    result.frames.push({ kind: 'complete', round: last.index, vmStep: steps.length - 1, message: execution.limited
      ? '寄存器机达到 2000 条指令上限；只保留输出前缀，不能判定行为一致。'
      : execution.error ? `寄存器机停止：${execution.error.message}`
        : `寄存器机执行结束：共 ${execution.executed} 条指令，其中内存读取 ${execution.loads} 次、写入 ${execution.stores} 次。` });
  }
  return result;
}

export interface SweepRow {
  count: number;
  algorithm: AllocationAlgorithm;
  valid: boolean;
  spilled: number;
  staticMemory: number;
  dynamicMemory: number;
  executed: number;
  outcome: 'same' | 'different' | 'unknown' | 'failed';
}
export function compareExecutions(left: Pick<Execution, 'output' | 'halted' | 'limited' | 'error'>,
  right: Pick<Execution, 'output' | 'halted' | 'limited' | 'error'>): 'same' | 'different' | 'unknown' {
  if (left.limited || right.limited) return 'unknown';
  return left.halted === right.halted && left.error?.message === right.error?.message &&
    left.output.length === right.output.length && left.output.every((value, index) => Object.is(value, right.output[index]))
    ? 'same' : 'different';
}
/** Run every supported K with both algorithms, without recording replay frames. */
export function sweepRegisters(ir: Instruction[], dominance: DominanceAnalysis, baseline: Pick<Execution, 'output' | 'halted' | 'limited' | 'error'>): SweepRow[] {
  const rows: SweepRow[] = [];
  for (let count = MIN_REGISTERS; count <= MAX_REGISTERS; count++)
    for (const algorithm of ['color', 'linear'] as const) {
      const allocation = allocateRegisters(ir, dominance, { count, algorithm }, { record: false });
      const execution = allocation.execution;
      rows.push({ count, algorithm, valid: allocation.valid, spilled: Object.keys(allocation.slots).length,
        staticMemory: allocation.staticLoads + allocation.staticStores,
        dynamicMemory: execution ? execution.loads + execution.stores : 0, executed: execution?.executed ?? 0,
        outcome: !allocation.valid || !execution ? 'failed' : compareExecutions(baseline, execution) });
    }
  return rows;
}
