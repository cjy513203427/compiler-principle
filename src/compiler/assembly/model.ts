export type AssemblyTopic = 'arithmetic' | 'branch' | 'loop' | 'memory' | 'call' | 'registers';
export type AssemblyNoteId = `assembly-${AssemblyTopic}`;
export type Register = 'RAX' | 'RBX' | 'RCX' | 'RDX' | 'RSI' | 'RDI' | 'RBP' | 'RSP' | 'R8' | 'R9';
export type Alias = Register | 'EAX' | 'EBX' | 'ECX' | 'EDX' | 'AX' | 'AL' | 'AH';
export type Width = 8 | 16 | 32 | 64;
export type Operand =
  | { kind: 'reg'; name: Alias }
  | { kind: 'imm'; value: bigint }
  | {
      kind: 'mem';
      base: Register;
      index?: Register;
      scale?: 1 | 2 | 4 | 8;
      displacement?: bigint;
      width: 32 | 64;
    };
export type Instruction =
  | { op: 'MOV' | 'ADD' | 'SUB' | 'CMP' | 'XOR' | 'LEA'; left: Operand; right: Operand }
  | { op: 'JMP' | 'JGE' | 'JAE'; target: string }
  | { op: 'CALL'; target: string }
  | { op: 'RET' };
export interface AssemblyLine {
  text: string;
  sourceLine: number;
  instruction?: Instruction;
  label?: string;
}
export interface AssemblyParameters {
  a: number;
  b: number;
  n: number;
  array: number[];
  index: number;
  unsigned: boolean;
  addressFirst: boolean;
  alias: 'AL' | 'AH' | 'AX' | 'EAX' | 'RAX';
  registerHex: string;
  writeHex: string;
}
export interface Program {
  topic: AssemblyTopic;
  source: string[];
  lines: AssemblyLine[];
  entry: string;
  registers: Partial<Record<Register, bigint>>;
  initialRax?: bigint;
  array?: { address: bigint; values: number[] };
  bindings: { name: string; register: Alias; signed?: boolean }[];
  expected: bigint;
  returnWidth: Width;
  signedReturn: boolean;
}
export interface Flags {
  ZF: boolean;
  SF: boolean;
  CF: boolean;
  OF: boolean;
}
export interface Access {
  address: bigint;
  width: Width;
  kind: 'read' | 'write';
  value: bigint;
}
export interface Frame {
  name: string;
  returnPc: number;
  returnAddress: bigint;
}
export interface Snapshot {
  pc: number;
  nextPc: number;
  sourceLine: number;
  line: number;
  message: string;
  registers: Record<Register, bigint>;
  flags: Flags;
  memory: Record<string, number>;
  frames: Frame[];
  accesses: Access[];
  changedRegisters: Register[];
  changedFlags: (keyof Flags)[];
}
export interface Execution {
  steps: Snapshot[];
  instructions: (AssemblyLine & { instruction: Instruction; line: number })[];
  halted: boolean;
  limited: boolean;
  error?: string;
  result: bigint;
}
export const INITIAL_RSP = 0x1008n;
export const ARRAY_BASE = 0x2000n;
export const reg = (name: Alias): Operand => ({ kind: 'reg', name });
export const imm = (value: number | bigint): Operand => ({ kind: 'imm', value: BigInt(value) });
export const mask = (width: Width) => (1n << BigInt(width)) - 1n;
export const unsignedValue = (value: bigint, width: Width) => BigInt.asUintN(width, value);
export const signedValue = (value: bigint, width: Width) => BigInt.asIntN(width, value);
export function hex(value: bigint, width: Width = 64) {
  return `0x${unsignedValue(value, width)
    .toString(16)
    .toUpperCase()
    .padStart(width / 4, '0')}`;
}
