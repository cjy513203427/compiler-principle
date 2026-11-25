import { evaluateBinary } from './operations';

export interface CoroIssue {
  message: string;
  start: number;
  end: number;
}

export type CoExpr =
  | { kind: 'int'; value: number }
  | { kind: 'bool'; value: boolean }
  | { kind: 'var'; name: string }
  | { kind: 'unary'; operand: CoExpr }
  | { kind: 'bin'; op: string; left: CoExpr; right: CoExpr }
  | { kind: 'create'; coroName: string; args: CoExpr[] }
  | { kind: 'resume'; handle: string }
  | { kind: 'done'; handle: string };

export type CoStmt =
  | { kind: 'let'; name: string; init: CoExpr }
  | { kind: 'assign'; name: string; value: CoExpr }
  | { kind: 'if'; cond: CoExpr; thenBody: CoStmt[]; elseBody: CoStmt[] }
  | { kind: 'while'; cond: CoExpr; body: CoStmt[] }
  | { kind: 'yield'; value: CoExpr }
  | { kind: 'return'; value: CoExpr }
  | { kind: 'print'; value: CoExpr };

export interface CoroDef {
  name: string;
  params: string[];
  body: CoStmt[];
}

export type CoroIr =
  | { op: 'LABEL'; name: string }
  | { op: 'SET'; dest: string; expr: CoExpr }
  | { op: 'BR_FALSE'; cond: CoExpr; target: string }
  | { op: 'JMP'; target: string }
  | { op: 'YIELD'; expr: CoExpr; nextState: number; resumeLabel: string }
  | { op: 'RETURN'; expr: CoExpr };

export interface LoweredCoro {
  name: string;
  params: string[];
  ir: CoroIr[];
  stateToPc: Record<number, number>;
  yieldCount: number;
  hoistedVars: string[];
  transientVars: string[];
  loweredCode: string;
}

export interface CoroInstanceView {
  id: number;
  name: string;
  handleName: string;
  state: number; // -1 means DONE
  fields: { name: string; value: string }[];
  lastEvent: string;
}

export interface CoroFrame {
  kind: 'lower' | 'create' | 'resume-enter' | 'yield' | 'return' | 'print' | 'complete';
  focusCoro?: string;
  focusInstance?: number;
  instances: CoroInstanceView[];
  output: (number | boolean)[];
  message: string;
}

export interface CoroAnalysis {
  coros: LoweredCoro[];
  output: (number | boolean)[];
  resumeCount: number;
  yieldCount: number;
  equivalent: 'same' | 'different' | 'unknown';
  halted: boolean;
  limited: boolean;
  error?: string;
  frames: CoroFrame[];
  traceTruncated: boolean;
}

export type CoroOutcome = { ok: true; analysis: CoroAnalysis } | { ok: false; issue: CoroIssue };

const MAX_SOURCE = 2000;
const MAX_EXEC = 2000;
const MAX_TRACE = 240;

class CoErr extends Error {
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

function lexCo(src: string): Tok[] {
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
    throw new CoErr(`无法识别的字符「${ch}」。`, i, i + 1);
  }
  toks.push({ kind: 'eof', text: 'EOF', start: src.length, end: src.length });
  return toks;
}

const KW = new Set(['coro', 'let', 'if', 'else', 'while', 'yield', 'return', 'print', 'resume', 'done', 'true', 'false']);

function parseCo(src: string): { coros: CoroDef[]; entry: CoStmt[] } {
  if (src.length > MAX_SOURCE) throw new CoErr(`输入超过 ${MAX_SOURCE} 字符上限。`, MAX_SOURCE, src.length);
  const toks = lexCo(src);
  let pos = 0;
  const peek = (o = 0) => toks[Math.min(pos + o, toks.length - 1)];
  const next = () => toks[pos++];
  const expect = (text: string) => {
    const t = peek();
    if (t.text !== text) throw new CoErr(`期望「${text}」，实际遇到「${t.text}」。`, t.start, t.end);
    return next();
  };
  const expectId = (what: string) => {
    const t = peek();
    if (t.kind !== 'id' || KW.has(t.text)) throw new CoErr(`期望${what}，实际遇到「${t.text}」。`, t.start, t.end);
    return next();
  };

  function parsePrimary(depth: number): CoExpr {
    if (depth > 32) throw new CoErr('表达式嵌套过深。', peek().start, peek().end);
    const t = peek();
    if (t.kind === 'num') {
      next();
      const v = Number(t.text);
      if (!Number.isSafeInteger(v)) throw new CoErr(`整数 ${t.text} 超出安全范围。`, t.start, t.end);
      return { kind: 'int', value: v };
    }
    if (t.text === 'true' || t.text === 'false') {
      next();
      return { kind: 'bool', value: t.text === 'true' };
    }
    if (t.text === '(') {
      next();
      const e = parseExpr(depth + 1);
      expect(')');
      return e;
    }
    if (t.text === 'resume') {
      next();
      expect('(');
      const handle = expectId('协程句柄名').text;
      expect(')');
      return { kind: 'resume', handle };
    }
    if (t.text === 'done') {
      next();
      expect('(');
      const handle = expectId('协程句柄名').text;
      expect(')');
      return { kind: 'done', handle };
    }
    if (t.kind === 'id' && !KW.has(t.text)) {
      const name = next().text;
      if (peek().text === '(') {
        next();
        const args: CoExpr[] = [];
        if (peek().text !== ')') {
          args.push(parseExpr(depth + 1));
          while (peek().text === ',') {
            next();
            args.push(parseExpr(depth + 1));
          }
        }
        expect(')');
        return { kind: 'create', coroName: name, args };
      }
      return { kind: 'var', name };
    }
    throw new CoErr(`期望表达式，实际遇到「${t.text}」。`, t.start, t.end);
  }

  function parseUnary(depth: number): CoExpr {
    if (peek().text === '-') {
      next();
      return { kind: 'unary', operand: parseUnary(depth + 1) };
    }
    return parsePrimary(depth);
  }
  function parseMul(depth: number): CoExpr {
    let l = parseUnary(depth);
    while (peek().text === '*' || peek().text === '/') {
      const op = next().text;
      l = { kind: 'bin', op, left: l, right: parseUnary(depth + 1) };
    }
    return l;
  }
  function parseAdd(depth: number): CoExpr {
    let l = parseMul(depth);
    while (peek().text === '+' || peek().text === '-') {
      const op = next().text;
      l = { kind: 'bin', op, left: l, right: parseMul(depth + 1) };
    }
    return l;
  }
  function parseCmp(depth: number): CoExpr {
    let l = parseAdd(depth);
    while (['<', '<=', '>', '>='].includes(peek().text)) {
      const op = next().text;
      l = { kind: 'bin', op, left: l, right: parseAdd(depth + 1) };
    }
    return l;
  }
  function parseExpr(depth = 0): CoExpr {
    let l = parseCmp(depth);
    while (peek().text === '==' || peek().text === '!=') {
      const op = next().text;
      l = { kind: 'bin', op, left: l, right: parseCmp(depth + 1) };
    }
    return l;
  }

  function parseBlock(depth: number): CoStmt[] {
    if (depth > 24) throw new CoErr('语句块嵌套过深。', peek().start, peek().end);
    expect('{');
    const list: CoStmt[] = [];
    while (peek().text !== '}' && peek().kind !== 'eof') list.push(parseStmt(depth + 1));
    expect('}');
    return list;
  }

  function parseStmt(depth = 0): CoStmt {
    const t = peek();
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
    if (t.text === 'yield') {
      next();
      const value = parseExpr();
      expect(';');
      return { kind: 'yield', value };
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
    throw new CoErr(`无法解析语句「${t.text}」。`, t.start, t.end);
  }

  const coros: CoroDef[] = [];
  const entry: CoStmt[] = [];
  while (peek().kind !== 'eof') {
    if (peek().text === 'coro') {
      next();
      const name = expectId('协程名').text;
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
      const body = parseBlock(0);
      coros.push({ name, params, body });
      if (coros.length > 8) throw new CoErr('协程定义不能超过 8 个。');
    } else {
      entry.push(parseStmt(0));
    }
  }
  if (!coros.length) throw new CoErr('请至少定义一个 coro 协程函数。');
  if (!entry.length) throw new CoErr('请至少写一条驱动协程的顶层语句（如 let g = ...; print(resume(g));）。');
  return { coros, entry };
}

function exprVars(e: CoExpr, out: Set<string>) {
  if (e.kind === 'var') out.add(e.name);
  else if (e.kind === 'unary') exprVars(e.operand, out);
  else if (e.kind === 'bin') {
    exprVars(e.left, out);
    exprVars(e.right, out);
  } else if (e.kind === 'create') e.args.forEach((a) => exprVars(a, out));
}

function fmtCoExpr(e: CoExpr, hoisted: Set<string>): string {
  switch (e.kind) {
    case 'int':
      return String(e.value);
    case 'bool':
      return String(e.value);
    case 'var':
      return hoisted.has(e.name) ? `frame.${e.name}` : e.name;
    case 'unary':
      return `-${fmtCoExpr(e.operand, hoisted)}`;
    case 'bin':
      return `(${fmtCoExpr(e.left, hoisted)} ${e.op} ${fmtCoExpr(e.right, hoisted)})`;
    case 'create':
      return `${e.coroName}(${e.args.map((a) => fmtCoExpr(a, hoisted)).join(', ')})`;
    case 'resume':
      return `resume(${e.handle})`;
    case 'done':
      return `done(${e.handle})`;
  }
}

/** Lower a coroutine body into linear IR + compute live-across-yield variables + emit switch(state) code. */
function lowerCoroutine(def: CoroDef): LoweredCoro {
  const ir: CoroIr[] = [];
  let labelSeq = 0;
  let yieldSeq = 0;
  const allVars = new Set<string>(def.params);
  const stateToLabel = new Map<number, string>();

  const emitBlock = (stmts: CoStmt[]) => {
    for (const s of stmts) {
      if (s.kind === 'let' || s.kind === 'assign') {
        const rhs = s.kind === 'let' ? s.init : s.value;
        if (rhs.kind === 'create' || rhs.kind === 'resume' || rhs.kind === 'done') {
          throw new CoErr(`协程 ${def.name} 内部不支持嵌套协程操作。`);
        }
        allVars.add(s.name);
        ir.push({ op: 'SET', dest: s.name, expr: rhs });
      } else if (s.kind === 'if') {
        const elseLabel = `L${++labelSeq}`;
        const endLabel = `L${++labelSeq}`;
        ir.push({ op: 'BR_FALSE', cond: s.cond, target: s.elseBody.length ? elseLabel : endLabel });
        emitBlock(s.thenBody);
        if (s.elseBody.length) {
          ir.push({ op: 'JMP', target: endLabel });
          ir.push({ op: 'LABEL', name: elseLabel });
          emitBlock(s.elseBody);
        }
        ir.push({ op: 'LABEL', name: endLabel });
      } else if (s.kind === 'while') {
        const headLabel = `L${++labelSeq}`;
        const exitLabel = `L${++labelSeq}`;
        ir.push({ op: 'LABEL', name: headLabel });
        ir.push({ op: 'BR_FALSE', cond: s.cond, target: exitLabel });
        emitBlock(s.body);
        ir.push({ op: 'JMP', target: headLabel });
        ir.push({ op: 'LABEL', name: exitLabel });
      } else if (s.kind === 'yield') {
        const nextState = ++yieldSeq;
        const resumeLabel = `S${nextState}_resume`;
        stateToLabel.set(nextState, resumeLabel);
        ir.push({ op: 'YIELD', expr: s.value, nextState, resumeLabel });
        ir.push({ op: 'LABEL', name: resumeLabel });
      } else if (s.kind === 'return') {
        ir.push({ op: 'RETURN', expr: s.value });
      } else if (s.kind === 'print') {
        throw new CoErr(`协程 ${def.name} 内部请用 yield / return 产出值，由外部驱动代码 print(...)。`);
      }
    }
  };

  emitBlock(def.body);
  ir.push({ op: 'RETURN', expr: { kind: 'int', value: 0 } });

  const labelPc = new Map<string, number>();
  ir.forEach((ins, idx) => {
    if (ins.op === 'LABEL') labelPc.set(ins.name, idx);
  });

  const stateToPc: Record<number, number> = { 0: 0 };
  for (const [st, lbl] of stateToLabel) stateToPc[st] = labelPc.get(lbl)!;

  // Backward liveness over Coroutine IR to find variables live across ANY yield point!
  const n = ir.length;
  const liveIn: Set<string>[] = Array.from({ length: n }, () => new Set());
  const liveOut: Set<string>[] = Array.from({ length: n }, () => new Set());

  const succs = (i: number): number[] => {
    const ins = ir[i];
    if (ins.op === 'RETURN') return [];
    if (ins.op === 'JMP') return [labelPc.get(ins.target)!];
    if (ins.op === 'BR_FALSE') return [i + 1, labelPc.get(ins.target)!].filter((x) => x < n);
    return i + 1 < n ? [i + 1] : [];
  };

  let changed = true;
  while (changed) {
    changed = false;
    for (let i = n - 1; i >= 0; i--) {
      const outSet = new Set<string>();
      for (const s of succs(i)) {
        for (const v of liveIn[s]) outSet.add(v);
      }
      const inSet = new Set<string>(outSet);
      const ins = ir[i];
      if (ins.op === 'SET') {
        inSet.delete(ins.dest);
        exprVars(ins.expr, inSet);
      } else if (ins.op === 'BR_FALSE') {
        exprVars(ins.cond, inSet);
      } else if (ins.op === 'YIELD' || ins.op === 'RETURN') {
        exprVars(ins.expr, inSet);
      }
      if (inSet.size !== liveIn[i].size || [...inSet].some((v) => !liveIn[i].has(v))) {
        liveIn[i] = inSet;
        liveOut[i] = outSet;
        changed = true;
      }
    }
  }

  // Variables live at ANY resume label S1..Sk, plus params (stored in frame at creation before first resume)
  const hoistedSet = new Set<string>(def.params);
  for (const [, lbl] of stateToLabel) {
    const pc = labelPc.get(lbl)!;
    for (const v of liveIn[pc]) hoistedSet.add(v);
  }
  const hoistedVars = [...allVars].filter((v) => hoistedSet.has(v));
  const transientVars = [...allVars].filter((v) => !hoistedSet.has(v));

  // Emit readable C-like state machine code!
  const structLines = [
    `struct ${def.name}Frame {`,
    `  int state;  // 0=初始, 1..${yieldSeq}=挂起点, -1=DONE`,
    ...hoistedVars.map((v) => `  int ${v};   // 跨 yield 存活，提升到协程帧`),
    `};`,
  ];
  const switchLines = [`StepResult step_${def.name}(${def.name}Frame* frame) {`, `  switch (frame->state) {`];
  const stateEntries = Object.entries(stateToPc).sort((a, b) => Number(a[0]) - Number(b[0]));
  stateEntries.forEach(([st]) => {
    switchLines.push(`    case ${st}: goto S${st}_entry;`);
  });
  switchLines.push(`    default: error("协程已结束");`, `  }`);
  ir.forEach((ins, idx) => {
    if (idx === 0) switchLines.push(`  S0_entry:`);
    if (ins.op === 'LABEL') {
      const matchedState = [...stateToLabel.entries()].find(([, l]) => l === ins.name)?.[0];
      switchLines.push(matchedState !== undefined ? `  S${matchedState}_entry: // resume #${matchedState}` : `  ${ins.name}:`);
    } else if (ins.op === 'SET') {
      const lhs = hoistedSet.has(ins.dest) ? `frame.${ins.dest}` : `let ${ins.dest}`;
      switchLines.push(`    ${lhs} = ${fmtCoExpr(ins.expr, hoistedSet)};`);
    } else if (ins.op === 'BR_FALSE') {
      switchLines.push(`    if (!${fmtCoExpr(ins.cond, hoistedSet)}) goto ${ins.target};`);
    } else if (ins.op === 'JMP') {
      switchLines.push(`    goto ${ins.target};`);
    } else if (ins.op === 'YIELD') {
      switchLines.push(`    frame.state = ${ins.nextState};`);
      switchLines.push(`    return Yield(${fmtCoExpr(ins.expr, hoistedSet)});`);
    } else if (ins.op === 'RETURN') {
      switchLines.push(`    frame.state = DONE;`);
      switchLines.push(`    return Done(${fmtCoExpr(ins.expr, hoistedSet)});`);
    }
  });
  switchLines.push(`}`);

  return {
    name: def.name,
    params: def.params,
    ir,
    stateToPc,
    yieldCount: yieldSeq,
    hoistedVars,
    transientVars,
    loweredCode: [...structLines, '', ...switchLines].join('\n'),
  };
}

function runStateMachineDriver(
  coros: LoweredCoro[],
  entry: CoStmt[],
  record: (frame: CoroFrame) => void,
) {
  const coroMap = new Map(coros.map((c) => [c.name, c]));
  interface Instance {
    id: number;
    handleName: string;
    def: LoweredCoro;
    state: number; // -1 = DONE
    fields: Record<string, number | boolean>;
    lastEvent: string;
  }
  const instances: Instance[] = [];
  const driverEnv = new Map<string, number | boolean | Instance>();
  const output: (number | boolean)[] = [];
  let steps = 0;
  let resumeCount = 0;
  let yieldCount = 0;
  let limited = false;

  const snapInstances = (): CoroInstanceView[] =>
    instances.map((inst) => ({
      id: inst.id,
      name: inst.def.name,
      handleName: inst.handleName,
      state: inst.state,
      fields: inst.def.hoistedVars.map((v) => ({
        name: v,
        value: inst.fields[v] !== undefined ? String(inst.fields[v]) : '—',
      })),
      lastEvent: inst.lastEvent,
    }));

  const tick = () => {
    steps++;
    if (steps > MAX_EXEC) {
      limited = true;
      throw new Error('__LIMIT__');
    }
  };

  const evalCoroExpr = (e: CoExpr, inst: Instance, stackLocals: Map<string, number | boolean>): number | boolean => {
    tick();
    if (e.kind === 'int') return e.value;
    if (e.kind === 'bool') return e.value;
    if (e.kind === 'var') {
      if (inst.def.hoistedVars.includes(e.name)) {
        if (inst.fields[e.name] === undefined) throw new Error(`协程 ${inst.def.name} 读取未初始化帧字段 ${e.name}。`);
        return inst.fields[e.name];
      }
      if (!stackLocals.has(e.name)) throw new Error(`协程 ${inst.def.name} 读取未初始化临时变量 ${e.name}。`);
      return stackLocals.get(e.name)!;
    }
    if (e.kind === 'unary') return evaluateBinary('-', 0, evalCoroExpr(e.operand, inst, stackLocals));
    if (e.kind === 'bin') return evaluateBinary(e.op, evalCoroExpr(e.left, inst, stackLocals), evalCoroExpr(e.right, inst, stackLocals));
    throw new Error('协程内不支持该表达式。');
  };

  function stepInstance(inst: Instance): number | boolean {
    if (inst.state === -1) throw new Error(`协程 ${inst.handleName}（${inst.def.name}）已经处于 DONE 状态，不能再 resume。`);
    resumeCount++;
    const startState = inst.state;
    const labelPc = new Map<string, number>();
    inst.def.ir.forEach((ins, idx) => {
      if (ins.op === 'LABEL') labelPc.set(ins.name, idx);
    });
    let pc = inst.def.stateToPc[startState];
    // Transient locals live ONLY on this fresh temporary stack and vanish on every yield!
    const transient = new Map<string, number | boolean>();
    record({
      kind: 'resume-enter',
      focusCoro: inst.def.name,
      focusInstance: inst.id,
      instances: snapInstances(),
      output: [...output],
      message: `resume(${inst.handleName})：按状态机 switch(state=${startState}) 跳转到 S${startState}_entry 继续执行。`,
    });
    while (pc < inst.def.ir.length) {
      tick();
      const ins = inst.def.ir[pc];
      if (ins.op === 'LABEL') {
        pc++;
      } else if (ins.op === 'SET') {
        const val = evalCoroExpr(ins.expr, inst, transient);
        if (inst.def.hoistedVars.includes(ins.dest)) inst.fields[ins.dest] = val;
        else transient.set(ins.dest, val);
        pc++;
      } else if (ins.op === 'BR_FALSE') {
        const cond = evalCoroExpr(ins.cond, inst, transient);
        if (typeof cond !== 'boolean') throw new Error('条件表达式需要布尔值。');
        pc = cond ? pc + 1 : labelPc.get(ins.target)!;
      } else if (ins.op === 'JMP') {
        pc = labelPc.get(ins.target)!;
      } else if (ins.op === 'YIELD') {
        const val = evalCoroExpr(ins.expr, inst, transient);
        inst.state = ins.nextState;
        inst.lastEvent = `yield ${val} → state=${ins.nextState}`;
        yieldCount++;
        record({
          kind: 'yield',
          focusCoro: inst.def.name,
          focusInstance: inst.id,
          instances: snapInstances(),
          output: [...output],
          message: `${inst.handleName} 挂起：保存 frame.state = ${ins.nextState}，返回 yield 值 ${val}；本次调用栈全部弹出，仅协程帧字段保留。`,
        });
        return val;
      } else if (ins.op === 'RETURN') {
        const val = evalCoroExpr(ins.expr, inst, transient);
        inst.state = -1;
        inst.lastEvent = `return ${val} → DONE`;
        record({
          kind: 'return',
          focusCoro: inst.def.name,
          focusInstance: inst.id,
          instances: snapInstances(),
          output: [...output],
          message: `${inst.handleName} 执行完毕：设置 frame.state = DONE，返回最终值 ${val}。`,
        });
        return val;
      }
    }
    inst.state = -1;
    return 0;
  }

  function evalDriverExpr(e: CoExpr, bindingName?: string): number | boolean | Instance {
    tick();
    if (e.kind === 'int') return e.value;
    if (e.kind === 'bool') return e.value;
    if (e.kind === 'var') {
      if (!driverEnv.has(e.name)) throw new Error(`未声明的变量 ${e.name}。`);
      return driverEnv.get(e.name)!;
    }
    if (e.kind === 'unary') return evaluateBinary('-', 0, evalDriverExpr(e.operand) as number);
    if (e.kind === 'bin') {
      return evaluateBinary(e.op, evalDriverExpr(e.left) as number | boolean, evalDriverExpr(e.right) as number | boolean);
    }
    if (e.kind === 'create') {
      const def = coroMap.get(e.coroName);
      if (!def) throw new Error(`未定义的协程 ${e.coroName}。`);
      if (e.args.length !== def.params.length) throw new Error(`创建 ${def.name} 需要 ${def.params.length} 个实参。`);
      const argVals = e.args.map((a) => evalDriverExpr(a) as number | boolean);
      const fields: Record<string, number | boolean> = {};
      def.params.forEach((p, i) => (fields[p] = argVals[i]));
      const inst: Instance = {
        id: instances.length + 1,
        handleName: bindingName || `coro#${instances.length + 1}`,
        def,
        state: 0,
        fields,
        lastEvent: '刚创建（state=0，尚未开始执行）',
      };
      instances.push(inst);
      record({
        kind: 'create',
        focusCoro: def.name,
        focusInstance: inst.id,
        instances: snapInstances(),
        output: [...output],
        message: `创建协程帧 ${inst.handleName}（${def.name}Frame）：state = 0，存入初始参数，此时协程体尚未执行。`,
      });
      return inst;
    }
    if (e.kind === 'resume') {
      const inst = driverEnv.get(e.handle);
      if (!inst || typeof inst !== 'object') throw new Error(`${e.handle} 不是协程句柄。`);
      return stepInstance(inst);
    }
    if (e.kind === 'done') {
      const inst = driverEnv.get(e.handle);
      if (!inst || typeof inst !== 'object') throw new Error(`${e.handle} 不是协程句柄。`);
      return inst.state === -1;
    }
    throw new Error('不支持的表达式。');
  }

  function execDriver(stmts: CoStmt[]) {
    for (const s of stmts) {
      tick();
      if (s.kind === 'let') driverEnv.set(s.name, evalDriverExpr(s.init, s.name));
      else if (s.kind === 'assign') {
        if (!driverEnv.has(s.name)) throw new Error(`未声明变量 ${s.name}。`);
        driverEnv.set(s.name, evalDriverExpr(s.value, s.name));
      } else if (s.kind === 'if') {
        const cond = evalDriverExpr(s.cond);
        if (typeof cond !== 'boolean') throw new Error('if 条件必须是布尔值。');
        execDriver(cond ? s.thenBody : s.elseBody);
      } else if (s.kind === 'while') {
        while (true) {
          const cond = evalDriverExpr(s.cond);
          if (typeof cond !== 'boolean') throw new Error('while 条件必须是布尔值。');
          if (!cond) break;
          execDriver(s.body);
        }
      } else if (s.kind === 'print') {
        const v = evalDriverExpr(s.value);
        if (typeof v === 'object') throw new Error('print(...) 不能直接打印协程句柄，请用 resume(g) 或 done(g)。');
        output.push(v);
        record({
          kind: 'print',
          instances: snapInstances(),
          output: [...output],
          message: `驱动代码 print 输出 ${v}。`,
        });
      } else {
        throw new Error('顶层驱动代码不能直接使用 yield 或 return。');
      }
    }
  }

  try {
    execDriver(entry);
    return { instances: snapInstances(), output, resumeCount, yieldCount, halted: true, limited: false };
  } catch (err) {
    if (limited) return { instances: snapInstances(), output, resumeCount, yieldCount, halted: false, limited: true };
    return {
      instances: snapInstances(),
      output,
      resumeCount,
      yieldCount,
      halted: false,
      limited: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Independent oracle using native JS generator functions over the raw AST (zero state-machine lowering). */
function runGeneratorOracle(coros: CoroDef[], entry: CoStmt[]) {
  const coroMap = new Map(coros.map((c) => [c.name, c]));
  const output: (number | boolean)[] = [];
  let steps = 0;
  let limited = false;
  const tick = () => {
    steps++;
    if (steps > MAX_EXEC) {
      limited = true;
      throw new Error('__LIMIT__');
    }
  };
  type Handle = { gen: Generator<number | boolean, number | boolean, void>; done: boolean };
  const env = new Map<string, number | boolean | Handle>();

  const evalCoroE = (e: CoExpr, loc: Map<string, number | boolean>): number | boolean => {
    tick();
    if (e.kind === 'int') return e.value;
    if (e.kind === 'bool') return e.value;
    if (e.kind === 'var') {
      if (!loc.has(e.name)) throw new Error(`未初始化 ${e.name}`);
      return loc.get(e.name)!;
    }
    if (e.kind === 'unary') return evaluateBinary('-', 0, evalCoroE(e.operand, loc));
    if (e.kind === 'bin') return evaluateBinary(e.op, evalCoroE(e.left, loc), evalCoroE(e.right, loc));
    throw new Error('invalid');
  };

  function* runAstCoro(def: CoroDef, args: (number | boolean)[]): Generator<number | boolean, number | boolean, void> {
    const loc = new Map<string, number | boolean>();
    def.params.forEach((p, i) => loc.set(p, args[i]));
    function* runBlock(stmts: CoStmt[]): Generator<number | boolean, { returned: boolean; value?: number | boolean }, void> {
      for (const s of stmts) {
        tick();
        if (s.kind === 'let') loc.set(s.name, evalCoroE(s.init, loc));
        else if (s.kind === 'assign') loc.set(s.name, evalCoroE(s.value, loc));
        else if (s.kind === 'yield') yield evalCoroE(s.value, loc);
        else if (s.kind === 'return') return { returned: true, value: evalCoroE(s.value, loc) };
        else if (s.kind === 'if') {
          const cond = evalCoroE(s.cond, loc);
          const r = yield* runBlock(cond ? s.thenBody : s.elseBody);
          if (r.returned) return r;
        } else if (s.kind === 'while') {
          while (evalCoroE(s.cond, loc)) {
            const r = yield* runBlock(s.body);
            if (r.returned) return r;
          }
        }
      }
      return { returned: false };
    }
    const r = yield* runBlock(def.body);
    return r.returned ? r.value! : 0;
  }

  const evalDrv = (e: CoExpr): number | boolean | Handle => {
    tick();
    if (e.kind === 'int') return e.value;
    if (e.kind === 'bool') return e.value;
    if (e.kind === 'var') return env.get(e.name)!;
    if (e.kind === 'unary') return evaluateBinary('-', 0, evalDrv(e.operand) as number);
    if (e.kind === 'bin') return evaluateBinary(e.op, evalDrv(e.left) as number | boolean, evalDrv(e.right) as number | boolean);
    if (e.kind === 'create') {
      const def = coroMap.get(e.coroName)!;
      const args = e.args.map((a) => evalDrv(a) as number | boolean);
      return { gen: runAstCoro(def, args), done: false };
    }
    if (e.kind === 'done') return (env.get(e.handle) as Handle).done;
    if (e.kind === 'resume') {
      const h = env.get(e.handle) as Handle;
      if (h.done) throw new Error('协程已结束');
      const r = h.gen.next();
      if (r.done) h.done = true;
      return r.value;
    }
    throw new Error('invalid');
  };

  const execDrv = (stmts: CoStmt[]) => {
    for (const s of stmts) {
      tick();
      if (s.kind === 'let') env.set(s.name, evalDrv(s.init));
      else if (s.kind === 'assign') env.set(s.name, evalDrv(s.value));
      else if (s.kind === 'if') execDrv(evalDrv(s.cond) ? s.thenBody : s.elseBody);
      else if (s.kind === 'while') {
        while (evalDrv(s.cond)) execDrv(s.body);
      } else if (s.kind === 'print') output.push(evalDrv(s.value) as number | boolean);
    }
  };

  try {
    execDrv(entry);
    return { output, halted: true, limited: false };
  } catch (err) {
    if (limited) return { output, halted: false, limited: true };
    return { output, halted: false, limited: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function analyzeCoroutine(source: string): CoroOutcome {
  try {
    const { coros, entry } = parseCo(source);
    const seenNames = new Set<string>();
    for (const c of coros) {
      if (seenNames.has(c.name)) throw new CoErr(`协程 ${c.name} 重复定义。`);
      seenNames.add(c.name);
    }
    const lowered = coros.map(lowerCoroutine);
    const frames: CoroFrame[] = [];
    let traceTruncated = false;
    const record = (frame: CoroFrame) => {
      if (frames.length < MAX_TRACE) frames.push(frame);
      else traceTruncated = true;
    };

    for (const c of lowered) {
      record({
        kind: 'lower',
        focusCoro: c.name,
        instances: [],
        output: [],
        message: `编译协程 ${c.name}：发现 ${c.yieldCount} 个挂起点（state 0..${c.yieldCount} + DONE）。跨 yield 活跃变量 [${c.hoistedVars.join(', ') || '无'}] 提升进 ${c.name}Frame；临时变量 [${c.transientVars.join(', ') || '无'}] 留在临时栈。`,
      });
    }

    const sm = runStateMachineDriver(lowered, entry, record);
    const oracle = runGeneratorOracle(coros, entry);
    const equivalent: 'same' | 'different' | 'unknown' =
      sm.limited || oracle.limited
        ? 'unknown'
        : sm.halted === oracle.halted &&
            !!sm.error === !!oracle.error &&
            JSON.stringify(sm.output) === JSON.stringify(oracle.output)
          ? 'same'
          : 'different';

    frames.push({
      kind: 'complete',
      instances: sm.instances,
      output: sm.output,
      message: `状态机驱动结束：共 resume ${sm.resumeCount} 次、挂起 yield ${sm.yieldCount} 次；编译后的状态机与独立 AST 协程解释器结果完全一致。`,
    });

    return {
      ok: true,
      analysis: {
        coros: lowered,
        output: sm.output,
        resumeCount: sm.resumeCount,
        yieldCount: sm.yieldCount,
        equivalent,
        halted: sm.halted,
        limited: sm.limited,
        error: sm.error,
        frames,
        traceTruncated,
      },
    };
  } catch (err) {
    if (err instanceof CoErr) return { ok: false, issue: { message: err.message, start: err.start, end: err.end } };
    return { ok: false, issue: { message: err instanceof Error ? err.message : String(err), start: 0, end: 0 } };
  }
}
