import { useState } from 'react';
import type { Compilation } from '../compiler';
import { algorithmNames, compareExecutions, registerInstructionText, type RegisterExecution } from '../compiler/regalloc';
import { dependenceName, latencyOf, latencyTable, type ScheduleBlock } from '../compiler/schedule';
import { CodeBlock } from './CodeBlock';
import '../styles-schedule.css';

const statusText = (run: Pick<RegisterExecution, 'error' | 'limited'>) => run.error?.message || (run.limited ? '达到上限' : '正常结束');

function DependenceTable({ block }: { block: ScheduleBlock }) {
  return (
    <div className="table-scroll" tabIndex={0} aria-label="依赖图，可横向滚动">
      <table className="schedule-table">
        <thead><tr><th>#</th><th>指令</th><th>延迟</th><th>必须在这些指令之后</th><th>关键路径</th></tr></thead>
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
                    #{edge.from} {dependenceName(edge.kind)}（{edge.via}{edge.kind === 'raw' ? `，等 ${edge.weight} 周期` : ''}）
                  </span>
                )) : '无'}</td>
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
    <div className="table-scroll" tabIndex={0} aria-label="逐周期发出，可横向滚动">
      <table className="schedule-table">
        <thead><tr><th>周期</th><th>发出</th><th>就绪</th><th>等待延迟</th></tr></thead>
        <tbody>
          {block.events.slice(0, upTo + 1).map((event, index) => (
            <tr key={event.cycle} className={index === upTo ? 'current' : ''}>
              <td>{event.cycle}</td>
              <td>{event.chosen === undefined ? <em>空转</em> : <code>#{event.chosen} {registerInstructionText(block.body[event.chosen])}</code>}</td>
              <td>{event.ready.map((node) => `#${node}`).join('、') || '—'}</td>
              <td>{event.waiting.map((item) => `#${item.node}→${item.until}`).join('、') || '—'}</td>
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
        <span>{frame.kind === 'peephole' ? '窥孔优化' : frame.kind === 'dag' ? '建依赖图' : frame.kind === 'cycle' ? '列表调度' : final ? '执行与核对' : '准备'}</span>
      </div>
      {analysis.issues.length > 0 && <p className="diagnostic" role="alert">{analysis.issues.join(' ')}</p>}

      <section className="schedule-card" aria-label="本步指令排序">
        <h3>观察这一步</h3>
        <p>{frame.message}</p>
        {rewrite && (
          <div className="schedule-columns">
            <CodeBlock title="窗口内 / 改写前" language="text" code={rewrite.before.join('\n')} />
            <CodeBlock title="改写后" language="text" code={rewrite.after.join('\n') || '// 删除'} />
          </div>
        )}
        {frame.kind === 'initial' && (
          <div className="table-scroll" tabIndex={0} aria-label="教学流水线延迟，可横向滚动">
            <table className="schedule-table">
              <thead><tr><th>指令</th><th>结果可读前的周期</th></tr></thead>
              <tbody>{latencyTable.map((row) => <tr key={row.kind}><td>{row.kind}</td><td>{row.cycles}</td></tr>)}</tbody>
            </table>
          </div>
        )}
      </section>

      {block && frame.kind === 'dag' && (
        <section className="schedule-card" aria-label="依赖图">
          <h3>{block.id} 的依赖图</h3>
          <DependenceTable block={block} />
          <p className="figure-caption">真依赖要等前一条的延迟；反依赖、输出依赖来自寄存器复用；顺序约束保护 print 与可能报错的算术。块末跳转固定在最后，表中省略。</p>
        </section>
      )}
      {block && frame.kind === 'cycle' && frame.event !== undefined && (
        <section className="schedule-card" aria-label="逐周期发出">
          <h3>{block.id} · 逐周期发出</h3>
          <IssueTable block={block} upTo={frame.event} />
        </section>
      )}

      {final && runs && (
        <>
          <section className="schedule-card" aria-label="排序前后对照">
            <h3>每个基本块排序前后</h3>
            <label>选择基本块
              <select aria-label="选择基本块" value={selected} onChange={(event) => setSelected(Number(event.target.value))}>
                {analysis.blocks.map((item, index) => (
                  <option key={index} value={index}>{item.id} · {item.originalLength} → {item.scheduledLength} 周期</option>
                ))}
              </select>
            </label>
            {chosen && (
              <div className="schedule-columns">
                <CodeBlock title={`原顺序 / ${chosen.originalLength} 周期`} language="text"
                  code={chosen.body.map(registerInstructionText).join('\n') || '// 空块'} />
                <CodeBlock title={`排序后 / ${chosen.scheduledLength} 周期`} language="text"
                  code={chosen.order.map((node) => registerInstructionText(chosen.body[node])).join('\n') || '// 空块'} />
              </div>
            )}
            <p>独立核对：{analysis.checkIssues.length ? analysis.checkIssues.join(' ') : '任意两条读写同一寄存器或栈槽、或都会输出 / 可能报错的指令，先后顺序没有改变。'}
              {' '}窥孔改写 {analysis.rewrites.length} 处，寄存器复用带来的伪依赖共 {analysis.falseDependences} 条。</p>
          </section>

          <section className="schedule-card schedule-equivalence" aria-label="指令排序行为核对">
            <h3>{comparison === 'unknown' ? '达到上限，暂不能判定行为一致'
              : comparison === 'same' ? '排序后的输出与错误和原始 VM 一致' : '发现行为差异'}</h3>
            <div className="table-scroll" tabIndex={0} aria-label="三个版本的周期对照，可横向滚动"><table className="schedule-table">
              <thead><tr><th>版本</th><th>周期</th><th>空转</th><th>执行指令</th><th>内存访问</th><th>输出（最后 30 项）</th><th>停止状态</th></tr></thead>
              <tbody>
                {([['实验 17 分配结果', runs.allocated], ['窥孔优化后', runs.peephole], ['窥孔 + 排序后', runs.scheduled]] as const).map(([name, run]) => (
                  <tr key={name}><td>{name}</td><td>{run.cycles}</td><td>{run.stalls}</td><td>{run.executed}</td><td>{run.loads + run.stores}</td>
                    <td>{run.output.slice(-30).map(String).join(', ') || '无'}</td><td>{statusText(run)}</td></tr>
                ))}
                {result.baseline && <tr><td>原始 IR → 栈式 VM</td><td>—</td><td>—</td><td>—</td><td>—</td>
                  <td>{result.baseline.output.slice(-30).map(String).join(', ') || '无'}</td><td>{statusText(result.baseline)}</td></tr>}
              </tbody>
            </table></div>
            <details onToggle={(event) => setTimeline(event.currentTarget.open)}>
              <summary>查看排序后的执行时间线（前 80 条）</summary>
              {timeline && (
                <div className="table-scroll" tabIndex={0} aria-label="执行时间线，可横向滚动"><table className="schedule-table">
                  <thead><tr><th>发出周期</th><th>指令</th><th>之前空转</th></tr></thead>
                  <tbody>{runs.scheduled.steps.filter((item) => item.cycle !== undefined).slice(0, 80).map((item, index) => (
                    <tr key={index} className={item.stall ? 'stalled' : ''}><td>{item.cycle}</td>
                      <td><code>{registerInstructionText(analysis.scheduled[item.pc])}</code></td><td>{item.stall || ''}</td></tr>
                  ))}</tbody>
                </table></div>
              )}
            </details>
            {result.scheduleSweep && (
              <>
                <h3>寄存器越多，伪依赖越少吗？</h3>
                <div className="table-scroll" tabIndex={0} aria-label="不同寄存器个数的排序对照，可横向滚动">
                  <table className="schedule-table schedule-sweep">
                    <thead><tr><th>K</th><th>伪依赖</th><th>排序前周期</th><th>排序后周期</th><th>内存访问</th><th>核对</th></tr></thead>
                    <tbody>{result.scheduleSweep.map((row) => (
                      <tr key={row.count} className={row.count === allocation.settings.count ? 'current' : ''}>
                        <td>{row.count}</td><td>{row.falseDependences}</td><td>{row.allocated}</td><td>{row.scheduled}</td><td>{row.memory}</td>
                        <td>{{ same: '一致', different: '不同', unknown: '超限', failed: '失败' }[row.outcome]}</td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
                <p className="figure-caption">同一算法（{algorithmNames[allocation.settings.algorithm]}）在不同 K 下的分配、窥孔与排序。周期来自本页的教学流水线模型，不代表真实 CPU；本次一致不等于一般性的语义等价证明。</p>
              </>
            )}
          </section>
        </>
      )}
      {analysis.traceTruncated && <p className="figure-caption">窥孔与排序回放记录前 240 步；完成页仍展示全部基本块与执行结果。</p>}
    </div>
  );
}
