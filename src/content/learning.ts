import type { Stage } from '../compiler/model';

export interface LearningRoute {
  id: string;
  title: string;
  description: string;
  stages: Stage[];
}

export const learningRoutes: LearningRoute[] = [
  {
    id: 'foundation',
    title: '先跑通编译流程',
    description: '第一次阅读，从字符一直走到执行。沿用同一份 Mini C 程序，先建立全貌。',
    stages: ['lex', 'parse', 'semantic', 'ir', 'optimize', 'vm'],
  },
  {
    id: 'frontend',
    title: '词法与文法进阶',
    description: '熟悉词法和语法分析后，再看规则如何生成自动机、预测表与移进规约表。',
    stages: ['automata', 'minimize', 'grammar', 'lr'],
  },
  {
    id: 'middle',
    title: '程序表示与调用',
    description: '从分支和数据流走到 SSA，再消除 φ 回到普通 IR；最后进入专用函数方言，观察调用栈。',
    stages: ['cfg', 'dataflow', 'dominance', 'ssa', 'outssa', 'functions'],
  },
  {
    id: 'backend',
    title: '优化、后端与运行时',
    description: '在数据流与循环分析之上消除重复计算，再做指令选择、寄存器分配与指令排序；最后看运行时怎样回收不再使用的对象。',
    stages: ['cse', 'isel', 'regalloc', 'schedule', 'gc'],
  },
  {
    id: 'advanced',
    title: '进阶优化与现代语言实现',
    description: '直接在 SSA 上做稀疏条件常量传播，再看方法内联与逃逸分析、面向对象虚表分派、闭包环境捕获与无栈协程状态机。',
    stages: ['ssaopt', 'escape', 'vtable', 'closure', 'coroutine'],
  },
];

// Suggestions are navigation aids, not gates. New labs must declare their connections here.
export const lessonConnections: Record<Stage, { before: Stage[]; after: Stage[] }> = {
  lex: { before: [], after: ['parse', 'automata'] },
  parse: { before: ['lex'], after: ['semantic', 'grammar'] },
  semantic: { before: ['parse'], after: ['ir'] },
  ir: { before: ['semantic'], after: ['optimize', 'cfg'] },
  optimize: { before: ['ir'], after: ['vm', 'dataflow'] },
  vm: { before: ['ir'], after: ['cfg', 'functions'] },
  cfg: { before: ['ir', 'vm'], after: ['dataflow', 'dominance'] },
  dataflow: { before: ['cfg'], after: ['cse', 'ssa', 'ssaopt'] },
  dominance: { before: ['cfg'], after: ['ssa', 'cse'] },
  automata: { before: ['lex'], after: ['minimize'] },
  grammar: { before: ['parse'], after: ['lr'] },
  lr: { before: ['grammar'], after: ['semantic'] },
  ssa: { before: ['dominance', 'dataflow'], after: ['ssaopt', 'outssa'] },
  minimize: { before: ['automata'], after: ['grammar'] },
  outssa: { before: ['ssa', 'ssaopt'], after: ['isel', 'regalloc'] },
  functions: { before: ['vm', 'semantic'], after: ['escape', 'closure', 'coroutine'] },
  regalloc: { before: ['isel', 'dataflow'], after: ['schedule'] },
  schedule: { before: ['regalloc', 'dataflow'], after: ['gc'] },
  cse: { before: ['dataflow', 'dominance'], after: ['ssaopt', 'isel'] },
  gc: { before: ['escape', 'closure'], after: ['vm'] },
  isel: { before: ['ir', 'cse'], after: ['regalloc', 'schedule'] },
  ssaopt: { before: ['ssa', 'dataflow'], after: ['outssa', 'escape'] },
  escape: { before: ['functions', 'ssaopt'], after: ['gc', 'vtable'] },
  vtable: { before: ['functions', 'escape'], after: ['closure'] },
  closure: { before: ['functions', 'escape'], after: ['gc', 'coroutine'] },
  coroutine: { before: ['functions', 'dataflow'], after: ['closure', 'gc'] },
};
