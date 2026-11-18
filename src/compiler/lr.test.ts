import { describe, expect, it } from 'vitest';
import { analyzeGrammar, type Grammar } from './grammar';
import { analyzeLr, parseLr, type LrAnalysis, type LrNode } from './lr';
import { lrPresets } from '../content/lr';

function ok(source: string): LrAnalysis {
  const outcome = analyzeLr(source);
  if (!outcome.ok) throw new Error(outcome.issue.message);
  return outcome.analysis;
}
const preset = (id: string) => lrPresets.find((p) => p.id === id)!.code;
const BOOK =
  'start -> add\nadd -> add + mul | mul\nmul -> mul * pri | pri\npri -> Num | ( add )\n%%\n';

/** Evaluates the bottom-up tree of the book grammar: an independent check of its shape. */
function evaluate(nodes: LrNode[], id: number): number {
  const node = nodes[id];
  const kids = node.children.map((c) => nodes[c]);
  if (node.symbol === 'Num') return Number(node.text);
  if (kids.length === 1) return evaluate(nodes, kids[0].id);
  if (kids[0].symbol === '(') return evaluate(nodes, kids[1].id);
  const left = evaluate(nodes, kids[0].id);
  const right = evaluate(nodes, kids[2].id);
  return kids[1].symbol === '+' ? left + right : left * right;
}
const root = (a: LrAnalysis) => a.parse!.steps.at(-1)!.stack[1].node!;

function language(grammar: Grammar, max: number): Set<string> {
  const out = new Set<string>();
  const seen = new Set<string>();
  const queue: string[][] = [[grammar.start]];
  while (queue.length) {
    const form = queue.shift()!;
    const key = form.join(' ');
    if (seen.has(key)) continue;
    seen.add(key);
    const at = form.findIndex((s) => grammar.nonterminals.includes(s));
    if (at < 0) {
      out.add(key);
      continue;
    }
    for (const p of grammar.productions.filter((q) => q.lhs === form[at])) {
      const next = [...form.slice(0, at), ...p.rhs, ...form.slice(at + 1)];
      const terminals = next.filter((s) => !grammar.nonterminals.includes(s)).length;
      if (terminals <= max && next.length <= max + 6) queue.push(next);
    }
  }
  return out;
}

describe('LR(0) item sets', () => {
  it('builds the 12 textbook states for the classic expression grammar', () => {
    const a = ok('E -> E + T | T\nT -> T * F | F\nF -> ( E ) | id\n%%\nid');
    expect(a.states).toHaveLength(12);
    // State 0 is the closure of S′ → · E.
    expect(a.states[0].kernel).toEqual([{ production: 0, dot: 0 }]);
    expect(a.states[0].items).toHaveLength(7);
    expect(new Set(a.states[0].closure.map((c) => c.because))).toEqual(new Set(['E', 'T', 'F']));
  });
  it('records one construction step per state, in discovery order', () => {
    const a = ok(BOOK + '1');
    expect(a.itemSteps.map((s) => s.state)).toEqual(a.states.map((s) => s.id));
    const created = a.itemSteps.flatMap((s) => s.created);
    expect(created).toEqual(a.states.slice(1).map((s) => s.id));
  });
});

describe('SLR(1) parsing', () => {
  it('parses the left-recursive book grammar with the right precedence and associativity', () => {
    for (const [input, value] of [
      ['2 + 3 * 5', 17],
      ['( 2 + 3 ) * 5', 25],
      ['2 * 3 + 4 * 5', 26],
      ['1 + 2 + 3', 6],
    ] as const) {
      const a = ok(BOOK + input);
      expect(a.conflicts).toEqual([]);
      expect(a.parse!.accepted, input).toBe(true);
      expect(evaluate(a.parse!.nodes, root(a)), input).toBe(value);
    }
    // Left associativity: the left child of the top add is itself an add.
    const a = ok(BOOK + '1 + 2 + 3');
    const top = a.parse!.nodes[a.parse!.nodes[root(a)].children[0]];
    expect(top.symbol).toBe('add');
    expect(a.parse!.nodes[top.children[0]].symbol).toBe('add');
  });
  it('shifts * instead of reducing a complete add + mul, and says why', () => {
    const a = ok(BOOK + '2 + 3 * 5');
    const step = a.parse!.steps.find((s) => s.kind === 'shift' && s.cell?.terminal === '*')!;
    expect(step.message).toContain('先不规约');
    expect(step.message).toContain('add → add + mul');
  });
  it('reads the reductions backwards as a rightmost derivation', () => {
    const a = ok(BOOK + '2 + 3 * 5');
    const forms = a.parse!.derivation;
    expect(forms[0]).toEqual(['start']);
    expect(forms.slice(1, 4).map((f) => f.join(' '))).toEqual([
      'add',
      'add + mul',
      'add + mul * pri',
    ]);
    expect(forms.at(-1)).toEqual(['Num', '+', 'Num', '*', 'Num']);
    const nonterminals = a.spec.grammar.nonterminals;
    for (let i = 1; i < forms.length; i++) {
      // Everything right of the expanded symbol is already terminals.
      const before = forms[i - 1];
      let at = before.length - 1;
      while (at >= 0 && !nonterminals.includes(before[at])) at--;
      expect(forms[i].slice(forms[i].length - (before.length - at - 1))).toEqual(
        before.slice(at + 1),
      );
    }
  });
  it('accepts exactly the strings the grammar generates (brute-force oracle)', () => {
    for (const source of [
      BOOK,
      preset('lr-prefix').replace(/%%[\s\S]*/, '%%\n'),
      preset('lr-empty').replace(/%%[\s\S]*/, '%%\n'),
    ]) {
      const a = ok(source);
      const generated = language(a.spec.grammar, 5);
      const alphabet = a.spec.grammar.terminals;
      let layer: string[][] = [[]];
      const all: string[][] = [[]];
      for (let n = 1; n <= 5; n++) {
        layer = layer.flatMap((s) => alphabet.map((t) => [...s, t]));
        all.push(...layer);
      }
      for (const tokens of all) {
        const result = parseLr(
          a.productions,
          a.states,
          { action: a.action, goto: a.goto },
          a.follow,
          tokens.map((type) => ({ type, text: type === 'Num' ? '1' : type })),
        );
        expect(result.accepted, tokens.join(' ')).toBe(generated.has(tokens.join(' ')));
      }
    }
  });
  it('handles the LL(1) common-prefix grammar and ε reductions', () => {
    const prefix = ok(preset('lr-prefix'));
    expect(prefix.conflicts).toEqual([]);
    expect(prefix.parse!.accepted).toBe(true);
    const ll = analyzeGrammar(preset('lr-prefix'));
    expect(ll.ok && ll.analysis.conflicts.length).toBe(1);
    const empty = ok(preset('lr-empty'));
    expect(empty.parse!.steps[1].kind).toBe('reduce');
    expect(empty.parse!.steps[1].message).toContain('list → ε');
    expect(empty.parse!.accepted).toBe(true);
  });
  it('reports where the input stops fitting', () => {
    const a = ok(BOOK + '2 + * 5');
    expect(a.parse!.accepted).toBe(false);
    expect(a.parse!.error).toContain('只能出现');
    expect(a.parse!.steps.at(-1)!.position).toBe(2);
  });
});

describe('conflicts', () => {
  it('finds shift/reduce in an ambiguous grammar and reduce/reduce between twins', () => {
    const ambiguous = ok(preset('lr-ambiguous'));
    expect(ambiguous.conflicts.map((c) => [c.terminal, c.kind])).toEqual([['+', '移进/规约']]);
    expect(ambiguous.parse).toBeUndefined();
    const twins = ok(preset('lr-reduce'));
    expect(twins.conflicts.map((c) => [c.terminal, c.kind])).toEqual([['$', '规约/规约']]);
  });
  it('shows the documented SLR limitation on an LR(1) grammar', () => {
    const a = ok('S -> L = R | R\nL -> * R | Id\nR -> L\n%%\n');
    expect(a.conflicts.map((c) => [c.terminal, c.kind])).toEqual([['=', '移进/规约']]);
  });
  it('keeps every preset timeline in phase order with messages', () => {
    for (const p of lrPresets) {
      const a = ok(p.code);
      const order = a.frames.map((f) => ['items', 'table', 'parse'].indexOf(f.phase));
      expect(order, p.id).toEqual([...order].sort((x, y) => x - y));
      expect(a.frames.every((f) => f.message.length > 0)).toBe(true);
    }
  });
});
