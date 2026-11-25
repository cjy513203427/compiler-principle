import type { Lesson } from './lessons';

export const SCCP_REFERENCE = 'https://www.cs.cornell.edu/courses/cs6120/2025sp/lesson/5/';

export const ssaOptLesson: Lesson = {
  id: 'ssaopt',
  number: '22',
  title: 'SSA 上的优化',
  english: 'Optimizations on SSA (SCCP & DCE)',
  question: '构造出 SSA 之后，优化为什么突然变快又变准？',
  intro:
    '对应第 06、07 讲：直接在实验 13 的 SSA 形式上运行 Wegman–Zadeck 稀疏条件常量传播（SCCP）、平凡 φ 化简与基于 def-use 链的死代码消除，对比实验 08 的稠密数据流分析，并执行优化后的 SSA 与原 VM 核对。',
  chapter: '07',
  minutes: 20,
  icon: '⚡',
  color: 'purple',
  walkthrough: [
    {
      title: '实验 08 每次变化都要重扫整块，SSA 不用',
      body: '在普通 IR 上，同一个变量 x 可以被多次赋值，数据流分析必须在每个基本块里维护一份变量映射表，并反复迭代整张图。而在 SSA 里，每个版本名（如 x.1、x.2）全局只有唯一一处定义，优化器只需给每个版本记一个格值（⊥ / 常量 / ⊤），直接顺着定义-使用链（def-use）通知用到它的指令。',
    },
    {
      title: '两条工作表一起跑：CFG 边 + SSA def-use',
      body: '稀疏条件常量传播（SCCP）同时维护 CFG 工作表和 SSA 工作表。开始时假设所有块都不可达、所有版本都是 ⊥（尚无信息）；只有从入口沿可执行边到达的块才会被评估。遇到常量条件分支时，只把真或假那一条边放进 CFG 工作表，另一条分支压根不进队。',
      example: 'bool flag = false;\nif (flag) { x = 1 / 0; } else { x = 7; }\n// 只有 false 边进入 CFG 工作表，φ 只看到 7',
      exampleLanguage: 'c',
    },
    {
      title: '为什么 SCCP 比“先做常量传播再删死分支”更强？',
      body: '在实验 08 的例子中，如果不可达分支里给 x 赋了别的值，单纯的常量传播会把两个前驱合成为 ⊤，反而失去常量。SCCP 的 φ 节点只合并“已标为可执行的前驱边”送来的版本，因此不可达分支绝不会污染 φ，常量与不可达块能互相解锁。',
    },
    {
      title: '平凡 φ 化简与沿 def-use 链删死代码',
      body: '一旦不可达边被剪掉，剩下的 φ 可能只剩一个前驱输入，或所有输入都是同一个值，这时 φ 直接化简掉。接着从 print、活跃分支和可能除零/溢出的算术出发，沿 SSA def-use 链反向标记需要的版本，其余未标记的定义和 φ 一次全部删净。',
    },
    {
      title: '把优化后的 SSA 真实跑一遍',
      body: '优化器不会把可能除零或溢出的未折叠算术删掉，也不会重排 print 顺序。页面最后直接解释执行优化后的 SSA，与原始 Mini C 虚拟机核对输出与错误。',
    },
  ],
  note: [
    {
      title: '稀疏（Sparse）的意思是按需传播',
      body: '信息直接从定义点跳到使用点，不需要把无关变量沿每条基本块边搬来搬去。每条边最多进一次 CFG 工作表，每个 SSA 版本最多升级两次（⊥ → 常量 → ⊤），因此总工作量与程序规模线性相关。',
    },
    {
      title: '条件常量与不可达块互相促进',
      body: '常量条件剪掉不可达边 → 汇合处 φ 的输入变少 → φ 可能变成新常量 → 后续分支条件也变成常量。把两件事放进同一个工作表循环才能做到这种连锁化简。',
    },
    {
      title: '异常语义依然优先于激进删除',
      body: '如果某个常量算术本身会除零或超出安全整数，SCCP 不会把它折叠成常量，而是保守标为 ⊤ 并保留指令，确保运行时依然在正确位置报错。',
    },
  ],
  misconception:
    '“SSA 里的 φ 节点只是语法糖，优化前必须先消除”是误解：恰恰相反，中端优化都是在保留 φ 的 SSA 形式上完成的，优化结束后才由实验 15（SSA 消除）把剩余的 φ 变回边复制。',
  limit:
    '在实验 13 的标量 SSA 上实现 Wegman–Zadeck SCCP、平凡 φ 化简与保守 SSA DCE；为保持安全整数与除零异常语义，未折叠的算术运算视为可能触发异常而保留。不包含循环展开、全局值编号或 SSA 消除后的复制合并。',
  challenge:
    '选择“常量分支解锁汇合常量”预设，单步观察 CFG 工作表为何没有把 then 块放进去，以及汇合块的 φ 如何直接变成常量 7。再把 flag 改成循环变量，看看结果如何变成 ⊤。',
  answer:
    'flag.1 在入口就确定为 false，遇到 branch flag.1 时 SCCP 只把 false 边加入 CFG 工作表，then 块始终不可达。于是汇合块的 φ 只读取 else 边传来的 7，直接收敛为常量 7 并化简掉整个 φ 和 then 块。改成循环变量后，回边把条件推向 ⊤，两条分支都变为可执行，φ 合并两个不同常量后也变成 ⊤。',
  quiz: {
    question: '在 SCCP 中，某个汇合块有一个 φ([B1: x.1], [B2: x.2])，其中 B1 → 汇合块已可执行且 x.1 = 7，B2 → 汇合块尚未被标为可执行且 x.2 = 9。此时 φ 的格值应算作什么？',
    options: ['⊤（7 和 9 冲突）', '7（只合并已标为可执行的前驱边）', '⊥（必须等所有前驱都可执行）'],
    correct: 1,
    explain: 'SCCP 的核心就是只对已标为可执行的前驱边做 meet；尚未可执行的边按 ⊥ 处理，不会把 7 污染成 ⊤。只有当 B2 的边日后真的变成可执行时，才会重新把 φ 推向 ⊤。',
  },
};

export const ssaOptPresets = [
  {
    id: 'ssaopt-branch-unlock',
    label: 'SSA 优化 · 常量分支解锁汇合 φ',
    code: 'bool flag = false;\nint x = 0;\nif (flag) {\n  x = 1 / 0;\n} else {\n  x = 7;\n}\nint y = x * 3 + 1;\nprint(y);',
    prediction: 'flag 恒为 false。SCCP 会访问 if 的真分支吗？x 的 φ 与 y 会化简成什么？',
  },
  {
    id: 'ssaopt-loop-phi',
    label: 'SSA 优化 · 循环回边把 φ 推向 ⊤',
    code: 'int i = 0;\nint k = 10;\nwhile (i < 3) {\n  i = i + 1;\n}\nprint(i + k);',
    prediction: '进入循环前 i 是 0，回边加入后 i 的 φ 变成什么？不变的 k 会受影响吗？',
  },
  {
    id: 'ssaopt-dead-phi',
    label: 'SSA 优化 · 无用分支写入与死 φ 消除',
    code: 'int a = 1;\nwhile (a < 3) {\n  a = a + 1;\n}\nint used = 0;\nint unused = 0;\nif (a == 3) {\n  used = 5;\n  unused = 100;\n} else {\n  used = 5;\n  unused = 200;\n}\nprint(used);',
    prediction: '两条分支都给 used 赋 5，给 unused 赋不同值但从未打印。SCCP + DCE 之后还剩什么？',
  },
  {
    id: 'ssaopt-chain',
    label: 'SSA 优化 · 级联常量条件剪枝',
    code: 'int a = 2 + 3;\nint b = a * 2;\nint res = 0;\nif (b == 10) {\n  if (a < 6) {\n    res = b + 5;\n  } else {\n    res = 99;\n  }\n} else {\n  res = -1;\n}\nprint(res);',
    prediction: '两层嵌套 if 都能在 SSA 格值传播中被静态剪掉吗？最后还剩几条指令？',
  },
  {
    id: 'ssaopt-trap',
    label: '边界 · 保留可达的除零异常',
    code: 'int a = 10;\nint b = 0;\nint unused = a / b;\nprint(42);',
    prediction: 'unused 从未被 print 读取，SCCP 和 SSA 死代码消除能把 a / b 删掉吗？',
  },
];
