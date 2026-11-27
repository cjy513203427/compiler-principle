import { T } from '../i18n';
import { compileFunctions, MAIN_FUNCTION, type CallProgram } from './functions';
import { executeFunctions, MAX_CALL_DEPTH, MAX_CALL_STEPS } from './functions-vm';
import { analyzeConstants, joinFact, sameFact, factText, type Fact } from './dataflow';
import { instructionText, operandText, optimize } from './ir';
import { evaluateBinary } from './operations';
import { compareExecutions } from './regalloc';
import { execute, generateBytecode, type Execution } from './vm';
import { CompileError, constant, type DataType, type Instruction, type Operand, type OptimizationStep, type Value } from './model';

/** Three-address IR with calls. Mini C instructions plus call / return; locals are per function. */
export type PInstruction =
  | Instruction
  | { op: 'call'; dest?: string; name: string; args: Operand[]; nodeId: number }
  | { op: 'return'; value: Operand; nodeId: number };
export interface PFunction { name: string; params: string[]; returnType?: DataType; code: PInstruction[] }
export type PProgram = Map<string, PFunction>;
export const INLINE_LIMIT = 16;
const MAX_PROGRAM = 4000;
const MAX_ROUNDS = 64;
const MAX_FRAMES = 400;
const ARITHMETIC = new Set(['+', '-', '*', '/']);

export function pInstructionText(instruction: PInstruction): string {
  if (instruction.op === 'call')
    return `${instruction.dest ? `${instruction.dest} = ` : ''}call ${instruction.name}(${instruction.args.map(operandText).join(', ')})`;
  if (instruction.op === 'return') return `return ${operandText(instruction.value)}`;
  return instructionText(instruction);
}
const operandsOf = (instruction: PInstruction): Operand[] =>
  instruction.op === 'binary' ? [instruction.left, instruction.right]
    : instruction.op === 'move' || instruction.op === 'print' || instruction.op === 'return' ? [instruction.value]
      : instruction.op === 'branch' ? [instruction.condition]
        : instruction.op === 'call' ? instruction.args : [];
const destOf = (instruction: PInstruction) => ('dest' in instruction ? instruction.dest : undefined);
const realSize = (code: PInstruction[]) => code.filter((instruction) => instruction.op !== 'label').length;

/** Translate stack bytecode with a symbolic operand stack. Statements leave the stack empty,
 *  and a callee cannot touch the caller's locals, so deferring a LOAD to its consumer is safe. */
export function lowerProgram(program: CallProgram): PProgram {
  const lowered: PProgram = new Map();
  for (const fn of program.functions.values()) {
    const targets = new Set(fn.code.flatMap((instruction) => (instruction.op === 'JUMP' || instruction.op === 'BR_FALSE' ? [instruction.target] : [])));
    const code: PInstruction[] = [];
    const stack: Operand[] = [];
    let temp = 0;
    const pop = () => {
      const value = stack.pop();
      if (!value) throw new Error(T('{#0} 的字节码栈不平衡。', fn.name));
      return value;
    };
    fn.code.forEach((instruction, pc) => {
      if (targets.has(pc)) code.push({ op: 'label', name: `L${pc}`, nodeId: instruction.start });
      const nodeId = instruction.start;
      switch (instruction.op) {
        case 'PUSH': stack.push(constant(instruction.value)); break;
        case 'LOAD': stack.push({ kind: 'ref', name: instruction.key }); break;
        case 'STORE': code.push({ op: 'move', dest: instruction.key, value: pop(), nodeId }); break;
        case 'BINARY': {
          const right = pop(), left = pop(), dest = `t${temp++}`;
          code.push({ op: 'binary', dest, operator: instruction.operator, left, right, nodeId });
          stack.push({ kind: 'ref', name: dest });
          break;
        }
        case 'CALL': {
          const args = stack.splice(stack.length - instruction.arity, instruction.arity), dest = `t${temp++}`;
          code.push({ op: 'call', dest, name: instruction.name, args, nodeId });
          stack.push({ kind: 'ref', name: dest });
          break;
        }
        case 'DROP': {
          const value = pop();
          const call = [...code].reverse().find((item) => item.op === 'call' && value.kind === 'ref' && item.dest === value.name);
          if (call && call.op === 'call') delete call.dest;
          break;
        }
        case 'PRINT': code.push({ op: 'print', value: pop(), nodeId }); break;
        case 'RETURN': code.push({ op: 'return', value: pop(), nodeId }); break;
        case 'JUMP': code.push({ op: 'jump', target: `L${instruction.target}`, nodeId }); break;
        case 'BR_FALSE': code.push({ op: 'branch', condition: pop(), target: `L${instruction.target}`, nodeId }); break;
        case 'HALT': break;
      }
    });
    if (targets.has(fn.code.length)) code.push({ op: 'label', name: `L${fn.code.length}`, nodeId: 0 });
    lowered.set(fn.name, { name: fn.name, params: fn.params.map((param) => param.key), returnType: fn.returnType, code });
  }
  return lowered;
}

export interface PExecution extends Pick<Execution, 'output' | 'halted' | 'limited'> {
  error?: { message: string; pc: number };
  executed: number;
  calls: number;
  maxDepth: number;
}
/** Run the IR with one frame per call: the same depth and step limits as the function VM. */
export function runProgram(program: PProgram, main = MAIN_FUNCTION, budget = MAX_CALL_STEPS): PExecution {
  const labels = new Map([...program].map(([name, fn]) => [name, new Map(fn.code.flatMap((instruction, index) => (instruction.op === 'label' ? [[instruction.name, index] as const] : [])))]));
  type Frame = { fn: PFunction; pc: number; env: Map<string, Value>; dest?: string };
  const frames: Frame[] = [{ fn: program.get(main)!, pc: 0, env: new Map() }];
  const output: Value[] = [];
  let executed = 0, calls = 0, maxDepth = 1;
  const result = (extra: Partial<PExecution>): PExecution => ({ output, halted: false, limited: false, executed, calls, maxDepth, ...extra });
  while (true) {
    const frame = frames.at(-1)!;
    const instruction = frame.fn.code[frame.pc];
    if (!instruction) {
      if (frames.length === 1) return result({ halted: true });
      return result({ error: { message: T('执行到 {#0} 末尾，缺少 return。', frame.fn.name), pc: frame.pc } });
    }
    if (instruction.op === 'label') { frame.pc++; continue; }
    if (executed >= budget) return result({ limited: true });
    executed++;
    const read = (operand: Operand): Value => {
      if (operand.kind === 'constant') return operand.value;
      if (!frame.env.has(operand.name)) throw new Error(T('读取未初始化局部变量 {#0}。', operand.name));
      return frame.env.get(operand.name)!;
    };
    const jump = (target: string) => {
      const index = labels.get(frame.fn.name)!.get(target);
      if (index === undefined) throw new Error(T('不存在的标签 {#0}。', target));
      return index;
    };
    try {
      let next = frame.pc + 1;
      switch (instruction.op) {
        case 'move': frame.env.set(instruction.dest, read(instruction.value)); break;
        case 'binary': frame.env.set(instruction.dest, evaluateBinary(instruction.operator, read(instruction.left), read(instruction.right))); break;
        case 'print': output.push(read(instruction.value)); break;
        case 'jump': next = jump(instruction.target); break;
        case 'branch': {
          const condition = read(instruction.condition);
          if (typeof condition !== 'boolean') throw new Error(T('条件跳转需要 bool 值。'));
          if (!condition) next = jump(instruction.target);
          break;
        }
        case 'call': {
          if (frames.length >= MAX_CALL_DEPTH) return result({ limited: true });
          const callee = program.get(instruction.name);
          if (!callee) throw new Error(T('函数 {#0} 不存在。', instruction.name));
          const args = instruction.args.map(read);
          frame.pc = next;
          frames.push({ fn: callee, pc: 0, env: new Map(callee.params.map((param, index) => [param, args[index]])), dest: instruction.dest });
          calls++;
          maxDepth = Math.max(maxDepth, frames.length);
          continue;
        }
        case 'return': {
          const value = read(instruction.value);
          frames.pop();
          const caller = frames.at(-1);
          if (!caller) throw new Error(T('return 没有调用者。'));
          if (frame.dest) caller.env.set(frame.dest, value);
          continue;
        }
      }
      frame.pc = next;
    } catch (error) {
      return result({ error: { message: error instanceof Error ? error.message : String(error), pc: frame.pc } });
    }
  }
}

export interface CallSite { caller: string; index: number; callee: string }
export interface CallGraph { functions: string[]; sites: CallSite[]; edges: [string, string][]; sccs: string[][]; recursive: string[]; reachable: string[] }
export function buildCallGraph(program: PProgram, main = MAIN_FUNCTION): CallGraph {
  const functions = [...program.keys()];
  const sites: CallSite[] = [];
  for (const [name, fn] of program)
    fn.code.forEach((instruction, index) => { if (instruction.op === 'call') sites.push({ caller: name, index, callee: instruction.name }); });
  const edges = [...new Set(sites.map((site) => `${site.caller}\u0000${site.callee}`))].map((key) => key.split('\u0000') as [string, string]);
  const out = new Map(functions.map((name) => [name, edges.filter(([from]) => from === name).map(([, to]) => to)]));
  // Tarjan: SCCs come out callees first, which is the bottom-up order used below.
  const index = new Map<string, number>(), low = new Map<string, number>(), stack: string[] = [], onStack = new Set<string>();
  const sccs: string[][] = [];
  let counter = 0;
  const visit = (node: string) => {
    index.set(node, counter); low.set(node, counter); counter++;
    stack.push(node); onStack.add(node);
    for (const next of out.get(node) ?? []) {
      if (!index.has(next)) { visit(next); low.set(node, Math.min(low.get(node)!, low.get(next)!)); }
      else if (onStack.has(next)) low.set(node, Math.min(low.get(node)!, index.get(next)!));
    }
    if (low.get(node) === index.get(node)) {
      const component: string[] = [];
      let member: string;
      do { member = stack.pop()!; onStack.delete(member); component.push(member); } while (member !== node);
      sccs.push(component.reverse());
    }
  };
  functions.forEach((name) => { if (!index.has(name)) visit(name); });
  const recursive = sccs.filter((component) => component.length > 1 || edges.some(([a, b]) => a === component[0] && b === component[0])).flat();
  const reachable = new Set([main]);
  const queue = [main];
  while (queue.length) for (const next of out.get(queue.shift()!) ?? []) if (!reachable.has(next)) { reachable.add(next); queue.push(next); }
  return { functions, sites, edges, sccs, recursive, reachable: functions.filter((name) => reachable.has(name)) };
}

export interface EffectSummary {
  name: string;
  prints: boolean;
  traps: boolean;
  diverges: boolean;
  recursive: boolean;
  pure: boolean;
  reasons: string[];
}
/** Bottom-up over the SCCs: a call has every effect its callee may have. */
export function summarizeEffects(program: PProgram, graph: CallGraph): Record<string, EffectSummary> {
  const summaries: Record<string, EffectSummary> = {};
  for (const component of graph.sccs) {
    const recursive = component.some((name) => graph.recursive.includes(name));
    const local = component.map((name) => {
      const code = program.get(name)!.code;
      const labels = new Map(code.flatMap((instruction, index) => (instruction.op === 'label' ? [[instruction.name, index] as const] : [])));
      const reasons: string[] = [];
      const prints = code.some((instruction) => instruction.op === 'print');
      if (prints) reasons.push(T('直接 print'));
      const unsafe = code.filter((instruction) => {
        if (instruction.op !== 'binary' || !ARITHMETIC.has(instruction.operator)) return false;
        // Unary minus is lowered to 0 - x; safe integers are symmetric, so it never overflows.
        if (instruction.operator === '-' && instruction.left.kind === 'constant' && instruction.left.value === 0) return false;
        // A non-zero constant divisor cannot trap: |a / c| ≤ |a|.
        if (instruction.operator === '/' && instruction.right.kind === 'constant' && instruction.right.value !== 0) return false;
        if (instruction.left.kind !== 'constant' || instruction.right.kind !== 'constant') return true;
        try { evaluateBinary(instruction.operator, instruction.left.value, instruction.right.value); return false; } catch { return true; }
      });
      if (unsafe.some((instruction) => instruction.op === 'binary' && instruction.operator === '/')) reasons.push(T('除法可能除零'));
      if (unsafe.some((instruction) => instruction.op === 'binary' && instruction.operator !== '/')) reasons.push(T('加减乘可能溢出'));
      const loops = code.some((instruction, index) => (instruction.op === 'jump' || instruction.op === 'branch') && (labels.get(instruction.target) ?? Infinity) < index);
      if (loops) reasons.push(T('含循环，可能不终止'));
      if (recursive) reasons.push(T('处在递归环里，调用深度可能达到上限'));
      return { name, prints, traps: unsafe.length > 0, diverges: loops || recursive, recursive, reasons };
    });
    // Members of one SCC reach each other, so they share every effect.
    const callees = [...new Set(component.flatMap((name) => graph.sites.filter((site) => site.caller === name).map((site) => site.callee)))]
      .filter((callee) => !component.includes(callee));
    const inherited = callees.map((callee) => summaries[callee]);
    const shared = {
      prints: local.some((item) => item.prints) || inherited.some((item) => item.prints),
      traps: local.some((item) => item.traps) || inherited.some((item) => item.traps),
      diverges: local.some((item) => item.diverges) || inherited.some((item) => item.diverges),
    };
    for (const item of local) {
      const reasons = [...item.reasons];
      for (const callee of callees) {
        const summary = summaries[callee];
        const kinds = [summary.prints && T('产生输出'), summary.traps && T('报错'), summary.diverges && T('不终止')].filter(Boolean);
        if (kinds.length) reasons.push(T('调用 {#0}（可能{#1}）', callee, kinds.join(T('、'))));
      }
      if (component.length > 1) reasons.push(T('与 {#0} 相互递归', component.filter((name) => name !== item.name).join(T('、'))));
      const effects = component.length > 1 ? shared : {
        prints: item.prints || inherited.some((summary) => summary.prints),
        traps: item.traps || inherited.some((summary) => summary.traps),
        diverges: item.diverges || inherited.some((summary) => summary.diverges),
      };
      summaries[item.name] = { name: item.name, ...effects, recursive, pure: !effects.prints && !effects.traps && !effects.diverges, reasons };
    }
  }
  return summaries;
}

type Env = Map<string, Fact>;
export interface FunctionFacts { executable: boolean[]; before: Env[]; returns: Fact | undefined; siteArgs: Map<number, (Fact | undefined)[]>; converged: boolean }
const factOf = (operand: Operand, env: Env): Fact | undefined =>
  operand.kind === 'constant' ? { kind: 'constant', value: operand.value } : env.get(operand.name);
function joinEnv(left: Env | undefined, right: Env): Env {
  if (!left) return new Map(right);
  const joined = new Map(left);
  for (const [name, fact] of right) {
    const value = joinFact(joined.get(name), fact);
    if (value) joined.set(name, value);
  }
  return joined;
}
const sameEnv = (left: Env | undefined, right: Env) =>
  !!left && left.size === right.size && [...right].every(([name, fact]) => sameFact(left.get(name), fact));

/** Conditional constant propagation inside one function. Parameters and call results come from the summaries. */
export function analyzeFunctionFacts(fn: PFunction, params: (Fact | undefined)[], returns: Record<string, Fact | undefined>): FunctionFacts {
  const code = fn.code;
  const labels = new Map(code.flatMap((instruction, index) => (instruction.op === 'label' ? [[instruction.name, index] as const] : [])));
  const leaders = new Set([0]);
  code.forEach((instruction, index) => {
    if (instruction.op === 'label') leaders.add(index);
    if (instruction.op === 'jump' || instruction.op === 'branch' || instruction.op === 'return') leaders.add(index + 1);
  });
  const starts = [...leaders].filter((index) => index < code.length).sort((a, b) => a - b);
  const blockOf: number[] = [];
  starts.forEach((start, block) => { for (let i = start; i < (starts[block + 1] ?? code.length); i++) blockOf[i] = block; });
  const entry: Env = new Map();
  fn.params.forEach((param, index) => { if (params[index]) entry.set(param, params[index]!); });
  const inputs = new Map<number, Env>([[0, entry]]);
  const outputs = new Map<number, Env>();
  const executableBlocks = new Set(starts.length ? [0] : []);
  const before: Env[] = code.map(() => new Map());
  const siteArgs = new Map<number, (Fact | undefined)[]>();
  let returnFact: Fact | undefined;
  let converged = false;
  for (let pass = 0; pass < 200; pass++) {
    let changed = false;
    returnFact = undefined;
    for (let block = 0; block < starts.length; block++) {
      if (!executableBlocks.has(block)) continue;
      const env = new Map(inputs.get(block));
      const end = starts[block + 1] ?? code.length;
      const successors: number[] = [];
      for (let index = starts[block]; index < end; index++) {
        const instruction = code[index];
        before[index] = new Map(env);
        switch (instruction.op) {
          case 'move': { const fact = factOf(instruction.value, env); if (fact) env.set(instruction.dest, fact); else env.delete(instruction.dest); break; }
          case 'binary': {
            const left = factOf(instruction.left, env), right = factOf(instruction.right, env);
            let fact: Fact | undefined;
            if (left?.kind === 'constant' && right?.kind === 'constant') {
              try { fact = { kind: 'constant', value: evaluateBinary(instruction.operator, left.value, right.value) }; }
              catch { fact = { kind: 'overdefined' }; } // traps: the value is never produced
            } else if (left && right) fact = { kind: 'overdefined' };
            if (fact) env.set(instruction.dest, fact); else env.delete(instruction.dest);
            break;
          }
          case 'call': {
            siteArgs.set(index, instruction.args.map((arg) => factOf(arg, env)));
            if (instruction.dest) { const fact = returns[instruction.name]; if (fact) env.set(instruction.dest, fact); else env.delete(instruction.dest); }
            break;
          }
          case 'return': returnFact = joinFact(returnFact, factOf(instruction.value, env)); break;
          case 'jump': successors.push(blockOf[labels.get(instruction.target)!]); break;
          case 'branch': {
            const fact = factOf(instruction.condition, env);
            const target = blockOf[labels.get(instruction.target)!];
            if (fact?.kind === 'constant') successors.push(fact.value ? block + 1 : target);
            else if (fact) successors.push(block + 1, target);
            break;
          }
          default: break;
        }
      }
      const last = code[end - 1];
      if (last && last.op !== 'jump' && last.op !== 'branch' && last.op !== 'return' && block + 1 < starts.length) successors.push(block + 1);
      if (!sameEnv(outputs.get(block), env)) { outputs.set(block, env); changed = true; }
      for (const successor of successors) {
        if (successor === undefined || successor >= starts.length) continue;
        if (!executableBlocks.has(successor)) { executableBlocks.add(successor); changed = true; }
        const joined = joinEnv(inputs.get(successor), env);
        if (!sameEnv(inputs.get(successor), joined)) { inputs.set(successor, joined); changed = true; }
      }
    }
    if (!changed) { converged = true; break; }
  }
  return { executable: code.map((_, index) => executableBlocks.has(blockOf[index])), before, returns: returnFact, siteArgs, converged };
}

export type IpcpEvent =
  | { kind: 'param'; fn: string; param: string; fact: Fact; site: CallSite }
  | { kind: 'return'; fn: string; fact: Fact };
export interface IpcpResult {
  params: Record<string, (Fact | undefined)[]>;
  returns: Record<string, Fact | undefined>;
  facts: Record<string, FunctionFacts>;
  analyzed: string[];
  events: IpcpEvent[];
  rounds: number;
  converged: boolean;
}
/** Interprocedural constant propagation: meet arguments over every executed call site, iterate to a fixpoint. */
export function propagateConstants(program: PProgram, main = MAIN_FUNCTION): IpcpResult {
  const params: Record<string, (Fact | undefined)[]> = Object.fromEntries([...program].map(([name, fn]) => [name, fn.params.map(() => undefined)]));
  const returns: Record<string, Fact | undefined> = {};
  const facts: Record<string, FunctionFacts> = {};
  const analyzed = new Set([main]);
  const events: IpcpEvent[] = [];
  let rounds = 0, converged = false;
  while (rounds < MAX_ROUNDS) {
    rounds++;
    let changed = false;
    for (const name of program.keys()) {
      if (!analyzed.has(name)) continue;
      const fn = program.get(name)!;
      const result = analyzeFunctionFacts(fn, params[name], returns);
      facts[name] = result;
      if (!result.converged) return { params, returns, facts, analyzed: [...analyzed], events, rounds, converged: false };
      for (const [index, args] of result.siteArgs) {
        if (!result.executable[index]) continue;
        const instruction = fn.code[index] as Extract<PInstruction, { op: 'call' }>;
        const callee = program.get(instruction.name)!;
        if (!analyzed.has(callee.name)) { analyzed.add(callee.name); changed = true; }
        callee.params.forEach((param, position) => {
          const joined = joinFact(params[callee.name][position], args[position]);
          if (joined && !sameFact(joined, params[callee.name][position])) {
            params[callee.name][position] = joined;
            events.push({ kind: 'param', fn: callee.name, param, fact: joined, site: { caller: name, index, callee: callee.name } });
            changed = true;
          }
        });
      }
      if (result.returns && !sameFact(result.returns, returns[name])) {
        returns[name] = result.returns;
        events.push({ kind: 'return', fn: name, fact: result.returns });
        changed = true;
      }
    }
    if (!changed) { converged = true; break; }
  }
  return { params, returns, facts, analyzed: [...analyzed], events, rounds, converged };
}

export type TransformKind = 'unreachable' | 'substitute' | 'fold' | 'branch' | 'fold-call' | 'dead-call' | 'dead-code' | 'dead-function' | 'kept-call';
export interface TransformEvent { kind: TransformKind; fn: string; text: string; round?: number }
/** Rewrite every function with the IPCP facts. Calls are removed or folded only when the callee is pure. */
export function transformProgram(program: PProgram, ipcp: IpcpResult, summaries: Record<string, EffectSummary>) {
  const output: PProgram = new Map();
  const events: TransformEvent[] = [];
  for (const [name, fn] of program) {
    if (!ipcp.analyzed.includes(name)) {
      events.push({ kind: 'dead-function', fn: name, text: T('{#0} 从 main 出发的调用都没有执行到，整个函数删除。', name) });
      continue;
    }
    const facts = ipcp.facts[name];
    const substitute = (operand: Operand, env: Env): Operand => {
      if (operand.kind !== 'ref') return operand;
      const fact = env.get(operand.name);
      return fact?.kind === 'constant' ? constant(fact.value) : operand;
    };
    let code: PInstruction[] = [];
    fn.code.forEach((instruction, index) => {
      if (instruction.op === 'label') { code.push(instruction); return; }
      if (!facts.executable[index]) { events.push({ kind: 'unreachable', fn: name, text: T('删除不可达的 {#0}', pInstructionText(instruction)) }); return; }
      const env = facts.before[index];
      const before = pInstructionText(instruction);
      let next: PInstruction;
      switch (instruction.op) {
        case 'move': case 'print': case 'return': next = { ...instruction, value: substitute(instruction.value, env) }; break;
        case 'binary': next = { ...instruction, left: substitute(instruction.left, env), right: substitute(instruction.right, env) }; break;
        case 'branch': next = { ...instruction, condition: substitute(instruction.condition, env) }; break;
        case 'call': next = { ...instruction, args: instruction.args.map((arg) => substitute(arg, env)) }; break;
        default: next = instruction;
      }
      if (pInstructionText(next) !== before) events.push({ kind: 'substitute', fn: name, text: `${before} → ${pInstructionText(next)}` });
      if (next.op === 'binary' && next.left.kind === 'constant' && next.right.kind === 'constant') {
        try {
          const value = evaluateBinary(next.operator, next.left.value, next.right.value);
          events.push({ kind: 'fold', fn: name, text: T('{#0} 折叠为 {#1} = {#2}', pInstructionText(next), next.dest, value) });
          next = { op: 'move', dest: next.dest, value: constant(value), nodeId: next.nodeId };
        } catch { /* keep the trap at run time */ }
      }
      if (next.op === 'branch' && next.condition.kind === 'constant') {
        events.push({ kind: 'branch', fn: name, text: T('{#0}：条件恒为 {#1}', pInstructionText(next), next.condition.value) });
        if (next.condition.value) return;
        next = { op: 'jump', target: next.target, nodeId: next.nodeId };
      }
      if (next.op === 'call') {
        const summary = summaries[next.name], result = ipcp.returns[next.name];
        if (summary.pure && result?.kind === 'constant') {
          if (!next.dest) {
            events.push({ kind: 'dead-call', fn: name, text: T('{#0}：结果没人用，{#1} 是纯函数，删除调用', pInstructionText(next), next.name) });
            return;
          }
          events.push({ kind: 'fold-call', fn: name, text: T('{#0}：{#1} 是纯函数且总返回 {#2}，调用换成常量', pInstructionText(next), next.name, result.value) });
          next = { op: 'move', dest: next.dest, value: constant(result.value), nodeId: next.nodeId };
        } else if (result?.kind === 'constant')
          events.push({ kind: 'kept-call', fn: name, text: T('{#0}：返回值总是 {#1}，结果可以传播，但 {#2} {#3}，调用必须保留', pInstructionText(next), result.value, next.name, summary.reasons.join(T('、'))) });
      }
      code.push(next);
    });
    // Drop pure writes nobody reads, and calls to pure functions whose result is unused.
    for (let changed = true; changed;) {
      changed = false;
      const used = new Set(code.flatMap((instruction) => operandsOf(instruction).flatMap((operand) => (operand.kind === 'ref' ? [operand.name] : []))));
      code = code.filter((instruction) => {
        const dest = destOf(instruction);
        if (instruction.op === 'call' && summaries[instruction.name].pure && (!dest || !used.has(dest))) {
          events.push({ kind: 'dead-call', fn: name, text: T('{#0}：结果没人用，{#1} 是纯函数，删除调用', pInstructionText(instruction), instruction.name) });
          changed = true; return false;
        }
        if (instruction.op === 'call' && dest && !used.has(dest)) {
          events.push({ kind: 'kept-call', fn: name, text: T('{#0}：结果没人用，但 {#1} {#2}，只丢掉结果，调用保留', pInstructionText(instruction), instruction.name, summaries[instruction.name].reasons.join(T('、'))) });
          delete (instruction as { dest?: string }).dest;
          changed = true; return true;
        }
        const pure = instruction.op === 'move' || (instruction.op === 'binary' && !ARITHMETIC.has(instruction.operator));
        if (pure && dest && !used.has(dest)) {
          events.push({ kind: 'dead-code', fn: name, text: T('{#0}：写入的值之后没人读取，删除', pInstructionText(instruction)) });
          changed = true; return false;
        }
        return true;
      });
    }
    output.set(name, { ...fn, code });
  }
  return { program: output, events };
}

export interface InlineEvent { caller: string; callee: string; instance: number; size: number; reason?: string; inlined: boolean }
/** Inline small, non-recursive callees, callees first, so an inlined body already contains its own inlining. */
export function inlineProgram(program: PProgram, graph: CallGraph, limit = INLINE_LIMIT, main = MAIN_FUNCTION) {
  const result: PProgram = new Map([...program].map(([name, fn]) => [name, { ...fn, code: [...fn.code] }]));
  const events: InlineEvent[] = [];
  let instance = 0;
  const order = graph.sccs.flat().filter((name) => result.has(name));
  for (const name of order) {
    const fn = result.get(name)!;
    const code: PInstruction[] = [];
    for (const instruction of fn.code) {
      if (instruction.op !== 'call') { code.push(instruction); continue; }
      const callee = result.get(instruction.name)!;
      const size = realSize(callee.code);
      const reason = graph.recursive.includes(instruction.name) ? T('递归函数不能完全展开')
        : size > limit ? T('{#0} 条超过内联上限 {#1}', size, limit)
          : code.length + size > MAX_PROGRAM ? T('展开后代码过大') : undefined;
      if (reason) { events.push({ caller: name, callee: instruction.name, instance: 0, size, reason, inlined: false }); code.push(instruction); continue; }
      const id = ++instance;
      const prefix = `${instruction.name}@${id}.`;
      const rename = (value: string) => `${prefix}${value}`;
      const operand = (value: Operand): Operand => (value.kind === 'ref' ? { kind: 'ref', name: rename(value.name) } : value);
      const end = `${prefix}end`;
      callee.params.forEach((param, index) => code.push({ op: 'move', dest: rename(param), value: instruction.args[index], nodeId: instruction.nodeId }));
      for (const body of callee.code) {
        switch (body.op) {
          case 'label': code.push({ ...body, name: rename(body.name) }); break;
          case 'jump': code.push({ ...body, target: rename(body.target) }); break;
          case 'branch': code.push({ ...body, condition: operand(body.condition), target: rename(body.target) }); break;
          case 'move': code.push({ ...body, dest: rename(body.dest), value: operand(body.value) }); break;
          case 'binary': code.push({ ...body, dest: rename(body.dest), left: operand(body.left), right: operand(body.right) }); break;
          case 'print': code.push({ ...body, value: operand(body.value) }); break;
          case 'call': code.push({ ...body, dest: body.dest && rename(body.dest), args: body.args.map(operand) }); break;
          case 'return':
            if (instruction.dest) code.push({ op: 'move', dest: instruction.dest, value: operand(body.value), nodeId: body.nodeId });
            code.push({ op: 'jump', target: end, nodeId: body.nodeId });
            break;
        }
      }
      code.push({ op: 'label', name: end, nodeId: instruction.nodeId });
      events.push({ caller: name, callee: instruction.name, instance: id, size, inlined: true });
    }
    result.set(name, { ...fn, code });
  }
  // Functions nobody calls any more disappear from the final program.
  const graphAfter = buildCallGraph(result, main);
  for (const name of [...result.keys()]) if (!graphAfter.reachable.includes(name)) result.delete(name);
  return { program: result, events };
}

export type InterprocFrame =
  | { kind: 'lower'; fn: string; message: string }
  | { kind: 'graph'; message: string }
  | { kind: 'summary'; fn: string; message: string }
  | { kind: 'ipcp'; event: number; message: string }
  | { kind: 'transform'; fn: string; message: string }
  | { kind: 'inline'; event: number; message: string }
  | { kind: 'minic'; message: string }
  | { kind: 'complete'; message: string };
export interface RunRow { id: 'vm' | 'ir' | 'ipcp' | 'inline' | 'minic'; label: string; execution?: PExecution; outcome: 'same' | 'different' | 'unknown' | 'skipped'; note?: string }
export interface InterprocAnalysis {
  program: CallProgram;
  lowered: PProgram;
  graph: CallGraph;
  summaries: Record<string, EffectSummary>;
  /** Effects recomputed on the rewritten program; specialization can make a function pure. */
  finalSummaries: Record<string, EffectSummary>;
  ipcp: IpcpResult;
  rounds: number;
  optimized: PProgram;
  transformEvents: TransformEvent[];
  inlined: PProgram;
  inlineEvents: InlineEvent[];
  minic?: { steps: OptimizationStep[]; execution: Execution };
  remainingCalls: string[];
  runs: RunRow[];
  baseline: { output: Value[]; halted: boolean; limited: boolean; error?: { message: string; pc: number }; executed: number; calls: number };
  frames: InterprocFrame[];
  traceTruncated: boolean;
}
const allOn = { fold: true, propagate: true, dead: true };
const programText = (program: PProgram) => [...program].map(([name, fn]) => `${name}:${fn.code.map(pInstructionText).join(';')}`).join('|');
const eventText = (event: IpcpEvent) => event.kind === 'param'
  ? T('调用点 {#0} 第 {#1} 条把实参合入 {#2} 的形参 {#3}：现在是 {#4}。', event.site.caller, event.site.index, event.fn, event.param, factText(event.fact))
  : T('{#0} 的所有 return 合并后，返回值现在是 {#1}。', event.fn, factText(event.fact));
const factLabel = (fact: Fact | undefined) => (fact ? factText(fact) : T('⊥（没被调用）'));

export function analyzeInterprocedural(program: CallProgram): InterprocAnalysis {
  const lowered = lowerProgram(program);
  const graph = buildCallGraph(lowered);
  const summaries = summarizeEffects(lowered, graph);
  const ipcp = propagateConstants(lowered);
  // Rewriting can remove the arithmetic that made a callee impure (add(3, 4) → return 7),
  // so summarize, propagate and rewrite again until the program stops changing.
  const transformEvents: TransformEvent[] = [];
  let optimized = lowered, rounds = 0, roundSummaries = summaries, roundIpcp = ipcp;
  while (rounds < 4) {
    rounds++;
    const step = transformProgram(optimized, roundIpcp, roundSummaries);
    // A kept call is reported once, not again in every later round.
    transformEvents.push(...step.events.filter((event) => event.kind !== 'kept-call' || !transformEvents.some((seen) => seen.text === event.text)).map((event) => ({ ...event, round: rounds })));
    const unchanged = programText(step.program) === programText(optimized);
    optimized = step.program;
    if (unchanged) break;
    roundSummaries = summarizeEffects(optimized, buildCallGraph(optimized));
    roundIpcp = propagateConstants(optimized);
  }
  const optimizedGraph = buildCallGraph(optimized);
  const finalSummaries = summarizeEffects(optimized, optimizedGraph);
  const { program: inlined, events: inlineEvents } = inlineProgram(optimized, optimizedGraph);
  const mainCode = inlined.get(MAIN_FUNCTION)!.code;
  const remainingCalls = [...new Set(mainCode.flatMap((instruction) => (instruction.op === 'call' ? [instruction.name] : [])))];
  const vm = executeFunctions(program);
  const baseline = { output: vm.output, halted: vm.halted, limited: vm.limited, error: vm.error ? { message: vm.error, pc: 0 } : undefined, executed: vm.executed, calls: vm.calls };
  let minic: InterprocAnalysis['minic'];
  if (!remainingCalls.length) {
    const plain = mainCode as Instruction[];
    const steps = optimize(plain, allOn, analyzeConstants(plain));
    minic = { steps, execution: execute(generateBytecode(steps.at(-1)!.instructions)) };
  }
  const compare = (execution: PExecution | Execution) => compareExecutions(baseline, execution);
  const lowerRun = runProgram(lowered), optimizedRun = runProgram(optimized), inlinedRun = runProgram(inlined);
  const runs: RunRow[] = [
    { id: 'vm', label: T('实验 16 · 函数字节码 VM'), execution: { ...baseline, maxDepth: vm.maxDepth }, outcome: 'same', note: T('对照基线') },
    { id: 'ir', label: T('降低后的三地址 IR'), execution: lowerRun, outcome: compare(lowerRun) },
    { id: 'ipcp', label: T('跨过程常量传播与清理后'), execution: optimizedRun, outcome: compare(optimizedRun) },
    { id: 'inline', label: T('内联后'), execution: inlinedRun, outcome: compare(inlinedRun) },
    minic
      ? { id: 'minic', label: T('内联后的 main → 实验 05 优化器 → 栈式 VM'), execution: { ...minic.execution, executed: minic.execution.steps.length - 1, calls: 0, maxDepth: 1 }, outcome: compare(minic.execution) }
      : { id: 'minic', label: T('内联后的 main → 实验 05 优化器 → 栈式 VM'), outcome: 'skipped', note: T('main 仍调用 {#0}，旧优化器没有给 call 建模，不交给它', remainingCalls.join(T('、'))) },
  ];
  const frames: InterprocFrame[] = [];
  let traceTruncated = false;
  const push = (frame: InterprocFrame) => { if (frames.length < MAX_FRAMES) frames.push(frame); else traceTruncated = true; };
  for (const [name, fn] of lowered)
    push({ kind: 'lower', fn: name, message: T('把 {#0} 的栈式字节码翻译成三地址 IR：用一个符号栈记住每个值来自常量、变量还是临时值；CALL 变成 call 指令，结果放进新临时值。共 {#1} 条。', name === MAIN_FUNCTION ? T('顶层程序') : name, realSize(fn.code)) });
  const recursiveText = graph.recursive.length
    ? T('递归环：{#0}。', graph.sccs.filter((component) => component.some((name) => graph.recursive.includes(name))).map((component) => component.join(' ⇄ ')).join(T('；')))
    : T('没有递归。');
  const unreachableText = graph.functions.length > graph.reachable.length
    ? T('从 main 到不了：{#0}。', graph.functions.filter((name) => !graph.reachable.includes(name)).join(T('、')))
    : '';
  push({ kind: 'graph', message: T('调用图：{#0} 条调用边，{#1} 个调用点。{#2}{#3}按强连通分量自底向上，先总结被调函数，再总结调用者。', graph.edges.length, graph.sites.length, recursiveText, unreachableText) });
  for (const name of graph.sccs.flat()) {
    const summary = summaries[name];
    push({ kind: 'summary', fn: name, message: summary.pure
      ? T('{#0}：纯函数——不输出、不会报错、一定返回，没人用结果时可以删掉调用。', name)
      : T('{#0}：{#1}。', name, summary.reasons.join(T('；'))) });
  }
  ipcp.events.forEach((event, index) => push({ kind: 'ipcp', event: index, message: eventText(event) }));
  const paramSummary = Object.entries(ipcp.params).filter(([name, facts]) => facts.length && ipcp.analyzed.includes(name)).map(([name, facts]) => `${name}(${facts.map(factLabel).join(', ')})`).join(T('，')) || T('没有带形参的函数被调用');
  push({ kind: 'transform', fn: MAIN_FUNCTION, message: ipcp.converged
    ? T('过程间常量传播在 {#0} 轮后收敛。{#1}。接下来按这些事实改写每个函数：替换常量、折叠、删除不可达代码；只有纯函数的调用才能删除或换成常量。', ipcp.rounds, paramSummary)
    : T('过程间常量传播没有收敛，变换只用已得到的保守结果。{#0}。接下来按这些事实改写每个函数：替换常量、折叠、删除不可达代码；只有纯函数的调用才能删除或换成常量。', paramSummary) });
  for (let round = 1; round <= rounds; round++) {
    if (round > 1) {
      const purer = Object.keys(finalSummaries).filter((name) => !summaries[name]?.pure && finalSummaries[name].pure);
      const own = transformEvents.filter((event) => event.round === round);
      if (!own.length) break;
      push({ kind: 'transform', fn: MAIN_FUNCTION, message: purer.length
        ? T('第 {#0} 轮：改写后的函数重新总结效果、重新传播常量。{#1} 的可能报错或输出的代码已被常量折叠掉，现在是纯函数，调用它们也可以删除或折叠。', round, purer.join(T('、')))
        : T('第 {#0} 轮：改写后的函数重新总结效果、重新传播常量。', round) });
    }
    for (const [name] of lowered) {
      const own = transformEvents.filter((event) => event.fn === name && event.round === round);
      if (own.length) push({ kind: 'transform', fn: name, message: own.length > 3
        ? T('{#0}：{#1} 处改写。{#2}……。', name, own.length, own.slice(0, 3).map((event) => event.text).join(T('；')))
        : T('{#0}：{#1} 处改写。{#2}。', name, own.length, own.slice(0, 3).map((event) => event.text).join(T('；'))) });
    }
  }
  inlineEvents.forEach((event, index) => push({ kind: 'inline', event: index, message: event.inlined
    ? T('在 {#0} 中内联 {#1}（第 {#2} 份，{#3} 条）：形参变成复制 {#1}@{#2}.形参 = 实参，局部变量和标签加上前缀，return 变成“写结果 + 跳到结尾”。', event.caller, event.callee, event.instance, event.size)
    : T('不内联 {#0} 里对 {#1} 的调用：{#2}。', event.caller, event.callee, event.reason) }));
  push({ kind: 'minic', message: minic
    ? T('内联后 main 不再有 call，正好是实验 04 的 IR 形状，交给实验 05 的优化器（传播、折叠、分支简化、清理）：{#0} 条 → {#1} 条，再生成栈式字节码执行。', realSize(mainCode), realSize(minic.steps.at(-1)!.instructions))
    : T('main 仍调用 {#0}。实验 05 的优化器没有给 call 建模（输出、报错、不终止），不能把它当作纯表达式处理，所以这一步跳过。', remainingCalls.join(T('、'))) });
  const failed = runs.filter((row) => row.outcome === 'different');
  push({ kind: 'complete', message: failed.length
    ? T('发现行为差异：{#0}。', failed.map((row) => row.label).join(T('、')))
    : runs.some((row) => row.outcome === 'unknown')
      ? T('有执行达到上限，相关版本暂不能判定一致；其余版本与实验 16 的 VM 输出和错误一致。')
      : runs.some((row) => row.outcome === 'skipped')
        ? T('除了跳过的实验 05 一行，其余版本都实际执行，输出和错误与实验 16 的函数字节码 VM 一致。')
        : T('每个版本都实际执行，输出和错误与实验 16 的函数字节码 VM 一致。') });
  return { program, lowered, graph, summaries, finalSummaries, ipcp, rounds, optimized, transformEvents, inlined, inlineEvents, minic, remainingCalls, runs, baseline, frames, traceTruncated };
}

export function analyzeInterproc(source: string) {
  try {
    const program = compileFunctions(source);
    return { ok: true as const, analysis: analyzeInterprocedural(program) };
  } catch (error) {
    if (error instanceof CompileError) return { ok: false as const, issue: error.diagnostic };
    throw error;
  }
}
