import { BOOK } from './lessons';
import type { AssemblyTopic } from '../compiler/assembly/model';

export const ASSEMBLY_TITLE = '编译中的汇编速查';
export const assemblyBookReferences = [
  {
    number: '08',
    title: '代码生成：如何实现机器相关的优化？',
    file: '08 代码生成：如何实现机器相关的优化？.md',
    focus: 'x86 / ARM 对照、指令选择、寄存器分配与指令排序。',
  },
  {
    number: '16',
    title: 'Java JIT编译器（四）：Graal的后端是如何工作的？',
    file: '16 Java JIT编译器（四）：Graal的后端是如何工作的？.md',
    focus: '从 HIR 到 LIR，再观察 LEA、内存操作合并和冗余复制消除。',
  },
].map((item) => ({ ...item, url: `${BOOK}/${encodeURIComponent(item.file)}` }));

export const assemblyReadingConventions = [
  {
    place: '原书第 08 讲 / x86 示例',
    syntax:
      'GNU / AT&T：源在左，目标在右；% 标寄存器，$ 标立即数。movl / addl 的 l 表示 32 位，pushq / movq 的 q 表示 64 位。',
    parameters:
      '示例的两个整数参数在 EDI、ESI，返回值在 EAX。出现 RBP / RSP 等 64 位寄存器，按 x86-64 代码阅读。',
  },
  {
    place: '原书第 16 讲 / Graal 示例',
    syntax:
      '示例采用目标在左的 Intel 风格。先辨认每条指令的读写方向，再看 HIR / LIR 如何落到目标代码。',
    parameters:
      '书中 Java 示例用 ESI、EDX 保存两个参数。它有 JVM / Graal 的调用上下文，不能套用普通 C 函数或 Windows 的传参表。',
  },
  {
    place: '本附录 / 可交互对照',
    syntax:
      '统一使用 Intel 语法，目标在左。源码与指令是独立编写的教学模板，不是原书汇编的逐行复刻。',
    parameters:
      '采用 Windows x64 ABI：本例两个整数参数取 ECX、EDX，32 位返回值在 EAX。平台不同，寄存器安排可能不同。',
  },
];

export const bookInstructionGroups = [
  {
    name: 'MOV / movl / movq',
    chapter: '08、16',
    task: '在寄存器与内存之间传送值',
    reading: '先看方向与宽度，再看有没有内存操作数。普通 x86 MOV 的两个操作数不能同时是内存。',
    form: 'Intel: mov eax, ecx\nAT&T:  movl %ecx, %eax',
  },
  {
    name: 'ADD / addl',
    chapter: '08、16',
    task: '把加法结果写回目标',
    reading: 'x86 常见的双操作数加法会覆盖目标。做中间表示到指令的对应时，注意旧值何时被覆盖。',
    form: 'Intel: add eax, 6\nAT&T:  addl $6, %eax',
  },
  {
    name: 'LEA / leal',
    chapter: '08、16',
    task: '计算地址表达式，也可承担整数计算',
    reading:
      '它算出表达式的值，不读取所指内存，也不修改算术标志。比例因子只可取 1、2、4、8；它不是通用乘法指令。',
    form: 'lea eax, [rcx + rdx*2 + 6]',
  },
  {
    name: 'PUSH / POP / RET',
    chapter: '08',
    task: '识别函数序曲、尾声与返回',
    reading:
      'PUSH / POP 常用于保存、恢复寄存器，RET 取回返回位置。优化后可能省略帧指针；不能期待每个函数都有同一套序曲。',
    form: 'push rbp\nmov rbp, rsp\n...\npop rbp\nret',
  },
  {
    name: 'ARM：LDR / STR',
    chapter: '08',
    task: '区分加载与存储',
    reading:
      '原书还比较 ARMv7 代码：LDR 从内存加载，STR 向内存存储。不要把 x86 的指令名与寻址写法直接套到 ARM。',
    form: '此处只帮助识别原书示例；未接入 ARM 模拟器。',
  },
  {
    name: 'ARM：ADD / SUB / BX',
    chapter: '08',
    task: '识别运算、栈调整与返回',
    reading:
      '书中通过 ADD / SUB 调整 SP，并用 BX LR 返回。LR 是该 ARM 示例保存返回地址的寄存器，不能把它当作 x86 的栈返回机制。',
    form: '同一项高级语言工作，可由不同架构的指令完成。',
  },
];

export const assemblyCompilerPatterns: {
  title: string;
  chapter: string;
  question: string;
  explanation: string;
  before: string;
  after: string;
  limit: string;
  topic: AssemblyTopic;
  action: string;
}[] = [
  {
    title: 'LEA 为什么出现在加法里？',
    chapter: '08、16',
    question: '看到方括号，是否就发生了内存读取？',
    explanation:
      '指令选择可以借助“基址 + 索引 × 比例 + 偏移”完成一部分整数运算，并把结果直接写到所需寄存器。本例是独立编写的等值形式。',
    before: 'mov eax, ecx\nadd eax, edx\nadd eax, 6',
    after: 'lea eax, [rcx + rdx + 6]',
    limit:
      '两者的低 32 位结果相同，但 ADD 改标志，LEA 不改。只有后续不依赖这些标志时，才可把它们视为此处可替换的结果计算。指令更少也不保证在每种 CPU 上都更快。',
    topic: 'memory',
    action: '动手区分 LEA 与内存读取',
  },
  {
    title: '为什么数组访问能合成一条指令？',
    chapter: '08',
    question: '地址计算是否必须先占用一个临时寄存器？',
    explanation:
      'x86 内存操作数可以携带缩放索引。对 4 字节元素，编译器可能把地址计算并入读取，不必显式保留临时地址。',
    before: 'lea r8, [rcx + rdx*4]\nmov eax, DWORD PTR [r8]',
    after: 'mov eax, DWORD PTR [rcx + rdx*4]',
    limit:
      '原书也讨论了数组写入；这里用读取演示同一种地址表达能力。临时寄存器的值若仍有其他用途，就不能直接删掉它。',
    topic: 'memory',
    action: '切换两种数组读取方式',
  },
  {
    title: '优化后，变量和 MOV 去哪了？',
    chapter: '08、16',
    question: '高级语言里一个变量，是否必须固定占一块栈内存？',
    explanation:
      '寄存器分配把虚拟位置对应到物理寄存器；合适的位置安排可消除复制。值留在参数寄存器或直接进入返回寄存器时，来回落栈和多余 MOV 可能消失。寄存器不足时，也可能溢出到栈。',
    before: '表达式 → 临时值\n临时值 → 返回寄存器',
    after: '表达式 → 直接放入返回寄存器',
    limit:
      '这不是删去变量语义，而是改变值的存放位置。原书第 16 讲中的 LIR 指令名也不应全当作最终 CPU 指令。本项目尚未实现寄存器分配算法。',
    topic: 'arithmetic',
    action: '跟踪参数与返回值的位置',
  },
  {
    title: '为什么加载指令被提前了？',
    chapter: '08',
    question: '机器指令的先后为何与源码行序不完全一致？',
    explanation:
      '在依赖关系允许时，编译器可把加载提前，让中间的独立工作覆盖一部分等待时间。读汇编时，要追踪“谁产生这个值、谁使用它”，而不只按源码行号对齐。',
    before: '准备使用某个值\n加载该值\n立即消费该值',
    after: '提前加载该值\n完成独立的工作\n消费已加载的值',
    limit:
      '必须保留数据依赖、可能别名、异常和可观察副作用的约束。这里是排序思路示意，不是 CPU 时序仿真，也不把所有 ARM 或 x86 处理器视作同一种流水线。',
    topic: 'loop',
    action: '回看循环中的值依赖',
  },
];

export const independentAssemblyCourse = [
  '先建立机器模型：数值与位、字节和地址、CPU / 寄存器 / 内存各做什么。',
  '再认识体系关系：8086 的 16 位模型、80386 的 32 位扩展，以及 x86-64 的 64 位环境；分清架构、语法和操作系统约定。',
  '沿着赋值 → 运算 → 判断 → 循环 → 数组 → 函数推进，每次都用简单高级语言对照，并允许逐步修改机器状态。',
  '最后再谈栈帧、调用约定和编译器优化；8086 分段与中断另作历史环境单元，避免把旧机制直接套到现代代码。',
];
