import { describe, expect, it } from 'vitest';
import {
  AUTOMATA_LIMITS,
  analyzeAutomata,
  backtrackMatch,
  buildDfa,
  buildNfa,
  epsilonClosure,
  parseRegex,
  parseSpec,
  rangesText,
  type AutomataAnalysis,
  type CharRange,
  type RegexNode,
} from './automata';
import { automataPresets } from '../content/automata';

function ok(source: string): AutomataAnalysis {
  const outcome = analyzeAutomata(source);
  if (!outcome.ok) throw new Error(outcome.issue.message);
  return outcome.analysis;
}
const tokens = (a: AutomataAnalysis) =>
  a.scan!.tokens.filter((t) => !t.skip).map((t) => `${a.spec.rules[t.rule].name}:${t.text}`);

// ---- independent oracle: JS RegExp built from the parsed AST, brute-force longest match ----
const esc = (code: number) => `\\u${code.toString(16).padStart(4, '0')}`;
const cls = (ranges: CharRange[]) =>
  `[${ranges.map(([lo, hi]) => (lo === hi ? esc(lo) : `${esc(lo)}-${esc(hi)}`)).join('')}]`;
function toJs(node: RegexNode): string {
  switch (node.kind) {
    case 'set':
      return cls(node.ranges);
    case 'concat':
      return node.parts.map(toJs).join('');
    case 'alt':
      return `(?:${node.options.map(toJs).join('|')})`;
    case 'repeat':
      return `(?:${toJs(node.body)})${node.op}`;
  }
}
function oracle(source: string) {
  const spec = parseSpec(source);
  const matchers = spec.rules.map((r) => new RegExp(`^(?:${toJs(r.ast)})$`));
  const out: string[] = [];
  let pos = 0;
  while (pos < spec.input.length) {
    let found: { end: number; rule: number } | undefined;
    for (let end = spec.input.length; end > pos && !found; end--) {
      const rule = matchers.findIndex((m) => m.test(spec.input.slice(pos, end)));
      if (rule >= 0) found = { end, rule };
    }
    if (!found) return { tokens: out, error: pos };
    const rule = spec.rules[found.rule];
    if (!rule.skip) out.push(`${rule.name}:${spec.input.slice(pos, found.end)}`);
    pos = found.end;
  }
  return { tokens: out, error: undefined };
}

describe('regex parsing', () => {
  it('parses classes, ranges, escapes and negation within the ASCII alphabet', () => {
    const node = parseRegex('[a-cx\\d]');
    expect(node.kind === 'set' && rangesText(node.ranges)).toBe('[0-9a-cx]');
    const negated = parseRegex('[^\\n]');
    expect(negated.kind === 'set' && negated.ranges).toEqual([
      [9, 9],
      [13, 13],
      [32, 126],
    ]);
    // Spaces outside a class are layout only; an escaped space is literal.
    const spaced = parseRegex('a b\\ c');
    expect(spaced.kind === 'concat' && spaced.parts.length).toBe(4);
  });
  it('rejects malformed patterns with a position', () => {
    for (const [pattern, message] of [
      ['a|', '空分支'],
      ['(ab', '右括号'],
      ['*a', '前面缺少'],
      ['[z-a]', '起点大于终点'],
      ['a{2}', '{m,n}'],
      ['\\q', '不支持的转义'],
      ['[]', '字符集不能为空'],
    ]) {
      expect(() => parseRegex(pattern), pattern).toThrow(message);
    }
  });
});

describe('Thompson-style construction (原书图 7–11)', () => {
  const nfaOf = (pattern: string) => buildNfa(parseSpec(`R: ${pattern}\n%%\n`).rules).nfa;
  it('merges states on concatenation: abc needs one state per character', () => {
    const nfa = nfaOf('abc');
    // start + rule entry + 3 character targets
    expect(nfa.states.length).toBe(5);
    expect(nfa.edges.filter((e) => e.ranges === null)).toHaveLength(1);
  });
  it('s* can skip and repeat; s+ cannot skip; s? cannot repeat', () => {
    const accepts = (pattern: string, text: string) =>
      backtrackMatch(nfaOf(pattern), text).outcome === 'match';
    expect(['', 'a', 'aaa'].map((t) => accepts('a*', t))).toEqual([true, true, true]);
    expect(['', 'a', 'aaa'].map((t) => accepts('a+', t))).toEqual([false, true, true]);
    expect(['', 'a', 'aa'].map((t) => accepts('a?', t))).toEqual([true, true, false]);
  });
  it('records each construction step and marks the accept state with the rule', () => {
    const { nfa, steps } = buildNfa(parseSpec('Int: int\nId: [a-z]+\n%%\n').rules);
    expect(steps.map((s) => s.kind)).toEqual([
      'start',
      'rule',
      'set',
      'set',
      'set',
      'concat',
      'accept',
      'rule',
      'set',
      'plus',
      'accept',
    ]);
    const accepting = nfa.states.filter((s) => s.rule !== undefined).map((s) => s.rule);
    expect(accepting).toEqual([0, 1]);
    // Every state becomes visible at or before the first step that uses it.
    for (const e of nfa.edges) {
      expect(nfa.states[e.from].step).toBeLessThanOrEqual(e.step);
      expect(nfa.states[e.to].step).toBeLessThanOrEqual(e.step);
    }
  });
});

describe('subset construction', () => {
  it('starts from the ε-closure and makes a deterministic table', () => {
    const { nfa } = buildNfa(parseSpec('R: (a|b)*abb\n%%\n').rules);
    const { dfa } = buildDfa(nfa, parseSpec('R: (a|b)*abb\n%%\n').rules);
    expect(dfa.states[0].nfa).toEqual(epsilonClosure(nfa, [nfa.start]));
    // Textbook result for (a|b)*abb: five DFA states, one accepting.
    expect(dfa.states).toHaveLength(5);
    expect(dfa.states.filter((s) => s.accept !== undefined)).toHaveLength(1);
    for (const state of dfa.states) {
      const out = dfa.edges.filter((e) => e.from === state.id).flatMap((e) => e.ranges);
      for (let i = 0; i < out.length; i++)
        for (let j = i + 1; j < out.length; j++)
          expect(out[i][1] < out[j][0] || out[j][1] < out[i][0]).toBe(true);
    }
  });
  it('resolves an accept conflict by rule order and reports a shadowed rule', () => {
    const first = ok('Int: int\nId: [a-z]+\n%%\nint');
    const conflict = first.dfa.states.find((s) => s.candidates.length > 1)!;
    expect(conflict.candidates).toEqual([0, 1]);
    expect(conflict.accept).toBe(0);
    expect(tokens(first)).toEqual(['Int:int']);
    const swapped = ok('Id: [a-z]+\nInt: int\n%%\nint');
    expect(tokens(swapped)).toEqual(['Id:int']);
    expect(swapped.notes[1].shadowed).toBe(true);
  });
  it('stops at the DFA state limit and does not scan with a partial automaton', () => {
    const a = ok('T: (a|b)* a (a|b)(a|b)(a|b)(a|b)(a|b)(a|b)\n%%\nab');
    expect(a.dfa.complete).toBe(false);
    expect(a.dfa.states).toHaveLength(AUTOMATA_LIMITS.dfaStates);
    expect(a.subset.at(-1)!.kind).toBe('limit');
    expect(a.scan).toBeUndefined();
    expect(a.frames.at(-1)!.phase).toBe('dfa');
  });
});

describe('maximal-munch scanning', () => {
  it('reads past an accept, then rolls back to the last accepting position', () => {
    const a = ok('Float: [0-9]+ \\. [0-9]+\nInt: [0-9]+\nDot: \\.\nskip: \\ +\n%%\n3.14 7. 8');
    expect(tokens(a)).toEqual(['Float:3.14', 'Int:7', 'Dot:.', 'Int:8']);
    const seven = a.scan!.tokens.find((t) => t.text === '7')!;
    expect(seven.reads).toBe(2);
  });
  it('never emits an empty token, and reports where no rule matches', () => {
    const a = ok('Num: [0-9]*\n%%\n12x');
    expect(a.notes[0].emptyMatch).toBe(true);
    expect(tokens(a)).toEqual(['Num:12']);
    expect(a.scan!.error!.position).toBe(2);
    expect(a.frames.at(-1)!.message).toContain('没有规则能匹配');
  });
  it('agrees with a brute-force RegExp oracle on every preset and extra cases', () => {
    const extra = [
      'A: a|ab|abc\nB: b+c?\n%%\nabcabbbcab',
      'Id: \\w+\nOp: [-+*/=<>!]=?|==\nskip: \\s+\n%%\nx1 = y_2 <= 3 != 4\nz',
      'Str: "[^"\\n]*"\nWord: [a-z]+\nskip: [ ]\n%%\nsay "hi there" now',
      'Comment: //[^\\n]*\nSlash: /\nskip: \\n\n%%\n/ // note\n/',
      'X: (a*)*b\nY: a+\n%%\naaab aa',
      'T: (ab|a)(bc|c)?\nU: b|c\n%%\nabcabcbc',
    ];
    for (const source of [...automataPresets.map((p) => p.code), ...extra]) {
      const outcome = analyzeAutomata(source);
      if (!outcome.ok) throw new Error(`${source}: ${outcome.issue.message}`);
      const a = outcome.analysis;
      if (!a.scan) continue;
      const expected = oracle(source);
      expect(tokens(a), source).toEqual(expected.tokens);
      expect(a.scan.error?.position, source).toBe(expected.error);
    }
  });
});

describe('backtracking NFA matcher', () => {
  it('reproduces the book example: intA tries the int path first, then backtracks', () => {
    const a = ok(automataPresets.find((p) => p.id === 'auto-book')!.code);
    const run = a.comparisons[0].backtrack;
    expect(run.outcome).toBe('match');
    // The int branch reaches its end at index 3 with "A" still unread.
    const intEnd = run.trace.findIndex((t) => t.index === 3);
    expect(intEnd).toBeGreaterThan(0);
    const firstBack = run.trace.findIndex((t, i) => i > intEnd && t.index === 0);
    expect(firstBack).toBeGreaterThan(intEnd);
  });
  it('picks the same rule as the DFA for every token (priority = edge order)', () => {
    for (const preset of automataPresets) {
      const a = ok(preset.code);
      for (const c of a.comparisons)
        if (c.backtrack.outcome === 'match')
          expect(c.backtrack.rule, preset.id).toBe(a.scan!.tokens[c.token].rule);
    }
  });
  it('terminates on nested stars and grows quickly on (a|aa)*b', () => {
    expect(backtrackMatch(ok('X: (a*)*\n%%\n').nfa, 'aaaa').outcome).toBe('match');
    const counts = [6, 8, 10].map(
      (n) => backtrackMatch(ok('S: (a|aa)*b\n%%\n').nfa, 'a'.repeat(n)).attempts,
    );
    expect(counts[1]).toBeGreaterThan(counts[0] * 2);
    expect(counts[2]).toBeGreaterThan(counts[1] * 2);
    const slow = ok(automataPresets.find((p) => p.id === 'auto-backtrack')!.code);
    expect(slow.comparisons[0].dfaReads).toBe(12);
    expect(slow.comparisons[0].backtrack.attempts).toBeGreaterThan(1000);
    expect(backtrackMatch(slow.nfa, 'a'.repeat(16)).outcome).toBe('limit');
  });
});

describe('spec validation and limits', () => {
  it('requires a separator, valid names and unique rules', () => {
    const issue = (source: string) => {
      const outcome = analyzeAutomata(source);
      return outcome.ok ? '' : outcome.issue.message;
    };
    expect(issue('A: a')).toContain('%%');
    expect(issue('%%\nabc')).toContain('至少需要一条规则');
    expect(issue('1x: a\n%%\n')).toContain('名称');
    expect(issue('A: a\nA: b\n%%\n')).toContain('重复');
    expect(issue('A: a\n%%\n中文')).toContain('字母表之外');
    expect(issue(`A: ${'a'.repeat(81)}\n%%\n`)).toContain('80');
    expect(issue(`A: a\n%%\n${'a'.repeat(301)}`)).toContain('300');
    expect(issue(Array.from({ length: 9 }, (_, i) => `R${i}: a`).join('\n') + '\n%%\n')).toContain(
      '8',
    );
    const position = analyzeAutomata('A: a\nB: (b\n%%\n');
    expect(!position.ok && position.issue.start).toBeGreaterThanOrEqual(8);
  });
  it('keeps every frame message non-empty and the timeline in phase order', () => {
    for (const preset of automataPresets) {
      const a = ok(preset.code);
      expect(a.frames.every((f) => f.message.length > 0)).toBe(true);
      const order = a.frames.map((f) => ['nfa', 'dfa', 'scan'].indexOf(f.phase));
      expect(order).toEqual([...order].sort((x, y) => x - y));
    }
  });
});
