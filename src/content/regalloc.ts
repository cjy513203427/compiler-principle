import type { Lesson } from './lessons';
import { T } from '../i18n';

export const REGALLOC_REFERENCE = 'https://www.cs.cornell.edu/courses/cs4120/2026sp/notes/regalloc/';
export const regallocLesson: Lesson = {
  id: 'regalloc', number: '17', title: T('寄存器分配'), english: 'Register allocation',
  question: T('只有 K 个寄存器，哪些值留下，哪些放回栈里？'),
  intro: T('从活跃变量分析继续：把三地址代码里无限多的变量和临时值，分配到 K 个寄存器。用图着色和线性扫描两种算法，观察干涉、溢出与插入的 load / store，再在寄存器机上执行核对。'),
  chapter: '08', minutes: 25, icon: '▦', color: 'orange',
  walkthrough: [
    { title: T('IR 假设寄存器无限，机器只有 K 个'), body: T('实验 04 生成的三地址代码随手创建 t0、t1……，相当于假设有无限多个虚拟寄存器。真实 CPU 只有有限个物理寄存器。寄存器分配为每个值找一个寄存器；放不下的值溢出（Spill）到栈槽，代价是额外的内存读写。'), example: T('t0 = v0_a + v1_b\nt1 = v2_c + v3_d\nt2 = t0 * t1\n// K = 3 时，a、b、c、d、t0、t1 不能同时都在寄存器里'), exampleLanguage: 'text' },
    { title: T('先问：哪些值同时还要用？'), body: T('实验 08 按基本块求活跃变量，这里细化到每一条指令之后：从最后一条往前推，读取加入、写入移出。某个位置同时活跃的值个数叫寄存器压力；压力超过 K，就必定有值不能留在寄存器里。') },
    { title: T('两值同时活跃，就不能共用寄存器'), body: T('写入 x 时，此后仍要读取的每个 y 都与 x 连一条干涉边（Interference）。连边的两个值必须分到不同寄存器，于是分配就变成“用 K 种颜色给图着色，相邻点颜色不同”。复制 x = y 之后两者的值相同，所以这一条不与 y 连边，留给它们分到同一寄存器的机会。'), example: T('v2_i = 0      // 写入 i 时 sum 仍活跃 → i — sum\nt3 = v2_i + 1\nv2_i = t3     // 复制：i 不与 t3 连边'), exampleLanguage: 'text' },
    { title: T('图着色：先移出容易的点'), body: T('度数少于 K 的点，无论邻居怎样着色，总还剩一种颜色，所以可以先压栈移出，图随之变小（Kempe / Chaitin 的简化）。所有点度数都 ≥ K 时，按“溢出代价 ÷ 度数”选一个“可能溢出”的点压栈。最后逐个弹出着色；可能溢出的点若仍有空色就保住，否则真正溢出（Briggs 的乐观着色）。') },
    { title: T('线性扫描：按程序顺序发放寄存器'), body: T('把每个值活跃的位置合成一个从首次到最后一次的区间，按起点排序扫描：已结束的区间释放寄存器；没有空寄存器时，溢出结束得最晚的那个区间。它只扫描一遍，速度快，常用于 JIT；但区间忽略中间不活跃的空洞，有时会比图着色多溢出。'), example: T('“区间空洞”预设：t 在 #0 定义、#1 使用，#6 重新赋值、#7 使用\n区间：[后 #0, 前 #7]，中间 #2–#5 其实不活跃'), exampleLanguage: 'text' },
    { title: T('溢出之后要重写并重来'), body: T('溢出的值改放在栈槽：每次读取前插入 load，每次写入后插入 store，用只活一条指令的新临时值 x~n 承接。程序变了，活跃性和冲突也变了，所以要重新分析和分配，直到不再溢出。本页把 x~n 标记为不可再溢出；K ≥ 2 时一定能结束。') },
  ],
  note: [
    { title: T('活跃区间决定冲突'), body: T('是否冲突看的是“同时还要用”，与变量名、声明位置无关。一个变量重新赋值后，前后两段可以分到不同空隙；而不同变量只要生存期不重叠，也能共用同一个寄存器。') },
    { title: T('溢出代价看使用频率'), body: T('原书提到应把寄存器留给使用最频繁的变量，例如循环中的变量。本页的图着色以使用与定义次数计算代价，每深一层循环乘 10，循环外只用一次的值最先被选为溢出候选。线性扫描不看频率，只看区间结束位置。') },
    { title: T('分配之后再执行核对'), body: T('分配结果先经独立检查：每次写入都不能覆盖此后仍要读取的值；再把变量名换成寄存器名，由寄存器机逐条执行，比较输出与错误是否与原始 VM 一致。比较只说明这一次运行一致，不是一般性的等价证明。') },
  ],
  misconception: T('“变量比寄存器多就一定要溢出”混淆了变量个数与同时活跃的个数。生存期不重叠的值可以轮流使用同一个寄存器；只有某处的寄存器压力超过 K 才必须溢出。反过来，图着色与线性扫描都是启发式：某个程序上图着色也可能比线性扫描溢出更多，二者都不保证最少的 load / store。'),
  limit: T('分配对象是未优化的原始三地址代码，让每个临时值和寄存器压力都可见；真实编译器通常在优化与指令选择之后、在低层 IR 上分配。K 可选 2–8，寄存器全部等价，没有调用约定、预着色、调用者/被调者保存或寄存器类别。图着色为 Chaitin 简化 + Briggs 乐观着色，溢出代价为“使用与定义次数 × 10^循环深度 ÷ 度数”（本项目选定的启发式），弹出时偏好复制另一端的寄存器，但没有复制合并（Coalescing）、活跃区间拆分、重新物化或栈槽复用。线性扫描采用 Poletto & Sarkar 的整区间做法，按 IR 文本顺序编号。寄存器机是教学格式，不是 x86 或 ARM 指令，也没有生成机器码。程序最多 2000 字符，溢出重写最多 16 轮，IR 最多 10000 条，寄存器机最多 2000 条指令；分配与执行回放各保留前 240 步，最终结果完整。'),
  challenge: T('选默认的循环预设，先用 K = 3 的图着色，指出被溢出的两个值和循环中每轮多出的内存访问；切换到线性扫描比较溢出了谁。再选“区间空洞”，把 K 改为 2，解释为何线性扫描要溢出而图着色不用。'),
  answer: T('图着色溢出 offset 与 scale：offset 在循环外只定义一次、使用一次，代价最低；scale 每轮读取一次，于是循环里每轮多一条 load。i 与 sum 每轮都读写，代价高，留在寄存器。线性扫描只看区间结束位置，sum 和 offset 都活到最后，先被溢出，循环内的内存访问更多。区间空洞预设中，t 在中间一段并不活跃，干涉图里它与 a、b 没有边，可以共用；线性扫描把 t 的首尾连成一个区间，与 a、b 重叠，K = 2 时放不下。'),
  quiz: { question: T('在图着色分配中，为什么可以先移出度数小于 K 的点？'),
    options: [T('它的值不会被使用，可以删除'), T('无论邻居怎样着色，它最多占用 K − 1 种颜色，总还剩一种'), T('度数小的点一定会被溢出')], correct: 1,
    explain: T('移出它不影响其余部分能否着色：等其余点着色完再放回来，最多 K − 1 个邻居占去 K − 1 种颜色，还剩一种给它。') },
};
export const regallocPresets = [
  { id: 'ra-loop', label: T('寄存器分配 · 循环里的值优先留下'),
    code: 'int offset = 100;\nint scale = 3;\nint i = 0;\nint sum = 0;\nwhile (i < 5) {\n  sum = sum + i * scale;\n  i = i + 1;\n}\nprint(sum + offset);',
    prediction: T('K = 3 时放不下全部活跃值。offset 只在循环外用一次，i、sum 每轮都读写；你认为谁先被溢出？') },
  { id: 'ra-pressure', label: T('寄存器分配 · 一条表达式的压力'),
    code: 'int a = 1;\nint b = 2;\nint c = 3;\nint d = 4;\nprint((a + b) * (c + d));\nprint(a + b + c + d);',
    prediction: T('计算 (a + b) * (c + d) 时，a、b、c、d 之后还要再用。最少需要几个寄存器才完全不溢出？') },
  { id: 'ra-holes', label: T('寄存器分配 · 区间空洞'),
    code: 'int t = 1;\nprint(t);\nint a = 2;\nint b = 3;\nprint(a + b);\nt = 5;\nprint(t);',
    prediction: T('K = 3 时两种算法都不溢出。把 K 改为 2，哪种算法会溢出？t 在中间一段是否活跃？') },
  { id: 'ra-copy', label: T('寄存器分配 · 复制两端同一寄存器'),
    code: 'int a = 5;\nint b = a;\nint c = b;\nprint(c);',
    prediction: T('复制 b = a 不让 a、b 连边。a、b、c 会不会分到同一个寄存器，复制指令还剩几条？') },
  { id: 'ra-trap', label: T('寄存器分配 · 溢出后保留除零'),
    code: 'int a = 10;\nint b = 0;\nint c = 7;\nprint(a + c);\nprint(a / b);\nprint(c);',
    prediction: T('插入 load / store 后，除零错误之前的输出 17 还会保留吗？错误之后的 print(c) 会执行吗？') },
  { id: 'ra-nested', label: T('寄存器分配 · 嵌套循环与溢出代价'),
    code: 'int i = 0;\nint total = 0;\nint unused = 42;\nwhile (i < 3) {\n  int j = 0;\n  while (j < 3) {\n    total = total + i * j;\n    j = j + 1;\n  }\n  i = i + 1;\n}\nprint(total);\nprint(unused);',
    prediction: T('内层循环的值代价乘 100。K = 3 时，图着色会溢出 unused 和哪个外层值？线性扫描的内存访问多多少？') },
];
