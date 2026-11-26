import type { Lesson } from './lessons';

export const INTERPROC_REFERENCE = 'https://www.cs.cornell.edu/courses/cs6120/2025fa/lesson/9/';
export const IPSCCP_REFERENCE = 'https://llvm.org/doxygen/IPO_2SCCP_8cpp_source.html';

export const interprocLesson: Lesson = {
  id: 'interproc',
  number: '23',
  title: '跨过程分析与内联',
  english: 'Interprocedural analysis & inlining',
  question: '调用一个函数之前，编译器能知道它会做什么吗？',
  intro:
    '把实验 16 的函数程序降低成带 call 的三地址 IR，建立调用图，自底向上总结每个函数会不会输出、报错或停不下来；再跨函数传播常量、只删除纯函数的调用、内联小函数。main 里的调用全部展开后，就能交给实验 05 的优化器和栈式 VM。每个版本都实际执行，与实验 16 的 VM 对照。',
  chapter: '15',
  minutes: 26,
  icon: '⇲',
  color: 'green',
  walkthrough: [
    {
      title: '为什么旧优化器不碰 CALL',
      body: '实验 05 的优化器会删除“结果没人用的计算”，前提是删掉不改变输出和报错。一次调用却可能 print、可能除零、也可能无限递归。不知道这些，就只能把调用原样保留；如果把它当成普通表达式删掉，输出和错误就会变。所以第一步不是优化，而是先弄清每个函数可能产生的效果。',
      example: 'int log(int n) { print(n); return 0; }\nint k = log(5);   // k 没人用，但 print 5 必须发生',
      exampleLanguage: 'c',
    },
    {
      title: '先把函数字节码降成三地址 IR',
      body: '实验 16 直接生成栈式字节码。这里用一个“符号栈”重新读一遍：PUSH 3 记下常量 3，LOAD x 记下变量 x，BINARY 时弹出两个记录、生成 t0 = x + 3，CALL 时弹出实参、生成 t1 = call f(x, 3)。每个函数得到自己的三地址 IR，形参和局部变量都是本函数的名字。',
      example: 'LOAD a / PUSH 10 / BINARY < / BR_FALSE 6\n→ t0 = a#0 < 10\n  ifFalse t0 goto L6',
      exampleLanguage: 'text',
    },
    {
      title: '调用图与自底向上的效果摘要',
      body: '调用图里每个函数是一个点，每条调用是一条边。按强连通分量（Tarjan 算法）分组：同一组里的函数互相可达，就是递归。从叶子开始往上总结：函数里有 print 就“会输出”；有加减乘就“可能报错”（溢出），除法的除数不是非零常量也算（除零）；有循环或在递归环里就“可能不终止”；调用别的函数，就继承它的全部效果。三样都没有，才叫纯函数。这门语言没有全局变量和引用参数，调用不能读写调用者的局部变量——内存效果由语言本身保证为空。',
      example: 'isZero(x) = x == 0      → 纯：只有比较\nadd(a, b) = a + b       → 可能溢出\nfact(n)                 → 递归，可能达到深度上限',
      exampleLanguage: 'text',
    },
    {
      title: '跨过程常量传播：在所有调用点合并实参',
      body: '对每个形参，把所有已执行调用点传进来的值合并：处处都是 3 就是常量 3，出现两个不同值就是 ⊤。函数内部再做条件常量传播，只走条件允许的分支，把所有 return 合并成返回值。原书第 15 讲的 atLeastTen(3)：a = 3，a < 10 恒真，else 分支不可达，返回值恒为 10。',
      example: 'int atLeastTen(int a) {\n  if (a < 10) { return 10; }\n  return a;\n}\nprint(atLeastTen(3));   // 返回值 10，调用可以换成常量',
      exampleLanguage: 'c',
    },
    {
      title: '结果是常量，不等于调用可以删',
      body: '常量结果总可以传播给使用者：如果调用返回了，返回值一定是它。但调用本身只有在被调函数是纯函数时才能换成常量或删除。log(5) 总返回 0，k = log(5) + 1 可以直接写成 1，可 print 5 仍要发生，所以 call log(5) 留下。改写完以后再总结一次：add(3, 4) 被折叠成 return 7，加法消失，它就变成了纯函数。',
      example: 'call log(5)   // 保留：log 会输出；结果没人用，只丢掉结果\nprint 1       // log(5) + 1 已知是 1',
      exampleLanguage: 'text',
    },
    {
      title: '内联：把函数体展开到调用处',
      body: '对不递归、不超过 16 条指令的函数，把调用替换成函数体：形参变成“前缀.形参 = 实参”的复制，局部变量和标签加上前缀，return 变成“写结果 + 跳到结尾”。递归函数无法完全展开，留作 call。main 里的调用全部展开后，它正好是实验 04 的 IR 形状，可以交给实验 05 的优化器（传播、折叠、分支简化、清理）——这才算把函数接入了已有的优化链。',
      example: 'atLeastTen@1.a#0 = 20\natLeastTen@1.t0 = atLeastTen@1.a#0 < 10\nifFalse atLeastTen@1.t0 goto atLeastTen@1.L6\n…\n→ 实验 05 优化器：print 20',
      exampleLanguage: 'text',
    },
  ],
  note: [
    {
      title: '摘要是保守的',
      body: '“有加法就可能溢出”很粗，但它只会让编译器少优化，不会改错程序。精度靠后续改写提升：常量折叠掉的加法不再算作风险，所以本页把“总结 → 传播 → 改写”重复到不再变化（最多 4 轮）。',
    },
    {
      title: '内联用代码量换机会',
      body: '原书第 15 讲说，内联的条件是方法足够热、又不太大；内联把多个方法合成一个，让方法内的优化能跨过原来的边界。本页没有运行统计，只用固定的大小上限；同一个函数在每个调用点各展开一份，代码量会增加。',
    },
    {
      title: '每个版本都实际执行',
      body: '实验 16 的函数字节码 VM 是基线；降低后的 IR、跨过程改写后、内联后各用带栈帧的 IR 解释器执行，完全展开的 main 再走实验 05 优化器与栈式 VM。比较输出和错误；任一方达到步数或深度上限时不判定一致。',
    },
  ],
  misconception:
    '“调用的结果没人用，就可以把调用删掉”和“函数总返回同一个常量，就可以把调用换成常量”都只对纯函数成立。会输出、可能除零或溢出、可能不终止的函数，即使结果确定，调用也必须保留——优化可以传播结果，不能吞掉效果。',
  limit:
    '输入是实验 16 的函数方言，前端检查全部复用；由函数字节码经符号栈降低为三地址 IR。效果摘要只区分输出、可能报错（未折叠的加减乘，以及除数不是非零常量的除法；0 − x 除外）与可能不终止（循环或递归环），不区分具体错误类型，也不做上下文敏感分析。过程间常量传播在所有已执行调用点上合并实参，函数内做条件常量传播；变换包括常量替换与折叠、常量分支、不可达代码与未被调用函数的删除、纯函数调用的折叠或删除、无用纯写入清理，最多迭代 4 轮。内联只处理不递归、不超过 16 条指令的函数，按调用图自底向上展开，展开后的函数不超过 4000 条。完全展开的 main 交给实验 05 优化器（三项全开）与栈式 VM；仍有 call 时这一步跳过。IR 解释器与实验 16 VM 一样限制 32 帧和 2000 步，但计步单位不同；栈式 VM 也是 2000 条字节码。没有尾调用、过程克隆（按调用点特化成多份）、逃逸分析或基于运行统计的内联。',
  challenge:
    '运行“原书例子”，看 atLeastTen 在哪一步被证明总返回 10、调用在哪一步消失；再切到“两个调用点”，解释为什么跨过程常量传播得不到常量，而内联之后实验 05 的优化器却能把两个结果都算出来。',
  answer:
    '原书例子只有一个调用点传入 3，形参 a 合并后是常量 3；a < 10 恒真，else 分支不可达，所有 return 合并为 10。atLeastTen 只有比较、没有输出和循环，是纯函数，所以 call 直接换成 10。两个调用点分别传 3 和 20，a 合并成 ⊤，返回值也是 ⊤；内联后每个调用点各有一份函数体，形参复制是各自的常量，实验 05 的条件常量传播在每份里分别算出 10 和 20。',
  quiz: {
    question: '下面哪个函数的调用，在结果没人使用时可以安全删除？',
    options: [
      'int log(int n) { print(n); return n; }',
      'bool same(int a, int b) { return a == b; }',
      'int twice(int n) { return n * 2; }',
    ],
    correct: 1,
    explain:
      'same 只有比较：不输出、不会报错、没有循环或递归，一定会返回，是纯函数。log 会输出；twice 的乘法在 n 很大时会超出安全整数而报错，调用必须保留。除以非零常量则不同：商的绝对值不超过被除数，不会报错。',
  },
};

export const interprocPresets = [
  {
    id: 'ip-book',
    label: '跨过程 · 原书例子：atLeastTen(3)',
    code: 'int atLeastTen(int a) {\n  if (a < 10) {\n    return 10;\n  }\n  return a;\n}\nprint(atLeastTen(3));',
    prediction: 'a 只会是 3。哪个分支不可达？返回值能确定吗？这个调用最后还在不在？',
  },
  {
    id: 'ip-two-sites',
    label: '跨过程 · 两个调用点：传播失败，内联成功',
    code: 'int atLeastTen(int a) {\n  if (a < 10) {\n    return 10;\n  }\n  return a;\n}\nprint(atLeastTen(3));\nprint(atLeastTen(20));',
    prediction: '形参 a 合并了 3 和 20，会是什么？内联之后，实验 05 的优化器还能算出两个结果吗？',
  },
  {
    id: 'ip-effects',
    label: '效果 · 结果确定，调用却不能删',
    code: 'int log(int n) {\n  print(n);\n  return 0;\n}\nbool same(int a, int b) {\n  return a == b;\n}\nint k = log(5) + 1;\nprint(k);\nsame(1, 2);',
    prediction: 'log 总返回 0，same 的结果没人用。哪个调用可以删，哪个必须留下？',
  },
  {
    id: 'ip-specialize',
    label: '特化 · 一部分实参处处相同',
    code: 'int scale(int x, int factor) {\n  return x * factor;\n}\nprint(scale(3, 10));\nprint(scale(7, 10));',
    prediction: 'factor 在两个调用点都是 10，x 不同。函数体会被改写成什么？',
  },
  {
    id: 'ip-rounds',
    label: '迭代 · 改写后才变成纯函数',
    code: 'int pick(bool fast, int n) {\n  if (fast) {\n    return n;\n  }\n  int total = 0;\n  while (n > 0) {\n    total = total + n;\n    n = n - 1;\n  }\n  return total;\n}\nint never(int n) {\n  return n + 1;\n}\nprint(pick(true, 4));',
    prediction: 'pick 里有循环，一开始不是纯函数。fast 恒为 true 之后呢？never 会怎样？',
  },
  {
    id: 'ip-trap',
    label: '效果 · 结果没人用，除零仍要发生',
    code: 'int ratio(int a, int b) {\n  return a / b;\n}\nprint(1);\nint unused = ratio(8, 0);\nprint(2);',
    prediction: 'unused 从没被读取。能不能把 ratio(8, 0) 删掉？输出和错误应该是什么？',
  },
  {
    id: 'ip-recursion',
    label: '边界 · 递归不能完全展开',
    code: 'int fact(int n) {\n  if (n <= 1) {\n    return 1;\n  }\n  return n * fact(n - 1);\n}\nint square(int x) {\n  return x * x;\n}\nprint(square(fact(3)));',
    prediction: 'square 能内联吗？fact 呢？main 里还剩 call 时，能交给实验 05 的优化器吗？',
  },
];
