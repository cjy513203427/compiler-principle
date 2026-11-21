import type { Lesson } from './lessons';

export const MINIMIZATION_REFERENCE = 'https://www.cs.cornell.edu/courses/cs4120/2026sp/notes/leximpl/';
export const minimizationLesson: Lesson = {
  id: 'minimize', number: '14', title: 'DFA 最小化', english: 'DFA minimization',
  question: '两个状态看起来不同，今后的行为也不同吗？',
  intro: '接着正则与自动机实验，把行为相同的 DFA 状态合并。逐步拆分候选组，找出不能合并的最短反例，再用原始与最小化扫描器切同一份输入。',
  chapter: '02', minutes: 18, icon: '≡', color: 'green',
  walkthrough: [
    { title: '先回到子集构造', body: '实验 10 中，一个 DFA 状态对应一组 NFA 状态。两个集合不同，只说明构造过程走过不同的路径；从现在开始能接受哪些后缀，仍可能完全相同。比如 ab|cb，读过 a 或 c 后，接下来都只需要读 b。', example: 'Tok: ab|cb\n%%\nabcb', exampleLanguage: 'regex' },
    { title: '先按现在的输出分组', body: '只判断一种语言时，可以先分接受与拒绝。词法扫描器还要保留 Token 类别，因此本实验按获胜规则编号分组：接受 A 和接受 B 的状态即使都接受，也不能合并。规则顺序和 skip 行为已经包含在获胜规则里。', example: 'A: ab\nB: cb\n%%\nabcb', exampleLanguage: 'regex' },
    { title: '再问：读同一个字符，会去同一组吗？', body: '比较同组状态对每类字符的后继组编号，这串编号叫签名。签名不同，就把这一组拆开。新分组又可能让其他组的签名不同，所以必须反复检查；直到再也拆不开，才得到稳定分组。', example: 'D1 读 b → 接受 Tok 的组\nD0 读 b → 拒绝组\n所以 D1 与 D0 不能在同一组。', exampleLanguage: 'text' },
    { title: '无路可走也需要统一表示', body: '原始图省略了失败边。细化时先把缺失转换补到拒绝状态 Dead，再让它对每个字符回到自身。若 Dead 不能从入口到达，就不加入。最终扫描器继续省略 Dead 类和指向它的边；状态数量会同时说明是否计入这个补全状态。', exampleLanguage: 'text' },
    { title: '用一段后缀证明不能合并', body: '从两个状态同时出发，广度优先搜索状态对；一旦到达不同的输出，就找到了区分后缀。第一次找到的是最短反例。如果不用再读字符就已输出不同规则，反例就是空串 ε。穷尽状态对仍无反例，才说明它们等价。', exampleLanguage: 'text' },
    { title: '最后检查合并有没有改坏扫描器', body: '每个稳定组成为一个新状态。程序独立搜索原始与最小化机器的状态积，校验全部后缀的获胜规则，再实际扫描当前输入，核对 Token 类别、词素、起止位置、skip 和首次失败位置。回退次数和状态编号属于回放细节，不是 Token 语义。' },
  ],
  note: [
    { title: '等价看的是所有后缀', body: '两个状态在当前输入上碰巧得到相同结果，不足以合并。它们必须对所有支持的后缀得到相同的获胜规则或都拒绝。区分后缀可以在完全没有读完当前示例输入的状态中找到。' },
    { title: '分组要同时尊重输出和转换', body: '先按获胜规则分组，再用后继所在组细化到不动点。这里使用便于逐步观察的 Moore 式分割细化，不是 Hopcroft 的工作列表算法；不声明 Hopcroft 的时间复杂度。不可达状态先移除。' },
    { title: '状态变少不等于每个字符少走一步', body: '原始与最小化机器都逐字符查转换表，合并主要减少状态和表格。最长匹配仍需记录最后接受位置并可能回退；关键字与标识符的同长竞争仍由原规则顺序决定。' },
  ],
  misconception: '不能把所有接受状态合并，也不能只看一跳后继是否相同。接受不同 Token 的状态必须分开；一跳相同的候选还可能被更长的后缀区分。最小化也不会消除子集构造阶段已经发生的状态膨胀。',
  limit: '复用实验 10 的规则解析、Thompson 构造、子集构造和最长匹配扫描。对完整、入口可达的 DFA 按获胜规则做分割细化；包含可达隐式 Dead 的完整机稳定分组才用于最小性计数。导出时省略 Dead 类，空语言仍保留入口。字母表限 ASCII 可打印字符与 \\t \\n \\r；最多 8 条规则、每条 80 字符、输入 300 字符、DFA 64 个状态（补全最多多一个 Dead）。构造超限不发布最小化或扫描结果。没有 Hopcroft、Unicode 或最小化 NFA，不保证状态数一定下降。',
  challenge: '先选“相同后缀可以合并”，查询 D1 与 D2，再查询 D0 与 D1，解释为什么后一对不能合并。然后选“不同 Token 不能合并”，说明为什么两个都能接受的终点必须分开。',
  answer: 'ab|cb 读过 a 或 c 后的状态接受相同的后缀 b，所以可合并。入口与读过 a 的状态却可被 b 区分：后者接受 Tok，前者拒绝。规则 A: ab 与 B: cb 的两个终点分别输出 A、B，空串 ε 已能区分它们，因此不能合并。',
  quiz: { question: '两个状态都能接受，是否就能合并？', options: ['能，只要都接受', '不能，还要比较获胜规则与所有后缀的行为', '能，只要这次输入的 Token 相同'], correct: 1, explain: '词法 DFA 的输出包含规则编号；规则不同，空串就能区分它们。即使当前输出相同，也必须继续检查后缀转换行为。' },
};
export const minimizationPresets = [
  { id: 'min-merge', label: '最小化 · 相同后缀可以合并', code: 'Tok: ab|cb\n%%\nabcb', prediction: '读过 a 和 c 后的两个状态，今后需要的输入相同吗？原始 5 个状态能压到几个？' },
  { id: 'min-refine', label: '最小化 · 细化需要继续传播', code: 'Tok: aab|cab\n%%\naabcab', prediction: '按接受与拒绝分组后，为什么还要继续检查第二轮、第三轮？' },
  { id: 'min-rules', label: '最小化 · 不同 Token 不能合并', code: 'A: ab\nB: cb\n%%\nabcb', prediction: '两个终点都接受，但一个输出 A、一个输出 B。空后缀能区分它们吗？' },
  { id: 'min-keyword', label: '最小化 · 规则优先级与 skip', code: 'Int: int\nId: [a-z]+\nskip: \\ +\n%%\nint integer in', prediction: '最小化后 int 仍是 Int 吗？把 Int 与 Id 两行互换又会怎样？' },
  { id: 'min-rollback', label: '最小化 · 最长匹配与回退', code: 'Float: [0-9]+ \\. [0-9]+\nInt: [0-9]+\nDot: \\.\nskip: \\ +\n%%\n3.14 7. 8', prediction: '7. 后面没有数字，最小化后仍会退回并分别生成 Int、Dot 吗？' },
  { id: 'min-error', label: '最小化 · 保留首次失败位置', code: 'Tok: ab|cb\n%%\nabca', prediction: '先成功得到 ab 后，剩下的 ca 无法匹配。两台扫描器应报告哪个起始位置？' },
  { id: 'min-minimal', label: '最小化 · 状态不一定减少', code: 'A: a\n%%\naaa', prediction: '入口和接受状态还能合并吗？最小化是不是一定要删掉至少一个状态？' },
];
