import type { EscapeAnalysis, AllocReport } from '../compiler/escape';
import { CodeBlock } from './CodeBlock';
import '../styles-escape.css';

const stateBadge: Record<AllocReport['state'], string> = {
  NoEscape: 'NoEscape（未逃逸）',
  ArgEscape: 'ArgEscape（参数逃逸）',
  GlobalEscape: 'GlobalEscape（全局/返回逃逸）',
};

export function EscapeView({ analysis, step }: { analysis: EscapeAnalysis; step: number }) {
  const frame = analysis.frames[step];
  const { runs } = analysis;
  const phaseLabel = {
    initial: '解析与未内联基线',
    inline: '方法内联决策',
    escape: '逃逸分析与传播',
    sroa: '标量替换（SROA）',
    complete: '三版本执行与收益核对',
  }[frame.kind];

  return (
    <div className="escape-view">
      <div className="escape-status" role="status">
        <strong>{phaseLabel}</strong>
        <span>
          函数调用：{runs.original.calls} → {runs.sroa.calls} · 堆分配：{runs.original.heapAllocs} → {runs.sroa.heapAllocs}
        </span>
      </div>

      <section className="escape-card" aria-label="本步内联与逃逸分析">
        <h3>观察这一步</h3>
        <p>{frame.message}</p>
      </section>

      {frame.kind !== 'complete' && (
        <>
          <section className="escape-card" aria-label="内联决策表">
            <h3>方法内联决策（{analysis.inlineDecisions.length} 处调用点）</h3>
            {analysis.inlineDecisions.length ? (
              <div className="table-scroll" tabIndex={0} aria-label="内联决策表，可横向滚动">
                <table className="escape-table">
                  <thead>
                    <tr>
                      <th>调用者</th>
                      <th>被调用函数</th>
                      <th>结果</th>
                      <th>原因</th>
                    </tr>
                  </thead>
                  <tbody>
                    {analysis.inlineDecisions.map((d, i) => (
                      <tr key={i} className={frame.focusInline === i ? 'current' : ''}>
                        <td><code>{d.caller}</code></td>
                        <td><code>{d.callee}</code></td>
                        <td className={d.inlined ? 'badge-ok' : 'badge-warn'}>{d.inlined ? '已内联' : '保留调用'}</td>
                        <td>{d.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="figure-caption">当前程序没有自定义函数调用点。</p>
            )}
          </section>

          <section className="escape-card" aria-label="逃逸状态对照表">
            <h3>逃逸状态：内联前 vs 内联后</h3>
            <div className="escape-columns">
              <div>
                <h4>未内联时的逃逸判定</h4>
                <div className="table-scroll" tabIndex={0}>
                  <table className="escape-table">
                    <thead>
                      <tr><th>分配点</th><th>所在函数</th><th>级别</th></tr>
                    </thead>
                    <tbody>
                      {analysis.beforeEscape.map((r) => (
                        <tr key={`b-${r.allocId}-${r.ownerFunc}`}>
                          <td><code>{r.allocId}</code> ({r.structName})</td>
                          <td><code>{r.ownerFunc}</code></td>
                          <td className={`esc-${r.state}`}>{stateBadge[r.state]}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
              <div>
                <h4>内联后的逃逸判定与 SROA</h4>
                <div className="table-scroll" tabIndex={0}>
                  <table className="escape-table">
                    <thead>
                      <tr><th>分配点</th><th>级别</th><th>SROA</th><th>原因</th></tr>
                    </thead>
                    <tbody>
                      {analysis.afterEscape.map((r) => (
                        <tr key={`a-${r.allocId}-${r.ownerFunc}`} className={frame.focusAlloc === r.allocId ? 'current' : ''}>
                          <td><code>{r.allocId}</code> ({r.structName})</td>
                          <td className={`esc-${r.state}`}>{stateBadge[r.state]}</td>
                          <td>{r.scalarized ? `拆为 ${r.scalarVars?.join(', ')}` : '保留堆对象'}</td>
                          <td>{r.reason}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </section>
        </>
      )}

      {frame.kind === 'complete' && (
        <>
          <section className="escape-card" aria-label="代码改写对照">
            <h3>三个阶段的程序对照</h3>
            <div className="escape-three">
              <CodeBlock title="1. 优化前源码" language="c" code={analysis.originalCode} />
              <CodeBlock title="2. 方法内联后" language="c" code={analysis.inlinedCode} />
              <CodeBlock title="3. 逃逸分析 + 标量替换（SROA）后" language="c" code={analysis.sroaCode} />
            </div>
          </section>

          <section className="escape-card escape-equivalence" aria-label="内联与逃逸行为核对">
            <h3>
              {analysis.equivalent === 'same'
                ? '三个版本输出、发布对象与错误完全一致'
                : analysis.equivalent === 'unknown'
                  ? '达到步数上限，暂不能判定完整等价'
                  : '发现行为差异'}
            </h3>
            <div className="table-scroll" tabIndex={0} aria-label="三版本运行统计，可横向滚动">
              <table className="escape-table">
                <thead>
                  <tr>
                    <th>版本</th>
                    <th>函数调用次数</th>
                    <th>堆分配次数 (new)</th>
                    <th>输出</th>
                    <th>发布到全局的对象</th>
                    <th>停止状态</th>
                  </tr>
                </thead>
                <tbody>
                  {[runs.original, runs.inlined, runs.sroa].map((r) => (
                    <tr key={r.name}>
                      <td>{r.name}</td>
                      <td><strong>{r.calls}</strong></td>
                      <td><strong>{r.heapAllocs}</strong></td>
                      <td>{r.output.map(String).join(', ') || '无'}</td>
                      <td>{r.published.join('；') || '无'}</td>
                      <td>{r.error || (r.limited ? '达到上限' : '正常结束')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
      {analysis.traceTruncated && <p className="figure-caption">回放记录前 240 步；最终页展示全部统计与代码。</p>}
    </div>
  );
}
