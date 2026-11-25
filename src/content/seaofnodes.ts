import type { Lesson } from './lessons';

export const seaOfNodesLesson: Lesson = {
  id: 'seaofnodes',
  number: '30',
  title: 'Sea of Nodes 与去优化',
  english: 'Sea of Nodes IR & speculative deoptimization',
  question: '控制流和数据流放进同一张图后，JIT 怎么敢直接删掉一半分支？',
  intro:
    '对应第 14、15 讲（Graal / V8 TurboFan）：构建整合控制边（红）、浮动数据边（蓝）与 FrameState（绿）的 Sea of Nodes 图状 IR，观察规范化（Canonicalizer）、GVN 合并、循环外自动浮动，以及基于 profile 的投机剪枝与 FrameState 逆优化回退。',
  chapter: '14',
  minutes: 22,
  icon: '◉',
  color: 'blue',
  walkthrough: [
    {
      title: '传统 CFG + SSA 把指令“锁死”在基本块里',
      body: '在实验 07 和实验 13 里，每条三地址指令都必须隶属于某个基本块。像原书第 14 讲循环里的 b = a * 2，哪怕它根本不依赖循环变量，也必须先写进循环体块，再靠专门的循环不变代码外提（LICM）算法搬出去。',
    },
    {
      title: 'Sea of Nodes：固定控制节点 + 浮动数据节点',
      body: 'Graal 和 V8 TurboFan 把控制流图（红色控制边：Start / If / Merge / Loop / Return）和数据流图（蓝色数据边：Param / Add / Mul / Phi）统一到同一张图里。纯计算节点是“浮动的（Floating）”，只连着它们依赖的数据，不绑死在基本块里——所以循环里的 a * 2 天生就浮在循环脊柱之外！',
      example: 'fn sumLoop(a, n) {\n  let sum = 0; let i = 0;\n  while (i < n) { let b = a * 2; sum = sum + b; i = i + 1; }\n  return sum;\n}',
      exampleLanguage: 'c',
    },
    {
      title: 'Canonicalizer 与 GVN：直接在节点之海里局部改写',
      body: '原书第 14 讲展示了 Graal 的规范化（CanonicalizerPhase）：2 * a 改写为左移 a << 1、双重取负 -(-a) 直接消掉、常量运算折叠；同时相同运算符和相同输入的浮动节点（如两处 a + b）通过全局值编号（GVN）直接合并为同一个节点。',
    },
    {
      title: '基于推理的优化：profile 从未走过的冷分支直接剪掉',
      body: '看原书第 15 讲的 atLeastTen(a)：如果解释器收集的 profile 样例全部满足 a >= 10，JIT 就会大胆把 If 改写成 FixedGuard，直接删掉 a < 10 的冷分支，大幅精简图结构。',
    },
    {
      title: '绿色 FrameState 兜底：猜错了就触发逆优化（Deoptimization）',
      body: '万一以后真传进来一个 atLeastTen(3) 怎么办？图里在守卫失败的出口挂着 Deopt 节点和绿色的 FrameState（保存了解释器局部变量状态）：运行时一旦守卫失败，立刻用 FrameState 恢复栈帧并无缝切回基线解释器算完，保证结果 100% 正确！',
    },
  ],
  note: [
    {
      title: '声明式图 IR vs 命令式线性 IR',
      body: '原书第 14 讲特别区分了命令式 IR（如三地址代码，一步步写动作）与声明式 IR（Sea of Nodes，直接描述节点间的控制与数据依赖关系），直到后端调度前才把浮动节点排进具体基本块。',
    },
    {
      title: '固定节点保护副作用与内存顺序',
      body: '并不是所有节点都能浮动：控制分支、返回、守卫，以及对同一内存地址的 load/store 必须作为固定节点（FixedNode）串在控制流脊柱上，确保执行顺序不被打乱。',
    },
    {
      title: 'FrameState 让激进 JIT 既快又安全',
      body: 'AOT 编译器看不到运行期统计，必须保守生成所有冷分支代码；JIT 借助 profile 剪掉冷路径，并用 FrameState + Deoptimization 兜底，这就是原书第 15 讲强调的“全生命周期优化”优势。',
    },
  ],
  misconception:
    '“投机优化剪掉冷分支后，如果遇到罕见输入程序就会算错或崩溃”是误解：编译器在裁剪点插入了 FixedGuard + Deopt(FrameState)，遇到违背推测的输入会恢复解释器栈帧继续执行，只损失这一次回退开销，不会破坏语义正确性。',
  limit:
    '教学 Sea of Nodes 方言支持单函数（最多 4 参数）、整数算术与比较、if/else、while、profile 与 run 样例组，限制 2000 字符与 2000 步执行。实现固定控制节点、浮动数据节点、Canonicalizer（折叠 / 2·4 倍强度折减 / 双负号）、GVN 合并、循环外自动浮动标注、单边冷分支 Guard + Deopt 剪枝与独立解释器核对；不模拟内存效应边（Memory Graph）、Graal Low-Tier 降级或真实栈帧 OSR 替换。',
  challenge:
    '先看“原书第 15 讲：atLeastTen 投机剪枝与逆优化”预设，观察 profile 全为 >= 10 时图如何被裁剪，以及 run (18) 和 run (3) 分别走了哪条路径。接着往 profile 里加一个 (2)，看看 Guard 和 Deopt 会不会消失。',
  answer:
    '当 profile 只有 (12), (25), (40) 时，a < 10 分支命中 0 次，JIT 用 FixedGuard + Deopt 剪掉了 return 10 的冷分支；于是 run (18) 直接走快路径返回 18，而 run (3) 触发守卫失败，经 FrameState 恢复 a=3 回退基线解释器安全返回 10。一旦往 profile 加入 (2)，两条分支都变热，投机剪枝不再触发，图保留完整 If / True / False 结构。',
  quiz: {
    question: '在 Graal 的 Sea of Nodes 图中，绿色的 FrameState 节点最核心的用途是什么？',
    options: [
      '用来把循环里的乘法转换成移位运算',
      '记录解释器栈帧的局部变量等状态，在投机优化守卫失败触发逆优化（Deoptimization）时恢复现场回退解释器',
      '用来替代所有控制流节点，删除 Start 和 Return',
    ],
    correct: 1,
    explain: 'FrameState 保存安全点处的解释器栈帧信息，使 JIT 能在投机假设被打破时安全降级回解释器执行（也可用于调试信息）。',
  },
};

export const seaOfNodesPresets = [
  {
    id: 'son-at-least-ten',
    label: '原书第 15 讲 · atLeastTen 投机剪枝与逆优化',
    code: 'fn atLeastTen(a) {\n  if (a < 10) {\n    return 10;\n  } else {\n    return a;\n  }\n}\nprofile (12), (25), (40)\nrun (18), (3)',
    prediction: 'profile 全部 >= 10：JIT 会剪掉哪条分支？运行 (18) 和 (3) 时谁会触发 Deopt？',
  },
  {
    id: 'son-doif',
    label: '原书第 14 讲 · doif 控制流与数据流双图（Phi 汇合）',
    code: 'fn doif(x, y) {\n  let z = 0;\n  if (x < 2) {\n    z = x + y;\n  } else {\n    z = x * y;\n  }\n  return z;\n}\nprofile (1, 5), (4, 5)\nrun (1, 5), (4, 5)',
    prediction: '两条分支在 profile 中都热：图里会出现哪些固定控制节点和浮动数据节点（Phi）？',
  },
  {
    id: 'son-canonical',
    label: '原书第 14 讲 · Canonicalizer 规范化 + GVN 节点合并',
    code: 'fn simplify(a, b) {\n  let d = 2 * a;\n  let n = -(-b);\n  let s1 = a + b;\n  let s2 = b + a;\n  return d + n + s1 + s2;\n}\nprofile (3, 4)\nrun (3, 4), (10, -2)',
    prediction: '2 * a、-(-b) 以及重复的 a + b / b + a 在规范化与 GVN 后会变成什么？',
  },
  {
    id: 'son-float-loop',
    label: '原书第 14 讲 · 循环不变量天生浮动在循环之外',
    code: 'fn sumLoop(a, n) {\n  let sum = 0;\n  let i = 0;\n  while (i < n) {\n    let b = a * 2;\n    sum = sum + b;\n    i = i + 1;\n  }\n  return sum;\n}\nprofile (5, 4)\nrun (5, 4), (7, 3)',
    prediction: '循环体里的 a * 2 只依赖参数 a，在 Sea of Nodes 中它需要绑在循环基本块里吗？',
  },
  {
    id: 'son-cold-true',
    label: '对照 · 反向投机（只走 < 10 分支，>= 10 触发 Deopt）',
    code: 'fn atLeastTen(a) {\n  if (a < 10) {\n    return 10;\n  } else {\n    return a;\n  }\n}\nprofile (1), (4), (9)\nrun (5), (22)',
    prediction: '这次 profile 全部小于 10（类似原书第 15 讲图 10 的 i % 10）：剪枝方向会反转吗？',
  },
];
