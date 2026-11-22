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
    description: '从分支和数据流走到 SSA，再消除 φ 回到普通 IR；用活跃性把值分到有限寄存器，再重排指令、做窥孔优化；最后进入专用函数方言，观察调用栈。',
    stages: ['cfg', 'dataflow', 'dominance', 'ssa', 'outssa', 'regalloc', 'schedule', 'functions'],
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
  dataflow: { before: ['cfg'], after: ['optimize', 'ssa', 'regalloc'] },
  dominance: { before: ['cfg'], after: ['ssa'] },
  automata: { before: ['lex'], after: ['minimize'] },
  grammar: { before: ['parse'], after: ['lr'] },
  lr: { before: ['grammar'], after: ['semantic'] },
  ssa: { before: ['dominance', 'dataflow'], after: ['outssa', 'optimize'] },
  minimize: { before: ['automata'], after: ['grammar'] },
  outssa: { before: ['ssa', 'cfg'], after: ['regalloc', 'vm'] },
  functions: { before: ['vm', 'semantic'], after: ['cfg'] },
  regalloc: { before: ['dataflow', 'outssa'], after: ['schedule', 'functions'] },
  schedule: { before: ['regalloc', 'dataflow'], after: ['functions', 'optimize'] },
};
