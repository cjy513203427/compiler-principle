import { Fragment } from 'react';
import {
  END,
  EPSILON,
  productionText,
  type GrammarAnalysis,
  type SetMap,
  type TreeNode,
} from '../compiler/grammar';
import { CodeBlock } from './CodeBlock';
import '../styles-grammar.css';

const phases = [
  {
    id: 'first',
    name: '① FIRST',
    intro:
      '先算每个非终结符“可能以哪些 Token 开头”。一轮轮扫描产生式，能借的就借过来，直到不再变化。',
  },
  {
    id: 'follow',
    name: '② FOLLOW',
    intro: '再算每个非终结符“后面可能紧跟哪些 Token”。能为空的写法，要靠它来判断什么时候该结束。',
  },
  {
    id: 'table',
    name: '③ 分析表',
    intro: '把前两步合成一张表：某一行（非终结符）遇到某一列（下一个 Token）时，该用哪条产生式。',
  },
  {
    id: 'parse',
    name: '④ 用表解析',
    intro: '拿着表解析输入：栈顶是非终结符就查表、展开；栈顶是 Token 就和输入对一对。',
  },
] as const;
const label = (id: number) => `P${id + 1}`;
const list = (values: string[] = []) => (values.length ? values.join('  ') : '∅');

export function GrammarView({
  analysis,
  step,
  onApply,
}: {
  analysis: GrammarAnalysis;
  step: number;
  onApply: (source: string) => void;
}) {
  const { frames, spec } = analysis;
  const frame = frames[Math.min(step, frames.length - 1)];
  const final = step >= frames.length - 1;
  const current =
    frame.phase === 'first'
      ? analysis.firstSteps[frame.index]
      : frame.phase === 'follow'
        ? analysis.followSteps[frame.index]
        : undefined;
  const tableStep = frame.phase === 'table' ? analysis.tableSteps[frame.index] : undefined;
  const parseStep = frame.phase === 'parse' ? analysis.parse!.steps[frame.index] : undefined;
  const activeProduction = current?.production ?? tableStep?.production ?? parseStep?.production;
  const phase = phases.find((p) => p.id === frame.phase)!;
  return (
    <div className="grammar-view">
      <ol className="g-phases" aria-label="四个阶段">
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
      <ProductionList analysis={analysis} active={activeProduction} />
      <Warnings analysis={analysis} onApply={onApply} />
      {(frame.phase === 'first' || frame.phase === 'follow') && current && (
        <section
          className="g-card"
          aria-label={`${frame.phase === 'first' ? 'FIRST' : 'FOLLOW'} 集合`}
        >
          <div className="g-card-head">
            <strong>{current.round ? `第 ${current.round} 轮` : '准备'}</strong>
            {current.target && current.added.length > 0 && (
              <span>
                {frame.phase === 'first' ? 'FIRST' : 'FOLLOW'}({current.target}) 新增{' '}
                <b>{current.added.join('  ')}</b>
              </span>
            )}
          </div>
          <SetTable
            analysis={analysis}
            first={frame.phase === 'first' ? current.sets : analysis.first}
            follow={frame.phase === 'follow' ? current.sets : undefined}
            changed={current.target}
            added={current.added}
          />
        </section>
      )}
      {frame.phase === 'table' && (
        <section className="g-card" aria-label="LL(1) 分析表">
          <div className="g-card-head">
            <strong>{tableStep ? `填入 ${label(tableStep.production)}` : '分析表填好了'}</strong>
            <span>行：非终结符 · 列：下一个 Token · 格子：该用的产生式</span>
          </div>
          <SetTable analysis={analysis} first={analysis.first} follow={analysis.follow} />
          <ParseTable
            analysis={analysis}
            upto={tableStep ? tableStep.production : Infinity}
            highlight={tableStep?.production}
          />
          {!tableStep && <Conflicts analysis={analysis} />}
        </section>
      )}
      {frame.phase === 'parse' && parseStep && (
        <section className="g-card" aria-label="表驱动解析">
          <div className="g-card-head">
            <strong>
              {parseStep.kind === 'expand'
                ? '查表展开'
                : parseStep.kind === 'match'
                  ? '匹配 Token'
                  : parseStep.kind === 'accept'
                    ? '解析成功'
                    : parseStep.kind === 'error'
                      ? '语法错误'
                      : '准备'}
            </strong>
            <span>
              已读 {parseStep.position} / {spec.input.length} 个 Token
            </span>
          </div>
          <div className="g-stack-row">
            <div>
              <h3>栈（右端是栈顶）</h3>
              <div className="g-stack" aria-label="解析栈">
                {parseStep.stack.map((symbol, index) => (
                  <code key={index} className={index === parseStep.stack.length - 1 ? 'top' : ''}>
                    {symbol}
                  </code>
                ))}
              </div>
            </div>
            <div>
              <h3>输入</h3>
              <div className="g-input" aria-label="输入 Token">
                {[...spec.input, { type: END, text: END }].map((token, index) => (
                  <span
                    key={index}
                    className={
                      index < parseStep.position
                        ? 'read'
                        : index === parseStep.position
                          ? 'next'
                          : ''
                    }
                  >
                    <code>{token.text}</code>
                    {token.type !== token.text && <small>{token.type}</small>}
                  </span>
                ))}
              </div>
            </div>
          </div>
          {parseStep.kind === 'error' && (
            <p className="g-error" role="status">
              {analysis.parse!.error}
            </p>
          )}
          <h3>解析树（随步骤长出来）</h3>
          <ParseTree nodes={analysis.parse!.nodes} step={frame.index} active={parseStep.node} />
          <details className="g-details" open={final}>
            <summary>查看分析表</summary>
            <ParseTable
              analysis={analysis}
              upto={Infinity}
              used={
                parseStep.kind === 'expand'
                  ? {
                      row: analysis.spec.grammar.productions[parseStep.production!].lhs,
                      column: spec.input[parseStep.position]?.type ?? END,
                    }
                  : undefined
              }
            />
          </details>
        </section>
      )}
      {!final && <p className="g-hint">回放到最后一步，可以看到完整的分析表和解析树。</p>}
    </div>
  );
}

function ProductionList({ analysis, active }: { analysis: GrammarAnalysis; active?: number }) {
  const { grammar } = analysis.spec;
  return (
    <ol className="g-productions" aria-label="产生式">
      {grammar.productions.map((p) => (
        <li key={p.id} className={p.id === active ? 'active' : ''}>
          <span>{label(p.id)}</span>
          <code>
            <b>{p.lhs}</b> → {p.rhs.length ? p.rhs.join(' ') : EPSILON}
          </code>
        </li>
      ))}
      <li className="g-legend">
        开始符号 <code>{grammar.start}</code> · 终结符 <code>{grammar.terminals.join(' ')}</code>
      </li>
    </ol>
  );
}

function Warnings({
  analysis,
  onApply,
}: {
  analysis: GrammarAnalysis;
  onApply: (source: string) => void;
}) {
  if (!analysis.leftRecursion.length && !analysis.notes.length) return null;
  return (
    <div className="g-warnings">
      {analysis.leftRecursion.map((item) => (
        <section
          key={item.nonterminal}
          className="g-warning"
          aria-label={`${item.nonterminal} 的左递归`}
        >
          <strong>
            {item.nonterminal} 是{item.direct ? '' : '间接'}左递归：{item.path.join(' → ')}
          </strong>
          <p>
            递归下降解析 {item.nonterminal} 时，第一件事又是解析 {item.path[1]}
            {item.direct ? '' : `，绕一圈又回到 ${item.nonterminal}`}，一个 Token 都没读：
          </p>
          <CodeBlock
            className="g-chain"
            language="c"
            title="调用栈"
            label={`${item.nonterminal} 的递归调用链`}
            code={`${Array.from({ length: 4 }, () => item.path.slice(0, -1))
              .flat()
              .map((name, index) => `${'  '.repeat(Math.min(index, 6))}解析 ${name}()`)
              .join('\n')}\n// ……一个 Token 都没读，一直往下钻，停不下来`}
          />
        </section>
      ))}
      {analysis.rewrite && (
        <div className="g-rewrite">
          <p>可以按标准办法改写：A → A α | β 变成 A → β A′，A′ → α A′ | ε。</p>
          <CodeBlock code={analysis.rewrite} language="grammar" title="改写后.ll" />
          <button
            className="button secondary"
            onClick={() =>
              onApply(`${analysis.rewrite}\n%%\n${analysis.spec.inputText.replace(/^\n/, '')}`)
            }
          >
            用改写后的文法重新分析
          </button>
        </div>
      )}
      {analysis.leftRecursion.length > 0 && !analysis.rewrite && (
        <p className="g-hint">
          这里有间接左递归，需要先把规则代入合并，再按直接左递归改写；本实验只自动改写直接左递归。
        </p>
      )}
      {analysis.notes.map((note) => (
        <p key={note.symbol + note.kind} className="g-hint">
          {note.message}
        </p>
      ))}
    </div>
  );
}

function SetTable({
  analysis,
  first,
  follow,
  changed,
  added = [],
}: {
  analysis: GrammarAnalysis;
  first: SetMap;
  follow?: SetMap;
  changed?: string;
  added?: string[];
}) {
  const cell = (values: string[], name: string) =>
    values.length
      ? values.map((v) => (
          <Fragment key={v}>
            <code className={name === changed && added.includes(v) ? 'fresh' : ''}>{v}</code>{' '}
          </Fragment>
        ))
      : '∅';
  return (
    <div className="table-scroll">
      <table className="g-sets">
        <caption className="sr-only">各非终结符的集合</caption>
        <thead>
          <tr>
            <th>非终结符</th>
            <th>FIRST</th>
            {follow && <th>FOLLOW</th>}
          </tr>
        </thead>
        <tbody>
          {analysis.spec.grammar.nonterminals.map((n) => (
            <tr key={n} className={n === changed ? 'current' : ''}>
              <td>
                <code>{n}</code>
              </td>
              <td>{follow ? list(first[n]) : cell(first[n], n)}</td>
              {follow && <td>{cell(follow[n], n)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ParseTable({
  analysis,
  upto,
  highlight,
  used,
}: {
  analysis: GrammarAnalysis;
  upto: number;
  highlight?: number;
  used?: { row: string; column: string };
}) {
  const { grammar } = analysis.spec;
  const columns = [...grammar.terminals, END];
  return (
    <div className="table-scroll">
      <table className="g-table">
        <caption className="sr-only">LL(1) 分析表</caption>
        <thead>
          <tr>
            <th />
            {columns.map((c) => (
              <th key={c}>
                <code>{c}</code>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {grammar.nonterminals.map((n) => (
            <tr key={n}>
              <th>
                <code>{n}</code>
              </th>
              {columns.map((c) => {
                const entries = (analysis.table[n][c] || []).filter((e) => e.production <= upto);
                const conflict = entries.length > 1;
                const isUsed = used?.row === n && used.column === c;
                return (
                  <td
                    key={c}
                    className={[
                      conflict ? 'conflict' : '',
                      entries.some((e) => e.production === highlight) ? 'fresh' : '',
                      isUsed ? 'used' : '',
                    ].join(' ')}
                    title={entries
                      .map((e) => productionText(grammar.productions[e.production]))
                      .join('\n')}
                  >
                    {entries.map((e) => (
                      <span key={e.production}>
                        {label(e.production)}
                        {e.via === 'follow' && <small>F</small>}
                      </span>
                    ))}
                    {conflict && <b className="sr-only">冲突</b>}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="g-legend">
        P 编号对应上方产生式；小字 F 表示这一格因为 FOLLOW 填入（右边能为空）。红色格子是冲突。
      </p>
    </div>
  );
}

function Conflicts({ analysis }: { analysis: GrammarAnalysis }) {
  const { grammar } = analysis.spec;
  if (!analysis.conflicts.length)
    return (
      <p className="g-ok">
        每个格子最多一条产生式：这是一个 LL(1) 文法，可以只看下一个 Token 解析。
      </p>
    );
  return (
    <div className="g-conflicts" role="status">
      <strong>发现 {analysis.conflicts.length} 处冲突，不能只靠下一个 Token 决定</strong>
      <ul>
        {analysis.conflicts.map((c) => (
          <li key={c.nonterminal + c.terminal}>
            <code>{c.nonterminal}</code> 遇到 <code>{c.terminal}</code> 时，
            {c.productions.map((id) => productionText(grammar.productions[id])).join(' 和 ')}{' '}
            都可以。
            {c.kind === 'FIRST/FIRST'
              ? ' 它们的开头相同（FIRST/FIRST 冲突）。'
              : ' 其中一条能为空，而这个 Token 又能跟在后面（FIRST/FOLLOW 冲突）。'}
          </li>
        ))}
      </ul>
      <p>
        {analysis.leftRecursion.length
          ? '原因是左递归：先按上面的建议改写文法。'
          : '如果是几种写法开头相同，可以把共同的开头提出来，例如 stmt -> Id rest，rest -> = Num ; | ( ) ;。'}
      </p>
    </div>
  );
}

function ParseTree({ nodes, step, active }: { nodes: TreeNode[]; step: number; active?: number }) {
  const render = (node: TreeNode) => {
    const children = node.children
      .map((id) => nodes[id])
      .filter((child) => child.createdAt <= step);
    const matched = node.matchedAt !== undefined && node.matchedAt <= step;
    return (
      <li key={node.id}>
        <span
          className={[
            'g-node',
            node.symbol === EPSILON ? 'eps' : '',
            node.text !== undefined ? 'leaf' : '',
            matched ? 'matched' : '',
            node.id === active ? 'active' : '',
          ].join(' ')}
        >
          {node.symbol}
          {matched && node.text !== node.symbol && <small>「{node.text}」</small>}
        </span>
        {children.length > 0 && <ul>{children.map(render)}</ul>}
      </li>
    );
  };
  return (
    <ul className="g-tree" aria-label="解析树">
      {render(nodes[0])}
    </ul>
  );
}
