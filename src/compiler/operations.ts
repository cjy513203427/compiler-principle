import type { Value } from './model';
export function arithmetic(op: string, left: Value, right: Value): number {
  if (typeof left !== 'number' || typeof right !== 'number')
    throw new Error('算术操作数不是整数。');
  if (op === '/' && right === 0) throw new Error('整数除法的除数不能为 0。');
  const value =
    op === '+'
      ? left + right
      : op === '-'
        ? left - right
        : op === '*'
          ? left * right
          : Math.trunc(left / right);
  if (!Number.isSafeInteger(value)) throw new Error('计算结果超出安全整数范围。');
  return value;
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
