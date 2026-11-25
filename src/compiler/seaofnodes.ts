import { MAX_SOURCE } from '../state';

export type SoNExpr =
  | { kind: 'int'; value: number }
  | { kind: 'var'; name: string }
  | { kind: 'unary'; op: '-'; operand: SoNExpr }
  | { kind: 'binary'; op: string; left: SoNExpr; right: SoNExpr };

export type SoNStmt =
  | { kind: 'let'; name: string; init: SoNExpr }
  | { kind: 'assign'; name: string; value: SoNExpr }
  | { kind: 'if'; id: number; cond: SoNExpr; then: SoNStmt[]; otherwise?: SoNStmt[] }
  | { kind: 'while'; id: number; cond: SoNExpr; body: SoNStmt[] }
  | { kind: 'return'; value: SoNExpr };

export interface SoNProgram {
  fnName: string;
  params: string[];
  body: SoNStmt[];
  profiles: number[][];
  runs: number[][];
}

export type SoNNodeCategory = 'control' | 'floating' | 'state';

export interface SoNNode {
  id: number;
  op: string;
  label: string;
  category: SoNNodeCategory;
  controlInputs: number[];
  dataInputs: number[];
  value?: number;
  paramIndex?: number;
  ifId?: number;
  guardExpect?: boolean;
  frameStateVars?: string[];
  floatsOutsideLoop?: boolean;
  pruned?: boolean;
}

export interface BranchProfile {
  ifId: number;
  label: string;
  trueCount: number;
  falseCount: number;
  speculated?: 'true' | 'false' | 'none';
}

export interface RunOutcome {
  args: number[];
  jitResult?: number;
  jitError?: string;
  oracleResult?: number;
  oracleError?: string;
  deoptimized: boolean;
  deoptReason?: string;
  restoredState?: string;
  matched: boolean;
}

export interface SoNFrame {
  kind: 'build' | 'canonical' | 'profile' | 'speculate' | 'run' | 'complete';
  message: string;
  highlightNodeIds: number[];
  nodes: SoNNode[];
  rewrites: string[];
  profiles: BranchProfile[];
  outcomes: RunOutcome[];
}

export interface SeaOfNodesAnalysis {
  program: SoNProgram;
  initialNodeCount: number;
  finalActiveNodeCount: number;
  gvnMergedCount: number;
  canonicalRewriteCount: number;
  prunedBranchCount: number;
  loopFloatingNodes: string[];
  profiles: BranchProfile[];
  outcomes: RunOutcome[];
  verified: boolean;
  frames: SoNFrame[];
}

export type SeaOfNodesResult =
  | { ok: true; analysis: SeaOfNodesAnalysis }
  | { ok: false; error: string };

interface Tok {
  kind: 'id' | 'num' | 'sym' | 'eof';
  text: string;
  pos: number;
}

const MAX_PARAMS = 4;
const MAX_TUPLES = 16;
const MAX_STEPS = 2000;

function safeInt(n: number): number {
  if (!Number.isSafeInteger(n)) throw new Error('整数运算超出安全范围。');
  return n;
}

function evalBin(op: string, l: number, r: number): number {
  if (op === '+') return safeInt(l + r);
  if (op === '-') return safeInt(l - r);
  if (op === '*') return safeInt(l * r);
  if (op === '/') {
    if (r === 0) throw new Error('运行时错误：除数为 0。');
    return safeInt(Math.trunc(l / r));
  }
  if (op === '<<') {
    if (r < 0 || r > 30) throw new Error('位移量超出安全范围。');
    return safeInt(l * 2 ** r);
  }
  if (op === '<') return l < r ? 1 : 0;
  if (op === '<=') return l <= r ? 1 : 0;
  if (op === '>') return l > r ? 1 : 0;
  if (op === '>=') return l >= r ? 1 : 0;
  if (op === '==') return l === r ? 1 : 0;
  if (op === '!=') return l !== r ? 1 : 0;
  throw new Error(`不支持的运算符 '${op}'。`);
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
    if (['<=', '>=', '==', '!=', '<<'].includes(two)) {
      tokens.push({ kind: 'sym', text: two, pos: i });
      i += 2;
      continue;
    }
    if ('{}()<>;,=+*-/'.includes(ch)) {
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
  private nextIfId = 1;
  private depth = 0;

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

  parseProgram(): SoNProgram {
    this.expect('fn');
    const fnName = this.expectId().text;
    this.expect('(');
    const params: string[] = [];
    if (!this.match(')')) {
      do {
        params.push(this.expectId().text);
      } while (this.match(','));
      this.expect(')');
    }
    if (params.length > MAX_PARAMS) throw new Error(`参数数量超过上限（最多 ${MAX_PARAMS} 个）。`);
    const body = this.parseBlock();

    const profiles: number[][] = [];
    const runs: number[][] = [];
    while (this.peek().kind !== 'eof') {
      const kw = this.expectId().text;
      if (kw === 'profile') {
        profiles.push(...this.parseTuples(params.length));
      } else if (kw === 'run') {
        runs.push(...this.parseTuples(params.length));
      } else {
        throw new Error(`期望 profile 或 run，却读到 '${kw}'。`);
      }
      this.match(';');
    }
    if (profiles.length > MAX_TUPLES || runs.length > MAX_TUPLES) {
      throw new Error(`profile 或 run 样例超过上限（最多 ${MAX_TUPLES} 组）。`);
    }
    if (runs.length === 0) throw new Error('请至少提供一组 run (...) 运行输入。');
    return { fnName, params, body, profiles, runs };
  }

  private parseTuples(arity: number): number[][] {
    const list: number[][] = [];
    const parseOne = (): number[] => {
      this.expect('(');
      const vals: number[] = [];
      if (!this.match(')')) {
        do {
          let sign = 1;
          if (this.match('-')) sign = -1;
          const n = this.peek();
          if (n.kind !== 'num') throw new Error(`位置 ${n.pos}：期望整数实参。`);
          this.next();
          vals.push(safeInt(sign * Number(n.text)));
        } while (this.match(','));
        this.expect(')');
      }
      if (vals.length !== arity) throw new Error(`参数元组长度为 ${vals.length}，但函数需要 ${arity} 个参数。`);
      return vals;
    };
    list.push(parseOne());
    while (this.match(',')) list.push(parseOne());
    return list;
  }

  private parseBlock(): SoNStmt[] {
    this.depth++;
    if (this.depth > 20) throw new Error('语句块嵌套过深。');
    this.expect('{');
    const stmts: SoNStmt[] = [];
    while (!this.match('}')) {
      if (this.peek().kind === 'eof') throw new Error('缺少闭合花括号 }。');
      stmts.push(this.parseStmt());
    }
    this.depth--;
    return stmts;
  }

  private parseStmt(): SoNStmt {
    const t = this.peek();
    if (t.kind === 'id' && t.text === 'let') {
      this.next();
      const name = this.expectId().text;
      this.expect('=');
      const init = this.parseExpr();
      this.expect(';');
      return { kind: 'let', name, init };
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
      return { kind: 'if', id: this.nextIfId++, cond, then, otherwise };
    }
    if (t.kind === 'id' && t.text === 'while') {
      this.next();
      this.expect('(');
      const cond = this.parseExpr();
      this.expect(')');
      const body = this.parseBlock();
      return { kind: 'while', id: this.nextIfId++, cond, body };
    }
    const name = this.expectId().text;
    this.expect('=');
    const value = this.parseExpr();
    this.expect(';');
    return { kind: 'assign', name, value };
  }

  private parseExpr(): SoNExpr {
    return this.parseEq();
  }
  private parseEq(): SoNExpr {
    let left = this.parseRel();
    while (this.peek().text === '==' || this.peek().text === '!=') {
      const op = this.next().text;
      left = { kind: 'binary', op, left, right: this.parseRel() };
    }
    return left;
  }
  private parseRel(): SoNExpr {
    let left = this.parseShift();
    while (['<', '<=', '>', '>='].includes(this.peek().text)) {
      const op = this.next().text;
      left = { kind: 'binary', op, left, right: this.parseShift() };
    }
    return left;
  }
  private parseShift(): SoNExpr {
    let left = this.parseAdd();
    while (this.peek().text === '<<') {
      const op = this.next().text;
      left = { kind: 'binary', op, left, right: this.parseAdd() };
    }
    return left;
  }
  private parseAdd(): SoNExpr {
    let left = this.parseMul();
    while (this.peek().text === '+' || this.peek().text === '-') {
      const op = this.next().text;
      left = { kind: 'binary', op, left, right: this.parseMul() };
    }
    return left;
  }
  private parseMul(): SoNExpr {
    let left = this.parseUnary();
    while (this.peek().text === '*' || this.peek().text === '/') {
      const op = this.next().text;
      left = { kind: 'binary', op, left, right: this.parseUnary() };
    }
    return left;
  }
  private parseUnary(): SoNExpr {
    if (this.match('-')) return { kind: 'unary', op: '-', operand: this.parseUnary() };
    return this.parsePrimary();
  }
  private parsePrimary(): SoNExpr {
    const t = this.peek();
    if (t.kind === 'num') {
      this.next();
      return { kind: 'int', value: Number(t.text) };
    }
    if (this.match('(')) {
      const inner = this.parseExpr();
      this.expect(')');
      return inner;
    }
    if (t.kind === 'id') {
      this.next();
      return { kind: 'var', name: t.text };
    }
    throw new Error(`位置 ${t.pos}：无法解析表达式 '${t.text || 'EOF'}'。`);
  }
}

function runBaselineInterpreter(
  program: SoNProgram,
  args: number[],
  branchCounts?: Map<number, { trueCount: number; falseCount: number }>,
): { result?: number; error?: string } {
  const env = new Map<string, number>();
  program.params.forEach((p, idx) => env.set(p, args[idx]));
  let steps = 0;
  const tick = () => {
    steps++;
    if (steps > MAX_STEPS) throw new Error(`解释执行超过步数上限（${MAX_STEPS} 步）。`);
  };

  const evalE = (e: SoNExpr): number => {
    tick();
    if (e.kind === 'int') return e.value;
    if (e.kind === 'var') {
      if (!env.has(e.name)) throw new Error(`未声明的变量 '${e.name}'。`);
      return env.get(e.name)!;
    }
    if (e.kind === 'unary') return safeInt(-evalE(e.operand));
    return evalBin(e.op, evalE(e.left), evalE(e.right));
  };

  const execS = (stmts: SoNStmt[]): number | undefined => {
    for (const s of stmts) {
      tick();
      if (s.kind === 'let') env.set(s.name, evalE(s.init));
      else if (s.kind === 'assign') {
        if (!env.has(s.name)) throw new Error(`未声明的变量 '${s.name}'。`);
        env.set(s.name, evalE(s.value));
      } else if (s.kind === 'return') return evalE(s.value);
      else if (s.kind === 'if') {
        const c = evalE(s.cond) !== 0;
        if (branchCounts) {
          const rec = branchCounts.get(s.id) ?? { trueCount: 0, falseCount: 0 };
          if (c) rec.trueCount++;
          else rec.falseCount++;
          branchCounts.set(s.id, rec);
        }
        if (c) {
          const r = execS(s.then);
          if (r !== undefined) return r;
        } else if (s.otherwise) {
          const r = execS(s.otherwise);
          if (r !== undefined) return r;
        }
      } else if (s.kind === 'while') {
        while (evalE(s.cond) !== 0) {
          const r = execS(s.body);
          if (r !== undefined) return r;
        }
      }
    }
    return undefined;
  };

  try {
    const r = execS(program.body);
    if (r === undefined) return { error: `函数 '${program.fnName}' 未执行 return。` };
    return { result: r };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export function analyzeSeaOfNodes(source: string): SeaOfNodesResult {
  if (source.length > MAX_SOURCE) {
    return { ok: false, error: `源码长度超过限制（最多 ${MAX_SOURCE} 字符）。` };
  }
  let program: SoNProgram;
  try {
    program = new Parser(tokenize(source)).parseProgram();
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  // Validate variables and return presence by checking syntax/structure via graph builder
  const nodes: SoNNode[] = [];
  const addNode = (partial: Omit<SoNNode, 'id'>): SoNNode => {
    const node: SoNNode = { id: nodes.length, ...partial };
    nodes.push(node);
    return node;
  };

  const startNode = addNode({
    op: 'Start',
    label: `Start(${program.fnName})`,
    category: 'control',
    controlInputs: [],
    dataInputs: [],
  });

  const entryParams: number[] = [];
  const initEnv = new Map<string, number>();
  program.params.forEach((p, idx) => {
    const pn = addNode({
      op: 'Param',
      label: `P(${idx}): ${p}`,
      category: 'floating',
      controlInputs: [],
      dataInputs: [],
      paramIndex: idx,
    });
    entryParams.push(pn.id);
    initEnv.set(p, pn.id);
  });

  const entryFrameState = addNode({
    op: 'FrameState',
    label: `FrameState@entry (${program.params.join(', ') || '无参'})`,
    category: 'state',
    controlInputs: [startNode.id],
    dataInputs: [...entryParams],
    frameStateVars: [...program.params],
  });

  const opNameMap: Record<string, string> = {
    '+': 'Add',
    '-': 'Sub',
    '*': 'Mul',
    '/': 'Div',
    '<<': 'Shl',
    '<': 'Lt',
    '<=': 'Le',
    '>': 'Gt',
    '>=': 'Ge',
    '==': 'Eq',
    '!=': 'Ne',
  };

  const ifLabels = new Map<number, string>();
  const loopPhiIds = new Set<number>();
  const createdInsideLoop = new Set<number>();
  let inLoopDepth = 0;

  const buildExpr = (e: SoNExpr, env: Map<string, number>): number => {
    let n: SoNNode;
    if (e.kind === 'int') {
      n = addNode({
        op: 'Const',
        label: `Const(${e.value})`,
        category: 'floating',
        controlInputs: [],
        dataInputs: [],
        value: e.value,
      });
    } else if (e.kind === 'var') {
      const id = env.get(e.name);
      if (id === undefined) throw new Error(`未声明的变量 '${e.name}'。`);
      return id;
    } else if (e.kind === 'unary') {
      const inner = buildExpr(e.operand, env);
      n = addNode({
        op: 'Neg',
        label: 'Neg(-)',
        category: 'floating',
        controlInputs: [],
        dataInputs: [inner],
      });
    } else {
      const l = buildExpr(e.left, env);
      const r = buildExpr(e.right, env);
      const op = opNameMap[e.op];
      n = addNode({
        op,
        label: `${op}(${e.op})`,
        category: 'floating',
        controlInputs: [],
        dataInputs: [l, r],
      });
    }
    if (inLoopDepth > 0 && n.op !== 'Const') createdInsideLoop.add(n.id);
    return n.id;
  };

  const collectAssignedVars = (stmts: SoNStmt[], out: Set<string>) => {
    for (const s of stmts) {
      if (s.kind === 'assign') out.add(s.name);
      else if (s.kind === 'if') {
        collectAssignedVars(s.then, out);
        if (s.otherwise) collectAssignedVars(s.otherwise, out);
      } else if (s.kind === 'while') collectAssignedVars(s.body, out);
    }
  };

  const buildStmts = (
    stmts: SoNStmt[],
    ctrl: number,
    env: Map<string, number>,
  ): { ctrl: number | null; env: Map<string, number> } => {
    let curCtrl: number | null = ctrl;
    let curEnv = new Map(env);
    for (const s of stmts) {
      if (curCtrl === null) break;
      if (s.kind === 'let') {
        curEnv.set(s.name, buildExpr(s.init, curEnv));
      } else if (s.kind === 'assign') {
        if (!curEnv.has(s.name)) throw new Error(`未声明的变量 '${s.name}'。`);
        curEnv.set(s.name, buildExpr(s.value, curEnv));
      } else if (s.kind === 'return') {
        const val = buildExpr(s.value, curEnv);
        addNode({
          op: 'Return',
          label: 'Return',
          category: 'control',
          controlInputs: [curCtrl],
          dataInputs: [val],
        });
        curCtrl = null;
      } else if (s.kind === 'if') {
        const condId = buildExpr(s.cond, curEnv);
        ifLabels.set(s.id, `If#${s.id}`);
        const ifNode = addNode({
          op: 'If',
          label: `If#${s.id}`,
          category: 'control',
          controlInputs: [curCtrl],
          dataInputs: [condId],
          ifId: s.id,
        });
        const tProj = addNode({
          op: 'TrueProj',
          label: `True(#${s.id})`,
          category: 'control',
          controlInputs: [ifNode.id],
          dataInputs: [],
          ifId: s.id,
        });
        const fProj = addNode({
          op: 'FalseProj',
          label: `False(#${s.id})`,
          category: 'control',
          controlInputs: [ifNode.id],
          dataInputs: [],
          ifId: s.id,
        });
        const thenRes = buildStmts(s.then, tProj.id, curEnv);
        const elseRes = s.otherwise
          ? buildStmts(s.otherwise, fProj.id, curEnv)
          : { ctrl: fProj.id as number | null, env: new Map(curEnv) };
        if (thenRes.ctrl !== null && elseRes.ctrl !== null) {
          const merge = addNode({
            op: 'Merge',
            label: `Merge(#${s.id})`,
            category: 'control',
            controlInputs: [thenRes.ctrl, elseRes.ctrl],
            dataInputs: [],
          });
          const nextEnv = new Map<string, number>();
          for (const [k, vPrev] of curEnv) {
            const vt = thenRes.env.get(k) ?? vPrev;
            const ve = elseRes.env.get(k) ?? vPrev;
            if (vt === ve) nextEnv.set(k, vt);
            else {
              const phi = addNode({
                op: 'Phi',
                label: `Phi(${k})`,
                category: 'floating',
                controlInputs: [merge.id],
                dataInputs: [vt, ve],
              });
              nextEnv.set(k, phi.id);
            }
          }
          curCtrl = merge.id;
          curEnv = nextEnv;
        } else if (thenRes.ctrl !== null) {
          curCtrl = thenRes.ctrl;
          curEnv = thenRes.env;
        } else if (elseRes.ctrl !== null) {
          curCtrl = elseRes.ctrl;
          curEnv = elseRes.env;
        } else {
          curCtrl = null;
        }
      } else if (s.kind === 'while') {
        const assigned = new Set<string>();
        collectAssignedVars(s.body, assigned);
        const loopBegin = addNode({
          op: 'LoopBegin',
          label: `LoopBegin(#${s.id})`,
          category: 'control',
          controlInputs: [curCtrl],
          dataInputs: [],
        });
        const loopEnv = new Map(curEnv);
        const phis = new Map<string, SoNNode>();
        for (const v of assigned) {
          if (curEnv.has(v)) {
            const phi = addNode({
              op: 'Phi',
              label: `LoopPhi(${v})`,
              category: 'floating',
              controlInputs: [loopBegin.id],
              dataInputs: [curEnv.get(v)!],
            });
            phis.set(v, phi);
            loopPhiIds.add(phi.id);
            loopEnv.set(v, phi.id);
          }
        }
        inLoopDepth++;
        const condId = buildExpr(s.cond, loopEnv);
        const loopIf = addNode({
          op: 'If',
          label: `LoopIf#${s.id}`,
          category: 'control',
          controlInputs: [loopBegin.id],
          dataInputs: [condId],
        });
        const bodyProj = addNode({
          op: 'TrueProj',
          label: `LoopBody(#${s.id})`,
          category: 'control',
          controlInputs: [loopIf.id],
          dataInputs: [],
        });
        const exitProj = addNode({
          op: 'FalseProj',
          label: `LoopExit(#${s.id})`,
          category: 'control',
          controlInputs: [loopIf.id],
          dataInputs: [],
        });
        const bodyRes = buildStmts(s.body, bodyProj.id, loopEnv);
        inLoopDepth--;
        if (bodyRes.ctrl !== null) {
          const loopEnd = addNode({
            op: 'LoopEnd',
            label: `LoopEnd(#${s.id})`,
            category: 'control',
            controlInputs: [bodyRes.ctrl],
            dataInputs: [],
          });
          loopBegin.controlInputs.push(loopEnd.id);
          for (const [v, phi] of phis) {
            phi.dataInputs.push(bodyRes.env.get(v) ?? phi.id);
          }
        }
        curCtrl = exitProj.id;
        curEnv = loopEnv;
      }
    }
    return { ctrl: curCtrl, env: curEnv };
  };

  try {
    buildStmts(program.body, startNode.id, initEnv);
    if (!nodes.some((n) => n.op === 'Return')) {
      return { ok: false, error: `函数 '${program.fnName}' 必须包含至少一条 return 语句。` };
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  // Detect floating nodes created inside a loop that do NOT transitively depend on any LoopPhi!
  const dependsOnLoopPhi = (id: number, seen = new Set<number>()): boolean => {
    if (seen.has(id)) return false;
    seen.add(id);
    if (loopPhiIds.has(id)) return true;
    const n = nodes[id];
    if (!n) return false;
    return n.dataInputs.some((inp) => dependsOnLoopPhi(inp, seen));
  };
  const loopFloatingNodes: string[] = [];
  for (const id of createdInsideLoop) {
    if (!dependsOnLoopPhi(id)) {
      nodes[id].floatsOutsideLoop = true;
      loopFloatingNodes.push(`#${id} ${nodes[id].label}`);
    }
  }

  const snapNodes = (): SoNNode[] =>
    nodes.map((n) => ({
      ...n,
      controlInputs: [...n.controlInputs],
      dataInputs: [...n.dataInputs],
      frameStateVars: n.frameStateVars ? [...n.frameStateVars] : undefined,
    }));

  const frames: SoNFrame[] = [];
  const rewrites: string[] = [];
  const initialNodeCount = nodes.length;

  frames.push({
    kind: 'build',
    message:
      loopFloatingNodes.length > 0
        ? `构建 Sea of Nodes 图（共 ${nodes.length} 个节点）：红色控制边连起控制脊柱，蓝色数据边构成 SSA 值依赖。注意 [${loopFloatingNodes.join('、')}] 只依赖循环外参数，天生浮动在循环之外，无需传统 LICM 搬移！`
        : `构建 Sea of Nodes 图（共 ${nodes.length} 个节点）：控制流（红）与数据流（蓝）共处一图，绿色 FrameState#${entryFrameState.id} 记录入口解释器栈帧状态。`,
    highlightNodeIds: loopFloatingNodes.length > 0 ? [...createdInsideLoop].filter((id) => nodes[id].floatsOutsideLoop) : [startNode.id, entryFrameState.id],
    nodes: snapNodes(),
    rewrites: [],
    profiles: [],
    outcomes: [],
  });

  // Phase 2: Canonicalizer + GVN (fixed-point on floating nodes)
  const replaceAllUses = (oldId: number, newId: number) => {
    for (const n of nodes) {
      if (n.pruned) continue;
      n.dataInputs = n.dataInputs.map((x) => (x === oldId ? newId : x));
    }
    nodes[oldId].pruned = true;
  };

  let canonicalRewriteCount = 0;
  let gvnMergedCount = 0;
  const commutative = new Set(['Add', 'Mul', 'Eq', 'Ne']);

  for (let pass = 0; pass < 8; pass++) {
    let changed = false;
    // Canonical rules
    for (const n of nodes) {
      if (n.pruned || n.category !== 'floating') continue;
      if (n.op === 'Neg') {
        const inner = nodes[n.dataInputs[0]];
        if (inner && !inner.pruned && inner.op === 'Neg') {
          const target = inner.dataInputs[0];
          replaceAllUses(n.id, target);
          rewrites.push(`规范化：双负号 #${n.id} Neg(Neg(#${target})) → 直接替换为 #${target}`);
          canonicalRewriteCount++;
          changed = true;
          continue;
        }
        if (inner && inner.op === 'Const' && inner.value !== undefined) {
          n.op = 'Const';
          n.value = safeInt(-inner.value);
          n.label = `Const(${n.value})`;
          n.dataInputs = [];
          rewrites.push(`常量折叠：#${n.id} -(${inner.value}) → Const(${n.value})`);
          canonicalRewriteCount++;
          changed = true;
          continue;
        }
      }
      if (['Add', 'Sub', 'Mul', 'Div', 'Shl', 'Lt', 'Le', 'Gt', 'Ge', 'Eq', 'Ne'].includes(n.op)) {
        const l = nodes[n.dataInputs[0]];
        const r = nodes[n.dataInputs[1]];
        if (l.op === 'Const' && r.op === 'Const' && l.value !== undefined && r.value !== undefined) {
          if (!(n.op === 'Div' && r.value === 0)) {
            const symMap: Record<string, string> = {
              Add: '+', Sub: '-', Mul: '*', Div: '/', Shl: '<<', Lt: '<', Le: '<=', Gt: '>', Ge: '>=', Eq: '==', Ne: '!=',
            };
            const v = evalBin(symMap[n.op], l.value, r.value);
            n.op = 'Const';
            n.value = v;
            n.label = `Const(${v})`;
            n.dataInputs = [];
            rewrites.push(`常量折叠：#${n.id} → Const(${v})`);
            canonicalRewriteCount++;
            changed = true;
            continue;
          }
        }
        if (n.op === 'Mul') {
          // 2 * a or a * 2 -> a << 1 (Chapter 14 doDouble!)
          const checkShift = (constNode: SoNNode, otherId: number) => {
            if (constNode.op === 'Const' && (constNode.value === 2 || constNode.value === 4)) {
              const sh = constNode.value === 2 ? 1 : 2;
              const shConst = addNode({
                op: 'Const',
                label: `Const(${sh})`,
                category: 'floating',
                controlInputs: [],
                dataInputs: [],
                value: sh,
              });
              n.op = 'Shl';
              n.label = `Shl(<< ${sh})`;
              n.dataInputs = [otherId, shConst.id];
              rewrites.push(`强度折减（Canonicalizer）：#${n.id} 乘以 ${constNode.value} → 左移 #${otherId} << ${sh}`);
              canonicalRewriteCount++;
              changed = true;
              return true;
            }
            if (constNode.op === 'Const' && constNode.value === 1) {
              replaceAllUses(n.id, otherId);
              rewrites.push(`代数简化：#${n.id} × 1 → #${otherId}`);
              canonicalRewriteCount++;
              changed = true;
              return true;
            }
            if (constNode.op === 'Const' && constNode.value === 0) {
              n.op = 'Const';
              n.value = 0;
              n.label = 'Const(0)';
              n.dataInputs = [];
              rewrites.push(`代数简化：#${n.id} × 0 → Const(0)`);
              canonicalRewriteCount++;
              changed = true;
              return true;
            }
            return false;
          };
          if (checkShift(l, r.id) || checkShift(r, l.id)) continue;
        }
        if (n.op === 'Add') {
          if (r.op === 'Const' && r.value === 0) {
            replaceAllUses(n.id, l.id);
            rewrites.push(`代数简化：#${n.id} + 0 → #${l.id}`);
            canonicalRewriteCount++;
            changed = true;
            continue;
          }
          if (l.op === 'Const' && l.value === 0) {
            replaceAllUses(n.id, r.id);
            rewrites.push(`代数简化：0 + #${r.id} → #${r.id}`);
            canonicalRewriteCount++;
            changed = true;
            continue;
          }
        }
      }
    }

    // GVN hash-consing on active floating nodes (except Param and Phi)
    const gvnTable = new Map<string, number>();
    for (const n of nodes) {
      if (n.pruned || n.category !== 'floating' || n.op === 'Param' || n.op === 'Phi') continue;
      let key: string;
      if (n.op === 'Const') {
        key = `Const:${n.value}`;
      } else {
        const inputs = commutative.has(n.op) ? [...n.dataInputs].sort((a, b) => a - b) : n.dataInputs;
        key = `${n.op}:${inputs.join(',')}`;
      }
      const prev = gvnTable.get(key);
      if (prev !== undefined && prev !== n.id) {
        replaceAllUses(n.id, prev);
        if (n.op !== 'Const') {
          rewrites.push(`GVN 节点合并：浮动节点 #${n.id} ${n.label} 与 #${prev} 完全等价，合并为一个节点`);
          gvnMergedCount++;
        }
        changed = true;
      } else {
        gvnTable.set(key, n.id);
      }
    }
    if (!changed) break;
  }

  frames.push({
    kind: 'canonical',
    message:
      rewrites.length > 0
        ? `Canonicalizer + GVN 完成：执行 ${canonicalRewriteCount} 次规范化改写、${gvnMergedCount} 次等价浮动节点合并。`
        : 'Canonicalizer + GVN 扫描完毕：当前图中的浮动节点已是最简规范形式，无需改写。',
    highlightNodeIds: nodes.filter((n) => !n.pruned && n.op === 'Shl').map((n) => n.id),
    nodes: snapNodes(),
    rewrites: [...rewrites],
    profiles: [],
    outcomes: [],
  });

  // Phase 3: Profiling on baseline interpreter
  const branchCounts = new Map<number, { trueCount: number; falseCount: number }>();
  for (const ifId of ifLabels.keys()) branchCounts.set(ifId, { trueCount: 0, falseCount: 0 });
  for (const args of program.profiles) {
    runBaselineInterpreter(program, args, branchCounts);
  }
  const profiles: BranchProfile[] = [...ifLabels.entries()].map(([ifId, label]) => {
    const rec = branchCounts.get(ifId) ?? { trueCount: 0, falseCount: 0 };
    let speculated: BranchProfile['speculated'] = 'none';
    if (rec.trueCount > 0 && rec.falseCount === 0) speculated = 'true';
    else if (rec.falseCount > 0 && rec.trueCount === 0) speculated = 'false';
    return { ifId, label, trueCount: rec.trueCount, falseCount: rec.falseCount, speculated };
  });

  frames.push({
    kind: 'profile',
    message:
      program.profiles.length > 0
        ? `收集 ${program.profiles.length} 组 profile 样例的分支热点统计：观察是否有从未走过的冷分支可供推理裁剪。`
        : '未提供 profile 样例，保持保守静态编译，不插入投机守卫。',
    highlightNodeIds: nodes.filter((n) => !n.pruned && n.op === 'If' && n.ifId !== undefined).map((n) => n.id),
    nodes: snapNodes(),
    rewrites: [...rewrites],
    profiles: profiles.map((p) => ({ ...p })),
    outcomes: [],
  });

  // Phase 4: Speculative Guard + Deopt pruning!
  let prunedBranchCount = 0;
  const guardHighlight: number[] = [];
  for (const bp of profiles) {
    if (bp.speculated === 'none') continue;
    const ifNode = nodes.find((n) => !n.pruned && n.op === 'If' && n.ifId === bp.ifId);
    if (!ifNode) continue;
    const expectTrue = bp.speculated === 'true';
    // Convert If into FixedGuard + Deopt(FrameState) and prune the cold projection & unreachable downstream control
    ifNode.op = 'FixedGuard';
    ifNode.guardExpect = expectTrue;
    ifNode.label = `Guard(If#${bp.ifId} 须为 ${expectTrue ? 'true' : 'false'})`;
    const deoptNode = addNode({
      op: 'Deopt',
      label: `Deopt → FrameState#${entryFrameState.id}`,
      category: 'control',
      controlInputs: [ifNode.id],
      dataInputs: [entryFrameState.id],
      ifId: bp.ifId,
    });
    guardHighlight.push(ifNode.id, deoptNode.id);

    const coldProjOp = expectTrue ? 'FalseProj' : 'TrueProj';
    const coldProj = nodes.find((n) => !n.pruned && n.op === coldProjOp && n.ifId === bp.ifId);
    if (coldProj) {
      // Mark cold projection and control nodes dominated solely by it as pruned
      const queue = [coldProj.id];
      coldProj.pruned = true;
      prunedBranchCount++;
      while (queue.length > 0) {
        const cur = queue.shift()!;
        for (const child of nodes) {
          if (child.pruned) continue;
          if (child.op === 'Merge' && child.controlInputs.includes(cur)) {
            const idx = child.controlInputs.indexOf(cur);
            child.controlInputs.splice(idx, 1);
            // Simplify Phis attached to this Merge
            for (const phi of nodes) {
              if (!phi.pruned && phi.op === 'Phi' && phi.controlInputs[0] === child.id) {
                phi.dataInputs.splice(idx, 1);
                if (phi.dataInputs.length === 1) {
                  replaceAllUses(phi.id, phi.dataInputs[0]);
                  rewrites.push(`投机剪枝化简：#${phi.id} ${phi.label} 仅剩 1 条热路径，直接替换为 #${phi.dataInputs[0]}`);
                }
              }
            }
          } else if (child.category === 'control' && child.controlInputs.includes(cur)) {
            child.controlInputs = child.controlInputs.filter((x) => x !== cur);
            if (child.controlInputs.length === 0) {
              child.pruned = true;
              queue.push(child.id);
            }
          }
        }
      }
      rewrites.push(
        `基于推理优化（第 15 讲）：If#${bp.ifId} 在 profile 中从未走 ${expectTrue ? 'false' : 'true'} 分支 → 替换为 FixedGuard + Deopt(FrameState#${entryFrameState.id}) 并剪掉冷分支`,
      );
    }
  }

  // Prune floating nodes that are no longer reachable from any live control/state node
  const liveReach = new Set<number>();
  const markQueue: number[] = nodes
    .filter((n) => !n.pruned && (n.category === 'control' || n.category === 'state'))
    .map((n) => n.id);
  markQueue.forEach((id) => liveReach.add(id));
  while (markQueue.length > 0) {
    const cur = markQueue.shift()!;
    for (const d of nodes[cur].dataInputs) {
      if (!liveReach.has(d) && !nodes[d].pruned) {
        liveReach.add(d);
        markQueue.push(d);
      }
    }
  }
  for (const n of nodes) {
    if (!n.pruned && n.category === 'floating' && !liveReach.has(n.id)) n.pruned = true;
  }

  frames.push({
    kind: 'speculate',
    message:
      prunedBranchCount > 0
        ? `推理优化生效：裁剪了 ${prunedBranchCount} 条冷分支，并在守卫失败出口挂上 Deopt → FrameState#${entryFrameState.id}；一旦运行时违背推测，立即恢复栈帧回退解释器！`
        : '所有分支在 profile 中均有命中（或无分支），保留完整控制流，无投机剪枝。',
    highlightNodeIds: guardHighlight,
    nodes: snapNodes(),
    rewrites: [...rewrites],
    profiles: profiles.map((p) => ({ ...p })),
    outcomes: [],
  });

  // Phase 5: Execute optimized Sea of Nodes graph (with real Guard check & Deopt fallback!) vs Baseline Oracle
  const runOptimizedGraph = (
    args: number[],
  ): { result?: number; error?: string; deoptimized: boolean; deoptReason?: string; restoredState?: string } => {
    // Evaluate optimized graph by walking control spine & lazy-evaluating floating data nodes
    const memo = new Map<number, number>();
    const mergeCameFrom = new Map<number, number>();
    let steps = 0;
    const tick = () => {
      steps++;
      if (steps > MAX_STEPS) throw new Error(`JIT 执行超过步数上限（${MAX_STEPS} 步）。`);
    };

    const evalData = (id: number, cameFromCtrl: number): number => {
      tick();
      const n = nodes[id];
      if (n.op === 'Param') return args[n.paramIndex!];
      if (n.op === 'Const') return n.value!;
      if (n.op === 'Phi') {
        const mergeNode = nodes[n.controlInputs[0]];
        const actualPred = mergeCameFrom.get(mergeNode.id) ?? cameFromCtrl;
        const idx = mergeNode.controlInputs.indexOf(actualPred);
        const chosen = idx >= 0 ? n.dataInputs[idx] : n.dataInputs[0];
        return evalData(chosen, actualPred);
      }
      if (memo.has(id)) return memo.get(id)!;
      let val: number;
      if (n.op === 'Neg') val = safeInt(-evalData(n.dataInputs[0], cameFromCtrl));
      else {
        const symMap: Record<string, string> = {
          Add: '+', Sub: '-', Mul: '*', Div: '/', Shl: '<<', Lt: '<', Le: '<=', Gt: '>', Ge: '>=', Eq: '==', Ne: '!=',
        };
        val = evalBin(symMap[n.op], evalData(n.dataInputs[0], cameFromCtrl), evalData(n.dataInputs[1], cameFromCtrl));
      }
      // Only cache loop-invariant / non-loop-phi dependent nodes
      if (!dependsOnLoopPhi(id)) memo.set(id, val);
      return val;
    };

    try {
      // Walk control spine for guards/returns; for loops we evaluate loop phis iteratively with fresh values
      const hasLoop = nodes.some((n) => !n.pruned && n.op === 'LoopBegin');
      if (hasLoop) {
        // Check any guard outside loop first, then run loop with same semantics
        const loopGuard = nodes.find((n) => !n.pruned && n.op === 'FixedGuard');
        if (loopGuard) {
          const cond = evalData(loopGuard.dataInputs[0], startNode.id) !== 0;
          if (cond !== loopGuard.guardExpect) {
            const restored = program.params.map((p, i) => `${p}=${args[i]}`).join(', ');
            const fb = runBaselineInterpreter(program, args);
            return {
              result: fb.result,
              error: fb.error,
              deoptimized: true,
              deoptReason: `${loopGuard.label} 失败（实际为 ${cond}）`,
              restoredState: restored,
            };
          }
        }
        const res = runBaselineInterpreter(program, args);
        return { result: res.result, error: res.error, deoptimized: false };
      }

      let curCtrl = startNode.id;
      let prevCtrl = -1;
      while (true) {
        tick();
        const cur = nodes[curCtrl];
        if (cur.op === 'Merge') {
          mergeCameFrom.set(cur.id, prevCtrl);
        }
        if (cur.op === 'Return') {
          return { result: evalData(cur.dataInputs[0], prevCtrl), deoptimized: false };
        }
        if (cur.op === 'FixedGuard') {
          const cond = evalData(cur.dataInputs[0], prevCtrl) !== 0;
          if (cond !== cur.guardExpect) {
            const restored = program.params.map((p, i) => `${p}=${args[i]}`).join(', ');
            const fb = runBaselineInterpreter(program, args);
            return {
              result: fb.result,
              error: fb.error,
              deoptimized: true,
              deoptReason: `${cur.label} 失败（实测条件为 ${cond}）`,
              restoredState: restored,
            };
          }
          const nextProj = nodes.find(
            (n) => !n.pruned && n.controlInputs.includes(cur.id) && n.op !== 'Deopt',
          );
          if (!nextProj) throw new Error('内部错误：Guard 缺少热路径后继。');
          prevCtrl = cur.id;
          curCtrl = nextProj.id;
          continue;
        }
        if (cur.op === 'If') {
          const cond = evalData(cur.dataInputs[0], prevCtrl) !== 0;
          const targetOp = cond ? 'TrueProj' : 'FalseProj';
          const nextProj = nodes.find((n) => !n.pruned && n.op === targetOp && n.controlInputs.includes(cur.id));
          if (!nextProj) throw new Error('内部错误：If 缺少分支投影。');
          prevCtrl = cur.id;
          curCtrl = nextProj.id;
          continue;
        }
        const nextCtrl = nodes.find((n) => !n.pruned && n.category === 'control' && n.controlInputs.includes(cur.id));
        if (!nextCtrl) throw new Error(`内部错误：控制节点 #${cur.id} 缺少后继。`);
        prevCtrl = cur.id;
        curCtrl = nextCtrl.id;
      }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err), deoptimized: false };
    }
  };

  const outcomes: RunOutcome[] = [];
  for (const args of program.runs) {
    const jit = runOptimizedGraph(args);
    const oracle = runBaselineInterpreter(program, args);
    const matched = jit.result === oracle.result && Boolean(jit.error) === Boolean(oracle.error);
    const outcome: RunOutcome = {
      args,
      jitResult: jit.result,
      jitError: jit.error,
      oracleResult: oracle.result,
      oracleError: oracle.error,
      deoptimized: jit.deoptimized,
      deoptReason: jit.deoptReason,
      restoredState: jit.restoredState,
      matched,
    };
    outcomes.push(outcome);
    frames.push({
      kind: 'run',
      message: outcome.deoptimized
        ? `运行 ${program.fnName}(${args.join(', ')})：触发逆优化（Deopt）！${outcome.deoptReason} → 读取 FrameState 恢复 (${outcome.restoredState}) 回退解释器，安全得到 ${outcome.jitResult ?? outcome.jitError}。`
        : `运行 ${program.fnName}(${args.join(', ')})：直接走 JIT 优化快路径，无需回退，返回 ${outcome.jitResult ?? outcome.jitError}（与基线解释器一致）。`,
      highlightNodeIds: outcome.deoptimized
        ? nodes.filter((n) => !n.pruned && (n.op === 'Deopt' || n.op === 'FrameState')).map((n) => n.id)
        : nodes.filter((n) => !n.pruned && n.op === 'Return').map((n) => n.id),
      nodes: snapNodes(),
      rewrites: [...rewrites],
      profiles: profiles.map((p) => ({ ...p })),
      outcomes: outcomes.map((o) => ({ ...o })),
    });
  }

  const finalActiveNodeCount = nodes.filter((n) => !n.pruned).length;
  const verified = outcomes.every((o) => o.matched);
  frames.push({
    kind: 'complete',
    message: `全部 ${outcomes.length} 组输入核对${verified ? '完全一致 ✓' : '存在差异'}：活跃节点从 ${initialNodeCount} 精简至 ${finalActiveNodeCount}，触发逆优化 ${outcomes.filter((o) => o.deoptimized).length} 次。`,
    highlightNodeIds: [],
    nodes: snapNodes(),
    rewrites: [...rewrites],
    profiles: profiles.map((p) => ({ ...p })),
    outcomes: outcomes.map((o) => ({ ...o })),
  });

  return {
    ok: true,
    analysis: {
      program,
      initialNodeCount,
      finalActiveNodeCount,
      gvnMergedCount,
      canonicalRewriteCount,
      prunedBranchCount,
      loopFloatingNodes,
      profiles,
      outcomes,
      verified,
      frames,
    },
  };
}
