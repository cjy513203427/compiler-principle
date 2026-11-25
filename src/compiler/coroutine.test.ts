import { describe, it, expect } from 'vitest';
import { analyzeCoroutine } from './coroutine';
import { coroutinePresets } from '../content/coroutine';

describe('stackless coroutines & state-machine lowering', () => {
  it('hoists live-across-yield variables to frame and keeps transient doubled on stack', () => {
    const res = analyzeCoroutine(coroutinePresets[0].code);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.analysis.equivalent).toBe('same');
    expect(res.analysis.output).toEqual([0, 2, 4, 3, true]);
    const range = res.analysis.coros[0];
    expect(range.hoistedVars).toContain('i');
    expect(range.hoistedVars).toContain('n');
    expect(range.transientVars).toContain('doubled');
  });

  it('lowers multiple sequential yields into distinct state cases', () => {
    const res = analyzeCoroutine(coroutinePresets[1].code);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.analysis.equivalent).toBe('same');
    expect(res.analysis.output).toEqual([3, 30, 35, 36]);
    expect(res.analysis.coros[0].yieldCount).toBe(3);
  });

  it('interleaves two independent coroutine frames cleanly on one stack', () => {
    const res = analyzeCoroutine(coroutinePresets[2].code);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.analysis.equivalent).toBe('same');
    expect(res.analysis.output).toEqual([0, 3, 1, 2, 1]);
  });

  it('handles yields inside if/else branches and rejoins after resume', () => {
    const res = analyzeCoroutine(coroutinePresets[3].code);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.analysis.equivalent).toBe('same');
    expect(res.analysis.output).toEqual([100, 200, 999, 999]);
  });

  it('reports runtime error when resuming a DONE coroutine consistently with oracle', () => {
    const res = analyzeCoroutine(coroutinePresets[4].code);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.analysis.equivalent).toBe('same');
    expect(res.analysis.output).toEqual([7, 8]);
    expect(res.analysis.error).toContain('DONE');
  });
});
