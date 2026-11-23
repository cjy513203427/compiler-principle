import { tokenize } from './lexer';
import { parse } from './parser';
import { analyze } from './semantic';
import { generateIR, optimize, hasControlFlow } from './ir';
import { generateBytecode, execute } from './vm';
import { buildCFG, traceCFG } from './cfg';
import { analyzeConstants, analyzeLiveness } from './dataflow';
import { analyzeDominance } from './dominance';
import { buildSSA } from './ssa';
import { lowerSSA } from './outssa';
import { allocateRegisters, sweepRegisters, type RegisterSettings } from './regalloc';
import { scheduleAllocation, sweepSchedules } from './schedule';
import { analyzeRedundancy } from './redundancy';
import { CompileError, type Diagnostic, type OptimizationOptions } from './model';
export * from './model';
export { tokenize, parse, analyze, generateIR, optimize, generateBytecode, execute };

export function compile(source: string, options: OptimizationOptions, settings: { outOfSSA?: boolean; registers?: RegisterSettings; schedule?: boolean; redundancy?: boolean } = {}) {
  let lex: ReturnType<typeof tokenize> | undefined;
  let syntax: ReturnType<typeof parse> | undefined;
  let semantic: ReturnType<typeof analyze> | undefined;
  let ir: ReturnType<typeof generateIR> | undefined;
  let optimization: ReturnType<typeof optimize> | undefined;
  let bytecode: ReturnType<typeof generateBytecode> | undefined;
  let execution: ReturnType<typeof execute> | undefined;
  let baseline: ReturnType<typeof execute> | undefined;
  let diagnostic: Diagnostic | undefined;
  let cfg: ReturnType<typeof buildCFG> | undefined;
  let controlTrace: ReturnType<typeof traceCFG> | undefined;
  let baselineBytecode: ReturnType<typeof generateBytecode> | undefined;
  let dataflow: ReturnType<typeof analyzeConstants> | undefined;
  let liveness: ReturnType<typeof analyzeLiveness> | undefined;
  let dominance: ReturnType<typeof analyzeDominance> | undefined;
  let ssa: ReturnType<typeof buildSSA> | undefined;
  let outssa: ReturnType<typeof lowerSSA> | undefined;
  let regalloc: ReturnType<typeof allocateRegisters> | undefined;
  let registerSweep: ReturnType<typeof sweepRegisters> | undefined;
  let schedule: ReturnType<typeof scheduleAllocation> | undefined;
  let scheduleSweep: ReturnType<typeof sweepSchedules> | undefined;
  let redundancy: ReturnType<typeof analyzeRedundancy> | undefined;
  try {
    lex = tokenize(source);
    syntax = parse(lex.tokens);
    semantic = analyze(syntax.ast);
    ir = generateIR(syntax.ast, semantic);
    dataflow = analyzeConstants(ir);
    liveness = analyzeLiveness(ir);
    optimization = optimize(ir, options, dataflow);
    bytecode = generateBytecode(optimization.at(-1)!.instructions);
    execution = execute(bytecode);
    baselineBytecode = generateBytecode(ir);
    baseline = execute(baselineBytecode);
    cfg = buildCFG(ir);
    dominance = analyzeDominance(cfg);
    ssa = buildSSA(dominance, liveness);
    if (settings.outOfSSA) outssa = lowerSSA(ssa, dominance);
    if (settings.redundancy) redundancy = analyzeRedundancy(ir, dominance);
    if (settings.registers) {
      // Allocate the unoptimized IR so every temporary and its pressure stays visible.
      regalloc = allocateRegisters(ir, dominance, settings.registers);
      if (settings.schedule) {
        schedule = scheduleAllocation(regalloc);
        scheduleSweep = sweepSchedules(ir, dominance, settings.registers.algorithm, baseline);
      } else registerSweep = sweepRegisters(ir, dominance, baseline);
    }
    controlTrace = traceCFG(cfg, baselineBytecode, baseline);
    if (execution.error)
      diagnostic = { stage: 'vm', message: execution.error.message, start: 0, end: 0 };
    else if (execution.limited)
      diagnostic = {
        stage: 'vm',
        message:
          '达到 2000 条指令的回放上限，已暂停执行。请缩小循环次数，或检查循环条件和变量更新。',
        start: 0,
        end: 0,
      };
  } catch (error) {
    if (error instanceof CompileError) diagnostic = error.diagnostic;
    else throw error;
  }
  return {
    lex,
    syntax,
    semantic,
    ir,
    optimization,
    bytecode,
    execution,
    baseline,
    diagnostic,
    cfg,
    controlTrace,
    baselineBytecode,
    dataflow,
    liveness,
    dominance,
    ssa,
    outssa,
    regalloc,
    registerSweep,
    schedule,
    scheduleSweep,
    redundancy,
    hasControlFlow: ir ? hasControlFlow(ir) : false,
  };
}
export type Compilation = ReturnType<typeof compile>;
