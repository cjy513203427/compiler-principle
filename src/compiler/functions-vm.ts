import type { Value } from './model';
import { evaluateBinary } from './operations';
import type { CallInstruction, CallProgram } from './functions';

export const MAX_CALL_DEPTH = 32; // Includes the top-level frame.
export const MAX_CALL_STEPS = 2000;
export const MAX_CALL_FRAMES = 400;
export function callInstructionText(instruction: CallInstruction): string {
  if (instruction.op === 'CALL') return `CALL ${instruction.name} / ${instruction.arity}`;
  return `${instruction.op}${'key' in instruction ? ` ${instruction.key}` : 'value' in instruction ? ` ${instruction.value}` : 'operator' in instruction ? ` ${instruction.operator}` : 'target' in instruction ? ` ${instruction.target}` : ''}`;
}
export interface Activation {
  id: number; name: string; pc: number; returnTo?: { name: string; pc: number };
  locals: Record<string, Value>; stack: Value[];
}
export interface CallEvent {
  kind: 'call' | 'return'; id: number; name: string; depth: number;
  args?: Value[]; value?: Value; executed: number;
}
export interface CallFrame {
  message: string; activations: Activation[]; output: Value[]; executed: number; eventCount: number;
  maxDepth: number; calls: number; location?: { start: number; end: number };
  status: 'running' | 'halted' | 'error' | 'limit';
}
export interface CallExecution {
  frames: CallFrame[]; events: CallEvent[]; output: Value[];
  halted: boolean; limited: boolean; error?: string; executed: number; calls: number; maxDepth: number; truncated: boolean;
}

export function executeFunctions(program: CallProgram, budget = MAX_CALL_STEPS): CallExecution {
  const activations: Activation[] = [{ id: 0, name: program.main, pc: 0, locals: Object.create(null), stack: [] }];
  const output: Value[] = [], events: CallEvent[] = [], frames: CallFrame[] = [];
  let serial = 1, executed = 0, maxDepth = 1, calls = 0;
  let truncated = false;
  const snapshot = (message: string, status: CallFrame['status'], location?: CallFrame['location']) => {
    if (frames.length >= MAX_CALL_FRAMES && status === 'running') { truncated = true; return; }
    frames.push({ message, status, location, executed, maxDepth, calls, eventCount: events.length, output: [...output],
      activations: activations.map((frame) => ({ ...frame, returnTo: frame.returnTo && { ...frame.returnTo }, locals: { ...frame.locals }, stack: [...frame.stack] })) });
  };
  const result = (halted: boolean, limited: boolean, error?: string): CallExecution => ({
    frames, events, output, halted, limited, error, executed, calls, maxDepth, truncated,
  });
  snapshot('顶层帧就绪；CALL 将创建独立的局部变量表和操作数栈。', 'running');
  const limit = Number.isFinite(budget) ? Math.max(1, Math.min(MAX_CALL_STEPS, Math.floor(budget))) : MAX_CALL_STEPS;
  while (executed < limit) {
    const active = activations.at(-1)!;
    const fn = program.functions.get(active.name)!;
    const instruction = fn.code[active.pc];
    if (!instruction) {
      const error = '执行到函数末尾或无效 PC；缺少 RETURN / HALT。'; snapshot(error, 'error'); return result(false, false, error);
    }
    const location = { start: instruction.start, end: instruction.end };
    const oldStack = [...active.stack];
    let message = `${active.name} : ${active.pc} · ${callInstructionText(instruction)}。`;
    const pop = () => { if (!active.stack.length) throw new Error('当前帧的操作数栈下溢。'); return active.stack.pop()!; };
    executed++;
    try {
      let next = active.pc + 1;
      switch (instruction.op) {
        case 'PUSH': active.stack.push(instruction.value); break;
        case 'LOAD':
          if (!Object.hasOwn(active.locals, instruction.key)) throw new Error(`读取未初始化局部变量 ${instruction.key}。`);
          active.stack.push(active.locals[instruction.key]); break;
        case 'STORE': active.locals[instruction.key] = pop(); break;
        case 'BINARY': { const right = pop(), left = pop(); active.stack.push(evaluateBinary(instruction.operator, left, right)); break; }
        case 'PRINT': output.push(pop()); break;
        case 'DROP': pop(); break;
        case 'JUMP': next = instruction.target; break;
        case 'BR_FALSE': { const value = pop(); if (typeof value !== 'boolean') throw new Error('条件跳转需要 bool 值。'); if (!value) next = instruction.target; break; }
        case 'CALL': {
          if (activations.length >= MAX_CALL_DEPTH) {
            snapshot(`调用深度达到 ${MAX_CALL_DEPTH} 帧（含顶层），暂停执行；这不等于证明递归不会结束。`, 'limit', location);
            return result(false, true);
          }
          const callee = program.functions.get(instruction.name);
          if (!callee || instruction.arity !== callee.params.length || active.stack.length < instruction.arity) throw new Error('调用目标、参数数量或操作数栈无效。');
          const args = active.stack.splice(active.stack.length - instruction.arity, instruction.arity);
          const locals: Record<string, Value> = Object.create(null);
          callee.params.forEach((param, i) => { locals[param.key] = args[i]; });
          const id = serial++;
          active.pc = next;
          activations.push({ id, name: callee.name, pc: 0, returnTo: { name: active.name, pc: next }, locals, stack: [] });
          calls++; maxDepth = Math.max(maxDepth, activations.length);
          events.push({ kind: 'call', id, name: callee.name, depth: activations.length, args: [...args], executed });
          message += ` 创建帧 #${id}，按值绑定形参；调用者暂停在返回位置 ${next}。`;
          snapshot(message, 'running', location); continue;
        }
        case 'RETURN': {
          if (activations.length === 1 || active.stack.length !== 1) throw new Error('RETURN 需要一个返回值与调用者帧。');
          const value = pop(); activations.pop(); const caller = activations.at(-1)!;
          caller.stack.push(value);
          events.push({ kind: 'return', id: active.id, name: active.name, depth: activations.length + 1, value, executed });
          message += ` 帧 #${active.id} 出栈，${value} 压入调用者操作数栈，继续 ${caller.name} : ${caller.pc}。`;
          snapshot(message, 'running', location); continue;
        }
        case 'HALT':
          if (activations.length !== 1 || active.stack.length) throw new Error('HALT 时调用栈或操作数栈不平衡。');
          snapshot('HALT：顶层程序结束；所有函数均已返回。', 'halted', location); return result(true, false);
      }
      if (next < 0 || next >= fn.code.length) throw new Error('函数内跳转地址越界。');
      active.pc = next; snapshot(message, 'running', location);
    } catch (error) {
      active.stack = oldStack;
      const detail = error instanceof Error ? error.message : String(error);
      snapshot(`运行时错误：${detail} 当前调用链保留供检查，后续输出不执行。`, 'error', location);
      return result(false, false, detail);
    }
  }
  snapshot(`已执行 ${limit} 条字节码，暂停于本次前缀；这不等于证明程序不会终止。`, 'limit');
  return result(false, true);
}
