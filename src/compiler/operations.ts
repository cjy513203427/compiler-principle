import type { Value } from './model';
export const DIVIDE_BY_ZERO = '整数除法的除数不能为 0。';
export const UNSAFE_INTEGER = '计算结果超出安全整数范围。';
export function arithmetic(op: string, left: Value, right: Value): number {
  if (typeof left !== 'number' || typeof right !== 'number')
    throw new Error('算术操作数不是整数。');
  if (op === '/' && right === 0) throw new Error(DIVIDE_BY_ZERO);
  // left % right is exact for safe integers, so the quotient below is an exact integer;
  // Math.trunc(left / right) would round large dividends first (2^53 - 1 / 2 → 2^52).
  const value =
    op === '+'
      ? left + right
      : op === '-'
        ? left - right
        : op === '*'
          ? left * right
          : (left - (left % right)) / right;
  if (!Number.isSafeInteger(value)) throw new Error(UNSAFE_INTEGER);
  // Integers have no negative zero (0 * -1, 0 / -5); keep one zero for every executor.
  return value === 0 ? 0 : value;
}
export function evaluateBinary(op: string, left: Value, right: Value): Value {
  if (op === '==') return left === right;
  if (op === '!=') return left !== right;
  if (['<', '<=', '>', '>='].includes(op)) {
    if (typeof left !== 'number' || typeof right !== 'number')
      throw new Error('比较操作数不是整数。');
    return op === '<'
      ? left < right
      : op === '<='
        ? left <= right
        : op === '>'
          ? left > right
          : left >= right;
  }
  return arithmetic(op, left, right);
}
