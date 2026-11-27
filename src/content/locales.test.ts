/**
 * Page and compiler modules translate when they are imported, so each language reloads them after
 * switching the locale. These tests run every preset in English and German, check that the results
 * match the Chinese run (translated presets differ only in comments), and scan every exported text
 * and every analysis result for leftover Chinese or missing-translation warnings.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const CJK = /[　-〿一-鿿＀-￯]/;
/** The Chinese book's URLs and chapter file names stay Chinese in every language. */
const SOURCE_KEY = /^(https?:\/\/|\d\d [^/]*\.md$)/;
/** Source positions shift when a preset's translated comment changes length. */
const POSITION_KEY = /^(start|end|pos|position|offset|inputOffset|line|column|cursor|location)$/i;

/** Every string reachable from a value, with its path; functions are skipped. */
function strings(value: unknown, path = '', seen = new Set<unknown>()): [string, string][] {
  if (typeof value === 'string') return [[path, value]];
  if (!value || typeof value !== 'object' || seen.has(value)) return [];
  seen.add(value);
  return Object.entries(value).flatMap(([key, child]) =>
    typeof child === 'function' ? [] : strings(child, `${path}.${key}`, seen),
  );
}
const chinese = (pairs: [string, string][]) =>
  pairs.filter(([, text]) => CJK.test(text) && !SOURCE_KEY.test(text)).map(([p, t]) => `${p}: ${t}`);

/** Numbers and booleans of a result in walk order: everything a translation must not change. */
function fingerprint(value: unknown, skipPositions: boolean, seen = new Set<unknown>()): unknown[] {
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint')
    return [String(value)];
  if (!value || typeof value !== 'object' || seen.has(value)) return [];
  seen.add(value);
  if (Array.isArray(value)) return [value.length, ...value.flatMap((v) => fingerprint(v, skipPositions, seen))];
  return Object.entries(value).flatMap(([key, child]) =>
    typeof child === 'function' || (skipPositions && POSITION_KEY.test(key))
      ? []
      : [key, ...fingerprint(child, skipPositions, seen)],
  );
}

interface Preset {
  id: string;
  code: string;
}
type Runner = (code: string) => unknown;

/** Every preset list with the analysis the page runs on it. */
async function labs() {
  const compiler = await import('../compiler');
  const { defaultRegisterSettings } = await import('../compiler/regalloc');
  const { defaultCodegenSettings } = await import('../compiler/codegen');
  const program: Runner = (code) =>
    compiler.compile(code, { fold: true, propagate: true, dead: true }, {
      outOfSSA: true,
      ssaOpt: true,
      redundancy: true,
      schedule: true,
      registers: defaultRegisterSettings,
      codegen: defaultCodegenSettings,
    });
  const own = {
    automata: (await import('../compiler/automata')).analyzeAutomata,
    grammar: (await import('../compiler/grammar')).analyzeGrammar,
    lr: (await import('../compiler/lr')).analyzeLr,
    minimize: (await import('../compiler/minimize')).analyzeMinimization,
    functions: (await import('../compiler/functions')).analyzeFunctions,
    interproc: (await import('../compiler/interproc')).analyzeInterproc,
    gc: (await import('../compiler/gc')).analyzeGc,
    copies: (await import('../compiler/outssa')).analyzeCopyExperiment,
  };
  const lessons = await import('./lessons');
  const lists: [string, Preset[], Runner][] = [
    ['lessons', lessons.presets, program],
    ['flow', lessons.flowPresets, program],
    ['dataflow', lessons.dataflowPresets, program],
    ['dominance', (await import('./dominance')).dominancePresets, program],
    ['ssa', (await import('./ssa')).ssaPresets, program],
    ['outssa', (await import('./outssa')).outSsaPresets, program],
    ['regalloc', (await import('./regalloc')).regallocPresets, program],
    ['schedule', (await import('./schedule')).schedulePresets, program],
    ['redundancy', (await import('./redundancy')).redundancyPresets, program],
    ['ssaopt', (await import('./ssaopt')).ssaOptPresets, program],
    ['codegen', (await import('./codegen')).codegenPresets, program],
    ['automata', (await import('./automata')).automataPresets, own.automata],
    ['minimize', (await import('./minimize')).minimizationPresets, own.minimize],
    ['grammar', (await import('./grammar')).grammarPresets, own.grammar],
    ['lr', (await import('./lr')).lrPresets, own.lr],
    ['functions', (await import('./functions')).functionPresets, own.functions],
    ['interproc', (await import('./interproc')).interprocPresets, own.interproc],
    ['gc', (await import('./gc')).gcPresets, own.gc],
    ['copies', (await import('./outssa')).copyPresets, own.copies],
  ];
  return lists;
}

/** Content modules whose exports are rendered as page text. */
const CONTENT = {
  lessons: () => import('./lessons'),
  learning: () => import('./learning'),
  assembly: () => import('./assembly'),
  assemblyReading: () => import('./assembly-reading'),
  automata: () => import('./automata'),
  codegen: () => import('./codegen'),
  dominance: () => import('./dominance'),
  functions: () => import('./functions'),
  gc: () => import('./gc'),
  grammar: () => import('./grammar'),
  interproc: () => import('./interproc'),
  lr: () => import('./lr'),
  minimize: () => import('./minimize'),
  outssa: () => import('./outssa'),
  redundancy: () => import('./redundancy'),
  regalloc: () => import('./regalloc'),
  schedule: () => import('./schedule'),
  ssa: () => import('./ssa'),
  ssaopt: () => import('./ssaopt'),
};

async function useLocale(locale: 'zh' | 'en' | 'de') {
  vi.resetModules();
  const i18n = await import('../i18n');
  const catalog = locale === 'zh' ? {} : (await import(`../i18n/catalog/${locale}.json`)).default;
  i18n.setLocale(locale, catalog);
}

/** Chinese results, keyed by lab and preset, computed once. */
let reference: Map<string, { code: string; ok: unknown; full: unknown[]; reduced: unknown[] }>;

const okOf = (result: unknown) =>
  result && typeof result === 'object'
    ? 'ok' in result
      ? (result as { ok: unknown }).ok
      : 'diagnostic' in result
        ? !(result as { diagnostic?: unknown }).diagnostic
        : undefined
    : undefined;

describe('presets in every language', () => {
  let warnings: unknown[][] = [];
  beforeEach(() => {
    warnings = [];
    vi.spyOn(console, 'warn').mockImplementation((...args) => void warnings.push(args));
  });
  afterEach(() => vi.restoreAllMocks());

  it('zh reference runs', { timeout: 60_000 }, async () => {
    await useLocale('zh');
    reference = new Map();
    for (const [lab, presets, run] of await labs())
      for (const preset of presets) {
        const result = run(preset.code);
        reference.set(`${lab}/${preset.id}`, {
          code: preset.code,
          ok: okOf(result),
          full: fingerprint(result, false),
          reduced: fingerprint(result, true),
        });
      }
    expect(reference.size).toBeGreaterThan(100);
  });

  for (const locale of ['en', 'de'] as const)
    it(`${locale}: every preset gives the Chinese results, in ${locale} only`, { timeout: 60_000 }, async () => {
      await useLocale(locale);
      const leftovers: string[] = [];
      const differences: string[] = [];
      for (const [lab, presets, run] of await labs())
        for (const preset of presets) {
          const key = `${lab}/${preset.id}`;
          const zh = reference.get(key);
          expect(zh, key).toBeDefined();
          const result = run(preset.code);
          leftovers.push(...chinese(strings(result, key)));
          const sameCode = zh!.code === preset.code;
          if (okOf(result) !== zh!.ok) differences.push(`${key}: ok ${okOf(result)} vs ${zh!.ok}`);
          else if (sameCode ? fingerprint(result, false).join() !== zh!.full.join()
            : fingerprint(result, true).join() !== zh!.reduced.join())
            differences.push(`${key}: results differ${sameCode ? '' : ' (translated comments)'}`);
          // A translated preset may only change comments; its code lines must stay ASCII.
          if (!sameCode) expect(CJK.test(preset.code), key).toBe(false);
        }
      expect(differences).toEqual([]);
      expect(leftovers.slice(0, 20)).toEqual([]);
      expect(warnings.filter((w) => String(w[0]).includes('[i18n]'))).toEqual([]);
    });

  for (const locale of ['en', 'de'] as const)
    it(`${locale}: content modules export no Chinese`, { timeout: 60_000 }, async () => {
      await useLocale(locale);
      const leftovers: string[] = [];
      for (const [name, load] of Object.entries(CONTENT)) leftovers.push(...chinese(strings(await load(), name)));
      expect(leftovers).toEqual([]);
      expect(warnings.filter((w) => String(w[0]).includes('[i18n]'))).toEqual([]);
    });
});
