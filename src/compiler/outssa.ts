import type { ControlEdge } from './cfg';
import type { DominanceAnalysis } from './dominance';
import { referencedVariables } from './dataflow';
import { validateSSA, type SsaAnalysis } from './ssa';
import { execute, generateBytecode, type Execution } from './vm';
import type { Bytecode, Instruction } from './model';

export interface ParallelCopy { dest: string; source: string }
export interface CopyStep {
  kind: 'copy' | 'save' | 'identity';
  copy: ParallelCopy;
  remaining: ParallelCopy[];
  message: string;
}
export interface CopySchedule { moves: ParallelCopy[]; temporaries: string[]; steps: CopyStep[] }
const MAX_TRACE = 240;
const MAX_IR = 10000;

/** Emit a destination only after all pending reads of its old value have been preserved. */
export function scheduleParallelCopies(copies: ParallelCopy[], fresh?: () => string): CopySchedule {
  if (new Set(copies.map((copy) => copy.dest)).size !== copies.length)
    throw new Error('一组并行复制中，每个目标只能写入一次。');
  const used = new Set(copies.flatMap((copy) => [copy.dest, copy.source]));
  let counter = 0;
  const allocate = fresh || (() => {
    let name: string;
    do { name = `__phi_tmp${counter++}`; } while (used.has(name));
    used.add(name);
    return name;
  });
  let pending = copies.filter((copy) => copy.dest !== copy.source).map((copy) => ({ ...copy }));
  const moves: ParallelCopy[] = [], steps: CopyStep[] = [];
  const temporaries: string[] = [];
  const snapshot = () => pending.map((copy) => ({ ...copy }));
  for (const copy of copies.filter((copy) => copy.dest === copy.source))
    steps.push({ kind: 'identity', copy: { ...copy }, remaining: snapshot(), message: `${copy.dest} ← ${copy.source} 是自身复制，可以省略。` });
  while (pending.length) {
    const index = pending.findIndex((copy) => !pending.some((other) => other.source === copy.dest));
    if (index >= 0) {
      const [copy] = pending.splice(index, 1);
      moves.push(copy);
      steps.push({ kind: 'copy', copy, remaining: snapshot(),
        message: `执行 ${copy.dest} ← ${copy.source}：其他待处理复制已不再读取 ${copy.dest} 的旧值。` });
    } else {
      const dest = pending[0].dest;
      const temporary = allocate();
      if (copies.some((copy) => copy.dest === temporary || copy.source === temporary) || temporaries.includes(temporary))
        throw new Error('复制临时变量与已有名字冲突。');
      const copy = { dest: temporary, source: dest };
      temporaries.push(temporary);
      moves.push(copy);
      pending = pending.map((item) => item.source === dest ? { ...item, source: temporary } : item);
      steps.push({ kind: 'save', copy, remaining: snapshot(),
        message: `发现复制环：先把 ${dest} 的旧值保存到 ${temporary}，再把相关读取改为这个临时变量。` });
    }
  }
  return { moves, temporaries, steps };
}

export interface EdgeCopyPlan extends CopySchedule {
  from: string;
  to: string;
  edgeIds: string[];
  placement: 'predecessor' | 'successor' | 'split';
  host: string;
  copies: ParallelCopy[];
}
export interface LoweredBlock { id: string; instructions: Instruction[]; original: boolean }
export interface OutSsaFrame {
  kind: 'initial' | 'edge' | 'copy' | 'ready' | 'execute' | 'complete';
  block: string;
  message: string;
  plan?: number;
  copyStep?: number;
  vmStep?: number;
}
export interface OutSsaAnalysis {
  valid: boolean;
  issues: string[];
  plans: EdgeCopyPlan[];
  blocks: LoweredBlock[];
  edges: ControlEdge[];
  instructions: Instruction[];
  instructionBlocks: string[];
  visitedBlocks: string[];
  bytecode?: Bytecode[];
  execution?: Execution;
  frames: OutSsaFrame[];
  traceTruncated: boolean;
}

export function lowerSSA(ssa: Pick<SsaAnalysis, 'valid' | 'blocks'>, dominance: DominanceAnalysis): OutSsaAnalysis {
  const result: OutSsaAnalysis = { valid: false, issues: [], plans: [], blocks: [], edges: [],
    instructions: [], instructionBlocks: [], visitedBlocks: [], frames: [], traceTruncated: false };
  const fail = (message: string) => {
    result.issues.push(message);
    result.frames.push({ kind: 'complete', block: dominance.entry, message });
    return result;
  };
  if (!ssa.valid || !dominance.converged) return fail('SSA 或支配分析未通过校验，不执行消除。');
  const ids = ssa.blocks.map((block) => block.id);
  if (new Set(ids).size !== ids.length || ids.length !== dominance.reachable.length ||
      dominance.reachable.some((id) => !ids.includes(id))) return fail('SSA 块没有完整覆盖原始入口可达图。');
  const issues = validateSSA(ssa.blocks, dominance);
  if (issues.length) return fail(`SSA 校验失败：${issues.join(' ')}`);
  const byId = new Map(ssa.blocks.map((block) => [block.id, block]));
  const edges = dominance.graph.edges.filter((edge) => ids.includes(edge.from) && ids.includes(edge.to));
  const rewritten = edges.map((edge) => ({ ...edge }));
  const ordered = [byId.get(dominance.entry)!, ...ssa.blocks.filter((block) => block.id !== dominance.entry)];
  const bodies = new Map(ordered.map((block) => [block.id, block.instructions
    .filter((instruction) => !['label', 'branch', 'jump'].includes(instruction.op))
    .map((instruction) => ({ ...instruction }))]));
  const used = new Set(ssa.blocks.flatMap((block) => [
    ...block.phis.flatMap((phi) => [phi.dest, ...phi.inputs.map((input) => input.name)]),
    ...block.instructions.flatMap((instruction) => [
      ...referencedVariables(instruction), ...('dest' in instruction ? [instruction.dest] : []),
    ]),
  ]));
  let tempIndex = 0, edgeIndex = 0;
  const fresh = () => {
    let name: string;
    do { name = `__phi_tmp${tempIndex++}`; } while (used.has(name));
    used.add(name);
    return name;
  };
  const record = (frame: OutSsaFrame) => {
    if (result.frames.length < MAX_TRACE) result.frames.push(frame);
    else result.traceTruncated = true;
  };
  record({ kind: 'initial', block: dominance.entry,
    message: '先按前驱边收集全部 φ 的并行复制，再选择落点、调度复制并重建普通 IR。此时尚未运行转换结果。' });
  for (const block of ssa.blocks) {
    if (!block.phis.length) continue;
    const predecessors = [...new Set(edges.filter((edge) => edge.to === block.id).map((edge) => edge.from))];
    for (const from of predecessors) {
      const copies = block.phis.map((phi) => ({ dest: phi.dest,
        source: phi.inputs.find((input) => input.predecessor === from)!.name }));
      const schedule = scheduleParallelCopies(copies, fresh);
      const outgoing = edges.filter((edge) => edge.from === from);
      const incoming = edges.filter((edge) => edge.from === from && edge.to === block.id);
      const placement: EdgeCopyPlan['placement'] = outgoing.length === 1 ? 'predecessor'
        : predecessors.length === 1 ? 'successor' : 'split';
      let host = placement === 'predecessor' ? from : block.id;
      if (placement === 'split') {
        do { host = `E${edgeIndex++}`; } while (bodies.has(host));
        bodies.set(host, []);
        for (const edge of rewritten.filter((edge) => incoming.some((original) => original.id === edge.id)))
          edge.to = host;
        rewritten.push({ id: `${host}-next-${block.id}`, from: host, to: block.id, kind: 'next' });
      }
      const plan: EdgeCopyPlan = { from, to: block.id, edgeIds: incoming.map((edge) => edge.id),
        placement, host, copies, ...schedule };
      const planIndex = result.plans.push(plan) - 1;
      record({ kind: 'edge', block: host, plan: planIndex, message: placement === 'split'
        ? `${from} 有多个后继，${block.id} 有多个前驱：拆分关键边为 ${from} → ${host} → ${block.id}，复制只在这条路径执行。`
        : placement === 'predecessor' ? `${from} 只有一条后继边，将复制放在 ${from} 的普通指令之后、跳转之前。`
          : `${block.id} 只有一个前驱，将复制放在 ${block.id} 的入口。` });
      schedule.steps.forEach((step, index) => record({ kind: 'copy', block: host,
        plan: planIndex, copyStep: index, message: step.message }));
      const moves: Instruction[] = schedule.moves.map((copy) => ({ op: 'move', dest: copy.dest,
        value: { kind: 'ref', name: copy.source }, nodeId: -1 }));
      bodies.set(host, placement === 'successor' ? [...moves, ...bodies.get(host)!] : [...bodies.get(host)!, ...moves]);
    }
  }
  result.edges = rewritten;
  const label = (id: string) => `__out_${id}`;
  let halt = '__out_halt';
  while ([...bodies.keys()].some((id) => label(id) === halt)) halt += '_';
  for (const [id, body] of bodies) {
    const successors = rewritten.filter((edge) => edge.from === id);
    const code: Instruction[] = [{ op: 'label', name: label(id), nodeId: -1 }, ...body];
    if (successors.length === 2) {
      const branch = byId.get(id)?.instructions.at(-1);
      const yes = successors.find((edge) => edge.kind === 'true');
      const no = successors.find((edge) => edge.kind === 'false');
      if (branch?.op !== 'branch' || !yes || !no) return fail(`${id} 的条件跳转与 CFG 不一致。`);
      code.push({ ...branch, target: label(no.to) }, { op: 'jump', target: label(yes.to), nodeId: branch.nodeId });
    } else if (successors.length <= 1) {
      if (byId.get(id)?.instructions.at(-1)?.op === 'branch') return fail(`${id} 的条件跳转缺少完整的真/假边。`);
      code.push({ op: 'jump', target: successors.length ? label(successors[0].to) : halt, nodeId: -1 });
    } else return fail(`${id} 有超过两条后继边，超出当前 IR 范围。`);
    result.blocks.push({ id, instructions: code, original: byId.has(id) });
    result.instructions.push(...code);
    result.instructionBlocks.push(...code.map(() => id));
    if (result.instructions.length > MAX_IR) return fail('SSA 消除后的 IR 超过 10000 条，停止生成和执行。');
  }
  result.instructions.push({ op: 'label', name: halt, nodeId: -1 });
  result.instructionBlocks.push('HALT');
  if (result.instructions.length > MAX_IR) return fail('SSA 消除后的 IR 超过 10000 条，停止生成和执行。');
  result.bytecode = generateBytecode(result.instructions);
  result.valid = true;
  result.frames.push({ kind: 'ready', block: dominance.entry,
    message: `φ 已全部替换为普通复制：${result.plans.length} 组边复制，${result.blocks.filter((block) => !block.original).length} 个新边块。现在交给现有字节码生成器与栈式 VM。` });
  result.execution = execute(result.bytecode);
  const executedBlock = (pc: number) => pc < 0 ? dominance.entry
    : result.instructionBlocks[result.bytecode![pc]?.irIndex ?? -1] || 'HALT';
  result.visitedBlocks = [...new Set(result.execution.steps.flatMap((step) => {
    const index = result.bytecode![step.pc]?.irIndex;
    return index === undefined ? [] : [result.instructionBlocks[index] || 'HALT'];
  }))];
  result.execution.steps.slice(0, MAX_TRACE).forEach((step, index) => result.frames.push({ kind: 'execute',
    block: executedBlock(step.pc),
    vmStep: index, message: step.message }));
  if (result.execution.steps.length > MAX_TRACE) result.traceTruncated = true;
  result.frames.push({ kind: 'complete', block: executedBlock(result.execution.steps.at(-1)!.pc),
    vmStep: result.execution.steps.length - 1,
    message: result.execution.limited ? '转换后 VM 达到 2000 条字节码上限；只保留输出前缀，不能判定行为一致。'
      : result.execution.error ? `转换后 VM 停止：${result.execution.error.message}`
        : '转换后的普通 IR 已由原栈式 VM 执行结束；保留版本名，但 φ 目标现在可以在不同前驱边上被写入。' });
  return result;
}

export function compareVmExecutions(left: Execution, right: Execution): 'same' | 'different' | 'unknown' {
  if (left.limited || right.limited) return 'unknown';
  return left.halted === right.halted && left.error?.message === right.error?.message &&
    left.output.length === right.output.length && left.output.every((value, index) => Object.is(value, right.output[index]))
    ? 'same' : 'different';
}

export interface CopyExperiment {
  copies: ParallelCopy[];
  schedule: CopySchedule;
  rows: { name: string; initial?: number; parallel?: number; naive?: number; scheduled?: number }[];
  naiveCorrect: boolean;
  scheduledCorrect: boolean;
}
export type CopyOutcome = { ok: true; experiment: CopyExperiment } | { ok: false; issue: string };
export function analyzeCopyExperiment(text: string): CopyOutcome {
  if (text.length > 500) return { ok: false, issue: '并行复制实验最多 500 字符。' };
  const sections = text.split(/^%%\s*$/m);
  if (sections.length !== 2) return { ok: false, issue: '用单独一行 %% 分隔复制和初始值。' };
  const copies: ParallelCopy[] = [];
  const initial = new Map<string, number>();
  const name = '[A-Za-z_][A-Za-z0-9_]{0,23}';
  for (const line of sections[0].split('\n').filter((line) => line.trim())) {
    const match = line.trim().match(new RegExp(`^(${name})\\s*(?:<-|←)\\s*(${name})$`));
    if (!match) return { ok: false, issue: '复制写成 a <- b，每行一条，名字最多 24 字符。' };
    copies.push({ dest: match[1], source: match[2] });
  }
  if (!copies.length || copies.length > 12) return { ok: false, issue: '需要 1–12 条并行复制。' };
  for (const line of sections[1].split('\n').filter((line) => line.trim())) {
    const match = line.trim().match(new RegExp(`^(${name})\\s*=\\s*(-?\\d+)$`));
    if (!match || !Number.isSafeInteger(Number(match[2]))) return { ok: false, issue: '初始值写成 a = 1，数值必须是安全整数。' };
    if (initial.has(match[1])) return { ok: false, issue: '每个初始名字只能出现一次。' };
    initial.set(match[1], Number(match[2]));
  }
  if (initial.size > 24) return { ok: false, issue: '最多 24 个初始名字。' };
  if (copies.some((copy) => !initial.has(copy.source))) return { ok: false, issue: '每个复制源都需要初始值。' };
  try {
    const schedule = scheduleParallelCopies(copies);
    const parallel = new Map(initial), naive = new Map(initial), scheduled = new Map(initial);
    copies.forEach((copy) => parallel.set(copy.dest, initial.get(copy.source)!));
    copies.forEach((copy) => naive.set(copy.dest, naive.get(copy.source)!));
    schedule.moves.forEach((copy) => scheduled.set(copy.dest, scheduled.get(copy.source)!));
    const names = [...new Set([...initial.keys(), ...copies.map((copy) => copy.dest)])];
    const rows = names.map((name) => ({ name, initial: initial.get(name), parallel: parallel.get(name), naive: naive.get(name), scheduled: scheduled.get(name) }));
    return { ok: true, experiment: { copies, schedule, rows,
      naiveCorrect: rows.every((row) => Object.is(row.parallel, row.naive)),
      scheduledCorrect: rows.every((row) => Object.is(row.parallel, row.scheduled)) } };
  } catch (error) {
    return { ok: false, issue: error instanceof Error ? error.message : String(error) };
  }
}
