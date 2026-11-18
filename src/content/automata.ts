import type { Lesson } from './lessons';

export const REGEX_REFERENCE = 'https://swtch.com/~rsc/regexp/regexp1.html';
export const automataLesson: Lesson = {
  id: 'automata',
  number: '10',
  title: '正则与自动机',
  english: 'Regex → NFA → DFA',
  question: '只写词法规则，扫描器能自动生成吗？',
  intro:
    '把每条“名称: 正则”机械地翻译成 NFA，用子集构造得到 DFA，再按最长匹配扫描输入。交换两条规则的顺序，或让规则能匹配空串，看看结果怎样变化。',
  chapter: '02',
  minutes: 18,
  icon: 'ε',
  color: 'blue',
  note: [
    {
      title: '正则可以机械地翻译成 NFA',
      body: '字符 i 是一条 i → f 的边；s|t 先用 ε 分叉，再用 ε 汇合；st 把 s 的结束状态与 t 的开始状态合二为一；s* 既能经 ε 跳过，也能从结尾回到开头重复；s+ 没有跳过的边，至少走一遍；s? 只能跳过或走一遍。多条规则各自从总开始状态经 ε 进入，结束状态标上规则名。',
    },
    {
      title: 'NFA 要试探，DFA 只走一条路',
      body: 'NFA 的某个状态对同一个输入可能有多条路，还可能有不读字符的 ε 边。回溯实现先试一条，失败后退回分叉处再试别的，极端情况下尝试次数会指数增长。子集构造把“读完当前前缀后，NFA 可能所在的全部状态”合成一个 DFA 状态：先求 ε-闭包，再对每类输入求 move 和闭包。匹配时每个字符只查一次表，代价转移到了构造阶段，有些正则会让 DFA 状态成倍增加。',
    },
    {
      title: '多条规则：最长匹配，再看优先级',
      body: '扫描器一直向前读，记住最近一次到达接受状态的位置；无路可走时回到那里生成 Token，多读的字符退回输入。如果同一个 DFA 状态包含多条规则的接受状态，排在前面的规则获胜：int 同时符合 Int 与 Id，所以 Int 要写在前面。能匹配空串的规则不能单独产生 Token，否则扫描器会原地打转。',
    },
  ],
  misconception:
    '扫描器并不是“一到接受状态就生成 Token”。它先走到无路可走，再回退到最近的接受位置。另外，规则顺序决定冲突时谁获胜：把关键字写在标识符后面，关键字规则就永远不会胜出。',
  limit:
    '自行实现的 Thompson 式构造、子集构造与最长匹配扫描；连接时合并状态，与原书图 9 的画法一致。支持字符、[ ] 字符集与区间、[^ ]、.、\\d \\w \\s、| * + ? 和括号；字母表限于 ASCII 可打印字符与 \\t \\n \\r。不做 DFA 最小化，不支持 {m,n}、锚点、捕获组和反向引用。最多 8 条规则、每条 80 字符、输入 300 字符；NFA 300 个状态、DFA 64 个状态，DFA 超限时不发布扫描结果。回溯对照每个 Token 最多尝试 5000 次，只记录前 240 次。',
  challenge:
    '用默认预设解释 intA 为什么是一个 Id，而 int 是 Int。再把 Int 与 Id 两行交换，预测 int 的类别，并指出哪个 DFA 状态同时含有两条规则的接受状态。',
  answer:
    '最长匹配让扫描器读完 intA，到空格才停下，最近的接受状态只属于 Id。读完 int 时所在的 DFA 状态同时包含 Int 与 Id 的接受状态，排在前面的 Int 获胜。交换顺序后，这个状态改由 Id 获胜，Int 在任何状态都不会胜出，页面会提示它被完全遮蔽。',
  quiz: {
    question: '子集构造得到的一个 DFA 状态代表什么？',
    options: [
      'NFA 中的某一个状态',
      '读完当前前缀后，NFA 可能同时所处的状态集合',
      '已经生成的一个 Token',
    ],
    correct: 1,
    explain:
      'DFA 状态是 NFA 状态的集合（含 ε-闭包）。用集合一次性记住所有可能性，匹配时就不需要回溯。',
  },
};

const header = '# 每行“名称: 正则”，越靠前越优先；名为 skip 的规则匹配后丢弃\n';
export const automataPresets = [
  {
    id: 'auto-keyword',
    label: '自动机 · 关键字与标识符的冲突',
    code: `${header}Int: int\nId: [a-zA-Z][a-zA-Z0-9]*\nNum: [0-9]+\nskip: [ \\t\\n]+\n%%\nint intA 42 in`,
    prediction: 'intA 会被切成 int 和 A 吗？读完 int 时，扫描器为什么还不急着生成 Token？',
  },
  {
    id: 'auto-order',
    label: '自动机 · 交换规则顺序',
    code: `${header}Id: [a-zA-Z][a-zA-Z0-9]*\nInt: int\nNum: [0-9]+\nskip: [ \\t\\n]+\n%%\nint intA 42`,
    prediction: '只交换了两行。int 现在是什么？Int 规则还能在哪个 DFA 状态胜出？',
  },
  {
    id: 'auto-book',
    label: '自动机 · 原书的 intA 回溯',
    code: `# 原书示例：一条正则的三个分支\nTok: int | [a-zA-Z][a-zA-Z0-9]* | [0-9]*\n%%\nintA`,
    prediction: '回溯匹配先走 int 分支。走到哪里会失败？这条规则还能匹配空串，扫描器会怎样处理？',
  },
  {
    id: 'auto-longest',
    label: '自动机 · 最长匹配要回退',
    code: `${header}Float: [0-9]+ \\. [0-9]+\nInt: [0-9]+\nDot: \\.\nskip: \\ +\n%%\n3.14 7. 8`,
    prediction: '读到 7. 时还像浮点数。下一个字符是空格，扫描器要退回几个字符？',
  },
  {
    id: 'auto-backtrack',
    label: '自动机 · 回溯的代价',
    code: `# Slow 在前，回溯会先把它试个遍\nSlow: (a|aa)*b\nAs: a+\n%%\naaaaaaaaaaaa`,
    prediction:
      '最终 Token 是 As。DFA 读几个字符就能决定？回溯匹配要尝试多少次才排除 Slow？再加两个 a 呢？',
  },
  {
    id: 'auto-blowup',
    label: '自动机 · 子集构造的状态膨胀',
    code: `# 倒数第 4 个字符是 a\nTail: (a|b)* a (a|b) (a|b) (a|b)\nOther: [ab]+\nskip: \\ +\n%%\nabbb babb`,
    prediction: 'NFA 只有二十多个状态，DFA 会有多少个？再加一组 (a|b) 呢？',
  },
];
