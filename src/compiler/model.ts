export type Stage = 'lex' | 'parse' | 'semantic' | 'ir' | 'optimize' | 'vm' | 'cfg';
export type Value = number | boolean;
export type DataType = 'int' | 'bool';
export type TokenKind = 'keyword' | 'identifier' | 'number' | 'operator' | 'punctuation' | 'eof';
export interface Token {
  kind: TokenKind;
  text: string;
  start: number;
  end: number;
}
export interface NodeBase {
  id: number;
  start: number;
  end: number;
}
export type Expr =
  | (NodeBase & { kind: 'literal'; value: Value })
  | (NodeBase & { kind: 'identifier'; name: string })
  | (NodeBase & { kind: 'binary'; op: string; left: Expr; right: Expr })
  | (NodeBase & { kind: 'unary'; operand: Expr });
export type Stmt =
  | (NodeBase & { kind: 'declare'; name: string; dataType: DataType; init: Expr })
  | (NodeBase & { kind: 'assign'; name: string; value: Expr })
  | (NodeBase & { kind: 'print'; value: Expr })
  | (NodeBase & { kind: 'block'; body: Stmt[] })
  | (NodeBase & { kind: 'if'; condition: Expr; then: Stmt; otherwise?: Stmt })
  | (NodeBase & { kind: 'while'; condition: Expr; body: Stmt });
export interface Program extends NodeBase {
  kind: 'program';
  body: Stmt[];
}
export type AstNode = Program | Stmt | Expr;
export interface ScanStep {
  position: number;
  state: 'start' | 'identifier' | 'number' | 'symbol' | 'comment';
  message: string;
  emitted: number;
}
export interface ParseStep {
  cursor: number;
  message: string;
  nodeId?: number;
}
export interface SymbolEntry {
  key: string;
  name: string;
  type: DataType;
  scope: number;
  declaration: number;
}
export interface SemanticStep {
  message: string;
  nodeId: number;
  scopes: number[];
  symbols: SymbolEntry[];
  selected?: string;
}
export interface Analysis {
  symbols: SymbolEntry[];
  references: Map<number, string>;
  steps: SemanticStep[];
  types: Map<number, DataType>;
}
export type Operand = { kind: 'constant'; value: Value } | { kind: 'ref'; name: string };
export type Instruction =
  | { op: 'move'; dest: string; value: Operand; nodeId: number }
  | { op: 'binary'; dest: string; operator: string; left: Operand; right: Operand; nodeId: number }
  | { op: 'print'; value: Operand; nodeId: number }
  | { op: 'label'; name: string; nodeId: number }
  | { op: 'jump'; target: string; nodeId: number }
  | { op: 'branch'; condition: Operand; target: string; nodeId: number };
export type ValueInstruction = Extract<Instruction, { op: 'move' | 'binary' | 'print' }>;
export interface OptimizationOptions {
  fold: boolean;
  propagate: boolean;
  dead: boolean;
}
export interface OptimizationStep {
  title: string;
  detail: string;
  instructions: Instruction[];
}
export type Bytecode = (
  | { op: 'PUSH'; value: Value }
  | { op: 'LOAD' | 'STORE' | 'LABEL'; name: string }
  | { op: 'JUMP' | 'BR_FALSE'; target: number }
  | {
      op:
        'ADD' | 'SUB' | 'MUL' | 'DIV' | 'LT' | 'LE' | 'GT' | 'GE' | 'EQ' | 'NE' | 'PRINT' | 'HALT';
    }
) & { irIndex?: number };
export interface VmStep {
  pc: number;
  nextPc: number;
  message: string;
  stack: Value[];
  memory: Record<string, Value>;
  output: Value[];
  condition?: boolean;
}
export interface Diagnostic {
  stage: Stage;
  message: string;
  start: number;
  end: number;
}
export class CompileError extends Error {
  constructor(public diagnostic: Diagnostic) {
    super(diagnostic.message);
  }
}
export const constant = (value: Value): Operand => ({ kind: 'constant', value });
export const reference = (name: string): Operand => ({ kind: 'ref', name });
export function children(node: AstNode): AstNode[] {
  switch (node.kind) {
    case 'program':
    case 'block':
      return node.body;
    case 'declare':
      return [node.init];
    case 'if':
      return [node.condition, node.then, ...(node.otherwise ? [node.otherwise] : [])];
    case 'while':
      return [node.condition, node.body];
    case 'assign':
    case 'print':
      return [node.value];
    case 'binary':
      return [node.left, node.right];
    case 'unary':
      return [node.operand];
    default:
      return [];
  }
}
export function nodeLabel(node: AstNode): string {
  switch (node.kind) {
    case 'program':
      return 'Program';
    case 'block':
      return 'Block';
    case 'declare':
      return `${node.dataType} ${node.name}`;
    case 'assign':
      return `${node.name} =`;
    case 'print':
      return 'print';
    case 'if':
      return 'if / else';
    case 'while':
      return 'while';
    case 'binary':
      return node.op;
    case 'unary':
      return '− (unary)';
    case 'identifier':
      return node.name;
    case 'literal':
      return String(node.value);
  }
}
