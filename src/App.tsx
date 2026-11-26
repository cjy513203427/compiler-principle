import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { assemblyTopics, ASSEMBLY_SOURCES } from './content/assembly';
import { assemblyShareUrl } from './assembly/state';
import { defaultParameters } from './content/assembly';
import { ASSEMBLY_TITLE, assemblyBookReferences } from './content/assembly-reading';
import { dominancePresets, DOMINANCE_REFERENCE, LOOP_REFERENCE } from './content/dominance';
import { automataPresets, REGEX_REFERENCE } from './content/automata';
import { analyzeAutomata } from './compiler/automata';
import { AutomataView } from './components/AutomataView';
import { grammarPresets, LEFT_RECURSION_REFERENCE } from './content/grammar';
import { analyzeGrammar } from './compiler/grammar';
import { GrammarView } from './components/GrammarView';
import { CodeBlock } from './components/CodeBlock';
import { lrPresets } from './content/lr';
import { analyzeLr } from './compiler/lr';
import { LrView } from './components/LrView';
import { ssaPresets, SSA_REFERENCE, PHI_REFERENCE } from './content/ssa';
import { minimizationPresets, MINIMIZATION_REFERENCE } from './content/minimize';
import { analyzeMinimization } from './compiler/minimize';
import { MinimizationView } from './components/MinimizationView';
import { LearningRoutes, LessonConnections } from './components/LearningRoutes';
import { outSsaPresets, OUT_SSA_REFERENCE, SSA_DECONSTRUCTION_REFERENCE } from './content/outssa';
import { functionPresets, CALL_STACK_REFERENCE, CALL_FRAMES_REFERENCE } from './content/functions';
import { analyzeFunctions } from './compiler/functions';
import { FunctionsView } from './components/FunctionsView';
import { regallocPresets, REGALLOC_REFERENCE } from './content/regalloc';
import { schedulePresets } from './content/schedule';
import { redundancyPresets } from './content/redundancy';
import { ssaOptPresets, SCCP_REFERENCE, SSA_OPT_REFERENCE, LOST_COPY_REFERENCE } from './content/ssaopt';
import { codegenPresets, TILING_REFERENCE, SYSV_ABI_REFERENCE, INTEL_SDM_REFERENCE } from './content/codegen';
import { CodegenSettingsFieldset } from './components/CodegenView';
import type { CodegenSettings } from './compiler/codegen';
import { gcPresets } from './content/gc';
import { analyzeGc } from './compiler/gc';
import { GcView } from './components/GcView';
import { RegisterSettingsFieldset } from './components/RegallocView';
import type { RegisterSettings } from './compiler/regalloc';
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
  grammar: '文法与预测分析',
  lr: '移进与规约',
  ssa: '静态单赋值',
  minimize: 'DFA 最小化',
  outssa: 'SSA 消除',
  functions: '函数与调用栈',
  regalloc: '寄存器分配',
  schedule: '指令排序与窥孔优化',
  cse: '公共子表达式与循环外提',
  gc: '垃圾收集',
  ssaopt: 'SSA 优化与复制合并',
  codegen: '指令选择与代码生成',
};
type InputKind = 'program' | 'automata' | 'grammar' | 'lr' | 'minimize' | 'functions' | 'gc';
// Rules and grammar labs keep their own input instead of a Mini C program.
const kindOf = (route: Route): InputKind =>
  route === 'automata' || route === 'grammar' || route === 'lr' || route === 'minimize' || route === 'functions' || route === 'gc' ? route : 'program';
const inputCopy = {
  program: {
    title: '源程序',
    format: 'Mini C / 教学语言',
    custom: '自定义程序',
    file: 'experiment.mc',
    field: '源程序代码',
    run: '运行编译',
    dirty: '代码已修改。运行编译后更新右侧结果。',
    presets,
  },
  functions: {
    title: '函数程序', format: 'Mini C / 函数方言', custom: '自定义函数程序', file: 'functions.mc',
    field: '函数程序代码', run: '编译并执行函数', dirty: '函数程序已修改。编译并执行后更新右侧结果。',
    presets: functionPresets,
  },
  gc: {
    title: '堆与操作', format: '对象 / 根 / %% / 操作', custom: '自定义堆', file: 'heap.gc',
    field: '堆描述与操作', run: '运行垃圾收集', dirty: '堆或操作已修改。运行垃圾收集后更新右侧结果。',
    presets: gcPresets,
  },
  automata: {
    title: '词法规则与输入',
    format: '名称: 正则 / %% / 输入',
    custom: '自定义规则',
    file: 'rules.lex',
    field: '词法规则与输入',
    run: '生成自动机',
    dirty: '规则或输入已修改。生成自动机后更新右侧结果。',
    presets: automataPresets,
  },
  minimize: {
    title: '词法规则与输入',
    format: '名称: 正则 / %% / 输入',
    custom: '自定义规则',
    file: 'rules.min.lex',
    field: '词法规则与输入',
    run: '最小化 DFA',
    dirty: '规则或输入已修改。最小化 DFA 后更新右侧结果。',
    presets: minimizationPresets,
  },
  grammar: {
    title: '文法与输入',
    format: '产生式 / %% / 输入',
    custom: '自定义文法',
    file: 'grammar.ll',
    field: '文法与输入',
    run: '计算分析表',
    dirty: '文法或输入已修改。计算分析表后更新右侧结果。',
    presets: grammarPresets,
  },
  lr: {
    title: '文法与输入',
    format: '产生式 / %% / 输入',
    custom: '自定义文法',
    file: 'grammar.lr',
    field: '文法与输入',
    run: '构造 LR 表',
    dirty: '文法或输入已修改。构造 LR 表后更新右侧结果。',
    presets: lrPresets,
  },
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
  const [registers, setRegisters] = useState<RegisterSettings>(initial.registers);
  const [codegenSettings, setCodegenSettings] = useState<CodegenSettings>(initial.codegen);
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
  const needsOutSSA = route === 'outssa';
  const inputKind = kindOf(route);
  const programSource = inputKind === 'program' ? source : '';
  const usesRegisters = route === 'regalloc' || route === 'schedule';
  const allocationSettings = usesRegisters ? registers : undefined;
  const needsSchedule = route === 'schedule';
  const needsRedundancy = route === 'cse';
  const needsSsaOpt = route === 'ssaopt';
  const generation = route === 'codegen' ? codegenSettings : undefined;
  const result = useMemo(
    () => compile(programSource, options, { outOfSSA: needsOutSSA, ssaOpt: needsSsaOpt, registers: allocationSettings, schedule: needsSchedule, redundancy: needsRedundancy, codegen: generation }),
    [programSource, options, needsOutSSA, needsSsaOpt, allocationSettings, needsSchedule, needsRedundancy, generation],
  );
  const ownInput = inputKind !== 'program';
  const copy = inputCopy[inputKind];
  // Own-input labs never go through compile(); each has its own analysis.
  const automata = useMemo(
    () => (inputKind === 'automata' ? analyzeAutomata(source) : undefined),
    [inputKind, source],
  );
  const grammarResult = useMemo(
    () => (inputKind === 'grammar' ? analyzeGrammar(source) : undefined),
    [inputKind, source],
  );
  const lrResult = useMemo(
    () => (inputKind === 'lr' ? analyzeLr(source) : undefined),
    [inputKind, source],
  );
  const minimization = useMemo(
    () => (inputKind === 'minimize' ? analyzeMinimization(source) : undefined),
    [inputKind, source],
  );
  const functions = useMemo(
    () => (inputKind === 'functions' ? analyzeFunctions(source) : undefined),
    [inputKind, source],
  );
  const gcResult = useMemo(
    () => (inputKind === 'gc' ? analyzeGc(source) : undefined),
    [inputKind, source],
  );
  const ownOutcome = automata || grammarResult || lrResult || minimization || functions || gcResult;
  const ownIssue = ownOutcome && !ownOutcome.ok ? ownOutcome.issue : undefined;
  const ownFrames = ownOutcome?.ok ? ownOutcome.analysis.frames : undefined;
  const length = lesson
    ? ownInput
      ? ownFrames?.length || 0
      : traceLength(result, lesson.id)
    : 0;
  const currentStep = Math.max(0, Math.min(step, Math.max(0, length - 1)));
  const dirty = draft !== source;
  const preferredPresets = route === 'ssa' ? ssaPresets : route === 'ssaopt' ? ssaOptPresets : route === 'codegen' ? codegenPresets : route === 'outssa' ? outSsaPresets : route === 'regalloc' ? regallocPresets : route === 'schedule' ? schedulePresets : route === 'cse' ? redundancyPresets : undefined;
  const labPresets = preferredPresets
    ? [...preferredPresets, ...copy.presets.filter((item) => !preferredPresets.some((own) => own.code === item.code))]
    : copy.presets;
  const selectedPreset = labPresets.find((p) => p.code === draft);
  // Keep applied input and pending edits separate across in-app navigation.
  const stash = useRef<Record<InputKind, { source: string; draft: string }>>({
    program: { source: presets[0].code, draft: presets[0].code },
    automata: { source: automataPresets[0].code, draft: automataPresets[0].code },
    grammar: { source: grammarPresets[0].code, draft: grammarPresets[0].code },
    lr: { source: lrPresets[0].code, draft: lrPresets[0].code },
    minimize: { source: minimizationPresets[0].code, draft: minimizationPresets[0].code },
    functions: { source: functionPresets[0].code, draft: functionPresets[0].code },
    gc: { source: gcPresets[0].code, draft: gcPresets[0].code },
  });
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
      setRegisters(restored.registers);
      setCodegenSettings(restored.codegen);
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
    let pendingDraft = draft;
    if (kindOf(route) !== kindOf(next)) {
      stash.current[kindOf(route)] = { source, draft };
      const restored = stash.current[kindOf(next)];
      base = restored.source;
      pendingDraft = restored.draft;
    }
    const nextSource =
      base === presets[0].code && pendingDraft === base
        ? next === 'cfg'
          ? flowPresets[0].code
          : next === 'dataflow'
            ? dataflowPresets[0].code
            : next === 'regalloc'
              ? regallocPresets[0].code
              : next === 'schedule'
              ? schedulePresets[0].code
              : next === 'cse'
              ? redundancyPresets[0].code
              : next === 'ssaopt'
              ? ssaOptPresets[0].code
              : next === 'codegen'
              ? codegenPresets[0].code
              : next === 'outssa'
              ? outSsaPresets[0].code
              : next === 'ssa'
                ? ssaPresets[0].code
                : next === 'dominance'
                  ? dominancePresets[0].code
                  : base
        : base;
    setSource(nextSource);
    setDraft(nextSource === base ? pendingDraft : nextSource);
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
        : shareUrl(window.location.href, next, nextSource, 0, nextOptions, registers, codegenSettings),
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
  function changeRegisters(next: RegisterSettings) {
    setRegisters(next);
    setPlaying(false);
    setStep(0);
  }
  function changeCodegen(next: CodegenSettings) {
    setCodegenSettings(next);
    setPlaying(false);
    setStep(0);
  }
  function changeOptions(key: keyof OptimizationOptions) {
    setOptions((previous) => ({ ...previous, [key]: !previous[key] }));
    setPlaying(false);
    setStep(0);
  }
  async function copyShare() {
    const url = shareUrl(window.location.href, route, source, currentStep, options, registers, codegenSettings);
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
                        <h2>{copy.title}</h2>
                        <span>{copy.format}</span>
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
                          {copy.custom}
                        </option>
                        {labPresets.map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.label}
                          </option>
                        ))}
                      </select>
                      <div className="editor">
                        <div className="editor-toolbar">
                          <span className="file-dot" /> {copy.file}{' '}
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
                            aria-label={copy.field}
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
                          {copy.run} <span aria-hidden="true">↵</span>
                        </button>
                        <button
                          className="text-button"
                          onClick={() => {
                            applySource(labPresets[0].code);
                            if (!ownInput) setOptions(defaultOptions);
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
                          {copy.dirty}
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
                      {usesRegisters && (
                        <RegisterSettingsFieldset settings={registers} onChange={changeRegisters} />
                      )}
                      {lesson.id === 'codegen' && (
                        <CodegenSettingsFieldset settings={codegenSettings} onChange={changeCodegen} />
                      )}
                      {inputKind === 'grammar' || inputKind === 'lr' ? (
                        <details className="language-help">
                          <summary>文法怎么写？</summary>
                          <p>
                            %% 上方每行一条“左边 {'->'} 右边”，候选之间用 |，空串写 ε；以 | 开头的行接着上一行。第一条产生式的左边是开始符号。出现在左边的名字是非终结符，其余符号都是终结符（Token）。
                          </p>
                          <p>
                            %% 下方是要解析的输入，空格可省略。和终结符同名的单词、符号直接对应；文法里有 Num 时，数字记作 Num；有 Id 时，其余单词记作 Id。只支持纯产生式，不支持 * + ? 写法。
                          </p>
                        </details>
                      ) : inputKind === 'automata' || inputKind === 'minimize' ? (
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
                      ) : inputKind === 'gc' ? (
                        <details className="language-help">
                          <summary>堆怎么写？</summary>
                          <p>每行一个对象：名字 大小 {'->'} 引用1, 引用2（大小 1–8 格，按声明顺序紧挨着放进堆）。root a, b 写出根；heap N 指定堆容量；request N 指定回收后要申请的连续空间。# 开头为注释。</p>
                          <p>%% 下方是程序依次做的修改：drop x 去掉一个根，root x 新增一个根，link x {'->'} y 新增引用，cut x {'->'} y 删除引用。程序只能修改当前可达的对象。最多 24 个对象、24 个操作、1200 字符。</p>
                        </details>
                      ) : inputKind === 'functions' ? (
                        <details className="language-help">
                          <summary>函数方言怎么写？</summary>
                          <p>顶层定义形如 int add(int a, int b) {'{ return a + b; }'}，用 add(3, 4) 调用。形参与返回值使用 int / bool；支持递归、相互递归、块作用域、if / else、while 和 print。</p>
                          <p>实参从左到右求值，按值传递。函数必须明确覆盖所有返回路径，while 不算保证返回。顶层语句是独立入口，变量不是全局变量；函数不能读取调用者的局部变量。最多 32 帧（含入口）和 2000 条执行指令。</p>
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
                          className={`result-badge ${(ownInput ? ownIssue : result.diagnostic?.stage === lesson.id) ? 'error' : ''}`}
                        >
                          {(ownInput ? ownIssue : result.diagnostic?.stage === lesson.id)
                            ? '发现问题'
                            : length
                              ? '可回放'
                              : '等待修复'}
                        </span>
                      </div>
                      {ownIssue && (
                        <div className="diagnostic" role="alert">
                          <strong>{stageNames[lesson.id]} · 输入未通过</strong>
                          <p>{ownIssue.message}</p>
                          <small>
                            第 {source.slice(0, ownIssue.start).split('\n').length} 行 · 偏移{' '}
                            {ownIssue.start}
                          </small>
                        </div>
                      )}
                      {!ownInput && result.diagnostic && (
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
                        {inputKind === 'gc' ? (
                          gcResult?.ok && <GcView key={source} analysis={gcResult.analysis} step={currentStep} />
                        ) : inputKind === 'functions' ? (
                          functions?.ok && <FunctionsView key={source} analysis={functions.analysis} source={source} step={currentStep} />
                        ) : inputKind === 'minimize' ? (
                          minimization?.ok && (
                            <MinimizationView key={source} analysis={minimization.analysis} step={currentStep} />
                          )
                        ) : inputKind === 'automata' ? (
                          automata?.ok && (
                            <AutomataView key={source} analysis={automata.analysis} step={currentStep} />
                          )
                        ) : inputKind === 'lr' ? (
                          lrResult?.ok && (
                            <LrView key={source} analysis={lrResult.analysis} step={currentStep} />
                          )
                        ) : inputKind === 'grammar' ? (
                          grammarResult?.ok && (
                            <GrammarView
                              key={source}
                              analysis={grammarResult.analysis}
                              step={currentStep}
                              onApply={(code) => {
                                applySource(code);
                                setNotice('已换成改写后的文法，回放从头开始。');
                              }}
                            />
                          )
                        ) : (
                          <ResultView
                            key={`${lesson.id}:${source}:${usesRegisters ? `${registers.count}${registers.algorithm}` : ''}:${generation ? `${generation.pool}${generation.input}${+options.fold}${+options.propagate}${+options.dead}` : ''}`}
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
                              {ownFrames
                                ? ownFrames[currentStep]?.message
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
                  {!ownInput && (
                  <div className="pipeline-strip">
                    <span>同一段程序的旅程</span>
                    {lessons.filter((item) => kindOf(item.id) === 'program').map((item) => (
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
              {panel === 'reading' && <Reading lesson={lesson} navigate={navigate} />}
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
                    同日单页重读第 03 讲，补充“文法与预测分析”：产生式写法、左递归及改写、FIRST / FOLLOW 的不动点计算与 LL(1) 分析表，均按原书的讲法独立实现。第 03 讲后半的 LR 直观介绍，补充为“移进与规约”实验：LR(0) 项目集与 SLR(1) 表，原书示例的左递归文法可直接解析。
                  </p>
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
                    条件和可变局部变量；标量 SSA 与 φ 在第 13 个实验中单独构造与执行。
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
                    本版专注前端与基础中间表示。完整 LR(1) / LALR、内存 SSA、复制合并、
                    指令选择与机器码生成、垃圾回收和各真实编译器的工程实现，均不在当前覆盖范围。已有基础分支、循环、常量传播、活跃变量分析，支配树、自然循环、
                    标量 SSA 构造、校验与基础 SSA 消除，图着色与线性扫描的教学寄存器分配，正则 → NFA → DFA 与 DFA 最小化，FIRST / FOLLOW 与 LL(1) 预测分析，以及 SLR(1) 的移进 / 规约。
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
                  <p>第 13 个实验于 2026-11-21 核对 Cornell 的 SSA 构造与活跃性说明，以及 LLVM φ 的前驱边语义。采用独立的教学表示与解释器，保留现有优化器。</p>
                  <a href={PHI_REFERENCE} target="_blank" rel="noreferrer">LLVM · φ 指令的输入与语义 ↗</a>
                  <p>第 14 个实验于 2026-11-21 核对 Cornell 的 DFA 最小化与词法动作说明，采用分割细化、最短区分后缀和独立状态积等价校验；未重新请求原书。</p>
                  <a href={MINIMIZATION_REFERENCE} target="_blank" rel="noreferrer">Cornell · DFA 最小化与词法扫描 ↗</a>
                  <p>第 15 个实验于 2026-11-21 核对 Cornell 的 Out of SSA 与 CMU 的 SSA Deconstruction 讲义，补充边复制、关键边拆分、复制环调度和接回原 VM 的执行对照。</p>
                  <a href={SSA_DECONSTRUCTION_REFERENCE} target="_blank" rel="noreferrer">CMU · SSA 消除与并行复制 ↗</a>
                  <p>第 16 个实验于 2026-11-21 核对 Cornell 调用约定讲义与《Crafting Interpreters》作者的调用帧实现。专用函数方言支持参数、返回、递归与独立栈帧，未把函数调用接入现有 CFG、SSA 或优化器。</p>
                  <a href={CALL_STACK_REFERENCE} target="_blank" rel="noreferrer">Cornell · 调用约定、返回地址与栈帧 ↗</a>
                  <a href={CALL_FRAMES_REFERENCE} target="_blank" rel="noreferrer">Crafting Interpreters · Calls and Functions ↗</a>
                  <p>第 17 个实验于 2026-11-22 从本地缓存重读原书第 08 讲的寄存器分配一节（无限虚拟寄存器、溢出到栈、图染色与线性扫描），并核对 Cornell CS 4120 的寄存器分配讲义。按循环深度加权的溢出代价是本项目选定的启发式，讲义未给出。</p>
                  <a href={REGALLOC_REFERENCE} target="_blank" rel="noreferrer">Cornell · Register Allocation ↗</a>
                  <p>第 18 个实验于 2026-11-22 从本地缓存重读原书第 08 讲的指令排序（流水线、依赖、List Scheduling）与窥孔优化一节。教学延迟、关键路径优先级和精确异常约定是本项目自定的模型，未另找外部资料核对；不代表任何真实 CPU。</p>
                  <p>第 19 个实验于 2026-11-22 通过缓存脚本单页重读原书第 07 讲，实现全局可用表达式、公共子表达式消除、本地值编号对照与循环不变代码外提；可能报错的运算只从循环条件中外提，这是本项目为保持输出与错误一致而定的约定。</p>
                  <p>第 20 个实验于 2026-11-22 通过缓存脚本单页读取原书第 32 讲，补充引用计数、Python 式循环检测、三色标记的标记-清除、标记-整理与停止-拷贝；堆以格为单位，不模拟分代、增量、并发或停顿时间。</p>
                  <p>第 21 个实验于 2026-11-26 核对 Wegman-Zadeck 稀疏条件常量传播（SCCP）、LLVM Passes 说明、Cornell CS 6120 的 SSA 优化讲义与 Briggs 等人的 Practical Improvements to the Construction and Destruction of Static Single Assignment Form（Lost-Copy 与 Swap 问题），实现标量 SSA 上的 SCCP、复制传播、异常安全的稀疏死代码删除，以及消除 φ 时的干涉图保守复制合并；未重新请求原书。</p>
                  <a href={SCCP_REFERENCE} target="_blank" rel="noreferrer">LLVM · Sparse Conditional Constant Propagation ↗</a>
                  <a href={SSA_OPT_REFERENCE} target="_blank" rel="noreferrer">Cornell CS 6120 · SSA Optimization &amp; Deconstruction ↗</a>
                  <a href={LOST_COPY_REFERENCE} target="_blank" rel="noreferrer">Briggs et al. · Practical Improvements to the Construction and Destruction of SSA Form（SPE 1998）↗</a>
                  <p>第 22 个实验于 2026-11-26 通过缓存脚本单页重读原书第 08 讲的指令选择一节（选代价更低的指令组合、lea 一次完成三数相加、树覆盖与 BURS），并核对 Cornell CS 4120 的指令选择讲义（瓦片与最大吞进）、x86-64 psABI 仓库（System V 调用约定）与 Intel 手册入口。目标语义、r11 保留给范围检查、三个运行时函数和 x86-64 子集模拟器是本项目的约定；页面结果没有在真实 CPU 或汇编器上验证。</p>
                  <a href={TILING_REFERENCE} target="_blank" rel="noreferrer">Cornell CS 4120 · Instruction Selection（Tiles）↗</a>
                  <a href={SYSV_ABI_REFERENCE} target="_blank" rel="noreferrer">x86-64 psABI · System V AMD64 调用约定 ↗</a>
                  <a href={INTEL_SDM_REFERENCE} target="_blank" rel="noreferrer">Intel 64 and IA-32 Architectures Software Developer's Manuals ↗</a>
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
          <p>先沿六个编译环节跑通一段程序，再按主题深入：从词法规则到 DFA 最小化、从文法到分析表，或从控制流到数据流、支配关系与 SSA。</p>
        </div>
        <div className="journey">
          {lessons
            .filter((item) => kindOf(item.id) === 'program' && !['cfg', 'dataflow', 'dominance', 'ssa', 'ssaopt', 'outssa', 'regalloc', 'schedule', 'cse', 'codegen'].includes(item.id))
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
        <LearningRoutes onNavigate={navigate} completed={completed} />
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
                            : item.id === 'lr'
                              ? '移进 / 规约 / SLR 表'
                              : item.id === 'grammar'
                              ? 'FIRST / FOLLOW / LL(1) 表'
                              : item.id === 'minimize'
                              ? '分割细化 / 区分后缀 / 扫描对照'
                              : item.id === 'automata'
                              ? 'NFA / 子集构造 / 最长匹配'
                              : item.id === 'cse'
                              ? '可用表达式 / 复用 / 循环外提'
                              : item.id === 'gc'
                              ? '三色标记 / 引用计数 / 碎片'
                              : item.id === 'schedule'
                              ? '依赖图 / 列表调度 / 窥孔窗口'
                              : item.id === 'regalloc'
                              ? '干涉图 / 线性扫描 / 溢出到栈'
                              : item.id === 'codegen'
                              ? '树覆盖 / 预着色 / x86-64 执行'
                              : item.id === 'functions'
                              ? 'CALL / RETURN / 独立栈帧 / 递归'
                              : item.id === 'outssa'
                              ? '边复制 / 关键边拆分 / 原 VM 执行'
                              : item.id === 'ssa'
                              ? 'φ 裁剪 / 版本重命名 / 行为核对'
                              : item.id === 'ssaopt'
                              ? '稀疏传播 / 死代码 / 复制合并'
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
function Reading({ lesson, navigate }: { lesson: Lesson; navigate: (stage: Stage) => void }) {
  return (
    <article className="reading-page">
      <div className="reading-lead">
        <span className={`lesson-icon ${lesson.color}`}>{lesson.icon}</span>
        <div>
          <small>{lesson.english}</small>
          <h2>
            {lesson.title}，{lesson.walkthrough ? '一步一步读懂' : '需要记住的三件事'}
          </h2>
        </div>
      </div>
      {lesson.walkthrough && (
        <section className="walkthrough" aria-label="一步一步读懂">
          <p className="walkthrough-lead">
            从你已经做过的实验出发，每一步只多走一点。读完再看下面的三条小结。
          </p>
          <ol>
            {lesson.walkthrough.map((item) => (
              <li key={item.title}>
                <h4>{item.title}</h4>
                <p>{item.body}</p>
                {item.example && (
                  <CodeBlock
                    code={item.example}
                    language={item.exampleLanguage || (lesson.id === 'automata' ? 'regex' : 'grammar')}
                    title="示例"
                  />
                )}
              </li>
            ))}
          </ol>
        </section>
      )}
      {lesson.walkthrough && <h3 className="walkthrough-summary">小结：需要记住的三件事</h3>}
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
      <LessonConnections stage={lesson.id} onNavigate={navigate} />
      <div className="reading-source">
        <span>对应原书 / 第 {lesson.chapter} 讲</span>
        <a href={chapterUrl(lesson.chapter)} target="_blank" rel="noreferrer">
          {chapters.find((c) => c.number === lesson.chapter)!.title} ↗
        </a>
        <small>
          来源核对：{['automata', 'grammar', 'lr', 'minimize'].includes(lesson.id) ? '2026-11-18' : '2026-11-16'} · 本页说明与图形独立编写
        </small>
        {lesson.id === 'grammar' && (
          <a href={LEFT_RECURSION_REFERENCE} target="_blank" rel="noreferrer">
            原书参考资料：Wikipedia · 左递归及其消除 ↗
          </a>
        )}
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
        {lesson.id === 'ssa' && (
          <>
            <small>补充概念核对：2026-11-21 · 标量 SSA 与 φ 的前驱边语义</small>
            <a href={SSA_REFERENCE} target="_blank" rel="noreferrer">Cornell CS 4120 · SSA 构造、支配边界与活跃性 ↗</a>
            <a href={PHI_REFERENCE} target="_blank" rel="noreferrer">LLVM Language Reference · φ 输入与前驱边 ↗</a>
          </>
        )}
        {lesson.id === 'minimize' && (
          <>
            <small>补充概念核对：2026-11-21 · 输出规则、状态等价与区分后缀</small>
            <a href={MINIMIZATION_REFERENCE} target="_blank" rel="noreferrer">Cornell CS 4120 · DFA 最小化与词法动作 ↗</a>
          </>
        )}
        {lesson.id === 'outssa' && (
          <>
            <small>补充概念核对：2026-11-21 · φ 消除、关键边与并行复制</small>
            <a href={OUT_SSA_REFERENCE} target="_blank" rel="noreferrer">Cornell CS 6120 · Converting from SSA ↗</a>
            <a href={SSA_DECONSTRUCTION_REFERENCE} target="_blank" rel="noreferrer">CMU 15-411 · SSA Deconstruction ↗</a>
          </>
        )}
        {lesson.id === 'codegen' && (
          <>
            <small>概念来源：2026-11-26 通过缓存脚本单页重读原书第 08 讲的指令选择一节；补充核对瓦片与最大吞进、System V AMD64 调用约定与 x86 指令手册。目标语义与运行时函数是本项目的教学约定。</small>
            <a href={TILING_REFERENCE} target="_blank" rel="noreferrer">Cornell CS 4120 · Instruction Selection（Tiles）↗</a>
            <a href={SYSV_ABI_REFERENCE} target="_blank" rel="noreferrer">x86-64 psABI · System V AMD64 ↗</a>
            <a href={INTEL_SDM_REFERENCE} target="_blank" rel="noreferrer">Intel SDM ↗</a>
          </>
        )}
        {lesson.id === 'ssaopt' && (
          <>
            <small>补充概念核对：2026-11-26 · 稀疏条件常量传播（SCCP）、稀疏死代码删除与干涉图保护的复制合并</small>
            <a href={SCCP_REFERENCE} target="_blank" rel="noreferrer">LLVM · Sparse Conditional Constant Propagation ↗</a>
            <a href={SSA_OPT_REFERENCE} target="_blank" rel="noreferrer">Cornell CS 6120 · SSA Optimization &amp; Deconstruction ↗</a>
            <a href={LOST_COPY_REFERENCE} target="_blank" rel="noreferrer">Briggs et al. · Practical Improvements to the Construction and Destruction of SSA Form（SPE 1998）↗</a>
          </>
        )}
        {lesson.id === 'regalloc' && (
          <>
            <small>补充概念核对：2026-11-22 · 干涉图、Kempe 简化与乐观着色、线性扫描、溢出重写</small>
            <a href={REGALLOC_REFERENCE} target="_blank" rel="noreferrer">Cornell CS 4120 · Register Allocation ↗</a>
          </>
        )}
        {lesson.id === 'cse' && (
          <small>概念来源：2026-11-22 通过缓存脚本单页重读原书第 07 讲（公共子表达式消除、值编号、可用表达式分析、循环不变代码外提）；异常安全的外提条件是本项目的约定。</small>
        )}
        {lesson.id === 'gc' && (
          <small>概念来源：2026-11-22 通过缓存脚本单页读取原书第 32 讲（可达性、标记-清除、标记-整理、停止-拷贝、引用计数与 Python 循环检测、三色标记）；堆模型为本项目的教学简化。</small>
        )}
        {lesson.id === 'schedule' && (
          <small>概念来源：2026-11-22 从本地缓存重读原书第 08 讲的指令排序与窥孔优化两节；延迟数值、关键路径优先级与精确异常约定是本项目的教学模型，未另找外部资料核对。</small>
        )}
        {lesson.id === 'functions' && (
          <>
            <small>补充概念核对：2026-11-21 · 调用约定、返回地址与活动记录；第 06 讲作为字节码概念入口</small>
            <a href={CALL_STACK_REFERENCE} target="_blank" rel="noreferrer">Cornell CS 3410 · Calling Conventions ↗</a>
            <a href={CALL_FRAMES_REFERENCE} target="_blank" rel="noreferrer">Crafting Interpreters · Calls and Functions ↗</a>
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
