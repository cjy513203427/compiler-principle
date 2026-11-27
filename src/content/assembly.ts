import type { AssemblyNoteId, AssemblyTopic, AssemblyParameters } from '../compiler/assembly/model';
import { T } from '../i18n';
export const DEFAULT_ASSEMBLY: AssemblyParameters = {
  a: 2,
  b: 3,
  n: 4,
  array: [10, 20, 30, 40],
  index: 2,
  unsigned: false,
  addressFirst: false,
  alias: 'EAX',
  registerHex: '1122334455667788',
  writeHex: 'AA',
};
export function defaultParameters(topic: AssemblyTopic): AssemblyParameters {
  return {
    ...DEFAULT_ASSEMBLY,
    array: [...DEFAULT_ASSEMBLY.array],
    ...(topic === 'branch' ? { a: -1, b: 1 } : {}),
  };
}
export const ASSEMBLY_SOURCES = [
  {
    title: T('Microsoft · x64 寄存器与子寄存器'),
    url: 'https://learn.microsoft.com/en-us/windows-hardware/drivers/debugger/x64-architecture',
  },
  {
    title: T('Microsoft · Windows x64 调用约定'),
    url: 'https://learn.microsoft.com/en-us/cpp/build/x64-calling-convention',
  },
  {
    title: T('Intel · 指令参考手册（Volume 2）'),
    url: 'https://www.intel.com/content/www/us/en/developer/articles/technical/intel-sdm.html',
  },
];
export interface AssemblyTopicInfo {
  id: AssemblyTopic;
  noteId: AssemblyNoteId;
  title: string;
  question: string;
  intro: string;
  prediction: string;
  notes: { title: string; body: string }[];
  misconception: string;
  challenge: string;
  answer: string;
  quiz: { question: string; options: string[]; correct: number; explain: string };
}
export const assemblyTopics: AssemblyTopicInfo[] = [
  {
    id: 'arithmetic',
    noteId: 'assembly-arithmetic',
    title: T('赋值与加法'),
    question: T('变量的值，是怎样进入寄存器的？'),
    intro: T('从一个加法函数开始。修改参数，单步观察 MOV 复制、ADD 写回，以及返回值的位置。'),
    prediction: T('执行 MOV 后，作为源的 ECX 会被清空吗？修改参数后，哪些寄存器会改变？'),
    notes: [
      {
        title: T('先确定两侧的约定'),
        body: T(
          '本附录统一使用 x86-64、Intel 语法与 Windows x64 ABI。32 位参数 a、b 分别取自 ECX、EDX，32 位返回值放在 EAX。整数输入会按 uint32_t 转换，高位模式与有符号解释可在状态表中同时查看。',
        ),
      },
      {
        title: T('MOV 是复制，ADD 把结果写回左边'),
        body: T(
          'mov eax, ecx 把 ECX 的值复制到 EAX，ECX 保留。随后 add eax, edx 计算 EAX + EDX，结果写回 EAX。本例 uint32_t 加法按 2³² 回绕；不会把有符号 C 溢出当成合法行为。',
        ),
      },
      {
        title: T('标志位描述的是一次运算'),
        body: T(
          'CF 观察无符号进位，OF 观察有符号溢出，ZF 表示结果为零，SF 是结果最高位。MOV 不改这些标志。本例只模拟这四位，不包含 PF、AF 和完整 RFLAGS。',
        ),
      },
    ],
    misconception: T(
      '同一组位可以有有符号和无符号解释。CF 和 OF 不是同一件事，uint32_t 的回绕也不代表 C 的有符号溢出合法。',
    ),
    challenge: T(
      '用自己的话解释 MOV 与 ADD 各自读取、写入了什么。再比较 0xFFFFFFFF + 1 与 0x7FFFFFFF + 1 的 CF / OF。',
    ),
    answer: T(
      'MOV 复制并保留源；ADD 读取两侧、写回左侧。FFFFFFFF + 1 得到零，CF=1、OF=0；7FFFFFFF + 1 得到 80000000，CF=0、OF=1。',
    ),
    quiz: {
      question: T('mov eax, ecx 执行后，ECX 的值怎样变化？'),
      options: [T('被清零'), T('保持原值'), T('与 EAX 交换')],
      correct: 1,
      explain: T('MOV 复制源值，不清空源，也不交换两个操作数。'),
    },
  },
  {
    id: 'branch',
    noteId: 'assembly-branch',
    title: T('比较与分支'),
    question: T('同样的位模式，为什么能走向不同的分支？'),
    intro: T(
      '对比 signed 与 unsigned 的小于判断。观察 CMP 产生的标志，以及 JGE / JAE 如何读取不同条件。',
    ),
    prediction: T('输入 a = −1、b = 1：有符号比较和无符号比较的结果会一样吗？'),
    notes: [
      {
        title: T('CMP 做减法，但不保存差值'),
        body: T(
          'cmp ecx, edx 临时计算 ECX − EDX，用结果更新标志位，两个操作数都保留。下一条条件跳转读取这些标志，不会重新比较高级语言变量。',
        ),
      },
      {
        title: T('跳转指令选择解释方式'),
        body: T(
          'JGE 表示有符号大于等于，条件是 SF = OF；JAE 表示无符号大于等于，条件是 CF = 0。这里把“不小于”直接跳到结束位置，只有小于时才把 result 改成 1。',
        ),
      },
      {
        title: T('从控制流图回看汇编'),
        body: T(
          'if 的判断块对应 CMP 与条件跳转，赋值块对应 MOV，汇合处通过标签连接。标签只是汇编器使用的名字，不是一条 CPU 指令；回放时标签本身不会消耗一步。',
        ),
      },
    ],
    misconception: T(
      'SF=1 不足以独立判断“有符号小于”；减法可能溢出，因此有符号关系还要考虑 OF。',
    ),
    challenge: T(
      '解释为什么 a = −1、b = 1 时，JGE 与 JAE 可能做出不同选择，并说明 CMP 是否改写了 a。',
    ),
    answer: T(
      '−1 的 32 位模式是 FFFFFFFF：有符号为 −1，无符号为 4294967295。CMP 产生同一组标志；JGE 看 SF/OF，JAE 看 CF，最终分支可不同。CMP 不改写 a。',
    ),
    quiz: {
      question: T('CMP 会把差值写回第一个操作数吗？'),
      options: [T('会'), T('不会，只更新标志'), T('取决于比较结果')],
      correct: 1,
      explain: T('CMP 使用减法的标志效果，但不保存差值到操作数。'),
    },
  },
  {
    id: 'loop',
    noteId: 'assembly-loop',
    title: T('循环与回边'),
    question: T('while 在汇编里，还有一个 while 吗？'),
    intro: T('把循环拆成比较、条件跳转、加法和回跳。修改 n，观察零次循环与多轮累加。'),
    prediction: T('n = 0 时会执行循环体吗？每轮结束后，要回到哪一条指令重新判断？'),
    notes: [
      {
        title: T('寄存器保存循环状态'),
        body: T(
          'ECX 保存 n，EDX 保存 i，EAX 保存 sum。XOR 一个寄存器与自身会得到零，本例用它初始化 i 和 sum；同时更新本附录展示的四个标志。',
        ),
      },
      {
        title: T('退出判断与回边'),
        body: T(
          'cmp edx, ecx 检查 i 与 n，jae done 在 i ≥ n 时退出。否则累加并更新 i，再由 jmp 回到比较位置。这里 n 是无符号且限制在 0–12，所有演示都能在回放上限内完成。',
        ),
      },
      {
        title: T('不要依赖上一轮的标志'),
        body: T(
          '循环体中的 ADD 会更新标志，回到条件处后 CMP 会重新计算正确的比较标志。高级语言的一次 while 条件检查可能对应多条低层指令。',
        ),
      },
    ],
    misconception: T(
      'JMP 不会自动更新循环变量，也不会自己检查结束条件。更新 i 和比较条件需要由其他指令完成。',
    ),
    challenge: T('用 n = 4 解释为什么输出为 6，条件检查为什么比循环体执行次数多一次。'),
    answer: T('循环累加 0、1、2、3，得到 6。i 更新为 4 后还要再比较一次，才能由 JAE 走退出路径。'),
    quiz: {
      question: T('n = 0 时，这个 while 的循环体会执行几次？'),
      options: [T('0 次'), T('1 次'), T('无法结束')],
      correct: 0,
      explain: T('第一次比较就有 i ≥ n，直接跳到 done。'),
    },
  },
  {
    id: 'memory',
    noteId: 'assembly-memory',
    title: T('数组与地址'),
    question: T('a[i] 如何变成一次内存读取？'),
    intro: T('修改数组与索引，对比直接读取和“先 LEA 算地址，再 MOV 读取”的两种写法。'),
    prediction: T('int32_t 每项 4 字节。i 增加 1，访问地址会增加多少？LEA 会读出数组元素吗？'),
    notes: [
      {
        title: T('地址是首地址加上偏移'),
        body: T(
          'RCX 保存数组首地址，RDX 保存已零扩展的索引；有效地址是 RCX + RDX × 4。这里模拟的首地址为 0x2000，不是当前浏览器进程的真实地址。',
        ),
      },
      {
        title: T('LEA 与内存读取'),
        body: T(
          'LEA 把有效地址放进 R8，不读取这个地址里的值，也不改变标志。MOV 配合 DWORD PTR 内存操作数才读取 4 字节。切换两种写法，结果应相同，但内存访问发生的步骤不同。',
        ),
      },
      {
        title: T('位模式与小端顺序'),
        body: T(
          '本例按 x86 的小端字节顺序存储 int32_t：低地址放低字节。读出的 32 位模式进入 EAX，返回值按 int32_t 解释；例如 FFFFFFFF 对应 −1。',
        ),
      },
    ],
    misconception: T(
      '方括号表示访问内存，不表示“把地址本身读出来”。LEA 的地址表达式看起来相近，但执行的是地址计算。',
    ),
    challenge: T('画出 a[2] 的地址计算过程，说明 LEA 后 R8 与 MOV 后 EAX 分别装了什么。'),
    answer: T(
      '0x2000 + 2 × 4 = 0x2008。LEA 后 R8 是地址 0x2008，MOV 后 EAX 是该处 4 字节组成的元素位模式。',
    ),
    quiz: {
      question: T('LEA R8, [RCX + RDX*4] 会读取数组元素吗？'),
      options: [T('会'), T('不会，只计算地址'), T('只读取第一个字节')],
      correct: 1,
      explain: T('LEA 只计算有效地址；这里没有数据内存读取。'),
    },
  },
  {
    id: 'call',
    noteId: 'assembly-call',
    title: T('函数与栈'),
    question: T('CALL 之后，程序怎么知道从哪里回来？'),
    intro: T('跟随 caller 调用 add，观察参数寄存器、32 字节 shadow space、栈对齐与返回位置。'),
    prediction: T('CALL 与 RET 各让 RSP 改变多少？返回值是否需要放在栈顶？'),
    notes: [
      {
        title: T('先由 ABI 约定参数位置'),
        body: T(
          '本例按 Windows x64 ABI，把两个 32 位参数写入 ECX、EDX。caller 在 CALL 前预留 32 字节 shadow space，并额外减去 8 字节以满足本例对齐，总计 sub rsp, 40。其他平台的调用约定可能不同。',
        ),
      },
      {
        title: T('CALL 与 RET 维护返回位置'),
        body: T(
          'CALL 把下一条指令的返回位置压入 8 字节栈槽，RSP 减 8，再转入 add。RET 读取该返回位置，RSP 加 8，继续 caller。回放里的返回位置用 #指令序号示意，没有伪造真实机器编码的字节地址。',
        ),
      },
      {
        title: T('返回值与恢复栈空间'),
        body: T(
          'add 把 32 位返回值留在 EAX。caller 恢复自己预留的 40 字节，再 RET 到外部调用者。shadow space 是 caller 预留的空间，不要求 callee 必须把寄存器参数写进去。本例省略异常展开元数据。',
        ),
      },
    ],
    misconception: T(
      '操作数栈、函数调用栈和返回值寄存器不是同一件事。本例没有像前面教学 VM 那样，把每次算术的输入都压栈。',
    ),
    challenge: T(
      '追踪 RSP 从 0x1008 到 CALL、进入 add、返回 caller，再退出的全过程，指出返回值在哪里。',
    ),
    answer: T(
      '先减 40 得到 0xFE0；CALL 再减 8 得到 0xFD8。add 的 RET 弹回 0xFE0；caller 加 40 恢复 0x1008，最后 RET 弹到外部调用者。返回值在 EAX。',
    ),
    quiz: {
      question: T('本例 CALL 把什么放入栈中？'),
      options: [T('返回值'), T('下一条指令的返回位置'), T('整个寄存器组')],
      correct: 1,
      explain: T('CALL 保存返回位置；整数返回值依调用约定放在寄存器里。'),
    },
  },
  {
    id: 'registers',
    noteId: 'assembly-registers',
    title: T('从 8086 过渡'),
    question: T('AX、EAX、RAX 是三块不同的寄存器吗？'),
    intro: T('通过同一个 64 位寄存器的不同窗口，复习 AX / AL / AH，并观察写 EAX 时的高位清零。'),
    prediction: T('RAX 初值为 1122334455667788h，分别写入 AX 与 EAX，哪些位会保留？'),
    notes: [
      {
        title: T('名字是同一块寄存器的窗口'),
        body: T(
          'RAX 是 64 位窗口，EAX 是低 32 位，AX 是低 16 位，AL 是低 8 位，AH 是第 8–15 位。这里始终是 x86-64 模式的演示，不是 8086 指令模拟器。',
        ),
      },
      {
        title: T('写入规则存在重要区别'),
        body: T(
          '写 AL、AH、AX 会保留其他位；写 EAX 则把 RAX 的高 32 位清零；写 RAX 覆盖全部 64 位。这不是符号扩展。注意 AH 与 REX 前缀的组合另有限制，本例使用的 MOV 立即数不涉及冲突。',
        ),
      },
      {
        title: T('保留旧知识，再建立新坐标'),
        body: T(
          '8086 的 16 位寄存器、标志与跳转直觉仍有用。现代代码还要明确操作数宽度、64 位地址与 ABI。分段、分页、中断、DOS 服务、完整标志和 SIMD 不在本附录的模拟范围。',
        ),
      },
    ],
    misconception: T('写 EAX 并不是只改 RAX 的低 32 位；高 32 位会清零。写 AX 则会保留高位。'),
    challenge: T(
      '分别用 AX、EAX 写入 00AAh，解释 RAX 的最终值。再试试 AH 与 AL，指出各自覆盖的字节。',
    ),
    answer: T(
      '写 AX 后是 11223344556600AAh；写 EAX 后是 00000000000000AAh。AH 覆盖从低位数起第二个字节，AL 覆盖最低字节。',
    ),
    quiz: {
      question: T('在 64 位模式下，写 EAX 会怎样处理 RAX 的高 32 位？'),
      options: [T('保留'), T('清零'), T('按符号位填充')],
      correct: 1,
      explain: T('32 位目的寄存器的写入会零扩展到对应的 64 位寄存器。'),
    },
  },
];
export const instructionCards = [
  {
    name: 'MOV',
    meaning: T('复制值'),
    form: T('mov 目标, 源'),
    effect: T('读右侧、写左侧，源保留。内存操作数会发生读取或写入；本例标志不变。'),
  },
  {
    name: 'ADD',
    meaning: T('加法并写回'),
    form: T('add 目标, 源'),
    effect: T('结果写回左侧，按操作数宽度回绕；更新 ZF、SF、CF、OF。'),
  },
  {
    name: 'SUB',
    meaning: T('减法并写回'),
    form: T('sub 目标, 源'),
    effect: T('左减右，写回左侧并更新标志。本例也用它分配栈空间。'),
  },
  {
    name: 'CMP',
    meaning: T('比较并更新标志'),
    form: T('cmp 左, 右'),
    effect: T('临时计算左减右，更新标志但不改操作数。'),
  },
  {
    name: 'XOR',
    meaning: T('按位异或'),
    form: T('xor 目标, 源'),
    effect: T('相同寄存器异或得到零；本例更新 ZF/SF 并把 CF/OF 清零。'),
  },
  {
    name: 'LEA',
    meaning: T('计算地址'),
    form: T('lea 寄存器, [地址表达式]'),
    effect: T('只计算有效地址，不读取所指的数据；本例标志不变。'),
  },
  {
    name: 'JGE',
    meaning: T('有符号 ≥ 时跳转'),
    form: T('jge 标签'),
    effect: T('条件 SF = OF，标志本身不变。常用于跳过“不满足小于”的分支。'),
  },
  {
    name: 'JAE',
    meaning: T('无符号 ≥ 时跳转'),
    form: T('jae 标签'),
    effect: T('条件 CF = 0。不要与有符号条件混用。'),
  },
  {
    name: 'JMP',
    meaning: T('无条件跳转'),
    form: T('jmp 标签'),
    effect: T('改变执行位置，不自动修改循环变量或标志。'),
  },
  {
    name: 'CALL',
    meaning: T('保存返回位置并调用'),
    form: T('call 函数标签'),
    effect: T('本例 RSP 减 8，写入返回位置，再进入 callee。'),
  },
  {
    name: 'RET',
    meaning: T('弹出返回位置'),
    form: 'ret',
    effect: T('本例读取栈上的返回位置，RSP 加 8。不会自动清理 caller 预留的 shadow space。'),
  },
];
