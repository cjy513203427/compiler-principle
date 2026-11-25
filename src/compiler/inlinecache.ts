import { MAX_SOURCE } from '../state';

export type IcExpr =
  | { kind: 'int'; value: number }
  | { kind: 'bool'; value: boolean }
  | { kind: 'var'; name: string }
  | { kind: 'obj'; entries: { key: string; value: IcExpr }[] }
  | { kind: 'get'; siteId: number; obj: IcExpr; prop: string; location: string }
  | { kind: 'call'; name: string; args: IcExpr[] }
  | { kind: 'unary'; op: '-'; operand: IcExpr }
  | { kind: 'binary'; op: string; left: IcExpr; right: IcExpr };

export type IcStmt =
  | { kind: 'let'; name: string; init: IcExpr }
  | { kind: 'assign'; name: string; value: IcExpr }
  | { kind: 'setprop'; objName: string; prop: string; value: IcExpr }
  | { kind: 'print'; value: IcExpr }
  | { kind: 'if'; cond: IcExpr; then: IcStmt[]; otherwise?: IcStmt[] }
  | { kind: 'while'; cond: IcExpr; body: IcStmt[] }
  | { kind: 'return'; value: IcExpr };

export interface IcFnDecl {
  name: string;
  params: string[];
  body: IcStmt[];
}

export interface IcProgram {
  functions: IcFnDecl[];
  main: IcStmt[];
}

export interface ShapeNode {
  id: number;
  parentId: number | null;
  addedProp?: string;
  props: { name: string; offset: number }[];
  transitions: { prop: string; toShapeId: number }[];
}

export type IcState = 'uninitialized' | 'monomorphic' | 'polymorphic' | 'megamorphic';

export interface IcSiteSnapshot {
  siteId: number;
  location: string;
  prop: string;
  state: IcState;
  entries: { shapeId: number; offset: number }[];
  hits: number;
  misses: number;
  totalCost: number;
}

export interface IcHeapObject {
  id: number;
  label: string;
  shapeId: number;
  slots: { prop: string; offset: number; value: string }[];
}

export interface IcFrame {
  kind: 'alloc' | 'transition' | 'ic-hit' | 'ic-miss' | 'print' | 'complete';
  message: string;
  activeShapeId?: number;
  activeSiteId?: number;
  activeObjectId?: number;
  shapes: ShapeNode[];
  sites: IcSiteSnapshot[];
  heap: IcHeapObject[];
  output: string[];
  icTotalCost: number;
  dictTotalCost: number;
}

export interface InlineCacheAnalysis {
  program: IcProgram;
  shapes: ShapeNode[];
  sites: IcSiteSnapshot[];
  icTotalCost: number;
  dictTotalCost: number;
  icOutput: string[];
  icError?: string;
  oracleOutput: string[];
  oracleError?: string;
  verified: boolean;
  frames: IcFrame[];
  traceTruncated: boolean;
}

export type InlineCacheResult =
  | { ok: true; analysis: InlineCacheAnalysis }
  | { ok: false; error: string };

interface Tok {
  kind: 'id' | 'num' | 'sym' | 'eof';
  text: string;
  pos: number;
}

const MAX_FUNCS = 16;
const MAX_STEPS = 2000;
const MAX_FRAMES = 240;
const POLY_LIMIT = 4;

const COST_MONO_HIT = 1;
const COST_MISS_LOOKUP = 10;
const COST_MEGA_LOOKUP = 12;
const COST_DICT_LOOKUP = 12;

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
    if (['<=', '>=', '==', '!='].includes(two)) {
      tokens.push({ kind: 'sym', text: two, pos: i });
      i += 2;
      continue;
    }
    if ('{}()<>;,:=.+-*/'.includes(ch)) {
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
  private nextSiteId = 1;
  private currentFn = 'main';

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

  parseProgram(): IcProgram {
    const functions: IcFnDecl[] = [];
    const main: IcStmt[] = [];
    while (this.peek().kind !== 'eof') {
      if (this.peek().kind === 'id' && this.peek().text === 'fn') {
        functions.push(this.parseFn());
      } else {
        main.push(this.parseStmt());
      }
    }
    if (functions.length > MAX_FUNCS) throw new Error(`函数数量超过上限（${MAX_FUNCS} 个）。`);
    return { functions, main };
  }

  private parseFn(): IcFnDecl {
    this.expect('fn');
    const name = this.expectId().text;
    const prev = this.currentFn;
    this.currentFn = name;
    this.expect('(');
    const params: string[] = [];
    if (!this.match(')')) {
      do {
        params.push(this.expectId().text);
      } while (this.match(','));
      this.expect(')');
    }
    const body = this.parseBlock();
    this.currentFn = prev;
    return { name, params, body };
  }

  private parseBlock(): IcStmt[] {
    this.depth++;
    if (this.depth > 32) throw new Error('语句块嵌套超过上限。');
    this.expect('{');
    const stmts: IcStmt[] = [];
    while (!this.match('}')) {
      if (this.peek().kind === 'eof') throw new Error('缺少闭合花括号 }。');
      stmts.push(this.parseStmt());
    }
    this.depth--;
    return stmts;
  }

  private parseStmt(): IcStmt {
    const t = this.peek();
    if (t.kind === 'id' && t.text === 'let') {
      this.next();
      const name = this.expectId().text;
      this.expect('=');
      const init = this.parseExpr();
      this.expect(';');
      return { kind: 'let', name, init };
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
    if (this.match('.')) {
      const prop = this.expectId().text;
      this.expect('=');
      const value = this.parseExpr();
      this.expect(';');
      return { kind: 'setprop', objName: name, prop, value };
    }
    this.expect('=');
    const value = this.parseExpr();
    this.expect(';');
    return { kind: 'assign', name, value };
  }

  private parseExpr(): IcExpr {
    return this.parseEq();
  }
  private parseEq(): IcExpr {
    let left = this.parseRel();
    while (this.peek().text === '==' || this.peek().text === '!=') {
      const op = this.next().text;
      left = { kind: 'binary', op, left, right: this.parseRel() };
    }
    return left;
  }
  private parseRel(): IcExpr {
    let left = this.parseAdd();
    while (['<', '<=', '>', '>='].includes(this.peek().text)) {
      const op = this.next().text;
      left = { kind: 'binary', op, left, right: this.parseAdd() };
    }
    return left;
  }
  private parseAdd(): IcExpr {
    let left = this.parseMul();
    while (this.peek().text === '+' || this.peek().text === '-') {
      const op = this.next().text;
      left = { kind: 'binary', op, left, right: this.parseMul() };
    }
    return left;
  }
  private parseMul(): IcExpr {
    let left = this.parseUnary();
    while (this.peek().text === '*' || this.peek().text === '/') {
      const op = this.next().text;
      left = { kind: 'binary', op, left, right: this.parseUnary() };
    }
    return left;
  }
  private parseUnary(): IcExpr {
    if (this.match('-')) return { kind: 'unary', op: '-', operand: this.parseUnary() };
    return this.parsePostfix();
  }
  private parsePostfix(): IcExpr {
    let expr = this.parsePrimary();
    while (this.match('.')) {
      const prop = this.expectId().text;
      const objLabel = expr.kind === 'var' ? expr.name : 'expr';
      expr = {
        kind: 'get',
        siteId: this.nextSiteId++,
        obj: expr,
        prop,
        location: `${this.currentFn}: ${objLabel}.${prop}`,
      };
    }
    return expr;
  }

  private parsePrimary(): IcExpr {
    const t = this.peek();
    if (t.kind === 'num') {
      this.next();
      return { kind: 'int', value: Number(t.text) };
    }
    if (t.kind === 'id' && (t.text === 'true' || t.text === 'false')) {
      this.next();
      return { kind: 'bool', value: t.text === 'true' };
    }
    if (this.match('{')) {
      const entries: { key: string; value: IcExpr }[] = [];
      if (!this.match('}')) {
        do {
          const key = this.expectId().text;
          this.expect(':');
          const value = this.parseExpr();
          entries.push({ key, value });
        } while (this.match(','));
        this.expect('}');
      }
      return { kind: 'obj', entries };
    }
    if (this.match('(')) {
      const inner = this.parseExpr();
      this.expect(')');
      return inner;
    }
    if (t.kind === 'id') {
      if (this.peek(1).text === '(') {
        const name = this.next().text;
        this.expect('(');
        const args: IcExpr[] = [];
        if (!this.match(')')) {
          do {
            args.push(this.parseExpr());
          } while (this.match(','));
          this.expect(')');
        }
        return { kind: 'call', name, args };
      }
      this.next();
      return { kind: 'var', name: t.text };
    }
    throw new Error(`位置 ${t.pos}：无法解析表达式 '${t.text || 'EOF'}'。`);
  }
}

type ShapeVal = number | boolean | { objId: number };
type DictVal = number | boolean | { dict: Record<string, DictVal> };

function safeInt(n: number): number {
  if (!Number.isSafeInteger(n)) throw new Error('整数运算超出安全范围。');
  return n;
}

function evalOp(op: string, l: number | boolean, r: number | boolean): number | boolean {
  if (typeof l === 'number' && typeof r === 'number') {
    if (op === '+') return safeInt(l + r);
    if (op === '-') return safeInt(l - r);
    if (op === '*') return safeInt(l * r);
    if (op === '/') {
      if (r === 0) throw new Error('运行时错误：除数为 0。');
      return safeInt(Math.trunc(l / r));
    }
    if (op === '<') return l < r;
    if (op === '<=') return l <= r;
    if (op === '>') return l > r;
    if (op === '>=') return l >= r;
    if (op === '==') return l === r;
    if (op === '!=') return l !== r;
  }
  if (typeof l === 'boolean' && typeof r === 'boolean') {
    if (op === '==') return l === r;
    if (op === '!=') return l !== r;
  }
  throw new Error(`运行时错误：运算符 '${op}' 类型不匹配。`);
}

function fmtShapeVal(v: ShapeVal): string {
  return typeof v === 'object' ? `Obj#${v.objId}` : String(v);
}

function fmtDictVal(v: DictVal): string {
  return typeof v === 'object' ? '{obj}' : String(v);
}

export function analyzeInlineCache(source: string): InlineCacheResult {
  if (source.length > MAX_SOURCE) {
    return { ok: false, error: `源码长度超过限制（最多 ${MAX_SOURCE} 字符）。` };
  }
  let program: IcProgram;
  try {
    program = new Parser(tokenize(source)).parseProgram();
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  const fnMap = new Map<string, IcFnDecl>();
  for (const fn of program.functions) {
    if (fnMap.has(fn.name)) return { ok: false, error: `重复定义函数 '${fn.name}'。` };
    fnMap.set(fn.name, fn);
  }

  // Collect all syntactic IC sites
  const siteMap = new Map<number, IcSiteSnapshot>();
  const collectExpr = (e: IcExpr) => {
    if (e.kind === 'get') {
      siteMap.set(e.siteId, {
        siteId: e.siteId,
        location: e.location,
        prop: e.prop,
        state: 'uninitialized',
        entries: [],
        hits: 0,
        misses: 0,
        totalCost: 0,
      });
      collectExpr(e.obj);
    } else if (e.kind === 'obj') e.entries.forEach((x) => collectExpr(x.value));
    else if (e.kind === 'call') e.args.forEach(collectExpr);
    else if (e.kind === 'unary') collectExpr(e.operand);
    else if (e.kind === 'binary') {
      collectExpr(e.left);
      collectExpr(e.right);
    }
  };
  const collectStmts = (ss: IcStmt[]) => {
    for (const s of ss) {
      if (s.kind === 'let') collectExpr(s.init);
      else if (s.kind === 'assign' || s.kind === 'setprop' || s.kind === 'print' || s.kind === 'return')
        collectExpr(s.value);
      else if (s.kind === 'if') {
        collectExpr(s.cond);
        collectStmts(s.then);
        if (s.otherwise) collectStmts(s.otherwise);
      } else if (s.kind === 'while') {
        collectExpr(s.cond);
        collectStmts(s.body);
      }
    }
  };
  for (const fn of program.functions) collectStmts(fn.body);
  collectStmts(program.main);

  // Shape transition tree
  const shapes: ShapeNode[] = [{ id: 0, parentId: null, props: [], transitions: [] }];
  const heapObjs: { id: number; label: string; shapeId: number; slots: ShapeVal[] }[] = [];

  const transitionShape = (fromId: number, prop: string): { toId: number; created: boolean; offset: number } => {
    const parent = shapes[fromId];
    const existing = parent.transitions.find((t) => t.prop === prop);
    if (existing) {
      const target = shapes[existing.toShapeId];
      const offset = target.props.find((p) => p.name === prop)!.offset;
      return { toId: existing.toShapeId, created: false, offset };
    }
    const newId = shapes.length;
    const offset = parent.props.length;
    const nextShape: ShapeNode = {
      id: newId,
      parentId: fromId,
      addedProp: prop,
      props: [...parent.props, { name: prop, offset }],
      transitions: [],
    };
    shapes.push(nextShape);
    parent.transitions.push({ prop, toShapeId: newId });
    return { toId: newId, created: true, offset };
  };

  const snapshotShapes = (): ShapeNode[] =>
    shapes.map((s) => ({
      ...s,
      props: s.props.map((p) => ({ ...p })),
      transitions: s.transitions.map((t) => ({ ...t })),
    }));
  const snapshotSites = (): IcSiteSnapshot[] =>
    [...siteMap.values()].map((s) => ({ ...s, entries: s.entries.map((e) => ({ ...e })) }));
  const snapshotHeap = (): IcHeapObject[] =>
    heapObjs.map((o) => {
      const shape = shapes[o.shapeId];
      return {
        id: o.id,
        label: o.label,
        shapeId: o.shapeId,
        slots: shape.props.map((p) => ({
          prop: p.name,
          offset: p.offset,
          value: fmtShapeVal(o.slots[p.offset]),
        })),
      };
    });

  const frames: IcFrame[] = [];
  let traceTruncated = false;
  let icTotalCost = 0;
  let dictTotalCost = 0;
  const icOutput: string[] = [];
  let icError: string | undefined;

  const pushFrame = (
    kind: IcFrame['kind'],
    message: string,
    extra: { activeShapeId?: number; activeSiteId?: number; activeObjectId?: number } = {},
  ) => {
    if (frames.length < MAX_FRAMES) {
      frames.push({
        kind,
        message,
        ...extra,
        shapes: snapshotShapes(),
        sites: snapshotSites(),
        heap: snapshotHeap(),
        output: [...icOutput],
        icTotalCost,
        dictTotalCost,
      });
    } else {
      traceTruncated = true;
    }
  };

  // Run Shape + IC VM
  let steps = 0;
  const tick = () => {
    steps++;
    if (steps > MAX_STEPS) throw new Error(`执行超过步数上限（${MAX_STEPS} 步），已暂停。`);
  };

  const evalShapeExpr = (expr: IcExpr, env: Map<string, ShapeVal>, bindLabel?: string): ShapeVal => {
    tick();
    if (expr.kind === 'int' || expr.kind === 'bool') return expr.value;
    if (expr.kind === 'var') {
      if (!env.has(expr.name)) throw new Error(`未声明的变量 '${expr.name}'。`);
      return env.get(expr.name)!;
    }
    if (expr.kind === 'unary') {
      const v = evalShapeExpr(expr.operand, env);
      if (typeof v !== 'number') throw new Error('一元负号要求整数。');
      return safeInt(-v);
    }
    if (expr.kind === 'binary') {
      const l = evalShapeExpr(expr.left, env);
      const r = evalShapeExpr(expr.right, env);
      if (typeof l === 'object' || typeof r === 'object') throw new Error(`不能对对象直接做 '${expr.op}' 运算。`);
      return evalOp(expr.op, l, r);
    }
    if (expr.kind === 'obj') {
      const objId = heapObjs.length + 1;
      const obj = { id: objId, label: bindLabel || `obj#${objId}`, shapeId: 0, slots: [] as ShapeVal[] };
      heapObjs.push(obj);
      const added: string[] = [];
      let createdAny = false;
      for (const entry of expr.entries) {
        const val = evalShapeExpr(entry.value, env);
        const existingProp = shapes[obj.shapeId].props.find((p) => p.name === entry.key);
        if (existingProp) {
          obj.slots[existingProp.offset] = val;
        } else {
          const tr = transitionShape(obj.shapeId, entry.key);
          obj.shapeId = tr.toId;
          obj.slots[tr.offset] = val;
          added.push(`${entry.key}@${tr.offset}`);
          if (tr.created) createdAny = true;
        }
      }
      pushFrame(
        'alloc',
        `创建对象 #${obj.id}（${obj.label}）：按属性顺序 [${added.join(', ') || '空'}] 沿隐藏类转移树到达 Shape#${obj.shapeId}${createdAny ? '（新建分支）' : '（复用已有隐藏类！）'}。`,
        { activeShapeId: obj.shapeId, activeObjectId: obj.id },
      );
      return { objId: obj.id };
    }
    if (expr.kind === 'get') {
      const target = evalShapeExpr(expr.obj, env);
      if (typeof target !== 'object') throw new Error(`无法从基础值 ${String(target)} 读取属性 '.${expr.prop}'。`);
      const obj = heapObjs[target.objId - 1];
      const site = siteMap.get(expr.siteId)!;
      const shape = shapes[obj.shapeId];
      dictTotalCost += COST_DICT_LOOKUP;

      if (site.state === 'megamorphic') {
        site.misses++;
        site.totalCost += COST_MEGA_LOOKUP;
        icTotalCost += COST_MEGA_LOOKUP;
        const propInfo = shape.props.find((p) => p.name === expr.prop);
        if (!propInfo) throw new Error(`运行时错误：对象 #${obj.id}（Shape#${obj.shapeId}）没有属性 '${expr.prop}'。`);
        const val = obj.slots[propInfo.offset];
        pushFrame(
          'ic-miss',
          `[超态慢路径] ${site.location}：已见超过 ${POLY_LIMIT} 种 Shape，退化为字典慢查找（+${COST_MEGA_LOOKUP} 周期），读出 ${fmtShapeVal(val)}。`,
          { activeShapeId: obj.shapeId, activeSiteId: site.siteId, activeObjectId: obj.id },
        );
        return val;
      }

      const cachedIdx = site.entries.findIndex((e) => e.shapeId === obj.shapeId);
      if (cachedIdx >= 0) {
        const entry = site.entries[cachedIdx];
        const cost = site.state === 'monomorphic' ? COST_MONO_HIT : 2 + cachedIdx;
        site.hits++;
        site.totalCost += cost;
        icTotalCost += cost;
        const val = obj.slots[entry.offset];
        pushFrame(
          'ic-hit',
          `[${site.state === 'monomorphic' ? '单态 IC 命中' : '多态 IC 命中'}] ${site.location}：对象 #${obj.id} 匹配 Shape#${obj.shapeId} → 直接读取槽 slots[${entry.offset}] = ${fmtShapeVal(val)}（仅 ${cost} 周期）。`,
          { activeShapeId: obj.shapeId, activeSiteId: site.siteId, activeObjectId: obj.id },
        );
        return val;
      }

      // IC Miss
      const propInfo = shape.props.find((p) => p.name === expr.prop);
      if (!propInfo) throw new Error(`运行时错误：对象 #${obj.id}（Shape#${obj.shapeId}）没有属性 '${expr.prop}'。`);
      site.misses++;
      site.totalCost += COST_MISS_LOOKUP;
      icTotalCost += COST_MISS_LOOKUP;
      const prevState = site.state;
      if (site.entries.length < POLY_LIMIT) {
        site.entries.push({ shapeId: obj.shapeId, offset: propInfo.offset });
        site.state = site.entries.length === 1 ? 'monomorphic' : 'polymorphic';
      } else {
        site.state = 'megamorphic';
      }
      const val = obj.slots[propInfo.offset];
      pushFrame(
        'ic-miss',
        `[IC 未命中 · ${prevState} → ${site.state}] ${site.location}：首次遇到 Shape#${obj.shapeId}，查表得知 '${expr.prop}' 在偏移 @${propInfo.offset}${site.state === 'megamorphic' ? '，缓存表已满，退化为超态（Megamorphic）！' : ' 并写入内联缓存'}（+${COST_MISS_LOOKUP} 周期）。`,
        { activeShapeId: obj.shapeId, activeSiteId: site.siteId, activeObjectId: obj.id },
      );
      return val;
    }
    // call
    const fn = fnMap.get(expr.name);
    if (!fn) throw new Error(`未定义的函数 '${expr.name}'。`);
    if (expr.args.length !== fn.params.length) {
      throw new Error(`函数 '${fn.name}' 需要 ${fn.params.length} 个参数，实际传入 ${expr.args.length} 个。`);
    }
    const vals = expr.args.map((a) => evalShapeExpr(a, env));
    const childEnv = new Map<string, ShapeVal>();
    fn.params.forEach((p, idx) => childEnv.set(p, vals[idx]));
    const ret = execShapeStmts(fn.body, childEnv);
    if (ret === undefined) throw new Error(`函数 '${fn.name}' 未执行 return。`);
    return ret;
  };

  const execShapeStmts = (stmts: IcStmt[], env: Map<string, ShapeVal>): ShapeVal | undefined => {
    for (const s of stmts) {
      tick();
      if (s.kind === 'let') {
        const v = evalShapeExpr(s.init, env, s.name);
        env.set(s.name, v);
      } else if (s.kind === 'assign') {
        if (!env.has(s.name)) throw new Error(`未声明的变量 '${s.name}'。`);
        env.set(s.name, evalShapeExpr(s.value, env, s.name));
      } else if (s.kind === 'setprop') {
        const target = env.get(s.objName);
        if (!target || typeof target !== 'object') throw new Error(`变量 '${s.objName}' 不是对象。`);
        const obj = heapObjs[target.objId - 1];
        const val = evalShapeExpr(s.value, env);
        const existing = shapes[obj.shapeId].props.find((p) => p.name === s.prop);
        dictTotalCost += COST_DICT_LOOKUP;
        if (existing) {
          obj.slots[existing.offset] = val;
          icTotalCost += COST_MONO_HIT;
          pushFrame(
            'transition',
            `修改已有属性 ${s.objName}.${s.prop} = ${fmtShapeVal(val)}（保持 Shape#${obj.shapeId}，写槽 @${existing.offset}）。`,
            { activeShapeId: obj.shapeId, activeObjectId: obj.id },
          );
        } else {
          const prevShape = obj.shapeId;
          const tr = transitionShape(prevShape, s.prop);
          obj.shapeId = tr.toId;
          obj.slots[tr.offset] = val;
          icTotalCost += COST_MISS_LOOKUP;
          pushFrame(
            'transition',
            `动态添加新属性 ${s.objName}.${s.prop} = ${fmtShapeVal(val)}：对象 #${obj.id} 从 Shape#${prevShape} 迁移到 Shape#${tr.toId}（新增槽 @${tr.offset}）。`,
            { activeShapeId: obj.shapeId, activeObjectId: obj.id },
          );
        }
      } else if (s.kind === 'print') {
        const v = evalShapeExpr(s.value, env);
        icOutput.push(fmtShapeVal(v));
        pushFrame('print', `输出：${fmtShapeVal(v)}`);
      } else if (s.kind === 'if') {
        const c = evalShapeExpr(s.cond, env);
        if (typeof c !== 'boolean') throw new Error('if 条件必须是 bool。');
        if (c) {
          const r = execShapeStmts(s.then, env);
          if (r !== undefined) return r;
        } else if (s.otherwise) {
          const r = execShapeStmts(s.otherwise, env);
          if (r !== undefined) return r;
        }
      } else if (s.kind === 'while') {
        while (true) {
          const c = evalShapeExpr(s.cond, env);
          if (typeof c !== 'boolean') throw new Error('while 条件必须是 bool。');
          if (!c) break;
          const r = execShapeStmts(s.body, env);
          if (r !== undefined) return r;
        }
      } else if (s.kind === 'return') {
        return evalShapeExpr(s.value, env);
      }
    }
    return undefined;
  };

  try {
    execShapeStmts(program.main, new Map());
  } catch (err) {
    icError = err instanceof Error ? err.message : String(err);
  }

  // Independent Dictionary-Mode Oracle Interpreter
  const oracleOutput: string[] = [];
  let oracleError: string | undefined;
  let oSteps = 0;
  const oTick = () => {
    oSteps++;
    if (oSteps > MAX_STEPS) throw new Error(`执行超过步数上限（${MAX_STEPS} 步），已暂停。`);
  };
  const evalDictExpr = (expr: IcExpr, env: Map<string, DictVal>): DictVal => {
    oTick();
    if (expr.kind === 'int' || expr.kind === 'bool') return expr.value;
    if (expr.kind === 'var') {
      if (!env.has(expr.name)) throw new Error(`未声明的变量 '${expr.name}'。`);
      return env.get(expr.name)!;
    }
    if (expr.kind === 'unary') {
      const v = evalDictExpr(expr.operand, env);
      if (typeof v !== 'number') throw new Error('一元负号要求整数。');
      return safeInt(-v);
    }
    if (expr.kind === 'binary') {
      const l = evalDictExpr(expr.left, env);
      const r = evalDictExpr(expr.right, env);
      if (typeof l === 'object' || typeof r === 'object') throw new Error(`不能对对象直接做 '${expr.op}' 运算。`);
      return evalOp(expr.op, l, r);
    }
    if (expr.kind === 'obj') {
      const dict: Record<string, DictVal> = {};
      for (const e of expr.entries) dict[e.key] = evalDictExpr(e.value, env);
      return { dict };
    }
    if (expr.kind === 'get') {
      const t = evalDictExpr(expr.obj, env);
      if (typeof t !== 'object') throw new Error(`无法读取属性 '.${expr.prop}'。`);
      if (!(expr.prop in t.dict)) throw new Error(`运行时错误：对象没有属性 '${expr.prop}'。`);
      return t.dict[expr.prop];
    }
    const fn = fnMap.get(expr.name)!;
    const args = expr.args.map((a) => evalDictExpr(a, env));
    const child = new Map<string, DictVal>();
    fn.params.forEach((p, idx) => child.set(p, args[idx]));
    const r = execDictStmts(fn.body, child);
    if (r === undefined) throw new Error(`函数 '${fn.name}' 未执行 return。`);
    return r;
  };
  const execDictStmts = (stmts: IcStmt[], env: Map<string, DictVal>): DictVal | undefined => {
    for (const s of stmts) {
      oTick();
      if (s.kind === 'let') env.set(s.name, evalDictExpr(s.init, env));
      else if (s.kind === 'assign') env.set(s.name, evalDictExpr(s.value, env));
      else if (s.kind === 'setprop') {
        const t = env.get(s.objName);
        if (!t || typeof t !== 'object') throw new Error(`变量 '${s.objName}' 不是对象。`);
        t.dict[s.prop] = evalDictExpr(s.value, env);
      } else if (s.kind === 'print') oracleOutput.push(fmtDictVal(evalDictExpr(s.value, env)));
      else if (s.kind === 'if') {
        const c = evalDictExpr(s.cond, env);
        if (typeof c !== 'boolean') throw new Error('if 条件必须是 bool。');
        if (c) {
          const r = execDictStmts(s.then, env);
          if (r !== undefined) return r;
        } else if (s.otherwise) {
          const r = execDictStmts(s.otherwise, env);
          if (r !== undefined) return r;
        }
      } else if (s.kind === 'while') {
        while (true) {
          const c = evalDictExpr(s.cond, env);
          if (typeof c !== 'boolean') throw new Error('while 条件必须是 bool。');
          if (!c) break;
          const r = execDictStmts(s.body, env);
          if (r !== undefined) return r;
        }
      } else if (s.kind === 'return') return evalDictExpr(s.value, env);
    }
    return undefined;
  };
  try {
    execDictStmts(program.main, new Map());
  } catch (err) {
    oracleError = err instanceof Error ? err.message : String(err);
  }

  const verified =
    Boolean(icError) === Boolean(oracleError) &&
    icOutput.length === oracleOutput.length &&
    icOutput.every((v, i) => v === oracleOutput[i]);

  pushFrame(
    'complete',
    `运行完成：共形成 ${shapes.length} 个隐藏类（Shape#0–#${shapes.length - 1}），属性访问总代价 Shape+IC ${icTotalCost} vs 字典查找 ${dictTotalCost}，与独立字典解释器结果${verified ? '完全一致' : '存在差异'}。`,
  );

  return {
    ok: true,
    analysis: {
      program,
      shapes: snapshotShapes(),
      sites: snapshotSites(),
      icTotalCost,
      dictTotalCost,
      icOutput,
      icError,
      oracleOutput,
      oracleError,
      verified,
      frames,
      traceTruncated,
    },
  };
}
