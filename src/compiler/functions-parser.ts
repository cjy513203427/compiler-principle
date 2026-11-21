import { tokenize } from './lexer';
import { CompileError, type DataType, type NodeBase, type Value } from './model';

// This dialect is deliberately separate from the intraprocedural Mini C pipeline.
// It shares its scanner and arithmetic, but never sends CALL through the old optimizer.
export type FunctionExpr = NodeBase & (
  | { kind: 'literal'; value: Value }
  | { kind: 'identifier'; name: string }
  | { kind: 'call'; name: string; args: FunctionExpr[] }
  | { kind: 'binary'; operator: string; left: FunctionExpr; right: FunctionExpr }
  | { kind: 'unary'; operand: FunctionExpr }
);
export type FunctionStmt = NodeBase & (
  | { kind: 'declare'; name: string; dataType: DataType; value: FunctionExpr }
  | { kind: 'assign'; name: string; value: FunctionExpr }
  | { kind: 'print' | 'return' | 'discard'; value: FunctionExpr }
  | { kind: 'block'; body: FunctionStmt[] }
  | { kind: 'if'; condition: FunctionExpr; then: FunctionStmt; otherwise?: FunctionStmt }
  | { kind: 'while'; condition: FunctionExpr; body: FunctionStmt }
);
export interface FunctionParameter extends NodeBase { name: string; dataType: DataType }
export interface FunctionDefinition extends NodeBase {
  name: string; returnType: DataType; params: FunctionParameter[]; body: FunctionStmt;
}
export interface FunctionProgram { functions: FunctionDefinition[]; main: FunctionStmt[] }
const precedence: Record<string, number> = { '==': 1, '!=': 1, '<': 2, '<=': 2, '>': 2, '>=': 2, '+': 3, '-': 3, '*': 4, '/': 4 };

export function parseFunctions(source: string): FunctionProgram {
  const { tokens } = tokenize(source, { functions: true });
  let cursor = 0, serial = 0, nesting = 0;
  const peek = () => tokens[cursor];
  const fail = (message: string): never => { throw new CompileError({ stage: 'functions', message, start: peek().start, end: peek().end }); };
  const take = (expected?: string) => {
    if (expected && peek().text !== expected) fail(`期望「${expected}」，实际读到「${peek().text}」。`);
    return tokens[cursor++];
  };
  const name = () => { if (peek().kind !== 'identifier') fail('这里需要 ASCII 标识符。'); return take(); };
  const type = (): DataType => {
    if (peek().text !== 'int' && peek().text !== 'bool') fail('参数和返回值的类型只能是 int 或 bool。');
    return take().text as DataType;
  };
  const node = (start: number) => ({ id: serial++, start, end: tokens[cursor - 1].end });
  function nested<T>(read: () => T): T {
    if (++nesting > 64) fail('语法嵌套超过 64 层，请缩小示例。');
    try { return read(); } finally { nesting--; }
  }
  function primary(): FunctionExpr {
    const token = peek();
    if (token.text === '-') {
      take(); const operand = nested(primary);
      return { kind: 'unary', operand, ...node(token.start) };
    }
    if (token.kind === 'number' || token.text === 'true' || token.text === 'false') {
      take(); const value = token.kind === 'number' ? Number(token.text) : token.text === 'true';
      if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new CompileError({ stage: 'functions', message: '整数字面量超出安全整数范围。', start: token.start, end: token.end });
      return { kind: 'literal', value, ...node(token.start) };
    }
    if (token.kind === 'identifier') {
      take();
      if (peek().text !== '(') return { kind: 'identifier', name: token.text, ...node(token.start) };
      take('('); const args: FunctionExpr[] = [];
      if (peek().text !== ')') {
        do {
          if (args.length === 8) fail('一次调用最多传入 8 个实参。');
          args.push(nested(expression));
          if (peek().text !== ',') break;
          take(',');
        } while (true);
      }
      take(')'); return { kind: 'call', name: token.text, args, ...node(token.start) };
    }
    if (token.text === '(') { take(); const value = nested(expression); take(')'); return value; }
    return fail(`期望表达式，实际读到「${token.text}」。`);
  }
  function expression(min = 1): FunctionExpr {
    let left = primary();
    while ((precedence[peek().text] ?? 0) >= min) {
      const operator = take().text;
      const right = nested(() => expression(precedence[operator] + 1));
      left = { kind: 'binary', operator, left, right, ...node(left.start) };
    }
    return left;
  }
  function statement(): FunctionStmt {
    const token = peek();
    if (token.text === '{') {
      take(); const body: FunctionStmt[] = [];
      while (peek().text !== '}' && peek().kind !== 'eof') body.push(nested(statement));
      take('}'); return { kind: 'block', body, ...node(token.start) };
    }
    if (token.text === 'if' || token.text === 'while') {
      take(); take('('); const condition = expression(); take(')');
      if (peek().text !== '{') fail('if / while 的主体需要花括号。');
      const body = nested(statement);
      if (token.text === 'while') return { kind: 'while', condition, body, ...node(token.start) };
      let otherwise: FunctionStmt | undefined;
      if (peek().text === 'else') {
        take(); if (peek().text !== '{') fail('else 的主体需要花括号。');
        otherwise = nested(statement);
      }
      return { kind: 'if', condition, then: body, otherwise, ...node(token.start) };
    }
    if (token.text === 'int' || token.text === 'bool') {
      const dataType = type(), identifier = name(); take('='); const value = expression(); take(';');
      return { kind: 'declare', name: identifier.text, dataType, value, ...node(token.start) };
    }
    if (token.text === 'print' || token.text === 'return') {
      take(); if (token.text === 'print') take('(');
      const value = expression(); if (token.text === 'print') take(')'); take(';');
      return { kind: token.text, value, ...node(token.start) };
    }
    if (token.kind === 'identifier') {
      if (tokens[cursor + 1].text === '=') {
        take(); take('='); const value = expression(); take(';');
        return { kind: 'assign', name: token.text, value, ...node(token.start) };
      }
      const value = expression();
      if (value.kind !== 'call') fail('独立表达式语句必须是函数调用。');
      take(';'); return { kind: 'discard', value, ...node(token.start) };
    }
    return fail('这里需要声明、赋值、调用、return、print、if、while 或语句块。函数只可在顶层定义。');
  }
  const functions: FunctionDefinition[] = [], main: FunctionStmt[] = [];
  while (peek().kind !== 'eof') {
    if (['int', 'bool'].includes(peek().text) && tokens[cursor + 1]?.kind === 'identifier' && tokens[cursor + 2]?.text === '(') {
      if (functions.length === 24) fail('最多定义 24 个函数。');
      const start = peek().start, returnType = type(), identifier = name(); take('(');
      const params: FunctionParameter[] = [];
      if (peek().text !== ')') {
        do {
          if (params.length === 8) fail('每个函数最多 8 个形参。');
          const start = peek().start, dataType = type(), identifier = name();
          params.push({ name: identifier.text, dataType, ...node(start) });
          if (peek().text !== ',') break;
          take(',');
        } while (true);
      }
      take(')'); if (peek().text !== '{') fail('函数体需要花括号；不支持函数原型。');
      const body = statement(); functions.push({ name: identifier.text, returnType, params, body, ...node(start) });
    } else main.push(statement());
  }
  return { functions, main };
}
