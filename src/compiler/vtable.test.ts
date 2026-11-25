import { describe, it, expect } from 'vitest';
import { analyzeVtable } from './vtable';
import { vtablePresets } from '../content/vtable';

describe('OOP object layout, vtable dispatch & CHA devirtualization', () => {
  it('builds prefix-compatible field layout and overrides slot 0 in-place', () => {
    const res = analyzeVtable(vtablePresets[0].code);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.analysis.equivalent).toBe('same');
    expect(res.analysis.output).toEqual([20, 8, 36]);
    const shape = res.analysis.layouts.find((l) => l.name === 'Shape')!;
    const rect = res.analysis.layouts.find((l) => l.name === 'Rect')!;
    const sq = res.analysis.layouts.find((l) => l.name === 'Square')!;
    // Prefix compatibility of field offsets
    expect(shape.fields[0]).toMatchObject({ offset: 1, name: 'base' });
    expect(rect.fields[0]).toMatchObject({ offset: 1, name: 'base', inherited: true });
    expect(rect.fields[1]).toMatchObject({ offset: 2, name: 'height', inherited: false });
    // Slot 0 overridden in place
    expect(shape.vtable[0]).toMatchObject({ slot: 0, methodName: 'area', implClass: 'Shape' });
    expect(rect.vtable[0]).toMatchObject({ slot: 0, methodName: 'area', implClass: 'Rect', status: 'overridden' });
    expect(sq.vtable[0]).toMatchObject({ slot: 0, methodName: 'area', implClass: 'Square', status: 'overridden' });
    // perimeter() is never overridden -> devirtualized via CHA
    const perimSite = res.analysis.callSites.find((c) => c.methodName === 'perimeter')!;
    expect(perimSite.devirtualized).toBe(true);
  });

  it('dispatches template-method this.area() dynamically to the runtime subclass', () => {
    const res = analyzeVtable(vtablePresets[1].code);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.analysis.equivalent).toBe('same');
    expect(res.analysis.output).toEqual([42, 50]);
    expect(res.analysis.dispatches.some((d) => d.resolvedImpl === 'Rect::area')).toBe(true);
    expect(res.analysis.dispatches.some((d) => d.resolvedImpl === 'Square::area')).toBe(true);
  });

  it('devirtualizes all call sites when no subclass overrides exist', () => {
    const res = analyzeVtable(vtablePresets[2].code);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.analysis.output).toEqual([15, 15]);
    expect(res.analysis.dynamicCount).toBe(0);
    expect(res.analysis.devirtCount).toBe(2);
  });

  it('switches targets at the same polymorphic loop call site', () => {
    const res = analyzeVtable(vtablePresets[3].code);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.analysis.output).toEqual([13, 13, 30, 30]);
    expect(res.analysis.equivalent).toBe('same');
  });

  it('rejects inheritance cycles cleanly', () => {
    const res = analyzeVtable(vtablePresets[4].code);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.issue.message).toContain('继承环');
  });
});
