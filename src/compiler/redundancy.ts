import { T } from '../i18n';
import { buildCFG, type ControlFlowGraph } from './cfg';
import { analyzeLiveness, referencedVariables, MAX_ANALYSIS_PASSES } from './dataflow';
import { analyzeDominance, type DominanceAnalysis } from './dominance';
import { instructionText, operandText } from './ir';
import { evaluateBinary } from './operations';
import { execute, generateBytecode, type Execution } from './vm';
import type { Bytecode, Instruction, Operand } from './model';

const COMMUTATIVE = new Set(['+', '*', '==', '!=']);
const NON_TRAPPING = new Set(['<', '<=', '>', '>=', '==', '!=']);
type Binary = Extract<Instruction, { op: 'binary' }>;
/** Syntactic key: same operator and same operand names/constants; commutative operands are sorted. */
export function expressionKey(instruction: Binary): string {
  let left = operandText(instruction.left), right = operandText(instruction.right);
  if (COMMUTATIVE.has(instruction.operator) && left > right) [left, right] = [right, left];
  return `${left} ${instruction.operator} ${right}`;
}
const destOf = (instruction: Instruction) => 'dest' in instruction ? instruction.dest : undefined;
/** Overflow and division by zero are runtime errors here; comparisons of typed ints cannot fail. */
export function mayTrap(instruction: Instruction): boolean {
  if (instruction.op !== 'binary' || NON_TRAPPING.has(instruction.operator)) return false;
  if (instruction.left.kind === 'constant' && instruction.right.kind === 'constant') {
    try { evaluateBinary(instruction.operator, instruction.left.value, instruction.right.value); return false; } catch { return true; }
  }
  return true;
}

/** Forward must-analysis over the CFG; facts are strings, merges intersect all predecessors. */
type Transfer = (index: number, facts: Set<string>) => void;
export interface AvailableStep { pass: number; block: string; input: string[]; output: string[]; changed: boolean }
export interface AvailableAnalysis {
  graph: ControlFlowGraph;
  input: Record<string, string[]>;
  output: Record<string, string[]>;
  steps: AvailableStep[];
  iterations: number;
  converged: boolean;
}
function solveForwardMust(graph: ControlFlowGraph, universe: string[], transfer: Transfer): AvailableAnalysis {
  const entry = graph.blocks[0].id;
  const input: Record<string, Set<string>> = {}, output: Record<string, Set<string>> = {};
  for (const block of graph.blocks) { input[block.id] = new Set(); output[block.id] = new Set(block.id === entry ? [] : universe); }
  const steps: AvailableStep[] = [];
  let iterations = 0, converged = false;
  for (let pass = 1; pass <= MAX_ANALYSIS_PASSES; pass++) {
    iterations = pass;
    let changedPass = false;
    for (const block of graph.blocks) {
      const predecessors = graph.edges.filter((edge) => edge.to === block.id).map((edge) => output[edge.from]);
      const nextIn = block.id === entry || !predecessors.length ? new Set<string>()
        : new Set([...predecessors[0]].filter((fact) => predecessors.every((set) => set.has(fact))));
      const nextOut = new Set(nextIn);
      for (let index = block.start; index < block.end; index++) transfer(index, nextOut);
      const changed = nextIn.size !== input[block.id].size || nextOut.size !== output[block.id].size ||
        [...nextOut].some((fact) => !output[block.id].has(fact));
      input[block.id] = nextIn;
      output[block.id] = nextOut;
      if (changed) changedPass = true;
      if (steps.length < 240) steps.push({ pass, block: block.id, input: [...nextIn].sort(), output: [...nextOut].sort(), changed });
    }
    if (!changedPass) { converged = true; break; }
  }
  const sorted = (record: Record<string, Set<string>>) =>
    Object.fromEntries(Object.entries(record).map(([id, set]) => [id, [...set].sort()]));
  return { graph, input: sorted(input), output: sorted(output), steps, iterations, converged };
}
/** Expression e is available: computed on every path, operands unchanged since. */
function keyTransfer(code: Instruction[]): Transfer {
  const operands = new Map<string, string[]>();
  code.forEach((instruction) => { if (instruction.op === 'binary') operands.set(expressionKey(instruction), referencedVariables(instruction)); });
  return (index, facts) => {
    const instruction = code[index];
    const dest = destOf(instruction);
    if (!dest) return;
    for (const key of [...facts]) if (operands.get(key)?.includes(dest)) facts.delete(key);
    if (instruction.op === 'binary' && !referencedVariables(instruction).includes(dest)) facts.add(expressionKey(instruction));
  };
}
/** Instruction K is available: its dest still holds the value of its expression. */
function computationTransfer(code: Instruction[]): Transfer {
  return (index, facts) => {
    const instruction = code[index];
    const dest = destOf(instruction);
    if (!dest) return;
    for (const fact of [...facts]) {
      const computed = code[Number(fact)] as Binary;
      if (computed.dest === dest || referencedVariables(computed).includes(dest)) facts.delete(fact);
    }
    if (instruction.op === 'binary' && !referencedVariables(instruction).includes(dest)) facts.add(String(index));
  };
}
export function analyzeAvailable(code: Instruction[]): AvailableAnalysis {
  const keys = [...new Set(code.flatMap((instruction) => instruction.op === 'binary' ? [expressionKey(instruction)] : []))];
  return solveForwardMust(buildCFG(code), keys, keyTransfer(code));
}

export interface CseReplacement { index: number; key: string; source?: number; holder: string; before: string; after: string }
export function eliminateCommonSubexpressions(code: Instruction[], available: AvailableAnalysis): { code: Instruction[]; replacements: CseReplacement[]; saved: Record<string, string> } {
  const graph = available.graph;
  const computations = solveForwardMust(graph, code.flatMap((instruction, index) => instruction.op === 'binary' ? [String(index)] : []), computationTransfer(code));
  const byKey = keyTransfer(code), byComputation = computationTransfer(code);
  const result = code.map((instruction) => ({ ...instruction }));
  const replacements: CseReplacement[] = [];
  const used = new Set(code.flatMap((instruction) => [...referencedVariables(instruction), ...(destOf(instruction) ? [destOf(instruction)!] : [])]));
  const saved: Record<string, string> = {};
  let counter = 0;
  const saveFor = (key: string) => {
    if (!saved[key]) { let name: string; do { name = `cse${counter++}`; } while (used.has(name)); used.add(name); saved[key] = name; }
    return saved[key];
  };
  for (const block of graph.blocks) {
    const keys = new Set(available.input[block.id]);
    const instances = new Set(computations.input[block.id]);
    for (let index = block.start; index < block.end; index++) {
      const instruction = code[index];
      if (instruction.op === 'binary' && keys.has(expressionKey(instruction))) {
        const key = expressionKey(instruction);
        const direct = [...instances].map(Number).sort((a, b) => a - b).find((fact) => expressionKey(code[fact] as Binary) === key);
        const holder = direct !== undefined ? (code[direct] as Binary).dest : saveFor(key);
        result[index] = { op: 'move', dest: instruction.dest, value: { kind: 'ref', name: holder }, nodeId: instruction.nodeId };
        replacements.push({ index, key, source: direct, holder, before: instructionText(instruction), after: instructionText(result[index]) });
      }
      byKey(index, keys);
      byComputation(index, instances);
    }
  }
  // Every computation of a saved expression also stores its result, so the latest one on any path is in the holder.
  const output: Instruction[] = [];
  code.forEach((instruction, index) => {
    output.push(result[index]);
    if (instruction.op !== 'binary') return;
    const holder = saved[expressionKey(instruction)];
    const replacement = result[index];
    if (holder && !(replacement.op === 'move' && replacement.value.kind === 'ref' && replacement.value.name === holder))
      output.push({ op: 'move', dest: holder, value: { kind: 'ref', name: instruction.dest }, nodeId: instruction.nodeId });
  });
  return { code: output, replacements, saved };
}

export interface LoopReport {
  header: string;
  label: string;
  blocks: string[];
  hoistable: boolean;
  reason?: string;
  decisions: { text: string; status: 'hoisted' | 'trap' | 'blocked' | 'variant'; reason: string }[];
  hoisted: string[];
}
const isOperandInvariant = (operand: Operand, definedInLoop: Set<string>, invariant: Set<string>) =>
  operand.kind === 'constant' || !definedInLoop.has(operand.name) || invariant.has(operand.name);
const operandsOf = (instruction: Instruction): Operand[] =>
  instruction.op === 'binary' ? [instruction.left, instruction.right] : instruction.op === 'move' ? [instruction.value] : [];

function hoistLoop(code: Instruction[], label: string): { code: Instruction[]; report: LoopReport } | undefined {
  const graph = buildCFG(code);
  const dominance = analyzeDominance(graph);
  const headerIndex = code.findIndex((instruction) => instruction.op === 'label' && instruction.name === label);
  const header = graph.instructionBlock[headerIndex];
  const loop = dominance.loops.find((item) => item.header === header);
  if (!loop) return undefined;
  const report: LoopReport = { header, label, blocks: loop.nodes, hoistable: false, decisions: [], hoisted: [] };
  const outside = graph.edges.filter((edge) => edge.to === header && !loop.nodes.includes(edge.from));
  const previous = graph.blocks.find((block) => block.end === headerIndex);
  if (outside.length !== 1 || !previous || outside[0].from !== previous.id || !['next', 'true'].includes(outside[0].kind)) {
    report.reason = T('循环头不是只从前一个块顺序进入，没有安全的位置放外提代码，跳过。');
    return { code, report };
  }
  report.hoistable = true;
  const inLoop = code.map((_, index) => loop.nodes.includes(graph.instructionBlock[index]));
  const definitions = new Map<string, number>();
  code.forEach((instruction) => { const dest = destOf(instruction); if (dest) definitions.set(dest, (definitions.get(dest) ?? 0) + 1); });
  const definedInLoop = new Set(code.flatMap((instruction, index) => inLoop[index] && destOf(instruction) ? [destOf(instruction)!] : []));
  const liveAtHeader = new Set(analyzeLiveness(code).input[header] ?? []);
  const hoisted = new Set<number>();
  const hoistedNames = new Set<string>();
  let blockedTrap = false; // an earlier trapping header instruction stayed in place
  for (let index = 0; index < code.length; index++) {
    const instruction = code[index];
    if (!inLoop[index] || (instruction.op !== 'binary' && instruction.op !== 'move')) continue;
    const text = instructionText(instruction);
    const inHeader = graph.instructionBlock[index] === header;
    const variant = operandsOf(instruction).find((operand) => !isOperandInvariant(operand, definedInLoop, hoistedNames));
    const record = (status: LoopReport['decisions'][number]['status'], reason: string) => {
      report.decisions.push({ text, status, reason });
      if (inHeader && mayTrap(instruction) && status !== 'hoisted') blockedTrap = true;
    };
    if (variant && variant.kind === 'ref') { record('variant', T('{#0} 在循环内被改写，每轮的值可能不同。', variant.name)); continue; }
    if (definitions.get(instruction.dest) !== 1) { record('blocked', T('{#0} 有多处赋值，搬走其中一处会改变其他路径看到的值。', instruction.dest)); continue; }
    if (liveAtHeader.has(instruction.dest)) { record('blocked', T('进入循环头时 {#0} 的旧值还会被读取。', instruction.dest)); continue; }
    if (mayTrap(instruction)) {
      if (!inHeader) { record('trap', T('不变，但可能溢出或除零。它在循环体里，零轮循环时不会执行，也可能排在 print 之后；外提会凭空报错或改变输出顺序。')); continue; }
      if (blockedTrap) { record('trap', T('不变，但循环条件里更早的可能报错的计算留在原处；外提它会改变报错的先后。')); continue; }
    }
    hoisted.add(index);
    hoistedNames.add(instruction.dest);
    report.hoisted.push(text);
    report.decisions.push({ text, status: 'hoisted', reason: inHeader
      ? T('位于循环条件的计算里：每次进入循环都会先执行它，且操作数不变；提前到循环前只算一次。')
      : T('操作数不变且不会报错：即使循环零轮，提前算一次也不改变输出与错误。') });
  }
  if (!hoisted.size) return { code, report };
  const moved = code.filter((_, index) => hoisted.has(index));
  const rest = code.filter((_, index) => !hoisted.has(index));
  const at = rest.findIndex((instruction) => instruction.op === 'label' && instruction.name === label);
  return { code: [...rest.slice(0, at), ...moved, ...rest.slice(at)], report };
}

export interface ValueNumberFinding { block: string; index: number; text: string; equalTo: string; cse: boolean }
/** Local value numbering on the original IR: equal values even when spelled differently. Analysis only. */
export function localValueNumbering(code: Instruction[], graph: ControlFlowGraph, cseIndices: Set<number>): ValueNumberFinding[] {
  const findings: ValueNumberFinding[] = [];
  for (const block of graph.blocks) {
    const numberOf = new Map<string, number>();
    const byKey = new Map<string, number>();
    const holders = new Map<number, Set<string>>();
    let next = 0;
    const valueOf = (operand: Operand) => {
      const key = operand.kind === 'constant' ? `#${String(operand.value)}` : operand.name;
      if (!numberOf.has(key)) { numberOf.set(key, next); holders.set(next, new Set(operand.kind === 'ref' ? [operand.name] : [])); next++; }
      return numberOf.get(key)!;
    };
    const assign = (dest: string, value: number) => {
      const old = numberOf.get(dest);
      if (old !== undefined) holders.get(old)?.delete(dest);
      numberOf.set(dest, value);
      holders.get(value)!.add(dest);
    };
    for (let index = block.start; index < block.end; index++) {
      const instruction = code[index];
      if (instruction.op === 'move') assign(instruction.dest, valueOf(instruction.value));
      else if (instruction.op === 'binary') {
        let left = valueOf(instruction.left), right = valueOf(instruction.right);
        if (COMMUTATIVE.has(instruction.operator) && left > right) [left, right] = [right, left];
        const key = `${left}${instruction.operator}${right}`;
        const known = byKey.get(key);
        const holder = known === undefined ? undefined : [...holders.get(known)!].find((name) => name !== instruction.dest);
        if (known !== undefined && holder) {
          findings.push({ block: block.id, index, text: instructionText(instruction), equalTo: holder, cse: cseIndices.has(index) });
          assign(instruction.dest, known);
        } else {
          const value = next++;
          holders.set(value, new Set());
          byKey.set(key, value);
          assign(instruction.dest, value);
        }
      }
    }
  }
  return findings;
}

export interface RedundancyFrame {
  kind: 'initial' | 'available' | 'cse' | 'loop' | 'decision' | 'execute' | 'complete';
  step?: number;
  replacement?: number;
  loop?: number;
  decision?: number;
  message: string;
}
export interface RedundancyRun { bytecode: Bytecode[]; execution: Execution; operations: number }
export interface RedundancyAnalysis {
  valid: boolean;
  issues: string[];
  available: AvailableAnalysis;
  replacements: CseReplacement[];
  saved: Record<string, string>;
  afterCse: Instruction[];
  loops: LoopReport[];
  afterLicm: Instruction[];
  valueNumbers: ValueNumberFinding[];
  runs?: { original: RedundancyRun; cse: RedundancyRun; licm: RedundancyRun };
  frames: RedundancyFrame[];
  traceTruncated: boolean;
}
const OPERATIONS = new Set(['ADD', 'SUB', 'MUL', 'DIV', 'LT', 'LE', 'GT', 'GE', 'EQ', 'NE']);
function run(code: Instruction[]): RedundancyRun {
  const bytecode = generateBytecode(code);
  const execution = execute(bytecode);
  const operations = execution.steps.filter((step) => step.pc >= 0 && OPERATIONS.has(bytecode[step.pc]?.op)).length;
  return { bytecode, execution, operations };
}
const factText = (facts: string[]) => facts.join(T('；')) || '∅';

export function analyzeRedundancy(ir: Instruction[], dominance: DominanceAnalysis): RedundancyAnalysis {
  const available = analyzeAvailable(ir);
  const result: RedundancyAnalysis = { valid: false, issues: [], available, replacements: [], saved: {}, afterCse: ir, loops: [], afterLicm: ir,
    valueNumbers: [], frames: [], traceTruncated: false };
  const push = (frame: RedundancyFrame) => {
    if (result.frames.length < 240) result.frames.push(frame);
    else result.traceTruncated = true;
  };
  const fail = (message: string) => { result.issues.push(message); result.frames.push({ kind: 'complete', message }); return result; };
  push({ kind: 'initial', message: T('从原始三地址代码出发（{#0} 条）。先求“可用表达式”：在每个位置，哪些计算结果仍然有效，由哪个临时值保存。', ir.length) });
  if (!available.converged || !dominance.converged) return fail(T('可用表达式或支配分析没有收敛，保留原始 IR。'));
  available.steps.forEach((step, index) => push({ kind: 'available', step: index,
    message: T('第 {#0} 轮处理 {#1}：IN 取所有前驱 OUT 的交集（每条路径都算过才算可用）。OUT = {#2}。', step.pass, step.block, factText(step.output)) }));
  const cse = eliminateCommonSubexpressions(ir, available);
  result.replacements = cse.replacements;
  result.saved = cse.saved;
  result.afterCse = cse.code;
  cse.replacements.forEach((item, index) => push({ kind: 'cse', replacement: index, message: item.source !== undefined
    ? T('#{#0} 要算 {#1}。到这里每条路径上 #{#2} 的结果 {#3} 都仍然有效：改为 {#4}。', item.index, item.key, item.source, item.holder, item.after)
    : T('#{#0} 要算 {#1}。每条路径都算过它，但由不同指令算出、存在不同临时值里：新建 {#2}，在每次计算 {#1} 之后保存结果，这里改为 {#3}。', item.index, item.key, item.holder, item.after) }));
  if (!cse.replacements.length) push({ kind: 'cse', message: T('没有找到在所有路径上都已算过的同一表达式，公共子表达式消除不改动代码。') });
  const labels = dominance.loops.slice().sort((a, b) => a.nodes.length - b.nodes.length).map((loop) => {
    const block = dominance.graph.blocks.find((item) => item.id === loop.header)!;
    const first = ir[block.start];
    return first?.op === 'label' ? first.name : undefined;
  }).filter((label): label is string => !!label);
  let code = cse.code;
  for (const label of labels) {
    const outcome = hoistLoop(code, label);
    if (!outcome) continue;
    code = outcome.code;
    const loopIndex = result.loops.push(outcome.report) - 1;
    push({ kind: 'loop', loop: loopIndex, message: outcome.report.reason
      ? T('循环 {#0}：{#1}', label, outcome.report.reason)
      : T('循环 {#0}（{#1}）：外提代码放在循环头之前，只在进入循环时执行一次。逐条判断循环里的计算是否不变、能否安全外提。', label, outcome.report.blocks.join(T('、'))) });
    outcome.report.decisions.forEach((decision, index) => push({ kind: 'decision', loop: loopIndex, decision: index,
      message: T('{#0}：{#1}', decision.text, decision.reason) }));
  }
  result.afterLicm = code;
  if (!dominance.loops.length) push({ kind: 'loop', message: T('程序没有自然循环，不做循环不变代码外提。') });
  const entryLive = (instructions: Instruction[]) => analyzeLiveness(instructions).input[buildCFG(instructions).blocks[0].id] ?? [];
  const before = entryLive(ir).join(','), after = entryLive(code).join(',');
  if (before !== after) return fail(T('优化后入口处出现了未定义就读取的值（{#0}），撤销结果。', after));
  result.valueNumbers = localValueNumbering(ir, available.graph, new Set(cse.replacements.map((item) => item.index)));
  result.runs = { original: run(ir), cse: run(cse.code), licm: run(code) };
  result.valid = true;
  const { original, licm } = result.runs;
  result.frames.push({ kind: 'execute', message: T('三个版本都交给原栈式 VM 执行：原始 {#0} 次运算，公共子表达式消除后 {#1} 次，再外提后 {#2} 次。', original.operations, result.runs.cse.operations, licm.operations) });
  result.frames.push({ kind: 'complete', message: licm.execution.limited || original.execution.limited
    ? T('至少一个版本达到 2000 条字节码上限；只比较输出前缀，不能判定行为一致。')
    : T('执行结束，可以对照输出、报错和运算次数。') });
  return result;
}
