import { describe, expect, it } from 'vitest';
import { analyzeSeaOfNodes } from './seaofnodes';
import { seaOfNodesPresets } from '../content/seaofnodes';

describe('Sea of Nodes graph IR, canonicalizer, and speculative deoptimization', () => {
  it('verifies all presets against independent baseline interpreter oracle', () => {
    for (const preset of seaOfNodesPresets) {
      const res = analyzeSeaOfNodes(preset.code);
      expect(res.ok).toBe(true);
      if (!res.ok) continue;
      expect(res.analysis.verified).toBe(true);
      expect(res.analysis.frames.length).toBeGreaterThanOrEqual(4);
    }
  });

  it('prunes cold branch on atLeastTen and deoptimizes safely on out-of-profile input', () => {
    const res = analyzeSeaOfNodes(seaOfNodesPresets[0].code);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.analysis.prunedBranchCount).toBe(1);
    expect(res.analysis.outcomes[0].deoptimized).toBe(false);
    expect(res.analysis.outcomes[0].jitResult).toBe(18);
    expect(res.analysis.outcomes[1].deoptimized).toBe(true);
    expect(res.analysis.outcomes[1].jitResult).toBe(10);
    expect(res.analysis.verified).toBe(true);
  });

  it('applies Canonicalizer strength reduction, double negation, and GVN merging', () => {
    const canonPreset = seaOfNodesPresets.find((p) => p.id === 'son-canonical')!;
    const res = analyzeSeaOfNodes(canonPreset.code);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.analysis.canonicalRewriteCount).toBeGreaterThanOrEqual(2);
    expect(res.analysis.gvnMergedCount).toBeGreaterThanOrEqual(1);
    expect(res.analysis.finalActiveNodeCount).toBeLessThan(res.analysis.initialNodeCount);
  });

  it('identifies loop-invariant floating nodes naturally outside the loop spine', () => {
    const loopPreset = seaOfNodesPresets.find((p) => p.id === 'son-float-loop')!;
    const res = analyzeSeaOfNodes(loopPreset.code);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.analysis.loopFloatingNodes.length).toBeGreaterThan(0);
    expect(res.analysis.verified).toBe(true);
  });

  it('keeps both branches without speculation when both sides are hot in profile', () => {
    const doifPreset = seaOfNodesPresets.find((p) => p.id === 'son-doif')!;
    const res = analyzeSeaOfNodes(doifPreset.code);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.analysis.prunedBranchCount).toBe(0);
    expect(res.analysis.outcomes.every((o) => !o.deoptimized)).toBe(true);
  });
});
