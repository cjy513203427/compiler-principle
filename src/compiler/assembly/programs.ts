import {
  type Alias,
  type AssemblyLine,
  type AssemblyParameters,
  type AssemblyTopic,
  type Instruction,
  type Operand,
  type Program,
  ARRAY_BASE,
  reg,
  imm,
  unsignedValue,
} from './model';
export function operandText(operand: Operand): string {
  if (operand.kind === 'reg') return operand.name;
  if (operand.kind === 'imm')
    return operand.value > 0xffffffffn
      ? `0${operand.value.toString(16).toUpperCase()}h`
      : String(operand.value);
  return `${operand.width === 32 ? 'DWORD' : 'QWORD'} PTR [${operand.base}${operand.index ? ` + ${operand.index}*${operand.scale ?? 1}` : ''}${operand.displacement ? ` + ${operand.displacement}` : ''}]`;
}
export function instructionText(instruction: Instruction): string {
  if ('left' in instruction)
    return `${instruction.op.toLowerCase()} ${operandText(instruction.left)}, ${instruction.op === 'LEA' ? operandText(instruction.right).replace('DWORD PTR ', '').replace('QWORD PTR ', '') : operandText(instruction.right)}`;
  return instruction.op.toLowerCase() + ('target' in instruction ? ` ${instruction.target}` : '');
}
export function buildProgram(topic: AssemblyTopic, parameters: AssemblyParameters): Program {
  const p = parameters;
  const lines: AssemblyLine[] = [];
  const emit = (sourceLine: number, instruction: Instruction) =>
    lines.push({ sourceLine, instruction, text: instructionText(instruction) });
  const label = (name: string, sourceLine: number) =>
    lines.push({ sourceLine, label: name, text: `${name}:` });
  const binary = (
    op: 'MOV' | 'ADD' | 'SUB' | 'CMP' | 'XOR' | 'LEA',
    left: Alias,
    right: Operand,
    line: number,
  ) => emit(line, { op, left: reg(left), right });
  const program: Program = {
    topic,
    source: [],
    lines,
    entry:
      topic === 'arithmetic'
        ? 'add'
        : topic === 'branch'
          ? 'less'
          : topic === 'loop'
            ? 'sum_to'
            : topic === 'memory'
              ? 'read_at'
              : topic === 'call'
                ? 'caller'
                : 'register_window',
    registers: {},
    bindings: [],
    expected: 0n,
    returnWidth: 32,
    signedReturn: false,
  };
  if (topic === 'arithmetic') {
    program.source = ['uint32_t add(uint32_t a, uint32_t b) {', '  return a + b;', '}'];
    program.registers = {
      RCX: unsignedValue(BigInt(p.a), 32),
      RDX: unsignedValue(BigInt(p.b), 32),
    };
    program.bindings = [
      { name: 'a', register: 'ECX' },
      { name: 'b', register: 'EDX' },
    ];
    label('add', 0);
    binary('MOV', 'EAX', reg('ECX'), 1);
    binary('ADD', 'EAX', reg('EDX'), 1);
    emit(1, { op: 'RET' });
    program.expected = unsignedValue(BigInt(p.a) + BigInt(p.b), 32);
  } else if (topic === 'branch') {
    const type = p.unsigned ? 'uint32_t' : 'int32_t';
    program.source = [
      `int less(${type} a, ${type} b) {`,
      '  int result = 0;',
      '  if (a < b) {',
      '    result = 1;',
      '  }',
      '  return result;',
      '}',
    ];
    program.registers = {
      RCX: unsignedValue(BigInt(p.a), 32),
      RDX: unsignedValue(BigInt(p.b), 32),
    };
    program.bindings = [
      { name: 'a', register: 'ECX', signed: !p.unsigned },
      { name: 'b', register: 'EDX', signed: !p.unsigned },
      { name: 'result', register: 'EAX' },
    ];
    label('less', 0);
    binary('MOV', 'EAX', imm(0), 1);
    binary('CMP', 'ECX', reg('EDX'), 2);
    emit(2, { op: p.unsigned ? 'JAE' : 'JGE', target: 'done' });
    binary('MOV', 'EAX', imm(1), 3);
    label('done', 5);
    emit(5, { op: 'RET' });
    const a = p.unsigned ? BigInt.asUintN(32, BigInt(p.a)) : BigInt.asIntN(32, BigInt(p.a));
    const b = p.unsigned ? BigInt.asUintN(32, BigInt(p.b)) : BigInt.asIntN(32, BigInt(p.b));
    program.expected = a < b ? 1n : 0n;
  } else if (topic === 'loop') {
    program.source = [
      'uint32_t sum_to(uint32_t n) {',
      '  uint32_t sum = 0;',
      '  uint32_t i = 0;',
      '  while (i < n) {',
      '    sum = sum + i;',
      '    i = i + 1;',
      '  }',
      '  return sum;',
      '}',
    ];
    program.registers = { RCX: BigInt(p.n) };
    program.bindings = [
      { name: 'n', register: 'ECX' },
      { name: 'i', register: 'EDX' },
      { name: 'sum', register: 'EAX' },
    ];
    label('sum_to', 0);
    binary('XOR', 'EAX', reg('EAX'), 1);
    binary('XOR', 'EDX', reg('EDX'), 2);
    label('loop_test', 3);
    binary('CMP', 'EDX', reg('ECX'), 3);
    emit(3, { op: 'JAE', target: 'done' });
    binary('ADD', 'EAX', reg('EDX'), 4);
    binary('ADD', 'EDX', imm(1), 5);
    emit(3, { op: 'JMP', target: 'loop_test' });
    label('done', 7);
    emit(7, { op: 'RET' });
    program.expected = BigInt((p.n * (p.n - 1)) / 2);
  } else if (topic === 'memory') {
    program.source = ['int32_t read_at(const int32_t *a, uint32_t i) {', '  return a[i];', '}'];
    program.registers = { RCX: ARRAY_BASE, RDX: BigInt(p.index) };
    program.array = { address: ARRAY_BASE, values: [...p.array] };
    program.signedReturn = true;
    program.bindings = [
      { name: 'a 的首地址', register: 'RCX' },
      { name: 'i', register: 'EDX' },
    ];
    label('read_at', 0);
    const location: Operand = { kind: 'mem', base: 'RCX', index: 'RDX', scale: 4, width: 32 };
    if (p.addressFirst) {
      binary('LEA', 'R8', location, 1);
      binary('MOV', 'EAX', { kind: 'mem', base: 'R8', width: 32 }, 1);
    } else binary('MOV', 'EAX', location, 1);
    emit(1, { op: 'RET' });
    program.expected = unsignedValue(BigInt(p.array[p.index]), 32);
  } else if (topic === 'call') {
    program.source = [
      'uint32_t add(uint32_t a, uint32_t b) {',
      '  return a + b;',
      '}',
      '',
      'uint32_t caller(void) {',
      `  return add(${p.a}, ${p.b});`,
      '}',
    ];
    program.bindings = [
      { name: 'add 的 a', register: 'ECX' },
      { name: 'add 的 b', register: 'EDX' },
    ];
    label('caller', 4);
    binary('MOV', 'ECX', imm(p.a), 5);
    binary('MOV', 'EDX', imm(p.b), 5);
    binary('SUB', 'RSP', imm(40), 5);
    emit(5, { op: 'CALL', target: 'add' });
    binary('ADD', 'RSP', imm(40), 5);
    emit(5, { op: 'RET' });
    label('add', 0);
    binary('MOV', 'EAX', reg('ECX'), 1);
    binary('ADD', 'EAX', reg('EDX'), 1);
    emit(1, { op: 'RET' });
    program.expected = unsignedValue(BigInt(p.a) + BigInt(p.b), 32);
  } else {
    const before = BigInt(`0x${p.registerHex}`);
    const value = BigInt(`0x${p.writeHex}`);
    program.returnWidth = 64;
    program.initialRax = before;
    program.source = [
      '// 寄存器窗口操作；不是可编译的 C 程序',
      `RAX = 0x${p.registerHex};`,
      `${p.alias} = 0x${p.writeHex};`,
    ];
    label('register_window', 0);
    binary('MOV', p.alias, imm(value), 2);
    program.expected =
      p.alias === 'RAX'
        ? value
        : p.alias === 'EAX'
          ? value
          : p.alias === 'AX'
            ? (before & ~0xffffn) | value
            : p.alias === 'AH'
              ? (before & ~0xff00n) | (value << 8n)
              : (before & ~0xffn) | value;
  }
  return program;
}
