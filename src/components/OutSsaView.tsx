import { useMemo, useState } from 'react';
import type { Compilation } from '../compiler';
import { instructionText } from '../compiler/ir';
import { bytecodeText } from '../compiler/vm';
import { phiText, compareSSA } from '../compiler/ssa';
import { analyzeCopyExperiment, compareVmExecutions, type ParallelCopy } from '../compiler/outssa';
import { copyPresets } from '../content/outssa';
import { CodeBlock } from './CodeBlock';
import '../styles-outssa.css';

const copyText = (copy: ParallelCopy) => `${copy.dest} ← ${copy.source}`;
const placementText = { predecessor: '前驱末尾', successor: '后继入口', split: '拆分关键边' };

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
        <strong>{frame.kind === 'execute' ? '消除后 VM 执行' : complete ? '结果与核对' : ready ? '普通 IR 已生成' : '构造边复制'} · {frame.block}</strong>
        <span>{analysis.valid ? '输入 SSA 校验通过' : '停止转换'}</span>
      </div>
      {analysis.issues.length > 0 && <p className="diagnostic" role="alert">{analysis.issues.join(' ')}</p>}
      <section className="outssa-card" aria-label="本步 SSA 消除">
        <h3>观察这一步</h3>
        <p>{frame.message}</p>
        {frame.plan !== undefined && plan && <>
          <p className="outssa-edge-path"><code>{plan.from} → {plan.placement === 'split' ? `${plan.host} → ` : ''}{plan.to}</code> · {placementText[plan.placement]}</p>
          <CodeBlock title="这条边的并行复制" code={plan.copies.map(copyText).join('\n')} language="text" />
          {frame.copyStep !== undefined && <>
            <CodeBlock title="本步调度" code={copyText(plan.steps[frame.copyStep].copy)} language="text" />
            <p>待处理：<code>{plan.steps[frame.copyStep].remaining.map(copyText).join('；') || '无'}</code></p>
          </>}
        </>}
      </section>
      {ready && <>
        <section className="outssa-card" aria-label="边复制计划">
          <h3>φ 在哪些边上变成复制？</h3>
          {analysis.plans.length ? <>
            <label>选择一条边<select aria-label="选择边复制" value={selectedPlan} onChange={(event) => setSelectedPlan(Number(event.target.value))}>
              {analysis.plans.map((item, index) => <option key={index} value={index}>{item.from} → {item.to} · {placementText[item.placement]}</option>)}
            </select></label>
            <p className="outssa-edge-path"><code>{plan.from} → {plan.placement === 'split' ? `${plan.host} → ` : ''}{plan.to}</code> · 复制落在 {plan.host}</p>
            <div className="outssa-columns">
              <CodeBlock title="并行复制 / 同时读取旧值" code={plan.copies.map(copyText).join('\n')} language="text" />
              <CodeBlock title="顺序复制 / 实际生成" code={plan.moves.map(copyText).join('\n') || '// 只有自身复制，不需要指令'} language="text" />
            </div>
            <p>新增临时变量：<code>{plan.temporaries.join(', ') || '无'}</code>。</p>
          </> : <p>当前程序没有 φ，不需要边复制或调度临时变量。</p>}
          <p className="figure-caption">位置来自原始 CFG 的前驱/后继关系，不借用本次执行路径。</p>
        </section>
        <section className="outssa-card" aria-label="SSA 与消除后的块对照">
          <label>查看一个块<select aria-label="SSA 消除对照块" value={selectedBlock} onChange={(event) => setSelectedBlock(event.target.value)}>
            {analysis.blocks.map((item) => <option key={item.id}>{item.id}</option>)}
          </select></label>
          <div className="outssa-columns">
            <CodeBlock title={`${selectedBlock} / 输入 SSA`} language="text"
              code={original ? [...original.phis.map(phiText), ...original.instructions.map(instructionText)].join('\n') || '// 结构出口' : '// 新增边块，原始 SSA 中没有这个块'} />
            <CodeBlock title={`${selectedBlock} / 消除后的普通 IR`} language="text"
              code={block?.instructions.map(instructionText).join('\n') || '// 空块'} />
          </div>
          <details onToggle={(event) => setAllIr(event.currentTarget.open)}>
            <summary>查看完整普通 IR / {analysis.instructions.length} 条</summary>
            {allIr && <CodeBlock title="生成的普通 IR / 无 φ 指令" language="text" code={analysis.instructions.map(instructionText).join('\n')} />}
          </details>
        </section>
      </>}
      <section className="outssa-card outssa-vm" aria-label="消除后 VM 当前状态">
        <h3>原栈式 VM 的真实状态</h3>
        <p>{current ? `PC ${current.pc} → ${current.nextPc} · ${instruction ? bytecodeText(instruction) : '就绪'}` : '等待构造完成后开始 VM 回放。'}</p>
        <p>操作数栈：<code>[{current?.stack.map(String).join(', ')}]</code></p>
        <div className="outssa-output"><strong>{complete ? '消除后 VM 最终输出' : '回放到这里的输出'}</strong>
          <code>{current?.output.length ? current.output.slice(-30).map(String).join(', ') : '等待 print…'}</code>
        </div>
        {complete && <p className="outssa-visited">本次经过的块：<code>{analysis.visitedBlocks.join(' → ') || '未执行'}</code>。按首次经过顺序列出，重复访问不再重复列出。</p>}
      </section>
      {complete && analysis.execution && <section className="outssa-card outssa-equivalence" aria-label="SSA 消除行为核对">
        <h3>{inconclusive ? '达到上限，暂不能判定行为一致'
          : comparison === 'same' && ssaComparison === 'same' ? '三种执行的本次输出与错误一致' : '发现行为差异'}</h3>
        <div className="table-scroll" tabIndex={0} aria-label="三种执行结果，可横向滚动"><table>
          <thead><tr><th>表示</th><th>输出（最后 30 项）</th><th>停止状态</th></tr></thead>
          <tbody>
            <tr><td>原始 IR → VM</td><td>{result.baseline!.output.slice(-30).map(String).join(', ') || '无'}</td><td>{result.baseline!.error?.message || (result.baseline!.limited ? '达到上限' : '正常结束')}</td></tr>
            <tr><td>SSA 解释器</td><td>{result.ssa!.execution!.output.slice(-30).map(String).join(', ') || '无'}</td><td>{result.ssa!.execution!.error || (result.ssa!.execution!.limited ? '达到上限' : '正常结束')}</td></tr>
            <tr><td>消除后 IR → VM</td><td>{analysis.execution.output.slice(-30).map(String).join(', ') || '无'}</td><td>{analysis.execution.error?.message || (analysis.execution.limited ? '达到上限' : '正常结束')}</td></tr>
          </tbody>
        </table></div>
        <p className="figure-caption">三种表示的计步方式和跳转数量不同；本次核对不等于一般性的语义等价证明。达到上限时，输出仅是前缀。</p>
      </section>}
      <CopyWorkbench />
      {analysis.traceTruncated && <p className="figure-caption">构造与 VM 回放各记录前 240 步；最后一步仍展示完整转换结果和最终 VM 状态。</p>}
    </div>
  );
}

function CopyWorkbench() {
  const [text, setText] = useState(copyPresets[0].code);
  const outcome = useMemo(() => analyzeCopyExperiment(text), [text]);
  return <details className="outssa-card copy-workbench">
    <summary>并行复制小实验 / 编辑一个复制环</summary>
    <p>这里使用与 φ 消除相同的调度器，独立演示复制依赖。修改后即时计算；小实验输入不写入主程序的分享链接。</p>
    <label>选择复制场景<select aria-label="选择并行复制场景" value={copyPresets.find((item) => item.code === text)?.id || 'custom'}
      onChange={(event) => { const item = copyPresets.find((item) => item.id === event.target.value); if (item) setText(item.code); }}>
      <option value="custom" disabled>自定义复制</option>
      {copyPresets.map((item) => <option value={item.id} key={item.id}>{item.label}</option>)}
    </select></label>
    <label>复制与初始值<textarea aria-label="并行复制与初始值" value={text} maxLength={500} spellCheck={false}
      onChange={(event) => setText(event.target.value)} /></label>
    <p className="figure-caption">%% 上方每行 a &lt;- b；下方每行 a = 1。每个复制源要有初始值，同一目标只写一次。</p>
    {!outcome.ok ? <p className="diagnostic" role="alert">{outcome.issue}</p> : <>
      <CodeBlock language="text" title="调度生成的顺序复制" code={outcome.experiment.schedule.moves.map(copyText).join('\n') || '// 无需复制'} />
      <ol className="copy-reasons">{outcome.experiment.schedule.steps.map((step, index) => <li key={index}>{step.message}</li>)}</ol>
      <div className="table-scroll" tabIndex={0} aria-label="并行复制结果，可横向滚动"><table className="copy-results">
        <thead><tr><th>名字</th><th>初始值</th><th>并行语义</th><th>直接顺序</th><th>正确调度</th></tr></thead>
        <tbody>{outcome.experiment.rows.map((row) => <tr key={row.name}>
          <td>{row.name}</td><td>{row.initial ?? '未定义'}</td><td>{row.parallel}</td><td>{row.naive}</td><td>{row.scheduled}</td>
        </tr>)}</tbody>
      </table></div>
      <p className="copy-verdict" role="status">{outcome.experiment.naiveCorrect ? '直接顺序复制在本例恰好正确。' : '直接顺序复制改变了结果。'}{outcome.experiment.scheduledCorrect ? ' 调度结果符合并行语义。' : ' 调度结果不一致。'}</p>
    </>}
  </details>;
}
