import type { Lesson } from './lessons';
import { T } from '../i18n';

export const OUT_SSA_REFERENCE = 'https://www.cs.cornell.edu/courses/cs6120/2025sp/lesson/6/';
export const SSA_DECONSTRUCTION_REFERENCE = 'https://www.cs.cmu.edu/~15411/rec/02.pdf';
export const outSsaLesson: Lesson = {
  id: 'outssa', number: '15', title: T('SSA 消除'), english: 'Out of SSA',
  question: T('去掉 φ，普通复制怎样保留同样的行为？'),
  intro: T('接着静态单赋值实验，按前驱边把 φ 变成复制，拆分关键边、安排复制顺序，再生成普通字节码交给原栈式虚拟机执行。'),
  chapter: '06', minutes: 22, icon: '⇄', color: 'blue',
  walkthrough: [
    { title: T('把每个 φ 的选择放回前驱边'), body: T('实验 13 中，φ 按刚刚经过的前驱选择输入。消除 φ 时，把这个选择改成对应边上的普通复制。同一条边进入块首的所有 φ，必须先合成一组并行复制，不能分别处理后就忘了它们相互依赖。'), example: 'B2: x.3 = φ([B0: x.1], [B1: x.2])\n\nB0 → B2:  x.3 ← x.1\nB1 → B2:  x.3 ← x.2', exampleLanguage: 'text' },
    { title: T('先确定复制放在哪里'), body: T('前驱只有一条后继边时，可以在它的普通指令之后、跳转之前放复制。否则，若目标只有一个前驱，可以放在目标入口。两端都不满足时，这是一条关键边（Critical edge）：插入一个新边块，让复制只在走这条边时执行。'), example: T('B0 → B2\n变为\nB0 → E0（复制）→ B2'), exampleLanguage: 'text' },
    { title: T('并行复制不能直接照着列表执行'), body: T('同时做 a ← b 和 b ← a 的意思是交换旧值。直接先写 a，再读 a 写 b，会让两者都变成原来的 b。正确调度先找可以安全覆盖的目标；形成复制环时，用一个新临时变量保存旧值。'), example: T('并行：a ← b，b ← a\n顺序：tmp ← a\n      a ← b\n      b ← tmp'), exampleLanguage: 'text' },
    { title: T('版本名可以保留，单赋值性质会消失'), body: T('消除后仍使用 x.1、x.2 等名字表示存储位置，但同一个 φ 目标现在可以在多条前驱边被写入。保留名字不是保留 SSA。当前 Mini C 直接构造的 SSA 常常没有复制环；独立小实验可以编辑出环，观察同一调度器怎样处理。') },
    { title: T('把块和跳转重新排成普通 IR'), body: T('原始标签是别名，新的输出为每个块分配明确标签。条件块分别跳到真、假目标，新边块执行复制后再跳向原目标。显示中的块顺序不代表执行顺序；所有边都通过实际标签和跳转连接，出口跳到统一 HALT 位置。') },
    { title: T('接回已有的字节码生成器和 VM'), body: T('转换结果只包含普通的赋值、运算、输出、标签和跳转，没有 φ。页面比较原始 VM、SSA 解释器、消除后 VM 的输出与错误，并回放消除后 VM 的真实 PC、操作数栈和输出。不同表示的计步方式和跳转数量不同，任一达到上限就不判定行为一致。') },
  ],
  note: [
    { title: T('φ 是边上的选择'), body: T('边复制的位置由实际前驱与后继关系决定。分支只走一边，不能因为两边最终都汇合，就把某条边的复制随意放到分支之前或汇合之后。拆分关键边让这个执行位置显式可见。') },
    { title: T('先保留旧值，再覆盖位置'), body: T('调度时，目标的旧值若仍是其他待处理复制的源，就暂时不能覆盖。找不到安全目标时，保存环内一个旧值并替换相应读取。自身复制可以省略，临时变量必须使用没有冲突的新名字。') },
    { title: T('消除表示不等于完成后端优化'), body: T('这里实现的是保留独立版本位置的基础 SSA 消除，不做复制合并、寄存器分配或机器码生成，也没有把现有优化器换成 SSA 优化器。普通 IR 已交给原 VM 执行，教学边界仍是严格 bool 与安全整数。') },
  ],
  misconception: T('“φ 的每个输入都复制一次”缺少两个条件：复制要出现在对应的控制流边上，同一条边的一组复制要保留同时读旧值的语义。顺序照抄可能覆盖尚未读取的值；把复制放错路径也可能改变循环状态。'),
  limit: T('仅消除当前标量局部变量 SSA 的 φ，保留版本名。前驱末尾、后继入口或新边块放置复制，调度复制环后重建普通 IR，复用现有字节码生成器与 VM。没有复制合并、寄存器分配、函数或机器码后端。程序最多 2000 字符，转换 IR 最多 10000 条，VM 最多 2000 条字节码；构造与 VM 中间回放各保留前 240 步，最终结果完整保留。任一执行超限时，只比较输出前缀并显示无法判定。复制小实验独立于主程序，最多 500 字符、12 条复制与 24 个初始名字，不写入分享 URL。'),
  challenge: T('在默认预设中把 choose 从 false 改成 true，说明 E0 是否仍存在、本次 VM 是否经过它。再在复制小实验中交换 a 与 b，解释直接顺序复制为何错误、临时变量保存的是什么。'),
  answer: T('关键边来自原始 CFG 的结构，常量条件变化不删除它；E0 仍存在，但选择真分支时不会经过对应的假边块。交换需要读取 a、b 的两个旧值，先写 a 会破坏后一次读取；先把旧 a 存进临时变量，最后再写入 b，才能实现并行交换。'),
  quiz: { question: T('一组并行复制 a ← b、b ← a，初始 a=1、b=2。哪种顺序正确？'),
    options: [T('a ← b；b ← a'), T('tmp ← a；a ← b；b ← tmp'), T('两种顺序都得到 a=2、b=1')], correct: 1,
    explain: T('临时变量保存旧 a。没有它，第一步覆盖 a，第二步读到的已是旧 b，最后两者都会变成 2。') },
};
export const outSsaPresets = [
  { id: 'out-critical', label: T('SSA 消除 · 关键边上的复制'),
    code: 'bool choose = false;\nint value = 1;\nif (choose) {\n  value = 7;\n}\nprint(value);',
    prediction: T('B0 可以去两个块，汇合块也有两个前驱。假边上的复制放在哪里，才能只在这条路径执行？') },
  { id: 'out-diamond', label: T('SSA 消除 · 两个分支的复制'),
    code: 'bool choose = true;\nint value = 1;\nif (choose) {\n  value = 7;\n} else {\n  value = 9;\n}\nprint(value);',
    prediction: T('两个分支都只有一条后继边，还需要新增边块吗？') },
  { id: 'out-loop', label: T('SSA 消除 · 循环初值与回边'),
    code: 'int i = 0;\nint total = 0;\nwhile (i < 4) {\n  total = total + i;\n  i = i + 1;\n}\nprint(total);',
    prediction: T('循环外的初值复制与回边的更新复制分别在哪执行？') },
  { id: 'out-swap', label: T('SSA 消除 · 循环中交换值'),
    code: 'int a = 1;\nint b = 2;\nint i = 0;\nwhile (i < 3) {\n  int saved = a;\n  a = b;\n  b = saved;\n  i = i + 1;\n}\nprint(a);\nprint(b);',
    prediction: T('主程序保留了各个版本名，未必直接产生复制环；请与独立复制小实验的 a、b 交换对照。') },
  { id: 'out-zero', label: T('SSA 消除 · 本次循环零轮'),
    code: 'int i = 0;\nwhile (false) {\n  i = i + 1;\n}\nprint(i);',
    prediction: T('本次不会走回边，为什么转换结果中仍保留回边复制？') },
  { id: 'out-straight', label: T('SSA 消除 · 没有 φ 的程序'),
    code: 'int x = 3;\nprint(x + 4);',
    prediction: T('没有 φ 时，会不会凭空生成边复制或临时变量？') },
  { id: 'out-trap', label: T('SSA 消除 · 保留输出与除零'),
    code: 'int divisor = 0;\nprint(5);\nint value = 10 / divisor;\nprint(value);',
    prediction: T('去掉 φ 和改写跳转，是否会改变除零之前已经输出的 5？') },
];
export const copyPresets = [
  { id: 'swap', label: T('两个值交换'), code: 'a <- b\nb <- a\n%%\na = 1\nb = 2' },
  { id: 'chain', label: T('没有环也要安排顺序'), code: 'b <- c\na <- b\n%%\na = 1\nb = 2\nc = 3' },
  { id: 'cycle', label: T('三个值轮换'), code: 'a <- b\nb <- c\nc <- a\n%%\na = 1\nb = 2\nc = 3' },
  { id: 'identity', label: T('自身复制与普通复制'), code: 'a <- a\nb <- a\n%%\na = 4\nb = 9' },
];
