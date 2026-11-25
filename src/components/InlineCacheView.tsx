import type { InlineCacheAnalysis, IcState } from '../compiler/inlinecache';
import '../styles-inlinecache.css';

const icStateLabel: Record<IcState, string> = {
  uninitialized: '未初始化',
  monomorphic: '单态 (Monomorphic)',
  polymorphic: '多态 (Polymorphic)',
  megamorphic: '超态 (Megamorphic)',
};

export function InlineCacheView({ analysis, step }: { analysis: InlineCacheAnalysis; step: number }) {
  const frame = analysis.frames[step];
  const phaseLabel = {
    alloc: '对象创建与隐藏类分配',
    transition: '隐藏类属性迁移',
    'ic-hit': '内联缓存命中（快路径）',
    'ic-miss': '内联缓存未命中 / 状态变更',
    print: '输出结果',
    complete: '代价对照与字典核对',
  }[frame.kind];

  return (
    <div className="ic-view">
      <div className="ic-status" role="status">
        <strong>{phaseLabel}</strong>
        <span>
          隐藏类 {frame.shapes.length} 个 · 访问代价 Shape+IC {frame.icTotalCost} vs 字典 {frame.dictTotalCost} ·
          独立核对：{analysis.verified ? '一致 ✓' : '存在差异'}
        </span>
      </div>

      <section className="ic-card" aria-label="本步隐藏类与缓存">
        <h3>观察这一步</h3>
        <p>{frame.message}</p>
      </section>

      <section className="ic-card" aria-label="隐藏类转移树">
        <h3>隐藏类（Hidden Class / Shape）转移树</h3>
        <div className="shape-grid">
          {frame.shapes.map((s) => (
            <article
              key={s.id}
              className={`shape-box ${frame.activeShapeId === s.id ? 'active' : ''}`}
            >
              <header>
                <strong>Shape#{s.id}</strong>
                <small>
                  {s.parentId === null ? '空根对象 {}' : `Shape#${s.parentId} +${s.addedProp}`}
                </small>
              </header>
              <div className="shape-props">
                {s.props.length === 0 ? (
                  <span className="shape-empty">（无属性槽）</span>
                ) : (
                  s.props.map((p) => (
                    <span key={p.offset} className="shape-slot">
                      <code>@{p.offset}</code> {p.name}
                    </span>
                  ))
                )}
              </div>
              {s.transitions.length > 0 && (
                <div className="shape-edges">
                  {s.transitions.map((t) => (
                    <span key={t.prop}>+{t.prop} → Shape#{t.toShapeId}</span>
                  ))}
                </div>
              )}
            </article>
          ))}
        </div>
      </section>

      <section className="ic-card" aria-label="内联缓存状态表">
        <h3>各属性读取点的内联缓存（Inline Cache）</h3>
        <div className="table-scroll" tabIndex={0} aria-label="内联缓存表，可横向滚动">
          <table className="ic-table">
            <thead>
              <tr>
                <th>位置</th>
                <th>当前状态</th>
                <th>缓存映射 (Shape → 槽偏移)</th>
                <th>命中 / 未命中</th>
                <th>累计代价</th>
              </tr>
            </thead>
            <tbody>
              {frame.sites.map((site) => (
                <tr key={site.siteId} className={frame.activeSiteId === site.siteId ? 'active-row' : ''}>
                  <td><code>{site.location}</code></td>
                  <td>
                    <span className={`ic-pill ${site.state}`}>{icStateLabel[site.state]}</span>
                  </td>
                  <td>
                    {site.state === 'megamorphic'
                      ? '（已超过 4 种 Shape，退化为字典慢查找）'
                      : site.entries.length
                        ? site.entries.map((e) => `Shape#${e.shapeId} → @${e.offset}`).join('，')
                        : '空'}
                  </td>
                  <td>{site.hits} / {site.misses}</td>
                  <td>{site.totalCost}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {frame.heap.length > 0 && (
        <section className="ic-card" aria-label="堆对象紧凑槽位">
          <h3>堆对象实例（只存 Shape 指针 + 紧凑槽数组）</h3>
          <div className="ic-heap-grid">
            {frame.heap.map((obj) => (
              <div key={obj.id} className={`ic-heap-obj ${frame.activeObjectId === obj.id ? 'active' : ''}`}>
                <strong>#{obj.id} {obj.label}</strong>
                <span className="ic-shape-ref">shape → Shape#{obj.shapeId}</span>
                {obj.slots.map((sl) => (
                  <span key={sl.offset}>slots[{sl.offset}] ({sl.prop}) = {sl.value}</span>
                ))}
              </div>
            ))}
          </div>
        </section>
      )}

      <div className="output-console">
        <span>stdout {analysis.icError ? `· 错误：${analysis.icError}` : `· 与独立字典解释器一致`}</span>
        <pre>{frame.output.length ? frame.output.join('\n') : '等待 print…'}</pre>
      </div>
      {analysis.traceTruncated && <p className="figure-caption">回放记录前 240 步；最终统计仍完整。</p>}
    </div>
  );
}
