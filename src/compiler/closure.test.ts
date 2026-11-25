import { describe, it, expect } from 'vitest';
import { analyzeClosure } from './closure';
import { closurePresets } from '../content/closure';

describe('closures, free-variable capture and heap cells', () => {
  it('boxes captured counter variable into independent heap cells surviving return', () => {
    const res = analyzeClosure(closurePresets[0].code);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.analysis.equivalent).toBe('same');
    expect(res.analysis.output).toEqual([11, 16, 102]);
    expect(res.analysis.totalCells).toBe(2);
    expect(res.analysis.totalClosures).toBe(3); // makeCounter + 2 inc closures
    const last = res.analysis.frames.at(-1)!;
    expect(last.closures.filter((cl) => cl.env.length > 0)).toHaveLength(2);
    expect(last.cells.every((c) => c.aliveAfterOwnerReturned)).toBe(true);
  });

  it('shares a single heap cell across sibling closures in the same scope', () => {
    const res = analyzeClosure(closurePresets[1].code);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.analysis.equivalent).toBe('same');
    expect(res.analysis.output).toEqual([4, 10, 10]);
    expect(res.analysis.totalCells).toBe(1);
    expect(res.analysis.totalClosures).toBe(3); // demo + add + read
    expect(res.analysis.frames.at(-1)!.closures.filter((cl) => cl.env.length > 0)).toHaveLength(2);
  });

  it('passes closure objects into higher-order functions cleanly', () => {
    const res = analyzeClosure(closurePresets[2].code);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.analysis.equivalent).toBe('same');
    expect(res.analysis.output).toEqual([24]);
  });

  it('forwards multi-level captures through intermediate closures', () => {
    const res = analyzeClosure(closurePresets[3].code);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.analysis.equivalent).toBe('same');
    expect(res.analysis.output).toEqual([123]);
  });

  it('allocates zero heap cells when no inner function captures local variables', () => {
    const res = analyzeClosure(closurePresets[4].code);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.analysis.equivalent).toBe('same');
    expect(res.analysis.output).toEqual([21]);
    expect(res.analysis.totalCells).toBe(0);
  });
});
