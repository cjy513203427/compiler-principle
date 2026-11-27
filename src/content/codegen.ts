import type { Lesson } from './lessons';
import { T } from '../i18n';

export const TILING_REFERENCE = 'https://www.cs.cornell.edu/courses/cs4120/2019sp/lectures/17tiles/lec17-sp18.pdf';
export const SYSV_ABI_REFERENCE = 'https://gitlab.com/x86-psABIs/x86-64-ABI';
export const INTEL_SDM_REFERENCE = 'https://www.intel.com/content/www/us/en/developer/articles/technical/intel-sdm.html';

/** Runtime for the exported .s file on x86-64 Linux: gcc -no-pie program.s runtime.c */
export const CODEGEN_RUNTIME = `#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

void __mc_print_int(int64_t value) { printf("%lld\\n", (long long)value); }
void __mc_print_bool(int64_t value) { puts(value ? "true" : "false"); }
_Noreturn void __mc_trap(int code) {
  fflush(stdout);
  fputs(code == 1 ? "${T('整数除法的除数不能为 0。')}\\n" : "${T('计算结果超出安全整数范围。')}\\n", stderr);
  exit(1);
}
`;

export const codegenLesson: Lesson = {
  id: 'codegen',
  number: '22',
  title: T('指令选择与代码生成'),
  english: 'Instruction selection & code generation',
  question: T('同一句 a + b + 10，为什么能翻译成好几种机器指令？'),
  intro:
    T('把实验 04 的三地址代码翻译成 x86-64 汇编：先把临时值接回成表达式树，用指令模式覆盖它；再在干涉图里加入 rax / rdx / rdi 等固定寄存器和调用破坏，分配物理寄存器、布局栈帧，最后在 x86-64 子集模拟器上执行并与原 VM 对照。'),
  chapter: '08',
  minutes: 28,
  icon: '⚙',
  color: 'blue',
  walkthrough: [
    {
      title: T('从教学寄存器机到真实指令集'),
      body: T('实验 17 的寄存器机里，每条三地址指令恰好变成一条寄存器指令，K 个寄存器完全等价，也没有标志位。真实的 x86-64 不一样：add 会覆盖左操作数（两地址形式），立即数通常最多 32 位，除法只能用 rdx:rax，比较结果先放进标志位，调用函数还会破坏一部分寄存器。代码生成要同时面对这些差异。'),
      example: T('IR：           t0 = v0_a + v1_b\n寄存器机：     r2 = r0 + r1\nx86-64：       lea rax, [rbx + rcx]   ; 或 mov rax, rbx / add rax, rcx'),
      exampleLanguage: 'text',
    },
    {
      title: T('先把三地址代码接回成树'),
      body: T('实验 04 按后序遍历把表达式压平成 t0、t1……。如果一个临时值只被用一次，并且就在同一基本块里紧接着被用到，就把它接回使用处，得到一棵表达式树。合并只取“栈顶”的临时值，所以按后序重新展开时，各运算的先后顺序和原 IR 一致，除零、溢出报错的顺序也不变。'),
      example: 't0 = v0_a + v1_b\nt1 = t0 + 10\nprint t1\n→ Print(Add(Add(v0_a, v1_b), 10))',
      exampleLanguage: 'text',
    },
    {
      title: T('用指令模式覆盖树：最大吞进'),
      body: T('每条机器指令能“盖住”树上的一小片节点，像一块瓦片。最大吞进（maximal munch）从树根开始，每次选能盖住最多节点的模式，再处理剩下的子树：比较和条件跳转融合成 cmp + jge，加立即数用 lea，乘立即数用三操作数 imul，0 − x 用 neg。逐条模板作对照：先把 x < 10 算成 0 / 1 放进寄存器，再 test + je。'),
      example: T('IfFalse(Lt(v0_x, 10)) → L0\n逐条模板：xor t0 / cmp x, 10 / setl t0 / test t0, t0 / je .L0\n树覆盖：  cmp x, 10 / jge .L0'),
      exampleLanguage: 'text',
    },
    {
      title: T('语言的语义决定额外的检查'),
      body: T('原书第 08 讲里，clang -O2 用一条 leal 10(%rdi,%rsi), %eax 完成三数相加。这在 C 里成立，是因为 C 的有符号溢出属于未定义行为，编译器不必保留中间结果。本项目的语言规定每一步结果都必须是安全整数，否则报错；而 64 位寄存器装得下 2^53，CPU 并不会报错。所以每次加、减、乘之后都要和 r11 里的上限比较，乘法先看 jo，除法前 test 除数。0 − x 不会越界，不需要检查。'),
      example: 'lea rax, [rbx + rcx]\nmovabs r11, 9007199254740991\ncmp rax, r11\njg .Ltrap_range\nneg r11\ncmp rax, r11\njl .Ltrap_range',
      exampleLanguage: 'text',
    },
    {
      title: T('固定寄存器与调用约定：预着色'),
      body: T('cqo / idiv 固定读写 rax 和 rdx；print 的参数按 System V AMD64 约定放进 rdi；每次 call 之后，rax、rcx、rdx、rsi、rdi、r8–r11 这 9 个 caller-saved 寄存器内容都不再可靠。分配器把这些物理寄存器当作“已经着好色”的节点放进干涉图：跨 call 仍活跃的值和全部 caller-saved 寄存器连边，只能分到 rbx、r12–r15 这些 callee-saved 寄存器，或者溢出到栈。'),
      example: T('mov rdi, rbx          ; 参数固定在 rdi\ncall __mc_print_int   ; 之后 rax rcx rdx rsi rdi r8–r11 都未知\nlea rbx, [rbx + 1]    ; total 跨调用，只能留在 callee-saved 的 rbx'),
      exampleLanguage: 'text',
    },
    {
      title: T('栈帧：保存、对齐、恢复'),
      body: T('用到的 callee-saved 寄存器要在序曲里 push、尾声里 pop；溢出的值放在 [rbp − 偏移] 的栈槽里。System V 要求 call 时 rsp 按 16 字节对齐，所以栈槽个数和保存的寄存器个数合起来要补齐到 16 的倍数。模拟器会在每次 call 时检查对齐，ret 时检查 callee-saved 与 rsp 是否恢复，并在每次调用后把 caller-saved 寄存器标成未知；生成的代码违反任何一条，都会报“机器级错误”。'),
      example: T('push rbp\nmov rbp, rsp\npush rbx            ; callee-saved，用前保存\nsub rsp, 8          ; 1 个栈槽，补齐后 call 时 rsp 对齐 16\n…\nadd rsp, 8\npop rbx\npop rbp\nret'),
      exampleLanguage: 'text',
    },
  ],
  note: [
    {
      title: T('指令选择是覆盖问题'),
      body: T('同一棵树有多种覆盖方式，要选代价更低的组合。最大吞进是贪心算法，得到的是局部最优：不能再把相邻两块瓦片换成一块更便宜的，但不保证整体最便宜。动态规划或 BURS（自底向上重写系统）可以求整体最优；本页只实现最大吞进，并用逐条模板对照指令条数。'),
    },
    {
      title: T('约束先变成干涉边，再着色'),
      body: T('两地址形式、固定寄存器和调用破坏，都变成虚拟寄存器与物理寄存器之间的干涉边；mov 两端则优先分到同一个寄存器，分配后那条 mov 变成自身复制而删去。着色、溢出与重写的过程与实验 17 相同，只是颜色是真实的寄存器名。'),
    },
    {
      title: T('最后用真实执行核对'),
      body: T('核对分两层：先在最终的虚拟寄存器代码上重算活跃性，检查每次写入都不会覆盖仍要使用的值；再由模拟器逐条执行物理代码，与原始 VM 对照输出和错误。一次运行一致只说明这次输入一致，不是一般性的等价证明。'),
    },
  ],
  misconception:
    T('“指令选择就是查表，把每条 IR 换成一条机器指令。”——同一片树可以有多种覆盖：x < 10 加上分支，可以是 setcc + test + je，也可以融合成 cmp + jge；a + 10 可以是 mov + add，也可以是一条 lea。另外，原书 -O2 能用一条 lea 完成 a + b + 10，依赖的是 C 的有符号溢出属于未定义行为；语言要求溢出报错时，中间结果的检查一条都不能省。'),
  limit:
    T('目标是 x86-64 子集，Intel 语法，System V AMD64 调用约定，只生成一个 main 函数，通过 __mc_print_int / __mc_print_bool / __mc_trap 三个运行时函数输出和报错；r11 保留给范围检查。int 用 64 位补码寄存器表示，bool 用 0 / 1。页面结果来自本项目的 x86-64 子集模拟器（BigInt 64 位寄存器、ZF / SF / OF / CF、向下增长的栈），不是真实 CPU，也没有在本机用汇编器验证；导出的 .s 和运行时 C 代码可以在 x86-64 Linux 上自行汇编运行。没有内存操作数、动态规划 / BURS 最优覆盖、真正的复制合并（只有偏好着色）、区间拆分、函数调用与传参（见实验 16 方言）、指令排序与窥孔（见实验 18）。最大吞进只合并同一基本块里只用一次的临时值；溢出值每次使用都重新从栈槽读取，不做重新物化或就近复用。执行最多 20000 条机器指令，回放保留前 400 步；与原 VM 的计步单位不同，任一方超限都不判定一致。'),
  challenge:
    T('运行“原书例子：a + b + 10”，数一数机器代码里有几条 lea、几条检查指令；再说明为什么不能像原书 -O2 那样合成一条 lea 10(%rdi,%rsi)。然后切到“跨调用的值”，把寄存器改成“紧张”，看 total 和 i 谁留在 rbx、谁被溢出到栈。'),
  answer:
    T('a + b + 10 被接回成 Add(Add(a, b), 10)，覆盖成两条 lea，每条后面跟 6 条范围检查。合成一条 lea 只检查最终结果：如果 a + b 已经超出安全整数而 + 10 之后仍然超出，报错相同；但若中间越界、加上负常量后又回到范围内，合成版本就会漏报。本项目要求每一步越界都报错，所以只能逐步检查。紧张寄存器下只有 rbx 一个 callee-saved 寄存器，而 total 和 i 都跨 print 调用活跃：i 留在 rbx，total 溢出到 [rbp − 16]，循环里每次读写 total 都要访问栈。'),
  quiz: {
    question: T('在 x86-64 System V 约定下，一个值在 call 之后还要使用，分配器能把它放在 rcx 里吗？'),
    options: [
      T('可以，只要调用之前把值写进 rcx'),
      T('不可以，call 可能破坏 rcx 等全部 caller-saved 寄存器；它只能用 callee-saved 寄存器（并在序曲保存）或溢出到栈'),
      T('可以，只要被调用的函数没有用到 rcx'),
    ],
    correct: 1,
    explain:
      T('调用约定只保证 callee-saved 寄存器在返回后不变。调用者不能假设被调用函数没有用到 rcx；分配器把 call 视为写入全部 caller-saved 寄存器，于是跨调用活跃的值与它们都有干涉边。'),
  },
};

export const codegenPresets = [
  {
    id: 'cg-lea',
    label: T('代码生成 · 原书例子：a + b + 10'),
    code: 'int a = 3;\nint b = 4;\nprint(a + b + 10);',
    prediction: T('原书 -O2 用一条 lea 完成三数相加。这里会生成几条 lea？为什么每次加法后面都跟着检查？'),
  },
  {
    id: 'cg-branch',
    label: T('代码生成 · 比较与跳转融合'),
    code: 'int x = 7;\nint y = 0;\nif (x < 10) {\n  y = x * 4;\n} else {\n  y = 0 - x;\n}\nprint(y);',
    prediction: T('逐条模板先把 x < 10 算成 0 / 1 再 test。树覆盖会把比较和跳转合成哪两条指令？0 − x 用什么指令？'),
  },
  {
    id: 'cg-div',
    label: T('代码生成 · idiv 只认 rax 与 rdx'),
    code: 'int a = 17;\nint b = 5;\nprint(a / b);\nprint(a / 3);\nprint(0 - a / b);',
    prediction: T('除法前要做哪两件事？除数是常量 3 时，还需要除零检查吗？−17 / 5 的商是 −3 还是 −4？'),
  },
  {
    id: 'cg-call',
    label: T('代码生成 · 跨调用的值'),
    code: 'int total = 0;\nint i = 1;\nwhile (i <= 4) {\n  total = total + i;\n  print(total);\n  i = i + 1;\n}\nprint(total * 2);',
    prediction: T('total 和 i 在每次 print 之后还要用。它们能放进 rax、rcx 吗？把寄存器改成“紧张”后谁会被溢出？'),
  },
  {
    id: 'cg-imm',
    label: T('代码生成 · 32 位立即数放不下'),
    code: 'int big = 5000000000;\nint small = 7;\nprint(big + small);\nprint(small * 100000);\nprint(big - 1);',
    prediction: T('50 亿超过 32 位有符号立即数的范围。哪里需要 movabs？small * 100000 还能用三操作数 imul 吗？'),
  },
  {
    id: 'cg-range',
    label: T('语义边界 · 64 位装得下，语言却要报错'),
    code: 'int x = 9007199254740991;\nprint(x / 2);\nprint(x - 1);\nprint(x + 1);\nprint(0);',
    prediction: T('64 位寄存器装得下 x + 1，CPU 也不会报错。程序为什么还要停下？前两行的输出是多少？'),
  },
  {
    id: 'cg-trap',
    label: T('语义边界 · 除零前的输出要保留'),
    code: 'int a = 10;\nint b = 0;\nbool ok = a > b;\nprint(ok);\nprint(a / b);\nprint(1);',
    prediction: T('ok 是 bool，它用哪个运行时函数输出？除零检查在 idiv 之前还是之后？最后的 print(1) 会执行吗？'),
  },
];
