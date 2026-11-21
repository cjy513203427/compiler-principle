import { useMemo, useState } from 'react';
import { charText, rangesText, type ScanResult } from '../compiler/automata';
import { DEAD, distinguishStates, stateText, type MinimizationAnalysis } from '../compiler/minimize';
import '../styles-minimize.css';

const groupText = (group: number[]) => `{ ${group.map(stateText).join(', ')} }`;

export function MinimizationView({ analysis, step }: { analysis: MinimizationAnalysis; step: number }) {
  const { result, original, spec } = analysis;
  const frame = analysis.frames[step];
  const final = frame.kind === 'complete';
  const states = result?.machine.states || [];
  const [left, setLeft] = useState(states.includes(1) ? 1 : 0);
  const [right, setRight] = useState(states.includes(2) ? 2 : 0);
  const distinction = useMemo(() => final && result ? distinguishStates(result.machine, left, right) : undefined,
    [final, result, left, right]);
  const output = (state: number) => {
    const rule = result?.machine.accept[state];
    return rule === undefined ? '拒绝' : `${spec.rules[rule].name}${spec.rules[rule].skip ? ' / 丢弃' : ''}`;
  };
  if (frame.kind === 'limit') return <p className="diagnostic" role="alert">{frame.message}</p>;
  return (
    <div className="min-view">
      <div className="min-counts" aria-label="最小化状态数">
        <span>原始 DFA <b>{original.states.length}</b> 个状态</span>
        <span>{final ? <>最小化扫描器 <b>{result!.minimized.states.length}</b> 个状态</> : <>当前 <b>{frame.groups.length}</b> 个候选组</>}</span>
        <small>{final ? `完整机 ${result!.machine.states.length} → ${result!.groups.length}（${states.includes(DEAD) ? '含可达 Dead' : '无可达 Dead'}）` : '候选分组尚不代表最终等价类'}</small>
      </div>
      <section className="min-card" aria-label="本步分割细化">
        <h3>{final ? '稳定分组 / 再也拆不开' : frame.kind === 'initial' ? '先按当前输出分组' : '后继分组签名不同，拆开这一组'}</h3>
        <p>{frame.message}</p>
        {frame.evidence && <p className="min-evidence">
          拆分前读字符 <code>{charText(frame.evidence.code)}</code>：
          {stateText(frame.evidence.left)} → 旧组 P{frame.evidence.leftGroup}；
          {stateText(frame.evidence.right)} → 旧组 P{frame.evidence.rightGroup}。
        </p>}
        {frame.split && <p>原组 <code>{groupText(frame.split)}</code> → {frame.pieces!.map(groupText).join(' / ')}</p>}
        <div className="min-groups" aria-label="当前状态分组">
          {frame.groups.map((group, index) => <div className="min-group" key={index}>
            <strong>P{index} · {output(group[0])}</strong><code>{groupText(group)}</code>
          </div>)}
        </div>
        <p className="figure-caption">Dead 统一表示无路可走。P 编号属于本步分组，细化后可能变化；D 编号始终指原始状态。</p>
      </section>
      {!final && <p className="figure-caption">回放到最后一步可查询最短区分后缀、查看状态映射和扫描对照。</p>}
      {final && result && <>
        <section className="min-card min-query" aria-label="状态能否合并">
          <h3>找一段后缀，让它们表现不同</h3>
          <div className="min-selects">
            <label>左状态<select aria-label="区分查询左状态" value={left} onChange={(event) => setLeft(Number(event.target.value))}>
              {states.map((id) => <option key={id} value={id}>{stateText(id)} · {output(id)}</option>)}
            </select></label>
            <label>右状态<select aria-label="区分查询右状态" value={right} onChange={(event) => setRight(Number(event.target.value))}>
              {states.map((id) => <option key={id} value={id}>{stateText(id)} · {output(id)}</option>)}
            </select></label>
          </div>
          <p className="min-query-result" role="status">{distinction!.equivalent
            ? '两个状态等价，可以合并：不存在输出不同的后缀。'
            : `不能合并。最短区分后缀：${distinction!.suffix === '' ? 'ε（空串）' : JSON.stringify(distinction!.suffix)}。`}</p>
          <p className="figure-caption">广度优先搜索检查了 {distinction!.checkedPairs} 对状态；同一状态与自身也等价。</p>
          {!distinction!.equivalent && <div className="table-scroll"><table className="min-witness">
            <caption className="sr-only">区分后缀的双状态执行轨迹</caption>
            <thead><tr><th>读入</th><th>左路径</th><th>右路径</th></tr></thead>
            <tbody>{distinction!.trace.map((row, index) => <tr key={index}>
              <td>{row.code === undefined ? '起点 / ε' : charText(row.code)}</td>
              <td>{stateText(row.left)} · {output(row.left)}</td><td>{stateText(row.right)} · {output(row.right)}</td>
            </tr>)}</tbody>
          </table></div>}
        </section>
        <section className="min-card" aria-label="原始与最小化状态映射">
          <h3>每个稳定组成为一个新状态</h3>
          <div className="table-scroll"><table>
            <thead><tr><th>新状态</th><th>原始成员</th><th>获胜规则</th></tr></thead>
            <tbody>{result.members.map((members, id) => <tr key={id}>
              <td>M{id}{id === 0 ? ' / 入口' : ''}</td><td><code>{groupText(members)}</code></td><td>{output(members[0])}</td>
            </tr>)}</tbody>
          </table></div>
          <p className="figure-caption">M 编号是扫描器的新编号。省略 Dead 类与指向它的转换；{result.removed.length} 个原始死状态被并入省略的 Dead 类，{result.machine.unreachable.length} 个原始状态不可达。</p>
          <details className="min-transitions"><summary>查看最小化转换表</summary>
            <div className="table-scroll"><table>
              <thead><tr><th>从</th><th>字符</th><th>到</th></tr></thead>
              <tbody>{result.minimized.edges.map((edge, index) => <tr key={index}>
                <td>M{edge.from}</td><td><code>{rangesText(edge.ranges)}</code></td><td>M{edge.to}</td>
              </tr>)}</tbody>
            </table></div>
          </details>
        </section>
        <section className="min-card min-equivalence" aria-label="最小化等价校验">
          <h3>{analysis.verification?.equivalent ? '全部后缀的获胜规则一致' : '发现等价校验错误'}</h3>
          <p>独立状态积搜索检查 {analysis.verification?.checkedPairs} 对状态，比较整个支持字母表上的获胜规则，不使用上面的分组结论。</p>
          <strong>{analysis.scansEqual ? '本次 Token 与首次失败位置一致' : '本次扫描结果不一致'}</strong>
          <p>对照包含被 skip 丢弃的词素、规则编号、文字与起止位置。状态编号、试读次数和错误说明中的内部路径可能变化。</p>
        </section>
        <div className="min-scan-comparison">
          <ScanTable title="原始 DFA 扫描" scan={analysis.originalScan!} names={spec.rules.map((rule) => rule.name)} />
          {analysis.minimizedScan && <ScanTable title="最小化 DFA 扫描" scan={analysis.minimizedScan} names={spec.rules.map((rule) => rule.name)} />}
        </div>
        {original.states[0].accept !== undefined && <p className="min-notice">规则可匹配空串；与原扫描器相同，空词素不生成 Token，避免停在原地。</p>}
        {states.includes(DEAD) && <p className="figure-caption">最小性针对包含可达 Dead 的完整机；页面中的扫描器表继续采用省略失败边的表示。</p>}
      </>}
    </div>
  );
}

function ScanTable({ title, scan, names }: { title: string; scan: ScanResult; names: string[] }) {
  return <section className="min-card min-scan" aria-label={title}>
    <h3>{title}</h3>
    <div className="table-scroll"><table>
      <thead><tr><th>规则</th><th>词素</th><th>区间</th></tr></thead>
      <tbody>{scan.tokens.map((token, index) => <tr key={index}>
        <td>{names[token.rule]}{token.skip ? ' / 丢弃' : ''}</td><td><code>{JSON.stringify(token.text)}</code></td><td>[{token.start}, {token.end})</td>
      </tr>)}</tbody>
    </table></div>
    {!scan.tokens.length && <p>没有非空词素。</p>}
    <p className={scan.error ? 'min-error' : ''}>{scan.error ? `扫描失败 / 起始位置 ${scan.error.position}` : '扫描完成'}</p>
  </section>;
}
