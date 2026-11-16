import type { Stage } from '../compiler/model';

export const BOOK = 'https://learn.lianglianglee.com/专栏/编译原理实战课';
export const chapters = [
  {
    number: '02',
    title: '词法分析：用两种方式构造有限自动机',
    file: '02 词法分析：用两种方式构造有限自动机.md',
  },
  {
    number: '03',
    title: '语法分析：两个基本功和两种算法思路',
    file: '03 语法分析：两个基本功和两种算法思路.md',
  },
  {
    number: '04',
    title: '语义分析：让程序符合语义规则',
    file: '04 语义分析：让程序符合语义规则.md',
  },
  { number: '06', title: '中间代码：不是只有一副面孔', file: '06 中间代码：不是只有一副面孔.md' },
  {
    number: '07',
    title: '代码优化：跟编译器做朋友，让你的代码飞起来',
    file: '07 代码优化：跟编译器做朋友，让你的代码飞起来.md',
  },
  {
    number: '18',
    title: 'Python编译器（二）：从AST到字节码',
    file: '18 Python编译器（二）：从AST到字节码.md',
    verified: false,
  },
];
export const chapterUrl = (number: string) =>
  `${BOOK}/${encodeURIComponent(chapters.find((c) => c.number === number)!.file)}`;
export interface Lesson {
  id: Stage;
  number: string;
  title: string;
  english: string;
  question: string;
  intro: string;
  chapter: string;
  minutes: number;
  icon: string;
  color: string;
  note: { title: string; body: string }[];
  misconception: string;
  limit: string;
  challenge: string;
  answer: string;
  quiz: { question: string; options: string[]; correct: number; explain: string };
}
export const lessons: Lesson[] = [
  {
    id: 'lex',
    number: '01',
    title: '词法分析',
    english: 'Lexical analysis',
    question: '字符，什么时候成为一个词？',
    intro:
      '让扫描器读过每个字符，观察状态迁移与 Token 的产生。试着把 int 改成 integer，会被切成什么？',
    chapter: '02',
    minutes: 8,
    icon: 'Aa',
    color: 'green',
    note: [
      {
        title: '先找边界，再决定类别',
        body: '扫描器顺序读取输入，在标识符、数字和符号状态之间切换。字母开头的串会持续吸收字母与数字，直到边界。完整词素是 int 时才识别为关键字；integer 整体是一个标识符。',
      },
      {
        title: '最长匹配与规则优先级',
        body: '最长匹配负责确定词素的长度。完整词素同时符合关键字和标识符规则时，再用关键字表确定类别。这两件事有先后关系：不能遇到 int 前缀就急着截断。',
      },
      {
        title: 'Token 保留了什么？',
        body: '每个 Token 带有类别、原始词素和源码区间。空白与单行注释不进入 Token 串；它们仍影响源码位置。EOF 用来告诉后续解析器，输入已结束。',
      },
    ],
    misconception: '到达接受状态不代表立即发射 Token；后面的字符可能让当前词继续增长。',
    limit: '手写确定性扫描器，仅支持本实验语言；未实现正则表达式 → NFA → DFA 的自动构造。',
    challenge: '不看说明，解释 integer 为什么不是 int + eger。再说明关键字表在什么时候参与判断。',
    answer:
      '先按标识符规则读取完整的 integer，再查关键字表。最长匹配得到的词素不是 int，因此类别是 identifier。',
    quiz: {
      question: 'int total = 12; 中，不计 EOF，一共有几个 Token？',
      options: ['4 个', '5 个', '6 个'],
      correct: 1,
      explain: 'int、total、=、12、;，共 5 个。数字的字符数不会增加 Token 的数量。',
    },
  },
  {
    id: 'parse',
    number: '02',
    title: '语法分析',
    english: 'Syntax analysis',
    question: '为什么乘法会长在树的更深处？',
    intro: '跟随递归下降解析器，把 Token 组装成抽象语法树。改动括号和减号，比较优先级与结合性。',
    chapter: '03',
    minutes: 12,
    icon: '⑂',
    color: 'blue',
    note: [
      {
        title: '文法决定树的结构',
        body: '加减层调用乘除层，乘除层再读取一元运算和基本表达式。因此 2 + 3 * 4 中，乘法子树先被构建，并成为加法的右孩子。括号则重新进入完整的表达式解析。',
      },
      {
        title: '循环保留左结合',
        body: '加减层先取左项，再循环读取运算符和右项，每次把已有子树作为新节点的左孩子。因此 10 - 3 - 2 的树表示 (10 - 3) - 2，而不是 10 - (3 - 2)。',
      },
      {
        title: 'AST 省略了语法外壳',
        body: '括号与分号参与解析，却通常不成为独立的 AST 节点。运算顺序已经编码在树的连接关系里。本实验展示最终树，并用回放高亮当时刚构造的节点。',
      },
    ],
    misconception: '语法正确只说明结构符合文法；引用不存在的变量也可能成功构建 AST。',
    limit: '预测式递归下降，固定的表达式文法；没有通用 LL/LR 表生成、错误恢复与多错误报告。',
    challenge: '分别画出 10 - 3 - 2 和 10 - (3 - 2) 的树，解释哪个减号在根部。',
    answer:
      '前者最后一个减号在根部，左孩子为 10 - 3；后者第一个减号在根部，右孩子为 3 - 2。两者分别得到 5 与 9。',
    quiz: {
      question: '2 + 3 * 4 对应表达式子树的根节点是什么？',
      options: ['+', '*', '2'],
      correct: 0,
      explain: '乘法先成为子树，再被加法引用。树根的操作最后执行。',
    },
  },
  {
    id: 'semantic',
    number: '03',
    title: '语义分析',
    english: 'Semantic analysis',
    question: '同一个名字，指向同一个变量吗？',
    intro: '进入和退出语句块，追踪符号表与引用绑定。让一段语法正确的代码，接受作用域与类型的检查。',
    chapter: '04',
    minutes: 10,
    icon: '{ }',
    color: 'purple',
    note: [
      {
        title: '从内向外查找声明',
        body: '每个语句块创建一个词法作用域。引用变量时从当前作用域向外查找，首次找到的声明就是绑定目标。内部同名变量可以遮蔽外部变量；离开语句块后，它便不再可见。',
      },
      {
        title: '名称相同，身份不同',
        body: '每个声明获得独立的内部名称，例如 v0_x 与 v1_x。后续生成中间代码时使用内部名称，避免把两个作用域中的 x 混在一起。同层重复声明会被拒绝。',
      },
      {
        title: '把类型沿树向上传递',
        body: '字面量直接带有 int 或 bool 类型；变量类型来自符号表；算术节点要求两个操作数都是 int。声明与赋值再比较目标类型和表达式类型。本语言不进行隐式类型转换。',
      },
    ],
    misconception:
      '是否允许内部变量遮蔽外部变量，由具体语言规定。本实验允许遮蔽，不能把规则直接当成 Java 的规则。',
    limit:
      '只有 int、bool 和块作用域；初始化表达式先求值，随后引入新绑定。未实现函数、闭包、重载和泛型。',
    challenge: '用遮蔽预设说明两次 print(x) 的查找路径。把内部声明改成 x = 20; 后，又会发生什么？',
    answer:
      '内部声明时绑定独立，先输出 20，退出后输出外层的 10。改为赋值会找到外层的 x 并修改它，两次都输出 20。',
    quiz: {
      question: 'int count = true; 最早应该在哪一阶段被拒绝？',
      options: ['词法分析', '语法分析', '语义分析'],
      correct: 2,
      explain: 'Token 和声明结构都合法，但 int 与 bool 不兼容；这是类型检查的工作。',
    },
  },
  {
    id: 'ir',
    number: '04',
    title: '中间代码',
    english: 'Intermediate representation',
    question: '一棵树，如何变成线性的指令？',
    intro: '后序遍历表达式，把每个运算拆成一条三地址指令。高亮源码与对应节点，追踪临时变量的来源。',
    chapter: '06',
    minutes: 8,
    icon: 't₀',
    color: 'orange',
    note: [
      {
        title: '先处理孩子，再产生当前指令',
        body: '对二元表达式，先生成左、右子表达式的代码，再用一个临时变量保存本次运算结果。例如乘法的结果 t0 会成为随后加法的一项输入。',
      },
      {
        title: '三地址不是三条指令',
        body: '一条典型的三地址指令具有一个写入位置和最多两个输入，如 t1 = v0_x + t0。声明和赋值产生复制指令，print 则是可观察的输出操作。',
      },
      {
        title: 'IR 是编译阶段之间的接口',
        body: '表达式树适合表达结构，线性指令便于逐条执行和分析。真实编译器可能使用多种抽象层次的 IR；这里采用单一、无分支的教学格式，便于看到完整转换。',
      },
    ],
    misconception: 'IR 没有统一的唯一格式；这里的文本不是 LLVM IR，也不是某种真实 CPU 的汇编。',
    limit: '直线代码与词法块，没有控制流图、SSA、φ 节点、寄存器分配或机器码生成。',
    challenge: '为 int result = 2 + 3 * 4; 写出未优化的三地址代码，解释 t0 为什么先于 t1 出现。',
    answer: 't0 = 3 * 4；t1 = 2 + t0；v0_result = t1。乘法是加法的依赖，必须先得到它的结果。',
    quiz: {
      question: '为什么内部变量名要包含声明的独立编号？',
      options: ['让变量都变成常量', '区别不同作用域中的同名声明', '让所有指令更短'],
      correct: 1,
      explain: '作用域退出后，IR 仍需准确表达每次引用原本绑定的声明。',
    },
  },
  {
    id: 'optimize',
    number: '05',
    title: '代码优化',
    english: 'Optimization passes',
    question: '少算几步，结果还能一样吗？',
    intro: '独立开关常量传播、常量折叠与无用写入清理。比较前后指令，并实际执行两版程序验证输出。',
    chapter: '07',
    minutes: 12,
    icon: '↦',
    color: 'rose',
    note: [
      {
        title: '传播与折叠相互配合',
        body: '传播把已知常量替换到使用位置；折叠把合法的常量算术提前算出。一次顺序扫描中，前面的变换可能让后续语句继续简化。可变变量被重新赋值时，必须更新或清除旧信息。',
      },
      {
        title: '从可观察行为反向看',
        body: '清理从 print 和可能报错的算术操作出发，逆向追踪它们需要哪些值。若一个复制操作写入的值以后不再使用，就可以删除；如果它的输入仍被需要，则保留依赖。',
      },
      {
        title: '异常也是程序行为',
        body: '未被使用的除法也可能除零；算术还可能超出安全整数范围。本实现保守保留未折叠的算术操作，避免清理时吞掉错误。两版执行结果的对照是检查线索，并不是一般性的正确性证明。',
      },
    ],
    misconception: '指令更少并不等于实测运行更快。本页统计指令条数，没有进行 CPU 性能测试。',
    limit:
      '仅做直线代码的局部优化；整数采用 JS 安全整数，除法向零取整。没有浮点重排、CSE 或循环优化。',
    challenge:
      '关闭常量传播后，为什么有些折叠消失了？再试试 int unused = 1 / 0;，解释它为何必须保留。',
    answer:
      '未传播的变量引用不是字面量，折叠无法直接求值。除零会产生可观察错误，即使 unused 没有被读取，也不能删除这次运算。',
    quiz: {
      question: '已知 x = 2 后又执行 x = 5，下一次 print(x) 应传播什么？',
      options: ['2', '5', '始终不能传播'],
      correct: 1,
      explain: '顺序扫描必须更新 x 的常量信息，不能使用过期的 2。',
    },
  },
  {
    id: 'vm',
    number: '06',
    title: '栈式虚拟机',
    english: 'Stack virtual machine',
    question: '没有寄存器，也能执行程序吗？',
    intro: '把三地址代码降为教学字节码，观察程序计数器、操作数栈、局部变量表和输出如何一起变化。',
    chapter: '06',
    minutes: 10,
    icon: '▤',
    color: 'green',
    note: [
      {
        title: '隐式操作数的位置',
        body: 'PUSH 把常量压栈，LOAD 读取局部变量并压栈。算术指令从栈顶取出两个操作数，计算后把结果压回去；STORE 再把栈顶写入局部变量。',
      },
      {
        title: '弹出顺序影响减法与除法',
        body: '先压左项，再压右项，意味着右项在栈顶。执行 SUB 或 DIV 时必须先弹出右项，再弹出左项。颠倒这个顺序会改变非交换运算的结果。',
      },
      {
        title: '程序状态不止一个栈',
        body: 'PC 标明下一条要执行的指令。局部变量表保存已经 STORE 的值，print 输出也构成状态的一部分。回放展示每条指令执行后的快照，因此可以准确回退到之前的状态。',
      },
    ],
    misconception: '这里的操作数栈不是函数调用栈；本实验还没有函数调用、栈帧或递归。',
    limit: '自定义教学字节码，由浏览器内解释器执行；不是 CPython、JVM 字节码，也没有真实机器码。',
    challenge: '只看栈状态，手动执行 PUSH 10、PUSH 3、SUB，解释为什么最后留下 7。',
    answer:
      '栈底是 10，栈顶是 3。SUB 依次取出 right = 3、left = 10，计算 left - right，再把 7 压栈。',
    quiz: {
      question: '执行 STORE v0_x 后，操作数栈通常会怎样变化？',
      options: ['多一个元素', '少一个元素', '完全不变'],
      correct: 1,
      explain: 'STORE 弹出栈顶的值，把它存进指定局部变量；栈高减一。',
    },
  },
];
export const presets = [
  {
    id: 'precedence',
    label: '优先级 · 先乘后加',
    code: 'int result = 2 + 3 * 4;\nprint(result);',
    prediction: '先预测：输出是 14，还是 20？',
  },
  {
    id: 'parentheses',
    label: '括号 · 改写运算顺序',
    code: 'int result = (2 + 3) * 4;\nprint(result);',
    prediction: '只加了一对括号，AST 的根会变化吗？',
  },
  {
    id: 'associativity',
    label: '结合性 · 连续减法',
    code: 'int result = 10 - 3 - 2;\nprint(result);',
    prediction: '先预测：是 (10 - 3) - 2，还是 10 - (3 - 2)？',
  },
  {
    id: 'keyword',
    label: '最长匹配 · int 与 integer',
    code: 'int integer = 12;\nprint(integer);',
    prediction: 'integer 会成为一个 Token，还是两个？',
  },
  {
    id: 'shadow',
    label: '作用域 · 同名变量',
    code: 'int x = 10;\n{\n  int x = 20;\n  print(x);\n}\nprint(x);',
    prediction: '两次输出是否一样？内部的 x 会修改外层吗？',
  },
  {
    id: 'mutable',
    label: '常量传播 · 重新赋值',
    code: 'int x = 2;\nx = 5;\nint y = x * 3;\nprint(y);',
    prediction: 'x 被修改后，优化器会使用哪个常量？',
  },
  {
    id: 'type-error',
    label: '反例 · 类型不匹配',
    code: 'int count = true;\nprint(count);',
    prediction: '哪一个阶段会首先发现错误？',
  },
  {
    id: 'undefined',
    label: '反例 · 变量未声明',
    code: 'int result = missing + 1;\nprint(result);',
    prediction: '语法树能成功构建吗？',
  },
  {
    id: 'syntax-error',
    label: '反例 · 缺少分号',
    code: 'int result = 2 + 3\nprint(result);',
    prediction: '解析器在哪个 Token 处发现了问题？',
  },
  {
    id: 'trap',
    label: '优化边界 · 无用的除零',
    code: 'int unused = 1 / 0;\nprint(42);',
    prediction: '变量未被使用，除零指令能直接删掉吗？',
  },
];
export const defaultOptions = { fold: true, propagate: true, dead: true };
