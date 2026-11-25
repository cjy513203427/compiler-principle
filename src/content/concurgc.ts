import type { Lesson } from './lessons';

export const concurGcLesson: Lesson = {
  id: 'concurgc',
  number: '29',
  title: '并发 GC 与写屏障',
  english: 'Concurrent tri-color GC & write barriers',
  question: '不暂停程序（STW）边跑边做三色标记，为什么会把活对象误杀？',
  intro:
    '对应第 32 讲后半（增量收集与并发收集）：把业务线程（Mutator）的 link / cut / alloc 与 GC 的三色标记交错推进，同屏对比“无写屏障”“Dijkstra 插入写屏障”与“Yuasa SATB 删除写屏障”，亲眼复现三色漏标 Bug、写屏障修复与浮动垃圾权衡。',
  chapter: '32',
  minutes: 20,
  icon: '⛨',
  color: 'rose',
  walkthrough: [
    {
      title: '为什么要冒风险做并发标记？',
      body: '实验 20 的三色标记是在“停下整个世界（STW）”下完成的：扫描期间对象引用图纹丝不动。但原书第 32 讲指出，长时间 STW 会导致系统卡顿；为了让用户程序与 GC 并发运行，标记期间业务线程会继续修改指针（link / cut）和分配新对象（alloc）。',
    },
    {
      title: '三色漏标 Bug：两个条件同时满足，活对象就会被误杀！',
      body: '假设 A 已扫描完变黑，B 是灰色且指向白色 C。此时业务线程先执行 link A -> C（黑对象新增指向白对象的引用），再执行 cut B -> C（删掉灰对象到 C 的唯一路径）。因为 A 已经是黑色不会再扫，B 也已经断开了 C，最终 C 保持白色被 sweep 清除——但 root A 明明还指着 C！',
      example: 'mark-step      // A 变黑，B 变灰\nlink A -> C    // 条件1：黑对象 A 指向白对象 C\ncut B -> C     // 条件2：灰对象 B 断开到 C 的路径\nmark-all       // C 从未被发现，仍是白色！\nsweep          // 误杀存活对象 C！',
      exampleLanguage: 'text',
    },
    {
      title: '解法一：Dijkstra 插入写屏障（破坏条件 1：强三色不变式）',
      body: '在每次指针写入（link X -> Y）前插一小段编译器生成的代码：只要发现黑色对象 X 指向了白色对象 Y，写屏障立刻把 Y 染灰并放进灰队列！这样“黑指白”绝不会发生，C 被重新纳入扫描并保住自己和它引用的所有子对象。',
    },
    {
      title: '解法二：Yuasa SATB 删除写屏障（破坏条件 2：弱三色不变式）',
      body: '另一种思路不拦截新增引用，而是在断开旧引用（cut B -> C）时拦截：只要被断掉的旧目标 C 还是白色，写屏障就立刻把 C 染灰入队，保证“初始标记那一刻的快照（Snapshot-At-The-Beginning）”里的可达路径不会彻底消失。',
    },
    {
      title: 'SATB 的代价：浮动垃圾（Floating Garbage）',
      body: '如果业务线程只执行了 cut B -> C、并没有把 C 挂到 A 上，那么 C 其实已经彻底死了。但 SATB 为了保护快照还是把 C 染灰保活了一轮！这种“本轮没回收、留待下轮清理的死对象”叫做浮动垃圾——它安全、绝不误杀，只是暂时多占一点内存。',
    },
  ],
  note: [
    {
      title: '三色漏标的充要破坏方式：强 / 弱三色不变式',
      body: '强三色不变式禁止任何黑对象直接指向白对象（Dijkstra 插入写屏障，如 CMS/Go 早期增量更新）；弱三色不变式允许黑指白，但要求该白对象仍处于某灰对象的保护链上（Yuasa SATB 删除写屏障，如 Java G1 / Go 混合写屏障的删除侧）。',
    },
    {
      title: '写屏障是编译器在每次引用赋值处插入的配合代码',
      body: '原书第 32 讲强调 GC 不是运行时孤立完成的，需要编译器配合：每次字段指针写入生成写屏障指令，同时在并发标记阶段分配的新对象通常采用“分配即涂黑（Allocate-Black）”避免本轮误回收。',
    },
    {
      title: '安全优先于当轮极致回收',
      body: '漏标（误杀存活对象）会导致悬垂指针和内存崩溃，是绝对不能接受的错误；而浮动垃圾只推迟一个回收周期，因此现代低延迟收集器（G1、ZGC、Go GC）宁可容忍少量浮动垃圾也要确保并发安全。',
    },
  ],
  misconception:
    '“只要黑对象指向了白对象，就一定会发生误杀”并不完整：如果仍然存在某个灰对象（直接或经白色链间接）指向该白对象，后续扫描灰对象依然会找到它。只有“黑指白”与“灰到白的所有路径都被切断”同时发生，才会真正触发三色漏标。',
  limit:
    '教学并发交错模型：通过显式命令（mark-step / mark-all / link / cut / root / drop / alloc / sweep）单步重放业务线程与 GC 的交错，限制 1200 字符、20 个对象、32 条操作。并发标记期对新对象采用 Allocate-Black 规则；不模拟真实多核原子 CAS、栈上重新扫描（Rescan）、卡表/分代晋升（Remembered Set）或读屏障（ZGC/Shenandoah 染色指针）。',
  challenge:
    '先运行“经典三色漏标”预设，确认无屏障为何误杀 C，而 Dijkstra 和 SATB 各自在哪一条命令触发了写屏障。再切换到“SATB 的浮动垃圾”，解释为什么 C 已经不可达，SATB 却没有在本轮回收它。',
  answer:
    '在经典漏标预设中，mark-step 后 A 为黑、B 为灰、C 为白；link A -> C 触发了 Dijkstra 插入写屏障将 C 染灰，随后 cut B -> C 触发了 SATB 删除写屏障将 C 染灰；无屏障则未做任何处理导致 C 在 sweep 时被误杀。在浮动垃圾预设中，只断开了 B -> C 却没有把 C 挂到 A，C 变成不可达垃圾，但 SATB 在 cut B -> C 时按初始快照把白色的 C 染灰保活，因此成为留待下轮清理的浮动垃圾。',
  quiz: {
    question: '并发三色标记期间，黑对象 A 新增指向白对象 C 的引用（link A -> C），且灰对象 B 断开了到 C 的唯一引用（cut B -> C）。哪两条屏障思路都能保住 C？',
    options: [
      '只有 STW 才能保住，任何写屏障都不行',
      'Dijkstra 插入屏障在 link A -> C 时把 C 染灰；Yuasa SATB 删除屏障在 cut B -> C 时把 C 染灰',
      '把 A 重新染成白色即可安全结束',
    ],
    correct: 1,
    explain: '插入屏障破坏“黑指白”条件，删除屏障破坏“灰路径消失”条件，两者都能在各自拦截点把 C 染灰入队，防止 C 被误清除。',
  },
};

export const concurGcPresets = [
  {
    id: 'cgc-lost-object',
    label: '经典三色漏标 · 黑指白 + 灰断链（双屏障救回 C）',
    code: 'heap A B C D\nroot A\nedge A -> B\nedge B -> C\nedge A -> D\n%%\nmark-step\nlink A -> C\ncut B -> C\nmark-all\nsweep',
    prediction: 'A 变黑后执行 link A -> C 再执行 cut B -> C：无屏障会误杀谁？Dijkstra 和 SATB 分别在哪一步出手？',
  },
  {
    id: 'cgc-floating-garbage',
    label: 'SATB 代价 · 浮动垃圾（安全但推迟回收）',
    code: 'heap A B C\nroot A\nedge A -> B\nedge B -> C\n%%\nmark-step\ncut B -> C\nmark-all\nsweep',
    prediction: '这次没有执行 link A -> C，C 真的变成垃圾了。为什么 SATB 本轮仍会保活 C？',
  },
  {
    id: 'cgc-chain-rescue',
    label: '多跳白链 · 染灰 C 后顺藤摸瓜保住 E',
    code: 'heap A B C E\nroot A\nedge A -> B\nedge B -> C\nedge C -> E\n%%\nmark-step\nlink A -> C\ncut B -> C\nmark-all\nsweep',
    prediction: '写屏障只把直接目标 C 染灰，没有碰 E。最终 C 和 E 都能保住吗？无屏障会误杀几个？',
  },
  {
    id: 'cgc-new-alloc',
    label: '并发分配 · 标记中途 alloc F（分配即涂黑）',
    code: 'heap A B\nroot A\nedge A -> B\n%%\nmark-step\nalloc F\nmark-all\nsweep',
    prediction: '标记进行到一半时业务线程新分配了可达对象 F。不涂黑会怎样？Allocate-Black 又会怎样？',
  },
  {
    id: 'cgc-safe-one-cond',
    label: '对照 · 仅黑指白但灰链未断（无漏标）',
    code: 'heap A B C\nroot A\nedge A -> B\nedge B -> C\n%%\nmark-step\nlink A -> C\nmark-all\nsweep',
    prediction: '虽然发生了黑对象 A 指向白对象 C，但灰对象 B 仍保留着到 C 的边。无屏障会误杀 C 吗？',
  },
];
