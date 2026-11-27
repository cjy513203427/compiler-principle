import { useState } from 'react';
import type { Compilation, OptimizationOptions } from '../compiler';
import { factText } from '../compiler/dataflow';
import { instructionText } from '../compiler/ir';
import { shareUrl } from '../state';
import { T } from '../i18n';

export function DataflowView({
  result,
  step,
  source,
  options,
}: {
  result: Compilation;
  step: number;
  source: string;
  options: OptimizationOptions;
}) {
  const analysis = result.dataflow!;
  const frame = analysis.steps[step];
  const final = frame.kind === 'complete';
  const [selected, setSelected] = useState(
    [...analysis.graph.blocks]
      .reverse()
      .find((block) => block.instructions.some((instruction) => instruction.op === 'print'))?.id ||
      analysis.graph.blocks[0].id,
  );
  const [showTemps, setShowTemps] = useState(false);
  const blockId = final ? selected : frame.block;
  const block = analysis.graph.blocks.find((item) => item.id === blockId)!;
  const facts = final ? analysis.blocks[blockId] : frame;
  const enabled = new Set(frame.enabledEdges);
  const reachable = final ? analysis.blocks[blockId].reachable : true;
  const variables = analysis.variables.filter((name) => showTemps || name.startsWith('v'));
  const predecessors = final
    ? analysis.graph.edges
        .filter((edge) => edge.to === blockId)
        .map((edge) => ({
          block: edge.from,
          edge: edge.id,
          enabled: enabled.has(edge.id),
          output: analysis.blocks[edge.from].output,
        }))
    : frame.predecessors;
  const inconclusive = result.execution!.limited || result.baseline!.limited;
  const equivalent =
    JSON.stringify(result.execution!.output) === JSON.stringify(result.baseline!.output) &&
    result.execution!.error?.message === result.baseline!.error?.message;
  return (
    <div className="dataflow-view">
      <div className="dataflow-domain" aria-label={T('常量分析的三层信息')}>
        <div>
          <b>⊥</b>
          <span>{T('尚无信息')}</span>
        </div>
        <i>→</i>
        <div>
          <b>c</b>
          <span>{T('一个确定常量')}</span>
        </div>
        <i>→</i>
        <div>
          <b>⊤</b>
          <span>{T('无法确定唯一常量')}</span>
        </div>
      </div>
      <div className="dataflow-heading">
        <div>
          <span>{final ? T('最终分析结果') : T('迭代回放 · 第 {#0} 轮', frame.iteration)}</span>
          <h3>
            {final
              ? analysis.converged
                ? T('已达到不动点')
                : T('分析尚未完成')
              : T('{#0} · 合并与传递', blockId)}
          </h3>
        </div>
        <label>
          {T('检查基本块')}
          <select
            aria-label={T('检查分析基本块')}
            value={blockId}
            disabled={!final}
            onChange={(event) => setSelected(event.target.value)}
          >
            {analysis.graph.blocks.map((item) => (
              <option key={item.id} value={item.id}>
                {analysis.blocks[item.id].reachable
                  ? item.id
                  : analysis.converged
                    ? T('{#0} · 已证明不可达', item.id)
                    : T('{#0} · 尚未分析', item.id)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="dataflow-static-note">
        {T('这里展示静态推导，不使用一次运行的变量值。只有事实稳定后，才据此改写程序。')}
      </p>
      <div className="dataflow-predecessors">
        <div className="view-label">
          <span>{T('① 合并前驱 OUT → 本块 IN')}</span>
          <small>{T('{#0} 条边参与', predecessors.filter((item) => item.enabled).length)}</small>
        </div>
        {predecessors.length ? (
          predecessors.map((item) => (
            <details key={item.edge} className={item.enabled ? 'enabled' : ''}>
              <summary>
                {item.enabled
                  ? T('{#0} → {#1} · 可能执行，参与合并', item.block, blockId)
                  : T('{#0} → {#1} · 本步未启用此边', item.block, blockId)}
              </summary>
              <code>
                {variables.map((name) => `${name} = ${factText(item.output[name])}`).join('\n') ||
                  T('没有需要显示的源变量')}
              </code>
            </details>
          ))
        ) : (
          <p className="figure-caption">
            {blockId === analysis.graph.blocks[0].id
              ? T('入口采用保守边界信息；变量完成写入后，才建立对应的常量事实。')
              : T('没有参与本步合并的前驱。')}
          </p>
        )}
      </div>
      <div className="dataflow-table-heading">
        <span>{T('② 本块的 IN 与 OUT')}</span>
        <label>
          <input
            type="checkbox"
            checked={showTemps}
            onChange={(event) => setShowTemps(event.target.checked)}
          />
          {T('显示临时变量')}
        </label>
      </div>
      {!reachable && (
        <p className="dataflow-static-note">
          {analysis.converged
            ? T('分析已收敛，此块没有可执行入口。⊥ 是分析符号，不是程序中的值 0。')
            : T('尚未证明此块可达，分析完成前不能据此删除路径。⊥ 是分析符号，不是程序中的值 0。')}
        </p>
      )}
      <div className="table-scroll dataflow-facts">
        <table>
          <thead>
            <tr>
              <th>{T('变量')}</th>
              <th>{T('IN / 进入前')}</th>
              <th>{T('OUT / 传递后')}</th>
              <th>{T('本步')}</th>
            </tr>
          </thead>
          <tbody>
            {variables.map((name) => (
              <tr
                key={name}
                className={!final && frame.changed.includes(name) ? 'highlight-row' : ''}
              >
                <td>
                  <code>{name}</code>
                </td>
                <td>
                  <code className={facts.input[name]?.kind === 'overdefined' ? 'fact-top' : ''}>
                    {factText(facts.input[name])}
                  </code>
                </td>
                <td>
                  <code className={facts.output[name]?.kind === 'overdefined' ? 'fact-top' : ''}>
                    {factText(facts.output[name])}
                  </code>
                </td>
                <td>{!final && frame.changed.includes(name) ? T('已更新') : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!variables.length && (
          <p className="empty-inline">{T('没有源变量；可勾选临时变量观察表达式的事实。')}</p>
        )}
      </div>
      <details className="dataflow-instructions" open>
        <summary>{T('{#0} 的传递函数来自这些 IR 指令', blockId)}</summary>
        <div className="code-rows">
          {block.instructions.length ? (
            block.instructions.map((instruction, index) => (
              <div className="code-row" key={index}>
                <span>{block.start + index}</span>
                <code>{instructionText(instruction)}</code>
              </div>
            ))
          ) : (
            <div className="code-row">
              <code>{T('Exit / 无变量写入')}</code>
            </div>
          )}
        </div>
      </details>
      <div className="dataflow-edges">
        <span>{T('本步仍可能执行的边（保守近似）')}</span>
        <div>
          {analysis.graph.edges.map((edge) => (
            <code className={enabled.has(edge.id) ? 'enabled' : ''} key={edge.id}>
              {edge.from} —{edge.kind}→ {edge.to}
            </code>
          ))}
        </div>
      </div>
      <details className="dataflow-liveness">
        <summary>{T('③ 向后看：原始 CFG 的活跃变量')}</summary>
        <p>
          {T(
            'OUT 是各后继 IN 的并集；IN = USE ∪ (OUT − DEF)。这里保守考虑原始图的全部结构边，不把“本次未执行”当作死代码。',
          )}
        </p>
        <div className="dataflow-formula">
          <code>OUT[B] = ⋃ IN[successor]</code>
          <code>IN[B] = USE[B] ∪ (OUT[B] − DEF[B])</code>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>{T('基本块')}</th>
                <th>LIVE IN</th>
                <th>LIVE OUT</th>
              </tr>
            </thead>
            <tbody>
              {result.liveness!.graph.blocks.map((item) => (
                <tr key={item.id}>
                  <td>{item.id}</td>
                  <td>
                    <code>{result.liveness!.input[item.id].join(', ') || '∅'}</code>
                  </td>
                  <td>
                    <code>{result.liveness!.output[item.id].join(', ') || '∅'}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="figure-caption">
          {result.liveness!.converged
            ? T(
                '{#0} 轮 · 已收敛。未折叠的算术仍被保留，因为它可能报错。',
                result.liveness!.iterations,
              )
            : T(
                '{#0} 轮 · 未完成，不能用于删除写入。未折叠的算术仍被保留，因为它可能报错。',
                result.liveness!.iterations,
              )}
        </p>
      </details>
      <div className="dataflow-outcome">
        <strong>
          {T(
            '优化结果：{#0} → {#1} 条 IR',
            result.ir!.length,
            result.optimization!.at(-1)!.instructions.length,
          )}
        </strong>
        <p>
          {inconclusive
            ? T('执行达到回放上限，暂不能判断完整行为是否一致。')
            : equivalent
              ? T('两版程序的输出与错误一致。')
              : T('发现行为差异，请检查。')}
          {T(
            '原始输出 [{#0}] → 优化输出 [{#1}]',
            result.baseline!.output.slice(-12).map(String).join(', '),
            result.execution!.output.slice(-12).map(String).join(', '),
          )}
        </p>
        <a href={shareUrl(window.location.href, 'optimize', source, 0, options)}>
          {T('查看这段程序的优化前后对照 ↗')}
        </a>
      </div>
      {analysis.traceTruncated && (
        <p className="figure-caption">
          {T('中间步骤仅记录前 240 次处理，最后一步和最终表包含完整分析结果。')}
        </p>
      )}
    </div>
  );
}
