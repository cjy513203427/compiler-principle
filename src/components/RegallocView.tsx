import { useState } from 'react';
import type { Compilation } from '../compiler';
import {
  algorithmNames, allocInstructionText, pointText, registerInstructionText, registerText, slotText,
  MIN_REGISTERS, MAX_REGISTERS, compareExecutions,
  type AllocationRound, type RegisterAllocation, type RegisterSettings,
} from '../compiler/regalloc';
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
      <legend>寄存器设置</legend>
      <label>
        寄存器个数 K
        <select aria-label="寄存器个数" value={settings.count}
          onChange={(event) => onChange({ ...settings, count: Number(event.target.value) })}>
          {Array.from({ length: MAX_REGISTERS - MIN_REGISTERS + 1 }, (_, index) => MIN_REGISTERS + index)
            .map((count) => <option key={count} value={count}>{count}</option>)}
        </select>
      </label>
      <div role="radiogroup" aria-label="分配算法" className="register-algorithms">
        {(['color', 'linear'] as const).map((algorithm) => (
          <label key={algorithm}>
            <input type="radio" name="register-algorithm" checked={settings.algorithm === algorithm}
              onChange={() => onChange({ ...settings, algorithm })} />
            {algorithmNames[algorithm]}
          </label>
        ))}
      </div>
      <small>切换后重新分配，回放从头开始。两种算法都处理未优化的原始三地址代码。</small>
    </fieldset>
  );
}

function registerClass(register: number | undefined, spilled: boolean) {
  return spilled ? 'reg-spilled' : register === undefined ? 'reg-none' : `reg-${register}`;
}

function InterferenceFigure({ round, snapshot, showAll }: { round: AllocationRound; snapshot?: Snapshot; showAll: boolean }) {
  const nodes = round.graph.nodes;
  if (nodes.length > 40)
    return <p className="figure-caption">本轮有 {nodes.length} 个值，图过于拥挤，改用下方表格查看。</p>;
  const size = 360, center = size / 2, radius = nodes.length <= 1 ? 0 : 145;
  const position = new Map(nodes.map((name, index) => {
    const angle = (index / nodes.length) * Math.PI * 2 - Math.PI / 2;
    return [name, { x: center + radius * Math.cos(angle), y: center + radius * Math.sin(angle) }];
  }));
  const removed = new Set(snapshot?.stack ?? []);
  const assignment = showAll ? round.assignment : snapshot?.assignment ?? {};
  const spilled = new Set(showAll ? round.spilled : snapshot?.spilled ?? []);
  return (
    <div className="regalloc-graph-scroll" tabIndex={0} aria-label="干涉图，可在图内滚动">
      <svg viewBox={`0 0 ${size} ${size}`} role="img"
        aria-label={`干涉图：${nodes.length} 个值，${round.graph.edges.length} 条边`}>
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
                {isSpilled ? '栈' : register === undefined ? (removed.has(name) ? '栈中' : '') : registerText(register)}
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
    <div className="regalloc-graph-scroll" tabIndex={0} aria-label="活跃区间图，可在图内滚动">
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img"
        aria-label={`活跃区间：${intervals.length} 个`}>
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
                {isSpilled ? '栈' : register === undefined ? '' : registerText(register)}
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
    <div className="table-scroll" tabIndex={0} aria-label="本轮每个值的分配结果，可横向滚动">
      <table className="regalloc-table">
        <thead><tr><th>值</th><th>{linear ? '区间' : '干涉邻居'}</th><th>代价</th><th>结果</th></tr></thead>
        <tbody>
          {round.graph.nodes.map((name) => {
            const interval = round.intervals.find((item) => item.name === name);
            return (
              <tr key={name}>
                <td><code>{name}</code>{round.unspillable.includes(name) && <small> 不可溢出</small>}</td>
                <td>{linear
                  ? interval ? `${pointText(interval.start)} – ${pointText(interval.end)}` : '—'
                  : round.graph.adjacency[name].join(', ') || '无'}</td>
                <td>{round.costs[name]}</td>
                <td>{round.spilled.includes(name) ? '溢出到栈' : name in round.assignment ? registerText(round.assignment[name]) : '—'}</td>
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
          {round ? ` · 第 ${round.index + 1} 轮` : ''}
        </strong>
        <span>{frame.kind === 'execute' ? '寄存器机执行' : frame.kind === 'complete' ? '结果与核对' : final ? '分配完成' : '分配中'}</span>
      </div>
      {allocation.issues.length > 0 && <p className="diagnostic" role="alert">{allocation.issues.join(' ')}</p>}

      <section className="regalloc-card" aria-label="本步寄存器分配">
        <h3>观察这一步</h3>
        <p>{frame.message}</p>
        {frame.kind === 'liveness' && round && (
          <CodeBlock title="每条指令之后仍活跃的值（live-out）" language="text"
            code={round.code.map((item, index) => `#${String(index).padEnd(3)} ${allocInstructionText(item.instruction).padEnd(26)} → ${round.liveness.liveOut[index].join(', ') || '∅'}`).join('\n')} />
        )}
        {snapshot && color && <p>栈（从底到顶）：<code>{snapshot.stack.join(' → ') || '空'}</code></p>}
        {snapshot && !color && <p>正在占用寄存器的区间：<code>{snapshot.active.map((name) => `${name}:${registerText(snapshot.assignment[name])}`).join('，') || '无'}</code></p>}
        {event?.kind === 'select' && event.blocked.length > 0 && (
          <p>邻居已占用：<code>{event.blocked.map(registerText).join(', ')}</code></p>
        )}
        {next && (
          <CodeBlock title={`重写后的代码 / 第 ${next.index + 1} 轮输入`} language="text"
            code={next.code.map((item) => allocInstructionText(item.instruction)).join('\n')} />
        )}
      </section>

      {round && ['graph', 'event'].includes(frame.kind) && (
        <section className="regalloc-card" aria-label={color ? '干涉图' : '活跃区间'}>
          <h3>{color ? `干涉图 / 第 ${round.index + 1} 轮` : `活跃区间 / 第 ${round.index + 1} 轮`}</h3>
          {color ? <InterferenceFigure round={round} snapshot={snapshot} showAll={false} />
            : <IntervalFigure round={round} snapshot={snapshot} showAll={false} />}
          <p className="figure-caption">
            {color
              ? '实线是干涉边，虚线连接复制两端。点内第二行是寄存器；“栈中”表示已移出、等待弹出着色，“栈”表示真正溢出。粗边框是本步处理的值。'
              : '横轴是位置：“前 #i”在指令 i 读取之前，“后 #i”在它写入之后。条内文字是寄存器，“栈”表示溢出；粗边框是本步处理的区间。'}
          </p>
        </section>
      )}

      {final && (
        <>
          <section className="regalloc-card" aria-label="寄存器分配结果">
            <h3>谁共用了同一个寄存器？</h3>
            <ul className="register-groups">
              {byRegister.map((names, index) => (
                <li key={index} className={`reg-${index}`}><strong>{registerText(index)}</strong><code>{names.join(', ') || '未使用'}</code></li>
              ))}
              {Object.entries(allocation.slots).map(([name, slot]) => (
                <li key={name} className="reg-spilled"><strong>{slotText(slot)}</strong><code>{name}（溢出变量）</code></li>
              ))}
            </ul>
            <p>
              独立核对：{allocation.checkIssues.length ? allocation.checkIssues.join(' ') : '在最终代码上重新求活跃性，每次写入都没有覆盖此后仍要读取的值。'}
              {' '}静态插入 {allocation.staticLoads} 条 load、{allocation.staticStores} 条 store；{allocation.removedMoves} 条复制因两端同寄存器被删除。
            </p>
            <div className="regalloc-columns">
              <CodeBlock title="分配前 / 含溢出代码的 IR" language="text"
                code={allocation.finalCode.map((item) => allocInstructionText(item.instruction)).join('\n')} />
              <CodeBlock title={`分配后 / ${K} 个寄存器`} language="text"
                code={allocation.program.map((item) => registerInstructionText(item)).join('\n') || '// 空程序'} />
            </div>
            <details onToggle={(event) => setAllCode(event.currentTarget.open)}>
              <summary>查看每一轮的分配表 / 共 {allocation.rounds.length} 轮</summary>
              {allCode && allocation.rounds.map((item) => (
                <div key={item.index}>
                  <h4>第 {item.index + 1} 轮{item.spilled.length ? ` · 溢出 ${item.spilled.join(', ')}` : ' · 没有溢出'}</h4>
                  <RoundTable round={item} allocation={allocation} />
                </div>
              ))}
            </details>
          </section>
        </>
      )}

      {final && <section className="regalloc-card regalloc-machine" aria-label="寄存器机当前状态">
        <h3>寄存器机的真实状态</h3>
        <p>{current ? (instruction ? `PC ${current.pc} · ${registerInstructionText(instruction)} ； ${instruction.comment}` : current.message) : '下一步开始执行：寄存器与栈槽都还没有写入。'}</p>
        <div className="register-file">
          {Array.from({ length: K }, (_, index) => (
            <div key={index} className={`reg-${index} ${current?.written === registerText(index) ? 'written' : ''}`}>
              <span>{registerText(index)}</span><b>{valueText(current?.registers[index])}</b>
            </div>
          ))}
          {Object.keys(allocation.slots).map((name) => {
            const slot = allocation.slots[name];
            return (
              <div key={name} className={`reg-spilled ${current?.written === slotText(slot) ? 'written' : ''}`}>
                <span>{slotText(slot)}</span><b>{valueText(current?.slots[slot])}</b>
              </div>
            );
          })}
        </div>
        <p>到这一步的内存访问：<code>{memorySoFar ?? 0}</code> 次{current?.memory ? `（本步：${current.memory === 'load' ? '读取' : '写入'}）` : ''}</p>
        <div className="regalloc-output"><strong>{frame.kind === 'complete' ? '寄存器机最终输出' : '回放到这里的输出'}</strong>
          <code>{current?.output.length ? current.output.slice(-30).map(String).join(', ') : '等待 print…'}</code>
        </div>
      </section>}

      {frame.kind === 'complete' && allocation.execution && result.baseline && (
        <section className="regalloc-card regalloc-equivalence" aria-label="寄存器分配行为核对">
          <h3>{comparison === 'unknown' ? '达到上限，暂不能判定行为一致'
            : comparison === 'same' ? '寄存器机与原始 VM 的本次输出与错误一致' : '发现行为差异'}</h3>
          <div className="table-scroll" tabIndex={0} aria-label="执行结果对照，可横向滚动"><table>
            <thead><tr><th>执行</th><th>输出（最后 30 项）</th><th>停止状态</th></tr></thead>
            <tbody>
              <tr><td>原始 IR → 栈式 VM</td><td>{result.baseline.output.slice(-30).map(String).join(', ') || '无'}</td><td>{result.baseline.error?.message || (result.baseline.limited ? '达到上限' : '正常结束')}</td></tr>
              <tr><td>分配后 → 寄存器机</td><td>{allocation.execution.output.slice(-30).map(String).join(', ') || '无'}</td><td>{allocation.execution.error?.message || (allocation.execution.limited ? '达到上限' : '正常结束')}</td></tr>
            </tbody>
          </table></div>
          {result.registerSweep && (
            <>
              <h3>换一个 K、换一种算法</h3>
              <div className="table-scroll" tabIndex={0} aria-label="不同寄存器个数与算法的对照，可横向滚动">
                <table className="regalloc-sweep">
                  <thead><tr><th>K</th><th>算法</th><th>溢出值</th><th>静态 load/store</th><th>执行时内存访问</th><th>执行指令</th><th>核对</th></tr></thead>
                  <tbody>
                    {result.registerSweep.map((row) => (
                      <tr key={`${row.count}${row.algorithm}`}
                        className={row.count === K && row.algorithm === allocation.settings.algorithm ? 'current' : ''}>
                        <td>{row.count}</td><td>{algorithmNames[row.algorithm]}</td><td>{row.spilled}</td>
                        <td>{row.staticMemory}</td><td>{row.dynamicMemory}</td><td>{row.executed}</td>
                        <td>{{ same: '一致', different: '不同', unknown: '超限', failed: '分配失败' }[row.outcome]}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          <p className="figure-caption">两台机器的计步方式不同；本次一致不等于一般性的语义等价证明。内存访问次数只是代价的近似，不等于真实 CPU 的运行时间。</p>
        </section>
      )}
      {allocation.traceTruncated && <p className="figure-caption">分配与执行回放各记录前 240 步；最后一步仍展示完整分配结果和最终状态。</p>}
    </div>
  );
}
