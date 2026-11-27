import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LOCALE, T, localePath, setLocale, splitLocale } from '.';
import { Tx } from './jsx';
import { TRANSLATED, checkCatalog, extractMessages, readCatalog } from './extract';

const root = path.resolve(import.meta.dirname, '../..');

describe('locale URLs', () => {
  it('splits and formats paths for zh, en and de', () => {
    expect(splitLocale('/')).toEqual({ locale: 'zh', path: '/' });
    expect(splitLocale('/en')).toEqual({ locale: 'en', path: '/' });
    expect(splitLocale('/en/')).toEqual({ locale: 'en', path: '/' });
    expect(splitLocale('/de/')).toEqual({ locale: 'de', path: '/' });
    expect(splitLocale('/en/lab')).toEqual({ locale: 'en', path: '/lab' });

    expect(localePath('/', 'zh')).toBe('/');
    expect(localePath('/', 'en')).toBe('/en/');
    expect(localePath('/', 'de')).toBe('/de/');
    expect(localePath('/lab', 'en')).toBe('/en/lab');
  });
});

describe('T and Tx', () => {
  afterEach(() => setLocale('zh'));

  it('replaces placeholders and allows reordering in translations', () => {
    expect(T('第 {#0} 行 · 偏移 {#1}', 3, 12)).toBe('第 3 行 · 偏移 12');
    setLocale('en', { '第 {#0} 行 · 偏移 {#1}': 'Offset {#1}, line {#0}' });
    expect(LOCALE).toBe('en');
    expect(T('第 {#0} 行 · 偏移 {#1}', 3, 12)).toBe('Offset 12, line 3');
  });

  it('translates JSX fragments via Tx', () => {
    setLocale('de', { '点击 {#0} 运行': 'Drücke {#0} zum Starten' });
    const result = Tx('点击 {#0} 运行', 'Enter');
    expect(Array.isArray(result)).toBe(true);
    expect((result as unknown[]).length).toBe(3);
  });
});

describe('translation catalogs', () => {
  it('every T() and Tx() message has valid English and German translations', () => {
    const { messages, problems } = extractMessages(root);
    expect(problems).toEqual([]);
    expect(messages.length).toBeGreaterThan(0);
    const catalogs = Object.fromEntries(
      TRANSLATED.map((locale) => [locale, readCatalog(root, locale)]),
    );
    for (const locale of TRANSLATED) {
      expect(checkCatalog(locale, messages, catalogs[locale])).toEqual([]);
    }
    const edgeMismatches: string[] = [];
    for (const key of Object.keys(catalogs.en)) {
      const en = catalogs.en[key];
      const de = catalogs.de[key];
      if (de === undefined) continue;
      if (/^\s/.test(en) !== /^\s/.test(de) || /\s$/.test(en) !== /\s$/.test(de)) {
        edgeMismatches.push(`${key}: en=${JSON.stringify(en)} de=${JSON.stringify(de)}`);
      }
    }
    expect(edgeMismatches).toEqual([]);
  });
});
