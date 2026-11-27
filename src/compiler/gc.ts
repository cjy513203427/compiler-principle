import { T } from '../i18n';
import type { Diagnostic } from './model';

export interface HeapObject { name: string; size: number; address: number; refs: string[] }
export type MutatorOp =
  | { kind: 'drop'; target: string; text: string }
  | { kind: 'root'; target: string; text: string }
  | { kind: 'link'; from: string; target: string; text: string }
  | { kind: 'cut'; from: string; target: string; text: string };
export interface HeapProgram { capacity: number; request: number; roots: string[]; objects: HeapObject[]; ops: MutatorOp[] }
export const GC_LIMITS = { text: 1200, objects: 24, refs: 6, size: 8, heap: 128, ops: 24 };

type Outcome<T> = { ok: true; analysis: T } | { ok: false; issue: Diagnostic };
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,11}$/;

export function parseHeap(text: string): Outcome<HeapProgram> {
  const fail = (message: string, start = 0, end = start): Outcome<HeapProgram> =>
    ({ ok: false, issue: { stage: 'gc', message, start, end } });
  if (text.length > GC_LIMITS.text) return fail(T('输入最多 {#0} 字符。', GC_LIMITS.text));
  let capacity: number | undefined, request = 2, separator = false, offset = 0;
  const roots: { name: string; at: number }[] = [];
  const objects: HeapObject[] = [];
  const pending: { name: string; at: number }[] = [];
  const ops: (MutatorOp & { at: number })[] = [];
  for (const raw of text.split('\n')) {
    const at = offset;
    offset += raw.length + 1;
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const end = at + raw.length;
    if (line === '%%') { if (separator) return fail(T('只能有一个 %% 分隔行。'), at, end); separator = true; continue; }
    if (separator) {
      let match: RegExpMatchArray | null;
      if ((match = line.match(/^(drop|root)\s+(\S+)$/))) ops.push({ kind: match[1] as 'drop' | 'root', target: match[2], text: line, at });
      else if ((match = line.match(/^(link|cut)\s+(\S+)\s*->\s*(\S+)$/))) ops.push({ kind: match[1] as 'link' | 'cut', from: match[2], target: match[3], text: line, at });
      else return fail(T('%% 下方每行一个操作：drop x、root x、link x -> y、cut x -> y。'), at, end);
      if (ops.length > GC_LIMITS.ops) return fail(T('最多 {#0} 个操作。', GC_LIMITS.ops), at, end);
      continue;
    }
    let match: RegExpMatchArray | null;
    if ((match = line.match(/^heap\s+(\d+)$/))) {
      capacity = Number(match[1]);
      if (capacity < 2 || capacity > GC_LIMITS.heap) return fail(T('堆容量需要在 2–{#0} 格之间。', GC_LIMITS.heap), at, end);
    } else if ((match = line.match(/^request\s+(\d+)$/))) {
      request = Number(match[1]);
      if (request < 1 || request > GC_LIMITS.heap) return fail(T('申请大小需要在 1–{#0} 格之间。', GC_LIMITS.heap), at, end);
    } else if ((match = line.match(/^root\s+(.+)$/))) {
      for (const name of match[1].split(',').map((item) => item.trim()).filter(Boolean)) roots.push({ name, at });
    } else if ((match = line.match(/^(\S+)\s+(\d+)(?:\s*->\s*(.*))?$/))) {
      const [, name, size, list] = match;
      if (!NAME.test(name) || ['heap', 'request', 'root'].includes(name)) return fail(T('对象名 {#0} 无效：字母或下划线开头，最多 12 个字符。', name), at, end);
      if (objects.some((item) => item.name === name)) return fail(T('对象 {#0} 重复定义。', name), at, end);
      const sizeValue = Number(size);
      if (sizeValue < 1 || sizeValue > GC_LIMITS.size) return fail(T('对象大小需要在 1–{#0} 格之间。', GC_LIMITS.size), at, end);
      const refs = (list ?? '').split(',').map((item) => item.trim()).filter(Boolean);
      if (refs.length > GC_LIMITS.refs) return fail(T('每个对象最多 {#0} 个引用。', GC_LIMITS.refs), at, end);
      if (new Set(refs).size !== refs.length) return fail(T('{#0} 对同一个对象只写一次引用。', name), at, end);
      refs.forEach((ref) => pending.push({ name: ref, at }));
      objects.push({ name, size: sizeValue, address: 0, refs });
      if (objects.length > GC_LIMITS.objects) return fail(T('最多 {#0} 个对象。', GC_LIMITS.objects), at, end);
    } else return fail(T('每行写 heap N、request N、root a, b 或“名字 大小 -> 引用, …”。'), at, end);
  }
  if (!objects.length) return fail(T('至少需要一个对象。'));
  const known = new Set(objects.map((item) => item.name));
  for (const item of [...pending, ...roots]) if (!known.has(item.name)) return fail(T('没有名为 {#0} 的对象。', item.name), item.at, item.at + 1);
  if (new Set(roots.map((item) => item.name)).size !== roots.length) return fail(T('同一个根只写一次。'));
  for (const op of ops) for (const name of 'from' in op ? [op.from, op.target] : [op.target])
    if (!known.has(name)) return fail(T('操作里没有名为 {#0} 的对象。', name), op.at, op.at + op.text.length);
  let address = 0;
  for (const item of objects) { item.address = address; address += item.size; }
  const total = address;
  capacity ??= Math.max(total + 4, 8);
  if (total > capacity) return fail(T('对象共占 {#0} 格，超过堆容量 {#1} 格。', total, capacity));
  return { ok: true, analysis: { capacity, request, roots: roots.map((item) => item.name), objects, ops: ops.map(({ at: _at, ...op }) => op as MutatorOp) } };
}

export function reachableFrom(roots: string[], refs: Record<string, string[]>): Set<string> {
  const seen = new Set<string>(), queue = [...roots];
  while (queue.length) {
    const name = queue.shift()!;
    if (seen.has(name)) continue;
    seen.add(name);
    queue.push(...(refs[name] ?? []));
  }
  return seen;
}
export interface FreeRange { start: number; size: number }
function freeRanges(capacity: number, live: { address: number; size: number }[]): FreeRange[] {
  const used = Array(capacity).fill(false);
  live.forEach((item) => { for (let cell = item.address; cell < item.address + item.size; cell++) used[cell] = true; });
  const ranges: FreeRange[] = [];
  for (let cell = 0; cell < capacity; cell++) {
    if (used[cell]) continue;
    const last = ranges.at(-1);
    if (last && last.start + last.size === cell) last.size++;
    else ranges.push({ start: cell, size: 1 });
  }
  return ranges;
}

export interface RcEvent {
  kind: 'op' | 'inc' | 'dec' | 'free';
  object?: string;
  message: string;
  counts: Record<string, number>;
  freed: string[];
  roots: string[];
  refs: Record<string, string[]>;
}
export interface CycleEvent { kind: 'start' | 'subtract' | 'seed' | 'rescue' | 'garbage'; object?: string; message: string; gcRef: Record<string, number>; rescued: string[] }
export type MarkEvent = { kind: 'gray' | 'black'; object: string; from?: string };
export interface Collector {
  name: string;
  live: string[];
  reclaimed: string[];
  layout: { name: string; address: number; size: number }[];
  space: number;
  free: FreeRange[];
  largestFree: number;
  totalFree: number;
  request: { fits: boolean; address?: number };
  work: string;
  note?: string;
  /** No reachable object was reclaimed. */
  safe: boolean;
  /** Every unreachable object was reclaimed. */
  complete: boolean;
}
export interface GcFrame {
  phase: 'setup' | 'rc' | 'cycle' | 'mark' | 'sweep' | 'compact' | 'copy' | 'complete';
  event?: number;
  message: string;
}
export interface GcAnalysis {
  program: HeapProgram;
  finalRoots: string[];
  finalRefs: Record<string, string[]>;
  reachable: string[];
  rc: RcEvent[];
  rcFreed: string[];
  cycle: CycleEvent[];
  cycleGarbage: string[];
  mark: MarkEvent[];
  sweep: { object: string; kept: boolean }[];
  compact: { object: string; from: number; to: number }[];
  copy: { kind: 'copy' | 'scan'; object: string; from?: string; to?: number }[];
  copyFits: boolean;
  collectors: Collector[];
  frames: GcFrame[];
  traceTruncated: boolean;
}

export function analyzeGc(text: string): Outcome<GcAnalysis> {
  const parsed = parseHeap(text);
  if (!parsed.ok) return parsed;
  const program = parsed.analysis;
  const byName = new Map(program.objects.map((item) => [item.name, item]));
  const refs: Record<string, string[]> = Object.fromEntries(program.objects.map((item) => [item.name, [...item.refs]]));
  const roots = [...program.roots];
  const frames: GcFrame[] = [];
  let traceTruncated = false;
  const push = (frame: GcFrame) => { if (frames.length < 400) frames.push(frame); else traceTruncated = true; };
  const fail = (message: string, op: MutatorOp): Outcome<GcAnalysis> => {
    const at = text.indexOf(op.text);
    return { ok: false, issue: { stage: 'gc', message, start: Math.max(0, at), end: Math.max(0, at) + op.text.length } };
  };
  push({ phase: 'setup', message: T('{#0} 个对象按声明顺序紧挨着放进 {#1} 格的堆，根是 {#2}。从根出发沿引用能走到的对象才有用，其余都是垃圾。', program.objects.length, program.capacity, program.roots.join(T('、')) || T('（没有根）')) });

  // Reference counting reacts to every mutation; objects whose count reaches zero are freed at once.
  const counts: Record<string, number> = Object.fromEntries(program.objects.map((item) => [item.name, 0]));
  roots.forEach((name) => counts[name]++);
  program.objects.forEach((item) => item.refs.forEach((ref) => counts[ref]++));
  const freed = new Set<string>();
  const rc: RcEvent[] = [];
  const record = (kind: RcEvent['kind'], message: string, object?: string) => {
    rc.push({ kind, object, message, counts: { ...counts }, freed: [...freed], roots: [...roots],
      refs: Object.fromEntries(Object.entries(refs).map(([name, list]) => [name, [...list]])) });
    push({ phase: 'rc', event: rc.length - 1, message });
  };
  const release = (name: string, initially: boolean) => {
    freed.add(name);
    record('free', initially
      ? T('{#0} 一开始就没有任何引用（计数 0），立即回收；它引用的对象各减 1。', name)
      : T('{#0} 的计数变为 0，立即回收；它引用的对象各减 1。', name), name);
    for (const ref of refs[name]) decrement(ref, name);
  };
  const decrement = (name: string, by: string) => {
    counts[name]--;
    record('dec', T('{#0} 不再引用 {#1}：计数 {#2} → {#3}。', by, name, counts[name] + 1, counts[name]), name);
    if (counts[name] === 0) release(name, false);
  };
  record('op', T('引用计数：每个对象记下有多少个根或对象指向它。初始计数：{#0}。', program.objects.map((item) => `${item.name}=${counts[item.name]}`).join(T('，'))));
  for (const item of program.objects) if (counts[item.name] === 0 && !freed.has(item.name)) release(item.name, true);
  for (const op of program.ops) {
    const live = reachableFrom(roots, refs);
    if (op.kind === 'drop') {
      if (!roots.includes(op.target)) return fail(T('{#0} 当前不是根，不能 drop。', op.target), op);
      roots.splice(roots.indexOf(op.target), 1);
      record('op', T('执行 {#0}：根不再指向 {#1}。', op.text, op.target));
      decrement(op.target, T('根'));
    } else if (op.kind === 'root') {
      if (!live.has(op.target)) return fail(T('{#0} 已经不可达，程序拿不到指向它的引用。', op.target), op);
      if (roots.includes(op.target)) return fail(T('{#0} 已经是根。', op.target), op);
      roots.push(op.target);
      counts[op.target]++;
      record('op', T('执行 {#0}：新的根指向 {#1}，计数加 1 变为 {#2}。', op.text, op.target, counts[op.target]), op.target);
    } else if (op.kind === 'link') {
      if (!live.has(op.from) || !live.has(op.target)) return fail(T('只能连接当前可达的对象：程序拿不到不可达对象的引用。'), op);
      if (refs[op.from].includes(op.target)) return fail(T('{#0} 已经引用 {#1}。', op.from, op.target), op);
      if (refs[op.from].length >= GC_LIMITS.refs) return fail(T('每个对象最多 {#0} 个引用。', GC_LIMITS.refs), op);
      refs[op.from].push(op.target);
      counts[op.target]++;
      record('op', T('执行 {#0}：{#1} 的计数加 1 变为 {#2}。', op.text, op.target, counts[op.target]), op.target);
    } else {
      if (!live.has(op.from)) return fail(T('{#0} 已经不可达，程序无法修改它。', op.from), op);
      if (!refs[op.from].includes(op.target)) return fail(T('{#0} 没有引用 {#1}。', op.from, op.target), op);
      refs[op.from].splice(refs[op.from].indexOf(op.target), 1);
      record('op', T('执行 {#0}。', op.text));
      decrement(op.target, op.from);
    }
  }
  const reachable = reachableFrom(roots, refs);

  // Python-style cycle detection on objects reference counting kept alive.
  const tracked = program.objects.map((item) => item.name).filter((name) => !freed.has(name));
  const gcRef: Record<string, number> = Object.fromEntries(tracked.map((name) => [name, counts[name]]));
  const rescued: string[] = [];
  const cycle: CycleEvent[] = [];
  const note = (kind: CycleEvent['kind'], message: string, object?: string) => {
    cycle.push({ kind, object, message, gcRef: { ...gcRef }, rescued: [...rescued] });
    push({ phase: 'cycle', event: cycle.length - 1, message });
  };
  note('start', T('循环检测（Python gc 的思路）：剩下 {#0} 个未回收对象，先令 gc_ref = 引用计数。', tracked.length));
  for (const name of tracked) for (const ref of refs[name]) if (ref in gcRef) {
    gcRef[ref]--;
    note('subtract', T('假装去掉 {#0} → {#1} 这条对象之间的引用：{#1} 的 gc_ref 减为 {#2}。', name, ref, gcRef[ref]), ref);
  }
  const seeds = tracked.filter((name) => gcRef[name] > 0);
  note('seed', seeds.length ? T('gc_ref 仍大于 0 的 {#0} 一定被对象之外的根引用，不是垃圾。', seeds.join(T('、'))) : T('所有 gc_ref 都是 0：没有对象被根引用。'));
  const queue = [...seeds];
  while (queue.length) {
    const name = queue.shift()!;
    if (rescued.includes(name)) continue;
    rescued.push(name);
    note('rescue', T('{#0} 可从根到达，保留；继续检查它引用的对象。', name), name);
    queue.push(...refs[name].filter((ref) => ref in gcRef && !rescued.includes(ref)));
  }
  const cycleGarbage = tracked.filter((name) => !rescued.includes(name));
  note('garbage', cycleGarbage.length ? T('剩下的 {#0} 计数都不为 0，却不可达：这是只靠引用计数回收不了的循环垃圾。', cycleGarbage.join(T('、'))) : T('没有发现循环垃圾。'));

  // Tracing collectors run on the final graph. Marking uses the tri-color worklist.
  const mark: MarkEvent[] = [];
  const color = new Map(program.objects.map((item) => [item.name, 'white']));
  const worklist: string[] = [];
  for (const root of roots) if (color.get(root) === 'white') { color.set(root, 'gray'); worklist.push(root); mark.push({ kind: 'gray', object: root }); }
  while (worklist.length) {
    const name = worklist.shift()!;
    for (const ref of refs[name]) if (color.get(ref) === 'white') { color.set(ref, 'gray'); worklist.push(ref); mark.push({ kind: 'gray', object: ref, from: name }); }
    color.set(name, 'black');
    mark.push({ kind: 'black', object: name });
  }
  push({ phase: 'mark', message: T('标记阶段：所有对象先是白色。根直接引用的对象变灰色，放进待处理区。') });
  mark.forEach((event, index) => push({ phase: 'mark', event: index, message: event.kind === 'gray'
    ? event.from
      ? T('{#0} 引用 {#1}：白 → 灰，放进待处理区。', event.from, event.object)
      : T('根引用 {#0}：白 → 灰，放进待处理区。', event.object)
    : T('{#0} 的引用都看过了：灰 → 黑。', event.object) }));
  const marked = program.objects.filter((item) => color.get(item.name) === 'black');
  const garbage = program.objects.filter((item) => color.get(item.name) !== 'black');

  const sweep = program.objects.map((item) => ({ object: item.name, kept: color.get(item.name) === 'black' }));
  sweep.forEach((item, index) => push({ phase: 'sweep', event: index, message: item.kept
    ? T('清除阶段按地址扫描：{#0} 是黑色，保留在原地址 {#1}。', item.object, byName.get(item.object)!.address)
    : T('清除阶段：{#0} 仍是白色，把它的 {#1} 格还给空闲表。', item.object, byName.get(item.object)!.size) }));

  let cursor = 0;
  const compact = marked.map((item) => { const move = { object: item.name, from: item.address, to: cursor }; cursor += item.size; return move; });
  compact.forEach((item, index) => push({ phase: 'compact', event: index, message: item.from === item.to
    ? T('整理：{#0} 已在地址 {#1}，不用移动。', item.object, item.to)
    : T('整理：把 {#0} 从地址 {#1} 滑到 {#2}，指向它的引用一起改成新地址。', item.object, item.from, item.to) }));

  const half = Math.floor(program.capacity / 2);
  const initialTotal = program.objects.reduce((sum, item) => sum + item.size, 0);
  const copyFits = initialTotal <= half;
  const copy: GcAnalysis['copy'] = [];
  const copied = new Map<string, number>();
  let free = 0;
  const forward = (name: string, from?: string) => {
    if (copied.has(name)) return;
    copied.set(name, free);
    copy.push({ kind: 'copy', object: name, from, to: free });
    free += byName.get(name)!.size;
  };
  roots.forEach((root) => forward(root));
  for (let scan = 0; scan < [...copied.keys()].length; scan++) {
    const name = [...copied.keys()][scan];
    copy.push({ kind: 'scan', object: name });
    refs[name].forEach((ref) => forward(ref, name));
  }
  if (!copyFits) push({ phase: 'copy', message: T('停止-拷贝把 {#0} 格分成两半，每半 {#1} 格；初始对象共 {#2} 格，旧空间一开始就放不下。下面的拷贝过程仅作演示。', program.capacity, half, initialTotal) });
  copy.forEach((item, index) => push({ phase: 'copy', event: index, message: item.kind === 'copy'
    ? item.from
      ? T('扫描 {#0} 时发现 {#1}：拷到新空间地址 {#2}，旧位置留下转发地址。', item.from, item.object, item.to)
      : T('根引用 {#0}：拷到新空间地址 {#1}，旧位置留下转发地址。', item.object, item.to)
    : T('扫描指针来到 {#0}：检查它的引用，没拷过的对象接着拷到新空间末尾。', item.object) }));

  const fit = (ranges: FreeRange[]) => ranges.find((range) => range.size >= program.request);
  const summarize = (name: Collector['name'], layout: Collector['layout'], space: number, work: string, extra: Partial<Collector> = {}): Collector => {
    const ranges = freeRanges(space, layout);
    const target = fit(ranges);
    const liveNames = new Set(layout.map((item) => item.name));
    return { name, live: layout.map((item) => item.name), reclaimed: program.objects.map((item) => item.name).filter((item) => !liveNames.has(item)),
      layout, space, free: ranges, largestFree: Math.max(0, ...ranges.map((range) => range.size)),
      totalFree: ranges.reduce((sum, range) => sum + range.size, 0), request: { fits: !!target, address: target?.start }, work,
      safe: [...reachable].every((item) => liveNames.has(item)),
      complete: program.objects.every((item) => reachable.has(item.name) || !liveNames.has(item.name)), ...extra };
  };
  const rcLayout = program.objects.filter((item) => !freed.has(item.name)).map(({ name, address, size }) => ({ name, address, size }));
  const collectors: Collector[] = [
    summarize(T('标记-清除'), marked.map(({ name, address, size }) => ({ name, address, size })), program.capacity,
      T('标记 {#0} 个对象，清除时扫描全部 {#1} 个', marked.length, program.objects.length)),
    summarize(T('标记-整理'), compact.map((item) => ({ name: item.object, address: item.to, size: byName.get(item.object)!.size })), program.capacity,
      T('标记 {#0} 个对象，移动 {#1} 个', marked.length, compact.filter((item) => item.from !== item.to).length)),
    summarize(T('停止-拷贝'), [...copied].map(([name, address]) => ({ name, address, size: byName.get(name)!.size })), half,
      T('拷贝 {#0} 个对象，只触碰存活对象', copied.size), copyFits ? {} : { note: T('初始对象 {#0} 格超过半个堆 {#1} 格，实际无法使用。', initialTotal, half) }),
    summarize(T('只用引用计数'), rcLayout, program.capacity, T('计数更新 {#0} 次，边运行边回收', rc.filter((item) => item.kind === 'inc' || item.kind === 'dec' || item.kind === 'op').length),
      { note: cycleGarbage.length ? T('{#0} 构成或挂在循环上，计数不为 0，泄漏。', cycleGarbage.join(T('、'))) : undefined }),
    summarize(T('引用计数 + 循环检测'), rcLayout.filter((item) => !cycleGarbage.includes(item.name)), program.capacity,
      T('定期检测：扫描 {#0} 个未回收对象', tracked.length)),
  ];
  push({ phase: 'complete', message: T('完成：可达对象 {#0} 个，垃圾 {#1} 个。比较各算法回收了谁、剩余空间是否连续，以及申请 {#2} 格能否成功。', reachable.size, garbage.length, program.request) });
  return { ok: true, analysis: { program, finalRoots: roots, finalRefs: refs, reachable: [...reachable], rc, rcFreed: [...freed], cycle, cycleGarbage,
    mark, sweep, compact, copy, copyFits, collectors, frames, traceTruncated } };
}
