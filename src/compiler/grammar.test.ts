import { describe, expect, it } from 'vitest';
import {
  analyzeGrammar,
  END,
  EPSILON,
  parseGrammarSpec,
  parseWithTable,
  type Grammar,
  type GrammarAnalysis,
} from './grammar';
import { grammarPresets } from '../content/grammar';

function ok(source: string): GrammarAnalysis {
  const outcome = analyzeGrammar(source);
  if (!outcome.ok) throw new Error(outcome.issue.message);
  return outcome.analysis;
}
const sorted = (values: string[] = []) => [...values].sort();
const preset = (id: string) => grammarPresets.find((p) => p.id === id)!.code;

// Independent oracle: every terminal string of length ≤ max, by expanding leftmost nonterminals.
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
function* strings(alphabet: string[], max: number): Generator<string[]> {
  yield [];
  let layer: string[][] = [[]];
  for (let n = 1; n <= max; n++) {
    layer = layer.flatMap((s) => alphabet.map((a) => [...s, a]));
    yield* layer;
  }
}

describe('grammar text', () => {
  it('separates nonterminals, terminals, ε and continuation lines', () => {
    const { grammar } = parseGrammarSpec("s -> a s'\ns' -> + a s'\n  | ε\na -> Num\n%%\n");
    expect(grammar.start).toBe('s');
    expect(grammar.nonterminals).toEqual(['s', "s'", 'a']);
    expect(grammar.terminals).toEqual(['+', 'Num']);
    expect(grammar.productions[2].rhs).toEqual([]);
  });
  it('maps input words and digits onto Num / Id and keeps literal terminals', () => {
    const spec = parseGrammarSpec(preset('g-stmt'));
    expect(spec.input.slice(0, 5).map((t) => `${t.type}:${t.text}`)).toEqual([
      'Int:Int',
      'Id:a',
      '=:=',
      'Num:2',
      ';:;',
    ]);
    expect(parseGrammarSpec('e -> Num + Num\n%%\n2+3').input.map((t) => t.type)).toEqual([
      'Num',
      '+',
      'Num',
    ]);
  });
  it('rejects malformed grammars and unknown input with positions', () => {
    const issue = (source: string) => {
      const outcome = analyzeGrammar(source);
      return outcome.ok ? '' : outcome.issue.message;
    };
    expect(issue('a -> b')).toContain('%%');
    expect(issue('a b\n%%\n')).toContain('->');
    expect(issue('a -> b |\n%%\n')).toContain('空候选');
    expect(issue('a -> b ε\n%%\n')).toContain('单独');
    expect(issue('a -> b $\n%%\n')).toContain('$');
    expect(issue('a -> b\na -> b\n%%\n')).toContain('重复');
    expect(issue('a -> Num\n%%\nx')).toContain('不是文法中的终结符');
    expect(issue(`a -> Num\n%%\n${'Num '.repeat(61)}`)).toContain('60');
  });
});

describe('FIRST and FOLLOW', () => {
  // Classic textbook grammar (Dragon book, expression grammar without left recursion).
  const classic =
    "E -> T E'\nE' -> + T E' | ε\nT -> F T'\nT' -> * F T' | ε\nF -> ( E ) | id\n%%\nid + id * id";
  it('matches the textbook sets', () => {
    const a = ok(classic);
    expect(sorted(a.first.E)).toEqual(sorted(['(', 'id']));
    expect(sorted(a.first["E'"])).toEqual(sorted(['+', EPSILON]));
    expect(sorted(a.first["T'"])).toEqual(sorted(['*', EPSILON]));
    expect(sorted(a.follow.E)).toEqual(sorted([')', END]));
    expect(sorted(a.follow["E'"])).toEqual(sorted([')', END]));
    expect(sorted(a.follow.T)).toEqual(sorted(['+', ')', END]));
    expect(sorted(a.follow["T'"])).toEqual(sorted(['+', ')', END]));
    expect(sorted(a.follow.F)).toEqual(sorted(['+', '*', ')', END]));
  });
  it('records a fixed-point iteration that ends with an unchanged round', () => {
    const a = ok(classic);
    expect(a.firstSteps.at(-1)!.added).toEqual([]);
    expect(a.firstSteps.at(-1)!.reason).toContain('不动点');
    // Later steps never lose elements.
    for (let i = 1; i < a.firstSteps.length; i++)
      for (const [name, values] of Object.entries(a.firstSteps[i - 1].sets))
        for (const v of values) expect(a.firstSteps[i].sets[name]).toContain(v);
    expect(a.followSteps[0].sets.E).toEqual([END]);
  });
  it('answers the book exercise for the statement grammar', () => {
    const a = ok(preset('g-stmt'));
    expect(sorted(a.first.stmt)).toEqual(sorted(['Int', 'Num', 'Id', '(', 'Return']));
    expect(sorted(a.first.stmts)).toEqual(sorted(['Int', 'Num', 'Id', '(', 'Return', EPSILON]));
    expect(sorted(a.follow.stmts)).toEqual([END]);
    expect(sorted(a.follow.init)).toEqual([';']);
    expect(a.conflicts).toEqual([]);
  });
});

describe('LL(1) table and parsing', () => {
  it('parses the expression preset and builds a tree whose leaves spell the input', () => {
    const a = ok(preset('g-expr'));
    expect(a.conflicts).toEqual([]);
    expect(a.parse!.accepted).toBe(true);
    const leaves: string[] = [];
    const walk = (id: number) => {
      const node = a.parse!.nodes[id];
      if (!node.children.length && node.text !== undefined) leaves.push(node.text);
      node.children.forEach(walk);
    };
    walk(0);
    expect(leaves).toEqual(['2', '+', '3', '*', '4']);
    // Reaching $ chooses the ε productions because $ is in their FOLLOW sets.
    expect(a.parse!.steps.some((s) => s.kind === 'expand' && s.message.includes("add' -> ε"))).toBe(
      true,
    );
  });
  it('reports where the input stops fitting the grammar', () => {
    const a = ok(preset('g-expr').replace('2 + 3 * 4', '2 + * 4'));
    expect(a.parse!.accepted).toBe(false);
    expect(a.parse!.error).toContain('*');
    expect(a.parse!.steps.at(-1)!.position).toBe(2);
  });
  it('accepts exactly the strings the grammar generates (brute-force oracle)', () => {
    for (const id of ['g-expr', 'g-right', 'g-stmt']) {
      const base = ok(preset(id));
      const grammar = base.spec.grammar;
      const max = id === 'g-stmt' ? 4 : 6;
      const generated = language(grammar, max);
      expect(generated.size).toBeGreaterThan(2);
      for (const tokens of strings(grammar.terminals, max)) {
        const input = tokens.map((type) => ({ type, text: type }));
        expect(
          parseWithTable(grammar, base.table, input).accepted,
          `${id}: ${tokens.join(' ')}`,
        ).toBe(generated.has(tokens.join(' ')));
      }
    }
  });
  it('finds FIRST/FIRST conflicts and does not parse', () => {
    const a = ok(preset('g-prefix'));
    expect(a.conflicts).toEqual([
      { nonterminal: 'stmt', terminal: 'Id', productions: [0, 1], kind: 'FIRST/FIRST' },
    ]);
    expect(a.parse).toBeUndefined();
    expect(a.frames.at(-1)!.message).toContain('不是 LL(1)');
  });
  it('finds FIRST/FOLLOW conflicts', () => {
    // The dangling-else shape: after "x", an "e" may close either if.
    const a = ok('s -> i s t | x\nt -> e s | ε\n%%\n');
    expect(a.conflicts).toEqual([
      { nonterminal: 't', terminal: 'e', productions: [2, 3], kind: 'FIRST/FOLLOW' },
    ]);
  });
});

describe('left recursion', () => {
  it('detects the book grammar, explains the conflict and rewrites it into LL(1)', () => {
    const a = ok(preset('g-left'));
    expect(a.leftRecursion.map((l) => [l.nonterminal, l.direct])).toEqual([
      ['add', true],
      ['mul', true],
    ]);
    expect(a.conflicts.length).toBeGreaterThan(0);
    expect(a.rewrite).toBe(
      "add -> mul add'\nadd' -> + mul add' | ε\nmul -> pri mul'\nmul' -> * pri mul' | ε\npri -> Num | ( add )",
    );
    const rewritten = ok(`${a.rewrite}\n%%\n2 + 3 * 4`);
    expect(rewritten.conflicts).toEqual([]);
    expect(rewritten.parse!.accepted).toBe(true);
    // The rewrite keeps the language: compare short strings with the original grammar.
    const before = language(a.spec.grammar, 5);
    const after = language(rewritten.spec.grammar, 5);
    expect([...after].sort()).toEqual([...before].sort());
  });
  it('finds indirect left recursion through a nullable prefix but does not auto-rewrite it', () => {
    const a = ok('a -> n b x | y\nb -> a z | w\nn -> ε | q\n%%\n');
    const found = a.leftRecursion.find((l) => l.nonterminal === 'a')!;
    expect(found.direct).toBe(false);
    expect(found.path).toEqual(['a', 'b', 'a']);
    expect(a.rewrite).toBeUndefined();
  });
  it('notes lower-case symbols without productions and unreachable rules', () => {
    const a = ok('s -> expr ;\nt -> Num\n%%\n');
    expect(a.notes.map((n) => [n.kind, n.symbol])).toEqual([
      ['terminal-guess', 'expr'],
      ['unreachable', 't'],
    ]);
  });
});

describe('timeline', () => {
  it('runs in phase order with non-empty messages for every preset', () => {
    for (const p of grammarPresets) {
      const a = ok(p.code);
      const order = a.frames.map((f) => ['first', 'follow', 'table', 'parse'].indexOf(f.phase));
      expect(order, p.id).toEqual([...order].sort((x, y) => x - y));
      expect(a.frames.every((f) => f.message.length > 0)).toBe(true);
    }
  });
});
