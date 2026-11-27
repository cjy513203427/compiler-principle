import { useState } from 'react';
import type { Compilation } from '../compiler';
import {
  algorithmNames, allocInstructionText, pointText, registerInstructionText, registerText, slotText,
  MIN_REGISTERS, MAX_REGISTERS, compareExecutions,
  type AllocationRound, type RegisterAllocation, type RegisterSettings,
} from '../compiler/regalloc';
import { T } from '../i18n';
import { Tx } from '../i18n/jsx';
import { CodeBlock } from './CodeBlock';
import '../styles-regalloc.css';

const valueText = (value: unknown) => (value === undefined ? '—' : String(value));

interface Snapshot {
  stack: string[];
  assignment: Record<string, number>;
  spilled: string[];
  active: string[];
  focus?: string;
}
/** Rebuild the allocator state after `event` by replaying the recorded decisions. */
function replay(round: AllocationRound, event: number): Snapshot {
  const snapshot: Snapshot = { stack: [], assignment: {}, spilled: [], active: [] };
  round.events.slice(0, event + 1).forEach((item) => {
    snapshot.focus = item.node;
    if (item.kind === 'simplify' || item.kind === 'potential') snapshot.stack.push(item.node);
    else if (item.kind === 'select') {
      snapshot.stack.pop();
      if (item.register === undefined) snapshot.spilled.push(item.node);
      else snapshot.assignment[item.node] = item.register;
    } else if (item.kind === 'assign') {
      snapshot.assignment[item.node] = item.register;
      snapshot.active.push(item.node);
    } else if (item.kind === 'expire') snapshot.active = snapshot.active.filter((name) => name !== item.node);
    else if (item.kind === 'spill') {
      snapshot.spilled.push(item.node);
      snapshot.active = snapshot.active.filter((name) => name !== item.node);
      delete snapshot.assignment[item.node];
      if (item.stolenBy) {
        snapshot.assignment[item.stolenBy] = item.register!;
        snapshot.active.push(item.stolenBy);
        snapshot.focus = item.stolenBy;
      }
    }
  });
  return snapshot;
}

export function RegisterSettingsFieldset({ settings, onChange, disabled }: {
  settings: RegisterSettings; onChange: (next: RegisterSettings) => void; disabled?: boolean;
}) {
  return (
    <fieldset className="optimization-options register-settings" disabled={disabled}>
      <legend>{T('寄存器设置')}</legend>
      <label>
        {T('寄存器个数 K')}
        <select aria-label={T('寄存器个数')} value={settings.count}
          onChange={(event) => onChange({ ...settings, count: Number(event.target.value) })}>
          {Array.from({ length: MAX_REGISTERS - MIN_REGISTERS + 1 }, (_, index) => MIN_REGISTERS + index)
            .map((count) => <option key={count} value={count}>{count}</option>)}
        </select>
      </label>
      <div role="radiogroup" aria-label={T('分配算法')} className="register-algorithms">
        {(['color', 'linear'] as const).map((algorithm) => (
          <label key={algorithm}>
            <input type="radio" name="register-algorithm" checked={settings.algorithm === algorithm}
              onChange={() => onChange({ ...settings, algorithm })} />
            {algorithmNames[algorithm]}
          </label>
        ))}
      </div>
      <small>{T('切换后重新分配，回放从头开始。两种算法都处理未优化的原始三地址代码。')}</small>
    </fieldset>
  );
}

function registerClass(register: number | undefined, spilled: boolean) {
  return spilled ? 'reg-spilled' : register === undefined ? 'reg-none' : `reg-${register}`;
}

function InterferenceFigure({ round, snapshot, showAll }: { round: AllocationRound; snapshot?: Snapshot; showAll: boolean }) {
  const nodes = round.graph.nodes;
  if (nodes.length > 40)
    return <p className="figure-caption">{T('本轮有 {#0} 个值，图过于拥挤，改用下方表格查看。', nodes.length)}</p>;
  const size = 360, center = size / 2, radius = nodes.length <= 1 ? 0 : 145;
  const position = new Map(nodes.map((name, index) => {
    const angle = (index / nodes.length) * Math.PI * 2 - Math.PI / 2;
    return [name, { x: center + radius * Math.cos(angle), y: center + radius * Math.sin(angle) }];
  }));
  const removed = new Set(snapshot?.stack ?? []);
  const assignment = showAll ? round.assignment : snapshot?.assignment ?? {};
  const spilled = new Set(showAll ? round.spilled : snapshot?.spilled ?? []);
  return (
    <div className="regalloc-graph-scroll" tabIndex={0} aria-label={T('干涉图，可在图内滚动')}>
      <svg viewBox={`0 0 ${size} ${size}`} role="img"
        aria-label={T('干涉图：{#0} 个值，{#1} 条边', nodes.length, round.graph.edges.length)}>
        {round.graph.edges.map(([a, b]) => {
          const from = position.get(a)!, to = position.get(b)!;
          const faded = removed.has(a) || removed.has(b);
          return <line key={`${a}|${b}`} x1={from.x} y1={from.y} x2={to.x} y2={to.y} className={faded ? 'edge faded' : 'edge'} />;
        })}
        {round.graph.moves.map(([a, b]) => {
          const from = position.get(a)!, to = position.get(b)!;
          return <line key={`m${a}|${b}`} x1={from.x} y1={from.y} x2={to.x} y2={to.y} className="move-edge" />;
        })}
        {nodes.map((name) => {
          const { x, y } = position.get(name)!;
          const register = assignment[name];
          const isSpilled = spilled.has(name);
          return (
            <g key={name} className={`node ${registerClass(register, isSpilled)} ${removed.has(name) ? 'on-stack' : ''} ${snapshot?.focus === name ? 'focus' : ''}`}>
              <circle cx={x} cy={y} r={27} />
              <text x={x} y={y - 3} textAnchor="middle">{name.length > 9 ? `${name.slice(0, 8)}…` : name}</text>
              <text x={x} y={y + 12} textAnchor="middle" className="node-reg">
                {isSpilled ? T('栈') : register === undefined ? (removed.has(name) ? T('栈中') : '') : registerText(register)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function IntervalFigure({ round, snapshot, showAll }: { round: AllocationRound; snapshot?: Snapshot; showAll: boolean }) {
  const intervals = round.intervals;
  const points = round.code.length * 2;
  const unit = 12, labelWidth = 92, row = 22;
  const width = labelWidth + points * unit + 12, height = intervals.length * row + 26;
  const assignment = showAll ? round.assignment : snapshot?.assignment ?? {};
  const spilled = new Set(showAll ? round.spilled : snapshot?.spilled ?? []);
  const active = new Set(snapshot?.active ?? []);
  return (
    <div className="regalloc-graph-scroll" tabIndex={0} aria-label={T('活跃区间图，可在图内滚动')}>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img"
        aria-label={T('活跃区间：{#0} 个', intervals.length)}>
        {Array.from({ length: round.code.length }, (_, index) => (
          <text key={index} x={labelWidth + index * 2 * unit + unit} y={12} textAnchor="middle" className="axis">
            {index % 2 === 0 ? `#${index}` : ''}
          </text>
        ))}
        {intervals.map((interval, index) => {
          const register = assignment[interval.name];
          const isSpilled = spilled.has(interval.name);
          const y = 20 + index * row;
          return (
            <g key={interval.name} className={`interval ${registerClass(register, isSpilled)} ${active.has(interval.name) ? 'active' : ''} ${snapshot?.focus === interval.name ? 'focus' : ''}`}>
              <text x={labelWidth - 6} y={y + 13} textAnchor="end">{interval.name.length > 12 ? `${interval.name.slice(0, 11)}…` : interval.name}</text>
              <rect x={labelWidth + interval.start * unit} y={y + 2} width={(interval.end - interval.start + 1) * unit} height={row - 6} rx={3} />
              <text x={labelWidth + interval.start * unit + 4} y={y + 13} className="bar-label">
                {isSpilled ? T('栈') : register === undefined ? '' : registerText(register)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function RoundTable({ round, allocation }: { round: AllocationRound; allocation: RegisterAllocation }) {
  const linear = allocation.settings.algorithm === 'linear';
  return (
    <div className="table-scroll" tabIndex={0} aria-label={T('本轮每个值的分配结果，可横向滚动')}>
      <table className="regalloc-table">
        <thead><tr><th>{T('值')}</th><th>{linear ? T('区间') : T('干涉邻居')}</th><th>{T('代价')}</th><th>{T('结果')}</th></tr></thead>
        <tbody>
          {round.graph.nodes.map((name) => {
            const interval = round.intervals.find((item) => item.name === name);
            return (
              <tr key={name}>
                <td><code>{name}</code>{round.unspillable.includes(name) && <small> {T('不可溢出')}</small>}</td>
                <td>{linear
                  ? interval ? `${pointText(interval.start)} – ${pointText(interval.end)}` : '—'
                  : round.graph.adjacency[name].join(', ') || T('无')}</td>
                <td>{round.costs[name]}</td>
                <td>{round.spilled.includes(name) ? T('溢出到栈') : name in round.assignment ? registerText(round.assignment[name]) : '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function RegallocView({ result, step }: { result: Compilation; step: number }) {
  const allocation = result.regalloc!;
  const frame = allocation.frames[step];
  const [allCode, setAllCode] = useState(false);
  const K = allocation.settings.count;
  const round = frame.round !== undefined && frame.round >= 0 ? allocation.rounds[frame.round] : undefined;
  const final = ['assigned', 'execute', 'complete'].includes(frame.kind) && allocation.valid;
  const snapshot = round && frame.kind === 'event' && frame.event !== undefined ? replay(round, frame.event) : undefined;
  const event = round && frame.event !== undefined ? round.events[frame.event] : undefined;
  const next = frame.kind === 'rewrite' && round ? allocation.rounds[round.index + 1] : undefined;
  const current = frame.vmStep !== undefined ? allocation.execution?.steps[frame.vmStep] : undefined;
  const instruction = current && current.pc >= 0 ? allocation.program[current.pc] : undefined;
  const memorySoFar = frame.vmStep === undefined ? undefined
    : allocation.execution!.steps.slice(0, frame.vmStep + 1).reduce((total, item) => total + (item.memory ? 1 : 0), 0);
  const comparison = allocation.execution && result.baseline ? compareExecutions(result.baseline, allocation.execution) : undefined;
  const byRegister = Array.from({ length: K }, (_, index) =>
    Object.entries(allocation.assignment).filter(([, register]) => register === index).map(([name]) => name));
  const color = allocation.settings.algorithm === 'color';
  return (
    <div className="regalloc-view">
      <div className="regalloc-status" role="status">
        <strong>
          {algorithmNames[allocation.settings.algorithm]} · K = {K}
          {round ? T(' · 第 {#0} 轮', round.index + 1) : ''}
        </strong>
        <span>{frame.kind === 'execute' ? T('寄存器机执行') : frame.kind === 'complete' ? T('结果与核对') : final ? T('分配完成') : T('分配中')}</span>
      </div>
      {allocation.issues.length > 0 && <p className="diagnostic" role="alert">{allocation.issues.join(' ')}</p>}

      <section className="regalloc-card" aria-label={T('本步寄存器分配')}>
        <h3>{T('观察这一步')}</h3>
        <p>{frame.message}</p>
        {frame.kind === 'liveness' && round && (
          <CodeBlock title={T('每条指令之后仍活跃的值（live-out）')} language="text"
            code={round.code.map((item, index) => `#${String(index).padEnd(3)} ${allocInstructionText(item.instruction).padEnd(26)} → ${round.liveness.liveOut[index].join(', ') || '∅'}`).join('\n')} />
        )}
        {snapshot && color && <p>{Tx('栈（从底到顶）：{#0}', <code>{snapshot.stack.join(' → ') || T('空')}</code>)}</p>}
        {snapshot && !color && <p>{Tx('正在占用寄存器的区间：{#0}', <code>{snapshot.active.map((name) => `${name}:${registerText(snapshot.assignment[name])}`).join(T('，')) || T('无')}</code>)}</p>}
        {event?.kind === 'select' && event.blocked.length > 0 && (
          <p>{Tx('邻居已占用：{#0}', <code>{event.blocked.map(registerText).join(', ')}</code>)}</p>
        )}
        {next && (
          <CodeBlock title={T('重写后的代码 / 第 {#0} 轮输入', next.index + 1)} language="text"
            code={next.code.map((item) => allocInstructionText(item.instruction)).join('\n')} />
        )}
      </section>

      {round && ['graph', 'event'].includes(frame.kind) && (
        <section className="regalloc-card" aria-label={color ? T('干涉图') : T('活跃区间')}>
          <h3>{color ? T('干涉图 / 第 {#0} 轮', round.index + 1) : T('活跃区间 / 第 {#0} 轮', round.index + 1)}</h3>
          {color ? <InterferenceFigure round={round} snapshot={snapshot} showAll={false} />
            : <IntervalFigure round={round} snapshot={snapshot} showAll={false} />}
          <p className="figure-caption">
            {color
              ? T('实线是干涉边，虚线连接复制两端。点内第二行是寄存器；“栈中”表示已移出、等待弹出着色，“栈”表示真正溢出。粗边框是本步处理的值。')
              : T('横轴是位置：“前 #i”在指令 i 读取之前，“后 #i”在它写入之后。条内文字是寄存器，“栈”表示溢出；粗边框是本步处理的区间。')}
          </p>
        </section>
      )}

      {final && (
        <>
          <section className="regalloc-card" aria-label={T('寄存器分配结果')}>
            <h3>{T('谁共用了同一个寄存器？')}</h3>
            <ul className="register-groups">
              {byRegister.map((names, index) => (
                <li key={index} className={`reg-${index}`}><strong>{registerText(index)}</strong><code>{names.join(', ') || T('未使用')}</code></li>
              ))}
              {Object.entries(allocation.slots).map(([name, slot]) => (
                <li key={name} className="reg-spilled"><strong>{slotText(slot)}</strong><code>{T('{#0}（溢出变量）', name)}</code></li>
              ))}
            </ul>
            <p>
              {T('独立核对：{#0}', allocation.checkIssues.length ? allocation.checkIssues.join(' ') : T('在最终代码上重新求活跃性，每次写入都没有覆盖此后仍要读取的值。'))}
              {' '}{T('静态插入 {#0} 条 load、{#1} 条 store；{#2} 条复制因两端同寄存器被删除。', allocation.staticLoads, allocation.staticStores, allocation.removedMoves)}
            </p>
            <div className="regalloc-columns">
              <CodeBlock title={T('分配前 / 含溢出代码的 IR')} language="text"
                code={allocation.finalCode.map((item) => allocInstructionText(item.instruction)).join('\n')} />
              <CodeBlock title={T('分配后 / {#0} 个寄存器', K)} language="text"
                code={allocation.program.map((item) => registerInstructionText(item)).join('\n') || T('// 空程序')} />
            </div>
            <details onToggle={(event) => setAllCode(event.currentTarget.open)}>
              <summary>{T('查看每一轮的分配表 / 共 {#0} 轮', allocation.rounds.length)}</summary>
              {allCode && allocation.rounds.map((item) => (
                <div key={item.index}>
                  <h4>{item.spilled.length ? T('第 {#0} 轮 · 溢出 {#1}', item.index + 1, item.spilled.join(', ')) : T('第 {#0} 轮 · 没有溢出', item.index + 1)}</h4>
                  <RoundTable round={item} allocation={allocation} />
                </div>
              ))}
            </details>
          </section>
        </>
      )}

      {final && <section className="regalloc-card regalloc-machine" aria-label={T('寄存器机当前状态')}>
        <h3>{T('寄存器机的真实状态')}</h3>
        <p>{current ? (instruction ? T('PC {#0} · {#1} ； {#2}', current.pc, registerInstructionText(instruction), instruction.comment) : current.message) : T('下一步开始执行：寄存器与栈槽都还没有写入。')}</p>
        <div className="register-file">
          {Array.from({ length: K }, (_, index) => (
            <div key={index} className={`reg-${index} ${current?.written === registerText(index) ? 'written' : ''}`} data-written-label={T('刚写入')}>
              <span>{registerText(index)}</span><b>{valueText(current?.registers[index])}</b>
            </div>
          ))}
          {Object.keys(allocation.slots).map((name) => {
            const slot = allocation.slots[name];
            return (
              <div key={name} className={`reg-spilled ${current?.written === slotText(slot) ? 'written' : ''}`} data-written-label={T('刚写入')}>
                <span>{slotText(slot)}</span><b>{valueText(current?.slots[slot])}</b>
              </div>
            );
          })}
        </div>
        <p>{current?.memory ? Tx('到这一步的内存访问：{#0} 次（本步：{#1}）', <code>{memorySoFar ?? 0}</code>, current.memory === 'load' ? T('读取') : T('写入')) : Tx('到这一步的内存访问：{#0} 次', <code>{memorySoFar ?? 0}</code>)}</p>
        <div className="regalloc-output"><strong>{frame.kind === 'complete' ? T('寄存器机最终输出') : T('回放到这里的输出')}</strong>
          <code>{current?.output.length ? current.output.slice(-30).map(String).join(', ') : T('等待 print…')}</code>
        </div>
      </section>}

      {frame.kind === 'complete' && allocation.execution && result.baseline && (
        <section className="regalloc-card regalloc-equivalence" aria-label={T('寄存器分配行为核对')}>
          <h3>{comparison === 'unknown' ? T('达到上限，暂不能判定行为一致')
            : comparison === 'same' ? T('寄存器机与原始 VM 的本次输出与错误一致') : T('发现行为差异')}</h3>
          <div className="table-scroll" tabIndex={0} aria-label={T('执行结果对照，可横向滚动')}><table>
            <thead><tr><th>{T('执行')}</th><th>{T('输出（最后 30 项）')}</th><th>{T('停止状态')}</th></tr></thead>
            <tbody>
              <tr><td>{T('原始 IR → 栈式 VM')}</td><td>{result.baseline.output.slice(-30).map(String).join(', ') || T('无')}</td><td>{result.baseline.error?.message || (result.baseline.limited ? T('达到上限') : T('正常结束'))}</td></tr>
              <tr><td>{T('分配后 → 寄存器机')}</td><td>{allocation.execution.output.slice(-30).map(String).join(', ') || T('无')}</td><td>{allocation.execution.error?.message || (allocation.execution.limited ? T('达到上限') : T('正常结束'))}</td></tr>
            </tbody>
          </table></div>
          {result.registerSweep && (
            <>
              <h3>{T('换一个 K、换一种算法')}</h3>
              <div className="table-scroll" tabIndex={0} aria-label={T('不同寄存器个数与算法的对照，可横向滚动')}>
                <table className="regalloc-sweep">
                  <thead><tr><th>K</th><th>{T('算法')}</th><th>{T('溢出值')}</th><th>{T('静态 load/store')}</th><th>{T('执行时内存访问')}</th><th>{T('执行指令')}</th><th>{T('核对')}</th></tr></thead>
                  <tbody>
                    {result.registerSweep.map((row) => (
                      <tr key={`${row.count}${row.algorithm}`}
                        className={row.count === K && row.algorithm === allocation.settings.algorithm ? 'current' : ''}>
                        <td>{row.count}</td><td>{algorithmNames[row.algorithm]}</td><td>{row.spilled}</td>
                        <td>{row.staticMemory}</td><td>{row.dynamicMemory}</td><td>{row.executed}</td>
                        <td>{{ same: T('一致'), different: T('不同'), unknown: T('超限'), failed: T('分配失败') }[row.outcome]}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          <p className="figure-caption">{T('两台机器的计步方式不同；本次一致不等于一般性的语义等价证明。内存访问次数只是代价的近似，不等于真实 CPU 的运行时间。')}</p>
        </section>
      )}
      {allocation.traceTruncated && <p className="figure-caption">{T('分配与执行回放各记录前 240 步；最后一步仍展示完整分配结果和最终状态。')}</p>}
    </div>
  );
}
