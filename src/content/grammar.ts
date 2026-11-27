import type { Lesson } from './lessons';
import { T } from '../i18n';

export const LEFT_RECURSION_REFERENCE = 'https://en.wikipedia.org/wiki/Left_recursion';
export const grammarLesson: Lesson = {
  id: 'grammar',
  number: '11',
  title: T('文法与预测分析'),
  english: 'FIRST / FOLLOW / LL(1)',
  question: T('只看下一个 Token，解析器怎么知道该走哪条路？'),
  intro: T(
    '实验 02 的递归下降是手写的：每遇到一个规则就调用一个函数。这里把规则写成产生式，让程序自己算出“看到哪个 Token 该选哪条规则”，再用这张表解析输入。',
  ),
  chapter: '03',
  minutes: 22,
  icon: '⊢',
  color: 'purple',
  walkthrough: [
    {
      title: T('先回到实验 02：一个规则就是一个函数'),
      body: T(
        '在实验 02 里，解析表达式的函数会去调用解析乘法的函数，乘法再去调用解析数字或括号的函数。语法规则写成什么样，函数就怎么互相调用，这就叫递归下降。这一页想回答一个问题：一个规则有好几种写法时，函数怎么知道该走哪一种？',
      ),
    },
    {
      title: T('把规则写成“产生式”'),
      body: T(
        '箭头左边是一个名字，右边写它可以展开成什么。左边出现过的名字叫非终结符，意思是“还能继续展开”；没出现在左边的，比如 + 和 Num，就是 Token，叫终结符，展开到它们就停了。一个名字有几种写法，就用 | 隔开。ε 表示“什么也没有”。',
      ),
      example: T('pri -> Num | ( exp )\n# pri 要么是一个数字，要么是括号包着的一个 exp'),
    },
    {
      title: T('最笨的办法：挨个试'),
      body: T(
        '解析 pri 时，可以先试第一种写法，不行就退回来试第二种。这和实验 10 里 NFA 的回溯是一回事：能用，但会白费功夫，规则一多还可能试很久。',
      ),
    },
    {
      title: T('更聪明的办法：先偷看下一个 Token'),
      body: T(
        '看上面的 pri：第一种写法一定以 Num 开头，第二种一定以 ( 开头。所以只要偷看一眼下一个 Token，就知道该选哪种，根本不用试。一种写法“可能以哪些 Token 开头”，就是它的 FIRST 集合。只要同一个名字的几种写法 FIRST 互不重叠，就能一眼选对。',
      ),
      example: T('下一个是 Num → 选 pri -> Num\n下一个是 (   → 选 pri -> ( exp )'),
    },
    {
      title: T('FIRST 会一层层传上去'),
      body: T(
        "exp -> mul add' 以 mul 开头，那么 mul 能以什么开头，exp 就能以什么开头。所以 FIRST(exp) 要借用 FIRST(mul)，mul 又要借 FIRST(pri)。程序不按顺序硬算，而是一轮轮扫描全部产生式，每轮把能借到的都加进去，直到某一轮什么都没加，这就是“不动点”。",
      ),
    },
    {
      title: T('麻烦来自 ε：还要看“后面跟着什么”'),
      body: T(
        "add' -> + mul add' | ε 的意思是：后面要么还有一个“+ 某某”，要么到此为止。如果下一个 Token 是 +，当然选第一种。可如果下一个是 ) 呢？这时应该选 ε，因为 ) 正是 add' 结束后可能出现的东西。一个名字后面可能紧跟哪些 Token，就是 FOLLOW 集合。开始符号后面跟的是输入结束，记作 $。",
      ),
      example: T("2 + 3 )\n      ↑ 看到 )，说明 add' 这里该结束了"),
    },
    {
      title: T('把答案填成一张表'),
      body: T(
        '行是非终结符，列是 Token，格子里写“这时该用哪条产生式”。FIRST 决定大部分格子，能为空的写法再按 FOLLOW 填。解析时手里拿一个栈：栈顶是名字就查表、展开；栈顶是 Token 就和输入对一对。这就是 LL(1)：从左往右读，总是先展开最左边，只预读 1 个 Token。',
      ),
    },
    {
      title: T('一个格子塞进两条，说明这个文法不行'),
      body: T(
        '如果某个格子里有两条产生式，就是“冲突”：只看一个 Token 选不出来。常见原因有两个：几种写法开头相同，比如都以 Id 开头；或者文法是左递归的。遇到冲突，要么改写文法，要么换更强的算法。',
      ),
    },
    {
      title: T('左递归：没读 Token 就无限往下钻'),
      body: T(
        "原书的 add -> add + mul 看起来很自然，但递归下降解析 add 的第一件事就是“先解析 add”，而这又要先解析 add……一个 Token 都没读，就无限递归下去了。标准改法是把它拆成 add -> mul add' 和 add' -> + mul add' | ε。改写后的树是向右长的，直接按树计算会把 10 - 3 - 2 当成 10 - (3 - 2)。所以实验 02 用循环来解析，在循环里把树接成左结合。",
      ),
      example: T("add  -> add + mul | mul\n⇓ 改写\nadd  -> mul add'\nadd' -> + mul add' | ε"),
    },
  ],
  note: [
    {
      title: T('FIRST：一种写法可能以哪些 Token 开头'),
      body: T(
        '以 Token 开头，就把这个 Token 加进来；以名字开头，就借用那个名字的 FIRST；如果那个名字可以为空，再接着看下一项。整条右边都能为空时，加入 ε。全部产生式反复扫描，直到一轮下来没有变化。',
      ),
    },
    {
      title: T('FOLLOW：一个名字后面可能紧跟哪些 Token'),
      body: T(
        '在每条产生式里找到这个名字，看它后面是什么：后面的 FIRST 都能跟在它后面；如果它在末尾，或后面都可以为空，那么左边那个名字后面能跟什么，它后面也能跟什么。开始符号后面先放 $。',
      ),
    },
    {
      title: T('分析表与冲突'),
      body: T(
        '产生式 A -> α 填在 A 行、FIRST(α) 的各列；α 能为空时，再填到 FOLLOW(A) 的各列。每个格子最多一条，就是 LL(1) 文法，解析时一路查表，不用回溯。格子里有两条就是冲突，要改写文法，例如消除左递归或提取共同开头。',
      ),
    },
  ],
  misconception: T(
    "消除左递归只解决了“死循环”，不会自动得到正确的结合性：改写后的 add' 是右递归，树向右长。另外，ε 不是一个 Token，输入里永远读不到 ε；选择 ε 产生式，靠的是下一个 Token 落在 FOLLOW 里。",
  ),
  limit: T(
    '纯 BNF 产生式（不支持 * + ? 等 EBNF 写法）、不动点法求 FIRST / FOLLOW、LL(1) 分析表与表驱动解析；能识别直接和间接左递归，只对直接左递归给出改写。不提取左公因子，不做错误恢复，不演示 LR 的移进 / 规约。最多 16 个非终结符、40 个候选、每个候选 10 个符号，输入 60 个 Token，解析最多回放 600 步。有冲突时不解析。',
  ),
  challenge: T(
    "用“原书的左递归文法”预设，说出 add 这一行哪个格子有冲突、为什么。点“改写”后，再解释 + 为什么出现在 FOLLOW(mul) 里，以及解析到 4 后面的 $ 时，add' 为什么选 ε。",
  ),
  answer: T(
    "add -> add + mul 和 add -> mul 都以 mul 开头，FIRST 都是 { Num, ( }，所以 add 行的 Num 列和 ( 列都塞进了两条。改写后，add -> mul add' 中 mul 后面是 add'，FIRST(add') 里的 + 就能紧跟在 mul 后面。读到 $ 时，$ 在 FOLLOW(add') 中，说明加法部分已经结束，所以选 ε。",
  ),
  quiz: {
    question: T('分析表里，A -> ε 应该填在哪些列？'),
    options: [T('FIRST(A) 的各列'), T('FOLLOW(A) 的各列'), T('所有列')],
    correct: 1,
    explain: T(
      'ε 不读任何 Token。只有当下一个 Token 本来就可以跟在 A 后面时，A 才能“什么也不产生”。',
    ),
  },
};

const header = `${T('# 产生式：左边 -> 右边，候选之间用 |，ε 表示空\n# 第一条产生式的左边是开始符号；%% 下面是要解析的输入')}\n`;
export const grammarPresets = [
  {
    id: 'g-expr',
    label: T('文法 · 表达式（已改写成 LL(1)）'),
    code: `${header}exp -> mul add'\nadd' -> + mul add' | ε\nmul -> pri mul'\nmul' -> * pri mul' | ε\npri -> Num | ( exp )\n%%\n2 + 3 * 4`,
    prediction: T("FIRST(exp) 里会有哪些 Token？读到最后的 $ 时，add' 和 mul' 会怎么选？"),
  },
  {
    id: 'g-left',
    label: T('文法 · 原书的左递归写法'),
    code: `${T('# 原书的写法：加法和乘法都是左递归')}\nadd -> add + mul | mul\nmul -> mul * pri | pri\npri -> Num | ( add )\n%%\n2 + 3 * 4`,
    prediction: T(
      '递归下降遇到 add -> add + mul 会怎样？分析表里哪些格子会塞进两条产生式？',
    ),
  },
  {
    id: 'g-stmt',
    label: T('文法 · 原书的语句：靠第一个 Token 选'),
    code: `${T('# 原书例子：看第一个 Token 就能分出是哪种语句')}\nstmts -> stmt stmts | ε\nstmt -> varDecl | expStmt | returnStmt\nvarDecl -> Int Id init ;\ninit -> = exp | ε\nexpStmt -> exp ;\nreturnStmt -> Return exp ;\nexp -> Num | Id | ( exp )\n%%\nInt a = 2 ;\nInt b ;\nReturn a ;`,
    prediction: T('解析 Int b ; 时，init 后面马上就是分号。init 会选哪条？依据是什么？'),
  },
  {
    id: 'g-prefix',
    label: T('文法 · 开头相同，一个 Token 不够'),
    code: `${T('# 两种写法都以 Id 开头')}\nstmt -> Id = Num ; | Id ( ) ;\n%%\nx = 1 ;`,
    prediction: T('只偷看一个 Token（Id），能分出是赋值还是调用吗？怎样改写才能分开？'),
  },
  {
    id: 'g-right',
    label: T('文法 · 右递归与结合性'),
    code: `${T('# 没有左递归，能用 LL(1) 解析，但树会向右长')}\nexp -> Num rest\nrest -> - exp | ε\n%%\n10 - 3 - 2`,
    prediction: T(
      '先看解析树：哪两个数先被放进同一个子树？直接按这棵树算，结果是 5 还是 9？',
    ),
  },
];
