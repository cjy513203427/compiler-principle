import { describe, expect, it } from 'vitest';
import { analyzeConcurGc } from './concurgc';
import { concurGcPresets } from '../content/concurgc';

describe('concurrent tri-color GC and write barriers', () => {
  it('reproduces lost-object bug without barrier and fixes it with both Dijkstra and SATB', () => {
    const res = analyzeConcurGc(concurGcPresets[0].code);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const { none, dijkstra, satb } = res.analysis.finalStrategies;
    expect(none.verdict).toBe('unsafe');
    expect(none.lostLive).toEqual(['C']);
    expect(dijkstra.verdict).toBe('exact');
    expect(dijkstra.lostLive).toEqual([]);
    expect(dijkstra.barrierTriggers).toBeGreaterThan(0);
    expect(satb.verdict).toBe('exact');
    expect(satb.lostLive).toEqual([]);
    expect(satb.barrierTriggers).toBeGreaterThan(0);
  });

  it('demonstrates floating garbage tradeoff under SATB deletion barrier', () => {
    const preset = concurGcPresets.find((p) => p.id === 'cgc-floating-garbage')!;
    const res = analyzeConcurGc(preset.code);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const { dijkstra, satb } = res.analysis.finalStrategies;
    expect(dijkstra.lostLive).toEqual([]);
    expect(dijkstra.floatingGarbage).toEqual([]);
    expect(satb.verdict).toBe('floating');
    expect(satb.lostLive).toEqual([]);
    expect(satb.floatingGarbage).toContain('C');
  });

  it('rescues multi-hop white chain through gray worklist propagation', () => {
    const preset = concurGcPresets.find((p) => p.id === 'cgc-chain-rescue')!;
    const res = analyzeConcurGc(preset.code);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.analysis.finalStrategies.none.lostLive).toEqual(['C', 'E']);
    expect(res.analysis.finalStrategies.dijkstra.lostLive).toEqual([]);
    expect(res.analysis.finalStrategies.satb.lostLive).toEqual([]);
  });

  it('protects mid-mark allocations via allocate-black while naive leaves them white', () => {
    const preset = concurGcPresets.find((p) => p.id === 'cgc-new-alloc')!;
    const res = analyzeConcurGc(preset.code);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.analysis.finalStrategies.none.lostLive).toContain('F');
    expect(res.analysis.finalStrategies.dijkstra.lostLive).toEqual([]);
    expect(res.analysis.finalStrategies.satb.lostLive).toEqual([]);
  });

  it('shows no lost object when only one of the two necessary conditions holds', () => {
    const preset = concurGcPresets.find((p) => p.id === 'cgc-safe-one-cond')!;
    const res = analyzeConcurGc(preset.code);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.analysis.finalStrategies.none.verdict).toBe('exact');
    expect(res.analysis.finalStrategies.dijkstra.verdict).toBe('exact');
    expect(res.analysis.finalStrategies.satb.verdict).toBe('exact');
  });

  it('rejects mutator actions on unreachable objects', () => {
    const res = analyzeConcurGc('heap A B C\nroot A\nedge B -> C\n%%\ncut B -> C\nsweep');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('不可达');
  });
});
