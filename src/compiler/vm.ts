import { evaluateBinary } from './operations';
import { type Instruction, type Operand, type Bytecode, type VmStep, type Value } from './model';

export const MAX_VM_STEPS = 2000;
const operations = {
  '+': 'ADD',
  '-': 'SUB',
  '*': 'MUL',
  '/': 'DIV',
  '<': 'LT',
  '<=': 'LE',
  '>': 'GT',
  '>=': 'GE',
  '==': 'EQ',
  '!=': 'NE',
} as const;
const operators = {
  ADD: '+',
  SUB: '-',
  MUL: '*',
  DIV: '/',
  LT: '<',
  LE: '<=',
  GT: '>',
  GE: '>=',
  EQ: '==',
  NE: '!=',
} as const;
export function generateBytecode(instructions: Instruction[]): Bytecode[] {
  const code: Bytecode[] = [];
  const labels = new Map<string, number>();
  const unresolved: { index: number; target: string }[] = [];
  instructions.forEach((instruction, irIndex) => {
    const emit = (bytecode: Bytecode) => code.push({ ...bytecode, irIndex });
    const push = (operand: Operand) =>
      emit(
        operand.kind === 'constant'
          ? { op: 'PUSH', value: operand.value }
          : { op: 'LOAD', name: operand.name },
      );
    if (instruction.op === 'label') {
      labels.set(instruction.name, code.length);
      emit({ op: 'LABEL', name: instruction.name });
    } else if (instruction.op === 'jump' || instruction.op === 'branch') {
      if (instruction.op === 'branch') push(instruction.condition);
      unresolved.push({ index: code.length, target: instruction.target });
      emit({ op: instruction.op === 'jump' ? 'JUMP' : 'BR_FALSE', target: -1 });
    } else if (instruction.op === 'print') {
      push(instruction.value);
      emit({ op: 'PRINT' });
    } else {
      if (instruction.op === 'move') push(instruction.value);
      else {
        push(instruction.left);
        push(instruction.right);
        emit({ op: operations[instruction.operator as keyof typeof operations] });
      }
      emit({ op: 'STORE', name: instruction.dest });
    }
  });
  for (const fixup of unresolved) {
    const target = labels.get(fixup.target);
    if (target === undefined) throw new Error(`不存在的跳转标签 ${fixup.target}。`);
    (code[fixup.index] as Extract<Bytecode, { target: number }>).target = target;
  }
  code.push({ op: 'HALT', irIndex: instructions.length });
  return code;
}
export function bytecodeText(instruction: Bytecode): string {
  return (
    instruction.op +
    ('name' in instruction
      ? ` ${instruction.name}`
      : 'value' in instruction
        ? ` ${instruction.value}`
        : 'target' in instruction
          ? ` ${instruction.target}`
          : '')
  );
}
export interface Execution {
  steps: VmStep[];
  output: Value[];
  halted: boolean;
  limited: boolean;
  error?: { message: string; pc: number };
}
export function execute(code: Bytecode[], budget = MAX_VM_STEPS): Execution {
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
  let pc = 0;
  const limit = Math.max(1, Math.min(MAX_VM_STEPS, Math.floor(budget) || MAX_VM_STEPS));
  for (let executed = 0; pc < code.length && executed < limit; executed++) {
    const instruction = code[pc];
    const previousStack = [...stack];
    let nextPc = pc + 1;
    let conditionResult: boolean | undefined;
    let message = `执行 ${bytecodeText(instruction)}。`;
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
        case 'LABEL':
          break;
        case 'JUMP':
          nextPc = instruction.target;
          break;
        case 'BR_FALSE': {
          const condition = pop();
          if (typeof condition !== 'boolean') throw new Error('条件跳转需要 bool 值。');
          conditionResult = condition;
          if (!condition) nextPc = instruction.target;
          message += `条件为 ${condition}，${condition ? '顺序进入真分支' : `跳转到 PC ${nextPc}`}。`;
          break;
        }
        case 'HALT':
          message = '执行 HALT，程序结束。';
          break;
        default: {
          const right = pop();
          const left = pop();
          stack.push(evaluateBinary(operators[instruction.op], left, right));
          if (instruction.op === 'SUB' || instruction.op === 'DIV')
            message += '先弹出右操作数，再弹出左操作数。';
        }
      }
      if (nextPc < 0 || nextPc > code.length) throw new Error('跳转地址越界。');
      steps.push({
        pc,
        nextPc,
        message,
        stack: [...stack],
        memory: { ...memory },
        output: [...output],
        condition: conditionResult,
      });
      if (instruction.op === 'HALT') return { steps, output, halted: true, limited: false };
      pc = nextPc;
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
      return { steps, output, error: { message, pc }, halted: false, limited: false };
    }
  }
  if (pc < code.length) {
    steps.at(-1)!.message +=
      ` 已达到 ${limit} 条指令的回放上限，执行被暂停；这不等于证明程序不会终止。`;
    return { steps, output, halted: false, limited: true };
  }
  return { steps, output, halted: false, limited: false };
}
