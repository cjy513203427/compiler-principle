import { describe, it, expect } from 'vitest';
import { analyzeEscape } from './escape';
import { escapePresets } from '../content/escape';

describe('inlining, escape analysis and SROA', () => {
  it('inlines factory function, demotes GlobalEscape to NoEscape, and eliminates all heap allocations in loop', () => {
    const res = analyzeEscape(escapePresets[0].code);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.analysis.equivalent).toBe('same');
    expect(res.analysis.runs.original.output).toEqual([25]);
    expect(res.analysis.runs.original.heapAllocs).toBe(5);
    expect(res.analysis.runs.sroa.heapAllocs).toBe(0);
    expect(res.analysis.runs.sroa.calls).toBe(0);
    expect(res.analysis.beforeEscape.some((r) => r.state === 'GlobalEscape')).toBe(true);
    expect(res.analysis.afterEscape.some((r) => r.state === 'NoEscape' && r.scalarized)).toBe(true);
  });

  it('propagates escape transitively when an object is stored into an escaping container', () => {
    const res = analyzeEscape(escapePresets[1].code);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.analysis.equivalent).toBe('same');
    expect(res.analysis.afterEscape.every((r) => r.state === 'GlobalEscape')).toBe(true);
    expect(res.analysis.runs.sroa.heapAllocs).toBe(2);
  });

  it('scalarizes local object while keeping published object on the heap', () => {
    const res = analyzeEscape(escapePresets[2].code);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.analysis.equivalent).toBe('same');
    expect(res.analysis.runs.original.heapAllocs).toBe(2);
    expect(res.analysis.runs.sroa.heapAllocs).toBe(1);
    expect(res.analysis.runs.sroa.output).toEqual([33]);
  });

  it('skips recursive inlining and classifies passed object as ArgEscape', () => {
    const res = analyzeEscape(escapePresets[3].code);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.analysis.equivalent).toBe('same');
    expect(res.analysis.runs.original.output).toEqual([8]);
    expect(res.analysis.inlineDecisions.some((d) => d.callee === 'countdown' && !d.inlined)).toBe(true);
    expect(res.analysis.afterEscape.some((r) => r.state === 'ArgEscape')).toBe(true);
  });

  it('keeps aliased branch objects on heap conservatively without breaking semantics', () => {
    const res = analyzeEscape(escapePresets[4].code);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.analysis.equivalent).toBe('same');
    expect(res.analysis.runs.original.output).toEqual([10]);
    expect(res.analysis.runs.sroa.heapAllocs).toBe(2);
  });

  it('rejects undefined struct types with clear diagnostics', () => {
    const res = analyzeEscape('Ghost g = new Ghost(1); print(1);');
    expect(res.ok).toBe(false);
  });
});
