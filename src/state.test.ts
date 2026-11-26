import { it, expect } from 'vitest';
import { readUrl, shareUrl, validateNotebook } from './state';
import { ssaPresets } from './content/ssa';
import { minimizationPresets } from './content/minimize';
import { outSsaPresets } from './content/outssa';
import { functionPresets } from './content/functions';
import { regallocPresets } from './content/regalloc';
import { schedulePresets } from './content/schedule';
import { redundancyPresets } from './content/redundancy';
import { gcPresets } from './content/gc';
import { ssaOptPresets } from './content/ssaopt';
import { codegenPresets } from './content/codegen';
import { interprocPresets } from './content/interproc';
import { defaultOptions } from './content/lessons';
it('restores SSA optimization lab with bounded inputs and local notes', () => {
  expect(readUrl('?lab=ssaopt').source).toBe(ssaOptPresets[0].code);
  const shared = shareUrl('http://localhost:5173', 'ssaopt', ssaOptPresets[2].code, 6, { fold: false, propagate: false, dead: false });
  expect(readUrl(new URL(shared).search)).toMatchObject({ route: 'ssaopt', source: ssaOptPresets[2].code, step: 6 });
  expect(new URL(shared).searchParams.get('regs')).toBeNull();
  expect(readUrl('?lab=ssaopt&code=' + 'a'.repeat(2001)).source).toBe(ssaOptPresets[0].code);
  expect(validateNotebook({ version: 1, notes: { ssa: '构造', ssaopt: '稀疏传播' }, completed: ['ssa', 'ssaopt'] }))
    .toEqual({ version: 1, notes: { ssa: '构造', ssaopt: '稀疏传播' }, completed: ['ssa', 'ssaopt'] });
});
it('restores the redundancy and garbage collection labs with bounded inputs and local notes', () => {
  expect(readUrl('?lab=cse').source).toBe(redundancyPresets[0].code);
  expect(readUrl('?lab=gc').source).toBe(gcPresets[0].code);
  const shared = shareUrl('http://localhost:5173', 'gc', gcPresets[2].code, 5, { fold: true, propagate: true, dead: true });
  expect(readUrl(new URL(shared).search)).toMatchObject({ route: 'gc', source: gcPresets[2].code, step: 5 });
  expect(new URL(shared).searchParams.get('regs')).toBeNull();
  expect(readUrl('?lab=gc&code=' + 'a'.repeat(2001)).source).toBe(gcPresets[0].code);
  expect(validateNotebook({ version: 1, notes: { cse: '可用', gc: '可达' }, completed: ['cse', 'gc'] }))
    .toEqual({ version: 1, notes: { cse: '可用', gc: '可达' }, completed: ['cse', 'gc'] });
});
it('restores scheduling inputs with the shared register settings', () => {
  expect(readUrl('?lab=schedule').source).toBe(schedulePresets[0].code);
  const shared = shareUrl('http://localhost:5173', 'schedule', schedulePresets[1].code, 3,
    { fold: true, propagate: true, dead: true }, { count: 2, algorithm: 'color' });
  expect(new URL(shared).searchParams.get('regs')).toBe('2');
  expect(readUrl(new URL(shared).search)).toMatchObject({ route: 'schedule', source: schedulePresets[1].code, step: 3,
    registers: { count: 2, algorithm: 'color' } });
  expect(validateNotebook({ version: 1, notes: { schedule: '伪依赖' }, completed: ['schedule'] }).completed).toEqual(['schedule']);
});
it('restores register allocation settings from bounded URLs and keeps notes local', () => {
  expect(readUrl('?lab=regalloc')).toMatchObject({ source: regallocPresets[0].code, registers: { count: 3, algorithm: 'color' } });
  const shared = shareUrl('http://localhost:5173', 'regalloc', regallocPresets[2].code, 7,
    { fold: true, propagate: true, dead: true }, { count: 2, algorithm: 'linear' });
  expect(readUrl(new URL(shared).search)).toMatchObject({ route: 'regalloc', source: regallocPresets[2].code, step: 7,
    registers: { count: 2, algorithm: 'linear' } });
  expect(readUrl('?lab=regalloc&regs=99&alloc=%3Cscript%3E').registers).toEqual({ count: 3, algorithm: 'color' });
  expect(readUrl('?lab=regalloc&code=' + 'a'.repeat(2001)).source).toBe(regallocPresets[0].code);
  expect(validateNotebook({ version: 1, notes: { dataflow: '活跃', regalloc: '溢出' }, completed: ['dataflow', 'regalloc'] }))
    .toEqual({ version: 1, notes: { dataflow: '活跃', regalloc: '溢出' }, completed: ['dataflow', 'regalloc'] });
});
it('restores bounded function inputs and retains function notes with older notebook entries', () => {
  expect(readUrl('?lab=functions').source).toBe(functionPresets[0].code);
  const shared = shareUrl('http://localhost:5173', 'functions', functionPresets[1].code, 12,
    { fold: false, propagate: false, dead: false });
  expect(readUrl(new URL(shared).search)).toMatchObject({ route: 'functions', source: functionPresets[1].code, step: 12 });
  expect(readUrl('?lab=functions&code=' + 'a'.repeat(2001)).source).toBe(functionPresets[0].code);
  expect(validateNotebook({ version: 1, notes: { lex: '旧', functions: '调用' }, completed: ['lex', 'functions'] }))
    .toEqual({ version: 1, notes: { lex: '旧', functions: '调用' }, completed: ['lex', 'functions'] });
});
it('restores out-of-SSA experiments and retains their notes alongside older topics', () => {
  expect(readUrl('?lab=outssa').source).toBe(outSsaPresets[0].code);
  const shared = shareUrl('http://localhost:5173', 'outssa', outSsaPresets[2].code, 4,
    { fold: false, propagate: true, dead: false });
  expect(readUrl(new URL(shared).search)).toMatchObject({ route: 'outssa', source: outSsaPresets[2].code, step: 4 });
  expect(readUrl('?lab=outssa&code=' + 'a'.repeat(2001)).source).toBe(outSsaPresets[0].code);
  expect(validateNotebook({ version: 1, notes: { ssa: '构造', outssa: '消除' }, completed: ['ssa', 'outssa'] }))
    .toEqual({ version: 1, notes: { ssa: '构造', outssa: '消除' }, completed: ['ssa', 'outssa'] });
});
it('restores minimization state and validates new and old notebook entries', () => {
  expect(readUrl('?lab=minimize').source).toBe(minimizationPresets[0].code);
  const url = shareUrl('http://localhost:5173', 'minimize', minimizationPresets[2].code, 2,
    { fold: true, propagate: true, dead: true });
  expect(readUrl(new URL(url).search)).toMatchObject({ route: 'minimize', source: minimizationPresets[2].code, step: 2 });
  expect(readUrl('?lab=minimize&code=' + 'x'.repeat(2001)).source).toBe(minimizationPresets[0].code);
  expect(validateNotebook({ version: 1, notes: { lex: '旧笔记', minimize: '新笔记' }, completed: ['lex', 'minimize'] }).completed)
    .toEqual(['lex', 'minimize']);
});
it('restores SSA inputs and retains both old and new local notes', () => {
  expect(readUrl('?lab=ssa').source).toBe(ssaPresets[0].code);
  const shared = shareUrl('http://localhost:5173', 'ssa', ssaPresets[1].code, 8,
    { fold: false, propagate: false, dead: false });
  expect(readUrl(new URL(shared).search)).toMatchObject({ route: 'ssa', step: 8, source: ssaPresets[1].code });
  expect(validateNotebook({ version: 1, notes: { lex: '旧笔记', ssa: '新笔记' }, completed: ['lex', 'ssa'] }))
    .toEqual({ version: 1, notes: { lex: '旧笔记', ssa: '新笔记' }, completed: ['lex', 'ssa'] });
});
it('round-trips the current executable state without encoding private notes', () => {
  const options = { fold: true, propagate: false, dead: true };
  const code = 'int integer = 5;\nprint(integer); // & ?';
  const url = shareUrl('http://localhost:5173/?old=1#fragment', 'vm', code, 12, options);
  expect(readUrl(new URL(url).search)).toEqual({ route: 'vm', source: code, step: 12, options,
    registers: { count: 3, algorithm: 'color' }, codegen: { pool: 'full', input: 'raw' } });
  expect(url).not.toContain('regs=');
  expect(url).not.toContain('pool=');
  expect(url).not.toContain('notes');
  expect(new URL(url).hash).toBe('');
});
it('opens the interprocedural lab with its own preset and bounded input', () => {
  expect(readUrl('?lab=interproc')).toMatchObject({ route: 'interproc', source: interprocPresets[0].code });
  const shared = shareUrl('http://localhost:5173', 'interproc', interprocPresets[1].code, 3, defaultOptions);
  expect(readUrl(new URL(shared).search)).toMatchObject({ route: 'interproc', source: interprocPresets[1].code, step: 3 });
  expect(readUrl('?lab=interproc&code=' + 'a'.repeat(2001)).source).toBe(interprocPresets[0].code);
});
it('restores code generation settings from bounded URLs', () => {
  expect(readUrl('?lab=codegen')).toMatchObject({ route: 'codegen', source: codegenPresets[0].code, codegen: { pool: 'full', input: 'raw' } });
  const shared = shareUrl('http://localhost:5173', 'codegen', codegenPresets[3].code, 4, defaultOptions,
    undefined, { pool: 'tight', input: 'optimized' });
  expect(readUrl(new URL(shared).search)).toMatchObject({ route: 'codegen', source: codegenPresets[3].code, step: 4,
    codegen: { pool: 'tight', input: 'optimized' } });
  expect(readUrl('?lab=codegen&pool=%3Cscript%3E&ir=all').codegen).toEqual({ pool: 'full', input: 'raw' });
  expect(new URL(shareUrl('http://localhost:5173', 'regalloc', 'print(1);', 0, defaultOptions, undefined, { pool: 'tight', input: 'raw' })).searchParams.get('pool')).toBeNull();
});
it('bounds and validates untrusted URLs and imports', () => {
  const restored = readUrl('?lab=unknown&step=-22&opt=nope&code=' + 'a'.repeat(2001));
  expect(restored.route).toBe('home');
  expect(restored.step).toBe(0);
  expect(restored.source.length).toBeLessThan(2001);
  expect(readUrl('?lab=lex&step=Infinity').step).toBe(10000);
  expect(() => validateNotebook({ version: 2, notes: {}, completed: [] })).toThrow();
  expect(() => validateNotebook({ version: 1, notes: { lex: 5 }, completed: [] })).toThrow();
  expect(
    validateNotebook({
      version: 1,
      notes: { lex: '<script>alert(1)</script>' },
      completed: ['lex', 'unknown', 'lex'],
    }),
  ).toEqual({ version: 1, notes: { lex: '<script>alert(1)</script>' }, completed: ['lex'] });
});
