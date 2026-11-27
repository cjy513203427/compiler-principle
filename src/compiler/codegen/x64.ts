import { T } from '../../i18n';
import type { Value } from '../model';
import { DIVIDE_BY_ZERO, UNSAFE_INTEGER } from '../operations';

/**
 * A small x86-64 subset in Intel syntax. Only what the Mini C code generator emits is modelled,
 * with 64-bit two's-complement registers, the four flags the emitted jumps read, a downward stack,
 * and System V AMD64 call rules for the three runtime functions.
 */
export type Reg64 =
  | 'rax' | 'rbx' | 'rcx' | 'rdx' | 'rsi' | 'rdi' | 'rbp' | 'rsp'
  | 'r8' | 'r9' | 'r10' | 'r11' | 'r12' | 'r13' | 'r14' | 'r15';
export const REGISTERS: Reg64[] = ['rax', 'rbx', 'rcx', 'rdx', 'rsi', 'rdi', 'rbp', 'rsp', 'r8', 'r9', 'r10', 'r11', 'r12', 'r13', 'r14', 'r15'];
/** A call may overwrite these (System V AMD64). */
export const CALLER_SAVED: Reg64[] = ['rax', 'rcx', 'rdx', 'rsi', 'rdi', 'r8', 'r9', 'r10', 'r11'];
/** A function must give these back unchanged; rbp and rsp are handled by the frame. */
export const CALLEE_SAVED: Reg64[] = ['rbx', 'r12', 'r13', 'r14', 'r15'];
/** Reserved for the safe-integer limit in range checks; never allocated. */
export const SCRATCH: Reg64 = 'r11';
const low32: Record<Reg64, string> = {
  rax: 'eax', rbx: 'ebx', rcx: 'ecx', rdx: 'edx', rsi: 'esi', rdi: 'edi', rbp: 'ebp', rsp: 'esp',
  r8: 'r8d', r9: 'r9d', r10: 'r10d', r11: 'r11d', r12: 'r12d', r13: 'r13d', r14: 'r14d', r15: 'r15d',
};
const low8: Record<Reg64, string> = {
  rax: 'al', rbx: 'bl', rcx: 'cl', rdx: 'dl', rsi: 'sil', rdi: 'dil', rbp: 'bpl', rsp: 'spl',
  r8: 'r8b', r9: 'r9b', r10: 'r10b', r11: 'r11b', r12: 'r12b', r13: 'r13b', r14: 'r14b', r15: 'r15b',
};

export type Reg = { kind: 'v'; name: string } | { kind: 'p'; reg: Reg64 };
export type Imm = { kind: 'imm'; value: bigint };
/** `slot` is a spill slot before frame layout; `frame` is QWORD PTR [rbp - offset]. */
export type Mem = { kind: 'slot'; slot: number } | { kind: 'frame'; offset: number };
export type Cond = 'l' | 'le' | 'g' | 'ge' | 'e' | 'ne' | 'o';
export type RuntimeFunction = '__mc_print_int' | '__mc_print_bool' | '__mc_trap';
/** Why an instruction exists; used for counting and for folding check code in the view. */
export type Role = 'compute' | 'copy' | 'check' | 'abi' | 'spill' | 'frame' | 'control';
export type MOp =
  | { op: 'mov'; dst: Reg; src: Reg | Imm }
  | { op: 'load'; dst: Reg; src: Mem }
  | { op: 'store'; dst: Mem; src: Reg }
  | { op: 'movabs'; dst: Reg; imm: bigint }
  | { op: 'lea'; dst: Reg; base: Reg; index?: Reg; disp: bigint }
  | { op: 'add' | 'sub' | 'imul'; dst: Reg; src: Reg | Imm }
  | { op: 'imul3'; dst: Reg; src: Reg; imm: bigint }
  | { op: 'neg'; dst: Reg }
  | { op: 'cmp'; left: Reg; right: Reg | Imm }
  | { op: 'test'; left: Reg; right: Reg }
  /** setcc writes only the low byte, so it reads the rest of the register. */
  | { op: 'set'; cond: Cond; dst: Reg }
  /** xor r32, r32: the zeroing idiom; clears the whole register and the flags. */
  | { op: 'zero'; dst: Reg }
  | { op: 'cqo' }
  | { op: 'idiv'; src: Reg }
  | { op: 'jmp'; target: string }
  | { op: 'j'; cond: Cond; target: string }
  | { op: 'label'; name: string }
  | { op: 'call'; target: RuntimeFunction }
  | { op: 'push' | 'pop'; reg: Reg }
  | { op: 'subsp' | 'addsp'; amount: number }
  | { op: 'ret' }
  /** Pseudo instruction at the end of the body; frame layout replaces it with the epilogue. */
  | { op: 'exit' };
export type MInst = MOp & { origin: number; role: Role; note?: string };

export const vreg = (name: string): Reg => ({ kind: 'v', name });
export const preg = (reg: Reg64): Reg => ({ kind: 'p', reg });
export const imm = (value: bigint): Imm => ({ kind: 'imm', value });
export const regKey = (reg: Reg) => (reg.kind === 'v' ? `%${reg.name}` : reg.reg);
export const isVirtual = (key: string) => key.startsWith('%');
export const sameReg = (a: Reg | Imm | undefined, b: Reg | Imm | undefined) =>
  !!a && !!b && a.kind !== 'imm' && b.kind !== 'imm' && regKey(a) === regKey(b);
export const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
export const fitsImm32 = (value: bigint) => value >= -(2n ** 31n) && value < 2n ** 31n;
export const inverse: Record<Cond, Cond> = { l: 'ge', ge: 'l', le: 'g', g: 'le', e: 'ne', ne: 'e', o: 'o' };
export const mirrored: Record<Cond, Cond> = { l: 'g', g: 'l', le: 'ge', ge: 'le', e: 'e', ne: 'ne', o: 'o' };
export const conditionOf: Record<string, Cond> = { '<': 'l', '<=': 'le', '>': 'g', '>=': 'ge', '==': 'e', '!=': 'ne' };

function regText(reg: Reg, width: 64 | 32 | 8 = 64) {
  if (reg.kind === 'v') return `%${reg.name}`;
  return width === 64 ? reg.reg : width === 32 ? low32[reg.reg] : low8[reg.reg];
}
const sourceText = (value: Reg | Imm) => (value.kind === 'imm' ? String(value.value) : regText(value));
const memText = (mem: Mem) => `QWORD PTR [${mem.kind === 'slot' ? `slot${mem.slot}` : `rbp - ${mem.offset}`}]`;
export function instructionText(instruction: MOp): string {
  switch (instruction.op) {
    case 'mov': return `mov ${regText(instruction.dst)}, ${sourceText(instruction.src)}`;
    case 'load': return `mov ${regText(instruction.dst)}, ${memText(instruction.src)}`;
    case 'store': return `mov ${memText(instruction.dst)}, ${regText(instruction.src)}`;
    case 'movabs': return `movabs ${regText(instruction.dst)}, ${instruction.imm}`;
    case 'lea': {
      const disp = instruction.disp === 0n ? '' : instruction.disp < 0n ? ` - ${-instruction.disp}` : ` + ${instruction.disp}`;
      return `lea ${regText(instruction.dst)}, [${regText(instruction.base)}${instruction.index ? ` + ${regText(instruction.index)}` : ''}${disp}]`;
    }
    case 'add': case 'sub': return `${instruction.op} ${regText(instruction.dst)}, ${sourceText(instruction.src)}`;
    case 'imul': return instruction.src.kind === 'imm'
      ? `imul ${regText(instruction.dst)}, ${regText(instruction.dst)}, ${instruction.src.value}`
      : `imul ${regText(instruction.dst)}, ${regText(instruction.src)}`;
    case 'imul3': return `imul ${regText(instruction.dst)}, ${regText(instruction.src)}, ${instruction.imm}`;
    case 'neg': return `neg ${regText(instruction.dst)}`;
    case 'cmp': return `cmp ${regText(instruction.left)}, ${sourceText(instruction.right)}`;
    case 'test': return `test ${regText(instruction.left)}, ${regText(instruction.right)}`;
    case 'set': return `set${instruction.cond} ${regText(instruction.dst, 8)}`;
    case 'zero': return `xor ${regText(instruction.dst, 32)}, ${regText(instruction.dst, 32)}`;
    case 'cqo': return 'cqo';
    case 'idiv': return `idiv ${regText(instruction.src)}`;
    case 'jmp': return `jmp ${instruction.target}`;
    case 'j': return `j${instruction.cond} ${instruction.target}`;
    case 'label': return `${instruction.name}:`;
    case 'call': return `call ${instruction.target}`;
    case 'push': case 'pop': return `${instruction.op} ${regText(instruction.reg)}`;
    case 'subsp': return `sub rsp, ${instruction.amount}`;
    case 'addsp': return `add rsp, ${instruction.amount}`;
    case 'ret': return 'ret';
    case 'exit': return T('; 函数尾声（布局时展开）');
  }
}

const p = preg;
/** Registers read, including implicit operands (cqo reads rax; idiv reads rdx:rax). */
export function uses(instruction: MOp): Reg[] {
  switch (instruction.op) {
    case 'mov': return instruction.src.kind === 'imm' ? [] : [instruction.src];
    case 'store': return [instruction.src];
    case 'lea': return instruction.index ? [instruction.base, instruction.index] : [instruction.base];
    case 'add': case 'sub': case 'imul':
      return instruction.src.kind === 'imm' ? [instruction.dst] : [instruction.dst, instruction.src];
    case 'imul3': return [instruction.src];
    case 'neg': case 'set': return [instruction.dst];
    case 'cmp': return instruction.right.kind === 'imm' ? [instruction.left] : [instruction.left, instruction.right];
    case 'test': return [instruction.left, instruction.right];
    case 'cqo': return [p('rax')];
    case 'idiv': return [p('rax'), p('rdx'), instruction.src];
    case 'call': return [p('rdi')];
    case 'push': return [instruction.reg];
    default: return [];
  }
}
/** Registers written, including every caller-saved register a call may clobber. */
export function defs(instruction: MOp): Reg[] {
  switch (instruction.op) {
    case 'mov': case 'load': case 'movabs': case 'lea': case 'add': case 'sub': case 'imul':
    case 'imul3': case 'neg': case 'set': case 'zero':
      return [instruction.dst];
    case 'cqo': return [p('rdx')];
    case 'idiv': return [p('rax'), p('rdx')];
    case 'call': return CALLER_SAVED.map(p);
    case 'pop': return [instruction.reg];
    default: return [];
  }
}
export function mapRegs(instruction: MInst, map: (reg: Reg) => Reg): MInst {
  const value = (operand: Reg | Imm) => (operand.kind === 'imm' ? operand : map(operand));
  switch (instruction.op) {
    case 'mov': return { ...instruction, dst: map(instruction.dst), src: value(instruction.src) };
    case 'load': case 'movabs': case 'neg': case 'set': case 'zero': return { ...instruction, dst: map(instruction.dst) };
    case 'store': return { ...instruction, src: map(instruction.src) };
    case 'lea': return { ...instruction, dst: map(instruction.dst), base: map(instruction.base), index: instruction.index && map(instruction.index) };
    case 'add': case 'sub': case 'imul': return { ...instruction, dst: map(instruction.dst), src: value(instruction.src) };
    case 'imul3': return { ...instruction, dst: map(instruction.dst), src: map(instruction.src) };
    case 'cmp': return { ...instruction, left: map(instruction.left), right: value(instruction.right) };
    case 'test': return { ...instruction, left: map(instruction.left), right: map(instruction.right) };
    case 'idiv': return { ...instruction, src: map(instruction.src) };
    case 'push': case 'pop': return { ...instruction, reg: map(instruction.reg) };
    default: return instruction;
  }
}
/** Control successors by index. A call to __mc_trap never returns. */
export function successors(code: MOp[]): number[][] {
  const labels = new Map<string, number>();
  code.forEach((instruction, index) => { if (instruction.op === 'label') labels.set(instruction.name, index); });
  const target = (name: string) => {
    const index = labels.get(name);
    if (index === undefined) throw new Error(T('机器代码缺少标签 {#0}。', name));
    return index;
  };
  return code.map((instruction, index) => {
    const next = index + 1 < code.length ? [index + 1] : [];
    if (instruction.op === 'jmp') return [target(instruction.target)];
    if (instruction.op === 'j') return [...next, target(instruction.target)];
    if (instruction.op === 'exit' || instruction.op === 'ret' || (instruction.op === 'call' && instruction.target === '__mc_trap')) return [];
    return next;
  });
}

export interface Flags { ZF: boolean; SF: boolean; OF: boolean; CF: boolean }
export interface X64Step {
  pc: number;
  nextPc: number;
  message: string;
  registers: (bigint | undefined)[];
  flags?: Flags;
  output: Value[];
  written: Reg64[];
  memory?: { kind: 'load' | 'store'; offset: number; value: bigint };
  stack: { offset: number; value: bigint | undefined }[];
}
export interface X64Execution {
  steps: X64Step[];
  output: Value[];
  halted: boolean;
  limited: boolean;
  error?: { message: string; pc: number };
  /** A machine-level fault (not a Mini C runtime error): a code generator bug. */
  fault?: string;
  executed: number;
  loads: number;
  stores: number;
  calls: number;
  traceTruncated: boolean;
}
export const MAX_X64_STEPS = 20000;
export const MAX_X64_TRACE = 400;
export const TRAP_MESSAGES: Record<number, string> = { 1: DIVIDE_BY_ZERO, 2: UNSAFE_INTEGER };
/** Entry rsp: a caller's `call main` has just pushed the return address, so rsp ≡ 8 (mod 16). */
const ENTRY_RSP = 0x7fff_f000n - 8n;
const RETURN_SENTINEL = 0x4010_00n;
const calleeSentinel = (index: number) => 0x5a5a_0000_0000_0000n + BigInt(index + 1) * 0x1111n;
const signed = (value: bigint) => BigInt.asIntN(64, value);
const index = (reg: Reg64) => REGISTERS.indexOf(reg);

class Fault extends Error {}
/** Execute physical code. Caller-saved registers are unknown after every call, as on real hardware. */
export function runX64(code: MInst[], settings: { record?: boolean; budget?: number; trace?: number } = {}): X64Execution {
  const record = settings.record ?? true;
  const budget = Math.max(1, Math.min(MAX_X64_STEPS, settings.budget ?? MAX_X64_STEPS));
  const traceLimit = settings.trace ?? MAX_X64_TRACE;
  const registers: (bigint | undefined)[] = REGISTERS.map(() => undefined);
  registers[index('rsp')] = ENTRY_RSP;
  registers[index('rbp')] = 0x7fff_f100n;
  CALLEE_SAVED.forEach((reg, i) => { registers[index(reg)] = calleeSentinel(i); });
  const entry = [...registers];
  const memory = new Map<bigint, bigint>([[ENTRY_RSP, RETURN_SENTINEL]]);
  let flags: Flags | undefined;
  const output: Value[] = [];
  const steps: X64Step[] = [];
  let traceTruncated = false;
  const stackView = () => {
    const rsp = registers[index('rsp')] ?? ENTRY_RSP;
    const rows: X64Step['stack'] = [];
    for (let address = ENTRY_RSP - 8n; address >= rsp && rows.length < 24; address -= 8n)
      rows.push({ offset: Number(ENTRY_RSP - address), value: memory.get(address) });
    return rows;
  };
  const snapshot = (step: Omit<X64Step, 'registers' | 'flags' | 'output' | 'stack'>) => {
    if (!record) return;
    if (steps.length >= traceLimit) { traceTruncated = true; return; }
    steps.push({ ...step, registers: [...registers], flags: flags && { ...flags }, output: [...output], stack: stackView() });
  };
  snapshot({ pc: -1, nextPc: 0, message: T('进入 main：rsp 指向调用者压入的返回地址；callee-saved 寄存器里是调用者的值，返回前必须原样交还。caller-saved 寄存器内容未知。'), written: [] });
  const labels = new Map<string, number>();
  code.forEach((instruction, i) => { if (instruction.op === 'label') labels.set(instruction.name, i); });
  const read = (reg: Reg): bigint => {
    if (reg.kind === 'v') throw new Fault(T('虚拟寄存器 %{#0} 没有分配物理寄存器。', reg.name));
    const value = registers[index(reg.reg)];
    if (value === undefined) throw new Fault(T('读取内容未知的寄存器 {#0}（从未写入，或已被调用破坏）。', reg.reg));
    return value;
  };
  const write = (reg: Reg, value: bigint, written: Reg64[]) => {
    if (reg.kind === 'v') throw new Fault(T('虚拟寄存器 %{#0} 没有分配物理寄存器。', reg.name));
    registers[index(reg.reg)] = signed(value);
    written.push(reg.reg);
  };
  const source = (value: Reg | Imm) => (value.kind === 'imm' ? value.value : read(value));
  const address = (mem: Mem) => {
    if (mem.kind === 'slot') throw new Fault(T('栈槽尚未布局到帧内。'));
    return read(preg('rbp')) - BigInt(mem.offset);
  };
  const subtractFlags = (a: bigint, b: bigint): Flags => {
    const exact = a - b, result = signed(exact);
    return { ZF: result === 0n, SF: result < 0n, OF: exact !== result, CF: BigInt.asUintN(64, a) < BigInt.asUintN(64, b) };
  };
  const condition = (cond: Cond) => {
    if (!flags) throw new Fault(T('条件跳转读取了尚未设置（或已被调用破坏）的标志位。'));
    const { ZF, SF, OF } = flags;
    return cond === 'l' ? SF !== OF : cond === 'le' ? ZF || SF !== OF : cond === 'g' ? !ZF && SF === OF
      : cond === 'ge' ? SF === OF : cond === 'e' ? ZF : cond === 'ne' ? !ZF : OF;
  };
  let pc = 0, executed = 0, loads = 0, stores = 0, calls = 0;
  const finish = (extra: Partial<X64Execution>): X64Execution =>
    ({ steps, output, halted: false, limited: false, executed, loads, stores, calls, traceTruncated, ...extra });
  while (pc < code.length) {
    const instruction = code[pc];
    if (instruction.op === 'label') { pc++; continue; }
    if (executed >= budget) return finish({ limited: true });
    executed++;
    let nextPc = pc + 1, message = '';
    const written: Reg64[] = [];
    let access: X64Step['memory'];
    try {
      switch (instruction.op) {
        case 'mov': case 'movabs': {
          const value = instruction.op === 'mov' ? source(instruction.src) : instruction.imm;
          write(instruction.dst, value, written);
          message = `${written[0]} = ${signed(value)}`;
          break;
        }
        case 'load': {
          const at = address(instruction.src), value = memory.get(at);
          if (value === undefined) throw new Fault(T('读取从未写入的栈地址 [rbp - {#0}]。', (instruction.src as { offset: number }).offset));
          write(instruction.dst, value, written);
          loads++;
          access = { kind: 'load', offset: Number(ENTRY_RSP - at), value };
          message = T('从栈读取 {#0} 放入 {#1}', value, written[0]);
          break;
        }
        case 'store': {
          const at = address(instruction.dst), value = read(instruction.src);
          memory.set(at, value);
          stores++;
          access = { kind: 'store', offset: Number(ENTRY_RSP - at), value };
          message = T('把 {#0} 写入栈', value);
          break;
        }
        case 'lea': {
          const value = read(instruction.base) + (instruction.index ? read(instruction.index) : 0n) + instruction.disp;
          write(instruction.dst, value, written);
          message = T('{#0} = {#1}（地址计算单元做加法，不改标志位）', written[0], signed(value));
          break;
        }
        case 'add': case 'sub': {
          const a = read(instruction.dst), b = source(instruction.src);
          const exact = instruction.op === 'add' ? a + b : a - b, result = signed(exact);
          write(instruction.dst, result, written);
          flags = instruction.op === 'sub' ? subtractFlags(a, b)
            : { ZF: result === 0n, SF: result < 0n, OF: exact !== result, CF: BigInt.asUintN(64, a) + BigInt.asUintN(64, b) >= 2n ** 64n };
          message = `${written[0]} = ${result}`;
          break;
        }
        case 'imul': case 'imul3': {
          // add / sub / imul share one variant, so narrow on the field that only imul3 has.
          const three = 'imm' in instruction;
          const a = three ? read(instruction.src) : read(instruction.dst);
          const b = three ? instruction.imm : source(instruction.src);
          const exact = a * b, result = signed(exact);
          write(instruction.dst, result, written);
          const overflow = exact !== result;
          flags = { ZF: result === 0n, SF: result < 0n, OF: overflow, CF: overflow };
          message = overflow
            ? T('{#0} = {#1}，超出 64 位，OF = 1', written[0], result)
            : T('{#0} = {#1}，OF = 0', written[0], result);
          break;
        }
        case 'neg': {
          const a = read(instruction.dst), result = signed(-a);
          write(instruction.dst, result, written);
          flags = { ZF: result === 0n, SF: result < 0n, OF: a === -(2n ** 63n), CF: a !== 0n };
          message = `${written[0]} = ${result}`;
          break;
        }
        case 'cmp': {
          const a = read(instruction.left), b = source(instruction.right);
          flags = subtractFlags(a, b);
          message = T('比较 {#0} 与 {#1}：ZF={#2} SF={#3} OF={#4}', a, b, +flags.ZF, +flags.SF, +flags.OF);
          break;
        }
        case 'test': {
          const result = read(instruction.left) & read(instruction.right);
          flags = { ZF: result === 0n, SF: signed(result) < 0n, OF: false, CF: false };
          message = result === 0n ? T('按位与结果为 0，ZF = 1') : T('按位与结果非 0，ZF = 0');
          break;
        }
        case 'set': {
          const old = read(instruction.dst), bit = condition(instruction.cond) ? 1n : 0n;
          write(instruction.dst, (old & ~0xffn) | bit, written);
          message = bit
            ? T('条件 {#0} 成立，低 8 位写 {#1}', instruction.cond, bit)
            : T('条件 {#0} 不成立，低 8 位写 {#1}', instruction.cond, bit);
          break;
        }
        case 'zero': {
          write(instruction.dst, 0n, written);
          flags = { ZF: true, SF: false, OF: false, CF: false };
          message = T('{#0} = 0（xor 清零，同时改写标志位）', written[0]);
          break;
        }
        case 'cqo': {
          const value = read(preg('rax')) < 0n ? -1n : 0n;
          write(preg('rdx'), value, written);
          message = T('把 rax 的符号扩展到 rdx（rdx = {#0}），组成 128 位被除数', value);
          break;
        }
        case 'idiv': {
          const divisor = read(instruction.src);
          const dividend = (read(preg('rdx')) << 64n) | BigInt.asUintN(64, read(preg('rax')));
          if (divisor === 0n) throw new Fault(T('处理器除法异常 #DE：除数为 0，生成的代码漏掉了除零检查。'));
          const quotient = dividend / divisor;
          if (quotient !== signed(quotient)) throw new Fault(T('处理器除法异常 #DE：商超出 64 位。'));
          write(preg('rax'), quotient, written);
          write(preg('rdx'), dividend - quotient * divisor, written);
          flags = undefined;
          message = T('rax = {#0}（向零取整），rdx = {#1}（余数）', quotient, dividend - quotient * divisor);
          break;
        }
        case 'jmp': {
          const target = labels.get(instruction.target);
          if (target === undefined) throw new Fault(T('不存在的标签 {#0}。', instruction.target));
          nextPc = target;
          message = T('跳转到 {#0}', instruction.target);
          break;
        }
        case 'j': {
          const taken = condition(instruction.cond);
          const target = labels.get(instruction.target);
          if (target === undefined) throw new Fault(T('不存在的标签 {#0}。', instruction.target));
          if (taken) nextPc = target;
          message = taken
            ? T('条件 {#0} 成立，跳到 {#1}', instruction.cond, instruction.target)
            : T('条件 {#0} 不成立，顺序执行', instruction.cond);
          break;
        }
        case 'call': {
          const rsp = read(preg('rsp'));
          if (rsp % 16n !== 0n) throw new Fault(T('call {#0} 时 rsp 没有按 16 字节对齐，违反 System V 调用约定。', instruction.target));
          calls++;
          const argument = read(preg('rdi'));
          if (instruction.target === '__mc_trap') {
            const trapCode = Number(BigInt.asIntN(32, argument));
            const text =
              trapCode === 1
                ? T('整数除法的除数不能为 0。')
                : trapCode === 2
                  ? T('计算结果超出安全整数范围。')
                  : TRAP_MESSAGES[trapCode];
            if (!text) throw new Fault(T('__mc_trap 收到未知错误码 {#0}。', argument));
            snapshot({ pc, nextPc: pc, message: T('执行 {#0}：运行时报告错误并终止程序：{#1}', instructionText(instruction), text), written });
            return finish({ error: { message: text, pc } });
          }
          if (instruction.target === '__mc_print_bool') {
            if (argument !== 0n && argument !== 1n) throw new Fault(T('__mc_print_bool 收到 {#0}，bool 只能是 0 或 1。', argument));
            output.push(argument === 1n);
          } else output.push(Number(argument));
          // The callee may leave anything in caller-saved registers and flags.
          for (const reg of CALLER_SAVED) registers[index(reg)] = undefined;
          flags = undefined;
          message = T('调用 {#0} 输出 {#1}；返回后 caller-saved 寄存器与标志位内容未知', instruction.target, String(output.at(-1)));
          break;
        }
        case 'push': {
          const value = read(instruction.reg), rsp = read(preg('rsp')) - 8n;
          write(preg('rsp'), rsp, written);
          memory.set(rsp, value);
          stores++;
          access = { kind: 'store', offset: Number(ENTRY_RSP - rsp), value };
          message = T('rsp -= 8，把 {#0} 存到栈顶', regText(instruction.reg));
          break;
        }
        case 'pop': {
          const rsp = read(preg('rsp')), value = memory.get(rsp);
          if (value === undefined) throw new Fault(T('pop 读取了未写入的栈地址。'));
          write(instruction.reg, value, written);
          write(preg('rsp'), rsp + 8n, written);
          loads++;
          access = { kind: 'load', offset: Number(ENTRY_RSP - rsp), value };
          message = T('从栈顶取回 {#0}，rsp += 8', regText(instruction.reg));
          break;
        }
        case 'subsp': case 'addsp': {
          const rsp = read(preg('rsp')) + BigInt(instruction.op === 'subsp' ? -instruction.amount : instruction.amount);
          write(preg('rsp'), rsp, written);
          message = `rsp ${instruction.op === 'subsp' ? '-' : '+'}= ${instruction.amount}`;
          break;
        }
        case 'ret': {
          const rsp = read(preg('rsp'));
          const target = memory.get(rsp);
          if (rsp !== ENTRY_RSP || target !== RETURN_SENTINEL) throw new Fault(T('ret 时 rsp 没有回到入口位置，返回地址不对。'));
          const broken = [...CALLEE_SAVED, 'rbp' as const].filter((reg) => registers[index(reg)] !== entry[index(reg)]);
          if (broken.length) throw new Fault(T('返回前没有恢复 callee-saved 寄存器：{#0}。', broken.join(', ')));
          write(preg('rsp'), rsp + 8n, written);
          snapshot({ pc, nextPc: code.length, message: T('执行 ret：rsp 回到入口，callee-saved 寄存器都已恢复，返回调用者。'), written });
          return finish({ halted: true });
        }
        case 'exit': throw new Fault(T('尾声伪指令没有展开。'));
      }
      snapshot({ pc, nextPc, message: T('执行 {#0}：{#1}。', instructionText(instruction), message), written, memory: access });
      pc = nextPc;
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      const faultMessage = T('机器级错误：{#0}', text);
      snapshot({ pc, nextPc: pc, message: faultMessage, written });
      return finish({ fault: text, error: { message: faultMessage, pc } });
    }
  }
  const missingRet = T('执行越过代码末尾，缺少 ret。');
  return finish({ fault: missingRet, error: { message: T('机器级错误：{#0}', missingRet), pc } });
}
export const registerIndex = index;
