import {
  type Access,
  type Alias,
  type Execution,
  type Flags,
  type Frame,
  type Operand,
  type Program,
  type Register,
  type Snapshot,
  type Width,
  INITIAL_RSP,
  mask,
  unsignedValue,
} from './model';
export const MAX_ASSEMBLY_STEPS = 256;
const registers: Register[] = ['RAX', 'RBX', 'RCX', 'RDX', 'RSI', 'RDI', 'RBP', 'RSP', 'R8', 'R9'];
export function aliasInfo(name: Alias): { register: Register; width: Width; offset: number } {
  if (registers.includes(name as Register))
    return { register: name as Register, width: 64, offset: 0 };
  if (name === 'AX' || name === 'AL' || name === 'AH')
    return { register: 'RAX', width: name === 'AX' ? 16 : 8, offset: name === 'AH' ? 8 : 0 };
  return {
    register: ({ EAX: 'RAX', EBX: 'RBX', ECX: 'RCX', EDX: 'RDX' } as const)[name as 'EAX'],
    width: 32,
    offset: 0,
  };
}
export function readRegister(state: Record<Register, bigint>, name: Alias): bigint {
  const info = aliasInfo(name);
  return (state[info.register] >> BigInt(info.offset)) & mask(info.width);
}
export function writeRegister(state: Record<Register, bigint>, name: Alias, value: bigint): void {
  const { register, width, offset } = aliasInfo(name);
  const normalized = unsignedValue(value, width);
  if (width === 64 || width === 32) state[register] = normalized;
  else {
    const field = mask(width) << BigInt(offset);
    state[register] = unsignedValue(
      (state[register] & ~field) | (normalized << BigInt(offset)),
      64,
    );
  }
}
export function arithmeticFlags(
  op: 'ADD' | 'SUB' | 'CMP' | 'XOR',
  a: bigint,
  b: bigint,
  width: Width,
): { result: bigint; flags: Flags } {
  const left = unsignedValue(a, width);
  const right = unsignedValue(b, width);
  const result = unsignedValue(
    op === 'ADD' ? left + right : op === 'XOR' ? left ^ right : left - right,
    width,
  );
  const sign = 1n << BigInt(width - 1);
  const sa = (left & sign) !== 0n;
  const sb = (right & sign) !== 0n;
  const sr = (result & sign) !== 0n;
  return {
    result,
    flags: {
      ZF: result === 0n,
      SF: sr,
      CF: op === 'ADD' ? left + right > mask(width) : op === 'XOR' ? false : left < right,
      OF: op === 'ADD' ? sa === sb && sa !== sr : op === 'XOR' ? false : sa !== sb && sa !== sr,
    },
  };
}
export function runAssembly(program: Program, budget = MAX_ASSEMBLY_STEPS): Execution {
  const code = program.lines.flatMap((line, index) =>
    line.instruction ? [{ ...line, instruction: line.instruction, line: index }] : [],
  );
  const labels = new Map<string, number>();
  let instructionIndex = 0;
  program.lines.forEach((line) => {
    if (line.label) labels.set(line.label, instructionIndex);
    if (line.instruction) instructionIndex++;
  });
  const state = Object.fromEntries(registers.map((name) => [name, 0n])) as Record<Register, bigint>;
  Object.assign(state, program.registers);
  state.RSP = INITIAL_RSP;
  if (program.initialRax !== undefined) state.RAX = program.initialRax;
  let flags: Flags = { ZF: false, SF: false, CF: false, OF: false };
  const memory: Record<string, number> = Object.create(null);
  const mapped = (address: bigint, bytes: number) =>
    (address >= 0xe00n && address + BigInt(bytes) <= 0x1040n) ||
    (program.array &&
      address >= program.array.address &&
      address + BigInt(bytes) <= program.array.address + BigInt(program.array.values.length * 4));
  const store = (address: bigint, width: Width, value: bigint) => {
    if (!mapped(address, width / 8))
      throw new Error('教学检查：访问超出本例映射内存；真实 CPU 不会自动检查 C 数组边界。');
    const normalized = unsignedValue(value, width);
    for (let i = 0; i < width / 8; i++)
      memory[String(address + BigInt(i))] = Number((normalized >> BigInt(i * 8)) & 255n);
  };
  const load = (address: bigint, width: Width): bigint => {
    if (!mapped(address, width / 8))
      throw new Error('教学检查：访问超出本例映射内存；真实 CPU 不会自动检查 C 数组边界。');
    let value = 0n;
    for (let i = 0; i < width / 8; i++) {
      const byte = memory[String(address + BigInt(i))];
      if (byte === undefined)
        throw new Error(
          '教学检查：正在读取本例尚未初始化的内存；这不是 CPU 自动提供的未初始化检测。',
        );
      value |= BigInt(byte) << BigInt(i * 8);
    }
    return value;
  };
  store(INITIAL_RSP, 64, BigInt(code.length)); // Logical return position, not an encoded machine address.
  program.array?.values.forEach((value, index) =>
    store(program.array!.address + BigInt(index * 4), 32, BigInt(value)),
  );
  const frames: Frame[] = [
    { name: program.entry, returnPc: code.length, returnAddress: INITIAL_RSP },
  ];
  const steps: Snapshot[] = [];
  const snapshot = (
    pc: number,
    nextPc: number,
    message: string,
    accesses: Access[],
    oldRegisters = state,
    oldFlags = flags,
  ) => {
    steps.push({
      pc,
      nextPc,
      line: code[pc]?.line ?? -1,
      sourceLine: code[pc]?.sourceLine ?? -1,
      message,
      registers: { ...state },
      flags: { ...flags },
      memory: { ...memory },
      frames: frames.map((frame) => ({ ...frame })),
      accesses: accesses.map((access) => ({ ...access })),
      changedRegisters: registers.filter((name) => oldRegisters[name] !== state[name]),
      changedFlags: (Object.keys(flags) as (keyof Flags)[]).filter(
        (name) => oldFlags[name] !== flags[name],
      ),
    });
  };
  snapshot(-1, 0, '进入示例。参数与外部返回位置已准备；下一步执行第 0 条指令。', []);
  const address = (operand: Extract<Operand, { kind: 'mem' }>) =>
    unsignedValue(
      state[operand.base] +
        (operand.index ? state[operand.index] * BigInt(operand.scale ?? 1) : 0n) +
        (operand.displacement ?? 0n),
      64,
    );
  let pc = 0;
  let halted = false;
  const limit = Math.max(1, Math.min(MAX_ASSEMBLY_STEPS, Math.floor(budget) || MAX_ASSEMBLY_STEPS));
  for (let count = 0; pc < code.length && count < limit; count++) {
    const { instruction } = code[pc];
    const oldRegisters = { ...state };
    const oldFlags = { ...flags };
    const accesses: Access[] = [];
    let nextPc = pc + 1;
    let message = '';
    const read = (operand: Operand): bigint => {
      if (operand.kind === 'reg') return readRegister(state, operand.name);
      if (operand.kind === 'imm') return operand.value;
      const location = address(operand);
      const value = load(location, operand.width);
      accesses.push({ address: location, width: operand.width, kind: 'read', value });
      return value;
    };
    const write = (operand: Operand, value: bigint) => {
      if (operand.kind === 'reg') writeRegister(state, operand.name, value);
      else if (operand.kind === 'mem') {
        const location = address(operand);
        store(location, operand.width, value);
        accesses.push({
          address: location,
          width: operand.width,
          kind: 'write',
          value: unsignedValue(value, operand.width),
        });
      } else throw new Error('立即数不能作为写入目标。');
    };
    const target = (label: string): number => {
      const found = labels.get(label);
      if (found === undefined) throw new Error(`不存在标签 ${label}。`);
      return found;
    };
    try {
      switch (instruction.op) {
        case 'MOV':
          write(instruction.left, read(instruction.right));
          message = 'MOV 复制右侧值到左侧，源操作数保留；四个标志位不变。';
          break;
        case 'LEA': {
          if (instruction.right.kind !== 'mem') throw new Error('LEA 需要地址表达式。');
          const value = address(instruction.right);
          write(instruction.left, value);
          message = `LEA 只计算地址 ${value.toString(16).toUpperCase()}h，没有读取该地址中的数据，标志位不变。`;
          break;
        }
        case 'ADD':
        case 'SUB':
        case 'CMP':
        case 'XOR': {
          const width =
            instruction.left.kind === 'reg'
              ? aliasInfo(instruction.left.name).width
              : instruction.left.kind === 'mem'
                ? instruction.left.width
                : 32;
          const left = read(instruction.left);
          const right = read(instruction.right);
          const calculated = arithmeticFlags(instruction.op, left, right, width);
          flags = calculated.flags;
          if (instruction.op !== 'CMP') write(instruction.left, calculated.result);
          message =
            instruction.op === 'CMP'
              ? `CMP 临时计算左减右，低 ${width} 位差为 ${calculated.result}；只更新标志，不改写两个操作数。`
              : `${instruction.op} 计算后把低 ${width} 位写回左侧：${calculated.result}。CF=${Number(flags.CF)}，OF=${Number(flags.OF)}。`;
          break;
        }
        case 'JMP':
          nextPc = target(instruction.target);
          message = `无条件跳到 ${instruction.target}，不修改标志位。`;
          break;
        case 'JGE':
        case 'JAE': {
          const taken = instruction.op === 'JGE' ? flags.SF === flags.OF : !flags.CF;
          if (taken) nextPc = target(instruction.target);
          message = `${instruction.op} 检查 ${instruction.op === 'JGE' ? 'SF = OF（有符号大于等于）' : 'CF = 0（无符号大于等于）'}，结果为 ${taken}；${taken ? `跳到 ${instruction.target}` : '顺序执行下一条'}。`;
          break;
        }
        case 'CALL': {
          if (state.RSP % 16n !== 0n)
            throw new Error('教学 ABI 检查：本例 CALL 前 RSP 需要 16 字节对齐。');
          const destination = target(instruction.target);
          const stackAddress = state.RSP - 8n;
          store(stackAddress, 64, BigInt(nextPc));
          state.RSP = stackAddress;
          accesses.push({ address: stackAddress, width: 64, kind: 'write', value: BigInt(nextPc) });
          frames.push({ name: instruction.target, returnPc: nextPc, returnAddress: stackAddress });
          nextPc = destination;
          message = `CALL 把返回位置 #${pc + 1} 压入 8 字节栈槽，RSP 减 8，再进入 ${instruction.target}。此处的 # 是教学指令序号。`;
          break;
        }
        case 'RET': {
          const stackAddress = state.RSP;
          const value = load(stackAddress, 64);
          if (value < 0n || value > BigInt(code.length)) throw new Error('教学返回位置越界。');
          accesses.push({ address: stackAddress, width: 64, kind: 'read', value });
          state.RSP += 8n;
          nextPc = Number(value);
          frames.pop();
          halted = nextPc === code.length;
          message = halted
            ? 'RET 弹出外部返回位置，RSP 加 8，示例结束；返回值保留在规定的寄存器中。'
            : `RET 弹出返回位置 #${nextPc}，RSP 加 8，继续调用者下一条指令。`;
          break;
        }
      }
      snapshot(pc, nextPc, message, accesses, oldRegisters, oldFlags);
      pc = nextPc;
      if (halted) break;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      snapshot(pc, pc, message, accesses, oldRegisters, oldFlags);
      return {
        steps,
        instructions: code,
        halted: false,
        limited: false,
        error: message,
        result: readRegister(state, program.returnWidth === 64 ? 'RAX' : 'EAX'),
      };
    }
  }
  const limited = pc < code.length && !halted;
  if (limited) steps.at(-1)!.message += ` 已达到 ${limit} 条指令的教学回放上限。`;
  return {
    steps,
    instructions: code,
    halted: halted || pc === code.length,
    limited,
    result: readRegister(state, program.returnWidth === 64 ? 'RAX' : 'EAX'),
  };
}
