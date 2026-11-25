import type { GenericsAnalysis } from '../compiler/generics';
import '../styles-generics.css';

export function GenericsView({ analysis, step }: { analysis: GenericsAnalysis; step: number }) {
  const frame = analysis.frames[step];
  const phaseLabel = {
    typecheck: '编译期类型检查',
    erase: '路线 A：类型擦除（Java 思路）',
    monomorph: '路线 B：单态化（C++ / Rust 思路）',
    'exec-erased': '执行擦除版（观察 box / checkcast）',
    'exec-mono': '执行单态化版（零装箱特化代码）',
    compare: '双路线统计与独立参考核对',
  }[frame.kind];

  return (
    <div className="generics-view">
      <div className="generics-status" role="status">
        <strong>{phaseLabel}</strong>
        <span>
          擦除单元 {analysis.erasedUnits.length} 份 vs 单态化单元 {analysis.monoUnits.length} 份 ·
          独立核对：{analysis.verified ? '行为一致 ✓' : '存在差异'}
        </span>
      </div>

      <section className="generics-card" aria-label="本步泛型编译">
        <h3>观察这一步</h3>
        <p>{frame.message}</p>
        {(frame.erasedOp || frame.monoOp) && (
          <div className="gen-op-badge">
            {frame.erasedOp && <span className="op-erased">擦除动作：<code>{frame.erasedOp}</code></span>}
            {frame.monoOp && <span className="op-mono">单态化动作：<code>{frame.monoOp}</code></span>}
          </div>
        )}
      </section>

      <div className="generics-split">
        <section className="generics-card" aria-label="类型擦除生成代码">
          <h3>路线 A：类型擦除（共享字节码）</h3>
          {analysis.erasedClashError && (
            <div className="gen-clash-banner" role="alert">
              {analysis.erasedClashError}
            </div>
          )}
          <div className="gen-unit-list">
            {analysis.erasedUnits.map((u, idx) => (
              <div key={`${u.name}-${idx}`} className="gen-unit">
                <div className="gen-unit-head">
                  <strong>{u.erasedSig}</strong>
                  <small>{u.kind === 'struct' ? '擦除结构体' : '擦除函数'}</small>
                </div>
                <pre className="gen-code">{u.code}</pre>
              </div>
            ))}
          </div>
        </section>

        <section className="generics-card" aria-label="单态化生成代码">
          <h3>路线 B：单态化（按具体类型展开）</h3>
          <div className="gen-unit-list">
            {analysis.monoUnits.map((u) => (
              <div key={u.mangledName} className="gen-unit mono">
                <div className="gen-unit-head">
                  <strong>{u.mangledName}</strong>
                  <small>来自 {u.sourceSig}</small>
                </div>
                <pre className="gen-code">{u.code}</pre>
              </div>
            ))}
          </div>
        </section>
      </div>

      <section className="generics-card" aria-label="双路线开销与行为对照">
        <h3>实时开销与行为核对</h3>
        <div className="table-scroll" tabIndex={0} aria-label="泛型双路线对比表，可横向滚动">
          <table className="gen-table">
            <thead>
              <tr>
                <th>编译路线</th>
                <th>代码单元</th>
                <th>装箱 (box)</th>
                <th>强转 (checkcast)</th>
                <th>拆箱 (unbox)</th>
                <th>估算堆/值字节</th>
                <th>输出 / 状态</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td><strong>类型擦除（Java）</strong></td>
                <td>{frame.erasedMetrics.codeUnits}</td>
                <td className={frame.erasedMetrics.boxOps > 0 ? 'metric-warn' : ''}>{frame.erasedMetrics.boxOps}</td>
                <td className={frame.erasedMetrics.checkcasts > 0 ? 'metric-warn' : ''}>{frame.erasedMetrics.checkcasts}</td>
                <td>{frame.erasedMetrics.unboxOps}</td>
                <td>{frame.erasedMetrics.heapBytes} B</td>
                <td>
                  {frame.erasedMetrics.error
                    ? `拒绝：${frame.erasedMetrics.error}`
                    : frame.erasedMetrics.output.join(', ') || '—'}
                </td>
              </tr>
              <tr>
                <td><strong>单态化（C++ / Rust）</strong></td>
                <td className={frame.monoMetrics.codeUnits > frame.erasedMetrics.codeUnits ? 'metric-note' : ''}>
                  {frame.monoMetrics.codeUnits}
                </td>
                <td className="metric-good">{frame.monoMetrics.boxOps}</td>
                <td className="metric-good">{frame.monoMetrics.checkcasts}</td>
                <td className="metric-good">{frame.monoMetrics.unboxOps}</td>
                <td>{frame.monoMetrics.heapBytes} B</td>
                <td>
                  {frame.monoMetrics.error
                    ? `错误：${frame.monoMetrics.error}`
                    : frame.monoMetrics.output.join(', ') || '—'}
                </td>
              </tr>
              <tr>
                <td><strong>独立类型化参考解释器</strong></td>
                <td>—</td>
                <td>—</td>
                <td>—</td>
                <td>—</td>
                <td>—</td>
                <td>{analysis.oracleError ? `错误：${analysis.oracleError}` : analysis.oracleOutput.join(', ') || '—'}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <div className="output-console">
        <span>stdout（单态化输出{analysis.erasedClashError ? ' · 擦除版因签名冲突未运行' : ' · 与擦除版完全一致'}）</span>
        <pre>{frame.monoMetrics.output.length ? frame.monoMetrics.output.join('\n') : '等待 print…'}</pre>
      </div>
      {analysis.traceTruncated && <p className="figure-caption">回放记录前 240 步；最终统计仍完整。</p>}
    </div>
  );
}
