import type { ClosureAnalysis } from '../compiler/closure';
import '../styles-closure.css';

export function ClosureView({ analysis, step }: { analysis: ClosureAnalysis; step: number }) {
  const frame = analysis.frames[step];
  const phaseLabel = {
    analysis: '静态自由变量与捕获分析',
    enter: '调用闭包 · 载入环境',
    'alloc-cell': '逃逸变量装箱到堆上 Cell',
    'make-closure': '构造闭包对象 { code, env }',
    'mutate-cell': '原地修改堆上 Cell',
    return: '函数返回 · 弹出栈帧',
    print: '输出结果',
    complete: '执行与词法链对照完成',
  }[frame.kind];

  return (
    <div className="closure-view">
      <div className="closure-status" role="status">
        <strong>{phaseLabel}</strong>
        <span>
          堆上 Cell：{analysis.totalCells} 个 · 闭包对象：{analysis.totalClosures} 个 ·{' '}
          {analysis.equivalent === 'same' ? '与独立词法链解释器一致' : analysis.equivalent === 'unknown' ? '达到上限' : '存在差异'}
        </span>
      </div>

      <section className="closure-card" aria-label="本步闭包执行">
        <h3>观察这一步</h3>
        <p>{frame.message}</p>
      </section>

      <section className="closure-card" aria-label="静态捕获分析表">
        <h3>编译期分析：栈变量 vs 堆装箱 Cell</h3>
        <div className="table-scroll" tabIndex={0} aria-label="捕获分析表，可横向滚动">
          <table className="closure-table">
            <thead>
              <tr><th>作用域</th><th>外层</th><th>留在栈上的局部</th><th>装箱到堆上的 Cell</th><th>从外层捕获</th></tr>
            </thead>
            <tbody>
              {analysis.reports.map((r) => (
                <tr key={r.fnId}>
                  <td><code>{r.name}</code></td>
                  <td><code>{r.parent}</code></td>
                  <td><code>{r.stackLocals.join(', ') || '无'}</code></td>
                  <td className={r.boxedLocals.length ? 'boxed-col' : ''}><code>{r.boxedLocals.join(', ') || '无'}</code></td>
                  <td><code>{r.captures.map((c) => `${c.name} (来自 ${c.fromScope})`).join('、') || '无'}</code></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {frame.kind !== 'analysis' && (
        <section className="closure-card" aria-label="运行时栈与堆环境">
          <h3>运行时三区视图：调用栈 / 堆上 Cell / 闭包对象</h3>
          <div className="closure-runtime-grid">
            <div className="rt-col">
              <h4>调用栈（栈顶在上）</h4>
              {[...frame.stack].reverse().map((sf) => (
                <div key={sf.id} className="rt-box stack-box">
                  <strong>帧 #{sf.id} · {sf.name}</strong>
                  {sf.locals.length ? (
                    sf.locals.map((loc) => (
                      <span key={loc.name} className={loc.boxedCell ? 'boxed-ref' : ''}>
                        <code>{loc.name}</code> = {loc.value}
                      </span>
                    ))
                  ) : (
                    <small>无局部变量</small>
                  )}
                </div>
              ))}
              {!frame.stack.length && <p className="empty-inline">栈空</p>}
            </div>

            <div className="rt-col">
              <h4>堆上捕获单元（Cell / Upvalue）</h4>
              {frame.cells.map((c) => (
                <div key={c.id} className={`rt-box cell-box ${frame.focusCell === c.id ? 'focus' : ''} ${c.aliveAfterOwnerReturned ? 'escaped' : ''}`}>
                  <strong>Cell#{c.id} · {c.name} = {c.value}</strong>
                  <small>
                    创建自 {c.ownerFn}
                    {c.aliveAfterOwnerReturned ? ' · 原栈帧已弹出，仍在堆上存活' : ' · 原栈帧仍在栈上'}
                  </small>
                </div>
              ))}
              {!frame.cells.length && <p className="empty-inline">尚未分配堆上 Cell</p>}
            </div>

            <div className="rt-col">
              <h4>堆上闭包对象</h4>
              {frame.closures.map((cl) => (
                <div key={cl.id} className={`rt-box cl-box ${frame.focusClosure === cl.id ? 'focus' : ''}`}>
                  <strong>Closure#{cl.id}</strong>
                  <span>code → <code>{cl.fnName}</code></span>
                  <span>
                    env → {cl.env.length ? cl.env.map((e) => `${e.name}:Cell#${e.cellId}`).join(', ') : '∅'}
                  </span>
                </div>
              ))}
              {!frame.closures.length && <p className="empty-inline">尚未创建闭包对象</p>}
            </div>
          </div>
        </section>
      )}

      <div className="output-console">
        <span>stdout {analysis.error ? `· 错误：${analysis.error}` : ''}</span>
        <pre>{frame.output.length ? frame.output.map(String).join('\n') : '等待 print…'}</pre>
      </div>
      {analysis.traceTruncated && <p className="figure-caption">回放记录前 240 步；最终统计仍完整。</p>}
    </div>
  );
}
