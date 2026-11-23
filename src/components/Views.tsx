import { useEffect, useRef, useState } from 'react';
import type { Compilation } from '../compiler';
import {
  children,
  nodeLabel,
  type AstNode,
  type Stage,
  type Value,
  type Instruction,
} from '../compiler/model';
import { instructionText } from '../compiler/ir';
import { bytecodeText } from '../compiler/vm';
import { ControlFlowView } from './ControlFlowView';
import { DataflowView } from './DataflowView';
import { DominanceView } from './DominanceView';
import { SsaView } from './SsaView';
import { OutSsaView } from './OutSsaView';
import { RegallocView } from './RegallocView';
import { ScheduleView } from './ScheduleView';
import { RedundancyView } from './RedundancyView';
import type { OptimizationOptions } from '../compiler/model';

const valueText = (value: Value) => String(value);
function revealCurrentRow(container: HTMLDivElement | null) {
  if (!container) return;
  const row = container.querySelector<HTMLDivElement>('.current');
  if (!row) {
    container.scrollTop = 0;
    return;
  }
  if (row.offsetTop < container.scrollTop) container.scrollTop = row.offsetTop;
  else if (row.offsetTop + row.offsetHeight > container.scrollTop + container.clientHeight) {
    container.scrollTop = row.offsetTop + row.offsetHeight - container.clientHeight;
  }
}
export function traceLength(result: Compilation, stage: Stage): number {
  switch (stage) {
    case 'lex':
      return result.lex?.steps.length || 0;
    case 'parse':
      return result.syntax?.steps.length || 0;
    case 'semantic':
      return result.semantic?.steps.length || 0;
    case 'ir':
      return result.ir ? result.ir.length + 1 : 0;
    case 'optimize':
      return result.optimization?.length || 0;
    case 'vm':
      return result.execution?.steps.length || 0;
    case 'cfg':
      return result.controlTrace?.length || 0;
    case 'dataflow':
      return result.dataflow?.steps.length || 0;
    case 'dominance':
      return result.dominance?.steps.length || 0;
    case 'ssa':
      return result.ssa?.steps.length || 0;
    case 'outssa':
      return result.outssa?.frames.length || 0;
    case 'regalloc':
      return result.regalloc?.frames.length || 0;
    case 'schedule':
      return result.schedule?.frames.length || 0;
    case 'cse':
      return result.redundancy?.frames.length || 0;
    case 'automata':
    case 'minimize':
    case 'grammar':
    case 'lr':
    case 'functions':
    case 'gc':
      // These labs read their own input (rules / grammar); see analyzeAutomata and analyzeGrammar.
      return 0;
  }
}
export function traceMessage(result: Compilation, stage: Stage, step: number): string {
  switch (stage) {
    case 'lex':
      return result.lex?.steps[step]?.message || '';
    case 'parse':
      return result.syntax?.steps[step]?.message || '';
    case 'semantic':
      return result.semantic?.steps[step]?.message || '';
    case 'ir':
      return step === 0
        ? '准备后序遍历 AST，依次生成三地址指令。'
        : `生成第 ${step} 条指令：${result.ir?.[step - 1] ? instructionText(result.ir[step - 1]) : ''}`;
    case 'optimize':
      return result.optimization?.[step]?.detail || '';
    case 'vm':
      return result.execution?.steps[step]?.message || '';
    case 'cfg':
      return result.controlTrace?.[step]?.message || '';
    case 'dataflow':
      return result.dataflow?.steps[step]?.message || '';
    case 'dominance':
      return result.dominance?.steps[step]?.message || '';
    case 'ssa':
      return result.ssa?.steps[step]?.message || '';
    case 'outssa':
      return result.outssa?.frames[step]?.message || '';
    case 'regalloc':
      return result.regalloc?.frames[step]?.message || '';
    case 'schedule':
      return result.schedule?.frames[step]?.message || '';
    case 'cse':
      return result.redundancy?.frames[step]?.message || '';
    case 'automata':
    case 'minimize':
    case 'grammar':
    case 'lr':
    case 'functions':
    case 'gc':
      return '';
  }
}
export function AstTree({
  root,
  activeId,
  types,
}: {
  root: AstNode;
  activeId?: number;
  types?: Map<number, string>;
}) {
  const [selected, setSelected] = useState<number | undefined>();
  const treeContainer = useRef<HTMLDivElement>(null);
  const positions: { node: AstNode; x: number; y: number; parent?: number }[] = [];
  const widths = new Map<number, number>();
  function measure(node: AstNode): number {
    const width = Math.max(
      122,
      children(node).reduce((sum, child) => sum + measure(child), 0),
    );
    widths.set(node.id, width);
    return width;
  }
  const width = measure(root) + 40;
  function place(node: AstNode, left: number, depth: number, parent?: number) {
    positions.push({ node, x: left + widths.get(node.id)! / 2, y: 30 + depth * 72, parent });
    let next = left;
    for (const child of children(node)) {
      place(child, next, depth + 1, node.id);
      next += widths.get(child.id)!;
    }
  }
  place(root, 20, 0);
  const height = Math.max(...positions.map((p) => p.y)) + 38;
  const selectedNode = positions.find((p) => p.node.id === selected)?.node;
  const active = positions.find((p) => p.node.id === activeId);
  useEffect(() => {
    const container = treeContainer.current;
    if (!container || !active) return;
    if (
      active.x - 45 < container.scrollLeft ||
      active.x + 45 > container.scrollLeft + container.clientWidth
    ) {
      container.scrollLeft = Math.max(0, active.x - container.clientWidth / 2);
    }
    if (
      active.y - 20 < container.scrollTop ||
      active.y + 30 > container.scrollTop + container.clientHeight
    ) {
      container.scrollTop = Math.max(0, active.y - container.clientHeight / 2);
    }
  }, [activeId, root]);
  return (
    <>
      <div
        ref={treeContainer}
        className="tree-scroll"
        tabIndex={0}
        aria-label="抽象语法树，可横向滚动"
      >
        <svg
          className="ast-tree"
          width={width}
          height={height}
          role="group"
          aria-label="按文法构造的抽象语法树"
        >
          {positions.map((p) => {
            const parent = positions.find((item) => item.node.id === p.parent);
            return (
              parent && (
                <path
                  key={`edge-${p.node.id}`}
                  d={`M ${parent.x} ${parent.y + 16} C ${parent.x} ${parent.y + 40}, ${p.x} ${p.y - 40}, ${p.x} ${p.y - 16}`}
                />
              )
            );
          })}
          {positions.map(({ node, x, y }) => (
            <g
              key={node.id}
              className={`tree-node ${activeId === node.id ? 'active' : ''} ${selected === node.id ? 'selected' : ''}`}
              transform={`translate(${x},${y})`}
              tabIndex={0}
              role="button"
              aria-label={`${nodeLabel(node)}，源码位置 ${node.start + 1} 至 ${node.end}`}
              onClick={() => setSelected(node.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  setSelected(node.id);
                }
              }}
            >
              <rect x={-53} y={-19} width={106} height={38} rx={6} />
              <text textAnchor="middle" dominantBaseline="central">
                {nodeLabel(node).length > 11 ? `${nodeLabel(node).slice(0, 9)}…` : nodeLabel(node)}
              </text>
              <title>
                {nodeLabel(node)} · #{node.id}
                {types?.get(node.id) ? ` · ${types.get(node.id)}` : ''}
              </title>
            </g>
          ))}
        </svg>
      </div>
      <div className="figure-caption">
        {selectedNode ? (
          <>
            <strong>{nodeLabel(selectedNode)}</strong> · 节点 #{selectedNode.id} · 源码区间 [
            {selectedNode.start}, {selectedNode.end})
            {types?.get(selectedNode.id) ? ` · 类型 ${types.get(selectedNode.id)}` : ''}
          </>
        ) : (
          '点击节点查看源码区间。绿色节点对应当前构造步骤，连线表示父子关系。'
        )}
      </div>
    </>
  );
}

function CodeRows({
  instructions,
  active = -1,
  revealed = instructions.length,
}: {
  instructions: Instruction[];
  active?: number;
  revealed?: number;
}) {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => revealCurrentRow(container.current), [active, revealed, instructions]);
  return (
    <div ref={container} className="code-rows" aria-label="三地址代码">
      {instructions.length ? (
        instructions.map((instruction, index) => (
          <div
            key={index}
            className={`code-row ${index === active ? 'current' : ''} ${index >= revealed ? 'unrevealed' : ''}`}
          >
            <span>{String(index).padStart(2, '0')}</span>
            <code>{index >= revealed ? '· · ·' : instructionText(instruction)}</code>
            {index === active && <b aria-label="当前指令">←</b>}
          </div>
        ))
      ) : (
        <p className="empty-inline">没有需要执行的指令。</p>
      )}
    </div>
  );
}
function StateMachine({ state }: { state: string }) {
  const nodes = [
    { state: 'start', x: 55, y: 84, label: '起始' },
    { state: 'identifier', x: 260, y: 35, label: '标识符' },
    { state: 'number', x: 260, y: 115, label: '数字' },
    { state: 'symbol', x: 455, y: 84, label: '符号' },
  ];
  return (
    <svg
      className="state-machine"
      viewBox="0 0 510 175"
      role="img"
      aria-label={`扫描状态示意，当前状态 ${state}`}
    >
      <defs>
        <marker
          id="arrow"
          viewBox="0 0 10 10"
          refX={9}
          refY={5}
          markerWidth={5}
          markerHeight={5}
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" fill="#96a89d" />
        </marker>
      </defs>
      <path className="state-edge" d="M 88 72 L 224 41 M 88 94 L 225 111 M 90 84 L 420 84" />
      <path
        className="state-edge"
        d="M 248 10 C 210 -12 310 -12 276 10 M 248 141 C 210 167 310 167 276 141"
      />
      <text x="141" y="42">
        字母 / _
      </text>
      <text x="141" y="131">
        0–9
      </text>
      <text x="349" y="74">
        运算符 / 分隔符
      </text>
      {nodes.map((node) => (
        <g
          key={node.state}
          className={node.state === state ? 'state active' : 'state'}
          transform={`translate(${node.x}, ${node.y})`}
        >
          <rect x={-35} y={-21} width={70} height={42} rx={21} />
          <text textAnchor="middle" dominantBaseline="central">
            {node.label}
          </text>
        </g>
      ))}
    </svg>
  );
}

export function ResultView({
  stage,
  result,
  source,
  step,
  options,
}: {
  stage: Stage;
  result: Compilation;
  source: string;
  step: number;
  options: OptimizationOptions;
}) {
  const bytecodeContainer = useRef<HTMLDivElement>(null);
  const tokenContainer = useRef<HTMLDivElement>(null);
  useEffect(() => revealCurrentRow(bytecodeContainer.current), [stage, step, result.bytecode]);
  useEffect(() => {
    if (tokenContainer.current)
      tokenContainer.current.scrollTop = tokenContainer.current.scrollHeight;
  }, [stage, step, result.lex]);
  if (!traceLength(result, stage))
    return (
      <div className="blocked-state">
        <span className="blocked-icon">!</span>
        <h3>先修复这段程序</h3>
        <p>
          当前程序在
          {result.diagnostic?.stage === 'lex'
            ? '词法'
            : result.diagnostic?.stage === 'parse'
              ? '语法'
              : '语义'}
          分析阶段被拒绝，尚未生成本阶段的结果。
        </p>
        <p>可以切换到错误所在的实验，或选择基础预设继续观察。</p>
      </div>
    );
  if (stage === 'lex') {
    const current = result.lex!.steps[step];
    const tokens = result.lex!.tokens;
    return (
      <>
        <div className="view-label">
          <span>01 / 字符流</span>
          <small>
            位置 {Math.min(source.length, Math.max(0, current.position + 1))} / {source.length}
          </small>
        </div>
        <pre className="character-stream">
          {Array.from(source).map((char, index) => (
            <span
              key={index}
              className={
                index === current.position
                  ? 'cursor-char'
                  : index < current.position
                    ? 'consumed'
                    : ''
              }
            >
              {char === ' ' ? '·' : char}
            </span>
          )) || '空输入'}
          {current.position === source.length && <span className="cursor-char"> EOF </span>}
        </pre>
        <div className="view-label">
          <span>02 / 扫描状态</span>
          <small>示意图 · 单行注释另行跳过</small>
        </div>
        <div className="diagram-scroll">
          <StateMachine state={current.state} />
        </div>
        <div className="view-label">
          <span>03 / 已生成的 Token</span>
          <small>{current.emitted} 个 / 含 EOF</small>
        </div>
        <div ref={tokenContainer} className="tokens">
          {tokens.slice(0, current.emitted).map((token, index) => (
            <div className={`token token-${token.kind}`} key={index}>
              <code>{token.text}</code>
              <span>{token.kind}</span>
              <small>
                [{token.start}, {token.end})
              </small>
            </div>
          ))}
          {!current.emitted && <p className="empty-inline">扫描器正在等待第一个完整的词素。</p>}
        </div>
      </>
    );
  }
  if (stage === 'parse') {
    const current = result.syntax!.steps[step];
    return (
      <>
        <div className="view-label">
          <span>输入 / Token 串</span>
          <small>已消费 {current.cursor} 个</small>
        </div>
        <div className="token-tape">
          {result.lex!.tokens.map((token, index) => (
            <code
              className={index === current.cursor ? 'active' : index < current.cursor ? 'past' : ''}
              key={index}
            >
              {token.text}
            </code>
          ))}
        </div>
        <div className="view-label">
          <span>输出 / 抽象语法树</span>
          <small>最终结构 + 当前构造节点</small>
        </div>
        <AstTree root={result.syntax!.ast} activeId={current.nodeId} />
        <details className="grammar">
          <summary>本实验使用的表达式文法 EBNF</summary>
          <pre>
            {
              'expression → comparison (("==" | "!=") comparison)*\ncomparison → addition (("<" | "<=" | ">" | ">=") addition)*\naddition   → term (("+" | "-") term)*\nterm       → unary (("*" | "/") unary)*\nunary      → "-" unary | primary\nprimary    → number | bool | id | "(" expression ")"'
            }
          </pre>
        </details>
      </>
    );
  }
  if (stage === 'semantic') {
    const current = result.semantic!.steps[step];
    return (
      <>
        <div className="view-label">
          <span>作用域链 / 从右向左查找</span>
          <small>当前 S{current.scopes.at(-1)}</small>
        </div>
        <div className="scope-chain">
          {current.scopes.map((scope, index) => (
            <span key={scope}>
              {index > 0 && <b>→</b>}
              <code className={index === current.scopes.length - 1 ? 'active' : ''}>
                S{scope} {scope === 0 ? '全局' : '语句块'}
              </code>
            </span>
          ))}
        </div>
        <div className="table-scroll">
          <table>
            <caption>当前可见的符号表条目（内层同名条目优先）</caption>
            <thead>
              <tr>
                <th>变量</th>
                <th>类型</th>
                <th>作用域</th>
                <th>内部名称</th>
              </tr>
            </thead>
            <tbody>
              {current.symbols.map((symbol) => (
                <tr
                  key={symbol.key}
                  className={symbol.key === current.selected ? 'highlight-row' : ''}
                >
                  <td>
                    <code>{symbol.name}</code>
                  </td>
                  <td>{symbol.type}</td>
                  <td>S{symbol.scope}</td>
                  <td>
                    <code>{symbol.key}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!current.symbols.length && <p className="empty-inline">此时还没有可见的变量声明。</p>}
        </div>
        <AstTree
          root={result.syntax!.ast}
          activeId={current.nodeId}
          types={result.semantic!.types}
        />
      </>
    );
  }
  if (stage === 'ir')
    return (
      <>
        <div className="view-label">
          <span>输出 / 三地址代码 TAC</span>
          <small>
            {step} / {result.ir!.length} 条
          </small>
        </div>
        <CodeRows instructions={result.ir!} active={step - 1} revealed={step} />
        <div className="view-label">
          <span>来源 / 对应 AST 节点</span>
          <small>t 为临时结果 · v 为绑定后的变量</small>
        </div>
        <AstTree root={result.syntax!.ast} activeId={result.ir![step - 1]?.nodeId} />
      </>
    );
  if (stage === 'optimize') {
    const current = result.optimization![step];
    const equivalent =
      JSON.stringify(result.execution!.output) === JSON.stringify(result.baseline!.output) &&
      result.execution!.error?.message === result.baseline!.error?.message;
    const inconclusive = result.execution!.limited || result.baseline!.limited;
    return (
      <>
        <div className="optimization-heading">
          <div>
            <small>当前变换</small>
            <h3>{current.title}</h3>
          </div>
          <div className="count">
            <strong>{current.instructions.length}</strong>
            <span>/ {result.ir!.length} 条 IR</span>
          </div>
        </div>
        <div className="comparison">
          <div>
            <div className="view-label">优化前</div>
            <CodeRows instructions={result.ir!} />
          </div>
          <div>
            <div className="view-label">当前阶段</div>
            <CodeRows instructions={current.instructions} />
          </div>
        </div>
        <div className={`equivalence ${equivalent || inconclusive ? '' : 'failed'}`}>
          <b>{inconclusive ? '…' : equivalent ? '✓' : '!'}</b>
          <div>
            <strong>
              {inconclusive
                ? '达到回放上限，暂不能判定行为一致'
                : equivalent
                  ? '两版程序的输出与错误一致'
                  : '发现行为差异'}
            </strong>
            <p>
              {inconclusive
                ? '以下是暂停前的输出前缀。原始输出'
                : '最终优化结果已实际执行。原始输出'}{' '}
              [{result.baseline!.output.slice(-30).map(valueText).join(', ')}] → 优化输出 [
              {result.execution!.output.slice(-30).map(valueText).join(', ')}]{' '}
              {result.execution!.error && `· 运行时报告：${result.execution!.error.message}`}
            </p>
          </div>
        </div>
        <p className="figure-caption">
          仅比较本次输入的输出和错误；条数不是运行时间，也不是通用的语义等价证明。
        </p>
      </>
    );
  }
  if (stage === 'cfg') return <ControlFlowView result={result} step={step} />;
  if (stage === 'dominance') return <DominanceView result={result} step={step} />;
  if (stage === 'ssa') return <SsaView result={result} step={step} />;
  if (stage === 'outssa') return <OutSsaView result={result} step={step} />;
  if (stage === 'regalloc') return <RegallocView result={result} step={step} />;
  if (stage === 'schedule') return <ScheduleView result={result} step={step} />;
  if (stage === 'cse') return <RedundancyView result={result} step={step} />;
  if (stage === 'dataflow')
    return <DataflowView result={result} step={step} source={source} options={options} />;
  const current = result.execution!.steps[step];
  return (
    <>
      <div className="vm-grid">
        <div>
          <div className="view-label">
            <span>字节码</span>
            <small>下一 PC = {current.nextPc}</small>
          </div>
          <div ref={bytecodeContainer} className="code-rows bytecode">
            {result.bytecode!.map((instruction, index) => (
              <div className={`code-row ${index === current.pc ? 'current' : ''}`} key={index}>
                <span>{String(index).padStart(2, '0')}</span>
                <code>{bytecodeText(instruction)}</code>
                {index === current.pc && <b>←</b>}
              </div>
            ))}
          </div>
        </div>
        <div>
          <div className="view-label">
            <span>操作数栈</span>
            <small>栈顶 ↑ · {current.stack.length} 项</small>
          </div>
          <div className="operand-stack">
            {[...current.stack].reverse().map((value, index) => (
              <div className="stack-value" key={index}>
                {valueText(value)}
              </div>
            ))}
            {!current.stack.length && <span>空栈</span>}
            <div className="stack-base" />
          </div>
          <div className="view-label">局部变量表</div>
          <dl className="memory">
            {Object.entries(current.memory).map(([name, value]) => (
              <div key={name}>
                <dt>{name}</dt>
                <dd>{valueText(value)}</dd>
              </div>
            ))}
          </dl>
          {!Object.keys(current.memory).length && <p className="empty-inline">尚未写入局部变量</p>}
        </div>
      </div>
      <div className="output-console">
        <span>stdout</span>
        <pre>
          {current.output.length ? current.output.map(valueText).join('\n') : '等待 print…'}
        </pre>
      </div>
    </>
  );
}
