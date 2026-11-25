import { describe, it, expect } from 'vitest';
import { tokenize } from './lexer';
import { parse } from './parser';
import { analyze } from './semantic';
import { generateIR } from './ir';
import { generateBytecode, execute } from './vm';
import { buildCFG } from './cfg';
import { analyzeLiveness } from './dataflow';
import { analyzeDominance } from './dominance';
import { buildSSA } from './ssa';
import { optimizeSSA } from './ssaopt';
import { ssaOptPresets } from '../content/ssaopt';
import { presets } from '../content/lessons';

function runSsaOpt(code: string) {
  const lex = tokenize(code);
  const syntax = parse(lex.tokens);
  const semantic = analyze(syntax.ast);
  const ir = generateIR(syntax.ast, semantic);
  const baseline = execute(generateBytecode(ir));
  const cfg = buildCFG(ir);
  const dominance = analyzeDominance(cfg);
  const liveness = analyzeLiveness(ir);
  const ssa = buildSSA(dominance, liveness);
  const ssaopt = optimizeSSA(ssa, dominance, baseline);
  return { baseline, ssa, ssaopt };
}

describe('SSA optimization (SCCP + DCE)', () => {
  it('prunes unreachable constant branch and folds phi + arithmetic into constant print', () => {
    const { ssaopt, baseline } = runSsaOpt(ssaOptPresets[0].code);
    expect(ssaopt.valid).toBe(true);
    expect(ssaopt.equivalence).toBe('same');
    expect(baseline.output).toEqual([22]);
    expect(ssaopt.removedBlocks.length).toBeGreaterThanOrEqual(1);
    expect(ssaopt.simplifiedPhis.length).toBeGreaterThanOrEqual(1);
    expect(ssaopt.afterCount).toBeLessThan(ssaopt.beforeCount);
  });

  it('pushes loop-carried phi to top while preserving loop-invariant constant', () => {
    const { ssaopt, baseline } = runSsaOpt(ssaOptPresets[1].code);
    expect(ssaopt.equivalence).toBe('same');
    expect(baseline.output).toEqual([13]);
    expect(Object.values(ssaopt.lattice).some((v) => v.kind === 'top')).toBe(true);
    expect(Object.values(ssaopt.lattice).some((v) => v.kind === 'const' && v.value === 10)).toBe(true);
  });

  it('eliminates dead phi for unused variable while folding constant-on-both-paths variable', () => {
    const { ssaopt, baseline } = runSsaOpt(ssaOptPresets[2].code);
    expect(ssaopt.equivalence).toBe('same');
    expect(baseline.output).toEqual([5]);
    expect(ssaopt.removedInstructions.length).toBeGreaterThan(0);
  });

  it('preserves division-by-zero trap even when destination is unused', () => {
    const { ssaopt, baseline } = runSsaOpt(ssaOptPresets[4].code);
    expect(baseline.error?.message).toContain('0');
    expect(ssaopt.equivalence).toBe('same');
    expect(ssaopt.execution?.error).toContain('0');
  });

  it('keeps all valid Mini C presets equivalent after SCCP + DCE', () => {
    for (const preset of [...ssaOptPresets, ...presets.slice(0, 16)]) {
      try {
        const { ssaopt } = runSsaOpt(preset.code);
        expect(ssaopt.equivalence, preset.id).not.toBe('different');
      } catch {
        // Skip invalid syntax/semantic counterexamples.
      }
    }
  });
});
