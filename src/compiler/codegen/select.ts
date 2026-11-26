import type { DataType, Instruction, Operand, Value } from '../model';
import { operandText } from '../ir';
import {
  conditionOf, fitsImm32, imm, inverse, mirrored, preg, sameReg, vreg, MAX_SAFE,
  type Imm, type MInst, type MOp, type Reg, type Role, type RuntimeFunction,
} from './x64';

/** tile: build expression trees and cover them with the largest matching x86 pattern (maximal munch).
 *  macro: expand each three-address instruction with a fixed template, as a naive baseline. */
export type Strategy = 'tile' | 'macro';
export type TreeNode =
  | { kind: 'const'; value: Value }
  | { kind: 'var'; name: string }
  | { kind: 'bin'; op: string; left: TreeNode; right: TreeNode; origin: number; temp: string };
export interface SelectionDecision {
  /** IR instructions covered by this root, in program order. */
  origins: number[];
  tree: string;
  rules: string[];
  start: number;
  end: number;
}
export interface Selection {
  strategy: Strategy;
  code: MInst[];
  decisions: SelectionDecision[];
  types: Record<string, DataType>;
  inlined: string[];
  issues: string[];
}
export const DIV_TRAP = '.Ltrap_div';
export const RANGE_TRAP = '.Ltrap_range';
export const ruleNames: Record<string, string> = {
  'lea': 'lea 三地址加法', 'lea-imm': 'lea 基址 + 立即数', 'mov-add': 'mov + add', 'mov-sub': 'mov + sub',
  'neg': '0 − x → neg', 'imul-imm': 'imul 三操作数立即数', 'mov-imul': 'mov + imul', 'idiv': 'cqo + idiv（rax/rdx 预着色）',
  'idiv-const': '常量除数省去除零检查', 'cmp-set': 'xor + cmp + setcc', 'cmp-jcc': 'cmp + 反条件跳转（融合）',
  'test-je': 'test + je', 'const-true': '条件恒真：不产生指令', 'const-false': '条件恒假：jmp',
  'mov': 'mov 寄存器复制', 'mov-imm': 'mov 32 位立即数', 'movabs': 'movabs 64 位立即数', 'xor-zero': 'xor 清零',
  'target': '结果直接写入变量的寄存器', 'print': 'rdi 传参 + call', 'range': '安全整数范围检查', 'overflow': 'jo 检查 64 位溢出',
  'div-zero': 'test + je 除零检查', 'swap': '常量在左：交换比较方向', 'jmp': 'jmp', 'label': '标签',
};
const opNames: Record<string, string> = { '+': 'Add', '-': 'Sub', '*': 'Mul', '/': 'Div', '<': 'Lt', '<=': 'Le', '>': 'Gt', '>=': 'Ge', '==': 'Eq', '!=': 'Ne' };
const comparison = (op: string) => op in conditionOf;
export function treeText(node: TreeNode): string {
  if (node.kind === 'const') return String(node.value);
  if (node.kind === 'var') return node.name;
  return `${opNames[node.op] ?? node.op}(${treeText(node.left)}, ${treeText(node.right)})`;
}
const nodeOrigins = (node: TreeNode): number[] =>
  node.kind === 'bin' ? [...nodeOrigins(node.left), ...nodeOrigins(node.right), node.origin] : [];
const bits = (value: Value) => (typeof value === 'boolean' ? (value ? 1n : 0n) : BigInt(value));

/** Types of every IR name, from comparison results, arithmetic and copies. */
export function inferTypes(ir: Instruction[]): Record<string, DataType> {
  const types: Record<string, DataType> = {};
  const of = (operand: Operand): DataType | undefined =>
    operand.kind === 'constant' ? (typeof operand.value === 'boolean' ? 'bool' : 'int') : types[operand.name];
  for (let pass = 0; pass < 64; pass++) {
    let changed = false;
    for (const instruction of ir) {
      let type: DataType | undefined, dest: string | undefined;
      if (instruction.op === 'binary') { dest = instruction.dest; type = comparison(instruction.operator) ? 'bool' : 'int'; }
      else if (instruction.op === 'move') { dest = instruction.dest; type = of(instruction.value); }
      if (dest && type && types[dest] !== type) { types[dest] = type; changed = true; }
    }
    if (!changed) break;
  }
  return types;
}

export function selectInstructions(ir: Instruction[], strategy: Strategy): Selection {
  const types = inferTypes(ir);
  const code: MInst[] = [];
  const decisions: SelectionDecision[] = [];
  const issues: string[] = [];
  const inlined: string[] = [];
  let origin = -1;
  let rules: string[] = [];
  let fresh = 0;
  const emit = (op: MOp, role: Role, rule?: string) => {
    code.push({ ...op, origin, role, note: rule && ruleNames[rule] });
    if (rule && !rules.includes(rule)) rules.push(rule);
  };
  const constReg = () => vreg(`k${fresh++}`);
  // Blocks, def and use counts decide which temporaries may become interior tree nodes.
  const block: number[] = [];
  let current = 0;
  ir.forEach((instruction, index) => {
    if (instruction.op === 'label' && index > 0) current++;
    block[index] = current;
    if (instruction.op === 'jump' || instruction.op === 'branch') current++;
  });
  const defsOf = new Map<string, number[]>(), usesOf = new Map<string, number[]>();
  const note = (map: Map<string, number[]>, name: string, index: number) => map.set(name, [...(map.get(name) ?? []), index]);
  const operands = (instruction: Instruction): Operand[] =>
    instruction.op === 'binary' ? [instruction.left, instruction.right]
      : instruction.op === 'move' || instruction.op === 'print' ? [instruction.value]
        : instruction.op === 'branch' ? [instruction.condition] : [];
  ir.forEach((instruction, index) => {
    if ('dest' in instruction) note(defsOf, instruction.dest, index);
    for (const operand of operands(instruction)) if (operand.kind === 'ref') note(usesOf, operand.name, index);
  });
  const inlinable = (name: string, at: number) => {
    if (strategy !== 'tile') return false;
    const d = defsOf.get(name), u = usesOf.get(name);
    return d?.length === 1 && u?.length === 1 && ir[d[0]].op === 'binary' && u[0] === at && block[d[0]] === block[at] && d[0] < at;
  };

  type Value_ = { kind: 'reg'; reg: Reg } | { kind: 'const'; value: bigint };
  const materialize = (value: bigint, dst: Reg, role: Role = 'compute') => {
    if (value === 0n) emit({ op: 'zero', dst }, role, 'xor-zero');
    else if (fitsImm32(value)) emit({ op: 'mov', dst, src: imm(value) }, role, 'mov-imm');
    else emit({ op: 'movabs', dst, imm: value }, role, 'movabs');
  };
  const toReg = (value: Value_): Reg => {
    if (value.kind === 'reg') return value.reg;
    const reg = constReg();
    materialize(value.value, reg);
    return reg;
  };
  const regOrImm = (value: Value_): Reg | Imm =>
    value.kind === 'const' && fitsImm32(value.value) ? imm(value.value) : toReg(value);
  const copyInto = (dst: Reg, value: Value_, role: Role = 'compute') => {
    if (value.kind === 'const') materialize(value.value, dst, role);
    // A copy into a fixed register is part of the call / idiv pattern, not a rule of its own.
    else if (!sameReg(dst, value.reg)) emit({ op: 'mov', dst, src: value.reg }, role === 'compute' ? 'copy' : role, role === 'compute' ? 'mov' : undefined);
  };
  const rangeCheck = (dst: Reg) => {
    const limit = preg('r11');
    emit({ op: 'movabs', dst: limit, imm: MAX_SAFE }, 'check', 'range');
    emit({ op: 'cmp', left: dst, right: limit }, 'check', 'range');
    emit({ op: 'j', cond: 'g', target: RANGE_TRAP }, 'check', 'range');
    emit({ op: 'neg', dst: limit }, 'check', 'range');
    emit({ op: 'cmp', left: dst, right: limit }, 'check', 'range');
    emit({ op: 'j', cond: 'l', target: RANGE_TRAP }, 'check', 'range');
  };
  const value = (node: TreeNode): Value_ =>
    node.kind === 'const' ? { kind: 'const', value: bits(node.value) }
      : node.kind === 'var' ? { kind: 'reg', reg: vreg(node.name) }
        : { kind: 'reg', reg: binary(node) };

  /** Two-address forms write dst before reading the right operand, so dst must not be that operand. */
  function twoAddress(dst: Reg, right: Value_, body: (target: Reg) => void) {
    if (right.kind === 'reg' && sameReg(dst, right.reg)) {
      const temp = vreg(`k${fresh++}`);
      body(temp);
      emit({ op: 'mov', dst, src: temp }, 'copy', 'mov');
    } else body(dst);
  }

  function binary(node: Extract<TreeNode, { kind: 'bin' }>, dest?: Reg): Reg {
    const left = value(node.left);
    const right = value(node.right);
    const saved = origin;
    origin = node.origin;
    const dst = dest ?? vreg(node.temp);
    const tile = strategy === 'tile';
    const op = node.op;
    if (comparison(op)) {
      let [l, r, cond] = [left, right, conditionOf[op]];
      if (tile && l.kind === 'const' && r.kind === 'reg') { [l, r, cond] = [r, l, mirrored[cond]]; rules.push('swap'); }
      const leftReg = toReg(l), rightValue = regOrImm(r);
      if (sameReg(dst, leftReg) || sameReg(dst, rightValue)) {
        const temp = vreg(`k${fresh++}`);
        emit({ op: 'zero', dst: temp }, 'compute', 'cmp-set');
        emit({ op: 'cmp', left: leftReg, right: rightValue }, 'compute', 'cmp-set');
        emit({ op: 'set', cond, dst: temp }, 'compute', 'cmp-set');
        emit({ op: 'mov', dst, src: temp }, 'copy', 'mov');
      } else {
        emit({ op: 'zero', dst }, 'compute', 'cmp-set');
        emit({ op: 'cmp', left: leftReg, right: rightValue }, 'compute', 'cmp-set');
        emit({ op: 'set', cond, dst }, 'compute', 'cmp-set');
      }
    } else if (op === '/') {
      const constantDivisor = tile && right.kind === 'const' && right.value !== 0n;
      const divisor = toReg(right);
      if (!constantDivisor) {
        emit({ op: 'test', left: divisor, right: divisor }, 'check', 'div-zero');
        emit({ op: 'j', cond: 'e', target: DIV_TRAP }, 'check', 'div-zero');
      } else rules.push('idiv-const');
      copyInto(preg('rax'), left, 'abi');
      emit({ op: 'cqo' }, 'compute', 'idiv');
      emit({ op: 'idiv', src: divisor }, 'compute', 'idiv');
      emit({ op: 'mov', dst, src: preg('rax') }, 'abi', 'idiv');
    } else if (op === '+' && tile && (left.kind === 'reg' || right.kind === 'reg')) {
      const [base, other] = left.kind === 'reg' ? [left.reg, right] : [(right as { reg: Reg }).reg, left];
      if (other.kind === 'reg') emit({ op: 'lea', dst, base, index: other.reg, disp: 0n }, 'compute', 'lea');
      else if (fitsImm32(other.value)) emit({ op: 'lea', dst, base, disp: other.value }, 'compute', 'lea-imm');
      else emit({ op: 'lea', dst, base, index: toReg(other), disp: 0n }, 'compute', 'lea');
      rangeCheck(dst);
    } else if (op === '-' && tile && left.kind === 'const' && left.value === 0n && right.kind === 'reg') {
      // Safe integers are symmetric around zero, so negation never needs a range check.
      copyInto(dst, right);
      emit({ op: 'neg', dst }, 'compute', 'neg');
    } else if (op === '-' && tile && left.kind === 'reg' && right.kind === 'const' && fitsImm32(-right.value)) {
      emit({ op: 'lea', dst, base: left.reg, disp: -right.value }, 'compute', 'lea-imm');
      rangeCheck(dst);
    } else if (op === '*' && tile && (left.kind === 'reg') !== (right.kind === 'reg')
      && fitsImm32((left.kind === 'const' ? left : right as { value: bigint }).value)) {
      const [source, factor] = left.kind === 'reg' ? [left.reg, (right as { value: bigint }).value] : [(right as { reg: Reg }).reg, left.value];
      emit({ op: 'imul3', dst, src: source, imm: factor }, 'compute', 'imul-imm');
      emit({ op: 'j', cond: 'o', target: RANGE_TRAP }, 'check', 'overflow');
      rangeCheck(dst);
    } else {
      const operator = op === '+' ? 'add' : op === '-' ? 'sub' : 'imul';
      twoAddress(dst, right, (target) => {
        copyInto(target, left);
        emit({ op: operator, dst: target, src: regOrImm(right) }, 'compute', op === '+' ? 'mov-add' : op === '-' ? 'mov-sub' : 'mov-imul');
        if (operator === 'imul') emit({ op: 'j', cond: 'o', target: RANGE_TRAP }, 'check', 'overflow');
        rangeCheck(target);
      });
    }
    origin = saved;
    return dst;
  }

  // Pending interior trees, kept in definition order. A consumer may take only the top of the
  // stack, in operand order, so emitting a tree in post-order replays the original IR order.
  let pending: { name: string; node: TreeNode }[] = [];
  const decide = (origins: number[], tree: string, start: number) =>
    decisions.push({ origins: [...new Set(origins)].sort((a, b) => a - b), tree, rules, start, end: code.length });
  const flush = () => {
    const waiting = pending;
    pending = [];
    for (const item of waiting) {
      const start = code.length;
      rules = [];
      origin = (item.node as { origin: number }).origin;
      binary(item.node as Extract<TreeNode, { kind: 'bin' }>);
      decide(nodeOrigins(item.node), `Assign(${item.name}, ${treeText(item.node)})`, start);
    }
  };
  const take = (instruction: Instruction, index: number): TreeNode[] => {
    const list = operands(instruction);
    const wanted = list.filter((operand) => operand.kind === 'ref' && inlinable(operand.name, index)).map((operand) => (operand as { name: string }).name);
    const top = pending.slice(pending.length - wanted.length).map((item) => item.name);
    const ok = wanted.length <= pending.length && wanted.every((name, i) => top[i] === name);
    if (!ok && wanted.length) flush();
    const consumed = ok ? pending.splice(pending.length - wanted.length) : [];
    return list.map((operand) => {
      if (operand.kind === 'constant') return { kind: 'const', value: operand.value };
      const found = consumed.find((item) => item.name === operand.name);
      if (found) { inlined.push(found.name); return found.node; }
      return { kind: 'var', name: operand.name };
    });
  };

  ir.forEach((instruction, index) => {
    if (instruction.op === 'binary' && strategy === 'tile' && usesOf.get(instruction.dest)?.length === 1
      && inlinable(instruction.dest, usesOf.get(instruction.dest)![0])) {
      const [left, right] = take(instruction, index);
      pending.push({ name: instruction.dest, node: { kind: 'bin', op: instruction.operator, left, right, origin: index, temp: instruction.dest } });
      return;
    }
    const children = take(instruction, index);
    // Older trees nobody consumed must run before this root to keep their order.
    if (pending.length) flush();
    const start = code.length;
    rules = [];
    origin = index;
    let tree = '';
    switch (instruction.op) {
      case 'label':
        emit({ op: 'label', name: `.${instruction.name}` }, 'control', 'label');
        tree = `Label(${instruction.name})`;
        break;
      case 'jump':
        emit({ op: 'jmp', target: `.${instruction.target}` }, 'control', 'jmp');
        tree = `Jump(${instruction.target})`;
        break;
      case 'binary': {
        const node: TreeNode = { kind: 'bin', op: instruction.operator, left: children[0], right: children[1], origin: index, temp: instruction.dest };
        tree = `Assign(${instruction.dest}, ${treeText(node)})`;
        binaryRoot(node, instruction.dest);
        break;
      }
      case 'move': {
        const node = children[0];
        tree = `Move(${instruction.dest}, ${treeText(node)})`;
        if (node.kind === 'bin') binaryRoot(node, instruction.dest);
        else copyInto(vreg(instruction.dest), value(node));
        break;
      }
      case 'print': {
        const node = children[0];
        tree = `Print(${treeText(node)})`;
        const result = value(node);
        origin = index;
        copyInto(preg('rdi'), result, 'abi');
        const type = node.kind === 'const' ? (typeof node.value === 'boolean' ? 'bool' : 'int')
          : node.kind === 'var' ? types[node.name] : comparison(node.op) ? 'bool' : 'int';
        if (!type) issues.push(`无法确定 ${operandText(instruction.value)} 的类型。`);
        const target: RuntimeFunction = type === 'bool' ? '__mc_print_bool' : '__mc_print_int';
        emit({ op: 'call', target }, 'abi', 'print');
        break;
      }
      case 'branch': {
        const node = children[0];
        tree = `IfFalse(${treeText(node)}) → ${instruction.target}`;
        const target = `.${instruction.target}`;
        if (node.kind === 'const') {
          if (strategy === 'tile') {
            if (node.value === false) emit({ op: 'jmp', target }, 'control', 'const-false');
            else rules.push('const-true');
          } else {
            const reg = toReg(value(node));
            emit({ op: 'test', left: reg, right: reg }, 'control', 'test-je');
            emit({ op: 'j', cond: 'e', target }, 'control', 'test-je');
          }
        } else if (node.kind === 'bin' && comparison(node.op)) {
          let left = value(node.left), right = value(node.right), cond = conditionOf[node.op];
          origin = node.origin;
          if (left.kind === 'const' && right.kind === 'reg') { [left, right, cond] = [right, left, mirrored[cond]]; rules.push('swap'); }
          const leftReg = toReg(left), rightValue = regOrImm(right);
          emit({ op: 'cmp', left: leftReg, right: rightValue }, 'control', 'cmp-jcc');
          origin = index;
          emit({ op: 'j', cond: inverse[cond], target }, 'control', 'cmp-jcc');
        } else {
          const reg = toReg(value(node));
          origin = index;
          emit({ op: 'test', left: reg, right: reg }, 'control', 'test-je');
          emit({ op: 'j', cond: 'e', target }, 'control', 'test-je');
        }
        break;
      }
    }
    decide([...children.flatMap(nodeOrigins), index], tree, start);
  });
  if (pending.length) flush();
  origin = -1;
  rules = [];
  code.push({ op: 'exit', origin: -1, role: 'frame' });
  const used = (name: string) => code.some((item) => (item.op === 'j' || item.op === 'jmp') && item.target === name);
  for (const [label, codeNumber] of [[DIV_TRAP, 1n], [RANGE_TRAP, 2n]] as const) {
    if (!used(label)) continue;
    code.push({ op: 'label', name: label, origin: -1, role: 'check' });
    code.push({ op: 'mov', dst: preg('rdi'), src: imm(codeNumber), origin: -1, role: 'check', note: '错误码作为第一个参数' });
    code.push({ op: 'call', target: '__mc_trap', origin: -1, role: 'check', note: '运行时报告错误并终止，不返回' });
  }
  return { strategy, code, decisions, types, inlined, issues };

  function binaryRoot(node: Extract<TreeNode, { kind: 'bin' }>, dest: string) {
    const target = vreg(dest);
    // Children finish before the root tile writes, and every tile guards its own operands
    // (two-address forms and setcc use a temporary when dest is also an operand).
    if (strategy === 'tile') {
      binary(node, target);
      if (node.temp !== dest) rules.push('target');
    } else {
      const result = binary(node);
      origin = node.origin;
      if (!sameReg(result, target)) emit({ op: 'mov', dst: target, src: result }, 'copy', 'mov');
    }
  }
}
export const ruleText = (rule: string) => ruleNames[rule] ?? rule;
