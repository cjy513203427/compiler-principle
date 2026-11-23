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
  if (text.length > GC_LIMITS.text) return fail(`输入最多 ${GC_LIMITS.text} 字符。`);
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
    if (line === '%%') { if (separator) return fail('只能有一个 %% 分隔行。', at, end); separator = true; continue; }
    if (separator) {
      let match: RegExpMatchArray | null;
      if ((match = line.match(/^(drop|root)\s+(\S+)$/))) ops.push({ kind: match[1] as 'drop' | 'root', target: match[2], text: line, at });
      else if ((match = line.match(/^(link|cut)\s+(\S+)\s*->\s*(\S+)$/))) ops.push({ kind: match[1] as 'link' | 'cut', from: match[2], target: match[3], text: line, at });
      else return fail('%% 下方每行一个操作：drop x、root x、link x -> y、cut x -> y。', at, end);
      if (ops.length > GC_LIMITS.ops) return fail(`最多 ${GC_LIMITS.ops} 个操作。`, at, end);
      continue;
    }
    let match: RegExpMatchArray | null;
    if ((match = line.match(/^heap\s+(\d+)$/))) {
      capacity = Number(match[1]);
      if (capacity < 2 || capacity > GC_LIMITS.heap) return fail(`堆容量需要在 2–${GC_LIMITS.heap} 格之间。`, at, end);
    } else if ((match = line.match(/^request\s+(\d+)$/))) {
      request = Number(match[1]);
      if (request < 1 || request > GC_LIMITS.heap) return fail(`申请大小需要在 1–${GC_LIMITS.heap} 格之间。`, at, end);
    } else if ((match = line.match(/^root\s+(.+)$/))) {
      for (const name of match[1].split(',').map((item) => item.trim()).filter(Boolean)) roots.push({ name, at });
    } else if ((match = line.match(/^(\S+)\s+(\d+)(?:\s*->\s*(.*))?$/))) {
      const [, name, size, list] = match;
      if (!NAME.test(name) || ['heap', 'request', 'root'].includes(name)) return fail(`对象名 ${name} 无效：字母或下划线开头，最多 12 个字符。`, at, end);
      if (objects.some((item) => item.name === name)) return fail(`对象 ${name} 重复定义。`, at, end);
      const sizeValue = Number(size);
      if (sizeValue < 1 || sizeValue > GC_LIMITS.size) return fail(`对象大小需要在 1–${GC_LIMITS.size} 格之间。`, at, end);
      const refs = (list ?? '').split(',').map((item) => item.trim()).filter(Boolean);
      if (refs.length > GC_LIMITS.refs) return fail(`每个对象最多 ${GC_LIMITS.refs} 个引用。`, at, end);
      if (new Set(refs).size !== refs.length) return fail(`${name} 对同一个对象只写一次引用。`, at, end);
      refs.forEach((ref) => pending.push({ name: ref, at }));
      objects.push({ name, size: sizeValue, address: 0, refs });
      if (objects.length > GC_LIMITS.objects) return fail(`最多 ${GC_LIMITS.objects} 个对象。`, at, end);
    } else return fail('每行写 heap N、request N、root a, b 或“名字 大小 -> 引用, …”。', at, end);
  }
  if (!objects.length) return fail('至少需要一个对象。');
  const known = new Set(objects.map((item) => item.name));
  for (const item of [...pending, ...roots]) if (!known.has(item.name)) return fail(`没有名为 ${item.name} 的对象。`, item.at, item.at + 1);
  if (new Set(roots.map((item) => item.name)).size !== roots.length) return fail('同一个根只写一次。');
  for (const op of ops) for (const name of 'from' in op ? [op.from, op.target] : [op.target])
    if (!known.has(name)) return fail(`操作里没有名为 ${name} 的对象。`, op.at, op.at + op.text.length);
  let address = 0;
  for (const item of objects) { item.address = address; address += item.size; }
  const total = address;
  capacity ??= Math.max(total + 4, 8);
  if (total > capacity) return fail(`对象共占 ${total} 格，超过堆容量 ${capacity} 格。`);
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
  name: '标记-清除' | '标记-整理' | '停止-拷贝' | '引用计数 + 循环检测' | '只用引用计数';
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
  push({ phase: 'setup', message: `${program.objects.length} 个对象按声明顺序紧挨着放进 ${program.capacity} 格的堆，根是 ${program.roots.join('、') || '（没有根）'}。从根出发沿引用能走到的对象才有用，其余都是垃圾。` });

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
    record('free', `${initially ? `${name} 一开始就没有任何引用（计数 0）` : `${name} 的计数变为 0`}，立即回收；它引用的对象各减 1。`, name);
    for (const ref of refs[name]) decrement(ref, name);
  };
  const decrement = (name: string, by: string) => {
    counts[name]--;
    record('dec', `${by} 不再引用 ${name}：计数 ${counts[name] + 1} → ${counts[name]}。`, name);
    if (counts[name] === 0) release(name, false);
  };
  record('op', `引用计数：每个对象记下有多少个根或对象指向它。初始计数：${program.objects.map((item) => `${item.name}=${counts[item.name]}`).join('，')}。`);
  for (const item of program.objects) if (counts[item.name] === 0 && !freed.has(item.name)) release(item.name, true);
  for (const op of program.ops) {
    const live = reachableFrom(roots, refs);
    if (op.kind === 'drop') {
      if (!roots.includes(op.target)) return fail(`${op.target} 当前不是根，不能 drop。`, op);
      roots.splice(roots.indexOf(op.target), 1);
      record('op', `执行 ${op.text}：根不再指向 ${op.target}。`);
      decrement(op.target, '根');
    } else if (op.kind === 'root') {
      if (!live.has(op.target)) return fail(`${op.target} 已经不可达，程序拿不到指向它的引用。`, op);
      if (roots.includes(op.target)) return fail(`${op.target} 已经是根。`, op);
      roots.push(op.target);
      counts[op.target]++;
      record('op', `执行 ${op.text}：新的根指向 ${op.target}，计数加 1 变为 ${counts[op.target]}。`, op.target);
    } else if (op.kind === 'link') {
      if (!live.has(op.from) || !live.has(op.target)) return fail('只能连接当前可达的对象：程序拿不到不可达对象的引用。', op);
      if (refs[op.from].includes(op.target)) return fail(`${op.from} 已经引用 ${op.target}。`, op);
      if (refs[op.from].length >= GC_LIMITS.refs) return fail(`每个对象最多 ${GC_LIMITS.refs} 个引用。`, op);
      refs[op.from].push(op.target);
      counts[op.target]++;
      record('op', `执行 ${op.text}：${op.target} 的计数加 1 变为 ${counts[op.target]}。`, op.target);
    } else {
      if (!live.has(op.from)) return fail(`${op.from} 已经不可达，程序无法修改它。`, op);
      if (!refs[op.from].includes(op.target)) return fail(`${op.from} 没有引用 ${op.target}。`, op);
      refs[op.from].splice(refs[op.from].indexOf(op.target), 1);
      record('op', `执行 ${op.text}。`);
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
  note('start', `循环检测（Python gc 的思路）：剩下 ${tracked.length} 个未回收对象，先令 gc_ref = 引用计数。`);
  for (const name of tracked) for (const ref of refs[name]) if (ref in gcRef) {
    gcRef[ref]--;
    note('subtract', `假装去掉 ${name} → ${ref} 这条对象之间的引用：${ref} 的 gc_ref 减为 ${gcRef[ref]}。`, ref);
  }
  const seeds = tracked.filter((name) => gcRef[name] > 0);
  note('seed', seeds.length ? `gc_ref 仍大于 0 的 ${seeds.join('、')} 一定被对象之外的根引用，不是垃圾。` : '所有 gc_ref 都是 0：没有对象被根引用。');
  const queue = [...seeds];
  while (queue.length) {
    const name = queue.shift()!;
    if (rescued.includes(name)) continue;
    rescued.push(name);
    note('rescue', `${name} 可从根到达，保留；继续检查它引用的对象。`, name);
    queue.push(...refs[name].filter((ref) => ref in gcRef && !rescued.includes(ref)));
  }
  const cycleGarbage = tracked.filter((name) => !rescued.includes(name));
  note('garbage', cycleGarbage.length ? `剩下的 ${cycleGarbage.join('、')} 计数都不为 0，却不可达：这是只靠引用计数回收不了的循环垃圾。` : '没有发现循环垃圾。');

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
  push({ phase: 'mark', message: '标记阶段：所有对象先是白色。根直接引用的对象变灰色，放进待处理区。' });
  mark.forEach((event, index) => push({ phase: 'mark', event: index, message: event.kind === 'gray'
    ? `${event.from ? `${event.from} 引用` : '根引用'} ${event.object}：白 → 灰，放进待处理区。`
    : `${event.object} 的引用都看过了：灰 → 黑。` }));
  const marked = program.objects.filter((item) => color.get(item.name) === 'black');
  const garbage = program.objects.filter((item) => color.get(item.name) !== 'black');

  const sweep = program.objects.map((item) => ({ object: item.name, kept: color.get(item.name) === 'black' }));
  sweep.forEach((item, index) => push({ phase: 'sweep', event: index, message: item.kept
    ? `清除阶段按地址扫描：${item.object} 是黑色，保留在原地址 ${byName.get(item.object)!.address}。`
    : `清除阶段：${item.object} 仍是白色，把它的 ${byName.get(item.object)!.size} 格还给空闲表。` }));

  let cursor = 0;
  const compact = marked.map((item) => { const move = { object: item.name, from: item.address, to: cursor }; cursor += item.size; return move; });
  compact.forEach((item, index) => push({ phase: 'compact', event: index, message: item.from === item.to
    ? `整理：${item.object} 已在地址 ${item.to}，不用移动。`
    : `整理：把 ${item.object} 从地址 ${item.from} 滑到 ${item.to}，指向它的引用一起改成新地址。` }));

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
  if (!copyFits) push({ phase: 'copy', message: `停止-拷贝把 ${program.capacity} 格分成两半，每半 ${half} 格；初始对象共 ${initialTotal} 格，旧空间一开始就放不下。下面的拷贝过程仅作演示。` });
  copy.forEach((item, index) => push({ phase: 'copy', event: index, message: item.kind === 'copy'
    ? `${item.from ? `扫描 ${item.from} 时发现` : '根引用'} ${item.object}：拷到新空间地址 ${item.to}，旧位置留下转发地址。`
    : `扫描指针来到 ${item.object}：检查它的引用，没拷过的对象接着拷到新空间末尾。` }));

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
    summarize('标记-清除', marked.map(({ name, address, size }) => ({ name, address, size })), program.capacity,
      `标记 ${marked.length} 个对象，清除时扫描全部 ${program.objects.length} 个`),
    summarize('标记-整理', compact.map((item) => ({ name: item.object, address: item.to, size: byName.get(item.object)!.size })), program.capacity,
      `标记 ${marked.length} 个对象，移动 ${compact.filter((item) => item.from !== item.to).length} 个`),
    summarize('停止-拷贝', [...copied].map(([name, address]) => ({ name, address, size: byName.get(name)!.size })), half,
      `拷贝 ${copied.size} 个对象，只触碰存活对象`, copyFits ? {} : { note: `初始对象 ${initialTotal} 格超过半个堆 ${half} 格，实际无法使用。` }),
    summarize('只用引用计数', rcLayout, program.capacity, `计数更新 ${rc.filter((item) => item.kind === 'inc' || item.kind === 'dec' || item.kind === 'op').length} 次，边运行边回收`,
      { note: cycleGarbage.length ? `${cycleGarbage.join('、')} 构成或挂在循环上，计数不为 0，泄漏。` : undefined }),
    summarize('引用计数 + 循环检测', rcLayout.filter((item) => !cycleGarbage.includes(item.name)), program.capacity,
      `定期检测：扫描 ${tracked.length} 个未回收对象`),
  ];
  push({ phase: 'complete', message: `完成：可达对象 ${reachable.size} 个，垃圾 ${garbage.length} 个。比较各算法回收了谁、剩余空间是否连续，以及申请 ${program.request} 格能否成功。` });
  return { ok: true, analysis: { program, finalRoots: roots, finalRefs: refs, reachable: [...reachable], rc, rcFreed: [...freed], cycle, cycleGarbage,
    mark, sweep, compact, copy, copyFits, collectors, frames, traceTruncated } };
}
