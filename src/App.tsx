import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { assemblyTopics, ASSEMBLY_SOURCES } from './content/assembly';
import { assemblyShareUrl } from './assembly/state';
import { defaultParameters } from './content/assembly';
import { ASSEMBLY_TITLE, assemblyBookReferences } from './content/assembly-reading';
import { dominancePresets, DOMINANCE_REFERENCE, LOOP_REFERENCE } from './content/dominance';
import { automataPresets, REGEX_REFERENCE } from './content/automata';
import { analyzeAutomata } from './compiler/automata';
import { AutomataView } from './components/AutomataView';
import { compile, type Stage, type OptimizationOptions } from './compiler';
import { ResultView, traceLength, traceMessage } from './components/Views';
import {
  lessons,
  presets,
  chapters,
  chapterUrl,
  BOOK,
  defaultOptions,
  flowPresets,
  CONTROL_FLOW_REFERENCE,
  dataflowPresets,
  DATAFLOW_REFERENCE,
  CONSTANT_PROPAGATION_REFERENCE,
  type Lesson,
} from './content/lessons';
import {
  emptyNotebook,
  validateNotebook,
  readUrl,
  shareUrl,
  STORAGE_KEY,
  MAX_SOURCE,
  type Route,
  type Notebook,
  type NoteId,
} from './state';

const AssemblyAppendix = lazy(() => import('./components/AssemblyAppendix'));
const initial = readUrl(window.location.search);
const stageNames: Record<Stage, string> = {
  lex: '词法分析',
  parse: '语法分析',
  semantic: '语义分析',
  ir: '中间代码',
  optimize: '代码优化',
  vm: '虚拟机执行',
  cfg: '控制流图',
  dataflow: '数据流分析',
  dominance: '支配关系',
  automata: '正则与自动机',
};
function readNotebook(): Notebook {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? validateNotebook(JSON.parse(raw)) : emptyNotebook();
  } catch {
    return emptyNotebook();
  }
}
function Arrow({ direction = 'right' }: { direction?: 'right' | 'left' }) {
  return <span aria-hidden="true">{direction === 'right' ? '↗' : '←'}</span>;
}

export default function App() {
  const [route, setRoute] = useState<Route>(initial.route);
  const [source, setSource] = useState(initial.source);
  const [draft, setDraft] = useState(initial.source);
  const [step, setStep] = useState(initial.step);
  const [options, setOptions] = useState<OptimizationOptions>(initial.options);
  const [notebook, setNotebook] = useState<Notebook>(readNotebook);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [panel, setPanel] = useState<'lab' | 'reading' | 'recall'>('lab');
  const [menuOpen, setMenuOpen] = useState(false);
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 760px)').matches);
  const [notice, setNotice] = useState('');
  const [storageError, setStorageError] = useState(false);
  const [shareFallback, setShareFallback] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const sidebar = useRef<HTMLElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const lesson = lessons.find((item) => item.id === route);
  const mainCompleted = notebook.completed.filter((id): id is Stage =>
    lessons.some((item) => item.id === id),
  );
  const result = useMemo(() => compile(source, options), [source, options]);
  const isAutomata = lesson?.id === 'automata';
  // The automata lab reads lexical rules, not Mini C; it never goes through compile().
  const automata = useMemo(
    () => (isAutomata ? analyzeAutomata(source) : undefined),
    [isAutomata, source],
  );
  const automataIssue = automata && !automata.ok ? automata.issue : undefined;
  const length = lesson
    ? isAutomata
      ? automata?.ok
        ? automata.analysis.frames.length
        : 0
      : traceLength(result, lesson.id)
    : 0;
  const currentStep = Math.max(0, Math.min(step, Math.max(0, length - 1)));
  const dirty = draft !== source;
  const labPresets = isAutomata ? automataPresets : presets;
  const selectedPreset = labPresets.find((p) => p.code === draft);
  // Each kind of input keeps its own text while the learner visits the other kind.
  const programStash = useRef(presets[0].code);
  const rulesStash = useRef(automataPresets[0].code);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 760px)');
    const update = () => setNarrow(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    if (!narrow || !menuOpen) return;
    sidebar.current?.querySelector<HTMLElement>('a[aria-current="page"]')?.focus();
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenuOpen(false);
        menuButton.current?.focus();
      }
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [narrow, menuOpen]);
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(notebook));
      setStorageError(false);
    } catch {
      setStorageError(true);
    }
  }, [notebook]);
  useEffect(() => {
    const onPop = () => {
      const restored = readUrl(window.location.search);
      setRoute(restored.route);
      setSource(restored.source);
      setDraft(restored.source);
      setStep(restored.step);
      setOptions(restored.options);
      setPlaying(false);
      setPanel('lab');
      setMenuOpen(false);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  useEffect(() => {
    if (!playing || length < 2) return;
    const interval = window.setInterval(
      () =>
        setStep((previous) => {
          if (previous >= length - 1) {
            setPlaying(false);
            return length - 1;
          }
          return previous + 1;
        }),
      800 / speed,
    );
    return () => clearInterval(interval);
  }, [playing, length, speed]);
  useEffect(() => {
    const pause = () => {
      if (document.hidden) setPlaying(false);
    };
    document.addEventListener('visibilitychange', pause);
    return () => document.removeEventListener('visibilitychange', pause);
  }, []);
  useEffect(() => {
    document.title = `${lesson?.title || (route === 'assembly' ? ASSEMBLY_TITLE : route === 'notes' ? '我的笔记' : route === 'sources' ? '阅读来源' : '动手理解编译原理')} · 编译手记`;
  }, [lesson, route]);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), 5000);
    return () => clearTimeout(timer);
  }, [notice]);
  function navigate(next: Route) {
    let base = source;
    if (route === 'automata' && next !== 'automata') {
      rulesStash.current = source;
      base = programStash.current;
    } else if (route !== 'automata' && next === 'automata') {
      programStash.current = source;
      base = rulesStash.current;
    }
    const nextSource =
      base === presets[0].code
        ? next === 'cfg'
          ? flowPresets[0].code
          : next === 'dataflow'
            ? dataflowPresets[0].code
            : next === 'dominance'
              ? dominancePresets[0].code
              : base
        : base;
    if (nextSource !== source) {
      setSource(nextSource);
      setDraft(nextSource);
    }
    const nextOptions =
      next === 'vm' && route !== 'optimize'
        ? { fold: false, propagate: false, dead: false }
        : options;
    setOptions(nextOptions);
    setRoute(next);
    setStep(0);
    setPlaying(false);
    setPanel('lab');
    setMenuOpen(false);
    setShareFallback('');
    window.history.pushState(
      null,
      '',
      next === 'assembly'
        ? new URL('?lab=assembly', window.location.href).href
        : shareUrl(window.location.href, next, nextSource, 0, nextOptions),
    );
    window.scrollTo({ top: 0, behavior: 'instant' });
    window.setTimeout(() => heading.current?.focus({ preventScroll: true }), 0);
  }
  function applySource(code: string) {
    setSource(code);
    setDraft(code);
    setStep(0);
    setPlaying(false);
    setShareFallback('');
  }
  function changeOptions(key: keyof OptimizationOptions) {
    setOptions((previous) => ({ ...previous, [key]: !previous[key] }));
    setPlaying(false);
    setStep(0);
  }
  async function copyShare() {
    const url = shareUrl(window.location.href, route, source, currentStep, options);
    window.history.replaceState(null, '', url);
    try {
      await navigator.clipboard.writeText(url);
      setNotice('实验链接已复制，包含代码、选项和当前步骤。');
    } catch {
      setShareFallback(url);
    }
  }
  function updateNote(id: NoteId, text: string) {
    setNotebook((previous) => ({ ...previous, notes: { ...previous.notes, [id]: text } }));
  }
  function toggleComplete(id: NoteId) {
    setNotebook((previous) => ({
      ...previous,
      completed: previous.completed.includes(id)
        ? previous.completed.filter((item) => item !== id)
        : [...previous.completed, id],
    }));
  }
  function exportNotebook() {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(notebook, null, 2)], { type: 'application/json' }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = '编译手记.json';
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function importNotebook(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      if (file.size > 1000000) throw new Error('笔记文件不能超过 1 MB。');
      const data = validateNotebook(JSON.parse(await file.text()));
      setNotebook((previous) => ({
        version: 1,
        notes: { ...previous.notes, ...data.notes },
        completed: [...new Set([...previous.completed, ...data.completed])],
      }));
      setNotice('笔记已合并导入。同一实验的内容以导入文件为准。');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '导入失败，请检查 JSON 文件。');
    }
    event.target.value = '';
  }
  const availableStages = lessons.filter((item) => traceLength(result, item.id) > 0);
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">
        跳到正文
      </a>
      {menuOpen && (
        <button
          className="sidebar-backdrop"
          aria-label="关闭目录"
          onClick={() => setMenuOpen(false)}
        />
      )}
      <aside
        ref={sidebar}
        className={`sidebar ${menuOpen ? 'is-open' : ''}`}
        aria-label="课程目录"
        inert={narrow && !menuOpen}
        aria-hidden={narrow && !menuOpen}
      >
        <a
          className="brand"
          href="?lab=home"
          onClick={(event) => {
            event.preventDefault();
            navigate('home');
          }}
        >
          <span className="brand-mark">⌘</span>
          <span>
            编译手记<small>THE COMPILER NOTEBOOK</small>
          </span>
        </a>
        <div className="sidebar-book">
          <span>一本可以运行的笔记</span>
          <p>基于《编译原理实战课》</p>
        </div>
        <nav>
          <a
            className={`nav-home ${route === 'home' ? 'active' : ''}`}
            aria-current={route === 'home' ? 'page' : undefined}
            href="?lab=home"
            onClick={(event) => {
              event.preventDefault();
              navigate('home');
            }}
          >
            <span>▧</span> 学习概览 <span className="nav-arrow">↗</span>
          </a>
          <div className="nav-label">
            动手实验 <span>{lessons.length}</span>
          </div>
          {lessons.map((item) => (
            <a
              className={`nav-lesson ${route === item.id ? 'active' : ''}`}
              key={item.id}
              href={`?lab=${item.id}`}
              aria-current={route === item.id ? 'page' : undefined}
              onClick={(event) => {
                event.preventDefault();
                navigate(item.id);
              }}
            >
              <span className="nav-number">{item.number}</span>
              <span>
                {item.title}
                <small>{item.english}</small>
              </span>
              {notebook.completed.includes(item.id) && (
                <span className="nav-check" aria-label="已复习">
                  ✓
                </span>
              )}
            </a>
          ))}
          <div className="nav-label extra-label">按需附录</div>
          <a
            className={`nav-home ${route === 'assembly' ? 'active' : ''}`}
            href="?lab=assembly"
            aria-current={route === 'assembly' ? 'page' : undefined}
            onClick={(event) => {
              event.preventDefault();
              navigate('assembly');
            }}
          >
            <span>⇄</span> {ASSEMBLY_TITLE}
          </a>
          <div className="nav-label extra-label">留给自己</div>
          <a
            className={`nav-home ${route === 'notes' ? 'active' : ''}`}
            href="?lab=notes"
            aria-current={route === 'notes' ? 'page' : undefined}
            onClick={(event) => {
              event.preventDefault();
              navigate('notes');
            }}
          >
            <span>✎</span> 我的笔记
          </a>
          <a
            className={`nav-home ${route === 'sources' ? 'active' : ''}`}
            href="?lab=sources"
            aria-current={route === 'sources' ? 'page' : undefined}
            onClick={(event) => {
              event.preventDefault();
              navigate('sources');
            }}
          >
            <span>↗</span> 阅读来源
          </a>
        </nav>
        <div className="sidebar-bottom">
          <div className="progress-label">
            <span>我的复习进度</span>
            <b>
              {mainCompleted.length} / {lessons.length}
            </b>
          </div>
          <div className="progress-track">
            <span style={{ width: `${(mainCompleted.length / lessons.length) * 100}%` }} />
          </div>
          <p>
            <span className="status-dot" /> 在浏览器中运行 · 无需服务端
          </p>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div>
            <button
              className="menu-button"
              ref={menuButton}
              onClick={() => setMenuOpen(!menuOpen)}
              aria-expanded={menuOpen}
              aria-label="切换课程目录"
            >
              ☰
            </button>
            <span>学习路径</span>
            <i>/</i>
            <strong>
              {lesson?.title ||
                (route === 'assembly'
                  ? ASSEMBLY_TITLE
                  : route === 'notes'
                    ? '我的笔记'
                    : route === 'sources'
                      ? '阅读来源'
                      : '编译器基础')}
            </strong>
          </div>
          <span className="local-badge">
            <span className="status-dot" /> 本地实验室
          </span>
        </header>
        <main id="main" tabIndex={-1}>
          {route === 'home' && (
            <Home navigate={navigate} headingRef={heading} completed={mainCompleted} />
          )}
          {route === 'assembly' && (
            <Suspense fallback={<p role="status">正在打开汇编附录…</p>}>
              <AssemblyAppendix
                headingRef={heading}
                notebook={notebook}
                onNote={updateNote}
                onComplete={toggleComplete}
                storageError={storageError}
              />
            </Suspense>
          )}
          {lesson && (
            <>
              <section className="lesson-heading">
                <div className="eyebrow">
                  实验 {lesson.number} <span>/</span> CHAPTER {lesson.chapter} <span>·</span> 约{' '}
                  {lesson.minutes} 分钟
                </div>
                <div className="title-row">
                  <h1 ref={heading} tabIndex={-1}>
                    {lesson.question}
                  </h1>
                  <button className="button secondary share-button" onClick={copyShare}>
                    分享实验 <Arrow />
                  </button>
                </div>
                <p>{lesson.intro}</p>
              </section>
              {shareFallback && (
                <label className="share-fallback">
                  复制这个链接
                  <input
                    value={shareFallback}
                    readOnly
                    onFocus={(event) => event.target.select()}
                  />
                </label>
              )}
              <div className="lesson-tabs" aria-label="学习方式">
                {(
                  [
                    { id: 'lab', name: '动手实验' },
                    { id: 'reading', name: '原理笔记' },
                    { id: 'recall', name: '复述自测' },
                  ] as const
                ).map((tab) => (
                  <button
                    key={tab.id}
                    className={panel === tab.id ? 'active' : ''}
                    aria-pressed={panel === tab.id}
                    onClick={() => {
                      setPanel(tab.id);
                      setPlaying(false);
                    }}
                  >
                    {tab.name}
                  </button>
                ))}
                <span>
                  {notebook.completed.includes(lesson.id) ? '✓ 已复习' : '先预测，再运行'}
                </span>
              </div>
              {panel === 'lab' && (
                <>
                  <div className="experiment-layout">
                    <section className="input-panel" aria-label="程序输入">
                      <div className="panel-title">
                        <h2>{isAutomata ? '词法规则与输入' : '源程序'}</h2>
                        <span>{isAutomata ? '名称: 正则 / %% / 输入' : 'Mini C / 教学语言'}</span>
                      </div>
                      <label className="field-label" htmlFor="preset">
                        选择一个观察角度
                      </label>
                      <select
                        id="preset"
                        value={selectedPreset?.id || 'custom'}
                        onChange={(event) => {
                          const preset = labPresets.find((item) => item.id === event.target.value);
                          if (preset) applySource(preset.code);
                        }}
                      >
                        <option value="custom" disabled>
                          {isAutomata ? '自定义规则' : '自定义程序'}
                        </option>
                        {labPresets.map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.label}
                          </option>
                        ))}
                      </select>
                      <div className="editor">
                        <div className="editor-toolbar">
                          <span className="file-dot" /> {isAutomata ? 'rules.lex' : 'experiment.mc'}{' '}
                          <span>{dirty ? '待运行' : '已编译'}</span>
                        </div>
                        <div className="editor-body">
                          <div className="line-numbers" aria-hidden="true">
                            {draft.split('\n').map((_, index) => (
                              <div key={index}>{index + 1}</div>
                            ))}
                          </div>
                          <textarea
                            id="source-code"
                            aria-label={isAutomata ? '词法规则与输入' : '源程序代码'}
                            spellCheck={false}
                            maxLength={MAX_SOURCE}
                            value={draft}
                            onChange={(event) => {
                              setDraft(event.target.value);
                              setPlaying(false);
                            }}
                            onKeyDown={(event) => {
                              if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                                event.preventDefault();
                                applySource(draft);
                              }
                            }}
                          />
                        </div>
                      </div>
                      <div className="editor-actions">
                        <button className="button primary" onClick={() => applySource(draft)}>
                          {isAutomata ? '生成自动机' : '运行编译'} <span aria-hidden="true">↵</span>
                        </button>
                        <button
                          className="text-button"
                          onClick={() => {
                            applySource(labPresets[0].code);
                            if (!isAutomata) setOptions(defaultOptions);
                          }}
                        >
                          恢复示例
                        </button>
                      </div>
                      <p className="keyboard-hint">
                        Ctrl / ⌘ + Enter 运行 · {draft.length}/{MAX_SOURCE} 字符
                      </p>
                      {dirty && (
                        <p className="dirty-note" role="status">
                          {isAutomata
                            ? '规则或输入已修改。生成自动机后更新右侧结果。'
                            : '代码已修改。运行编译后更新右侧结果。'}
                        </p>
                      )}
                      <div className="prediction">
                        <span>动手之前，想一想</span>
                        <p>
                          {selectedPreset?.prediction ||
                            '修改输入前，先写下你预测会变化的节点、指令或输出。'}
                        </p>
                      </div>
                      {(lesson.id === 'optimize' ||
                        lesson.id === 'vm' ||
                        lesson.id === 'dataflow') && (
                        <fieldset
                          className="optimization-options"
                          disabled={result.dataflow?.converged === false}
                        >
                          <legend>编译选项</legend>
                          {(
                            [
                              { key: 'fold', label: '常量折叠' },
                              { key: 'propagate', label: '常量传播' },
                              { key: 'dead', label: '清理无用写入' },
                            ] as const
                          ).map((option) => (
                            <label key={option.key}>
                              <input
                                type="checkbox"
                                checked={options[option.key]}
                                onChange={() => changeOptions(option.key)}
                              />
                              {option.label}
                            </label>
                          ))}
                          <small>
                            {result.dataflow?.converged === false
                              ? '分析尚未完成，保留原始 IR。'
                              : result.hasControlFlow
                                ? '先求解跨块事实，再改写 IR。清理同时处理已证明不可达块与无用复制。切换开关重置回放。'
                                : '切换选项后，回放将从头开始。'}
                          </small>
                        </fieldset>
                      )}
                      {isAutomata ? (
                        <details className="language-help">
                          <summary>规则怎么写？</summary>
                          <p>
                            %% 上方每行一条“名称: 正则”，越靠前优先级越高；# 开头为注释。名为 skip
                            的规则匹配后丢弃。%% 下方全部内容都是待扫描的输入。
                          </p>
                          <p>
                            支持字符、[a-z] 字符集与 [^…] 取反、.（除换行）、\d \w \s、\n \t、| * + ?
                            和括号。正则里的空格会被忽略，字面空格写成反斜杠加空格或 [ ]；{'( ) [ ] | * + ? . \\ { }'}
                            需要转义。不支持 {'{m,n}'}、锚点和捕获组。
                          </p>
                        </details>
                      ) : (
                      <details className="language-help">
                        <summary>这门小语言支持什么？</summary>
                        <p>
                          int / bool 声明与赋值、四则运算、比较运算、一元负号、括号、语句块、if /
                          else、while、print 和 // 注释。语句以半角分号结尾，if / while
                          主体必须用花括号。
                        </p>
                        <p>
                          条件必须是
                          bool；整数除法向零取整，只支持安全整数。变量初始化后才进入作用域，内部块允许遮蔽。暂不支持
                          break / continue、逻辑短路与函数。每次最多回放 2000 条字节码。
                        </p>
                      </details>
                      )}
                    </section>
                    <section className="output-panel" aria-label={`${lesson.title}实验结果`}>
                      <div className="panel-title">
                        <h2>
                          {lesson.title} <small>{lesson.english}</small>
                        </h2>
                        <span
                          className={`result-badge ${(isAutomata ? automataIssue : result.diagnostic?.stage === lesson.id) ? 'error' : ''}`}
                        >
                          {(isAutomata ? automataIssue : result.diagnostic?.stage === lesson.id)
                            ? '发现问题'
                            : length
                              ? '可回放'
                              : '等待修复'}
                        </span>
                      </div>
                      {automataIssue && (
                        <div className="diagnostic" role="alert">
                          <strong>正则与自动机 · 规则未通过</strong>
                          <p>{automataIssue.message}</p>
                          <small>
                            第 {source.slice(0, automataIssue.start).split('\n').length} 行 · 偏移{' '}
                            {automataIssue.start}
                          </small>
                        </div>
                      )}
                      {!isAutomata && result.diagnostic && (
                        <div className="diagnostic" role="alert">
                          <strong>
                            {stageNames[result.diagnostic.stage]} ·{' '}
                            {result.execution?.limited
                              ? '回放已暂停'
                              : result.diagnostic.stage === 'vm'
                                ? '运行时错误'
                                : '编译未通过'}
                          </strong>
                          <p>{result.diagnostic.message}</p>
                          {result.diagnostic.stage !== 'vm' && (
                            <small>
                              第 {source.slice(0, result.diagnostic.start).split('\n').length} 行 ·
                              源码偏移 {result.diagnostic.start}
                            </small>
                          )}
                        </div>
                      )}
                      <div className="result-content">
                        {isAutomata ? (
                          automata?.ok && (
                            <AutomataView key={source} analysis={automata.analysis} step={currentStep} />
                          )
                        ) : (
                          <ResultView
                            key={`${lesson.id}:${source}`}
                            stage={lesson.id}
                            result={result}
                            source={source}
                            step={currentStep}
                            options={options}
                          />
                        )}
                      </div>
                      {length > 0 && (
                        <div className="trace-player">
                          <div className="step-explanation" aria-live="polite" aria-atomic="true">
                            <span className="step-number">
                              {String(currentStep).padStart(2, '0')}
                            </span>
                            <p>
                              {isAutomata && automata?.ok
                                ? automata.analysis.frames[currentStep]?.message
                                : traceMessage(result, lesson.id, currentStep)}
                            </p>
                          </div>
                          <input
                            aria-label="当前步骤"
                            type="range"
                            min={0}
                            max={Math.max(0, length - 1)}
                            value={currentStep}
                            onChange={(event) => {
                              setStep(Number(event.target.value));
                              setPlaying(false);
                            }}
                          />
                          <div className="player-controls">
                            <div>
                              <button
                                aria-label="重置步骤"
                                title="重置步骤"
                                onClick={() => {
                                  setStep(0);
                                  setPlaying(false);
                                }}
                              >
                                ↺
                              </button>
                              <button
                                aria-label="上一步"
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
                                disabled={dirty || length < 2}
                                aria-label={playing ? '暂停' : '播放'}
                                onClick={() => {
                                  if (currentStep >= length - 1) setStep(0);
                                  setPlaying(!playing);
                                }}
                              >
                                {playing ? 'Ⅱ 暂停' : '▷ 播放'}
                              </button>
                              <button
                                aria-label="下一步"
                                disabled={currentStep >= length - 1}
                                onClick={() => {
                                  setStep(currentStep + 1);
                                  setPlaying(false);
                                }}
                              >
                                ›
                              </button>
                            </div>
                            <span>
                              {currentStep} / {length - 1}
                            </span>
                            <label>
                              <span className="sr-only">播放速度</span>
                              <select
                                aria-label="播放速度"
                                value={speed}
                                onChange={(event) => setSpeed(Number(event.target.value))}
                              >
                                <option value={0.5}>0.5×</option>
                                <option value={1}>1×</option>
                                <option value={2}>2×</option>
                                <option value={4}>4×</option>
                              </select>
                            </label>
                            <button
                              className="jump-end"
                              onClick={() => {
                                setStep(length - 1);
                                setPlaying(false);
                              }}
                            >
                              看最终结果 →
                            </button>
                          </div>
                        </div>
                      )}
                    </section>
                  </div>
                  {!isAutomata && (
                  <div className="pipeline-strip">
                    <span>同一段程序的旅程</span>
                    {lessons.filter((item) => item.id !== 'automata').map((item) => (
                      <button
                        key={item.id}
                        className={route === item.id ? 'active' : ''}
                        onClick={() => navigate(item.id)}
                      >
                        <i className={availableStages.includes(item) ? 'available' : ''} />
                        {item.title}
                        <span>→</span>
                      </button>
                    ))}
                  </div>
                  )}
                  <div className="learning-tip">
                    <span>✳</span>
                    <p>
                      <strong>试试对照实验</strong>
                      选择一个反例，先说出最早出错的阶段，再运行程序。切换到“原理笔记”核对你的解释。
                    </p>
                    <button className="text-button" onClick={() => setPanel('reading')}>
                      读原理 <Arrow />
                    </button>
                  </div>
                </>
              )}
              {panel === 'reading' && <Reading lesson={lesson} />}
              {panel === 'recall' && (
                <Recall
                  key={lesson.id}
                  lesson={lesson}
                  note={notebook.notes[lesson.id] || ''}
                  onNote={(text) => updateNote(lesson.id, text)}
                  completed={notebook.completed.includes(lesson.id)}
                  toggleComplete={() => toggleComplete(lesson.id)}
                  storageError={storageError}
                />
              )}
              <div className="lesson-pagination">
                <button
                  disabled={lesson.number === '01'}
                  onClick={() => navigate(lessons[Number(lesson.number) - 2].id)}
                >
                  <Arrow direction="left" /> 上一个实验
                </button>
                <span>
                  {lesson.number} / {String(lessons.length).padStart(2, '0')}
                </span>
                <button
                  onClick={() =>
                    navigate(
                      Number(lesson.number) === lessons.length
                        ? 'notes'
                        : lessons[Number(lesson.number)].id,
                    )
                  }
                >
                  {Number(lesson.number) === lessons.length
                    ? '整理我的笔记'
                    : `下一站 · ${lessons[Number(lesson.number)].title}`}{' '}
                  →
                </button>
              </div>
            </>
          )}
          {route === 'notes' && (
            <>
              <PageHeading
                title="把理解，留给以后的自己。"
                eyebrow="MY NOTEBOOK"
                description="每个实验留下自己的解释，比记住一个名词更有用。笔记与进度保存在当前浏览器，可随时导出备份。"
                headingRef={heading}
              />
              <div className="notebook-toolbar">
                <span>
                  {mainCompleted.length} / {lessons.length} 个实验已复习 · 附录{' '}
                  {notebook.completed.filter((id) => id.startsWith('assembly-')).length} / 6
                  {storageError && ' · 本地存储不可用，请导出备份'}
                </span>
                <div>
                  <button className="button secondary" onClick={exportNotebook}>
                    导出笔记 ↓
                  </button>
                  <button className="button secondary" onClick={() => fileInput.current?.click()}>
                    导入合并 ↑
                  </button>
                  <button
                    className="text-button danger"
                    onClick={() => {
                      if (
                        window.confirm('清除当前浏览器中的全部笔记和复习进度？建议先导出备份。')
                      ) {
                        setNotebook(emptyNotebook());
                        setNotice('本地笔记与复习进度已清除。');
                      }
                    }}
                  >
                    清除本地数据
                  </button>
                </div>
                <input
                  ref={fileInput}
                  className="sr-only"
                  type="file"
                  accept=".json,application/json"
                  onChange={importNotebook}
                  aria-label="导入笔记文件"
                />
              </div>
              <div className="notebook-grid">
                {lessons.map((item) => (
                  <article className="note-card" key={item.id}>
                    <div>
                      <span>
                        {item.number} / {item.title}
                      </span>
                      <label>
                        <input
                          type="checkbox"
                          checked={notebook.completed.includes(item.id)}
                          onChange={() => toggleComplete(item.id)}
                        />
                        已复习
                      </label>
                    </div>
                    <p>{item.challenge}</p>
                    <textarea
                      aria-label={`${item.title}的笔记`}
                      placeholder="用自己的话解释一次……"
                      maxLength={20000}
                      value={notebook.notes[item.id] || ''}
                      onChange={(event) => updateNote(item.id, event.target.value)}
                    />
                    <button className="text-button" onClick={() => navigate(item.id)}>
                      回到实验 <Arrow />
                    </button>
                  </article>
                ))}
              </div>
              <h2 className="appendix-notes-title">汇编附录的笔记</h2>
              <div className="notebook-grid">
                {assemblyTopics.map((item) => (
                  <article className="note-card" key={item.noteId}>
                    <div>
                      <span>附录 / {item.title}</span>
                      <label>
                        <input
                          type="checkbox"
                          aria-label={`${item.title}附录已复习`}
                          checked={notebook.completed.includes(item.noteId)}
                          onChange={() => toggleComplete(item.noteId)}
                        />
                        已复习
                      </label>
                    </div>
                    <p>{item.challenge}</p>
                    <textarea
                      aria-label={`${item.title}的附录笔记`}
                      placeholder="留下你对指令和状态的理解……"
                      maxLength={20000}
                      value={notebook.notes[item.noteId] || ''}
                      onChange={(event) => updateNote(item.noteId, event.target.value)}
                    />
                    <button
                      className="text-button"
                      onClick={() => {
                        navigate('assembly');
                        history.replaceState(
                          null,
                          '',
                          assemblyShareUrl(location.href, item.id, defaultParameters(item.id), 0),
                        );
                        window.dispatchEvent(new PopStateEvent('popstate'));
                      }}
                    >
                      回到本节附录 ↗
                    </button>
                  </article>
                ))}
              </div>
              <p className="privacy-note">
                笔记不包含在实验分享链接中，也不会上传或跨设备同步。导入同一实验的笔记会覆盖该实验已有内容，其他实验保留。
              </p>
            </>
          )}
          {route === 'sources' && (
            <>
              <PageHeading
                title="从原书出发，亲手验证。"
                eyebrow="READING & REFERENCES"
                description="以宫文学《编译原理实战课》为学习主线，按可验证的问题组织实验。这里是章节映射与这份笔记的实现边界。"
                headingRef={heading}
              />
              <div className="source-intro">
                <span className="source-book-icon">▤</span>
                <div>
                  <h2>编译原理实战课</h2>
                  <p>宫文学 · 课程目录与重点章节</p>
                  <a href={BOOK} target="_blank" rel="noreferrer">
                    打开原书目录 ↗
                  </a>
                </div>
                <span>选读 / 非全书复刻</span>
              </div>
              <div className="table-scroll source-table">
                <table>
                  <thead>
                    <tr>
                      <th>本笔记实验</th>
                      <th>原书章节</th>
                      <th>当前覆盖</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lessons.map((item) => (
                      <tr key={item.id}>
                        <td>
                          <button className="text-button" onClick={() => navigate(item.id)}>
                            {item.number} {item.title} ↗
                          </button>
                        </td>
                        <td>
                          <a href={chapterUrl(item.chapter)} target="_blank" rel="noreferrer">
                            第 {item.chapter} 讲 ↗
                          </a>
                        </td>
                        <td>
                          {item.id === 'vm'
                            ? 'P-code 概念 + 自定义栈机'
                            : item.limit.split('；')[0]}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="reading-page">
                <section>
                  <h2>随书汇编阅读辅助</h2>
                  <p>
                    已选读核对第 08、16 讲中的汇编示例、指令选择与寄存器分配讨论。附录说明原书的
                    AT&T / Intel 格式及调用上下文，并解释
                    LEA、缩放寻址、复制消除与指令排序。现有教学回放仍采用 Intel 语法和 Windows x64
                    ABI，与原书示例分别标注。核对日期：2026-11-16。
                  </p>
                  {assemblyBookReferences.map((item) => (
                    <a key={item.number} href={item.url} target="_blank" rel="noreferrer">
                      原书第 {item.number} 讲 · {item.title} ↗
                    </a>
                  ))}
                  {ASSEMBLY_SOURCES.map((item) => (
                    <a key={item.url} href={item.url} target="_blank" rel="noreferrer">
                      {item.title} ↗
                    </a>
                  ))}
                  <button className="text-button" onClick={() => navigate('assembly')}>
                    打开汇编附录 ↗
                  </button>
                </section>
                <section>
                  <h2>如何参考这些材料</h2>
                  <p>
                    已于 2026-11-16 顺序核对第 02、03、04、06、07
                    讲。原书用于主题选择与概念核对；界面文字、图形和编译器代码为本项目自行编写，没有镜像正文或图片。
                  </p>
                  <p>
                    2026-11-18 通过缓存脚本单页重读第 02 讲，补充正则 → NFA → DFA 实验：构造规则沿用原书图
                    7–11 的思路（连接时合并状态），回溯对照参照原书 matchWithNFA 的过程。原书未展开的子集构造，按其推荐的龙书第 2 版
                    3.7.1 节思路实现，并核对 Russ Cox 关于 Thompson NFA、回溯与 DFA 状态膨胀的文章。
                  </p>
                  <a href={REGEX_REFERENCE} target="_blank" rel="noreferrer">
                    Russ Cox · Regular Expression Matching Can Be Simple And Fast ↗
                  </a>
                  <p>
                    第 18 讲可作为字节码主题的延伸阅读，本次未核对。虚拟机实验基于第 06 讲 P-code
                    的概念，自定义指令不代表 CPython 的行为。
                  </p>
                  <a href={chapterUrl('18')} target="_blank" rel="noreferrer">
                    延伸：第 18 讲 · 从 AST 到字节码 ↗
                  </a>
                </section>
                <section>
                  <h2>控制流的补充参考</h2>
                  <p>
                    控制流图实验于 2026-11-16 核对 LLVM
                    官方教程中的基本块、分支汇合与循环回边概念。本项目采用 bool
                    条件和可变局部变量，未实现教程中的 SSA / φ。
                  </p>
                  <a href={CONTROL_FLOW_REFERENCE} target="_blank" rel="noreferrer">
                    LLVM 官方教程 · 控制流与基本块 ↗
                  </a>
                  <p>
                    第 08 个实验于 2026-11-16 补充核对 Cornell CS 4120 的数据流与活跃变量讲义，以及
                    LLVM 的条件常量传播说明。本项目使用稠密迭代与可变变量，没有实现稀疏 SSA。
                  </p>
                  <a href={DATAFLOW_REFERENCE} target="_blank" rel="noreferrer">
                    Cornell CS 4120 · 数据流与活跃变量 ↗
                  </a>
                  <a href={CONSTANT_PROPAGATION_REFERENCE} target="_blank" rel="noreferrer">
                    LLVM · 条件常量传播 ↗
                  </a>
                </section>
                <section>
                  <h2>访问节制与离线内容</h2>
                  <p>
                    页面、编译器与笔记都在本地运行，没有电子书抓取、外链图片、第三方字体或统计请求。点击原文链接才会由浏览器访问原书。
                  </p>
                  <p>
                    仓库提供手动、单页、串行的参考资料缓存脚本：默认复用缓存，跨进程请求间隔至少 15
                    秒，遇到 403 / 429 停止并记录冷却时间，不自动换 IP
                    或并发重试。全书内容没有打包到项目中。
                  </p>
                </section>
                <section>
                  <h2>哪些内容还没有覆盖</h2>
                  <p>
                    本版专注前端与基础中间表示。DFA 最小化、FIRST/FOLLOW、LR、完整 SSA
                    转换、寄存器分配、垃圾回收和各真实编译器的工程实现，均不在当前覆盖范围。已有基础分支、循环、常量传播、活跃变量分析，支配树、自然循环和
                    φ 候选位置分析，以及正则 → NFA → DFA 的词法自动机。
                  </p>
                  <p>
                    支配关系实验于 2026-11-17 补充核对 Cornell 与 LLVM
                    资料；分析原始结构图，不将一次运行路径当作静态证明，也不把候选 φ 当作完整 SSA。
                  </p>
                  <a href={DOMINANCE_REFERENCE} target="_blank" rel="noreferrer">
                    Cornell · 支配关系与 SSA ↗
                  </a>
                  <a href={LOOP_REFERENCE} target="_blank" rel="noreferrer">
                    LLVM · 循环术语 ↗
                  </a>
                </section>
              </div>
              <p className="figure-caption">
                来源目录共记录 {chapters.length} 个选读入口，具体章节可从各实验的“原理笔记”打开。
              </p>
            </>
          )}
        </main>
        <footer className="site-footer">
          <span>
            编译手记 <i> / </i> 理解，来自亲手运行。
          </span>
          <button onClick={() => navigate('sources')}>来源与边界 ↗</button>
          <span>浏览器内计算 · 笔记仅存本地</span>
        </footer>
      </div>
      <div className="toast" role="status" aria-live="polite">
        {notice}
      </div>
    </div>
  );
}

function PageHeading({
  title,
  eyebrow,
  description,
  headingRef,
}: {
  title: string;
  eyebrow: string;
  description: string;
  headingRef: React.RefObject<HTMLHeadingElement | null>;
}) {
  return (
    <section className="page-heading">
      <div className="eyebrow">{eyebrow}</div>
      <h1 ref={headingRef} tabIndex={-1}>
        {title}
      </h1>
      <p>{description}</p>
    </section>
  );
}
function Home({
  navigate,
  headingRef,
  completed,
}: {
  navigate: (route: Route) => void;
  headingRef: React.RefObject<HTMLHeadingElement | null>;
  completed: Stage[];
}) {
  const [brackets, setBrackets] = useState(false);
  const sample = brackets ? presets[1].code : presets[0].code;
  const preview = useMemo(() => compile(sample, defaultOptions), [sample]);
  return (
    <>
      <section className="home-hero">
        <div className="hero-copy">
          <div className="eyebrow">
            <span className="tiny-line" /> BUILD AN UNDERSTANDING
          </div>
          <h1 ref={headingRef} tabIndex={-1}>
            一段代码，
            <br />
            如何变成<span>机器的语言。</span>
          </h1>
          <p>
            从字符到语法树，从中间代码到执行。
            <br />
            把书里的抽象概念，变成手边可运行的实验。
          </p>
          <div className="hero-actions">
            <button className="button primary" onClick={() => navigate('lex')}>
              开始第一个实验 <span>→</span>
            </button>
            <a href="#learning-path">先看看学习路径 ↓</a>
          </div>
          <div className="hero-facts">
            <span>
              <b>{String(lessons.length).padStart(2, '0')}</b> 个动手实验
            </span>
            <i />
            <span>自由修改 · 逐步验证</span>
          </div>
        </div>
        <div className="hero-demo">
          <div className="demo-top">
            <span>
              <i />
              <i />
              <i />
            </span>
            <code>experiment.mc</code>
            <small>LIVE EXAMPLE</small>
          </div>
          <pre>
            <span className="syntax-keyword">int</span> result ={' '}
            <span className="syntax-number">{brackets ? '(2 + 3) * 4' : '2 + 3 * 4'}</span>;{'\n'}
            <span className="syntax-function">print</span>(result);
          </pre>
          <div className="demo-transform">
            <span>源码</span>
            <div>
              ↓ <small>编译与执行</small>
            </div>
            <span>输出</span>
          </div>
          <div className="demo-result">
            <span>stdout</span>
            <strong key={String(brackets)}>{preview.execution?.output[0]}</strong>
            <small>由这段程序实际计算</small>
          </div>
          <div className="demo-interaction">
            <button aria-pressed={brackets} onClick={() => setBrackets(!brackets)}>
              <span className={`toggle ${brackets ? 'on' : ''}`} />
              给加法加一对括号
            </button>
            <span>改一处，看变化 ↗</span>
          </div>
          <div className="demo-caption">小小的括号，改变的是整棵语法树。</div>
        </div>
      </section>
      <section className="journey-section">
        <div className="section-heading">
          <div>
            <div className="eyebrow">THE BIG PICTURE</div>
            <h2>先看清，这段旅程。</h2>
          </div>
          <p>六个编译环节，再用控制流、数据流与支配关系观察程序，最后看词法规则怎样自动变成自动机。</p>
        </div>
        <div className="journey">
          {lessons
            .filter((item) => !['cfg', 'dataflow', 'dominance', 'automata'].includes(item.id))
            .map((item, index) => (
              <button key={item.id} onClick={() => navigate(item.id)}>
                <span className={`journey-icon ${item.color}`}>{item.icon}</span>
                <strong>{item.title}</strong>
                <small>
                  {
                    [
                      '字符 → Token',
                      'Token → AST',
                      'AST → 语义信息',
                      'AST → 三地址代码',
                      'IR → 更简洁的 IR',
                      '字节码 → 输出',
                    ][index]
                  }
                </small>
                {index < 5 && <i>→</i>}
              </button>
            ))}
        </div>
        <p className="journey-caption">
          <span>↳</span>{' '}
          前端理解代码的结构与含义，中端改写表示，虚拟机负责执行。这里用一门小语言把它们连起来。
        </p>
      </section>
      <section id="learning-path" className="learning-path">
        <div className="section-heading">
          <div>
            <div className="eyebrow">LEARN BY DOING</div>
            <h2>每一站，回答一个问题。</h2>
          </div>
          <span className="section-count">
            {completed.length} / {lessons.length} 已复习
          </span>
        </div>
        <div className="lesson-grid">
          {lessons.map((item) => (
            <button className="lesson-card" key={item.id} onClick={() => navigate(item.id)}>
              <div className="card-top">
                <span className={`lesson-icon ${item.color}`}>{item.icon}</span>
                <span>
                  第 {item.chapter} 讲 · {item.minutes} 分钟
                </span>
                <b>{completed.includes(item.id) ? '✓' : item.number}</b>
              </div>
              <h3>
                {item.title}
                <span>{item.english}</span>
              </h3>
              <p>{item.question}</p>
              <div className="card-bottom">
                <span>
                  {item.id === 'lex'
                    ? '状态机 / 最长匹配'
                    : item.id === 'parse'
                      ? '递归下降 / 优先级'
                      : item.id === 'semantic'
                        ? '作用域 / 类型检查'
                        : item.id === 'ir'
                          ? '后序遍历 / 临时变量'
                          : item.id === 'optimize'
                            ? '常量传播 / 语义等价'
                            : item.id === 'automata'
                              ? 'NFA / 子集构造 / 最长匹配'
                              : item.id === 'dominance'
                              ? '支配树 / 自然循环 / φ 候选'
                              : item.id === 'dataflow'
                                ? 'IN / OUT / 不动点 / 活跃性'
                                : item.id === 'cfg'
                                  ? '基本块 / 分支 / 循环回边'
                                  : '操作数栈 / 程序状态'}
                </span>
                <b>→</b>
              </div>
            </button>
          ))}
        </div>
      </section>
      <section className="assembly-teaser">
        <div>
          <div className="eyebrow">OPTIONAL APPENDIX / 按需阅读</div>
          <h2>读到汇编时，先查清它在做什么。</h2>
          <p>
            随书查阅第 08、16 讲中的指令、语法差异与编译器写法，保留交互对照。寄存器、8086 与 x86
            的系统入门适合独立专题。
          </p>
        </div>
        <button className="button secondary" onClick={() => navigate('assembly')}>
          打开汇编附录 ↗
        </button>
      </section>
      <section className="study-method">
        <span className="method-mark">✳</span>
        <div>
          <h2>读懂之后，再亲手讲一遍。</h2>
          <p>先预测，改输入，单步核对。最后合上说明，用自己的话解释发生了什么。</p>
        </div>
        <button className="button secondary" onClick={() => navigate('notes')}>
          打开我的笔记 <Arrow />
        </button>
      </section>
    </>
  );
}
function Reading({ lesson }: { lesson: Lesson }) {
  return (
    <article className="reading-page">
      <div className="reading-lead">
        <span className={`lesson-icon ${lesson.color}`}>{lesson.icon}</span>
        <div>
          <small>{lesson.english}</small>
          <h2>{lesson.title}，需要记住的三件事</h2>
        </div>
      </div>
      {lesson.note.map((note, index) => (
        <section key={note.title}>
          <div className="reading-number">0{index + 1}</div>
          <h3>{note.title}</h3>
          <p>{note.body}</p>
        </section>
      ))}
      <aside className="misconception">
        <strong>一个容易混淆的地方</strong>
        <p>{lesson.misconception}</p>
      </aside>
      <section>
        <h3>这个实验的边界</h3>
        <p>{lesson.limit}</p>
      </section>
      <div className="reading-source">
        <span>对应原书 / 第 {lesson.chapter} 讲</span>
        <a href={chapterUrl(lesson.chapter)} target="_blank" rel="noreferrer">
          {chapters.find((c) => c.number === lesson.chapter)!.title} ↗
        </a>
        <small>
          来源核对：{lesson.id === 'automata' ? '2026-11-18' : '2026-11-16'} · 本页说明与图形独立编写
        </small>
        {lesson.id === 'automata' && (
          <>
            <small>子集构造：原书推荐龙书第 2 版 3.7.1 节（纸质书，未在线核对）</small>
            <a href={REGEX_REFERENCE} target="_blank" rel="noreferrer">
              概念核对：Russ Cox · Thompson NFA、回溯与 DFA ↗
            </a>
          </>
        )}
        {lesson.id === 'dataflow' && (
          <>
            <a href={DATAFLOW_REFERENCE} target="_blank" rel="noreferrer">
              概念核对：Cornell CS 4120 · 数据流与活跃变量 ↗
            </a>
            <a href={CONSTANT_PROPAGATION_REFERENCE} target="_blank" rel="noreferrer">
              延伸：LLVM 条件常量传播（本项目未使用稀疏 SSA） ↗
            </a>
          </>
        )}
        {lesson.id === 'cfg' && (
          <a href={CONTROL_FLOW_REFERENCE} target="_blank" rel="noreferrer">
            概念核对：LLVM 官方教程 · 控制流、基本块与跳转 ↗
          </a>
        )}
        {lesson.id === 'dominance' && (
          <>
            <small>补充概念核对：2026-11-17 · 原始结构图上的静态分析</small>
            <a href={DOMINANCE_REFERENCE} target="_blank" rel="noreferrer">
              Cornell CS 4120 · 支配关系、支配边界与 SSA ↗
            </a>
            <a href={LOOP_REFERENCE} target="_blank" rel="noreferrer">
              LLVM · 自然循环与循环术语 ↗
            </a>
          </>
        )}
      </div>
    </article>
  );
}
function Recall({
  lesson,
  note,
  onNote,
  completed,
  toggleComplete,
  storageError,
}: {
  lesson: Lesson;
  note: string;
  onNote: (text: string) => void;
  completed: boolean;
  toggleComplete: () => void;
  storageError: boolean;
}) {
  const [answer, setAnswer] = useState<number | undefined>();
  const [showReference, setShowReference] = useState(false);
  return (
    <div className="recall-page">
      <section className="quiz-card">
        <div className="eyebrow">QUICK CHECK / 快速核对</div>
        <h2>{lesson.quiz.question}</h2>
        <div className="quiz-options">
          {lesson.quiz.options.map((option, index) => (
            <button
              key={option}
              className={answer === index ? 'chosen' : ''}
              aria-pressed={answer === index}
              onClick={() => setAnswer(index)}
            >
              <span>{String.fromCharCode(65 + index)}</span>
              {option}
            </button>
          ))}
        </div>
        {answer !== undefined && (
          <div
            className={`quiz-feedback ${answer === lesson.quiz.correct ? 'correct' : ''}`}
            role="status"
          >
            <strong>{answer === lesson.quiz.correct ? '✓ 判断正确' : '再想一想'}</strong>
            <p>{lesson.quiz.explain}</p>
          </div>
        )}
      </section>
      <section className="recall-card">
        <div className="eyebrow">TEACH IT BACK / 用自己的话</div>
        <h2>现在，把原理讲给自己听。</h2>
        <p>{lesson.challenge}</p>
        <label className="sr-only" htmlFor="recall-note">
          {lesson.title}的复述笔记
        </label>
        <textarea
          id="recall-note"
          value={note}
          onChange={(event) => onNote(event.target.value)}
          maxLength={20000}
          placeholder="试着先不看参考解释，写下你的思考……"
        />
        <div className="note-status">
          <span>
            {storageError ? '本地存储不可用，请复制或导出备份' : '自动保存在此浏览器 · 不上传'}
          </span>
          <button
            className="text-button"
            onClick={() => setShowReference(!showReference)}
            aria-expanded={showReference}
          >
            {showReference ? '收起参考解释 ↑' : '展开参考解释 ↓'}
          </button>
        </div>
        {showReference && <div className="reference-answer">{lesson.answer}</div>}
        <button
          className={`button ${completed ? 'secondary' : 'primary'}`}
          onClick={toggleComplete}
        >
          {completed ? '✓ 已复习 · 点击撤销' : '我能解释了，标记已复习 ✓'}
        </button>
      </section>
    </div>
  );
}
