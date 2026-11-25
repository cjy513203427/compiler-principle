import { describe, expect, it } from 'vitest';
import { analyzeInlineCache } from './inlinecache';
import { inlineCachePresets } from '../content/inlinecache';

describe('V8 hidden classes (Shapes) and inline caching', () => {
  it('verifies all presets against independent dictionary-mode oracle', () => {
    for (const preset of inlineCachePresets) {
      const res = analyzeInlineCache(preset.code);
      expect(res.ok).toBe(true);
      if (!res.ok) continue;
      expect(res.analysis.verified).toBe(true);
      expect(res.analysis.frames.length).toBeGreaterThan(2);
    }
  });

  it('keeps monomorphic IC when objects share property order', () => {
    const res = analyzeInlineCache(inlineCachePresets[0].code);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const site = res.analysis.sites.find((s) => s.prop === 'x')!;
    expect(site.state).toBe('monomorphic');
    expect(site.hits).toBeGreaterThan(0);
    expect(res.analysis.icTotalCost).toBeLessThan(res.analysis.dictTotalCost);
  });

  it('splits transition tree and turns IC polymorphic when property order differs', () => {
    const orderPreset = inlineCachePresets.find((p) => p.id === 'ic-order-mismatch')!;
    const res = analyzeInlineCache(orderPreset.code);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const site = res.analysis.sites.find((s) => s.prop === 'x')!;
    expect(site.state).toBe('polymorphic');
    expect(site.entries.length).toBe(2);
    expect(site.entries[0].offset).not.toBe(site.entries[1].offset);
  });

  it('degrades to megamorphic after more than 4 distinct shapes', () => {
    const megaPreset = inlineCachePresets.find((p) => p.id === 'ic-megamorphic')!;
    const res = analyzeInlineCache(megaPreset.code);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const site = res.analysis.sites.find((s) => s.prop === 'x')!;
    expect(site.state).toBe('megamorphic');
  });

  it('matches oracle runtime error when reading missing property', () => {
    const code = 'let p = { x: 1 };\nprint(p.y);';
    const res = analyzeInlineCache(code);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.analysis.icError).toContain('没有属性');
    expect(res.analysis.oracleError).toContain('没有属性');
    expect(res.analysis.verified).toBe(true);
  });
});
