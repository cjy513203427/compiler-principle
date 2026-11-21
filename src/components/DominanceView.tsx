import { useId, useState } from 'react';
import type { Compilation } from '../compiler';
import { findCFGPath } from '../compiler/dominance';
import { instructionText } from '../compiler/ir';
import '../styles-dominance.css';

const setText = (values: string[]) => (values.length ? `{ ${values.join(', ')} }` : '∅');
export function DominanceView({ result, step }: { result: Compilation; step: number }) {
  const analysis = result.dominance!;
  const graph = analysis.graph;
  const frame = analysis.steps[step];
  const complete = frame.kind === 'complete';
  const ready = complete && analysis.converged;
  const [mode, setMode] = useState<'dom' | 'loop' | 'frontier'>('dom');
  const [selected, setSelected] = useState(
    graph.blocks.find(
      (block) =>
        analysis.reachable.includes(block.id) && block.instructions.some((i) => i.op === 'print'),
    )?.id || analysis.entry,
  );
  const [candidate, setCandidate] = useState(
    analysis.reachable.find((id) => id !== analysis.entry) || analysis.entry,
  );
  const [loopHeader, setLoopHeader] = useState(analysis.loops[0]?.header);
  const variables = Object.keys(analysis.definitions).filter((name) => name.startsWith('v'));
  const [variable, setVariable] = useState(
    variables.find((name) => analysis.phiCandidates[name].length) || variables[0] || '',
  );
  const inspected = ready ? selected : frame.block;
  const currentBlock = graph.blocks.find((block) => block.id === inspected)!;
  const currentSet = ready ? analysis.dominators[inspected] : frame.current;
  const dominates = ready && analysis.dominators[selected].includes(candidate);
  const bypass =
    ready && mode === 'dom' && !dominates ? findCFGPath(graph, selected, candidate) : undefined;
  const loop = analysis.loops.find((item) => item.header === loopHeader);
  const backEdges = new Set(ready ? analysis.loops.flatMap((item) => item.backEdges) : []);
  const highlighted = new Set(
    ready && mode === 'loop'
      ? loop?.nodes || []
      : ready && mode === 'frontier'
        ? analysis.frontier[candidate]
        : currentSet,
  );
  const marker = `dom-arrow-${useId().replace(/:/g, '')}`;
  const indexOf = (id: string) => graph.blocks.findIndex((block) => block.id === id);
  const depth = (id: string) => {
    let n = 0;
    let parent = analysis.immediate[id];
    while (parent && n < graph.blocks.length) {
      n++;
      parent = analysis.immediate[parent];
    }
    return n;
  };

  return (
    <div className="dominance-view">
      <div className="dom-status">
        <strong>
          {ready
            ? '支配分析已收敛'
            : complete
              ? '支配分析未完成'
              : `第 ${frame.iteration} 轮 / ${frame.kind === 'initial' ? '准备求解' : `处理 ${frame.block}`}`}
        </strong>
        <span>
          {analysis.reachable.length} / {graph.blocks.length} 块入口可达
        </span>
      </div>
      <p className="dom-scope">
        分析原始 CFG
        的全部结构边，不根据本次输出或常量条件删边。图中“可达”与一条绕行路径，都只描述图结构。
      </p>
      <div className="dom-formula">
        <code>Dom[入口] = {'{入口}'}</code>
        <code>Dom[B] = {'{B}'} ∪ ⋂ Dom[可达前驱]</code>
      </div>
      {!complete && (
        <section className="dom-derivation" aria-label="本步支配集合推导">
          <h3>{frame.block} / 逐步收缩候选集合</h3>
          <p>
            之前：<code>{setText(frame.previous)}</code>
          </p>
          {frame.predecessors.map((pred) => (
            <p key={pred.block}>
              前驱 {pred.block}：<code>{setText(pred.dominators)}</code>
            </p>
          ))}
          <p>
            现在：<code>{setText(frame.current)}</code>
          </p>
          <p>
            {frame.removed.length
              ? `移除：${frame.removed.join('、')}`
              : frame.kind === 'initial'
                ? '入口固定；其他可达块从全集初始化。'
                : '集合不变，继续检查后续块。'}
          </p>
          <span>此时仍是求解过程；完成回放后再查看支配树与循环结论。</span>
        </section>
      )}
      {complete && !analysis.converged && (
        <p className="diagnostic" role="alert">
          集合尚未收敛，不展示直接支配者、循环或 φ 候选。请缩小输入。
        </p>
      )}
      <div className="dom-modes" aria-label="支配分析视角">
        {(
          [
            { id: 'dom', name: '必经关系与支配树' },
            { id: 'loop', name: '自然循环与嵌套' },
            { id: 'frontier', name: '支配边界与 φ 候选' },
          ] as const
        ).map((item) => (
          <button key={item.id} aria-pressed={mode === item.id} onClick={() => setMode(item.id)}>
            {item.name}
          </button>
        ))}
      </div>
      {ready && mode === 'dom' && (
        <>
          <section className="dom-query">
            <h3>试着绕过一个块</h3>
            <div>
              <label>
                候选必经块 A
                <select
                  aria-label="候选必经块"
                  value={candidate}
                  onChange={(event) => setCandidate(event.target.value)}
                >
                  {analysis.reachable.map((id) => (
                    <option key={id}>{id}</option>
                  ))}
                </select>
              </label>
              <label>
                目标块 B
                <select
                  aria-label="支配查询目标块"
                  value={selected}
                  onChange={(event) => setSelected(event.target.value)}
                >
                  {analysis.reachable.map((id) => (
                    <option key={id}>{id}</option>
                  ))}
                </select>
              </label>
            </div>
            <p className="dom-query-result" role="status">
              {dominates
                ? `${candidate} 支配 ${selected}：从入口到目标的所有结构路径都经过它。`
                : `${candidate} 不支配 ${selected}：存在一条绕过它的结构路径。`}
            </p>
            {bypass && <code className="dom-bypass">绕行反例：{bypass.join(' → ')}</code>}
            <p className="figure-caption">
              能找到一条反例就能否定“必经”；一次实际运行经过 A，不能证明 A 支配 B。
            </p>
          </section>
          <section className="dom-tree" aria-label="直接支配树">
            <h3>直接支配树 / 最近的必经层</h3>
            {analysis.reachable.map((id) => (
              <button
                key={id}
                className={selected === id ? 'selected' : ''}
                style={{ paddingLeft: `${14 + Math.min(depth(id), 12) * 16}px` }}
                onClick={() => setSelected(id)}
              >
                <code>{id}</code>
                <span>
                  {id === analysis.entry ? '入口 / 树根' : `idom = ${analysis.immediate[id]}`}
                </span>
              </button>
            ))}
            <p className="figure-caption">层级来自直接支配关系，不表示 CFG 中有同样的直接连边。</p>
          </section>
        </>
      )}
      {ready && mode === 'loop' && (
        <section className="dom-loop-panel">
          <h3>识别到 {analysis.loops.length} 个自然循环</h3>
          {loop ? (
            <>
              <label>
                选择循环
                <select
                  aria-label="选择自然循环"
                  value={loopHeader}
                  onChange={(event) => setLoopHeader(event.target.value)}
                >
                  {analysis.loops.map((item) => (
                    <option key={item.header} value={item.header}>
                      header {item.header} · {item.nodes.length} 个块
                    </option>
                  ))}
                </select>
              </label>
              <dl>
                <div>
                  <dt>Header / 循环头</dt>
                  <dd>{loop.header}</dd>
                </div>
                <div>
                  <dt>Latch / 回跳起点</dt>
                  <dd>{loop.latches.join(', ')}</dd>
                </div>
                <div>
                  <dt>Members / 循环成员</dt>
                  <dd>{loop.nodes.join(', ')}</dd>
                </div>
                <div>
                  <dt>Preheader / 专用前置块</dt>
                  <dd>{loop.preheader || '不存在'}</dd>
                </div>
                <div>
                  <dt>Exit blocks / 循环外退出块</dt>
                  <dd>{loop.exitBlocks.join(', ') || '无结构退出边'}</dd>
                </div>
                <div>
                  <dt>Parent / 外层循环头</dt>
                  <dd>{loop.parent || '顶层循环'}</dd>
                </div>
              </dl>
              <div className="dom-loop-edges">
                {loop.backEdges.map((id) => {
                  const edge = graph.edges.find((e) => e.id === id)!;
                  return (
                    <p key={id}>
                      <code>
                        {edge.from} → {edge.to}
                      </code>
                      ：{edge.to} 支配 {edge.from}，因此是自然循环回边。
                    </p>
                  );
                })}
              </div>
            </>
          ) : (
            <p>没有找到满足“目标支配起点”的边。这不等于一般图中不存在有向环。</p>
          )}
          <p className="dom-scope">
            同一个 header
            的回边合并为一个自然循环。这里只识别自然循环，不枚举所有有向环，也不分析循环是否会终止。
          </p>
        </section>
      )}
      {ready && mode === 'frontier' && (
        <section className="dom-frontier-panel">
          <h3>支配在何处遇到汇合？</h3>
          <label>
            查看 DF(A)
            <select
              aria-label="支配边界的基本块"
              value={candidate}
              onChange={(event) => setCandidate(event.target.value)}
            >
              {analysis.reachable.map((id) => (
                <option key={id}>{id}</option>
              ))}
            </select>
          </label>
          <p className="dom-frontier-result">
            <code>
              DF({candidate}) = {setText(analysis.frontier[candidate])}
            </code>
          </p>
          <p>A 支配目标的某个前驱，却不严格支配目标本身；循环头可以位于自己的支配边界中。</p>
          <h3>按变量计算迭代 φ 候选</h3>
          {variables.length ? (
            <>
              <label>
                选择源变量
                <select
                  aria-label="φ 候选的变量"
                  value={variable}
                  onChange={(event) => setVariable(event.target.value)}
                >
                  {variables.map((name) => (
                    <option key={name}>{name}</option>
                  ))}
                </select>
              </label>
              <p>
                定义块：<code>{setText(analysis.definitions[variable])}</code>
              </p>
              <p className="dom-phi-result">
                候选块：<code>{setText(analysis.phiCandidates[variable])}</code>
              </p>
              {analysis.phiCandidates[variable].map((id) => (
                <div className="dom-phi-site" key={id}>
                  <strong>{id} / φ 候选</strong>
                  <span>
                    可达前驱：
                    {[
                      ...new Set(
                        graph.edges
                          .filter(
                            (edge) => edge.to === id && analysis.reachable.includes(edge.from),
                          )
                          .map((edge) => edge.from),
                      ),
                    ].join(', ')}
                  </span>
                  <p>φ 按进入这里的前驱边选择对应版本；这里尚未分配版本名。</p>
                </div>
              ))}
            </>
          ) : (
            <p>当前程序没有源变量定义，可编辑左侧程序再观察。</p>
          )}
          <p className="dom-scope">
            这里只求迭代支配边界，没有活跃性裁剪，候选可能多余。完整 SSA 仍需沿支配树重命名、补齐 φ
            输入与校验；可继续到实验 13「静态单赋值」观察这些步骤与执行。本页只展示候选。
          </p>
        </section>
      )}
      <div className="dom-graph-caption">
        <strong>
          原始 CFG /{' '}
          {ready && mode === 'loop'
            ? '绿色为所选循环成员'
            : ready && mode === 'frontier'
              ? '绿色为 DF(A) 中的块'
              : '绿色为目标的支配候选'}
        </strong>
        <span>{ready ? '点击可达块检查 IR；必经视角同时更换目标' : '本步处理块以深色描边'}</span>
      </div>
      <div className="dom-graph-scroll" tabIndex={0} aria-label="支配关系控制流图，可在图内滚动">
        <svg
          className="dom-graph"
          width="400"
          height={graph.blocks.length * 108 + 20}
          role="group"
          aria-label="支配分析的原始基本块图"
        >
          <defs>
            <marker
              id={marker}
              viewBox="0 0 10 10"
              refX={9}
              refY={5}
              markerWidth={6}
              markerHeight={6}
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke" />
            </marker>
          </defs>
          {graph.edges.map((edge, index) => {
            const from = indexOf(edge.from),
              to = indexOf(edge.to);
            const start = from * 108 + 18,
              end = to * 108 + 18;
            const back = to <= from,
              adjacent = to === from + 1,
              lane = back ? 12 + (index % 3) * 8 : 388 - (index % 3) * 8;
            const path = adjacent
              ? `M 200 ${start + 76} L 200 ${end}`
              : `M ${back ? 64 : 336} ${start + 48} L ${lane} ${start + 48} L ${lane} ${end + 28} L ${back ? 64 : 336} ${end + 28}`;
            const witness = bypass?.some((id, i) => id === edge.from && bypass[i + 1] === edge.to);
            return (
              <g
                key={edge.id}
                className={`dom-edge ${backEdges.has(edge.id) ? 'natural-back' : ''} ${witness ? 'witness' : ''}`}
              >
                <path d={path} markerEnd={`url(#${marker})`} />
                <title>
                  {edge.from} → {edge.to} · {edge.kind}
                  {backEdges.has(edge.id) ? ' · 自然循环回边' : ''}
                </title>
              </g>
            );
          })}
          {graph.blocks.map((block, index) => (
            <g
              key={block.id}
              transform={`translate(64,${index * 108 + 18})`}
              className={`dom-block ${highlighted.has(block.id) ? 'highlighted' : ''} ${inspected === block.id ? 'current' : ''} ${!analysis.reachable.includes(block.id) ? 'unreachable' : ''}`}
              role="button"
              aria-label={`查询基本块 ${block.id}`}
              tabIndex={ready && analysis.reachable.includes(block.id) ? 0 : -1}
              aria-disabled={!ready || !analysis.reachable.includes(block.id)}
              onClick={() => {
                if (ready && analysis.reachable.includes(block.id)) setSelected(block.id);
              }}
              onKeyDown={(event) => {
                if (
                  ready &&
                  analysis.reachable.includes(block.id) &&
                  (event.key === 'Enter' || event.key === ' ')
                ) {
                  event.preventDefault();
                  setSelected(block.id);
                }
              }}
            >
              <rect width={272} height={76} rx={8} />
              <text x={14} y={26} className="dom-node-name">
                {block.id}
                {!analysis.reachable.includes(block.id) ? ' · 入口不可达' : ''}
              </text>
              <text x={14} y={52}>
                {block.instructions.length
                  ? instructionText(block.instructions[0]).slice(0, 25)
                  : 'Exit / 结构出口'}
              </text>
            </g>
          ))}
        </svg>
      </div>
      {ready && (
        <div className="table-scroll dom-all-sets">
          <table>
            <thead>
              <tr>
                <th>块</th>
                <th>Dom / 必经块</th>
                <th>idom</th>
                <th>DF / 支配边界</th>
              </tr>
            </thead>
            <tbody>
              {graph.blocks.map((block) => (
                <tr key={block.id} className={selected === block.id ? 'highlight-row' : ''}>
                  <td>{block.id}</td>
                  <td>
                    <code>
                      {analysis.reachable.includes(block.id)
                        ? setText(analysis.dominators[block.id])
                        : '入口不可达 / 不定义'}
                    </code>
                  </td>
                  <td>{analysis.immediate[block.id] || '—'}</td>
                  <td>
                    <code>
                      {analysis.reachable.includes(block.id)
                        ? setText(analysis.frontier[block.id])
                        : '—'}
                    </code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <details className="dom-instructions" open>
        <summary>{currentBlock.id} / 原始 IR 指令</summary>
        <div className="code-rows">
          {currentBlock.instructions.length ? (
            currentBlock.instructions.map((instruction, index) => (
              <div className="code-row" key={index}>
                <span>{currentBlock.start + index}</span>
                <code>{instructionText(instruction)}</code>
              </div>
            ))
          ) : (
            <p>结构出口，没有 IR 指令。</p>
          )}
        </div>
      </details>
      {ready && (
        <div className="dom-execution-reference">
          <strong>本次 VM 实际输出 / 仅供对照</strong>
          <code>
            {result.baseline?.output.length
              ? result.baseline.output.slice(-12).map(String).join(', ')
              : '没有输出'}
          </code>
          <p>
            {result.baseline?.limited
              ? '执行达到上限，输出不是完整行为。'
              : result.baseline?.error
                ? `本次执行发生错误：${result.baseline.error.message}`
                : '输出来自原始程序的一次执行，没有参与上面的结构分析。'}
          </p>
        </div>
      )}
      {analysis.traceTruncated && (
        <p className="figure-caption">
          只保留前 240 次块处理的中间回放，最后一步仍包含完整结果；记录截断不会停止分析。
        </p>
      )}
    </div>
  );
}
