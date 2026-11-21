import type { Lesson } from './lessons';

export const SSA_REFERENCE = 'https://courses.cs.cornell.edu/courses/cs4120/2026sp/notes/reachdef/index.html';
export const PHI_REFERENCE = 'https://llvm.org/docs/LangRef.html#phi-instruction';
export const ssaLesson: Lesson = {
  id: 'ssa',
  number: '13',
  title: '静态单赋值',
  english: 'Static single assignment',
  question: '同一个变量的几次赋值，怎样各有一个名字？',
  intro: '接着支配关系实验，把 φ 候选变成真正的 SSA：裁剪位置、沿支配树重命名，再逐步执行，检查分支与循环怎样选择输入版本。',
  chapter: '06',
  minutes: 22,
  icon: 'φ',
  color: 'blue',
  walkthrough: [
    {
      title: '先给每次写入一个名字',
      body: '在中间代码实验里，x 可以被反复写入。SSA 给每一处静态写入分配唯一版本；右边先读旧版本，左边再创建新版本。源变量已经用符号表区分了作用域，版本号在这个基础上增加。',
      example: 'x.1 = 1\nx.2 = x.1 + 1\nprint x.2',
      exampleLanguage: 'text',
    },
    {
      title: '两条路径汇合时，用 φ 选择版本',
      body: '在支配关系实验里，你已经找到 φ 候选。若变量在块入口活跃，就需要把不同路径上的定义合成一个名字。φ 的每个输入写着对应的前驱块；从哪个前驱来，就选那个值。',
      example: 'B3:\n  x.4 = φ([B1: x.2], [B2: x.3])\n  print x.4',
      exampleLanguage: 'text',
    },
    {
      title: '沿支配树走，版本栈记录当前可见定义',
      body: '进入块先给 φ 命名，再逐条处理普通指令；用完本块后，为后继 φ 填入当前栈顶。访问完支配子树就弹栈，避免把一个分支的版本带进兄弟分支。版本栈属于构造算法，不是运行时调用栈。',
    },
    {
      title: '循环头同时接收初值与更新值',
      body: '第一次进入循环头选循环外的初值；从回边进入则选上一轮的更新版本。静态单赋值限制每个名字只有一处定义；这处定义可以随循环动态执行多次。块首多个 φ 先读完输入，再同时写入，才能正确处理交叉依赖。',
      example: 'B1:\n  i.2 = φ([B0: i.1], [B2: i.3])\n  ...\nB2:\n  i.3 = i.2 + 1\n  goto B1',
      exampleLanguage: 'text',
    },
    {
      title: '校验结构，再核对实际行为',
      body: '唯一命名还不够：普通使用必须由定义支配，φ 的输入必须覆盖可达前驱，且定义能到达对应前驱的末尾。本实验校验通过才执行；原始 VM 与 SSA 解释器独立执行当前程序，对照输出与错误。',
    },
  ],
  note: [
    { title: 'SSA 是一种表示，不会自动变快', body: '每个静态版本只定义一次，使定义与使用的关系更清楚。插入 φ 和重命名本身没有消除计算，也不能用版本数或指令条数代替性能测量。现有优化器仍独立使用可变变量 IR。' },
    { title: '活跃性决定哪些候选值得保留', body: '从定义块沿支配边界迭代；只在变量入口活跃的块插入 φ，并把新 φ 当成定义继续传播。候选表也列出被裁掉的位置。临时值在循环体内先定义后使用时，通常不需要在循环头合并。' },
    { title: 'φ 使用发生在对应的前驱边上', body: '普通使用的定义应在同块更早的位置，或在支配它的块中。φ 的输入则在前驱末尾检查：回边的更新定义不必支配循环头，却必须支配那条回边的起点。多个 φ 逻辑上同时赋值。' },
  ],
  misconception: 'φ 不会执行所有分支，也不会求和或任选一个值。改变条件会改变本次选中的输入，但不会删除原始 CFG 的另一条结构边。静态单赋值也不表示循环中的定义在运行时只能执行一次。',
  limit: '面向当前 Mini C 的标量局部变量，构造入口结构可达图上的活跃性裁剪 SSA，沿支配树栈式重命名并校验。保留原始指令顺序与安全整数、严格 bool、除零等异常语义。没有内存 SSA、函数、指针、SSA 消除或基于 SSA 的优化。构造与执行各记录前 240 步，最终结果完整；SSA 执行最多 2000 次操作，任一执行超限就不判定行为一致。并非可提交给 LLVM 的 IR。',
  challenge: '选“分支汇合”，把 choose 改为 false，说明 φ 的结构为什么不变、选中的输入为什么变化。再选循环，指出第一次与回边进入时的输入，并解释为何不会为每一轮生成新的静态版本名。',
  answer: 'φ 的位置由结构支配关系、定义块与活跃性决定；改变常量条件不会改动原始结构边，但运行时进入汇合块的前驱会改变。循环头从前置块取得初值，从回边取得上一轮更新值。版本名代表静态定义位置，循环重复执行这些位置，所以不用按迭代次数继续创建名字。',
  quiz: {
    question: 'x.3 = φ([B1: x.1], [B2: x.2]) 从 B2 进入时，x.3 取哪个值？',
    options: ['x.1 + x.2', 'x.2 的值', '总是取版本号最大的运行时值'],
    correct: 1,
    explain: 'φ 按实际进入块的前驱边选输入；B2 对应 x.2。版本号表示静态定义，不能据此判断运行时先后。',
  },
};
export const ssaPresets = [
  { id: 'ssa-diamond', label: 'SSA · 分支汇合',
    code: 'bool choose = true;\nint value = 1;\nif (choose) {\n  value = 7;\n} else {\n  value = 9;\n}\nprint(value);',
    prediction: '把 choose 改成 false，φ 的位置会改变，还是只有进入汇合块的前驱改变？' },
  { id: 'ssa-loop', label: 'SSA · 循环初值与回边',
    code: 'int i = 0;\nint total = 0;\nwhile (i < 4) {\n  total = total + i;\n  i = i + 1;\n}\nprint(total);',
    prediction: '循环头的 i 与 total 各有几个输入？四轮循环会生成四套静态版本名吗？' },
  { id: 'ssa-pruned', label: 'SSA · 无用 φ 的活跃性裁剪',
    code: 'bool choose = true;\nint value = 0;\nif (choose) {\n  value = 7;\n} else {\n  value = 9;\n}\nvalue = 11;\nprint(value);',
    prediction: '汇合后的第一条语句覆盖了 value，先前分支的值还需要 φ 吗？' },
  { id: 'ssa-scope', label: 'SSA · 同名变量与作用域',
    code: 'int x = 2;\nif (true) {\n  int x = 7;\n  x = x + 1;\n  print(x);\n}\nx = x + 1;\nprint(x);',
    prediction: '两处 x 已有不同的符号表名字；给它们加版本号后，会不会相互影响？' },
  { id: 'ssa-swap', label: 'SSA · 循环中交换两个值',
    code: 'int a = 1;\nint b = 2;\nint i = 0;\nwhile (i < 3) {\n  int saved = a;\n  a = b;\n  b = saved;\n  i = i + 1;\n}\nprint(a);\nprint(b);',
    prediction: '多个 φ 在进入循环头时怎样读写？交换三轮之后，a 和 b 是多少？' },
  { id: 'ssa-trap', label: 'SSA · 保留输出与除零异常',
    code: 'int divisor = 0;\nprint(5);\nint value = 10 / divisor;\nprint(value);',
    prediction: '除零前的 5 是否仍输出？SSA 表示能让这次错误消失吗？' },
];
