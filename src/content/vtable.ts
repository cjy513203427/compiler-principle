import type { Lesson } from './lessons';

export const vtableLesson: Lesson = {
  id: 'vtable',
  number: '24',
  title: '面向对象与虚表分派',
  english: 'OOP object layout & vtable dispatch',
  question: '声明类型是父类，程序怎么在运行时找到子类的方法？',
  intro:
    '对应第 38 讲（及加餐 5）：编辑类继承层次、字段与覆写方法，观察前缀兼容的对象内存布局、虚函数表（vtable）的槽位继承与覆写、运行时 vptr → vtable[slot] 间接分派，以及类层次分析（CHA）如何把单实现调用去虚拟化。',
  chapter: '38',
  minutes: 22,
  icon: '◈',
  color: 'green',
  walkthrough: [
    {
      title: '对象在内存里长什么样？',
      body: '在 C++、Java 等面向对象的实现里，一个对象实例在内存里并不是“带着一堆名字的字典”，而是一段连续的字段槽位：最开头（+0 偏移）放一个隐藏指针 vptr，指向所属类的虚函数表；接着按从父类到子类的顺序摆放字段。',
      example: 'Shape 实例：[+0 vptr -> Shape::vtable] [+1 base]\nRect  实例：[+0 vptr -> Rect::vtable]  [+1 base] [+2 height]',
      exampleLanguage: 'text',
    },
    {
      title: '为什么子类可以安全地当父类用（前缀兼容）？',
      body: '注意看 Rect 的内存布局：父类 Shape 的字段 base 就在偏移 +1，Rect 新增的 height 排在后面 +2。因此，当 Shape s = new Rect(4, 5) 执行 s.base 时，编译器根本不需要知道 s 到底是 Shape 还是 Rect，统一读偏移 +1 就能拿到正确的 base！',
    },
    {
      title: '虚函数表（vtable）怎么建？',
      body: '每个类在只读区共享一张虚表，不是每个对象复制一份方法代码。子类构造自己的虚表时，先原封不动复制父类的全部槽位：如果子类覆写了同名方法，就在原槽位号原地换成子类实现；如果子类新增了方法，就追加到表尾。',
      example: 'Shape::vtable: [0] area -> Shape::area    [1] perimeter -> Shape::perimeter\nRect::vtable:  [0] area -> Rect::area (覆写) [1] perimeter -> Shape::perimeter (继承) [2] extra -> Rect::extra',
      exampleLanguage: 'text',
    },
    {
      title: '运行时动态分派的三步跳转',
      body: '编译器看到 s.area() 时，根据静态类型 Shape 已经查出 area 在槽位 [0]。真正运行时只需三步：从 s 的 +0 读出 vptr → 取出 vtable[0] → 跳转到对应实现，并把 s 作为隐式参数 this 传进去。即使在父类方法里写 this.area()，同样会按运行时的真实 vptr 分派到子类！',
    },
    {
      title: '类层次分析（CHA）与去虚拟化',
      body: '动态查表会多一次间接跳转，也挡住内联优化。如果编译器扫描整个类层次（CHA）发现某个方法没有任何子类覆写（例如 perimeter），或者局部变量的精确具体类型已知，就能直接“去虚拟化”，改回静态直调！',
    },
  ],
  note: [
    {
      title: '字段靠固定偏移，方法靠固定槽位号',
      body: '单继承下，父类和子类的字段偏移量前缀一致，虚表槽位号前缀也一致。原书第 38 讲将无需运行时查表的绑定称为静态绑定（早期绑定，如 private / static / final 或重载 Overload），而基于子类型多态的虚表查表（C++ vtable / Java invokevirtual）称为动态绑定（后期绑定）。',
    },
    {
      title: 'vtable 属于类，vptr 属于实例',
      body: '创建 1000 个 Rect 对象不会复制 1000 份方法表，每个对象头部只需存 1 个指向 Rect::vtable 的指针 vptr。',
    },
    {
      title: '模板方法依赖 this 的动态分派',
      body: '父类方法里调用 this.area() 时，this 的静态类型是父类，但运行时 vptr 指向实际子类对象，因此父类的通用骨架会自动回调子类的覆写实现。',
    },
  ],
  misconception:
    '“虚表查找是在运行时按方法名做字符串哈希查找”是常见误解：在静态类型 OOP 编译器（如 C++、HotSpot vtable）里，方法名在编译期就已经翻译成固定整数槽位号（如 vtable[0]），运行时只需 O(1) 的指针解引用。',
  limit:
    '教学单继承模型：对象首槽用 +0 vptr 示意类虚表指针（Java 另有标记字等对象头字段，C++ 仅含虚方法的类带 vptr），字段和方法参数/返回值均为 int。不支持多重继承（多 vptr 与指针转换偏移调整）、接口表（itable）、Trait/Mixin、访问控制修饰符、自动装箱/拆箱、super 关键字或动态类加载（封闭世界假设下做 CHA）。限制 2000 字符、12 个类与 2000 步执行。',
  challenge:
    '选“模板方法（父类 this 回调子类）”预设，观察两次调用 doubleArea() 时，父类方法里的 this.area() 为什么一次跳到 Rect::area，一次跳到 Square::area。再把 Square 的覆写删掉，观察 CHA 去虚拟化报告怎么变化。',
  answer:
    'doubleArea() 定义在 Shape 里，从未被覆写，因此 a.doubleArea() 可被 CHA 直接去虚拟化为 Shape::doubleArea。但进入 Shape::doubleArea 后，this.area() 的静态类型是 Shape，而 Shape 及其子类共有 3 种 area 实现，无法去虚拟化，必须读取 this 头部 +0 的 vptr 再查槽 [0]：当对象是 Rect 时跳到 Rect::area，换成 Square 时跳到 Square::area。',
  quiz: {
    question: '在单继承下，子类 Rect 覆写了父类 Shape 位于槽位 [0] 的 area() 方法，Rect 的虚函数表里 area() 应该放在哪个槽位？',
    options: [
      '仍然放在槽位 [0]，原地替换成 Rect::area',
      '追加到虚表末尾的新槽位，保留槽位 [0] 指向 Shape::area',
      '每次调用时按字符串名字重新搜索',
    ],
    correct: 0,
    explain: '只有让覆写方法保持与父类完全相同的槽位号 [0]，通过父类引用调用 s.area() 时才能统一编译成查 vtable[0] 并自动命中子类实现。',
  },
};

export const vtablePresets = [
  {
    id: 'vt-poly',
    label: '虚表分派 · 父类变量指向不同子类（多态）',
    code: 'class Shape {\n  int base;\n  int area() { return this.base; }\n  int perimeter() { return this.base * 2; }\n}\nclass Rect extends Shape {\n  int height;\n  int area() { return this.base * this.height; }\n  int extra() { return this.height; }\n}\nclass Square extends Rect {\n  int area() { return this.base * this.base; }\n}\n\nShape s = new Rect(4, 5);\nprint(s.area());\nprint(s.perimeter());\ns = new Square(6, 6);\nprint(s.area());',
    prediction: '变量 s 的静态类型始终是 Shape。为什么两次 s.area() 跳到不同实现，而 s.perimeter() 却能被去虚拟化？',
  },
  {
    id: 'vt-template',
    label: '虚表分派 · 模板方法（父类 this 回调子类）',
    code: 'class Shape {\n  int base;\n  int area() { return this.base; }\n  int doubleArea() { return this.area() * 2; }\n}\nclass Rect extends Shape {\n  int height;\n  int area() { return this.base * this.height; }\n}\nclass Square extends Rect {\n  int area() { return this.base * this.base; }\n}\n\nShape a = new Rect(3, 7);\nprint(a.doubleArea());\na = new Square(5, 5);\nprint(a.doubleArea());',
    prediction: 'doubleArea() 定义在父类 Shape 里，它内部的 this.area() 会调用 Shape::area 还是子类的 area？',
  },
  {
    id: 'vt-devirt',
    label: '对照 · 精确类型与无覆写 → 全部去虚拟化',
    code: 'class Counter {\n  int val;\n  int get() { return this.val; }\n  int add(int d) {\n    this.val = this.val + d;\n    return this.val;\n  }\n}\n\nCounter c = new Counter(10);\nprint(c.add(5));\nprint(c.get());',
    prediction: '没有子类覆写时，所有调用点都能通过 CHA 去虚拟化为静态直调吗？',
  },
  {
    id: 'vt-loop-poly',
    label: '虚表分派 · 循环里同一调用点切换接收者',
    code: 'class Op {\n  int factor;\n  int apply(int x) { return x + this.factor; }\n}\nclass MulOp extends Op {\n  int apply(int x) { return x * this.factor; }\n}\n\nint i = 0;\nOp fn = new Op(3);\nwhile (i < 4) {\n  if (i == 2) {\n    fn = new MulOp(3);\n  }\n  print(fn.apply(10));\n  i = i + 1;\n}',
    prediction: '同一行 fn.apply(10) 在前两轮和后两轮分别查出哪个实现？',
  },
  {
    id: 'vt-cycle-err',
    label: '反例 · 继承环检测',
    code: 'class A extends B {\n  int x;\n}\nclass B extends A {\n  int y;\n}\nA a = new A(1, 2);\nprint(1);',
    prediction: 'A 继承 B、B 又继承 A 时，编译期布局构建能通过吗？',
  },
];
