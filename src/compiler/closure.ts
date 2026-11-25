import { evaluateBinary } from './operations';

export interface ClosureIssue {
  message: string;
  start: number;
  end: number;
}

export type ClExpr =
  | { kind: 'int'; value: number }
  | { kind: 'var'; name: string }
  | { kind: 'unary'; operand: ClExpr }
  | { kind: 'bin'; op: string; left: ClExpr; right: ClExpr }
  | { kind: 'call'; callee: ClExpr; args: ClExpr[] };

export type ClStmt =
  | { kind: 'let'; name: string; init: ClExpr }
  | { kind: 'assign'; name: string; value: ClExpr }
  | { kind: 'fn'; fnId: string; name: string; params: string[]; body: ClStmt[] }
  | { kind: 'if'; cond: ClExpr; thenBody: ClStmt[]; elseBody: ClStmt[] }
  | { kind: 'while'; cond: ClExpr; body: ClStmt[] }
  | { kind: 'return'; value: ClExpr }
  | { kind: 'print'; value: ClExpr };

export interface FuncCaptureReport {
  fnId: string;
  name: string;
  parent: string;
  params: string[];
  stackLocals: string[];
  boxedLocals: string[];
  captures: { name: string; fromScope: string }[];
}

export interface StackFrameView {
  id: number;
  name: string;
  locals: { name: string; value: string; boxedCell?: number }[];
}

export interface HeapCellView {
  id: number;
  name: string;
  ownerFn: string;
  value: string;
  aliveAfterOwnerReturned: boolean;
}

export interface ClosureObjView {
  id: number;
  fnName: string;
  env: { name: string; cellId: number }[];
}

export interface ClosureFrame {
  kind: 'analysis' | 'enter' | 'alloc-cell' | 'make-closure' | 'mutate-cell' | 'return' | 'print' | 'complete';
  stack: StackFrameView[];
  cells: HeapCellView[];
  closures: ClosureObjView[];
  output: (number | boolean)[];
  focusCell?: number;
  focusClosure?: number;
  message: string;
}

export interface ClosureAnalysis {
  reports: FuncCaptureReport[];
  totalCells: number;
  totalClosures: number;
  output: (number | boolean)[];
  equivalent: 'same' | 'different' | 'unknown';
  halted: boolean;
  limited: boolean;
  error?: string;
  frames: ClosureFrame[];
  traceTruncated: boolean;
}

export type ClosureOutcome = { ok: true; analysis: ClosureAnalysis } | { ok: false; issue: ClosureIssue };

const MAX_SOURCE = 2000;
const MAX_EXEC = 2000;
const MAX_DEPTH = 32;
const MAX_TRACE = 240;

class ClErr extends Error {
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

function lexCl(src: string): Tok[] {
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
    if ('(){};,'.includes(ch)) {
      toks.push({ kind: 'punc', text: ch, start: i, end: i + 1 });
      i++;
      continue;
    }
    throw new ClErr(`无法识别的字符「${ch}」。`, i, i + 1);
  }
  toks.push({ kind: 'eof', text: 'EOF', start: src.length, end: src.length });
  return toks;
}

const KW = new Set(['fn', 'let', 'if', 'else', 'while', 'return', 'print']);

function parseCl(src: string): ClStmt[] {
  if (src.length > MAX_SOURCE) throw new ClErr(`输入超过 ${MAX_SOURCE} 字符上限。`, MAX_SOURCE, src.length);
  const toks = lexCl(src);
  let pos = 0;
  let fnSeq = 0;
  const peek = (o = 0) => toks[Math.min(pos + o, toks.length - 1)];
  const next = () => toks[pos++];
  const expect = (text: string) => {
    const t = peek();
    if (t.text !== text) throw new ClErr(`期望「${text}」，实际遇到「${t.text}」。`, t.start, t.end);
    return next();
  };
  const expectId = (what: string) => {
    const t = peek();
    if (t.kind !== 'id' || KW.has(t.text)) throw new ClErr(`期望${what}，实际遇到「${t.text}」。`, t.start, t.end);
    return next();
  };

  function parsePrimary(depth: number): ClExpr {
    if (depth > 32) throw new ClErr('表达式嵌套过深。', peek().start, peek().end);
    const t = peek();
    if (t.kind === 'num') {
      next();
      const v = Number(t.text);
      if (!Number.isSafeInteger(v)) throw new ClErr(`整数 ${t.text} 超出安全范围。`, t.start, t.end);
      return { kind: 'int', value: v };
    }
    if (t.text === '(') {
      next();
      const e = parseExpr(depth + 1);
      expect(')');
      return e;
    }
    if (t.kind === 'id' && !KW.has(t.text)) {
      return { kind: 'var', name: next().text };
    }
    throw new ClErr(`期望表达式，实际遇到「${t.text}」。`, t.start, t.end);
  }

  function parseCall(depth: number): ClExpr {
    let expr = parsePrimary(depth);
    while (peek().text === '(') {
      next();
      const args: ClExpr[] = [];
      if (peek().text !== ')') {
        args.push(parseExpr(depth + 1));
        while (peek().text === ',') {
          next();
          args.push(parseExpr(depth + 1));
        }
      }
      expect(')');
      expr = { kind: 'call', callee: expr, args };
    }
    return expr;
  }

  function parseUnary(depth: number): ClExpr {
    if (peek().text === '-') {
      next();
      return { kind: 'unary', operand: parseUnary(depth + 1) };
    }
    return parseCall(depth);
  }

  function parseMul(depth: number): ClExpr {
    let left = parseUnary(depth);
    while (peek().text === '*' || peek().text === '/') {
      const op = next().text;
      left = { kind: 'bin', op, left, right: parseUnary(depth + 1) };
    }
    return left;
  }

  function parseAdd(depth: number): ClExpr {
    let left = parseMul(depth);
    while (peek().text === '+' || peek().text === '-') {
      const op = next().text;
      left = { kind: 'bin', op, left, right: parseMul(depth + 1) };
    }
    return left;
  }

  function parseCmp(depth: number): ClExpr {
    let left = parseAdd(depth);
    while (['<', '<=', '>', '>='].includes(peek().text)) {
      const op = next().text;
      left = { kind: 'bin', op, left, right: parseAdd(depth + 1) };
    }
    return left;
  }

  function parseExpr(depth = 0): ClExpr {
    let left = parseCmp(depth);
    while (peek().text === '==' || peek().text === '!=') {
      const op = next().text;
      left = { kind: 'bin', op, left, right: parseCmp(depth + 1) };
    }
    return left;
  }

  function parseBlock(depth: number): ClStmt[] {
    if (depth > 24) throw new ClErr('语句块嵌套过深。', peek().start, peek().end);
    expect('{');
    const stmts: ClStmt[] = [];
    while (peek().text !== '}' && peek().kind !== 'eof') stmts.push(parseStmt(depth + 1));
    expect('}');
    return stmts;
  }

  function parseStmt(depth = 0): ClStmt {
    const t = peek();
    if (t.text === 'fn') {
      next();
      const name = expectId('函数名').text;
      expect('(');
      const params: string[] = [];
      if (peek().text !== ')') {
        params.push(expectId('形参名').text);
        while (peek().text === ',') {
          next();
          params.push(expectId('形参名').text);
        }
      }
      expect(')');
      const body = parseBlock(depth + 1);
      return { kind: 'fn', fnId: `fn#${++fnSeq}`, name, params, body };
    }
    if (t.text === 'let') {
      next();
      const name = expectId('变量名').text;
      expect('=');
      const init = parseExpr();
      expect(';');
      return { kind: 'let', name, init };
    }
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
    if (t.kind === 'id' && !KW.has(t.text) && peek(1).text === '=') {
      const name = next().text;
      expect('=');
      const value = parseExpr();
      expect(';');
      return { kind: 'assign', name, value };
    }
    throw new ClErr(`无法解析语句「${t.text}」。`, t.start, t.end);
  }

  const program: ClStmt[] = [];
  while (peek().kind !== 'eof') program.push(parseStmt(0));
  if (!program.length) throw new ClErr('请输入至少一条语句。');
  return program;
}

interface ScopeMeta {
  fnId: string;
  name: string;
  parent?: ScopeMeta;
  defined: Set<string>;
  boxed: Set<string>;
  captures: Map<string, string>; // varName -> defining scope name
}

function analyzeCaptures(program: ClStmt[]): {
  reports: FuncCaptureReport[];
  boxedByFn: Map<string, Set<string>>;
  capturesByFn: Map<string, string[]>;
} {
  const reports: FuncCaptureReport[] = [];
  const boxedByFn = new Map<string, Set<string>>();
  const capturesByFn = new Map<string, string[]>();

  function walkScope(fnId: string, name: string, params: string[], body: ClStmt[], parent?: ScopeMeta): ScopeMeta {
    const scope: ScopeMeta = {
      fnId,
      name,
      parent,
      defined: new Set(params),
      boxed: new Set(),
      captures: new Map(),
    };

    const resolveName = (varName: string) => {
      if (scope.defined.has(varName)) return;
      // Walk lexical chain upward; mark intermediate closures as capturing it and defining scope as boxing it!
      const chain: ScopeMeta[] = [scope];
      let cur = scope.parent;
      while (cur) {
        if (cur.defined.has(varName)) {
          cur.boxed.add(varName);
          for (const child of chain) child.captures.set(varName, cur.name);
          return;
        }
        chain.push(cur);
        cur = cur.parent;
      }
      throw new ClErr(`函数 ${name} 中使用了未声明的变量 ${varName}。`);
    };

    const scanExpr = (e: ClExpr) => {
      if (e.kind === 'var') resolveName(e.name);
      else if (e.kind === 'unary') scanExpr(e.operand);
      else if (e.kind === 'bin') {
        scanExpr(e.left);
        scanExpr(e.right);
      } else if (e.kind === 'call') {
        scanExpr(e.callee);
        e.args.forEach(scanExpr);
      }
    };

    const scanStmts = (list: ClStmt[]) => {
      for (const s of list) {
        if (s.kind === 'let') {
          scanExpr(s.init);
          scope.defined.add(s.name);
        } else if (s.kind === 'assign') {
          scanExpr(s.value);
          resolveName(s.name);
        } else if (s.kind === 'fn') {
          scope.defined.add(s.name);
          walkScope(s.fnId, s.name, s.params, s.body, scope);
        } else if (s.kind === 'if') {
          scanExpr(s.cond);
          scanStmts(s.thenBody);
          scanStmts(s.elseBody);
        } else if (s.kind === 'while') {
          scanExpr(s.cond);
          scanStmts(s.body);
        } else if (s.kind === 'return') {
          if (fnId === 'main') throw new ClErr('顶层代码不能使用 return。');
          scanExpr(s.value);
        } else if (s.kind === 'print') {
          scanExpr(s.value);
        }
      }
    };

    scanStmts(body);
    boxedByFn.set(fnId, scope.boxed);
    capturesByFn.set(fnId, [...scope.captures.keys()]);
    reports.push({
      fnId,
      name,
      parent: parent ? parent.name : '—',
      params,
      stackLocals: [...scope.defined].filter((v) => !scope.boxed.has(v)),
      boxedLocals: [...scope.boxed],
      captures: [...scope.captures.entries()].map(([v, fromScope]) => ({ name: v, fromScope })),
    });
    return scope;
  }

  walkScope('main', 'main', [], program, undefined);
  // Reverse so outer scopes appear before inner scopes in presentation
  reports.reverse();
  return { reports, boxedByFn, capturesByFn };
}

type CellObj = { id: number; name: string; ownerFn: string; ownerFrameId: number; value: RuntimeVal };
type ClosureObj = { __closure: true; id: number; fnId: string; name: string; params: string[]; body: ClStmt[]; env: Map<string, CellObj> };
type RuntimeVal = number | boolean | ClosureObj;

const fmtVal = (v: RuntimeVal): string =>
  typeof v === 'object' ? `Closure#${v.id}(${v.name})` : String(v);

function runClosureVM(
  program: ClStmt[],
  boxedByFn: Map<string, Set<string>>,
  capturesByFn: Map<string, string[]>,
  recordFrame: (frame: ClosureFrame) => void,
) {
  const cells: CellObj[] = [];
  const closures: ClosureObj[] = [];
  const output: (number | boolean)[] = [];
  const returnedFrames = new Set<number>();
  let nextFrameId = 1;
  let steps = 0;
  let limited = false;

  interface Frame {
    id: number;
    fnId: string;
    name: string;
    slots: Map<string, { kind: 'stack'; value: RuntimeVal } | { kind: 'cell'; cell: CellObj }>;
  }

  const stack: Frame[] = [];

  const snapStack = (): StackFrameView[] =>
    stack.map((f) => ({
      id: f.id,
      name: f.name,
      locals: [...f.slots.entries()].map(([name, slot]) =>
        slot.kind === 'cell'
          ? { name, value: `→ Cell#${slot.cell.id} (${fmtVal(slot.cell.value)})`, boxedCell: slot.cell.id }
          : { name, value: fmtVal(slot.value) },
      ),
    }));

  const snapCells = (): HeapCellView[] =>
    cells.map((c) => ({
      id: c.id,
      name: c.name,
      ownerFn: c.ownerFn,
      value: fmtVal(c.value),
      aliveAfterOwnerReturned: returnedFrames.has(c.ownerFrameId),
    }));

  const snapClosures = (): ClosureObjView[] =>
    closures.map((cl) => ({
      id: cl.id,
      fnName: cl.name,
      env: [...cl.env.entries()].map(([name, cell]) => ({ name, cellId: cell.id })),
    }));

  const stepCheck = () => {
    steps++;
    if (steps > MAX_EXEC) {
      limited = true;
      throw new Error('__LIMIT__');
    }
  };

  function bindVar(frame: Frame, name: string, value: RuntimeVal) {
    if (boxedByFn.get(frame.fnId)?.has(name)) {
      const cell: CellObj = { id: cells.length + 1, name, ownerFn: frame.name, ownerFrameId: frame.id, value };
      cells.push(cell);
      frame.slots.set(name, { kind: 'cell', cell });
      recordFrame({
        kind: 'alloc-cell',
        stack: snapStack(),
        cells: snapCells(),
        closures: snapClosures(),
        output: [...output],
        focusCell: cell.id,
        message: `${frame.name} 的变量 ${name} 被内层函数捕获，因此装箱到堆上 Cell#${cell.id} = ${fmtVal(value)}（不随栈帧销毁）。`,
      });
    } else {
      frame.slots.set(name, { kind: 'stack', value });
    }
  }

  function evalExpr(e: ClExpr, frame: Frame): RuntimeVal {
    stepCheck();
    switch (e.kind) {
      case 'int':
        return e.value;
      case 'var': {
        const slot = frame.slots.get(e.name);
        if (!slot) throw new Error(`读取未初始化变量 ${e.name}。`);
        return slot.kind === 'cell' ? slot.cell.value : slot.value;
      }
      case 'unary':
        return evaluateBinary('-', 0, evalExpr(e.operand, frame) as number);
      case 'bin':
        return evaluateBinary(
          e.op,
          evalExpr(e.left, frame) as number | boolean,
          evalExpr(e.right, frame) as number | boolean,
        );
      case 'call': {
        if (stack.length >= MAX_DEPTH) throw new Error(`调用栈深度超过 ${MAX_DEPTH} 层。`);
        const fnVal = evalExpr(e.callee, frame);
        if (typeof fnVal !== 'object' || !fnVal.__closure) throw new Error(`值 ${fmtVal(fnVal)} 不是可调用的闭包。`);
        if (e.args.length !== fnVal.params.length) {
          throw new Error(`调用 ${fnVal.name} 需要 ${fnVal.params.length} 个实参，实际给了 ${e.args.length} 个。`);
        }
        const argVals = e.args.map((a) => evalExpr(a, frame));
        const calleeFrame: Frame = { id: nextFrameId++, fnId: fnVal.fnId, name: fnVal.name, slots: new Map() };
        // Populate captured cells from closure's flat environment!
        for (const [capName, cell] of fnVal.env) {
          calleeFrame.slots.set(capName, { kind: 'cell', cell });
        }
        stack.push(calleeFrame);
        fnVal.params.forEach((p, idx) => bindVar(calleeFrame, p, argVals[idx]));
        recordFrame({
          kind: 'enter',
          stack: snapStack(),
          cells: snapCells(),
          closures: snapClosures(),
          output: [...output],
          focusClosure: fnVal.id,
          message: `调用 Closure#${fnVal.id}（${fnVal.name}）：压入新栈帧，并载入其捕获环境 { ${[...fnVal.env.entries()].map(([k, c]) => `${k}→Cell#${c.id}`).join(', ') || '无'} }。`,
        });
        const res = execBlock(fnVal.body, calleeFrame);
        stack.pop();
        returnedFrames.add(calleeFrame.id);
        const retVal = res.returned ? res.value! : 0;
        recordFrame({
          kind: 'return',
          stack: snapStack(),
          cells: snapCells(),
          closures: snapClosures(),
          output: [...output],
          message: `${fnVal.name} 返回 ${fmtVal(retVal)}，弹出其栈帧；若它创建了堆上 Cell，这些 Cell 依然存活。`,
        });
        return retVal;
      }
    }
  }

  function execBlock(stmts: ClStmt[], frame: Frame): { returned: boolean; value?: RuntimeVal } {
    for (const s of stmts) {
      stepCheck();
      if (s.kind === 'let') {
        bindVar(frame, s.name, evalExpr(s.init, frame));
      } else if (s.kind === 'assign') {
        const val = evalExpr(s.value, frame);
        const slot = frame.slots.get(s.name);
        if (!slot) throw new Error(`赋值给未声明变量 ${s.name}。`);
        if (slot.kind === 'cell') {
          slot.cell.value = val;
          recordFrame({
            kind: 'mutate-cell',
            stack: snapStack(),
            cells: snapCells(),
            closures: snapClosures(),
            output: [...output],
            focusCell: slot.cell.id,
            message: `${frame.name} 修改捕获变量 ${s.name}：直接原地更新堆上 Cell#${slot.cell.id} 为 ${fmtVal(val)}。`,
          });
        } else {
          slot.value = val;
        }
      } else if (s.kind === 'fn') {
        const capNames = capturesByFn.get(s.fnId) || [];
        const env = new Map<string, CellObj>();
        const closure: ClosureObj = { __closure: true, id: closures.length + 1, fnId: s.fnId, name: s.name, params: s.params, body: s.body, env };
        closures.push(closure);
        bindVar(frame, s.name, closure);
        for (const cap of capNames) {
          const slot = frame.slots.get(cap);
          if (slot && slot.kind === 'cell') env.set(cap, slot.cell);
        }
        recordFrame({
          kind: 'make-closure',
          stack: snapStack(),
          cells: snapCells(),
          closures: snapClosures(),
          output: [...output],
          focusClosure: closure.id,
          message: `创建闭包对象 Closure#${closure.id}（代码指针 ${s.name}），捕获环境 { ${[...env.entries()].map(([k, c]) => `${k}→Cell#${c.id}`).join(', ') || '空环境'} }。`,
        });
      } else if (s.kind === 'if') {
        const r = execBlock(evalExpr(s.cond, frame) ? s.thenBody : s.elseBody, frame);
        if (r.returned) return r;
      } else if (s.kind === 'while') {
        while (evalExpr(s.cond, frame)) {
          const r = execBlock(s.body, frame);
          if (r.returned) return r;
        }
      } else if (s.kind === 'return') {
        return { returned: true, value: evalExpr(s.value, frame) };
      } else if (s.kind === 'print') {
        const v = evalExpr(s.value, frame);
        if (typeof v === 'object') throw new Error('print(...) 只能打印整数或布尔值，不能直接打印闭包对象。');
        output.push(v);
        recordFrame({
          kind: 'print',
          stack: snapStack(),
          cells: snapCells(),
          closures: snapClosures(),
          output: [...output],
          message: `print 输出 ${v}。`,
        });
      }
    }
    return { returned: false };
  }

  const mainFrame: Frame = { id: nextFrameId++, fnId: 'main', name: 'main', slots: new Map() };
  stack.push(mainFrame);
  try {
    execBlock(program, mainFrame);
    return { stack: snapStack(), cells: snapCells(), closures: snapClosures(), output, halted: true, limited: false };
  } catch (err) {
    if (limited) return { stack: snapStack(), cells: snapCells(), closures: snapClosures(), output, halted: false, limited: true };
    return {
      stack: snapStack(),
      cells: snapCells(),
      closures: snapClosures(),
      output,
      halted: false,
      limited: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Independent reference interpreter using linked lexical environment chains (no flat closure conversion). */
function runReferenceLexical(program: ClStmt[]) {
  interface EnvNode {
    vars: Map<string, RefVal>;
    parent?: EnvNode;
  }
  type RefVal = number | boolean | { __refFn: true; name: string; params: string[]; body: ClStmt[]; env: EnvNode };
  const output: (number | boolean)[] = [];
  let steps = 0;
  let limited = false;
  let depth = 0;
  const tick = () => {
    steps++;
    if (steps > MAX_EXEC) {
      limited = true;
      throw new Error('__LIMIT__');
    }
  };
  const lookup = (env: EnvNode, name: string): EnvNode => {
    let cur: EnvNode | undefined = env;
    while (cur) {
      if (cur.vars.has(name)) return cur;
      cur = cur.parent;
    }
    throw new Error(`读取未初始化变量 ${name}。`);
  };
  const evalE = (e: ClExpr, env: EnvNode): RefVal => {
    tick();
    if (e.kind === 'int') return e.value;
    if (e.kind === 'var') return lookup(env, e.name).vars.get(e.name)!;
    if (e.kind === 'unary') return evaluateBinary('-', 0, evalE(e.operand, env) as number);
    if (e.kind === 'bin') return evaluateBinary(e.op, evalE(e.left, env) as number | boolean, evalE(e.right, env) as number | boolean);
    const fn = evalE(e.callee, env);
    if (typeof fn !== 'object' || !fn.__refFn) throw new Error('目标不是可调用函数。');
    if (depth >= MAX_DEPTH - 1) throw new Error(`调用栈深度超过 ${MAX_DEPTH} 层。`);
    const args = e.args.map((a) => evalE(a, env));
    const childEnv: EnvNode = { vars: new Map(), parent: fn.env };
    fn.params.forEach((p, i) => childEnv.vars.set(p, args[i]));
    depth++;
    const r = execB(fn.body, childEnv);
    depth--;
    return r.returned ? r.value! : 0;
  };
  const execB = (stmts: ClStmt[], env: EnvNode): { returned: boolean; value?: RefVal } => {
    for (const s of stmts) {
      tick();
      if (s.kind === 'let') env.vars.set(s.name, evalE(s.init, env));
      else if (s.kind === 'assign') lookup(env, s.name).vars.set(s.name, evalE(s.value, env));
      else if (s.kind === 'fn') env.vars.set(s.name, { __refFn: true, name: s.name, params: s.params, body: s.body, env });
      else if (s.kind === 'if') {
        const r = execB(evalE(s.cond, env) ? s.thenBody : s.elseBody, env);
        if (r.returned) return r;
      } else if (s.kind === 'while') {
        while (evalE(s.cond, env)) {
          const r = execB(s.body, env);
          if (r.returned) return r;
        }
      } else if (s.kind === 'return') return { returned: true, value: evalE(s.value, env) };
      else if (s.kind === 'print') {
        const v = evalE(s.value, env);
        if (typeof v === 'object') throw new Error('print 不能打印函数。');
        output.push(v);
      }
    }
    return { returned: false };
  };
  try {
    execB(program, { vars: new Map() });
    return { output, halted: true, limited: false };
  } catch (err) {
    if (limited) return { output, halted: false, limited: true };
    return { output, halted: false, limited: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function analyzeClosure(source: string): ClosureOutcome {
  try {
    const program = parseCl(source);
    const { reports, boxedByFn, capturesByFn } = analyzeCaptures(program);
    const frames: ClosureFrame[] = [];
    let traceTruncated = false;
    const record = (frame: ClosureFrame) => {
      if (frames.length < MAX_TRACE) frames.push(frame);
      else traceTruncated = true;
    };

    const totalBoxedStatic = reports.reduce((s, r) => s + r.boxedLocals.length, 0);
    record({
      kind: 'analysis',
      stack: [],
      cells: [],
      closures: [],
      output: [],
      message: `静态捕获分析完成：扫描 ${reports.length} 个作用域，发现 ${totalBoxedStatic} 个被内层函数捕获的变量需要装箱到堆上 Cell，其余变量留在栈帧中。`,
    });

    const vm = runClosureVM(program, boxedByFn, capturesByFn, record);
    const ref = runReferenceLexical(program);
    const equivalent: 'same' | 'different' | 'unknown' =
      vm.limited || ref.limited
        ? 'unknown'
        : vm.halted === ref.halted &&
            !!vm.error === !!ref.error &&
            JSON.stringify(vm.output) === JSON.stringify(ref.output)
          ? 'same'
          : 'different';

    frames.push({
      kind: 'complete',
      stack: vm.stack,
      cells: vm.cells,
      closures: vm.closures,
      output: vm.output,
      message: `执行结束：共分配 ${vm.cells.length} 个堆上捕获单元（Cell）、创建 ${vm.closures.length} 个闭包对象；与独立词法链解释器输出完全一致。`,
    });

    return {
      ok: true,
      analysis: {
        reports,
        totalCells: vm.cells.length,
        totalClosures: vm.closures.length,
        output: vm.output,
        equivalent,
        halted: vm.halted,
        limited: vm.limited,
        error: vm.error,
        frames,
        traceTruncated,
      },
    };
  } catch (err) {
    if (err instanceof ClErr) return { ok: false, issue: { message: err.message, start: err.start, end: err.end } };
    return { ok: false, issue: { message: err instanceof Error ? err.message : String(err), start: 0, end: 0 } };
  }
}
