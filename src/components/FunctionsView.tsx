import { useEffect, useRef, useState } from 'react';
import { callInstructionText, MAIN_FUNCTION, type analyzeFunctions } from '../compiler/functions';
import { MAX_CALL_DEPTH, MAX_CALL_FRAMES } from '../compiler/functions-vm';
import { T } from '../i18n';
import { Tx } from '../i18n/jsx';
import '../styles-functions.css';

type Analysis = Extract<ReturnType<typeof analyzeFunctions>, { ok: true }>['analysis'];
const nameText = (name: string) => name === MAIN_FUNCTION ? T('顶层入口') : name;
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
    <div className="call-counts" aria-label={T('本步调用统计')}>
      <span>{Tx('活动帧 {#0}', <b>{frame.activations.length} / {MAX_CALL_DEPTH}</b>)}</span>
      <span>{Tx('已调用 {#0} 次', <b>{frame.calls}</b>)}</span><span>{Tx('最大深度 {#0}', <b>{frame.maxDepth}</b>)}</span>
      <span>{Tx('已执行 {#0} 条', <b>{frame.executed}</b>)}</span>
    </div>
    {frame.status !== 'running' && <p className={`call-outcome ${frame.status}`} role="status">
      {frame.status === 'halted' ? T('执行完成：所有函数均已返回。') : frame.message}
    </p>}
    {analysis.truncated && <p className="figure-caption">{T('中间回放保留前 {#0} 个状态，随后直接显示最终现场；执行统计与输出覆盖完整的本次执行。', MAX_CALL_FRAMES)}</p>}
    <section className="call-card" aria-label={T('调用栈与栈帧')}>
      <h3>{T('调用栈 / 每一次调用各有一帧')}</h3>
      <p className="figure-caption">{T('从栈顶到入口排列。选择暂停的调用者，检查它保存的局部变量和中间值。')}</p>
      <label>{T('检查哪一帧')}<select aria-label={T('检查调用帧')} value={frame.activations.some((item) => String(item.id) === inspection) ? inspection : 'active'} onChange={(event) => setInspection(event.target.value)}>
        <option value="active">{T('跟随当前执行帧')}</option>
        {[...frame.activations].reverse().map((item) => <option key={item.id} value={item.id}>#{item.id} {nameText(item.name)} · PC {item.pc}</option>)}
      </select></label>
      <ol className="call-chain" reversed>
        {[...frame.activations].reverse().map((item) => <li key={item.id}>
          <button type="button" className={selected.id === item.id ? 'selected' : ''} aria-pressed={selected.id === item.id} onClick={() => setInspection(String(item.id))}>
            <strong>#{item.id} · {nameText(item.name)}</strong><span>PC {item.pc} · {active.id === item.id ? T('当前帧') : T('等待返回')}</span>
          </button>
        </li>)}
      </ol>
      <div className="call-frame-detail" aria-label={T('选中帧的状态')}>
        <h3>#{selected.id} · {nameText(selected.name)}</h3>
        <p>{selected.returnTo ? T('返回到 {#0} : {#1}', nameText(selected.returnTo.name), selected.returnTo.pc) : T('入口帧：HALT 后结束程序')}</p>
        <div className="call-operand" aria-label={T('选中帧操作数栈')}><b>{T('操作数栈 / 底 → 顶')}</b><code>{selected.stack.length ? selected.stack.map(String).join(' → ') : T('空')}</code></div>
        <div className="table-scroll"><table>
          <caption>{T('独立局部变量表 / 存储槽位')}</caption>
          <thead><tr><th>{T('名字 / 槽位')}</th><th>{T('类型')}</th><th>{T('本帧的值')}</th></tr></thead>
          <tbody>{fn.locals.map((local) => <tr key={local.key}><td>{local.parameter ? Tx('{#0} · 形参', <code>{local.key}</code>) : <code>{local.key}</code>}</td><td>{local.dataType}</td><td>{Object.hasOwn(selected.locals, local.key) ? String(selected.locals[local.key]) : T('尚未初始化')}</td></tr>)}</tbody>
        </table></div>
        {!fn.locals.length && <p>{T('本帧没有局部变量槽位。')}</p>}
        <p className="figure-caption">{T('# 后的槽位编号区分块内同名声明；不同调用帧仍各存一份。离开块后，保留的槽位不改变源码的作用域规则。')}</p>
      </div>
    </section>
    <section className="call-card" aria-label={T('函数字节码')}>
      <h3>{T('{#0} / 生成的字节码', nameText(selected.name))}</h3>
      <p className="figure-caption">{T('箭头指向此帧下一条待执行指令。暂停的调用者已经保存 CALL 后的 PC。')}</p>
      <div className="table-scroll call-code" ref={codeList}><table>
        <thead><tr><th>PC</th><th>{T('指令')}</th></tr></thead>
        <tbody>{fn.code.map((instruction, pc) => <tr key={pc} className={pc === selected.pc ? 'current' : ''} aria-current={pc === selected.pc ? 'step' : undefined}><td>{pc === selected.pc ? '→ ' : ''}{pc}</td><td><code>{callInstructionText(instruction)}</code></td></tr>)}</tbody>
      </table></div>
      {frame.location && <p className="call-location">{T('最近动作 · 第 {#0} 行', source.slice(0, frame.location.start).split('\n').length)}<br /><code>{source.slice(frame.location.start, frame.location.end) || T('程序末尾')}</code></p>}
    </section>
    <section className="call-card" aria-label={T('调用与返回记录')}>
      <h3>{T('调用与返回 / 本步之前的最近 12 次')}</h3>
      {events.length ? <ol className="call-events">{events.map((event) => <li key={`${event.kind}:${event.id}`}><span>{event.kind === 'call' ? T('入栈') : T('返回')} #{event.id} · {event.name}</span><code>{event.kind === 'call' ? `(${event.args!.join(', ')})` : `→ ${event.value}`}</code></li>)}</ol> : <p>{T('尚未执行 CALL。')}</p>}
      <div className="call-output" aria-label={T('本步程序输出')}><span>{T('程序输出')}</span><code>{frame.output.length ? frame.output.map(String).join(' · ') : T('等待 print…')}</code></div>
    </section>
    <p className="figure-caption">{T('此实验使用专用函数方言与教学调用协议。左到右求值、按值传参；已有 CFG、SSA 与优化实验仍使用原来的 Mini C 输入。')}</p>
  </div>;
}
