import { END, EPSILON } from '../compiler/grammar';
import {
  AUGMENTED,
  actionText,
  itemText,
  type LrAnalysis,
  type LrNode,
  type StackEntry,
} from '../compiler/lr';
import { CodeBlock } from './CodeBlock';
import '../styles-grammar.css';

const phases = [
  {
    id: 'items',
    name: '① 项目集',
    intro:
      '先算出所有“状态”：每个状态是一组带点的产生式，点表示读到了哪里。点后面是谁，就按谁往下一个状态走。',
  },
  {
    id: 'table',
    name: '② ACTION / GOTO',
    intro:
      '把状态整理成两张表：遇到 Token 时移进还是规约（ACTION），规约出一个名字后转到哪里（GOTO）。',
  },
  {
    id: 'parse',
    name: '③ 移进 / 规约',
    intro:
      '拿着表解析：读 Token 就移进，栈顶凑齐一条产生式的右边、且下一个 Token 合适时就规约，小块慢慢拼成大树。',
  },
] as const;

export function LrView({ analysis, step }: { analysis: LrAnalysis; step: number }) {
  const { frames } = analysis;
  const frame = frames[Math.min(step, frames.length - 1)];
  const final = step >= frames.length - 1;
  const phase = phases.find((p) => p.id === frame.phase)!;
  const parseStep = frame.phase === 'parse' ? analysis.parse!.steps[frame.index] : undefined;
  const activeProduction = parseStep?.production;
  return (
    <div className="grammar-view lr-view">
      <ol className="g-phases lr-phases" aria-label="三个阶段">
        {phases.map((item) => (
          <li
            key={item.id}
            className={frame.phase === item.id ? 'current' : ''}
            aria-current={frame.phase === item.id ? 'step' : undefined}
          >
            {item.name}
          </li>
        ))}
      </ol>
      <p className="g-intro">{phase.intro}</p>
      <ol className="g-productions" aria-label="产生式（含增广的开始产生式）">
        {analysis.productions.map((p) => (
          <li key={p.id} className={p.id === activeProduction ? 'active' : ''}>
            <span>r{p.id}</span>
            <code>
              <b>{p.lhs}</b> → {p.rhs.length ? p.rhs.join(' ') : EPSILON}
            </code>
          </li>
        ))}
        <li className="g-legend">
          r0 是自动加上的 {AUGMENTED} → {analysis.spec.grammar.start}：拼出它就表示整段输入解析完。
        </li>
      </ol>
      {frame.phase === 'items' && <ItemsPanel analysis={analysis} index={frame.index} />}
      {frame.phase === 'table' && (
        <section className="g-card" aria-label="ACTION / GOTO 表">
          <div className="g-card-head">
            <strong>
              {frame.index < analysis.tableSteps.length
                ? `填写状态 ${frame.index} 这一行`
                : '表填好了'}
            </strong>
            <span>s = 移进并转到该状态 · r = 按该产生式规约 · acc = 接受</span>
          </div>
          <LrTable
            analysis={analysis}
            upto={frame.index < analysis.tableSteps.length ? frame.index : Infinity}
            highlightRow={frame.index}
          />
          {frame.index >= analysis.tableSteps.length && <LrConflicts analysis={analysis} />}
        </section>
      )}
      {frame.phase === 'parse' && parseStep && (
        <section className="g-card" aria-label="移进规约解析">
          <div className="g-card-head">
            <strong>
              {
                {
                  start: '准备',
                  shift: '移进',
                  reduce: '规约',
                  accept: '接受',
                  error: '语法错误',
                }[parseStep.kind]
              }
            </strong>
            <span>
              已读 {parseStep.position} / {analysis.spec.input.length} 个 Token
            </span>
          </div>
          <h3>工作区（栈，右端是栈顶；小字是状态号）</h3>
          <Workspace
            stack={parseStep.stack}
            nodes={analysis.parse!.nodes}
            step={frame.index}
            fresh={parseStep.kind === 'reduce' || parseStep.kind === 'shift'}
          />
          <h3>输入</h3>
          <div className="g-input" aria-label="输入 Token">
            {[...analysis.spec.input, { type: END, text: END }].map((token, index) => (
              <span
                key={index}
                className={
                  index < parseStep.position ? 'read' : index === parseStep.position ? 'next' : ''
                }
              >
                <code>{token.text}</code>
                {token.type !== token.text && <small>{token.type}</small>}
              </span>
            ))}
          </div>
          {parseStep.kind === 'error' && (
            <p className="g-error" role="status">
              {analysis.parse!.error}
            </p>
          )}
          {parseStep.kind === 'accept' && analysis.parse!.derivation.length > 0 && (
            <>
              <h3>最右推导（把规约倒过来读）</h3>
              <CodeBlock
                language="grammar"
                title="rightmost.txt"
                label="最右推导"
                code={analysis
                  .parse!.derivation.map(
                    (form, index) => `${index ? '⇒ ' : '  '}${form.join(' ') || EPSILON}`,
                  )
                  .join('\n')}
              />
            </>
          )}
          <details className="g-details" open={final}>
            <summary>查看 ACTION / GOTO 表</summary>
            <LrTable analysis={analysis} upto={Infinity} used={parseStep.cell} />
          </details>
        </section>
      )}
      {!final && <p className="g-hint">回放到最后一步，可以看到完整的表、拼好的树和最右推导。</p>}
    </div>
  );
}

function ItemsPanel({ analysis, index }: { analysis: LrAnalysis; index: number }) {
  const { productions, states } = analysis;
  const step = analysis.itemSteps[index];
  const state = states[step.state];
  const known =
    Math.max(...analysis.itemSteps.slice(0, index + 1).flatMap((s) => [s.state, ...s.created])) + 1;
  return (
    <section className="g-card" aria-label="LR(0) 项目集">
      <div className="g-card-head">
        <strong>状态 {state.id}</strong>
        <span>已发现 {known} 个状态</span>
      </div>
      <ul className="lr-items" aria-label={`状态 ${state.id} 的项目`}>
        {state.kernel.map((item) => (
          <li key={`${item.production}.${item.dot}`}>
            <code>{itemText(productions, item)}</code>
            <small>
              {state.from ? `由状态 ${state.from.state} 读入 ${state.from.symbol} 而来` : '起点'}
            </small>
          </li>
        ))}
        {state.closure.map(({ item, because }) => (
          <li key={`${item.production}.${item.dot}`} className="closure">
            <code>{itemText(productions, item)}</code>
            <small>闭包：点后面是 {because}</small>
          </li>
        ))}
      </ul>
      <h3>从这个状态出发</h3>
      <div className="lr-transitions">
        {state.transitions.length ? (
          state.transitions.map((t) => (
            <span key={t.symbol} className={step.created.includes(t.target) ? 'new' : ''}>
              读入 <code>{t.symbol}</code> → 状态 {t.target}
              {step.created.includes(t.target) && <b>新</b>}
            </span>
          ))
        ) : (
          <span>点都在末尾，没有可以读入的符号，这里只能规约。</span>
        )}
      </div>
      <details className="g-details">
        <summary>已发现的全部状态</summary>
        <div className="table-scroll">
          <table className="lr-state-list">
            <caption className="sr-only">已发现的 LR(0) 状态</caption>
            <thead>
              <tr>
                <th>状态</th>
                <th>核心项目</th>
              </tr>
            </thead>
            <tbody>
              {states.slice(0, known).map((s) => (
                <tr key={s.id} className={s.id === state.id ? 'current' : ''}>
                  <td>{s.id}</td>
                  <td>
                    {s.kernel.map((item) => (
                      <code key={`${item.production}.${item.dot}`}>
                        {itemText(productions, item)}
                      </code>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}

function LrTable({
  analysis,
  upto,
  highlightRow,
  used,
}: {
  analysis: LrAnalysis;
  upto: number;
  highlightRow?: number;
  used?: { state: number; terminal: string };
}) {
  const { grammar } = analysis.spec;
  const terminals = [...grammar.terminals, END];
  return (
    <div className="table-scroll">
      <table className="g-table lr-table">
        <caption className="sr-only">SLR(1) ACTION 与 GOTO 表</caption>
        <thead>
          <tr>
            <th rowSpan={2}>状态</th>
            <th colSpan={terminals.length}>ACTION（遇到 Token）</th>
            <th colSpan={grammar.nonterminals.length}>GOTO（规约出名字后）</th>
          </tr>
          <tr>
            {terminals.map((t) => (
              <th key={t}>
                <code>{t}</code>
              </th>
            ))}
            {grammar.nonterminals.map((n) => (
              <th key={n}>
                <code>{n}</code>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {analysis.states.map((state) => {
            const visible = state.id <= upto;
            return (
              <tr key={state.id} className={state.id === highlightRow ? 'current' : ''}>
                <th>{state.id}</th>
                {terminals.map((t) => {
                  const actions = visible ? analysis.action[state.id][t] || [] : [];
                  return (
                    <td
                      key={t}
                      className={[
                        actions.length > 1 ? 'conflict' : '',
                        used?.state === state.id && used.terminal === t ? 'used' : '',
                      ].join(' ')}
                    >
                      {actions.map(actionText).join(' / ')}
                    </td>
                  );
                })}
                {grammar.nonterminals.map((n) => (
                  <td key={n}>{visible ? (analysis.goto[state.id][n] ?? '') : ''}</td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="g-legend">r 后面的编号对应上方 r0、r1……；红色格子是冲突，同一格有两个动作。</p>
    </div>
  );
}

function LrConflicts({ analysis }: { analysis: LrAnalysis }) {
  const { productions } = analysis;
  if (!analysis.conflicts.length)
    return (
      <p className="g-ok">
        每个格子最多一个动作：这个文法是 SLR(1) 的，可以按表一路移进、规约，不用回溯。
      </p>
    );
  const describe = (a: (typeof analysis.conflicts)[number]['actions'][number]) =>
    a.kind === 'shift'
      ? `移进并转到状态 ${a.target}`
      : a.kind === 'reduce'
        ? `按 ${productions[a.production].lhs} → ${productions[a.production].rhs.join(' ') || EPSILON} 规约`
        : '接受';
  return (
    <div className="g-conflicts" role="status">
      <strong>发现 {analysis.conflicts.length} 处冲突</strong>
      <ul>
        {analysis.conflicts.map((c) => (
          <li key={`${c.state}-${c.terminal}`}>
            状态 {c.state} 遇到 <code>{c.terminal}</code> 时，可以
            {c.actions.map(describe).join('，也可以')}（{c.kind}冲突）。
          </li>
        ))}
      </ul>
      <p>
        {analysis.conflicts.some((c) => c.kind === '移进/规约')
          ? '移进/规约冲突常见于有歧义的文法：同一串 Token 能拼成两种树。改写文法（例如按优先级分层），或给运算符规定结合性，就能消除。'
          : '规约/规约冲突说明同一串 Token 能合成两个不同的名字，而下一个 Token 又分不出来，需要合并或改写这两条规则。'}
      </p>
    </div>
  );
}

function Workspace({
  stack,
  nodes,
  step,
  fresh,
}: {
  stack: StackEntry[];
  nodes: LrNode[];
  step: number;
  fresh: boolean;
}) {
  const render = (id: number) => {
    const node = nodes[id];
    return (
      <li key={id}>
        <span
          className={[
            'g-node',
            node.symbol === EPSILON ? 'eps' : '',
            node.text !== undefined ? 'leaf matched' : '',
          ].join(' ')}
        >
          {node.symbol}
          {node.text !== undefined && node.text !== node.symbol && <small>「{node.text}」</small>}
        </span>
        {node.children.length > 0 && <ul>{node.children.map(render)}</ul>}
      </li>
    );
  };
  return (
    <div className="lr-workspace" aria-label="工作区">
      {stack.map((entry, index) => (
        <div key={index} className={`lr-entry ${fresh && index === stack.length - 1 ? 'top' : ''}`}>
          <span className="lr-state">{entry.state}</span>
          {entry.node !== undefined && <ul className="g-tree lr-piece">{render(entry.node)}</ul>}
          {entry.node !== undefined && nodes[entry.node].createdAt === step && (
            <span className="sr-only">本步新放入</span>
          )}
        </div>
      ))}
    </div>
  );
}
