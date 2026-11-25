import type { Lesson } from './lessons';

export const closureLesson: Lesson = {
  id: 'closure',
  number: '25',
  title: '闭包与环境捕获',
  english: 'Closures & captured environments',
  question: '外层函数明明已经返回了，它的局部变量为什么还活着？',
  intro:
    '对应第 05、39 讲：编写嵌套函数与高阶函数，先做静态自由变量分析，看哪些变量可以留在栈帧、哪些必须装箱逃逸到堆上 Cell（Upvalue），再逐步观察栈帧弹出、闭包对象持有环境指针以及共享可变状态。',
  chapter: '39',
  minutes: 20,
  icon: 'λ',
  color: 'purple',
  walkthrough: [
    {
      title: '如果所有局部变量都放栈上，会出什么问题？',
      body: '在实验 16（函数与调用栈）里，函数返回时它的整张栈帧会被立刻弹出销毁。但在支持一等函数的语言里，makeCounter(10) 返回了内层函数 inc，而 inc 里用到了外层的 count。如果 count 还在 makeCounter 的栈帧上，返回之后再调 c1(1) 就会读到已经被回收的垃圾内存！',
      example: 'fn makeCounter(start) {\n  let count = start;   // 被内层 inc 捕获！\n  fn inc(step) { count = count + step; return count; }\n  return inc;\n}',
      exampleLanguage: 'c',
    },
    {
      title: '静态捕获分析：区分“栈局部”和“堆上 Cell”',
      body: '编译器在编译期就能扫一遍语法树：任何被内层函数读写的变量（自由变量 / Free Variable），都标为“需要捕获”，运行时不直接放栈帧里，而是搬到堆上的独立格子（Cell / Upvalue）；没被捕获的普通局部变量（如 step、临时变量）依然老老实实待在栈上。',
    },
    {
      title: '闭包 = 代码指针 + 环境指针',
      body: '函数代码本身只有一份，但每次执行 makeCounter(...) 都会在堆上分配一套新的 Cell，并创建一个闭包对象 Closure { code: inc, env: { count -> Cell#1 } }。因此 c1 = makeCounter(10) 和 c2 = makeCounter(100) 共用同一段 inc 代码，却各管各的 Cell，互不干扰。',
    },
    {
      title: '同一个作用域创建两个闭包，会共享同一个 Cell',
      body: '因为捕获的是指向堆上 Cell 的指针而不是当时的值拷贝，当同一个外层调用里定义两个内层函数（如 add 和 peek）都访问 count 时，它们指向的是同一个 Cell#id——一个改完，另一个立刻看见新值！',
    },
    {
      title: '闭包和逃逸分析、垃圾收集的关系',
      body: '这就是第 05 讲和第 39 讲提到的“闭包让栈变量逃逸到堆”：这些 Cell 离开创建它们的栈帧后仍然存活，直到再也没有闭包对象引用它们，才由实验 20 的垃圾收集器回收。',
    },
  ],
  note: [
    {
      title: '闭包捕获的是变量位置（Cell），不是创建瞬间的快照',
      body: '原书第 39 讲指出，纯函数要求引用透明且无副作用，而闭包引用了词法作用域里的自由变量，因而是纯函数的对立面。在支持可变绑定的词法作用域语言（JS、Python、Lua、Go）中，闭包共享堆上的 Cell/Upvalue 引用，修改捕获变量对同一环境下的所有闭包都可见，直到不再被引用才交由 GC 回收。',
    },
    {
      title: '只有被内层引用的变量才需要堆装箱',
      body: '编译器通过静态自由变量分析，只把真正被捕获的变量搬到堆上，未捕获的参数和局部变量仍保留在零开销的调用栈帧里。',
    },
    {
      title: '扁平闭包环境可直接 O(1) 访问',
      body: '本实验采用类似 Lua/V8/CPython 的扁平捕获表（Closure 直接持有它用到的 Cell 列表），调用时无需层层向上翻找整条外层作用域链，并与独立的链式词法解释器对照结果。',
    },
  ],
  misconception:
    '“外层函数每调用一次，就会把内层函数的机器码重新编译一份”是误解：代码指针始终共享同一份函数体，每次调用动态创建的只是很小的闭包对象和被捕获变量的堆上 Cell。',
  limit:
    '教学函数式方言聚焦一等函数、高阶函数与闭包的自由变量装箱，支持嵌套 fn、let、赋值、整数运算、if/else、while、return、print，限制 2000 字符、32 层调用栈与 2000 步执行。不实现循环每次迭代独立词法绑定、闭包内联，也未涵盖原书第 39 讲后半的函数复合类型（参数逆变/返回协变）检查、延迟求值（换名/按需调用）与尾递归转循环优化。',
  challenge:
    '运行“两个独立计数器”预设，找出 makeCounter 返回时栈帧和堆上 Cell 分别发生了什么。再切换到“共享同一个捕获 Cell”，解释为什么 inc 和 peek 看到的是同一个变化中的值。',
  answer:
    '调用 makeCounter(10) 时，count 被装箱成堆上 Cell#1，inc 打包成 Closure#1 指向 Cell#1；makeCounter 返回后其栈帧弹出，Cell#1 标为“创建栈帧已返回，仍存活”。第二次调用 makeCounter(100) 分配了全新的 Cell#2 给 Closure#2，所以 c1 与 c2 互不影响。而在共享预设中，add 和 peek 在同一次外层执行里创建，捕获表指向同一个 Cell#1，add 修改 Cell#1 后 peek 读取的就是更新后的值。',
  quiz: {
    question: 'makeCounter(10) 和 makeCounter(100) 各自返回一个闭包 c1 和 c2。下面哪种说法正确？',
    options: [
      'c1 和 c2 共享同一个 count 变量，调用 c1 会改变 c2',
      'c1 和 c2 共享同一份 inc 函数代码，但各自持有一个指向不同堆上 Cell 的环境指针',
      'makeCounter 返回后 count 已经被销毁，调用 c1 只能读到初始常量 10',
    ],
    correct: 1,
    explain: '每次调用 makeCounter 都会为被捕获的 count 分配新的堆上 Cell 并打包进新的闭包对象；代码共享一份，环境各自独立。',
  },
};

export const closurePresets = [
  {
    id: 'cl-counters',
    label: '闭包 · 两个独立计数器（栈帧弹出后 Cell 仍存活）',
    code: 'fn makeCounter(start) {\n  let count = start;\n  fn inc(step) {\n    count = count + step;\n    return count;\n  }\n  return inc;\n}\n\nlet c1 = makeCounter(10);\nlet c2 = makeCounter(100);\nprint(c1(1));\nprint(c1(5));\nprint(c2(2));',
    prediction: 'makeCounter 返回后它的栈帧已经弹出了。c1 和 c2 为什么既没崩溃、又彼此互不干扰？',
  },
  {
    id: 'cl-shared-cell',
    label: '闭包 · 两个闭包共享同一个堆上 Cell',
    code: 'fn demo() {\n  let total = 0;\n  fn add(x) {\n    total = total + x;\n    return total;\n  }\n  fn read() {\n    return total;\n  }\n  print(add(4));\n  print(add(6));\n  print(read());\n  return 0;\n}\n\nlet ignored = demo();',
    prediction: 'add 修改 total 之后，另一个闭包 read 会看到 0 还是 10？它们指向同一个 Cell 吗？',
  },
  {
    id: 'cl-higher-order',
    label: '高阶函数 · 把闭包当作实参传递',
    code: 'fn makeAdder(k) {\n  fn add(x) {\n    return x + k;\n  }\n  return add;\n}\n\nfn applyTwice(f, v) {\n  return f(f(v));\n}\n\nlet plus7 = makeAdder(7);\nprint(applyTwice(plus7, 10));',
    prediction: 'plus7 传进 applyTwice 时，它的捕获变量 k 跟着一起带进去了吗？输出是多少？',
  },
  {
    id: 'cl-nested-chain',
    label: '多层嵌套 · 跨两层作用域传递捕获',
    code: 'fn outer(a) {\n  fn mid(b) {\n    fn inner(c) {\n      return a + b + c;\n    }\n    return inner;\n  }\n  return mid;\n}\n\nlet m = outer(100);\nlet f = m(20);\nprint(f(3));',
    prediction: 'inner 用到了最外层的 a 和中间层的 b。中间的 mid 需要帮忙中转捕获 a 吗？',
  },
  {
    id: 'cl-no-capture',
    label: '对照 · 未被内层引用的变量留在栈上',
    code: 'fn compute(x) {\n  let temp = x * 2;\n  let offset = 5;\n  return temp + offset;\n}\n\nprint(compute(8));',
    prediction: '没有嵌套函数引用 temp 和 offset 时，堆上会分配任何 Cell 吗？',
  },
];
