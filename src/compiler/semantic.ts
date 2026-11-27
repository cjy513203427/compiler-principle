import { T } from '../i18n';
import {
  CompileError,
  type AstNode,
  type Program,
  type Expr,
  type Stmt,
  type Analysis,
  type SymbolEntry,
  type DataType,
} from './model';

export function analyze(ast: Program): Analysis {
  const result: Analysis = { symbols: [], references: new Map(), steps: [], types: new Map() };
  let nextScope = 1;
  const scopes: { id: number; symbols: Map<string, SymbolEntry> }[] = [
    { id: 0, symbols: new Map() },
  ];
  const fail = (node: AstNode, message: string): never => {
    throw new CompileError({ stage: 'semantic', start: node.start, end: node.end, message });
  };
  const record = (node: AstNode, message: string, selected?: string) =>
    result.steps.push({
      nodeId: node.id,
      message,
      selected,
      scopes: scopes.map((s) => s.id),
      symbols: scopes.flatMap((s) => [...s.symbols.values()]),
    });
  const lookup = (node: AstNode, name: string): SymbolEntry => {
    for (let i = scopes.length - 1; i >= 0; i--) {
      const symbol = scopes[i].symbols.get(name);
      if (symbol) {
        result.references.set(node.id, symbol.key);
        record(
          node,
          T('从内向外查找 {#0}，绑定到作用域 S{#1} 的 {#2}。', name, symbol.scope, symbol.key),
          symbol.key,
        );
        return symbol;
      }
    }
    return fail(node, T('变量「{#0}」尚未声明，或已离开它的作用域。', name));
  };
  function expression(node: Expr): DataType {
    let type: DataType;
    if (node.kind === 'literal') type = typeof node.value === 'number' ? 'int' : 'bool';
    else if (node.kind === 'identifier') type = lookup(node, node.name).type;
    else if (node.kind === 'binary' && ['==', '!=', '<', '<=', '>', '>='].includes(node.op)) {
      const left = expression(node.left);
      const right = expression(node.right);
      if (node.op === '==' || node.op === '!=') {
        if (left !== right) fail(node, T('相等性比较两侧必须具有相同类型。'));
      } else if (left !== 'int' || right !== 'int') fail(node, T('大小比较的操作数必须是 int。'));
      type = 'bool';
    } else {
      const types =
        node.kind === 'unary'
          ? [expression(node.operand)]
          : [expression(node.left), expression(node.right)];
      if (types.some((t) => t !== 'int'))
        fail(node, T('算术运算的操作数必须是 int；本语言不把 bool 自动转换成 int。'));
      type = 'int';
    }
    result.types.set(node.id, type);
    record(node, T('节点类型为 {#0}，把类型信息标注到 AST。', type));
    return type;
  }
  function statement(node: Stmt) {
    if (node.kind === 'if' || node.kind === 'while') {
      if (expression(node.condition) !== 'bool')
        fail(node.condition, T('if / while 的条件必须是 bool；整数不会自动转换成布尔值。'));
      record(node, T('条件类型检查通过。静态检查会遍历全部分支，执行时才选择实际路径。'));
      if (node.kind === 'if') {
        statement(node.then);
        if (node.otherwise) statement(node.otherwise);
      } else statement(node.body);
    } else if (node.kind === 'block') {
      scopes.push({ id: nextScope++, symbols: new Map() });
      record(node, T('进入语句块，创建新的词法作用域。'));
      node.body.forEach(statement);
      scopes.pop();
      record(node, T('退出语句块，内部声明不再可见。'));
    } else if (node.kind === 'declare') {
      const scope = scopes.at(-1)!;
      if (scope.symbols.has(node.name)) fail(node, T('同一作用域中重复声明「{#0}」。', node.name));
      const type = expression(node.init);
      if (type !== node.dataType)
        fail(node, T('不能用 {#0} 初始化 {#1} 变量「{#2}」。', type, node.dataType, node.name));
      const symbol = {
        key: `v${result.symbols.length}_${node.name}`,
        name: node.name,
        type,
        scope: scope.id,
        declaration: node.id,
      };
      scope.symbols.set(node.name, symbol);
      result.symbols.push(symbol);
      result.references.set(node.id, symbol.key);
      record(node, T('声明 {#0}: {#1}；初始化完成后进入 S{#2}。', node.name, type, scope.id), symbol.key);
    } else if (node.kind === 'assign') {
      const symbol = lookup(node, node.name);
      const type = expression(node.value);
      if (type !== symbol.type)
        fail(node, T('不能把 {#0} 赋给 {#1} 变量「{#2}」。', type, symbol.type, node.name));
      record(node, T('赋值类型检查通过：{#0} ← {#1}。', symbol.type, type), symbol.key);
    } else {
      expression(node.value);
      record(node, T('print 的参数检查完成。'));
    }
  }
  record(ast, T('进入全局作用域 S0。'));
  ast.body.forEach(statement);
  record(ast, T('名称消解与类型检查全部通过。'));
  return result;
}
