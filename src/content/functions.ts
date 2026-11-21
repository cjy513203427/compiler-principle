import type { Lesson } from './lessons';

export const CALL_STACK_REFERENCE = 'https://www.cs.cornell.edu/courses/cs3410/2026sp/notes/asm-call.html';
export const CALL_FRAMES_REFERENCE = 'https://github.com/munificent/craftinginterpreters/blob/master/book/calls-and-functions.md';
export const functionsLesson: Lesson = {
  id: 'functions', number: '16', title: '函数与调用栈', english: 'Functions & call stack',
  question: '递归再进一次，旧的局部变量放在哪里？',
  intro: '从操作数栈继续，加入带类型的函数、按值传参与返回。跟随真实 CALL / RETURN，查看每次调用的栈帧、暂停位置和独立局部变量。',
  chapter: '06', minutes: 22, icon: '↳', color: 'green',
  walkthrough: [
    { title: '先区分两个栈', body: '实验 06 的操作数栈暂存一次表达式的中间值。函数调用还需要记住：谁正在执行、它的局部变量是什么、结束后回到哪里。调用栈（Call stack）按后进先出组织这些尚未返回的调用；本实验给每个栈帧再配一个独立操作数栈。' },
    { title: '先登记签名，再检查函数体', body: '定义写出返回类型、函数名和形参类型。编译器先收集全部签名，因此函数可以相互调用；随后检查参数数量、类型和返回值。函数体只查自己的词法作用域，不能读取调用者或顶层的局部变量。', example: 'int add(int a, int b) {\n  return a + b;\n}\nprint(add(3, 4));' },
    { title: '实参求值属于调用者', body: '本实验明确规定从左到右、各求值一次，再把得到的 int / bool 值绑定到新帧的形参。参数是值的副本：函数里修改形参，不会改变调用者的变量。这个求值顺序是教学语言的约定，不能据此推断 C 的实参求值顺序。' },
    { title: 'CALL 保存继续执行的位置', body: '调用者暂停在 CALL 后的下一条字节码。新帧保存返回位置，拥有独立局部变量表，从被调函数 PC 0 开始。页面中的 PC 是函数内部的字节码序号，与真实机器的内存地址不同。' },
    { title: '递归共享代码，每次调用各有一帧', body: 'fact(4) 和 fact(3) 使用相同的函数字节码，却有不同的帧编号、形参 n 和待完成乘法。观察调用者操作数栈里保留的 4、3，能够解释为什么递归返回时还要继续计算。', example: 'int fact(int n) {\n  if (n <= 1) { return 1; }\n  return n * fact(n - 1);\n}\nprint(fact(4));' },
    { title: 'RETURN 恢复调用者，异常暂停整条调用链', body: '返回表达式先算出一个值，随后当前帧出栈，该值压入调用者操作数栈，接着原来的 PC 执行。除零或溢出会停止程序，已发生的输出保留，调用链留在错误现场供检查；这里没有异常捕获或展开。没有副作用分析时，也不把旧优化器应用到函数调用上。' },
  ],
  note: [
    { title: '一段函数代码，多份活动状态', body: '栈帧（Stack frame / Activation record）对应一次尚未结束的调用，而非对应一个函数定义。递归时同一个形参槽位的名字会出现多次，实际值分别保存在不同帧中。' },
    { title: '静态作用域与动态调用链分开看', body: '变量名在编译时绑定到本函数的声明槽位；运行时，槽位放进当前帧。同名块变量也有不同槽位。调用名在独立函数表中解析，不受局部变量同名影响。界面保留已分配槽位便于观察，但离开块后源码不能继续引用那个绑定。' },
    { title: '调用约定是明确的协议', body: '这里约定左到右求值、按值绑定、每帧独立操作数栈和单值返回。Cornell 讲义介绍真实 RISC-V 调用约定，作者实现介绍栈式 VM 的帧；本实验只借鉴概念，没有生成对应 ABI 或机器指令。' },
  ],
  misconception: '“递归第二次调用会覆盖第一次的 n”把函数代码与活动状态混在了一起。代码可以共用；每次 CALL 都创建独立帧，旧 n 和待完成的运算仍在暂停的调用者里。操作数栈里压入一个值，也不等于创建一个调用帧。',
  limit: '专用函数方言，复用基础扫描器和安全整数运算；直接生成函数字节码，不接入现有 CFG、SSA、优化器或汇编模板。支持顶层 int / bool 函数、至多 8 个形参、单值 return、递归与相互递归、块作用域、if / while 和 print。顶层语句自动放入独立入口帧，顶层变量不是全局变量。函数须有静态可证明的完整返回路径：return、顺序后续 return 或 if / else 两边返回；while 一律不算保证返回。没有 void、原型、重载、闭包、引用参数、异常处理或尾调用优化。最多 2000 字符、24 个函数、32 个活动帧（含顶层）与 2000 条执行指令；上限只表示暂停。保留前 400 个状态与最终现场，省略时明确提示。',
  challenge: '选择递归阶乘，停在 fact(2) 入栈后。检查 fact(4)、fact(3) 与 fact(2) 的 n 及操作数栈，再回放到最终结果；把输入改成 fact(0)，解释调用次数和结果怎样变化。',
  answer: 'fact(4)、fact(3)、fact(2) 的 n 分别为 4、3、2；暂停的前两帧还保留着等待乘法的左操作数。fact(4) 共调用 4 次 fact，最大深度含顶层为 5，结果 24；fact(0) 直接走基例，只调用一次，深度 2，结果 1。',
  quiz: { question: '执行 return 后，返回值放到哪里，调用者从哪里继续？',
    options: ['覆盖所有调用层同名变量，从函数入口继续', '压入调用者的操作数栈，从 CALL 后的下一条指令继续', '再创建一个新栈帧，从顶层重新开始'], correct: 1,
    explain: '被调帧退出，调用者的局部变量和中间值仍然保留；返回值成为原表达式的一个操作数，继续之前暂停的计算。' },
};
export const functionPresets = [
  { id: 'call-add', label: '调用 · 参数与返回位置', code: 'int add(int a, int b) {\n  return a + b;\n}\nint x = 3;\nprint(add(x, 4));\nprint(x);', prediction: 'add 的形参保存什么？返回 7 之后，顶层 x 会改变吗？' },
  { id: 'call-fact', label: '递归 · 同一代码，多份 n', code: 'int fact(int n) {\n  if (n <= 1) { return 1; }\n  return n * fact(n - 1);\n}\nprint(fact(4));', prediction: '最深处有几帧？递归返回之前，4 和 3 存在哪里？' },
  { id: 'call-value', label: '传参 · 修改副本', code: 'int bump(int x) {\n  x = x + 1;\n  return x;\n}\nint x = 4;\nprint(bump(x));\nprint(x);', prediction: '两个 print 会得到 5、5，还是 5、4？请对照两帧的局部变量。' },
  { id: 'call-order', label: '嵌套调用 · 从左到右求值', code: 'int mark(int n) {\n  print(n);\n  return n;\n}\nint sub(int a, int b) {\n  return a - b;\n}\nprint(sub(mark(7), mark(2)));', prediction: 'sub 入栈之前，会先后出现哪些输出？' },
  { id: 'call-mutual', label: '相互递归 · bool 返回值', code: 'bool even(int n) {\n  if (n == 0) { return true; }\n  return odd(n - 1);\n}\nbool odd(int n) {\n  if (n == 0) { return false; }\n  return even(n - 1);\n}\nprint(even(6));', prediction: 'even 在 odd 定义之前调用它，为什么类型检查仍能完成？' },
  { id: 'call-loop', label: '局部循环 · 最后返回', code: 'int sum(int n) {\n  int total = 0;\n  while (n > 0) {\n    total = total + n;\n    n = n - 1;\n  }\n  return total;\n}\nprint(sum(4));', prediction: '循环多跑几轮，会创建更多调用帧吗？' },
  { id: 'call-trap', label: '异常 · 保留已发生的输出', code: 'int fail(int n) {\n  print(n);\n  return 10 / (n - n);\n}\nprint(1);\nprint(fail(3));\nprint(9);', prediction: '除零前已有的 1 和 3 会保留吗？9 会执行吗？' },
  { id: 'call-depth', label: '上限 · 没有递归基例', code: 'int down(int n) {\n  return down(n + 1);\n}\nprint(down(0));', prediction: '达到 32 帧只说明本次暂停，是否能据此证明任意程序不终止？' },
  { id: 'call-missing', label: '检查 · 缺少返回路径', code: 'int choose(bool yes) {\n  if (yes) { return 7; }\n}\nprint(choose(true));', prediction: '这次实参是 true，编译器为什么仍要求覆盖 false 路径？' },
  { id: 'call-scope', label: '检查 · 不能读取调用者变量', code: 'int read() {\n  return x;\n}\nint x = 9;\nprint(read());', prediction: '调用链上有 x，是否意味着 read 的词法作用域中也有 x？' },
];
