import type { Lesson } from './lessons';

export const ISEL_REFERENCE = 'https://www.cs.cornell.edu/courses/cs4120/2026sp/notes/instsel/';

export const iselLesson: Lesson = {
  id: 'isel',
  number: '21',
  title: '指令选择',
  english: 'Instruction selection',
  question: '同一棵表达式树，为什么 CISC 能压成一条指令？',
  intro:
    '对应第 08、16 讲：把 Mini C 的三地址代码还原成表达式树，用教学 CISC（含 LEA 与 MADD）和 RISC 指令集做树覆盖，亲眼比较最大吞噬贪心、自底向上动态规划（BURS 思路）与逐条直译的代价，并执行全部版本核对输出。',
  chapter: '08',
  minutes: 20,
  icon: '⊞',
  color: 'orange',
  walkthrough: [
    {
      title: '三地址代码只是“拆碎了的树”',
      body: '前端生成三地址代码时，把 a + b * 4 + 10 拆成了 t0 = b * 4、t1 = a + t0、t2 = t1 + 10。每个临时变量只在当前基本块用一次时，后端可以把它还原回一棵表达式树（或 DAG），这样才能一眼看出多条 IR 其实能合并成一条硬件指令。',
      example: 't0 = b * 4\nt1 = a + t0\nt2 = t1 + 10\n// 合并成一棵树：((a + (b * 4)) + 10)',
      exampleLanguage: 'text',
    },
    {
      title: '每条目标指令都是一块“瓦片”',
      body: '指令选择把树覆盖问题抽象成拼瓦片（Tree Tiling）：每条机器指令对应一小块树模板和一个代价。比如 x86 的 LEA 指令既能算基址加变址乘比例（1/2/4/8），还能顺手加一个立即数偏移，一块瓦片直接盖住三个运算符，代价却只要 2。',
      example: 'LEA dst, [a + b*4 + 10]   // 一条指令替代 MUL + ADD + ADD',
      exampleLanguage: 'asm',
    },
    {
      title: '贪心“最大吞噬”不一定最省',
      body: '最大吞噬（Maximal Munch）从树根往下看，总是优先拿能盖住最多运算符的瓦片。遇到 a * 3 + b 时，贪心会立刻选覆盖两个运算符的 MADD（代价 5，还要先把 3 装进寄存器，总代价 6）；而自底向上动态规划（BURS 思路）算出下面 a * 3 可以用 LEA [a + a*2]（代价 2）再加 b（代价 2），总代价只有 4。',
      example: 'a * 3 + b\n贪心：MOV r0, 3 ; MADD r, a, r0, b    // 代价 6\nDP ：LEA r0, [a + a*2] ; ADD r, r0, b // 代价 4',
      exampleLanguage: 'asm',
    },
    {
      title: 'CISC 与 RISC 的风格差异',
      body: '第 08 讲对比了 x86（CISC）和 ARM（RISC Load-Store）。本页同时生成 RISC 教学版本：没有 LEA 和 MADD，立即数也先用 MOVI 装入寄存器，再做寄存器算术。指令条数通常更多，但每条指令规则整齐、译码简单。',
    },
    {
      title: '换了指令，行为必须完全一致',
      body: '指令选择发生在寄存器分配之前（此时仍使用虚拟寄存器），随后再做寄存器分配和指令排序。本页把直译、CISC 贪心、CISC DP、RISC 四个版本都交给目标模拟器真实执行，与原 Mini C 虚拟机核对输出与除零/溢出错误。',
    },
  ],
  note: [
    {
      title: '指令选择先于寄存器分配',
      body: '第 08 讲的经典后端顺序是：指令选择（MIR → 带虚拟寄存器的 LIR）→ 指令排序 → 寄存器分配 → 再做指令排序与窥孔优化。本实验输出使用虚拟寄存器 r0、r1……，还没有映射到有限物理寄存器。',
    },
    {
      title: '树覆盖对比：最大吞噬 vs 动态规划',
      body: '最大吞噬实现简单、速度快，但局部贪心可能错过全局更优组合；动态规划（以及 HotSpot C2 使用的 BURS）自底向上为每个子树求最小总代价，在树结构上可以保证拿到当前瓦片集的最优解。',
    },
    {
      title: '单使用者约束保护副作用顺序',
      body: '像第 16 讲 Graal 匹配 addMemory 时要求 singleUser=true 一样，只有只被读取一次、且中间没有改写其依赖变量的临时值才能折叠进树；跨语句赋值、print 和分支边界不会越界折叠，防止改变异常顺序。',
    },
  ],
  misconception:
    '“一条指令盖住的运算符越多，总代价一定越低”并不总是对的：如果大瓦片本身代价高（例如需要把常量先放进寄存器的 MADD），反而可能输给两块更轻量的廉价瓦片（例如 LEA_MUL3 + ADD）。',
  limit:
    '教学瓦片集包含 CISC（MOV / ADD / SUB / IMUL / IDIV / SHL / LEA / MADD / CMP）与 RISC Load-Store 子集，代价为教学设定，不对应任何具体 CPU 周期表；只在基本块内按单使用者折叠表达式树，不做 DAG 共享优化、内存寻址合并、机器码编码或真实 ABI 调用约定。',
  challenge:
    '先看“贪心 vs DP：a * 3 + b”预设，解释最大吞噬和动态规划分别选了什么指令、为什么总代价不同。再把 3 改成变量 c，观察两者结果如何变化。',
  answer:
    '在 a * 3 + b 中，最大吞噬从根部优先匹配覆盖两个运算符的 MADD（代价 5），还必须用 MOV 把 3 放进寄存器（代价 1），总代价 6；动态规划则先发现 a * 3 可用 LEA [a + a*2]（代价 2），再配 ADD（代价 2），总代价仅 4。把 3 换成普通变量 c 后，a * c 不能用 LEA，于是 MADD（代价 5）反而胜过 IMUL + ADD（代价 6）。',
  quiz: {
    question: '在 x86 后端中，为什么编译器经常用 LEA 指令计算 a + b * 4 + 10 这样的普通整数表达式？',
    options: [
      '因为 LEA 专门用来读写内存里的数据',
      '因为 LEA 复用地址计算单元，能一条指令完成基址、比例变址和偏移相加，且不访问内存',
      '因为 x86 没有 ADD 和 MUL 指令',
    ],
    correct: 1,
    explain: 'LEA 只计算有效地址本身，并不访问内存；编译器借用它的 [base + index*scale + disp] 形式把多次整数加法与 2/4/8 乘法合并为一条低代价指令。',
  },
};

export const iselPresets = [
  {
    id: 'isel-lea-full',
    label: '指令选择 · LEA 融合三步计算（第 08 / 16 讲）',
    code: 'int a = 5;\nint b = 3;\nint addr = a + b * 4 + 10;\nprint(addr);',
    prediction: 'a + b * 4 + 10 在三地址代码里有 3 条算术指令，CISC 的 LEA 能把它压成几条？RISC 呢？',
  },
  {
    id: 'isel-greedy-vs-dp',
    label: '对照 · 贪心最大吞噬输给 DP（a * 3 + b）',
    code: 'int a = 7;\nint b = 5;\nint r = a * 3 + b;\nprint(r);',
    prediction: '最大吞噬会优先拿覆盖两个运算符的 MADD，还是两步 LEA + ADD？哪种总代价更低？',
  },
  {
    id: 'isel-madd-wins',
    label: '对照 · 通用乘加时 MADD 胜出（a * c + b）',
    code: 'int a = 7;\nint c = 6;\nint b = 5;\nint r = a * c + b;\nprint(r);',
    prediction: '把常量 3 换成变量 c 之后，LEA 还能用吗？MADD 和 IMUL + ADD 谁更划算？',
  },
  {
    id: 'isel-foo-book',
    label: '指令选择 · 原书 foo(a, b) 的 a + b + 10',
    code: 'int a = 12;\nint b = 8;\nint sum = a + b + 10;\nprint(sum);',
    prediction: '对应第 08 讲和第 16 讲的经典例子：a + b + 10 如何被一条 LEA 覆盖？',
  },
  {
    id: 'isel-loop-scale',
    label: '指令选择 · 循环里的比例乘法与移位',
    code: 'int i = 0;\nint acc = 0;\nwhile (i < 4) {\n  acc = acc + i * 8 + 1;\n  i = i + 1;\n}\nprint(acc);',
    prediction: '循环体里的 acc + i * 8 + 1 在 CISC 和 RISC 下各自会生成哪些指令？',
  },
  {
    id: 'isel-div-trap',
    label: '边界 · 保留除零错误顺序',
    code: 'int x = 10;\nint y = 0;\nprint(x + 2 * 4);\nint bad = x / y;\nprint(bad);',
    prediction: '指令选择后，第一行 print 会先输出 18，然后再在除零处报错吗？',
  },
];
