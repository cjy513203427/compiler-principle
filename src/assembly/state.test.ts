import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { assemblyShareUrl, readAssemblyUrl, validateParameters } from './state';
import { defaultParameters } from '../content/assembly';
import { readUrl, validateNotebook } from '../state';
import fixture from '../content/assembly-fixture.json';

it('round trips applied parameters and a step without main source or private notes', () => {
  const parameters = {
    ...defaultParameters('memory'),
    array: [1, -1, 42, -100],
    addressFirst: true,
  };
  const url = new URL(
    assemblyShareUrl('http://localhost/?notes=private&code=old#fragment', 'memory', parameters, 2),
  );
  expect(readAssemblyUrl(url.search)).toEqual({
    topic: 'memory',
    parameters,
    step: 2,
    invalid: false,
  });
  expect(readUrl(url.search).route).toBe('assembly');
  expect(url.searchParams.has('code')).toBe(false);
  expect(url.searchParams.has('notes')).toBe(false);
  expect(url.hash).toBe('');
});
it('bounds all externally supplied state and safely restores invalid examples', () => {
  const p = defaultParameters('arithmetic');
  for (const invalid of [
    { a: NaN },
    { a: 4294967296 },
    { n: 13 },
    { index: -1 },
    { array: [1, 2, 3] },
    { array: [0, 0, 0, 2147483648] },
    { alias: 'RIP' },
    { alias: 'AH', writeHex: '100' },
    { registerHex: '0xAA' },
    { unsigned: 'true' },
  ])
    expect(() => validateParameters({ ...p, ...invalid })).toThrow();
  expect(validateParameters({ ...p, alias: 'RAX', writeHex: 'FFFFFFFFFFFFFFFF' }).writeHex).toBe(
    'FFFFFFFFFFFFFFFF',
  );
  expect(readAssemblyUrl('?asm=memory&args=%7Bbad&step=Infinity')).toMatchObject({
    topic: 'memory',
    step: 256,
    invalid: true,
  });
  expect(readAssemblyUrl('?asm=unknown&step=-2')).toMatchObject({
    topic: 'arithmetic',
    step: 0,
    invalid: true,
  });
  expect(readAssemblyUrl('?args=' + encodeURIComponent(' '.repeat(701))).invalid).toBe(true);
});
it('retains old notebooks while accepting independent appendix notes and completion', () => {
  expect(
    validateNotebook({
      version: 1,
      notes: { lex: 'old', 'assembly-call': 'new', unknown: 'drop' },
      completed: ['lex', 'assembly-call', 'assembly-call', 'bad'],
    }),
  ).toEqual({
    version: 1,
    notes: { lex: 'old', 'assembly-call': 'new' },
    completed: ['lex', 'assembly-call'],
  });
  expect(() =>
    validateNotebook({ version: 1, notes: { 'assembly-call': false }, completed: [] }),
  ).toThrow();
});
it('publishes exactly the native GCC artifacts with verifiable provenance', () => {
  const read = (path: string) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
  const sha = (value: string) => createHash('sha256').update(value).digest('hex');
  const metadata = JSON.parse(read('public/assembly/provenance.json'));
  expect(read('public/assembly/compare.c')).toBe(fixture.source);
  expect(sha(fixture.source)).toBe(metadata.sourceHash);
  expect(fixture.nativeChecks).toBe('9 native checks passed');
  expect(fixture.compiler).toContain('gcc');
  expect(fixture.abi).toContain('ms_abi');
  for (const level of ['O0', 'O2'] as const) {
    expect(read(`public/assembly/gcc-${level}.s`)).toBe(fixture.outputs[level]);
    expect(sha(fixture.outputs[level])).toBe(metadata.outputHashes[level]);
    for (const name of ['add32', 'less_signed', 'less_unsigned', 'sum_to', 'read_at', 'caller'])
      expect(fixture.outputs[level]).toContain(name + ':');
  }
  expect(fixture.outputs.O0).not.toBe(fixture.outputs.O2);
});
