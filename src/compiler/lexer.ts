import { CompileError, type Token, type ScanStep } from './model';

const keywords = new Set(['int', 'bool', 'print', 'true', 'false']);
const letter = (c: string) => /[a-zA-Z_]/.test(c);
const digit = (c: string) => /[0-9]/.test(c);
export function tokenize(source: string): { tokens: Token[]; steps: ScanStep[] } {
  if (source.length > 2000)
    throw new CompileError({
      stage: 'lex',
      message: '教学程序最多 2000 个字符，请缩小示例。',
      start: 2000,
      end: source.length,
    });
  const tokens: Token[] = [];
  const steps: ScanStep[] = [
    { position: -1, state: 'start', message: '从初始状态出发；每次读取一个字符。', emitted: 0 },
  ];
  let i = 0;
  const addStep = (position: number, state: ScanStep['state'], message: string) =>
    steps.push({ position, state, message, emitted: tokens.length });
  const emit = (kind: Token['kind'], start: number) =>
    tokens.push({ kind, text: source.slice(start, i), start, end: i });
  while (i < source.length) {
    const start = i;
    const c = source[i];
    if (/\s/.test(c)) {
      i++;
      addStep(start, 'start', '跳过空白，回到初始状态。');
      continue;
    }
    if (c === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') {
        addStep(i++, 'comment', '单行注释：读取但不生成 Token。');
      }
      continue;
    }
    if (letter(c)) {
      while (i < source.length && (letter(source[i]) || digit(source[i]))) {
        const position = i++;
        const end = i === source.length || !(letter(source[i]) || digit(source[i]));
        if (end) emit(keywords.has(source.slice(start, i)) ? 'keyword' : 'identifier', start);
        addStep(
          position,
          'identifier',
          end
            ? `最长匹配结束：${source.slice(start, i)} → ${tokens.at(-1)!.kind}。`
            : '继续读取标识符；先不把关键字前缀切开。',
        );
      }
    } else if (digit(c)) {
      while (i < source.length && digit(source[i])) {
        const position = i++;
        const end = i === source.length || !digit(source[i]);
        if (end) emit('number', start);
        addStep(
          position,
          'number',
          end
            ? `数字结束，生成整数 Token：${source.slice(start, i)}。`
            : '仍是数字，继续累积整数字面量。',
        );
      }
    } else if ('+-*/=;(){}'.includes(c)) {
      i++;
      emit('+-*/='.includes(c) ? 'operator' : 'punctuation', start);
      addStep(start, 'symbol', `识别单字符符号 ${c}。`);
    } else {
      throw new CompileError({
        stage: 'lex',
        message: `无法识别字符「${c}」。本实验使用 ASCII 标识符与半角符号。`,
        start,
        end: start + 1,
      });
    }
  }
  tokens.push({ kind: 'eof', text: 'EOF', start: i, end: i });
  addStep(i, 'start', '读到文件结尾，生成 EOF；词法分析完成。');
  return { tokens, steps };
}
