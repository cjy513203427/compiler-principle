import { useEffect, useRef, useState } from 'react';
import type { Compilation } from '../compiler';
import { instructionText as irText } from '../compiler/ir';
import {
  assemblyFile, inputNames, poolNames, strategyNames,
  type CodegenRun, type CodegenSettings,
} from '../compiler/codegen';
import { ruleText } from '../compiler/codegen/select';
import { instructionText, REGISTERS, CALLER_SAVED, CALLEE_SAVED, MAX_SAFE, defs, uses, regKey, type MInst, type X64Step } from '../compiler/codegen/x64';
import { POOLS } from '../compiler/codegen/allocate';
import { CODEGEN_RUNTIME } from '../content/codegen';
import { T } from '../i18n';
import { Tx } from '../i18n/jsx';
import { CodeBlock } from './CodeBlock';
import '../styles-codegen.css';

export function CodegenSettingsFieldset({ settings, onChange }: {
  settings: CodegenSettings; onChange: (next: CodegenSettings) => void;
}) {
  return (
    <fieldset className="optimization-options codegen-settings">
      <legend>{T('代码生成设置')}</legend>
      <div role="radiogroup" aria-label={T('可分配寄存器')} className="codegen-choices">
        <span>{T('可分配寄存器')}</span>
        {(['full', 'tight'] as const).map((pool) => (
          <label key={pool}>
            <input type="radio" name="codegen-pool" checked={settings.pool === pool} onChange={() => onChange({ ...settings, pool })} />
            {poolNames[pool]}
          </label>
        ))}
      </div>
      <div role="radiogroup" aria-label={T('输入的 IR')} className="codegen-choices">
        <span>{T('输入的 IR')}</span>
        {(['raw', 'optimized'] as const).map((input) => (
          <label key={input}>
            <input type="radio" name="codegen-input" checked={settings.input === input} onChange={() => onChange({ ...settings, input })} />
            {inputNames[input]}
          </label>
        ))}
      </div>
      <small>{T('切换后重新生成，回放从头开始。r11、rsp、rbp 不参与分配；优化后的 IR 使用实验 05 当前的三个开关。')}</small>
    </fieldset>
  );
}

const phaseName = (kind: 'input' | 'select' | 'constraints' | 'event' | 'rewrite' | 'layout' | 'execute' | 'complete') => ({
  input: T('读入 IR'), select: T('指令选择'), constraints: T('寄存器约束'), event: T('寄存器分配'), rewrite: T('溢出重写'),
  layout: T('栈帧布局'), execute: T('模拟执行'), complete: T('结果与核对'),
}[kind]);
const roleName = (role: MInst['role']) => ({
  compute: T('计算'), copy: T('复制'), check: T('检查'), abi: T('约定'), spill: T('溢出'), frame: T('帧'), control: T('控制'),
}[role]);
const outcomeLabel = (outcome: 'same' | 'different' | 'unknown' | 'failed') => ({
  same: T('一致'), different: T('不同'), unknown: T('超限'), failed: T('生成失败'),
}[outcome]);

function registerValue(reg: (typeof REGISTERS)[number], step: X64Step | undefined, run: CodegenRun) {
  const value = step?.registers[REGISTERS.indexOf(reg)];
  if (value === undefined) return '?';
  if (reg === 'rsp' || reg === 'rbp') return `0x${value.toString(16).toUpperCase()}`;
  // Callee-saved registers start with the caller's (arbitrary) values; show that instead of the number.
  if (CALLEE_SAVED.includes(reg) && value === run.execution?.steps[0]?.registers[REGISTERS.indexOf(reg)]) return T('调用者的值');
  return formatValue(value);
}
function formatValue(value: bigint | undefined) {
  if (value === undefined) return '?';
  if (value > MAX_SAFE || value < -MAX_SAFE) return `0x${BigInt.asUintN(64, value).toString(16).toUpperCase()}`;
  return String(value);
}

interface Row { kind: 'line'; index: number; text: string; instruction: MInst }
interface Fold { kind: 'fold'; indices: number[]; reloads: number }
/** Optionally collapse each run of check instructions into one row. */
function rows(code: MInst[], fold: boolean): (Row | Fold)[] {
  const result: (Row | Fold)[] = [];
  code.forEach((instruction, index) => {
    // Stack-slot reloads that only feed a check stay inside the folded group.
    const feedsCheck = instruction.role === 'spill' && result.at(-1)?.kind === 'fold' && code[index + 1]?.role === 'check';
    if (fold && (feedsCheck || (instruction.role === 'check' && instruction.op !== 'label'))) {
      const last = result.at(-1);
      if (last?.kind === 'fold') { last.indices.push(index); if (feedsCheck) last.reloads++; }
      else result.push({ kind: 'fold', indices: [index], reloads: 0 });
      return;
    }
    result.push({ kind: 'line', index, text: instruction.op === 'label' ? `${instruction.name}:` : `    ${instructionText(instruction)}`, instruction });
  });
  return result;
}

function Listing({ code, current, fold, label, showRole }: {
  code: MInst[]; current: Set<number>; fold: boolean; label: string; showRole?: boolean;
}) {
  const container = useRef<HTMLDivElement>(null);
  const first = Math.min(...current);
  useEffect(() => {
    const box = container.current;
    const row = box?.querySelector<HTMLElement>('.current');
    if (!box || !row) return;
    const top = row.offsetTop - box.offsetTop;
    if (top < box.scrollTop || top > box.scrollTop + box.clientHeight - row.clientHeight)
      box.scrollTop = Math.max(0, top - box.clientHeight / 3);
  }, [first, fold]);
  return (
    <div ref={container} className="code-rows codegen-listing" tabIndex={0} aria-label={label}>
      {rows(code, fold).map((row) => row.kind === 'fold' ? (
        <div key={`f${row.indices[0]}`} className={`code-row fold ${row.indices.some((i) => current.has(i)) ? 'current' : ''}`}>
          <span>{String(row.indices[0]).padStart(3, '0')}</span>
          <code>    ⋯ {row.reloads
            ? T('{#0} 条安全检查（含 {#1} 条栈槽读取）', row.indices.length - row.reloads, row.reloads)
            : T('{#0} 条安全检查', row.indices.length - row.reloads)}</code>
        </div>
      ) : (
        <div key={row.index} className={`code-row role-${row.instruction.role} ${current.has(row.index) ? 'current' : ''}`}>
          <span>{String(row.index).padStart(3, '0')}</span>
          <code>{row.text}</code>
          {showRole && row.instruction.op !== 'label' && <small>{roleName(row.instruction.role)}</small>}
        </div>
      ))}
    </div>
  );
}

function MachineState({ step, run }: { step?: X64Step; run: CodegenRun }) {
  const used = new Set([...Object.values(run.assignment), 'rsp', 'rbp', 'rdi', 'rax', 'r11']);
  return (
    <section className="codegen-card" aria-label={T('x86-64 机器状态')}>
      <h3>{T('寄存器、标志位与栈')}</h3>
      <div className="x64-registers">
        {REGISTERS.filter((reg) => used.has(reg)).map((reg) => (
          <div key={reg} className={`${CALLEE_SAVED.includes(reg) ? 'callee' : CALLER_SAVED.includes(reg) ? 'caller' : 'frame'} ${step?.written.includes(reg) ? 'written' : ''}`}>
            <span>{reg}</span>
            <b>{registerValue(reg, step, run)}</b>
            <small>{CALLEE_SAVED.includes(reg) ? 'callee-saved' : CALLER_SAVED.includes(reg) ? 'caller-saved' : T('栈指针')}</small>
          </div>
        ))}
      </div>
      <p className="x64-flags">
        {T('标志位：{#0}', step?.flags
          ? (['ZF', 'SF', 'OF', 'CF'] as const).map((flag) => `${flag}=${+step.flags![flag]}`).join('  ')
          : T('未知（尚未比较，或刚被调用 / 除法破坏）'))}
      </p>
      <div className="table-scroll" tabIndex={0} aria-label={T('栈内容，可横向滚动')}>
        <table className="x64-stack">
          <thead><tr><th>{T('位置')}</th><th>{T('内容')}</th></tr></thead>
          <tbody>
            <tr><td>{T('入口 rsp')}</td><td>{T('返回地址')}</td></tr>
            {(step?.stack ?? []).map((row) => (
              <tr key={row.offset} className={step?.memory?.offset === row.offset ? 'touched' : ''}>
                <td>{row.offset === 8 ? '[rbp]' : `[rbp − ${row.offset - 8}]`}</td>
                <td>{row.offset === 8 && row.value !== undefined ? T('0x{#0}（调用者的 rbp）', row.value.toString(16).toUpperCase()) : formatValue(row.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="regalloc-output"><strong>stdout</strong>
        <code>{step?.output.length ? step.output.slice(-30).map(String).join(', ') : T('等待 print…')}</code>
      </div>
    </section>
  );
}

export function CodegenView({ result, step }: { result: Compilation; step: number }) {
  const run = result.codegen!;
  const frame = run.frames[step];
  const [fold, setFold] = useState(true);
  const [exported, setExported] = useState(false);
  const decision = frame.kind === 'select' ? run.selection.decisions[frame.decision] : undefined;
  const round = frame.kind === 'constraints' || frame.kind === 'event' || frame.kind === 'rewrite' ? run.rounds[frame.round] : undefined;
  const event = frame.kind === 'event' && round ? round.events[frame.event] : undefined;
  const machineStep = frame.kind === 'execute' ? run.execution?.steps[frame.step]
    : frame.kind === 'complete' && frame.step !== undefined ? run.execution?.steps[frame.step] : undefined;
  const late = ['layout', 'execute', 'complete'].includes(frame.kind) && run.valid;
  const selectedLines = new Set(decision ? Array.from({ length: decision.end - decision.start }, (_, i) => decision.start + i) : []);
  const coveredIr = new Set(decision?.origins ?? []);
  const pcLines = new Set(machineStep && machineStep.pc >= 0 ? [machineStep.pc] : []);
  const focus = event?.node;
  // While coloring, mark every instruction that reads or writes the value being decided.
  const focusLines = new Set(round && focus ? round.code.flatMap((instruction, index) =>
    [...uses(instruction), ...defs(instruction)].some((reg) => regKey(reg) === focus) ? [index] : []) : []);
  // Replay coloring decisions up to this frame, so the table shows the state at this step.
  const tableRound = late ? run.rounds.at(-1) : round;
  const progress: Record<string, string> = {};
  if (late) {
    for (const [key, register] of Object.entries(run.assignment)) progress[key] = register;
    for (const [key, slot] of Object.entries(run.slots)) progress[key] = T('栈槽 {#0}', slot);
  } else if (round) {
    const seen = frame.kind === "event" ? round.events.slice(0, frame.event + 1) : frame.kind === "rewrite" ? round.events : [];
    for (const item of seen)
      progress[item.node] = item.kind !== "select" ? T('压栈，待着色') : item.register ?? T('溢出到栈');
  }
  const tableKeys = late
    ? [...Object.keys(run.assignment).filter((key) => !key.includes("~")), ...Object.keys(run.slots)].sort()
    : tableRound?.graph.nodes.filter((key) => !key.includes("~")) ?? [];
  return (
    <div className="codegen-view">
      <div className="codegen-status" role="status">
        <strong>{phaseName(frame.kind)}</strong>
        <span>{strategyNames[run.strategy]} · {poolNames[run.settings.pool]} · {inputNames[run.settings.input]}</span>
      </div>
      {run.issues.length > 0 && <p className="diagnostic" role="alert">{run.issues.join(' ')}</p>}

      <section className="codegen-card" aria-label={T('本步代码生成')}>
        <h3>{T('观察这一步')}</h3>
        <p>{frame.message}</p>
        {decision && (
          <>
            <p className="codegen-tree"><span>{T('表达式树')}</span><code>{decision.tree}</code></p>
            {decision.rules.length > 0 && (
              <ul className="codegen-rules" aria-label={T('选中的指令模式')}>
                {decision.rules.map((rule) => <li key={rule}>{ruleText(rule)}</li>)}
              </ul>
            )}
          </>
        )}
        {event?.kind === 'select' && event.blocked.length > 0 && <p>{Tx('已被占用：{#0}', <code>{event.blocked.join(', ')}</code>)}</p>}
        {frame.kind === 'constraints' && round && round.graph.acrossCall.length > 0 && (
          <p>{Tx('跨调用活跃（不能用 caller-saved）：{#0}', <code>{round.graph.acrossCall.join(', ')}</code>)}</p>
        )}
        {frame.kind === 'rewrite' && run.rounds[frame.round + 1] && (
          <details>
            <summary>{T('查看重写后的第 {#0} 轮输入', frame.round + 2)}</summary>
            <CodeBlock title={T('插入栈槽读写后的虚拟寄存器代码')} language="asm"
              code={run.rounds[frame.round + 1].code.map((item) => item.op === 'label' ? `${item.name}:` : `    ${instructionText(item)}`).join('\n')} />
          </details>
        )}
      </section>

      <label className="codegen-fold">
        <input type="checkbox" checked={fold} onChange={(change) => setFold(change.target.checked)} />
        {T('折叠安全检查（范围、溢出、除零）')}
      </label>

      {!late ? (
        <div className="codegen-columns">
          <div>
            <div className="view-label"><span>{T('三地址 IR')}</span><small>{inputNames[run.settings.input]}</small></div>
            <div className="code-rows codegen-listing" tabIndex={0} aria-label={T('输入的三地址代码')}>
              {run.ir.map((instruction, index) => (
                <div key={index} className={`code-row ${coveredIr.has(index) ? 'current' : ''}`}>
                  <span>{String(index).padStart(2, '0')}</span><code>{irText(instruction)}</code>
                </div>
              ))}
            </div>
          </div>
          <div>
            <div className="view-label"><span>{T('指令选择结果')}</span><small>{T('虚拟寄存器 %名字')}</small></div>
            <Listing code={round ? round.code : run.selection.code} current={focusLines.size ? focusLines : selectedLines} fold={fold} label={T('指令选择得到的虚拟寄存器代码')} showRole />
          </div>
        </div>
      ) : (
        <div>
          <div className="view-label"><span>{T('最终汇编 · Intel 语法')}</span><small>{run.stats ? T('{#0} 条 · 检查 {#1} · 溢出 {#2} · 帧 {#3}', run.stats.instructions, run.stats.checks, run.stats.spill, run.stats.frame) : ''}</small></div>
          <Listing code={run.program} current={pcLines} fold={fold} label={T('分配寄存器并布局栈帧后的 x86-64 汇编')} />
        </div>
      )}

      {tableRound && (
        <section className="codegen-card" aria-label={T('虚拟寄存器的分配')}>
          <h3>{late ? T('每个值最后去了哪里') : T('第 {#0} 轮着色', tableRound.index + 1)}</h3>
          <div className="table-scroll" tabIndex={0} aria-label={T('虚拟寄存器分配表，可横向滚动')}>
            <table className="codegen-table">
              <thead><tr><th>{T('值')}</th><th>{late ? T('结果') : T('到这一步')}</th><th>{T('约束')}</th></tr></thead>
              <tbody>
                {tableKeys.map((key) => {
                  const graph = [...run.rounds].reverse().find((item) => key in item.graph.adjacency)?.graph ?? tableRound.graph;
                  const fixed = (graph.adjacency[key] ?? []).filter((other) => POOLS[run.settings.pool].includes(other as never));
                  const across = run.rounds.some((item) => item.graph.acrossCall.includes(key));
                  return (
                    <tr key={key} className={focus === key ? "current" : ""}>
                      <td><code>{key}</code></td>
                      <td>{progress[key] ?? "—"}</td>
                      <td>{across && fixed.length ? T('跨调用 · 避开 {#0}', fixed.join(' ')) : across ? T('跨调用 · —') : fixed.length ? T('避开 {#0}', fixed.join(' ')) : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {(frame.kind === 'execute' || frame.kind === 'complete') && run.valid && <MachineState step={machineStep} run={run} />}

      {frame.kind === 'complete' && run.execution && result.baseline && (
        <section className="codegen-card codegen-equivalence" aria-label={T('代码生成行为核对')}>
          <h3>{run.execution.fault ? T('生成的代码有机器级错误')
            : run.outcome === 'unknown' ? T('达到上限，暂不能判定行为一致')
              : run.outcome === 'same' ? T('x86-64 模拟执行与原始 VM 的本次输出与错误一致') : T('发现行为差异')}</h3>
          <div className="table-scroll" tabIndex={0} aria-label={T('执行结果对照，可横向滚动')}><table>
            <thead><tr><th>{T('执行')}</th><th>{T('输出（最后 30 项）')}</th><th>{T('停止状态')}</th></tr></thead>
            <tbody>
              <tr><td>{T('原始 IR → 栈式 VM')}</td><td>{result.baseline.output.slice(-30).map(String).join(', ') || T('无')}</td><td>{result.baseline.error?.message || (result.baseline.limited ? T('达到上限') : T('正常结束'))}</td></tr>
              <tr><td>{T('x86-64 → 子集模拟器')}</td><td>{run.execution.output.slice(-30).map(String).join(', ') || T('无')}</td><td>{run.execution.error?.message || (run.execution.limited ? T('达到上限') : T('正常结束'))}</td></tr>
            </tbody>
          </table></div>
          {result.codegenSweep && (
            <>
              <h3>{T('换输入、换寄存器、换选择方式')}</h3>
              <div className="table-scroll" tabIndex={0} aria-label={T('不同设置的代码生成对照，可横向滚动')}>
                <table className="codegen-sweep">
                  <thead><tr><th>{T('输入')}</th><th>{T('寄存器')}</th><th>{T('选择')}</th><th>{T('静态指令')}</th><th>{T('其中检查')}</th><th>{T('溢出值')}</th><th>callee-saved</th><th>{T('执行指令')}</th><th>{T('栈访问')}</th><th>{T('核对')}</th></tr></thead>
                  <tbody>
                    {result.codegenSweep.map((row) => (
                      <tr key={`${row.input}${row.pool}${row.strategy}`}
                        className={row.input === run.settings.input && row.pool === run.settings.pool && row.strategy === run.strategy ? 'current' : ''}>
                        <td>{row.input === 'raw' ? T('原始') : T('优化后')}</td><td>{row.pool === 'full' ? T('13 个') : T('紧张')}</td><td>{strategyNames[row.strategy]}</td>
                        <td>{row.instructions}</td><td>{row.checks}</td><td>{row.spilled}</td><td>{row.calleeSaved}</td>
                        <td>{row.executed}</td><td>{row.memory}</td><td>{outcomeLabel(row.outcome)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          <p className="figure-caption">{T('两台机器的计步单位不同；本次一致不等于一般性的等价证明。结果来自本项目的 x86-64 子集模拟器，不是真实 CPU；指令条数和栈访问次数只是代价的近似。')}</p>
        </section>
      )}

      {late && (
        <details className="codegen-card" onToggle={(toggle) => setExported(toggle.currentTarget.open)}>
          <summary>{T('导出：完整的 .s 文件与运行时（可在 x86-64 Linux 上自行汇编）')}</summary>
          {exported && (
            <>
              <CodeBlock title="program.s" language="asm" code={assemblyFile(run.program)} />
              <CodeBlock title="runtime.c" language="c" code={CODEGEN_RUNTIME} />
              <CodeBlock title={T('终端')} language="shell" lineNumbers={false} code="gcc program.s runtime.c -o program && ./program" />
              <p className="figure-caption">{T('本页没有在本机用汇编器验证这两份文件；它们与页面上模拟执行的是同一份指令序列。')}</p>
            </>
          )}
        </details>
      )}
      {run.traceTruncated && <p className="figure-caption">{T('回放最多保留 420 步，模拟执行记录前 400 步；最后一步仍展示完整结果与核对。')}</p>}
    </div>
  );
}
