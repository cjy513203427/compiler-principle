import type { VtableAnalysis } from '../compiler/vtable';
import '../styles-vtable.css';

const statusText = { defined: '本类新增', inherited: '继承父类', overridden: '覆写原槽' };

export function VtableView({ analysis, step }: { analysis: VtableAnalysis; step: number }) {
  const frame = analysis.frames[step];
  const phaseLabel = {
    layout: '对象内存布局',
    vtable: '构建虚函数表',
    cha: '去虚拟化分析 (CHA)',
    alloc: '堆上创建实例',
    dispatch: '运行时虚表分派',
    print: '输出结果',
    complete: '分派统计与对照',
  }[frame.kind];

  return (
    <div className="vtable-view">
      <div className="vtable-status" role="status">
        <strong>{phaseLabel}</strong>
        <span>
          {analysis.layouts.length} 个类 · {analysis.callSites.length} 处调用点 · 动态查表 {analysis.dynamicCount} 次 / 可去虚拟化 {analysis.devirtCount} 次
        </span>
      </div>

      <section className="vtable-card" aria-label="本步虚表分派">
        <h3>观察这一步</h3>
        <p>{frame.message}</p>
        {frame.dispatch && (
          <div className="dispatch-chain" aria-label="动态分派路径">
            <span>变量 <code>{frame.dispatch.receiverVar}</code>（静态 {frame.dispatch.staticType}）</span>
            <b>→</b>
            <span>堆对象 <code>#{frame.dispatch.objectId}</code></span>
            <b>→</b>
            <span><code>+0 vptr</code> ({frame.dispatch.runtimeClass}::vtable)</span>
            <b>→</b>
            <span>槽 <code>[{frame.dispatch.slot}]</code></span>
            <b>→</b>
            <strong className="dispatch-target">{frame.dispatch.resolvedImpl}</strong>
          </div>
        )}
      </section>

      <section className="vtable-card" aria-label="对象内存布局与虚函数表">
        <h3>各类的对象布局与虚函数表（前缀兼容）</h3>
        <div className="vtable-class-grid">
          {analysis.layouts.map((lay) => (
            <article key={lay.name} className={`vtable-class-box ${frame.focusClass === lay.name ? 'focus' : ''}`}>
              <header>
                <strong>class {lay.name}</strong>
                {lay.superName && <small>extends {lay.superName}</small>}
              </header>
              <div className="layout-strip">
                <div className="layout-cell vptr">
                  <span>+0</span>
                  <code>vptr → {lay.name}::vtable</code>
                </div>
                {lay.fields.map((f) => (
                  <div key={f.offset} className={`layout-cell ${f.inherited ? 'inherited' : 'own'}`}>
                    <span>+{f.offset}</span>
                    <code>{f.name}</code>
                    <small>{f.inherited ? `继承自 ${f.definedIn}` : '本类字段'}</small>
                  </div>
                ))}
              </div>
              <table className="vtable-mini">
                <thead>
                  <tr><th>槽</th><th>方法</th><th>指向实现</th><th>来源</th></tr>
                </thead>
                <tbody>
                  {lay.vtable.map((slot) => (
                    <tr
                      key={slot.slot}
                      className={`${slot.status} ${frame.dispatch?.runtimeClass === lay.name && frame.dispatch.slot === slot.slot ? 'active-slot' : ''}`}
                    >
                      <td><code>[{slot.slot}]</code></td>
                      <td><code>{slot.methodName}</code></td>
                      <td><code>{slot.implClass}::{slot.methodName}</code></td>
                      <td>{statusText[slot.status]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </article>
          ))}
        </div>
      </section>

      {frame.heap.length > 0 && (
        <section className="vtable-card" aria-label="堆对象实例">
          <h3>当前堆上的对象实例</h3>
          <div className="heap-objs">
            {frame.heap.map((obj) => (
              <div key={obj.id} className={`heap-obj ${frame.dispatch?.objectId === obj.id ? 'active' : ''}`}>
                <strong>#{obj.id} {obj.className}</strong>
                <span>+0 vptr → {obj.className}::vtable</span>
                {obj.fields.map((f) => (
                  <span key={f.offset}>+{f.offset} {f.name} = {f.value}</span>
                ))}
              </div>
            ))}
          </div>
        </section>
      )}

      {(frame.kind === 'cha' || frame.kind === 'complete') && (
        <section className="vtable-card" aria-label="静态去虚拟化分析">
          <h3>调用点去虚拟化分析（CHA + 精确类型）</h3>
          <div className="table-scroll" tabIndex={0} aria-label="去虚拟化分析表，可横向滚动">
            <table className="vtable-table">
              <thead>
                <tr><th>调用点</th><th>位置</th><th>静态类型与槽位</th><th>可能实现</th><th>结论</th><th>依据</th></tr>
              </thead>
              <tbody>
                {analysis.callSites.map((site) => (
                  <tr key={site.siteId}>
                    <td>#{site.siteId}</td>
                    <td><code>{site.location}</code></td>
                    <td><code>{site.staticType}.{site.methodName}()</code> [槽 {site.slot}]</td>
                    <td><code>{site.possibleTargets.join(', ')}</code></td>
                    <td className={site.devirtualized ? 'devirt-yes' : 'devirt-no'}>
                      {site.devirtualized ? '可静态直调' : '需查虚表'}
                    </td>
                    <td>{site.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
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
