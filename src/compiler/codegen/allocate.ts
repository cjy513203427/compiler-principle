import { T } from '../../i18n';
import {
  CALLEE_SAVED, CALLER_SAVED, defs, isVirtual, mapRegs, preg, regKey, successors, uses, vreg,
  type MInst, type MOp, type Reg, type Reg64,
} from './x64';

export type RegisterPool = 'full' | 'tight';
/** Allocation order: caller-saved first (no save/restore cost), then callee-saved. r11 stays the check scratch. */
export const POOLS: Record<RegisterPool, Reg64[]> = {
  full: ['rax', 'rcx', 'rdx', 'rsi', 'rdi', 'r8', 'r9', 'r10', 'rbx', 'r12', 'r13', 'r14', 'r15'],
  tight: ['rax', 'rcx', 'rdx', 'rbx'],
};
export const poolNames: Record<RegisterPool, string> = {
  full: T('13 个通用寄存器'),
  tight: T('紧张：rax rcx rdx rbx'),
};
export const MAX_CODEGEN_ROUNDS = 16;
const MAX_PASSES = 400;

export interface MachineLiveness { liveIn: string[][]; liveOut: string[][]; converged: boolean }
export function machineLiveness(code: MOp[]): MachineLiveness {
  const next = successors(code);
  const use = code.map((instruction) => [...new Set(uses(instruction).map(regKey))]);
  const def = code.map((instruction) => new Set(defs(instruction).map(regKey)));
  const liveIn = code.map(() => new Set<string>());
  const liveOut = code.map(() => new Set<string>());
  let converged = false;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    let changed = false;
    for (let index = code.length - 1; index >= 0; index--) {
      const out = new Set<string>();
      for (const successor of next[index]) for (const name of liveIn[successor]) out.add(name);
      const input = new Set(use[index]);
      for (const name of out) if (!def[index].has(name)) input.add(name);
      if (out.size !== liveOut[index].size || input.size !== liveIn[index].size) changed = true;
      liveOut[index] = out;
      liveIn[index] = input;
    }
    if (!changed) { converged = true; break; }
  }
  return { liveIn: liveIn.map((set) => [...set].sort()), liveOut: liveOut.map((set) => [...set].sort()), converged };
}

const moveSource = (instruction: MOp) =>
  instruction.op === 'mov' && instruction.src.kind !== 'imm' ? regKey(instruction.src) : undefined;

export interface MachineGraph {
  nodes: string[];
  precolored: Reg64[];
  adjacency: Record<string, string[]>;
  moves: [string, string][];
  /** Virtual registers still needed after some call: every caller-saved register is off limits. */
  acrossCall: string[];
}
export function buildMachineGraph(code: MOp[], liveness: MachineLiveness): MachineGraph {
  const nodes: string[] = [];
  const seen = new Set<string>();
  const precolored = new Set<Reg64>();
  const adjacency = new Map<string, Set<string>>();
  const touch = (key: string) => {
    if (!adjacency.has(key)) adjacency.set(key, new Set());
    if (isVirtual(key)) { if (!seen.has(key)) { seen.add(key); nodes.push(key); } }
    else precolored.add(key as Reg64);
  };
  const add = (a: string, b: string) => {
    if (a === b || (!isVirtual(a) && !isVirtual(b))) return;
    adjacency.get(a)!.add(b);
    adjacency.get(b)!.add(a);
  };
  const moves: [string, string][] = [];
  const acrossCall = new Set<string>();
  code.forEach((instruction, index) => {
    uses(instruction).forEach((reg) => touch(regKey(reg)));
    defs(instruction).forEach((reg) => touch(regKey(reg)));
    liveness.liveOut[index].forEach(touch);
  });
  code.forEach((instruction, index) => {
    const source = moveSource(instruction);
    const written = defs(instruction).map(regKey);
    if (source && written[0] !== source) moves.push([written[0], source]);
    if (instruction.op === 'call') liveness.liveOut[index].filter(isVirtual).forEach((key) => acrossCall.add(key));
    // A write conflicts with every value still needed afterwards; a copy may share with its source.
    for (const key of written) for (const live of liveness.liveOut[index]) if (live !== source) add(key, live);
  });
  return {
    nodes, precolored: [...precolored],
    adjacency: Object.fromEntries([...adjacency].map(([key, set]) => [key, [...set]])),
    moves, acrossCall: nodes.filter((key) => acrossCall.has(key)),
  };
}

export type ColoringEvent =
  | { kind: 'simplify'; node: string; degree: number }
  | { kind: 'potential'; node: string; degree: number; cost: number }
  | { kind: 'select'; node: string; register?: Reg64; reason: 'bias' | 'lowest' | 'callee' | 'spill'; blocked: Reg64[]; partner?: string };
export interface CodegenRound {
  index: number;
  code: MInst[];
  liveness: MachineLiveness;
  graph: MachineGraph;
  costs: Record<string, number>;
  events: ColoringEvent[];
  assignment: Record<string, Reg64>;
  spilled: string[];
  failure?: string;
}

function colorRound(graph: MachineGraph, pool: Reg64[], costs: Record<string, number>, unspillable: Set<string>) {
  const K = pool.length;
  const events: ColoringEvent[] = [];
  const remaining = new Set(graph.nodes);
  const inPool = new Set(pool);
  const degree = (key: string) => graph.adjacency[key].filter((other) => remaining.has(other) || (!isVirtual(other) && inPool.has(other as Reg64))).length;
  const stack: string[] = [];
  while (remaining.size) {
    const easy = graph.nodes.find((key) => remaining.has(key) && degree(key) < K);
    if (easy) {
      events.push({ kind: 'simplify', node: easy, degree: degree(easy) });
      remaining.delete(easy);
      stack.push(easy);
      continue;
    }
    let best: string | undefined;
    for (const key of graph.nodes) {
      if (!remaining.has(key) || unspillable.has(key)) continue;
      if (!best || costs[key] / degree(key) < costs[best] / degree(best)) best = key;
    }
    if (!best) return { events, assignment: {}, spilled: [], failure: T('剩余的值都是溢出产生的短临时值，{#0} 个可分配寄存器仍放不下它们。', K) };
    events.push({ kind: 'potential', node: best, degree: degree(best), cost: costs[best] });
    remaining.delete(best);
    stack.push(best);
  }
  const assignment: Record<string, Reg64> = {};
  const spilled: string[] = [];
  const partners = new Map(graph.nodes.map((key) => [key, [] as string[]]));
  for (const [a, b] of graph.moves) {
    partners.get(a)?.push(b);
    partners.get(b)?.push(a);
  }
  const colorOf = (key: string): Reg64 | undefined => (isVirtual(key) ? assignment[key] : (key as Reg64));
  while (stack.length) {
    const node = stack.pop()!;
    const blocked = [...new Set(graph.adjacency[node].flatMap((other) => {
      const color = colorOf(other);
      return color ? [color] : [];
    }))].sort();
    const partner = partners.get(node)!.find((other) => {
      const color = colorOf(other);
      return color && inPool.has(color) && !blocked.includes(color);
    });
    if (partner) {
      assignment[node] = colorOf(partner)!;
      events.push({ kind: 'select', node, register: assignment[node], reason: 'bias', blocked, partner });
      continue;
    }
    const free = pool.find((reg) => !blocked.includes(reg));
    if (!free) {
      spilled.push(node);
      events.push({ kind: 'select', node, reason: 'spill', blocked });
    } else {
      assignment[node] = free;
      events.push({ kind: 'select', node, register: free, reason: CALLEE_SAVED.includes(free) ? 'callee' : 'lowest', blocked });
    }
  }
  return { events, assignment, spilled };
}

export function checkMachineAssignment(code: MOp[], assignment: Record<string, Reg64>, pool: Reg64[]): string[] {
  const issues: string[] = [];
  const liveness = machineLiveness(code);
  if (!liveness.converged) return [T('机器代码活跃性没有收敛，无法核对分配。')];
  const color = (key: string) => (isVirtual(key) ? assignment[key] : (key as Reg64));
  const names = new Set(code.flatMap((instruction) => [...uses(instruction), ...defs(instruction)].map(regKey)).filter(isVirtual));
  for (const name of names) {
    if (!assignment[name]) issues.push(T('{#0} 没有物理寄存器。', name));
    else if (!pool.includes(assignment[name])) issues.push(T('{#0} 用了不在可分配集合里的 {#1}。', name, assignment[name]));
  }
  const entry = liveness.liveIn[0]?.filter(isVirtual) ?? [];
  if (entry.length) issues.push(T('入口处仍有未定义就使用的值：{#0}。', entry.join(', ')));
  code.forEach((instruction, index) => {
    const source = moveSource(instruction);
    for (const written of defs(instruction).map(regKey))
      for (const live of liveness.liveOut[index])
        if (live !== written && live !== source && color(live) === color(written) && (isVirtual(live) || isVirtual(written)))
          issues.push(T('#{#0} 写入 {#1} 会覆盖仍要使用的 {#2}（同在 {#3}）。', index, written, live, color(written)));
  });
  return issues;
}

export interface AllocationOutcome {
  valid: boolean;
  issues: string[];
  rounds: CodegenRound[];
  slots: Record<string, number>;
  assignment: Record<string, Reg64>;
  finalVirtual: MInst[];
  checkIssues: string[];
}
export function allocateMachine(code: MInst[], pool: Reg64[], depth: (origin: number) => number): AllocationOutcome {
  const result: AllocationOutcome = { valid: false, issues: [], rounds: [], slots: {}, assignment: {}, finalVirtual: [], checkIssues: [] };
  const unspillable = new Set<string>();
  const counters = new Map<string, number>();
  let current = code;
  for (let round = 0; ; round++) {
    if (round >= MAX_CODEGEN_ROUNDS) { result.issues.push(T('溢出重写超过 {#0} 轮，停止分配。', MAX_CODEGEN_ROUNDS)); return result; }
    const liveness = machineLiveness(current);
    if (!liveness.converged) { result.issues.push(T('机器代码活跃性没有收敛，不进行分配。')); return result; }
    const graph = buildMachineGraph(current, liveness);
    const costs: Record<string, number> = Object.fromEntries(graph.nodes.map((key) => [key, 0]));
    current.forEach((instruction) => {
      const weight = 10 ** Math.min(depth(instruction.origin), 6);
      for (const key of new Set([...uses(instruction), ...defs(instruction)].map(regKey))) if (key in costs) costs[key] += weight;
    });
    const outcome = colorRound(graph, pool, costs, unspillable);
    result.rounds.push({ index: round, code: current, liveness, graph, costs, events: outcome.events,
      assignment: outcome.assignment, spilled: outcome.spilled, failure: outcome.failure });
    if (outcome.failure) { result.issues.push(outcome.failure); return result; }
    if (!outcome.spilled.length) break;
    for (const key of outcome.spilled) if (!(key in result.slots)) result.slots[key] = Object.keys(result.slots).length;
    const spilled = new Set(outcome.spilled);
    const rewritten: MInst[] = [];
    for (const instruction of current) {
      const touched = [...new Set([...uses(instruction), ...defs(instruction)].map(regKey))].filter((key) => spilled.has(key));
      if (!touched.length) { rewritten.push(instruction); continue; }
      const names = new Map<string, Reg>();
      for (const key of touched) {
        const base = key.slice(1);
        const next = (counters.get(base) ?? 0) + 1;
        counters.set(base, next);
        const temp = vreg(`${base}~${next}`);
        unspillable.add(regKey(temp));
        names.set(key, temp);
      }
      const read = new Set(uses(instruction).map(regKey));
      const written = new Set(defs(instruction).map(regKey));
      for (const key of touched) if (read.has(key))
        rewritten.push({ op: 'load', dst: names.get(key)!, src: { kind: 'slot', slot: result.slots[key] }, origin: instruction.origin, role: 'spill', note: T('重新取回溢出的 {#0}', key) });
      rewritten.push(mapRegs(instruction, (reg) => names.get(regKey(reg)) ?? reg));
      for (const key of touched) if (written.has(key))
        rewritten.push({ op: 'store', dst: { kind: 'slot', slot: result.slots[key] }, src: names.get(key)!, origin: instruction.origin, role: 'spill', note: T('把 {#0} 写回栈槽', key) });
    }
    current = rewritten;
  }
  const last = result.rounds.at(-1)!;
  result.assignment = last.assignment;
  result.finalVirtual = current;
  result.checkIssues = checkMachineAssignment(current, last.assignment, pool);
  if (result.checkIssues.length) { result.issues.push(T('分配核对失败：{#0}', result.checkIssues.slice(0, 3).join(' '))); return result; }
  result.valid = true;
  return result;
}

export interface FrameLayout { calleeSaved: Reg64[]; slots: number; size: number; padding: number }
/** Replace virtual registers, drop self copies, then wrap the body in a System V frame. */
export function layoutFrame(code: MInst[], assignment: Record<string, Reg64>, slotCount: number) {
  let removedMoves = 0;
  const body: MInst[] = [];
  for (const instruction of code) {
    const physical = mapRegs(instruction, (reg) => (reg.kind === 'v' ? preg(assignment[regKey(reg)]) : reg));
    if (physical.op === 'mov' && physical.src.kind === 'p' && physical.dst.kind === 'p' && physical.src.reg === physical.dst.reg) { removedMoves++; continue; }
    body.push(physical);
  }
  // Calls only clobber caller-saved registers, so their defs never require a save.
  const used = new Set(body.flatMap((instruction) => (instruction.op === 'call' ? [] : defs(instruction)).map((reg) => (reg as { reg: Reg64 }).reg)));
  const calleeSaved = CALLEE_SAVED.filter((reg) => used.has(reg));
  // Entry rsp ≡ 8 (mod 16); after push rbp it is aligned, so saves + locals must be a multiple of 16.
  const padding = (8 * calleeSaved.length + 8 * slotCount) % 16;
  const size = 8 * slotCount + padding;
  const frame = frameInst;
  const prologue: MInst[] = [
    frame({ op: 'push', reg: preg('rbp') }, T('保存调用者的帧指针')),
    frame({ op: 'mov', dst: preg('rbp'), src: preg('rsp') }, T('建立本函数的帧')),
    ...calleeSaved.map((reg) => frame({ op: 'push', reg: preg(reg) }, T('{#0} 是 callee-saved，用之前先保存', reg))),
    ...(size ? [frame({ op: 'subsp', amount: size }, padding ? T('{#0} 个栈槽 + 8 字节对齐填充', slotCount) : T('{#0} 个栈槽', slotCount))] : []),
  ];
  const epilogue: MInst[] = [
    frame({ op: 'zero', dst: preg('rax') }, T('main 返回 0')),
    ...(size ? [frame({ op: 'addsp', amount: size }, T('释放栈槽'))] : []),
    ...[...calleeSaved].reverse().map((reg) => frame({ op: 'pop', reg: preg(reg) }, T('恢复 {#0}', reg))),
    frame({ op: 'pop', reg: preg('rbp') }, T('恢复调用者的帧指针')),
    frame({ op: 'ret' }, T('返回调用者')),
  ];
  const offset = (slot: number) => 8 * (calleeSaved.length + 1 + slot);
  const program: MInst[] = [...prologue];
  for (const instruction of body) {
    if (instruction.op === 'exit') { program.push(...epilogue); continue; }
    if (instruction.op === 'load' && instruction.src.kind === 'slot') program.push({ ...instruction, src: { kind: 'frame', offset: offset(instruction.src.slot) } });
    else if (instruction.op === 'store' && instruction.dst.kind === 'slot') program.push({ ...instruction, dst: { kind: 'frame', offset: offset(instruction.dst.slot) } });
    else program.push(instruction);
  }
  const layout: FrameLayout = { calleeSaved, slots: slotCount, size, padding };
  return { program, removedMoves, layout, slotOffset: offset };
}
function frameInst(op: MOp, note?: string): MInst {
  return { ...op, origin: -1, role: 'frame', note };
}
export const callerSaved = CALLER_SAVED;
