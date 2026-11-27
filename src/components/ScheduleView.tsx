import { useState } from 'react';
import type { Compilation } from '../compiler';
import { algorithmNames, compareExecutions, registerInstructionText, type RegisterExecution } from '../compiler/regalloc';
import { dependenceName, latencyOf, latencyTable, type ScheduleBlock } from '../compiler/schedule';
import { T } from '../i18n';
import { CodeBlock } from './CodeBlock';
import '../styles-schedule.css';

const statusText = (run: Pick<RegisterExecution, 'error' | 'limited'>) => run.error?.message || (run.limited ? T('达到上限') : T('正常结束'));

function DependenceTable({ block }: { block: ScheduleBlock }) {
  return (
    <div className="table-scroll" tabIndex={0} aria-label={T('依赖图，可横向滚动')}>
      <table className="schedule-table">
        <thead><tr><th>#</th><th>{T('指令')}</th><th>{T('延迟')}</th><th>{T('必须在这些指令之后')}</th><th>{T('关键路径')}</th></tr></thead>
        <tbody>
          {block.body.map((instruction, index) => {
            const incoming = block.edges.filter((edge) => edge.to === index && edge.kind !== 'control');
            return (
              <tr key={index}>
                <td>#{index}</td>
                <td><code>{registerInstructionText(instruction)}</code></td>
                <td>{latencyOf(instruction)}</td>
                <td>{incoming.length ? incoming.map((edge) => (
                  <span key={`${edge.from}${edge.kind}${edge.via}`} className={`dep dep-${edge.kind}`}>
                    {edge.kind === 'raw'
                      ? T('#{#0} {#1}（{#2}，等 {#3} 周期）', edge.from, dependenceName(edge.kind), edge.via, edge.weight)
                      : T('#{#0} {#1}（{#2}）', edge.from, dependenceName(edge.kind), edge.via)}
                  </span>
                )) : T('无')}</td>
                <td>{block.priority[index]}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function IssueTable({ block, upTo }: { block: ScheduleBlock; upTo: number }) {
  return (
    <div className="table-scroll" tabIndex={0} aria-label={T('逐周期发出，可横向滚动')}>
      <table className="schedule-table">
        <thead><tr><th>{T('周期')}</th><th>{T('发出')}</th><th>{T('就绪')}</th><th>{T('等待延迟')}</th></tr></thead>
        <tbody>
          {block.events.slice(0, upTo + 1).map((event, index) => (
            <tr key={event.cycle} className={index === upTo ? 'current' : ''}>
              <td>{event.cycle}</td>
              <td>{event.chosen === undefined ? <em>{T('空转')}</em> : <code>#{event.chosen} {registerInstructionText(block.body[event.chosen])}</code>}</td>
              <td>{event.ready.map((node) => `#${node}`).join(T('、')) || '—'}</td>
              <td>{event.waiting.map((item) => `#${item.node}→${item.until}`).join(T('、')) || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ScheduleView({ result, step }: { result: Compilation; step: number }) {
  const analysis = result.schedule!;
  const allocation = result.regalloc!;
  const frame = analysis.frames[step];
  const [selected, setSelected] = useState(0);
  const [timeline, setTimeline] = useState(false);
  const block = frame.block !== undefined ? analysis.blocks[frame.block] : undefined;
  const rewrite = frame.rewrite !== undefined ? analysis.rewrites[frame.rewrite] : undefined;
  const final = ['timing', 'complete'].includes(frame.kind) && analysis.valid;
  const runs = analysis.runs;
  const chosen = analysis.blocks[selected] ?? analysis.blocks[0];
  const comparison = runs && result.baseline ? compareExecutions(result.baseline, runs.scheduled) : undefined;
  return (
    <div className="schedule-view">
      <div className="schedule-status" role="status">
        <strong>{algorithmNames[allocation.settings.algorithm]} · K = {allocation.settings.count}{block ? ` · ${block.id}` : ''}</strong>
        <span>{frame.kind === 'peephole' ? T('窥孔优化') : frame.kind === 'dag' ? T('建依赖图') : frame.kind === 'cycle' ? T('列表调度') : final ? T('执行与核对') : T('准备')}</span>
      </div>
      {analysis.issues.length > 0 && <p className="diagnostic" role="alert">{analysis.issues.join(' ')}</p>}

      <section className="schedule-card" aria-label={T('本步指令排序')}>
        <h3>{T('观察这一步')}</h3>
        <p>{frame.message}</p>
        {rewrite && (
          <div className="schedule-columns">
            <CodeBlock title={T('窗口内 / 改写前')} language="text" code={rewrite.before.join('\n')} />
            <CodeBlock title={T('改写后')} language="text" code={rewrite.after.join('\n') || T('// 删除')} />
          </div>
        )}
        {frame.kind === 'initial' && (
          <div className="table-scroll" tabIndex={0} aria-label={T('教学流水线延迟，可横向滚动')}>
            <table className="schedule-table">
              <thead><tr><th>{T('指令')}</th><th>{T('结果可读前的周期')}</th></tr></thead>
              <tbody>{latencyTable.map((row) => <tr key={row.kind}><td>{row.kind}</td><td>{row.cycles}</td></tr>)}</tbody>
            </table>
          </div>
        )}
      </section>

      {block && frame.kind === 'dag' && (
        <section className="schedule-card" aria-label={T('依赖图')}>
          <h3>{T('{#0} 的依赖图', block.id)}</h3>
          <DependenceTable block={block} />
          <p className="figure-caption">{T('真依赖要等前一条的延迟；反依赖、输出依赖来自寄存器复用；顺序约束保护 print 与可能报错的算术。块末跳转固定在最后，表中省略。')}</p>
        </section>
      )}
      {block && frame.kind === 'cycle' && frame.event !== undefined && (
        <section className="schedule-card" aria-label={T('逐周期发出')}>
          <h3>{T('{#0} · 逐周期发出', block.id)}</h3>
          <IssueTable block={block} upTo={frame.event} />
        </section>
      )}

      {final && runs && (
        <>
          <section className="schedule-card" aria-label={T('排序前后对照')}>
            <h3>{T('每个基本块排序前后')}</h3>
            <label>{T('选择基本块')}
              <select aria-label={T('选择基本块')} value={selected} onChange={(event) => setSelected(Number(event.target.value))}>
                {analysis.blocks.map((item, index) => (
                  <option key={index} value={index}>{T('{#0} · {#1} → {#2} 周期', item.id, item.originalLength, item.scheduledLength)}</option>
                ))}
              </select>
            </label>
            {chosen && (
              <div className="schedule-columns">
                <CodeBlock title={T('原顺序 / {#0} 周期', chosen.originalLength)} language="text"
                  code={chosen.body.map(registerInstructionText).join('\n') || T('// 空块')} />
                <CodeBlock title={T('排序后 / {#0} 周期', chosen.scheduledLength)} language="text"
                  code={chosen.order.map((node) => registerInstructionText(chosen.body[node])).join('\n') || T('// 空块')} />
              </div>
            )}
            <p>{T('独立核对：{#0} 窥孔改写 {#1} 处，寄存器复用带来的伪依赖共 {#2} 条。',
              analysis.checkIssues.length ? analysis.checkIssues.join(' ') : T('任意两条读写同一寄存器或栈槽、或都会输出 / 可能报错的指令，先后顺序没有改变。'),
              analysis.rewrites.length, analysis.falseDependences)}</p>
          </section>

          <section className="schedule-card schedule-equivalence" aria-label={T('指令排序行为核对')}>
            <h3>{comparison === 'unknown' ? T('达到上限，暂不能判定行为一致')
              : comparison === 'same' ? T('排序后的输出与错误和原始 VM 一致') : T('发现行为差异')}</h3>
            <div className="table-scroll" tabIndex={0} aria-label={T('三个版本的周期对照，可横向滚动')}><table className="schedule-table">
              <thead><tr><th>{T('版本')}</th><th>{T('周期')}</th><th>{T('空转')}</th><th>{T('执行指令')}</th><th>{T('内存访问')}</th><th>{T('输出（最后 30 项）')}</th><th>{T('停止状态')}</th></tr></thead>
              <tbody>
                {([[T('实验 17 分配结果'), runs.allocated], [T('窥孔优化后'), runs.peephole], [T('窥孔 + 排序后'), runs.scheduled]] as const).map(([name, run]) => (
                  <tr key={name}><td>{name}</td><td>{run.cycles}</td><td>{run.stalls}</td><td>{run.executed}</td><td>{run.loads + run.stores}</td>
                    <td>{run.output.slice(-30).map(String).join(', ') || T('无')}</td><td>{statusText(run)}</td></tr>
                ))}
                {result.baseline && <tr><td>{T('原始 IR → 栈式 VM')}</td><td>—</td><td>—</td><td>—</td><td>—</td>
                  <td>{result.baseline.output.slice(-30).map(String).join(', ') || T('无')}</td><td>{statusText(result.baseline)}</td></tr>}
              </tbody>
            </table></div>
            <details onToggle={(event) => setTimeline(event.currentTarget.open)}>
              <summary>{T('查看排序后的执行时间线（前 80 条）')}</summary>
              {timeline && (
                <div className="table-scroll" tabIndex={0} aria-label={T('执行时间线，可横向滚动')}><table className="schedule-table">
                  <thead><tr><th>{T('发出周期')}</th><th>{T('指令')}</th><th>{T('之前空转')}</th></tr></thead>
                  <tbody>{runs.scheduled.steps.filter((item) => item.cycle !== undefined).slice(0, 80).map((item, index) => (
                    <tr key={index} className={item.stall ? 'stalled' : ''}><td>{item.cycle}</td>
                      <td><code>{registerInstructionText(analysis.scheduled[item.pc])}</code></td><td>{item.stall || ''}</td></tr>
                  ))}</tbody>
                </table></div>
              )}
            </details>
            {result.scheduleSweep && (
              <>
                <h3>{T('寄存器越多，伪依赖越少吗？')}</h3>
                <div className="table-scroll" tabIndex={0} aria-label={T('不同寄存器个数的排序对照，可横向滚动')}>
                  <table className="schedule-table schedule-sweep">
                    <thead><tr><th>K</th><th>{T('伪依赖')}</th><th>{T('排序前周期')}</th><th>{T('排序后周期')}</th><th>{T('内存访问')}</th><th>{T('核对')}</th></tr></thead>
                    <tbody>{result.scheduleSweep.map((row) => (
                      <tr key={row.count} className={row.count === allocation.settings.count ? 'current' : ''}>
                        <td>{row.count}</td><td>{row.falseDependences}</td><td>{row.allocated}</td><td>{row.scheduled}</td><td>{row.memory}</td>
                        <td>{{ same: T('一致'), different: T('不同'), unknown: T('超限'), failed: T('失败') }[row.outcome]}</td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
                <p className="figure-caption">{T('同一算法（{#0}）在不同 K 下的分配、窥孔与排序。周期来自本页的教学流水线模型，不代表真实 CPU；本次一致不等于一般性的语义等价证明。', algorithmNames[allocation.settings.algorithm])}</p>
              </>
            )}
          </section>
        </>
      )}
      {analysis.traceTruncated && <p className="figure-caption">{T('窥孔与排序回放记录前 240 步；完成页仍展示全部基本块与执行结果。')}</p>}
    </div>
  );
}
