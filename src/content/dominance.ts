import type { Lesson } from './lessons';
import { T } from '../i18n';

export const DOMINANCE_REFERENCE =
  'https://courses.cs.cornell.edu/courses/cs4120/2026sp/notes/reachdef/index.html';
export const LOOP_REFERENCE = 'https://llvm.org/docs/LoopTerminology.html';
export const dominanceLesson: Lesson = {
  id: 'dominance',
  number: '09',
  title: T('支配关系'),
  english: 'Dominance & loops',
  question: T('到达这个基本块，哪些地方一定经过？'),
  intro: T(
    '逐轮求出必经块，再观察直接支配树、自然循环和支配边界。尝试找一条绕过候选块的路径，检验“必经”究竟意味着什么。',
  ),
  chapter: '06',
  minutes: 20,
  icon: '⋔',
  color: 'green',
  note: [
    {
      title: T('支配是所有入口路径的共同约束'),
      body: T(
        '如果从入口到 B 的每条 CFG 路径都经过 A，A 就支配 B；每个可达块也支配自身。入口的集合只有自身，其余块从全部可达块开始，用“自身 ∪ 所有可达前驱支配集合的交集”反复收缩。直接支配者是最近的一层必经块，不一定是 CFG 中直接连边的前驱；它们组成支配树。',
      ),
    },
    {
      title: T('循环头必须支配回边的起点'),
      body: T(
        '对边 latch → header，只有 header 支配 latch 时才把它作为自然循环的回边。从 latch 沿前驱反向收集、到 header 停止，可以找到循环成员。同一 header 的回边合并，循环可嵌套；preheader 在循环外且只有一个后继指向 header。循环里的 exiting block 与循环外的 exit block 要区分，不能把图中画向上方的边都叫自然循环回边。',
      ),
    },
    {
      title: T('支配边界是理解 φ 位置的桥梁'),
      body: T(
        'DF(A) 包含这些块：A 支配它的某个前驱，却不严格支配它本身。循环头可以出现在自己的支配边界中。把一个变量的定义块放入工作列表，沿支配边界迭代，还要把新 φ 候选当成新定义继续传播。φ 根据进入块的前驱边选择一个版本，不是把所有值相加；完整 SSA 还需重命名与校验。本页没有做活跃性裁剪，所以候选可能多余。',
      ),
    },
  ],
  misconception: T(
    '本次执行经过一个块，不代表它支配后面的块。反过来，while 条件本次为 false，也不会让原始 CFG 中的结构循环自动消失。这里保留全部结构边，不使用常量传播删边；一条结构路径也不保证所有条件能同时成立。',
  ),
  limit: T(
    '分析原始 IR 的入口可达 CFG：迭代支配集合、直接支配者、支配边界、自然循环与未裁剪的迭代 φ 候选。最多 200 轮，未收敛不发布后续结论；回放最多保留 240 次块处理，最终集合完整。不是 Lengauer–Tarjan 算法，不枚举所有有向环或不可约区域。本页不改写程序；继续到实验 13「静态单赋值」可观察 φ 裁剪、版本重命名与执行。',
  ),
  challenge: T(
    '选“两条路径的共同必经块”。解释为什么某个分支块不能支配汇合块，并找到绕过它的结构路径。再选嵌套循环，指出两个 header、各自 latch 和循环成员，最后解释循环头为何可能是 φ 候选。',
  ),
  answer: T(
    '分支的另一条路径可以绕过该分支块，因此它不是汇合块的必经点；两条路径共同经过的入口仍支配汇合块。自然循环由“目标支配起点”的边反向收集，内层成员包含在外层循环中。循环头同时接收入口初值与回边更新值，迭代支配边界会将它列为候选；是否保留 φ 仍需后续分析。',
  ),
  quiz: {
    question: T('A 支配 B，最准确的意思是什么？'),
    options: [
      T('这次运行先经过 A 再经过 B'),
      T('从入口到 B 的所有 CFG 路径都经过 A'),
      T('A 到 B 必须有一条直接连边'),
    ],
    correct: 1,
    explain: T('支配关系描述全部入口路径；一次运行和一条直接连边都不足以证明它。'),
  },
};
export const dominancePresets = [
  {
    id: 'dom-diamond',
    label: T('支配 · 两条路径的共同必经块'),
    code: 'bool choose = true;\nint value = 1;\nif (choose) {\n  value = 7;\n} else {\n  value = 9;\n}\nprint(value);',
    prediction: T('把 choose 改为 false，实际输出会改变。原始 CFG 的支配集合也会改变吗？'),
  },
  {
    id: 'dom-loop',
    label: T('支配 · 循环头与回边'),
    code: 'int i = 0;\nint total = 0;\nwhile (i < 4) {\n  total = total + i;\n  i = i + 1;\n}\nprint(total);',
    prediction: T(
      '循环体到循环头的边，为什么能被认定为自然循环回边？初始 i 和回边更新的 i 在哪里汇合？',
    ),
  },
  {
    id: 'dom-nested',
    label: T('支配 · 嵌套循环的成员'),
    code: 'int outer = 0;\nint total = 0;\nwhile (outer < 2) {\n  int inner = 0;\n  while (inner < 3) {\n    total = total + 1;\n    inner = inner + 1;\n  }\n  outer = outer + 1;\n}\nprint(total);',
    prediction: T('两个循环的成员是否重叠？内层循环的退出块，会不会仍在外层循环里？'),
  },
  {
    id: 'dom-sequential',
    label: T('支配 · 两个并列循环'),
    code: 'int left = 0;\nwhile (left < 2) {\n  left = left + 1;\n}\nint right = 0;\nwhile (right < 3) {\n  right = right + 1;\n}\nprint(left + right);',
    prediction: T('同样有两个 while，这次是嵌套还是两个独立循环？'),
  },
  {
    id: 'dom-zero',
    label: T('支配 · 本次零轮仍有结构循环'),
    code: 'int i = 0;\nwhile (false) {\n  i = i + 1;\n}\nprint(i);',
    prediction: T('VM 一次也不进入循环体，原始 CFG 中的自然循环应该消失吗？请与常量传播的结果区分。'),
  },
];
