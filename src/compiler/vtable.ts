import { evaluateBinary } from './operations';

export interface VtableIssue {
  message: string;
  start: number;
  end: number;
}

export type OopExpr =
  | { kind: 'int'; value: number }
  | { kind: 'var'; name: string }
  | { kind: 'this' }
  | { kind: 'unary'; operand: OopExpr }
  | { kind: 'bin'; op: string; left: OopExpr; right: OopExpr }
  | { kind: 'new'; className: string; args: OopExpr[] }
  | { kind: 'getField'; target: OopExpr; field: string }
  | { kind: 'callMethod'; siteId: number; target: OopExpr; method: string; args: OopExpr[] };

export type OopStmt =
  | { kind: 'decl'; type: string; name: string; init: OopExpr }
  | { kind: 'assign'; name: string; value: OopExpr }
  | { kind: 'setField'; target: 'this' | string; field: string; value: OopExpr }
  | { kind: 'if'; cond: OopExpr; thenBody: OopStmt[]; elseBody: OopStmt[] }
  | { kind: 'while'; cond: OopExpr; body: OopStmt[] }
  | { kind: 'return'; value: OopExpr }
  | { kind: 'print'; value: OopExpr };

export interface MethodDef {
  name: string;
  params: string[];
  body: OopStmt[];
}

export interface ClassDef {
  name: string;
  superName?: string;
  fields: string[];
  methods: MethodDef[];
}

export interface FieldSlot {
  offset: number; // +1, +2, ... (+0 is vptr)
  name: string;
  definedIn: string;
  inherited: boolean;
}

export interface VtableSlot {
  slot: number;
  methodName: string;
  implClass: string;
  status: 'defined' | 'inherited' | 'overridden';
}

export interface ClassLayout {
  name: string;
  superName?: string;
  fields: FieldSlot[];
  vtable: VtableSlot[];
}

export interface CallSiteReport {
  siteId: number;
  location: string;
  staticType: string;
  methodName: string;
  slot: number;
  possibleTargets: string[];
  devirtualized: boolean;
  reason: string;
}

export interface HeapObjectView {
  id: number;
  className: string;
  fields: { offset: number; name: string; value: number }[];
}

export interface DispatchEvent {
  siteId: number;
  receiverVar: string;
  objectId: number;
  staticType: string;
  runtimeClass: string;
  slot: number;
  methodName: string;
  resolvedImpl: string;
  devirtualized: boolean;
}

export interface VtableFrame {
  kind: 'layout' | 'vtable' | 'cha' | 'alloc' | 'dispatch' | 'print' | 'complete';
  focusClass?: string;
  dispatch?: DispatchEvent;
  heap: HeapObjectView[];
  output: (number | boolean)[];
  message: string;
}

export interface VtableAnalysis {
  layouts: ClassLayout[];
  callSites: CallSiteReport[];
  dispatches: DispatchEvent[];
  heap: HeapObjectView[];
  output: (number | boolean)[];
  dynamicCount: number;
  devirtCount: number;
  equivalent: 'same' | 'different' | 'unknown';
  halted: boolean;
  limited: boolean;
  error?: string;
  frames: VtableFrame[];
  traceTruncated: boolean;
}

export type VtableOutcome = { ok: true; analysis: VtableAnalysis } | { ok: false; issue: VtableIssue };

const MAX_SOURCE = 2000;
const MAX_EXEC = 2000;
const MAX_DEPTH = 32;
const MAX_TRACE = 240;

class OopErr extends Error {
  constructor(
    message: string,
    public start = 0,
    public end = 0,
  ) {
    super(message);
  }
}

interface Tok {
  kind: 'id' | 'num' | 'op' | 'punc' | 'eof';
  text: string;
  start: number;
  end: number;
}

function lexOop(src: string): Tok[] {
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
      while (i < src.length && /[a-zA-Z0-9_]/.test(src[i])) i++;
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
    throw new OopErr(`无法识别的字符「${ch}」。`, i, i + 1);
  }
  toks.push({ kind: 'eof', text: 'EOF', start: src.length, end: src.length });
  return toks;
}

const KW = new Set(['class', 'extends', 'new', 'this', 'int', 'if', 'else', 'while', 'return', 'print']);

function parseOop(src: string): { classes: ClassDef[]; entry: OopStmt[] } {
  if (src.length > MAX_SOURCE) throw new OopErr(`输入超过 ${MAX_SOURCE} 字符上限。`, MAX_SOURCE, src.length);
  const toks = lexOop(src);
  let pos = 0;
  let nextSite = 1;
  const peek = (o = 0) => toks[Math.min(pos + o, toks.length - 1)];
  const next = () => toks[pos++];
  const expect = (text: string) => {
    const t = peek();
    if (t.text !== text) throw new OopErr(`此处期望「${text}」，实际遇到「${t.text}」。`, t.start, t.end);
    return next();
  };
  const expectId = (what: string) => {
    const t = peek();
    if (t.kind !== 'id' || KW.has(t.text)) throw new OopErr(`此处期望${what}，实际遇到「${t.text}」。`, t.start, t.end);
    return next();
  };

  function parsePrimary(depth: number): OopExpr {
    if (depth > 32) throw new OopErr('表达式嵌套过深。', peek().start, peek().end);
    const t = peek();
    if (t.kind === 'num') {
      next();
      const v = Number(t.text);
      if (!Number.isSafeInteger(v)) throw new OopErr(`整数 ${t.text} 超出安全范围。`, t.start, t.end);
      return { kind: 'int', value: v };
    }
    if (t.text === '(') {
      next();
      const inner = parseExpr(depth + 1);
      expect(')');
      return inner;
    }
    if (t.text === 'this') {
      next();
      return { kind: 'this' };
    }
    if (t.text === 'new') {
      next();
      const className = expectId('类名').text;
      expect('(');
      const args: OopExpr[] = [];
      if (peek().text !== ')') {
        args.push(parseExpr(depth + 1));
        while (peek().text === ',') {
          next();
          args.push(parseExpr(depth + 1));
        }
      }
      expect(')');
      return { kind: 'new', className, args };
    }
    if (t.kind === 'id' && !KW.has(t.text)) {
      return { kind: 'var', name: next().text };
    }
    throw new OopErr(`期望表达式，实际遇到「${t.text}」。`, t.start, t.end);
  }

  function parsePostfix(depth: number): OopExpr {
    let expr = parsePrimary(depth);
    while (peek().text === '.') {
      next();
      const member = expectId('成员名').text;
      if (peek().text === '(') {
        next();
        const args: OopExpr[] = [];
        if (peek().text !== ')') {
          args.push(parseExpr(depth + 1));
          while (peek().text === ',') {
            next();
            args.push(parseExpr(depth + 1));
          }
        }
        expect(')');
        expr = { kind: 'callMethod', siteId: nextSite++, target: expr, method: member, args };
      } else {
        expr = { kind: 'getField', target: expr, field: member };
      }
    }
    return expr;
  }

  function parseUnary(depth: number): OopExpr {
    if (peek().text === '-') {
      next();
      return { kind: 'unary', operand: parseUnary(depth + 1) };
    }
    return parsePostfix(depth);
  }

  function parseMul(depth: number): OopExpr {
    let left = parseUnary(depth);
    while (peek().text === '*' || peek().text === '/') {
      const op = next().text;
      left = { kind: 'bin', op, left, right: parseUnary(depth + 1) };
    }
    return left;
  }

  function parseAdd(depth: number): OopExpr {
    let left = parseMul(depth);
    while (peek().text === '+' || peek().text === '-') {
      const op = next().text;
      left = { kind: 'bin', op, left, right: parseMul(depth + 1) };
    }
    return left;
  }

  function parseCmp(depth: number): OopExpr {
    let left = parseAdd(depth);
    while (['<', '<=', '>', '>='].includes(peek().text)) {
      const op = next().text;
      left = { kind: 'bin', op, left, right: parseAdd(depth + 1) };
    }
    return left;
  }

  function parseExpr(depth = 0): OopExpr {
    let left = parseCmp(depth);
    while (peek().text === '==' || peek().text === '!=') {
      const op = next().text;
      left = { kind: 'bin', op, left, right: parseCmp(depth + 1) };
    }
    return left;
  }

  function parseBlock(depth: number): OopStmt[] {
    if (depth > 24) throw new OopErr('语句块嵌套过深。', peek().start, peek().end);
    expect('{');
    const stmts: OopStmt[] = [];
    while (peek().text !== '}' && peek().kind !== 'eof') stmts.push(parseStmt(depth + 1));
    expect('}');
    return stmts;
  }

  function parseStmt(depth = 0): OopStmt {
    const t = peek();
    if (t.text === 'if') {
      next();
      expect('(');
      const cond = parseExpr();
      expect(')');
      const thenBody = parseBlock(depth + 1);
      const elseBody = peek().text === 'else' ? (next(), parseBlock(depth + 1)) : [];
      return { kind: 'if', cond, thenBody, elseBody };
    }
    if (t.text === 'while') {
      next();
      expect('(');
      const cond = parseExpr();
      expect(')');
      return { kind: 'while', cond, body: parseBlock(depth + 1) };
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
    if (
      t.kind === 'id' &&
      (!KW.has(t.text) || t.text === 'int') &&
      peek(1).kind === 'id' &&
      !KW.has(peek(1).text) &&
      peek(2).text === '='
    ) {
      const type = next().text;
      const name = next().text;
      expect('=');
      const init = parseExpr();
      expect(';');
      return { kind: 'decl', type, name, init };
    }
    if ((t.text === 'this' || (t.kind === 'id' && !KW.has(t.text))) && peek(1).text === '.' && peek(2).kind === 'id' && peek(3).text === '=') {
      const target = next().text;
      next();
      const field = next().text;
      expect('=');
      const value = parseExpr();
      expect(';');
      return { kind: 'setField', target, field, value };
    }
    if (t.kind === 'id' && !KW.has(t.text) && peek(1).text === '=') {
      const name = next().text;
      expect('=');
      const value = parseExpr();
      expect(';');
      return { kind: 'assign', name, value };
    }
    throw new OopErr(`无法解析语句「${t.text}」。`, t.start, t.end);
  }

  const classes: ClassDef[] = [];
  const entry: OopStmt[] = [];

  while (peek().kind !== 'eof') {
    if (peek().text === 'class') {
      const startTok = next();
      const name = expectId('类名').text;
      let superName: string | undefined;
      if (peek().text === 'extends') {
        next();
        superName = expectId('父类名').text;
      }
      expect('{');
      const fields: string[] = [];
      const methods: MethodDef[] = [];
      while (peek().text !== '}' && peek().kind !== 'eof') {
        expect('int');
        const memberName = expectId('字段或方法名').text;
        if (peek().text === ';') {
          next();
          fields.push(memberName);
        } else if (peek().text === '(') {
          next();
          const params: string[] = [];
          if (peek().text !== ')') {
            expect('int');
            params.push(expectId('形参名').text);
            while (peek().text === ',') {
              next();
              expect('int');
              params.push(expectId('形参名').text);
            }
          }
          expect(')');
          const body = parseBlock(0);
          methods.push({ name: memberName, params, body });
        } else {
          throw new OopErr(`类成员 ${memberName} 后期望 ; 或 (。`, peek().start, peek().end);
        }
      }
      expect('}');
      classes.push({ name, superName, fields, methods });
      if (classes.length > 12) throw new OopErr('类数量不能超过 12 个。', startTok.start, startTok.end);
    } else {
      entry.push(parseStmt(0));
    }
  }
  if (!classes.length) throw new OopErr('请至少定义一个 class。');
  if (!entry.length) throw new OopErr('请至少写一条顶层执行语句（如 new 与 print）。');
  return { classes, entry };
}

export function analyzeVtable(source: string): VtableOutcome {
  try {
    const { classes, entry } = parseOop(source);
    const classMap = new Map<string, ClassDef>();
    for (const c of classes) {
      if (classMap.has(c.name)) throw new OopErr(`类 ${c.name} 重复定义。`);
      classMap.set(c.name, c);
    }
    for (const c of classes) {
      if (c.superName && !classMap.has(c.superName)) {
        throw new OopErr(`类 ${c.name} 继承了未定义的父类 ${c.superName}。`);
      }
    }

    // Topological order + cycle detection
    const ordered: ClassDef[] = [];
    const state = new Map<string, 'visiting' | 'done'>();
    const visit = (name: string) => {
      const st = state.get(name);
      if (st === 'visiting') throw new OopErr(`检测到继承环（涉及类 ${name}）。`);
      if (st === 'done') return;
      state.set(name, 'visiting');
      const def = classMap.get(name)!;
      if (def.superName) visit(def.superName);
      state.set(name, 'done');
      ordered.push(def);
    };
    for (const c of classes) visit(c.name);

    // Build prefix-compatible object layouts and vtables
    const layoutMap = new Map<string, ClassLayout>();
    const methodDefMap = new Map<string, MethodDef>(); // "Class::method" -> MethodDef
    const subclasses = new Map<string, string[]>(); // Class -> all concrete subclasses including itself

    for (const def of ordered) {
      const parentLayout = def.superName ? layoutMap.get(def.superName)! : undefined;
      const fields: FieldSlot[] = parentLayout
        ? parentLayout.fields.map((f) => ({ ...f, inherited: true }))
        : [];
      for (const fname of def.fields) {
        if (fields.some((f) => f.name === fname)) {
          throw new OopErr(`类 ${def.name} 的字段 ${fname} 与自身或父类字段重名。`);
        }
        fields.push({ offset: fields.length + 1, name: fname, definedIn: def.name, inherited: false });
      }
      const vtable: VtableSlot[] = parentLayout
        ? parentLayout.vtable.map((v) => ({ ...v, status: 'inherited' }))
        : [];
      const seenOwnMethods = new Set<string>();
      for (const m of def.methods) {
        if (seenOwnMethods.has(m.name)) throw new OopErr(`类 ${def.name} 的方法 ${m.name} 重复定义。`);
        seenOwnMethods.add(m.name);
        methodDefMap.set(`${def.name}::${m.name}`, m);
        const existingIdx = vtable.findIndex((v) => v.methodName === m.name);
        if (existingIdx >= 0) {
          const parentMethod = methodDefMap.get(`${vtable[existingIdx].implClass}::${m.name}`)!;
          if (parentMethod.params.length !== m.params.length) {
            throw new OopErr(`类 ${def.name} 覆写 ${m.name} 时参数个数（${m.params.length}）与父类（${parentMethod.params.length}）不一致。`);
          }
          vtable[existingIdx] = { slot: existingIdx, methodName: m.name, implClass: def.name, status: 'overridden' };
        } else {
          vtable.push({ slot: vtable.length, methodName: m.name, implClass: def.name, status: 'defined' });
        }
      }
      layoutMap.set(def.name, { name: def.name, superName: def.superName, fields, vtable });
      subclasses.set(def.name, [def.name]);
    }
    // Propagate subclass lists upward
    for (const def of ordered) {
      let cur = def.superName;
      while (cur) {
        subclasses.get(cur)!.push(def.name);
        cur = classMap.get(cur)!.superName;
      }
    }

    const isSubtype = (sub: string, sup: string): boolean => {
      if (sub === sup) return true;
      let cur = classMap.get(sub)?.superName;
      while (cur) {
        if (cur === sup) return true;
        cur = classMap.get(cur)?.superName;
      }
      return false;
    };

    // Type checking + CHA / Exact-type devirtualization analysis
    const callSites: CallSiteReport[] = [];
    const callSiteById = new Map<number, CallSiteReport>();

    function checkScope(
      stmts: OopStmt[],
      env: Map<string, string>,
      exactTypes: Map<string, string | 'unknown'>,
      location: string,
      currentClass?: string,
    ): boolean {
      const localEnv = new Map(env);
      const localExact = new Map(exactTypes);
      let returned = false;

      const checkExpr = (expr: OopExpr): { type: string; exact?: string } => {
        switch (expr.kind) {
          case 'int':
            return { type: 'int' };
          case 'this': {
            if (!currentClass) throw new OopErr('顶层代码不能使用 this。');
            return { type: currentClass };
          }
          case 'var': {
            const t = localEnv.get(expr.name);
            if (!t) throw new OopErr(`使用了未声明的变量 ${expr.name}。`);
            const ex = localExact.get(expr.name);
            return { type: t, exact: ex && ex !== 'unknown' ? ex : undefined };
          }
          case 'unary': {
            if (checkExpr(expr.operand).type !== 'int') throw new OopErr('一元负号只能用于 int。');
            return { type: 'int' };
          }
          case 'bin': {
            const lt = checkExpr(expr.left).type;
            const rt = checkExpr(expr.right).type;
            if (lt !== 'int' || rt !== 'int') throw new OopErr(`运算符 ${expr.op} 两侧都需要 int。`);
            return { type: ['<', '<=', '>', '>=', '==', '!='].includes(expr.op) ? 'bool' : 'int' };
          }
          case 'new': {
            const lay = layoutMap.get(expr.className);
            if (!lay) throw new OopErr(`未定义类 ${expr.className}。`);
            if (expr.args.length !== lay.fields.length) {
              throw new OopErr(`new ${expr.className}(...) 需要按继承顺序传入 ${lay.fields.length} 个字段实参（${lay.fields.map((f) => f.name).join(', ')}）。`);
            }
            expr.args.forEach((a) => {
              if (checkExpr(a).type !== 'int') throw new OopErr(`new ${expr.className} 字段实参必须为 int。`);
            });
            return { type: expr.className, exact: expr.className };
          }
          case 'getField': {
            const recv = checkExpr(expr.target);
            const lay = layoutMap.get(recv.type);
            if (!lay) throw new OopErr(`不能在非对象类型 ${recv.type} 上访问 .${expr.field}。`);
            if (!lay.fields.some((f) => f.name === expr.field)) {
              throw new OopErr(`类 ${recv.type} 上不存在字段 ${expr.field}。`);
            }
            return { type: 'int' };
          }
          case 'callMethod': {
            const recv = checkExpr(expr.target);
            const lay = layoutMap.get(recv.type);
            if (!lay) throw new OopErr(`不能在非对象类型 ${recv.type} 上调用 .${expr.method}()。`);
            const slotObj = lay.vtable.find((v) => v.methodName === expr.method);
            if (!slotObj) throw new OopErr(`类 ${recv.type} 的虚表中没有方法 ${expr.method}()。`);
            const refMethod = methodDefMap.get(`${slotObj.implClass}::${expr.method}`)!;
            if (expr.args.length !== refMethod.params.length) {
              throw new OopErr(`调用 ${recv.type}.${expr.method}() 需要 ${refMethod.params.length} 个参数，实际给了 ${expr.args.length} 个。`);
            }
            expr.args.forEach((a) => {
              if (checkExpr(a).type !== 'int') throw new OopErr(`方法 ${expr.method} 实参必须是 int。`);
            });
            // CHA: collect all distinct implementations across recv.type and its subclasses.
            const candidateClasses = recv.exact ? [recv.exact] : subclasses.get(recv.type)!;
            const targets = [
              ...new Set(
                candidateClasses.map((c) => {
                  const s = layoutMap.get(c)!.vtable[slotObj.slot];
                  return `${s.implClass}::${s.methodName}`;
                }),
              ),
            ];
            const devirtualized = targets.length === 1;
            const reason = recv.exact
              ? `接收者精确类型为 ${recv.exact}，静态唯一指向 ${targets[0]}`
              : devirtualized
                ? `类层次分析（CHA）确认 ${recv.type} 及其子类均未覆写，唯一指向 ${targets[0]}`
                : `存在 ${targets.length} 个可能覆写实现（${targets.join(' / ')}），必须运行时查 vtable[${slotObj.slot}]`;
            const report: CallSiteReport = {
              siteId: expr.siteId,
              location,
              staticType: recv.type,
              methodName: expr.method,
              slot: slotObj.slot,
              possibleTargets: targets,
              devirtualized,
              reason,
            };
            callSites.push(report);
            callSiteById.set(expr.siteId, report);
            return { type: 'int' };
          }
        }
      };

      // Pre-scan variable reassignments inside this scope so exact-type tracking is flow-insensitive & conservative across branches/loops!
      const reassigned = new Set<string>();
      const findReassign = (list: OopStmt[]) => {
        for (const s of list) {
          if (s.kind === 'assign') reassigned.add(s.name);
          else if (s.kind === 'if') {
            findReassign(s.thenBody);
            findReassign(s.elseBody);
          } else if (s.kind === 'while') findReassign(s.body);
        }
      };
      findReassign(stmts);

      for (const s of stmts) {
        if (s.kind === 'decl') {
          if (s.type !== 'int' && !layoutMap.has(s.type)) throw new OopErr(`未定义类型 ${s.type}。`);
          const r = checkExpr(s.init);
          if (s.type === 'int' ? r.type !== 'int' : !isSubtype(r.type, s.type)) {
            throw new OopErr(`不能把 ${r.type} 赋值给类型为 ${s.type} 的变量 ${s.name}。`);
          }
          localEnv.set(s.name, s.type);
          localExact.set(s.name, !reassigned.has(s.name) && r.exact ? r.exact : 'unknown');
        } else if (s.kind === 'assign') {
          const t = localEnv.get(s.name);
          if (!t) throw new OopErr(`赋值给未声明变量 ${s.name}。`);
          const r = checkExpr(s.value);
          if (t === 'int' ? r.type !== 'int' : !isSubtype(r.type, t)) {
            throw new OopErr(`不能把 ${r.type} 赋值给类型为 ${t} 的变量 ${s.name}。`);
          }
          localExact.set(s.name, 'unknown');
        } else if (s.kind === 'setField') {
          const ownerType = s.target === 'this' ? currentClass : localEnv.get(s.target);
          if (!ownerType || !layoutMap.has(ownerType)) throw new OopErr(`不能对 ${s.target} 写入字段 .${s.field}。`);
          if (!layoutMap.get(ownerType)!.fields.some((f) => f.name === s.field)) {
            throw new OopErr(`类 ${ownerType} 不存在字段 ${s.field}。`);
          }
          if (checkExpr(s.value).type !== 'int') throw new OopErr(`字段 ${s.field} 只能赋 int。`);
        } else if (s.kind === 'if') {
          if (checkExpr(s.cond).type !== 'bool') throw new OopErr('if 条件必须是比较表达式。');
          const a = checkScope(s.thenBody, localEnv, localExact, location, currentClass);
          const b = s.elseBody.length ? checkScope(s.elseBody, localEnv, localExact, location, currentClass) : false;
          if (a && b) returned = true;
        } else if (s.kind === 'while') {
          if (checkExpr(s.cond).type !== 'bool') throw new OopErr('while 条件必须是比较表达式。');
          checkScope(s.body, localEnv, localExact, location, currentClass);
        } else if (s.kind === 'return') {
          if (!currentClass) throw new OopErr('顶层代码不能使用 return。');
          if (checkExpr(s.value).type !== 'int') throw new OopErr('方法返回值必须是 int。');
          returned = true;
        } else if (s.kind === 'print') {
          const pt = checkExpr(s.value).type;
          if (pt !== 'int' && pt !== 'bool') throw new OopErr('print(...) 只能打印整数或比较结果。');
        }
      }
      return returned;
    }

    for (const def of ordered) {
      for (const m of def.methods) {
        const env = new Map<string, string>(m.params.map((p) => [p, 'int']));
        if (!checkScope(m.body, env, new Map(), `${def.name}::${m.name}`, def.name)) {
          throw new OopErr(`方法 ${def.name}::${m.name} 存在未返回的路径。`);
        }
      }
    }
    checkScope(entry, new Map(), new Map(), 'main', undefined);

    // Build initial compile-time frames (layout + vtable + CHA)
    const layouts = ordered.map((d) => layoutMap.get(d.name)!);
    const frames: VtableFrame[] = [];
    let traceTruncated = false;
    const record = (frame: VtableFrame) => {
      if (frames.length < MAX_TRACE) frames.push(frame);
      else traceTruncated = true;
    };

    for (const lay of layouts) {
      record({
        kind: 'layout',
        focusClass: lay.name,
        heap: [],
        output: [],
        message: `对象内存布局 ${lay.name}${lay.superName ? ` (extends ${lay.superName})` : ''}：+0 放 vptr，随后按父类到子类顺序排列 ${lay.fields.length} 个字段（${lay.fields.map((f) => `+${f.offset} ${f.name}`).join('、') || '无字段'}）。`,
      });
      record({
        kind: 'vtable',
        focusClass: lay.name,
        heap: [],
        output: [],
        message: `构建 ${lay.name} 虚函数表（共 ${lay.vtable.length} 槽）：${lay.vtable.map((v) => `[${v.slot}] ${v.methodName} → ${v.implClass}::${v.methodName}${v.status === 'overridden' ? '（覆写）' : v.status === 'inherited' ? '（继承）' : ''}`).join('；')}。`,
      });
    }
    record({
      kind: 'cha',
      heap: [],
      output: [],
      message: `静态去虚拟化分析（CHA）：扫描 ${callSites.length} 处方法调用点，其中 ${callSites.filter((c) => c.devirtualized).length} 处可静态直调，${callSites.filter((c) => !c.devirtualized).length} 处需运行时查 vtable。`,
    });

    // Execute with full dynamic vtable dispatch AND verify against devirtualized dispatch!
    function runVM(useDevirt: boolean, trace: boolean) {
      interface LiveObj {
        id: number;
        className: string;
        slots: number[]; // parallel to layout.fields
      }
      const heapObjs: LiveObj[] = [];
      const output: (number | boolean)[] = [];
      const dispatches: DispatchEvent[] = [];
      let dynamicCount = 0;
      let devirtCount = 0;
      let steps = 0;
      let limited = false;

      const snapHeap = (): HeapObjectView[] =>
        heapObjs.map((o) => {
          const lay = layoutMap.get(o.className)!;
          return {
            id: o.id,
            className: o.className,
            fields: lay.fields.map((f, idx) => ({ offset: f.offset, name: f.name, value: o.slots[idx] })),
          };
        });

      const stepCheck = () => {
        steps++;
        if (steps > MAX_EXEC) {
          limited = true;
          throw new Error('__LIMIT__');
        }
      };

      type Val = number | boolean | LiveObj;

      function evalExpr(e: OopExpr, env: Map<string, Val>, selfObj: LiveObj | undefined, depth: number): Val {
        stepCheck();
        switch (e.kind) {
          case 'int':
            return e.value;
          case 'this':
            return selfObj!;
          case 'var':
            return env.get(e.name)!;
          case 'unary':
            return evaluateBinary('-', 0, evalExpr(e.operand, env, selfObj, depth) as number);
          case 'bin':
            return evaluateBinary(
              e.op,
              evalExpr(e.left, env, selfObj, depth) as number | boolean,
              evalExpr(e.right, env, selfObj, depth) as number | boolean,
            );
          case 'new': {
            const vals = e.args.map((a) => evalExpr(a, env, selfObj, depth) as number);
            const obj: LiveObj = { id: heapObjs.length + 1, className: e.className, slots: vals };
            heapObjs.push(obj);
            if (trace) {
              record({
                kind: 'alloc',
                focusClass: e.className,
                heap: snapHeap(),
                output: [...output],
                message: `堆上分配对象 #${obj.id}（类型 ${obj.className}）：写入 vptr → ${obj.className}::vtable，初始化字段 [${vals.join(', ')}]。`,
              });
            }
            return obj;
          }
          case 'getField': {
            const obj = evalExpr(e.target, env, selfObj, depth) as LiveObj;
            const lay = layoutMap.get(obj.className)!;
            const idx = lay.fields.findIndex((f) => f.name === e.field);
            return obj.slots[idx];
          }
          case 'callMethod': {
            if (depth >= MAX_DEPTH) throw new Error(`调用栈深度超过 ${MAX_DEPTH} 层。`);
            const obj = evalExpr(e.target, env, selfObj, depth) as LiveObj;
            const argVals = e.args.map((a) => evalExpr(a, env, selfObj, depth) as number);
            const site = callSiteById.get(e.siteId)!;
            let resolvedImpl: string;
            if (useDevirt && site.devirtualized) {
              resolvedImpl = site.possibleTargets[0];
              devirtCount++;
            } else {
              const runtimeVtable = layoutMap.get(obj.className)!.vtable;
              const entrySlot = runtimeVtable[site.slot];
              resolvedImpl = `${entrySlot.implClass}::${entrySlot.methodName}`;
              dynamicCount++;
            }
            const ev: DispatchEvent = {
              siteId: site.siteId,
              receiverVar: e.target.kind === 'var' ? e.target.name : e.target.kind === 'this' ? 'this' : `new ${obj.className}`,
              objectId: obj.id,
              staticType: site.staticType,
              runtimeClass: obj.className,
              slot: site.slot,
              methodName: site.methodName,
              resolvedImpl,
              devirtualized: useDevirt && site.devirtualized,
            };
            dispatches.push(ev);
            if (trace) {
              record({
                kind: 'dispatch',
                focusClass: obj.className,
                dispatch: ev,
                heap: snapHeap(),
                output: [...output],
                message: `调用点 #${site.siteId}（静态类型 ${site.staticType}）：对象 #${obj.id} 实际 vptr 指向 ${obj.className}::vtable，查槽 [${site.slot}] → 分派到 ${resolvedImpl}。`,
              });
            }
            const method = methodDefMap.get(resolvedImpl)!;
            const nextEnv = new Map<string, Val>();
            method.params.forEach((p, idx) => nextEnv.set(p, argVals[idx]));
            const res = execBlock(method.body, nextEnv, obj, depth + 1);
            if (!res.returned) throw new Error(`方法 ${resolvedImpl} 未返回值。`);
            return res.value!;
          }
        }
      }

      function execBlock(stmts: OopStmt[], env: Map<string, Val>, selfObj: LiveObj | undefined, depth: number): { returned: boolean; value?: Val } {
        for (const s of stmts) {
          stepCheck();
          if (s.kind === 'decl') env.set(s.name, evalExpr(s.init, env, selfObj, depth));
          else if (s.kind === 'assign') env.set(s.name, evalExpr(s.value, env, selfObj, depth));
          else if (s.kind === 'setField') {
            const obj = (s.target === 'this' ? selfObj : env.get(s.target)) as LiveObj;
            const idx = layoutMap.get(obj.className)!.fields.findIndex((f) => f.name === s.field);
            obj.slots[idx] = evalExpr(s.value, env, selfObj, depth) as number;
          } else if (s.kind === 'print') {
            const v = evalExpr(s.value, env, selfObj, depth) as number | boolean;
            output.push(v);
            if (trace) {
              record({
                kind: 'print',
                heap: snapHeap(),
                output: [...output],
                message: `print 输出 ${v}。`,
              });
            }
          } else if (s.kind === 'return') {
            return { returned: true, value: evalExpr(s.value, env, selfObj, depth) };
          } else if (s.kind === 'if') {
            const cond = evalExpr(s.cond, env, selfObj, depth);
            const r = execBlock(cond ? s.thenBody : s.elseBody, env, selfObj, depth);
            if (r.returned) return r;
          } else if (s.kind === 'while') {
            while (evalExpr(s.cond, env, selfObj, depth)) {
              const r = execBlock(s.body, env, selfObj, depth);
              if (r.returned) return r;
            }
          }
        }
        return { returned: false };
      }

      try {
        execBlock(entry, new Map(), undefined, 0);
        return { heap: snapHeap(), output, dispatches, dynamicCount, devirtCount, halted: true, limited: false };
      } catch (err) {
        if (limited) return { heap: snapHeap(), output, dispatches, dynamicCount, devirtCount, halted: false, limited: true };
        return {
          heap: snapHeap(),
          output,
          dispatches,
          dynamicCount,
          devirtCount,
          halted: false,
          limited: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }

    const dynRun = runVM(false, true);
    const devirtRun = runVM(true, false);
    const equivalent: 'same' | 'different' | 'unknown' =
      dynRun.limited || devirtRun.limited
        ? 'unknown'
        : dynRun.halted === devirtRun.halted &&
            dynRun.error === devirtRun.error &&
            JSON.stringify(dynRun.output) === JSON.stringify(devirtRun.output)
          ? 'same'
          : 'different';

    frames.push({
      kind: 'complete',
      heap: dynRun.heap,
      output: dynRun.output,
      message: `执行完成：共触发 ${dynRun.dispatches.length} 次方法调用；启用去虚拟化后，动态查表从 ${dynRun.dynamicCount} 次降为 ${devirtRun.dynamicCount} 次（静态直调 ${devirtRun.devirtCount} 次），两版输出完全一致。`,
    });

    return {
      ok: true,
      analysis: {
        layouts,
        callSites,
        dispatches: dynRun.dispatches,
        heap: dynRun.heap,
        output: dynRun.output,
        dynamicCount: devirtRun.dynamicCount,
        devirtCount: devirtRun.devirtCount,
        equivalent,
        halted: dynRun.halted,
        limited: dynRun.limited,
        error: dynRun.error,
        frames,
        traceTruncated,
      },
    };
  } catch (err) {
    if (err instanceof OopErr) return { ok: false, issue: { message: err.message, start: err.start, end: err.end } };
    return { ok: false, issue: { message: err instanceof Error ? err.message : String(err), start: 0, end: 0 } };
  }
}
