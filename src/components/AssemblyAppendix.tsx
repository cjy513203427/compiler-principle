import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  AssemblyNoteId,
  AssemblyParameters,
  AssemblyTopic,
  Register,
  Snapshot,
} from '../compiler/assembly/model';
import { ARRAY_BASE, INITIAL_RSP, hex, signedValue } from '../compiler/assembly/model';
import { aliasInfo, readRegister, runAssembly } from '../compiler/assembly/machine';
import { buildProgram } from '../compiler/assembly/programs';
import { defaultParameters } from '../content/assembly';
import { assemblyShareUrl, readAssemblyUrl, validateParameters } from '../assembly/state';
import { assemblyTopics, ASSEMBLY_SOURCES, instructionCards } from '../content/assembly';
import fixture from '../content/assembly-fixture.json';
import type { Notebook } from '../state';
import { CodeBlock } from './CodeBlock';
import '../styles-assembly.css';
import AssemblyReadingGuide from './AssemblyReadingGuide';
import { ASSEMBLY_TITLE, assemblyBookReferences } from '../content/assembly-reading';
import { lessons } from '../content/lessons';
import { T } from '../i18n';
import { Tx } from '../i18n/jsx';

const wantsExperiment = (search: string) => {
  const query = new URLSearchParams(search);
  return query.has('asm') || query.has('args');
};

type Draft = Omit<AssemblyParameters, 'a' | 'b' | 'n' | 'array' | 'index'> & {
  a: string;
  b: string;
  n: string;
  array: string[];
  index: string;
};
const draftOf = (p: AssemblyParameters): Draft => ({
  ...p,
  a: String(p.a),
  b: String(p.b),
  n: String(p.n),
  index: String(p.index),
  array: p.array.map(String),
});
const displayedRegisters: Register[] = ['RAX', 'RCX', 'RDX', 'R8', 'RSP'];
function memoryValue(state: Snapshot, address: bigint, bytes: number): bigint | undefined {
  let value = 0n;
  for (let i = 0; i < bytes; i++) {
    const byte = state.memory[String(address + BigInt(i))];
    if (byte === undefined) return undefined;
    value |= BigInt(byte) << BigInt(i * 8);
  }
  return value;
}
export default function AssemblyAppendix({
  headingRef,
  notebook,
  onNote,
  onComplete,
  storageError,
}: {
  headingRef: React.RefObject<HTMLHeadingElement | null>;
  notebook: Notebook;
  onNote: (id: AssemblyNoteId, text: string) => void;
  onComplete: (id: AssemblyNoteId) => void;
  storageError: boolean;
}) {
  const [initial] = useState(() => readAssemblyUrl(window.location.search));
  const [topic, setTopic] = useState<AssemblyTopic>(initial.topic);
  const [parameters, setParameters] = useState(initial.parameters);
  const [draft, setDraft] = useState<Draft>(() => draftOf(initial.parameters));
  const [step, setStep] = useState(initial.step);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [panel, setPanel] = useState<'guide' | 'lab' | 'reading' | 'cards' | 'real' | 'recall'>(
    () => (wantsExperiment(window.location.search) ? 'lab' : 'guide'),
  );
  const flagNames = {
    ZF: T('结果为零'),
    SF: T('结果最高位'),
    CF: T('无符号进位 / 借位'),
    OF: T('有符号溢出'),
  };
  const [error, setError] = useState(initial.invalid ? T('链接中的参数无效，已恢复安全示例。') : '');
  const [shareStatus, setShareStatus] = useState('');
  const [shareFallback, setShareFallback] = useState('');
  const [instructionName, setInstructionName] = useState('MOV');
  const [quiz, setQuiz] = useState<number>();
  const [reference, setReference] = useState(false);
  const [optimization, setOptimization] = useState<'O0' | 'O2'>('O0');
  const codeContainer = useRef<HTMLDivElement>(null);
  const info = assemblyTopics.find((item) => item.id === topic)!;
  const program = useMemo(() => buildProgram(topic, parameters), [topic, parameters]);
  const execution = useMemo(() => runAssembly(program), [program]);
  const currentStep = Math.min(step, execution.steps.length - 1);
  const state = execution.steps[currentStep];
  const dirty = JSON.stringify(draft) !== JSON.stringify(draftOf(parameters));
  const card = instructionCards.find((item) => item.name === instructionName)!;
  const completed = notebook.completed.includes(info.noteId);
  useEffect(() => {
    const pop = () => {
      const restored = readAssemblyUrl(window.location.search);
      setTopic(restored.topic);
      setParameters(restored.parameters);
      setDraft(draftOf(restored.parameters));
      setStep(restored.step);
      setPlaying(false);
      setError(restored.invalid ? T('链接参数无效，已恢复示例。') : '');
      setPanel(wantsExperiment(window.location.search) ? 'lab' : 'guide');
    };
    window.addEventListener('popstate', pop);
    return () => window.removeEventListener('popstate', pop);
  }, []);
  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(
      () =>
        setStep((previous) => {
          if (previous >= execution.steps.length - 1) {
            setPlaying(false);
            return execution.steps.length - 1;
          }
          return previous + 1;
        }),
      850 / speed,
    );
    return () => clearInterval(timer);
  }, [playing, execution, speed]);
  useEffect(() => {
    const pause = () => {
      if (document.hidden) setPlaying(false);
    };
    document.addEventListener('visibilitychange', pause);
    return () => document.removeEventListener('visibilitychange', pause);
  }, []);
  useEffect(() => {
    const op = execution.instructions[state.pc]?.instruction.op;
    if (op) setInstructionName(op);
    const container = codeContainer.current;
    const active = container?.querySelector<HTMLElement>('.asm-line.current');
    if (container && active) {
      const top = active.offsetTop;
      if (
        top < container.scrollTop ||
        top + active.offsetHeight > container.scrollTop + container.clientHeight
      )
        container.scrollTop = Math.max(0, top - 40);
    }
  }, [state.pc, execution]);
  function choose(next: AssemblyTopic) {
    const p = defaultParameters(next);
    setTopic(next);
    setParameters(p);
    setDraft(draftOf(p));
    setStep(0);
    setPlaying(false);
    setPanel('lab');
    setError('');
    setQuiz(undefined);
    setReference(false);
    setShareStatus('');
    setShareFallback('');
    history.pushState(null, '', assemblyShareUrl(location.href, next, p, 0));
  }
  function edit<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((previous) => ({ ...previous, [key]: value }));
    setPlaying(false);
    setError('');
  }
  function apply() {
    try {
      if (
        [draft.a, draft.b, draft.n, draft.index, ...draft.array].some(
          (value) => value.trim() === '',
        )
      )
        throw new Error(T('请先填写完整的整数参数。'));
      const p = validateParameters({
        ...draft,
        a: Number(draft.a),
        b: Number(draft.b),
        n: Number(draft.n),
        index: Number(draft.index),
        array: draft.array.map(Number),
      });
      setParameters(p);
      setDraft(draftOf(p));
      setStep(0);
      setPlaying(false);
      setError('');
      setShareStatus('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : T('参数无效。'));
    }
  }
  function preset(kind: 'normal' | 'carry' | 'overflow' | 'zero' | 'signed' | 'unsigned') {
    const p = { ...parameters, array: [...parameters.array] };
    if (kind === 'carry') {
      p.a = 4294967295;
      p.b = 1;
    } else if (kind === 'overflow') {
      p.a = 2147483647;
      p.b = 1;
    } else if (kind === 'zero') p.n = 0;
    else if (kind === 'signed' || kind === 'unsigned') {
      p.a = -1;
      p.b = 1;
      p.unsigned = kind === 'unsigned';
    } else Object.assign(p, defaultParameters(topic));
    setParameters(p);
    setDraft(draftOf(p));
    setStep(0);
    setPlaying(false);
    setError('');
  }
  async function share() {
    const url =
      panel === 'guide'
        ? new URL('?lab=assembly', location.href).href
        : assemblyShareUrl(location.href, topic, parameters, currentStep);
    history.replaceState(null, '', url);
    try {
      await navigator.clipboard.writeText(url);
      setShareStatus(
        panel === 'guide'
          ? T('已复制阅读附录链接，不含私人笔记。')
          : T('已复制：包含已应用参数、主题和步骤，不含私人笔记。'),
      );
    } catch {
      setShareFallback(url);
    }
  }
  const returned =
    currentStep === execution.steps.length - 1 && execution.halted && !execution.error;
  const numeric = (name: 'a' | 'b' | 'n' | 'index', label: string, min: number, max: number) => (
    <label className="asm-field">
      {label}
      <input
        aria-label={label}
        type="number"
        min={min}
        max={max}
        step={1}
        value={draft[name]}
        onChange={(event) => edit(name, event.target.value)}
      />
    </label>
  );
  return (
    <div className="assembly-appendix">
      <section className="lesson-heading">
        <div className="eyebrow">{T('随书附录 / 选读第 08、16 讲 · 指令与编译器写法')}</div>
        <div className="title-row">
          <h1 ref={headingRef} tabIndex={-1}>
            {ASSEMBLY_TITLE}
          </h1>
          <button className="button secondary" onClick={share}>
            {panel === 'guide' ? T('分享阅读附录 ↗') : T('分享当前实验 ↗')}
          </button>
        </div>
        <p>
          {T(
            '读原书遇到汇编时，查清指令含义、平台约定和编译器的选择。这里保留必要的读法与交互对照，汇编基础另成专题。',
          )}
        </p>
      </section>
      {(['lab', 'reading', 'recall'] as string[]).includes(panel) && (
        <>
          <nav className="asm-topics" aria-label={T('汇编附录主题')}>
            {assemblyTopics.map((item, index) => (
              <button
                key={item.id}
                aria-pressed={item.id === topic}
                className={item.id === topic ? 'active' : ''}
                onClick={() => choose(item.id)}
              >
                <span>{index < 5 ? `A${index + 1}` : '8086'}</span>
                {item.title}
                {notebook.completed.includes(item.noteId) && <b>✓</b>}
              </button>
            ))}
          </nav>
          <div className="asm-topic-heading">
            <h2>{info.question}</h2>
            <p>{info.intro}</p>
          </div>
          <div className="asm-boundary">
            <strong>{T('教学回放')}</strong>
            <span>{T('手写指令配合模拟器逐步计算。编译器生成的固定样例可在“真实输出”中对照。')}</span>
          </div>
          <details className="asm-primer">
            <summary>{T('读法提醒：寄存器、内存和指令')}</summary>
            <p>
              {Tx(
                '{#0}可以先理解为 CPU 里几个有名字的小格子。EAX、ECX 等名字指向固定的格子；高级语言的变量可能暂存在其中，实际对应由编译器决定。',
                <strong>{T('寄存器')}</strong>,
              )}
            </p>
            <p>
              {Tx(
                '{#0}像一排按字节编号的储物格。地址就是编号，0x 开头表示十六进制；一个 int32_t 占 4 字节，32 位等于 4 个字节。',
                <strong>{T('内存')}</strong>,
              )}
            </p>
            <p>
              {Tx(
                '{#0}把大动作拆小：本附录的 Intel 语法把目标写在左边。mov eax, ecx 类似“eax = ecx”；add eax, edx 类似“eax = eax + edx”。点“下一步”，绿色高亮显示刚执行的指令和变化的状态。',
                <strong>{T('指令')}</strong>,
              )}
            </p>
          </details>
        </>
      )}
      <div className="lesson-tabs asm-tabs" aria-label={T('汇编学习方式')}>
        {(
          [
            { id: 'guide', label: T('随书导读') },
            { id: 'lab', label: T('动手对照') },
            { id: 'reading', label: T('原理与边界') },
            { id: 'cards', label: T('指令速查') },
            { id: 'real', label: T('真实输出') },
            { id: 'recall', label: T('复述自测') },
          ] as const
        ).map((item) => (
          <button
            key={item.id}
            className={panel === item.id ? 'active' : ''}
            aria-pressed={panel === item.id}
            onClick={() => {
              setPanel(item.id);
              setPlaying(false);
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
      {panel === 'guide' && <AssemblyReadingGuide onExperiment={choose} />}
      {shareStatus && (
        <p className="asm-status" role="status">
          {shareStatus}
        </p>
      )}
      {shareFallback && (
        <label className="share-fallback">
          {T('复制这个实验链接')}
          <input readOnly value={shareFallback} onFocus={(event) => event.target.select()} />
        </label>
      )}
      {panel === 'lab' && (
        <>
          <section className="asm-inputs" aria-label={T('汇编示例参数')}>
            <div className="asm-parameter-grid">
              {(['arithmetic', 'branch', 'call'] as AssemblyTopic[]).includes(topic) && (
                <>
                  {numeric('a', T('参数 a'), -2147483648, 4294967295)}
                  {numeric('b', T('参数 b'), -2147483648, 4294967295)}
                </>
              )}
              {topic === 'branch' && (
                <label className="asm-field">
                  {T('比较方式')}
                  <select
                    aria-label={T('比较方式')}
                    value={draft.unsigned ? 'unsigned' : 'signed'}
                    onChange={(event) => edit('unsigned', event.target.value === 'unsigned')}
                  >
                    <option value="signed">{T('int32_t · 有符号')}</option>
                    <option value="unsigned">{T('uint32_t · 无符号')}</option>
                  </select>
                </label>
              )}
              {topic === 'loop' && numeric('n', T('循环上界 n'), 0, 12)}
              {topic === 'memory' && (
                <>
                  {draft.array.map((value, index) => (
                    <label className="asm-field" key={index}>
                      a[{index}]
                      <input
                        aria-label={T('数组元素 {#0}', index)}
                        type="number"
                        value={value}
                        onChange={(event) =>
                          edit(
                            'array',
                            draft.array.map((v, i) => (i === index ? event.target.value : v)),
                          )
                        }
                      />
                    </label>
                  ))}
                  {numeric('index', T('数组索引 i'), 0, 3)}
                  <label className="asm-field">
                    {T('读取方式')}
                    <select
                      aria-label={T('读取方式')}
                      value={draft.addressFirst ? 'lea' : 'direct'}
                      onChange={(event) => edit('addressFirst', event.target.value === 'lea')}
                    >
                      <option value="direct">{T('MOV 直接读取')}</option>
                      <option value="lea">{T('LEA 算地址，再 MOV')}</option>
                    </select>
                  </label>
                </>
              )}
              {topic === 'registers' && (
                <>
                  <label className="asm-field">
                    {T('RAX 初值（十六进制）')}
                    <input
                      aria-label={T('RAX 初值')}
                      value={draft.registerHex}
                      maxLength={16}
                      spellCheck={false}
                      onChange={(event) => edit('registerHex', event.target.value)}
                    />
                  </label>
                  <label className="asm-field">
                    {T('写入窗口')}
                    <select
                      aria-label={T('写入窗口')}
                      value={draft.alias}
                      onChange={(event) =>
                        edit('alias', event.target.value as AssemblyParameters['alias'])
                      }
                    >
                      {['AL', 'AH', 'AX', 'EAX', 'RAX'].map((value) => (
                        <option key={value}>{value}</option>
                      ))}
                    </select>
                  </label>
                  <label className="asm-field">
                    {T('写入值（十六进制）')}
                    <input
                      aria-label={T('寄存器写入值')}
                      value={draft.writeHex}
                      maxLength={16}
                      spellCheck={false}
                      onChange={(event) => edit('writeHex', event.target.value)}
                    />
                  </label>
                </>
              )}
            </div>
            <div className="asm-input-actions">
              <button className="button primary" onClick={apply}>
                {T('应用参数并重算 ↵')}
              </button>
              <button className="text-button" onClick={() => preset('normal')}>
                {T('恢复本例')}
              </button>
              <span>{dirty ? T('参数待应用；下方仍展示上次结果') : T('源码与状态已同步')}</span>
            </div>
            <div className="asm-presets">
              {topic === 'arithmetic' && (
                <>
                  <button onClick={() => preset('carry')}>{T('对照：无符号进位')}</button>
                  <button onClick={() => preset('overflow')}>{T('对照：有符号溢出位')}</button>
                </>
              )}
              {topic === 'branch' && (
                <>
                  <button onClick={() => preset('signed')}>{T('−1 与 1 · signed')}</button>
                  <button onClick={() => preset('unsigned')}>{T('同样的位 · unsigned')}</button>
                </>
              )}
              {topic === 'loop' && (
                <button onClick={() => preset('zero')}>{T('对照：零次循环')}</button>
              )}
            </div>
            <p className="asm-prediction">
              <strong>{T('先预测：')}</strong>
              {info.prediction}
            </p>
            {error && (
              <p className="diagnostic" role="alert">
                {error}
              </p>
            )}
          </section>
          <div className="asm-player">
            <div className="step-explanation" aria-live="polite">
              <span className="step-number">{currentStep}</span>
              <p>{state.message}</p>
            </div>
            <input
              type="range"
              aria-label={T('汇编当前步骤')}
              min={0}
              max={execution.steps.length - 1}
              value={currentStep}
              onChange={(event) => {
                setStep(Number(event.target.value));
                setPlaying(false);
              }}
            />
            <div className="player-controls">
              <div>
                <button
                  aria-label={T('汇编重置步骤')}
                  onClick={() => {
                    setStep(0);
                    setPlaying(false);
                  }}
                >
                  ↺
                </button>
                <button
                  aria-label={T('汇编上一步')}
                  disabled={currentStep === 0}
                  onClick={() => {
                    setStep(currentStep - 1);
                    setPlaying(false);
                  }}
                >
                  ‹
                </button>
                <button
                  className="play-button"
                  aria-label={playing ? T('汇编暂停') : T('汇编播放')}
                  disabled={dirty}
                  onClick={() => {
                    if (currentStep === execution.steps.length - 1) setStep(0);
                    setPlaying(!playing);
                  }}
                >
                  {playing ? T('Ⅱ 暂停') : T('▷ 播放')}
                </button>
                <button
                  aria-label={T('汇编下一步')}
                  disabled={currentStep === execution.steps.length - 1}
                  onClick={() => {
                    setStep(currentStep + 1);
                    setPlaying(false);
                  }}
                >
                  ›
                </button>
              </div>
              <span>
                {currentStep} / {execution.steps.length - 1}
              </span>
              <select
                aria-label={T('汇编播放速度')}
                value={speed}
                onChange={(event) => setSpeed(Number(event.target.value))}
              >
                <option value={0.5}>0.5×</option>
                <option value={1}>1×</option>
                <option value={2}>2×</option>
              </select>
              <button
                className="jump-end"
                onClick={() => {
                  setStep(execution.steps.length - 1);
                  setPlaying(false);
                }}
              >
                {T('看汇编最终结果 →')}
              </button>
            </div>
          </div>
          <div className="asm-code-grid">
            <section className="asm-panel">
              <div className="panel-title">
                <h3>{topic === 'registers' ? T('窗口操作示意') : T('简单高级语言')}</h3>
                <span>{topic === 'registers' ? T('非 C 程序') : T('C / stdint 类型')}</span>
              </div>
              <div className="asm-source" aria-label={T('高级语言对照')}>
                {program.source.map((line, index) => (
                  <div
                    key={index}
                    className={`asm-source-line ${index === state.sourceLine ? 'current' : ''}`}
                  >
                    <span>{index + 1}</span>
                    <code>{line || ' '}</code>
                  </div>
                ))}
              </div>
              <p className="figure-caption">
                {topic === 'registers'
                  ? T('左侧仅帮助理解位窗口，不送入 C 编译器。')
                  : topic === 'loop'
                    ? T('示例参数：n = {#0}。输入先保留低 32 位，再按示例类型解释。', parameters.n)
                    : topic === 'memory'
                      ? T(
                          '示例参数：a = [{#0}]，i = {#1}。输入先保留低 32 位，再按示例类型解释。',
                          parameters.array.join(', '),
                          parameters.index,
                        )
                      : T(
                          '示例参数：a = {#0}，b = {#1}。输入先保留低 32 位，再按示例类型解释。',
                          parameters.a,
                          parameters.b,
                        )}
              </p>
            </section>
            <section className="asm-panel">
              <div className="panel-title">
                <h3>{T('教学汇编')}</h3>
                <span>{T('Intel · 目标在左')}</span>
              </div>
              <div className="asm-code" ref={codeContainer} aria-label={T('汇编指令列表')}>
                {program.lines.map((line, index) => (
                  <div
                    key={index}
                    className={`asm-line ${line.instruction ? '' : 'label'} ${index === state.line ? 'current' : ''}`}
                  >
                    <span>
                      {line.instruction
                        ? execution.instructions.findIndex((item) => item.line === index)
                        : ''}
                    </span>
                    <button
                      onClick={() => {
                        if (line.instruction) {
                          setInstructionName(line.instruction.op);
                          setPlaying(false);
                        }
                      }}
                      disabled={!line.instruction}
                      aria-label={
                        line.instruction
                          ? T('查看 {#0} 指令说明 {#1}', line.instruction.op, index)
                          : undefined
                      }
                    >
                      <code>{line.text}</code>
                    </button>
                    {index === state.line && <b>←</b>}
                  </div>
                ))}
              </div>
              <p className="figure-caption">
                {T(
                  '标签不算指令。PC 与栈中返回位置按 #指令序号示意，省略机器编码和真实 RIP 字节地址。',
                )}
              </p>
            </section>
          </div>
          <section className="asm-state-panel">
            <div className="panel-title">
              <h3>{T('执行后的机器状态')}</h3>
              <span>
                {T('下一 PC = #{#0} · 当前函数 {#1}', state.nextPc, state.frames.at(-1)?.name || T('已返回'))}
              </span>
            </div>
            <div className="asm-registers">
              {displayedRegisters.map((name) => (
                <div key={name} className={state.changedRegisters.includes(name) ? 'changed' : ''}>
                  <strong>
                    {name}
                    <span>
                      {name === 'RAX'
                        ? T('返回值 / 计算结果')
                        : name === 'RSP'
                          ? T('栈顶地址')
                          : name === 'RCX'
                            ? T('第 1 个整数 / 指针参数')
                            : name === 'RDX'
                              ? T('第 2 个整数参数 / 索引')
                              : T('地址计算 / 临时值')}
                    </span>
                  </strong>
                  <code>{hex(state.registers[name])}</code>
                  <small>
                    {name === 'RSP'
                      ? `RSP mod 16 = ${state.registers.RSP % 16n}`
                      : T(
                          '低 32 位：u32 {#0} / i32 {#1}',
                          BigInt.asUintN(32, state.registers[name]),
                          BigInt.asIntN(32, state.registers[name]),
                        )}
                  </small>
                </div>
              ))}
            </div>
            <div className="asm-flags" aria-label={T('标志位')}>
              {(Object.keys(flagNames) as (keyof typeof flagNames)[]).map((name) => (
                <div key={name} className={state.changedFlags.includes(name) ? 'changed' : ''}>
                  <strong>
                    {name} = {Number(state.flags[name])}
                  </strong>
                  <span>{flagNames[name]}</span>
                </div>
              ))}
            </div>
            <div className="asm-bindings">
              {program.bindings.map((binding) => (
                <span key={binding.name}>
                  {Tx(
                    '{#0} ↔ {#1}：{#2}',
                    binding.name,
                    <code>{binding.register}</code>,
                    <b>
                      {String(
                        binding.signed
                          ? signedValue(
                              readRegister(state.registers, binding.register),
                              aliasInfo(binding.register).width,
                            )
                          : readRegister(state.registers, binding.register),
                      )}
                    </b>,
                  )}
                </span>
              ))}
            </div>
            {topic === 'registers' && (
              <div className="asm-byte-view">
                <span>{T('RAX 的 8 个字节 · 左高位、右低位')}</span>
                <div>
                  {Array.from({ length: 8 }, (_, index) => (
                    <code
                      key={index}
                      className={
                        currentStep > 0 &&
                        (((7 - index) * 8 >= aliasInfo(parameters.alias).offset &&
                          (7 - index) * 8 <
                            aliasInfo(parameters.alias).offset +
                              aliasInfo(parameters.alias).width) ||
                          (parameters.alias === 'EAX' && index < 4))
                          ? 'changed'
                          : ''
                      }
                    >
                      {((state.registers.RAX >> BigInt((7 - index) * 8)) & 255n)
                        .toString(16)
                        .toUpperCase()
                        .padStart(2, '0')}
                    </code>
                  ))}
                </div>
                <p>
                  {parameters.alias === 'EAX'
                    ? T('写 {#0}：低 32 位被写入，高 32 位清零。', parameters.alias)
                    : parameters.alias === 'RAX'
                      ? T('写 {#0}：覆盖全部 64 位。', parameters.alias)
                      : T('写 {#0}：只覆盖这个窗口，其他位保留。', parameters.alias)}
                </p>
              </div>
            )}
            {topic === 'memory' && (
              <div className="asm-array">
                <h4>{T('数组内存 / 32 位元素')}</h4>
                {parameters.array.map((value, index) => {
                  const address = ARRAY_BASE + BigInt(index * 4);
                  const accessed = state.accesses.some(
                    (access) => access.address === address && access.kind === 'read',
                  );
                  return (
                    <div key={index} className={accessed ? 'changed' : ''}>
                      <span>a[{index}]</span>
                      <code>{hex(address)}</code>
                      <b>{value}</b>
                      <small>
                        {T(
                          '低地址 → 高地址：{#0}',
                          Array.from({ length: 4 }, (_, byte) =>
                            state.memory[String(address + BigInt(byte))]
                              ?.toString(16)
                              .toUpperCase()
                              .padStart(2, '0'),
                          ).join(' '),
                        )}
                      </small>
                    </div>
                  );
                })}
                <p className="figure-caption">
                  {T(
                    '本步数据内存读取：{#0} 次。LEA 只算地址，因此这一项为 0。',
                    state.accesses.filter(
                      (access) => access.kind === 'read' && access.address >= ARRAY_BASE,
                    ).length,
                  )}
                </p>
              </div>
            )}
            {topic === 'call' && (
              <div className="asm-stack">
                <h4>{T('调用栈 / RSP 向低地址增长')}</h4>
                <div className="asm-frames">
                  {state.frames.map((frame, index) => (
                    <span key={index}>{T('{#0} · 返回 #{#1}', frame.name, frame.returnPc)}</span>
                  ))}
                  {!state.frames.length && <span>{T('已回到外部调用者')}</span>}
                </div>
                <div className="asm-stack-rows">
                  {Array.from({ length: 8 }, (_, index) => 0xfd8n + BigInt(index * 8)).map(
                    (address) => {
                      const value = memoryValue(state, address, 8);
                      const active = state.accesses.some((access) => access.address === address);
                      return (
                        <div key={String(address)} className={active ? 'changed' : ''}>
                          <code>{hex(address, 16)}</code>
                          <span>{address === state.registers.RSP ? '← RSP' : ''}</span>
                          <b>
                            {value !== undefined
                              ? T('返回位置 #{#0}', value)
                              : address >= 0xfe0n && address < 0x1000n && currentStep >= 3
                                ? T('32B shadow space · 未写入')
                                : T('未初始化 / 填充')}
                          </b>
                        </div>
                      );
                    },
                  )}
                </div>
                <p className="figure-caption">
                  {T(
                    '入口 RSP = {#0}。本例先减 40 = 32B shadow space + 8B 对齐；CALL 再压入 8B 返回位置。内存中的 # 不是实际机器地址。',
                    hex(INITIAL_RSP),
                  )}
                </p>
              </div>
            )}
            <div className={`asm-result ${returned ? 'finished' : ''}`}>
              <span>
                {returned
                  ? topic === 'registers'
                    ? T('片段结束 / RAX')
                    : T('返回值 / EAX')
                  : T('本次回放')}
              </span>
              <strong>
                {returned
                  ? String(
                      program.signedReturn
                        ? signedValue(execution.result, program.returnWidth)
                        : execution.result,
                    )
                  : T('等待完成…')}
              </strong>
              <p>
                {returned
                  ? execution.result === program.expected
                    ? T('✓ 与左侧示例的独立计算结果一致')
                    : T('结果不一致，请检查')
                  : T('按下一步观察当前指令造成的变化。')}
              </p>
            </div>
            {execution.error && (
              <p className="diagnostic" role="alert">
                {execution.error}
              </p>
            )}
          </section>
          <aside className="asm-instruction-card">
            <span>{T('本步指令 / 点击汇编行可查')}</span>
            <h3>
              {card.name} · {card.meaning}
            </h3>
            <code>{card.form}</code>
            <p>{card.effect}</p>
          </aside>
        </>
      )}
      {panel === 'reading' && (
        <article className="reading-page">
          {info.notes.map((note, index) => (
            <section key={note.title}>
              <span className="reading-number">0{index + 1}</span>
              <h3>{note.title}</h3>
              <p>{note.body}</p>
            </section>
          ))}
          <aside className="misconception">
            <strong>{T('容易混淆')}</strong>
            <p>{info.misconception}</p>
          </aside>
          {topic === 'registers' && (
            <div className="table-scroll">
              <table className="asm-transition-table">
                <thead>
                  <tr>
                    <th>{T('你可能熟悉的 8086')}</th>
                    <th>{T('本附录的 x86-64 主线')}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>{T('AX、AL、AH')}</td>
                    <td>{T('同一 RAX 的窗口；增加 EAX、RAX 的宽度与写入规则')}</td>
                  </tr>
                  <tr>
                    <td>{T('IP、SP 与 16 位直觉')}</td>
                    <td>{T('现代指令指针 RIP、栈指针 RSP；本例 PC 只用序号示意')}</td>
                  </tr>
                  <tr>
                    <td>{T('段寄存器与段:偏移')}</td>
                    <td>{T('本附录不模拟分段/分页；不能把旧的地址公式套到 64 位示例')}</td>
                  </tr>
                  <tr>
                    <td>{T('CALL/RET 与标志位')}</td>
                    <td>{T('继续保留这些直觉，再明确操作数宽度与 ABI')}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
          <section>
            <h3>{T('这份模拟覆盖什么')}</h3>
            <p>
              {T(
                '初始寄存器与标志的零值是教学设置，不是 ABI 保证。只执行页面生成的指令子集：寄存器窗口、32/64 位整数、四个标志、地址读取与简单调用。不解析任意 C/汇编，不包含异常展开、分段分页、系统调用、SIMD 或机器编码。数组越界和未初始化读取是教学检查，并非 CPU 自动保证。',
              )}
            </p>
            <p>
              {T(
                '左侧变量与寄存器的对应只适用于这份手写实现。真实编译器优化后可能合并变量、消除分支或改用其他指令，不能机械地一一对应。',
              )}
            </p>
          </section>
          <AssemblyReferences />
        </article>
      )}
      {panel === 'cards' && (
        <>
          <p className="asm-reading-tip">
            {T('这里是交互实验支持的 11 条指令。原书选读中出现的 PUSH / POP 与 ARM 指令，可从“随书导读”查阅。')}
          </p>
          <div className="asm-card-grid">
            {instructionCards.map((item) => (
              <article key={item.name}>
                <h3>
                  {item.name}
                  <small>{item.meaning}</small>
                </h3>
                <code>{item.form}</code>
                <p>{item.effect}</p>
              </article>
            ))}
            <AssemblyReferences />
          </div>
        </>
      )}
      {panel === 'real' && (
        <section className="asm-real">
          <div className="asm-real-heading">
            <h2>{T('真实编译器输出 / 固定核对样例')}</h2>
            <select
              aria-label={T('真实汇编优化级别')}
              value={optimization}
              onChange={(event) => setOptimization(event.target.value as 'O0' | 'O2')}
            >
              <option>O0</option>
              <option>O2</option>
            </select>
          </div>
          <p>
            {T(
              '以下内容由本机 GCC 实际生成，参数面板不会重新编译这些固定文件。它与“动手对照”的教学汇编分别展示。',
            )}
          </p>
          <dl>
            <div>
              <dt>{T('编译器')}</dt>
              <dd>{fixture.compiler}</dd>
            </div>
            <div>
              <dt>{T('环境与 ABI')}</dt>
              <dd>
                {Tx(
                  '{#0}；所有样例函数显式使用 {#1}，因此采用 Microsoft x64 调用规则。这不是 Windows PE 构建。',
                  fixture.target,
                  <code>ms_abi</code>,
                )}
              </dd>
            </div>
            <div>
              <dt>{T('选项')}</dt>
              <dd>
                <code>{fixture.flags}</code>
              </dd>
            </div>
            <div>
              <dt>{T('核对')}</dt>
              <dd>
                {fixture.checkedAt} · {fixture.nativeChecks}
              </dd>
            </div>
          </dl>
          <div className="asm-real-links">
            <a href="/assembly/compare.c" download>
              {T('下载固定 C 源码 ↓')}
            </a>
            <a href={`/assembly/gcc-${optimization}.s`} download>
              {T('下载 {#0} 原始汇编 ↓', optimization)}
            </a>
            <a href="/assembly/provenance.json" download>
              {T('版本、命令与 SHA-256 ↓')}
            </a>
          </div>
          <p className="asm-static-note">
            {T(
              'O2 中的 add32 可能用 LEA，比较可能用 SETcc，循环可能改写，caller 甚至可能直接返回常量。这些指令不一定在教学模拟器支持范围；原始输出在这里供阅读核对，不送入模拟器。',
            )}
          </p>
          <details>
            <summary>{T('查看这次实际编译的源码')}</summary>
            <CodeBlock code={fixture.source} language="c" title="compare.c" />
          </details>
          <CodeBlock
            className="asm-real-output"
            code={fixture.outputs[optimization]}
            language="asm"
            title={`gcc-${optimization}.s`}
            label={T('真实编译器汇编输出')}
          />
          <details>
            <summary>{T('在自己的环境重新生成')}</summary>
            <CodeBlock
              language="shell"
              title="terminal"
              code={
                'gcc -m64 -S -masm=intel -O0 -fno-asynchronous-unwind-tables -fno-stack-protector compare.c -o gcc-O0.s\ngcc -m64 -S -masm=intel -O2 -fno-asynchronous-unwind-tables -fno-stack-protector compare.c -o gcc-O2.s'
              }
            />
            <p>
              {T(
                'Linux GCC 默认是 System V；源码中的 ms_abi 是为这次对照显式添加的。完整重现脚本见仓库 scripts/generate-assembly.sh；原生 Windows 工具链的指令选择和附加元数据可能不同。',
              )}
            </p>
          </details>
        </section>
      )}
      {panel === 'recall' && (
        <section className="recall-page">
          <div className="quiz-card">
            <div className="eyebrow">{T('QUICK CHECK / 汇编核对')}</div>
            <h2>{info.quiz.question}</h2>
            <div className="quiz-options">
              {info.quiz.options.map((option, index) => (
                <button
                  key={option}
                  aria-pressed={quiz === index}
                  className={quiz === index ? 'chosen' : ''}
                  onClick={() => setQuiz(index)}
                >
                  <span>{String.fromCharCode(65 + index)}</span>
                  {option}
                </button>
              ))}
            </div>
            {quiz !== undefined && (
              <div
                className={`quiz-feedback ${quiz === info.quiz.correct ? 'correct' : ''}`}
                role="status"
              >
                <strong>{quiz === info.quiz.correct ? T('✓ 判断正确') : T('再想一想')}</strong>
                <p>{info.quiz.explain}</p>
              </div>
            )}
          </div>
          <div className="recall-card">
            <h2>{T('合上说明，再讲一遍。')}</h2>
            <p>{info.challenge}</p>
            <textarea
              aria-label={T('{#0}的汇编笔记', info.title)}
              value={notebook.notes[info.noteId] || ''}
              maxLength={20000}
              onChange={(event) => onNote(info.noteId, event.target.value)}
              placeholder={T('写下你对寄存器、指令和状态变化的理解……')}
            />
            <div className="note-status">
              <span>
                {storageError
                  ? T('本地存储不可用，请导出备份')
                  : T('保存在当前浏览器；可在“我的笔记”统一导出')}
              </span>
              <button
                className="text-button"
                onClick={() => setReference(!reference)}
                aria-expanded={reference}
              >
                {reference ? T('收起参考解释 ↑') : T('展开参考解释 ↓')}
              </button>
            </div>
            {reference && <p className="reference-answer">{info.answer}</p>}
            <button
              className={`button ${completed ? 'secondary' : 'primary'}`}
              onClick={() => onComplete(info.noteId)}
            >
              {completed ? T('✓ 附录已复习 · 点击撤销') : T('我能解释了，标记附录已复习 ✓')}
            </button>
          </div>
        </section>
      )}
      <p className="asm-footer-note">
        {T(
          '附录用于随书查阅，不计入前面 {#0} 个核心实验的进度。已有汇编基础的读者可按需跳转；模拟与真实编译输出分别标明来源。',
          lessons.length,
        )}
      </p>
    </div>
  );
}
function AssemblyReferences() {
  return (
    <div className="reading-source">
      <span>{T('来源核对：2026-11-16 · 独立编写的说明与模拟器')}</span>
      {assemblyBookReferences.map((item) => (
        <a key={item.number} href={item.url} target="_blank" rel="noreferrer">
          {T('原书第 {#0} 讲 · {#1} ↗', item.number, item.title)}
        </a>
      ))}
      {ASSEMBLY_SOURCES.map((item) => (
        <a key={item.url} href={item.url} target="_blank" rel="noreferrer">
          {item.title} ↗
        </a>
      ))}
    </div>
  );
}
