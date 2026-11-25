import type { Lesson } from './lessons';

export const coroutineLesson: Lesson = {
  id: 'coroutine',
  number: '26',
  title: '协程与状态机改写',
  english: 'Stackless coroutines & state-machine lowering',
  question: '无栈协程不用独立调用栈，怎么暂停又能从原位置恢复？',
  intro:
    '对应第 34 讲：编写带 yield 的协程与 resume 驱动代码，先用跨挂起点活跃分析区分“提升到协程帧的变量”和“栈上临时变量”，再把协程降级成显式 switch(state) 状态机，与独立原生生成器对照执行。',
  chapter: '34',
  minutes: 22,
  icon: '⏸',
  color: 'orange',
  walkthrough: [
    {
      title: '有栈协程 vs 无栈协程',
      body: '有栈协程（如 Go goroutine）为每个协程分配独立栈空间，切换时保存寄存器并切换栈指针；而无栈协程（如 C# yield / async、Rust async/await、Kotlin suspend、C++20 coroutine）不单独分配调用栈，而是靠编译器把协程体改写成一个普通的状态机函数！',
    },
    {
      title: '第一步：给每个 yield 编一个状态号',
      body: '协程刚创建时 state = 0（还没开始跑）。每遇到一个 yield 语句，编译器就在它后面放一个恢复标签 S1_entry、S2_entry……：执行到 yield 时，先把 frame.state 改成下一状态号，直接 return 交出控制权；下次 resume 时，函数开头用 switch(frame.state) 跳回上次停下的位置！',
      example: 'switch (frame->state) {\n  case 0: goto S0_entry;\n  case 1: goto S1_entry;\n  default: error("DONE");\n}',
      exampleLanguage: 'c',
    },
    {
      title: '第二步：哪些变量必须搬进协程帧（活跃分析）？',
      body: '每次 yield 都会让当前函数的普通调用栈彻底弹出！因此编译器会做一遍数据流活跃性分析（复用实验 08 的思想）：凡是在某个恢复点 S1、S2…… 之后还会被读取的变量（如循环计数器 i、上限 n），必须提升进堆上的协程帧结构体；而只在两次 yield 之间临时算完就丢的变量（如 let doubled = i * 2; yield doubled;），完全可以留在临时栈，不必占协程帧空间！',
    },
    {
      title: '多协程交替推进，共享同一个调用栈',
      body: '你可以同时创建两个协程帧 g1 = range(3) 和 g2 = fib(4)，在驱动代码里交替 resume(g1) 和 resume(g2)。每次 resume 都是一次普通的短函数调用：进来切状态、算几步、写回 frame.state、立刻返回——这正是现代 async/await 能支撑百万级并发任务的底层秘密。',
    },
    {
      title: '用独立参考模型核对降级正确性',
      body: '页面一方面运行真正降级后的 switch(state) 状态机驱动器（每次 yield 清空临时栈，只留 frame 字段），另一方面用直接遍历 AST 的独立生成器跑一遍，核对每一次产出值、返回值和异常是否完全一致。',
    },
  ],
  note: [
    {
      title: '状态机改写把“暂停/恢复”变成纯数据结构',
      body: '无栈协程在运行时没有任何神秘的栈切换指令：挂起只是更新整数 state 并 return，恢复只是 switch(state) 跳转，执行开销接近普通函数调用。',
    },
    {
      title: '跨 yield 活跃分析直接决定协程帧大小',
      body: '这也是为什么 Rust 和 C++20 编译器非常重视跨 await 变量的生命周期：减少跨越挂起点的无用变量，就能直接缩小每个异步任务的内存占用。',
    },
    {
      title: '创建协程 ≠ 立即执行',
      body: '执行 let g = range(3) 只是分配协程帧并把 state 置为 0；直到第一次调用 resume(g)，状态机才真正从 case 0 启动，运行到第一个 yield 或 return。',
    },
  ],
  misconception:
    '“协程里的每一个局部变量都会被保存到堆上的协程帧里”是误解：只有生命周期跨越了至少一个 yield（在恢复点入口活跃）的变量才需要放进帧结构体，不跨 yield 的临时变量依然留在普通调用栈上。',
  limit:
    '教学无栈协程方言支持单层 coro、let/赋值、if/else、while、yield、return，驱动侧支持创建、resume(g)、done(g) 与 print，限制 2000 字符与 2000 步执行。不支持嵌套协程调用（await 另一个协程）、向 yield 反向传值或异步事件循环调度器。',
  challenge:
    '运行“循环生成器 + 临时变量”预设，观察编译结果中 i 和 n 为什么被提升进 rangeFrame，而 doubled 却留在临时栈。再把 doubled 改成在 yield 之后再次读取，看看它会不会被自动提升进协程帧。',
  answer:
    '在原预设中，doubled 在 yield doubled 之后不再被读取，活跃性分析确认它在 S1_resume 入口不活跃，因此不进入 rangeFrame；而 i 和 n 在恢复后还要用于 i = i + 1 和 i < n，必须提升进帧结构体。如果在 yield 之后加上一句读取 doubled（例如 i = i + doubled - doubled + 1），活跃性分析会立刻把 doubled 也提升进 rangeFrame。',
  quiz: {
    question: '在无栈协程的状态机改写中，一个局部变量在什么时候必须提升到堆上的协程帧（Coroutine Frame）中？',
    options: [
      '只要它是协程内部声明的变量就必须提升',
      '当它的值在某个 yield 挂起之前定义，且在恢复执行之后还会被读取（跨 yield 活跃）时',
      '只有循环变量才需要提升，普通变量不需要',
    ],
    correct: 1,
    explain: '挂起时普通调用栈会被弹出，因此只有生命周期跨越挂起点（在恢复点入口仍活跃）的变量才必须存进协程帧；在两次挂起之间产生并消费完毕的临时变量留在普通栈上即可。',
  },
};

export const coroutinePresets = [
  {
    id: 'co-range',
    label: '协程 · 循环生成器与跨 yield 活跃分析',
    code: 'coro range(n) {\n  let i = 0;\n  while (i < n) {\n    let doubled = i * 2;\n    yield doubled;\n    i = i + 1;\n  }\n  return i;\n}\n\nlet g = range(3);\nprint(resume(g));\nprint(resume(g));\nprint(resume(g));\nprint(resume(g));\nprint(done(g));',
    prediction: 'range 里有 n、i、doubled 三个变量，哪几个必须放进 rangeFrame，哪一个可以留在临时栈？',
  },
  {
    id: 'co-multi-yield',
    label: '协程 · 多个连续 yield 挂起点（多状态切换）',
    code: 'coro steps(base) {\n  let x = base + 1;\n  yield x;\n  x = x * 10;\n  yield x;\n  let bonus = 5;\n  yield x + bonus;\n  return x + bonus + 1;\n}\n\nlet s = steps(2);\nwhile (done(s) == false) {\n  print(resume(s));\n}',
    prediction: '三个 yield 会生成几个状态（case）？bonus 跨不跨 yield？',
  },
  {
    id: 'co-interleave',
    label: '并发交替 · 两个协程帧交替 resume（共享单栈）',
    code: 'coro fib(limit) {\n  let a = 0;\n  let b = 1;\n  let k = 0;\n  while (k < limit) {\n    yield a;\n    let next = a + b;\n    a = b;\n    b = next;\n    k = k + 1;\n  }\n  return a;\n}\n\ncoro countdown(start) {\n  let cur = start;\n  while (cur > 0) {\n    yield cur;\n    cur = cur - 1;\n  }\n  return 0;\n}\n\nlet f = fib(4);\nlet c = countdown(3);\nprint(resume(f));\nprint(resume(c));\nprint(resume(f));\nprint(resume(c));\nprint(resume(f));',
    prediction: '交替 resume(f) 和 resume(c) 时，它们如何各记各的 state 和帧字段而互不覆盖？',
  },
  {
    id: 'co-branch-yield',
    label: '协程 · 分支内部的 yield 挂起',
    code: 'coro pick(flag) {\n  if (flag == 1) {\n    yield 100;\n  } else {\n    yield 200;\n  }\n  return 999;\n}\n\nlet a = pick(1);\nlet b = pick(0);\nprint(resume(a));\nprint(resume(b));\nprint(resume(a));\nprint(resume(b));',
    prediction: '两个分支里的 yield 各自有独立状态号。恢复后它们都汇合到 return 999 吗？',
  },
  {
    id: 'co-resume-done',
    label: '反例 · 对已 DONE 的协程再次 resume',
    code: 'coro once(v) {\n  yield v;\n  return v + 1;\n}\n\nlet g = once(7);\nprint(resume(g));\nprint(resume(g));\nprint(resume(g));',
    prediction: '第二次 resume 返回 8 并把状态置为 DONE。第三次 resume 会怎样？',
  },
];
