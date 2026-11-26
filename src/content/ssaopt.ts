import type { Lesson } from './lessons';

export const SCCP_REFERENCE = 'https://llvm.org/docs/Passes.html#sccp-sparse-conditional-constant-propagation';
export const SSA_OPT_REFERENCE = 'https://www.cs.cornell.edu/courses/cs6120/2025sp/lesson/6/';
export const LOST_COPY_REFERENCE = 'https://doi.org/10.1002/(SICI)1097-024X(19980710)28:8%3C859::AID-SPE188%3E3.0.CO;2-8';

export const ssaOptLesson: Lesson = {
  id: 'ssaopt',
  number: '21',
  title: 'SSA 优化与复制合并',
  english: 'SSA optimization & coalescing',
  question: '为什么很多优化，到了 SSA 上突然变简单了？',
  intro:
    '接着实验 13 和 15：先在标量 SSA 上运行稀疏条件常量传播（SCCP）、复制传播与稀疏死代码删除，再在消除 φ 回到普通 IR 时，用干涉图检查哪些边复制可以安全合并、哪些必须保留。',
  chapter: '07',
  minutes: 24,
  icon: '⚡',
  color: 'purple',
  walkthrough: [
    {
      title: '从稠密扫描到稀疏工作表',
      body: '实验 08 在可变变量 IR 上做条件常量传播，每轮都要重新扫描全部可达基本块，并维护每个块出口的完整变量表。在 SSA 里，每个版本只有唯一一处定义，直接拥有一个全局格值（⊥、常量 c、⊤）；它的格值变化时，只需要沿 def-use 链唤醒直接用到它的指令和 φ。',
      example: '实验 08（稠密）：每轮扫所有块，每块维护全变量表\n实验 21（稀疏）：两条工作表（可执行边 + SSA 变更），按需唤醒',
      exampleLanguage: 'text',
    },
    {
      title: '不可达分支不会污染 φ',
      body: '稀疏条件常量传播（SCCP）同时维护“哪些边可执行”与“每个版本的格值”。计算 φ 时，只合并当前已标记为可执行的前驱边。因此当 if (false) 的假分支把 x 改成 99 时，那条边从未激活，φ 的结果仍然是 10，整个分支随后被裁剪。',
      example: 'bool flag = false;\nint x = 10;\nif (flag) { x = 99; }   // 边未激活，不参与 φ 合并\nprint(x + 5);           // 直接折叠为 15',
      exampleLanguage: 'c',
    },
    {
      title: '唯一定义让复制传播与死代码删除直接沿链走',
      body: '因为 SSA 版本不会被再次赋值，遇到 y.1 = x.1 时，直接把所有对 y.1 的使用换成 x.1 即可，不必担心中间有别的写入覆盖 x.1。稀疏死代码删除从 print、分支和可能报错的算术出发，反向沿唯一定义标记活指令与活 φ；没有连到这些根的整条定义链和无用 φ 会一次清干净。',
      example: 'v1_y.3 = v0_x.2\n→ 在 φ 中直接把 v1_y.3 换为 v0_x.2\n→ v1_y.3 不再被任何指令读取，直接删除',
      exampleLanguage: 'text',
    },
    {
      title: '消除 φ 后，为什么还留着那么多复制？',
      body: '实验 15 保留了全部版本号，所以循环和分支汇合处会留下 v0_i.2 ← v0_i.1、v0_i.2 ← v0_i.3 这样的边复制。既然它们原本都来自同一个源变量 i，能不能把所有版本直接去掉后缀、合并回同一个名字？',
    },
    {
      title: '经典陷阱：丢失复制问题（Lost-Copy Problem）',
      body: '答案是“不能盲目合并”。当循环里 y = x; x = x + 1; 经过 SSA 复制传播后，回边上会同时需要旧值 x.2 和新值 x.3：写入 x.3 时，x.2 还要在回边被 y 的 φ 读取。如果强行把 x.2 和 x.3 合并成同一个变量，x + 1 就会提前覆盖旧值，把正确的 4、3 算成 4、4！',
      example: 'B2: t1.1 = v0_x.2 + 1\n    v0_x.3 = t1.1       // 写入 v0_x.3 时，v0_x.2 仍活跃！\n    v1_y.2 ← v0_x.2     // 合并会覆盖这里的旧值',
      exampleLanguage: 'text',
    },
    {
      title: '用干涉图护航的保守复制合并',
      body: '把实验 17 的逐条活跃性与干涉图拿来做守门员：对每条复制 d ← s，如果 d 和 s 在干涉图中没有边（从不同时活跃），就能安全合并为一个名字并删去自身复制；如果存在干涉边，就明确拒绝合并并指出冲突指令。最后把原始 IR、原始 SSA、优化后 SSA、未合并消除与合并消除全部实际执行对照。',
    },
  ],
  note: [
    {
      title: 'SCCP 比“常量传播 + 死代码删除”交替更强',
      body: '如果先不看分支条件做常量传播，不可达分支里的赋值会把 φ 污染成 ⊤，之后就再也证明不了常量。SCCP 把可达边传播与格值求解合在同一个不动点里，互为因果。',
    },
    {
      title: '精确异常决定稀疏死代码删除的根集合',
      body: '本项目的除零和整数溢出都是确定的运行时错误，不是未定义行为。因此可能触发报错的未折叠算术即使结果无人读取，也必须作为根保留，不能随死变量一起删除。',
    },
    {
      title: '复制合并是活跃性约束下的重命名',
      body: '版本号合并不是字符串去后缀，而是图着色里的节点合并：只有不干涉的两个变量才能共用同一存储位置。合并后如实重算活跃性并交给原 VM 执行核对。',
    },
  ],
  misconception:
    '“把 SSA 变回普通 IR 时，直接把 x.1、x.2、x.3 的版本号去掉就行。”——这在未做任何优化的原始 SSA 上往往碰巧能跑，但一旦在 SSA 上做过复制传播或代码移动，不同版本的活跃区间就会重叠（丢失复制问题与交换环），直接去后缀会悄悄改错程序结果。',
  limit:
    '面向标量局部变量 SSA。实现 Wegman-Zadeck 稀疏条件常量传播（SCCP）、SSA 复制传播、平凡 φ 化简、异常安全的稀疏死代码删除，以及基于逐条活跃性与干涉图的保守复制合并；优化后重新运行 SSA 校验与解释器，并将基础消除与合并消除接回原栈式 VM 执行对照。没有全局值编号（GVN）、内存 SSA、循环不变外提的 SSA 版、区间拆分或图着色合并（Iterated Register Coalescing）与寄存器分配集成。现有实验 05 优化器仍保留可变变量实现，不由此替换。SCCP 最多 20000 步，合并最多 200 轮，回放保留前 240 步；执行上限 2000 步，任一版本超限时标记为无法判定。',
  challenge:
    '先运行“丢失复制”预设，找出被拒绝合并的一对变量，说明具体是哪条指令导致它们干涉；再切换到“循环里的 φ 复制消失”，解释为什么循环累加的 i 与 sum 却可以安全合并。',
  answer:
    '在“丢失复制”预设中，SSA 复制传播使回边需要把旧值 v0_x.2 交给 y 的 φ，因此在计算新值 v0_x.3 = t1.1 时 v0_x.2 仍然活跃，二者存在干涉边，拒绝合并。而在“循环累加”预设中，计算完新值 v0_i.3 后，旧值 v0_i.2 不再被任何后续指令读取，两者活跃期不相交，在干涉图中无边，可以安全合并为同一个变量并消去复制。',
  quiz: {
    question: '在 SSA 消除时，什么时候可以把复制 d ← s 的两端合并为同一个变量？',
    options: [
      '只要 d 和 s 来自源码里的同一个变量名（例如 x.2 和 x.3）',
      '只有当 d 和 s 在逐条活跃性分析的干涉图中没有干涉边时',
      '任何边复制都可以直接合并，因为并行复制调度器已经排好顺序',
    ],
    correct: 1,
    explain:
      '来自同一源变量的不同 SSA 版本在优化后仍可能同时活跃（如丢失复制问题）。必须确认二者不干涉，合并才不会破坏尚未读取的旧值。',
  },
};

export const ssaOptPresets = [
  {
    id: 'ssaopt-sccp',
    label: 'SSA 优化 · 不可达分支不污染常量',
    code: 'bool flag = false;\nint x = 10;\nif (flag) {\n  x = 99;\n}\nint y = x + 5;\nprint(y);',
    prediction: 'if 分支把 x 改成 99，但条件是 false。SCCP 会把汇合后的 x 算成 10 还是 ⊤？',
  },
  {
    id: 'ssaopt-loop',
    label: '复制合并 · 循环里的 φ 复制消失',
    code: 'int i = 0;\nint sum = 0;\nwhile (i < 4) {\n  sum = sum + i;\n  i = i + 1;\n}\nprint(sum);',
    prediction: '基础 SSA 消除会留下多条边复制。i 和 sum 的不同版本存在干涉吗？合并后剩几条复制？',
  },
  {
    id: 'ssaopt-lostcopy',
    label: '反例 · 丢失复制（为什么不能盲目合并）',
    code: 'int x = 1;\nint y = 0;\nint i = 0;\nwhile (i < 3) {\n  y = x;\n  x = x + 1;\n  i = i + 1;\n}\nprint(x);\nprint(y);',
    prediction: 'y 读取更新前的 x。SSA 复制传播后，x 的新旧版本能合并成同一个变量吗？输出应是多少？',
  },
  {
    id: 'ssaopt-swap',
    label: '反例 · 复制传播造出真实交换环',
    code: 'int a = 1;\nint b = 2;\nint i = 0;\nwhile (i < 3) {\n  int saved = a;\n  a = b;\n  b = saved;\n  i = i + 1;\n}\nprint(a);\nprint(b);',
    prediction: '复制传播消掉 saved 之后，循环 φ 会发生什么变化？干涉图会阻止哪一对合并？',
  },
  {
    id: 'ssaopt-dead',
    label: '稀疏死代码 · 清理自引用的无用 φ 环',
    code: 'int i = 0;\nint keep = 1;\nbool flip = false;\nwhile (i < 4) {\n  flip = flip == false;\n  keep = keep + 2;\n  i = i + 1;\n}\nprint(keep);',
    prediction: 'flip 在循环里读自己又写自己，所以传统活跃性会认为它“活跃”。稀疏死代码删除能连同 φ 一起清掉吗？',
  },
  {
    id: 'ssaopt-merge-const',
    label: '稀疏传播 · 两条可达分支算出相同常量',
    code: 'int i = 0;\nwhile (i < 2) {\n  i = i + 1;\n}\nint v = 0;\nif (i == 2) {\n  v = 4 + 3;\n} else {\n  v = 10 - 3;\n}\nprint(v * 2);',
    prediction: '循环让 if 条件变成 ⊤，两条分支都可执行；两边折叠后都是 7，φ 与 v * 2 会怎样化简？',
  },
  {
    id: 'ssaopt-trap',
    label: '语义边界 · 保留未使用的除零',
    code: 'int d = 0;\nprint(5);\nint dead = 10 / d;\nprint(6);',
    prediction: 'dead 从未被读取，稀疏死代码删除能把 10 / d 删掉吗？输出和报错应怎样保持？',
  },
];
