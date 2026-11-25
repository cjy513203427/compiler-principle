import { evaluateBinary } from './operations';

export interface EscapeIssue {
  message: string;
  start: number;
  end: number;
}

export interface StructDef {
  name: string;
  fields: { name: string; type: string }[];
}

export type EscExpr =
  | { kind: 'int'; value: number }
  | { kind: 'var'; name: string }
  | { kind: 'unary'; operand: EscExpr }
  | { kind: 'bin'; op: string; left: EscExpr; right: EscExpr }
  | { kind: 'new'; structName: string; args: EscExpr[]; allocId: string }
  | { kind: 'field'; target: EscExpr; field: string }
  | { kind: 'call'; callee: string; args: EscExpr[] };

export type EscStmt =
  | { kind: 'decl'; type: string; name: string; init: EscExpr }
  | { kind: 'assign'; name: string; value: EscExpr }
  | { kind: 'setField'; target: string; field: string; value: EscExpr }
  | { kind: 'if'; cond: EscExpr; thenBody: EscStmt[]; elseBody: EscStmt[] }
  | { kind: 'while'; cond: EscExpr; body: EscStmt[] }
  | { kind: 'return'; value: EscExpr }
  | { kind: 'print'; value: EscExpr }
  | { kind: 'publish'; value: EscExpr };

export interface FuncDef {
  name: string;
  returnType: string;
  params: { name: string; type: string }[];
  body: EscStmt[];
}

export interface EscProgram {
  structs: StructDef[];
  functions: FuncDef[];
  entry: EscStmt[];
}

export type EscapeState = 'NoEscape' | 'ArgEscape' | 'GlobalEscape';

export interface AllocReport {
  allocId: string;
  structName: string;
  ownerFunc: string;
  varName: string;
  state: EscapeState;
  reason: string;
  scalarized: boolean;
  scalarVars?: string[];
}

export interface InlineDecision {
  caller: string;
  callee: string;
  inlined: boolean;
  reason: string;
}

export interface EscapeRunStats {
  name: string;
  output: (number | boolean)[];
  published: string[];
  calls: number;
  heapAllocs: number;
  steps: number;
  halted: boolean;
  limited: boolean;
  error?: string;
}

export interface EscapeFrame {
  kind: 'initial' | 'inline' | 'escape' | 'sroa' | 'complete';
  message: string;
  focusAlloc?: string;
  focusInline?: number;
}

export interface EscapeAnalysis {
  originalCode: string;
  inlinedCode: string;
  sroaCode: string;
  inlineDecisions: InlineDecision[];
  beforeEscape: AllocReport[];
  afterEscape: AllocReport[];
  runs: {
    original: EscapeRunStats;
    inlined: EscapeRunStats;
    sroa: EscapeRunStats;
  };
  equivalent: 'same' | 'different' | 'unknown';
  frames: EscapeFrame[];
  traceTruncated: boolean;
}

export type EscapeOutcome = { ok: true; analysis: EscapeAnalysis } | { ok: false; issue: EscapeIssue };

const MAX_SOURCE = 2000;
const MAX_EXEC_STEPS = 2000;
const MAX_CALL_DEPTH = 32;
const MAX_INLINE_STMTS = 10;
const MAX_TRACE = 240;

interface Tok {
  kind: 'id' | 'num' | 'op' | 'punc' | 'eof';
  text: string;
  start: number;
  end: number;
}

class ParseErr extends Error {
  constructor(
    message: string,
    public start: number,
    public end: number,
  ) {
    super(message);
  }
}

function lexEscape(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      const start = i;
      while (i < src.length && /[0-9]/.test(src[i])) i++;
      toks.push({ kind: 'num', text: src.slice(start, i), start, end: i });
      continue;
    }
    if (/[a-zA-Z_]/.test(ch)) {
      const start = i;
      while (i < src.length && /[a-zA-Z0-9_$]/.test(src[i])) i++;
      toks.push({ kind: 'id', text: src.slice(start, i), start, end: i });
      continue;
    }
    const two = src.slice(i, i + 2);
    if (['<=', '>=', '==', '!='].includes(two)) {
      toks.push({ kind: 'op', text: two, start: i, end: i + 2 });
      i += 2;
      continue;
    }
    if ('+-*/<>='.includes(ch)) {
      toks.push({ kind: 'op', text: ch, start: i, end: i + 1 });
      i++;
      continue;
    }
    if ('(){};,.'.includes(ch)) {
      toks.push({ kind: 'punc', text: ch, start: i, end: i + 1 });
      i++;
      continue;
    }
    throw new ParseErr(`无法识别的字符「${ch}」。`, i, i + 1);
  }
  toks.push({ kind: 'eof', text: 'EOF', start: src.length, end: src.length });
  return toks;
}

const KEYWORDS = new Set(['struct', 'new', 'if', 'else', 'while', 'return', 'print', 'publish', 'int']);

function parseEscapeProgram(src: string): EscProgram {
  if (src.length > MAX_SOURCE) throw new ParseErr(`输入超过 ${MAX_SOURCE} 字符上限。`, MAX_SOURCE, src.length);
  const toks = lexEscape(src);
  let pos = 0;
  let allocSeq = 0;
  const peek = (offset = 0) => toks[Math.min(pos + offset, toks.length - 1)];
  const next = () => toks[pos++];
  const expect = (text: string) => {
    const t = peek();
    if (t.text !== text) throw new ParseErr(`此处期望「${text}」，实际遇到「${t.text}」。`, t.start, t.end);
    return next();
  };
  const expectId = (what: string) => {
    const t = peek();
    if (t.kind !== 'id' || KEYWORDS.has(t.text)) throw new ParseErr(`此处期望${what}，实际遇到「${t.text}」。`, t.start, t.end);
    return next();
  };
  const expectType = () => {
    const t = peek();
    if (t.kind !== 'id' || (KEYWORDS.has(t.text) && t.text !== 'int')) {
      throw new ParseErr(`此处期望类型名（int 或 struct 名），实际遇到「${t.text}」。`, t.start, t.end);
    }
    return next().text;
  };

  const structs: StructDef[] = [];
  const functions: FuncDef[] = [];
  const entry: EscStmt[] = [];

  function parsePrimary(depth: number): EscExpr {
    if (depth > 32) throw new ParseErr('表达式嵌套过深。', peek().start, peek().end);
    const t = peek();
    if (t.kind === 'num') {
      next();
      const value = Number(t.text);
      if (!Number.isSafeInteger(value)) throw new ParseErr(`整数 ${t.text} 超出安全整数范围。`, t.start, t.end);
      return { kind: 'int', value };
    }
    if (t.text === '(') {
      next();
      const inner = parseExpr(depth + 1);
      expect(')');
      return inner;
    }
    if (t.text === 'new') {
      next();
      const structName = expectId('结构体名').text;
      expect('(');
      const args: EscExpr[] = [];
      if (peek().text !== ')') {
        args.push(parseExpr(depth + 1));
        while (peek().text === ',') {
          next();
          args.push(parseExpr(depth + 1));
        }
      }
      expect(')');
      return { kind: 'new', structName, args, allocId: `alloc#${allocSeq++}` };
    }
    if (t.kind === 'id' && !KEYWORDS.has(t.text)) {
      const name = next().text;
      if (peek().text === '(') {
        next();
        const args: EscExpr[] = [];
        if (peek().text !== ')') {
          args.push(parseExpr(depth + 1));
          while (peek().text === ',') {
            next();
            args.push(parseExpr(depth + 1));
          }
        }
        expect(')');
        return { kind: 'call', callee: name, args };
      }
      return { kind: 'var', name };
    }
    throw new ParseErr(`期望表达式，实际遇到「${t.text}」。`, t.start, t.end);
  }

  function parsePostfix(depth: number): EscExpr {
    let expr = parsePrimary(depth);
    while (peek().text === '.') {
      next();
      const field = expectId('字段名').text;
      expr = { kind: 'field', target: expr, field };
    }
    return expr;
  }

  function parseUnary(depth: number): EscExpr {
    if (peek().text === '-') {
      next();
      return { kind: 'unary', operand: parseUnary(depth + 1) };
    }
    return parsePostfix(depth);
  }

  function parseMul(depth: number): EscExpr {
    let left = parseUnary(depth);
    while (peek().text === '*' || peek().text === '/') {
      const op = next().text;
      left = { kind: 'bin', op, left, right: parseUnary(depth + 1) };
    }
    return left;
  }

  function parseAdd(depth: number): EscExpr {
    let left = parseMul(depth);
    while (peek().text === '+' || peek().text === '-') {
      const op = next().text;
      left = { kind: 'bin', op, left, right: parseMul(depth + 1) };
    }
    return left;
  }

  function parseCmp(depth: number): EscExpr {
    let left = parseAdd(depth);
    while (['<', '<=', '>', '>='].includes(peek().text)) {
      const op = next().text;
      left = { kind: 'bin', op, left, right: parseAdd(depth + 1) };
    }
    return left;
  }

  function parseExpr(depth = 0): EscExpr {
    let left = parseCmp(depth);
    while (peek().text === '==' || peek().text === '!=') {
      const op = next().text;
      left = { kind: 'bin', op, left, right: parseCmp(depth + 1) };
    }
    return left;
  }

  function parseBlock(depth: number): EscStmt[] {
    if (depth > 24) throw new ParseErr('语句块嵌套过深。', peek().start, peek().end);
    expect('{');
    const stmts: EscStmt[] = [];
    while (peek().text !== '}' && peek().kind !== 'eof') {
      stmts.push(parseStmt(depth + 1));
    }
    expect('}');
    return stmts;
  }

  function parseStmt(depth = 0): EscStmt {
    const t = peek();
    if (t.text === 'if') {
      next();
      expect('(');
      const cond = parseExpr();
      expect(')');
      const thenBody = parseBlock(depth + 1);
      let elseBody: EscStmt[] = [];
      if (peek().text === 'else') {
        next();
        elseBody = parseBlock(depth + 1);
      }
      return { kind: 'if', cond, thenBody, elseBody };
    }
    if (t.text === 'while') {
      next();
      expect('(');
      const cond = parseExpr();
      expect(')');
      const body = parseBlock(depth + 1);
      return { kind: 'while', cond, body };
    }
    if (t.text === 'return') {
      next();
      const value = parseExpr();
      expect(';');
      return { kind: 'return', value };
    }
    if (t.text === 'print') {
      next();
      expect('(');
      const value = parseExpr();
      expect(')');
      expect(';');
      return { kind: 'print', value };
    }
    if (t.text === 'publish') {
      next();
      expect('(');
      const value = parseExpr();
      expect(')');
      expect(';');
      return { kind: 'publish', value };
    }
    // Variable declaration: Type name = expr;
    if (
      t.kind === 'id' &&
      (!KEYWORDS.has(t.text) || t.text === 'int') &&
      peek(1).kind === 'id' &&
      !KEYWORDS.has(peek(1).text) &&
      peek(2).text === '='
    ) {
      const type = next().text;
      const name = next().text;
      expect('=');
      const init = parseExpr();
      expect(';');
      return { kind: 'decl', type, name, init };
    }
    // Field assignment: obj.field = expr;
    if (t.kind === 'id' && !KEYWORDS.has(t.text) && peek(1).text === '.' && peek(2).kind === 'id' && peek(3).text === '=') {
      const target = next().text;
      next();
      const field = next().text;
      expect('=');
      const value = parseExpr();
      expect(';');
      return { kind: 'setField', target, field, value };
    }
    // Variable assignment: x = expr;
    if (t.kind === 'id' && !KEYWORDS.has(t.text) && peek(1).text === '=') {
      const name = next().text;
      expect('=');
      const value = parseExpr();
      expect(';');
      return { kind: 'assign', name, value };
    }
    throw new ParseErr(`无法解析的语句起点「${t.text}」。`, t.start, t.end);
  }

  while (peek().kind !== 'eof') {
    const t = peek();
    if (t.text === 'struct') {
      next();
      const name = expectId('结构体名').text;
      expect('{');
      const fields: { name: string; type: string }[] = [];
      while (peek().text !== '}' && peek().kind !== 'eof') {
        const ft = expectType();
        const fn = expectId('字段名').text;
        expect(';');
        fields.push({ name: fn, type: ft });
      }
      expect('}');
      structs.push({ name, fields });
      if (structs.length > 12) throw new ParseErr('结构体数量不能超过 12 个。', t.start, t.end);
    } else if (
      t.kind === 'id' &&
      (!KEYWORDS.has(t.text) || t.text === 'int') &&
      peek(1).kind === 'id' &&
      !KEYWORDS.has(peek(1).text) &&
      peek(2).text === '('
    ) {
      const returnType = next().text;
      const name = next().text;
      expect('(');
      const params: { name: string; type: string }[] = [];
      if (peek().text !== ')') {
        params.push({ type: expectType(), name: expectId('形参名').text });
        while (peek().text === ',') {
          next();
          params.push({ type: expectType(), name: expectId('形参名').text });
        }
      }
      expect(')');
      const body = parseBlock(0);
      functions.push({ name, returnType, params, body });
      if (functions.length > 16) throw new ParseErr('函数数量不能超过 16 个。', t.start, t.end);
    } else {
      entry.push(parseStmt(0));
    }
  }

  if (!entry.length) throw new ParseErr('请至少写一条顶层执行语句（如 print(...)）。', 0, 0);
  return { structs, functions, entry };
}

function validateProgram(prog: EscProgram) {
  const structMap = new Map<string, StructDef>();
  for (const s of prog.structs) {
    if (structMap.has(s.name)) throw new ParseErr(`结构体 ${s.name} 重复定义。`, 0, 0);
    const seenFields = new Set<string>();
    for (const f of s.fields) {
      if (seenFields.has(f.name)) throw new ParseErr(`结构体 ${s.name} 的字段 ${f.name} 重复。`, 0, 0);
      seenFields.add(f.name);
    }
    structMap.set(s.name, s);
  }
  const knownType = (t: string) => t === 'int' || structMap.has(t);
  for (const s of prog.structs) {
    for (const f of s.fields) {
      if (!knownType(f.type)) throw new ParseErr(`结构体 ${s.name} 的字段 ${f.name} 使用了未定义类型 ${f.type}。`, 0, 0);
    }
  }
  const funcMap = new Map<string, FuncDef>();
  for (const fn of prog.functions) {
    if (funcMap.has(fn.name)) throw new ParseErr(`函数 ${fn.name} 重复定义。`, 0, 0);
    if (!knownType(fn.returnType)) throw new ParseErr(`函数 ${fn.name} 的返回类型 ${fn.returnType} 未定义。`, 0, 0);
    for (const p of fn.params) {
      if (!knownType(p.type)) throw new ParseErr(`函数 ${fn.name} 的形参 ${p.name} 使用了未定义类型 ${p.type}。`, 0, 0);
    }
    funcMap.set(fn.name, fn);
  }

  function checkExpr(expr: EscExpr, env: Map<string, string>): string {
    switch (expr.kind) {
      case 'int':
        return 'int';
      case 'var': {
        const t = env.get(expr.name);
        if (!t) throw new ParseErr(`使用了未声明的变量 ${expr.name}。`, 0, 0);
        return t;
      }
      case 'unary': {
        if (checkExpr(expr.operand, env) !== 'int') throw new ParseErr('一元负号只能用于 int。', 0, 0);
        return 'int';
      }
      case 'bin': {
        const lt = checkExpr(expr.left, env);
        const rt = checkExpr(expr.right, env);
        if (lt !== 'int' || rt !== 'int') throw new ParseErr(`运算符 ${expr.op} 两侧都需要 int。`, 0, 0);
        return ['<', '<=', '>', '>=', '==', '!='].includes(expr.op) ? 'bool' : 'int';
      }
      case 'new': {
        const def = structMap.get(expr.structName);
        if (!def) throw new ParseErr(`未定义结构体 ${expr.structName}。`, 0, 0);
        if (expr.args.length !== def.fields.length) {
          throw new ParseErr(`new ${def.name}(...) 需要 ${def.fields.length} 个实参，实际给了 ${expr.args.length} 个。`, 0, 0);
        }
        expr.args.forEach((arg, idx) => {
          const at = checkExpr(arg, env);
          if (at !== def.fields[idx].type) {
            throw new ParseErr(`new ${def.name} 的第 ${idx + 1} 个实参期望 ${def.fields[idx].type}，实际为 ${at}。`, 0, 0);
          }
        });
        return def.name;
      }
      case 'field': {
        const tt = checkExpr(expr.target, env);
        const def = structMap.get(tt);
        if (!def) throw new ParseErr(`不能对非结构体类型 ${tt} 访问字段 .${expr.field}。`, 0, 0);
        const f = def.fields.find((item) => item.name === expr.field);
        if (!f) throw new ParseErr(`结构体 ${tt} 没有字段 ${expr.field}。`, 0, 0);
        return f.type;
      }
      case 'call': {
        const fn = funcMap.get(expr.callee);
        if (!fn) throw new ParseErr(`调用了未定义函数 ${expr.callee}。`, 0, 0);
        if (expr.args.length !== fn.params.length) {
          throw new ParseErr(`调用 ${fn.name} 需要 ${fn.params.length} 个实参，实际给了 ${expr.args.length} 个。`, 0, 0);
        }
        expr.args.forEach((arg, idx) => {
          const at = checkExpr(arg, env);
          if (at !== fn.params[idx].type) {
            throw new ParseErr(`${fn.name} 的第 ${idx + 1} 个实参期望 ${fn.params[idx].type}，实际为 ${at}。`, 0, 0);
          }
        });
        return fn.returnType;
      }
    }
  }

  function checkBlock(stmts: EscStmt[], env: Map<string, string>, expectedReturn?: string): boolean {
    const local = new Map(env);
    let returned = false;
    for (const s of stmts) {
      if (s.kind === 'decl') {
        if (!knownType(s.type)) throw new ParseErr(`未定义类型 ${s.type}。`, 0, 0);
        const t = checkExpr(s.init, local);
        if (t !== s.type) throw new ParseErr(`变量 ${s.name} 声明为 ${s.type}，初始化表达式却是 ${t}。`, 0, 0);
        local.set(s.name, s.type);
      } else if (s.kind === 'assign') {
        const existing = local.get(s.name);
        if (!existing) throw new ParseErr(`赋值给未声明变量 ${s.name}。`, 0, 0);
        const t = checkExpr(s.value, local);
        if (t !== existing) throw new ParseErr(`变量 ${s.name} 类型为 ${existing}，不能赋 ${t}。`, 0, 0);
      } else if (s.kind === 'setField') {
        const tt = local.get(s.target);
        const def = tt ? structMap.get(tt) : undefined;
        if (!def) throw new ParseErr(`不能对 ${s.target} 写入字段 .${s.field}。`, 0, 0);
        const f = def.fields.find((item) => item.name === s.field);
        if (!f) throw new ParseErr(`结构体 ${def.name} 没有字段 ${s.field}。`, 0, 0);
        const vt = checkExpr(s.value, local);
        if (vt !== f.type) throw new ParseErr(`字段 ${def.name}.${f.name} 类型为 ${f.type}，不能赋 ${vt}。`, 0, 0);
      } else if (s.kind === 'if') {
        if (checkExpr(s.cond, local) !== 'bool') throw new ParseErr('if 条件必须是比较表达式。', 0, 0);
        const a = checkBlock(s.thenBody, local, expectedReturn);
        const b = s.elseBody.length ? checkBlock(s.elseBody, local, expectedReturn) : false;
        if (a && b) returned = true;
      } else if (s.kind === 'while') {
        if (checkExpr(s.cond, local) !== 'bool') throw new ParseErr('while 条件必须是比较表达式。', 0, 0);
        checkBlock(s.body, local, expectedReturn);
      } else if (s.kind === 'return') {
        if (!expectedReturn) throw new ParseErr('顶层入口代码不能使用 return。', 0, 0);
        const rt = checkExpr(s.value, local);
        if (rt !== expectedReturn) throw new ParseErr(`return 类型 ${rt} 与函数返回类型 ${expectedReturn} 不一致。`, 0, 0);
        returned = true;
      } else if (s.kind === 'print') {
        const pt = checkExpr(s.value, local);
        if (pt !== 'int' && pt !== 'bool') throw new ParseErr('print(...) 只支持输出整数或比较结果。', 0, 0);
      } else if (s.kind === 'publish') {
        const pt = checkExpr(s.value, local);
        if (!structMap.has(pt)) throw new ParseErr('publish(...) 用于把结构体对象发布到外部全局区。', 0, 0);
      }
    }
    return returned;
  }

  for (const fn of prog.functions) {
    const env = new Map<string, string>(fn.params.map((p) => [p.name, p.type]));
    if (!checkBlock(fn.body, env, fn.returnType)) {
      throw new ParseErr(`函数 ${fn.name} 存在未返回的控制流路径。`, 0, 0);
    }
  }
  checkBlock(prog.entry, new Map(), undefined);
}

export function formatExpr(e: EscExpr): string {
  switch (e.kind) {
    case 'int':
      return String(e.value);
    case 'var':
      return e.name;
    case 'unary':
      return `-${formatExpr(e.operand)}`;
    case 'bin':
      return `(${formatExpr(e.left)} ${e.op} ${formatExpr(e.right)})`;
    case 'new':
      return `new ${e.structName}(${e.args.map(formatExpr).join(', ')})`;
    case 'field':
      return `${formatExpr(e.target)}.${e.field}`;
    case 'call':
      return `${e.callee}(${e.args.map(formatExpr).join(', ')})`;
  }
}

function formatStmts(stmts: EscStmt[], indent = ''): string {
  return stmts
    .map((s) => {
      switch (s.kind) {
        case 'decl':
          return `${indent}${s.type} ${s.name} = ${formatExpr(s.init)};`;
        case 'assign':
          return `${indent}${s.name} = ${formatExpr(s.value)};`;
        case 'setField':
          return `${indent}${s.target}.${s.field} = ${formatExpr(s.value)};`;
        case 'if':
          return s.elseBody.length
            ? `${indent}if (${formatExpr(s.cond)}) {\n${formatStmts(s.thenBody, indent + '  ')}\n${indent}} else {\n${formatStmts(s.elseBody, indent + '  ')}\n${indent}}`
            : `${indent}if (${formatExpr(s.cond)}) {\n${formatStmts(s.thenBody, indent + '  ')}\n${indent}}`;
        case 'while':
          return `${indent}while (${formatExpr(s.cond)}) {\n${formatStmts(s.body, indent + '  ')}\n${indent}}`;
        case 'return':
          return `${indent}return ${formatExpr(s.value)};`;
        case 'print':
          return `${indent}print(${formatExpr(s.value)});`;
        case 'publish':
          return `${indent}publish(${formatExpr(s.value)});`;
      }
    })
    .join('\n');
}

export function formatProgram(prog: EscProgram): string {
  const parts: string[] = [];
  for (const s of prog.structs) {
    parts.push(`struct ${s.name} { ${s.fields.map((f) => `${f.type} ${f.name};`).join(' ')} }`);
  }
  for (const fn of prog.functions) {
    parts.push(`${fn.returnType} ${fn.name}(${fn.params.map((p) => `${p.type} ${p.name}`).join(', ')}) {\n${formatStmts(fn.body, '  ')}\n}`);
  }
  parts.push(formatStmts(prog.entry));
  return parts.join('\n\n');
}

function countStmts(stmts: EscStmt[]): number {
  return stmts.reduce(
    (sum, s) =>
      sum + 1 + (s.kind === 'if' ? countStmts(s.thenBody) + countStmts(s.elseBody) : s.kind === 'while' ? countStmts(s.body) : 0),
    0,
  );
}

function collectCallsInExpr(expr: EscExpr, out: Set<string>) {
  if (expr.kind === 'call') {
    out.add(expr.callee);
    expr.args.forEach((a) => collectCallsInExpr(a, out));
  } else if (expr.kind === 'bin') {
    collectCallsInExpr(expr.left, out);
    collectCallsInExpr(expr.right, out);
  } else if (expr.kind === 'unary') collectCallsInExpr(expr.operand, out);
  else if (expr.kind === 'field') collectCallsInExpr(expr.target, out);
  else if (expr.kind === 'new') expr.args.forEach((a) => collectCallsInExpr(a, out));
}

function collectCallsInStmts(stmts: EscStmt[], out: Set<string>) {
  for (const s of stmts) {
    if (s.kind === 'decl') collectCallsInExpr(s.init, out);
    else if (s.kind === 'assign' || s.kind === 'setField' || s.kind === 'return' || s.kind === 'print' || s.kind === 'publish') {
      collectCallsInExpr(s.value, out);
    } else if (s.kind === 'if') {
      collectCallsInExpr(s.cond, out);
      collectCallsInStmts(s.thenBody, out);
      collectCallsInStmts(s.elseBody, out);
    } else if (s.kind === 'while') {
      collectCallsInExpr(s.cond, out);
      collectCallsInStmts(s.body, out);
    }
  }
}

function findRecursiveFuncs(prog: EscProgram): Set<string> {
  const edges = new Map<string, Set<string>>();
  for (const fn of prog.functions) {
    const calls = new Set<string>();
    collectCallsInStmts(fn.body, calls);
    edges.set(fn.name, calls);
  }
  const recursive = new Set<string>();
  for (const fn of prog.functions) {
    const visited = new Set<string>();
    const stack = [...(edges.get(fn.name) || [])];
    while (stack.length) {
      const cur = stack.pop()!;
      if (cur === fn.name) {
        recursive.add(fn.name);
        break;
      }
      if (visited.has(cur)) continue;
      visited.add(cur);
      for (const nxt of edges.get(cur) || []) stack.push(nxt);
    }
  }
  return recursive;
}

/** Only inline functions whose return sits cleanly at the tail (no early return inside while/if). */
function hasTailOnlyReturn(body: EscStmt[]): boolean {
  if (!body.length) return false;
  const hasReturnInside = (stmts: EscStmt[]): boolean =>
    stmts.some(
      (s) =>
        s.kind === 'return' ||
        (s.kind === 'if' && (hasReturnInside(s.thenBody) || hasReturnInside(s.elseBody))) ||
        (s.kind === 'while' && hasReturnInside(s.body)),
    );
  const last = body[body.length - 1];
  return last.kind === 'return' && !hasReturnInside(body.slice(0, -1));
}

function inlineProgram(prog: EscProgram): { program: EscProgram; decisions: InlineDecision[] } {
  const recursive = findRecursiveFuncs(prog);
  const funcMap = new Map(prog.functions.map((f) => [f.name, f]));
  const decisions: InlineDecision[] = [];
  let inlineCounter = 0;

  function renameExpr(expr: EscExpr, map: Map<string, string>, tag: string): EscExpr {
    switch (expr.kind) {
      case 'int':
        return expr;
      case 'var':
        return { kind: 'var', name: map.get(expr.name) || expr.name };
      case 'unary':
        return { kind: 'unary', operand: renameExpr(expr.operand, map, tag) };
      case 'bin':
        return { kind: 'bin', op: expr.op, left: renameExpr(expr.left, map, tag), right: renameExpr(expr.right, map, tag) };
      case 'new':
        return {
          kind: 'new',
          structName: expr.structName,
          args: expr.args.map((a) => renameExpr(a, map, tag)),
          allocId: `${expr.allocId}@${tag}`,
        };
      case 'field':
        return { kind: 'field', target: renameExpr(expr.target, map, tag), field: expr.field };
      case 'call':
        return { kind: 'call', callee: expr.callee, args: expr.args.map((a) => renameExpr(a, map, tag)) };
    }
  }

  function renameStmts(stmts: EscStmt[], map: Map<string, string>, tag: string): EscStmt[] {
    const out: EscStmt[] = [];
    for (const s of stmts) {
      if (s.kind === 'decl') {
        const init = renameExpr(s.init, map, tag);
        const fresh = `${s.name}_${tag}`;
        map.set(s.name, fresh);
        out.push({ kind: 'decl', type: s.type, name: fresh, init });
      } else if (s.kind === 'assign') {
        out.push({ kind: 'assign', name: map.get(s.name) || s.name, value: renameExpr(s.value, map, tag) });
      } else if (s.kind === 'setField') {
        out.push({ kind: 'setField', target: map.get(s.target) || s.target, field: s.field, value: renameExpr(s.value, map, tag) });
      } else if (s.kind === 'if') {
        out.push({
          kind: 'if',
          cond: renameExpr(s.cond, map, tag),
          thenBody: renameStmts(s.thenBody, new Map(map), tag),
          elseBody: renameStmts(s.elseBody, new Map(map), tag),
        });
      } else if (s.kind === 'while') {
        out.push({ kind: 'while', cond: renameExpr(s.cond, map, tag), body: renameStmts(s.body, new Map(map), tag) });
      } else if (s.kind === 'return') {
        out.push({ kind: 'return', value: renameExpr(s.value, map, tag) });
      } else if (s.kind === 'print') {
        out.push({ kind: 'print', value: renameExpr(s.value, map, tag) });
      } else if (s.kind === 'publish') {
        out.push({ kind: 'publish', value: renameExpr(s.value, map, tag) });
      }
    }
    return out;
  }

  function expandExpr(expr: EscExpr, caller: string, depth: number, prefix: EscStmt[]): EscExpr {
    switch (expr.kind) {
      case 'int':
      case 'var':
        return expr;
      case 'unary':
        return { kind: 'unary', operand: expandExpr(expr.operand, caller, depth, prefix) };
      case 'bin':
        return {
          kind: 'bin',
          op: expr.op,
          left: expandExpr(expr.left, caller, depth, prefix),
          right: expandExpr(expr.right, caller, depth, prefix),
        };
      case 'new':
        return { ...expr, args: expr.args.map((a) => expandExpr(a, caller, depth, prefix)) };
      case 'field':
        return { kind: 'field', target: expandExpr(expr.target, caller, depth, prefix), field: expr.field };
      case 'call': {
        const args = expr.args.map((a) => expandExpr(a, caller, depth, prefix));
        const callee = funcMap.get(expr.callee)!;
        if (recursive.has(callee.name)) {
          decisions.push({ caller, callee: callee.name, inlined: false, reason: '存在递归调用环，不能展开' });
          return { kind: 'call', callee: expr.callee, args };
        }
        if (depth >= 3) {
          decisions.push({ caller, callee: callee.name, inlined: false, reason: '达到最大内联深度 3' });
          return { kind: 'call', callee: expr.callee, args };
        }
        const size = countStmts(callee.body);
        if (size > MAX_INLINE_STMTS) {
          decisions.push({ caller, callee: callee.name, inlined: false, reason: `函数体 ${size} 条语句超过内联预算 ${MAX_INLINE_STMTS}` });
          return { kind: 'call', callee: expr.callee, args };
        }
        if (!hasTailOnlyReturn(callee.body)) {
          decisions.push({ caller, callee: callee.name, inlined: false, reason: '存在多个提前 return 出口，暂不展开' });
          return { kind: 'call', callee: expr.callee, args };
        }
        const tag = `in${++inlineCounter}`;
        decisions.push({ caller, callee: callee.name, inlined: true, reason: `非递归且仅 ${size} 条语句，展开为 ${tag}` });
        const map = new Map<string, string>();
        callee.params.forEach((p, idx) => {
          const pname = `${p.name}_${tag}`;
          map.set(p.name, pname);
          prefix.push({ kind: 'decl', type: p.type, name: pname, init: args[idx] });
        });
        const renamedBody = renameStmts(callee.body, map, tag);
        const expandedBody = expandStmts(renamedBody.slice(0, -1), caller, depth + 1);
        prefix.push(...expandedBody);
        const tailRet = renamedBody[renamedBody.length - 1] as Extract<EscStmt, { kind: 'return' }>;
        const retVal = expandExpr(tailRet.value, caller, depth + 1, prefix);
        const retVar = `ret_${tag}`;
        prefix.push({ kind: 'decl', type: callee.returnType, name: retVar, init: retVal });
        return { kind: 'var', name: retVar };
      }
    }
  }

  function expandStmts(stmts: EscStmt[], caller: string, depth: number): EscStmt[] {
    const out: EscStmt[] = [];
    for (const s of stmts) {
      const prefix: EscStmt[] = [];
      if (s.kind === 'decl') {
        const init = expandExpr(s.init, caller, depth, prefix);
        out.push(...prefix, { ...s, init });
      } else if (s.kind === 'assign') {
        const value = expandExpr(s.value, caller, depth, prefix);
        out.push(...prefix, { ...s, value });
      } else if (s.kind === 'setField') {
        const value = expandExpr(s.value, caller, depth, prefix);
        out.push(...prefix, { ...s, value });
      } else if (s.kind === 'print') {
        const value = expandExpr(s.value, caller, depth, prefix);
        out.push(...prefix, { ...s, value });
      } else if (s.kind === 'publish') {
        const value = expandExpr(s.value, caller, depth, prefix);
        out.push(...prefix, { ...s, value });
      } else if (s.kind === 'return') {
        const value = expandExpr(s.value, caller, depth, prefix);
        out.push(...prefix, { ...s, value });
      } else if (s.kind === 'if') {
        const cond = expandExpr(s.cond, caller, depth, prefix);
        out.push(...prefix, {
          kind: 'if',
          cond,
          thenBody: expandStmts(s.thenBody, caller, depth),
          elseBody: expandStmts(s.elseBody, caller, depth),
        });
      } else if (s.kind === 'while') {
        // Expand calls inside condition only if condition has no call; otherwise keep loop condition intact.
        out.push({ kind: 'while', cond: s.cond, body: expandStmts(s.body, caller, depth) });
      }
    }
    return out;
  }

  const newFunctions = prog.functions.map((fn) => ({ ...fn, body: expandStmts(fn.body, fn.name, 0) }));
  const newEntry = expandStmts(prog.entry, 'main', 0);
  return { program: { structs: prog.structs, functions: newFunctions, entry: newEntry }, decisions };
}

const escapeRank: Record<EscapeState, number> = { NoEscape: 0, ArgEscape: 1, GlobalEscape: 2 };

function runEscapeAnalysisOnScope(
  ownerFunc: string,
  stmts: EscStmt[],
  structMap: Map<string, StructDef>,
): { reports: AllocReport[]; varAllocs: Map<string, Set<string>> } {
  const allocInfo = new Map<string, { structName: string; varName: string; state: EscapeState; reason: string }>();
  const varPoints = new Map<string, Set<string>>();
  const fieldPoints = new Map<string, Set<string>>(); // allocId -> set of child allocIds stored in its fields

  const addVarPoint = (v: string, id: string) => {
    if (!varPoints.has(v)) varPoints.set(v, new Set());
    varPoints.get(v)!.add(id);
  };
  const promote = (id: string, state: EscapeState, reason: string) => {
    const info = allocInfo.get(id);
    if (!info) return;
    if (escapeRank[state] > escapeRank[info.state]) {
      info.state = state;
      info.reason = reason;
    }
  };

  function evalPoints(expr: EscExpr, boundVar?: string): Set<string> {
    switch (expr.kind) {
      case 'int':
        return new Set();
      case 'var':
        return new Set(varPoints.get(expr.name) || []);
      case 'unary':
        return evalPoints(expr.operand);
      case 'bin':
        evalPoints(expr.left);
        evalPoints(expr.right);
        return new Set();
      case 'new': {
        if (!allocInfo.has(expr.allocId)) {
          allocInfo.set(expr.allocId, {
            structName: expr.structName,
            varName: boundVar || '(匿名)',
            state: 'NoEscape',
            reason: '仅在当前函数栈帧内创建和使用，未逃逸',
          });
        }
        const childSet = fieldPoints.get(expr.allocId) || new Set<string>();
        fieldPoints.set(expr.allocId, childSet);
        for (const arg of expr.args) {
          for (const cid of evalPoints(arg)) childSet.add(cid);
        }
        return new Set([expr.allocId]);
      }
      case 'field': {
        const bases = evalPoints(expr.target);
        const out = new Set<string>();
        for (const b of bases) {
          for (const cid of fieldPoints.get(b) || []) out.add(cid);
        }
        return out;
      }
      case 'call': {
        for (const arg of expr.args) {
          for (const id of evalPoints(arg)) {
            promote(id, 'ArgEscape', `作为实参传给未内联函数 ${expr.callee}(...)`);
          }
        }
        return new Set();
      }
    }
  }

  function scan(block: EscStmt[]) {
    for (const s of block) {
      if (s.kind === 'decl') {
        const pts = evalPoints(s.init, s.name);
        for (const id of pts) addVarPoint(s.name, id);
      } else if (s.kind === 'assign') {
        const pts = evalPoints(s.value, s.name);
        for (const id of pts) addVarPoint(s.name, id);
      } else if (s.kind === 'setField') {
        const rhs = evalPoints(s.value);
        const bases = varPoints.get(s.target) || new Set();
        for (const b of bases) {
          if (!fieldPoints.has(b)) fieldPoints.set(b, new Set());
          for (const c of rhs) fieldPoints.get(b)!.add(c);
        }
      } else if (s.kind === 'publish') {
        for (const id of evalPoints(s.value)) {
          promote(id, 'GlobalEscape', '经 publish(...) 发布到全局外部区域');
        }
      } else if (s.kind === 'return') {
        for (const id of evalPoints(s.value)) {
          promote(id, 'GlobalEscape', `经 return 返回给 ${ownerFunc} 的调用者`);
        }
      } else if (s.kind === 'print') {
        evalPoints(s.value);
      } else if (s.kind === 'if') {
        evalPoints(s.cond);
        scan(s.thenBody);
        scan(s.elseBody);
      } else if (s.kind === 'while') {
        evalPoints(s.cond);
        scan(s.body);
      }
    }
  }

  // Run two passes for loop-carried alias/field edges, then propagate escape transitively along field edges.
  scan(stmts);
  scan(stmts);

  let changed = true;
  while (changed) {
    changed = false;
    for (const [parentId, children] of fieldPoints) {
      const pState = allocInfo.get(parentId)?.state;
      if (!pState || pState === 'NoEscape') continue;
      for (const childId of children) {
        const cInfo = allocInfo.get(childId);
        if (cInfo && escapeRank[pState] > escapeRank[cInfo.state]) {
          cInfo.state = pState;
          cInfo.reason = `存入了已逃逸对象 ${parentId} 的字段（传递逃逸）`;
          changed = true;
        }
      }
    }
  }

  // Check SROA eligibility: NoEscape + flat scalar fields + no ambiguous multi-alloc alias on the variable.
  const reports: AllocReport[] = [...allocInfo.entries()].map(([allocId, info]) => {
    const def = structMap.get(info.structName)!;
    const flatIntFields = def.fields.every((f) => f.type === 'int');
    const ambiguous = [...varPoints.values()].some((set) => set.has(allocId) && set.size > 1);
    const scalarized = info.state === 'NoEscape' && flatIntFields && !ambiguous && info.varName !== '(匿名)';
    const reason =
      info.state !== 'NoEscape'
        ? info.reason
        : ambiguous
          ? '未逃逸，但同一变量在不同路径指向多个对象，保守保留堆分配'
          : !flatIntFields
            ? '未逃逸，含嵌套对象字段（教学 SROA 仅拆平标量字段）'
            : info.reason;
    return {
      allocId,
      structName: info.structName,
      ownerFunc,
      varName: info.varName,
      state: info.state,
      reason,
      scalarized,
      scalarVars: scalarized ? def.fields.map((f) => `${info.varName}$${f.name}`) : undefined,
    };
  });

  return { reports, varAllocs: varPoints };
}

function applySroaToScope(
  stmts: EscStmt[],
  reports: AllocReport[],
  varAllocs: Map<string, Set<string>>,
  structMap: Map<string, StructDef>,
): EscStmt[] {
  const scalarAllocIds = new Set(reports.filter((r) => r.scalarized).map((r) => r.allocId));
  // Map every variable that uniquely points to a scalarized allocId -> its root variable prefix + struct def.
  const allocRoot = new Map<string, { rootVar: string; structDef: StructDef }>();
  for (const r of reports) {
    if (r.scalarized) allocRoot.set(r.allocId, { rootVar: r.varName, structDef: structMap.get(r.structName)! });
  }
  const scalarVarAlias = new Map<string, { rootVar: string; structDef: StructDef }>();
  for (const [v, set] of varAllocs) {
    if (set.size === 1) {
      const only = [...set][0];
      if (scalarAllocIds.has(only)) scalarVarAlias.set(v, allocRoot.get(only)!);
    }
  }

  function rewriteExpr(e: EscExpr): EscExpr {
    switch (e.kind) {
      case 'int':
      case 'var':
        return e;
      case 'unary':
        return { kind: 'unary', operand: rewriteExpr(e.operand) };
      case 'bin':
        return { kind: 'bin', op: e.op, left: rewriteExpr(e.left), right: rewriteExpr(e.right) };
      case 'new':
        return { ...e, args: e.args.map(rewriteExpr) };
      case 'call':
        return { ...e, args: e.args.map(rewriteExpr) };
      case 'field': {
        if (e.target.kind === 'var' && scalarVarAlias.has(e.target.name)) {
          const info = scalarVarAlias.get(e.target.name)!;
          return { kind: 'var', name: `${info.rootVar}$${e.field}` };
        }
        return { kind: 'field', target: rewriteExpr(e.target), field: e.field };
      }
    }
  }

  function rewriteStmts(list: EscStmt[]): EscStmt[] {
    const out: EscStmt[] = [];
    for (const s of list) {
      if (s.kind === 'decl') {
        if (s.init.kind === 'new' && scalarAllocIds.has(s.init.allocId)) {
          const info = allocRoot.get(s.init.allocId)!;
          info.structDef.fields.forEach((f, idx) => {
            out.push({
              kind: 'decl',
              type: f.type,
              name: `${info.rootVar}$${f.name}`,
              init: rewriteExpr((s.init as Extract<EscExpr, { kind: 'new' }>).args[idx]),
            });
          });
          continue;
        }
        if (s.init.kind === 'var' && scalarVarAlias.has(s.name) && scalarVarAlias.has(s.init.name)) {
          // Alias copy `Point q = p;` disappears because q's field accesses now read p$field directly.
          continue;
        }
        out.push({ ...s, init: rewriteExpr(s.init) });
      } else if (s.kind === 'assign') {
        if (scalarVarAlias.has(s.name) && s.value.kind === 'var' && scalarVarAlias.has(s.value.name)) {
          continue;
        }
        out.push({ ...s, value: rewriteExpr(s.value) });
      } else if (s.kind === 'setField') {
        if (scalarVarAlias.has(s.target)) {
          const info = scalarVarAlias.get(s.target)!;
          out.push({ kind: 'assign', name: `${info.rootVar}$${s.field}`, value: rewriteExpr(s.value) });
        } else {
          out.push({ ...s, value: rewriteExpr(s.value) });
        }
      } else if (s.kind === 'if') {
        out.push({ kind: 'if', cond: rewriteExpr(s.cond), thenBody: rewriteStmts(s.thenBody), elseBody: rewriteStmts(s.elseBody) });
      } else if (s.kind === 'while') {
        out.push({ kind: 'while', cond: rewriteExpr(s.cond), body: rewriteStmts(s.body) });
      } else if (s.kind === 'return') {
        out.push({ kind: 'return', value: rewriteExpr(s.value) });
      } else if (s.kind === 'print') {
        out.push({ kind: 'print', value: rewriteExpr(s.value) });
      } else if (s.kind === 'publish') {
        out.push({ kind: 'publish', value: rewriteExpr(s.value) });
      }
    }
    return out;
  }

  return rewriteStmts(stmts);
}

type RuntimeVal = number | boolean | { __obj: true; structName: string; fields: Record<string, RuntimeVal> };

function formatRuntimeObj(v: RuntimeVal): string {
  if (typeof v !== 'object') return String(v);
  return `${v.structName}{${Object.entries(v.fields).map(([k, val]) => `${k}=${formatRuntimeObj(val)}`).join(', ')}}`;
}

function executeProgram(name: string, prog: EscProgram): EscapeRunStats {
  const structMap = new Map(prog.structs.map((s) => [s.name, s]));
  const funcMap = new Map(prog.functions.map((f) => [f.name, f]));
  const output: (number | boolean)[] = [];
  const published: string[] = [];
  let calls = 0;
  let heapAllocs = 0;
  let steps = 0;
  let limited = false;

  const checkStep = () => {
    steps++;
    if (steps > MAX_EXEC_STEPS) {
      limited = true;
      throw new Error('__LIMIT__');
    }
  };

  function evalExpr(e: EscExpr, env: Map<string, RuntimeVal>, depth: number): RuntimeVal {
    checkStep();
    switch (e.kind) {
      case 'int':
        return e.value;
      case 'var': {
        if (!env.has(e.name)) throw new Error(`读取未初始化变量 ${e.name}。`);
        return env.get(e.name)!;
      }
      case 'unary': {
        const v = evalExpr(e.operand, env, depth);
        return evaluateBinary('-', 0, v as number);
      }
      case 'bin': {
        const l = evalExpr(e.left, env, depth);
        const r = evalExpr(e.right, env, depth);
        return evaluateBinary(e.op, l as number | boolean, r as number | boolean);
      }
      case 'new': {
        const def = structMap.get(e.structName)!;
        const fields: Record<string, RuntimeVal> = {};
        def.fields.forEach((f, idx) => {
          fields[f.name] = evalExpr(e.args[idx], env, depth);
        });
        heapAllocs++;
        return { __obj: true, structName: def.name, fields };
      }
      case 'field': {
        const target = evalExpr(e.target, env, depth);
        if (typeof target !== 'object') throw new Error('不能在标量上访问字段。');
        return target.fields[e.field];
      }
      case 'call': {
        if (depth >= MAX_CALL_DEPTH) throw new Error(`调用深度超过 ${MAX_CALL_DEPTH} 层上限。`);
        const fn = funcMap.get(e.callee)!;
        const argVals = e.args.map((a) => evalExpr(a, env, depth));
        calls++;
        const fnEnv = new Map<string, RuntimeVal>();
        fn.params.forEach((p, idx) => fnEnv.set(p.name, argVals[idx]));
        const ret = execBlock(fn.body, fnEnv, depth + 1);
        if (!ret.returned) throw new Error(`函数 ${fn.name} 未返回值。`);
        return ret.value!;
      }
    }
  }

  function execBlock(stmts: EscStmt[], env: Map<string, RuntimeVal>, depth: number): { returned: boolean; value?: RuntimeVal } {
    for (const s of stmts) {
      checkStep();
      if (s.kind === 'decl') {
        env.set(s.name, evalExpr(s.init, env, depth));
      } else if (s.kind === 'assign') {
        env.set(s.name, evalExpr(s.value, env, depth));
      } else if (s.kind === 'setField') {
        const obj = env.get(s.target);
        if (!obj || typeof obj !== 'object') throw new Error(`写入字段 ${s.target}.${s.field} 失败。`);
        obj.fields[s.field] = evalExpr(s.value, env, depth);
      } else if (s.kind === 'print') {
        output.push(evalExpr(s.value, env, depth) as number | boolean);
      } else if (s.kind === 'publish') {
        published.push(formatRuntimeObj(evalExpr(s.value, env, depth)));
      } else if (s.kind === 'return') {
        return { returned: true, value: evalExpr(s.value, env, depth) };
      } else if (s.kind === 'if') {
        const cond = evalExpr(s.cond, env, depth);
        const branch = cond ? s.thenBody : s.elseBody;
        const r = execBlock(branch, env, depth);
        if (r.returned) return r;
      } else if (s.kind === 'while') {
        while (evalExpr(s.cond, env, depth)) {
          const r = execBlock(s.body, env, depth);
          if (r.returned) return r;
        }
      }
    }
    return { returned: false };
  }

  try {
    execBlock(prog.entry, new Map(), 0);
    return { name, output, published, calls, heapAllocs, steps, halted: true, limited: false };
  } catch (err) {
    if (limited) {
      return { name, output, published, calls, heapAllocs, steps, halted: false, limited: true };
    }
    return {
      name,
      output,
      published,
      calls,
      heapAllocs,
      steps,
      halted: false,
      limited: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function analyzeEscape(source: string): EscapeOutcome {
  try {
    const original = parseEscapeProgram(source);
    validateProgram(original);
    const structMap = new Map(original.structs.map((s) => [s.name, s]));

    // 1) Escape analysis BEFORE inlining (for contrast!)
    const beforeEscape: AllocReport[] = [];
    for (const fn of original.functions) {
      beforeEscape.push(...runEscapeAnalysisOnScope(fn.name, fn.body, structMap).reports);
    }
    beforeEscape.push(...runEscapeAnalysisOnScope('main', original.entry, structMap).reports);

    // 2) Inlining
    const { program: inlined, decisions: inlineDecisions } = inlineProgram(original);

    // 3) Escape analysis AFTER inlining + SROA
    const afterEscape: AllocReport[] = [];
    const sroaFunctions: FuncDef[] = inlined.functions.map((fn) => {
      const res = runEscapeAnalysisOnScope(fn.name, fn.body, structMap);
      afterEscape.push(...res.reports);
      return { ...fn, body: applySroaToScope(fn.body, res.reports, res.varAllocs, structMap) };
    });
    const mainRes = runEscapeAnalysisOnScope('main', inlined.entry, structMap);
    afterEscape.push(...mainRes.reports);
    const sroaEntry = applySroaToScope(inlined.entry, mainRes.reports, mainRes.varAllocs, structMap);
    const sroaProg: EscProgram = { structs: inlined.structs, functions: sroaFunctions, entry: sroaEntry };

    // 4) Execute all 3 versions
    const runs = {
      original: executeProgram('优化前（原样调用与堆分配）', original),
      inlined: executeProgram('仅方法内联后', inlined),
      sroa: executeProgram('内联 + 逃逸分析 + 标量替换（SROA）', sroaProg),
    };

    const equivalent: 'same' | 'different' | 'unknown' =
      runs.original.limited || runs.inlined.limited || runs.sroa.limited
        ? 'unknown'
        : [runs.inlined, runs.sroa].every(
              (r) =>
                r.halted === runs.original.halted &&
                r.error === runs.original.error &&
                JSON.stringify(r.output) === JSON.stringify(runs.original.output) &&
                JSON.stringify(r.published) === JSON.stringify(runs.original.published),
            )
          ? 'same'
          : 'different';

    // 5) Build replay frames
    const frames: EscapeFrame[] = [];
    let traceTruncated = false;
    const record = (frame: EscapeFrame) => {
      if (frames.length < MAX_TRACE) frames.push(frame);
      else traceTruncated = true;
    };

    record({
      kind: 'initial',
      message: `解析通过：${original.structs.length} 个结构体、${original.functions.length} 个函数。未内联前，原始程序里有 ${beforeEscape.length} 处 new 分配点。`,
    });

    inlineDecisions.forEach((d, idx) => {
      record({
        kind: 'inline',
        focusInline: idx,
        message: d.inlined
          ? `内联决策：把 ${d.callee}(...) 展开进 ${d.caller}（${d.reason}），消除函数调用并把内部对象暴露到调用者作用域。`
          : `内联决策：保留对 ${d.callee}(...) 的调用（${d.reason}）。`,
      });
    });

    afterEscape.forEach((r) => {
      record({
        kind: 'escape',
        focusAlloc: r.allocId,
        message: `逃逸分析 ${r.allocId}（${r.ownerFunc} 中的 new ${r.structName}）：判定为 ${r.state}——${r.reason}。`,
      });
    });

    const scalarizedList = afterEscape.filter((r) => r.scalarized);
    scalarizedList.forEach((r) => {
      record({
        kind: 'sroa',
        focusAlloc: r.allocId,
        message: `标量替换（SROA）：${r.allocId} 未逃逸，删去堆对象分配，改用标量局部变量 ${r.scalarVars!.join('、')}。`,
      });
    });

    frames.push({
      kind: 'complete',
      message: `三版本执行完成：函数调用 ${runs.original.calls} → ${runs.sroa.calls} 次，堆对象分配 ${runs.original.heapAllocs} → ${runs.sroa.heapAllocs} 次。`,
    });

    return {
      ok: true,
      analysis: {
        originalCode: formatProgram(original),
        inlinedCode: formatProgram(inlined),
        sroaCode: formatProgram(sroaProg),
        inlineDecisions,
        beforeEscape,
        afterEscape,
        runs,
        equivalent,
        frames,
        traceTruncated,
      },
    };
  } catch (err) {
    if (err instanceof ParseErr) {
      return { ok: false, issue: { message: err.message, start: err.start, end: err.end } };
    }
    return { ok: false, issue: { message: err instanceof Error ? err.message : String(err), start: 0, end: 0 } };
  }
}
