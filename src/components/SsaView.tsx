import { useState } from 'react';
import type { Compilation } from '../compiler';
import { compareSSA, phiText } from '../compiler/ssa';
import { instructionText } from '../compiler/ir';
import { CodeBlock } from './CodeBlock';
import '../styles-ssa.css';

export function SsaView({ result, step }: { result: Compilation; step: number }) {
  const analysis = result.ssa!;
  const frame = analysis.steps[step];
  const [selected, setSelected] = useState(analysis.blocks[0].id);
  const showResult = ['validated', 'execute', 'complete'].includes(frame.kind);
  const block = analysis.blocks.find((item) => item.id === (showResult ? selected : frame.block))!;
  const original = result.cfg!.blocks.find((item) => item.id === block.id)!;
  const complete = frame.kind === 'complete';
  const comparison = analysis.execution && result.baseline
    ? compareSSA(result.baseline, analysis.execution) : undefined;
  const stage = frame.kind === 'execute' ? '执行 SSA' : complete ? '结果与核对'
    : frame.kind === 'validated' ? '结构校验' : '构造 SSA';
  return (
    <div className="ssa-view">
      <div className="ssa-status" role="status">
        <strong>{stage} · {frame.block}</strong>
        <span>{showResult ? analysis.valid ? 'SSA 校验通过' : 'SSA 校验失败' : '沿支配树处理，版本栈不代表运行时值'}</span>
      </div>
      {analysis.issues.length > 0 && <p className="diagnostic" role="alert">{analysis.issues.join(' ')}</p>}
      <section className="ssa-event" aria-label="本步 SSA 操作">
        <h3>{frame.kind === 'execute' ? '执行这一步' : '观察这一步'}</h3>
        <p>{frame.message}</p>
        {frame.original && <CodeBlock code={frame.original} language="text" title={frame.renamed ? '改写前 / 边' : '本次指令'} />}
        {frame.renamed && <CodeBlock code={frame.renamed} language="text" title="改写后 / 输入" />}
        {frame.write && <p className="ssa-write"><code>{frame.write.name} = {String(frame.write.value)}</code></p>}
        {frame.selections && frame.selections.length > 0 && (
          <div className="ssa-selections" aria-label="本次 φ 输入选择">
            <strong>来自 {frame.predecessor} · 全部读取后同时写入</strong>
            {frame.selections.map((input) => <p key={input.dest}>
              <code>{input.dest} ← {input.source} = {String(input.value)}</code>
            </p>)}
          </div>
        )}
        {frame.stacks && (
          <details open className="ssa-stacks">
            <summary>构造时的版本栈 / 右端为栈顶</summary>
            {Object.entries(frame.stacks).length ? Object.entries(frame.stacks).map(([name, stack]) => (
              <p key={name}><code>{name}: {stack.join(' → ')}</code></p>
            )) : <p>空栈</p>}
          </details>
        )}
      </section>
      {showResult ? (
        <>
          <section className="ssa-placement" aria-label="φ 候选与活跃性裁剪">
            <h3>φ 候选 → 活跃性裁剪</h3>
            {analysis.placements.length ? <div className="table-scroll"><table>
              <thead><tr><th>原变量</th><th>候选块</th><th>决定</th></tr></thead>
              <tbody>{analysis.placements.map((item) => <tr key={`${item.variable}-${item.block}`}>
                <td><code>{item.variable}</code></td><td>{item.block}</td>
                <td>{item.retained ? '保留 φ' : '裁掉 φ'}</td>
              </tr>)}</tbody>
            </table></div> : <p>当前程序不需要 φ；每次写入仍分配独立版本名。</p>}
          </section>
          <section className="ssa-inspect">
            <label>对照一个基本块
              <select aria-label="SSA 对照基本块" value={selected} onChange={(event) => setSelected(event.target.value)}>
                {analysis.blocks.map((item) => <option key={item.id}>{item.id}</option>)}
              </select>
            </label>
            <div className="ssa-code-comparison">
              <CodeBlock code={original.instructions.map(instructionText).join('\n') || '// 结构出口'} language="text" title={`${block.id} / 原始 IR`} />
              <CodeBlock code={[...block.phis.map(phiText), ...block.instructions.map(instructionText)].join('\n') || '// 结构出口'} language="text" title={`${block.id} / SSA`} />
            </div>
            <details className="ssa-all-blocks">
              <summary>查看完整 SSA / {analysis.blocks.length} 个可达块</summary>
              {analysis.blocks.map((item) => <CodeBlock key={item.id} language="text" title={item.id}
                code={[...item.phis.map(phiText), ...item.instructions.map(instructionText)].join('\n') || '// 结构出口'} />)}
            </details>
          </section>
        </>
      ) : <p className="figure-caption">构造完成后显示块对照与完整 SSA。此时的版本栈只用于命名，尚未执行程序。</p>}
      <section className="ssa-output" aria-label="SSA 当前执行输出">
        <strong>{complete ? 'SSA 最终输出' : 'SSA 回放到这里的输出'}</strong>
        <code>{frame.output?.length ? frame.output.slice(-30).map(String).join(', ') : '等待 print…'}</code>
      </section>
      {complete && analysis.execution && (
        <section className="ssa-equivalence" aria-label="SSA 行为核对">
          <strong>{comparison === 'same' ? '本次输出与错误一致' : comparison === 'unknown' ? '达到上限，暂不能判定行为一致' : '发现行为差异'}</strong>
          <p>原始 VM 输出 [{result.baseline!.output.slice(-30).map(String).join(', ')}] → SSA 输出 [{analysis.execution.output.slice(-30).map(String).join(', ')}]</p>
          <p>原始 VM：{result.baseline!.error?.message || (result.baseline!.limited ? '达到执行上限' : '正常结束')}<br />
            SSA：{analysis.execution.error || (analysis.execution.limited ? '达到执行上限' : '正常结束')}</p>
          <span>两种执行的计步单位不同；这里只核对本次输入的行为，不是通用等价证明。输出较多时只展示最后 30 项。</span>
        </section>
      )}
      {(analysis.traceTruncated || analysis.execution?.traceTruncated) && <p className="figure-caption">
        构造与执行各保留前 240 步中间回放，最终 SSA 与执行结果完整；记录截断不会停止计算。
      </p>}
    </div>
  );
}
