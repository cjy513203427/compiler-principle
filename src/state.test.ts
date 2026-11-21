import { it, expect } from 'vitest';
import { readUrl, shareUrl, validateNotebook } from './state';
import { ssaPresets } from './content/ssa';
import { minimizationPresets } from './content/minimize';
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
  expect(readUrl(new URL(url).search)).toEqual({ route: 'vm', source: code, step: 12, options });
  expect(url).not.toContain('notes');
  expect(new URL(url).hash).toBe('');
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
