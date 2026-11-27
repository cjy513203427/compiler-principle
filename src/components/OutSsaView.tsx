import { useMemo, useState } from 'react';
import type { Compilation } from '../compiler';
import { instructionText } from '../compiler/ir';
import { bytecodeText } from '../compiler/vm';
import { phiText, compareSSA } from '../compiler/ssa';
import { analyzeCopyExperiment, compareVmExecutions, type ParallelCopy } from '../compiler/outssa';
import { copyPresets } from '../content/outssa';
import { T } from '../i18n';
import { Tx } from '../i18n/jsx';
import { CodeBlock } from './CodeBlock';
import '../styles-outssa.css';

const copyText = (copy: ParallelCopy) => `${copy.dest} ← ${copy.source}`;
const placementText = (placement: 'predecessor' | 'successor' | 'split') =>
  ({ predecessor: T('前驱末尾'), successor: T('后继入口'), split: T('拆分关键边') }[placement]);

export function OutSsaView({ result, step }: { result: Compilation; step: number }) {
  const analysis = result.outssa!;
  const frame = analysis.frames[step];
  const [selectedPlan, setSelectedPlan] = useState(0);
  const [selectedBlock, setSelectedBlock] = useState(analysis.blocks[0]?.id || '');
  const [allIr, setAllIr] = useState(false);
  const ready = analysis.valid && ['ready', 'execute', 'complete'].includes(frame.kind);
  const complete = frame.kind === 'complete';
  const plan = analysis.plans[frame.plan ?? selectedPlan];
  const block = analysis.blocks.find((item) => item.id === selectedBlock);
  const original = result.ssa!.blocks.find((item) => item.id === selectedBlock);
  const current = frame.vmStep === undefined ? undefined : analysis.execution?.steps[frame.vmStep];
  const instruction = current ? analysis.bytecode?.[current.pc] : undefined;
  const comparison = analysis.execution ? compareVmExecutions(result.baseline!, analysis.execution) : undefined;
  const ssaComparison = analysis.execution && result.ssa?.execution ? compareSSA(analysis.execution, result.ssa.execution) : undefined;
  const inconclusive = comparison === 'unknown' || ssaComparison === 'unknown';
  return (
    <div className="outssa-view">
      <div className="outssa-status" role="status">
        <strong>{frame.kind === 'execute' ? T('消除后 VM 执行') : complete ? T('结果与核对') : ready ? T('普通 IR 已生成') : T('构造边复制')} · {frame.block}</strong>
        <span>{analysis.valid ? T('输入 SSA 校验通过') : T('停止转换')}</span>
      </div>
      {analysis.issues.length > 0 && <p className="diagnostic" role="alert">{analysis.issues.join(' ')}</p>}
      <section className="outssa-card" aria-label={T('本步 SSA 消除')}>
        <h3>{T('观察这一步')}</h3>
        <p>{frame.message}</p>
        {frame.plan !== undefined && plan && <>
          <p className="outssa-edge-path"><code>{plan.from} → {plan.placement === 'split' ? `${plan.host} → ` : ''}{plan.to}</code> · {placementText(plan.placement)}</p>
          <CodeBlock title={T('这条边的并行复制')} code={plan.copies.map(copyText).join('\n')} language="text" />
          {frame.copyStep !== undefined && <>
            <CodeBlock title={T('本步调度')} code={copyText(plan.steps[frame.copyStep].copy)} language="text" />
            <p>{Tx('待处理：{#0}', <code>{plan.steps[frame.copyStep].remaining.map(copyText).join(T('；')) || T('无')}</code>)}</p>
          </>}
        </>}
      </section>
      {ready && <>
        <section className="outssa-card" aria-label={T('边复制计划')}>
          <h3>{T('φ 在哪些边上变成复制？')}</h3>
          {analysis.plans.length ? <>
            <label>{T('选择一条边')}<select aria-label={T('选择边复制')} value={selectedPlan} onChange={(event) => setSelectedPlan(Number(event.target.value))}>
              {analysis.plans.map((item, index) => <option key={index} value={index}>{item.from} → {item.to} · {placementText(item.placement)}</option>)}
            </select></label>
            <p className="outssa-edge-path">{Tx('{#0} · 复制落在 {#1}', <code>{plan.from} → {plan.placement === 'split' ? `${plan.host} → ` : ''}{plan.to}</code>, plan.host)}</p>
            <div className="outssa-columns">
              <CodeBlock title={T('并行复制 / 同时读取旧值')} code={plan.copies.map(copyText).join('\n')} language="text" />
              <CodeBlock title={T('顺序复制 / 实际生成')} code={plan.moves.map(copyText).join('\n') || T('// 只有自身复制，不需要指令')} language="text" />
            </div>
            <p>{Tx('新增临时变量：{#0}。', <code>{plan.temporaries.join(', ') || T('无')}</code>)}</p>
          </> : <p>{T('当前程序没有 φ，不需要边复制或调度临时变量。')}</p>}
          <p className="figure-caption">{T('位置来自原始 CFG 的前驱/后继关系，不借用本次执行路径。')}</p>
        </section>
        <section className="outssa-card" aria-label={T('SSA 与消除后的块对照')}>
          <label>{T('查看一个块')}<select aria-label={T('SSA 消除对照块')} value={selectedBlock} onChange={(event) => setSelectedBlock(event.target.value)}>
            {analysis.blocks.map((item) => <option key={item.id}>{item.id}</option>)}
          </select></label>
          <div className="outssa-columns">
            <CodeBlock title={T('{#0} / 输入 SSA', selectedBlock)} language="text"
              code={original ? [...original.phis.map(phiText), ...original.instructions.map(instructionText)].join('\n') || T('// 结构出口') : T('// 新增边块，原始 SSA 中没有这个块')} />
            <CodeBlock title={T('{#0} / 消除后的普通 IR', selectedBlock)} language="text"
              code={block?.instructions.map(instructionText).join('\n') || T('// 空块')} />
          </div>
          <details onToggle={(event) => setAllIr(event.currentTarget.open)}>
            <summary>{T('查看完整普通 IR / {#0} 条', analysis.instructions.length)}</summary>
            {allIr && <CodeBlock title={T('生成的普通 IR / 无 φ 指令')} language="text" code={analysis.instructions.map(instructionText).join('\n')} />}
          </details>
        </section>
      </>}
      <section className="outssa-card outssa-vm" aria-label={T('消除后 VM 当前状态')}>
        <h3>{T('原栈式 VM 的真实状态')}</h3>
        <p>{current ? `PC ${current.pc} → ${current.nextPc} · ${instruction ? bytecodeText(instruction) : T('就绪')}` : T('等待构造完成后开始 VM 回放。')}</p>
        <p>{Tx('操作数栈：{#0}', <code>[{current?.stack.map(String).join(', ')}]</code>)}</p>
        <div className="outssa-output"><strong>{complete ? T('消除后 VM 最终输出') : T('回放到这里的输出')}</strong>
          <code>{current?.output.length ? current.output.slice(-30).map(String).join(', ') : T('等待 print…')}</code>
        </div>
        {complete && <p className="outssa-visited">{Tx('本次经过的块：{#0}。按首次经过顺序列出，重复访问不再重复列出。', <code>{analysis.visitedBlocks.join(' → ') || T('未执行')}</code>)}</p>}
      </section>
      {complete && analysis.execution && <section className="outssa-card outssa-equivalence" aria-label={T('SSA 消除行为核对')}>
        <h3>{inconclusive ? T('达到上限，暂不能判定行为一致')
          : comparison === 'same' && ssaComparison === 'same' ? T('三种执行的本次输出与错误一致') : T('发现行为差异')}</h3>
        <div className="table-scroll" tabIndex={0} aria-label={T('三种执行结果，可横向滚动')}><table>
          <thead><tr><th>{T('表示')}</th><th>{T('输出（最后 30 项）')}</th><th>{T('停止状态')}</th></tr></thead>
          <tbody>
            <tr><td>{T('原始 IR → VM')}</td><td>{result.baseline!.output.slice(-30).map(String).join(', ') || T('无')}</td><td>{result.baseline!.error?.message || (result.baseline!.limited ? T('达到上限') : T('正常结束'))}</td></tr>
            <tr><td>{T('SSA 解释器')}</td><td>{result.ssa!.execution!.output.slice(-30).map(String).join(', ') || T('无')}</td><td>{result.ssa!.execution!.error || (result.ssa!.execution!.limited ? T('达到上限') : T('正常结束'))}</td></tr>
            <tr><td>{T('消除后 IR → VM')}</td><td>{analysis.execution.output.slice(-30).map(String).join(', ') || T('无')}</td><td>{analysis.execution.error?.message || (analysis.execution.limited ? T('达到上限') : T('正常结束'))}</td></tr>
          </tbody>
        </table></div>
        <p className="figure-caption">{T('三种表示的计步方式和跳转数量不同；本次核对不等于一般性的语义等价证明。达到上限时，输出仅是前缀。')}</p>
      </section>}
      <CopyWorkbench />
      {analysis.traceTruncated && <p className="figure-caption">{T('构造与 VM 回放各记录前 240 步；最后一步仍展示完整转换结果和最终 VM 状态。')}</p>}
    </div>
  );
}

function CopyWorkbench() {
  const [text, setText] = useState(copyPresets[0].code);
  const outcome = useMemo(() => analyzeCopyExperiment(text), [text]);
  return <details className="outssa-card copy-workbench">
    <summary>{T('并行复制小实验 / 编辑一个复制环')}</summary>
    <p>{T('这里使用与 φ 消除相同的调度器，独立演示复制依赖。修改后即时计算；小实验输入不写入主程序的分享链接。')}</p>
    <label>{T('选择复制场景')}<select aria-label={T('选择并行复制场景')} value={copyPresets.find((item) => item.code === text)?.id || 'custom'}
      onChange={(event) => { const item = copyPresets.find((item) => item.id === event.target.value); if (item) setText(item.code); }}>
      <option value="custom" disabled>{T('自定义复制')}</option>
      {copyPresets.map((item) => <option value={item.id} key={item.id}>{item.label}</option>)}
    </select></label>
    <label>{T('复制与初始值')}<textarea aria-label={T('并行复制与初始值')} value={text} maxLength={500} spellCheck={false}
      onChange={(event) => setText(event.target.value)} /></label>
    <p className="figure-caption">{T('%% 上方每行 a <- b；下方每行 a = 1。每个复制源要有初始值，同一目标只写一次。')}</p>
    {!outcome.ok ? <p className="diagnostic" role="alert">{outcome.issue}</p> : <>
      <CodeBlock language="text" title={T('调度生成的顺序复制')} code={outcome.experiment.schedule.moves.map(copyText).join('\n') || T('// 无需复制')} />
      <ol className="copy-reasons">{outcome.experiment.schedule.steps.map((step, index) => <li key={index}>{step.message}</li>)}</ol>
      <div className="table-scroll" tabIndex={0} aria-label={T('并行复制结果，可横向滚动')}><table className="copy-results">
        <thead><tr><th>{T('名字')}</th><th>{T('初始值')}</th><th>{T('并行语义')}</th><th>{T('直接顺序')}</th><th>{T('正确调度')}</th></tr></thead>
        <tbody>{outcome.experiment.rows.map((row) => <tr key={row.name}>
          <td>{row.name}</td><td>{row.initial ?? T('未定义')}</td><td>{row.parallel}</td><td>{row.naive}</td><td>{row.scheduled}</td>
        </tr>)}</tbody>
      </table></div>
      <p className="copy-verdict" role="status">{outcome.experiment.naiveCorrect ? T('直接顺序复制在本例恰好正确。') : T('直接顺序复制改变了结果。')} {outcome.experiment.scheduledCorrect ? T('调度结果符合并行语义。') : T('调度结果不一致。')}</p>
    </>}
  </details>;
}
