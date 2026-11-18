// Bottom-up parsing: LR(0) item sets, SLR(1) ACTION / GOTO tables and shift-reduce parsing (原书第 03 讲后半).
// Reuses the grammar text format and FIRST / FOLLOW from grammar.ts.

import {
  END,
  EPSILON,
  GrammarError,
  computeFirst,
  computeFollow,
  parseGrammarSpec,
  setText,
  type GrammarIssue,
  type GrammarSpec,
  type InputToken,
  type SetMap,
} from './grammar';

export const LR_LIMITS = { states: 80, parseSteps: 600 } as const;
/** Augmented start symbol. The prime (U+2032) cannot appear in user grammars. */
export const AUGMENTED = 'S′';

export interface LrProduction {
  /** 0 is the augmented S′ -> start; user productions keep their P1… numbering. */
  id: number;
  lhs: string;
  rhs: string[];
}
export interface Item {
  production: number;
  dot: number;
}
export const itemKey = (item: Item) => `${item.production}.${item.dot}`;
export function itemText(productions: LrProduction[], item: Item) {
  const p = productions[item.production];
  const rhs = [...p.rhs];
  rhs.splice(item.dot, 0, '·');
  return `${p.lhs} → ${rhs.join(' ')}`;
}

export interface LrState {
  id: number;
  kernel: Item[];
  /** Items added by closure, with the nonterminal after a dot that pulled them in. */
  closure: { item: Item; because: string }[];
  items: Item[];
  transitions: { symbol: string; target: number }[];
  /** Where the state was first reached from. */
  from?: { state: number; symbol: string };
}
export interface ItemStep {
  state: number;
  created: number[];
  message: string;
}

function augment(spec: GrammarSpec): LrProduction[] {
  return [
    { id: 0, lhs: AUGMENTED, rhs: [spec.grammar.start] },
    ...spec.grammar.productions.map((p) => ({ id: p.id + 1, lhs: p.lhs, rhs: p.rhs })),
  ];
}

export function closure(productions: LrProduction[], nonterminals: string[], kernel: Item[]) {
  const items = [...kernel];
  const seen = new Set(items.map(itemKey));
  const added: { item: Item; because: string }[] = [];
  for (let i = 0; i < items.length; i++) {
    const p = productions[items[i].production];
    const next = p.rhs[items[i].dot];
    if (!next || !nonterminals.includes(next)) continue;
    for (const q of productions)
      if (q.lhs === next) {
        const item = { production: q.id, dot: 0 };
        if (seen.has(itemKey(item))) continue;
        seen.add(itemKey(item));
        items.push(item);
        added.push({ item, because: next });
      }
  }
  return { items, added };
}

export function buildItemSets(spec: GrammarSpec) {
  const productions = augment(spec);
  const { nonterminals } = spec.grammar;
  const states: LrState[] = [];
  const steps: ItemStep[] = [];
  const index = new Map<string, number>();
  const keyOf = (kernel: Item[]) => kernel.map(itemKey).sort().join(' ');
  const add = (kernel: Item[], from?: LrState['from']) => {
    if (states.length >= LR_LIMITS.states)
      throw new GrammarError({
        message: `LR(0) 状态超过 ${LR_LIMITS.states} 个，请缩小文法。`,
        start: 0,
        end: 0,
      });
    const { items, added } = closure(productions, nonterminals, kernel);
    const state: LrState = {
      id: states.length,
      kernel,
      closure: added,
      items,
      transitions: [],
      from,
    };
    states.push(state);
    index.set(keyOf(kernel), state.id);
    return state.id;
  };
  add([{ production: 0, dot: 0 }]);
  for (let s = 0; s < states.length; s++) {
    const state = states[s];
    const symbols: string[] = [];
    for (const item of state.items) {
      const next = productions[item.production].rhs[item.dot];
      if (next && !symbols.includes(next)) symbols.push(next);
    }
    const created: number[] = [];
    for (const symbol of symbols) {
      const kernel = state.items
        .filter((item) => productions[item.production].rhs[item.dot] === symbol)
        .map((item) => ({ production: item.production, dot: item.dot + 1 }));
      let target = index.get(keyOf(kernel));
      if (target === undefined) {
        target = add(kernel, { state: s, symbol });
        created.push(target);
      }
      state.transitions.push({ symbol, target });
    }
    const closureText = state.closure.length
      ? `点后面是 ${[...new Set(state.closure.map((c) => c.because))].join('、')}，接下来可能开始认它们，所以把它们的产生式（点在最前）也加进来；`
      : '';
    steps.push({
      state: s,
      created,
      message: `${s === 0 ? `状态 0 从 ${AUGMENTED} → · ${spec.grammar.start} 出发：还什么都没读，正等着认出整个 ${spec.grammar.start}。` : `状态 ${s}（由状态 ${state.from!.state} 读入 ${state.from!.symbol} 得到）：把点往后挪一格。`}${closureText}${symbols.length ? `再按点后面的符号 ${symbols.join(' ')} 分别前进${created.length ? `，新得到状态 ${created.join('、')}` : '，没有新状态'}。` : '所有项目的点都在末尾，这里只能规约。'}`,
    });
  }
  return { productions, states, steps };
}

// ---------- SLR(1) table ----------

export type LrAction =
  { kind: 'shift'; target: number } | { kind: 'reduce'; production: number } | { kind: 'accept' };
export interface LrConflict {
  state: number;
  terminal: string;
  actions: LrAction[];
  kind: '移进/规约' | '规约/规约';
}
export interface TableStep {
  state: number;
  message: string;
}
export const actionText = (a: LrAction) =>
  a.kind === 'shift' ? `s${a.target}` : a.kind === 'reduce' ? `r${a.production}` : 'acc';

export function buildLrTable(
  productions: LrProduction[],
  states: LrState[],
  terminals: string[],
  follow: SetMap,
) {
  const action: Record<string, LrAction[]>[] = states.map(() => ({}));
  const goto: Record<string, number>[] = states.map(() => ({}));
  const steps: TableStep[] = [];
  const push = (s: number, t: string, a: LrAction) => {
    const cell = (action[s][t] ||= []);
    if (!cell.some((x) => actionText(x) === actionText(a))) cell.push(a);
  };
  for (const state of states) {
    const notes: string[] = [];
    for (const { symbol, target } of state.transitions)
      if (terminals.includes(symbol)) push(state.id, symbol, { kind: 'shift', target });
      else goto[state.id][symbol] = target;
    const shifts = state.transitions.filter((t) => terminals.includes(t.symbol));
    if (shifts.length)
      notes.push(`点后面是 ${shifts.map((t) => t.symbol).join('、')}：读到它们就移进`);
    for (const item of state.items) {
      const p = productions[item.production];
      if (item.dot < p.rhs.length) continue;
      if (p.id === 0) {
        push(state.id, END, { kind: 'accept' });
        notes.push(`${AUGMENTED} → ${p.rhs[0]} · 完整了：读到 $ 就接受`);
        continue;
      }
      const lookahead = follow[p.lhs];
      for (const t of lookahead) push(state.id, t, { kind: 'reduce', production: p.id });
      notes.push(
        `${p.lhs} → ${p.rhs.length ? p.rhs.join(' ') : EPSILON} · 已经完整：只有下一个 Token 在 FOLLOW(${p.lhs}) = ${setText(lookahead)} 里时才规约`,
      );
    }
    const gotos = Object.entries(goto[state.id]);
    if (gotos.length)
      notes.push(`规约出 ${gotos.map(([n, t]) => `${n} 后转到状态 ${t}`).join('，')}（GOTO）`);
    steps.push({ state: state.id, message: `状态 ${state.id}：${notes.join('；')}。` });
  }
  const conflicts: LrConflict[] = [];
  action.forEach((row, s) => {
    for (const [terminal, actions] of Object.entries(row))
      if (actions.length > 1)
        conflicts.push({
          state: s,
          terminal,
          actions,
          kind: actions.some((a) => a.kind === 'shift') ? '移进/规约' : '规约/规约',
        });
  });
  return { action, goto, steps, conflicts };
}

// ---------- shift-reduce parsing ----------

export interface LrNode {
  id: number;
  symbol: string;
  children: number[];
  text?: string;
  createdAt: number;
}
export interface StackEntry {
  state: number;
  symbol?: string;
  node?: number;
}
export interface LrParseStep {
  kind: 'start' | 'shift' | 'reduce' | 'accept' | 'error';
  stack: StackEntry[];
  position: number;
  /** ACTION cell that decided this step. */
  cell?: { state: number; terminal: string };
  production?: number;
  message: string;
}
export interface LrParse {
  steps: LrParseStep[];
  nodes: LrNode[];
  accepted: boolean;
  error?: string;
  /** Rightmost derivation, i.e. the reductions read backwards. */
  derivation: string[][];
}

export function parseLr(
  productions: LrProduction[],
  states: LrState[],
  table: { action: Record<string, LrAction[]>[]; goto: Record<string, number>[] },
  follow: SetMap,
  input: InputToken[],
): LrParse {
  const nodes: LrNode[] = [];
  const stack: StackEntry[] = [{ state: 0 }];
  const steps: LrParseStep[] = [];
  const show = (i: number) =>
    i < input.length
      ? `${input[i].type}${input[i].type !== input[i].text ? `「${input[i].text}」` : ''}`
      : '$';
  const snapshot = () => stack.map((e) => ({ ...e }));
  const forms: string[][] = [input.map((t) => t.type)];
  steps.push({
    kind: 'start',
    stack: snapshot(),
    position: 0,
    message: '栈里先放状态 0，还没有任何符号。栈是拼装语法树的工作区，右边是还没读的 Token。',
  });
  let i = 0;
  while (steps.length < LR_LIMITS.parseSteps) {
    const top = stack.at(-1)!;
    const lookahead = i < input.length ? input[i].type : END;
    const actions = table.action[top.state][lookahead] || [];
    const cell = { state: top.state, terminal: lookahead };
    if (!actions.length) {
      const expected = Object.keys(table.action[top.state]);
      const error = `状态 ${top.state} 遇到 ${show(i)} 时没有可做的动作：这里只能出现 ${setText(expected)}。`;
      steps.push({ kind: 'error', stack: snapshot(), position: i, cell, message: error });
      return { steps, nodes, accepted: false, error, derivation: [] };
    }
    const act = actions[0];
    if (act.kind === 'accept') {
      steps.push({
        kind: 'accept',
        stack: snapshot(),
        position: i,
        cell,
        message: `栈里只剩一个 ${stack[1].symbol}，输入也读完了：整棵树拼好了，接受。`,
      });
      return { steps, nodes, accepted: true, derivation: forms.reverse() };
    }
    if (act.kind === 'shift') {
      const node: LrNode = {
        id: nodes.length,
        symbol: lookahead,
        children: [],
        text: input[i].text,
        createdAt: steps.length,
      };
      nodes.push(node);
      stack.push({ state: act.target, symbol: lookahead, node: node.id });
      // Explain why a complete item was not reduced yet, when that is the interesting part.
      const waiting = states[top.state].items
        .map((item) => productions[item.production])
        .filter(
          (p, k) =>
            states[top.state].items[k].dot === p.rhs.length &&
            p.id !== 0 &&
            !follow[p.lhs].includes(lookahead),
        );
      i++;
      steps.push({
        kind: 'shift',
        stack: snapshot(),
        position: i,
        cell,
        message: `状态 ${top.state} 遇到 ${show(i - 1)}：移进，把它压栈，转到状态 ${act.target}。${waiting.length ? `虽然 ${waiting.map((p) => `${p.lhs} → ${p.rhs.join(' ')}`).join('、')} 已经完整，但 ${lookahead} 不会跟在 ${waiting.map((p) => p.lhs).join('、')} 后面，所以先不规约。` : ''}`,
      });
      continue;
    }
    const p = productions[act.production];
    const popped = stack.splice(stack.length - p.rhs.length, p.rhs.length);
    const node: LrNode = { id: nodes.length, symbol: p.lhs, children: [], createdAt: steps.length };
    nodes.push(node);
    if (p.rhs.length) node.children = popped.map((e) => e.node!);
    else {
      const eps: LrNode = {
        id: nodes.length,
        symbol: EPSILON,
        children: [],
        createdAt: steps.length,
      };
      nodes.push(eps);
      node.children = [eps.id];
    }
    const under = stack.at(-1)!;
    const target = table.goto[under.state][p.lhs];
    stack.push({ state: target, symbol: p.lhs, node: node.id });
    forms.push([...stack.slice(1).map((e) => e.symbol!), ...input.slice(i).map((t) => t.type)]);
    steps.push({
      kind: 'reduce',
      stack: snapshot(),
      position: i,
      cell,
      production: p.id,
      message: p.rhs.length
        ? `栈顶的 ${p.rhs.join(' ')} 正好是 ${p.lhs} → ${p.rhs.join(' ')} 的右边，下一个 ${show(i)} 在 FOLLOW(${p.lhs}) 里：规约，把它们合成一个 ${p.lhs}。露出的状态 ${under.state} 按 GOTO 遇到 ${p.lhs} 转到状态 ${target}。`
        : `下一个是 ${show(i)}，在 FOLLOW(${p.lhs}) 里：按 ${p.lhs} → ε 规约出一个空的 ${p.lhs}，不弹出任何东西，状态 ${under.state} 按 GOTO 转到状态 ${target}。`,
    });
  }
  const error = `解析超过 ${LR_LIMITS.parseSteps} 步，已停止。`;
  steps.push({ kind: 'error', stack: snapshot(), position: i, message: error });
  return { steps, nodes, accepted: false, error, derivation: [] };
}

// ---------- whole analysis ----------

export type LrFrame = { phase: 'items' | 'table' | 'parse'; index: number; message: string };
export interface LrAnalysis {
  spec: GrammarSpec;
  productions: LrProduction[];
  states: LrState[];
  itemSteps: ItemStep[];
  first: SetMap;
  follow: SetMap;
  action: Record<string, LrAction[]>[];
  goto: Record<string, number>[];
  tableSteps: TableStep[];
  conflicts: LrConflict[];
  parse?: LrParse;
  frames: LrFrame[];
}
export type LrOutcome = { ok: true; analysis: LrAnalysis } | { ok: false; issue: GrammarIssue };

export function analyzeLr(source: string): LrOutcome {
  try {
    const spec = parseGrammarSpec(source);
    const { first } = computeFirst(spec.grammar);
    const { follow } = computeFollow(spec.grammar, first);
    const followMap: SetMap = Object.fromEntries([...follow].map(([k, v]) => [k, [...v]]));
    const firstMap: SetMap = Object.fromEntries([...first].map(([k, v]) => [k, [...v]]));
    const { productions, states, steps: itemSteps } = buildItemSets(spec);
    const table = buildLrTable(productions, states, spec.grammar.terminals, followMap);
    const parse = table.conflicts.length
      ? undefined
      : parseLr(productions, states, table, followMap, spec.input);
    const frames: LrFrame[] = [
      ...itemSteps.map((s, index) => ({ phase: 'items' as const, index, message: s.message })),
      ...table.steps.map((s, index) => ({ phase: 'table' as const, index, message: s.message })),
      ...(parse?.steps || []).map((s, index) => ({
        phase: 'parse' as const,
        index,
        message: s.message,
      })),
    ];
    if (table.conflicts.length)
      frames.push({
        phase: 'table',
        index: table.steps.length,
        message: `表里有 ${table.conflicts.length} 个格子放了不止一个动作：遇到这个 Token 时，既可以这样又可以那样，SLR(1) 决定不了，所以不做解析。`,
      });
    return {
      ok: true,
      analysis: {
        spec,
        productions,
        states,
        itemSteps,
        first: firstMap,
        follow: followMap,
        action: table.action,
        goto: table.goto,
        tableSteps: table.steps,
        conflicts: table.conflicts,
        parse,
        frames,
      },
    };
  } catch (error) {
    if (error instanceof GrammarError) return { ok: false, issue: error.issue };
    throw error;
  }
}
