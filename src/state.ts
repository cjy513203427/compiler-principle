import { lessons, presets, flowPresets, dataflowPresets, defaultOptions } from './content/lessons';
import type { Stage, OptimizationOptions } from './compiler/model';
import { assemblyTopics } from './content/assembly';
import type { AssemblyNoteId } from './compiler/assembly/model';
import { dominancePresets } from './content/dominance';
import { automataPresets } from './content/automata';
import { grammarPresets } from './content/grammar';
import { lrPresets } from './content/lr';
import { ssaPresets } from './content/ssa';
import { minimizationPresets } from './content/minimize';
import { outSsaPresets } from './content/outssa';
import { functionPresets } from './content/functions';
import { regallocPresets } from './content/regalloc';
import { schedulePresets } from './content/schedule';
import { normalizeRegisterSettings, type RegisterSettings } from './compiler/regalloc';

export type Route = Stage | 'home' | 'notes' | 'sources' | 'assembly';
export type NoteId = Stage | AssemblyNoteId;
export const MAX_SOURCE = 2000;
export function readUrl(search: string) {
  const params = new URLSearchParams(search);
  const requested = params.get('lab');
  const route: Route = [
    ...lessons.map((l) => l.id),
    'home',
    'notes',
    'sources',
    'assembly',
  ].includes(requested || '')
    ? (requested as Route)
    : 'home';
  const raw = params.get('code');
  const source =
    raw !== null && raw.length <= MAX_SOURCE
      ? raw
      : route === 'functions'
        ? functionPresets[0].code
        : route === 'regalloc'
        ? regallocPresets[0].code
        : route === 'schedule'
        ? schedulePresets[0].code
        : route === 'cfg'
        ? flowPresets[0].code
        : route === 'dataflow'
          ? dataflowPresets[0].code
          : route === 'outssa'
            ? outSsaPresets[0].code
            : route === 'ssa'
              ? ssaPresets[0].code
              : route === 'dominance'
                ? dominancePresets[0].code
                : route === 'minimize'
                  ? minimizationPresets[0].code
                  : route === 'automata'
                    ? automataPresets[0].code
                    : route === 'grammar'
                      ? grammarPresets[0].code
                      : route === 'lr'
                        ? lrPresets[0].code
                        : presets[0].code;
  const step = Math.max(0, Math.min(10000, Math.floor(Number(params.get('step')) || 0)));
  const flags = params.get('opt');
  const options: OptimizationOptions =
    flags && /^[01]{3}$/.test(flags)
      ? { fold: flags[0] === '1', propagate: flags[1] === '1', dead: flags[2] === '1' }
      : route === 'vm'
        ? { fold: false, propagate: false, dead: false }
        : defaultOptions;
  const registers = normalizeRegisterSettings(params.get('regs') ?? undefined, params.get('alloc'));
  return { route, source, step, options, registers };
}
export function shareUrl(
  base: string,
  route: Route,
  source: string,
  step: number,
  options: OptimizationOptions,
  registers?: RegisterSettings,
) {
  const url = new URL(base);
  url.search = '';
  url.hash = '';
  url.searchParams.set('lab', route);
  url.searchParams.set('code', source);
  url.searchParams.set('step', String(step));
  url.searchParams.set('opt', `${+options.fold}${+options.propagate}${+options.dead}`);
  if ((route === 'regalloc' || route === 'schedule') && registers) {
    url.searchParams.set('regs', String(registers.count));
    url.searchParams.set('alloc', registers.algorithm);
  }
  return url.href;
}
export interface Notebook {
  version: 1;
  notes: Partial<Record<NoteId, string>>;
  completed: NoteId[];
}
export const emptyNotebook = (): Notebook => ({ version: 1, notes: {}, completed: [] });
export function validateNotebook(value: unknown): Notebook {
  if (!value || typeof value !== 'object') throw new Error('笔记文件格式不正确。');
  const data = value as Partial<Notebook>;
  if (
    data.version !== 1 ||
    !data.notes ||
    typeof data.notes !== 'object' ||
    Array.isArray(data.notes) ||
    !Array.isArray(data.completed)
  )
    throw new Error('笔记版本或内容不正确。');
  const notes: Notebook['notes'] = {};
  const ids: NoteId[] = [...lessons.map((l) => l.id), ...assemblyTopics.map((l) => l.noteId)];
  for (const id of ids) {
    const text = data.notes[id];
    if (text !== undefined && (typeof text !== 'string' || text.length > 20000))
      throw new Error('单篇笔记需要是 20,000 字以内的文本。');
    if (text !== undefined) notes[id] = text;
  }
  return {
    version: 1,
    notes,
    completed: [...new Set(data.completed.filter((id) => ids.includes(id)))],
  };
}
export const STORAGE_KEY = 'compiler-notebook-v1';
