import { defaultParameters } from '../content/assembly';
import type { AssemblyParameters, AssemblyTopic } from '../compiler/assembly/model';
export const ASSEMBLY_TOPICS: AssemblyTopic[] = [
  'arithmetic',
  'branch',
  'loop',
  'memory',
  'call',
  'registers',
];
export function validateParameters(value: unknown): AssemblyParameters {
  if (!value || typeof value !== 'object') throw new Error('汇编参数格式不正确。');
  const p = value as AssemblyParameters;
  const integer = (n: unknown, low: number, high: number) =>
    typeof n === 'number' && Number.isInteger(n) && n >= low && n <= high;
  if (!integer(p.a, -2147483648, 4294967295) || !integer(p.b, -2147483648, 4294967295))
    throw new Error('a、b 需要是 −2147483648 到 4294967295 之间的整数。');
  if (!integer(p.n, 0, 12) || !integer(p.index, 0, 3))
    throw new Error('循环次数需要在 0–12，数组索引需要在 0–3。');
  if (
    !Array.isArray(p.array) ||
    p.array.length !== 4 ||
    !p.array.every((n) => integer(n, -2147483648, 2147483647))
  )
    throw new Error('数组需要 4 个有符号 32 位整数。');
  if (
    typeof p.unsigned !== 'boolean' ||
    typeof p.addressFirst !== 'boolean' ||
    !['AL', 'AH', 'AX', 'EAX', 'RAX'].includes(p.alias)
  )
    throw new Error('显示或寄存器选项不正确。');
  if (
    typeof p.registerHex !== 'string' ||
    !/^[\da-fA-F]{1,16}$/.test(p.registerHex) ||
    typeof p.writeHex !== 'string' ||
    !/^[\da-fA-F]{1,16}$/.test(p.writeHex)
  )
    throw new Error('寄存器值需要 1–16 位十六进制，不含 0x 前缀。');
  const width =
    p.alias === 'AL' || p.alias === 'AH' ? 8 : p.alias === 'AX' ? 16 : p.alias === 'EAX' ? 32 : 64;
  if (BigInt(`0x${p.writeHex}`) >= 1n << BigInt(width))
    throw new Error(`写入值超出 ${p.alias} 的 ${width} 位范围。`);
  return {
    a: p.a,
    b: p.b,
    n: p.n,
    index: p.index,
    array: [...p.array],
    unsigned: p.unsigned,
    addressFirst: p.addressFirst,
    alias: p.alias,
    registerHex: p.registerHex.toUpperCase(),
    writeHex: p.writeHex.toUpperCase(),
  };
}
export function readAssemblyUrl(search: string) {
  const query = new URLSearchParams(search);
  const requested = query.get('asm');
  const topic = ASSEMBLY_TOPICS.includes(requested as AssemblyTopic)
    ? (requested as AssemblyTopic)
    : 'arithmetic';
  let parameters = defaultParameters(topic);
  let invalid = requested !== null && requested !== topic;
  const raw = query.get('args');
  if (raw !== null) {
    try {
      if (raw.length > 700) throw new Error('参数过长');
      parameters = validateParameters(JSON.parse(raw));
    } catch {
      invalid = true;
    }
  }
  const step = Math.max(0, Math.min(256, Math.floor(Number(query.get('step')) || 0)));
  return { topic, parameters, step, invalid };
}
export function assemblyShareUrl(
  base: string,
  topic: AssemblyTopic,
  parameters: AssemblyParameters,
  step: number,
) {
  const url = new URL(base);
  url.search = '';
  url.hash = '';
  url.searchParams.set('lab', 'assembly');
  url.searchParams.set('asm', topic);
  url.searchParams.set('args', JSON.stringify(validateParameters(parameters)));
  url.searchParams.set('step', String(Math.max(0, Math.min(256, Math.floor(step)))));
  return url.href;
}
