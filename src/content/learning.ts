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
    description: '从分支和数据流走到 SSA，在 SSA 上做稀疏优化与复制合并，再看消除 φ 与专用函数调用栈。',
    stages: ['cfg', 'dataflow', 'dominance', 'ssa', 'ssaopt', 'outssa', 'functions'],
  },
  {
    id: 'backend',
    title: '优化、后端与运行时',
    description: '在数据流与循环分析之上消除重复计算，再把值分到有限寄存器、重排指令，然后把 IR 真正翻译成 x86-64 汇编；最后看运行时怎样回收不再使用的对象。',
    stages: ['cse', 'regalloc', 'schedule', 'codegen', 'gc'],
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
  dataflow: { before: ['cfg'], after: ['cse', 'ssa', 'regalloc'] },
  dominance: { before: ['cfg'], after: ['ssa', 'cse'] },
  automata: { before: ['lex'], after: ['minimize'] },
  grammar: { before: ['parse'], after: ['lr'] },
  lr: { before: ['grammar'], after: ['semantic'] },
  ssa: { before: ['dominance', 'dataflow'], after: ['ssaopt', 'outssa'] },
  minimize: { before: ['automata'], after: ['grammar'] },
  outssa: { before: ['ssa', 'ssaopt'], after: ['regalloc', 'vm'] },
  functions: { before: ['vm', 'semantic'], after: ['cfg', 'gc'] },
  regalloc: { before: ['dataflow', 'cse'], after: ['schedule', 'codegen'] },
  schedule: { before: ['regalloc', 'dataflow'], after: ['codegen', 'gc'] },
  cse: { before: ['dataflow', 'dominance'], after: ['regalloc', 'optimize'] },
  gc: { before: ['functions', 'schedule'], after: ['vm'] },
  ssaopt: { before: ['ssa', 'outssa', 'dataflow'], after: ['regalloc', 'cse'] },
  codegen: { before: ['regalloc', 'schedule'], after: ['functions', 'gc'] },
};
