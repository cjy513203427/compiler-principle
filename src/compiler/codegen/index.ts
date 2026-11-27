import { T } from '../../i18n';
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
export const inputNames: Record<IrSource, string> = { raw: T('原始 IR'), optimized: T('实验 05 优化后的 IR') };
export const strategyNames: Record<Strategy, string> = { tile: T('树覆盖'), macro: T('逐条模板') };
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
      return T(
        '{#0} 只受 {#1} 个约束（未移出的邻居 + 已占用的预着色寄存器），少于可分配的 {#2} 个，先压栈。',
        event.node,
        event.degree,
        K,
      );
    case 'potential':
      return T(
        '剩下的值约束都 ≥ {#0}。选“溢出代价 / 约束数”最小的 {#1}（代价 {#2}）作为可能溢出压栈。',
        K,
        event.node,
        costs[event.node],
      );
    case 'select': {
      const blocked = event.blocked.length ? event.blocked.join(', ') : T('无');
      const across = acrossCall.has(event.node);
      if (event.reason === 'spill')
        return across
          ? T(
              '弹出 {#0}：它在某次 call 之后仍要用，所有 caller-saved 寄存器都被调用破坏，只剩 callee-saved。被占用 {#1}，没有可用寄存器，溢出到栈槽。',
              event.node,
              blocked,
            )
          : T('弹出 {#0}：被占用 {#1}，没有可用寄存器，溢出到栈槽。', event.node, blocked);
      if (event.reason === 'bias')
        return T(
          '弹出 {#0}：和 {#1} 之间有一条 mov，{#2} 未被占用，选同一个寄存器，这条 mov 之后变成自身复制而删掉。',
          event.node,
          event.partner,
          event.register,
        );
      if (event.reason === 'callee')
        return across
          ? T(
              '弹出 {#0}：它在某次 call 之后仍要用，所有 caller-saved 寄存器都被调用破坏，只剩 callee-saved。被占用 {#1}，分到 callee-saved 的 {#2}；序曲要先 push 保存，尾声再 pop 恢复。',
              event.node,
              blocked,
              event.register,
            )
          : T(
              '弹出 {#0}：被占用 {#1}，分到 callee-saved 的 {#2}；序曲要先 push 保存，尾声再 pop 恢复。',
              event.node,
              blocked,
              event.register,
            );
      return T(
        '弹出 {#0}：被占用 {#1}，按顺序分到 caller-saved 的 {#2}。',
        event.node,
        blocked,
        event.register,
      );
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
  if (ir.length > MAX_IR) return fail(T('IR 超过 {#0} 条，不生成机器代码。', MAX_IR));
  const graph = buildCFG(ir);
  const dominance = analyzeDominance(graph);
  const depthOf = ir.map((_, index) => dominance.converged
    ? dominance.loops.filter((loop) => loop.nodes.includes(graph.instructionBlock[index])).length : 0);
  const depth = (origin: number) => (origin >= 0 ? depthOf[origin] ?? 0 : 0);
  push({
    kind: 'input',
    message:
      strategy === 'tile'
        ? T(
            '输入是{#0}，共 {#1} 条三地址指令。树覆盖先把只用一次、就在同一块里被用到的临时值接回它的使用处，得到表达式树；再从树根开始，每次选能盖住最多节点的 x86 模式（最大吞进，maximal munch）。',
            inputNames[options.input],
            ir.length,
          )
        : T(
            '输入是{#0}，共 {#1} 条三地址指令。逐条模板不看相邻指令：每条三地址指令按固定模板展开，作为对照基线。',
            inputNames[options.input],
            ir.length,
          ),
  });
  run.selection = selectInstructions(ir, strategy);
  if (run.selection.issues.length) return fail(run.selection.issues.join(' '));
  run.selection.decisions.forEach((decision, index) => {
    const count = decision.end - decision.start;
    const rules = decision.rules.length
      ? decision.rules.map(ruleText).join(T('、'))
      : T('不产生指令');
    push({
      kind: 'select',
      decision: index,
      message: count
        ? T('{#0}：{#1}，产生 {#2} 条虚拟寄存器指令。', decision.tree, rules, count)
        : T('{#0}：{#1}。', decision.tree, rules),
    });
  });
  const allocation = allocateMachine(run.selection.code, pool, depth);
  run.rounds = allocation.rounds;
  run.slots = allocation.slots;
  run.assignment = allocation.assignment;
  run.checkIssues = allocation.checkIssues;
  for (const round of allocation.rounds) {
    const across = new Set(round.graph.acrossCall);
    const calls = round.code.filter((instruction) => instruction.op === 'call' && instruction.target !== '__mc_trap').length;
    push({
      kind: 'constraints',
      round: round.index,
      message:
        round.index === 0
          ? across.size
            ? T(
                '开始分配：可分配 {#0} 个寄存器（{#1}）。预着色约束：cqo / idiv 固定读写 rax、rdx；传参固定用 rdi；{#2} 次 call 会破坏全部 caller-saved 寄存器（{#3}）。跨调用仍活跃的值：{#4}。',
                pool.length,
                pool.join(' '),
                calls,
                CALLER_SAVED.join(' '),
                [...across].join(', '),
              )
            : T(
                '开始分配：可分配 {#0} 个寄存器（{#1}）。预着色约束：cqo / idiv 固定读写 rax、rdx；传参固定用 rdi；{#2} 次 call 会破坏全部 caller-saved 寄存器（{#3}）。没有值跨调用活跃。',
                pool.length,
                pool.join(' '),
                calls,
                CALLER_SAVED.join(' '),
              )
          : T(
              '第 {#0} 轮：溢出代码改变了程序，重新求活跃性与冲突。现在共 {#1} 条。',
              round.index + 1,
              round.code.length,
            ),
    });
    round.events.forEach((event, index) => push({ kind: 'event', round: round.index, event: index, message: eventMessage(event, pool, round.costs, across) }));
    if (round.spilled.length)
      push({
        kind: 'rewrite',
        round: round.index,
        message: T(
          '真正溢出 {#0}：每次读取前从栈槽 mov 回来，每次写入后存回栈槽；新的 x~n 只活一两条指令，标为不可再溢出，然后重新分析。',
          round.spilled.join(', '),
        ),
      });
  }
  if (!allocation.valid) return fail(allocation.issues.join(' '));
  const slotCount = Object.keys(allocation.slots).length;
  const { program, removedMoves, layout } = layoutFrame(allocation.finalVirtual, allocation.assignment, slotCount);
  run.program = program;
  run.removedMoves = removedMoves;
  run.layout = layout;
  run.stats = countStats(program);
  run.valid = true;
  const calleePart = layout.calleeSaved.length
    ? T('用到 callee-saved {#0}，序曲 push、尾声 pop', layout.calleeSaved.join(', '))
    : T('没有用到 callee-saved 寄存器');
  const slotPart = slotCount
    ? layout.padding
      ? T('{#0} 个栈槽，再补 8 字节使 call 时 rsp 仍按 16 对齐', slotCount)
      : T('{#0} 个栈槽', slotCount)
    : layout.padding
      ? T('没有栈槽，再补 8 字节使 call 时 rsp 仍按 16 对齐')
      : T('没有栈槽');
  push({
    kind: 'layout',
    message: removedMoves
      ? T(
          '布局栈帧：push rbp 后 rsp 对齐 16 字节；{#0}；{#1}。{#2} 条 mov 两端是同一寄存器，已删除。共 {#3} 条指令，其中安全检查 {#4} 条。',
          calleePart,
          slotPart,
          removedMoves,
          run.stats.instructions,
          run.stats.checks,
        )
      : T(
          '布局栈帧：push rbp 后 rsp 对齐 16 字节；{#0}；{#1}。共 {#2} 条指令，其中安全检查 {#3} 条。',
          calleePart,
          slotPart,
          run.stats.instructions,
          run.stats.checks,
        ),
  });
  run.execution = runX64(program, { record });
  if (baseline) run.outcome = compareExecutions(baseline, run.execution);
  if (record) {
    run.execution.steps.forEach((step, index) => push({ kind: 'execute', step: index, message: step.message }));
    const execution = run.execution;
    if (execution.traceTruncated) run.traceTruncated = true;
    run.frames.push({
      kind: 'complete',
      step: execution.steps.length - 1,
      message: execution.fault
        ? T(
            '模拟器发现机器级错误：{#0} 这说明生成的代码有问题，不是源程序的运行时错误。',
            execution.fault,
          )
        : execution.limited
          ? T(
              '执行达到 {#0} 条机器指令的上限；只保留输出前缀，不能判定行为一致。',
              execution.executed,
            )
          : execution.error
            ? T(
                '运行时报告错误并终止：{#0} 共执行 {#1} 条机器指令。',
                execution.error.message,
                execution.executed,
              )
            : T(
                'ret 返回调用者，callee-saved 寄存器和 rsp 都已恢复。共执行 {#0} 条机器指令，{#1} 次 call，{#2} 次栈访问。',
                execution.executed,
                execution.calls,
                execution.loads + execution.stores,
              ),
    });
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
