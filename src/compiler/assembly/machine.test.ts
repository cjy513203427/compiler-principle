import { describe, it, expect } from 'vitest';
import { arithmeticFlags, runAssembly } from './machine';
import { buildProgram } from './programs';
import { defaultParameters } from '../../content/assembly';
import { ARRAY_BASE, type AssemblyTopic, reg, imm } from './model';

function run(topic: AssemblyTopic, changes = {}) {
  return runAssembly(buildProgram(topic, { ...defaultParameters(topic), ...changes }));
}
describe('x86-64 teaching execution', () => {
  it('copies MOV sources without changing flags, and preserves immutable snapshots', () => {
    const result = run('arithmetic');
    expect(result.steps[1].registers).toMatchObject({ RAX: 2n, RCX: 2n, RDX: 3n });
    expect(result.steps[1].flags).toEqual(result.steps[0].flags);
    expect(result.steps[0].registers.RAX).toBe(0n);
    expect(result.steps[2].registers.RAX).toBe(5n);
    expect(result.result).toBe(5n);
    expect(result.steps.at(-1)?.registers.RSP).toBe(0x1010n);
    expect(result.halted).toBe(true);
  });
  it.each([
    ['ADD', 0xffffffffn, 1n, 0n, true, false, true, false],
    ['ADD', 0x7fffffffn, 1n, 0x80000000n, false, true, false, true],
    ['ADD', 0x80000000n, 0x80000000n, 0n, true, true, true, false],
    ['SUB', 0n, 1n, 0xffffffffn, true, false, false, true],
    ['CMP', 0x80000000n, 1n, 0x7fffffffn, false, true, false, false],
    ['XOR', 0xffffffffn, 0xffffffffn, 0n, false, false, true, false],
  ] as const)('computes %s flags at boundaries (%s, %s)', (op, a, b, value, CF, OF, ZF, SF) => {
    expect(arithmeticFlags(op, a, b, 32)).toEqual({ result: value, flags: { CF, OF, ZF, SF } });
  });
  it('CMP preserves operands and signed/unsigned jumps disagree on FFFFFFFF', () => {
    const signed = run('branch');
    const unsigned = run('branch', { unsigned: true });
    expect(signed.steps[2].registers).toEqual(signed.steps[1].registers);
    expect(signed.steps[2].flags).toEqual(unsigned.steps[2].flags);
    expect(signed.result).toBe(1n);
    expect(unsigned.result).toBe(0n);
    expect(run('branch', { a: -2147483648, b: 1 }).result).toBe(1n); // SF=0, OF=1
    expect(run('branch', { a: 2147483647, b: -1 }).result).toBe(0n);
  });
  it('agrees with independent integer arithmetic for varied 32-bit inputs', () => {
    let seed = 19;
    for (let i = 0; i < 80; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const a = seed;
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const b = seed;
      expect(run('arithmetic', { a, b }).result).toBe(BigInt((a + b) >>> 0));
      expect(run('branch', { a, b, unsigned: true }).result).toBe(a < b ? 1n : 0n);
      expect(run('branch', { a, b, unsigned: false }).result).toBe((a | 0) < (b | 0) ? 1n : 0n);
    }
  });
  it('checks the loop condition once more than it executes the body, including zero iterations', () => {
    for (let n = 0; n <= 12; n++) {
      const result = run('loop', { n });
      expect(result.result).toBe(BigInt((n * (n - 1)) / 2));
      expect(
        result.steps.filter((step) => result.instructions[step.pc]?.instruction.op === 'CMP'),
      ).toHaveLength(n + 1);
      expect(
        result.steps.filter((step) => result.instructions[step.pc]?.instruction.op === 'JMP'),
      ).toHaveLength(n);
      expect(result.limited).toBe(false);
    }
  });
  it('uses scaled byte addresses, little endian loads, and LEA performs no data read', () => {
    const array = [0x12345678, -1, -2147483648, 30];
    for (let index = 0; index < 4; index++) {
      const direct = run('memory', { array, index });
      const lea = run('memory', { array, index, addressFirst: true });
      expect(direct.result).toBe(BigInt(array[index] >>> 0));
      expect(lea.result).toBe(direct.result);
      expect(lea.steps[1].registers.R8).toBe(ARRAY_BASE + BigInt(index * 4));
      expect(lea.steps[1].accesses).toHaveLength(0);
      expect(lea.steps[1].flags).toEqual(lea.steps[0].flags);
      expect(lea.steps[2].accesses[0]).toMatchObject({
        address: ARRAY_BASE + BigInt(index * 4),
        width: 32,
        kind: 'read',
      });
    }
    const memory = run('memory', { array }).steps[0].memory;
    expect([0, 1, 2, 3].map((i) => memory[String(ARRAY_BASE + BigInt(i))])).toEqual([
      0x78, 0x56, 0x34, 0x12,
    ]);
  });
  it('reserves Win64 shadow space, pushes the logical return, restores caller stack and returns EAX', () => {
    const result = run('call');
    expect(result.steps.map((s) => s.registers.RSP)).toEqual([
      0x1008n,
      0x1008n,
      0x1008n,
      0xfe0n,
      0xfd8n,
      0xfd8n,
      0xfd8n,
      0xfe0n,
      0x1008n,
      0x1010n,
    ]);
    const called = result.steps[4];
    expect(called.frames.map((f) => f.name)).toEqual(['caller', 'add']);
    expect(called.accesses).toEqual([{ address: 0xfd8n, width: 64, kind: 'write', value: 4n }]);
    expect(called.flags).toEqual(result.steps[3].flags);
    expect(result.steps[7].nextPc).toBe(4);
    expect(result.steps[7].flags).toEqual(result.steps[6].flags);
    expect(result.steps.at(-1)?.frames).toHaveLength(0);
    expect(result.steps[0].memory[String(0xfd8n)]).toBeUndefined();
    expect(result.result).toBe(5n);
  });
  it.each([
    ['AL', 0x11223344556677aan],
    ['AH', 0x112233445566aa88n],
    ['AX', 0x11223344556600aan],
    ['EAX', 0xaan],
    ['RAX', 0xaan],
  ] as const)(
    'writes %s with the correct preservation / zero-extension rule',
    (alias, expected) => {
      expect(run('registers', { alias }).result).toBe(expected);
    },
  );
  it('keeps teaching errors and budgets explicit', () => {
    const badCall = buildProgram('call', defaultParameters('call'));
    badCall.lines = badCall.lines.filter((line) => line.instruction?.op !== 'SUB');
    expect(runAssembly(badCall).error).toContain('ABI');
    const badRead = buildProgram('memory', defaultParameters('memory'));
    badRead.registers.RCX = 0x3000n;
    expect(runAssembly(badRead).error).toContain('映射内存');
    badRead.registers.RCX = 0xe00n;
    expect(runAssembly(badRead).error).toContain('尚未初始化');
    const forever = buildProgram('loop', defaultParameters('loop'));
    forever.lines = [
      { text: 'again:', label: 'again', sourceLine: 0 },
      { text: 'jmp again', sourceLine: 0, instruction: { op: 'JMP', target: 'again' } },
    ];
    expect(runAssembly(forever, 5)).toMatchObject({ limited: true, halted: false });
    expect(runAssembly(forever, 5).steps).toHaveLength(6);
    const wide = buildProgram('registers', defaultParameters('registers'));
    wide.lines = [
      { text: '', sourceLine: 0, instruction: { op: 'ADD', left: reg('RAX'), right: imm(1) } },
    ];
    wide.initialRax = 0xffffffffffffffffn;
    expect(runAssembly(wide).steps[1]).toMatchObject({
      registers: { RAX: 0n },
      flags: { CF: true, OF: false, ZF: true },
    });
  });
});
