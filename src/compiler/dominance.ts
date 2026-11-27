import { T } from '../i18n';
import type { ControlFlowGraph } from './cfg';

export interface DominanceStep {
  kind: 'initial' | 'visit' | 'complete';
  iteration: number;
  block: string;
  previous: string[];
  current: string[];
  removed: string[];
  predecessors: { block: string; dominators: string[] }[];
  message: string;
}
export interface NaturalLoop {
  header: string;
  latches: string[];
  nodes: string[];
  backEdges: string[];
  exitingEdges: string[];
  exitBlocks: string[];
  preheader?: string;
  parent?: string;
}
export interface DominanceAnalysis {
  graph: ControlFlowGraph;
  entry: string;
  reachable: string[];
  dominators: Record<string, string[]>;
  immediate: Record<string, string | undefined>;
  frontier: Record<string, string[]>;
  definitions: Record<string, string[]>;
  phiCandidates: Record<string, string[]>;
  loops: NaturalLoop[];
  steps: DominanceStep[];
  iterations: number;
  converged: boolean;
  traceTruncated: boolean;
}
const MAX_PASSES = 200;
const MAX_TRACE = 240;

/** A structural CFG path, optionally excluding one node. No VM trace or constant facts. */
export function findCFGPath(
  graph: ControlFlowGraph,
  target: string,
  avoid?: string,
): string[] | undefined {
  const entry = graph.blocks[0]?.id;
  if (!entry || entry === avoid) return undefined;
  const queue = [entry];
  const parent = new Map<string, string | undefined>([[entry, undefined]]);
  for (let i = 0; i < queue.length; i++) {
    const current = queue[i];
    if (current === target) {
      const path = [current];
      while (parent.get(path[0]) !== undefined) path.unshift(parent.get(path[0])!);
      return path;
    }
    for (const edge of graph.edges.filter((item) => item.from === current)) {
      if (edge.to === avoid || parent.has(edge.to)) continue;
      parent.set(edge.to, current);
      queue.push(edge.to);
    }
  }
  return undefined;
}

/** Iterated dominance frontier, intentionally unpruned: candidates, not a complete SSA form. */
export function iteratedFrontier(
  definitions: string[],
  frontier: Record<string, string[]>,
): string[] {
  const candidates = new Set<string>();
  const processed = new Set<string>();
  const queue = [...definitions];
  for (let i = 0; i < queue.length; i++) {
    const block = queue[i];
    if (processed.has(block)) continue;
    processed.add(block);
    for (const target of frontier[block] || []) {
      if (candidates.has(target)) continue;
      candidates.add(target);
      queue.push(target); // A candidate phi itself defines the variable.
    }
  }
  return [...candidates];
}

export function analyzeDominance(
  graph: ControlFlowGraph,
  settings: { maxPasses?: number; reverse?: boolean } = {},
): DominanceAnalysis {
  const ids = graph.blocks.map((block) => block.id);
  if (!ids.length) throw new Error(T('支配分析需要一个入口块。'));
  const entry = ids[0];
  const predecessors = Object.fromEntries(
    ids.map((id) => [
      id,
      [...new Set(graph.edges.filter((edge) => edge.to === id).map((edge) => edge.from))],
    ]),
  );
  const reachableSet = new Set([entry]);
  const queue = [entry];
  for (let i = 0; i < queue.length; i++) {
    for (const edge of graph.edges.filter((item) => item.from === queue[i])) {
      if (!reachableSet.has(edge.to)) {
        reachableSet.add(edge.to);
        queue.push(edge.to);
      }
    }
  }
  const ordered = (values: Iterable<string>) => {
    const set = new Set(values);
    return ids.filter((id) => set.has(id));
  };
  const reachable = ordered(reachableSet);
  const dom = Object.fromEntries(
    ids.map((id) => [id, new Set(id === entry ? [entry] : reachableSet.has(id) ? reachable : [])]),
  );
  const steps: DominanceStep[] = [
    {
      kind: 'initial',
      iteration: 0,
      block: entry,
      previous: [],
      current: [entry],
      removed: [],
      predecessors: [],
      message: T(
        '入口 {#0} 只由自身支配。其余入口可达块从全部可达块开始，逐轮取前驱集合的交集。',
        entry,
      ),
    },
  ];
  let iterations = 0;
  let converged = reachable.length === 1;
  let traceTruncated = false;
  const order = settings.reverse ? [...reachable].reverse() : reachable;
  const requested = settings.maxPasses ?? MAX_PASSES;
  const limit = Number.isFinite(requested)
    ? Math.max(0, Math.min(MAX_PASSES, Math.floor(requested)))
    : MAX_PASSES;
  for (let pass = 1; pass <= limit && !converged; pass++) {
    iterations = pass;
    let changed = false;
    for (const block of order) {
      if (block === entry) continue;
      const incoming = predecessors[block].filter((id) => reachableSet.has(id));
      const before = ordered(dom[block]);
      const inputs = incoming.map((id) => ({ block: id, dominators: ordered(dom[id]) }));
      const intersection = incoming.length
        ? [...dom[incoming[0]]].filter((id) => incoming.every((pred) => dom[pred].has(id)))
        : [];
      const next = new Set([...intersection, block]);
      const removed = before.filter((id) => !next.has(id));
      dom[block] = next;
      if (removed.length) changed = true;
      if (steps.length <= MAX_TRACE)
        steps.push({
          kind: 'visit',
          iteration: pass,
          block,
          previous: before,
          current: ordered(next),
          removed,
          predecessors: inputs,
          message: removed.length
            ? T(
                '第 {#0} 轮处理 {#1}：合并 {#2} 的支配集合，再加入 {#1}。移除候选 {#3}。',
                pass,
                block,
                incoming.join(T('、')),
                removed.join(T('、')),
              )
            : T(
                '第 {#0} 轮处理 {#1}：合并 {#2} 的支配集合，再加入 {#1}。集合不变。',
                pass,
                block,
                incoming.join(T('、')),
              ),
        });
      else traceTruncated = true;
    }
    converged = !changed;
  }
  const dominators = Object.fromEntries(ids.map((id) => [id, ordered(dom[id])]));
  const immediate: DominanceAnalysis['immediate'] = {};
  const frontier = Object.fromEntries(ids.map((id) => [id, [] as string[]]));
  const definitions: Record<string, string[]> = {};
  const phiCandidates: Record<string, string[]> = {};
  const loops: NaturalLoop[] = [];
  if (converged) {
    for (const block of reachable) {
      const strict = dominators[block].filter((id) => id !== block);
      immediate[block] = strict.find((candidate) =>
        strict.every((other) => dom[candidate].has(other)),
      );
    }
    // y ∈ DF(x) iff x dominates a reachable predecessor of y, but does not strictly dominate y.
    for (const x of reachable) {
      frontier[x] = reachable.filter(
        (y) =>
          (x === y || !dom[y].has(x)) &&
          predecessors[y].some((pred) => reachableSet.has(pred) && dom[pred].has(x)),
      );
    }
    for (const block of graph.blocks.filter((item) => reachableSet.has(item.id))) {
      for (const instruction of block.instructions) {
        if (!('dest' in instruction)) continue;
        definitions[instruction.dest] ??= [];
        if (!definitions[instruction.dest].includes(block.id))
          definitions[instruction.dest].push(block.id);
      }
    }
    for (const [variable, sites] of Object.entries(definitions))
      phiCandidates[variable] = ordered(iteratedFrontier(sites, frontier));
    const grouped = new Map<
      string,
      { nodes: Set<string>; latches: Set<string>; edges: Set<string> }
    >();
    for (const edge of graph.edges) {
      if (!reachableSet.has(edge.from) || !dom[edge.from].has(edge.to)) continue;
      const header = edge.to;
      const group = grouped.get(header) || {
        nodes: new Set([header]),
        latches: new Set<string>(),
        edges: new Set<string>(),
      };
      group.latches.add(edge.from);
      group.edges.add(edge.id);
      const pending = edge.from === header ? [] : [edge.from];
      const local = new Set([header]);
      while (pending.length) {
        const node = pending.pop()!;
        if (local.has(node)) continue;
        local.add(node);
        for (const pred of predecessors[node])
          if (reachableSet.has(pred) && !local.has(pred)) pending.push(pred);
      }
      local.forEach((node) => group.nodes.add(node));
      grouped.set(header, group);
    }
    for (const [header, group] of grouped) {
      const entering = predecessors[header].filter(
        (id) => reachableSet.has(id) && !group.nodes.has(id),
      );
      const exiting = graph.edges.filter(
        (edge) => group.nodes.has(edge.from) && !group.nodes.has(edge.to),
      );
      const preheader =
        entering.length === 1 &&
        graph.edges.filter((edge) => edge.from === entering[0]).every((edge) => edge.to === header)
          ? entering[0]
          : undefined;
      loops.push({
        header,
        nodes: ordered(group.nodes),
        latches: ordered(group.latches),
        backEdges: [...group.edges],
        exitingEdges: exiting.map((edge) => edge.id),
        exitBlocks: ordered(exiting.map((edge) => edge.to)),
        preheader,
      });
    }
    loops.sort((a, b) => ids.indexOf(a.header) - ids.indexOf(b.header));
    for (const loop of loops)
      loop.parent = loops
        .filter(
          (other) =>
            other.nodes.length > loop.nodes.length &&
            loop.nodes.every((id) => other.nodes.includes(id)),
        )
        .sort((a, b) => a.nodes.length - b.nodes.length)[0]?.header;
  }
  steps.push({
    kind: 'complete',
    iteration: iterations,
    block: entry,
    previous: [],
    current: [entry],
    removed: [],
    predecessors: [],
    message: converged
      ? T(
          '支配集合在 {#0} 轮后收敛。识别到 {#1} 个自然循环；现在可以检查支配树、绕行路径和 φ 候选位置。',
          iterations,
          loops.length,
        )
      : T('达到 {#0} 轮分析上限，尚未收敛；不发布直接支配、循环与 φ 候选结论。', limit),
  });
  return {
    graph,
    entry,
    reachable,
    dominators,
    immediate,
    frontier,
    definitions,
    phiCandidates,
    loops,
    steps,
    iterations,
    converged,
    traceTruncated,
  };
}
