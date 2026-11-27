import { T } from '../i18n';
import { CompileError, type DataType, type NodeBase, type Value } from './model';
import { parseFunctions, type FunctionExpr, type FunctionStmt } from './functions-parser';
import { executeFunctions } from './functions-vm';
export { callInstructionText } from './functions-vm';

export type CallOpcode =
  | { op: 'PUSH'; value: Value }
  | { op: 'LOAD' | 'STORE'; key: string }
  | { op: 'BINARY'; operator: string }
  | { op: 'JUMP' | 'BR_FALSE'; target: number }
  | { op: 'CALL'; name: string; arity: number }
  | { op: 'PRINT' | 'RETURN' | 'DROP' | 'HALT' };
export type CallInstruction = CallOpcode & { start: number; end: number };
export interface CallLocal { key: string; name: string; dataType: DataType; parameter: boolean }
export interface CallFunction {
  name: string; returnType?: DataType; params: CallLocal[]; locals: CallLocal[]; code: CallInstruction[];
}
export interface CallProgram { functions: Map<string, CallFunction>; main: string }
export const MAIN_FUNCTION = '@main';
const dtype = (value: Value): DataType => typeof value === 'boolean' ? 'bool' : 'int';
const fail = (node: Pick<NodeBase, 'start' | 'end'>, message: string): never => {
  throw new CompileError({ stage: 'functions', message, start: node.start, end: node.end });
};
function mustReturn(stmt: FunctionStmt): boolean {
  return stmt.kind === 'return' || (stmt.kind === 'block' && stmt.body.some(mustReturn)) ||
    (stmt.kind === 'if' && !!stmt.otherwise && mustReturn(stmt.then) && mustReturn(stmt.otherwise));
}

export function compileFunctions(source: string): CallProgram {
  const ast = parseFunctions(source);
  const functions = new Map<string, CallFunction>();
  for (const fn of ast.functions) {
    if (functions.has(fn.name)) fail(fn, T('函数 {#0} 重复定义；不支持重载。', fn.name));
    functions.set(fn.name, { name: fn.name, returnType: fn.returnType, params: [], locals: [], code: [] });
  }
  functions.set(MAIN_FUNCTION, { name: MAIN_FUNCTION, params: [], locals: [], code: [] });
  // Register every signature first, so forward calls and mutual recursion are checked identically.
  for (const definition of ast.functions) {
    const fn = functions.get(definition.name)!;
    fn.params = definition.params.map((param) => ({ key: `${param.name}#${param.id}`, name: param.name, dataType: param.dataType, parameter: true }));
  }
  function compileBody(fn: CallFunction, body: FunctionStmt[], params: typeof ast.functions[number]['params']) {
    const scopes: Map<string, CallLocal>[] = [new Map()];
    const emit = (node: Pick<NodeBase, 'start' | 'end'>, op: CallOpcode) => {
      fn.code.push({ ...op, start: node.start, end: node.end }); return fn.code.length - 1;
    };
    const patch = (index: number) => {
      const instruction = fn.code[index];
      if (instruction.op === 'JUMP' || instruction.op === 'BR_FALSE') instruction.target = fn.code.length;
    };
    const declare = (node: NodeBase, name: string, dataType: DataType, parameter = false): CallLocal => {
      const scope = scopes.at(-1)!;
      if (scope.has(name)) fail(node, T('同一作用域内重复声明 {#0}。', name));
      const local = { key: `${name}#${node.id}`, name, dataType, parameter };
      scope.set(name, local); fn.locals.push(local); return local;
    };
    params.forEach((param) => declare(param, param.name, param.dataType, true));
    const lookup = (node: NodeBase, name: string): CallLocal => {
      for (let i = scopes.length - 1; i >= 0; i--) { const local = scopes[i].get(name); if (local) return local; }
      return fail(node, T('变量 {#0} 未在当前函数的词法作用域中声明；函数不读取顶层变量或调用者局部变量。', name));
    };
    const expect = (node: NodeBase, actual: DataType, expected: DataType) => {
      if (actual !== expected) fail(node, T('类型不匹配：需要 {#0}，实际是 {#1}。', expected, actual));
    };
    function expr(node: FunctionExpr): DataType {
      switch (node.kind) {
        case 'literal': emit(node, { op: 'PUSH', value: node.value }); return dtype(node.value);
        case 'identifier': { const local = lookup(node, node.name); emit(node, { op: 'LOAD', key: local.key }); return local.dataType; }
        case 'call': {
          const target = functions.get(node.name);
          if (!target) return fail(node, T('函数 {#0} 未定义。', node.name));
          if (target.params.length !== node.args.length) fail(node, T('函数 {#0} 需要 {#1} 个实参，实际传入 {#2} 个。', node.name, target.params.length, node.args.length));
          node.args.forEach((arg, i) => expect(arg, expr(arg), target.params[i].dataType));
          emit(node, { op: 'CALL', name: node.name, arity: node.args.length }); return target.returnType!;
        }
        case 'unary':
          emit(node, { op: 'PUSH', value: 0 }); expect(node.operand, expr(node.operand), 'int');
          emit(node, { op: 'BINARY', operator: '-' }); return 'int';
        case 'binary': {
          const left = expr(node.left), right = expr(node.right);
          if (node.operator === '==' || node.operator === '!=') expect(node, right, left);
          else { expect(node.left, left, 'int'); expect(node.right, right, 'int'); }
          emit(node, { op: 'BINARY', operator: node.operator });
          return ['<', '<=', '>', '>=', '==', '!='].includes(node.operator) ? 'bool' : 'int';
        }
      }
    }
    function stmt(node: FunctionStmt): void {
      switch (node.kind) {
        case 'block':
          scopes.push(new Map()); node.body.forEach(stmt); scopes.pop(); break;
        case 'declare': {
          expect(node.value, expr(node.value), node.dataType);
          const local = declare(node, node.name, node.dataType); emit(node, { op: 'STORE', key: local.key }); break;
        }
        case 'assign': {
          const local = lookup(node, node.name); expect(node.value, expr(node.value), local.dataType);
          emit(node, { op: 'STORE', key: local.key }); break;
        }
        case 'return':
          if (!fn.returnType) fail(node, T('顶层程序不能使用 return；请在函数体中返回值。'));
          expect(node.value, expr(node.value), fn.returnType!); emit(node, { op: 'RETURN' }); break;
        case 'print': case 'discard':
          expr(node.value); emit(node, { op: node.kind === 'print' ? 'PRINT' : 'DROP' }); break;
        case 'if': {
          expect(node.condition, expr(node.condition), 'bool'); const branch = emit(node, { op: 'BR_FALSE', target: -1 });
          stmt(node.then);
          if (node.otherwise) {
            const jump = emit(node, { op: 'JUMP', target: -1 }); patch(branch); stmt(node.otherwise); patch(jump);
          } else patch(branch);
          break;
        }
        case 'while': {
          const head = fn.code.length; expect(node.condition, expr(node.condition), 'bool');
          const branch = emit(node, { op: 'BR_FALSE', target: -1 }); stmt(node.body);
          emit(node, { op: 'JUMP', target: head }); patch(branch); break;
        }
      }
    }
    body.forEach(stmt);
  }
  for (const definition of ast.functions) {
    if (!mustReturn(definition.body)) fail(definition, T('函数 {#0} 可能到达末尾而没有返回值；需要明确覆盖所有路径的 return。', definition.name));
    compileBody(functions.get(definition.name)!, definition.body.kind === 'block' ? definition.body.body : [definition.body], definition.params);
  }
  const main = functions.get(MAIN_FUNCTION)!;
  compileBody(main, ast.main, []);
  main.code.push({ op: 'HALT', start: source.length, end: source.length });
  return { functions, main: MAIN_FUNCTION };
}

export function analyzeFunctions(source: string) {
  try {
    const program = compileFunctions(source);
    return { ok: true as const, analysis: { program, ...executeFunctions(program) } };
  } catch (error) {
    if (error instanceof CompileError) return { ok: false as const, issue: error.diagnostic };
    throw error;
  }
}
