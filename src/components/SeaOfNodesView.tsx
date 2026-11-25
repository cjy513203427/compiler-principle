import type { SeaOfNodesAnalysis, SoNNodeCategory } from '../compiler/seaofnodes';
import '../styles-seaofnodes.css';

const catLabel: Record<SoNNodeCategory, string> = {
  control: '固定控制节点（红边）',
  floating: '浮动数据节点（蓝边 · SSA）',
  state: '栈帧状态（绿 · FrameState）',
};

export function SeaOfNodesView({ analysis, step }: { analysis: SeaOfNodesAnalysis; step: number }) {
  const frame = analysis.frames[step];
  const phaseLabel = {
    build: '1. 构建 Sea of Nodes 图',
    canonical: '2. Canonicalizer 规范化 + GVN',
    profile: '3. 收集 Profile 分支热点',
    speculate: '4. 投机剪枝 + FixedGuard / Deopt',
    run: '5. 执行 JIT 与 Deopt 回退核对',
    complete: '6. 总结与行为一致性核对',
  }[frame.kind];

  const activeNodes = frame.nodes.filter((n) => !n.pruned);
  const prunedNodes = frame.nodes.filter((n) => n.pruned);

  return (
    <div className="son-view">
      <div className="son-status" role="status">
        <strong>{phaseLabel}</strong>
        <span>
          活跃节点 {activeNodes.length}（已裁剪/合并 {prunedNodes.length}）·
          规范化 {analysis.canonicalRewriteCount} / GVN {analysis.gvnMergedCount} ·
          独立核对：{analysis.verified ? '全部一致 ✓' : '存在差异'}
        </span>
      </div>

      <section className="son-card" aria-label="本步 Sea of Nodes 观察">
        <h3>观察这一步</h3>
        <p>{frame.message}</p>
      </section>

      <section className="son-card" aria-label="Sea of Nodes 节点图">
        <h3>节点之海（红：控制依赖 · 蓝：数据依赖 · 绿：FrameState）</h3>
        <div className="son-legend">
          <span className="legend-chip control">固定控制节点</span>
          <span className="legend-chip floating">浮动数据节点</span>
          <span className="legend-chip state">FrameState（逆优化快照）</span>
          <span className="legend-chip loop-float">天生浮出循环</span>
        </div>
        <div className="son-node-grid">
          {activeNodes.map((n) => (
            <article
              key={n.id}
              className={`son-node cat-${n.category} ${frame.highlightNodeIds.includes(n.id) ? 'highlight' : ''} ${n.floatsOutsideLoop ? 'loop-float' : ''}`}
            >
              <header>
                <strong>#{n.id} {n.label}</strong>
                <small>{catLabel[n.category]}</small>
              </header>
              <div className="son-edges">
                {n.controlInputs.length > 0 && (
                  <span className="edge-ctrl">控制前驱：{n.controlInputs.map((id) => `#${id}`).join(', ')}</span>
                )}
                {n.dataInputs.length > 0 && (
                  <span className="edge-data">数据输入：{n.dataInputs.map((id) => `#${id}`).join(', ')}</span>
                )}
                {n.controlInputs.length === 0 && n.dataInputs.length === 0 && (
                  <span className="edge-none">入口 / 常量根节点</span>
                )}
              </div>
              {n.floatsOutsideLoop && (
                <div className="son-float-badge">不依赖 LoopPhi → 天生浮出循环</div>
              )}
            </article>
          ))}
        </div>
        {prunedNodes.length > 0 && (
          <p className="son-pruned-line">
            已合并或裁剪的节点（{prunedNodes.length}）：
            {prunedNodes.map((n) => `#${n.id} ${n.label}`).join('、')}
          </p>
        )}
      </section>

      {frame.rewrites.length > 0 && (
        <section className="son-card" aria-label="图改写记录">
          <h3>规范化 / GVN / 投机剪枝记录</h3>
          <ul className="son-rewrite-list">
            {frame.rewrites.map((r, idx) => (
              <li key={idx}>{r}</li>
            ))}
          </ul>
        </section>
      )}

      {frame.profiles.length > 0 && (
        <section className="son-card" aria-label="Profile 分支统计">
          <h3>Profile 热点统计与投机决策</h3>
          <div className="table-scroll" tabIndex={0} aria-label="分支统计表，可横向滚动">
            <table className="son-table">
              <thead>
                <tr><th>分支节点</th><th>true 次数</th><th>false 次数</th><th>投机优化决策</th></tr>
              </thead>
              <tbody>
                {frame.profiles.map((bp) => (
                  <tr key={bp.ifId}>
                    <td><code>{bp.label}</code></td>
                    <td>{bp.trueCount}</td>
                    <td>{bp.falseCount}</td>
                    <td>
                      {bp.speculated === 'none'
                        ? '两侧均热或未采样：保留完整 If'
                        : `冷分支 0 次 → 改为 Guard(须为 ${bp.speculated}) + Deopt`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {frame.outcomes.length > 0 && (
        <section className="son-card" aria-label="JIT 执行与逆优化核对">
          <h3>运行输入与逆优化（Deoptimization）核对</h3>
          <div className="table-scroll" tabIndex={0} aria-label="运行核对表，可横向滚动">
            <table className="son-table">
              <thead>
                <tr>
                  <th>调用实参</th>
                  <th>执行路径</th>
                  <th>JIT 返回</th>
                  <th>基线解释器</th>
                  <th>核对</th>
                </tr>
              </thead>
              <tbody>
                {frame.outcomes.map((o, idx) => (
                  <tr key={idx} className={o.deoptimized ? 'deopt-row' : ''}>
                    <td><code>{analysis.program.fnName}({o.args.join(', ')})</code></td>
                    <td>
                      {o.deoptimized ? (
                        <span className="path-deopt">
                          触发 Deopt → 恢复 ({o.restoredState}) 回退解释器
                        </span>
                      ) : (
                        <span className="path-fast">JIT 优化快路径</span>
                      )}
                    </td>
                    <td><code>{o.jitError ?? o.jitResult}</code></td>
                    <td><code>{o.oracleError ?? o.oracleResult}</code></td>
                    <td className={o.matched ? 'match-ok' : 'match-bad'}>{o.matched ? '一致 ✓' : '不一致'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
