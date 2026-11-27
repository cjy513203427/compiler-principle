import { Fragment } from 'react';
import type { Compilation } from '../compiler';
import { instructionText } from '../compiler/ir';
import { compareVmExecutions } from '../compiler/outssa';
import type { RedundancyRun } from '../compiler/redundancy';
import { T } from '../i18n';
import { Tx } from '../i18n/jsx';
import { CodeBlock } from './CodeBlock';
import '../styles-redundancy.css';

const statusLabel = (status: 'hoisted' | 'trap' | 'blocked' | 'variant') =>
  ({ hoisted: T('外提'), trap: T('不变但保留'), blocked: T('不能搬'), variant: T('会变化') }[status]);
const runStatus = (run: RedundancyRun) =>
  run.execution.error?.message || (run.execution.limited ? T('达到上限') : T('正常结束'));

export function RedundancyView({ result, step }: { result: Compilation; step: number }) {
  const analysis = result.redundancy!;
  const frame = analysis.frames[step];
  const ir = result.ir!;
  const available = frame.step !== undefined ? analysis.available.steps[frame.step] : undefined;
  const replacement = frame.replacement !== undefined ? analysis.replacements[frame.replacement] : undefined;
  const loop = frame.loop !== undefined ? analysis.loops[frame.loop] : undefined;
  const final = (frame.kind === 'execute' || frame.kind === 'complete') && analysis.valid;
  const runs = analysis.runs;
  const marked = new Set(analysis.replacements.map((item) => item.index));
  return (
    <div className="redundancy-view">
      <div className="redundancy-status" role="status">
        <strong>{frame.kind === 'available' ? T('可用表达式分析') : frame.kind === 'cse' ? T('公共子表达式消除')
          : frame.kind === 'loop' || frame.kind === 'decision' ? T('循环不变代码外提') : final ? T('执行与核对') : T('准备')}</strong>
        <span>{T('{#0} 处复用 · {#1} 条外提', analysis.replacements.length, analysis.loops.reduce((sum, item) => sum + item.hoisted.length, 0))}</span>
      </div>
      {analysis.issues.length > 0 && <p className="diagnostic" role="alert">{analysis.issues.join(' ')}</p>}

      <section className="redundancy-card" aria-label={T('本步冗余消除')}>
        <h3>{T('观察这一步')}</h3>
        <p>{frame.message}</p>
        {available && (
          <div className="table-scroll" tabIndex={0} aria-label={T('可用表达式，可横向滚动')}>
            <table className="redundancy-table">
              <thead><tr><th>{available.block}</th><th>{T('可用表达式')}</th></tr></thead>
              <tbody>
                <tr><td>{T('IN（前驱交集）')}</td><td><code>{available.input.join(T('；')) || '∅'}</code></td></tr>
                <tr><td>OUT</td><td><code>{available.output.join(T('；')) || '∅'}</code></td></tr>
              </tbody>
            </table>
          </div>
        )}
        {replacement && (
          <div className="redundancy-columns">
            <CodeBlock title={T('#{#0} 原来', replacement.index)} language="text" code={replacement.before} />
            <CodeBlock title={T('改为复制')} language="text" code={replacement.after} />
          </div>
        )}
        {loop && (
          <div className="table-scroll" tabIndex={0} aria-label={T('循环内计算的判断，可横向滚动')}>
            <table className="redundancy-table">
              <thead><tr><th>{T('循环 {#0} 内的计算', loop.label)}</th><th>{T('结论')}</th><th>{T('原因')}</th></tr></thead>
              <tbody>{loop.decisions.slice(0, frame.decision === undefined ? 0 : frame.decision + 1).map((item, index) => (
                <tr key={index} className={index === frame.decision ? 'current' : ''}>
                  <td><code>{item.text}</code></td><td className={`decision-${item.status}`}>{statusLabel(item.status)}</td><td>{item.reason}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </section>

      {!final && (
        <section className="redundancy-card" aria-label={T('原始三地址代码')}>
          <CodeBlock title={T('原始三地址代码')} language="text" lineNumbers={false}
            code={ir.map((instruction, index) => `#${String(index).padEnd(3)} ${instructionText(instruction)}${marked.has(index) && frame.kind !== 'initial' && frame.kind !== 'available' ? `   ${T('// 可复用')}` : ''}`).join('\n')} />
        </section>
      )}

      {final && runs && (
        <>
          <section className="redundancy-card" aria-label={T('优化前后代码')}>
            <h3>{T('三个版本')}</h3>
            <div className="redundancy-columns three">
              <CodeBlock title={T('原始')} language="text" code={ir.map(instructionText).join('\n')} />
              <CodeBlock title={T('消除公共子表达式')} language="text" code={analysis.afterCse.map(instructionText).join('\n')} />
              <CodeBlock title={T('再外提循环不变量')} language="text" code={analysis.afterLicm.map(instructionText).join('\n')} />
            </div>
            {Object.keys(analysis.saved).length > 0 && (
              <p>{Tx(
                '新建的保存变量：{#0}——它们在每次计算该表达式后保存结果，供汇合后的复用读取。',
                Object.entries(analysis.saved).map(([key, name], index) => (
                  <Fragment key={name}>
                    {index > 0 && T('、')}
                    <code>{name} ← {key}</code>
                  </Fragment>
                )),
              )}</p>
            )}
            {analysis.loops.map((item) => (
              <details key={item.label}>
                <summary>{item.reason
                  ? T('循环 {#0}：外提 {#1} 条（{#2}）', item.label, item.hoisted.length, item.reason)
                  : T('循环 {#0}：外提 {#1} 条', item.label, item.hoisted.length)}</summary>
                <div className="table-scroll" tabIndex={0} aria-label={T('循环 {#0} 的判断，可横向滚动', item.label)}>
                  <table className="redundancy-table">
                    <thead><tr><th>{T('计算')}</th><th>{T('结论')}</th><th>{T('原因')}</th></tr></thead>
                    <tbody>{item.decisions.map((decision, index) => (
                      <tr key={index}><td><code>{decision.text}</code></td><td className={`decision-${decision.status}`}>{statusLabel(decision.status)}</td><td>{decision.reason}</td></tr>
                    ))}</tbody>
                  </table>
                </div>
              </details>
            ))}
          </section>

          <section className="redundancy-card" aria-label={T('值编号对照')}>
            <h3>{T('值编号还能看出什么？')}</h3>
            {analysis.valueNumbers.length ? (
              <ul>{analysis.valueNumbers.map((item) => (
                <li key={item.index}>{item.cse
                  ? Tx('{#0} 与 {#1} 的值相同（{#2}），公共子表达式消除也找到了。', <code>{item.text}</code>, <code>{item.equalTo}</code>, item.block)
                  : Tx('{#0} 与 {#1} 的值相同（{#2}）：名字不同，按名字比较的公共子表达式消除没发现。', <code>{item.text}</code>, <code>{item.equalTo}</code>, item.block)}</li>
              ))}</ul>
            ) : <p>{T('各基本块里没有值编号能发现的重复计算。')}</p>}
            <p className="figure-caption">{T('本地值编号只在每个基本块内做，结果仅作对照，不改代码。')}</p>
          </section>

          <section className="redundancy-card redundancy-equivalence" aria-label={T('冗余消除行为核对')}>
            <h3>{[runs.cse, runs.licm].some((run) => compareVmExecutions(runs.original.execution, run.execution) === 'unknown') ? T('达到上限，暂不能判定行为一致')
              : [runs.cse, runs.licm].every((run) => compareVmExecutions(runs.original.execution, run.execution) === 'same') ? T('三个版本的输出与错误一致') : T('发现行为差异')}</h3>
            <div className="table-scroll" tabIndex={0} aria-label={T('三个版本的执行对照，可横向滚动')}>
              <table className="redundancy-table">
                <thead><tr><th>{T('版本')}</th><th>{T('执行的运算')}</th><th>{T('执行的字节码')}</th><th>{T('输出（最后 30 项）')}</th><th>{T('停止状态')}</th></tr></thead>
                <tbody>{([[T('原始'), runs.original], [T('消除公共子表达式'), runs.cse], [T('再外提循环不变量'), runs.licm]] as const).map(([name, run]) => (
                  <tr key={name}><td>{name}</td><td>{run.operations}</td><td>{run.execution.steps.length - 1}</td>
                    <td>{run.execution.output.slice(-30).map(String).join(', ') || T('无')}</td><td>{runStatus(run)}</td></tr>
                ))}</tbody>
              </table>
            </div>
            <p className="figure-caption">{T('“运算”统计 VM 实际执行的加减乘除与比较。复制仍是一条指令，需要复制传播和死代码删除才会消失。本次一致不等于一般性的语义等价证明。')}</p>
          </section>
        </>
      )}
      {analysis.traceTruncated && <p className="figure-caption">{T('回放记录前 240 步；完成页仍展示全部结果。')}</p>}
    </div>
  );
}
