import type { Lesson } from './lessons';

export const genericsLesson: Lesson = {
  id: 'generics',
  number: '27',
  title: '泛型编译：擦除与单态化',
  english: 'Generics: type erasure vs monomorphization',
  question: '同一份 Box<T> 代码，Java 和 C++ / Rust 到底生成了什么？',
  intro:
    '对应第 37 讲：用同一份泛型程序同时跑通“类型擦除（Java 路线）”与“单态化（C++ / Rust 路线）”，直观对照字节码复用 vs 特化代码膨胀、基础类型装箱与 checkcast 开销、泛型不变性（Invariance）以及擦除重载冲突。',
  chapter: '37',
  minutes: 22,
  icon: '⟨T⟩',
  color: 'purple',
  walkthrough: [
    {
      title: '参数化多态：把“类型”也当作参数传进去',
      body: '没有泛型时，存 int 的容器和存 bool 的容器要写两套几乎一模一样的代码。泛型让结构体和函数接受类型参数 <T>，编译期就能拦住“往 Box<int> 里塞 bool”这类错误。',
      example: 'struct Box<T> { T value; }\nfn id<T>(T x) -> T { return x; }',
      exampleLanguage: 'c',
    },
    {
      title: '路线一：类型擦除（Java 路线）——代码只留一份',
      body: '编译期做完类型检查后，把 <T> 全部擦除成统一的 Object，因此 Box<int> 和 Box<bool> 共用同一份 class Box 字节码。代价是基础类型 int/bool 放进 Object 槽位前必须装箱（box，多出对象头），取出时再由编译器插入 checkcast 和拆箱（unbox）。',
    },
    {
      title: '路线二：单态化（C++ / Rust 路线）——按类型展开特化代码',
      body: '编译器扫描程序里实际用到了哪些具体类型实参，为 Box<int> 和 Box<bool> 分别生成 Box_int 和 Box_bool，为 id<int> 和 id<bool> 生成两份特化函数。基础类型直接按值存储，0 次装箱、0 次强转，但代码单元数量随类型组合增长。',
    },
    {
      title: '类型擦除的典型限制：重载签名冲突',
      body: '原书第 37 讲举过一个经典例子：同时定义两个重载函数，参数分别是 Box<int> 和 Box<bool>。单态化下它们对应两个不同签名完全合法；但在类型擦除后，两者签名都变成相同的 (Box)，编译器不得不直接报错！',
    },
    {
      title: '为什么 Box<Cat> 不是 Box<Animal> 的子类型（不变性）？',
      body: '即使 Cat extends Animal，如果允许把 Box<Cat> 当作 Box<Animal> 使用，外部代码就可以合法地往里面塞一只 Dog，破坏原来的 Box<Cat>。因此默认泛型容器对类型参数是“不变（Invariant）”的。',
    },
  ],
  note: [
    {
      title: '三种经典泛型实现：擦除、单态化与运行时具体化',
      body: '原书第 37 讲对比了三条路线：Java 的编译期类型擦除（JVM 字节码不变，共享代码但需装箱）、C++ 模板 / Rust 的编译期单态化（零装箱高性能但增加代码体积），以及 C# / .NET 在 IL 保留类型参数、由 JIT 在运行时具体化（Reification）。',
    },
    {
      title: '循环会成倍放大装箱与内存开销',
      body: '在类型擦除模型下，每个装箱后的基础类型都要带上对象头（原书估算 64 位 JVM 对象头约 12–16 字节，是 4 字节 int 的数倍）。把 Box<int> 放进循环，本实验的统计表能直接看到装箱次数与堆字节数线性上涨。',
    },
    {
      title: '不变、协变与逆变是泛型类型系统的基础',
      body: '复合类型随类型参数变化的方向分为不变（如 Box<T>）、协变（只读场景，如 Java 的 ? extends Animal）和逆变（消费参数场景）。编译器必须在类型检查阶段守住这些规则。',
    },
  ],
  misconception:
    '“Java 的类型擦除意味着编译期也不检查泛型类型”是误解：类型检查是在擦除之前完整执行的，所以 `Box<int> b = new Box<int>(true)` 在两种路线下都会在编译期被拒绝；擦除只发生在通过类型检查之后的代码生成阶段。',
  limit:
    '教学泛型方言支持 struct<T...>、fn<T...>、简单单继承名义类（class Cat extends Animal）、int / bool / str 与基础控制流，限制 2000 字符、12 个结构体、16 个函数、32 个单态化实例与 2000 步执行。对象头按 16B 教学模型估算，不实现通配符协变/逆变（? extends / ? super）、C# 运行时 JIT 具体化或泛型约束（where / trait bound）。',
  challenge:
    '先运行“循环放大装箱开销”预设，对比两种路线的代码单元数、装箱次数与堆字节数。再切换到“擦除导致重载签名冲突”，解释为什么单态化能顺利输出，而类型擦除在编译期就拒绝了。',
  answer:
    '循环 5 次构造和读取 Box<int> 时，类型擦除只生成 1 份 Box 代码，但每轮都要执行 box(i)、checkcast<int> 与 unbox，累积 5 次装箱与 5 次强转；单态化生成专用 Box_int，全程 0 次装箱与 0 次强转。而在重载冲突预设中，inspect(Box<int>) 和 inspect(Box<bool>) 在单态化下编译为两个独立函数，但在擦除后签名同为 inspect(Box)，导致签名碰撞无法共存。',
  quiz: {
    question: '相比 Java 的类型擦除，C++ / Rust 的单态化（Monomorphization）最核心的权衡是什么？',
    options: [
      '单态化不需要在编译期做任何类型检查',
      '单态化消除了基础类型装箱和运行时强转开销，但会为不同类型实参生成多份特化代码导致体积增大',
      '单态化生成的目标代码一定比类型擦除更小',
    ],
    correct: 1,
    explain: '单态化按具体类型实参展开专用代码，直接平铺 int/bool 等值类型从而做到零装箱、零 checkcast；代价是每种具体实例化组合都会增加一份代码单元。',
  },
};

export const genericsPresets = [
  {
    id: 'gen-box-id',
    label: '泛型对照 · Box<int> 与 Box<bool>（擦除 vs 单态化）',
    code: 'struct Box<T> {\n  T value;\n}\n\nfn id<T>(T x) -> T {\n  return x;\n}\n\nlet Box<int> bi = new Box<int>(42);\nlet Box<bool> bb = new Box<bool>(true);\nlet int n = id<int>(bi.value + 8);\nlet bool ok = id<bool>(bb.value);\nprint(n);\nprint(ok);',
    prediction: '同一份 Box<T> 和 id<T> 被用于 int 和 bool：两种路线各自生成几份代码？擦除路线发生了几次装箱和 checkcast？',
  },
  {
    id: 'gen-pair',
    label: '多类型参数 · Pair<A, B> 与泛型提取函数',
    code: 'struct Pair<A, B> {\n  A first;\n  B second;\n}\n\nfn getFirst<A, B>(Pair<A, B> p) -> A {\n  return p.first;\n}\n\nlet Pair<int, str> p1 = new Pair<int, str>(100, "ok");\nlet Pair<bool, int> p2 = new Pair<bool, int>(true, 7);\nprint(getFirst<int, str>(p1));\nprint(getFirst<bool, int>(p2));\nprint(p1.second);',
    prediction: 'Pair<int, str> 与 Pair<bool, int> 在单态化下会展开成哪两个特化结构体？',
  },
  {
    id: 'gen-loop-boxing',
    label: '性能对照 · 循环里放大类型擦除的装箱开销',
    code: 'struct Box<T> {\n  T value;\n}\n\nlet int i = 1;\nlet int sum = 0;\nwhile (i <= 5) {\n  let Box<int> cell = new Box<int>(i);\n  sum = sum + cell.value;\n  i = i + 1;\n}\nprint(sum);',
    prediction: '循环跑 5 轮：类型擦除会产生多少次 box 和 checkcast？单态化又是多少？',
  },
  {
    id: 'gen-erasure-clash',
    label: '原书边界 · 类型擦除导致重载签名冲突',
    code: 'struct Box<T> {\n  T value;\n}\n\nfn inspect(Box<int> b) -> int {\n  return b.value + 1;\n}\n\nfn inspect(Box<bool> b) -> int {\n  if (b.value) {\n    return 1;\n  } else {\n    return 0;\n  }\n}\n\nlet Box<int> bi = new Box<int>(10);\nlet Box<bool> bb = new Box<bool>(true);\nprint(inspect(bi));\nprint(inspect(bb));',
    prediction: 'inspect(Box<int>) 与 inspect(Box<bool>) 在擦除后会变成什么签名？单态化能正常编译运行吗？',
  },
  {
    id: 'gen-invariance-err',
    label: '反例 · 泛型不变性（Box<Cat> 不可赋给 Box<Animal>）',
    code: 'class Animal {}\nclass Cat extends Animal {}\nstruct Box<T> {\n  T item;\n}\n\nlet Box<Cat> cats = new Box<Cat>(new Cat());\nlet Box<Animal> animals = cats;\nprint(1);',
    prediction: 'Cat 是 Animal 的子类，为什么把 Box<Cat> 赋值给 Box<Animal> 会在编译期报错？',
  },
];
