import { describe, expect, it } from 'vitest';
import { analyzeDominance, findCFGPath, iteratedFrontier } from './dominance';
import { compile } from './index';
import type { ControlFlowGraph } from './cfg';
import { dominancePresets } from '../content/dominance';
import { defaultOptions } from '../content/lessons';

function graph(count: number, pairs: [number, number][]): ControlFlowGraph {
  return {
    blocks: Array.from({ length: count }, (_, i) => ({
      id: `B${i}`,
      start: i,
      end: i + 1,
      instructions: [],
    })),
    edges: pairs.map(([a, b]) => ({ id: `${a}-${b}`, from: `B${a}`, to: `B${b}`, kind: 'next' })),
    instructionBlock: [],
  };
}
describe('dominance on structural CFGs', () => {
  it('finds the closest dominator of a diamond join without inventing a CFG edge', () => {
    const g = graph(5, [
      [0, 1],
      [0, 2],
      [1, 3],
      [2, 3],
      [3, 4],
    ]);
    const result = analyzeDominance(g);
    expect(result.dominators.B3).toEqual(['B0', 'B3']);
    expect(result.immediate).toMatchObject({ B1: 'B0', B2: 'B0', B3: 'B0', B4: 'B3' });
    expect(result.frontier.B1).toEqual(['B3']);
    expect(result.frontier.B2).toEqual(['B3']);
    expect(findCFGPath(g, 'B3', 'B1')).toEqual(['B0', 'B2', 'B3']);
    expect(findCFGPath(g, 'B4', 'B3')).toBeUndefined();
    expect(result.steps[0].current).toEqual(['B0']);
    expect(result.steps.find((s) => s.block === 'B3' && s.kind === 'visit')?.removed).toContain(
      'B1',
    );
    expect(result.converged).toBe(true);
  });
  it('ignores unreachable predecessors and does not define dominance for unreachable regions', () => {
    const result = analyzeDominance(
      graph(4, [
        [0, 1],
        [2, 3],
        [3, 2],
        [3, 1],
      ]),
    );
    expect(result.reachable).toEqual(['B0', 'B1']);
    expect(result.dominators.B1).toEqual(['B0', 'B1']);
    expect(result.dominators.B2).toEqual([]);
    expect(result.immediate.B2).toBeUndefined();
    expect(result.frontier.B2).toEqual([]);
    expect(result.loops).toEqual([]);
  });
  it('recognizes a natural loop with a dedicated preheader and its own header frontier', () => {
    const g = graph(5, [
      [0, 1],
      [1, 2],
      [1, 3],
      [2, 1],
      [3, 4],
    ]);
    g.blocks[0].instructions = [
      { op: 'move', dest: 'v0_i', value: { kind: 'constant', value: 0 }, nodeId: 0 },
    ];
    g.blocks[2].instructions = [
      { op: 'move', dest: 'v0_i', value: { kind: 'constant', value: 1 }, nodeId: 1 },
    ];
    const result = analyzeDominance(g);
    expect(result.loops).toEqual([
      {
        header: 'B1',
        nodes: ['B1', 'B2'],
        latches: ['B2'],
        backEdges: ['2-1'],
        exitingEdges: ['1-3'],
        exitBlocks: ['B3'],
        preheader: 'B0',
        parent: undefined,
      },
    ]);
    expect(result.frontier.B1).toEqual(['B1']);
    expect(result.frontier.B2).toEqual(['B1']);
    expect(result.phiCandidates.v0_i).toEqual(['B1']);
  });
  it('handles a self loop without swallowing its entering block, and merges multiple latches', () => {
    const self = analyzeDominance(
      graph(3, [
        [0, 1],
        [1, 1],
        [1, 2],
      ]),
    );
    expect(self.loops[0].nodes).toEqual(['B1']);
    expect(self.loops[0].preheader).toBe('B0');
    const multiple = analyzeDominance(
      graph(5, [
        [0, 1],
        [1, 2],
        [1, 3],
        [2, 1],
        [3, 1],
        [1, 4],
      ]),
    );
    expect(multiple.loops).toHaveLength(1);
    expect(multiple.loops[0].latches).toEqual(['B2', 'B3']);
    expect(multiple.loops[0].nodes).toEqual(['B1', 'B2', 'B3']);
    expect(analyzeDominance(graph(1, [[0, 0]])).loops[0].nodes).toEqual(['B0']);
    expect(analyzeDominance(graph(1, [])).loops).toEqual([]);
  });
  it('finds nested memberships and separates an inner exit from the outer exit', () => {
    const result = analyzeDominance(
      graph(7, [
        [0, 1],
        [1, 2],
        [1, 5],
        [2, 3],
        [2, 4],
        [3, 2],
        [4, 1],
        [5, 6],
      ]),
    );
    expect(result.loops).toHaveLength(2);
    expect(result.loops[0]).toMatchObject({
      header: 'B1',
      nodes: ['B1', 'B2', 'B3', 'B4'],
      exitBlocks: ['B5'],
    });
    expect(result.loops[1]).toMatchObject({
      header: 'B2',
      nodes: ['B2', 'B3'],
      exitBlocks: ['B4'],
      parent: 'B1',
    });
  });
  it('does not confuse visual backward edges or a two-entry cycle with natural loop backedges', () => {
    expect(
      analyzeDominance(
        graph(5, [
          [0, 3],
          [3, 2],
          [2, 1],
          [1, 4],
        ]),
      ).loops,
    ).toEqual([]);
    expect(
      analyzeDominance(
        graph(4, [
          [0, 1],
          [0, 2],
          [1, 2],
          [2, 1],
          [2, 3],
        ]),
      ).loops,
    ).toEqual([]);
    const noPreheader = analyzeDominance(
      graph(5, [
        [0, 1],
        [0, 2],
        [1, 2],
        [2, 3],
        [3, 2],
        [2, 4],
      ]),
    );
    expect(noPreheader.loops[0].preheader).toBeUndefined();
  });
  it('computes iterated phi candidates including transitive sites, without liveness pruning', () => {
    expect(iteratedFrontier(['A'], { A: ['B'], B: ['C'], C: ['B'] })).toEqual(['B', 'C']);
    const g = graph(4, [
      [0, 1],
      [0, 2],
      [1, 3],
      [2, 3],
    ]);
    for (const i of [1, 2])
      g.blocks[i].instructions = [
        { op: 'move', dest: 'unused', value: { kind: 'constant', value: i }, nodeId: i },
      ];
    expect(analyzeDominance(g).phiCandidates.unused).toEqual(['B3']);
  });
  it('publishes no derived claims when limited, and truncates recording without truncating the solve', () => {
    const limited = analyzeDominance(
      graph(3, [
        [0, 1],
        [1, 2],
      ]),
      { maxPasses: 0 },
    );
    expect(limited.converged).toBe(false);
    expect(limited.immediate).toEqual({});
    expect(limited.loops).toEqual([]);
    expect(limited.phiCandidates).toEqual({});
    const large = analyzeDominance(
      graph(
        150,
        Array.from({ length: 149 }, (_, i) => [i, i + 1]),
      ),
    );
    expect(large.converged).toBe(true);
    expect(large.traceTruncated).toBe(true);
    expect(large.steps).toHaveLength(242);
    expect(large.dominators.B149).toHaveLength(150);
  });
  it('agrees with independent exhaustive simple-path intersections on varied small graphs', () => {
    let seed = 31;
    for (let sample = 0; sample < 36; sample++) {
      const pairs: [number, number][] = [];
      for (let a = 0; a < 6; a++)
        for (let b = 0; b < 6; b++) {
          seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
          if (seed % 5 === 0) pairs.push([a, b]);
        }
      const g = graph(6, pairs),
        result = analyzeDominance(g),
        reverse = analyzeDominance(g, { reverse: true });
      expect(result.dominators).toEqual(reverse.dominators);
      for (let target = 0; target < 6; target++) {
        const paths: number[][] = [];
        const visit = (current: number, path: number[]) => {
          if (current === target) {
            paths.push(path);
            return;
          }
          for (const [a, b] of pairs)
            if (a === current && !path.includes(b)) visit(b, [...path, b]);
        };
        visit(0, [0]);
        const expected = paths.length
          ? Array.from({ length: 6 }, (_, i) => i)
              .filter((i) => paths.every((path) => path.includes(i)))
              .map((i) => `B${i}`)
          : [];
        expect(result.dominators[`B${target}`]).toEqual(expected);
      }
    }
  });
  it('analyzes program structure independently of branch values and VM visits', () => {
    const first = compile(dominancePresets[0].code, defaultOptions);
    const alternate = compile(dominancePresets[0].code.replace('true', 'false'), defaultOptions);
    expect(first.baseline?.output).toEqual([7]);
    expect(alternate.baseline?.output).toEqual([9]);
    expect(first.dominance?.dominators).toEqual(alternate.dominance?.dominators);
    const zero = compile(dominancePresets[4].code, defaultOptions);
    expect(zero.baseline?.output).toEqual([0]);
    expect(zero.dominance?.loops).toHaveLength(1);
    const nested = compile(dominancePresets[2].code, defaultOptions);
    expect(nested.dominance?.loops).toHaveLength(2);
    expect(nested.baseline?.output).toEqual([6]);
    expect(nested.dominance?.loops.filter((loop) => loop.parent)).toHaveLength(1);
    const parallel = compile(dominancePresets[3].code, defaultOptions);
    expect(parallel.dominance?.loops.every((loop) => !loop.parent)).toBe(true);
  });
});
