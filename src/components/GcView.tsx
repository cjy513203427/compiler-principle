import type { GcAnalysis, Collector } from '../compiler/gc';
import { T } from '../i18n';
import { Tx } from '../i18n/jsx';
import '../styles-gc.css';

interface NodeState { label: string; tone: string }
interface Block { name: string; address: number; size: number; tone: string }

function GraphFigure({ names, refs, roots, states, focus }: {
  names: string[]; refs: Record<string, string[]>; roots: string[]; states: Record<string, NodeState>; focus?: string;
}) {
  const size = 360, center = size / 2, radius = names.length <= 1 ? 0 : 140;
  const position = new Map(names.map((name, index) => {
    const angle = (index / names.length) * Math.PI * 2 - Math.PI / 2;
    return [name, { x: center + radius * Math.cos(angle), y: center + radius * Math.sin(angle) }];
  }));
  const edges = names.flatMap((from) => (refs[from] ?? []).map((to) => ({ from, to })));
  return (
    <div className="gc-graph-scroll" tabIndex={0} aria-label={T('对象引用图，可在图内滚动')}>
      <svg viewBox={`0 0 ${size} ${size}`} role="img" aria-label={T('对象引用图：{#0} 个对象，{#1} 条引用，根 {#2}', names.length, edges.length, roots.join(T('、')) || T('无'))}>
        <defs>
          <marker id="gc-arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" className="gc-arrow" />
          </marker>
        </defs>
        {edges.map(({ from, to }) => {
          const a = position.get(from)!, b = position.get(to)!;
          if (from === to) return <circle key={`${from}>${to}`} cx={a.x} cy={a.y - 30} r={10} className="gc-edge" fill="none" />;
          const dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy) || 1;
          return <line key={`${from}>${to}`} x1={a.x + (dx / length) * 24} y1={a.y + (dy / length) * 24}
            x2={b.x - (dx / length) * 26} y2={b.y - (dy / length) * 26} className="gc-edge" markerEnd="url(#gc-arrow)" />;
        })}
        {names.map((name) => {
          const { x, y } = position.get(name)!;
          const state = states[name] ?? { label: '', tone: 'plain' };
          return (
            <g key={name} className={`gc-node tone-${state.tone} ${roots.includes(name) ? 'root' : ''} ${focus === name ? 'focus' : ''}`}>
              <circle cx={x} cy={y} r={24} />
              {roots.includes(name) && <circle cx={x} cy={y} r={28} className="root-ring" />}
              <text x={x} y={y - 3} textAnchor="middle">{name}</text>
              <text x={x} y={y + 11} textAnchor="middle" className="node-state">{state.label}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

const ROW = 16;
function HeapBar({ capacity, blocks, label }: { capacity: number; blocks: Block[]; label: string }) {
  const owner: (Block | undefined)[] = Array(capacity).fill(undefined);
  blocks.forEach((block) => { for (let cell = block.address; cell < block.address + block.size && cell < capacity; cell++) owner[cell] = block; });
  // One segment per object or free run, split where a row wraps.
  const segments: { start: number; size: number; block?: Block; first: boolean }[] = [];
  for (let cell = 0; cell < capacity; cell++) {
    const last = segments.at(-1);
    if (last && last.block === owner[cell] && cell % ROW !== 0) last.size++;
    else segments.push({ start: cell, size: 1, block: owner[cell], first: !owner[cell] || owner[cell]!.address === cell });
  }
  return (
    <figure className="gc-heap" aria-label={label}>
      <figcaption>{label}</figcaption>
      <div className="gc-cells" style={{ gridTemplateColumns: `repeat(${Math.min(ROW, capacity)}, minmax(0, 1fr))` }}>
        {segments.map((segment) => (
          <div key={segment.start} style={{ gridColumn: `span ${segment.size}` }}
            className={`gc-cell ${segment.block ? `tone-${segment.block.tone}` : 'empty'} ${segment.block && segment.first ? 'start' : ''}`}
            title={segment.block ? T('{#0}：地址 {#1}，{#2} 格', segment.block.name, segment.block.address, segment.block.size) : T('空闲：地址 {#0} 起 {#1} 格', segment.start, segment.size)}>
            {segment.block ? (segment.first ? segment.block.name : '…') : `${segment.start}`}
          </div>
        ))}
      </div>
    </figure>
  );
}

function CollectorRow({ collector }: { collector: Collector }) {
  return (
    <tr>
      <td>{collector.name}</td>
      <td>{collector.reclaimed.join(T('、')) || T('无')}</td>
      <td>{collector.totalFree} / {collector.space}</td>
      <td>{collector.largestFree}</td>
      <td>{collector.request.fits ? T('成功（地址 {#0}）', collector.request.address) : T('失败')}</td>
      <td>{collector.safe ? (collector.complete ? T('回收全部垃圾') : T('安全，但有垃圾没回收')) : T('回收了可达对象')}</td>
      <td>{collector.note ? T('{#0}。{#1}', collector.work, collector.note) : collector.work}</td>
    </tr>
  );
}

export function GcView({ analysis, step }: { analysis: GcAnalysis; step: number }) {
  const frame = analysis.frames[step];
  const { program } = analysis;
  const names = program.objects.map((item) => item.name);
  const byName = new Map(program.objects.map((item) => [item.name, item]));
  const initialRefs = Object.fromEntries(program.objects.map((item) => [item.name, item.refs]));
  let refs: Record<string, string[]> = analysis.finalRefs, roots = analysis.finalRoots, focus: string | undefined;
  const states: Record<string, NodeState> = {};
  let heap: { capacity: number; blocks: Block[]; label: string } = {
    capacity: program.capacity, label: T('堆：{#0} 格', program.capacity),
    blocks: program.objects.map((item) => ({ name: item.name, address: item.address, size: item.size, tone: 'plain' })),
  };
  let worklist: string[] = [];
  if (frame.phase === 'setup') { refs = initialRefs; roots = program.roots; }
  else if (frame.phase === 'rc' && frame.event !== undefined) {
    const event = analysis.rc[frame.event];
    refs = event.refs; roots = event.roots; focus = event.object;
    names.forEach((name) => { states[name] = event.freed.includes(name) ? { label: T('已回收'), tone: 'freed' } : { label: T('计数 {#0}', event.counts[name]), tone: 'plain' }; });
    heap.blocks = heap.blocks.map((block) => ({ ...block, tone: event.freed.includes(block.name) ? 'freed' : 'plain' }));
  } else if (frame.phase === 'cycle' && frame.event !== undefined) {
    const event = analysis.cycle[frame.event];
    focus = event.object;
    const done = event.kind === 'garbage';
    names.forEach((name) => {
      states[name] = analysis.rcFreed.includes(name) ? { label: T('已回收'), tone: 'freed' }
        : event.rescued.includes(name) ? { label: T('保留'), tone: 'black' }
          : done ? { label: T('循环垃圾'), tone: 'garbage' } : { label: `gc_ref ${event.gcRef[name]}`, tone: 'plain' };
    });
    heap.blocks = heap.blocks.map((block) => ({ ...block, tone: states[block.name].tone }));
  } else if (frame.phase === 'mark' || frame.phase === 'sweep' || frame.phase === 'compact' || frame.phase === 'copy' || frame.phase === 'complete') {
    const upTo = frame.phase === 'mark' ? (frame.event ?? -1) : analysis.mark.length - 1;
    const colors = new Map(names.map((name) => [name, 'white']));
    analysis.mark.slice(0, upTo + 1).forEach((event) => {
      colors.set(event.object, event.kind);
      if (event.kind === 'gray') worklist.push(event.object); else worklist = worklist.filter((name) => name !== event.object);
    });
    if (frame.phase === 'mark') focus = analysis.mark[frame.event ?? -1]?.object;
    const text = { white: T('白'), gray: T('灰'), black: T('黑') } as Record<string, string>;
    names.forEach((name) => { states[name] = { label: text[colors.get(name)!], tone: colors.get(name)! }; });
    heap.blocks = heap.blocks.map((block) => ({ ...block, tone: colors.get(block.name)! }));
    if (frame.phase === 'sweep' && frame.event !== undefined) {
      const swept = analysis.sweep.slice(0, frame.event + 1);
      focus = swept.at(-1)?.object;
      heap = { ...heap, label: T('标记-清除：按地址扫描'), blocks: heap.blocks.filter((block) => !swept.some((item) => item.object === block.name && !item.kept)) };
    } else if (frame.phase === 'compact' && frame.event !== undefined) {
      const moved = analysis.compact.slice(0, frame.event + 1);
      focus = moved.at(-1)?.object;
      heap = { ...heap, label: T('标记-整理：存活对象滑到左端'), blocks: analysis.compact.map((item, index) => ({
        name: item.object, size: byName.get(item.object)!.size, address: index <= frame.event! ? item.to : item.from, tone: index <= frame.event! ? 'moved' : 'black' })) };
    } else if (frame.phase === 'copy' && frame.event !== undefined) {
      const events = analysis.copy.slice(0, frame.event + 1);
      focus = events.at(-1)?.object;
      const copied = events.filter((item) => item.kind === 'copy');
      const scanned = new Set(events.filter((item) => item.kind === 'scan').map((item) => item.object));
      names.forEach((name) => {
        const target = copied.find((item) => item.object === name);
        states[name] = target ? { label: T('新址 {#0}', target.to), tone: scanned.has(name) ? 'black' : 'gray' } : { label: T('旧空间'), tone: 'white' };
      });
      heap = { capacity: Math.floor(program.capacity / 2), label: T('停止-拷贝：新空间（半个堆，{#0} 格）', Math.floor(program.capacity / 2)),
        blocks: copied.map((item) => ({ name: item.object, address: item.to!, size: byName.get(item.object)!.size, tone: scanned.has(item.object) ? 'black' : 'gray' })) };
    }
  }
  const phaseName = { setup: T('堆与根'), rc: T('引用计数'), cycle: T('循环检测'), mark: T('三色标记'), sweep: T('清除'), compact: T('整理'), copy: T('停止-拷贝'), complete: T('对照') }[frame.phase];
  return (
    <div className="gc-view">
      <div className="gc-status" role="status">
        <strong>{phaseName}</strong>
        <span>{T('可达 {#0} 个 · 不可达 {#1} 个 · 申请 {#2} 格', analysis.reachable.length, program.objects.length - analysis.reachable.length, program.request)}</span>
      </div>
      <section className="gc-card" aria-label={T('本步垃圾收集')}>
        <h3>{T('观察这一步')}</h3>
        <p>{frame.message}</p>
        {frame.phase === 'mark' && <p>{Tx('待处理区（灰色）：{#0}', <code>{worklist.join(' → ') || T('空')}</code>)}</p>}
      </section>
      {frame.phase !== 'complete' && (
        <section className="gc-card" aria-label={T('对象图与堆')}>
          <div className="gc-layout">
            <GraphFigure names={names} refs={refs} roots={roots} states={states} focus={focus} />
            <HeapBar {...heap} />
          </div>
          <p className="figure-caption">{T('双圈是根直接引用的对象；节点第二行是这一阶段的状态（计数、gc_ref、颜色或新地址），颜色只是辅助。堆以格为单位，对象名写在它的起始格。')}</p>
        </section>
      )}
      {frame.phase === 'complete' && (
        <>
          <section className="gc-card" aria-label={T('各算法回收结果')}>
            <h3>{T('谁被回收，剩下的空间能用吗？')}</h3>
            <div className="table-scroll" tabIndex={0} aria-label={T('各算法对照，可横向滚动')}>
              <table className="gc-table">
                <thead><tr><th>{T('算法')}</th><th>{T('回收')}</th><th>{T('空闲 / 空间')}</th><th>{T('最大连续空闲')}</th><th>{T('申请 {#0} 格', program.request)}</th><th>{T('核对')}</th><th>{T('工作量')}</th></tr></thead>
                <tbody>{analysis.collectors.map((collector) => <CollectorRow key={collector.name} collector={collector} />)}</tbody>
              </table>
            </div>
            <p className="figure-caption">{T('“核对”用独立的可达性计算检查：没有回收任何可达对象，以及是否回收了全部不可达对象。停止-拷贝只算半个堆。')}</p>
          </section>
          <section className="gc-card" aria-label={T('回收后的堆')}>
            <h3>{T('回收后的堆')}</h3>
            {analysis.collectors.map((collector) => (
              <HeapBar key={collector.name} capacity={collector.space} label={T('{#0}：空闲 {#1} 格，最大连续 {#2} 格', collector.name, collector.totalFree, collector.largestFree)}
                blocks={collector.layout.map((item) => ({ ...item, tone: 'black' }))} />
            ))}
          </section>
        </>
      )}
      {analysis.traceTruncated && <p className="figure-caption">{T('回放记录前 400 步；对照页仍展示完整结果。')}</p>}
    </div>
  );
}
