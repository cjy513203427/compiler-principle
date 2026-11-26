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
import { CodeBlock } from './CodeBlock';
import '../styles-codegen.css';

export function CodegenSettingsFieldset({ settings, onChange }: {
  settings: CodegenSettings; onChange: (next: CodegenSettings) => void;
}) {
  return (
    <fieldset className="optimization-options codegen-settings">
      <legend>代码生成设置</legend>
      <div role="radiogroup" aria-label="可分配寄存器" className="codegen-choices">
        <span>可分配寄存器</span>
        {(['full', 'tight'] as const).map((pool) => (
          <label key={pool}>
            <input type="radio" name="codegen-pool" checked={settings.pool === pool} onChange={() => onChange({ ...settings, pool })} />
            {poolNames[pool]}
          </label>
        ))}
      </div>
      <div role="radiogroup" aria-label="输入的 IR" className="codegen-choices">
        <span>输入的 IR</span>
        {(['raw', 'optimized'] as const).map((input) => (
          <label key={input}>
            <input type="radio" name="codegen-input" checked={settings.input === input} onChange={() => onChange({ ...settings, input })} />
            {inputNames[input]}
          </label>
        ))}
      </div>
      <small>切换后重新生成，回放从头开始。r11、rsp、rbp 不参与分配；优化后的 IR 使用实验 05 当前的三个开关。</small>
    </fieldset>
  );
}

const phaseNames = {
  input: '读入 IR', select: '指令选择', constraints: '寄存器约束', event: '寄存器分配', rewrite: '溢出重写',
  layout: '栈帧布局', execute: '模拟执行', complete: '结果与核对',
} as const;
const roleNames: Record<MInst['role'], string> = {
  compute: '计算', copy: '复制', check: '检查', abi: '约定', spill: '溢出', frame: '帧', control: '控制',
};
const outcomeText = { same: '一致', different: '不同', unknown: '超限', failed: '生成失败' } as const;

function registerValue(reg: (typeof REGISTERS)[number], step: X64Step | undefined, run: CodegenRun) {
  const value = step?.registers[REGISTERS.indexOf(reg)];
  if (value === undefined) return '?';
  if (reg === 'rsp' || reg === 'rbp') return `0x${value.toString(16).toUpperCase()}`;
  // Callee-saved registers start with the caller's (arbitrary) values; show that instead of the number.
  if (CALLEE_SAVED.includes(reg) && value === run.execution?.steps[0]?.registers[REGISTERS.indexOf(reg)]) return '调用者的值';
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
          <code>    ⋯ {row.indices.length - row.reloads} 条安全检查{row.reloads ? `（含 ${row.reloads} 条栈槽读取）` : ''}</code>
        </div>
      ) : (
        <div key={row.index} className={`code-row role-${row.instruction.role} ${current.has(row.index) ? 'current' : ''}`}>
          <span>{String(row.index).padStart(3, '0')}</span>
          <code>{row.text}</code>
          {showRole && row.instruction.op !== 'label' && <small>{roleNames[row.instruction.role]}</small>}
        </div>
      ))}
    </div>
  );
}

function MachineState({ step, run }: { step?: X64Step; run: CodegenRun }) {
  const used = new Set([...Object.values(run.assignment), 'rsp', 'rbp', 'rdi', 'rax', 'r11']);
  return (
    <section className="codegen-card" aria-label="x86-64 机器状态">
      <h3>寄存器、标志位与栈</h3>
      <div className="x64-registers">
        {REGISTERS.filter((reg) => used.has(reg)).map((reg) => (
          <div key={reg} className={`${CALLEE_SAVED.includes(reg) ? 'callee' : CALLER_SAVED.includes(reg) ? 'caller' : 'frame'} ${step?.written.includes(reg) ? 'written' : ''}`}>
            <span>{reg}</span>
            <b>{registerValue(reg, step, run)}</b>
            <small>{CALLEE_SAVED.includes(reg) ? 'callee-saved' : CALLER_SAVED.includes(reg) ? 'caller-saved' : '栈指针'}</small>
          </div>
        ))}
      </div>
      <p className="x64-flags">
        标志位：{step?.flags
          ? (['ZF', 'SF', 'OF', 'CF'] as const).map((flag) => `${flag}=${+step.flags![flag]}`).join('  ')
          : '未知（尚未比较，或刚被调用 / 除法破坏）'}
      </p>
      <div className="table-scroll" tabIndex={0} aria-label="栈内容，可横向滚动">
        <table className="x64-stack">
          <thead><tr><th>位置</th><th>内容</th></tr></thead>
          <tbody>
            <tr><td>入口 rsp</td><td>返回地址</td></tr>
            {(step?.stack ?? []).map((row) => (
              <tr key={row.offset} className={step?.memory?.offset === row.offset ? 'touched' : ''}>
                <td>{row.offset === 8 ? '[rbp]' : `[rbp − ${row.offset - 8}]`}</td>
                <td>{row.offset === 8 && row.value !== undefined ? `0x${row.value.toString(16).toUpperCase()}（调用者的 rbp）` : formatValue(row.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="regalloc-output"><strong>stdout</strong>
        <code>{step?.output.length ? step.output.slice(-30).map(String).join(', ') : '等待 print…'}</code>
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
    for (const [key, slot] of Object.entries(run.slots)) progress[key] = `栈槽 ${slot}`;
  } else if (round) {
    const seen = frame.kind === "event" ? round.events.slice(0, frame.event + 1) : frame.kind === "rewrite" ? round.events : [];
    for (const item of seen)
      progress[item.node] = item.kind !== "select" ? "压栈，待着色" : item.register ?? "溢出到栈";
  }
  const tableKeys = late
    ? [...Object.keys(run.assignment).filter((key) => !key.includes("~")), ...Object.keys(run.slots)].sort()
    : tableRound?.graph.nodes.filter((key) => !key.includes("~")) ?? [];
  return (
    <div className="codegen-view">
      <div className="codegen-status" role="status">
        <strong>{phaseNames[frame.kind]}</strong>
        <span>{strategyNames[run.strategy]} · {poolNames[run.settings.pool]} · {inputNames[run.settings.input]}</span>
      </div>
      {run.issues.length > 0 && <p className="diagnostic" role="alert">{run.issues.join(' ')}</p>}

      <section className="codegen-card" aria-label="本步代码生成">
        <h3>观察这一步</h3>
        <p>{frame.message}</p>
        {decision && (
          <>
            <p className="codegen-tree"><span>表达式树</span><code>{decision.tree}</code></p>
            {decision.rules.length > 0 && (
              <ul className="codegen-rules" aria-label="选中的指令模式">
                {decision.rules.map((rule) => <li key={rule}>{ruleText(rule)}</li>)}
              </ul>
            )}
          </>
        )}
        {event?.kind === 'select' && event.blocked.length > 0 && <p>已被占用：<code>{event.blocked.join(', ')}</code></p>}
        {frame.kind === 'constraints' && round && round.graph.acrossCall.length > 0 && (
          <p>跨调用活跃（不能用 caller-saved）：<code>{round.graph.acrossCall.join(', ')}</code></p>
        )}
        {frame.kind === 'rewrite' && run.rounds[frame.round + 1] && (
          <details>
            <summary>查看重写后的第 {frame.round + 2} 轮输入</summary>
            <CodeBlock title="插入栈槽读写后的虚拟寄存器代码" language="asm"
              code={run.rounds[frame.round + 1].code.map((item) => item.op === 'label' ? `${item.name}:` : `    ${instructionText(item)}`).join('\n')} />
          </details>
        )}
      </section>

      <label className="codegen-fold">
        <input type="checkbox" checked={fold} onChange={(change) => setFold(change.target.checked)} />
        折叠安全检查（范围、溢出、除零）
      </label>

      {!late ? (
        <div className="codegen-columns">
          <div>
            <div className="view-label"><span>三地址 IR</span><small>{inputNames[run.settings.input]}</small></div>
            <div className="code-rows codegen-listing" tabIndex={0} aria-label="输入的三地址代码">
              {run.ir.map((instruction, index) => (
                <div key={index} className={`code-row ${coveredIr.has(index) ? 'current' : ''}`}>
                  <span>{String(index).padStart(2, '0')}</span><code>{irText(instruction)}</code>
                </div>
              ))}
            </div>
          </div>
          <div>
            <div className="view-label"><span>指令选择结果</span><small>虚拟寄存器 %名字</small></div>
            <Listing code={round ? round.code : run.selection.code} current={focusLines.size ? focusLines : selectedLines} fold={fold} label="指令选择得到的虚拟寄存器代码" showRole />
          </div>
        </div>
      ) : (
        <div>
          <div className="view-label"><span>最终汇编 · Intel 语法</span><small>{run.stats ? `${run.stats.instructions} 条 · 检查 ${run.stats.checks} · 溢出 ${run.stats.spill} · 帧 ${run.stats.frame}` : ''}</small></div>
          <Listing code={run.program} current={pcLines} fold={fold} label="分配寄存器并布局栈帧后的 x86-64 汇编" />
        </div>
      )}

      {tableRound && (
        <section className="codegen-card" aria-label="虚拟寄存器的分配">
          <h3>{late ? "每个值最后去了哪里" : `第 ${tableRound.index + 1} 轮着色`}</h3>
          <div className="table-scroll" tabIndex={0} aria-label="虚拟寄存器分配表，可横向滚动">
            <table className="codegen-table">
              <thead><tr><th>值</th><th>{late ? "结果" : "到这一步"}</th><th>约束</th></tr></thead>
              <tbody>
                {tableKeys.map((key) => {
                  const graph = [...run.rounds].reverse().find((item) => key in item.graph.adjacency)?.graph ?? tableRound.graph;
                  const fixed = (graph.adjacency[key] ?? []).filter((other) => POOLS[run.settings.pool].includes(other as never));
                  const across = run.rounds.some((item) => item.graph.acrossCall.includes(key));
                  return (
                    <tr key={key} className={focus === key ? "current" : ""}>
                      <td><code>{key}</code></td>
                      <td>{progress[key] ?? "—"}</td>
                      <td>{across ? "跨调用 · " : ""}{fixed.length ? `避开 ${fixed.join(" ")}` : "—"}</td>
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
        <section className="codegen-card codegen-equivalence" aria-label="代码生成行为核对">
          <h3>{run.execution.fault ? '生成的代码有机器级错误'
            : run.outcome === 'unknown' ? '达到上限，暂不能判定行为一致'
              : run.outcome === 'same' ? 'x86-64 模拟执行与原始 VM 的本次输出与错误一致' : '发现行为差异'}</h3>
          <div className="table-scroll" tabIndex={0} aria-label="执行结果对照，可横向滚动"><table>
            <thead><tr><th>执行</th><th>输出（最后 30 项）</th><th>停止状态</th></tr></thead>
            <tbody>
              <tr><td>原始 IR → 栈式 VM</td><td>{result.baseline.output.slice(-30).map(String).join(', ') || '无'}</td><td>{result.baseline.error?.message || (result.baseline.limited ? '达到上限' : '正常结束')}</td></tr>
              <tr><td>x86-64 → 子集模拟器</td><td>{run.execution.output.slice(-30).map(String).join(', ') || '无'}</td><td>{run.execution.error?.message || (run.execution.limited ? '达到上限' : '正常结束')}</td></tr>
            </tbody>
          </table></div>
          {result.codegenSweep && (
            <>
              <h3>换输入、换寄存器、换选择方式</h3>
              <div className="table-scroll" tabIndex={0} aria-label="不同设置的代码生成对照，可横向滚动">
                <table className="codegen-sweep">
                  <thead><tr><th>输入</th><th>寄存器</th><th>选择</th><th>静态指令</th><th>其中检查</th><th>溢出值</th><th>callee-saved</th><th>执行指令</th><th>栈访问</th><th>核对</th></tr></thead>
                  <tbody>
                    {result.codegenSweep.map((row) => (
                      <tr key={`${row.input}${row.pool}${row.strategy}`}
                        className={row.input === run.settings.input && row.pool === run.settings.pool && row.strategy === run.strategy ? 'current' : ''}>
                        <td>{row.input === 'raw' ? '原始' : '优化后'}</td><td>{row.pool === 'full' ? '13 个' : '紧张'}</td><td>{strategyNames[row.strategy]}</td>
                        <td>{row.instructions}</td><td>{row.checks}</td><td>{row.spilled}</td><td>{row.calleeSaved}</td>
                        <td>{row.executed}</td><td>{row.memory}</td><td>{outcomeText[row.outcome]}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          <p className="figure-caption">两台机器的计步单位不同；本次一致不等于一般性的等价证明。结果来自本项目的 x86-64 子集模拟器，不是真实 CPU；指令条数和栈访问次数只是代价的近似。</p>
        </section>
      )}

      {late && (
        <details className="codegen-card" onToggle={(toggle) => setExported(toggle.currentTarget.open)}>
          <summary>导出：完整的 .s 文件与运行时（可在 x86-64 Linux 上自行汇编）</summary>
          {exported && (
            <>
              <CodeBlock title="program.s" language="asm" code={assemblyFile(run.program)} />
              <CodeBlock title="runtime.c" language="c" code={CODEGEN_RUNTIME} />
              <CodeBlock title="终端" language="shell" lineNumbers={false} code="gcc program.s runtime.c -o program && ./program" />
              <p className="figure-caption">本页没有在本机用汇编器验证这两份文件；它们与页面上模拟执行的是同一份指令序列。</p>
            </>
          )}
        </details>
      )}
      {run.traceTruncated && <p className="figure-caption">回放最多保留 420 步，模拟执行记录前 400 步；最后一步仍展示完整结果与核对。</p>}
    </div>
  );
}
