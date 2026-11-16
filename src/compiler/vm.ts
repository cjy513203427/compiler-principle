import { arithmetic } from './ir';
import { type Instruction, type Operand, type Bytecode, type VmStep, type Value } from './model';

export function generateBytecode(instructions: Instruction[]): Bytecode[] {
  const code: Bytecode[] = [];
  const push = (operand: Operand) =>
    code.push(
      operand.kind === 'constant'
        ? { op: 'PUSH', value: operand.value }
        : { op: 'LOAD', name: operand.name },
    );
  for (const instruction of instructions) {
    if (instruction.op === 'print') {
      push(instruction.value);
      code.push({ op: 'PRINT' });
    } else {
      if (instruction.op === 'move') push(instruction.value);
      else {
        push(instruction.left);
        push(instruction.right);
        code.push({
          op: ({ '+': 'ADD', '-': 'SUB', '*': 'MUL', '/': 'DIV' } as const)[
            instruction.operator as '+'
          ],
        });
      }
      code.push({ op: 'STORE', name: instruction.dest });
    }
  }
  code.push({ op: 'HALT' });
  return code;
}
export function bytecodeText(instruction: Bytecode): string {
  return (
    instruction.op +
    ('name' in instruction
      ? ` ${instruction.name}`
      : 'value' in instruction
        ? ` ${instruction.value}`
        : '')
  );
}
export function execute(code: Bytecode[]): {
  steps: VmStep[];
  output: Value[];
  error?: { message: string; pc: number };
} {
  const stack: Value[] = [];
  const memory: Record<string, Value> = Object.create(null);
  const output: Value[] = [];
  const steps: VmStep[] = [
    {
      pc: -1,
      nextPc: 0,
      message: '虚拟机就绪：操作数栈与局部变量表均为空。',
      stack: [],
      memory: {},
      output: [],
    },
  ];
  const pop = (): Value => {
    if (!stack.length) throw new Error('操作数栈下溢。');
    return stack.pop()!;
  };
  for (let pc = 0; pc < code.length; pc++) {
    const instruction = code[pc];
    const previousStack = [...stack];
    try {
      switch (instruction.op) {
        case 'PUSH':
          stack.push(instruction.value);
          break;
        case 'LOAD':
          if (!(instruction.name in memory))
            throw new Error(`读取未初始化变量 ${instruction.name}。`);
          stack.push(memory[instruction.name]);
          break;
        case 'STORE':
          memory[instruction.name] = pop();
          break;
        case 'PRINT':
          output.push(pop());
          break;
        case 'HALT':
          break;
        default: {
          const right = pop();
          const left = pop();
          stack.push(
            arithmetic(
              ({ ADD: '+', SUB: '-', MUL: '*', DIV: '/' } as const)[instruction.op],
              left,
              right,
            ),
          );
        }
      }
      steps.push({
        pc,
        nextPc: pc + 1,
        message:
          instruction.op === 'HALT'
            ? '执行 HALT，程序结束。'
            : `执行 ${bytecodeText(instruction)}。${instruction.op === 'SUB' || instruction.op === 'DIV' ? '先弹出右操作数，再弹出左操作数。' : ''}`,
        stack: [...stack],
        memory: { ...memory },
        output: [...output],
      });
      if (instruction.op === 'HALT') break;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      steps.push({
        pc,
        nextPc: pc,
        message: `运行时错误：${message}`,
        stack: previousStack,
        memory: { ...memory },
        output: [...output],
      });
      return { steps, output, error: { message, pc } };
    }
  }
  return { steps, output };
}
