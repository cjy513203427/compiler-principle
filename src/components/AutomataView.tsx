import { useEffect, useId, useRef, useState } from 'react';
import {
  AUTOMATA_LIMITS,
  charText,
  nfaListing,
  rangesText,
  type AutomataAnalysis,
  type CharRange,
} from '../compiler/automata';
import '../styles-automata.css';

const setText = (values: number[]) => `{${values.join(', ')}}`;
const cellText = (c: string) => (c === '\n' ? '↵' : charText(c.charCodeAt(0)));
const kindNames = {
  start: '总开始状态',
  rule: '进入规则',
  set: '字符 / 字符集',
  concat: '连接 st',
  alt: '选择 s|t',
  star: '重复 s*',
  plus: '至少一次 s+',
  optional: '可选 s?',
  accept: '标记接受状态',
} as const;
function keepVisible(container: HTMLElement | null, selector: string) {
  const row = container?.querySelector<HTMLElement>(selector);
  if (!container || !row) return;
  if (row.offsetTop < container.scrollTop) container.scrollTop = row.offsetTop - 8;
  else if (row.offsetTop + row.offsetHeight > container.scrollTop + container.clientHeight)
    container.scrollTop = row.offsetTop + row.offsetHeight - container.clientHeight + 8;
}

export function AutomataView({ analysis, step }: { analysis: AutomataAnalysis; step: number }) {
  const { spec, frames, dfa } = analysis;
  const frame = frames[Math.min(step, frames.length - 1)];
  const final = step >= frames.length - 1;
  const phases = [
    { id: 'nfa', name: '① 正则 → NFA', count: analysis.thompson.length },
    { id: 'dfa', name: '② 子集构造 → DFA', count: analysis.subset.length },
    { id: 'scan', name: '③ 最长匹配扫描', count: analysis.scan?.frames.length || 0 },
  ] as const;
  return (
    <div className="automata-view">
      <ol className="auto-phases" aria-label="三个阶段">
        {phases.map((phase) => (
          <li
            key={phase.id}
            className={frame.phase === phase.id ? 'current' : ''}
            aria-current={frame.phase === phase.id ? 'step' : undefined}
          >
            <strong>{phase.name}</strong>
            <span>{phase.count ? `${phase.count} 步` : '未运行'}</span>
          </li>
        ))}
      </ol>
      <div className="auto-counts">
        <span>
          NFA <b>{analysis.nfa.states.length}</b> 个状态
        </span>
        <span>
          DFA <b>{dfa.states.length}</b> 个状态{dfa.complete ? '' : '（已达上限）'}
        </span>
        <span>
          输入划分为 <b>{dfa.classes}</b> 类字符
        </span>
      </div>
      <RuleTable analysis={analysis} />
      {frame.phase === 'nfa' && <ThompsonPanel analysis={analysis} index={frame.index} />}
      {frame.phase === 'dfa' && <SubsetPanel analysis={analysis} index={frame.index} />}
      {frame.phase === 'scan' && <ScanPanel analysis={analysis} index={frame.index} />}
      {final && (
        <FinalPanel
          key={spec.input + spec.rules.map((r) => r.pattern).join()}
          analysis={analysis}
        />
      )}
      {!final && (
        <p className="auto-hint">回放到最后一步，可以查看 DFA 图、转移表、NFA 清单和回溯对照。</p>
      )}
    </div>
  );
}

function RuleTable({ analysis }: { analysis: AutomataAnalysis }) {
  return (
    <div className="table-scroll auto-rules">
      <table>
        <caption className="sr-only">词法规则与优先级</caption>
        <thead>
          <tr>
            <th>优先</th>
            <th>名称</th>
            <th>正则</th>
            <th>提示</th>
          </tr>
        </thead>
        <tbody>
          {analysis.spec.rules.map((rule) => {
            const note = analysis.notes[rule.index];
            return (
              <tr key={rule.name}>
                <td>{rule.index + 1}</td>
                <td>
                  <code>{rule.name}</code>
                </td>
                <td>
                  <code>{rule.pattern}</code>
                </td>
                <td>
                  {[
                    rule.skip && '匹配后丢弃',
                    note.shadowed && '⚠ 被更靠前的规则完全遮蔽，从不胜出',
                    note.emptyMatch && '⚠ 可以匹配空串；空词素不会成为 Token',
                  ]
                    .filter(Boolean)
                    .join('；') || '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function NfaList({
  analysis,
  visibleStep,
  fresh,
}: {
  analysis: AutomataAnalysis;
  visibleStep: number;
  fresh?: number;
}) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => keepVisible(box.current, '.fresh'), [fresh]);
  const rows = nfaListing(analysis.nfa, analysis.spec.rules, visibleStep);
  return (
    <div className="auto-nfa-list" ref={box} tabIndex={0} aria-label="NFA 状态与转换清单，可滚动">
      {rows.map((row) => (
        <div
          key={row.state}
          className={`auto-nfa-row ${row.edges.some((e) => e.step === fresh) || analysis.nfa.states[row.state].step === fresh ? 'fresh' : ''}`}
        >
          <span className="auto-nfa-state">{row.state}</span>
          <div>
            {row.edges.map((edge) => (
              <code key={edge.id} className={edge.step === fresh ? 'fresh-edge' : ''}>
                {edge.label} → {edge.to}
              </code>
            ))}
            {row.accept && <code className="auto-accept">(end) 接受 {row.accept}</code>}
            {!row.edges.length && !row.accept && <code className="auto-muted">（尚无出边）</code>}
          </div>
        </div>
      ))}
    </div>
  );
}

function ThompsonPanel({ analysis, index }: { analysis: AutomataAnalysis; index: number }) {
  const step = analysis.thompson[index];
  const rule = step.rule !== undefined ? analysis.spec.rules[step.rule] : undefined;
  return (
    <section className="auto-card" aria-label="NFA 构造步骤">
      <div className="auto-card-head">
        <span className="auto-kind">{kindNames[step.kind]}</span>
        {rule && <span>规则 {rule.name}</span>}
      </div>
      {step.text && (
        <p>
          正在翻译：<code className="auto-big">{step.text}</code>
        </p>
      )}
      <p className="auto-new">
        本步新增：{step.states.length ? `状态 ${step.states.join('、')}` : '无新状态'}
        {step.edges.length ? ` · ${step.edges.length} 条边` : ''}
      </p>
      <h3>到目前为止的 NFA（原书的清单写法）</h3>
      <NfaList analysis={analysis} visibleStep={index} fresh={index} />
      <p className="auto-legend">粗体为本步新增；ε 边不读字符。</p>
    </section>
  );
}

function SubsetPanel({ analysis, index }: { analysis: AutomataAnalysis; index: number }) {
  const step = analysis.subset[index];
  const { dfa, spec } = analysis;
  const current = dfa.states[step.dfa];
  return (
    <section className="auto-card" aria-label="子集构造步骤">
      <div className="auto-card-head">
        <span className="auto-kind">
          {step.kind === 'start'
            ? '初始状态'
            : step.kind === 'limit'
              ? '达到上限'
              : `处理 D${step.dfa}`}
        </span>
        <span>已发现 {step.known} 个 DFA 状态</span>
      </div>
      <p>
        D{current.id} = <code>{setText(current.nfa)}</code>
        {current.accept !== undefined && (
          <>
            {' '}
            · 接受 <b>{spec.rules[current.accept].name}</b>
          </>
        )}
      </p>
      {step.kind === 'process' && (
        <div className="table-scroll">
          <table className="auto-moves">
            <caption className="sr-only">本状态的 move 与 ε-闭包</caption>
            <thead>
              <tr>
                <th>输入</th>
                <th>move（读字符后）</th>
                <th>ε-闭包 → 目标</th>
              </tr>
            </thead>
            <tbody>
              {step.moves.map((move) => (
                <tr key={move.target + rangesText(move.ranges)}>
                  <td>
                    <code>{rangesText(move.ranges)}</code>
                  </td>
                  <td>
                    <code>{setText(move.move)}</code>
                  </td>
                  <td>
                    <code>{setText(dfa.states[move.target].nfa)}</code> = D{move.target}
                    {move.created && <span className="auto-tag">新</span>}
                  </td>
                </tr>
              ))}
              {!step.moves.length && (
                <tr>
                  <td colSpan={3}>任何输入都无路可走。</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      <h3>DFA 状态表（截至本步）</h3>
      <DfaStateTable analysis={analysis} known={step.known} current={step.dfa} />
    </section>
  );
}

function DfaStateTable({
  analysis,
  known,
  current,
  onSelect,
}: {
  analysis: AutomataAnalysis;
  known: number;
  current?: number;
  onSelect?: (id: number) => void;
}) {
  const { dfa, spec } = analysis;
  return (
    <div className="table-scroll auto-dfa-table">
      <table>
        <caption className="sr-only">DFA 状态与对应的 NFA 状态集合</caption>
        <thead>
          <tr>
            <th>DFA</th>
            <th>NFA 状态集合</th>
            <th>接受</th>
            <th>转移</th>
          </tr>
        </thead>
        <tbody>
          {dfa.states.slice(0, known).map((state) => (
            <tr key={state.id} className={state.id === current ? 'current' : ''}>
              <td>
                {onSelect ? (
                  <button className="text-button" onClick={() => onSelect(state.id)}>
                    D{state.id}
                  </button>
                ) : (
                  `D${state.id}`
                )}
              </td>
              <td>
                <code>{setText(state.nfa)}</code>
              </td>
              <td>
                {state.accept === undefined
                  ? '—'
                  : state.candidates.length > 1
                    ? `${spec.rules[state.accept].name}（也含 ${state.candidates
                        .slice(1)
                        .map((r) => spec.rules[r].name)
                        .join('、')}）`
                    : spec.rules[state.accept].name}
              </td>
              <td>
                {dfa.edges
                  .filter((edge) => edge.from === state.id && edge.to < known)
                  .map((edge) => `${rangesText(edge.ranges)}→D${edge.to}`)
                  .join('  ') || '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function InputStrip({
  analysis,
  tokens,
  tokenStart,
  position,
  acceptEnd,
}: {
  analysis: AutomataAnalysis;
  tokens: number;
  tokenStart: number;
  position: number;
  acceptEnd?: number;
}) {
  const input = analysis.spec.input;
  const owner = new Map<number, number>();
  analysis.scan?.tokens.slice(0, tokens).forEach((token, index) => {
    for (let i = token.start; i < token.end; i++) owner.set(i, index);
  });
  if (!input.length) return <p className="auto-hint">%% 下方的输入为空。</p>;
  return (
    <div className="auto-input" role="group" aria-label="待扫描的输入">
      {[...input].map((c, i) => {
        const token = owner.get(i);
        const done = token !== undefined;
        const skip = done && analysis.scan!.tokens[token].skip;
        const reading = !done && i >= tokenStart && i < position;
        return (
          <span
            key={i}
            className={[
              'auto-cell',
              done ? `token t${token % 2}` : '',
              skip ? 'skip' : '',
              reading ? 'reading' : '',
              i === position - 1 && reading ? 'cursor' : '',
              acceptEnd !== undefined && i === acceptEnd - 1 && reading ? 'accept-mark' : '',
            ].join(' ')}
            title={`位置 ${i}`}
          >
            {cellText(c)}
          </span>
        );
      })}
    </div>
  );
}

function TokenList({ analysis, count }: { analysis: AutomataAnalysis; count: number }) {
  const tokens = analysis.scan?.tokens.slice(0, count) || [];
  return (
    <ol className="auto-tokens" aria-label="已生成的 Token">
      {tokens.map((token, index) => (
        <li key={index} className={token.skip ? 'skip' : ''}>
          <small>{analysis.spec.rules[token.rule].name}</small>
          <code>{[...token.text].map(cellText).join('')}</code>
        </li>
      ))}
      {!tokens.length && <li className="auto-muted">尚未生成 Token</li>}
    </ol>
  );
}

function ScanPanel({ analysis, index }: { analysis: AutomataAnalysis; index: number }) {
  const frame = analysis.scan!.frames[index];
  const { spec } = analysis;
  return (
    <section className="auto-card" aria-label="最长匹配扫描">
      <div className="auto-card-head">
        <span className="auto-kind">
          {frame.kind === 'read'
            ? '向前读'
            : frame.kind === 'emit'
              ? '回退并生成'
              : frame.kind === 'error'
                ? '无法匹配'
                : frame.kind === 'truncated'
                  ? '回放截断'
                  : '扫描完成'}
        </span>
        <span>
          {frame.state !== undefined && frame.kind === 'read' ? `当前 D${frame.state}` : ''}
          {frame.lastAccept
            ? ` · 最近接受：位置 ${frame.lastAccept.end}（${spec.rules[frame.lastAccept.rule].name}）`
            : frame.kind === 'read'
              ? ' · 尚无接受位置'
              : ''}
        </span>
      </div>
      <InputStrip
        analysis={analysis}
        tokens={frame.tokens}
        tokenStart={frame.tokenStart}
        position={
          frame.kind === 'read' || frame.kind === 'error' ? frame.position : frame.tokenStart
        }
        acceptEnd={frame.lastAccept?.end}
      />
      <p className="auto-legend">
        浅色底：本次词素已读部分；下划线：最近接受位置；灰色：skip 丢弃的字符。
      </p>
      {analysis.scan?.error && frame.kind === 'error' && (
        <p className="auto-error" role="status">
          {analysis.scan.error.message}
        </p>
      )}
      <h3>Token 串</h3>
      <TokenList analysis={analysis} count={frame.tokens} />
    </section>
  );
}

function DfaGraph({
  analysis,
  selected,
  onSelect,
}: {
  analysis: AutomataAnalysis;
  selected: number;
  onSelect: (id: number) => void;
}) {
  const { dfa, spec } = analysis;
  const marker = `auto-arrow-${useId().replace(/:/g, '')}`;
  const depth = new Map<number, number>([[0, 0]]);
  const queue = [0];
  while (queue.length) {
    const id = queue.shift()!;
    for (const edge of dfa.edges)
      if (edge.from === id && !depth.has(edge.to)) {
        depth.set(edge.to, depth.get(id)! + 1);
        queue.push(edge.to);
      }
  }
  const columns: number[][] = [];
  for (const state of dfa.states) (columns[depth.get(state.id) ?? 0] ||= []).push(state.id);
  const position = new Map<number, { x: number; y: number }>();
  columns.forEach((column, x) =>
    // Leave room above each node for its self-loop label and below for the rule name.
    column.forEach((id, y) => position.set(id, { x: 70 + x * 200, y: 100 + y * 150 })),
  );
  const width = 150 + (columns.length - 1) * 200;
  const height = 170 + (Math.max(...columns.map((c) => c.length)) - 1) * 150;
  const short = (ranges: CharRange[]) => {
    const text = rangesText(ranges);
    return text.length > 14 ? `${text.slice(0, 13)}…` : text;
  };
  return (
    <div className="auto-graph-scroll" tabIndex={0} aria-label="DFA 状态图，可在图内滚动">
      <svg width={width} height={height} role="group" aria-label="DFA 状态图">
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
        {dfa.edges.map((edge, index) => {
          const a = position.get(edge.from)!;
          const b = position.get(edge.to)!;
          const label = short(edge.ranges);
          if (edge.from === edge.to) {
            return (
              <g key={index} className="auto-edge">
                <path
                  d={`M ${a.x - 12} ${a.y - 24} C ${a.x - 30} ${a.y - 70}, ${a.x + 30} ${a.y - 70}, ${a.x + 12} ${a.y - 24}`}
                  markerEnd={`url(#${marker})`}
                />
                <text x={a.x} y={a.y - 62} textAnchor="middle">
                  {label}
                </text>
                <title>{rangesText(edge.ranges)}</title>
              </g>
            );
          }
          const dx = b.x - a.x,
            dy = b.y - a.y;
          const length = Math.hypot(dx, dy) || 1;
          const nx = -dy / length,
            ny = dx / length;
          const bend = 22;
          const cx = (a.x + b.x) / 2 + nx * bend,
            cy = (a.y + b.y) / 2 + ny * bend;
          const sx = a.x + (dx / length) * 24,
            sy = a.y + (dy / length) * 24;
          const ex = b.x - (dx / length) * 27,
            ey = b.y - (dy / length) * 27;
          return (
            <g key={index} className="auto-edge">
              <path d={`M ${sx} ${sy} Q ${cx} ${cy} ${ex} ${ey}`} markerEnd={`url(#${marker})`} />
              <text x={cx} y={cy - 4} textAnchor="middle">
                {label}
              </text>
              <title>
                D{edge.from} —{rangesText(edge.ranges)}→ D{edge.to}
              </title>
            </g>
          );
        })}
        {dfa.states.map((state) => {
          const p = position.get(state.id)!;
          const choose = () => onSelect(state.id);
          return (
            <g
              key={state.id}
              className={`auto-node ${state.accept !== undefined ? 'accept' : ''} ${selected === state.id ? 'selected' : ''}`}
              transform={`translate(${p.x},${p.y})`}
              role="button"
              tabIndex={0}
              aria-pressed={selected === state.id}
              aria-label={`D${state.id}${state.accept !== undefined ? `，接受 ${spec.rules[state.accept].name}` : ''}`}
              onClick={choose}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  choose();
                }
              }}
            >
              <circle r={24} />
              {state.accept !== undefined && <circle r={19} className="inner" />}
              <text y={5} textAnchor="middle">
                D{state.id}
              </text>
              {state.accept !== undefined && (
                <text y={44} textAnchor="middle" className="auto-node-rule">
                  {spec.rules[state.accept].name}
                </text>
              )}
            </g>
          );
        })}
        <path className="auto-start-arrow" d="M 14 100 L 44 100" markerEnd={`url(#${marker})`} />
      </svg>
    </div>
  );
}

function FinalPanel({ analysis }: { analysis: AutomataAnalysis }) {
  const { dfa, spec, scan } = analysis;
  const [tab, setTab] = useState<'graph' | 'table' | 'nfa' | 'backtrack'>(
    dfa.complete && dfa.states.length <= 20 ? 'graph' : 'table',
  );
  const [selected, setSelected] = useState(0);
  const [token, setToken] = useState(
    Math.max(
      0,
      analysis.comparisons.reduce(
        (best, item, index, all) =>
          item.backtrack.attempts > all[best].backtrack.attempts ? index : best,
        0,
      ),
    ),
  );
  const tabs = [
    { id: 'graph', name: 'DFA 图' },
    { id: 'table', name: 'DFA 状态表' },
    { id: 'nfa', name: 'NFA 清单' },
    { id: 'backtrack', name: 'NFA 回溯对照' },
  ] as const;
  const state = dfa.states[selected];
  const comparison = analysis.comparisons[token];
  return (
    <section className="auto-final" aria-label="最终结果">
      {!dfa.complete && (
        <p className="auto-error" role="status">
          DFA 达到 {AUTOMATA_LIMITS.dfaStates}{' '}
          个状态的上限，构造未完成，因此没有运行扫描。可以删掉一组重复的 (a|b) 再试，或在 DFA
          状态表里观察状态集合怎样成倍增长。
        </p>
      )}
      <div className="auto-tabs" role="group" aria-label="查看最终结构">
        {tabs.map((item) => (
          <button key={item.id} aria-pressed={tab === item.id} onClick={() => setTab(item.id)}>
            {item.name}
          </button>
        ))}
      </div>
      {tab === 'graph' &&
        (dfa.complete && dfa.states.length <= 20 ? (
          <>
            <DfaGraph analysis={analysis} selected={selected} onSelect={setSelected} />
            <div className="auto-selected" aria-live="polite">
              <strong>
                D{state.id}
                {state.accept !== undefined
                  ? ` · 接受 ${spec.rules[state.accept].name}`
                  : ' · 不接受'}
              </strong>
              <p>
                对应 NFA 状态 <code>{setText(state.nfa)}</code>
                {state.candidates.length > 1 &&
                  `。同时含有 ${state.candidates.map((r) => spec.rules[r].name).join('、')} 的接受状态，按规则顺序取 ${spec.rules[state.candidates[0]].name}。`}
              </p>
              <p className="auto-legend">
                双圈为接受状态；没画出的输入表示进入死状态，扫描在此停下。点击状态查看详情。
              </p>
            </div>
          </>
        ) : (
          <p className="auto-hint">状态较多或构造未完成，请查看 DFA 状态表。</p>
        ))}
      {tab === 'table' && (
        <DfaStateTable
          analysis={analysis}
          known={dfa.states.length}
          current={selected}
          onSelect={setSelected}
        />
      )}
      {tab === 'nfa' && <NfaList analysis={analysis} visibleStep={Infinity} />}
      {tab === 'backtrack' &&
        (comparison ? (
          <>
            <p className="auto-hint">
              对每个 Token 的词素，用原书 matchWithNFA
              的思路做整串匹配：按建边顺序深度优先尝试，失败就退回上一个分叉。 DFA
              一个字符只查一次表，“读入”含最长匹配多读、随后退回的字符。
            </p>
            <div className="table-scroll">
              <table className="auto-compare">
                <caption className="sr-only">DFA 读入字符数与 NFA 回溯尝试次数</caption>
                <thead>
                  <tr>
                    <th>词素</th>
                    <th>DFA 结果 / 读入</th>
                    <th>回溯结果 / 尝试次数</th>
                  </tr>
                </thead>
                <tbody>
                  {analysis.comparisons.map((item, index) => {
                    const lexeme = scan!.tokens[item.token];
                    const bt = item.backtrack;
                    return (
                      <tr key={index} className={index === token ? 'current' : ''}>
                        <td>
                          <button
                            className="text-button"
                            aria-pressed={index === token}
                            onClick={() => setToken(index)}
                          >
                            <code>{[...lexeme.text].map(cellText).join('')}</code>
                          </button>
                        </td>
                        <td>
                          {spec.rules[lexeme.rule].name} / {item.dfaReads} 个字符
                        </td>
                        <td>
                          {bt.outcome === 'match'
                            ? `${spec.rules[bt.rule!].name}${bt.rule === lexeme.rule ? ' ✓' : ' ✗'}`
                            : bt.outcome === 'limit'
                              ? '达到上限，未决'
                              : '不匹配'}{' '}
                          / {bt.attempts}
                          {bt.outcome === 'limit' ? '+' : ''} 次
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <h3>
              「{[...scan!.tokens[comparison.token].text].map(cellText).join('')}」的回溯轨迹
              {comparison.backtrack.trace.length < comparison.backtrack.attempts &&
                `（只显示前 ${comparison.backtrack.trace.length} 次）`}
            </h3>
            <ol className="auto-trace" tabIndex={0} aria-label="回溯尝试轨迹，可滚动">
              {comparison.backtrack.trace.map((item, index, all) => (
                <li key={index} style={{ paddingLeft: `${Math.min(item.depth, 24) * 8 + 8}px` }}>
                  {index > 0 && item.depth <= all[index - 1].depth && (
                    <span className="auto-tag back">↩ 回溯</span>
                  )}
                  尝试状态 {item.state}，位置 {item.index}
                  {item.stranded && (
                    <span className="auto-muted"> · 到了接受状态，但还有字符没读</span>
                  )}
                </li>
              ))}
            </ol>
          </>
        ) : (
          <p className="auto-hint">没有生成 Token，暂无可对照的词素。</p>
        ))}
    </section>
  );
}
