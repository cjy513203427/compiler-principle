import { tokenize } from './lexer';
import { parse } from './parser';
import { analyze } from './semantic';
import { generateIR, optimize } from './ir';
import { generateBytecode, execute } from './vm';
import { CompileError, type Diagnostic, type OptimizationOptions } from './model';
export * from './model';
export { tokenize, parse, analyze, generateIR, optimize, generateBytecode, execute };

export function compile(source: string, options: OptimizationOptions) {
  let lex: ReturnType<typeof tokenize> | undefined;
  let syntax: ReturnType<typeof parse> | undefined;
  let semantic: ReturnType<typeof analyze> | undefined;
  let ir: ReturnType<typeof generateIR> | undefined;
  let optimization: ReturnType<typeof optimize> | undefined;
  let bytecode: ReturnType<typeof generateBytecode> | undefined;
  let execution: ReturnType<typeof execute> | undefined;
  let baseline: ReturnType<typeof execute> | undefined;
  let diagnostic: Diagnostic | undefined;
  try {
    lex = tokenize(source);
    syntax = parse(lex.tokens);
    semantic = analyze(syntax.ast);
    ir = generateIR(syntax.ast, semantic);
    optimization = optimize(ir, options);
    bytecode = generateBytecode(optimization.at(-1)!.instructions);
    execution = execute(bytecode);
    baseline = execute(generateBytecode(ir));
    if (execution.error)
      diagnostic = { stage: 'vm', message: execution.error.message, start: 0, end: 0 };
  } catch (error) {
    if (error instanceof CompileError) diagnostic = error.diagnostic;
    else throw error;
  }
  return { lex, syntax, semantic, ir, optimization, bytecode, execution, baseline, diagnostic };
}
export type Compilation = ReturnType<typeof compile>;
