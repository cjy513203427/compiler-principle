import type { Lesson } from './lessons';

export const escapeLesson: Lesson = {
  id: 'escape',
  number: '23',
  title: '内联与逃逸分析',
  english: 'Inlining & escape analysis (SROA)',
  question: '明明写了 new，编译器怎么敢完全不在堆上分配？',
  intro:
    '对应第 07、15 讲：用带 struct 和 new 的教学语言，观察方法内联如何打破函数边界，逃逸分析如何区分 NoEscape / ArgEscape / GlobalEscape（含字段传递逃逸），以及标量替换（SROA）如何把堆分配彻底抹掉。',
  chapter: '15',
  minutes: 22,
  icon: '⤢',
  color: 'blue',
  walkthrough: [
    {
      title: '为什么内联总是逃逸分析的“前置开关”？',
      body: '看工厂函数 Point makePoint(int a, int b) { return new Point(a, b); }。单看 makePoint 自己，它把对象 return 给了调用者，所以必须判为 GlobalEscape（逃出函数）。但一旦编译器把 makePoint 内联进调用者，return 消失了，对象生命周期完全留在调用者内部，瞬间变成 NoEscape！',
      example: 'Point makePoint(int a, int b) { Point p = new Point(a, b); return p; }\n// 内联后：不再 return 对象，p 留在调用者循环内部',
      exampleLanguage: 'c',
    },
    {
      title: '三种逃逸级别：NoEscape、ArgEscape、GlobalEscape',
      body: '逃逸分析追踪每个 new 创建的对象会被谁拿到：只留在当前函数里就是 NoEscape；传给了没法内联的函数（如递归函数）是 ArgEscape；通过 return 返回或 publish(...) 存进全局外部区，就是 GlobalEscape。',
    },
    {
      title: '逃逸会沿字段“传染”',
      body: '即使你没有直接 publish(p)，只要把 p 放进另一个结构体 b = new Box(p) 并执行 publish(b)，外部代码就能通过 b.p 摸到 p。因此逃逸分析必须沿对象字段边迭代传播：容器逃逸，装在里面的子对象也跟着逃逸。',
    },
    {
      title: '标量替换（SROA）：把对象彻底拆成几个局部变量',
      body: '在实验 07 讲到“化整为零（SROA）”。一旦确认 Point pt 未逃逸且不存在跨分支多对象别名，编译器干脆删掉 new Point(...)，改用两个普通标量 pt$x 和 pt$y！循环 5 次原本要堆分配 5 个对象，优化后变成 0 次堆分配。',
      example: '// 优化前：Point pt = new Point(i, i + 1); total = total + pt.x + pt.y;\n// SROA后：int pt$x = i; int pt$y = i + 1; total = total + pt$x + pt$y;',
      exampleLanguage: 'c',
    },
    {
      title: '不是所有函数都能内联，也不是所有对象都能拆',
      body: '递归函数会无限展开，过大的函数会导致代码膨胀，所以编译器会设预算拒绝内联；同样，如果一个变量在 if/else 两条分支指向不同的 new 对象，或对象逃逸了，就必须保守保留堆分配。',
    },
  ],
  note: [
    {
      title: '内联放大后续所有优化的收益',
      body: '内联不仅省掉一次函数调用的压栈/跳转开销，更重要的是把跨函数的边界打通，让逃逸分析、常量传播、死代码消除都能一起生效。这也是 Graal、V8 TurboFan 等 JIT 编译器把内联放在最前面的原因。',
    },
    {
      title: '逃逸分析依赖连接图与不动点传播',
      body: '分析器记录“变量指向哪些分配点”和“对象字段指向哪些分配点”，再从 return / publish / 未内联实参出发沿字段边把逃逸状态传播到不动点。',
    },
    {
      title: '零堆分配减轻 GC 压力',
      body: '和实验 20（垃圾收集）连起来看：循环里每轮 new 出的短命对象如果被 SROA 消除，不仅省下分配时间，连后续垃圾收集的工作量也一并消失了。',
    },
  ],
  misconception:
    '“只要没有 return 或存入全局变量，函数里的 new 就一定能做标量替换”并不完全正确：第一，把它存入一个逃逸对象的字段会触发传递逃逸；第二，如果同一引用变量在不同分支指向不同的分配点（产生别名歧义），简单标量替换无法确定读哪个标量，需要保守保留或做更复杂的部分逃逸分析。',
  limit:
    '教学方言支持 struct、int、new、字段读写、if/else、while、函数与 publish(...) 全局槽，限制 2000 字符、12 个结构体、16 个函数与 2000 步执行。仅对非递归、单尾出口且不超过 10 条语句的函数做内联（最大深度 3）；SROA 仅对无别名歧义的扁平整数结构体生效，不模拟 Graal 的部分逃逸分析（PEA）或锁消除。',
  challenge:
    '先看“内联解锁零堆分配”预设，比较内联前后的逃逸状态表，说明为什么 makePoint 里的 new Point 从 GlobalEscape 变成了 NoEscape。再把 publish(pt) 加进循环，观察堆分配次数如何变化。',
  answer:
    '未内联时，makePoint 以 return p 结束，p 离开函数栈帧，因此必须判定为 GlobalEscape。把 makePoint 内联进 sumDist 后，Point 的创建和字段读取都在同一个循环内完成、不再对外返回，逃逸分析判定为 NoEscape，随后 SROA 把它拆成两个整数标量，堆分配从 5 次降为 0 次。加入 publish(pt) 后对象变为 GlobalEscape，SROA 自动放弃，5 次堆分配全部保留。',
  quiz: {
    question: '在 Graal 等 JIT 编译器中，为什么要先做方法内联，再做逃逸分析和标量替换？',
    options: [
      '因为不内联就无法解析结构体语法',
      '因为内联会消除 return 和参数传递边界，让原本跨函数逃逸的短命对象变为局部未逃逸对象',
      '因为内联会自动把所有堆对象改成全局变量',
    ],
    correct: 1,
    explain: '工厂方法或 getter/setter 往往把对象作为返回值或参数在函数间传递；内联把调用者和被调用者合进同一个编译单元后，对象的完整生命周期变得可见，逃逸分析才能安全确认它未逃逸。',
  },
};

export const escapePresets = [
  {
    id: 'esc-inline-sroa',
    label: '内联与逃逸 · 内联解锁零堆分配（工厂函数）',
    code: 'struct Point { int x; int y; }\n\nPoint makePoint(int a, int b) {\n  Point p = new Point(a, b);\n  return p;\n}\n\nint sumDist(int n) {\n  int i = 0;\n  int total = 0;\n  while (i < n) {\n    Point pt = makePoint(i, i + 1);\n    total = total + pt.x + pt.y;\n    i = i + 1;\n  }\n  return total;\n}\n\nprint(sumDist(5));',
    prediction: 'makePoint 返回了 new Point。内联前后，循环里的 5 次堆分配能变成 0 次吗？',
  },
  {
    id: 'esc-transitive',
    label: '逃逸传播 · 存入逃逸容器触发传递逃逸',
    code: 'struct Point { int x; int y; }\nstruct Box { Point item; }\n\nPoint p = new Point(3, 4);\nBox b = new Box(p);\npublish(b);\nprint(p.x + p.y);',
    prediction: '程序只调用了 publish(b)，没有直接 publish(p)。p 是未逃逸，还是跟着逃逸？',
  },
  {
    id: 'esc-global-vs-local',
    label: '对照 · 一个未逃逸，一个逃逸到全局',
    code: 'struct Pair { int a; int b; }\n\nPair temp = new Pair(10, 20);\nPair shared = new Pair(3, 7);\npublish(shared);\nprint(temp.a + temp.b + shared.a);',
    prediction: '两个 new Pair 中，哪一个会被标量替换消除，哪一个必须留在堆上？',
  },
  {
    id: 'esc-recursive-arg',
    label: '边界 · 递归函数不能内联 → ArgEscape',
    code: 'struct Counter { int step; }\n\nint countdown(int n, Counter c) {\n  if (n <= 0) {\n    return 0;\n  } else {\n    return c.step + countdown(n - 1, c);\n  }\n}\n\nCounter stepObj = new Counter(2);\nprint(countdown(4, stepObj));',
    prediction: 'countdown 是递归函数无法内联。传给它的 stepObj 会被判成什么逃逸级别？',
  },
  {
    id: 'esc-alias-merge',
    label: '边界 · 跨分支多对象别名阻止简单 SROA',
    code: 'struct Box { int v; }\n\nint flag = 1;\nBox a = new Box(10);\nBox b = new Box(20);\nBox chosen = a;\nif (flag == 1) {\n  chosen = a;\n} else {\n  chosen = b;\n}\nprint(chosen.v);',
    prediction: 'a 和 b 都没有逃逸，为什么 chosen 指向两个不同对象时，简单 SROA 选择保守保留？',
  },
];
