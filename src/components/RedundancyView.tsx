import type { Compilation } from '../compiler';
import { instructionText } from '../compiler/ir';
import { compareVmExecutions } from '../compiler/outssa';
import type { RedundancyRun } from '../compiler/redundancy';
import { CodeBlock } from './CodeBlock';
import '../styles-redundancy.css';

const statusLabel = { hoisted: '外提', trap: '不变但保留', blocked: '不能搬', variant: '会变化' };
const runStatus = (run: RedundancyRun) =>
  run.execution.error?.message || (run.execution.limited ? '达到上限' : '正常结束');

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
        <strong>{frame.kind === 'available' ? '可用表达式分析' : frame.kind === 'cse' ? '公共子表达式消除'
          : frame.kind === 'loop' || frame.kind === 'decision' ? '循环不变代码外提' : final ? '执行与核对' : '准备'}</strong>
        <span>{analysis.replacements.length} 处复用 · {analysis.loops.reduce((sum, item) => sum + item.hoisted.length, 0)} 条外提</span>
      </div>
      {analysis.issues.length > 0 && <p className="diagnostic" role="alert">{analysis.issues.join(' ')}</p>}

      <section className="redundancy-card" aria-label="本步冗余消除">
        <h3>观察这一步</h3>
        <p>{frame.message}</p>
        {available && (
          <div className="table-scroll" tabIndex={0} aria-label="可用表达式，可横向滚动">
            <table className="redundancy-table">
              <thead><tr><th>{available.block}</th><th>可用表达式</th></tr></thead>
              <tbody>
                <tr><td>IN（前驱交集）</td><td><code>{available.input.join('；') || '∅'}</code></td></tr>
                <tr><td>OUT</td><td><code>{available.output.join('；') || '∅'}</code></td></tr>
              </tbody>
            </table>
          </div>
        )}
        {replacement && (
          <div className="redundancy-columns">
            <CodeBlock title={`#${replacement.index} 原来`} language="text" code={replacement.before} />
            <CodeBlock title="改为复制" language="text" code={replacement.after} />
          </div>
        )}
        {loop && (
          <div className="table-scroll" tabIndex={0} aria-label="循环内计算的判断，可横向滚动">
            <table className="redundancy-table">
              <thead><tr><th>循环 {loop.label} 内的计算</th><th>结论</th><th>原因</th></tr></thead>
              <tbody>{loop.decisions.slice(0, frame.decision === undefined ? 0 : frame.decision + 1).map((item, index) => (
                <tr key={index} className={index === frame.decision ? 'current' : ''}>
                  <td><code>{item.text}</code></td><td className={`decision-${item.status}`}>{statusLabel[item.status]}</td><td>{item.reason}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </section>

      {!final && (
        <section className="redundancy-card" aria-label="原始三地址代码">
          <CodeBlock title="原始三地址代码" language="text" lineNumbers={false}
            code={ir.map((instruction, index) => `#${String(index).padEnd(3)} ${instructionText(instruction)}${marked.has(index) && frame.kind !== 'initial' && frame.kind !== 'available' ? '   // 可复用' : ''}`).join('\n')} />
        </section>
      )}

      {final && runs && (
        <>
          <section className="redundancy-card" aria-label="优化前后代码">
            <h3>三个版本</h3>
            <div className="redundancy-columns three">
              <CodeBlock title="原始" language="text" code={ir.map(instructionText).join('\n')} />
              <CodeBlock title="消除公共子表达式" language="text" code={analysis.afterCse.map(instructionText).join('\n')} />
              <CodeBlock title="再外提循环不变量" language="text" code={analysis.afterLicm.map(instructionText).join('\n')} />
            </div>
            {Object.keys(analysis.saved).length > 0 && (
              <p>新建的保存变量：{Object.entries(analysis.saved).map(([key, name]) => <code key={name}>{name} ← {key}　</code>)}——它们在每次计算该表达式后保存结果，供汇合后的复用读取。</p>
            )}
            {analysis.loops.map((item) => (
              <details key={item.label}>
                <summary>循环 {item.label}：外提 {item.hoisted.length} 条{item.reason ? `（${item.reason}）` : ''}</summary>
                <div className="table-scroll" tabIndex={0} aria-label={`循环 ${item.label} 的判断，可横向滚动`}>
                  <table className="redundancy-table">
                    <thead><tr><th>计算</th><th>结论</th><th>原因</th></tr></thead>
                    <tbody>{item.decisions.map((decision, index) => (
                      <tr key={index}><td><code>{decision.text}</code></td><td className={`decision-${decision.status}`}>{statusLabel[decision.status]}</td><td>{decision.reason}</td></tr>
                    ))}</tbody>
                  </table>
                </div>
              </details>
            ))}
          </section>

          <section className="redundancy-card" aria-label="值编号对照">
            <h3>值编号还能看出什么？</h3>
            {analysis.valueNumbers.length ? (
              <ul>{analysis.valueNumbers.map((item) => (
                <li key={item.index}><code>{item.text}</code> 与 <code>{item.equalTo}</code> 的值相同（{item.block}）{item.cse ? '，公共子表达式消除也找到了。' : '：名字不同，按名字比较的公共子表达式消除没发现。'}</li>
              ))}</ul>
            ) : <p>各基本块里没有值编号能发现的重复计算。</p>}
            <p className="figure-caption">本地值编号只在每个基本块内做，结果仅作对照，不改代码。</p>
          </section>

          <section className="redundancy-card redundancy-equivalence" aria-label="冗余消除行为核对">
            <h3>{[runs.cse, runs.licm].some((run) => compareVmExecutions(runs.original.execution, run.execution) === 'unknown') ? '达到上限，暂不能判定行为一致'
              : [runs.cse, runs.licm].every((run) => compareVmExecutions(runs.original.execution, run.execution) === 'same') ? '三个版本的输出与错误一致' : '发现行为差异'}</h3>
            <div className="table-scroll" tabIndex={0} aria-label="三个版本的执行对照，可横向滚动">
              <table className="redundancy-table">
                <thead><tr><th>版本</th><th>执行的运算</th><th>执行的字节码</th><th>输出（最后 30 项）</th><th>停止状态</th></tr></thead>
                <tbody>{([['原始', runs.original], ['消除公共子表达式', runs.cse], ['再外提循环不变量', runs.licm]] as const).map(([name, run]) => (
                  <tr key={name}><td>{name}</td><td>{run.operations}</td><td>{run.execution.steps.length - 1}</td>
                    <td>{run.execution.output.slice(-30).map(String).join(', ') || '无'}</td><td>{runStatus(run)}</td></tr>
                ))}</tbody>
              </table>
            </div>
            <p className="figure-caption">“运算”统计 VM 实际执行的加减乘除与比较。复制仍是一条指令，需要复制传播和死代码删除才会消失。本次一致不等于一般性的语义等价证明。</p>
          </section>
        </>
      )}
      {analysis.traceTruncated && <p className="figure-caption">回放记录前 240 步；完成页仍展示全部结果。</p>}
    </div>
  );
}
