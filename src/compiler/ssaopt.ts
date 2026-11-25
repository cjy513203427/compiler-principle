import type { DominanceAnalysis } from './dominance';
import { referencedVariables } from './dataflow';
import { instructionText } from './ir';
import { evaluateBinary } from './operations';
import { phiText, type Phi, type SsaAnalysis, type SsaBlock, type SsaExecution } from './ssa';
import type { Instruction, Operand, Value } from './model';
import type { Execution } from './vm';

export type Lattice = { kind: 'bottom' } | { kind: 'const'; value: Value } | { kind: 'top' };

export interface SsaOptEdge {
  from: string;
  to: string;
  kind: 'next' | 'jump' | 'true' | 'false';
}

export interface SsaOptFrame {
  kind: 'initial' | 'cfg-edge' | 'ssa-prop' | 'rewrite' | 'dce' | 'complete';
  block?: string;
  variable?: string;
  edge?: string;
  cfgQueue: string[];
  ssaQueue: string[];
  executableBlocks: string[];
  lattice: Record<string, string>;
  message: string;
}

export interface SsaOptAnalysis {
  valid: boolean;
  issues: string[];
  lattice: Record<string, Lattice>;
  executableBlocks: string[];
  executableEdges: string[];
  optimizedBlocks: SsaBlock[];
  optimizedEdges: SsaOptEdge[];
  removedBlocks: string[];
  simplifiedPhis: string[];
  removedInstructions: string[];
  sccpOperations: number;
  beforeCount: number;
  afterCount: number;
  execution?: SsaExecution;
  equivalence: 'same' | 'different' | 'unknown';
  frames: SsaOptFrame[];
  traceTruncated: boolean;
}

const MAX_TRACE = 240;
const MAX_EXEC = 2000;
const MAX_SCCP = 2000;

export function formatLattice(val: Lattice | undefined): string {
  if (!val || val.kind === 'bottom') return '⊥';
  if (val.kind === 'top') return '⊤';
  return String(val.value);
}

function meet(a: Lattice, b: Lattice): Lattice {
  if (a.kind === 'bottom') return b;
  if (b.kind === 'bottom') return a;
  if (a.kind === 'top' || b.kind === 'top') return { kind: 'top' };
  return Object.is(a.value, b.value) ? a : { kind: 'top' };
}

function sameLattice(a: Lattice, b: Lattice): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'const' && b.kind === 'const') return Object.is(a.value, b.value);
  return true;
}

const countOps = (blocks: SsaBlock[]) =>
  blocks.reduce(
    (sum, b) => sum + b.phis.length + b.instructions.filter((ins) => ins.op !== 'label').length,
    0,
  );

function executeOptimizedSSA(
  blocks: SsaBlock[],
  edges: SsaOptEdge[],
  entry: string,
): SsaExecution {
  const byId = new Map(blocks.map((b) => [b.id, b]));
  const memory = new Map<string, Value>();
  const output: Value[] = [];
  let count = 0;
  let id = entry;
  let predecessor: string | undefined;
  const read = (name: string) => {
    if (!memory.has(name)) throw new Error(`读取未初始化 SSA 版本 ${name}。`);
    return memory.get(name)!;
  };
  const val = (op: Operand) => (op.kind === 'constant' ? op.value : read(op.name));
  try {
    while (count < MAX_EXEC) {
      const block = byId.get(id);
      if (!block) throw new Error(`优化后 SSA 缺少基本块 ${id}。`);
      count++;
      const selections = block.phis.map((phi) => {
        const input = phi.inputs.find((item) => item.predecessor === predecessor);
        if (!input) throw new Error(`${id} 的 φ 缺少前驱 ${predecessor}。`);
        return { dest: phi.dest, value: read(input.name) };
      });
      selections.forEach((s) => memory.set(s.dest, s.value));
      let branch: boolean | undefined;
      for (const ins of block.instructions) {
        if (count >= MAX_EXEC) {
          return { block: id, steps: [], output, halted: false, limited: true, traceTruncated: false };
        }
        if (ins.op === 'label') continue;
        count++;
        if (ins.op === 'move') memory.set(ins.dest, val(ins.value));
        else if (ins.op === 'binary') {
          memory.set(ins.dest, evaluateBinary(ins.operator, val(ins.left), val(ins.right)));
        } else if (ins.op === 'print') {
          output.push(val(ins.value));
        } else if (ins.op === 'branch') {
          const cond = val(ins.condition);
          if (typeof cond !== 'boolean') throw new Error('条件跳转需要 bool 值。');
          branch = cond;
        }
      }
      const outgoing = edges.filter((e) => e.from === id);
      if (!outgoing.length) {
        return { block: id, steps: [], output, halted: true, limited: false, traceTruncated: false };
      }
      const nextEdge =
        branch === undefined
          ? outgoing[0]
          : outgoing.find((e) => e.kind === (branch ? 'true' : 'false')) || outgoing[0];
      predecessor = id;
      id = nextEdge.to;
    }
    return { block: id, steps: [], output, halted: false, limited: true, traceTruncated: false };
  } catch (err) {
    return {
      block: id,
      steps: [],
      output,
      halted: false,
      limited: false,
      error: err instanceof Error ? err.message : String(err),
      traceTruncated: false,
    };
  }
}

export function optimizeSSA(
  ssa: SsaAnalysis,
  dominance: DominanceAnalysis,
  baseline: Execution,
): SsaOptAnalysis {
  const beforeCount = countOps(ssa.blocks);
  if (!ssa.valid || !dominance.converged) {
    return {
      valid: false,
      issues: ssa.issues.length ? ssa.issues : ['前置 SSA 构造未通过，无法在 SSA 上优化。'],
      lattice: {},
      executableBlocks: [],
      executableEdges: [],
      optimizedBlocks: [],
      optimizedEdges: [],
      removedBlocks: [],
      simplifiedPhis: [],
      removedInstructions: [],
      sccpOperations: 0,
      beforeCount,
      afterCount: beforeCount,
      equivalence: 'unknown',
      frames: [
        {
          kind: 'complete',
          cfgQueue: [],
          ssaQueue: [],
          executableBlocks: [],
          lattice: {},
          message: '前置 SSA 未通过校验，跳过稀疏优化。',
        },
      ],
      traceTruncated: false,
    };
  }

  const byId = new Map(ssa.blocks.map((b) => [b.id, b]));
  const lattice = new Map<string, Lattice>();

  // Build explicit SSA def-use edges: variable -> list of users (phi or instruction in a block).
  type User = { blockId: string; kind: 'phi'; phiIndex: number } | { blockId: string; kind: 'instr'; instrIndex: number };
  const users = new Map<string, User[]>();
  const addUser = (name: string, user: User) => {
    if (!users.has(name)) users.set(name, []);
    users.get(name)!.push(user);
  };

  for (const block of ssa.blocks) {
    block.phis.forEach((phi, phiIndex) => {
      lattice.set(phi.dest, { kind: 'bottom' });
      phi.inputs.forEach((inp) => addUser(inp.name, { blockId: block.id, kind: 'phi', phiIndex }));
    });
    block.instructions.forEach((ins, instrIndex) => {
      if ('dest' in ins) lattice.set(ins.dest, { kind: 'bottom' });
      referencedVariables(ins).forEach((name) => addUser(name, { blockId: block.id, kind: 'instr', instrIndex }));
    });
  }

  const getVal = (op: Operand): Lattice =>
    op.kind === 'constant' ? { kind: 'const', value: op.value } : (lattice.get(op.name) ?? { kind: 'bottom' });

  const executableEdges = new Set<string>();
  const executableBlocks = new Set<string>();
  const cfgQueue: { from?: string; to: string }[] = [{ to: dominance.entry }];
  const ssaQueue: string[] = [];
  const frames: SsaOptFrame[] = [];
  let traceTruncated = false;
  let sccpOperations = 0;

  const snapLattice = () =>
    Object.fromEntries([...lattice.entries()].map(([k, v]) => [k, formatLattice(v)]));

  const record = (frame: Omit<SsaOptFrame, 'cfgQueue' | 'ssaQueue' | 'executableBlocks' | 'lattice'>) => {
    if (frames.length < MAX_TRACE) {
      frames.push({
        ...frame,
        cfgQueue: cfgQueue.map((e) => (e.from ? `${e.from}→${e.to}` : `ENTRY→${e.to}`)),
        ssaQueue: [...ssaQueue],
        executableBlocks: [...executableBlocks],
        lattice: snapLattice(),
      });
    } else {
      traceTruncated = true;
    }
  };

  const updateVar = (name: string, next: Lattice, reason: string, blockId: string) => {
    const prev = lattice.get(name) ?? { kind: 'bottom' };
    if (sameLattice(prev, next)) return;
    lattice.set(name, next);
    if (!ssaQueue.includes(name)) ssaQueue.push(name);
    record({
      kind: 'ssa-prop',
      block: blockId,
      variable: name,
      message: `${blockId}：${name} 从 ${formatLattice(prev)} 更新为 ${formatLattice(next)}（${reason}），沿 def-use 链加入 SSA 工作表。`,
    });
  };

  const evalPhi = (blockId: string, phi: Phi) => {
    let acc: Lattice = { kind: 'bottom' };
    for (const inp of phi.inputs) {
      if (!executableEdges.has(`${inp.predecessor}->${blockId}`)) continue;
      acc = meet(acc, lattice.get(inp.name) ?? { kind: 'bottom' });
    }
    updateVar(phi.dest, acc, `仅合并可执行前驱边的 φ`, blockId);
  };

  const evalInstr = (blockId: string, ins: Instruction) => {
    if (ins.op === 'move') {
      updateVar(ins.dest, getVal(ins.value), instructionText(ins), blockId);
    } else if (ins.op === 'binary') {
      const l = getVal(ins.left);
      const r = getVal(ins.right);
      let next: Lattice;
      if (l.kind === 'top' || r.kind === 'top') next = { kind: 'top' };
      else if (l.kind === 'bottom' || r.kind === 'bottom') next = { kind: 'bottom' };
      else {
        try {
          next = { kind: 'const', value: evaluateBinary(ins.operator, l.value, r.value) };
        } catch {
          // Never fold a trapping operation (div by zero or overflow) into a constant.
          next = { kind: 'top' };
        }
      }
      updateVar(ins.dest, next, instructionText(ins), blockId);
    } else if (ins.op === 'branch') {
      const cond = getVal(ins.condition);
      const outgoing = dominance.graph.edges.filter((e) => e.from === blockId);
      const enqueueEdge = (e: { from: string; to: string }) => {
        const key = `${e.from}->${e.to}`;
        if (!executableEdges.has(key)) cfgQueue.push({ from: e.from, to: e.to });
      };
      if (cond.kind === 'const' && typeof cond.value === 'boolean') {
        const chosen = outgoing.find((e) => e.kind === (cond.value ? 'true' : 'false'));
        if (chosen) enqueueEdge(chosen);
      } else if (cond.kind === 'top') {
        outgoing.forEach(enqueueEdge);
      }
    }
  };

  record({
    kind: 'initial',
    block: dominance.entry,
    message: `从有效 SSA 出发（共 ${ssa.blocks.length} 个块、${beforeCount} 条 φ/指令），初始化 CFG 边工作表与 SSA def-use 工作表，所有 SSA 版本初始为 ⊥。`,
  });

  while ((cfgQueue.length || ssaQueue.length) && sccpOperations < MAX_SCCP) {
    if (cfgQueue.length) {
      const edge = cfgQueue.shift()!;
      sccpOperations++;
      const edgeKey = edge.from ? `${edge.from}->${edge.to}` : `ENTRY->${edge.to}`;
      if (edge.from && executableEdges.has(edgeKey)) continue;
      if (edge.from) executableEdges.add(edgeKey);
      const firstVisit = !executableBlocks.has(edge.to);
      executableBlocks.add(edge.to);
      const block = byId.get(edge.to)!;
      record({
        kind: 'cfg-edge',
        block: block.id,
        edge: edgeKey,
        message: firstVisit
          ? `CFG 工作表弹出可执行边 ${edgeKey}：首次进入 ${block.id}，依次评估块首 φ 与全部指令。`
          : `CFG 工作表弹出新的可执行边 ${edgeKey}：${block.id} 已访问过，只需重算其块首 φ。`,
      });
      block.phis.forEach((phi) => evalPhi(block.id, phi));
      if (firstVisit) {
        block.instructions.forEach((ins) => evalInstr(block.id, ins));
        // If block does not end with a conditional branch, enqueue its single outgoing CFG edge.
        const hasBranch = block.instructions.some((ins) => ins.op === 'branch');
        if (!hasBranch) {
          for (const outEdge of dominance.graph.edges.filter((e) => e.from === block.id)) {
            if (!executableEdges.has(`${outEdge.from}->${outEdge.to}`)) {
              cfgQueue.push({ from: outEdge.from, to: outEdge.to });
            }
          }
        }
      }
    } else {
      const variable = ssaQueue.shift()!;
      sccpOperations++;
      const userList = users.get(variable) || [];
      for (const user of userList) {
        if (!executableBlocks.has(user.blockId)) continue;
        const block = byId.get(user.blockId)!;
        if (user.kind === 'phi') evalPhi(block.id, block.phis[user.phiIndex]);
        else evalInstr(block.id, block.instructions[user.instrIndex]);
      }
    }
  }

  // Rewrite SSA using SCCP lattice facts + reachable CFG subset.
  const removedBlocks = ssa.blocks.filter((b) => !executableBlocks.has(b.id)).map((b) => b.id);
  const subst = new Map<string, Operand>();
  for (const [name, val] of lattice) {
    if (val.kind === 'const') subst.set(name, { kind: 'constant', value: val.value });
  }

  const resolveOp = (op: Operand): Operand => {
    let cur = op;
    const seen = new Set<string>();
    while (cur.kind === 'ref' && subst.has(cur.name) && !seen.has(cur.name)) {
      seen.add(cur.name);
      cur = subst.get(cur.name)!;
    }
    return cur;
  };

  let optBlocks: SsaBlock[] = ssa.blocks
    .filter((b) => executableBlocks.has(b.id))
    .map((block) => {
      const phis: Phi[] = block.phis.map((phi) => ({
        ...phi,
        inputs: phi.inputs.filter((inp) => executableEdges.has(`${inp.predecessor}->${block.id}`)),
      }));
      const instructions: Instruction[] = [];
      for (const ins of block.instructions) {
        if (ins.op === 'move') {
          const val = lattice.get(ins.dest);
          instructions.push({
            ...ins,
            value: val?.kind === 'const' ? { kind: 'constant', value: val.value } : resolveOp(ins.value),
          });
        } else if (ins.op === 'binary') {
          const val = lattice.get(ins.dest);
          if (val?.kind === 'const') {
            instructions.push({ op: 'move', dest: ins.dest, value: { kind: 'constant', value: val.value }, nodeId: ins.nodeId });
          } else {
            instructions.push({ ...ins, left: resolveOp(ins.left), right: resolveOp(ins.right) });
          }
        } else if (ins.op === 'print') {
          instructions.push({ ...ins, value: resolveOp(ins.value) });
        } else if (ins.op === 'branch') {
          const cond = resolveOp(ins.condition);
          if (cond.kind === 'constant' && typeof cond.value === 'boolean') {
            const chosen = dominance.graph.edges.find(
              (e) => e.from === block.id && e.kind === (cond.value ? 'true' : 'false'),
            );
            if (chosen) {
              instructions.push({ op: 'jump', target: chosen.to, nodeId: ins.nodeId });
            }
          } else {
            instructions.push({ ...ins, condition: cond });
          }
        } else {
          instructions.push({ ...ins });
        }
      }
      return { id: block.id, phis, instructions };
    });

  // Simplify trivial phis and pure copy moves iteratively.
  const simplifiedPhis: string[] = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (const block of optBlocks) {
      const keptPhis: Phi[] = [];
      for (const phi of block.phis) {
        const val = lattice.get(phi.dest);
        if (val?.kind === 'const') {
          subst.set(phi.dest, { kind: 'constant', value: val.value });
          simplifiedPhis.push(`${phiText(phi)}  ⇒  常量 ${val.value}`);
          changed = true;
          continue;
        }
        const resolvedInputs = phi.inputs.map((inp) => resolveOp({ kind: 'ref', name: inp.name }));
        const nonSelf = resolvedInputs.filter((op) => !(op.kind === 'ref' && op.name === phi.dest));
        if (nonSelf.length > 0) {
          const first = nonSelf[0];
          const allSame = nonSelf.every((op) =>
            first.kind === 'constant'
              ? op.kind === 'constant' && Object.is(op.value, first.value)
              : op.kind === 'ref' && op.name === first.name,
          );
          if (allSame) {
            subst.set(phi.dest, first);
            simplifiedPhis.push(`${phiText(phi)}  ⇒  ${first.kind === 'constant' ? first.value : first.name}`);
            changed = true;
            continue;
          }
        }
        keptPhis.push({
          ...phi,
          inputs: phi.inputs.map((inp) => {
            const r = resolveOp({ kind: 'ref', name: inp.name });
            return { predecessor: inp.predecessor, name: r.kind === 'ref' ? r.name : inp.name };
          }),
        });
      }
      block.phis = keptPhis;
      block.instructions = block.instructions.map((ins) => {
        if (ins.op === 'move') return { ...ins, value: resolveOp(ins.value) };
        if (ins.op === 'binary') return { ...ins, left: resolveOp(ins.left), right: resolveOp(ins.right) };
        if (ins.op === 'print') return { ...ins, value: resolveOp(ins.value) };
        if (ins.op === 'branch') return { ...ins, condition: resolveOp(ins.condition) };
        return ins;
      });
    }
  }

  record({
    kind: 'rewrite',
    message: `根据 SCCP 事实改写 SSA：删除 ${removedBlocks.length} 个不可达块，化简 ${simplifiedPhis.length} 个常量/平凡 φ，将常量条件分支改为无条件跳转。`,
  });

  // SSA Dead Code Elimination: trace live defs backward from print, branches, and potentially trapping arithmetic.
  const defMap = new Map<string, { blockId: string; kind: 'phi' | 'instr'; index: number }>();
  for (const block of optBlocks) {
    block.phis.forEach((phi, index) => defMap.set(phi.dest, { blockId: block.id, kind: 'phi', index }));
    block.instructions.forEach((ins, index) => {
      if ('dest' in ins) defMap.set(ins.dest, { blockId: block.id, kind: 'instr', index });
    });
  }

  const livePhis = new Set<string>();
  const liveInstrs = new Set<string>();
  const dceWorklist: string[] = [];

  const markVar = (name: string) => {
    const def = defMap.get(name);
    if (!def) return;
    const key = `${def.blockId}:${def.kind}:${def.index}`;
    if (def.kind === 'phi') {
      if (!livePhis.has(key)) {
        livePhis.add(key);
        dceWorklist.push(key);
      }
    } else if (!liveInstrs.has(key)) {
      liveInstrs.add(key);
      dceWorklist.push(key);
    }
  };

  const mayTrap = (ins: Instruction) =>
    ins.op === 'binary' && ['+', '-', '*', '/'].includes(ins.operator);

  for (const block of optBlocks) {
    block.instructions.forEach((ins, index) => {
      if (ins.op === 'print' || ins.op === 'branch' || ins.op === 'jump' || ins.op === 'label' || mayTrap(ins)) {
        const key = `${block.id}:instr:${index}`;
        liveInstrs.add(key);
        dceWorklist.push(key);
      }
    });
  }

  const optById = new Map(optBlocks.map((b) => [b.id, b]));
  while (dceWorklist.length) {
    const key = dceWorklist.shift()!;
    const [blockId, kind, idxStr] = key.split(':');
    const index = Number(idxStr);
    const block = optById.get(blockId)!;
    if (kind === 'phi') {
      block.phis[index].inputs.forEach((inp) => markVar(inp.name));
    } else {
      referencedVariables(block.instructions[index]).forEach(markVar);
    }
  }

  const removedInstructions: string[] = [];
  optBlocks = optBlocks.map((block) => {
    const phis = block.phis.filter((phi, index) => {
      const keep = livePhis.has(`${block.id}:phi:${index}`);
      if (!keep) removedInstructions.push(`${block.id}: ${phiText(phi)}`);
      return keep;
    });
    const instructions = block.instructions.filter((ins, index) => {
      const keep = liveInstrs.has(`${block.id}:instr:${index}`);
      if (!keep) removedInstructions.push(`${block.id}: ${instructionText(ins)}`);
      return keep;
    });
    return { id: block.id, phis, instructions };
  });

  const optEdges: SsaOptEdge[] = dominance.graph.edges
    .filter((e) => executableEdges.has(`${e.from}->${e.to}`))
    .map((e) => ({ from: e.from, to: e.to, kind: e.kind }));

  record({
    kind: 'dce',
    message: `基于 SSA def-use 链做死代码消除：删去 ${removedInstructions.length} 条无用定义或 φ（保留 print、活跃分支与可能除零/溢出的算术）。`,
  });

  const execution = executeOptimizedSSA(optBlocks, optEdges, dominance.entry);
  const afterCount = countOps(optBlocks);
  const equivalence: 'same' | 'different' | 'unknown' =
    baseline.limited || execution.limited
      ? 'unknown'
      : baseline.halted === execution.halted &&
          baseline.error?.message === execution.error &&
          baseline.output.length === execution.output.length &&
          baseline.output.every((v, i) => Object.is(v, execution.output[i]))
        ? 'same'
        : 'different';

  frames.push({
    kind: 'complete',
    cfgQueue: [],
    ssaQueue: [],
    executableBlocks: [...executableBlocks],
    lattice: snapLattice(),
    message:
      equivalence === 'same'
        ? `SSA 优化完成：φ 与指令从 ${beforeCount} 条精简为 ${afterCount} 条，共执行 ${sccpOperations} 次稀疏工作表处理；输出与错误和原 VM 一致。`
        : equivalence === 'unknown'
          ? '达到执行上限，暂不能判定完整行为等价。'
          : '优化后 SSA 与原 VM 执行结果不一致！',
  });

  return {
    valid: true,
    issues: [],
    lattice: Object.fromEntries(lattice),
    executableBlocks: [...executableBlocks],
    executableEdges: [...executableEdges],
    optimizedBlocks: optBlocks,
    optimizedEdges: optEdges,
    removedBlocks,
    simplifiedPhis,
    removedInstructions,
    sccpOperations,
    beforeCount,
    afterCount,
    execution,
    equivalence,
    frames,
    traceTruncated,
  };
}
