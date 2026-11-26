import { describe, expect, it } from 'vitest';
import { compile } from './index';
import { assemblyFile, generateCode, normalizeCodegenSettings, sweepCodegen, type CodegenSettings } from './codegen';
import { checkMachineAssignment, POOLS } from './codegen/allocate';
import { inferTypes, selectInstructions } from './codegen/select';
import { CALLER_SAVED, imm, instructionText, preg, runX64, type MInst, type MOp } from './codegen/x64';
import { arithmetic } from './operations';
import { presets } from '../content/lessons';
import { codegenPresets } from '../content/codegen';
import { regallocPresets } from '../content/regalloc';
import { ssaOptPresets } from '../content/ssaopt';
import { redundancyPresets } from '../content/redundancy';
import { outSsaPresets } from '../content/outssa';

const options = { fold: true, propagate: true, dead: true };
const prepare = (source: string) => {
  const result = compile(source, options);
  if (!result.ir || !result.baseline || !result.optimization) throw new Error(result.diagnostic?.message);
  return result;
};
const preset = (id: string) => codegenPresets.find((item) => item.id === id)!.code;
const run = (source: string, settings: Partial<CodegenSettings> = {}, strategy: 'tile' | 'macro' = 'tile') => {
  const result = prepare(source);
  const full = { ...normalizeCodegenSettings(undefined, undefined), ...settings };
  const ir = full.input === 'raw' ? result.ir! : result.optimization!.at(-1)!.instructions;
  return { result, run: generateCode(ir, full, strategy, result.baseline) };
};
const text = (code: MInst[]) => code.map((instruction) => instructionText(instruction));

function verifyEverywhere(source: string) {
  const result = prepare(source);
  const irs = { raw: result.ir!, optimized: result.optimization!.at(-1)!.instructions };
  for (const input of ['raw', 'optimized'] as const)
    for (const pool of ['full', 'tight'] as const)
      for (const strategy of ['tile', 'macro'] as const) {
        const label = `${input} ${pool} ${strategy}\n${source}`;
        const generated = generateCode(irs[input], { pool, input }, strategy, result.baseline, { record: false });
        expect(generated.issues, label).toEqual([]);
        expect(generated.valid, label).toBe(true);
        // Recheck the final virtual code (the last round, which had no spill) independently.
        expect(checkMachineAssignment(generated.rounds.at(-1)!.code, generated.assignment, POOLS[pool]), label).toEqual([]);
        const execution = generated.execution!;
        expect(execution.fault, label).toBeUndefined();
        if (generated.outcome === 'unknown') expect(result.baseline!.limited || execution.limited, label).toBe(true);
        else expect(generated.outcome, label).toBe('same');
      }
}

describe('source integer semantics shared by every executor', () => {
  it('divides exactly and has a single zero', () => {
    expect(arithmetic('/', 9007199254740991, 2)).toBe(4503599627370495);
    expect(arithmetic('/', -9007199254740991, 2)).toBe(-4503599627370495);
    expect(arithmetic('/', -17, 5)).toBe(-3);
    expect(Object.is(arithmetic('*', 0, -5), 0)).toBe(true);
    expect(Object.is(arithmetic('/', 0, -5), 0)).toBe(true);
    expect(Object.is(arithmetic('/', -1, 2), 0)).toBe(true);
    expect(() => arithmetic('*', 94906267, 94906267)).toThrow('安全整数');
    expect(() => arithmetic('+', 9007199254740991, 1)).toThrow('安全整数');
  });
});

describe('code generation keeps behaviour', () => {
  it('matches the VM for every preset, input, register pool and strategy', () => {
    for (const { code } of [...presets, ...codegenPresets, ...regallocPresets, ...ssaOptPresets, ...redundancyPresets, ...outSsaPresets]) {
      const result = compile(code, options);
      if (result.ir) verifyEverywhere(code);
    }
  });

  it('matches the VM on seeded random programs with loops, comparisons, big constants and traps', () => {
    let seed = 20261126;
    const random = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    const constants = ['0', '1', '7', '3000000000', '9007199254740991', '2147483647', '2147483648'];
    for (let round = 0; round < 60; round++) {
      const names = Array.from({ length: 3 + random(4) }, (_, index) => `v${index}`);
      const atom = () => (random(3) ? names[random(names.length)] : random(4) ? String(random(9)) : constants[random(constants.length)]);
      const expression = (depth: number): string => {
        if (depth <= 0 || random(3) === 0) return random(5) === 0 ? `(0 - ${atom()})` : atom();
        const op = ['+', '-', '*', '+', '/', '-'][random(6)];
        return `(${expression(depth - 1)} ${op} ${expression(depth - 1)})`;
      };
      const condition = () => `${expression(1)} ${['<', '<=', '>', '>=', '==', '!='][random(6)]} ${expression(1)}`;
      const lines = names.map((name, index) => `int ${name} = ${index + random(5)};`);
      lines.push(`bool flag = ${condition()};`);
      for (let statement = 0; statement < 3 + random(4); statement++) {
        const kind = random(6);
        if (kind === 0) {
          const counter = `c${statement}`;
          lines.push(`int ${counter} = 0;`, `while (${counter} < ${1 + random(3)}) {`,
            `  ${names[random(names.length)]} = ${expression(2)};`, `  print(${expression(1)});`,
            `  ${counter} = ${counter} + 1;`, '}');
        } else if (kind === 1) lines.push(`if (${condition()}) {`, `  print(${expression(2)});`, '} else {', `  flag = ${condition()};`, '}');
        else if (kind === 2) lines.push('print(flag);', `flag = flag == ${random(2) ? 'true' : 'false'};`);
        else if (kind === 3) lines.push(`${names[random(names.length)]} = ${expression(2)};`);
        else lines.push(`print(${expression(2)});`);
      }
      verifyEverywhere(lines.join('\n'));
    }
  });

  it('reports overflow and division by zero with the source messages, after earlier output', () => {
    const range = run(preset('cg-range')).run;
    expect(range.execution!.output).toEqual([4503599627370495, 9007199254740990]);
    expect(range.execution!.error?.message).toBe('计算结果超出安全整数范围。');
    const trap = run(preset('cg-trap')).run;
    expect(trap.execution!.output).toEqual([true]);
    expect(trap.execution!.error?.message).toBe('整数除法的除数不能为 0。');
    expect(trap.outcome).toBe('same');
    const product = run('int a = 94906267;\nprint(a * a);').run;
    expect(product.execution!.error?.message).toBe('计算结果超出安全整数范围。');
    const huge = run('int a = 3037000500;\nprint(a * a);').run; // exceeds 64 bits: jo, before the range check
    expect(huge.execution!.error?.message).toBe('计算结果超出安全整数范围。');
    expect(huge.outcome).toBe('same');
  });
});

describe('instruction selection', () => {
  it('rebuilds the book example into one tree and covers it with two lea', () => {
    const { run: generated } = run(preset('cg-lea'));
    const tree = generated.selection.decisions.find((decision) => decision.tree.startsWith('Print'))!;
    expect(tree.tree).toBe('Print(Add(Add(v0_a, v1_b), 10))');
    const code = text(generated.selection.code);
    expect(code.filter((line) => line.startsWith('lea'))).toEqual(['lea %t0, [%v0_a + %v1_b]', 'lea %t1, [%t0 + 10]']);
    expect(generated.stats!.checks).toBeGreaterThanOrEqual(12);
  });

  it('fuses compare and branch, uses neg and three-operand imul; the macro baseline does not', () => {
    const tile = run(preset('cg-branch')).run;
    const macro = run(preset('cg-branch'), {}, 'macro').run;
    const tileCode = text(tile.selection.code);
    expect(tileCode).toContain('cmp %v0_x, 10');
    expect(tileCode).toContain('jge .L0');
    expect(tileCode.some((line) => line.startsWith('set'))).toBe(false);
    expect(tileCode).toContain('imul %v1_y, %v0_x, 4');
    expect(tileCode).toContain('neg %v1_y');
    const macroCode = text(macro.selection.code);
    expect(macroCode).toContain('setl %t0');
    expect(macroCode).toContain('test %t0, %t0');
    expect(tile.stats!.instructions).toBeLessThan(macro.stats!.instructions);
  });

  it('keeps idiv on rax and rdx and skips the zero check only for a constant divisor', () => {
    const { run: generated } = run(preset('cg-div'));
    const code = text(generated.selection.code);
    expect(code.filter((line) => line === 'cqo')).toHaveLength(3);
    expect(code.filter((line) => line.startsWith('test'))).toHaveLength(2);
    expect(generated.execution!.output).toEqual([3, 5, -3]);
    const final = text(generated.program);
    final.forEach((line, index) => { if (line === 'cqo') expect(final[index + 1]).toMatch(/^idiv (?!rax|rdx)/); });
  });

  it('uses movabs only for constants outside 32 bits', () => {
    const code = text(run(preset('cg-imm')).run.selection.code);
    expect(code).toContain('movabs %v0_big, 5000000000');
    expect(code).toContain('mov %v1_small, 7');
    expect(code).toContain('imul %t1, %v1_small, 100000');
  });

  it('keeps evaluation order when a temporary is not on top of the pending stack', () => {
    // Optimized IR can reuse a temporary; it must be materialized, not inlined twice.
    const ir = [
      { op: 'binary', dest: 't0', operator: '/', left: { kind: 'constant', value: 1 }, right: { kind: 'ref', name: 'v0_a' }, nodeId: 0 },
      { op: 'binary', dest: 't1', operator: '/', left: { kind: 'constant', value: 2 }, right: { kind: 'ref', name: 'v1_b' }, nodeId: 0 },
      { op: 'binary', dest: 't2', operator: '+', left: { kind: 'ref', name: 't1' }, right: { kind: 'ref', name: 't0' }, nodeId: 0 },
      { op: 'print', value: { kind: 'ref', name: 't2' }, nodeId: 0 },
    ] as const;
    const selection = selectInstructions([...ir] as never, 'tile');
    const divides = selection.code.filter((instruction) => instruction.op === 'idiv').map((instruction) => instruction.origin);
    expect(divides).toEqual([0, 1]);
  });

  it('infers bool for comparisons and copies', () => {
    const result = prepare('bool a = 1 < 2;\nbool b = a;\nint c = 3;\nprint(b);');
    expect(inferTypes(result.ir!)).toMatchObject({ v0_a: 'bool', v1_b: 'bool', v2_c: 'int' });
  });
});

describe('registers, calling convention and frame', () => {
  it('keeps values live across a call out of caller-saved registers', () => {
    for (const pool of ['full', 'tight'] as const) {
      const { run: generated } = run(preset('cg-call'), { pool });
      const across = generated.rounds.at(-1)!.graph.acrossCall;
      expect(across.length).toBeGreaterThan(0);
      for (const key of across) expect(CALLER_SAVED).not.toContain(generated.assignment[key]);
      expect(generated.outcome).toBe('same');
    }
    const tight = run(preset('cg-call'), { pool: 'tight' }).run;
    expect(Object.keys(tight.slots)).toHaveLength(1);
    expect(tight.layout!.calleeSaved).toEqual(['rbx']);
    expect(tight.layout!.size % 16).toBe(8);
  });

  it('aligns rsp to 16 at every call and restores callee-saved registers', () => {
    for (const { code } of codegenPresets)
      for (const pool of ['full', 'tight'] as const) {
        const { run: generated } = run(code, { pool });
        const pushes = 1 + generated.layout!.calleeSaved.length;
        expect((8 + 8 * pushes + generated.layout!.size) % 16, code).toBe(0);
        expect(generated.execution!.fault, code).toBeUndefined();
      }
  });

  it('the simulator rejects code that breaks the convention', () => {
    const frame = (body: MOp[]): MInst[] => [
      { op: 'push', reg: preg('rbp') }, { op: 'mov', dst: preg('rbp'), src: preg('rsp') }, ...body,
      { op: 'pop', reg: preg('rbp') }, { op: 'ret' },
    ].map((op) => ({ ...op, origin: -1, role: 'compute' }) as MInst);
    const clobbered = runX64(frame([
      { op: 'mov', dst: preg('rcx'), src: imm(5n) }, { op: 'mov', dst: preg('rdi'), src: imm(1n) },
      { op: 'call', target: '__mc_print_int' }, { op: 'mov', dst: preg('rdi'), src: preg('rcx') },
    ]));
    expect(clobbered.fault).toContain('rcx');
    const misaligned = runX64([{ op: 'mov', dst: preg('rdi'), src: imm(1n) }, { op: 'call', target: '__mc_print_int' }, { op: 'ret' }]
      .map((op) => ({ ...op, origin: -1, role: 'compute' }) as MInst));
    expect(misaligned.fault).toContain('16 字节对齐');
    const broken = runX64(frame([{ op: 'mov', dst: preg('rbx'), src: imm(1n) }]));
    expect(broken.fault).toContain('rbx');
    const flags = runX64(frame([{ op: 'mov', dst: preg('rdi'), src: imm(1n) }, { op: 'call', target: '__mc_print_int' }, { op: 'j', cond: 'e', target: 'x' }, { op: 'label', name: 'x' }]));
    expect(flags.fault).toContain('标志位');
  });

  it('turns biased copies into self moves and deletes them', () => {
    const { run: generated } = run('int a = 5;\nint b = a;\nint c = b;\nprint(c);');
    expect(generated.removedMoves).toBeGreaterThan(0);
    expect(text(generated.program).filter((line) => /^mov r\w+, r\w+$/.test(line) && !line.includes('rbp'))).toEqual([]);
  });

  it('exports a GNU as file with a main symbol and no virtual registers', () => {
    const file = assemblyFile(run(preset('cg-call')).run.program);
    expect(file).toContain('.intel_syntax noprefix');
    expect(file).toContain('.globl main');
    expect(file).not.toContain('%');
    expect(file).not.toContain('slot');
  });

  it('sweeps both inputs, pools and strategies', () => {
    const result = prepare(preset('cg-call'));
    const rows = sweepCodegen({ raw: result.ir!, optimized: result.optimization!.at(-1)!.instructions }, result.baseline!);
    expect(rows).toHaveLength(8);
    expect(rows.every((row) => row.outcome === 'same')).toBe(true);
    const tile = rows.find((row) => row.input === 'raw' && row.pool === 'full' && row.strategy === 'tile')!;
    const macro = rows.find((row) => row.input === 'raw' && row.pool === 'full' && row.strategy === 'macro')!;
    expect(tile.instructions).toBeLessThan(macro.instructions);
  });

  it('records frames that end with the comparison', () => {
    const { run: generated } = run(preset('cg-branch'));
    expect(generated.frames[0].kind).toBe('input');
    expect(generated.frames.some((frame) => frame.kind === 'select')).toBe(true);
    expect(generated.frames.some((frame) => frame.kind === 'layout')).toBe(true);
    expect(generated.frames.at(-1)!.kind).toBe('complete');
    expect(generated.frames.length).toBeLessThanOrEqual(421);
  });
});
