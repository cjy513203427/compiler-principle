import { useEffect, useState } from 'react';
import { factText } from '../compiler/dataflow';
import { instructionText } from '../compiler/ir';
import { MAIN_FUNCTION } from '../compiler/functions';
import { pInstructionText, type InterprocAnalysis, type PInstruction } from '../compiler/interproc';
import { CodeBlock } from './CodeBlock';
import '../styles-interproc.css';

const phaseNames = {
  lower: '降低为三地址 IR', graph: '调用图', summary: '效果摘要', ipcp: '跨过程常量传播',
  transform: '按事实改写', inline: '内联', minic: '接入实验 05 优化器', complete: '执行与核对',
} as const;
const versionNames = { lowered: '降低后', optimized: '跨过程改写后', inlined: '内联后', minic: '实验 05 优化后' } as const;
type Version = keyof typeof versionNames;
const displayName = (name: string) => (name === MAIN_FUNCTION ? 'main' : name);
const code = (instructions: PInstruction[]) =>
  instructions.map((instruction) => (instruction.op === 'label' ? `${instruction.name}:` : `  ${pInstructionText(instruction)}`)).join('\n') || '  // 空';
const status = (execution?: { error?: { message: string }; limited: boolean }) =>
  !execution ? '—' : execution.error?.message || (execution.limited ? '达到上限' : '正常结束');
const yes = (value: boolean) => (value ? '是' : '否');

function CallGraphFigure({ analysis, focus }: { analysis: InterprocAnalysis; focus?: string }) {
  const { graph } = analysis;
  const names = graph.functions;
  if (names.length > 16) return <p className="figure-caption">函数超过 16 个，改用下方表格查看调用关系。</p>;
  const size = 340, center = size / 2, radius = names.length <= 1 ? 0 : 120;
  const position = new Map(names.map((name, index) => {
    const angle = (index / names.length) * Math.PI * 2 - Math.PI / 2;
    return [name, { x: center + radius * Math.cos(angle), y: center + radius * Math.sin(angle) }];
  }));
  const purity = (name: string) => {
    const summary = analysis.summaries[name];
    return !graph.reachable.includes(name) ? 'unreached' : summary.pure ? 'pure' : summary.recursive ? 'recursive' : 'effect';
  };
  return (
    <div className="interproc-graph" tabIndex={0} aria-label="调用图，可在图内滚动">
      <svg viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`调用图：${names.length} 个函数，${graph.edges.length} 条调用边`}>
        <defs>
          <marker id="call-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" className="arrow-head" />
          </marker>
        </defs>
        {graph.edges.map(([from, to]) => {
          const a = position.get(from)!, b = position.get(to)!;
          if (from === to)
            return <path key={`${from}>${to}`} d={`M ${a.x - 12} ${a.y - 24} C ${a.x - 40} ${a.y - 70}, ${a.x + 40} ${a.y - 70}, ${a.x + 12} ${a.y - 24}`} className="call-edge" markerEnd="url(#call-arrow)" />;
          const dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy) || 1, r = 30;
          return <line key={`${from}>${to}`} x1={a.x + (dx / length) * r} y1={a.y + (dy / length) * r} x2={b.x - (dx / length) * r} y2={b.y - (dy / length) * r} className="call-edge" markerEnd="url(#call-arrow)" />;
        })}
        {names.map((name) => {
          const { x, y } = position.get(name)!;
          const label = displayName(name);
          return (
            <g key={name} className={`call-node ${purity(name)} ${focus === name ? 'focus' : ''}`}>
              <circle cx={x} cy={y} r={28} />
              <text x={x} y={y + 4} textAnchor="middle">{label.length > 9 ? `${label.slice(0, 8)}…` : label}</text>
            </g>
          );
        })}
      </svg>
      <p className="figure-caption">绿色是纯函数，橙色有效果（输出 / 可能报错 / 可能不终止），红框是递归，灰色从 main 到不了。箭头从调用者指向被调用者；粗边框是本步处理的函数。</p>
    </div>
  );
}

export function InterprocView({ analysis, step }: { analysis: InterprocAnalysis; step: number }) {
  const frame = analysis.frames[step];
  const focus = 'fn' in frame ? frame.fn : frame.kind === 'inline' ? analysis.inlineEvents[frame.event]?.caller
    : frame.kind === 'ipcp' ? analysis.ipcp.events[frame.event]?.fn : undefined;
  const [selected, setSelected] = useState(focus ?? MAIN_FUNCTION);
  const defaultVersion: Version = frame.kind === 'lower' || frame.kind === 'graph' || frame.kind === 'summary' || frame.kind === 'ipcp' ? 'lowered'
    : frame.kind === 'transform' ? 'optimized' : frame.kind === 'inline' ? 'inlined' : analysis.minic ? 'minic' : 'inlined';
  const [version, setVersion] = useState<Version>(defaultVersion);
  useEffect(() => { if (focus) setSelected(focus); }, [focus]);
  useEffect(() => { setVersion(defaultVersion); }, [defaultVersion]);
  const ipcpEvent = frame.kind === 'ipcp' ? analysis.ipcp.events[frame.event] : undefined;
  const inlineEvent = frame.kind === 'inline' ? analysis.inlineEvents[frame.event] : undefined;
  const source = version === 'lowered' ? analysis.lowered : version === 'optimized' ? analysis.optimized : analysis.inlined;
  const listing = version === 'minic'
    ? analysis.minic ? analysis.minic.steps.at(-1)!.instructions.map((item) => (item.op === 'label' ? `${item.name}:` : `  ${instructionText(item)}`)).join('\n') || '  // 空' : ''
    : source.get(selected) ? code(source.get(selected)!.code) : `  // ${version === 'optimized' ? '改写时删除' : '内联后不再被调用，已删除'}`;
  const functions = analysis.graph.functions;
  return (
    <div className="interproc-view">
      <div className="interproc-status" role="status">
        <strong>{phaseNames[frame.kind]}</strong>
        <span>{functions.length - 1} 个函数 · {analysis.graph.sites.length} 个调用点 · 改写 {analysis.rounds} 轮 · 内联 {analysis.inlineEvents.filter((event) => event.inlined).length} 处</span>
      </div>

      <section className="interproc-card" aria-label="本步跨过程分析">
        <h3>观察这一步</h3>
        <p>{frame.message}</p>
        {ipcpEvent?.kind === 'param' && <p>调用点：<code>{pInstructionText(analysis.lowered.get(ipcpEvent.site.caller)!.code[ipcpEvent.site.index])}</code>（在 {displayName(ipcpEvent.site.caller)} 中）</p>}
        {inlineEvent && <p>{inlineEvent.inlined ? `展开为第 ${inlineEvent.instance} 份副本，名字前缀 ${inlineEvent.callee}@${inlineEvent.instance}.` : `保留 call ${inlineEvent.callee}`}</p>}
      </section>

      <div className="interproc-columns">
        <section className="interproc-card" aria-label="调用图">
          <h3>调用图</h3>
          <CallGraphFigure analysis={analysis} focus={focus} />
        </section>
        <section className="interproc-card" aria-label="函数效果摘要">
          <h3>每个函数会做什么</h3>
          <div className="table-scroll" tabIndex={0} aria-label="效果摘要表，可横向滚动">
            <table className="interproc-table">
              <thead><tr><th>函数</th><th>输出</th><th>可能报错</th><th>可能不终止</th><th>纯函数</th><th>改写后</th><th>形参</th><th>返回值</th></tr></thead>
              <tbody>
                {functions.map((name) => {
                  const summary = analysis.summaries[name], after = analysis.finalSummaries[name];
                  const params = analysis.ipcp.params[name] ?? [];
                  return (
                    <tr key={name} className={focus === name ? 'current' : ''}>
                      <td><code>{displayName(name)}</code>{summary.recursive && <small> 递归</small>}</td>
                      <td>{yes(summary.prints)}</td><td>{yes(summary.traps)}</td><td>{yes(summary.diverges)}</td>
                      <td>{yes(summary.pure)}</td>
                      <td>{after ? (after.pure ? '纯' : '有效果') : '已删除'}</td>
                      <td>{name === MAIN_FUNCTION ? '—' : !analysis.ipcp.analyzed.includes(name) ? '没被调用' : params.map((fact) => (fact ? factText(fact) : '⊥')).join(', ') || '无'}</td>
                      <td>{name === MAIN_FUNCTION ? '—' : analysis.ipcp.returns[name] ? factText(analysis.ipcp.returns[name]!) : '⊥'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="figure-caption">“形参 / 返回值”是跨过程常量传播的结果：数字表示处处相同的常量，⊤ 表示不止一种值，⊥ 表示还没有值传进来。{analysis.summaries[selected]?.reasons.length ? `${displayName(selected)}：${analysis.summaries[selected].reasons.join('；')}。` : ''}</p>
        </section>
      </div>

      <section className="interproc-card" aria-label="函数代码">
        <h3>函数代码</h3>
        <div className="interproc-pickers">
          <label>
            函数
            <select aria-label="查看的函数" value={selected} onChange={(change) => setSelected(change.target.value)} disabled={version === 'minic'}>
              {functions.map((name) => <option key={name} value={name}>{displayName(name)}</option>)}
            </select>
          </label>
          <div role="radiogroup" aria-label="代码版本" className="interproc-versions">
            {(Object.keys(versionNames) as Version[]).map((item) => (
              <label key={item}>
                <input type="radio" name="interproc-version" checked={version === item} disabled={item === 'minic' && !analysis.minic}
                  onChange={() => setVersion(item)} />
                {versionNames[item]}
              </label>
            ))}
          </div>
        </div>
        <CodeBlock title={version === 'minic' ? 'main · 实验 05 优化后' : `${displayName(selected)} · ${versionNames[version]}`} language="text"
          code={version === 'minic' && !analysis.minic ? `// main 仍调用 ${analysis.remainingCalls.join('、')}，没有交给实验 05 的优化器` : listing} />
      </section>

      {frame.kind === 'complete' && (
        <section className="interproc-card interproc-equivalence" aria-label="跨过程优化行为核对">
          <h3>{analysis.runs.some((row) => row.outcome === 'different') ? '发现行为差异'
            : analysis.runs.some((row) => row.outcome === 'unknown') ? '有版本达到上限，暂不能判定一致'
              : analysis.runs.some((row) => row.outcome === 'skipped') ? '执行过的版本，输出与错误都和实验 16 的 VM 一致' : '每个版本的输出与错误都和实验 16 的 VM 一致'}</h3>
          <div className="table-scroll" tabIndex={0} aria-label="各版本执行对照，可横向滚动">
            <table>
              <thead><tr><th>版本</th><th>输出（最后 30 项）</th><th>停止状态</th><th>执行步数</th><th>调用次数</th><th>核对</th></tr></thead>
              <tbody>
                {analysis.runs.map((row) => (
                  <tr key={row.id}>
                    <td>{row.label}</td>
                    <td>{row.execution ? row.execution.output.slice(-30).map(String).join(', ') || '无' : '—'}</td>
                    <td>{status(row.execution)}</td>
                    <td>{row.execution?.executed ?? '—'}</td>
                    <td>{row.execution ? row.execution.calls : '—'}</td>
                    <td>{row.note && row.outcome !== 'skipped' && row.id === 'vm' ? row.note : { same: '一致', different: '不同', unknown: '超限', skipped: '跳过' }[row.outcome]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {analysis.runs.find((row) => row.outcome === 'skipped')?.note && <p>{analysis.runs.find((row) => row.outcome === 'skipped')!.note}。</p>}
          <p className="figure-caption">函数字节码 VM、IR 解释器与栈式 VM 的计步单位不同，步数只用于同一行内比较；本次一致不等于一般性的等价证明。</p>
        </section>
      )}
      {analysis.traceTruncated && <p className="figure-caption">回放最多保留 400 步；最后一步仍展示完整结果与核对。</p>}
    </div>
  );
}
