import { useEffect, useRef, useState } from 'react';
import { callInstructionText, MAIN_FUNCTION, type analyzeFunctions } from '../compiler/functions';
import { MAX_CALL_DEPTH, MAX_CALL_FRAMES } from '../compiler/functions-vm';
import '../styles-functions.css';

type Analysis = Extract<ReturnType<typeof analyzeFunctions>, { ok: true }>['analysis'];
const nameText = (name: string) => name === MAIN_FUNCTION ? '顶层入口' : name;
export function FunctionsView({ analysis, step, source }: { analysis: Analysis; step: number; source: string }) {
  const frame = analysis.frames[step];
  const [inspection, setInspection] = useState('active');
  const active = frame.activations.at(-1)!;
  const selected = frame.activations.find((item) => String(item.id) === inspection) || active;
  const fn = analysis.program.functions.get(selected.name)!;
  const events = analysis.events.slice(0, frame.eventCount).slice(-12);
  const codeList = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const container = codeList.current, current = container?.querySelector<HTMLElement>('.current');
    if (!container || !current) return;
    container.scrollTop += current.getBoundingClientRect().top - container.getBoundingClientRect().top - container.clientHeight / 2 + current.clientHeight / 2;
  }, [selected.name, selected.pc]);
  return <div className="functions-view">
    <div className="call-counts" aria-label="本步调用统计">
      <span>活动帧 <b>{frame.activations.length} / {MAX_CALL_DEPTH}</b></span>
      <span>已调用 <b>{frame.calls}</b> 次</span><span>最大深度 <b>{frame.maxDepth}</b></span>
      <span>已执行 <b>{frame.executed}</b> 条</span>
    </div>
    {frame.status !== 'running' && <p className={`call-outcome ${frame.status}`} role="status">
      {frame.status === 'halted' ? '执行完成：所有函数均已返回。' : frame.message}
    </p>}
    {analysis.truncated && <p className="figure-caption">中间回放保留前 {MAX_CALL_FRAMES} 个状态，随后直接显示最终现场；执行统计与输出覆盖完整的本次执行。</p>}
    <section className="call-card" aria-label="调用栈与栈帧">
      <h3>调用栈 / 每一次调用各有一帧</h3>
      <p className="figure-caption">从栈顶到入口排列。选择暂停的调用者，检查它保存的局部变量和中间值。</p>
      <label>检查哪一帧<select aria-label="检查调用帧" value={frame.activations.some((item) => String(item.id) === inspection) ? inspection : 'active'} onChange={(event) => setInspection(event.target.value)}>
        <option value="active">跟随当前执行帧</option>
        {[...frame.activations].reverse().map((item) => <option key={item.id} value={item.id}>#{item.id} {nameText(item.name)} · PC {item.pc}</option>)}
      </select></label>
      <ol className="call-chain" reversed>
        {[...frame.activations].reverse().map((item) => <li key={item.id}>
          <button type="button" className={selected.id === item.id ? 'selected' : ''} aria-pressed={selected.id === item.id} onClick={() => setInspection(String(item.id))}>
            <strong>#{item.id} · {nameText(item.name)}</strong><span>PC {item.pc} · {active.id === item.id ? '当前帧' : '等待返回'}</span>
          </button>
        </li>)}
      </ol>
      <div className="call-frame-detail" aria-label="选中帧的状态">
        <h3>#{selected.id} · {nameText(selected.name)}</h3>
        <p>{selected.returnTo ? `返回到 ${nameText(selected.returnTo.name)} : ${selected.returnTo.pc}` : '入口帧：HALT 后结束程序'}</p>
        <div className="call-operand" aria-label="选中帧操作数栈"><b>操作数栈 / 底 → 顶</b><code>{selected.stack.length ? selected.stack.map(String).join(' → ') : '空'}</code></div>
        <div className="table-scroll"><table>
          <caption>独立局部变量表 / 存储槽位</caption>
          <thead><tr><th>名字 / 槽位</th><th>类型</th><th>本帧的值</th></tr></thead>
          <tbody>{fn.locals.map((local) => <tr key={local.key}><td><code>{local.key}</code>{local.parameter ? ' · 形参' : ''}</td><td>{local.dataType}</td><td>{Object.hasOwn(selected.locals, local.key) ? String(selected.locals[local.key]) : '尚未初始化'}</td></tr>)}</tbody>
        </table></div>
        {!fn.locals.length && <p>本帧没有局部变量槽位。</p>}
        <p className="figure-caption"># 后的槽位编号区分块内同名声明；不同调用帧仍各存一份。离开块后，保留的槽位不改变源码的作用域规则。</p>
      </div>
    </section>
    <section className="call-card" aria-label="函数字节码">
      <h3>{nameText(selected.name)} / 生成的字节码</h3>
      <p className="figure-caption">箭头指向此帧下一条待执行指令。暂停的调用者已经保存 CALL 后的 PC。</p>
      <div className="table-scroll call-code" ref={codeList}><table>
        <thead><tr><th>PC</th><th>指令</th></tr></thead>
        <tbody>{fn.code.map((instruction, pc) => <tr key={pc} className={pc === selected.pc ? 'current' : ''} aria-current={pc === selected.pc ? 'step' : undefined}><td>{pc === selected.pc ? '→ ' : ''}{pc}</td><td><code>{callInstructionText(instruction)}</code></td></tr>)}</tbody>
      </table></div>
      {frame.location && <p className="call-location">最近动作 · 第 {source.slice(0, frame.location.start).split('\n').length} 行<br /><code>{source.slice(frame.location.start, frame.location.end) || '程序末尾'}</code></p>}
    </section>
    <section className="call-card" aria-label="调用与返回记录">
      <h3>调用与返回 / 本步之前的最近 12 次</h3>
      {events.length ? <ol className="call-events">{events.map((event) => <li key={`${event.kind}:${event.id}`}><span>{event.kind === 'call' ? '入栈' : '返回'} #{event.id} · {event.name}</span><code>{event.kind === 'call' ? `(${event.args!.join(', ')})` : `→ ${event.value}`}</code></li>)}</ol> : <p>尚未执行 CALL。</p>}
      <div className="call-output" aria-label="本步程序输出"><span>程序输出</span><code>{frame.output.length ? frame.output.map(String).join(' · ') : '等待 print…'}</code></div>
    </section>
    <p className="figure-caption">此实验使用专用函数方言与教学调用协议。左到右求值、按值传参；已有 CFG、SSA 与优化实验仍使用原来的 Mini C 输入。</p>
  </div>;
}
