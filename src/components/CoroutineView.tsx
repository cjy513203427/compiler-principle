import type { CoroAnalysis } from '../compiler/coroutine';
import { CodeBlock } from './CodeBlock';
import '../styles-coroutine.css';

export function CoroutineView({ analysis, step }: { analysis: CoroAnalysis; step: number }) {
  const frame = analysis.frames[step];
  const phaseLabel = {
    lower: '编译期降级为状态机',
    create: '创建协程帧（state = 0）',
    'resume-enter': 'resume · switch(state) 恢复',
    yield: 'yield · 保存状态并弹出调用栈',
    return: 'return · 置为 DONE',
    print: '驱动代码输出',
    complete: '状态机执行与独立生成器核对',
  }[frame.kind];

  return (
    <div className="coro-view">
      <div className="coro-status" role="status">
        <strong>{phaseLabel}</strong>
        <span>
          {analysis.coros.length} 个协程 · resume {analysis.resumeCount} 次 · yield {analysis.yieldCount} 次 ·{' '}
          {analysis.equivalent === 'same' ? '与独立生成器结果一致' : analysis.equivalent === 'unknown' ? '达到上限' : '存在差异'}
        </span>
      </div>

      <section className="coro-card" aria-label="本步协程状态机">
        <h3>观察这一步</h3>
        <p>{frame.message}</p>
      </section>

      {frame.instances.length > 0 && (
        <section className="coro-card" aria-label="活动协程帧">
          <h3>堆上的协程状态帧（每次 yield 后仅保留这里）</h3>
          <div className="coro-inst-grid">
            {frame.instances.map((inst) => (
              <article
                key={inst.id}
                className={`coro-inst ${frame.focusInstance === inst.id ? 'focus' : ''} ${inst.state === -1 ? 'done' : ''}`}
              >
                <header>
                  <strong>{inst.handleName} ({inst.name}Frame)</strong>
                  <span className="state-pill">{inst.state === -1 ? 'state = DONE' : `state = ${inst.state}`}</span>
                </header>
                <div className="coro-fields">
                  {inst.fields.map((f) => (
                    <span key={f.name}><code>{f.name}</code> = {f.value}</span>
                  ))}
                  {!inst.fields.length && <small>无跨 yield 字段</small>}
                </div>
                <small className="coro-last">{inst.lastEvent}</small>
              </article>
            ))}
          </div>
        </section>
      )}

      <section className="coro-card" aria-label="降级后的状态机代码">
        <h3>编译期产物：协程帧分析与 switch(state) 状态机</h3>
        {analysis.coros.map((c) => (
          <div key={c.name} className={`coro-lower-block ${frame.focusCoro === c.name ? 'focus' : ''}`}>
            <div className="coro-liveness-row">
              <span><strong>coro {c.name}</strong>（{c.yieldCount} 个挂起点）</span>
              <span className="tag-hoisted">提升到协程帧：{c.hoistedVars.join(', ') || '无'}</span>
              <span className="tag-transient">留在临时栈：{c.transientVars.join(', ') || '无'}</span>
            </div>
            <CodeBlock title={`${c.name} 降级后的状态机`} language="c" code={c.loweredCode} />
          </div>
        ))}
      </section>

      <div className="output-console">
        <span>stdout {analysis.error ? `· 错误：${analysis.error}` : ''}</span>
        <pre>{frame.output.length ? frame.output.map(String).join('\n') : '等待 print…'}</pre>
      </div>
      {analysis.traceTruncated && <p className="figure-caption">回放记录前 240 步；最终状态机代码与输出仍完整。</p>}
    </div>
  );
}
