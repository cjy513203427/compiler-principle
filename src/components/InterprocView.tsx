import { useEffect, useState } from 'react';
import { factText } from '../compiler/dataflow';
import { instructionText } from '../compiler/ir';
import { MAIN_FUNCTION } from '../compiler/functions';
import { pInstructionText, type InterprocAnalysis, type PInstruction } from '../compiler/interproc';
import { T } from '../i18n';
import { Tx } from '../i18n/jsx';
import { CodeBlock } from './CodeBlock';
import '../styles-interproc.css';

const phaseName = (kind: 'lower' | 'graph' | 'summary' | 'ipcp' | 'transform' | 'inline' | 'minic' | 'complete') => ({
  lower: T('降低为三地址 IR'), graph: T('调用图'), summary: T('效果摘要'), ipcp: T('跨过程常量传播'),
  transform: T('按事实改写'), inline: T('内联'), minic: T('接入实验 05 优化器'), complete: T('执行与核对'),
}[kind]);
const VERSION_KEYS = ['lowered', 'optimized', 'inlined', 'minic'] as const;
type Version = (typeof VERSION_KEYS)[number];
const versionName = (version: Version) => ({
  lowered: T('降低后'), optimized: T('跨过程改写后'), inlined: T('内联后'), minic: T('实验 05 优化后'),
}[version]);
const displayName = (name: string) => (name === MAIN_FUNCTION ? 'main' : name);
const code = (instructions: PInstruction[]) =>
  instructions.map((instruction) => (instruction.op === 'label' ? `${instruction.name}:` : `  ${pInstructionText(instruction)}`)).join('\n') || `  ${T('// 空')}`;
const status = (execution?: { error?: { message: string }; limited: boolean }) =>
  !execution ? '—' : execution.error?.message || (execution.limited ? T('达到上限') : T('正常结束'));
const yes = (value: boolean) => (value ? T('是') : T('否'));

function CallGraphFigure({ analysis, focus }: { analysis: InterprocAnalysis; focus?: string }) {
  const { graph } = analysis;
  const names = graph.functions;
  if (names.length > 16) return <p className="figure-caption">{T('函数超过 16 个，改用下方表格查看调用关系。')}</p>;
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
    <div className="interproc-graph" tabIndex={0} aria-label={T('调用图，可在图内滚动')}>
      <svg viewBox={`0 0 ${size} ${size}`} role="img" aria-label={T('调用图：{#0} 个函数，{#1} 条调用边', names.length, graph.edges.length)}>
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
      <p className="figure-caption">{T('绿色是纯函数，橙色有效果（输出 / 可能报错 / 可能不终止），红框是递归，灰色从 main 到不了。箭头从调用者指向被调用者；粗边框是本步处理的函数。')}</p>
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
    ? analysis.minic ? analysis.minic.steps.at(-1)!.instructions.map((item) => (item.op === 'label' ? `${item.name}:` : `  ${instructionText(item)}`)).join('\n') || `  ${T('// 空')}` : ''
    : source.get(selected) ? code(source.get(selected)!.code) : `  ${version === 'optimized' ? T('// 改写时删除') : T('// 内联后不再被调用，已删除')}`;
  const functions = analysis.graph.functions;
  return (
    <div className="interproc-view">
      <div className="interproc-status" role="status">
        <strong>{phaseName(frame.kind)}</strong>
        <span>{T('{#0} 个函数 · {#1} 个调用点 · 改写 {#2} 轮 · 内联 {#3} 处', functions.length - 1, analysis.graph.sites.length, analysis.rounds, analysis.inlineEvents.filter((event) => event.inlined).length)}</span>
      </div>

      <section className="interproc-card" aria-label={T('本步跨过程分析')}>
        <h3>{T('观察这一步')}</h3>
        <p>{frame.message}</p>
        {ipcpEvent?.kind === 'param' && <p>{Tx('调用点：{#0}（在 {#1} 中）', <code>{pInstructionText(analysis.lowered.get(ipcpEvent.site.caller)!.code[ipcpEvent.site.index])}</code>, displayName(ipcpEvent.site.caller))}</p>}
        {inlineEvent && <p>{inlineEvent.inlined ? T('展开为第 {#0} 份副本，名字前缀 {#1}@{#2}.', inlineEvent.instance, inlineEvent.callee, inlineEvent.instance) : T('保留 call {#0}', inlineEvent.callee)}</p>}
      </section>

      <div className="interproc-columns">
        <section className="interproc-card" aria-label={T('调用图')}>
          <h3>{T('调用图')}</h3>
          <CallGraphFigure analysis={analysis} focus={focus} />
        </section>
        <section className="interproc-card" aria-label={T('函数效果摘要')}>
          <h3>{T('每个函数会做什么')}</h3>
          <div className="table-scroll" tabIndex={0} aria-label={T('效果摘要表，可横向滚动')}>
            <table className="interproc-table">
              <thead><tr><th>{T('函数')}</th><th>{T('输出')}</th><th>{T('可能报错')}</th><th>{T('可能不终止')}</th><th>{T('纯函数')}</th><th>{T('改写后')}</th><th>{T('形参')}</th><th>{T('返回值')}</th></tr></thead>
              <tbody>
                {functions.map((name) => {
                  const summary = analysis.summaries[name], after = analysis.finalSummaries[name];
                  const params = analysis.ipcp.params[name] ?? [];
                  return (
                    <tr key={name} className={focus === name ? 'current' : ''}>
                      <td><code>{displayName(name)}</code>{summary.recursive && <small> {T('递归')}</small>}</td>
                      <td>{yes(summary.prints)}</td><td>{yes(summary.traps)}</td><td>{yes(summary.diverges)}</td>
                      <td>{yes(summary.pure)}</td>
                      <td>{after ? (after.pure ? T('纯') : T('有效果')) : T('已删除')}</td>
                      <td>{name === MAIN_FUNCTION ? '—' : !analysis.ipcp.analyzed.includes(name) ? T('没被调用') : params.map((fact) => (fact ? factText(fact) : '⊥')).join(', ') || T('无')}</td>
                      <td>{name === MAIN_FUNCTION ? '—' : analysis.ipcp.returns[name] ? factText(analysis.ipcp.returns[name]!) : '⊥'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="figure-caption">{T('“形参 / 返回值”是跨过程常量传播的结果：数字表示处处相同的常量，⊤ 表示不止一种值，⊥ 表示还没有值传进来。')}{analysis.summaries[selected]?.reasons.length ? T('{#0}：{#1}。', displayName(selected), analysis.summaries[selected].reasons.join(T('；'))) : ''}</p>
        </section>
      </div>

      <section className="interproc-card" aria-label={T('函数代码')}>
        <h3>{T('函数代码')}</h3>
        <div className="interproc-pickers">
          <label>
            {T('函数')}
            <select aria-label={T('查看的函数')} value={selected} onChange={(change) => setSelected(change.target.value)} disabled={version === 'minic'}>
              {functions.map((name) => <option key={name} value={name}>{displayName(name)}</option>)}
            </select>
          </label>
          <div role="radiogroup" aria-label={T('代码版本')} className="interproc-versions">
            {VERSION_KEYS.map((item) => (
              <label key={item}>
                <input type="radio" name="interproc-version" checked={version === item} disabled={item === 'minic' && !analysis.minic}
                  onChange={() => setVersion(item)} />
                {versionName(item)}
              </label>
            ))}
          </div>
        </div>
        <CodeBlock title={version === 'minic' ? T('main · 实验 05 优化后') : `${displayName(selected)} · ${versionName(version)}`} language="text"
          code={version === 'minic' && !analysis.minic ? T('// main 仍调用 {#0}，没有交给实验 05 的优化器', analysis.remainingCalls.join(T('、'))) : listing} />
      </section>

      {frame.kind === 'complete' && (
        <section className="interproc-card interproc-equivalence" aria-label={T('跨过程优化行为核对')}>
          <h3>{analysis.runs.some((row) => row.outcome === 'different') ? T('发现行为差异')
            : analysis.runs.some((row) => row.outcome === 'unknown') ? T('有版本达到上限，暂不能判定一致')
              : analysis.runs.some((row) => row.outcome === 'skipped') ? T('执行过的版本，输出与错误都和实验 16 的 VM 一致') : T('每个版本的输出与错误都和实验 16 的 VM 一致')}</h3>
          <div className="table-scroll" tabIndex={0} aria-label={T('各版本执行对照，可横向滚动')}>
            <table>
              <thead><tr><th>{T('版本')}</th><th>{T('输出（最后 30 项）')}</th><th>{T('停止状态')}</th><th>{T('执行步数')}</th><th>{T('调用次数')}</th><th>{T('核对')}</th></tr></thead>
              <tbody>
                {analysis.runs.map((row) => (
                  <tr key={row.id}>
                    <td>{row.label}</td>
                    <td>{row.execution ? row.execution.output.slice(-30).map(String).join(', ') || T('无') : '—'}</td>
                    <td>{status(row.execution)}</td>
                    <td>{row.execution?.executed ?? '—'}</td>
                    <td>{row.execution ? row.execution.calls : '—'}</td>
                    <td>{row.note && row.outcome !== 'skipped' && row.id === 'vm' ? row.note : { same: T('一致'), different: T('不同'), unknown: T('超限'), skipped: T('跳过') }[row.outcome]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {analysis.runs.find((row) => row.outcome === 'skipped')?.note && <p>{T('{#0}。', analysis.runs.find((row) => row.outcome === 'skipped')!.note)}</p>}
          <p className="figure-caption">{T('函数字节码 VM、IR 解释器与栈式 VM 的计步单位不同，步数只用于同一行内比较；本次一致不等于一般性的等价证明。')}</p>
        </section>
      )}
      {analysis.traceTruncated && <p className="figure-caption">{T('回放最多保留 400 步；最后一步仍展示完整结果与核对。')}</p>}
    </div>
  );
}
