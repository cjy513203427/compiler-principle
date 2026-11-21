import { describe, expect, it } from 'vitest';
import { analyzeMinimization, completeMachine, DEAD, distinguishStates, minimizeDfa, verifyDfaEquivalence } from './minimize';
import { dfaNext, scan, type Dfa } from './automata';
import { minimizationPresets } from '../content/minimize';
import { automataPresets } from '../content/automata';

const analyze = (source: string) => {
  const outcome = analyzeMinimization(source);
  if (!outcome.ok) throw new Error(outcome.issue.message);
  return outcome.analysis;
};
const fixture = (accept: (number | undefined)[], transitions: (number | undefined)[][]): Dfa => ({
  states: accept.map((output, id) => ({ id, accept: output, candidates: output === undefined ? [] : [output], nfa: [] })),
  edges: transitions.flatMap((row, from) => row.flatMap((to, i) => to === undefined ? [] : [{ from, to, ranges: [[97 + i, 97 + i] as const] }])),
  complete: true, classes: 2,
});
const next = (dfa: Dfa, state: number, code: number) => state === DEAD ? DEAD : dfaNext(dfa, state, code) ?? DEAD;
const output = (dfa: Dfa, state: number) => state === DEAD ? undefined : dfa.states[state].accept;
const run = (dfa: Dfa, start: number, word: string) => output(dfa, [...word].reduce((state, ch) => next(dfa, state, ch.charCodeAt(0)), start));

// Independent table-filling oracle: mark output differences, then propagate backward.
function distinguishablePairs(dfa: Dfa) {
  const alphabet = [97, 98, 99]; // Generated fixtures only use a/b; c represents every missing class.
  const reachable = [0];
  const seen = new Set(reachable);
  for (let i = 0; i < reachable.length; i++) for (const code of alphabet) {
    const target = next(dfa, reachable[i], code);
    if (!seen.has(target)) { seen.add(target); reachable.push(target); }
  }
  const key = (a: number, b: number) => `${Math.min(a, b)},${Math.max(a, b)}`;
  const marked = new Set<string>();
  for (const a of reachable) for (const b of reachable)
    if (output(dfa, a) !== output(dfa, b)) marked.add(key(a, b));
  let changed = true;
  while (changed) {
    changed = false;
    for (const a of reachable) for (const b of reachable) {
      if (marked.has(key(a, b))) continue;
      if (alphabet.some((code) => marked.has(key(next(dfa, a, code), next(dfa, b, code))))) {
        marked.add(key(a, b)); changed = true;
      }
    }
  }
  return { reachable, distinct: (a: number, b: number) => marked.has(key(a, b)) };
}

describe('lexer DFA minimization', () => {
  it('reduces ab|cb from five states to three and records real partition splits', () => {
    const analysis = analyze(minimizationPresets[0].code);
    expect(analysis.original.states).toHaveLength(5);
    expect(analysis.result!.minimized.states).toHaveLength(3);
    expect(analysis.result!.machine.states).toHaveLength(6);
    expect(analysis.result!.groups).toHaveLength(4);
    expect(analysis.result!.mapping[1]).toBe(analysis.result!.mapping[2]);
    expect(analysis.result!.members).toEqual([[0], [1, 2], [3, 4]]);
    expect(analysis.frames[0].kind).toBe('initial');
    expect(analysis.frames.at(-1)!.kind).toBe('complete');
    for (const frame of analysis.frames.filter((frame) => frame.kind === 'split')) {
      expect(frame.groups.length).toBeGreaterThan(frame.previous!.length);
      expect(frame.evidence!.leftGroup).not.toBe(frame.evidence!.rightGroup);
    }
    expect(analysis.minimizedScan!.tokens.map((token) => token.text)).toEqual(['ab', 'cb']);
  });

  it('keeps different token actions separate and finds empty/nonempty shortest witnesses', () => {
    const merged = analyze(minimizationPresets[0].code).result!;
    expect(distinguishStates(merged.machine, 1, 2).equivalent).toBe(true);
    const distinction = distinguishStates(merged.machine, 0, 1);
    expect(distinction.suffix).toBe('b');
    expect(distinction.trace.at(-1)).toMatchObject({ left: DEAD, right: 3 });
    const actions = analyze(minimizationPresets[2].code).result!;
    expect(actions.minimized.states).toHaveLength(5);
    expect(distinguishStates(actions.machine, 3, 4).suffix).toBe('');
    expect(actions.mapping[3]).not.toBe(actions.mapping[4]);
    expect(distinguishStates(actions.machine, 1, 2).suffix).toBe('b');
  });

  it('retains priorities, skipped lexemes, rollback and the first failure position', () => {
    for (const preset of [...minimizationPresets, ...automataPresets]) {
      const analysis = analyze(preset.code);
      if (!analysis.original.complete) continue;
      expect(analysis.verification!.equivalent, preset.id).toBe(true);
      expect(analysis.scansEqual, preset.id).toBe(true);
    }
    const keyword = analyze(minimizationPresets[3].code);
    expect(keyword.minimizedScan!.tokens.map((token) => [keyword.spec.rules[token.rule].name, token.text]))
      .toEqual([['Int', 'int'], ['skip', ' '], ['Id', 'integer'], ['skip', ' '], ['Id', 'in']]);
    const reversed = analyze('Id: [a-z]+\nInt: int\n%%\nint');
    expect(reversed.spec.rules[reversed.minimizedScan!.tokens[0].rule].name).toBe('Id');
    const rollback = analyze(minimizationPresets[4].code);
    expect(rollback.minimizedScan!.tokens.filter((token) => !token.skip).map((token) => token.text))
      .toEqual(['3.14', '7', '.', '8']);
    expect(analyze(minimizationPresets[5].code).minimizedScan!.error?.position).toBe(2);
    expect(analyze(minimizationPresets[6].code).result!.minimized.states).toHaveLength(2);
  });

  it('does not emit empty tokens and handles an empty input', () => {
    const empty = analyze('Maybe: a*\n%%\n');
    expect(empty.minimizedScan!.tokens).toEqual([]);
    const nonempty = analyze('Maybe: a*\n%%\naaa');
    expect(nonempty.minimizedScan!.tokens.map((token) => token.text)).toEqual(['aaa']);
    expect(nonempty.scansEqual).toBe(true);
  });

  it('drops unreachable states, merges dead states and retains an empty-language entry', () => {
    const unreachable = minimizeDfa(fixture([undefined, 0, 1], [[1], [], [2]]));
    expect(unreachable.machine.unreachable).toEqual([2]);
    expect(unreachable.minimized.states).toHaveLength(2);
    const dead = minimizeDfa(fixture([undefined, undefined], [[1], []]));
    expect(dead.groups).toHaveLength(1);
    expect(new Set(dead.groups[0])).toEqual(new Set([0, 1, DEAD]));
    expect(dead.minimized.states).toHaveLength(1);
    expect(dead.minimized.edges).toEqual([]);
    expect(verifyDfaEquivalence(fixture([undefined, undefined], [[1], []]), dead.minimized).equivalent).toBe(true);
  });

  it('does not add an unreachable sink to a machine already total on the supported alphabet', () => {
    const total: Dfa = { states: [{ id: 0, nfa: [], accept: 0, candidates: [0] }],
      edges: [{ from: 0, to: 0, ranges: [[9, 10], [13, 13], [32, 126]] }], complete: true, classes: 3 };
    expect(completeMachine(total).states).toEqual([0]);
    expect(minimizeDfa(total).minimized.states).toHaveLength(1);
  });

  it('does not publish results when subset construction is incomplete and validates source limits', () => {
    const tooLarge = analyze('Tail: (a|b)*a(a|b)(a|b)(a|b)(a|b)(a|b)(a|b)\n%%\nab');
    expect(tooLarge.original.complete).toBe(false);
    expect(tooLarge.result).toBeUndefined();
    expect(tooLarge.minimizedScan).toBeUndefined();
    expect(tooLarge.frames[0].kind).toBe('limit');
    expect(analyzeMinimization('a'.repeat(2001)).ok).toBe(false);
    expect(analyzeMinimization('A: (a\n%%\na').ok).toBe(false);
    expect(() => minimizeDfa({ ...fixture([0], [[]]), complete: false })).toThrow('完整');
  });

  it('the independent equivalence check detects altered winning rules', () => {
    const analysis = analyze(minimizationPresets[0].code);
    const broken = structuredClone(analysis.result!.minimized);
    broken.states.find((state) => state.accept !== undefined)!.accept = 1;
    const verification = verifyDfaEquivalence(analysis.original, broken);
    expect(verification.equivalent).toBe(false);
    expect(verification.suffix).toBe('ab');
  });

  it('agrees with independent table filling on generated automata, including minimality', () => {
    let seed = 123456;
    const random = (n: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
    for (let example = 0; example < 35; example++) {
      const count = 2 + random(6);
      const dfa = fixture(Array.from({ length: count }, () => [undefined, 0, 1][random(3)]),
        Array.from({ length: count }, () => Array.from({ length: 2 }, () => {
          const target = random(count + 1); return target === count ? undefined : target;
        })));
      const before = structuredClone(dfa);
      const result = minimizeDfa(dfa);
      const oracle = distinguishablePairs(dfa);
      expect(new Set(result.machine.states)).toEqual(new Set(oracle.reachable));
      for (const a of oracle.reachable) for (const b of oracle.reachable) {
        const sameGroup = result.groups.some((group) => group.includes(a) && group.includes(b));
        expect(sameGroup).toBe(!oracle.distinct(a, b));
        const query = distinguishStates(result.machine, a, b);
        expect(query.equivalent).toBe(sameGroup);
        if (!query.equivalent) {
          expect(run(dfa, a, query.suffix!)).not.toBe(run(dfa, b, query.suffix!));
          // For these small fixtures, enumerate all shorter strings as a separate shortestness check.
          let words = [''];
          for (let length = 0; length < query.suffix!.length; length++) {
            for (const word of words) expect(run(dfa, a, word)).toBe(run(dfa, b, word));
            words = words.flatMap((word) => ['a', 'b', 'c'].map((ch) => word + ch));
          }
        }
      }
      expect(verifyDfaEquivalence(dfa, result.minimized).equivalent).toBe(true);
      expect(dfa).toEqual(before);
    }
  });

  it('matches a direct longest-match oracle over all short a/b/c inputs', () => {
    const analysis = analyze('A: ab|cb\nB: a+\n%%\n');
    const matchers = [/^(?:ab|cb)$/, /^a+$/];
    let words = [''];
    for (let length = 0; length <= 5; length++) {
      for (const word of words) {
        const expected: { rule: number; text: string; start: number; end: number }[] = [];
        let pos = 0;
        while (pos < word.length) {
          let found = false;
          for (let end = word.length; end > pos; end--) {
            const text = word.slice(pos, end), rule = matchers.findIndex((matcher) => matcher.test(text));
            if (rule < 0) continue;
            expected.push({ rule, text, start: pos, end }); pos = end; found = true; break;
          }
          if (!found) break;
        }
        const scanned = scan(analysis.result!.minimized, analysis.spec.rules, word);
        expect(scanned.tokens.map(({ rule, text, start, end }) => ({ rule, text, start, end }))).toEqual(expected);
        expect(scanned.error?.position).toBe(pos < word.length ? pos : undefined);
      }
      words = words.flatMap((word) => ['a', 'b', 'c'].map((ch) => word + ch));
    }
  });
});
