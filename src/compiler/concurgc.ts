export type TriColor = 'white' | 'gray' | 'black' | 'swept';
export type BarrierStrategy = 'none' | 'dijkstra' | 'satb';

export type ConcurGcOp =
  | { kind: 'mark-step' }
  | { kind: 'mark-all' }
  | { kind: 'link'; from: string; to: string }
  | { kind: 'cut'; from: string; to: string }
  | { kind: 'root'; name: string }
  | { kind: 'drop'; name: string }
  | { kind: 'alloc'; name: string }
  | { kind: 'sweep' };

export interface StrategySnapshot {
  strategy: BarrierStrategy;
  colors: Record<string, TriColor>;
  grayQueue: string[];
  barrierTriggers: number;
  lastAction: string;
  swept: string[];
  lostLive: string[];
  floatingGarbage: string[];
  verdict?: 'unsafe' | 'exact' | 'floating';
}

export interface ConcurGcFrame {
  stepIndex: number;
  opLabel: string;
  message: string;
  objects: string[];
  roots: string[];
  edges: { from: string; to: string }[];
  liveSet: string[];
  strategies: Record<BarrierStrategy, StrategySnapshot>;
}

export interface ConcurGcAnalysis {
  initialObjects: string[];
  ops: ConcurGcOp[];
  frames: ConcurGcFrame[];
  finalStrategies: Record<BarrierStrategy, StrategySnapshot>;
  liveSet: string[];
}

export type ConcurGcResult =
  | { ok: true; analysis: ConcurGcAnalysis }
  | { ok: false; error: string };

const MAX_INPUT = 1200;
const MAX_OBJECTS = 20;
const MAX_OPS = 32;
const IDENT_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

function computeLiveSet(roots: Set<string>, edges: Map<string, Set<string>>): Set<string> {
  const visited = new Set<string>();
  const queue: string[] = [];
  for (const r of roots) {
    if (!visited.has(r)) {
      visited.add(r);
      queue.push(r);
    }
  }
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const nxt of edges.get(cur) ?? []) {
      if (!visited.has(nxt)) {
        visited.add(nxt);
        queue.push(nxt);
      }
    }
  }
  return visited;
}

export function analyzeConcurGc(source: string): ConcurGcResult {
  if (source.length > MAX_INPUT) {
    return { ok: false, error: `输入长度超过限制（最多 ${MAX_INPUT} 字符）。` };
  }
  const parts = source.split('%%');
  if (parts.length !== 2) {
    return { ok: false, error: '请使用一行 %% 分隔上方的初始堆描述与下方的并发操作序列。' };
  }

  const objects: string[] = [];
  const objSet = new Set<string>();
  const roots = new Set<string>();
  const edges = new Map<string, Set<string>>();

  const addObj = (name: string) => {
    if (!IDENT_RE.test(name)) throw new Error(`非法对象名 '${name}'。`);
    if (objSet.has(name)) return;
    if (objects.length >= MAX_OBJECTS) throw new Error(`对象数量超过上限（最多 ${MAX_OBJECTS} 个）。`);
    objects.push(name);
    objSet.add(name);
    edges.set(name, new Set());
  };

  try {
    const headerLines = parts[0].split(/\r?\n/);
    for (let idx = 0; idx < headerLines.length; idx++) {
      const raw = headerLines[idx].replace(/\/\/.*$/, '').trim();
      if (!raw) continue;
      const words = raw.split(/\s+/);
      if (words[0] === 'heap') {
        if (words.length < 2) throw new Error(`第 ${idx + 1} 行：heap 后至少需要一个对象名。`);
        for (const w of words.slice(1)) addObj(w);
      } else if (words[0] === 'root') {
        if (words.length < 2) throw new Error(`第 ${idx + 1} 行：root 后至少需要一个对象名。`);
        for (const w of words.slice(1)) {
          if (!objSet.has(w)) throw new Error(`第 ${idx + 1} 行：root 引用的对象 '${w}' 未在 heap 中声明。`);
          roots.add(w);
        }
      } else if (words[0] === 'edge') {
        const rest = raw.slice(4).trim();
        const arrow = rest.split('->').map((s) => s.trim());
        if (arrow.length !== 2 || !arrow[0] || !arrow[1]) {
          throw new Error(`第 ${idx + 1} 行：edge 格式应为 'edge A -> B'。`);
        }
        if (!objSet.has(arrow[0]) || !objSet.has(arrow[1])) {
          throw new Error(`第 ${idx + 1} 行：edge 使用了未声明的对象 '${arrow[0]}' 或 '${arrow[1]}'。`);
        }
        edges.get(arrow[0])!.add(arrow[1]);
      } else {
        throw new Error(`第 ${idx + 1} 行：不支持的初始声明 '${words[0]}'（仅支持 heap / root / edge）。`);
      }
    }
    if (objects.length === 0) throw new Error('请在 %% 上方用 heap 至少声明一个对象。');
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  const ops: ConcurGcOp[] = [];
  try {
    const opLines = parts[1].split(/\r?\n/);
    for (let idx = 0; idx < opLines.length; idx++) {
      const raw = opLines[idx].replace(/\/\/.*$/, '').trim();
      if (!raw) continue;
      if (ops.length >= MAX_OPS) throw new Error(`操作数量超过上限（最多 ${MAX_OPS} 条）。`);
      const words = raw.split(/\s+/);
      const cmd = words[0];
      if (cmd === 'mark-step' && words.length === 1) {
        ops.push({ kind: 'mark-step' });
      } else if (cmd === 'mark-all' && words.length === 1) {
        ops.push({ kind: 'mark-all' });
      } else if (cmd === 'sweep' && words.length === 1) {
        ops.push({ kind: 'sweep' });
      } else if ((cmd === 'link' || cmd === 'cut') && raw.includes('->')) {
        const arrow = raw.slice(cmd.length).trim().split('->').map((s) => s.trim());
        if (arrow.length !== 2 || !IDENT_RE.test(arrow[0]) || !IDENT_RE.test(arrow[1])) {
          throw new Error(`操作区第 ${idx + 1} 行：${cmd} 格式应为 '${cmd} A -> B'。`);
        }
        ops.push({ kind: cmd, from: arrow[0], to: arrow[1] });
      } else if ((cmd === 'root' || cmd === 'drop' || cmd === 'alloc') && words.length === 2 && IDENT_RE.test(words[1])) {
        ops.push({ kind: cmd, name: words[1] });
      } else {
        throw new Error(`操作区第 ${idx + 1} 行：无法识别的操作 '${raw}'。`);
      }
    }
    if (ops.length === 0) throw new Error('请在 %% 下方至少写入一条操作（如 mark-step、link、cut、sweep）。');
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  interface StrategyState {
    strategy: BarrierStrategy;
    colors: Record<string, TriColor>;
    grayQueue: string[];
    barrierTriggers: number;
    lastAction: string;
    swept: string[];
    lostLive: string[];
    floatingGarbage: string[];
    verdict?: 'unsafe' | 'exact' | 'floating';
  }

  const initStrategy = (strategy: BarrierStrategy): StrategyState => {
    const colors: Record<string, TriColor> = {};
    const grayQueue: string[] = [];
    for (const o of objects) {
      if (roots.has(o)) {
        colors[o] = 'gray';
        grayQueue.push(o);
      } else {
        colors[o] = 'white';
      }
    }
    return {
      strategy,
      colors,
      grayQueue,
      barrierTriggers: 0,
      lastAction: `初始标记根集合 [${[...roots].join(', ') || '无'}] 为灰色，其余为白色。`,
      swept: [],
      lostLive: [],
      floatingGarbage: [],
    };
  };

  const states: Record<BarrierStrategy, StrategyState> = {
    none: initStrategy('none'),
    dijkstra: initStrategy('dijkstra'),
    satb: initStrategy('satb'),
  };

  const snapEdges = () => {
    const list: { from: string; to: string }[] = [];
    for (const from of objects) {
      for (const to of edges.get(from) ?? []) list.push({ from, to });
    }
    return list;
  };

  const snapStrategies = (): Record<BarrierStrategy, StrategySnapshot> => ({
    none: {
      ...states.none,
      colors: { ...states.none.colors },
      grayQueue: [...states.none.grayQueue],
      swept: [...states.none.swept],
      lostLive: [...states.none.lostLive],
      floatingGarbage: [...states.none.floatingGarbage],
    },
    dijkstra: {
      ...states.dijkstra,
      colors: { ...states.dijkstra.colors },
      grayQueue: [...states.dijkstra.grayQueue],
      swept: [...states.dijkstra.swept],
      lostLive: [...states.dijkstra.lostLive],
      floatingGarbage: [...states.dijkstra.floatingGarbage],
    },
    satb: {
      ...states.satb,
      colors: { ...states.satb.colors },
      grayQueue: [...states.satb.grayQueue],
      swept: [...states.satb.swept],
      lostLive: [...states.satb.lostLive],
      floatingGarbage: [...states.satb.floatingGarbage],
    },
  });

  const frames: ConcurGcFrame[] = [];
  const pushFrame = (stepIndex: number, opLabel: string, message: string) => {
    const live = [...computeLiveSet(roots, edges)];
    frames.push({
      stepIndex,
      opLabel,
      message,
      objects: [...objects],
      roots: [...roots],
      edges: snapEdges(),
      liveSet: live,
      strategies: snapStrategies(),
    });
  };

  const initialObjects = [...objects];
  pushFrame(
    0,
    '初始标记 (Initial Mark)',
    `并发标记启动：将 GC 根 [${[...roots].join(', ') || '无'}] 染灰并入队，其余对象为白色。随后业务线程（Mutator）与 GC 将交替推进。`,
  );

  const stepMarkOne = (st: StrategyState): string => {
    if (st.grayQueue.length === 0) return '灰队列已空，无需推进。';
    const cur = st.grayQueue.shift()!;
    const shaded: string[] = [];
    for (const child of edges.get(cur) ?? []) {
      if (st.colors[child] === 'white') {
        st.colors[child] = 'gray';
        st.grayQueue.push(child);
        shaded.push(child);
      }
    }
    st.colors[cur] = 'black';
    return shaded.length
      ? `扫描灰对象 ${cur} → 标黑，并将白子对象 [${shaded.join(', ')}] 染灰入队。`
      : `扫描灰对象 ${cur} → 标黑（无新的白子对象）。`;
  };

  const runSweep = (st: StrategyState, liveSet: Set<string>) => {
    st.swept = [];
    st.lostLive = [];
    st.floatingGarbage = [];
    for (const o of objects) {
      if (st.colors[o] === 'white') {
        st.colors[o] = 'swept';
        st.swept.push(o);
        if (liveSet.has(o)) st.lostLive.push(o);
      } else if (st.colors[o] !== 'swept' && !liveSet.has(o)) {
        st.floatingGarbage.push(o);
      }
    }
    if (st.lostLive.length > 0) {
      st.verdict = 'unsafe';
      st.lastAction = `危险！误杀了仍可达的存活对象 [${st.lostLive.join(', ')}]（发生三色漏标）！`;
    } else if (st.floatingGarbage.length > 0) {
      st.verdict = 'floating';
      st.lastAction = `安全（未误杀存活对象）；本轮保留了浮动垃圾 [${st.floatingGarbage.join(', ')}]，留待下轮回收。`;
    } else {
      st.verdict = 'exact';
      st.lastAction = `安全且精确：回收了全部不可达对象 [${st.swept.join(', ') || '无'}]，无误杀、无浮动垃圾。`;
    }
  };

  let sweptExplicitly = false;
  try {
    ops.forEach((op, idx) => {
      const stepNum = idx + 1;
      if (op.kind === 'mark-step') {
        for (const st of Object.values(states)) st.lastAction = stepMarkOne(st);
        pushFrame(stepNum, 'mark-step', 'GC 推进一小步：从各策略的灰队列中取出队首对象扫描其引用并涂黑。');
      } else if (op.kind === 'mark-all') {
        for (const st of Object.values(states)) {
          let cnt = 0;
          while (st.grayQueue.length > 0) {
            stepMarkOne(st);
            cnt++;
          }
          st.lastAction = cnt > 0 ? `连续扫描 ${cnt} 个灰对象，灰队列清空，标记阶段结束。` : '灰队列本就为空。';
        }
        pushFrame(stepNum, 'mark-all', 'GC 持续推进三色标记，直到各策略的灰队列全部清空。');
      } else if (op.kind === 'link') {
        if (!objSet.has(op.from) || !objSet.has(op.to)) {
          throw new Error(`link ${op.from} -> ${op.to} 使用了不存在的对象。`);
        }
        const liveNow = computeLiveSet(roots, edges);
        if (!liveNow.has(op.from) || !liveNow.has(op.to)) {
          throw new Error(`Mutator 只能操作当前可达的对象（link ${op.from} -> ${op.to} 中存在不可达对象）。`);
        }
        edges.get(op.from)!.add(op.to);
        // None
        states.none.lastAction = `直接写入 ${op.from} -> ${op.to}（无写屏障${states.none.colors[op.from] === 'black' && states.none.colors[op.to] === 'white' ? '：出现黑指白风险！' : ''}）。`;
        // Dijkstra Insertion Barrier: if black -> white, shade target gray!
        if (states.dijkstra.colors[op.from] === 'black' && states.dijkstra.colors[op.to] === 'white') {
          states.dijkstra.colors[op.to] = 'gray';
          states.dijkstra.grayQueue.push(op.to);
          states.dijkstra.barrierTriggers++;
          states.dijkstra.lastAction = `触发插入写屏障！拦截黑对象 ${op.from} 指向白对象 ${op.to}，立刻将 ${op.to} 染灰入队。`;
        } else {
          states.dijkstra.lastAction = `写入 ${op.from} -> ${op.to}（非黑指白，未触发屏障）。`;
        }
        // SATB does not trigger on pure insertion
        states.satb.lastAction = `写入 ${op.from} -> ${op.to}（删除写屏障只在覆盖/断开旧引用时触发）。`;
        pushFrame(
          stepNum,
          `link ${op.from} -> ${op.to}`,
          `业务线程并发写入新引用 ${op.from} -> ${op.to}：观察 Dijkstra 插入写屏障是否拦截“黑指白”。`,
        );
      } else if (op.kind === 'cut') {
        if (!objSet.has(op.from) || !objSet.has(op.to)) {
          throw new Error(`cut ${op.from} -> ${op.to} 使用了不存在的对象。`);
        }
        const liveNow = computeLiveSet(roots, edges);
        if (!liveNow.has(op.from)) {
          throw new Error(`Mutator 不能修改不可达对象 '${op.from}' 的引用。`);
        }
        if (!edges.get(op.from)!.has(op.to)) {
          throw new Error(`边 ${op.from} -> ${op.to} 当前不存在，无法 cut。`);
        }
        edges.get(op.from)!.delete(op.to);
        states.none.lastAction = `直接断开 ${op.from} -> ${op.to}（无写屏障）。`;
        states.dijkstra.lastAction = `断开 ${op.from} -> ${op.to}（插入屏障不拦截删除操作）。`;
        // SATB Deletion Barrier: if overwritten target is white, shade target gray!
        if (states.satb.colors[op.to] === 'white') {
          states.satb.colors[op.to] = 'gray';
          states.satb.grayQueue.push(op.to);
          states.satb.barrierTriggers++;
          states.satb.lastAction = `触发 SATB 删除写屏障！旧目标 ${op.to} 仍为白色，立刻将其染灰入队以保护初始快照。`;
        } else {
          states.satb.lastAction = `断开 ${op.from} -> ${op.to}（旧目标 ${op.to} 已非白色，无需补染）。`;
        }
        pushFrame(
          stepNum,
          `cut ${op.from} -> ${op.to}`,
          `业务线程并发断开引用 ${op.from} -> ${op.to}：观察 Yuasa SATB 删除写屏障如何保护被断掉的白色目标。`,
        );
      } else if (op.kind === 'root') {
        if (!objSet.has(op.name)) throw new Error(`root ${op.name} 引用了不存在的对象。`);
        roots.add(op.name);
        states.none.lastAction = `新增根 ${op.name}（若未重新扫描根，白对象有漏标风险）。`;
        if (states.dijkstra.colors[op.name] === 'white') {
          states.dijkstra.colors[op.name] = 'gray';
          states.dijkstra.grayQueue.push(op.name);
          states.dijkstra.barrierTriggers++;
          states.dijkstra.lastAction = `新增根 ${op.name}：插入屏障将其染灰入队。`;
        } else {
          states.dijkstra.lastAction = `新增根 ${op.name}（已着色）。`;
        }
        states.satb.lastAction = `新增根 ${op.name}（SATB 快照已覆盖原可达路径）。`;
        pushFrame(stepNum, `root ${op.name}`, `业务线程将 ${op.name} 加入根集合。`);
      } else if (op.kind === 'drop') {
        if (!roots.has(op.name)) throw new Error(`对象 '${op.name}' 当前不在根集合中，无法 drop。`);
        roots.delete(op.name);
        states.none.lastAction = `移除根 ${op.name}。`;
        states.dijkstra.lastAction = `移除根 ${op.name}。`;
        if (states.satb.colors[op.name] === 'white') {
          states.satb.colors[op.name] = 'gray';
          states.satb.grayQueue.push(op.name);
          states.satb.barrierTriggers++;
          states.satb.lastAction = `移除根 ${op.name}：SATB 屏障将其染灰保活本轮。`;
        } else {
          states.satb.lastAction = `移除根 ${op.name}（已非白色）。`;
        }
        pushFrame(stepNum, `drop ${op.name}`, `业务线程移除根引用 ${op.name}。`);
      } else if (op.kind === 'alloc') {
        if (objSet.has(op.name)) throw new Error(`alloc ${op.name} 失败：对象名已存在。`);
        addObj(op.name);
        roots.add(op.name);
        // Without barrier/allocate-black, naive allocator leaves new object white!
        states.none.colors[op.name] = 'white';
        states.none.lastAction = `新分配 ${op.name}（初始为白色且未入队，若不加处理会被本轮清除！）。`;
        // Both Dijkstra & SATB use allocate-black during concurrent mark
        states.dijkstra.colors[op.name] = 'black';
        states.dijkstra.barrierTriggers++;
        states.dijkstra.lastAction = `新分配 ${op.name}：并发标记期直接涂黑（Allocate-Black），防止本轮误杀。`;
        states.satb.colors[op.name] = 'black';
        states.satb.barrierTriggers++;
        states.satb.lastAction = `新分配 ${op.name}：并发标记期直接涂黑（Allocate-Black），本轮安全存活。`;
        pushFrame(
          stepNum,
          `alloc ${op.name}`,
          `标记期间业务线程新分配对象 ${op.name}（挂入根集合）：对比无保护（白色）与并发 GC 的“分配即涂黑”。`,
        );
      } else if (op.kind === 'sweep') {
        sweptExplicitly = true;
        const liveNow = computeLiveSet(roots, edges);
        for (const st of Object.values(states)) runSweep(st, liveNow);
        pushFrame(
          stepNum,
          'sweep（清除与独立可达性核对）',
          `清除全部白色对象，并用独立 BFS 核对当前真实可达集合 [${[...liveNow].join(', ') || '空'}]：检查是否误杀存活对象或产生浮动垃圾。`,
        );
      }
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  const finalLive = computeLiveSet(roots, edges);
  if (!sweptExplicitly) {
    for (const st of Object.values(states)) {
      while (st.grayQueue.length > 0) stepMarkOne(st);
      runSweep(st, finalLive);
    }
    pushFrame(
      ops.length + 1,
      '自动完成标记并核对',
      `自动清空剩余灰队列并模拟清除，核对当前真实可达集合 [${[...finalLive].join(', ') || '空'}]。`,
    );
  }

  return {
    ok: true,
    analysis: {
      initialObjects,
      ops,
      frames,
      finalStrategies: snapStrategies(),
      liveSet: [...finalLive],
    },
  };
}
