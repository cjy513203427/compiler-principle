import type { ControlEdge, ControlFlowGraph } from './cfg';
import {
  factText,
  joinFact,
  operandFact,
  referencedVariables,
  sameFact,
  type DataflowAnalysis,
  type Environment,
  type Fact,
} from './dataflow';
import { analyzeDominance, type DominanceAnalysis } from './dominance';
import { instructionText, operandText } from './ir';
import type { Bytecode, Instruction, Operand, Value } from './model';
import { evaluateBinary } from './operations';
import { compareVmExecutions, lowerSSA, type OutSsaAnalysis } from './outssa';
import { mayTrap } from './redundancy';
import { buildInterference, instructionLiveness } from './regalloc';
import {
  compareSSA,
  executeSSA,
  phiText,
  validateSSA,
  type Phi,
  type SsaAnalysis,
  type SsaBlock,
  type SsaExecution,
} from './ssa';
import { execute, generateBytecode, type Execution } from './vm';

const TOP: Fact = Object.freeze({ kind: 'overdefined' });
const MAX_SCCP_EVENTS = 20000;
const MAX_COALESCE_ROUNDS = 200;
const MAX_TRACE = 240;

type UseSite =
  | { kind: 'phi'; block: string; index: number }
  | { kind: 'inst'; block: string; index: number };

export interface SccpEvent {
  kind: 'edge' | 'phi' | 'inst' | 'branch';
  block: string;
  target?: string;
  variable?: string;
  previous?: string;
  next?: string;
  detail: string;
}

export interface SccpResult {
  converged: boolean;
  reachableBlocks: string[];
  executableEdges: string[];
  values: Environment;
  events: SccpEvent[];
  edgeVisits: number;
  valueEvaluations: number;
  denseBlockVisits?: number;
}

export interface DceRemoval {
  block: string;
  kind: 'phi' | 'inst';
  text: string;
  reason: string;
}

export interface CoalesceDecision {
  dest: string;
  source: string;
  status: 'merged' | 'interferes';
  mergedName?: string;
  conflict?: string;
  reason: string;
}

export interface SsaOptRun {
  instructions: Instruction[];
  bytecode: Bytecode[];
  execution: Execution;
  moveCount: number;
}

export interface SsaOptFrame {
  kind: 'initial' | 'sccp' | 'rewrite' | 'dce' | 'coalesce' | 'execute' | 'complete';
  block?: string;
  sccpEvent?: number;
  decision?: number;
  message: string;
}

export interface SsaOptAnalysis {
  valid: boolean;
  issues: string[];
  sccp: SccpResult;
  optimizedBlocks: SsaBlock[];
  optimizedEdges: ControlEdge[];
  optimizedDominance?: DominanceAnalysis;
  optimizedValidationIssues: string[];
  optimizedSsaExecution?: SsaExecution;
  foldedConstants: number;
  propagatedCopies: number;
  simplifiedPhis: number;
  removedBlocks: string[];
  dceRemovals: DceRemoval[];
  baseLowered?: OutSsaAnalysis;
  optimizedLowered?: OutSsaAnalysis;
  coalesceDecisions: CoalesceDecision[];
  mergedPairs: number;
  blockedPairs: number;
  uncoalescedRun?: SsaOptRun;
  coalescedRun?: SsaOptRun;
  frames: SsaOptFrame[];
  traceTruncated: boolean;
}

type CopyMove = Extract<Instruction, { op: 'move' }> & { value: { kind: 'ref'; name: string } };
const isCopyMove = (instruction: Instruction): instruction is CopyMove =>
  instruction.op === 'move' && instruction.value.kind === 'ref';

const countCopyMoves = (instructions: Instruction[]) =>
  instructions.filter((instruction) => isCopyMove(instruction) && instruction.dest !== instruction.value.name).length;

function replaceOperand(operand: Operand, map: Map<string, Operand>): Operand {
  if (operand.kind === 'constant') return operand;
  return map.get(operand.name) ?? operand;
}

function replaceInstructionOperands(instruction: Instruction, map: Map<string, Operand>): Instruction {
  switch (instruction.op) {
    case 'move':
    case 'print':
      return { ...instruction, value: replaceOperand(instruction.value, map) };
    case 'binary':
      return {
        ...instruction,
        left: replaceOperand(instruction.left, map),
        right: replaceOperand(instruction.right, map),
      };
    case 'branch':
      return { ...instruction, condition: replaceOperand(instruction.condition, map) };
    default:
      return { ...instruction };
  }
}

/** Sparse Conditional Constant Propagation (Wegman & Zadeck) over pruned SSA. */
export function runSCCP(
  ssa: Pick<SsaAnalysis, 'blocks'>,
  dominance: DominanceAnalysis,
  denseBlockVisits?: number,
): SccpResult {
  const byId = new Map(ssa.blocks.map((block) => [block.id, block]));
  const ids = new Set(ssa.blocks.map((block) => block.id));
  const edges = dominance.graph.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to));
  const outEdges = new Map<string, ControlEdge[]>(ssa.blocks.map((block) => [block.id, []]));
  const inEdges = new Map<string, ControlEdge[]>(ssa.blocks.map((block) => [block.id, []]));
  for (const edge of edges) {
    outEdges.get(edge.from)!.push(edge);
    inEdges.get(edge.to)!.push(edge);
  }

  // Build explicit def-use chains so lattice updates only wake direct consumers.
  const uses = new Map<string, UseSite[]>();
  const addUse = (name: string, site: UseSite) => {
    let list = uses.get(name);
    if (!list) {
      list = [];
      uses.set(name, list);
    }
    list.push(site);
  };
  for (const block of ssa.blocks) {
    block.phis.forEach((phi, index) => {
      for (const input of phi.inputs) addUse(input.name, { kind: 'phi', block: block.id, index });
    });
    block.instructions.forEach((instruction, index) => {
      for (const name of referencedVariables(instruction))
        addUse(name, { kind: 'inst', block: block.id, index });
    });
  }

  const values: Environment = {};
  const reachable = new Set<string>();
  const executable = new Set<string>();
  const flowWorklist: (ControlEdge | { entry: string })[] = [{ entry: dominance.entry }];
  const ssaWorklist: string[] = [];
  const inSsaQueue = new Set<string>();
  const events: SccpEvent[] = [];
  let edgeVisits = 0;
  let valueEvaluations = 0;
  let steps = 0;

  const enqueueEdge = (edge: ControlEdge) => {
    if (executable.has(edge.id)) return;
    executable.add(edge.id);
    flowWorklist.push(edge);
  };

  const updateFact = (
    name: string,
    next: Fact | undefined,
    block: string,
    kind: 'phi' | 'inst',
    detail: string,
  ) => {
    const previous = values[name];
    if (sameFact(previous, next)) return;
    if (next) values[name] = next;
    else delete values[name];
    if (!inSsaQueue.has(name)) {
      inSsaQueue.add(name);
      ssaWorklist.push(name);
    }
    events.push({
      kind,
      block,
      variable: name,
      previous: factText(previous),
      next: factText(next),
      detail,
    });
  };

  const evalPhi = (blockId: string, phi: Phi) => {
    valueEvaluations++;
    let merged: Fact | undefined;
    const activeInputs: string[] = [];
    for (const input of phi.inputs) {
      const hasExecutableEdge = inEdges
        .get(blockId)!
        .some((edge) => edge.from === input.predecessor && executable.has(edge.id));
      if (!hasExecutableEdge) continue;
      activeInputs.push(`${input.predecessor}:${input.name}=${factText(values[input.name])}`);
      merged = joinFact(merged, values[input.name]);
    }
    updateFact(
      phi.dest,
      merged,
      blockId,
      'phi',
      `${phiText(phi)} 只合并可执行入边（${activeInputs.join('，') || '无'}），得到 ${factText(merged)}。`,
    );
  };

  const evalInstruction = (blockId: string, instruction: Instruction) => {
    valueEvaluations++;
    if (instruction.op === 'move') {
      const next = operandFact(instruction.value, values);
      updateFact(
        instruction.dest,
        next,
        blockId,
        'inst',
        `${instructionText(instruction)} → ${instruction.dest} 的格值更新为 ${factText(next)}。`,
      );
    } else if (instruction.op === 'binary') {
      const left = operandFact(instruction.left, values);
      const right = operandFact(instruction.right, values);
      let next: Fact | undefined;
      if (left?.kind === 'overdefined' || right?.kind === 'overdefined') {
        next = TOP;
      } else if (left?.kind === 'constant' && right?.kind === 'constant') {
        try {
          next = { kind: 'constant', value: evaluateBinary(instruction.operator, left.value, right.value) };
        } catch {
          next = TOP; // Keep trapping division/overflow un-folded.
        }
      }
      updateFact(
        instruction.dest,
        next,
        blockId,
        'inst',
        next?.kind === 'constant'
          ? `${instructionText(instruction)} 两侧均为常量，折叠得到 ${factText(next)}。`
          : `${instructionText(instruction)} 的格值更新为 ${factText(next)}。`,
      );
    } else if (instruction.op === 'branch') {
      const cond = operandFact(instruction.condition, values);
      const outgoing = outEdges.get(blockId)!;
      if (cond?.kind === 'constant' && typeof cond.value === 'boolean') {
        const chosen = outgoing.find((edge) => edge.kind === (cond.value ? 'true' : 'false'));
        if (chosen && !executable.has(chosen.id)) {
          enqueueEdge(chosen);
          events.push({
            kind: 'branch',
            block: blockId,
            target: chosen.to,
            detail: `条件 ${operandText(instruction.condition)} 已知为 ${cond.value}：仅激活 ${blockId} → ${chosen.to}，另一条分支保持不可达。`,
          });
        }
      } else if (cond?.kind === 'overdefined') {
        const added: string[] = [];
        for (const edge of outgoing) {
          if (!executable.has(edge.id)) {
            enqueueEdge(edge);
            added.push(edge.to);
          }
        }
        if (added.length) {
          events.push({
            kind: 'branch',
            block: blockId,
            target: added.join('、'),
            detail: `条件 ${operandText(instruction.condition)} 为 ⊤：保守激活两条出边（${added.join('、')}）。`,
          });
        }
      }
    }
  };

  while ((flowWorklist.length || ssaWorklist.length) && steps < MAX_SCCP_EVENTS) {
    steps++;
    if (flowWorklist.length) {
      const item = flowWorklist.shift()!;
      edgeVisits++;
      const target = 'entry' in item ? item.entry : item.to;
      const firstVisit = !reachable.has(target);
      reachable.add(target);
      events.push({
        kind: 'edge',
        block: 'entry' in item ? target : item.from,
        target,
        detail:
          'entry' in item
            ? `从入口块 ${target} 启动稀疏工作表，无需先扫描不可达的基本块。`
            : `标记控制流边 ${item.from} → ${target} 为可执行${firstVisit ? `，首次进入 ${target}` : `，重新求值 ${target} 的 φ`}。`,
      });
      const block = byId.get(target)!;
      for (const phi of block.phis) evalPhi(target, phi);
      if (firstVisit) {
        for (const instruction of block.instructions) evalInstruction(target, instruction);
        const last = block.instructions.at(-1);
        if (last?.op !== 'branch') {
          for (const edge of outEdges.get(target)!) enqueueEdge(edge);
        }
      }
    } else {
      const name = ssaWorklist.shift()!;
      inSsaQueue.delete(name);
      for (const site of uses.get(name) ?? []) {
        if (!reachable.has(site.block)) continue;
        const block = byId.get(site.block)!;
        if (site.kind === 'phi') evalPhi(site.block, block.phis[site.index]);
        else evalInstruction(site.block, block.instructions[site.index]);
      }
    }
  }

  return {
    converged: flowWorklist.length === 0 && ssaWorklist.length === 0,
    reachableBlocks: ssa.blocks.map((block) => block.id).filter((id) => reachable.has(id)),
    executableEdges: edges.filter((edge) => executable.has(edge.id)).map((edge) => edge.id),
    values,
    events,
    edgeVisits,
    valueEvaluations,
    denseBlockVisits,
  };
}

function buildOptimizedCFG(
  blocks: SsaBlock[],
  executableEdges: ControlEdge[],
): { graph: ControlFlowGraph; dominance: DominanceAnalysis } {
  const flat: Instruction[] = [];
  const instructionBlock: string[] = [];
  const cfgBlocks: ControlFlowGraph['blocks'] = [];
  for (const block of blocks) {
    const start = flat.length;
    flat.push(...block.instructions);
    instructionBlock.push(...block.instructions.map(() => block.id));
    cfgBlocks.push({
      id: block.id,
      start,
      end: flat.length,
      instructions: block.instructions,
    });
  }
  const graph: ControlFlowGraph = { blocks: cfgBlocks, edges: executableEdges, instructionBlock };
  return { graph, dominance: analyzeDominance(graph) };
}

function rewriteAndPruneSSA(
  ssa: Pick<SsaAnalysis, 'blocks'>,
  dominance: DominanceAnalysis,
  sccp: SccpResult,
): {
  blocks: SsaBlock[];
  edges: ControlEdge[];
  optDominance: DominanceAnalysis;
  foldedConstants: number;
  propagatedCopies: number;
  simplifiedPhis: number;
  removedBlocks: string[];
  dceRemovals: DceRemoval[];
} {
  const reachableSet = new Set(sccp.reachableBlocks);
  const execEdgeSet = new Set(sccp.executableEdges);
  const removedBlocks = ssa.blocks.map((block) => block.id).filter((id) => !reachableSet.has(id));
  const rawEdges = dominance.graph.edges.filter(
    (edge) => reachableSet.has(edge.from) && reachableSet.has(edge.to) && execEdgeSet.has(edge.id),
  );
  const labelOf = new Map<string, string>();
  for (const block of ssa.blocks) {
    const first = block.instructions[0];
    if (first?.op === 'label') labelOf.set(block.id, first.name);
  }

  let foldedConstants = 0;
  let simplifiedPhis = 0;
  let propagatedCopies = 0;

  // Step 1: prune unreachable blocks/edges, simplify branches & constant instructions.
  const edges: ControlEdge[] = [];
  const blocks: SsaBlock[] = ssa.blocks
    .filter((block) => reachableSet.has(block.id))
    .map((block) => {
      const incomingPreds = [
        ...new Set(rawEdges.filter((edge) => edge.to === block.id).map((edge) => edge.from)),
      ];
      const outgoing = rawEdges.filter((edge) => edge.from === block.id);
      const nextPhis: Phi[] = [];
      const prepended: Instruction[] = [];
      for (const phi of block.phis) {
        const active = phi.inputs.filter((input) => incomingPreds.includes(input.predecessor));
        const fact = sccp.values[phi.dest];
        if (fact?.kind === 'constant') {
          simplifiedPhis++;
          prepended.push({
            op: 'move',
            dest: phi.dest,
            value: { kind: 'constant', value: fact.value },
            nodeId: -1,
          });
        } else if (active.length === 1) {
          simplifiedPhis++;
          prepended.push({
            op: 'move',
            dest: phi.dest,
            value: { kind: 'ref', name: active[0].name },
            nodeId: -1,
          });
        } else {
          nextPhis.push({ variable: phi.variable, dest: phi.dest, inputs: active });
        }
      }

      const nextInstructions: Instruction[] = [];
      for (const instruction of block.instructions) {
        if (instruction.op === 'label') {
          nextInstructions.push({ ...instruction });
          continue;
        }
        if (instruction.op === 'binary') {
          const fact = sccp.values[instruction.dest];
          if (fact?.kind === 'constant') {
            foldedConstants++;
            nextInstructions.push({
              op: 'move',
              dest: instruction.dest,
              value: { kind: 'constant', value: fact.value },
              nodeId: instruction.nodeId,
            });
            continue;
          }
        }
        if (instruction.op === 'branch' && outgoing.length === 1) {
          const only = outgoing[0];
          const targetLabel = labelOf.get(only.to) ?? `__ssaopt_${only.to}`;
          nextInstructions.push({ op: 'jump', target: targetLabel, nodeId: instruction.nodeId });
          continue;
        }
        nextInstructions.push({ ...instruction });
      }

      const hasLabel = nextInstructions[0]?.op === 'label';
      const combined = hasLabel
        ? [nextInstructions[0], ...prepended, ...nextInstructions.slice(1)]
        : [...prepended, ...nextInstructions];

      if (outgoing.length === 1 && block.instructions.at(-1)?.op === 'branch') {
        edges.push({ ...outgoing[0], kind: 'jump' });
      } else {
        edges.push(...outgoing.map((edge) => ({ ...edge })));
      }
      return { id: block.id, phis: nextPhis, instructions: combined };
    });

  const { dominance: optDominance } = buildOptimizedCFG(blocks, edges);

  const defBlockOf = () => {
    const map = new Map<string, string>();
    for (const block of blocks) {
      for (const phi of block.phis) map.set(phi.dest, block.id);
      for (const inst of block.instructions) if ('dest' in inst) map.set(inst.dest, block.id);
    }
    return map;
  };

  for (let round = 0; round < 32; round++) {
    let changed = false;
    const defBlock = defBlockOf();

    for (const block of blocks) {
      const kept: Phi[] = [];
      for (const phi of block.phis) {
        const nonSelf = [...new Set(phi.inputs.map((input) => input.name).filter((name) => name !== phi.dest))];
        if (nonSelf.length === 1) {
          const source = nonSelf[0];
          const sourceBlock = defBlock.get(source);
          if (sourceBlock && optDominance.dominators[block.id]?.includes(sourceBlock)) {
            simplifiedPhis++;
            const move: Instruction = {
              op: 'move',
              dest: phi.dest,
              value: { kind: 'ref', name: source },
              nodeId: -1,
            };
            const insertAt = block.instructions[0]?.op === 'label' ? 1 : 0;
            block.instructions.splice(insertAt, 0, move);
            changed = true;
            continue;
          }
        }
        kept.push(phi);
      }
      block.phis = kept;
    }

    const refForward = new Map<string, string>();
    const constForward = new Map<string, Value>();
    for (const block of blocks) {
      for (const inst of block.instructions) {
        if (inst.op === 'move') {
          if (inst.value.kind === 'ref' && inst.value.name !== inst.dest) {
            refForward.set(inst.dest, inst.value.name);
          } else if (inst.value.kind === 'constant') {
            constForward.set(inst.dest, inst.value.value);
          }
        }
      }
    }

    const resolveRef = (name: string): string => {
      const seen = new Set<string>();
      let cur = name;
      while (refForward.has(cur) && !seen.has(cur)) {
        seen.add(cur);
        cur = refForward.get(cur)!;
      }
      return cur;
    };

    const instOperandMap = new Map<string, Operand>();
    for (const [dest] of refForward) {
      const root = resolveRef(dest);
      if (constForward.has(root)) {
        instOperandMap.set(dest, { kind: 'constant', value: constForward.get(root)! });
      } else if (root !== dest) {
        instOperandMap.set(dest, { kind: 'ref', name: root });
      }
    }
    for (const [dest, val] of constForward) {
      if (!instOperandMap.has(dest)) instOperandMap.set(dest, { kind: 'constant', value: val });
    }

    for (const block of blocks) {
      for (const phi of block.phis) {
        for (const input of phi.inputs) {
          const resolved = resolveRef(input.name);
          if (resolved !== input.name) {
            input.name = resolved;
            propagatedCopies++;
            changed = true;
          }
        }
      }
      block.instructions = block.instructions.map((inst) => {
        const updated = replaceInstructionOperands(inst, instOperandMap);
        if (instructionText(updated) !== instructionText(inst)) {
          propagatedCopies++;
          changed = true;
        }
        return updated;
      });
    }

    for (const block of blocks) {
      block.instructions = block.instructions.map((inst) => {
        if (inst.op === 'binary' && inst.left.kind === 'constant' && inst.right.kind === 'constant') {
          try {
            const value = evaluateBinary(inst.operator, inst.left.value, inst.right.value);
            foldedConstants++;
            changed = true;
            return { op: 'move', dest: inst.dest, value: { kind: 'constant', value }, nodeId: inst.nodeId };
          } catch {
            return inst;
          }
        }
        return inst;
      });
    }

    if (!changed) break;
  }

  type DefSite = { kind: 'phi'; block: string; index: number } | { kind: 'inst'; block: string; index: number };
  const defOf = new Map<string, DefSite>();
  for (const block of blocks) {
    block.phis.forEach((phi, index) => defOf.set(phi.dest, { kind: 'phi', block: block.id, index }));
    block.instructions.forEach((inst, index) => {
      if ('dest' in inst) defOf.set(inst.dest, { kind: 'inst', block: block.id, index });
    });
  }

  const livePhis = new Set<string>();
  const liveInsts = new Set<string>();
  const queue: DefSite[] = [];
  const markVar = (name: string) => {
    const def = defOf.get(name);
    if (!def) return;
    const key = `${def.block}:${def.index}`;
    if (def.kind === 'phi') {
      if (!livePhis.has(key)) {
        livePhis.add(key);
        queue.push(def);
      }
    } else if (!liveInsts.has(key)) {
      liveInsts.add(key);
      queue.push(def);
    }
  };

  for (const block of blocks) {
    block.instructions.forEach((inst, index) => {
      const isRoot =
        inst.op === 'print' ||
        inst.op === 'label' ||
        inst.op === 'jump' ||
        inst.op === 'branch' ||
        mayTrap(inst);
      if (isRoot) {
        const key = `${block.id}:${index}`;
        liveInsts.add(key);
        for (const name of referencedVariables(inst)) markVar(name);
      }
    });
  }

  const blockById = new Map(blocks.map((block) => [block.id, block]));
  for (let i = 0; i < queue.length; i++) {
    const item = queue[i];
    const block = blockById.get(item.block)!;
    if (item.kind === 'phi') {
      const phi = block.phis[item.index];
      for (const input of phi.inputs) markVar(input.name);
    } else {
      const inst = block.instructions[item.index];
      for (const name of referencedVariables(inst)) markVar(name);
    }
  }

  const dceRemovals: DceRemoval[] = [];
  for (const block of blocks) {
    block.phis = block.phis.filter((phi, index) => {
      if (livePhis.has(`${block.id}:${index}`)) return true;
      dceRemovals.push({
        block: block.id,
        kind: 'phi',
        text: phiText(phi),
        reason: `${phi.dest} 不影响任何 print、分支条件或可能报错的运算，稀疏死代码删除直接移除了这个 φ。`,
      });
      return false;
    });
    block.instructions = block.instructions.filter((inst, index) => {
      if (liveInsts.has(`${block.id}:${index}`)) return true;
      dceRemovals.push({
        block: block.id,
        kind: 'inst',
        text: instructionText(inst),
        reason: `${'dest' in inst ? inst.dest : ''} 既无后续使用也不会触发运行时异常，直接清理。`,
      });
      return false;
    });
  }

  const rebuilt = buildOptimizedCFG(blocks, edges);
  return {
    blocks,
    edges,
    optDominance: rebuilt.dominance,
    foldedConstants,
    propagatedCopies,
    simplifiedPhis,
    removedBlocks,
    dceRemovals,
  };
}

function chooseRepresentative(dest: string, source: string): [string, string] {
  const rank = (name: string) => {
    if (name.startsWith('__phi_tmp')) return 3;
    if (/^t\d+/.test(name)) return 2;
    return 1;
  };
  const rDest = rank(dest);
  const rSrc = rank(source);
  if (rSrc !== rDest) return rSrc < rDest ? [source, dest] : [dest, source];
  const split = (name: string) => {
    const dot = name.lastIndexOf('.');
    return dot > 0 ? ([name.slice(0, dot), Number(name.slice(dot + 1))] as const) : ([name, Infinity] as const);
  };
  const [baseD, verD] = split(dest);
  const [baseS, verS] = split(source);
  if (baseD === baseS && Number.isFinite(verD) && Number.isFinite(verS)) {
    return verS <= verD ? [source, dest] : [dest, source];
  }
  return source <= dest ? [source, dest] : [dest, source];
}

function renameInCode(code: Instruction[], from: string, to: string): Instruction[] {
  const renameOp = (op: Operand): Operand =>
    op.kind === 'ref' && op.name === from ? { kind: 'ref', name: to } : op;
  const out: Instruction[] = [];
  for (const inst of code) {
    let next: Instruction;
    switch (inst.op) {
      case 'move':
        next = { ...inst, dest: inst.dest === from ? to : inst.dest, value: renameOp(inst.value) };
        if (next.value.kind === 'ref' && next.dest === next.value.name) continue;
        break;
      case 'binary':
        next = {
          ...inst,
          dest: inst.dest === from ? to : inst.dest,
          left: renameOp(inst.left),
          right: renameOp(inst.right),
        };
        break;
      case 'print':
        next = { ...inst, value: renameOp(inst.value) };
        break;
      case 'branch':
        next = { ...inst, condition: renameOp(inst.condition) };
        break;
      default:
        next = { ...inst };
    }
    out.push(next);
  }
  return out;
}

function findConflictInstruction(
  code: Instruction[],
  liveOut: string[][],
  a: string,
  b: string,
): string | undefined {
  for (let i = 0; i < code.length; i++) {
    const inst = code[i];
    const dest = 'dest' in inst ? inst.dest : undefined;
    if (!dest) continue;
    const copySrc = isCopyMove(inst) ? inst.value.name : undefined;
    if (dest === a && copySrc !== b && liveOut[i].includes(b)) {
      return `在 #${i}（${instructionText(inst)}）写入 ${a} 时，${b} 之后还要被读取`;
    }
    if (dest === b && copySrc !== a && liveOut[i].includes(a)) {
      return `在 #${i}（${instructionText(inst)}）写入 ${b} 时，${a} 之后还要被读取`;
    }
  }
  return undefined;
}

/** Conservative copy coalescing guarded by exact instruction-level liveness & interference. */
export function coalesceCopies(instructions: Instruction[]): {
  code: Instruction[];
  decisions: CoalesceDecision[];
  mergedPairs: number;
  blockedPairs: number;
} {
  let code = instructions.map((inst) => ({ ...inst }));
  const decisions: CoalesceDecision[] = [];
  const reportedBlocked = new Set<string>();
  let mergedPairs = 0;
  let blockedPairs = 0;

  for (let round = 0; round < MAX_COALESCE_ROUNDS; round++) {
    const liveness = instructionLiveness(code);
    if (!liveness.converged) break;
    const graph = buildInterference(code, liveness);
    const seenPairs = new Set<string>();
    let mergedThisRound = false;

    for (const inst of code) {
      if (!isCopyMove(inst) || inst.dest === inst.value.name) continue;
      const dest = inst.dest;
      const source = inst.value.name;
      const pairKey = dest < source ? `${dest}|${source}` : `${source}|${dest}`;
      if (seenPairs.has(pairKey)) continue;
      seenPairs.add(pairKey);

      const interferes = graph.adjacency[dest]?.includes(source) ?? false;
      if (interferes) {
        if (!reportedBlocked.has(pairKey)) {
          reportedBlocked.add(pairKey);
          blockedPairs++;
          const conflict = findConflictInstruction(code, liveness.liveOut, dest, source);
          decisions.push({
            dest,
            source,
            status: 'interferes',
            conflict,
            reason: conflict
              ? `拒绝合并 ${dest} ← ${source}：两者存在干涉（${conflict}），合并会破坏旧值！`
              : `拒绝合并 ${dest} ← ${source}：两者同时活跃，不能共享同一变量位置。`,
          });
        }
        continue;
      }

      const [keep, drop] = chooseRepresentative(dest, source);
      code = renameInCode(code, drop, keep);
      mergedPairs++;
      decisions.push({
        dest,
        source,
        status: 'merged',
        mergedName: keep,
        reason: `${dest} 与 ${source} 在干涉图中无边：合并为 ${keep}，复制 ${dest} ← ${source} 变为自身复制并删去。`,
      });
      mergedThisRound = true;
      break;
    }

    if (!mergedThisRound) break;
  }

  return { code, decisions, mergedPairs, blockedPairs };
}

function runIr(instructions: Instruction[]): SsaOptRun {
  const bytecode = generateBytecode(instructions);
  const execution = execute(bytecode);
  return { instructions, bytecode, execution, moveCount: countCopyMoves(instructions) };
}

export function optimizeSSA(
  ssa: SsaAnalysis,
  dominance: DominanceAnalysis,
  dataflow?: DataflowAnalysis,
): SsaOptAnalysis {
  const emptySccp: SccpResult = {
    converged: false,
    reachableBlocks: [],
    executableEdges: [],
    values: {},
    events: [],
    edgeVisits: 0,
    valueEvaluations: 0,
    denseBlockVisits: dataflow ? dataflow.steps.filter((step) => step.kind === 'visit').length : undefined,
  };
  const result: SsaOptAnalysis = {
    valid: false,
    issues: [],
    sccp: emptySccp,
    optimizedBlocks: [],
    optimizedEdges: [],
    optimizedValidationIssues: [],
    foldedConstants: 0,
    propagatedCopies: 0,
    simplifiedPhis: 0,
    removedBlocks: [],
    dceRemovals: [],
    coalesceDecisions: [],
    mergedPairs: 0,
    blockedPairs: 0,
    frames: [],
    traceTruncated: false,
  };

  const push = (frame: SsaOptFrame) => {
    if (result.frames.length < MAX_TRACE) result.frames.push(frame);
    else result.traceTruncated = true;
  };
  const fail = (message: string) => {
    result.issues.push(message);
    result.frames.push({ kind: 'complete', message });
    return result;
  };

  if (!ssa.valid || !dominance.converged) {
    return fail('输入 SSA 或支配分析未通过校验，不进行 SSA 优化与复制合并。');
  }

  const denseVisits = dataflow ? dataflow.steps.filter((step) => step.kind === 'visit').length : undefined;
  push({
    kind: 'initial',
    block: dominance.entry,
    message:
      '从校验通过的标量 SSA 出发：先用稀疏条件常量传播（SCCP）沿可执行边和 def-use 链求解，再做复制传播与稀疏死代码删除，最后在消除 φ 时做干涉图保护的保守复制合并。',
  });

  const sccp = runSCCP(ssa, dominance, denseVisits);
  result.sccp = sccp;
  if (!sccp.converged) {
    return fail('稀疏条件常量传播超过步数上限，保留原始 SSA。');
  }

  sccp.events.forEach((event, index) =>
    push({ kind: 'sccp', block: event.block, sccpEvent: index, message: event.detail }),
  );

  const rewritten = rewriteAndPruneSSA(ssa, dominance, sccp);
  result.optimizedBlocks = rewritten.blocks;
  result.optimizedEdges = rewritten.edges;
  result.optimizedDominance = rewritten.optDominance;
  result.foldedConstants = rewritten.foldedConstants;
  result.propagatedCopies = rewritten.propagatedCopies;
  result.simplifiedPhis = rewritten.simplifiedPhis;
  result.removedBlocks = rewritten.removedBlocks;
  result.dceRemovals = rewritten.dceRemovals;

  push({
    kind: 'rewrite',
    block: dominance.entry,
    message: `按 SCCP 改写并做 SSA 复制传播：裁剪 ${rewritten.removedBlocks.length} 个不可达块、化简 ${rewritten.simplifiedPhis} 个 φ、折叠 ${rewritten.foldedConstants} 处常量、传播 ${rewritten.propagatedCopies} 次复制。`,
  });

  if (rewritten.dceRemovals.length) {
    push({
      kind: 'dce',
      block: rewritten.dceRemovals[0].block,
      message: `稀疏死代码删除：从 print、分支和可能报错的算术反向沿唯一定义标记，清理了 ${rewritten.dceRemovals.length} 条无用定义或 φ。`,
    });
  } else {
    push({
      kind: 'dce',
      block: dominance.entry,
      message: '稀疏死代码删除：剩余指令与 φ 全部影响输出、控制流或可能报错的运算，没有可删除项。',
    });
  }

  const optIssues = validateSSA(rewritten.blocks, rewritten.optDominance);
  result.optimizedValidationIssues = optIssues;
  if (optIssues.length) {
    return fail(`优化后的 SSA 校验失败：${optIssues.join(' ')}`);
  }

  result.optimizedSsaExecution = executeSSA(rewritten.blocks, rewritten.optDominance);

  result.baseLowered = lowerSSA(ssa, dominance);
  const optLowered = lowerSSA({ valid: true, blocks: rewritten.blocks }, rewritten.optDominance);
  result.optimizedLowered = optLowered;
  if (!optLowered.valid) {
    return fail(`优化后 SSA 消除失败：${optLowered.issues.join(' ')}`);
  }

  result.uncoalescedRun = runIr(optLowered.instructions);
  const coalesced = coalesceCopies(optLowered.instructions);
  result.coalesceDecisions = coalesced.decisions;
  result.mergedPairs = coalesced.mergedPairs;
  result.blockedPairs = coalesced.blockedPairs;

  const finalLiveness = instructionLiveness(coalesced.code);
  if (!finalLiveness.converged || finalLiveness.liveIn[0]?.length) {
    return fail(`复制合并后入口出现未定义读取（${finalLiveness.liveIn[0]?.join(', ') || '未收敛'}），撤销结果。`);
  }

  coalesced.decisions.forEach((decision, index) =>
    push({ kind: 'coalesce', decision: index, message: decision.reason }),
  );
  if (!coalesced.decisions.length) {
    push({
      kind: 'coalesce',
      message: '消除 φ 后没有多余的变量间复制需要合并。',
    });
  }

  result.coalescedRun = runIr(coalesced.code);
  result.valid = true;

  const baseMoves = result.baseLowered.valid ? countCopyMoves(result.baseLowered.instructions) : 0;
  push({
    kind: 'execute',
    message: `交给 SSA 解释器与原栈式 VM 真实执行：变量间复制从基础消除的 ${baseMoves} 条降至合并后的 ${result.coalescedRun.moveCount} 条（合并 ${coalesced.mergedPairs} 对，因干涉拒绝 ${coalesced.blockedPairs} 对）。`,
  });

  const limited =
    result.optimizedSsaExecution.limited ||
    result.uncoalescedRun.execution.limited ||
    result.coalescedRun.execution.limited;
  const err = result.coalescedRun.execution.error?.message;
  result.frames.push({
    kind: 'complete',
    message: limited
      ? '至少一个版本达到 2000 步执行上限；只比较输出前缀，暂不能判定行为一致。'
      : err
        ? `执行停止：${err}。各版本均在相同位置保留了该错误。`
        : '四版本执行结束：可以对照稀疏工作量、优化后 SSA、复制合并决策与 VM 输出。',
  });

  return result;
}

export function compareAllSsaOptRuns(
  baseline: Execution,
  originalSsa: SsaExecution,
  analysis: SsaOptAnalysis,
): 'same' | 'different' | 'unknown' {
  if (!analysis.valid || !analysis.optimizedSsaExecution || !analysis.uncoalescedRun || !analysis.coalescedRun) {
    return 'unknown';
  }
  const checks = [
    compareSSA(baseline, originalSsa),
    compareSSA(baseline, analysis.optimizedSsaExecution),
    compareVmExecutions(baseline, analysis.uncoalescedRun.execution),
    compareVmExecutions(baseline, analysis.coalescedRun.execution),
  ];
  if (checks.includes('different')) return 'different';
  if (checks.includes('unknown')) return 'unknown';
  return 'same';
}
