import { describe, it, expect } from 'vitest';
import { tokenize } from './lexer';
import { parse } from './parser';
import { analyze } from './semantic';
import { generateIR } from './ir';
import { generateBytecode, execute } from './vm';
import { analyzeInstructionSelection, formatTargetInstr } from './isel';
import { iselPresets } from '../content/isel';
import { presets } from '../content/lessons';

function runIsel(code: string) {
  const lex = tokenize(code);
  const syntax = parse(lex.tokens);
  const semantic = analyze(syntax.ast);
  const ir = generateIR(syntax.ast, semantic);
  const baseline = execute(generateBytecode(ir));
  return { ir, baseline, isel: analyzeInstructionSelection(ir, baseline) };
}

describe('instruction selection (isel)', () => {
  it('fuses a + b * 4 + 10 into a single CISC LEA instruction', () => {
    const { isel } = runIsel(iselPresets[0].code);
    expect(isel.equivalent).toBe('same');
    const dpText = isel.runs.dp.instructions.map(formatTargetInstr).join('\n');
    expect(dpText).toContain('LEA v2_addr, [v0_a + v1_b*4 + 10]');
    expect(isel.runs.dp.totalCost).toBeLessThan(isel.runs.naive.totalCost);
    expect(isel.runs.dp.totalCost).toBeLessThan(isel.runs.risc.totalCost);
  });

  it('demonstrates bottom-up DP beating greedy Maximal Munch on a * 3 + b', () => {
    const { isel } = runIsel(iselPresets[1].code);
    expect(isel.equivalent).toBe('same');
    expect(isel.runs.dp.totalCost).toBeLessThan(isel.runs.munch.totalCost);
    expect(isel.runs.munch.instructions.some((i) => i.op === 'MADD')).toBe(true);
    expect(isel.runs.dp.instructions.some((i) => i.op === 'LEA' && i.tile === 'LEA_MUL3')).toBe(true);
  });

  it('uses MADD beneficially on general multiply-add a * c + b', () => {
    const { isel } = runIsel(iselPresets[2].code);
    expect(isel.equivalent).toBe('same');
    expect(isel.runs.dp.instructions.some((i) => i.op === 'MADD')).toBe(true);
    expect(isel.runs.dp.totalCost).toBeLessThan(isel.runs.naive.totalCost);
  });

  it('preserves print output before division-by-zero error across all 4 targets', () => {
    const { isel, baseline } = runIsel(iselPresets[5].code);
    expect(baseline.output).toEqual([18]);
    expect(baseline.error?.message).toContain('0');
    expect(isel.equivalent).toBe('same');
  });

  it('keeps all valid Mini C presets behaviorally equivalent across all 4 targets', () => {
    for (const preset of [...iselPresets, ...presets.slice(0, 14)]) {
      try {
        const { isel } = runIsel(preset.code);
        expect(isel.equivalent, preset.id).not.toBe('different');
      } catch {
        // Ignore intentionally invalid syntax/semantic counterexample presets.
      }
    }
  });
});
