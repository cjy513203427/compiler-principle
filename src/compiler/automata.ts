// Regex → NFA → DFA for lexical rules (原书第 02 讲).
// Pure functions only: the view renders these results and never recomputes them.

export type CharRange = readonly [number, number];
export const AUTOMATA_LIMITS = {
  source: 2000,
  rules: 8,
  pattern: 80,
  input: 300,
  nfaStates: 300,
  dfaStates: 64,
  scanFrames: 1500,
  backtrack: 5000,
  trace: 240,
} as const;
/** The alphabet: \t \n \r and printable ASCII. Negated classes complement within it. */
export const UNIVERSE: CharRange[] = [
  [9, 10],
  [13, 13],
  [32, 126],
];

export interface AutomataIssue {
  message: string;
  start: number;
  end: number;
}
export class AutomataError extends Error {
  issue: AutomataIssue;
  constructor(issue: AutomataIssue) {
    super(issue.message);
    this.issue = issue;
  }
}

export type RegexNode =
  | { kind: 'set'; ranges: CharRange[]; start: number; end: number }
  | { kind: 'concat'; parts: RegexNode[]; start: number; end: number }
  | { kind: 'alt'; options: RegexNode[]; start: number; end: number }
  | { kind: 'repeat'; op: '*' | '+' | '?'; body: RegexNode; start: number; end: number };

export interface LexRule {
  index: number;
  name: string;
  pattern: string;
  /** Offset of the pattern inside the whole source, for diagnostics. */
  offset: number;
  skip: boolean;
  ast: RegexNode;
}
export interface AutomataSpec {
  rules: LexRule[];
  input: string;
  inputOffset: number;
}

// ---------- character sets ----------

export function normalizeRanges(ranges: CharRange[]): CharRange[] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [lo, hi] of sorted) {
    const last = merged.at(-1);
    if (last && lo <= last[1] + 1) last[1] = Math.max(last[1], hi);
    else merged.push([lo, hi]);
  }
  return merged;
}
function complement(ranges: CharRange[]): CharRange[] {
  const result: [number, number][] = [];
  const holes = normalizeRanges(ranges);
  for (const [lo, hi] of UNIVERSE) {
    let next = lo;
    for (const [hLo, hHi] of holes) {
      if (hHi < next || hLo > hi) continue;
      if (hLo > next) result.push([next, hLo - 1]);
      next = Math.max(next, hHi + 1);
    }
    if (next <= hi) result.push([next, hi]);
  }
  return result;
}
export const rangesContain = (ranges: readonly CharRange[], code: number) =>
  ranges.some(([lo, hi]) => code >= lo && code <= hi);
export function charText(code: number): string {
  if (code === 32) return '␠';
  if (code === 10) return '\\n';
  if (code === 9) return '\\t';
  if (code === 13) return '\\r';
  return String.fromCharCode(code);
}
export function rangesText(ranges: readonly CharRange[]): string {
  if (ranges.length === 1 && ranges[0][0] === ranges[0][1]) return charText(ranges[0][0]);
  const body = ranges
    .map(([lo, hi]) =>
      lo === hi
        ? charText(lo)
        : hi === lo + 1
          ? `${charText(lo)}${charText(hi)}`
          : `${charText(lo)}-${charText(hi)}`,
    )
    .join('');
  return `[${body}]`;
}

// ---------- spec & regex parsing ----------

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const allowedChar = (code: number) => rangesContain(UNIVERSE, code);

export function parseSpec(source: string): AutomataSpec {
  if (source.length > AUTOMATA_LIMITS.source)
    throw new AutomataError({
      message: `规则与输入合计最多 ${AUTOMATA_LIMITS.source} 个字符。`,
      start: AUTOMATA_LIMITS.source,
      end: source.length,
    });
  const rules: LexRule[] = [];
  let offset = 0;
  let separator = -1;
  const lines = source.split('\n');
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    const lineStart = offset;
    offset += line.length + 1;
    const trimmed = line.trim();
    if (trimmed === '%%') {
      separator = lineIndex;
      break;
    }
    if (!trimmed || trimmed.startsWith('#')) continue;
    const colon = line.indexOf(':');
    const name = colon >= 0 ? line.slice(0, colon).trim() : '';
    if (colon < 0 || !NAME.test(name))
      throw new AutomataError({
        message: '规则写成“名称: 正则”，名称由字母、数字或下划线组成，且不以数字开头。',
        start: lineStart,
        end: lineStart + line.length,
      });
    const raw = line.slice(colon + 1);
    const lead = raw.length - raw.trimStart().length;
    const pattern = raw.trim();
    const patternOffset = lineStart + colon + 1 + lead;
    if (!pattern)
      throw new AutomataError({
        message: `规则 ${name} 缺少正则表达式。`,
        start: lineStart,
        end: lineStart + line.length,
      });
    if (pattern.length > AUTOMATA_LIMITS.pattern)
      throw new AutomataError({
        message: `单条正则最多 ${AUTOMATA_LIMITS.pattern} 个字符。`,
        start: patternOffset,
        end: patternOffset + pattern.length,
      });
    if (rules.some((rule) => rule.name === name))
      throw new AutomataError({
        message: `规则名 ${name} 重复。需要多种写法时，在一条规则里用 | 连接。`,
        start: lineStart,
        end: lineStart + colon,
      });
    if (rules.length >= AUTOMATA_LIMITS.rules)
      throw new AutomataError({
        message: `最多 ${AUTOMATA_LIMITS.rules} 条规则。`,
        start: lineStart,
        end: lineStart + line.length,
      });
    rules.push({
      index: rules.length,
      name,
      pattern,
      offset: patternOffset,
      skip: name === 'skip',
      ast: parseRegex(pattern, patternOffset),
    });
  }
  if (separator < 0)
    throw new AutomataError({
      message: '缺少单独一行的 %%。上方写规则，下方写要扫描的输入。',
      start: 0,
      end: source.length,
    });
  if (!rules.length)
    throw new AutomataError({ message: '%% 上方至少需要一条规则。', start: 0, end: offset });
  const inputOffset = Math.min(offset, source.length);
  const input = source.slice(inputOffset);
  if (input.length > AUTOMATA_LIMITS.input)
    throw new AutomataError({
      message: `待扫描的输入最多 ${AUTOMATA_LIMITS.input} 个字符。`,
      start: inputOffset + AUTOMATA_LIMITS.input,
      end: source.length,
    });
  for (let i = 0; i < input.length; i++)
    if (!allowedChar(input.charCodeAt(i)))
      throw new AutomataError({
        message: `输入含有字母表之外的字符「${input[i]}」。本实验只处理 ASCII 可打印字符、空格、\\t 与换行。`,
        start: inputOffset + i,
        end: inputOffset + i + 1,
      });
  return { rules, input, inputOffset };
}

export function parseRegex(pattern: string, base = 0): RegexNode {
  let pos = 0;
  const fail = (message: string, start = pos, end = start + 1): never => {
    throw new AutomataError({ message, start: base + start, end: base + Math.max(end, start + 1) });
  };
  const skipSpace = () => {
    while (pattern[pos] === ' ') pos++;
  };
  const escape = (inClass: boolean): CharRange[] => {
    const at = pos;
    pos++; // backslash
    const c = pattern[pos++];
    if (c === undefined) return fail('反斜杠后缺少字符。', at);
    if (c === 'd') return [[48, 57]];
    if (c === 'w')
      return normalizeRanges([
        [48, 57],
        [65, 90],
        [95, 95],
        [97, 122],
      ]);
    if (c === 's')
      return normalizeRanges([
        [9, 10],
        [13, 13],
        [32, 32],
      ]);
    if (c === 'n') return [[10, 10]];
    if (c === 't') return [[9, 9]];
    if (c === 'r') return [[13, 13]];
    if (/[A-Za-z0-9]/.test(c))
      return fail(`不支持的转义 \\${c}。可用 \\d \\w \\s \\n \\t \\r，或转义符号本身。`, at, pos);
    const code = c.charCodeAt(0);
    if (!allowedChar(code)) return fail('只支持 ASCII 字符。', at, pos);
    if (!inClass && c === ' ') return [[32, 32]];
    return [[code, code]];
  };
  const parseClass = (): RegexNode => {
    const start = pos;
    pos++; // [
    const negate = pattern[pos] === '^';
    if (negate) pos++;
    const ranges: CharRange[] = [];
    const single = (): number | CharRange[] => {
      if (pattern[pos] === '\\') {
        const r = escape(true);
        return r.length === 1 && r[0][0] === r[0][1] ? r[0][0] : r;
      }
      const code = pattern.charCodeAt(pos);
      if (!allowedChar(code) || code === 9 || code === 10 || code === 13)
        return fail('字符集里只能直接写 ASCII 可打印字符；制表符等请用转义。');
      pos++;
      return code;
    };
    while (pos < pattern.length && pattern[pos] !== ']') {
      const itemStart = pos;
      const lo = single();
      if (pattern[pos] === '-' && pattern[pos + 1] !== undefined && pattern[pos + 1] !== ']') {
        pos++;
        const hi = single();
        if (typeof lo !== 'number' || typeof hi !== 'number')
          return fail('区间两端必须是单个字符。', itemStart, pos);
        if (lo > hi)
          return fail(`区间 ${charText(lo)}-${charText(hi)} 的起点大于终点。`, itemStart, pos);
        ranges.push([lo, hi]);
      } else if (typeof lo === 'number') ranges.push([lo, lo]);
      else ranges.push(...lo);
    }
    if (pattern[pos] !== ']') return fail('字符集缺少右方括号 ]。', start, pattern.length);
    pos++;
    if (!ranges.length) return fail('字符集不能为空。', start, pos);
    const set = negate ? complement(ranges) : normalizeRanges(ranges);
    if (!set.length) return fail('取反后字符集为空。', start, pos);
    return { kind: 'set', ranges: set, start, end: pos };
  };
  const atom = (depth: number): RegexNode => {
    skipSpace();
    const start = pos;
    const c = pattern[pos];
    if (c === '(') {
      pos++;
      if (depth > 24) return fail('括号嵌套过深。', start);
      const inner = alternation(depth + 1);
      skipSpace();
      if (pattern[pos] !== ')') return fail('缺少右括号 )。', start, pos);
      pos++;
      return { ...inner, start, end: pos } as RegexNode;
    }
    if (c === '[') return parseClass();
    if (c === '.') {
      pos++;
      return { kind: 'set', ranges: complement([[10, 10]]), start, end: pos };
    }
    if (c === '\\') {
      const ranges = escape(false);
      return { kind: 'set', ranges, start, end: pos };
    }
    if (c === '{' || c === '}')
      return fail('暂不支持 {m,n} 计数重复，请展开书写；字面量花括号写成 \\{ 或 \\}。');
    if (c === ')') return fail('多余的右括号 )。');
    if (c === '*' || c === '+' || c === '?') return fail(`${c} 前面缺少要重复的内容。`);
    if (c === '|' || c === undefined) return fail('这里缺少一段正则（不能有空分支）。');
    const code = c.charCodeAt(0);
    if (!allowedChar(code)) return fail('只支持 ASCII 字符。');
    pos++;
    return { kind: 'set', ranges: [[code, code]], start, end: pos };
  };
  const repeat = (depth: number): RegexNode => {
    let node = atom(depth);
    for (;;) {
      skipSpace();
      const op = pattern[pos];
      if (op !== '*' && op !== '+' && op !== '?') return node;
      pos++;
      node = { kind: 'repeat', op, body: node, start: node.start, end: pos };
    }
  };
  const concatenation = (depth: number): RegexNode => {
    const parts: RegexNode[] = [];
    for (;;) {
      skipSpace();
      if (pos >= pattern.length || pattern[pos] === '|' || pattern[pos] === ')') break;
      parts.push(repeat(depth));
    }
    if (!parts.length) return fail('这里缺少一段正则（不能有空分支）。');
    return parts.length === 1
      ? parts[0]
      : { kind: 'concat', parts, start: parts[0].start, end: parts.at(-1)!.end };
  };
  const alternation = (depth: number): RegexNode => {
    const options = [concatenation(depth)];
    skipSpace();
    while (pattern[pos] === '|') {
      pos++;
      options.push(concatenation(depth));
      skipSpace();
    }
    return options.length === 1
      ? options[0]
      : { kind: 'alt', options, start: options[0].start, end: options.at(-1)!.end };
  };
  const tree = alternation(0);
  skipSpace();
  if (pos < pattern.length)
    fail(pattern[pos] === ')' ? '多余的右括号 )。' : `无法解析的字符「${pattern[pos]}」。`);
  return tree;
}

// ---------- Thompson-style construction (原书图 7–11) ----------

export interface NfaEdge {
  id: number;
  from: number;
  to: number;
  /** null means ε. */
  ranges: CharRange[] | null;
  step: number;
}
export interface NfaState {
  id: number;
  rule?: number;
  /** Thompson step that marks this state as accepting. */
  acceptStep?: number;
  step: number;
}
export type ThompsonKind =
  'start' | 'rule' | 'set' | 'concat' | 'alt' | 'star' | 'plus' | 'optional' | 'accept';
export interface ThompsonStep {
  kind: ThompsonKind;
  rule?: number;
  text: string;
  states: number[];
  edges: number[];
  message: string;
}
export interface Nfa {
  start: number;
  states: NfaState[];
  edges: NfaEdge[];
  /** Outgoing edge ids in creation order; the order is the backtracking preference. */
  out: number[][];
}

export function buildNfa(rules: LexRule[]): { nfa: Nfa; steps: ThompsonStep[] } {
  const states: NfaState[] = [];
  const edges: NfaEdge[] = [];
  const steps: ThompsonStep[] = [];
  let ownStates: number[] = [];
  let ownEdges: number[] = [];
  const newState = () => {
    if (states.length >= AUTOMATA_LIMITS.nfaStates)
      throw new AutomataError({
        message: `NFA 超过 ${AUTOMATA_LIMITS.nfaStates} 个状态，请缩短规则。`,
        start: 0,
        end: 0,
      });
    const id = states.length;
    states.push({ id, step: -1 });
    ownStates.push(id);
    return id;
  };
  const edge = (from: number, to: number, ranges: CharRange[] | null) => {
    const id = edges.length;
    edges.push({ id, from, to, ranges, step: -1 });
    ownEdges.push(id);
  };
  const record = (step: Omit<ThompsonStep, 'states' | 'edges'>) => {
    const index = steps.length;
    for (const id of ownStates) states[id].step = index;
    for (const id of ownEdges) edges[id].step = index;
    steps.push({ ...step, states: ownStates, edges: ownEdges });
    ownStates = [];
    ownEdges = [];
  };
  // Each node builds from an existing start state and returns its accepting state.
  // No node adds edges into the start it was given, so concatenation can merge states.
  function build(node: RegexNode, start: number, rule: LexRule): number {
    // Children push into their own lists and restore ours when they finish.
    const text = rule.pattern.slice(node.start, node.end).trim();
    const saved: [number[], number[]] = [ownStates, ownEdges];
    ownStates = [];
    ownEdges = [];
    const finish = (kind: ThompsonKind, end: number, message: string) => {
      record({ kind, rule: rule.index, text, message });
      [ownStates, ownEdges] = saved;
      return end;
    };
    switch (node.kind) {
      case 'set': {
        const end = newState();
        edge(start, end, node.ranges);
        return finish(
          'set',
          end,
          `字符 ${rangesText(node.ranges)}：新增状态 ${end}，边 ${start} —${rangesText(node.ranges)}→ ${end}。`,
        );
      }
      case 'concat': {
        const joints: number[] = [];
        let current = start;
        node.parts.forEach((part, index) => {
          current = build(part, current, rule);
          if (index < node.parts.length - 1) joints.push(current);
        });
        return finish(
          'concat',
          current,
          `连接 ${text}：前一段的结束状态直接作为后一段的开始（${joints.join('、')} 合二为一），不另加状态。`,
        );
      }
      case 'alt': {
        const end = newState();
        for (const option of node.options) {
          const branch = newState();
          edge(start, branch, null);
          const last = build(option, branch, rule);
          edge(last, end, null);
        }
        return finish(
          'alt',
          end,
          `选择 ${text}：从 ${start} 用 ε 分成 ${node.options.length} 条路径，各自结束后用 ε 汇合到 ${end}。`,
        );
      }
      case 'repeat': {
        const inner = newState();
        edge(start, inner, null);
        const last = build(node.body, inner, rule);
        if (node.op !== '?') edge(last, inner, null);
        const end = newState();
        edge(last, end, null);
        if (node.op !== '+') edge(start, end, null);
        return finish(
          node.op === '*' ? 'star' : node.op === '+' ? 'plus' : 'optional',
          end,
          node.op === '*'
            ? `${text}：${start} 可经 ε 直接到 ${end}（重复 0 次），也可从 ${last} 回到 ${inner} 再来一遍。`
            : node.op === '+'
              ? `${text}：没有跳过的 ε 边，至少走一遍；从 ${last} 可回到 ${inner} 继续重复。`
              : `${text}：${start} 可经 ε 跳过，或走一遍后到 ${end}；没有回边。`,
        );
      }
    }
  }
  const start = newState();
  record({
    kind: 'start',
    text: '',
    message: `创建总开始状态 ${start}。每条规则都从这里经 ε 进入。`,
  });
  for (const rule of rules) {
    const ruleStart = newState();
    edge(start, ruleStart, null);
    record({
      kind: 'rule',
      rule: rule.index,
      text: rule.pattern,
      message: `开始规则 ${rule.name}（第 ${rule.index + 1} 优先）：${start} —ε→ ${ruleStart}。`,
    });
    const end = build(rule.ast, ruleStart, rule);
    states[end].rule = rule.index;
    states[end].acceptStep = steps.length;
    record({
      kind: 'accept',
      rule: rule.index,
      text: rule.pattern,
      message: `规则 ${rule.name} 完成：状态 ${end} 成为接受状态，标记 ${rule.name}。`,
    });
  }
  // A state becomes visible no later than the first visible edge touching it.
  for (const e of edges) {
    states[e.from].step = Math.min(states[e.from].step, e.step);
    states[e.to].step = Math.min(states[e.to].step, e.step);
  }
  const out = states.map(() => [] as number[]);
  for (const e of edges) out[e.from].push(e.id);
  return { nfa: { start, states, edges, out }, steps };
}

export function epsilonClosure(nfa: Nfa, seeds: number[]): number[] {
  const seen = new Set(seeds);
  const stack = [...seeds];
  while (stack.length) {
    const state = stack.pop()!;
    for (const id of nfa.out[state]) {
      const e = nfa.edges[id];
      if (e.ranges === null && !seen.has(e.to)) {
        seen.add(e.to);
        stack.push(e.to);
      }
    }
  }
  return [...seen].sort((a, b) => a - b);
}

// ---------- subset construction ----------

export interface DfaState {
  id: number;
  nfa: number[];
  /** Winning rule: the earliest rule whose accepting NFA state is in the set. */
  accept?: number;
  candidates: number[];
}
export interface DfaEdge {
  from: number;
  to: number;
  ranges: CharRange[];
}
export interface SubsetMove {
  ranges: CharRange[];
  move: number[];
  target: number;
  created: boolean;
}
export interface SubsetStep {
  kind: 'start' | 'process' | 'limit';
  dfa: number;
  moves: SubsetMove[];
  known: number;
  message: string;
}
export interface Dfa {
  states: DfaState[];
  edges: DfaEdge[];
  complete: boolean;
  /** Number of disjoint input classes derived from all NFA edge labels. */
  classes: number;
}

function inputClasses(nfa: Nfa): CharRange[] {
  const points = new Set<number>();
  for (const e of nfa.edges)
    for (const [lo, hi] of e.ranges || []) {
      points.add(lo);
      points.add(hi + 1);
    }
  const sorted = [...points].sort((a, b) => a - b);
  const classes: CharRange[] = [];
  for (let i = 0; i + 1 < sorted.length; i++) {
    const lo = sorted[i];
    if (nfa.edges.some((e) => e.ranges && rangesContain(e.ranges, lo)))
      classes.push([lo, sorted[i + 1] - 1]);
  }
  return classes;
}

export function buildDfa(nfa: Nfa, rules: LexRule[]): { dfa: Dfa; steps: SubsetStep[] } {
  const classes = inputClasses(nfa);
  const states: DfaState[] = [];
  const edges: DfaEdge[] = [];
  const steps: SubsetStep[] = [];
  const index = new Map<string, number>();
  const name = (set: number[]) => `{${set.join(',')}}`;
  const add = (set: number[]) => {
    const candidates = [
      ...new Set(set.map((s) => nfa.states[s].rule).filter((r): r is number => r !== undefined)),
    ].sort((a, b) => a - b);
    const id = states.length;
    states.push({ id, nfa: set, accept: candidates[0], candidates });
    index.set(set.join(','), id);
    return id;
  };
  const acceptText = (state: DfaState) =>
    state.accept === undefined
      ? ''
      : state.candidates.length > 1
        ? `（同时接受 ${state.candidates.map((r) => rules[r].name).join('、')}，${rules[state.accept].name} 优先）`
        : `（接受 ${rules[state.accept].name}）`;
  add(epsilonClosure(nfa, [nfa.start]));
  steps.push({
    kind: 'start',
    dfa: 0,
    moves: [],
    known: 1,
    message: `D0 = ε-闭包({${nfa.start}}) = ${name(states[0].nfa)}${acceptText(states[0])}。`,
  });
  let complete = true;
  for (let current = 0; current < states.length; current++) {
    const groups = new Map<string, { ranges: CharRange[]; move: number[] }>();
    for (const cls of classes) {
      const move = new Set<number>();
      for (const s of states[current].nfa)
        for (const id of nfa.out[s]) {
          const e = nfa.edges[id];
          if (e.ranges && rangesContain(e.ranges, cls[0])) move.add(e.to);
        }
      if (!move.size) continue;
      const sorted = [...move].sort((a, b) => a - b);
      const key = sorted.join(',');
      const group = groups.get(key);
      if (group) group.ranges.push(cls);
      else groups.set(key, { ranges: [cls], move: sorted });
    }
    const moves: SubsetMove[] = [];
    let limited = false;
    for (const group of groups.values()) {
      const closure = epsilonClosure(nfa, group.move);
      let target = index.get(closure.join(','));
      const created = target === undefined;
      if (created) {
        if (states.length >= AUTOMATA_LIMITS.dfaStates) {
          limited = true;
          break;
        }
        target = add(closure);
      }
      const ranges = normalizeRanges(group.ranges);
      moves.push({ ranges, move: group.move, target: target!, created });
      edges.push({ from: current, to: target!, ranges });
    }
    const fresh = moves.filter((m) => m.created).map((m) => `D${m.target}`);
    steps.push({
      kind: 'process',
      dfa: current,
      moves,
      known: states.length,
      message: moves.length
        ? `处理 D${current} = ${name(states[current].nfa)}：${moves.length} 组输入各自求 move 和 ε-闭包${fresh.length ? `，新增 ${fresh.join('、')}` : '，没有新状态'}。`
        : `处理 D${current}：任何输入都无路可走（死状态不画出）。`,
    });
    if (limited) {
      complete = false;
      steps.push({
        kind: 'limit',
        dfa: current,
        moves: [],
        known: states.length,
        message: `DFA 状态达到上限 ${AUTOMATA_LIMITS.dfaStates}，停止构造。这正是子集构造可能出现的状态膨胀；不发布扫描结果。`,
      });
      break;
    }
  }
  return { dfa: { states, edges, complete, classes: classes.length }, steps };
}

export function dfaNext(dfa: Dfa, state: number, code: number): number | undefined {
  for (const e of dfa.edges) if (e.from === state && rangesContain(e.ranges, code)) return e.to;
  return undefined;
}

// ---------- maximal-munch scanning ----------

export interface LexToken {
  rule: number;
  text: string;
  start: number;
  end: number;
  skip: boolean;
  /** Characters the DFA read for this token, including the look-ahead it gave back. */
  reads: number;
}
export interface ScanFrame {
  kind: 'read' | 'emit' | 'error' | 'done' | 'truncated';
  tokenStart: number;
  position: number;
  state?: number;
  lastAccept?: { end: number; rule: number };
  tokens: number;
  message: string;
}
export interface ScanResult {
  tokens: LexToken[];
  frames: ScanFrame[];
  error?: { position: number; message: string };
}

export function scan(dfa: Dfa, rules: LexRule[], input: string): ScanResult {
  const tokens: LexToken[] = [];
  const frames: ScanFrame[] = [];
  let truncated = false;
  const push = (frame: ScanFrame) => {
    if (frames.length < AUTOMATA_LIMITS.scanFrames) frames.push(frame);
    else truncated = true;
  };
  let pos = 0;
  let error: ScanResult['error'];
  while (pos < input.length) {
    let state = 0;
    let i = pos;
    let last: { end: number; rule: number } | undefined;
    for (;;) {
      const next = i < input.length ? dfaNext(dfa, state, input.charCodeAt(i)) : undefined;
      if (next === undefined) break;
      state = next;
      i++;
      const accept = dfa.states[state].accept;
      if (accept !== undefined) last = { end: i, rule: accept };
      push({
        kind: 'read',
        tokenStart: pos,
        position: i,
        state,
        lastAccept: last,
        tokens: tokens.length,
        message: `读 ${charText(input.charCodeAt(i - 1))} → D${state}${accept !== undefined ? `，可接受 ${rules[accept].name}，记下位置 ${i}` : '，暂不可接受'}；继续尝试更长的词素。`,
      });
    }
    const stop =
      i < input.length ? `D${state} 遇到 ${charText(input.charCodeAt(i))} 无路可走` : '输入结束';
    if (!last) {
      error = {
        position: pos,
        message: `从位置 ${pos} 开始，没有规则能匹配非空词素（${stop}）。扫描停止。`,
      };
      push({
        kind: 'error',
        tokenStart: pos,
        position: i,
        state,
        tokens: tokens.length,
        message: error.message,
      });
      break;
    }
    const rule = rules[last.rule];
    tokens.push({
      rule: last.rule,
      text: input.slice(pos, last.end),
      start: pos,
      end: last.end,
      skip: rule.skip,
      reads: i - pos,
    });
    const back = i - last.end;
    push({
      kind: 'emit',
      tokenStart: pos,
      position: last.end,
      state,
      lastAccept: last,
      tokens: tokens.length,
      message: `${stop}：回到最近接受位置 ${last.end}${back ? `，退回多读的 ${back} 个字符` : ''}，${rule.skip ? `丢弃 skip 词素` : `生成 ${rule.name}「${input.slice(pos, last.end)}」`}。`,
    });
    pos = last.end;
  }
  if (truncated)
    frames.push({
      kind: 'truncated',
      tokenStart: pos,
      position: pos,
      tokens: tokens.length,
      message: `回放只记录前 ${AUTOMATA_LIMITS.scanFrames} 步；扫描本身已完成，下方 Token 列表完整。`,
    });
  if (!error)
    frames.push({
      kind: 'done',
      tokenStart: input.length,
      position: input.length,
      tokens: tokens.length,
      message: `扫描完成：${tokens.filter((t) => !t.skip).length} 个 Token，${tokens.filter((t) => t.skip).length} 段被 skip 丢弃。`,
    });
  return { tokens, frames, error };
}

// ---------- backtracking NFA matcher (原书 matchWithNFA 的思路) ----------

export interface BacktrackTry {
  state: number;
  index: number;
  depth: number;
  /** Reached an accepting state while characters remain. */
  stranded?: boolean;
}
export interface BacktrackResult {
  outcome: 'match' | 'fail' | 'limit';
  rule?: number;
  attempts: number;
  trace: BacktrackTry[];
}
/** Whole-string match by depth-first search; edges are tried in creation (= priority) order. */
export function backtrackMatch(
  nfa: Nfa,
  text: string,
  limit: number = AUTOMATA_LIMITS.backtrack,
): BacktrackResult {
  const stack: { state: number; index: number; edge: number }[] = [];
  const trace: BacktrackTry[] = [];
  let attempts = 0;
  const visit = (state: number, index: number): BacktrackResult | undefined => {
    attempts++;
    const rule = nfa.states[state].rule;
    const done = rule !== undefined && index === text.length;
    if (trace.length < AUTOMATA_LIMITS.trace)
      trace.push({ state, index, depth: stack.length, stranded: rule !== undefined && !done });
    if (done) return { outcome: 'match', rule, attempts, trace };
    stack.push({ state, index, edge: 0 });
  };
  const onPath = (state: number, index: number) => {
    for (let i = stack.length - 1; i >= 0 && stack[i].index === index; i--)
      if (stack[i].state === state) return true;
    return false;
  };
  let found = visit(nfa.start, 0);
  while (!found && stack.length) {
    if (attempts >= limit) return { outcome: 'limit', attempts, trace };
    const top = stack[stack.length - 1];
    const out = nfa.out[top.state];
    if (top.edge >= out.length) {
      stack.pop();
      continue;
    }
    const e = nfa.edges[out[top.edge++]];
    if (e.ranges === null) {
      // An ε-cycle at the same input position would never terminate.
      if (!onPath(e.to, top.index)) found = visit(e.to, top.index);
    } else if (top.index < text.length && rangesContain(e.ranges, text.charCodeAt(top.index)))
      found = visit(e.to, top.index + 1);
  }
  return found || { outcome: 'fail', attempts, trace };
}

// ---------- whole analysis ----------

export type AutomataFrame =
  | { phase: 'nfa'; index: number; message: string }
  | { phase: 'dfa'; index: number; message: string }
  | { phase: 'scan'; index: number; message: string };
export interface RuleNote {
  rule: number;
  emptyMatch: boolean;
  shadowed: boolean;
}
export interface AutomataAnalysis {
  spec: AutomataSpec;
  nfa: Nfa;
  thompson: ThompsonStep[];
  dfa: Dfa;
  subset: SubsetStep[];
  scan?: ScanResult;
  comparisons: { token: number; dfaReads: number; backtrack: BacktrackResult }[];
  notes: RuleNote[];
  frames: AutomataFrame[];
}
export type AutomataOutcome =
  { ok: true; analysis: AutomataAnalysis } | { ok: false; issue: AutomataIssue };

export function analyzeAutomata(source: string): AutomataOutcome {
  try {
    const spec = parseSpec(source);
    const { nfa, steps: thompson } = buildNfa(spec.rules);
    const { dfa, steps: subset } = buildDfa(nfa, spec.rules);
    const winners = new Set(dfa.states.map((s) => s.accept));
    const notes = spec.rules.map((rule) => ({
      rule: rule.index,
      emptyMatch: dfa.states[0].candidates.includes(rule.index),
      shadowed: dfa.complete && !winners.has(rule.index),
    }));
    const result = dfa.complete ? scan(dfa, spec.rules, spec.input) : undefined;
    const comparisons = (result?.tokens || []).map((token, index) => ({
      token: index,
      dfaReads: token.reads,
      backtrack: backtrackMatch(nfa, token.text),
    }));
    const frames: AutomataFrame[] = [
      ...thompson.map((s, index) => ({ phase: 'nfa' as const, index, message: s.message })),
      ...subset.map((s, index) => ({ phase: 'dfa' as const, index, message: s.message })),
      ...(result?.frames || []).map((s, index) => ({
        phase: 'scan' as const,
        index,
        message: s.message,
      })),
    ];
    return {
      ok: true,
      analysis: { spec, nfa, thompson, dfa, subset, scan: result, comparisons, notes, frames },
    };
  } catch (error) {
    if (error instanceof AutomataError) return { ok: false, issue: error.issue };
    throw error;
  }
}

/** Book-style listing: "0 ε -> 2". */
export function nfaListing(nfa: Nfa, rules: LexRule[], visibleStep = Infinity) {
  return nfa.states
    .filter((s) => s.step <= visibleStep)
    .map((s) => ({
      state: s.id,
      accept: s.rule !== undefined && s.acceptStep! <= visibleStep ? rules[s.rule].name : undefined,
      edges: nfa.out[s.id]
        .map((id) => nfa.edges[id])
        .filter((e) => e.step <= visibleStep)
        .map((e) => ({
          id: e.id,
          label: e.ranges ? rangesText(e.ranges) : 'ε',
          to: e.to,
          step: e.step,
        })),
    }));
}
