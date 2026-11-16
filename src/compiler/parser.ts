import {
  CompileError,
  type Token,
  type Expr,
  type Stmt,
  type Program,
  type ParseStep,
  type DataType,
} from './model';

export function parse(tokens: Token[]): { ast: Program; steps: ParseStep[] } {
  let cursor = 0;
  let id = 0;
  let nesting = 0;
  const steps: ParseStep[] = [{ cursor, message: '从 Program 开始，自顶向下匹配语句。' }];
  const peek = () => tokens[cursor];
  const fail = (message: string): never => {
    throw new CompileError({ stage: 'parse', message, start: peek().start, end: peek().end });
  };
  const take = (text?: string) => {
    if (text && peek().text !== text) fail(`期望「${text}」，实际读到「${peek().text}」。`);
    const token = tokens[cursor++];
    steps.push({ cursor, message: `消费 Token「${token.text}」。` });
    return token;
  };
  const built = <T extends Expr | Stmt>(node: T, message: string): T => {
    steps.push({ cursor, nodeId: node.id, message });
    return node;
  };
  function nested<T>(read: () => T): T {
    if (++nesting > 64) fail('嵌套超过 64 层，请把教学示例拆得更小一些。');
    try {
      return read();
    } finally {
      nesting--;
    }
  }
  function primary(): Expr {
    const token = peek();
    if (token.kind === 'number') {
      take();
      const value = Number(token.text);
      if (!Number.isSafeInteger(value))
        throw new CompileError({
          stage: 'parse',
          message: '整数字面量超出 JavaScript 安全整数范围。',
          start: token.start,
          end: token.end,
        });
      return built(
        { kind: 'literal', value, id: id++, start: token.start, end: token.end },
        `建立整数叶节点 ${token.text}。`,
      );
    }
    if (token.text === 'true' || token.text === 'false') {
      take();
      return built(
        {
          kind: 'literal',
          value: token.text === 'true',
          id: id++,
          start: token.start,
          end: token.end,
        },
        '建立 bool 叶节点。',
      );
    }
    if (token.kind === 'identifier') {
      take();
      return built(
        { kind: 'identifier', name: token.text, id: id++, start: token.start, end: token.end },
        `建立标识符节点 ${token.text}；此时尚未查找声明。`,
      );
    }
    if (token.text === '(') {
      take();
      const expr = nested(equality);
      take(')');
      return expr;
    }
    return fail(`期望表达式，实际读到「${token.text}」。`);
  }
  function unary(): Expr {
    if (peek().text !== '-') return primary();
    const start = take().start;
    const operand = nested(unary);
    return built(
      { kind: 'unary', operand, id: id++, start, end: operand.end },
      '构造一元负号节点。',
    );
  }
  function multiplication(): Expr {
    let left = unary();
    while (peek().text === '*' || peek().text === '/') {
      const op = take().text;
      const right = unary();
      left = built(
        { kind: 'binary', op, left, right, id: id++, start: left.start, end: right.end },
        `构造 ${op} 节点；乘除层先于加减层完成。`,
      );
    }
    return left;
  }
  function addition(): Expr {
    let left = multiplication();
    while (peek().text === '+' || peek().text === '-') {
      const op = take().text;
      const right = multiplication();
      left = built(
        { kind: 'binary', op, left, right, id: id++, start: left.start, end: right.end },
        `构造 ${op} 节点；循环把已有子树放在左侧，保持左结合。`,
      );
    }
    return left;
  }
  function comparison(): Expr {
    let left = addition();
    while (['<', '<=', '>', '>='].includes(peek().text)) {
      const op = take().text;
      const right = addition();
      left = built(
        { kind: 'binary', op, left, right, id: id++, start: left.start, end: right.end },
        `构造比较 ${op} 节点，结果类型交给语义阶段检查。`,
      );
    }
    return left;
  }
  function equality(): Expr {
    let left = comparison();
    while (peek().text === '==' || peek().text === '!=') {
      const op = take().text;
      const right = comparison();
      left = built(
        { kind: 'binary', op, left, right, id: id++, start: left.start, end: right.end },
        `构造相等性 ${op} 节点。`,
      );
    }
    return left;
  }
  function statement(): Stmt {
    const token = peek();
    if (token.text === 'if' || token.text === 'while') {
      take();
      take('(');
      const condition = equality();
      take(')');
      if (peek().text !== '{') fail('if / while 的主体必须使用花括号语句块。');
      const body = nested(statement);
      if (token.text === 'while')
        return built(
          { kind: 'while', condition, body, id: id++, start: token.start, end: body.end },
          '构造 while：条件每轮都要重新求值。',
        );
      let otherwise: Stmt | undefined;
      if (peek().text === 'else') {
        take();
        if (peek().text !== '{') fail('else 的主体必须使用花括号语句块。');
        otherwise = nested(statement);
      }
      return built(
        {
          kind: 'if',
          condition,
          then: body,
          otherwise,
          id: id++,
          start: token.start,
          end: otherwise?.end ?? body.end,
        },
        '构造 if / else：运行时只选择一条分支。',
      );
    }
    if (token.text === '{') {
      take();
      const body: Stmt[] = [];
      while (peek().text !== '}' && peek().kind !== 'eof') body.push(nested(statement));
      const end = take('}').end;
      return built(
        { kind: 'block', body, id: id++, start: token.start, end },
        '构造语句块；语义阶段会为它建立作用域。',
      );
    }
    if (token.text === 'int' || token.text === 'bool') {
      const dataType = take().text as DataType;
      if (peek().kind !== 'identifier') fail('类型后面需要一个变量名。');
      const name = take().text;
      take('=');
      const init = equality();
      const end = take(';').end;
      return built(
        { kind: 'declare', name, dataType, init, id: id++, start: token.start, end },
        `构造 ${name} 的变量声明。`,
      );
    }
    if (token.text === 'print') {
      take();
      take('(');
      const value = equality();
      take(')');
      const end = take(';').end;
      return built(
        { kind: 'print', value, id: id++, start: token.start, end },
        '构造 print 语句。',
      );
    }
    if (token.kind === 'identifier') {
      const name = take().text;
      take('=');
      const value = equality();
      const end = take(';').end;
      return built(
        { kind: 'assign', name, value, id: id++, start: token.start, end },
        `构造 ${name} 的赋值语句。`,
      );
    }
    return fail(`这里需要声明、赋值、print、if、while 或语句块，实际读到「${token.text}」。`);
  }
  const body: Stmt[] = [];
  while (peek().kind !== 'eof') body.push(statement());
  const ast: Program = { kind: 'program', body, id: id++, start: 0, end: peek().end };
  steps.push({ cursor, nodeId: ast.id, message: '全部 Token 已消费，Program 构建完成。' });
  return { ast, steps };
}
