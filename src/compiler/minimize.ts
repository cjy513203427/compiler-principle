import {
  AUTOMATA_LIMITS,
  AutomataError,
  UNIVERSE,
  buildDfa,
  buildNfa,
  dfaNext,
  normalizeRanges,
  parseSpec,
  scan,
  type AutomataIssue,
  type AutomataSpec,
  type CharRange,
  type Dfa,
  type ScanResult,
} from './automata';

/** -1 is the implicit rejecting sink; it is added only when reachable. */
export const DEAD = -1;
export const stateText = (state: number) => state === DEAD ? 'Dead' : `D${state}`;
export interface TotalMachine {
  states: number[];
  alphabet: CharRange[];
  transitions: Record<number, number[]>;
  accept: Record<number, number | undefined>;
  unreachable: number[];
}
export interface RefinementFrame {
  kind: 'initial' | 'split' | 'complete' | 'limit';
  message: string;
  groups: number[][];
  previous?: number[][];
  split?: number[];
  pieces?: number[][];
  evidence?: { left: number; right: number; code: number; leftGroup: number; rightGroup: number };
}
export interface DfaMinimization {
  machine: TotalMachine;
  frames: RefinementFrame[];
  groups: number[][];
  minimized: Dfa;
  mapping: Record<number, number | undefined>;
  members: number[][];
  removed: number[];
}
export interface Distinction {
  equivalent: boolean;
  suffix?: string;
  trace: { code?: number; left: number; right: number }[];
  checkedPairs: number;
}

/** Partition the entire supported alphabet, including symbols absent from all regex edges. */
function alphabetClasses(dfa: Dfa): CharRange[] {
  const points = dfa.edges.flatMap((edge) => edge.ranges.flatMap(([lo, hi]) => [lo, hi + 1]));
  return UNIVERSE.flatMap(([lo, hi]) => {
    const cuts = [...new Set([lo, hi + 1, ...points.filter((point) => point > lo && point <= hi)])]
      .sort((a, b) => a - b);
    return cuts.slice(0, -1).map((start, i): CharRange => [start, cuts[i + 1] - 1]);
  });
}

export function completeMachine(dfa: Dfa): TotalMachine {
  if (!dfa.complete || !dfa.states.length || dfa.states.length > AUTOMATA_LIMITS.dfaStates)
    throw new Error('只对完整构造且不超过 64 个状态的 DFA 求最小化。');
  const alphabet = alphabetClasses(dfa);
  const states = [0];
  const seen = new Set(states);
  const transitions: TotalMachine['transitions'] = {};
  const accept: TotalMachine['accept'] = {};
  for (let i = 0; i < states.length; i++) {
    const state = states[i];
    accept[state] = state === DEAD ? undefined : dfa.states[state].accept;
    transitions[state] = alphabet.map(([code]) => state === DEAD ? DEAD : dfaNext(dfa, state, code) ?? DEAD);
    for (const target of transitions[state]) {
      if (seen.has(target)) continue;
      seen.add(target);
      states.push(target);
    }
  }
  return { states, alphabet, transitions, accept, unreachable: dfa.states.map((state) => state.id).filter((id) => !seen.has(id)) };
}

/** Moore-style refinement: outputs are winning rule IDs, not merely accept/reject bits. */
export function minimizeDfa(dfa: Dfa): DfaMinimization {
  const machine = completeMachine(dfa);
  const initial = new Map<number | undefined, number[]>();
  for (const state of machine.states) {
    const output = machine.accept[state];
    if (!initial.has(output)) initial.set(output, []);
    initial.get(output)!.push(state);
  }
  let groups = [...initial.values()];
  const copy = () => groups.map((group) => [...group]);
  const frames: RefinementFrame[] = [{
    kind: 'initial', groups: copy(),
    message: `先删除 ${machine.unreachable.length} 个入口不可达状态，按“拒绝 / 获胜规则编号”分成 ${groups.length} 组。${machine.states.includes(DEAD) ? '缺失转换补到 Dead，它对所有字符回到自身。' : '全部转换已定义，Dead 不可达，无需加入。'}`,
  }];
  for (;;) {
    const groupOf = new Map(groups.flatMap((group, index) => group.map((state) => [state, index] as const)));
    let changed = false;
    for (let index = 0; index < groups.length; index++) {
      const group = groups[index];
      const signatures = new Map<string, number[]>();
      for (const state of group) {
        const key = machine.transitions[state].map((target) => groupOf.get(target)).join(',');
        if (!signatures.has(key)) signatures.set(key, []);
        signatures.get(key)!.push(state);
      }
      if (signatures.size === 1) continue;
      const pieces = [...signatures.values()];
      const left = pieces[0][0], right = pieces[1][0];
      const character = machine.alphabet.findIndex((_, i) =>
        groupOf.get(machine.transitions[left][i]) !== groupOf.get(machine.transitions[right][i]));
      const previous = copy();
      groups = [...groups.slice(0, index), ...pieces, ...groups.slice(index + 1)];
      frames.push({ kind: 'split', groups: copy(), previous, split: [...group], pieces,
        evidence: { left, right, code: machine.alphabet[character][0],
          leftGroup: groupOf.get(machine.transitions[left][character])!,
          rightGroup: groupOf.get(machine.transitions[right][character])! },
        message: `拆开第 ${index + 1} 组：${group.map(stateText).join('、')} 的后继分组签名不相同，分为 ${pieces.length} 组。分组只会细化，不会重新合并。` });
      changed = true;
      break; // Recompute all signatures against the new partition.
    }
    if (!changed) break;
  }
  const deadGroup = groups.find((group) => group.includes(DEAD));
  // Drop the rejecting sink class when exporting the partial lexer DFA. An empty-language
  // start state must remain, even if it belongs to this class.
  const kept = groups.filter((group) => group !== deadGroup || group.includes(0));
  kept.sort((left, right) => Number(right.includes(0)) - Number(left.includes(0)));
  const mapping: DfaMinimization['mapping'] = {};
  kept.forEach((group, index) => group.forEach((state) => { mapping[state] = index; }));
  const minimized: Dfa = { states: [], edges: [], complete: true, classes: machine.alphabet.length };
  kept.forEach((group, id) => {
    const representative = group.find((state) => state !== DEAD) ?? DEAD;
    const accept = machine.accept[representative];
    minimized.states.push({ id, accept, candidates: accept === undefined ? [] : [accept], nfa: [] });
    const edges = new Map<number, CharRange[]>();
    machine.alphabet.forEach((range, index) => {
      const target = machine.transitions[representative][index];
      if (deadGroup?.includes(target)) return;
      const to = mapping[target];
      if (to === undefined) throw new Error('最小化结果缺少后继分组。');
      if (!edges.has(to)) edges.set(to, []);
      edges.get(to)!.push(range);
    });
    for (const [to, ranges] of edges) minimized.edges.push({ from: id, to, ranges: normalizeRanges(ranges) });
  });
  const removed = deadGroup?.filter((state) => state !== DEAD && !kept.includes(deadGroup)) || [];
  const exportMessage = !deadGroup ? '不存在可达 Dead，直接导出稳定组'
    : deadGroup.includes(0) ? 'Dead 类包含入口，保留一个拒绝入口并省略失败边'
      : '导出扫描器时省略 Dead 类和指向它的边';
  frames.push({ kind: 'complete', groups: copy(),
    message: `分组稳定：每组对每类字符都进入同一个后继组。完整机有 ${groups.length} 个等价类；${exportMessage}，保留 ${minimized.states.length} 个状态。` });
  return { machine, frames, groups, minimized, mapping, members: kept.map((group) => group.filter((state) => state !== DEAD)), removed };
}

/** BFS on the finite product gives a shortest distinguishing suffix, or exhausts all pairs. */
function searchPairs(
  alphabet: number[], startLeft: number, startRight: number,
  outputLeft: (state: number) => number | undefined,
  outputRight: (state: number) => number | undefined,
  nextLeft: (state: number, code: number) => number,
  nextRight: (state: number, code: number) => number,
): Distinction {
  const queue: { left: number; right: number; parent?: number; code?: number }[] = [{ left: startLeft, right: startRight }];
  const seen = new Set([`${startLeft},${startRight}`]);
  for (let index = 0; index < queue.length; index++) {
    const current = queue[index];
    if (outputLeft(current.left) !== outputRight(current.right)) {
      const trace: Distinction['trace'] = [];
      let cursor: number | undefined = index;
      while (cursor !== undefined) {
        const item: typeof current = queue[cursor];
        trace.unshift({ left: item.left, right: item.right, code: item.code });
        cursor = item.parent;
      }
      return { equivalent: false, suffix: trace.slice(1).map((item) => String.fromCharCode(item.code!)).join(''), trace, checkedPairs: index + 1 };
    }
    for (const code of alphabet) {
      const left = nextLeft(current.left, code), right = nextRight(current.right, code);
      const key = `${left},${right}`;
      if (seen.has(key)) continue;
      seen.add(key);
      queue.push({ left, right, code, parent: index });
    }
  }
  return { equivalent: true, trace: [], checkedPairs: queue.length };
}

export function distinguishStates(machine: TotalMachine, left: number, right: number): Distinction {
  if (!machine.states.includes(left) || !machine.states.includes(right)) throw new Error('请选择可达状态。');
  const codes = machine.alphabet.map(([code]) => code);
  const column = new Map(codes.map((code, index) => [code, index]));
  const next = (state: number, code: number) => machine.transitions[state][column.get(code)!];
  return searchPairs(codes, left, right, (state) => machine.accept[state], (state) => machine.accept[state], next, next);
}

/** Independent equivalence check over every supported character, without using the partition. */
export function verifyDfaEquivalence(left: Dfa, right: Dfa): Distinction {
  if (!left.complete || !right.complete) throw new Error('不能校验尚未完整构造的 DFA。');
  const codes = UNIVERSE.flatMap(([lo, hi]) => Array.from({ length: hi - lo + 1 }, (_, index) => lo + index));
  const output = (dfa: Dfa, state: number) => state === DEAD ? undefined : dfa.states[state].accept;
  const next = (dfa: Dfa, state: number, code: number) => state === DEAD ? DEAD : dfaNext(dfa, state, code) ?? DEAD;
  return searchPairs(codes, 0, 0, (state) => output(left, state), (state) => output(right, state),
    (state, code) => next(left, state, code), (state, code) => next(right, state, code));
}

export function compareScans(left: ScanResult, right: ScanResult): boolean {
  return left.error?.position === right.error?.position && left.tokens.length === right.tokens.length &&
    left.tokens.every((token, index) => {
      const other = right.tokens[index];
      return token.rule === other.rule && token.text === other.text && token.start === other.start &&
        token.end === other.end && token.skip === other.skip;
    });
}
export interface MinimizationAnalysis {
  spec: AutomataSpec;
  original: Dfa;
  result?: DfaMinimization;
  frames: RefinementFrame[];
  verification?: Distinction;
  originalScan?: ScanResult;
  minimizedScan?: ScanResult;
  scansEqual?: boolean;
}
export type MinimizationOutcome = { ok: true; analysis: MinimizationAnalysis } | { ok: false; issue: AutomataIssue };
export function analyzeMinimization(source: string): MinimizationOutcome {
  try {
    const spec = parseSpec(source);
    const { nfa } = buildNfa(spec.rules);
    const { dfa: original } = buildDfa(nfa, spec.rules);
    if (!original.complete) return { ok: true, analysis: { spec, original, frames: [{
      kind: 'limit', groups: [], message: '子集构造达到 64 个状态上限，当前图尚未完整。不进行最小化、等价校验或扫描；请缩小规则。',
    }] } };
    const result = minimizeDfa(original);
    const verification = verifyDfaEquivalence(original, result.minimized);
    const originalScan = scan(original, spec.rules, spec.input);
    const minimizedScan = verification.equivalent ? scan(result.minimized, spec.rules, spec.input) : undefined;
    return { ok: true, analysis: { spec, original, result, frames: result.frames, verification,
      originalScan, minimizedScan, scansEqual: minimizedScan ? compareScans(originalScan, minimizedScan) : undefined } };
  } catch (error) {
    if (error instanceof AutomataError) return { ok: false, issue: error.issue };
    throw error;
  }
}
