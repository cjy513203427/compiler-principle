import { arithmetic, evaluateBinary } from './operations';
import { instructionText } from './ir';
import type { Instruction, Operand, Value } from './model';
import type { Execution } from './vm';

export interface ExprTree {
  id: number;
  kind: 'const' | 'reg' | 'bin';
  value?: Value;
  name?: string;
  op?: string;
  left?: ExprTree;
  right?: ExprTree;
  text: string;
}

export interface StmtTree {
  index: number;
  kind: 'assign' | 'print' | 'branch' | 'jump' | 'label';
  dest?: string;
  target?: string;
  expr?: ExprTree;
  sourceIR: string[];
}

export type TargetInstr =
  | { op: 'MOV'; dst: string; src: Operand; cost: number; tile: string }
  | { op: 'MOVI'; dst: string; value: Value; cost: number; tile: string }
  | { op: 'ALU'; kind: 'ADD' | 'SUB' | 'IMUL' | 'IDIV' | 'SHL'; dst: string; left: Operand; right: Operand; cost: number; tile: string }
  | { op: 'CMP'; cmpOp: string; dst: string; left: Operand; right: Operand; cost: number; tile: string }
  | { op: 'LEA'; dst: string; base?: Operand; index?: Operand; scale: 1 | 2 | 4 | 8; disp: number; cost: number; tile: string }
  | { op: 'MADD'; dst: string; a: Operand; b: Operand; c: Operand; cost: number; tile: string }
  | { op: 'PRINT'; src: Operand; cost: number; tile: string }
  | { op: 'LABEL'; name: string; cost: number; tile: string }
  | { op: 'JMP'; target: string; cost: number; tile: string }
  | { op: 'BR_FALSE'; cond: Operand; target: string; cost: number; tile: string };

export interface TileChoice {
  nodeId: number;
  nodeText: string;
  tileName: string;
  pattern: string;
  cost: number;
  totalCost: number;
  emitted: string;
  strategy: 'dp' | 'munch';
}

export interface TargetRun {
  name: string;
  isa: 'cisc' | 'risc';
  strategy: 'naive' | 'munch' | 'dp' | 'risc';
  instructions: TargetInstr[];
  totalCost: number;
  executableCount: number;
  output: Value[];
  halted: boolean;
  limited: boolean;
  error?: string;
  stepsExecuted: number;
}

export interface IselFrame {
  kind: 'initial' | 'tree' | 'dp' | 'munch' | 'compare' | 'complete';
  stmtIndex?: number;
  choiceIndex?: number;
  message: string;
}

export interface IselAnalysis {
  trees: StmtTree[];
  dpChoices: TileChoice[];
  munchChoices: TileChoice[];
  runs: {
    naive: TargetRun;
    munch: TargetRun;
    dp: TargetRun;
    risc: TargetRun;
  };
  frames: IselFrame[];
  traceTruncated: boolean;
  equivalent: 'same' | 'different' | 'unknown';
}

const MAX_TRACE = 240;
const MAX_EXEC = 2000;

export function formatOperand(op: Operand): string {
  return op.kind === 'constant' ? String(op.value) : op.name;
}

export function formatTargetInstr(ins: TargetInstr): string {
  switch (ins.op) {
    case 'MOV':
      return `MOV ${ins.dst}, ${formatOperand(ins.src)}`;
    case 'MOVI':
      return `MOVI ${ins.dst}, ${ins.value}`;
    case 'ALU':
      return `${ins.kind} ${ins.dst}, ${formatOperand(ins.left)}, ${formatOperand(ins.right)}`;
    case 'CMP':
      return `CMP.${ins.cmpOp} ${ins.dst}, ${formatOperand(ins.left)}, ${formatOperand(ins.right)}`;
    case 'LEA': {
      const parts: string[] = [];
      if (ins.base) parts.push(formatOperand(ins.base));
      if (ins.index) parts.push(ins.scale === 1 ? formatOperand(ins.index) : `${formatOperand(ins.index)}*${ins.scale}`);
      if (ins.disp !== 0 || parts.length === 0) {
        parts.push(ins.disp < 0 ? `- ${Math.abs(ins.disp)}` : `${ins.disp}`);
      }
      const expr = parts.join(' + ').replace(/\+ - /g, '- ');
      return `LEA ${ins.dst}, [${expr}]`;
    }
    case 'MADD':
      return `MADD ${ins.dst}, ${formatOperand(ins.a)}, ${formatOperand(ins.b)}, ${formatOperand(ins.c)}`;
    case 'PRINT':
      return `PRINT ${formatOperand(ins.src)}`;
    case 'LABEL':
      return `${ins.name}:`;
    case 'JMP':
      return `JMP ${ins.target}`;
    case 'BR_FALSE':
      return `BR_FALSE ${formatOperand(ins.cond)}, ${ins.target}`;
  }
}

const isTemp = (name: string) => /^t\d+$/.test(name);

function collectTreeVars(node: ExprTree, out: Set<string>) {
  if (node.kind === 'reg' && node.name) out.add(node.name);
  if (node.left) collectTreeVars(node.left, out);
  if (node.right) collectTreeVars(node.right, out);
}

/** Rebuild per-statement expression trees inside each basic block by folding single-use temporaries. */
export function buildExpressionTrees(ir: Instruction[]): StmtTree[] {
  let nextId = 1;
  const makeConst = (value: Value): ExprTree => ({ id: nextId++, kind: 'const', value, text: String(value) });
  const makeReg = (name: string): ExprTree => ({ id: nextId++, kind: 'reg', name, text: name });
  const makeBin = (op: string, left: ExprTree, right: ExprTree): ExprTree => ({
    id: nextId++,
    kind: 'bin',
    op,
    left,
    right,
    text: `(${left.text} ${op} ${right.text})`,
  });

  // Count total uses of every variable across the entire IR so we only inline strictly single-use temps.
  const useCount = new Map<string, number>();
  const addUse = (op: Operand) => {
    if (op.kind === 'ref') useCount.set(op.name, (useCount.get(op.name) || 0) + 1);
  };
  for (const ins of ir) {
    if (ins.op === 'move' || ins.op === 'print') addUse(ins.value);
    else if (ins.op === 'binary') {
      addUse(ins.left);
      addUse(ins.right);
    } else if (ins.op === 'branch') addUse(ins.condition);
  }

  const stmts: StmtTree[] = [];
  // Pending single-use temporary trees within the current basic block.
  const pending = new Map<string, { tree: ExprTree; lines: string[]; vars: Set<string> }>();

  const flushPending = () => {
    for (const [name, entry] of pending) {
      stmts.push({ index: stmts.length, kind: 'assign', dest: name, expr: entry.tree, sourceIR: entry.lines });
    }
    pending.clear();
  };

  const resolve = (op: Operand, sourceAcc: string[]): ExprTree => {
    if (op.kind === 'constant') return makeConst(op.value);
    const entry = pending.get(op.name);
    if (entry) {
      pending.delete(op.name);
      sourceAcc.push(...entry.lines);
      return entry.tree;
    }
    return makeReg(op.name);
  };

  const invalidateByWrite = (written: string) => {
    for (const [tempName, entry] of [...pending]) {
      if (entry.vars.has(written)) {
        pending.delete(tempName);
        stmts.push({ index: stmts.length, kind: 'assign', dest: tempName, expr: entry.tree, sourceIR: entry.lines });
      }
    }
  };

  for (const ins of ir) {
    if (ins.op === 'label' || ins.op === 'jump') {
      flushPending();
      stmts.push({
        index: stmts.length,
        kind: ins.op,
        target: ins.op === 'label' ? ins.name : ins.target,
        sourceIR: [instructionText(ins)],
      });
      continue;
    }
    if (ins.op === 'branch') {
      const lines: string[] = [];
      const expr = resolve(ins.condition, lines);
      lines.push(instructionText(ins));
      flushPending();
      stmts.push({ index: stmts.length, kind: 'branch', target: ins.target, expr, sourceIR: lines });
      continue;
    }
    if (ins.op === 'print') {
      const lines: string[] = [];
      const expr = resolve(ins.value, lines);
      lines.push(instructionText(ins));
      // Keep pending trees before print flushed so exception order before print is preserved.
      flushPending();
      stmts.push({ index: stmts.length, kind: 'print', expr, sourceIR: lines });
      continue;
    }
    if (ins.op === 'move') {
      const lines: string[] = [];
      const expr = resolve(ins.value, lines);
      lines.push(instructionText(ins));
      invalidateByWrite(ins.dest);
      if (isTemp(ins.dest) && useCount.get(ins.dest) === 1) {
        const vars = new Set<string>();
        collectTreeVars(expr, vars);
        pending.set(ins.dest, { tree: expr, lines, vars });
      } else {
        // Flush any remaining pending temps that might trap before this observable/named assignment.
        flushPending();
        stmts.push({ index: stmts.length, kind: 'assign', dest: ins.dest, expr, sourceIR: lines });
      }
      continue;
    }
    if (ins.op === 'binary') {
      const lines: string[] = [];
      const left = resolve(ins.left, lines);
      const right = resolve(ins.right, lines);
      lines.push(instructionText(ins));
      const expr = makeBin(ins.operator, left, right);
      invalidateByWrite(ins.dest);
      if (isTemp(ins.dest) && useCount.get(ins.dest) === 1) {
        const vars = new Set<string>();
        collectTreeVars(expr, vars);
        pending.set(ins.dest, { tree: expr, lines, vars });
      } else {
        flushPending();
        stmts.push({ index: stmts.length, kind: 'assign', dest: ins.dest, expr, sourceIR: lines });
      }
    }
  }
  flushPending();
  return stmts;
}

const isScale = (v: Value | undefined): v is 2 | 4 | 8 => v === 2 || v === 4 || v === 8;
const isIntConst = (node: ExprTree | undefined): node is ExprTree & { value: number } =>
  !!node && node.kind === 'const' && typeof node.value === 'number';
const isScaleMul = (node: ExprTree | undefined): { index: ExprTree; scale: 2 | 4 | 8 } | undefined => {
  if (!node || node.kind !== 'bin' || node.op !== '*') return undefined;
  if (isIntConst(node.right) && isScale(node.right.value)) return { index: node.left!, scale: node.right.value };
  if (isIntConst(node.left) && isScale(node.left.value)) return { index: node.right!, scale: node.left.value };
  return undefined;
};

interface TileMatch {
  name: string;
  pattern: string;
  opNodes: number; // How many operator nodes this tile covers (for Maximal Munch)
  cost: number;
  children: ExprTree[];
  emit: (dst: string, childOps: Operand[]) => TargetInstr[];
}

function ciscMatches(node: ExprTree): TileMatch[] {
  const matches: TileMatch[] = [];
  if (node.kind === 'const') {
    matches.push({
      name: 'MOV_IMM',
      pattern: 'CONST(c)',
      opNodes: 0,
      cost: 1,
      children: [],
      emit: (dst) => [{ op: 'MOV', dst, src: { kind: 'constant', value: node.value! }, cost: 1, tile: 'MOV_IMM' }],
    });
    return matches;
  }
  if (node.kind === 'reg') {
    matches.push({
      name: 'REG',
      pattern: 'REG(v)',
      opNodes: 0,
      cost: 0,
      children: [],
      emit: () => [],
    });
    return matches;
  }
  const op = node.op!;
  const L = node.left!;
  const R = node.right!;

  if (op === '+') {
    // 1) LEA full: (a + b*s) + c, c + (a + b*s), (a + c) + b*s, b*s + (a + c)
    const tryFullLea = (addNode: ExprTree, other: ExprTree) => {
      if (isIntConst(other) && addNode.kind === 'bin' && addNode.op === '+') {
        const lm = isScaleMul(addNode.left);
        if (lm) {
          matches.push({
            name: 'LEA_BASE_IDX_DISP',
            pattern: 'ADD(ADD(MUL(idx, s), base), imm)',
            opNodes: 3,
            cost: 2,
            children: [addNode.right!, lm.index],
            emit: (dst, [base, idx]) => [
              { op: 'LEA', dst, base, index: idx, scale: lm.scale, disp: other.value, cost: 2, tile: 'LEA_BASE_IDX_DISP' },
            ],
          });
        }
        const rm = isScaleMul(addNode.right);
        if (rm) {
          matches.push({
            name: 'LEA_BASE_IDX_DISP',
            pattern: 'ADD(ADD(base, MUL(idx, s)), imm)',
            opNodes: 3,
            cost: 2,
            children: [addNode.left!, rm.index],
            emit: (dst, [base, idx]) => [
              { op: 'LEA', dst, base, index: idx, scale: rm.scale, disp: other.value, cost: 2, tile: 'LEA_BASE_IDX_DISP' },
            ],
          });
        }
      }
      const sm = isScaleMul(other);
      if (sm && addNode.kind === 'bin' && addNode.op === '+') {
        if (isIntConst(addNode.right)) {
          matches.push({
            name: 'LEA_BASE_IDX_DISP',
            pattern: 'ADD(ADD(base, imm), MUL(idx, s))',
            opNodes: 3,
            cost: 2,
            children: [addNode.left!, sm.index],
            emit: (dst, [base, idx]) => [
              { op: 'LEA', dst, base, index: idx, scale: sm.scale, disp: addNode.right!.value as number, cost: 2, tile: 'LEA_BASE_IDX_DISP' },
            ],
          });
        } else if (isIntConst(addNode.left)) {
          matches.push({
            name: 'LEA_BASE_IDX_DISP',
            pattern: 'ADD(ADD(imm, base), MUL(idx, s))',
            opNodes: 3,
            cost: 2,
            children: [addNode.right!, sm.index],
            emit: (dst, [base, idx]) => [
              { op: 'LEA', dst, base, index: idx, scale: sm.scale, disp: addNode.left!.value as number, cost: 2, tile: 'LEA_BASE_IDX_DISP' },
            ],
          });
        }
      }
    };
    tryFullLea(L, R);
    tryFullLea(R, L);

    // 2) LEA 2-add + imm: (a + b) + c or c + (a + b)
    const tryAdd2Imm = (addNode: ExprTree, imm: ExprTree) => {
      if (isIntConst(imm) && addNode.kind === 'bin' && addNode.op === '+') {
        matches.push({
          name: 'LEA_ADD2_IMM',
          pattern: 'ADD(ADD(a, b), imm)',
          opNodes: 2,
          cost: 2,
          children: [addNode.left!, addNode.right!],
          emit: (dst, [a, b]) => [
            { op: 'LEA', dst, base: a, index: b, scale: 1, disp: imm.value, cost: 2, tile: 'LEA_ADD2_IMM' },
          ],
        });
      }
    };
    tryAdd2Imm(L, R);
    tryAdd2Imm(R, L);

    // 3) LEA scale + base: base + idx*s or idx*s + base (or idx*s + imm)
    const tryScaleAdd = (mulNode: ExprTree, other: ExprTree) => {
      const sm = isScaleMul(mulNode);
      if (!sm) return;
      if (isIntConst(other)) {
        matches.push({
          name: 'LEA_SCALE_IMM',
          pattern: 'ADD(MUL(idx, s), imm)',
          opNodes: 2,
          cost: 2,
          children: [sm.index],
          emit: (dst, [idx]) => [
            { op: 'LEA', dst, index: idx, scale: sm.scale, disp: other.value, cost: 2, tile: 'LEA_SCALE_IMM' },
          ],
        });
      } else {
        matches.push({
          name: 'LEA_SCALE_ADD',
          pattern: 'ADD(base, MUL(idx, s))',
          opNodes: 2,
          cost: 2,
          children: [other, sm.index],
          emit: (dst, [base, idx]) => [
            { op: 'LEA', dst, base, index: idx, scale: sm.scale, disp: 0, cost: 2, tile: 'LEA_SCALE_ADD' },
          ],
        });
      }
    };
    tryScaleAdd(L, R);
    tryScaleAdd(R, L);

    // 4) MADD (Multiply-Add, covers 2 op nodes ADD+MUL, cost 5 — useful for a*b + c, but worse than LEA_MUL3 + ADD!)
    if (L.kind === 'bin' && L.op === '*') {
      matches.push({
        name: 'MADD',
        pattern: 'ADD(MUL(a, b), c)',
        opNodes: 2,
        cost: 5,
        children: [L.left!, L.right!, R],
        emit: (dst, [a, b, c]) => [{ op: 'MADD', dst, a, b, c, cost: 5, tile: 'MADD' }],
      });
    }
    if (R.kind === 'bin' && R.op === '*') {
      matches.push({
        name: 'MADD',
        pattern: 'ADD(c, MUL(a, b))',
        opNodes: 2,
        cost: 5,
        children: [R.left!, R.right!, L],
        emit: (dst, [a, b, c]) => [{ op: 'MADD', dst, a, b, c, cost: 5, tile: 'MADD' }],
      });
    }

    // 5) ADD immediate or register
    if (isIntConst(R)) {
      matches.push({
        name: 'ADD_IMM',
        pattern: 'ADD(a, imm)',
        opNodes: 1,
        cost: 2,
        children: [L],
        emit: (dst, [a]) => [
          { op: 'ALU', kind: 'ADD', dst, left: a, right: { kind: 'constant', value: R.value }, cost: 2, tile: 'ADD_IMM' },
        ],
      });
    } else if (isIntConst(L)) {
      matches.push({
        name: 'ADD_IMM',
        pattern: 'ADD(imm, a)',
        opNodes: 1,
        cost: 2,
        children: [R],
        emit: (dst, [a]) => [
          { op: 'ALU', kind: 'ADD', dst, left: a, right: { kind: 'constant', value: L.value }, cost: 2, tile: 'ADD_IMM' },
        ],
      });
    }
    matches.push({
      name: 'ADD_REG',
      pattern: 'ADD(a, b)',
      opNodes: 1,
      cost: 2,
      children: [L, R],
      emit: (dst, [a, b]) => [{ op: 'ALU', kind: 'ADD', dst, left: a, right: b, cost: 2, tile: 'ADD_REG' }],
    });
  } else if (op === '-') {
    if (isIntConst(R)) {
      matches.push({
        name: 'SUB_IMM',
        pattern: 'SUB(a, imm)',
        opNodes: 1,
        cost: 2,
        children: [L],
        emit: (dst, [a]) => [
          { op: 'ALU', kind: 'SUB', dst, left: a, right: { kind: 'constant', value: R.value }, cost: 2, tile: 'SUB_IMM' },
        ],
      });
    }
    matches.push({
      name: 'SUB_REG',
      pattern: 'SUB(a, b)',
      opNodes: 1,
      cost: 2,
      children: [L, R],
      emit: (dst, [a, b]) => [{ op: 'ALU', kind: 'SUB', dst, left: a, right: b, cost: 2, tile: 'SUB_REG' }],
    });
  } else if (op === '*') {
    // LEA x * {3, 5, 9} = [x + x*{2,4,8}] (cost 2 vs IMUL cost 4!)
    const tryLeaMul = (x: ExprTree, kNode: ExprTree) => {
      if (!isIntConst(kNode)) return;
      if (kNode.value === 3 || kNode.value === 5 || kNode.value === 9) {
        const scale = (kNode.value - 1) as 2 | 4 | 8;
        matches.push({
          name: `LEA_MUL${kNode.value}`,
          pattern: `MUL(x, ${kNode.value})`,
          opNodes: 1,
          cost: 2,
          children: [x],
          emit: (dst, [base]) => [
            { op: 'LEA', dst, base, index: base, scale, disp: 0, cost: 2, tile: `LEA_MUL${kNode.value}` },
          ],
        });
      } else if (kNode.value === 2 || kNode.value === 4 || kNode.value === 8) {
        const shift = Math.log2(kNode.value);
        matches.push({
          name: `SHL_${shift}`,
          pattern: `MUL(x, ${kNode.value})`,
          opNodes: 1,
          cost: 2,
          children: [x],
          emit: (dst, [a]) => [
            { op: 'ALU', kind: 'SHL', dst, left: a, right: { kind: 'constant', value: shift }, cost: 2, tile: `SHL_${shift}` },
          ],
        });
      }
    };
    tryLeaMul(L, R);
    tryLeaMul(R, L);
    matches.push({
      name: 'IMUL_REG',
      pattern: 'MUL(a, b)',
      opNodes: 1,
      cost: 4,
      children: [L, R],
      emit: (dst, [a, b]) => [{ op: 'ALU', kind: 'IMUL', dst, left: a, right: b, cost: 4, tile: 'IMUL_REG' }],
    });
  } else if (op === '/') {
    matches.push({
      name: 'IDIV_REG',
      pattern: 'DIV(a, b)',
      opNodes: 1,
      cost: 6,
      children: [L, R],
      emit: (dst, [a, b]) => [{ op: 'ALU', kind: 'IDIV', dst, left: a, right: b, cost: 6, tile: 'IDIV_REG' }],
    });
  } else {
    matches.push({
      name: 'CMP_SET',
      pattern: `CMP(${op}, a, b)`,
      opNodes: 1,
      cost: 2,
      children: [L, R],
      emit: (dst, [a, b]) => [{ op: 'CMP', cmpOp: op, dst, left: a, right: b, cost: 2, tile: 'CMP_SET' }],
    });
  }
  return matches;
}

function selectCiscTree(
  root: ExprTree,
  strategy: 'dp' | 'munch',
  desiredDst: string | undefined,
  freshReg: () => string,
  choices: TileChoice[],
): { operand: Operand; instructions: TargetInstr[]; cost: number } {
  // Bottom-up DP table: nodeId -> { bestMatch, totalCost }
  const dpBest = new Map<number, { match: TileMatch; totalCost: number }>();

  function solveDp(node: ExprTree): { match: TileMatch; totalCost: number } {
    const cached = dpBest.get(node.id);
    if (cached) return cached;
    const candidates = ciscMatches(node);
    let best: { match: TileMatch; totalCost: number } | undefined;
    for (const match of candidates) {
      const childCost = match.children.reduce((sum, ch) => sum + solveDp(ch).totalCost, 0);
      const total = match.cost + childCost;
      if (!best || total < best.totalCost || (total === best.totalCost && match.opNodes > best.match.opNodes)) {
        best = { match, totalCost: total };
      }
    }
    dpBest.set(node.id, best!);
    return best!;
  }

  function pickMunch(node: ExprTree): TileMatch {
    const candidates = ciscMatches(node);
    // Greedy top-down: maximize operator nodes covered first; break ties by lower tile cost.
    return candidates.reduce((best, cur) =>
      cur.opNodes > best.opNodes || (cur.opNodes === best.opNodes && cur.cost < best.cost) ? cur : best,
    );
  }

  if (strategy === 'dp') solveDp(root);

  const out: TargetInstr[] = [];

  function emitNode(node: ExprTree, targetDst?: string): { operand: Operand; totalCost: number } {
    if (node.kind === 'reg') {
      if (targetDst && targetDst !== node.name) {
        const ins: TargetInstr = { op: 'MOV', dst: targetDst, src: { kind: 'ref', name: node.name! }, cost: 1, tile: 'MOV_REG' };
        out.push(ins);
        return { operand: { kind: 'ref', name: targetDst }, totalCost: 1 };
      }
      return { operand: { kind: 'ref', name: node.name! }, totalCost: 0 };
    }
    const match = strategy === 'dp' ? dpBest.get(node.id)!.match : pickMunch(node);
    const childResults = match.children.map((child) => emitNode(child));
    const childOps = childResults.map((r) => r.operand);
    const dst = targetDst || freshReg();
    const emitted = match.emit(dst, childOps);
    out.push(...emitted);
    const totalCost = match.cost + childResults.reduce((s, r) => s + r.totalCost, 0);
    if (node.kind === 'bin' || (node.kind === 'const' && targetDst)) {
      choices.push({
        nodeId: node.id,
        nodeText: node.text,
        tileName: match.name,
        pattern: match.pattern,
        cost: match.cost,
        totalCost,
        emitted: emitted.map(formatTargetInstr).join(' ; '),
        strategy,
      });
    }
    return { operand: { kind: 'ref', name: dst }, totalCost };
  }

  const res = emitNode(root, desiredDst);
  return { operand: res.operand, instructions: out, cost: res.totalCost };
}

function selectRiscTree(
  root: ExprTree,
  desiredDst: string | undefined,
  freshReg: () => string,
): { operand: Operand; instructions: TargetInstr[] } {
  const out: TargetInstr[] = [];
  function emit(node: ExprTree, targetDst?: string): Operand {
    if (node.kind === 'reg') {
      if (targetDst && targetDst !== node.name) {
        out.push({ op: 'MOV', dst: targetDst, src: { kind: 'ref', name: node.name! }, cost: 1, tile: 'RISC_MOV' });
        return { kind: 'ref', name: targetDst };
      }
      return { kind: 'ref', name: node.name! };
    }
    if (node.kind === 'const') {
      const dst = targetDst || freshReg();
      out.push({ op: 'MOVI', dst, value: node.value!, cost: 1, tile: 'RISC_MOVI' });
      return { kind: 'ref', name: dst };
    }
    const left = emit(node.left!);
    const right = emit(node.right!);
    const dst = targetDst || freshReg();
    if (node.op === '+') out.push({ op: 'ALU', kind: 'ADD', dst, left, right, cost: 2, tile: 'RISC_ADD' });
    else if (node.op === '-') out.push({ op: 'ALU', kind: 'SUB', dst, left, right, cost: 2, tile: 'RISC_SUB' });
    else if (node.op === '*') out.push({ op: 'ALU', kind: 'IMUL', dst, left, right, cost: 4, tile: 'RISC_MUL' });
    else if (node.op === '/') out.push({ op: 'ALU', kind: 'IDIV', dst, left, right, cost: 6, tile: 'RISC_DIV' });
    else out.push({ op: 'CMP', cmpOp: node.op!, dst, left, right, cost: 2, tile: 'RISC_CMP' });
    return { kind: 'ref', name: dst };
  }
  const operand = emit(root, desiredDst);
  return { operand, instructions: out };
}

function emitNaive(ir: Instruction[]): TargetInstr[] {
  const out: TargetInstr[] = [];
  for (const ins of ir) {
    if (ins.op === 'label') out.push({ op: 'LABEL', name: ins.name, cost: 0, tile: 'LABEL' });
    else if (ins.op === 'jump') out.push({ op: 'JMP', target: ins.target, cost: 1, tile: 'JMP' });
    else if (ins.op === 'branch') out.push({ op: 'BR_FALSE', cond: ins.condition, target: ins.target, cost: 2, tile: 'BR_FALSE' });
    else if (ins.op === 'print') out.push({ op: 'PRINT', src: ins.value, cost: 1, tile: 'PRINT' });
    else if (ins.op === 'move') out.push({ op: 'MOV', dst: ins.dest, src: ins.value, cost: 1, tile: 'MOV' });
    else {
      if (ins.operator === '+') out.push({ op: 'ALU', kind: 'ADD', dst: ins.dest, left: ins.left, right: ins.right, cost: 2, tile: 'ADD' });
      else if (ins.operator === '-') out.push({ op: 'ALU', kind: 'SUB', dst: ins.dest, left: ins.left, right: ins.right, cost: 2, tile: 'SUB' });
      else if (ins.operator === '*') out.push({ op: 'ALU', kind: 'IMUL', dst: ins.dest, left: ins.left, right: ins.right, cost: 4, tile: 'IMUL' });
      else if (ins.operator === '/') out.push({ op: 'ALU', kind: 'IDIV', dst: ins.dest, left: ins.left, right: ins.right, cost: 6, tile: 'IDIV' });
      else out.push({ op: 'CMP', cmpOp: ins.operator, dst: ins.dest, left: ins.left, right: ins.right, cost: 2, tile: 'CMP' });
    }
  }
  return out;
}

export function executeTarget(
  name: string,
  isa: 'cisc' | 'risc',
  strategy: TargetRun['strategy'],
  instructions: TargetInstr[],
): TargetRun {
  const labels = new Map<string, number>();
  instructions.forEach((ins, i) => {
    if (ins.op === 'LABEL') labels.set(ins.name, i);
  });
  const totalCost = instructions.reduce((sum, ins) => sum + ins.cost, 0);
  const executableCount = instructions.filter((ins) => ins.op !== 'LABEL').length;
  const regs = new Map<string, Value>();
  const output: Value[] = [];
  const read = (op: Operand): Value => {
    if (op.kind === 'constant') return op.value;
    if (!regs.has(op.name)) throw new Error(`读取未初始化虚拟寄存器 ${op.name}。`);
    return regs.get(op.name)!;
  };
  let pc = 0;
  let steps = 0;
  try {
    while (pc < instructions.length) {
      if (steps >= MAX_EXEC) {
        return { name, isa, strategy, instructions, totalCost, executableCount, output, halted: false, limited: true, stepsExecuted: steps };
      }
      const ins = instructions[pc];
      if (ins.op === 'LABEL') {
        pc++;
        continue;
      }
      steps++;
      if (ins.op === 'MOV') {
        regs.set(ins.dst, read(ins.src));
        pc++;
      } else if (ins.op === 'MOVI') {
        regs.set(ins.dst, ins.value);
        pc++;
      } else if (ins.op === 'ALU') {
        const l = read(ins.left);
        const r = read(ins.right);
        if (ins.kind === 'SHL') {
          if (typeof l !== 'number' || typeof r !== 'number') throw new Error('移位操作数不是整数。');
          regs.set(ins.dst, arithmetic('*', l, 2 ** r));
        } else {
          const sym = ins.kind === 'ADD' ? '+' : ins.kind === 'SUB' ? '-' : ins.kind === 'IMUL' ? '*' : '/';
          regs.set(ins.dst, arithmetic(sym, l, r));
        }
        pc++;
      } else if (ins.op === 'CMP') {
        regs.set(ins.dst, evaluateBinary(ins.cmpOp, read(ins.left), read(ins.right)));
        pc++;
      } else if (ins.op === 'LEA') {
        // Evaluate with safe-integer checks matching arithmetic() semantics.
        let acc = 0;
        let hasAcc = false;
        if (ins.base) {
          const b = read(ins.base);
          if (typeof b !== 'number') throw new Error('LEA 操作数不是整数。');
          acc = b;
          hasAcc = true;
        }
        if (ins.index) {
          const idx = read(ins.index);
          if (typeof idx !== 'number') throw new Error('LEA 索引操作数不是整数。');
          const scaled = ins.scale === 1 ? idx : arithmetic('*', idx, ins.scale);
          acc = hasAcc ? arithmetic('+', acc, scaled) : scaled;
          hasAcc = true;
        }
        if (ins.disp !== 0 || !hasAcc) {
          acc = hasAcc ? arithmetic('+', acc, ins.disp) : ins.disp;
        }
        regs.set(ins.dst, acc);
        pc++;
      } else if (ins.op === 'MADD') {
        const prod = arithmetic('*', read(ins.a), read(ins.b));
        regs.set(ins.dst, arithmetic('+', prod, read(ins.c)));
        pc++;
      } else if (ins.op === 'PRINT') {
        output.push(read(ins.src));
        pc++;
      } else if (ins.op === 'JMP') {
        const target = labels.get(ins.target);
        if (target === undefined) throw new Error(`找不到跳转标签 ${ins.target}。`);
        pc = target;
      } else if (ins.op === 'BR_FALSE') {
        const cond = read(ins.cond);
        if (typeof cond !== 'boolean') throw new Error('条件跳转需要 bool 值。');
        if (!cond) {
          const target = labels.get(ins.target);
          if (target === undefined) throw new Error(`找不到跳转标签 ${ins.target}。`);
          pc = target;
        } else {
          pc++;
        }
      }
    }
    return { name, isa, strategy, instructions, totalCost, executableCount, output, halted: true, limited: false, stepsExecuted: steps };
  } catch (err) {
    return {
      name,
      isa,
      strategy,
      instructions,
      totalCost,
      executableCount,
      output,
      halted: false,
      limited: false,
      error: err instanceof Error ? err.message : String(err),
      stepsExecuted: steps,
    };
  }
}

function compareWithBaseline(baseline: Execution, runs: TargetRun[]): 'same' | 'different' | 'unknown' {
  if (baseline.limited || runs.some((r) => r.limited)) return 'unknown';
  for (const r of runs) {
    if (
      r.halted !== baseline.halted ||
      r.error !== baseline.error?.message ||
      r.output.length !== baseline.output.length ||
      r.output.some((v, i) => !Object.is(v, baseline.output[i]))
    ) {
      return 'different';
    }
  }
  return 'same';
}

export function analyzeInstructionSelection(ir: Instruction[], baseline: Execution): IselAnalysis {
  const trees = buildExpressionTrees(ir);
  const dpChoices: TileChoice[] = [];
  const munchChoices: TileChoice[] = [];
  const dpInstrs: TargetInstr[] = [];
  const munchInstrs: TargetInstr[] = [];
  const riscInstrs: TargetInstr[] = [];

  let dpReg = 0;
  let munchReg = 0;
  let riscReg = 0;
  const freshDp = () => `r${dpReg++}`;
  const freshMunch = () => `r${munchReg++}`;
  const freshRisc = () => `r${riscReg++}`;

  for (const stmt of trees) {
    if (stmt.kind === 'label') {
      const ins: TargetInstr = { op: 'LABEL', name: stmt.target!, cost: 0, tile: 'LABEL' };
      dpInstrs.push(ins);
      munchInstrs.push(ins);
      riscInstrs.push(ins);
    } else if (stmt.kind === 'jump') {
      const ins: TargetInstr = { op: 'JMP', target: stmt.target!, cost: 1, tile: 'JMP' };
      dpInstrs.push(ins);
      munchInstrs.push(ins);
      riscInstrs.push(ins);
    } else if (stmt.kind === 'assign' && stmt.expr) {
      dpInstrs.push(...selectCiscTree(stmt.expr, 'dp', stmt.dest, freshDp, dpChoices).instructions);
      munchInstrs.push(...selectCiscTree(stmt.expr, 'munch', stmt.dest, freshMunch, munchChoices).instructions);
      riscInstrs.push(...selectRiscTree(stmt.expr, stmt.dest, freshRisc).instructions);
    } else if (stmt.kind === 'print' && stmt.expr) {
      const d = selectCiscTree(stmt.expr, 'dp', undefined, freshDp, dpChoices);
      dpInstrs.push(...d.instructions, { op: 'PRINT', src: d.operand, cost: 1, tile: 'PRINT' });
      const m = selectCiscTree(stmt.expr, 'munch', undefined, freshMunch, munchChoices);
      munchInstrs.push(...m.instructions, { op: 'PRINT', src: m.operand, cost: 1, tile: 'PRINT' });
      const r = selectRiscTree(stmt.expr, undefined, freshRisc);
      riscInstrs.push(...r.instructions, { op: 'PRINT', src: r.operand, cost: 1, tile: 'RISC_PRINT' });
    } else if (stmt.kind === 'branch' && stmt.expr) {
      const d = selectCiscTree(stmt.expr, 'dp', undefined, freshDp, dpChoices);
      dpInstrs.push(...d.instructions, { op: 'BR_FALSE', cond: d.operand, target: stmt.target!, cost: 2, tile: 'BR_FALSE' });
      const m = selectCiscTree(stmt.expr, 'munch', undefined, freshMunch, munchChoices);
      munchInstrs.push(...m.instructions, { op: 'BR_FALSE', cond: m.operand, target: stmt.target!, cost: 2, tile: 'BR_FALSE' });
      const r = selectRiscTree(stmt.expr, undefined, freshRisc);
      riscInstrs.push(...r.instructions, { op: 'BR_FALSE', cond: r.operand, target: stmt.target!, cost: 2, tile: 'RISC_BR_FALSE' });
    }
  }

  const naiveInstrs = emitNaive(ir);
  const runs = {
    naive: executeTarget('逐条直译 (Naive 1:1)', 'cisc', 'naive', naiveInstrs),
    munch: executeTarget('CISC 贪心最大吞噬 (Maximal Munch)', 'cisc', 'munch', munchInstrs),
    dp: executeTarget('CISC 动态规划最小代价 (DP / BURS)', 'cisc', 'dp', dpInstrs),
    risc: executeTarget('RISC Load-Store 指令集', 'risc', 'risc', riscInstrs),
  };

  const frames: IselFrame[] = [];
  let traceTruncated = false;
  const record = (frame: IselFrame) => {
    if (frames.length < MAX_TRACE) frames.push(frame);
    else traceTruncated = true;
  };

  record({
    kind: 'initial',
    message: `从 ${ir.length} 条三地址代码出发，把每个基本块内只用一次的临时变量折叠成 ${trees.length} 个语句树，准备做瓦片覆盖（Instruction Selection）。`,
  });

  trees.forEach((stmt, idx) => {
    if (stmt.expr && stmt.expr.kind === 'bin') {
      record({
        kind: 'tree',
        stmtIndex: idx,
        message: `还原语句 #${idx} 的表达式树：${stmt.dest ? `${stmt.dest} = ` : stmt.kind === 'print' ? 'print ' : 'branch '}${stmt.expr.text}（合并了 ${stmt.sourceIR.length} 条原始 IR）。`,
      });
    }
  });

  dpChoices.forEach((choice, idx) => {
    record({
      kind: 'dp',
      choiceIndex: idx,
      message: `DP 最小代价覆盖节点 ${choice.nodeText}：选中 ${choice.tileName}（${choice.pattern}），本瓦片代价 ${choice.cost}，子树总代价 ${choice.totalCost} → ${choice.emitted}。`,
    });
  });

  munchChoices.forEach((choice, idx) => {
    record({
      kind: 'munch',
      choiceIndex: idx,
      message: `最大吞噬（贪心）覆盖节点 ${choice.nodeText}：优先选覆盖算子最多的 ${choice.tileName}（代价 ${choice.cost}）→ ${choice.emitted}。`,
    });
  });

  record({
    kind: 'compare',
    message: `对照完成：直译代价 ${runs.naive.totalCost}，CISC 贪心代价 ${runs.munch.totalCost}，CISC DP 最小代价 ${runs.dp.totalCost}，RISC 代价 ${runs.risc.totalCost}。`,
  });

  const equivalent = compareWithBaseline(baseline, [runs.naive, runs.munch, runs.dp, runs.risc]);
  frames.push({
    kind: 'complete',
    message:
      equivalent === 'same'
        ? `全部四个目标版本与原 Mini C 虚拟机输出和错误完全一致。DP 方案比直译节省 ${Math.max(0, runs.naive.totalCost - runs.dp.totalCost)} 点代价。`
        : equivalent === 'unknown'
          ? '存在执行达到上限的版本，暂不能判定完整行为等价。'
          : '检测到目标执行与原 VM 存在差异，请检查实现。',
  });

  return { trees, dpChoices, munchChoices, runs, frames, traceTruncated, equivalent };
}
