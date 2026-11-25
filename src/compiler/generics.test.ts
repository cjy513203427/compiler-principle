import { describe, expect, it } from 'vitest';
import { analyzeGenerics } from './generics';
import { genericsPresets } from '../content/generics';

describe('generics: type erasure vs monomorphization', () => {
  it('verifies all presets against independent typed oracle', () => {
    for (const preset of genericsPresets) {
      const res = analyzeGenerics(preset.code);
      if (preset.id === 'gen-invariance-err') {
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.error).toContain('不变性');
      } else {
        expect(res.ok).toBe(true);
        if (res.ok) {
          expect(res.analysis.verified).toBe(true);
          expect(res.analysis.frames.length).toBeGreaterThan(2);
        }
      }
    }
  });

  it('shows boxing and checkcast overhead in erasure vs zero boxing in monomorphization', () => {
    const res = analyzeGenerics(genericsPresets[0].code);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const { erasedMetrics, monoMetrics, erasedUnits, monoUnits } = res.analysis;
    expect(erasedMetrics.boxOps).toBeGreaterThan(0);
    expect(erasedMetrics.checkcasts).toBeGreaterThan(0);
    expect(monoMetrics.boxOps).toBe(0);
    expect(monoMetrics.checkcasts).toBe(0);
    expect(monoUnits.length).toBeGreaterThan(erasedUnits.length);
    expect(erasedMetrics.output).toEqual(monoMetrics.output);
  });

  it('amplifies boxing overhead inside loops while keeping outputs identical', () => {
    const loopPreset = genericsPresets.find((p) => p.id === 'gen-loop-boxing')!;
    const res = analyzeGenerics(loopPreset.code);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.analysis.erasedMetrics.boxOps).toBeGreaterThanOrEqual(5);
    expect(res.analysis.monoMetrics.boxOps).toBe(0);
    expect(res.analysis.erasedMetrics.output).toEqual(['15']);
    expect(res.analysis.monoMetrics.output).toEqual(['15']);
  });

  it('rejects erased overload clash in erasure mode while monomorphization succeeds', () => {
    const clashPreset = genericsPresets.find((p) => p.id === 'gen-erasure-clash')!;
    const res = analyzeGenerics(clashPreset.code);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.analysis.erasedClashError).toContain('类型擦除冲突');
    expect(res.analysis.monoMetrics.error).toBeUndefined();
    expect(res.analysis.monoMetrics.output).toEqual(['11', '1']);
  });

  it('rejects invariant subtype assignment Box<Cat> -> Box<Animal>', () => {
    const code = `
class Animal {}
class Cat extends Animal {}
struct Box<T> { T item; }
let Box<Cat> c = new Box<Cat>(new Cat());
let Box<Animal> a = c;
print(1);
`;
    const res = analyzeGenerics(code);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('Invariance');
  });
});
