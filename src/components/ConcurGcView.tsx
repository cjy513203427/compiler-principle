import type { BarrierStrategy, ConcurGcAnalysis, TriColor } from '../compiler/concurgc';
import '../styles-concurgc.css';

const strategyTitle: Record<BarrierStrategy, { name: string; rule: string }> = {
  none: { name: '无写屏障（Naive）', rule: '直接修改指针，不加保护' },
  dijkstra: { name: 'Dijkstra 插入屏障', rule: '强三色不变式：黑 → 白 时把目标染灰' },
  satb: { name: 'Yuasa SATB 删除屏障', rule: '弱三色不变式：断开旧引用时把白目标染灰' },
};

const colorText: Record<TriColor, string> = {
  white: '白（未访问）',
  gray: '灰（待扫描）',
  black: '黑（已扫描）',
  swept: '已清除',
};

export function ConcurGcView({ analysis, step }: { analysis: ConcurGcAnalysis; step: number }) {
  const frame = analysis.frames[step];
  const strategies: BarrierStrategy[] = ['none', 'dijkstra', 'satb'];

  return (
    <div className="cgc-view">
      <div className="cgc-status" role="status">
        <strong>步骤 {frame.stepIndex} · {frame.opLabel}</strong>
        <span>
          当前真实可达（独立 BFS）：[{frame.liveSet.join(', ') || '空'}] · 根：[{frame.roots.join(', ') || '空'}]
        </span>
      </div>

      <section className="cgc-card" aria-label="本步并发标记说明">
        <h3>观察这一步</h3>
        <p>{frame.message}</p>
        <div className="cgc-graph-strip" aria-label="当前引用图边列表">
          <strong>当前堆边：</strong>
          {frame.edges.length === 0 ? (
            <span>（无对象间引用边）</span>
          ) : (
            frame.edges.map((e) => (
              <code key={`${e.from}->${e.to}`} className="cgc-edge-chip">
                {e.from} → {e.to}
              </code>
            ))
          )}
        </div>
      </section>

      <div className="cgc-strategy-grid">
        {strategies.map((key) => {
          const st = frame.strategies[key];
          const meta = strategyTitle[key];
          return (
            <section
              key={key}
              className={`cgc-strategy-card ${st.verdict ? `verdict-${st.verdict}` : ''}`}
              aria-label={meta.name}
            >
              <header>
                <h3>{meta.name}</h3>
                <small>{meta.rule}</small>
              </header>
              <p className="cgc-action">{st.lastAction}</p>
              <div className="cgc-meta-line">
                <span>灰队列：<code>[{st.grayQueue.join(', ') || '空'}]</code></span>
                <span>写屏障触发：<strong>{st.barrierTriggers} 次</strong></span>
              </div>
              <div className="cgc-nodes">
                {frame.objects.map((name) => {
                  const col = st.colors[name] ?? 'white';
                  const isRoot = frame.roots.includes(name);
                  const isLost = st.lostLive.includes(name);
                  const isFloat = st.floatingGarbage.includes(name);
                  return (
                    <div
                      key={name}
                      className={`cgc-node color-${col} ${isLost ? 'lost-live' : ''} ${isFloat ? 'float-dead' : ''}`}
                    >
                      <div className="cgc-node-head">
                        <strong>{name}</strong>
                        {isRoot && <span className="root-tag">ROOT</span>}
                      </div>
                      <span className="cgc-color-label">{colorText[col]}</span>
                      {isLost && <span className="cgc-alert-tag">误杀活对象!</span>}
                      {isFloat && <span className="cgc-float-tag">浮动垃圾</span>}
                    </div>
                  );
                })}
              </div>
              {st.verdict && (
                <div className={`cgc-verdict-bar ${st.verdict}`}>
                  {st.verdict === 'unsafe' && `不安全：误杀可达对象 [${st.lostLive.join(', ')}]`}
                  {st.verdict === 'exact' && `安全且精确：0 误杀，回收 [${st.swept.join(', ') || '无'}]`}
                  {st.verdict === 'floating' && `安全（含浮动垃圾 [${st.floatingGarbage.join(', ')}]，下轮回收）`}
                </div>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
