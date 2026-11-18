// Context-free grammars, FIRST / FOLLOW, LL(1) tables and table-driven parsing (原书第 03 讲).
// Pure functions only; the view renders these results.

export const GRAMMAR_LIMITS = {
  source: 2000,
  nonterminals: 16,
  productions: 40,
  rhs: 10,
  input: 60,
  rounds: 50,
  parseSteps: 600,
} as const;
export const EPSILON = 'ε';
export const END = '$';

export interface GrammarIssue {
  message: string;
  start: number;
  end: number;
}
export class GrammarError extends Error {
  issue: GrammarIssue;
  constructor(issue: GrammarIssue) {
    super(issue.message);
    this.issue = issue;
  }
}

export interface Production {
  id: number;
  lhs: string;
  /** Empty for ε. */
  rhs: string[];
}
export interface Grammar {
  productions: Production[];
  nonterminals: string[];
  terminals: string[];
  start: string;
}
export interface InputToken {
  type: string;
  text: string;
}
export interface GrammarSpec {
  grammar: Grammar;
  input: InputToken[];
  inputText: string;
}

export const productionText = (p: Production) =>
  `${p.lhs} -> ${p.rhs.length ? p.rhs.join(' ') : EPSILON}`;
export const setText = (values: Iterable<string>) => `{ ${[...values].join(', ')} }`;

const NONTERMINAL = /^[A-Za-z_][A-Za-z0-9_]*'*$/;
const WORD = /^[A-Za-z_][A-Za-z0-9_]*$/;

// ---------- parsing the grammar text ----------

export function parseGrammarSpec(source: string): GrammarSpec {
  if (source.length > GRAMMAR_LIMITS.source)
    throw new GrammarError({
      message: `文法与输入合计最多 ${GRAMMAR_LIMITS.source} 个字符。`,
      start: GRAMMAR_LIMITS.source,
      end: source.length,
    });
  const raw: { lhs: string; rhs: string[]; start: number; end: number }[] = [];
  let offset = 0;
  let separator = -1;
  let current: string | undefined;
  const lines = source.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const lineStart = offset;
    offset += line.length + 1;
    const trimmed = line.trim();
    if (trimmed === '%%') {
      separator = index;
      break;
    }
    if (!trimmed || trimmed.startsWith('#')) continue;
    const fail = (message: string): never => {
      throw new GrammarError({ message, start: lineStart, end: lineStart + line.length });
    };
    let lhs: string;
    let body: string;
    if (trimmed.startsWith('|')) {
      // A continuation line adds more alternatives to the previous left-hand side.
      if (!current) fail('以 | 开头的行要接在某条产生式后面。');
      lhs = current!;
      body = trimmed.slice(1);
    } else {
      const arrow = line.indexOf('->');
      if (arrow < 0) fail('产生式写成“左边 -> 右边”，多个候选用 | 分开。');
      lhs = line.slice(0, arrow).trim();
      body = line.slice(arrow + 2);
      if (!NONTERMINAL.test(lhs))
        fail(`左边「${lhs || '空'}」不是合法的非终结符名：用字母开头，可带撇号，如 add'。`);
    }
    current = lhs;
    for (const alternative of body.split('|')) {
      const symbols = alternative.trim().split(/\s+/).filter(Boolean);
      if (!symbols.length) fail(`${lhs} 有一个空候选；空串请明确写成 ε。`);
      const empty = symbols.length === 1 && (symbols[0] === EPSILON || symbols[0] === 'eps');
      if (!empty && symbols.some((s) => s === EPSILON || s === 'eps'))
        fail('ε 表示“什么也没有”，只能单独作为一个候选。');
      if (symbols.includes(END)) fail('$ 留给“输入结束”，不能写在产生式里。');
      if (symbols.includes('->')) fail('一行只能有一个 ->。');
      if (symbols.length > GRAMMAR_LIMITS.rhs) fail(`一个候选最多 ${GRAMMAR_LIMITS.rhs} 个符号。`);
      raw.push({ lhs, rhs: empty ? [] : symbols, start: lineStart, end: lineStart + line.length });
    }
  }
  if (separator < 0)
    throw new GrammarError({
      message: '缺少单独一行的 %%。上方写产生式，下方写要分析的输入。',
      start: 0,
      end: source.length,
    });
  if (!raw.length)
    throw new GrammarError({ message: '%% 上方至少需要一条产生式。', start: 0, end: offset });
  if (raw.length > GRAMMAR_LIMITS.productions)
    throw new GrammarError({
      message: `最多 ${GRAMMAR_LIMITS.productions} 个候选产生式。`,
      start: raw[GRAMMAR_LIMITS.productions].start,
      end: raw[GRAMMAR_LIMITS.productions].end,
    });
  const nonterminals = [...new Set(raw.map((p) => p.lhs))];
  if (nonterminals.length > GRAMMAR_LIMITS.nonterminals)
    throw new GrammarError({
      message: `最多 ${GRAMMAR_LIMITS.nonterminals} 个非终结符。`,
      start: 0,
      end: offset,
    });
  const seen = new Set<string>();
  const productions: Production[] = [];
  for (const p of raw) {
    const key = `${p.lhs}->${p.rhs.join(' ')}`;
    if (seen.has(key))
      throw new GrammarError({
        message: `产生式 ${p.lhs} -> ${p.rhs.join(' ') || EPSILON} 重复了。`,
        start: p.start,
        end: p.end,
      });
    seen.add(key);
    productions.push({ id: productions.length, lhs: p.lhs, rhs: p.rhs });
  }
  const terminals: string[] = [];
  for (const p of productions)
    for (const s of p.rhs)
      if (!nonterminals.includes(s) && !terminals.includes(s)) terminals.push(s);
  const grammar = { productions, nonterminals, terminals, start: nonterminals[0] };
  const inputOffset = Math.min(offset, source.length);
  const inputText = source.slice(inputOffset);
  return { grammar, input: tokenizeInput(grammar, inputText, inputOffset), inputText };
}

/** Splits the input into grammar terminals. Digits become Num and words become Id when the grammar has them. */
export function tokenizeInput(grammar: Grammar, text: string, base = 0): InputToken[] {
  const tokens: InputToken[] = [];
  const byLength = [...grammar.terminals].sort((a, b) => b.length - a.length);
  let i = 0;
  while (i < text.length) {
    if (/\s/.test(text[i])) {
      i++;
      continue;
    }
    const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i))?.[0];
    const digits = /^[0-9]+/.exec(text.slice(i))?.[0];
    let token: InputToken | undefined;
    if (word && grammar.terminals.includes(word)) token = { type: word, text: word };
    else if (word && grammar.terminals.includes('Id')) token = { type: 'Id', text: word };
    else if (digits && grammar.terminals.includes('Num')) token = { type: 'Num', text: digits };
    else if (!word) {
      const symbol = byLength.find((t) => !WORD.test(t) && text.startsWith(t, i));
      if (symbol) token = { type: symbol, text: symbol };
    }
    if (!token) {
      const bad = word || digits || text[i];
      throw new GrammarError({
        message: `输入里的「${bad}」不是文法中的终结符。${word ? '单词要和终结符同名，或在文法里使用 Id。' : digits ? '数字需要文法里有 Num。' : ''}`,
        start: base + i,
        end: base + i + bad.length,
      });
    }
    tokens.push(token);
    i += token.text.length;
    if (tokens.length > GRAMMAR_LIMITS.input)
      throw new GrammarError({
        message: `输入最多 ${GRAMMAR_LIMITS.input} 个 Token。`,
        start: base + i,
        end: base + text.length,
      });
  }
  return tokens;
}

// ---------- FIRST ----------

export type SetMap = Record<string, string[]>;
const snapshot = (map: Map<string, Set<string>>): SetMap =>
  Object.fromEntries([...map].map(([k, v]) => [k, [...v]]));

export interface SetStep {
  round: number;
  production?: number;
  target?: string;
  added: string[];
  reason: string;
  sets: SetMap;
}

export function firstOfSequence(
  first: Map<string, Set<string>>,
  grammar: Grammar,
  symbols: string[],
): { set: Set<string>; nullable: boolean } {
  const set = new Set<string>();
  for (const s of symbols) {
    if (!grammar.nonterminals.includes(s)) {
      set.add(s);
      return { set, nullable: false };
    }
    for (const t of first.get(s)!) if (t !== EPSILON) set.add(t);
    if (!first.get(s)!.has(EPSILON)) return { set, nullable: false };
  }
  return { set, nullable: true };
}

export function computeFirst(grammar: Grammar) {
  const first = new Map(grammar.nonterminals.map((n) => [n, new Set<string>()]));
  const steps: SetStep[] = [
    {
      round: 0,
      added: [],
      reason: '开始时每个 FIRST 集合都是空的。接下来一轮轮扫描全部产生式，直到再也加不进新东西。',
      sets: snapshot(first),
    },
  ];
  let converged = false;
  let round = 0;
  while (!converged && round < GRAMMAR_LIMITS.rounds) {
    round++;
    converged = true;
    for (const p of grammar.productions) {
      const { set, nullable } = firstOfSequence(first, grammar, p.rhs);
      if (nullable) set.add(EPSILON);
      const target = first.get(p.lhs)!;
      const added = [...set].filter((t) => !target.has(t));
      if (!added.length) continue;
      converged = false;
      for (const t of added) target.add(t);
      steps.push({
        round,
        production: p.id,
        target: p.lhs,
        added,
        reason: `第 ${round} 轮 · ${productionText(p)}：${firstReason(first, grammar, p)}`,
        sets: snapshot(first),
      });
    }
    if (converged)
      steps.push({
        round,
        added: [],
        reason: `第 ${round} 轮没有任何集合变化，到达不动点：FIRST 计算完成。`,
        sets: snapshot(first),
      });
  }
  return { first, steps, converged };
}

function firstReason(first: Map<string, Set<string>>, grammar: Grammar, p: Production) {
  if (!p.rhs.length) return `右边是 ε，说明 ${p.lhs} 可以什么都不产生，FIRST(${p.lhs}) 加入 ε。`;
  const parts: string[] = [];
  for (const s of p.rhs) {
    if (!grammar.nonterminals.includes(s)) {
      parts.push(
        parts.length
          ? `再看下一项，是终结符 ${s}，把它加进来`
          : `以终结符 ${s} 开头，把 ${s} 加进来`,
      );
      return `${parts.join('；')}。`;
    }
    const set = [...first.get(s)!].filter((t) => t !== EPSILON);
    parts.push(
      `${parts.length ? '再看下一项' : '以非终结符开头'} ${s}，把 FIRST(${s}) 中的 ${set.length ? setText(set) : '（目前还是空的）'} 加进来`,
    );
    if (!first.get(s)!.has(EPSILON)) return `${parts.join('；')}。`;
    parts.push(`${s} 可以为空`);
  }
  return `${parts.join('；')}；整条右边都可以为空，所以加入 ε。`;
}

// ---------- FOLLOW ----------

export function computeFollow(grammar: Grammar, first: Map<string, Set<string>>) {
  const follow = new Map(grammar.nonterminals.map((n) => [n, new Set<string>()]));
  follow.get(grammar.start)!.add(END);
  const steps: SetStep[] = [
    {
      round: 0,
      target: grammar.start,
      added: [END],
      reason: `${grammar.start} 是开始符号，整段输入解析完以后后面就是“输入结束”，所以 FOLLOW(${grammar.start}) 先放入 $。`,
      sets: snapshot(follow),
    },
  ];
  let converged = false;
  let round = 0;
  while (!converged && round < GRAMMAR_LIMITS.rounds) {
    round++;
    converged = true;
    for (const p of grammar.productions) {
      p.rhs.forEach((symbol, index) => {
        if (!grammar.nonterminals.includes(symbol)) return;
        const rest = p.rhs.slice(index + 1);
        const { set, nullable } = firstOfSequence(first, grammar, rest);
        const target = follow.get(symbol)!;
        const fromFirst = [...set].filter((t) => !target.has(t));
        for (const t of fromFirst) target.add(t);
        const fromParent = nullable ? [...follow.get(p.lhs)!].filter((t) => !target.has(t)) : [];
        for (const t of fromParent) target.add(t);
        const added = [...fromFirst, ...fromParent];
        if (!added.length) return;
        converged = false;
        const reasons: string[] = [];
        if (fromFirst.length)
          reasons.push(
            `${symbol} 后面是 ${rest.join(' ')}，它们能开头的 Token ${setText(fromFirst)} 可以紧跟在 ${symbol} 后面`,
          );
        if (fromParent.length)
          reasons.push(
            rest.length
              ? `${rest.join(' ')} 可以为空，${symbol} 就可能处在 ${p.lhs} 的末尾，所以 ${p.lhs} 后面的 ${setText(fromParent)} 也能跟在 ${symbol} 后面`
              : `${symbol} 在 ${p.lhs} 的末尾，所以 ${p.lhs} 后面的 ${setText(fromParent)} 也能跟在 ${symbol} 后面`,
          );
        steps.push({
          round,
          production: p.id,
          target: symbol,
          added,
          reason: `第 ${round} 轮 · ${productionText(p)}：${reasons.join('；')}。`,
          sets: snapshot(follow),
        });
      });
    }
    if (converged)
      steps.push({
        round,
        added: [],
        reason: `第 ${round} 轮没有任何集合变化：FOLLOW 计算完成。`,
        sets: snapshot(follow),
      });
  }
  return { follow, steps, converged };
}

// ---------- LL(1) table ----------

export interface TableEntry {
  production: number;
  via: 'first' | 'follow';
}
export interface TableStep {
  production: number;
  cells: { terminal: string; via: 'first' | 'follow' }[];
  reason: string;
}
export interface Conflict {
  nonterminal: string;
  terminal: string;
  productions: number[];
  kind: 'FIRST/FIRST' | 'FIRST/FOLLOW';
}

export function buildTable(
  grammar: Grammar,
  first: Map<string, Set<string>>,
  follow: Map<string, Set<string>>,
) {
  const table: Record<string, Record<string, TableEntry[]>> = Object.fromEntries(
    grammar.nonterminals.map((n) => [n, {}]),
  );
  const steps: TableStep[] = [];
  for (const p of grammar.productions) {
    const { set, nullable } = firstOfSequence(first, grammar, p.rhs);
    const cells: TableStep['cells'] = [];
    for (const t of set) cells.push({ terminal: t, via: 'first' });
    if (nullable) for (const t of follow.get(p.lhs)!) cells.push({ terminal: t, via: 'follow' });
    for (const cell of cells)
      (table[p.lhs][cell.terminal] ||= []).push({ production: p.id, via: cell.via });
    const viaFirst = cells.filter((c) => c.via === 'first').map((c) => c.terminal);
    const viaFollow = cells.filter((c) => c.via === 'follow').map((c) => c.terminal);
    steps.push({
      production: p.id,
      cells,
      reason: `${productionText(p)}：${[
        viaFirst.length && `下一个 Token 是 ${setText(viaFirst)} 时，说明要从这条产生式开始`,
        viaFollow.length &&
          `右边可以为空，当下一个 Token 是 ${p.lhs} 后面可能跟着的 ${setText(viaFollow)} 时，选它（相当于 ${p.lhs} 什么也不产生）`,
      ]
        .filter(Boolean)
        .join('；')}。`,
    });
  }
  const conflicts: Conflict[] = [];
  for (const n of grammar.nonterminals)
    for (const [terminal, entries] of Object.entries(table[n]))
      if (entries.length > 1)
        conflicts.push({
          nonterminal: n,
          terminal,
          productions: entries.map((e) => e.production),
          kind: entries.every((e) => e.via === 'first') ? 'FIRST/FIRST' : 'FIRST/FOLLOW',
        });
  return { table, steps, conflicts };
}

// ---------- left recursion ----------

export interface LeftRecursion {
  nonterminal: string;
  direct: boolean;
  /** e.g. ["add", "add"] or ["a", "b", "a"]. */
  path: string[];
}

export function findLeftRecursion(
  grammar: Grammar,
  first: Map<string, Set<string>>,
): LeftRecursion[] {
  // A → B when B can be the first thing A expands to (everything before it may be ε).
  const edges = new Map(grammar.nonterminals.map((n) => [n, [] as string[]]));
  for (const p of grammar.productions)
    for (const s of p.rhs) {
      if (!grammar.nonterminals.includes(s)) break;
      if (!edges.get(p.lhs)!.includes(s)) edges.get(p.lhs)!.push(s);
      if (!first.get(s)!.has(EPSILON)) break;
    }
  const result: LeftRecursion[] = [];
  for (const n of grammar.nonterminals) {
    // Breadth-first search for the shortest path back to n.
    const previous = new Map<string, string>();
    const queue = [...edges.get(n)!];
    for (const next of queue) previous.set(next, n);
    let found = edges.get(n)!.includes(n);
    while (!found && queue.length) {
      const at = queue.shift()!;
      for (const next of edges.get(at)!) {
        if (next === n) {
          previous.set(n, at);
          found = true;
          break;
        }
        if (!previous.has(next)) {
          previous.set(next, at);
          queue.push(next);
        }
      }
    }
    if (!found) continue;
    const direct = edges.get(n)!.includes(n);
    const path = [n];
    if (!direct) {
      let at = previous.get(n)!;
      while (at !== n) {
        path.unshift(at);
        at = previous.get(at)!;
      }
      path.unshift(n);
    } else path.push(n);
    result.push({ nonterminal: n, direct, path });
  }
  return result;
}

/** Rewrites only direct left recursion: A -> A α | β  ⇒  A -> β A' ; A' -> α A' | ε. */
export function rewriteDirectLeftRecursion(grammar: Grammar): string | undefined {
  const used = new Set([...grammar.nonterminals, ...grammar.terminals]);
  const lines: string[] = [];
  let changed = false;
  for (const n of grammar.nonterminals) {
    const own = grammar.productions.filter((p) => p.lhs === n);
    const recursive = own.filter((p) => p.rhs[0] === n);
    const others = own.filter((p) => p.rhs[0] !== n);
    if (!recursive.length) {
      lines.push(
        `${n} -> ${own.map((p) => (p.rhs.length ? p.rhs.join(' ') : EPSILON)).join(' | ')}`,
      );
      continue;
    }
    if (!others.length || recursive.some((p) => p.rhs.length === 1)) return undefined;
    let tail = `${n}'`;
    while (used.has(tail)) tail += "'";
    used.add(tail);
    changed = true;
    lines.push(`${n} -> ${others.map((p) => [...p.rhs, tail].join(' ')).join(' | ')}`);
    lines.push(
      `${tail} -> ${recursive.map((p) => [...p.rhs.slice(1), tail].join(' ')).join(' | ')} | ${EPSILON}`,
    );
  }
  return changed ? lines.join('\n') : undefined;
}

// ---------- table-driven parsing ----------

export interface TreeNode {
  id: number;
  symbol: string;
  children: number[];
  /** Parse step at which the node was created / its token matched. */
  createdAt: number;
  matchedAt?: number;
  text?: string;
}
export interface ParseStep {
  kind: 'start' | 'expand' | 'match' | 'accept' | 'error';
  stack: string[];
  position: number;
  production?: number;
  node?: number;
  message: string;
}
export interface ParseResult {
  steps: ParseStep[];
  nodes: TreeNode[];
  accepted: boolean;
  error?: string;
}

export function parseWithTable(
  grammar: Grammar,
  table: Record<string, Record<string, TableEntry[]>>,
  input: InputToken[],
): ParseResult {
  const nodes: TreeNode[] = [{ id: 0, symbol: grammar.start, children: [], createdAt: 0 }];
  const stack: { symbol: string; node?: number }[] = [
    { symbol: END },
    { symbol: grammar.start, node: 0 },
  ];
  const steps: ParseStep[] = [];
  const names = () => stack.map((s) => s.symbol);
  const lookahead = (i: number) => (i < input.length ? input[i].type : END);
  const show = (i: number) =>
    i < input.length
      ? `${input[i].type}${input[i].type !== input[i].text ? `「${input[i].text}」` : ''}`
      : '$（输入结束）';
  steps.push({
    kind: 'start',
    stack: names(),
    position: 0,
    node: 0,
    message: `栈里先放 $ 和开始符号 ${grammar.start}。栈顶是“接下来要认出的东西”，右边是还没读的 Token。`,
  });
  let i = 0;
  while (steps.length < GRAMMAR_LIMITS.parseSteps) {
    const top = stack.at(-1)!;
    const next = lookahead(i);
    if (top.symbol === END) {
      if (next === END) {
        steps.push({
          kind: 'accept',
          stack: names(),
          position: i,
          message: '栈里只剩 $，输入也读完了：解析成功。',
        });
        return { steps, nodes, accepted: true };
      }
      const error = `规则已经全部用完，但输入里还剩 ${show(i)}。`;
      steps.push({ kind: 'error', stack: names(), position: i, message: error });
      return { steps, nodes, accepted: false, error };
    }
    if (!grammar.nonterminals.includes(top.symbol)) {
      if (top.symbol === next) {
        stack.pop();
        const node = nodes[top.node!];
        node.matchedAt = steps.length;
        node.text = input[i].text;
        i++;
        steps.push({
          kind: 'match',
          stack: names(),
          position: i,
          node: node.id,
          message: `栈顶 ${top.symbol} 和下一个 Token 一样：匹配成功，弹出它，读入下一个 Token。`,
        });
        continue;
      }
      const error = `这里应该是 ${top.symbol}，但读到的是 ${show(i)}。`;
      steps.push({ kind: 'error', stack: names(), position: i, message: error });
      return { steps, nodes, accepted: false, error };
    }
    const entries = table[top.symbol][next] || [];
    if (!entries.length) {
      const expected = Object.keys(table[top.symbol]);
      const error = `${top.symbol} 不能以 ${show(i)} 开始；查表这一格是空的。这里能接受的是 ${setText(expected)}。`;
      steps.push({ kind: 'error', stack: names(), position: i, message: error });
      return { steps, nodes, accepted: false, error };
    }
    const production = grammar.productions[entries[0].production];
    stack.pop();
    const parent = nodes[top.node!];
    const step = steps.length;
    const children = (production.rhs.length ? production.rhs : [EPSILON]).map((symbol) => {
      const node: TreeNode = { id: nodes.length, symbol, children: [], createdAt: step };
      nodes.push(node);
      parent.children.push(node.id);
      return node;
    });
    for (let k = production.rhs.length - 1; k >= 0; k--)
      stack.push({ symbol: production.rhs[k], node: children[k].id });
    steps.push({
      kind: 'expand',
      stack: names(),
      position: i,
      production: production.id,
      node: parent.id,
      message: production.rhs.length
        ? `栈顶是 ${top.symbol}，下一个 Token 是 ${show(i)}：查表得到 ${productionText(production)}。把右边倒着压栈，最左边的 ${production.rhs[0]} 就到了栈顶。`
        : `栈顶是 ${top.symbol}，下一个 Token 是 ${show(i)}，它在 FOLLOW(${top.symbol}) 里：选 ${productionText(production)}，${top.symbol} 什么也不产生，直接弹出。`,
    });
  }
  const error = `解析超过 ${GRAMMAR_LIMITS.parseSteps} 步，已停止。`;
  steps.push({ kind: 'error', stack: names(), position: i, message: error });
  return { steps, nodes, accepted: false, error };
}

// ---------- whole analysis ----------

export type GrammarFrame = {
  phase: 'first' | 'follow' | 'table' | 'parse';
  index: number;
  message: string;
};
export interface GrammarNote {
  kind: 'terminal-guess' | 'unreachable';
  symbol: string;
  message: string;
}
export interface GrammarAnalysis {
  spec: GrammarSpec;
  first: SetMap;
  follow: SetMap;
  firstSteps: SetStep[];
  followSteps: SetStep[];
  table: Record<string, Record<string, TableEntry[]>>;
  tableSteps: TableStep[];
  conflicts: Conflict[];
  leftRecursion: LeftRecursion[];
  rewrite?: string;
  parse?: ParseResult;
  notes: GrammarNote[];
  frames: GrammarFrame[];
}
export type GrammarOutcome =
  { ok: true; analysis: GrammarAnalysis } | { ok: false; issue: GrammarIssue };

export function analyzeGrammar(source: string): GrammarOutcome {
  try {
    const spec = parseGrammarSpec(source);
    const { grammar } = spec;
    const firstResult = computeFirst(grammar);
    const followResult = computeFollow(grammar, firstResult.first);
    const {
      table,
      steps: tableSteps,
      conflicts,
    } = buildTable(grammar, firstResult.first, followResult.follow);
    const leftRecursion = findLeftRecursion(grammar, firstResult.first);
    const rewrite =
      leftRecursion.length && leftRecursion.every((l) => l.direct)
        ? rewriteDirectLeftRecursion(grammar)
        : undefined;
    const parse = conflicts.length ? undefined : parseWithTable(grammar, table, spec.input);
    const notes: GrammarNote[] = [];
    for (const t of grammar.terminals)
      if (/^[a-z]/.test(t) && t !== 'eps')
        notes.push({
          kind: 'terminal-guess',
          symbol: t,
          message: `${t} 没有自己的产生式，所以被当成终结符（Token）。如果它本该是非终结符，请补上 ${t} -> …。`,
        });
    const reachable = new Set([grammar.start]);
    const queue = [grammar.start];
    while (queue.length) {
      const n = queue.shift()!;
      for (const p of grammar.productions)
        if (p.lhs === n)
          for (const s of p.rhs)
            if (grammar.nonterminals.includes(s) && !reachable.has(s)) {
              reachable.add(s);
              queue.push(s);
            }
    }
    for (const n of grammar.nonterminals)
      if (!reachable.has(n))
        notes.push({
          kind: 'unreachable',
          symbol: n,
          message: `从开始符号 ${grammar.start} 出发永远用不到 ${n}。开始符号是第一条产生式的左边。`,
        });
    const frames: GrammarFrame[] = [
      ...firstResult.steps.map((s, index) => ({
        phase: 'first' as const,
        index,
        message: s.reason,
      })),
      ...followResult.steps.map((s, index) => ({
        phase: 'follow' as const,
        index,
        message: s.reason,
      })),
      ...tableSteps.map((s, index) => ({ phase: 'table' as const, index, message: s.reason })),
      ...(parse?.steps || []).map((s, index) => ({
        phase: 'parse' as const,
        index,
        message: s.message,
      })),
    ];
    if (conflicts.length)
      frames.push({
        phase: 'table',
        index: tableSteps.length,
        message: `分析表有 ${conflicts.length} 个格子放了不止一条产生式：只看下一个 Token 没法决定，这个文法不是 LL(1)，所以不做表驱动解析。`,
      });
    return {
      ok: true,
      analysis: {
        spec,
        first: snapshot(firstResult.first),
        follow: snapshot(followResult.follow),
        firstSteps: firstResult.steps,
        followSteps: followResult.steps,
        table,
        tableSteps,
        conflicts,
        leftRecursion,
        rewrite,
        parse,
        notes,
        frames,
      },
    };
  } catch (error) {
    if (error instanceof GrammarError) return { ok: false, issue: error.issue };
    throw error;
  }
}
