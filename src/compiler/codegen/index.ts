import type { Instruction } from '../model';
import type { Execution } from '../vm';
import { buildCFG } from '../cfg';
import { analyzeDominance } from '../dominance';
import { compareExecutions } from '../regalloc';
import { selectInstructions, ruleText, type Selection, type Strategy } from './select';
import {
  allocateMachine, layoutFrame, POOLS, poolNames,
  type CodegenRound, type ColoringEvent, type FrameLayout, type RegisterPool,
} from './allocate';
import { instructionText, runX64, CALLER_SAVED, type MInst, type Reg64, type X64Execution } from './x64';

export type IrSource = 'raw' | 'optimized';
export interface CodegenSettings { pool: RegisterPool; input: IrSource }
export const defaultCodegenSettings: CodegenSettings = { pool: 'full', input: 'raw' };
export const inputNames: Record<IrSource, string> = { raw: '原始 IR', optimized: '实验 05 优化后的 IR' };
export const strategyNames: Record<Strategy, string> = { tile: '树覆盖', macro: '逐条模板' };
export { poolNames, POOLS };
export function normalizeCodegenSettings(pool: unknown, input: unknown): CodegenSettings {
  return {
    pool: pool === 'tight' || pool === 'full' ? pool : defaultCodegenSettings.pool,
    input: input === 'optimized' || input === 'raw' ? input : defaultCodegenSettings.input,
  };
}

export type CodegenFrame =
  | { kind: 'input'; message: string }
  | { kind: 'select'; decision: number; message: string }
  | { kind: 'constraints'; round: number; message: string }
  | { kind: 'event'; round: number; event: number; message: string }
  | { kind: 'rewrite'; round: number; message: string }
  | { kind: 'layout'; message: string }
  | { kind: 'execute'; step: number; message: string }
  | { kind: 'complete'; step?: number; message: string };
export interface CodegenStats {
  instructions: number;
  checks: number;
  spill: number;
  frame: number;
  copies: number;
}
export interface CodegenRun {
  settings: CodegenSettings;
  strategy: Strategy;
  ir: Instruction[];
  selection: Selection;
  rounds: CodegenRound[];
  slots: Record<string, number>;
  assignment: Record<string, Reg64>;
  checkIssues: string[];
  issues: string[];
  valid: boolean;
  layout?: FrameLayout;
  program: MInst[];
  removedMoves: number;
  stats?: CodegenStats;
  execution?: X64Execution;
  outcome?: 'same' | 'different' | 'unknown';
  frames: CodegenFrame[];
  traceTruncated: boolean;
}
const MAX_FRAMES = 420;
const MAX_IR = 4000;

export function countStats(program: MInst[]): CodegenStats {
  const real = program.filter((instruction) => instruction.op !== 'label');
  const role = (name: MInst['role']) => real.filter((instruction) => instruction.role === name).length;
  return { instructions: real.length, checks: role('check'), spill: role('spill'), frame: role('frame'), copies: role('copy') };
}

function eventMessage(event: ColoringEvent, pool: Reg64[], costs: Record<string, number>, acrossCall: Set<string>): string {
  const K = pool.length;
  switch (event.kind) {
    case 'simplify':
      return `${event.node} 只受 ${event.degree} 个约束（未移出的邻居 + 已占用的预着色寄存器），少于可分配的 ${K} 个，先压栈。`;
    case 'potential':
      return `剩下的值约束都 ≥ ${K}。选“溢出代价 / 约束数”最小的 ${event.node}（代价 ${costs[event.node]}）作为可能溢出压栈。`;
    case 'select': {
      const blocked = event.blocked.length ? event.blocked.join(', ') : '无';
      const call = acrossCall.has(event.node) ? '它在某次 call 之后仍要用，所有 caller-saved 寄存器都被调用破坏，只剩 callee-saved。' : '';
      if (event.reason === 'spill') return `弹出 ${event.node}：${call}被占用 ${blocked}，没有可用寄存器，溢出到栈槽。`;
      if (event.reason === 'bias') return `弹出 ${event.node}：和 ${event.partner} 之间有一条 mov，${event.register} 未被占用，选同一个寄存器，这条 mov 之后变成自身复制而删掉。`;
      if (event.reason === 'callee') return `弹出 ${event.node}：${call}被占用 ${blocked}，分到 callee-saved 的 ${event.register}；序曲要先 push 保存，尾声再 pop 恢复。`;
      return `弹出 ${event.node}：被占用 ${blocked}，按顺序分到 caller-saved 的 ${event.register}。`;
    }
  }
}

export function generateCode(ir: Instruction[], requested: CodegenSettings, strategy: Strategy,
  baseline?: Pick<Execution, 'output' | 'halted' | 'limited' | 'error'>, settings: { record?: boolean } = {}): CodegenRun {
  const record = settings.record ?? true;
  const options = normalizeCodegenSettings(requested.pool, requested.input);
  const pool = POOLS[options.pool];
  const run: CodegenRun = { settings: options, strategy, ir, selection: { strategy, code: [], decisions: [], types: {}, inlined: [], issues: [] },
    rounds: [], slots: {}, assignment: {}, checkIssues: [], issues: [], valid: false, program: [], removedMoves: 0, frames: [], traceTruncated: false };
  const push = (frame: CodegenFrame) => {
    if (!record) return;
    if (run.frames.length < MAX_FRAMES) run.frames.push(frame);
    else run.traceTruncated = true;
  };
  const fail = (message: string) => {
    run.issues.push(message);
    if (record) run.frames.push({ kind: 'complete', message });
    return run;
  };
  if (ir.length > MAX_IR) return fail(`IR 超过 ${MAX_IR} 条，不生成机器代码。`);
  const graph = buildCFG(ir);
  const dominance = analyzeDominance(graph);
  const depthOf = ir.map((_, index) => dominance.converged
    ? dominance.loops.filter((loop) => loop.nodes.includes(graph.instructionBlock[index])).length : 0);
  const depth = (origin: number) => (origin >= 0 ? depthOf[origin] ?? 0 : 0);
  push({ kind: 'input', message: `输入是${inputNames[options.input]}，共 ${ir.length} 条三地址指令。${strategy === 'tile'
    ? '树覆盖先把只用一次、就在同一块里被用到的临时值接回它的使用处，得到表达式树；再从树根开始，每次选能盖住最多节点的 x86 模式（最大吞进，maximal munch）。'
    : '逐条模板不看相邻指令：每条三地址指令按固定模板展开，作为对照基线。'}` });
  run.selection = selectInstructions(ir, strategy);
  if (run.selection.issues.length) return fail(run.selection.issues.join(' '));
  run.selection.decisions.forEach((decision, index) => {
    const count = decision.end - decision.start;
    push({ kind: 'select', decision: index, message: `${decision.tree}：${decision.rules.length ? decision.rules.map(ruleText).join('、') : '不产生指令'}${count ? `，产生 ${count} 条虚拟寄存器指令` : ''}。` });
  });
  const allocation = allocateMachine(run.selection.code, pool, depth);
  run.rounds = allocation.rounds;
  run.slots = allocation.slots;
  run.assignment = allocation.assignment;
  run.checkIssues = allocation.checkIssues;
  for (const round of allocation.rounds) {
    const across = new Set(round.graph.acrossCall);
    const calls = round.code.filter((instruction) => instruction.op === 'call' && instruction.target !== '__mc_trap').length;
    push({ kind: 'constraints', round: round.index, message: round.index === 0
      ? `开始分配：可分配 ${pool.length} 个寄存器（${pool.join(' ')}）。预着色约束：cqo / idiv 固定读写 rax、rdx；传参固定用 rdi；${calls} 次 call 会破坏全部 caller-saved 寄存器（${CALLER_SAVED.join(' ')}）。${across.size ? `跨调用仍活跃的值：${[...across].join(', ')}。` : '没有值跨调用活跃。'}`
      : `第 ${round.index + 1} 轮：溢出代码改变了程序，重新求活跃性与冲突。现在共 ${round.code.length} 条。` });
    round.events.forEach((event, index) => push({ kind: 'event', round: round.index, event: index, message: eventMessage(event, pool, round.costs, across) }));
    if (round.spilled.length)
      push({ kind: 'rewrite', round: round.index, message: `真正溢出 ${round.spilled.join(', ')}：每次读取前从栈槽 mov 回来，每次写入后存回栈槽；新的 x~n 只活一两条指令，标为不可再溢出，然后重新分析。` });
  }
  if (!allocation.valid) return fail(allocation.issues.join(' '));
  const slotCount = Object.keys(allocation.slots).length;
  const { program, removedMoves, layout } = layoutFrame(allocation.finalVirtual, allocation.assignment, slotCount);
  run.program = program;
  run.removedMoves = removedMoves;
  run.layout = layout;
  run.stats = countStats(program);
  run.valid = true;
  push({ kind: 'layout', message: `布局栈帧：push rbp 后 rsp 对齐 16 字节；${layout.calleeSaved.length ? `用到 callee-saved ${layout.calleeSaved.join(', ')}，序曲 push、尾声 pop；` : '没有用到 callee-saved 寄存器；'}${slotCount ? `${slotCount} 个栈槽` : '没有栈槽'}${layout.padding ? '，再补 8 字节使 call 时 rsp 仍按 16 对齐' : ''}。${removedMoves ? `${removedMoves} 条 mov 两端是同一寄存器，已删除。` : ''}共 ${run.stats.instructions} 条指令，其中安全检查 ${run.stats.checks} 条。` });
  run.execution = runX64(program, { record });
  if (baseline) run.outcome = compareExecutions(baseline, run.execution);
  if (record) {
    run.execution.steps.forEach((step, index) => push({ kind: 'execute', step: index, message: step.message }));
    const execution = run.execution;
    if (execution.traceTruncated) run.traceTruncated = true;
    run.frames.push({ kind: 'complete', step: execution.steps.length - 1, message: execution.fault
      ? `模拟器发现机器级错误：${execution.fault} 这说明生成的代码有问题，不是源程序的运行时错误。`
      : execution.limited ? `执行达到 ${execution.executed} 条机器指令的上限；只保留输出前缀，不能判定行为一致。`
        : execution.error ? `运行时报告错误并终止：${execution.error.message} 共执行 ${execution.executed} 条机器指令。`
          : `ret 返回调用者，callee-saved 寄存器和 rsp 都已恢复。共执行 ${execution.executed} 条机器指令，${execution.calls} 次 call，${execution.loads + execution.stores} 次栈访问。` });
  }
  return run;
}

export interface CodegenSweepRow {
  input: IrSource;
  pool: RegisterPool;
  strategy: Strategy;
  valid: boolean;
  instructions: number;
  checks: number;
  spilled: number;
  calleeSaved: number;
  executed: number;
  memory: number;
  outcome: 'same' | 'different' | 'unknown' | 'failed';
}
export function sweepCodegen(irs: Record<IrSource, Instruction[]>, baseline: Pick<Execution, 'output' | 'halted' | 'limited' | 'error'>): CodegenSweepRow[] {
  const rows: CodegenSweepRow[] = [];
  for (const input of ['raw', 'optimized'] as const)
    for (const pool of ['full', 'tight'] as const)
      for (const strategy of ['tile', 'macro'] as const) {
        const run = generateCode(irs[input], { pool, input }, strategy, baseline, { record: false });
        const execution = run.execution;
        rows.push({ input, pool, strategy, valid: run.valid, instructions: run.stats?.instructions ?? 0, checks: run.stats?.checks ?? 0,
          spilled: Object.keys(run.slots).length, calleeSaved: run.layout?.calleeSaved.length ?? 0,
          executed: execution?.executed ?? 0, memory: execution ? execution.loads + execution.stores : 0,
          outcome: !run.valid || !execution ? 'failed' : run.outcome ?? 'unknown' });
      }
  return rows;
}

/** A complete GNU as file (Intel syntax) for x86-64 Linux; link it with the runtime shown in the lesson. */
export function assemblyFile(program: MInst[]): string {
  const lines = ['    .intel_syntax noprefix', '    .text', '    .globl main', 'main:'];
  for (const instruction of program)
    lines.push(instruction.op === 'label' ? `${instruction.name}:` : `    ${instructionText(instruction)}`);
  return `${lines.join('\n')}\n    .section .note.GNU-stack,"",@progbits\n`;
}
