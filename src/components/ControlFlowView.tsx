import { useEffect, useRef, useState } from 'react';
import type { Compilation } from '../compiler';
import { instructionText } from '../compiler/ir';
import type { ControlEdge } from '../compiler/cfg';
import { T } from '../i18n';

const edgeLabel = (kind: ControlEdge['kind']) =>
  ({ true: 'true', false: 'false', jump: T('跳转'), next: T('顺序') })[kind];
const WIDE = /[　-鿿＀-￯]/;
/** Estimated width of 14px monospace text (CJK glyphs are square). */
const monoWidth = (text: string) => [...text].reduce((w, c) => w + (WIDE.test(c) ? 14 : 8.4), 0);
/** Estimated width of a 12px label; translations are longer than the Chinese source. */
const labelWidth = (text: string) => [...text].reduce((w, c) => w + (WIDE.test(c) ? 12 : 6.6), 0);
export function ControlFlowView({ result, step }: { result: Compilation; step: number }) {
  const graph = result.cfg!;
  const trace = result.controlTrace!;
  const current = trace[step];
  const state = result.baseline!.steps[current.vmStep];
  const [selected, setSelected] = useState<string>();
  const scroll = useRef<HTMLDivElement>(null);
  const [graphWidth, setGraphWidth] = useState(640);
  const nodeLeft = graphWidth < 500 ? 52 : 110;
  const nodeWidth = graphWidth - nodeLeft * 2;
  const nodeRight = nodeLeft + nodeWidth;
  const center = graphWidth / 2;
  const maxChars = Math.floor((nodeWidth - 34) / 8.4);
  const visitsText = (id: string) => T('经过 {#0} 次', visits.get(id) || 0);
  const moreText = (count: number) => T('查看全部 {#0} 条', count);
  /** “B0 · this step” when it fits beside the visit count; the highlight already marks the block. */
  const blockName = (id: string) => {
    if (current.block !== id) return id;
    const full = T('{#0} · 本步', id);
    return monoWidth(full) + 12 + labelWidth(visitsText(id)) <= nodeWidth - 34 ? full : id;
  };
  useEffect(() => {
    const container = scroll.current;
    if (!container) return;
    const measure = () => setGraphWidth(Math.max(360, Math.min(640, container.clientWidth)));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);
  const indexOf = (id: string) => graph.blocks.findIndex((block) => block.id === id);
  const blockY = (index: number) => 22 + index * 170;
  const visits = new Map<string, number>();
  const edges = new Set<string>();
  trace.slice(1, step + 1).forEach((frame) => {
    visits.set(frame.block, (visits.get(frame.block) || 0) + 1);
    if (frame.edge) edges.add(frame.edge);
  });
  const inspected = graph.blocks.find((block) => block.id === (selected || current.block))!;
  useEffect(() => {
    const container = scroll.current;
    if (!container) return;
    const y = blockY(indexOf(current.block));
    if (y < container.scrollTop || y + 130 > container.scrollTop + container.clientHeight)
      container.scrollTop = Math.max(0, y - 35);
  }, [current.block, graph]);
  return (
    <div className="cfg-view">
      <div className="cfg-summary">
        <div>
          <span>{T('本步执行')}</span>
          <strong>{current.block}</strong>
        </div>
        <span>→</span>
        <div>
          <span>{T('下一基本块')}</span>
          <strong>{current.nextBlock || (result.baseline?.halted ? T('已结束') : T('已停止'))}</strong>
        </div>
        <div className="cfg-visit-total">
          <span>{T('已经过')}</span>
          <strong>{T('{#0} / {#1} 块', visits.size, graph.blocks.length)}</strong>
        </div>
      </div>
      <p className="figure-caption">{T('原始 IR 的控制流图 · 点击方框检查指令 · 小屏可在图内横向滚动')}</p>
      <div ref={scroll} className="cfg-scroll" tabIndex={0} aria-label={T('控制流图，可在图内滚动')}>
        <svg
          className="cfg-graph"
          width={graphWidth}
          height={graph.blocks.length * 170 + 25}
          role="group"
          aria-label={T('基本块与可能的执行路径')}
        >
          <defs>
            <marker
              id="cfg-arrow"
              viewBox="0 0 10 10"
              refX={9}
              refY={5}
              markerWidth={7}
              markerHeight={7}
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke" />
            </marker>
          </defs>
          {graph.edges.map((edge, index) => {
            const from = indexOf(edge.from);
            const to = indexOf(edge.to);
            const start = blockY(from);
            const end = blockY(to);
            const back = to <= from;
            const adjacent = to === from + 1;
            const lane = back ? 12 + (index % 3) * 10 : graphWidth - 12 - (index % 3) * 10;
            const path = adjacent
              ? `M ${center} ${start + 125} L ${center} ${end}`
              : back
                ? `M ${nodeLeft} ${start + 83} L ${lane} ${start + 83} L ${lane} ${end + 45} L ${nodeLeft} ${end + 45}`
                : `M ${nodeRight} ${start + 83} L ${lane} ${start + 83} L ${lane} ${end + 45} L ${nodeRight} ${end + 45}`;
            return (
              <g
                key={edge.id}
                className={`cfg-edge ${current.edge === edge.id ? 'active' : edges.has(edge.id) ? 'visited' : ''} ${back ? 'back-edge' : ''}`}
                data-edge={edge.id}
              >
                <path d={path} markerEnd="url(#cfg-arrow)" />
                <text
                  x={adjacent ? center + 14 : back ? lane + 3 : lane - 3}
                  y={adjacent ? start + 154 : start + 104}
                  textAnchor={!adjacent && !back ? 'end' : 'start'}
                >
                  {back ? (graphWidth < 500 ? T('回边') : T('跳转 / 回边')) : edgeLabel(edge.kind)}
                </text>
                <title>
                  {edge.from} → {edge.to} · {edgeLabel(edge.kind)}
                </title>
              </g>
            );
          })}
          {graph.blocks.map((block, index) => (
            <g
              key={block.id}
              transform={`translate(${nodeLeft},${blockY(index)})`}
              className={`cfg-block ${block.id === current.block ? 'active' : ''} ${visits.has(block.id) ? 'visited' : ''} ${block.id === selected ? 'selected' : ''}`}
              tabIndex={0}
              role="button"
              aria-label={T('检查基本块 {#0}', block.id)}
              onClick={() => setSelected(block.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  setSelected(block.id);
                }
              }}
            >
              <rect width={nodeWidth} height={125} rx={8} />
              <text className="cfg-block-name" x={17} y={27}>
                {blockName(block.id)}
              </text>
              <text className="cfg-block-visits" x={nodeWidth - 17} y={27} textAnchor="end">
                {visitsText(block.id)}
              </text>
              {block.instructions.length ? (
                block.instructions.slice(0, 3).map((instruction, line) => {
                  // The last line shares its row with “show all”, so it leaves room for it.
                  const limit =
                    line === 2 && block.instructions.length > 3
                      ? Math.floor((nodeWidth - 44 - labelWidth(moreText(block.instructions.length))) / 8.4)
                      : maxChars;
                  const text = instructionText(instruction);
                  return (
                    <text className="cfg-instruction" key={line} x={17} y={54 + line * 24}>
                      {text.length > limit ? text.slice(0, limit - 1) + '…' : text}
                    </text>
                  );
                })
              ) : (
                <text className="cfg-instruction" x={17} y={66}>
                  {T('HALT · 程序出口')}
                </text>
              )}
              {block.instructions.length > 3 && (
                <text className="cfg-more" x={nodeWidth - 17} y={111} textAnchor="end">
                  {moreText(block.instructions.length)}
                </text>
              )}
            </g>
          ))}
        </svg>
      </div>
      <div className="cfg-legend">
        <span>{T('粗线：本步选择')}</span>
        <span>{T('虚线：回边')}</span>
        <span>{T('未高亮：本次尚未经过')}</span>
      </div>
      <details className="cfg-inspection" open>
        <summary>{T('{#0} · 完整指令与后继', inspected.id)}</summary>
        <div className="code-rows">
          {inspected.instructions.length ? (
            inspected.instructions.map((instruction, index) => (
              <div className="code-row" key={index}>
                <span>{inspected.start + index}</span>
                <code>{instructionText(instruction)}</code>
              </div>
            ))
          ) : (
            <div className="code-row">
              <code>HALT</code>
            </div>
          )}
        </div>
        <div className="cfg-successors">
          {graph.edges
            .filter((edge) => edge.from === inspected.id)
            .map((edge) => (
              <button key={edge.id} onClick={() => setSelected(edge.to)}>
                {edgeLabel(edge.kind)} → {edge.to}
              </button>
            ))}
          {inspected.id === 'Exit' && <span>{T('程序出口，没有后继块。')}</span>}
        </div>
      </details>
      <div className="view-label">
        <span>{T('本步之后 / 局部变量')}</span>
        <small>{T('字节码快照 #{#0}', current.vmStep)}</small>
      </div>
      <dl className="memory cfg-memory">
        {Object.entries(state.memory)
          .filter(([name]) => name.startsWith('v'))
          .map(([name, value]) => (
            <div key={name}>
              <dt>{name}</dt>
              <dd>{String(value)}</dd>
            </div>
          ))}
      </dl>
      {!Object.keys(state.memory).length && <p className="empty-inline">{T('还没有执行变量写入。')}</p>}
      <div className="output-console">
        <span>{T('stdout / 本次实际输出')}</span>
        <pre>{state.output.length ? state.output.map(String).join('\n') : T('等待 print…')}</pre>
      </div>
      <div className="cfg-route-history">
        <span>{T('实际路径')}</span>
        <code>
          {trace
            .slice(Math.max(1, step - 10), step + 1)
            .map((frame) => frame.block)
            .join(' → ') || T('尚未执行')}
          {step > 11 ? T('（仅显示最近步骤）') : ''}
        </code>
      </div>
    </div>
  );
}
