import { T } from '../i18n';
import { evaluateBinary } from './operations';
import {
  allocateRegisters, compareExecutions, executeRegisters, registerInstructionText, registerReads, registerText,
  registerWrite, slotText, MAX_REGISTERS, MIN_REGISTERS,
  type AllocationAlgorithm, type RegisterAllocation, type RegisterExecution, type RegisterInstruction,
} from './regalloc';
import type { DominanceAnalysis } from './dominance';
import type { Execution } from './vm';
import type { Instruction } from './model';

/** Teaching latencies: cycles from issue until the result can be read. */
export function latencyOf(instruction: RegisterInstruction): number {
  if (instruction.op === 'label') return 0;
  if (instruction.op === 'load') return 3;
  if (instruction.op === 'binary') return instruction.operator === '*' ? 3 : instruction.operator === '/' ? 4 : 1;
  return 1;
}
export const latencyTable = [
  { kind: T('load（从栈槽读取）'), cycles: 3 },
  { kind: T('乘法 *'), cycles: 3 },
  { kind: T('除法 /'), cycles: 4 },
  { kind: T('其他：复制、加减、比较、store、print、跳转'), cycles: 1 },
];

const slotRead = (instruction: RegisterInstruction) => instruction.op === 'load' ? instruction.slot : undefined;
const slotWrite = (instruction: RegisterInstruction) => instruction.op === 'store' ? instruction.slot : undefined;
const isTerminator = (instruction: RegisterInstruction) => instruction.op === 'jump' || instruction.op === 'branch';
/** Arithmetic may overflow or divide by zero; it keeps its order relative to output and other traps. */
export function canTrap(instruction: RegisterInstruction): boolean {
  if (instruction.op !== 'binary' || !['+', '-', '*', '/'].includes(instruction.operator)) return false;
  const { left, right } = instruction;
  if (left.kind === 'constant' && right.kind === 'constant') {
    try { evaluateBinary(instruction.operator, left.value, right.value); return false; } catch { return true; }
  }
  return true;
}
export const isObservable = (instruction: RegisterInstruction) => instruction.op === 'print' || canTrap(instruction);

export interface DependenceEdge {
  from: number;
  to: number;
  kind: 'raw' | 'war' | 'waw' | 'order' | 'control';
  weight: number;
  via: string;
}
export interface CycleEvent { cycle: number; ready: number[]; chosen?: number; waiting: { node: number; until: number }[] }
export interface ScheduleBlock {
  id: string;
  label?: RegisterInstruction;
  body: RegisterInstruction[];
  edges: DependenceEdge[];
  priority: number[];
  order: number[];
  events: CycleEvent[];
  originalLength: number;
  scheduledLength: number;
}

export function splitBlocks(program: RegisterInstruction[]): { label?: RegisterInstruction; body: RegisterInstruction[] }[] {
  const blocks: { label?: RegisterInstruction; body: RegisterInstruction[] }[] = [];
  let current: { label?: RegisterInstruction; body: RegisterInstruction[] } | undefined;
  for (const instruction of program) {
    if (instruction.op === 'label') {
      if (current) blocks.push(current);
      current = { label: instruction, body: [] };
      continue;
    }
    current ??= { body: [] };
    current.body.push(instruction);
    if (isTerminator(instruction)) { blocks.push(current); current = undefined; }
  }
  if (current) blocks.push(current);
  return blocks;
}

export function buildDependences(body: RegisterInstruction[]): DependenceEdge[] {
  const edges: DependenceEdge[] = [];
  const add = (from: number, to: number, kind: DependenceEdge['kind'], weight: number, via: string) => {
    if (from !== to && !edges.some((edge) => edge.from === from && edge.to === to && edge.kind === kind && edge.via === via))
      edges.push({ from, to, kind, weight, via });
  };
  const lastWrite = new Map<string, number>();
  const readsSince = new Map<string, number[]>();
  let lastObservable: number | undefined;
  body.forEach((instruction, index) => {
    const reads = [...registerReads(instruction).map((register) => registerText(register)),
      ...(slotRead(instruction) !== undefined ? [slotText(slotRead(instruction)!)] : [])];
    const write = registerWrite(instruction) !== undefined ? registerText(registerWrite(instruction)!)
      : slotWrite(instruction) !== undefined ? slotText(slotWrite(instruction)!) : undefined;
    for (const name of reads) {
      const writer = lastWrite.get(name);
      if (writer !== undefined) add(writer, index, 'raw', latencyOf(body[writer]), name);
    }
    if (write) {
      for (const reader of readsSince.get(write) ?? []) add(reader, index, 'war', 1, write);
      const writer = lastWrite.get(write);
      if (writer !== undefined) add(writer, index, 'waw', Math.max(1, latencyOf(body[writer]) - latencyOf(instruction) + 1), write);
    }
    for (const name of reads) readsSince.set(name, [...(readsSince.get(name) ?? []), index]);
    if (write) { lastWrite.set(write, index); readsSince.set(write, []); }
    if (isObservable(instruction)) {
      if (lastObservable !== undefined) add(lastObservable, index, 'order', 1, instruction.op === 'print' ? T('输出') : T('可能报错'));
      lastObservable = index;
    }
    if (isTerminator(instruction))
      for (let other = 0; other < index; other++) if (!edges.some((edge) => edge.from === other && edge.to === index)) add(other, index, 'control', 1, T('块末跳转'));
  });
  return edges;
}

/** Issue the given order on the single-issue model and return the cycle after the last issue. */
export function scheduleLength(edges: DependenceEdge[], order: number[]): number {
  const at = new Map<number, number>();
  let cycle = 0;
  for (const node of order) {
    let start = cycle;
    for (const edge of edges) if (edge.to === node && at.has(edge.from)) start = Math.max(start, at.get(edge.from)! + edge.weight);
    at.set(node, start);
    cycle = start + 1;
  }
  return cycle;
}

export function listSchedule(body: RegisterInstruction[], edges: DependenceEdge[]) {
  const n = body.length;
  const successors = body.map((_, index) => edges.filter((edge) => edge.from === index));
  const predecessors = body.map((_, index) => edges.filter((edge) => edge.to === index));
  const priority: number[] = Array(n).fill(0);
  for (let index = n - 1; index >= 0; index--)
    priority[index] = Math.max(latencyOf(body[index]), ...successors[index].map((edge) => edge.weight + priority[edge.to]));
  const earliest: number[] = Array(n).fill(0);
  const done = new Set<number>();
  const order: number[] = [];
  const events: CycleEvent[] = [];
  for (let cycle = 0; done.size < n; cycle++) {
    if (cycle > n * 8 + 8) throw new Error(T('指令排序没有在预期周期内完成。'));
    const available = body.map((_, index) => index).filter((index) => !done.has(index) &&
      predecessors[index].every((edge) => done.has(edge.from)));
    const ready = available.filter((index) => earliest[index] <= cycle);
    const waiting = available.filter((index) => earliest[index] > cycle).map((node) => ({ node, until: earliest[node] }));
    if (!ready.length) { events.push({ cycle, ready, waiting }); continue; }
    const chosen = ready.reduce((best, index) => priority[index] > priority[best] ? index : best);
    events.push({ cycle, ready, chosen, waiting });
    done.add(chosen);
    order.push(chosen);
    for (const edge of successors[chosen]) earliest[edge.to] = Math.max(earliest[edge.to], cycle + edge.weight);
  }
  return { priority, order, events };
}

/** Independent check: any two instructions that touch the same location, or are both observable, keep their order. */
export function checkOrder(body: RegisterInstruction[], order: number[]): string[] {
  const issues: string[] = [];
  if (order.length !== body.length || new Set(order).size !== body.length) return [T('排序结果不是原指令的排列。')];
  const position = new Map(order.map((node, index) => [node, index]));
  const touches = (instruction: RegisterInstruction) => ({
    reads: [...registerReads(instruction).map(registerText), ...(slotRead(instruction) !== undefined ? [slotText(slotRead(instruction)!)] : [])],
    write: registerWrite(instruction) !== undefined ? registerText(registerWrite(instruction)!)
      : slotWrite(instruction) !== undefined ? slotText(slotWrite(instruction)!) : undefined,
  });
  for (let i = 0; i < body.length; i++) for (let j = i + 1; j < body.length; j++) {
    const a = touches(body[i]), b = touches(body[j]);
    const conflict = (a.write && (b.reads.includes(a.write) || b.write === a.write)) || (b.write && a.reads.includes(b.write)) ||
      (isObservable(body[i]) && isObservable(body[j])) || isTerminator(body[j]) || isTerminator(body[i]);
    if (conflict && position.get(i)! > position.get(j)!)
      issues.push(T('“{#0}” 被移到了 “{#1}” 之前。', registerInstructionText(body[j]), registerInstructionText(body[i])));
  }
  return issues;
}

export interface PeepholeRewrite { rule: 'forward' | 'redundant-load' | 'jump-next' | 'self-move' | 'dead-store'; index: number; before: string[]; after: string[]; message: string }
export function peephole(program: RegisterInstruction[]): { program: RegisterInstruction[]; rewrites: PeepholeRewrite[] } {
  const code = program.map((instruction) => ({ ...instruction })) as RegisterInstruction[];
  const rewrites: PeepholeRewrite[] = [];
  const text = (items: RegisterInstruction[]) => items.map(registerInstructionText);
  // Each rule looks only at adjacent instructions; a label between them breaks the window.
  for (let index = 0; index < code.length && rewrites.length < 1000;) {
    const a = code[index], b = code[index + 1];
    let replacement: RegisterInstruction[] | undefined, width = 2;
    let rule: PeepholeRewrite['rule'] | undefined, message = '';
    if (a.op === 'move' && a.value.kind === 'register' && a.value.index === a.dest) {
      replacement = []; width = 1; rule = 'self-move';
      message = T('{#0} = {#0} 不改变任何值，删去。', registerText(a.dest));
    } else if (a.op === 'store' && b?.op === 'load' && a.slot === b.slot) {
      if (a.value === b.dest) {
        replacement = [a]; rule = 'redundant-load';
        message = T('刚把 {#0} 存进 {#1}，紧接着又读回同一寄存器：这条 load 是冗余的，删去（原书第 08 讲的例子）。', registerText(a.value), slotText(a.slot));
      } else {
        replacement = [a, { op: 'move', dest: b.dest, value: { kind: 'register', index: a.value }, origin: b.origin, comment: b.comment }];
        rule = 'forward';
        message = T('{#0} 里的值就是 {#1}，把 load 改成寄存器复制，省一次内存读取；store 保留，后面可能还要读这个栈槽。', slotText(a.slot), registerText(a.value));
      }
    } else if (a.op === 'store' && b?.op === 'store' && a.slot === b.slot) {
      replacement = [b]; rule = 'dead-store';
      message = T('连续两次写 {#0}，中间没有读取：前一次 store 无用，删去。', slotText(a.slot));
    } else if (a.op === 'jump' && b?.op === 'label' && a.target === b.name) {
      replacement = [b]; rule = 'jump-next';
      message = T('goto {#0} 的目标就是下一条，顺序执行也会到达，删去跳转；标签保留给其他跳转。', a.target);
    }
    if (!replacement || !rule) { index++; continue; }
    const before = code.slice(index, index + width);
    code.splice(index, width, ...replacement);
    rewrites.push({ rule, index, before: text(before), after: text(replacement), message });
    index = Math.max(0, index - 1);
  }
  return { program: code, rewrites };
}

export interface ScheduleFrame {
  kind: 'initial' | 'peephole' | 'dag' | 'cycle' | 'timing' | 'complete';
  block?: number;
  event?: number;
  rewrite?: number;
  message: string;
}
export interface ScheduleAnalysis {
  valid: boolean;
  issues: string[];
  rewrites: PeepholeRewrite[];
  afterPeephole: RegisterInstruction[];
  blocks: ScheduleBlock[];
  scheduled: RegisterInstruction[];
  checkIssues: string[];
  falseDependences: number;
  runs?: { allocated: RegisterExecution; peephole: RegisterExecution; scheduled: RegisterExecution };
  frames: ScheduleFrame[];
  traceTruncated: boolean;
}
const MAX_TRACE = 240;
export const dependenceName = (kind: DependenceEdge['kind']) => {
  switch (kind) {
    case 'raw': return T('真依赖');
    case 'war': return T('反依赖');
    case 'waw': return T('输出依赖');
    case 'order': return T('顺序约束');
    case 'control': return T('块末跳转');
  }
};

export function scheduleAllocation(allocation: RegisterAllocation, settings: { record?: boolean } = {}): ScheduleAnalysis {
  const record = settings.record ?? true;
  const result: ScheduleAnalysis = { valid: false, issues: [], rewrites: [], afterPeephole: [], blocks: [], scheduled: [],
    checkIssues: [], falseDependences: 0, frames: [], traceTruncated: false };
  const push = (frame: ScheduleFrame) => {
    if (!record) return;
    if (result.frames.length < MAX_TRACE) result.frames.push(frame);
    else result.traceTruncated = true;
  };
  if (!allocation.valid) {
    result.issues.push(T('寄存器分配没有完成，无法继续排序。'));
    if (record) result.frames.push({ kind: 'complete', message: result.issues[0] });
    return result;
  }
  const K = allocation.settings.count, slots = Object.keys(allocation.slots).length;
  push({ kind: 'initial', message: T('从实验 17 的分配结果出发：K = {#0}，{#1} 条寄存器指令。先用 2 条指令宽的窗口做窥孔优化，再逐块重排。', K, allocation.program.length) });
  const optimized = peephole(allocation.program);
  result.rewrites = optimized.rewrites;
  result.afterPeephole = optimized.program;
  optimized.rewrites.forEach((rewrite, index) => push({ kind: 'peephole', rewrite: index, message: rewrite.message }));
  if (!optimized.rewrites.length) push({ kind: 'peephole', message: T('窗口滑过全部指令，没有找到可以改写的相邻指令对。') });
  for (const [index, block] of splitBlocks(optimized.program).entries()) {
    const edges = buildDependences(block.body);
    const { priority, order, events } = listSchedule(block.body, edges);
    const identity = block.body.map((_, node) => node);
    const scheduled: ScheduleBlock = { id: block.label?.op === 'label' ? block.label.name : index === 0 ? T('入口') : T('块 {#0}', index),
      label: block.label, body: block.body, edges, priority, order, events,
      originalLength: scheduleLength(edges, identity), scheduledLength: scheduleLength(edges, order) };
    result.blocks.push(scheduled);
    result.falseDependences += edges.filter((edge) => edge.kind === 'war' || edge.kind === 'waw').length;
    result.checkIssues.push(...checkOrder(block.body, order).map((issue) => T('{#0}：{#1}', scheduled.id, issue)));
    if (block.label) result.scheduled.push(block.label);
    result.scheduled.push(...order.map((node) => block.body[node]));
    if (block.body.length < 2) continue;
    const blockIndex = result.blocks.length - 1;
    const counts = (kind: DependenceEdge['kind']) => edges.filter((edge) => edge.kind === kind).length;
    push({ kind: 'dag', block: blockIndex, message: T('{#0}：{#1} 条指令建依赖图。真依赖 {#2} 条，寄存器复用带来的反依赖 / 输出依赖 {#3} 条，为保留输出与报错顺序的约束 {#4} 条。原顺序需要 {#5} 个周期。', scheduled.id, block.body.length, counts('raw'), counts('war') + counts('waw'), counts('order'), scheduled.originalLength) });
    events.forEach((event, eventIndex) => push({ kind: 'cycle', block: blockIndex, event: eventIndex,
      message: event.chosen === undefined
        ? T('周期 {#0}：没有就绪的指令，流水线空转（stall），等待 {#1}。', event.cycle, event.waiting.map((item) => T('#{#0} 到周期 {#1}', item.node, item.until)).join(T('、')))
        : T('周期 {#0}：就绪 {#1}，选关键路径最长的 #{#2}「{#3}」（剩余路径 {#4}）。', event.cycle, event.ready.map((node) => `#${node}`).join(T('、')), event.chosen, registerInstructionText(block.body[event.chosen]), priority[event.chosen]) }));
  }
  if (result.checkIssues.length) {
    result.issues.push(T('排序核对失败：{#0}', result.checkIssues.slice(0, 3).join(' ')));
    if (record) result.frames.push({ kind: 'complete', message: result.issues[0] });
    return result;
  }
  const run = (program: RegisterInstruction[], steps: boolean) => executeRegisters(program, K, slots, { record: steps, latency: latencyOf });
  result.runs = { allocated: run(allocation.program, record), peephole: run(optimized.program, false), scheduled: run(result.scheduled, record) };
  result.valid = true;
  const { allocated, scheduled } = result.runs;
  if (record) {
    result.frames.push({ kind: 'timing', message: T('用同一个流水线模型执行：分配后原顺序 {#0} 个周期（空转 {#1}），窥孔后 {#2}，再排序后 {#3} 个周期（空转 {#4}）。', allocated.cycles, allocated.stalls, result.runs.peephole.cycles, scheduled.cycles, scheduled.stalls) });
    result.frames.push({ kind: 'complete', message: scheduled.limited ? T('寄存器机达到 2000 条指令上限；只保留输出前缀，不能判定行为一致。')
      : scheduled.error ? T('排序后的程序停止：{#0}', scheduled.error.message) : T('排序后的程序执行结束，可以对照输出、报错与周期数。') });
  }
  return result;
}

export interface ScheduleSweepRow { count: number; valid: boolean; falseDependences: number; allocated: number; scheduled: number; memory: number; outcome: 'same' | 'different' | 'unknown' | 'failed' }
export function sweepSchedules(ir: Instruction[], dominance: DominanceAnalysis, algorithm: AllocationAlgorithm,
  baseline: Pick<Execution, 'output' | 'halted' | 'limited' | 'error'>): ScheduleSweepRow[] {
  const rows: ScheduleSweepRow[] = [];
  for (let count = MIN_REGISTERS; count <= MAX_REGISTERS; count++) {
    const allocation = allocateRegisters(ir, dominance, { count, algorithm }, { record: false });
    const analysis = scheduleAllocation(allocation, { record: false });
    const runs = analysis.runs;
    rows.push({ count, valid: analysis.valid, falseDependences: analysis.falseDependences,
      allocated: runs?.allocated.cycles ?? 0, scheduled: runs?.scheduled.cycles ?? 0,
      memory: runs ? runs.scheduled.loads + runs.scheduled.stores : 0,
      outcome: !runs ? 'failed' : compareExecutions(baseline, runs.scheduled) });
  }
  return rows;
}
