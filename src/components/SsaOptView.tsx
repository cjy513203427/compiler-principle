import { useState } from 'react';
import type { Compilation } from '../compiler';
import { instructionText } from '../compiler/ir';
import { phiText } from '../compiler/ssa';
import { compareAllSsaOptRuns, type CoalesceDecision } from '../compiler/ssaopt';
import { CodeBlock } from './CodeBlock';
import '../styles-ssaopt.css';

const phaseLabel = {
  initial: '准备',
  sccp: '稀疏条件常量传播',
  rewrite: '改写与复制传播',
  dce: '稀疏死代码删除',
  coalesce: '保守复制合并',
  execute: '执行与核对',
  complete: '执行与核对',
} as const;

const decisionBadge: Record<CoalesceDecision['status'], string> = {
  merged: '安全合并',
  interferes: '干涉拒绝',
};

const vmStatus = (execution: { error?: { message: string }; limited: boolean }) =>
  execution.error?.message || (execution.limited ? '达到上限' : '正常结束');

const ssaStatus = (execution: { error?: string; limited: boolean }) =>
  execution.error || (execution.limited ? '达到上限' : '正常结束');

export function SsaOptView({ result, step }: { result: Compilation; step: number }) {
  const analysis = result.ssaopt!;
  const ssa = result.ssa!;
  const frame = analysis.frames[step];
  const [selectedBlock, setSelectedBlock] = useState(ssa.blocks[0]?.id || '');
  const [showFullIr, setShowFullIr] = useState(false);

  const sccpEvent = frame.sccpEvent !== undefined ? analysis.sccp.events[frame.sccpEvent] : undefined;
  const activeDecision = frame.decision !== undefined ? analysis.coalesceDecisions[frame.decision] : undefined;
  const final = (frame.kind === 'execute' || frame.kind === 'complete') && analysis.valid;
  const originalBlock = ssa.blocks.find((block) => block.id === selectedBlock);
  const optimizedBlock = analysis.optimizedBlocks.find((block) => block.id === selectedBlock);
  const verdict =
    analysis.valid && result.baseline && ssa.execution
      ? compareAllSsaOptRuns(result.baseline, ssa.execution, analysis)
      : 'unknown';
  const baseEdgeMoves = analysis.baseLowered?.valid
    ? analysis.baseLowered.plans.reduce((sum, plan) => sum + plan.moves.length, 0)
    : 0;
  const optEdgeMoves = analysis.optimizedLowered?.valid
    ? analysis.optimizedLowered.plans.reduce((sum, plan) => sum + plan.moves.length, 0)
    : 0;

  return (
    <div className="ssaopt-view">
      <div className="ssaopt-status" role="status">
        <strong>
          {phaseLabel[frame.kind]}
          {frame.block ? ` · ${frame.block}` : ''}
        </strong>
        <span>
          折叠 {analysis.foldedConstants} 处 · 化简 {analysis.simplifiedPhis} 个 φ · 合并 {analysis.mergedPairs} 对 ·
          干涉拒绝 {analysis.blockedPairs} 对
        </span>
      </div>

      {analysis.issues.length > 0 && (
        <p className="diagnostic" role="alert">
          {analysis.issues.join(' ')}
        </p>
      )}

      <section className="ssaopt-card" aria-label="本步 SSA 优化">
        <h3>观察这一步</h3>
        <p>{frame.message}</p>
        {sccpEvent && (
          <div className="table-scroll" tabIndex={0} aria-label="本步稀疏传播事件，可横向滚动">
            <table className="ssaopt-table">
              <thead>
                <tr>
                  <th>事件</th>
                  <th>块 / 目标</th>
                  <th>版本</th>
                  <th>格值变化</th>
                </tr>
              </thead>
              <tbody>
                <tr className="current">
                  <td>
                    {sccpEvent.kind === 'edge'
                      ? '可执行边'
                      : sccpEvent.kind === 'phi'
                        ? 'φ 求值'
                        : sccpEvent.kind === 'branch'
                          ? '分支判定'
                          : '指令求值'}
                  </td>
                  <td>
                    <code>
                      {sccpEvent.block}
                      {sccpEvent.target ? ` → ${sccpEvent.target}` : ''}
                    </code>
                  </td>
                  <td>
                    <code>{sccpEvent.variable || '—'}</code>
                  </td>
                  <td>
                    <code>
                      {sccpEvent.previous && sccpEvent.next ? `${sccpEvent.previous} → ${sccpEvent.next}` : '控制流边更新'}
                    </code>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
        {activeDecision && (
          <div className="table-scroll" tabIndex={0} aria-label="本步复制合并决策，可横向滚动">
            <table className="ssaopt-table">
              <thead>
                <tr>
                  <th>复制</th>
                  <th>决策</th>
                  <th>说明</th>
                </tr>
              </thead>
              <tbody>
                <tr className="current">
                  <td>
                    <code>
                      {activeDecision.dest} ← {activeDecision.source}
                    </code>
                  </td>
                  <td className={`coalesce-${activeDecision.status}`}>{decisionBadge[activeDecision.status]}</td>
                  <td>{activeDecision.reason}</td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </section>

      {!final && (
        <section className="ssaopt-card" aria-label="当前 SSA 概览">
          <h3>输入 SSA（保持不变）</h3>
          <CodeBlock
            title="原始标量 SSA"
            language="text"
            lineNumbers={false}
            code={ssa.blocks
              .map(
                (block) =>
                  `${block.id}:\n${[...block.phis.map((phi) => `  ${phiText(phi)}`), ...block.instructions.map((inst) => `  ${instructionText(inst)}`)].join('\n') || '  // 空块'}`,
              )
              .join('\n\n')}
          />
        </section>
      )}

      {final && analysis.uncoalescedRun && analysis.coalescedRun && analysis.optimizedSsaExecution && (
        <>
          <section className="ssaopt-card" aria-label="稀疏与稠密分析对照">
            <h3>稀疏传播工作量与裁剪结果</h3>
            <div className="ssaopt-metrics">
              <div>
                <span>SCCP 激活边</span>
                <strong>
                  {analysis.sccp.executableEdges.length} 条（访问 {analysis.sccp.edgeVisits} 次）
                </strong>
              </div>
              <div>
                <span>SCCP 值求值</span>
                <strong>{analysis.sccp.valueEvaluations} 次（仅沿 def-use 唤醒）</strong>
              </div>
              <div>
                <span>实验 08 稠密分析</span>
                <strong>{analysis.sccp.denseBlockVisits ?? '—'} 次整块扫描</strong>
              </div>
              <div>
                <span>裁剪结果</span>
                <strong>
                  删 {analysis.removedBlocks.length} 块 · 删 {analysis.dceRemovals.length} 条死定义/φ
                </strong>
              </div>
            </div>
            {analysis.removedBlocks.length > 0 && (
              <p>
                被裁剪的不可达块：<code>{analysis.removedBlocks.join(', ')}</code>。
              </p>
            )}
            {analysis.dceRemovals.length > 0 && (
              <details>
                <summary>查看稀疏死代码删除清单（{analysis.dceRemovals.length} 项）</summary>
                <div className="table-scroll" tabIndex={0} aria-label="稀疏死代码删除清单，可横向滚动">
                  <table className="ssaopt-table">
                    <thead>
                      <tr>
                        <th>块</th>
                        <th>种类</th>
                        <th>被删内容</th>
                        <th>原因</th>
                      </tr>
                    </thead>
                    <tbody>
                      {analysis.dceRemovals.map((item, index) => (
                        <tr key={index}>
                          <td>
                            <code>{item.block}</code>
                          </td>
                          <td>{item.kind === 'phi' ? 'φ 节点' : '指令'}</td>
                          <td>
                            <code>{item.text}</code>
                          </td>
                          <td>{item.reason}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            )}
          </section>

          <section className="ssaopt-card" aria-label="SSA 优化前后对照">
            <h3>优化前后的 SSA 基本块</h3>
            <label className="ssaopt-select-label">
              查看一个块
              <select
                aria-label="SSA 优化对照块"
                value={selectedBlock}
                onChange={(event) => setSelectedBlock(event.target.value)}
              >
                {ssa.blocks.map((block) => (
                  <option key={block.id} value={block.id}>
                    {block.id}
                    {analysis.removedBlocks.includes(block.id) ? '（已裁剪）' : ''}
                  </option>
                ))}
              </select>
            </label>
            <div className="ssaopt-columns">
              <CodeBlock
                title={`${selectedBlock} / 输入 SSA`}
                language="text"
                code={
                  originalBlock
                    ? [...originalBlock.phis.map(phiText), ...originalBlock.instructions.map(instructionText)].join(
                        '\n',
                      ) || '// 空块'
                    : '// 不存在'
                }
              />
              <CodeBlock
                title={`${selectedBlock} / 优化后 SSA`}
                language="text"
                code={
                  optimizedBlock
                    ? [...optimizedBlock.phis.map(phiText), ...optimizedBlock.instructions.map(instructionText)].join(
                        '\n',
                      ) || '// 空块'
                    : '// SCCP 证明此块不可达，已整体裁剪'
                }
              />
            </div>
            <p className="figure-caption">
              优化后的 SSA 已重新构建支配树并通过独立合法性校验（定义唯一、支配使用、φ 与可达前驱一一对应）。
            </p>
          </section>

          <section className="ssaopt-card" aria-label="复制合并决策">
            <h3>保守复制合并（干涉图护航）</h3>
            <p>
              消除 φ 后的变量间复制从原始基础消除的 <strong>{baseEdgeMoves}</strong> 条边复制、优化后未合并的{' '}
              <strong>{analysis.uncoalescedRun.moveCount}</strong> 条总复制，降至合并后的{' '}
              <strong>{analysis.coalescedRun.moveCount}</strong> 条（本轮 φ 边复制为 {optEdgeMoves} 条）。
            </p>
            {analysis.coalesceDecisions.length > 0 ? (
              <div className="table-scroll" tabIndex={0} aria-label="复制合并决策表，可横向滚动">
                <table className="ssaopt-table">
                  <thead>
                    <tr>
                      <th>候选复制</th>
                      <th>结论</th>
                      <th>依据 / 干涉点</th>
                    </tr>
                  </thead>
                  <tbody>
                    {analysis.coalesceDecisions.map((item, index) => (
                      <tr key={index}>
                        <td>
                          <code>
                            {item.dest} ← {item.source}
                          </code>
                        </td>
                        <td className={`coalesce-${item.status}`}>{decisionBadge[item.status]}</td>
                        <td>{item.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p>优化并消除 φ 后已没有多余的变量间复制。</p>
            )}
            <details onToggle={(event) => setShowFullIr(event.currentTarget.open)}>
              <summary>查看合并前后的普通 IR 对照（{analysis.coalescedRun.instructions.length} 条）</summary>
              {showFullIr && (
                <div className="ssaopt-columns">
                  <CodeBlock
                    title={`优化 + 基础消除（未合并，${analysis.uncoalescedRun.instructions.length} 条）`}
                    language="text"
                    code={analysis.uncoalescedRun.instructions.map(instructionText).join('\n')}
                  />
                  <CodeBlock
                    title={`优化 + 保守合并（${analysis.coalescedRun.instructions.length} 条）`}
                    language="text"
                    code={analysis.coalescedRun.instructions.map(instructionText).join('\n')}
                  />
                </div>
              )}
            </details>
          </section>

          <section className="ssaopt-card ssaopt-equivalence" aria-label="SSA 优化行为核对">
            <h3>
              {verdict === 'unknown'
                ? '达到上限，暂不能判定行为一致'
                : verdict === 'same'
                  ? '全部执行版本的输出与错误一致'
                  : '发现行为差异'}
            </h3>
            <div className="table-scroll" tabIndex={0} aria-label="多版本执行对照，可横向滚动">
              <table className="ssaopt-table">
                <thead>
                  <tr>
                    <th>表示版本</th>
                    <th>变量间复制</th>
                    <th>执行步数</th>
                    <th>输出（最后 30 项）</th>
                    <th>停止状态</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>原始 IR → VM</td>
                    <td>—</td>
                    <td>{result.baseline!.steps.length - 1}</td>
                    <td>{result.baseline!.output.slice(-30).map(String).join(', ') || '无'}</td>
                    <td>{vmStatus(result.baseline!)}</td>
                  </tr>
                  <tr>
                    <td>原始 SSA 解释器</td>
                    <td>—</td>
                    <td>{ssa.execution!.steps.length}</td>
                    <td>{ssa.execution!.output.slice(-30).map(String).join(', ') || '无'}</td>
                    <td>{ssaStatus(ssa.execution!)}</td>
                  </tr>
                  <tr>
                    <td>优化后 SSA 解释器</td>
                    <td>—</td>
                    <td>{analysis.optimizedSsaExecution.steps.length}</td>
                    <td>{analysis.optimizedSsaExecution.output.slice(-30).map(String).join(', ') || '无'}</td>
                    <td>{ssaStatus(analysis.optimizedSsaExecution)}</td>
                  </tr>
                  <tr>
                    <td>优化 + 基础消除 → VM</td>
                    <td>{analysis.uncoalescedRun.moveCount}</td>
                    <td>{analysis.uncoalescedRun.execution.steps.length - 1}</td>
                    <td>{analysis.uncoalescedRun.execution.output.slice(-30).map(String).join(', ') || '无'}</td>
                    <td>{vmStatus(analysis.uncoalescedRun.execution)}</td>
                  </tr>
                  <tr>
                    <td>优化 + 保守合并 → VM</td>
                    <td>{analysis.coalescedRun.moveCount}</td>
                    <td>{analysis.coalescedRun.execution.steps.length - 1}</td>
                    <td>{analysis.coalescedRun.execution.output.slice(-30).map(String).join(', ') || '无'}</td>
                    <td>{vmStatus(analysis.coalescedRun.execution)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="figure-caption">
              SSA 解释器与栈式 VM 计步单位不同；本次核对针对当前输入，不等于一般性的语义等价证明。
            </p>
          </section>
        </>
      )}

      {analysis.traceTruncated && (
        <p className="figure-caption">回放记录前 240 步；最终页仍展示完整优化结果与全部合并决策。</p>
      )}
    </div>
  );
}
