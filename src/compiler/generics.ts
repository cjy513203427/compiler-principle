import { MAX_SOURCE } from '../state';

export type GType =
  | { kind: 'prim'; name: 'int' | 'bool' | 'str' }
  | { kind: 'nom'; name: string }
  | { kind: 'param'; name: string }
  | { kind: 'struct'; name: string; args: GType[] };

export interface GenClassDecl {
  name: string;
  superName?: string;
}

export interface GenField {
  name: string;
  type: GType;
}

export interface GenStructDecl {
  name: string;
  typeParams: string[];
  fields: GenField[];
}

export interface GenFnDecl {
  id: number;
  name: string;
  typeParams: string[];
  params: { name: string; type: GType }[];
  retType: GType;
  body: GenStmt[];
}

export type GenExpr =
  | { kind: 'int'; value: number }
  | { kind: 'bool'; value: boolean }
  | { kind: 'str'; value: string }
  | { kind: 'var'; name: string }
  | { kind: 'new'; type: GType; args: GenExpr[] }
  | { kind: 'call'; name: string; typeArgs: GType[]; args: GenExpr[] }
  | { kind: 'field'; obj: GenExpr; field: string }
  | { kind: 'unary'; op: '-'; operand: GenExpr }
  | { kind: 'binary'; op: string; left: GenExpr; right: GenExpr };

export type GenStmt =
  | { kind: 'let'; type: GType; name: string; init: GenExpr }
  | { kind: 'assign'; name: string; value: GenExpr }
  | { kind: 'print'; value: GenExpr }
  | { kind: 'if'; cond: GenExpr; then: GenStmt[]; otherwise?: GenStmt[] }
  | { kind: 'while'; cond: GenExpr; body: GenStmt[] }
  | { kind: 'return'; value: GenExpr };

export interface GenProgram {
  classes: GenClassDecl[];
  structs: GenStructDecl[];
  functions: GenFnDecl[];
  main: GenStmt[];
}

export interface MonomorphUnit {
  kind: 'struct' | 'fn';
  mangledName: string;
  sourceSig: string;
  code: string;
}

export interface ErasedUnit {
  kind: 'struct' | 'fn';
  name: string;
  erasedSig: string;
  code: string;
}

export interface GenMetrics {
  codeUnits: number;
  boxOps: number;
  unboxOps: number;
  checkcasts: number;
  heapBytes: number;
  steps: number;
  output: string[];
  error?: string;
}

export interface GenFrame {
  kind: 'typecheck' | 'erase' | 'monomorph' | 'exec-erased' | 'exec-mono' | 'compare';
  message: string;
  highlightUnit?: string;
  erasedOp?: string;
  monoOp?: string;
  erasedMetrics: GenMetrics;
  monoMetrics: GenMetrics;
}

export interface GenericsAnalysis {
  program: GenProgram;
  erasedUnits: ErasedUnit[];
  erasedClashError?: string;
  monoUnits: MonomorphUnit[];
  erasedMetrics: GenMetrics;
  monoMetrics: GenMetrics;
  oracleOutput: string[];
  oracleError?: string;
  verified: boolean;
  frames: GenFrame[];
  traceTruncated: boolean;
}

export type GenericsResult =
  | { ok: true; analysis: GenericsAnalysis }
  | { ok: false; error: string };

interface Tok {
  kind: 'id' | 'num' | 'str' | 'sym' | 'eof';
  text: string;
  pos: number;
}

const MAX_STRUCTS = 12;
const MAX_FUNCS = 16;
const MAX_SPECS = 32;
const MAX_STEPS = 2000;
const MAX_FRAMES = 240;

export function formatType(t: GType): string {
  if (t.kind === 'prim' || t.kind === 'nom' || t.kind === 'param') return t.name;
  return t.args.length ? `${t.name}<${t.args.map(formatType).join(', ')}>` : t.name;
}

function mangleType(t: GType): string {
  if (t.kind === 'prim' || t.kind === 'nom' || t.kind === 'param') return t.name;
  return t.args.length ? `${t.name}_${t.args.map(mangleType).join('_')}` : t.name;
}

function typeEquals(a: GType, b: GType): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'prim' && b.kind === 'prim') return a.name === b.name;
  if (a.kind === 'nom' && b.kind === 'nom') return a.name === b.name;
  if (a.kind === 'param' && b.kind === 'param') return a.name === b.name;
  if (a.kind === 'struct' && b.kind === 'struct') {
    return a.name === b.name && a.args.length === b.args.length && a.args.every((x, i) => typeEquals(x, b.args[i]));
  }
  return false;
}

function substType(t: GType, map: Map<string, GType>): GType {
  if (t.kind === 'param') return map.get(t.name) ?? t;
  if (t.kind === 'struct') return { kind: 'struct', name: t.name, args: t.args.map((a) => substType(a, map)) };
  return t;
}

function eraseTypeName(t: GType): string {
  if (t.kind === 'param') return 'Object';
  if (t.kind === 'prim') return t.name;
  if (t.kind === 'nom') return t.name;
  return t.name;
}

function eraseFieldType(t: GType): string {
  if (t.kind === 'param') return 'Object';
  if (t.kind === 'prim') return t.name;
  if (t.kind === 'nom') return t.name;
  return t.name;
}

function tokenize(source: string): Tok[] {
  const tokens: Tok[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (ch === '"') {
      const start = i++;
      let out = '';
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\n') throw new Error(`位置 ${start}：字符串字面量未闭合。`);
        out += source[i++];
      }
      if (i >= source.length) throw new Error(`位置 ${start}：字符串字面量未闭合。`);
      i++;
      tokens.push({ kind: 'str', text: out, pos: start });
      continue;
    }
    if (/[0-9]/.test(ch)) {
      const start = i;
      while (i < source.length && /[0-9]/.test(source[i])) i++;
      tokens.push({ kind: 'num', text: source.slice(start, i), pos: start });
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const start = i;
      while (i < source.length && /[A-Za-z0-9_]/.test(source[i])) i++;
      tokens.push({ kind: 'id', text: source.slice(start, i), pos: start });
      continue;
    }
    const two = source.slice(i, i + 2);
    if (['->', '<=', '>=', '==', '!='].includes(two)) {
      tokens.push({ kind: 'sym', text: two, pos: i });
      i += 2;
      continue;
    }
    if ('{}()<>;,=.+-*/'.includes(ch)) {
      tokens.push({ kind: 'sym', text: ch, pos: i });
      i++;
      continue;
    }
    throw new Error(`位置 ${i}：不支持的字符 '${ch}'。`);
  }
  tokens.push({ kind: 'eof', text: '', pos: source.length });
  return tokens;
}

class Parser {
  private i = 0;
  private depth = 0;
  private nextFnId = 0;
  private typeParamScope = new Set<string>();

  constructor(private tokens: Tok[]) {}

  private peek(offset = 0): Tok {
    return this.tokens[Math.min(this.i + offset, this.tokens.length - 1)];
  }
  private next(): Tok {
    return this.tokens[this.i++];
  }
  private match(text: string): boolean {
    if (this.peek().text === text) {
      this.i++;
      return true;
    }
    return false;
  }
  private expect(text: string): Tok {
    const t = this.peek();
    if (t.text !== text) throw new Error(`位置 ${t.pos}：期望 '${text}'，却读到 '${t.text || 'EOF'}'。`);
    return this.next();
  }
  private expectId(): Tok {
    const t = this.peek();
    if (t.kind !== 'id') throw new Error(`位置 ${t.pos}：期望标识符，却读到 '${t.text || 'EOF'}'。`);
    return this.next();
  }

  parseProgram(): GenProgram {
    const classes: GenClassDecl[] = [];
    const structs: GenStructDecl[] = [];
    const functions: GenFnDecl[] = [];
    const main: GenStmt[] = [];

    while (this.peek().kind !== 'eof') {
      const t = this.peek();
      if (t.kind === 'id' && t.text === 'class') {
        classes.push(this.parseClass());
      } else if (t.kind === 'id' && t.text === 'struct') {
        structs.push(this.parseStruct());
      } else if (t.kind === 'id' && t.text === 'fn') {
        functions.push(this.parseFn());
      } else {
        main.push(this.parseStmt());
      }
    }
    if (structs.length > MAX_STRUCTS) throw new Error(`结构体定义超过上限（${MAX_STRUCTS} 个）。`);
    if (functions.length > MAX_FUNCS) throw new Error(`函数定义超过上限（${MAX_FUNCS} 个）。`);
    return { classes, structs, functions, main };
  }

  private parseClass(): GenClassDecl {
    this.expect('class');
    const name = this.expectId().text;
    let superName: string | undefined;
    if (this.match('extends')) {
      superName = this.expectId().text;
    }
    this.expect('{');
    this.expect('}');
    return { name, superName };
  }

  private parseTypeParams(): string[] {
    const params: string[] = [];
    if (!this.match('<')) return params;
    params.push(this.expectId().text);
    while (this.match(',')) params.push(this.expectId().text);
    this.expect('>');
    return params;
  }

  private parseType(): GType {
    const id = this.expectId().text;
    if (id === 'int' || id === 'bool' || id === 'str') return { kind: 'prim', name: id };
    if (this.typeParamScope.has(id)) return { kind: 'param', name: id };
    if (this.match('<')) {
      const args: GType[] = [this.parseType()];
      while (this.match(',')) args.push(this.parseType());
      this.expect('>');
      return { kind: 'struct', name: id, args };
    }
    return { kind: 'nom', name: id };
  }

  private parseStruct(): GenStructDecl {
    this.expect('struct');
    const name = this.expectId().text;
    const typeParams = this.parseTypeParams();
    const prev = this.typeParamScope;
    this.typeParamScope = new Set(typeParams);
    this.expect('{');
    const fields: GenField[] = [];
    while (!this.match('}')) {
      const type = this.parseType();
      const fname = this.expectId().text;
      this.expect(';');
      fields.push({ name: fname, type });
    }
    this.typeParamScope = prev;
    return { name, typeParams, fields };
  }

  private parseFn(): GenFnDecl {
    this.expect('fn');
    const name = this.expectId().text;
    const typeParams = this.parseTypeParams();
    const prev = this.typeParamScope;
    this.typeParamScope = new Set(typeParams);
    this.expect('(');
    const params: { name: string; type: GType }[] = [];
    if (!this.match(')')) {
      do {
        const type = this.parseType();
        const pname = this.expectId().text;
        params.push({ name: pname, type });
      } while (this.match(','));
      this.expect(')');
    }
    this.expect('->');
    const retType = this.parseType();
    const body = this.parseBlock();
    this.typeParamScope = prev;
    return { id: this.nextFnId++, name, typeParams, params, retType, body };
  }

  private parseBlock(): GenStmt[] {
    this.depth++;
    if (this.depth > 32) throw new Error('语句块嵌套超过上限。');
    this.expect('{');
    const stmts: GenStmt[] = [];
    while (!this.match('}')) {
      if (this.peek().kind === 'eof') throw new Error('缺少闭合花括号 }。');
      stmts.push(this.parseStmt());
    }
    this.depth--;
    return stmts;
  }

  private parseStmt(): GenStmt {
    const t = this.peek();
    if (t.kind === 'id' && t.text === 'let') {
      this.next();
      const type = this.parseType();
      const name = this.expectId().text;
      this.expect('=');
      const init = this.parseExpr();
      this.expect(';');
      return { kind: 'let', type, name, init };
    }
    if (t.kind === 'id' && t.text === 'print') {
      this.next();
      this.expect('(');
      const value = this.parseExpr();
      this.expect(')');
      this.expect(';');
      return { kind: 'print', value };
    }
    if (t.kind === 'id' && t.text === 'return') {
      this.next();
      const value = this.parseExpr();
      this.expect(';');
      return { kind: 'return', value };
    }
    if (t.kind === 'id' && t.text === 'if') {
      this.next();
      this.expect('(');
      const cond = this.parseExpr();
      this.expect(')');
      const then = this.parseBlock();
      const otherwise = this.match('else') ? this.parseBlock() : undefined;
      return { kind: 'if', cond, then, otherwise };
    }
    if (t.kind === 'id' && t.text === 'while') {
      this.next();
      this.expect('(');
      const cond = this.parseExpr();
      this.expect(')');
      const body = this.parseBlock();
      return { kind: 'while', cond, body };
    }
    const name = this.expectId().text;
    this.expect('=');
    const value = this.parseExpr();
    this.expect(';');
    return { kind: 'assign', name, value };
  }

  private parseExpr(): GenExpr {
    return this.parseEq();
  }
  private parseEq(): GenExpr {
    let left = this.parseRel();
    while (this.peek().text === '==' || this.peek().text === '!=') {
      const op = this.next().text;
      left = { kind: 'binary', op, left, right: this.parseRel() };
    }
    return left;
  }
  private parseRel(): GenExpr {
    let left = this.parseAdd();
    while (['<', '<=', '>', '>='].includes(this.peek().text)) {
      const op = this.next().text;
      left = { kind: 'binary', op, left, right: this.parseAdd() };
    }
    return left;
  }
  private parseAdd(): GenExpr {
    let left = this.parseMul();
    while (this.peek().text === '+' || this.peek().text === '-') {
      const op = this.next().text;
      left = { kind: 'binary', op, left, right: this.parseMul() };
    }
    return left;
  }
  private parseMul(): GenExpr {
    let left = this.parseUnary();
    while (this.peek().text === '*' || this.peek().text === '/') {
      const op = this.next().text;
      left = { kind: 'binary', op, left, right: this.parseUnary() };
    }
    return left;
  }
  private parseUnary(): GenExpr {
    if (this.match('-')) return { kind: 'unary', op: '-', operand: this.parseUnary() };
    return this.parsePostfix();
  }
  private parsePostfix(): GenExpr {
    let expr = this.parsePrimary();
    while (this.match('.')) {
      const field = this.expectId().text;
      expr = { kind: 'field', obj: expr, field };
    }
    return expr;
  }

  private looksLikeGenericCall(): boolean {
    if (this.peek(1).text !== '<') return false;
    let depth = 0;
    let j = this.i + 1;
    while (j < this.tokens.length) {
      const tx = this.tokens[j].text;
      if (tx === '<') depth++;
      else if (tx === '>') {
        depth--;
        if (depth === 0) return this.tokens[j + 1]?.text === '(';
      } else if (tx === ';' || tx === '{' || tx === '}' || this.tokens[j].kind === 'eof') {
        return false;
      }
      j++;
    }
    return false;
  }

  private parsePrimary(): GenExpr {
    const t = this.peek();
    if (t.kind === 'num') {
      this.next();
      return { kind: 'int', value: Number(t.text) };
    }
    if (t.kind === 'str') {
      this.next();
      return { kind: 'str', value: t.text };
    }
    if (t.kind === 'id' && (t.text === 'true' || t.text === 'false')) {
      this.next();
      return { kind: 'bool', value: t.text === 'true' };
    }
    if (t.kind === 'id' && t.text === 'new') {
      this.next();
      const type = this.parseType();
      this.expect('(');
      const args: GenExpr[] = [];
      if (!this.match(')')) {
        do {
          args.push(this.parseExpr());
        } while (this.match(','));
        this.expect(')');
      }
      return { kind: 'new', type, args };
    }
    if (this.match('(')) {
      const inner = this.parseExpr();
      this.expect(')');
      return inner;
    }
    if (t.kind === 'id') {
      if (this.looksLikeGenericCall()) {
        const name = this.next().text;
        this.expect('<');
        const typeArgs: GType[] = [this.parseType()];
        while (this.match(',')) typeArgs.push(this.parseType());
        this.expect('>');
        this.expect('(');
        const args: GenExpr[] = [];
        if (!this.match(')')) {
          do {
            args.push(this.parseExpr());
          } while (this.match(','));
          this.expect(')');
        }
        return { kind: 'call', name, typeArgs, args };
      }
      if (this.peek(1).text === '(') {
        const name = this.next().text;
        this.expect('(');
        const args: GenExpr[] = [];
        if (!this.match(')')) {
          do {
            args.push(this.parseExpr());
          } while (this.match(','));
          this.expect(')');
        }
        return { kind: 'call', name, typeArgs: [], args };
      }
      this.next();
      return { kind: 'var', name: t.text };
    }
    throw new Error(`位置 ${t.pos}：无法解析表达式起始符号 '${t.text || 'EOF'}'。`);
  }
}

interface CheckedCall {
  fn: GenFnDecl;
  typeArgs: GType[];
  retType: GType;
}

type RuntimeVal =
  | { kind: 'int'; value: number }
  | { kind: 'bool'; value: boolean }
  | { kind: 'str'; value: string }
  | { kind: 'nom'; className: string }
  | { kind: 'struct'; structName: string; concreteType: string; fields: Record<string, RuntimeVal> }
  | { kind: 'boxed'; primKind: 'int' | 'bool' | 'str'; inner: RuntimeVal };

function formatVal(v: RuntimeVal): string {
  if (v.kind === 'boxed') return formatVal(v.inner);
  if (v.kind === 'int' || v.kind === 'bool') return String(v.value);
  if (v.kind === 'str') return v.value;
  if (v.kind === 'nom') return `${v.className}()`;
  const inner = Object.entries(v.fields)
    .map(([k, val]) => `${k}=${formatVal(val)}`)
    .join(', ');
  return `${v.concreteType}{${inner}}`;
}

function safeInt(n: number): number {
  if (!Number.isSafeInteger(n)) throw new Error('整数运算超出安全范围。');
  return n;
}

function evalBinary(op: string, l: RuntimeVal, r: RuntimeVal): RuntimeVal {
  const lv = l.kind === 'boxed' ? l.inner : l;
  const rv = r.kind === 'boxed' ? r.inner : r;
  if (op === '+' && lv.kind === 'str' && rv.kind === 'str') {
    return { kind: 'str', value: lv.value + rv.value };
  }
  if (lv.kind === 'int' && rv.kind === 'int') {
    if (op === '+') return { kind: 'int', value: safeInt(lv.value + rv.value) };
    if (op === '-') return { kind: 'int', value: safeInt(lv.value - rv.value) };
    if (op === '*') return { kind: 'int', value: safeInt(lv.value * rv.value) };
    if (op === '/') {
      if (rv.value === 0) throw new Error('运行时错误：除数为 0。');
      return { kind: 'int', value: safeInt(Math.trunc(lv.value / rv.value)) };
    }
    if (op === '<') return { kind: 'bool', value: lv.value < rv.value };
    if (op === '<=') return { kind: 'bool', value: lv.value <= rv.value };
    if (op === '>') return { kind: 'bool', value: lv.value > rv.value };
    if (op === '>=') return { kind: 'bool', value: lv.value >= rv.value };
    if (op === '==') return { kind: 'bool', value: lv.value === rv.value };
    if (op === '!=') return { kind: 'bool', value: lv.value !== rv.value };
  }
  if (lv.kind === 'bool' && rv.kind === 'bool') {
    if (op === '==') return { kind: 'bool', value: lv.value === rv.value };
    if (op === '!=') return { kind: 'bool', value: lv.value !== rv.value };
  }
  if (lv.kind === 'str' && rv.kind === 'str') {
    if (op === '==') return { kind: 'bool', value: lv.value === rv.value };
    if (op === '!=') return { kind: 'bool', value: lv.value !== rv.value };
  }
  throw new Error(`运行时错误：运算符 '${op}' 不支持当前操作数类型。`);
}

function emptyMetrics(codeUnits: number): GenMetrics {
  return { codeUnits, boxOps: 0, unboxOps: 0, checkcasts: 0, heapBytes: 0, steps: 0, output: [] };
}

function cloneMetrics(m: GenMetrics): GenMetrics {
  return { ...m, output: [...m.output] };
}

export function analyzeGenerics(source: string): GenericsResult {
  if (source.length > MAX_SOURCE) {
    return { ok: false, error: `源码长度超过限制（最多 ${MAX_SOURCE} 字符）。` };
  }
  let program: GenProgram;
  try {
    program = new Parser(tokenize(source)).parseProgram();
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  // Validate classes & inheritance cycles
  const classMap = new Map<string, GenClassDecl>();
  for (const c of program.classes) {
    if (classMap.has(c.name)) return { ok: false, error: `重复定义类 '${c.name}'。` };
    classMap.set(c.name, c);
  }
  for (const c of program.classes) {
    const seen = new Set<string>([c.name]);
    let cur = c.superName;
    while (cur) {
      if (seen.has(cur)) return { ok: false, error: `类继承出现循环：${c.name}。` };
      if (!classMap.has(cur)) return { ok: false, error: `父类 '${cur}' 未定义。` };
      seen.add(cur);
      cur = classMap.get(cur)!.superName;
    }
  }

  const structMap = new Map<string, GenStructDecl>();
  for (const s of program.structs) {
    if (structMap.has(s.name) || classMap.has(s.name)) {
      return { ok: false, error: `重复定义类型 '${s.name}'。` };
    }
    structMap.set(s.name, s);
  }

  const isNominalSubtype = (sub: string, sup: string): boolean => {
    let cur: string | undefined = sub;
    while (cur) {
      if (cur === sup) return true;
      cur = classMap.get(cur)?.superName;
    }
    return false;
  };

  const isAssignable = (from: GType, to: GType): { ok: true } | { ok: false; reason: string } => {
    if (typeEquals(from, to)) return { ok: true };
    if (from.kind === 'nom' && to.kind === 'nom' && isNominalSubtype(from.name, to.name)) {
      return { ok: true };
    }
    if (from.kind === 'struct' && to.kind === 'struct' && from.name === to.name && from.args.length === to.args.length) {
      // Check if difference is solely due to subtype argument (Invariance!)
      const hasSubtypeArg = from.args.some(
        (fa, idx) => !typeEquals(fa, to.args[idx]) && isAssignable(fa, to.args[idx]).ok,
      );
      if (hasSubtypeArg) {
        return {
          ok: false,
          reason: `泛型不变性错误（Invariance）：虽然类型实参存在子类型关系，但 ${formatType(from)} 不是 ${formatType(to)} 的子类型（否则可能通过父类容器写入错误类型）。`,
        };
      }
    }
    return {
      ok: false,
      reason: `类型不匹配：无法将 ${formatType(from)} 赋值给 ${formatType(to)}。`,
    };
  };

  const validateType = (t: GType, allowedParams: Set<string>): void => {
    if (t.kind === 'prim') return;
    if (t.kind === 'param') {
      if (!allowedParams.has(t.name)) throw new Error(`未声明的类型参数 '${t.name}'。`);
      return;
    }
    if (t.kind === 'nom') {
      if (structMap.has(t.name)) {
        const s = structMap.get(t.name)!;
        if (s.typeParams.length > 0) throw new Error(`泛型结构体 ${s.name} 需要 ${s.typeParams.length} 个类型参数。`);
        return;
      }
      if (!classMap.has(t.name)) throw new Error(`未定义的类型 '${t.name}'。`);
      return;
    }
    const s = structMap.get(t.name);
    if (!s) throw new Error(`未定义的泛型结构体 '${t.name}'。`);
    if (s.typeParams.length !== t.args.length) {
      throw new Error(`结构体 ${s.name} 需要 ${s.typeParams.length} 个类型参数，实际给出 ${t.args.length} 个。`);
    }
    for (const arg of t.args) validateType(arg, allowedParams);
  };

  // Validate struct fields & function signatures
  try {
    for (const s of program.structs) {
      const pset = new Set(s.typeParams);
      for (const f of s.fields) validateType(f.type, pset);
    }
    for (const fn of program.functions) {
      const pset = new Set(fn.typeParams);
      for (const p of fn.params) validateType(p.type, pset);
      validateType(fn.retType, pset);
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  // Track concrete struct & function instantiations discovered during type checking
  const monoStructs = new Map<string, { decl: GenStructDecl; args: GType[] }>();
  const monoFns = new Map<string, { decl: GenFnDecl; args: GType[]; mangledName: string }>();
  const callResolution = new WeakMap<GenExpr, CheckedCall>();
  const exprTypeMap = new WeakMap<GenExpr, GType>();

  const registerStructInst = (t: GType) => {
    if (t.kind !== 'struct') return;
    for (const a of t.args) registerStructInst(a);
    const key = formatType(t);
    if (!monoStructs.has(key)) {
      if (monoStructs.size + monoFns.size >= MAX_SPECS) {
        throw new Error(`单态化特化实例超过上限（${MAX_SPECS} 个）。`);
      }
      monoStructs.set(key, { decl: structMap.get(t.name)!, args: t.args });
    }
  };

  const checkBlock = (
    stmts: GenStmt[],
    env: Map<string, GType>,
    allowedParams: Set<string>,
    expectedRet?: GType,
    instMap?: Map<string, GType>,
  ): boolean => {
    let returned = false;
    for (const stmt of stmts) {
      if (stmt.kind === 'let') {
        validateType(stmt.type, allowedParams);
        const targetType = instMap ? substType(stmt.type, instMap) : stmt.type;
        registerStructInst(targetType);
        const initType = checkExpr(stmt.init, env, allowedParams, instMap);
        const ok = isAssignable(initType, targetType);
        if (!ok.ok) throw new Error(ok.reason);
        env.set(stmt.name, targetType);
      } else if (stmt.kind === 'assign') {
        const target = env.get(stmt.name);
        if (!target) throw new Error(`未声明的变量 '${stmt.name}'。`);
        const vt = checkExpr(stmt.value, env, allowedParams, instMap);
        const ok = isAssignable(vt, target);
        if (!ok.ok) throw new Error(ok.reason);
      } else if (stmt.kind === 'print') {
        checkExpr(stmt.value, env, allowedParams, instMap);
      } else if (stmt.kind === 'if') {
        const ct = checkExpr(stmt.cond, env, allowedParams, instMap);
        if (ct.kind !== 'prim' || ct.name !== 'bool') throw new Error(`if 条件必须是 bool，实际为 ${formatType(ct)}。`);
        const r1 = checkBlock(stmt.then, new Map(env), allowedParams, expectedRet, instMap);
        const r2 = stmt.otherwise ? checkBlock(stmt.otherwise, new Map(env), allowedParams, expectedRet, instMap) : false;
        if (r1 && r2) returned = true;
      } else if (stmt.kind === 'while') {
        const ct = checkExpr(stmt.cond, env, allowedParams, instMap);
        if (ct.kind !== 'prim' || ct.name !== 'bool') throw new Error(`while 条件必须是 bool，实际为 ${formatType(ct)}。`);
        checkBlock(stmt.body, new Map(env), allowedParams, expectedRet, instMap);
      } else if (stmt.kind === 'return') {
        if (!expectedRet) throw new Error('顶层语句不能使用 return。');
        const rt = checkExpr(stmt.value, env, allowedParams, instMap);
        const ok = isAssignable(rt, expectedRet);
        if (!ok.ok) throw new Error(ok.reason);
        returned = true;
      }
    }
    return returned;
  };

  const checkExpr = (
    expr: GenExpr,
    env: Map<string, GType>,
    allowedParams: Set<string>,
    instMap?: Map<string, GType>,
  ): GType => {
    let result: GType;
    if (expr.kind === 'int') result = { kind: 'prim', name: 'int' };
    else if (expr.kind === 'bool') result = { kind: 'prim', name: 'bool' };
    else if (expr.kind === 'str') result = { kind: 'prim', name: 'str' };
    else if (expr.kind === 'var') {
      const t = env.get(expr.name);
      if (!t) throw new Error(`未声明的变量 '${expr.name}'。`);
      result = t;
    } else if (expr.kind === 'new') {
      validateType(expr.type, allowedParams);
      const concrete = instMap ? substType(expr.type, instMap) : expr.type;
      if (concrete.kind === 'nom') {
        if (classMap.has(concrete.name)) {
          if (expr.args.length !== 0) throw new Error(`类 ${concrete.name} 构造器不接受参数。`);
          result = concrete;
        } else {
          const s = structMap.get(concrete.name);
          if (!s) throw new Error(`无法实例化未知类型 '${concrete.name}'。`);
          if (expr.args.length !== s.fields.length) {
            throw new Error(`结构体 ${s.name} 需要 ${s.fields.length} 个构造参数。`);
          }
          expr.args.forEach((a, idx) => {
            const at = checkExpr(a, env, allowedParams, instMap);
            const ok = isAssignable(at, s.fields[idx].type);
            if (!ok.ok) throw new Error(ok.reason);
          });
          result = concrete;
        }
      } else if (concrete.kind === 'struct') {
        registerStructInst(concrete);
        const s = structMap.get(concrete.name)!;
        const smap = new Map<string, GType>();
        s.typeParams.forEach((tp, idx) => smap.set(tp, concrete.args[idx]));
        if (expr.args.length !== s.fields.length) {
          throw new Error(`结构体 ${formatType(concrete)} 需要 ${s.fields.length} 个构造参数，实际给出 ${expr.args.length} 个。`);
        }
        expr.args.forEach((a, idx) => {
          const at = checkExpr(a, env, allowedParams, instMap);
          const ft = substType(s.fields[idx].type, smap);
          const ok = isAssignable(at, ft);
          if (!ok.ok) throw new Error(ok.reason);
        });
        result = concrete;
      } else {
        throw new Error(`不能对类型 ${formatType(concrete)} 使用 new。`);
      }
    } else if (expr.kind === 'field') {
      const ot = checkExpr(expr.obj, env, allowedParams, instMap);
      if (ot.kind !== 'struct' && !(ot.kind === 'nom' && structMap.has(ot.name))) {
        throw new Error(`类型 ${formatType(ot)} 没有字段 '${expr.field}'。`);
      }
      const s = structMap.get(ot.name)!;
      const f = s.fields.find((x) => x.name === expr.field);
      if (!f) throw new Error(`结构体 ${s.name} 没有字段 '${expr.field}'。`);
      if (ot.kind === 'struct') {
        const smap = new Map<string, GType>();
        s.typeParams.forEach((tp, idx) => smap.set(tp, ot.args[idx]));
        result = substType(f.type, smap);
      } else {
        result = f.type;
      }
    } else if (expr.kind === 'unary') {
      const ot = checkExpr(expr.operand, env, allowedParams, instMap);
      if (ot.kind !== 'prim' || ot.name !== 'int') throw new Error(`一元负号要求 int，实际为 ${formatType(ot)}。`);
      result = ot;
    } else if (expr.kind === 'binary') {
      const lt = checkExpr(expr.left, env, allowedParams, instMap);
      const rt = checkExpr(expr.right, env, allowedParams, instMap);
      if (expr.op === '+' && lt.kind === 'prim' && lt.name === 'str' && rt.kind === 'prim' && rt.name === 'str') {
        result = { kind: 'prim', name: 'str' };
      } else if (['+', '-', '*', '/'].includes(expr.op)) {
        if (lt.kind !== 'prim' || lt.name !== 'int' || rt.kind !== 'prim' || rt.name !== 'int') {
          throw new Error(`算术运算符 '${expr.op}' 要求两个 int，实际为 ${formatType(lt)} 与 ${formatType(rt)}。`);
        }
        result = { kind: 'prim', name: 'int' };
      } else if (['<', '<=', '>', '>='].includes(expr.op)) {
        if (lt.kind !== 'prim' || lt.name !== 'int' || rt.kind !== 'prim' || rt.name !== 'int') {
          throw new Error(`比较运算符 '${expr.op}' 要求两个 int。`);
        }
        result = { kind: 'prim', name: 'bool' };
      } else {
        if (!typeEquals(lt, rt)) throw new Error(`相等性比较 '${expr.op}' 要求两侧类型相同。`);
        result = { kind: 'prim', name: 'bool' };
      }
    } else {
      // call
      const concreteTypeArgs = expr.typeArgs.map((ta) => {
        validateType(ta, allowedParams);
        const c = instMap ? substType(ta, instMap) : ta;
        registerStructInst(c);
        return c;
      });
      const argTypes = expr.args.map((a) => checkExpr(a, env, allowedParams, instMap));
      const candidates = program.functions.filter(
        (fn) => fn.name === expr.name && fn.typeParams.length === concreteTypeArgs.length && fn.params.length === argTypes.length,
      );
      if (candidates.length === 0) {
        throw new Error(`找不到匹配的函数 ${expr.name}（类型参数 ${concreteTypeArgs.length} 个，实参 ${argTypes.length} 个）。`);
      }
      let matched: { fn: GenFnDecl; retType: GType } | undefined;
      for (const fn of candidates) {
        const fmap = new Map<string, GType>();
        fn.typeParams.forEach((tp, idx) => fmap.set(tp, concreteTypeArgs[idx]));
        const allOk = fn.params.every((p, idx) => isAssignable(argTypes[idx], substType(p.type, fmap)).ok);
        if (allOk) {
          matched = { fn, retType: substType(fn.retType, fmap) };
          break;
        }
      }
      if (!matched) {
        throw new Error(`调用 ${expr.name}(${argTypes.map(formatType).join(', ')}) 参数类型不匹配。`);
      }
      const { fn, retType } = matched;
      registerStructInst(retType);
      callResolution.set(expr, { fn, typeArgs: concreteTypeArgs, retType });

      // Register monomorphized specialization (and check body with concrete types)
      const specKey =
        fn.typeParams.length > 0
          ? `${fn.name}<${concreteTypeArgs.map(formatType).join(', ')}>`
          : `${fn.name}#${fn.id}(${fn.params.map((p) => formatType(p.type)).join(', ')})`;
      if (!monoFns.has(specKey)) {
        if (monoStructs.size + monoFns.size >= MAX_SPECS) {
          throw new Error(`单态化特化实例超过上限（${MAX_SPECS} 个）。`);
        }
        const mangledName =
          fn.typeParams.length > 0
            ? `${fn.name}_${concreteTypeArgs.map(mangleType).join('_')}`
            : candidates.length > 1 || program.functions.filter((f) => f.name === fn.name).length > 1
              ? `${fn.name}_${fn.params.map((p) => mangleType(p.type)).join('_')}`
              : fn.name;
        monoFns.set(specKey, { decl: fn, args: concreteTypeArgs, mangledName });
        const fmap = new Map<string, GType>();
        fn.typeParams.forEach((tp, idx) => fmap.set(tp, concreteTypeArgs[idx]));
        const fnEnv = new Map<string, GType>();
        fn.params.forEach((p) => fnEnv.set(p.name, substType(p.type, fmap)));
        const hasRet = checkBlock(fn.body, fnEnv, new Set(fn.typeParams), retType, fmap);
        if (!hasRet) throw new Error(`函数 '${fn.name}' 并非所有路径都包含 return。`);
      }
      result = retType;
    }
    exprTypeMap.set(expr, result);
    return result;
  };

  try {
    // Check non-generic uncalled functions too for return paths & type safety
    for (const fn of program.functions) {
      if (fn.typeParams.length === 0) {
        const fnEnv = new Map<string, GType>();
        fn.params.forEach((p) => fnEnv.set(p.name, p.type));
        const hasRet = checkBlock(fn.body, fnEnv, new Set(), fn.retType);
        if (!hasRet) throw new Error(`函数 '${fn.name}' 并非所有路径都包含 return。`);
      }
    }
    checkBlock(program.main, new Map(), new Set());
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  // Build Erased compilation units (Java style) and detect erasure overload clash!
  const erasedUnits: ErasedUnit[] = [];
  for (const s of program.structs) {
    const fieldsStr = s.fields.map((f) => `  ${eraseFieldType(f.type)} ${f.name};`).join('\n');
    erasedUnits.push({
      kind: 'struct',
      name: s.name,
      erasedSig: `class ${s.name}`,
      code: `class ${s.name} {\n${fieldsStr}\n}`,
    });
  }

  const erasedSigSeen = new Map<string, string>();
  let erasedClashError: string | undefined;
  for (const fn of program.functions) {
    const erasedParams = fn.params.map((p) => `${eraseTypeName(p.type)} ${p.name}`).join(', ');
    const sigKey = `${fn.name}(${fn.params.map((p) => eraseTypeName(p.type)).join(', ')})`;
    const origSig = `${fn.name}${fn.typeParams.length ? `<${fn.typeParams.join(', ')}>` : ''}(${fn.params.map((p) => formatType(p.type)).join(', ')})`;
    if (erasedSigSeen.has(sigKey)) {
      erasedClashError = `类型擦除冲突：${erasedSigSeen.get(sigKey)} 与 ${origSig} 擦除后签名同为 ${sigKey}，在 JVM 类型擦除模型下无法共存！`;
    } else {
      erasedSigSeen.set(sigKey, origSig);
    }
    erasedUnits.push({
      kind: 'fn',
      name: fn.name,
      erasedSig: `${eraseTypeName(fn.retType)} ${sigKey}`,
      code: `// 擦除泛型参数，必要处插入 box / checkcast / unbox\n${eraseTypeName(fn.retType)} ${fn.name}(${erasedParams}) { ... }`,
    });
  }

  // Build Monomorphized compilation units (C++ / Rust style)
  const monoUnits: MonomorphUnit[] = [];
  for (const [key, { decl, args }] of monoStructs) {
    const smap = new Map<string, GType>();
    decl.typeParams.forEach((tp, idx) => smap.set(tp, args[idx]));
    const mangled = `${decl.name}_${args.map(mangleType).join('_')}`;
    const fieldsStr = decl.fields.map((f) => `  ${formatType(substType(f.type, smap))} ${f.name};`).join('\n');
    monoUnits.push({
      kind: 'struct',
      mangledName: mangled,
      sourceSig: key,
      code: `struct ${mangled} {\n${fieldsStr}\n}`,
    });
  }
  for (const [key, { decl, args, mangledName }] of monoFns) {
    const fmap = new Map<string, GType>();
    decl.typeParams.forEach((tp, idx) => fmap.set(tp, args[idx]));
    const paramsStr = decl.params.map((p) => `${formatType(substType(p.type, fmap))} ${p.name}`).join(', ');
    const retStr = formatType(substType(decl.retType, fmap));
    monoUnits.push({
      kind: 'fn',
      mangledName,
      sourceSig: key,
      code: `// 零装箱、零强转的专用特化代码\n${retStr} ${mangledName}(${paramsStr}) { ... }`,
    });
  }

  const frames: GenFrame[] = [];
  let traceTruncated = false;
  const erasedMetrics = emptyMetrics(erasedUnits.length);
  const monoMetrics = emptyMetrics(monoUnits.length);

  const pushFrame = (frame: Omit<GenFrame, 'erasedMetrics' | 'monoMetrics'>) => {
    if (frames.length < MAX_FRAMES) {
      frames.push({
        ...frame,
        erasedMetrics: cloneMetrics(erasedMetrics),
        monoMetrics: cloneMetrics(monoMetrics),
      });
    } else {
      traceTruncated = true;
    }
  };

  pushFrame({
    kind: 'typecheck',
    message: `编译期类型检查通过：验证了 ${program.structs.length} 个泛型结构体、${program.functions.length} 个函数声明与所有调用实参（含不变性检查）。`,
  });

  if (erasedClashError) {
    erasedMetrics.error = erasedClashError;
    pushFrame({
      kind: 'erase',
      message: erasedClashError,
    });
  } else {
    pushFrame({
      kind: 'erase',
      message: `类型擦除（Java 路线）：将所有泛型类型参数擦除为 Object，仅生成 ${erasedUnits.length} 份共享字节码单元；原始类型 int/bool 进入泛型槽位时将自动插入 box / checkcast / unbox。`,
    });
  }

  pushFrame({
    kind: 'monomorph',
    message: `单态化（C++ / Rust 路线）：按实际使用的类型组合展开，生成 ${monoUnits.length} 份特化结构体与函数代码；基础类型直接按值平铺，无需装箱和运行时强转。`,
  });

  // Helper to resolve function calls identically in all VMs
  const resolveRuntimeCall = (
    name: string,
    typeArgs: GType[],
    argTypes: GType[],
  ): { fn: GenFnDecl; fmap: Map<string, GType> } => {
    const candidates = program.functions.filter(
      (fn) => fn.name === name && fn.typeParams.length === typeArgs.length && fn.params.length === argTypes.length,
    );
    for (const fn of candidates) {
      const fmap = new Map<string, GType>();
      fn.typeParams.forEach((tp, idx) => fmap.set(tp, typeArgs[idx]));
      if (fn.params.every((p, idx) => isAssignable(argTypes[idx], substType(p.type, fmap)).ok)) {
        return { fn, fmap };
      }
    }
    return { fn: candidates[0], fmap: new Map() };
  };

  // Run a VM mode: 'erased' | 'mono' | 'oracle'
  const runMode = (mode: 'erased' | 'mono' | 'oracle') => {
    const metrics = mode === 'erased' ? erasedMetrics : mode === 'mono' ? monoMetrics : emptyMetrics(0);
    let steps = 0;

    const tick = () => {
      steps++;
      metrics.steps = steps;
      if (steps > MAX_STEPS) throw new Error(`执行超过步数上限（${MAX_STEPS} 步），已暂停。`);
    };

    const isParamPrim = (val: RuntimeVal): val is Extract<RuntimeVal, { kind: 'int' | 'bool' | 'str' }> =>
      val.kind === 'int' || val.kind === 'bool' || val.kind === 'str';

    const primBytes = (k: 'int' | 'bool' | 'str') => (k === 'int' ? 4 : k === 'bool' ? 1 : 8);

    const boxIfNeeded = (val: RuntimeVal, declaredFieldType: GType, label: string): RuntimeVal => {
      if (mode === 'erased' && declaredFieldType.kind === 'param' && isParamPrim(val)) {
        metrics.boxOps++;
        metrics.heapBytes += 16 + primBytes(val.kind); // 16B object header + payload (Chapter 37)
        pushFrame({
          kind: 'exec-erased',
          message: `[类型擦除] ${label}：将基础值 ${formatVal(val)} 自动装箱（box）为堆对象（+16B 对象头），才能存入 Object 槽位。`,
          erasedOp: `box(${formatVal(val)}) -> Object`,
        });
        return { kind: 'boxed', primKind: val.kind, inner: val };
      }
      return val;
    };

    const checkcastAndUnbox = (val: RuntimeVal, declaredType: GType, concreteType: GType, label: string): RuntimeVal => {
      if (mode === 'erased' && declaredType.kind === 'param') {
        metrics.checkcasts++;
        let out = val;
        let opDesc = `checkcast<${formatType(concreteType)}>`;
        if (out.kind === 'boxed' && concreteType.kind === 'prim') {
          metrics.unboxOps++;
          out = out.inner;
          opDesc += ` + unbox -> ${formatVal(out)}`;
        }
        pushFrame({
          kind: 'exec-erased',
          message: `[类型擦除] ${label}：从 Object 取出值，执行编译器插入的 ${opDesc}。`,
          erasedOp: opDesc,
        });
        return out;
      }
      return val;
    };

    const evalExpr = (
      expr: GenExpr,
      env: Map<string, { val: RuntimeVal; type: GType }>,
      fmap: Map<string, GType>,
    ): { val: RuntimeVal; type: GType } => {
      tick();
      if (expr.kind === 'int') return { val: { kind: 'int', value: expr.value }, type: { kind: 'prim', name: 'int' } };
      if (expr.kind === 'bool') return { val: { kind: 'bool', value: expr.value }, type: { kind: 'prim', name: 'bool' } };
      if (expr.kind === 'str') return { val: { kind: 'str', value: expr.value }, type: { kind: 'prim', name: 'str' } };
      if (expr.kind === 'var') return env.get(expr.name)!;
      if (expr.kind === 'unary') {
        const inner = evalExpr(expr.operand, env, fmap);
        const iv = inner.val.kind === 'boxed' ? inner.val.inner : inner.val;
        if (iv.kind !== 'int') throw new Error('一元负号操作数不是整数。');
        return { val: { kind: 'int', value: safeInt(-iv.value) }, type: { kind: 'prim', name: 'int' } };
      }
      if (expr.kind === 'binary') {
        const l = evalExpr(expr.left, env, fmap);
        const r = evalExpr(expr.right, env, fmap);
        const v = evalBinary(expr.op, l.val, r.val);
        const t: GType =
          v.kind === 'int'
            ? { kind: 'prim', name: 'int' }
            : v.kind === 'bool'
              ? { kind: 'prim', name: 'bool' }
              : { kind: 'prim', name: 'str' };
        return { val: v, type: t };
      }
      if (expr.kind === 'new') {
        const concrete = substType(expr.type, fmap);
        if (concrete.kind === 'nom' && classMap.has(concrete.name)) {
          metrics.heapBytes += 16;
          return { val: { kind: 'nom', className: concrete.name }, type: concrete };
        }
        const sname = concrete.kind === 'struct' ? concrete.name : (concrete as { name: string }).name;
        const s = structMap.get(sname)!;
        const fields: Record<string, RuntimeVal> = {};
        let structBytes = mode === 'erased' ? 16 : 0; // erased: heap object header; mono: value-typed inline fields
        expr.args.forEach((arg, idx) => {
          const ev = evalExpr(arg, env, fmap);
          const fdecl = s.fields[idx];
          const stored = boxIfNeeded(ev.val, fdecl.type, `new ${formatType(concrete)}.${fdecl.name}`);
          fields[fdecl.name] = stored;
          if (mode === 'erased') {
            structBytes += fdecl.type.kind === 'param' ? 8 : 4; // 8B Object ref
          } else {
            structBytes += ev.type.kind === 'prim' ? primBytes(ev.type.name) : 8;
          }
        });
        metrics.heapBytes += structBytes;
        if (mode === 'mono') {
          const mangled = concrete.kind === 'struct' ? mangleType(concrete) : sname;
          pushFrame({
            kind: 'exec-mono',
            message: `[单态化] 构造特化结构体 ${mangled}（占 ${structBytes}B，直接平铺原始值，无需装箱）。`,
            monoOp: `new ${mangled}(...)`,
          });
        }
        return {
          val: { kind: 'struct', structName: sname, concreteType: formatType(concrete), fields },
          type: concrete,
        };
      }
      if (expr.kind === 'field') {
        const obj = evalExpr(expr.obj, env, fmap);
        if (obj.val.kind !== 'struct') throw new Error('非结构体无法访问字段。');
        const s = structMap.get(obj.val.structName)!;
        const fdecl = s.fields.find((f) => f.name === expr.field)!;
        const smap = new Map<string, GType>();
        const objType = obj.type;
        if (objType.kind === 'struct') {
          s.typeParams.forEach((tp, idx) => smap.set(tp, objType.args[idx]));
        }
        const concreteFieldType = substType(fdecl.type, smap);
        const raw = obj.val.fields[expr.field];
        const val = checkcastAndUnbox(raw, fdecl.type, concreteFieldType, `读取 ${obj.val.concreteType}.${expr.field}`);
        if (mode === 'mono') {
          pushFrame({
            kind: 'exec-mono',
            message: `[单态化] 直接读取 ${obj.val.concreteType}.${expr.field} = ${formatVal(val)}（固定偏移，0 次强转）。`,
            monoOp: `load ${mangleType(obj.type)}.${expr.field} -> ${formatVal(val)}`,
          });
        }
        return { val, type: concreteFieldType };
      }
      // call
      const concreteTypeArgs = expr.typeArgs.map((ta) => substType(ta, fmap));
      const evaluatedArgs = expr.args.map((a) => evalExpr(a, env, fmap));
      const resolved = resolveRuntimeCall(
        expr.name,
        concreteTypeArgs,
        evaluatedArgs.map((a) => a.type),
      );
      const { fn, fmap: childFmap } = resolved;
      const childEnv = new Map<string, { val: RuntimeVal; type: GType }>();
      fn.params.forEach((p, idx) => {
        const stored = boxIfNeeded(evaluatedArgs[idx].val, p.type, `传参 ${fn.name}(${p.name})`);
        childEnv.set(p.name, { val: stored, type: substType(p.type, childFmap) });
      });
      if (mode === 'mono' && fn.typeParams.length > 0) {
        const mangled = `${fn.name}_${concreteTypeArgs.map(mangleType).join('_')}`;
        pushFrame({
          kind: 'exec-mono',
          message: `[单态化] 直接调用特化函数 ${mangled}(...)（参数按原类型传递，无装箱）。`,
          monoOp: `call ${mangled}`,
        });
      }
      const ret = execStmts(fn.body, childEnv, childFmap);
      if (!ret) throw new Error(`函数 '${fn.name}' 未返回值。`);
      const concreteRet = substType(fn.retType, childFmap);
      const finalRet = checkcastAndUnbox(ret.val, fn.retType, concreteRet, `${fn.name} 返回值`);
      return { val: finalRet, type: concreteRet };
    };

    const execStmts = (
      stmts: GenStmt[],
      env: Map<string, { val: RuntimeVal; type: GType }>,
      fmap: Map<string, GType>,
    ): { val: RuntimeVal; type: GType } | undefined => {
      for (const s of stmts) {
        tick();
        if (s.kind === 'let') {
          const ev = evalExpr(s.init, env, fmap);
          env.set(s.name, { val: ev.val, type: substType(s.type, fmap) });
        } else if (s.kind === 'assign') {
          const ev = evalExpr(s.value, env, fmap);
          const cur = env.get(s.name)!;
          env.set(s.name, { val: ev.val, type: cur.type });
        } else if (s.kind === 'print') {
          const ev = evalExpr(s.value, env, fmap);
          metrics.output.push(formatVal(ev.val));
        } else if (s.kind === 'if') {
          const c = evalExpr(s.cond, env, fmap);
          const cv = c.val.kind === 'boxed' ? c.val.inner : c.val;
          if (cv.kind === 'bool' && cv.value) {
            const r = execStmts(s.then, env, fmap);
            if (r) return r;
          } else if (s.otherwise) {
            const r = execStmts(s.otherwise, env, fmap);
            if (r) return r;
          }
        } else if (s.kind === 'while') {
          while (true) {
            const c = evalExpr(s.cond, env, fmap);
            const cv = c.val.kind === 'boxed' ? c.val.inner : c.val;
            if (cv.kind !== 'bool' || !cv.value) break;
            const r = execStmts(s.body, env, fmap);
            if (r) return r;
          }
        } else if (s.kind === 'return') {
          return evalExpr(s.value, env, fmap);
        }
      }
      return undefined;
    };

    try {
      execStmts(program.main, new Map(), new Map());
    } catch (err) {
      metrics.error = err instanceof Error ? err.message : String(err);
    }
    return metrics;
  };

  if (!erasedClashError) {
    runMode('erased');
  }
  runMode('mono');
  const oracle = runMode('oracle');

  const monoMatches =
    monoMetrics.error === oracle.error &&
    monoMetrics.output.length === oracle.output.length &&
    monoMetrics.output.every((v, i) => v === oracle.output[i]);

  const erasedMatches = erasedClashError
    ? true // clash is an intentional compile-time rejection in erasure mode
    : erasedMetrics.error === oracle.error &&
      erasedMetrics.output.length === oracle.output.length &&
      erasedMetrics.output.every((v, i) => v === oracle.output[i]);

  const verified = monoMatches && erasedMatches;

  pushFrame({
    kind: 'compare',
    message: erasedClashError
      ? `对照完成：类型擦除因签名冲突在编译期拒绝；单态化生成 ${monoMetrics.codeUnits} 份特化代码且与参考解释器输出完全一致。`
      : `对照完成：类型擦除仅生成 ${erasedMetrics.codeUnits} 份代码但产生 ${erasedMetrics.boxOps} 次装箱与 ${erasedMetrics.checkcasts} 次 checkcast；单态化展开为 ${monoMetrics.codeUnits} 份代码、0 次装箱与强转，两者与参考解释器结果${verified ? '完全一致' : '存在差异'}。`,
  });

  return {
    ok: true,
    analysis: {
      program,
      erasedUnits,
      erasedClashError,
      monoUnits,
      erasedMetrics,
      monoMetrics,
      oracleOutput: oracle.output,
      oracleError: oracle.error,
      verified,
      frames,
      traceTruncated,
    },
  };
}
