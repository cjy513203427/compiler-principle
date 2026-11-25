import type { Lesson } from './lessons';

export const inlineCacheLesson: Lesson = {
  id: 'inlinecache',
  number: '28',
  title: '隐藏类与内联缓存',
  english: 'Hidden classes (Shapes) & inline caches',
  question: '没有 class 声明的 JavaScript，V8 怎么像静态语言一样 O(1) 读属性？',
  intro:
    '对应第 21 讲（V8 优化编译器）：编辑动态对象和属性访问函数，实时追踪隐藏类（Hidden Class / Shape）转移树如何按属性添加顺序生成槽位布局，以及内联缓存（IC）如何经历未初始化 → 单态 → 多态 → 超态，并与字典查找解释器对照代价与结果。',
  chapter: '21',
  minutes: 20,
  icon: '⚡',
  color: 'orange',
  walkthrough: [
    {
      title: '动态对象如果每次都查哈希表，为什么会很慢？',
      body: '在实验 24（面向对象与虚表）里，Java/C++ 的类在编译期就定死了字段偏移量，读 obj.x 只需一条固定偏移的访存指令。但 JavaScript 没有强制的类声明，你可以随时给对象加属性；如果像普通字典一样每次按字符串名字哈希查找，性能会慢一个数量级。',
    },
    {
      title: '隐藏类（Hidden Class / Shape）：运行时自动长出“类布局”',
      body: 'V8 偷偷在后台维护一棵隐藏类转移树：从空对象 Shape#0 出发，加上属性 x 转移到 Shape#1（x 在槽 @0），再加上属性 y 转移到 Shape#2（y 在槽 @1）。只要两个对象以相同顺序添加相同属性，它们就共享同一个 Shape#2，对象本身只需存一个紧凑数组 slots = [valX, valY]！',
      example: 'point1 = { x: 2, y: 3 }  // Shape#0 ->(+x) Shape#1 ->(+y) Shape#2\npoint2 = { x: 4, y: 5 }  // 复用同一个 Shape#2！',
      exampleLanguage: 'c',
    },
    {
      title: '为什么属性顺序颠倒会拆出两棵分支？',
      body: '看原书第 21 讲的 point3 = { y: 7, x: 6 }：它先加 y（槽 @0）再加 x（槽 @1），因此沿 Shape#0 走出了另一条新分支 Shape#3 → Shape#4。虽然都有 x 和 y，但 x 的偏移一个是 @0、一个是 @1，不能共用同一个 Shape！',
    },
    {
      title: '内联缓存（Inline Cache, IC）：把“Shape → 偏移”记在调用点上',
      body: '当 fn getX(o) { return o.x; } 第一次执行时，去 Shape#2 里查出 x 在槽 @0，并顺手把 (Shape#2 → @0) 缓存在这条 o.x 指令旁（进入单态 Monomorphic）。下次再传同 Shape 的对象进来，只需比一下 shapeId，命中就直接读 slots[0]——速度和静态语言几乎一样！',
    },
    {
      title: '单态 → 多态 → 超态（Megamorphic）的退化阶梯',
      body: '如果同一个 o.x 调用点先后遇到 2–4 种不同 Shape，IC 会扩张为多态（Polymorphic，逐条比对缓存表）；一旦超过上限（本实验设为 4 种），就放弃缓存退化为超态（Megamorphic），每次回落到慢速字典查找。这正是写高性能 JS 要保持对象结构一致的底层原因。',
    },
  ],
  note: [
    {
      title: '隐藏类共享对象结构，对象自身只存属性值数组',
      body: '不同编译器对隐藏类叫法不同：V8 称 Map，SpiderMonkey 称 Shape，学术界常称 Hidden Class。它们都用转移树把属性名到偏移量的映射从每个对象实例里抽离出来共享。',
    },
    {
      title: '单态 IC 是动态语言 JIT 推理优化的基石',
      body: '原书第 21 讲强调，Ignition 解释器在执行过程中收集 IC 反馈（Feedback Vector）；当一个属性访问长期保持单态，TurboFan 就能放心地内联固定偏移读取，只在 Shape 变更时触发去优化。',
    },
    {
      title: '属性顺序一致 + 避免中途随意增删属性',
      body: '构造同类型对象时按固定顺序初始化全部字段（缺失值可用统一占位），可以让所有实例落入同一个 Shape，最大化单态 IC 命中率。',
    },
  ],
  misconception:
    '“只要两个 JS 对象拥有相同的属性集合，V8 就会给它们分配同一个隐藏类”是误解：隐藏类按属性添加的先后顺序沿转移树构建，{ x: 2, y: 3 } 和 { y: 7, x: 6 } 的槽位偏移完全不同，会生成两个不同的 Shape。',
  limit:
    '教学动态对象方言支持字面量 { k: v }、动态属性赋值 obj.k = v、函数、分支与循环，限制 2000 字符、16 个函数与 2000 步执行。多态 IC 上限设为 4，周期代价（单态命中 1 / 未命中 10 / 超态与字典 12）为教学模型，不模拟 V8 的 Tagged Pointer (Smi)、delete 退化为字典模式、原型链查找或 TurboFan 机器码生成。',
  challenge:
    '先运行“原书例子：同顺序共享 Shape”预设，确认 getX 里的 o.x 是单态（Monomorphic）。再切换到“属性顺序颠倒”，观察转移树如何分叉，以及 o.x 的缓存表里两条记录的槽位偏移有何不同。',
  answer:
    '在同顺序预设中，point1 和 point2 依次添加 x、y，最终都指向 Shape#2（x@0, y@1），所以 getX(point2) 直接命中单态 IC（仅 1 周期）。在顺序颠倒预设中，point3 先加 y 再加 x，沿着 Shape#0 → Shape#3(y@0) → Shape#4(y@0, x@1) 长出新分支，x 的偏移变成 @1；于是 getX(point3) 触发 IC 未命中，将 o.x 推进为多态（Polymorphic），同时缓存 Shape#2→@0 与 Shape#4→@1。',
  quiz: {
    question: '在 V8 中，先后创建 point1 = { x: 2, y: 3 } 和 point3 = { y: 7, x: 6 }，它们会共享同一个隐藏类（Shape）吗？',
    options: [
      '会，因为属性名集合都是 {x, y}',
      '不会，因为隐藏类沿属性添加顺序转移，两者 x 和 y 的槽位偏移互换，属于两条不同转移路径',
      '不会，因为 V8 会为每个对象实例单独复制一份独立隐藏类',
    ],
    correct: 1,
    explain: 'point1 的路径是 Shape#0 →(+x)→(+y)，x 在偏移 0；point3 的路径是 Shape#0 →(+y)→(+x)，x 在偏移 1。槽位布局不同，因此对应不同隐藏类。',
  },
};

export const inlineCachePresets = [
  {
    id: 'ic-monomorphic',
    label: '原书例子 · 同顺序属性共享 Shape（单态 IC）',
    code: 'fn getX(o) {\n  return o.x;\n}\n\nlet point1 = { x: 2, y: 3 };\nlet point2 = { x: 4, y: 5 };\nlet point3 = { x: 8, y: 9 };\nprint(getX(point1));\nprint(getX(point2));\nprint(getX(point3));',
    prediction: 'point1、point2、point3 都按 x 再 y 创建。三次调用 getX 时，后两次会命中单态缓存吗？',
  },
  {
    id: 'ic-order-mismatch',
    label: '原书对照 · 属性顺序颠倒导致多态（Polymorphic）',
    code: 'fn getX(o) {\n  return o.x;\n}\n\nlet point1 = { x: 2, y: 3 };\nlet point2 = { x: 4, y: 5 };\nlet point3 = { y: 7, x: 6 };\nprint(getX(point1));\nprint(getX(point2));\nprint(getX(point3));\nprint(getX(point1));',
    prediction: 'point3 把 y 写在 x 前面。它的隐藏类和 point1 一样吗？o.x 的缓存状态会变成什么？',
  },
  {
    id: 'ic-dynamic-add',
    label: '隐藏类迁移 · 运行时动态追加属性 z',
    code: 'fn sumXY(p) {\n  return p.x + p.y;\n}\n\nlet a = { x: 1, y: 2 };\nprint(sumXY(a));\na.z = 10;\nprint(sumXY(a));\nprint(a.z);',
    prediction: '执行 a.z = 10 之后，对象 a 的 Shape 编号改变了吗？再次调用 sumXY(a) 会发生什么？',
  },
  {
    id: 'ic-megamorphic',
    label: '性能退化 · 5 种 Shape 击穿缓存（Megamorphic）',
    code: 'fn getX(o) {\n  return o.x;\n}\n\nlet s1 = { x: 1 };\nlet s2 = { a: 0, x: 2 };\nlet s3 = { b: 0, x: 3 };\nlet s4 = { c: 0, x: 4 };\nlet s5 = { d: 0, x: 5 };\nprint(getX(s1));\nprint(getX(s2));\nprint(getX(s3));\nprint(getX(s4));\nprint(getX(s5));\nprint(getX(s1));',
    prediction: '多态缓存上限为 4。第 5 种 Shape 传入后，再传回 s1 还能走快路径吗？',
  },
  {
    id: 'ic-hot-loop',
    label: '热点循环 · 单态 IC 与字典查找代价对比',
    code: 'fn score(p) {\n  return p.x * 2 + p.y;\n}\n\nlet p = { x: 3, y: 4 };\nlet i = 0;\nlet total = 0;\nwhile (i < 6) {\n  total = total + score(p);\n  p.x = p.x + 1;\n  i = i + 1;\n}\nprint(total);',
    prediction: '修改已有属性 p.x 不会改变 Shape。循环 6 轮下来，Shape+IC 与每次字典查找的代价相差多少？',
  },
];
