import { formatTargetInstr, type IselAnalysis, type ExprTree } from '../compiler/isel';
import { CodeBlock } from './CodeBlock';
import '../styles-isel.css';

function TreeSvg({ tree, highlightId }: { tree: ExprTree; highlightId?: number }) {
  const nodes: { node: ExprTree; x: number; y: number; parent?: { x: number; y: number } }[] = [];
  const widths = new Map<number, number>();
  const measure = (n: ExprTree): number => {
    const kids = [n.left, n.right].filter(Boolean) as ExprTree[];
    const w = kids.length ? kids.reduce((s, k) => s + measure(k), 0) : 78;
    widths.set(n.id, Math.max(78, w));
    return widths.get(n.id)!;
  };
  const totalW = measure(tree) + 28;
  const place = (n: ExprTree, left: number, depth: number, parent?: { x: number; y: number }) => {
    const x = left + widths.get(n.id)! / 2;
    const y = 26 + depth * 56;
    nodes.push({ node: n, x, y, parent });
    let cur = left;
    for (const k of [n.left, n.right].filter(Boolean) as ExprTree[]) {
      place(k, cur, depth + 1, { x, y });
      cur += widths.get(k.id)!;
    }
  };
  place(tree, 14, 0);
  const totalH = Math.max(...nodes.map((n) => n.y)) + 32;
  const label = (n: ExprTree) => (n.kind === 'bin' ? n.op! : n.kind === 'const' ? String(n.value) : n.name!);
  return (
    <div className="isel-tree-scroll" tabIndex={0} aria-label="表达式树，可横向滚动">
      <svg width={totalW} height={totalH} role="img" aria-label={`表达式树 ${tree.text}`}>
        {nodes.map((item) =>
          item.parent ? (
            <line key={`e-${item.node.id}`} x1={item.parent.x} y1={item.parent.y + 15} x2={item.x} y2={item.y - 15} className="isel-edge" />
          ) : null,
        )}
        {nodes.map((item) => (
          <g key={item.node.id} className={`isel-node kind-${item.node.kind} ${item.node.id === highlightId ? 'active' : ''}`} transform={`translate(${item.x},${item.y})`}>
            <rect x={-32} y={-15} width={64} height={30} rx={6} />
            <text textAnchor="middle" dominantBaseline="central">
              {label(item.node).length > 8 ? `${label(item.node).slice(0, 7)}…` : label(item.node)}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}

export function IselView({ analysis, step }: { analysis: IselAnalysis; step: number }) {
  const frame = analysis.frames[step];
  const { runs } = analysis;
  const activeTree = frame.stmtIndex !== undefined ? analysis.trees[frame.stmtIndex] : undefined;
  const activeChoice =
    frame.kind === 'dp' && frame.choiceIndex !== undefined
      ? analysis.dpChoices[frame.choiceIndex]
      : frame.kind === 'munch' && frame.choiceIndex !== undefined
        ? analysis.munchChoices[frame.choiceIndex]
        : undefined;
  const phaseLabel = {
    initial: '准备',
    tree: '构造表达式树',
    dp: '动态规划最小代价覆盖',
    munch: '贪心最大吞噬覆盖',
    compare: '方案对照',
    complete: '执行与等价核对',
  }[frame.kind];
  const allRuns = [runs.naive, runs.munch, runs.dp, runs.risc];

  return (
    <div className="isel-view">
      <div className="isel-status" role="status">
        <strong>{phaseLabel}</strong>
        <span>
          直译代价 {runs.naive.totalCost} · CISC 贪心 {runs.munch.totalCost} · CISC DP {runs.dp.totalCost} · RISC {runs.risc.totalCost}
        </span>
      </div>

      <section className="isel-card" aria-label="本步指令选择">
        <h3>观察这一步</h3>
        <p>{frame.message}</p>
        {activeTree?.expr && (
          <div className="isel-tree-block">
            <TreeSvg tree={activeTree.expr} />
            <CodeBlock title="被折叠的原始三地址代码" language="text" lineNumbers={false} code={activeTree.sourceIR.join('\n')} />
          </div>
        )}
        {activeChoice && (
          <div className="isel-choice-box">
            <div>
              <strong>瓦片 {activeChoice.tileName}</strong>
              <code>{activeChoice.pattern}</code>
            </div>
            <div>
              <span>本瓦片代价 {activeChoice.cost}</span>
              <span>子树累计代价 {activeChoice.totalCost}</span>
            </div>
            <CodeBlock title="生成指令" language="asm" lineNumbers={false} code={activeChoice.emitted} />
          </div>
        )}
      </section>

      {frame.kind !== 'compare' && frame.kind !== 'complete' && (
        <section className="isel-card" aria-label="已记录的瓦片覆盖表">
          <h3>{frame.kind === 'munch' ? '贪心最大吞噬选择记录' : '动态规划（BURS）选择记录'}</h3>
          <div className="table-scroll" tabIndex={0} aria-label="瓦片覆盖记录，可横向滚动">
            <table className="isel-table">
              <thead>
                <tr>
                  <th>子树</th>
                  <th>选中瓦片</th>
                  <th>模式</th>
                  <th>瓦片代价</th>
                  <th>发出指令</th>
                </tr>
              </thead>
              <tbody>
                {(frame.kind === 'munch' ? analysis.munchChoices : analysis.dpChoices).map((item, index) => (
                  <tr key={`${item.strategy}-${item.nodeId}-${index}`} className={frame.choiceIndex === index ? 'current' : ''}>
                    <td><code>{item.nodeText}</code></td>
                    <td><strong>{item.tileName}</strong></td>
                    <td><code>{item.pattern}</code></td>
                    <td>{item.cost}</td>
                    <td><code>{item.emitted}</code></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {(frame.kind === 'compare' || frame.kind === 'complete') && (
        <>
          <section className="isel-card" aria-label="四种指令选择结果对比">
            <h3>四个版本的代码对照</h3>
            <div className="isel-columns">
              <CodeBlock title={`CISC DP 最小代价（代价 ${runs.dp.totalCost}）`} language="asm" code={runs.dp.instructions.map(formatTargetInstr).join('\n')} />
              <CodeBlock title={`CISC 贪心最大吞噬（代价 ${runs.munch.totalCost}）`} language="asm" code={runs.munch.instructions.map(formatTargetInstr).join('\n')} />
              <CodeBlock title={`RISC Load-Store（代价 ${runs.risc.totalCost}）`} language="asm" code={runs.risc.instructions.map(formatTargetInstr).join('\n')} />
              <CodeBlock title={`逐条直译（代价 ${runs.naive.totalCost}）`} language="asm" code={runs.naive.instructions.map(formatTargetInstr).join('\n')} />
            </div>
          </section>

          <section className="isel-card isel-equivalence" aria-label="指令选择行为核对">
            <h3>
              {analysis.equivalent === 'same'
                ? '四个目标版本与原 Mini C 虚拟机输出和错误完全一致'
                : analysis.equivalent === 'unknown'
                  ? '存在达到步数上限的版本，暂不能判定等价'
                  : '发现行为差异'}
            </h3>
            <div className="table-scroll" tabIndex={0} aria-label="指令选择汇总表，可横向滚动">
              <table className="isel-table">
                <thead>
                  <tr>
                    <th>方案</th>
                    <th>可执行指令数</th>
                    <th>总静态代价</th>
                    <th>运行步数</th>
                    <th>输出</th>
                    <th>停止状态</th>
                  </tr>
                </thead>
                <tbody>
                  {allRuns.map((run) => (
                    <tr key={run.strategy}>
                      <td>{run.name}</td>
                      <td>{run.executableCount}</td>
                      <td><strong>{run.totalCost}</strong></td>
                      <td>{run.stepsExecuted}</td>
                      <td>{run.output.slice(-20).map(String).join(', ') || '无'}</td>
                      <td>{run.error || (run.limited ? '达到上限' : '正常结束')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="figure-caption">
              总静态代价按教学瓦片权重汇总：MOV/MOVI=1，ADD/SUB/SHL/LEA/CMP=2，IMUL=4，MADD=5，IDIV=6。仅验证当前输入的行为等价。
            </p>
          </section>
        </>
      )}
      {analysis.traceTruncated && <p className="figure-caption">回放记录前 240 步；最终对照页保留全部指令与执行结果。</p>}
    </div>
  );
}
