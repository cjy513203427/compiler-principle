import type { Compilation } from '../compiler';
import { instructionText } from '../compiler/ir';
import { phiText, type SsaBlock } from '../compiler/ssa';
import { formatLattice } from '../compiler/ssaopt';
import { CodeBlock } from './CodeBlock';
import '../styles-ssaopt.css';

function renderSsaBlocks(blocks: SsaBlock[]): string {
  return blocks
    .map((block) => {
      const lines = [
        `${block.id}:`,
        ...block.phis.map((phi) => `  ${phiText(phi)}`),
        ...block.instructions
          .filter((ins) => ins.op !== 'label')
          .map((ins) => `  ${instructionText(ins)}`),
      ];
      return lines.join('\n');
    })
    .join('\n\n');
}

export function SsaOptView({ result, step }: { result: Compilation; step: number }) {
  const analysis = result.ssaopt!;
  const ssa = result.ssa!;
  const frame = analysis.frames[step];
  const phaseLabel = {
    initial: '初始化工作表',
    'cfg-edge': 'CFG 可执行边传播',
    'ssa-prop': 'SSA def-use 格值更新',
    rewrite: '改写 SSA 与化简 φ',
    dce: 'SSA 死代码消除',
    complete: '优化完成与核对',
  }[frame.kind];

  return (
    <div className="ssaopt-view">
      <div className="ssaopt-status" role="status">
        <strong>{phaseLabel}</strong>
        <span>
          φ / 指令：{analysis.beforeCount} → {analysis.afterCount} · 稀疏工作表 {analysis.sccpOperations} 步（对照实验 08 稠密数据流 {result.dataflow?.steps.length ?? 0} 步）
        </span>
      </div>

      {!analysis.valid && (
        <div className="diagnostic" role="alert">
          {analysis.issues.join(' ')}
        </div>
      )}

      <section className="ssaopt-card" aria-label="本步 SSA 优化">
        <h3>观察这一步</h3>
        <p>{frame.message}</p>
        <div className="ssaopt-queues">
          <div>
            <span>CFG 边工作表</span>
            <code>{frame.cfgQueue.join(', ') || '空'}</code>
          </div>
          <div>
            <span>SSA def-use 工作表</span>
            <code>{frame.ssaQueue.join(', ') || '空'}</code>
          </div>
          <div>
            <span>已标记可执行块</span>
            <code>{frame.executableBlocks.join(', ') || '无'}</code>
          </div>
        </div>
      </section>

      {frame.kind !== 'complete' && (
        <section className="ssaopt-card" aria-label="当前 SSA 格值表">
          <h3>SSA 版本格值（⊥ 未访问 · 常量 · ⊤ 非常量）</h3>
          <div className="table-scroll" tabIndex={0} aria-label="SSA 格值表，可横向滚动">
            <table className="ssaopt-table">
              <thead>
                <tr>
                  <th>SSA 版本</th>
                  <th>当前格值</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(frame.lattice).map(([name, val]) => (
                  <tr key={name} className={frame.variable === name ? 'current' : ''}>
                    <td><code>{name}</code></td>
                    <td><strong className={`lat-${val === '⊥' ? 'bot' : val === '⊤' ? 'top' : 'const'}`}>{val}</strong></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {frame.kind === 'complete' && analysis.valid && (
        <>
          <section className="ssaopt-card" aria-label="SSA 优化前后对照">
            <h3>优化前后 SSA 对照</h3>
            <div className="ssaopt-columns">
              <CodeBlock title={`优化前 SSA（${ssa.blocks.length} 块，${analysis.beforeCount} 条）`} language="text" code={renderSsaBlocks(ssa.blocks)} />
              <CodeBlock title={`优化后 SSA（${analysis.optimizedBlocks.length} 块，${analysis.afterCount} 条）`} language="text" code={renderSsaBlocks(analysis.optimizedBlocks)} />
            </div>
            <div className="ssaopt-summary-grid">
              <div>
                <h4>删除的不可达块（{analysis.removedBlocks.length}）</h4>
                <p>{analysis.removedBlocks.join('、') || '无'}</p>
              </div>
              <div>
                <h4>化简的 φ 节点（{analysis.simplifiedPhis.length}）</h4>
                {analysis.simplifiedPhis.length ? (
                  <ul>{analysis.simplifiedPhis.map((line, i) => <li key={i}><code>{line}</code></li>)}</ul>
                ) : <p>无</p>}
              </div>
              <div>
                <h4>死代码消除移除（{analysis.removedInstructions.length}）</h4>
                {analysis.removedInstructions.length ? (
                  <ul>{analysis.removedInstructions.map((line, i) => <li key={i}><code>{line}</code></li>)}</ul>
                ) : <p>无</p>}
              </div>
            </div>
          </section>

          <section className="ssaopt-card ssaopt-equivalence" aria-label="SSA 优化行为核对">
            <h3>
              {analysis.equivalence === 'same'
                ? '原 VM、优化前 SSA、优化后 SSA 三者输出与错误一致'
                : analysis.equivalence === 'unknown'
                  ? '达到执行上限，暂不能判定完整行为等价'
                  : '发现行为差异'}
            </h3>
            <div className="table-scroll" tabIndex={0} aria-label="三版本执行对照，可横向滚动">
              <table className="ssaopt-table">
                <thead>
                  <tr>
                    <th>版本</th>
                    <th>输出</th>
                    <th>停止状态</th>
                    <th>最终格值汇总</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>原始 Mini C VM</td>
                    <td>{result.baseline?.output.slice(-20).map(String).join(', ') || '无'}</td>
                    <td>{result.baseline?.error?.message || (result.baseline?.limited ? '达到上限' : '正常结束')}</td>
                    <td>—</td>
                  </tr>
                  <tr>
                    <td>优化前 SSA</td>
                    <td>{ssa.execution?.output.slice(-20).map(String).join(', ') || '无'}</td>
                    <td>{ssa.execution?.error || (ssa.execution?.limited ? '达到上限' : '正常结束')}</td>
                    <td>{Object.keys(analysis.lattice).length} 个版本</td>
                  </tr>
                  <tr>
                    <td>优化后 SSA（SCCP + DCE）</td>
                    <td>{analysis.execution?.output.slice(-20).map(String).join(', ') || '无'}</td>
                    <td>{analysis.execution?.error || (analysis.execution?.limited ? '达到上限' : '正常结束')}</td>
                    <td>
                      {Object.values(analysis.lattice).filter((v) => v.kind === 'const').length} 个常量 ·{' '}
                      {Object.values(analysis.lattice).filter((v) => v.kind === 'top').length} 个 ⊤ ·{' '}
                      {Object.values(analysis.lattice).filter((v) => v.kind === 'bottom').length} 个 ⊥
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <details className="ssaopt-lattice-details">
              <summary>查看全部 {Object.keys(analysis.lattice).length} 个版本的最终格值</summary>
              <div className="ssaopt-chips">
                {Object.entries(analysis.lattice).map(([k, v]) => (
                  <code key={k}>{k} = {formatLattice(v)}</code>
                ))}
              </div>
            </details>
          </section>
        </>
      )}
      {analysis.traceTruncated && <p className="figure-caption">回放记录前 240 步；最终页仍展示完整优化结果与核对。</p>}
    </div>
  );
}
