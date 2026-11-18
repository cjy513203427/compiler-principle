import { expect, test } from '@playwright/test';

test('automata lab steps through NFA, subset construction and longest-match scanning', async ({
  page,
}) => {
  await page.goto('/?lab=automata');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('词法规则');
  await expect(page.getByLabel('词法规则与输入')).toHaveValue(/Int: int/);
  await expect(page.locator('.auto-phases li.current')).toContainText('正则 → NFA');
  await expect(page.locator('.step-explanation')).toContainText('总开始状态');
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  await expect(page.locator('.auto-card')).toContainText('规则 Int');
  await page.getByRole('button', { name: '看最终结果' }).click();
  await expect(page.locator('.auto-phases li.current')).toContainText('最长匹配扫描');
  const tokens = page.locator('.auto-card .auto-tokens li:not(.skip)');
  await expect(tokens).toHaveText(['Intint', 'IdintA', 'Num42', 'Idin']);
  // Graph nodes are keyboard reachable and explain the priority conflict.
  const conflict = page.locator('.auto-node', { hasText: 'Int' }).first();
  await conflict.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.auto-selected')).toContainText('按规则顺序取 Int');
  // Sliding back into the subset phase shows move / closure rows.
  const slider = page.getByRole('slider', { name: '当前步骤' });
  const thompson = await page.locator('.auto-phases li').first().textContent();
  const nfaSteps = Number(thompson!.match(/(\d+) 步/)![1]);
  await slider.fill(String(nfaSteps + 1));
  await expect(page.locator('.auto-phases li.current')).toContainText('子集构造');
  await expect(page.locator('.auto-moves')).toContainText('ε-闭包');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test('rule order, rollback, the book backtracking example and invalid rules', async ({ page }) => {
  await page.goto('/?lab=automata');
  await page.getByLabel('选择一个观察角度').selectOption('auto-order');
  await page.getByRole('button', { name: '看最终结果' }).click();
  await expect(page.locator('.auto-rules')).toContainText('完全遮蔽');
  await expect(page.locator('.auto-card .auto-tokens li').first()).toHaveText('Idint');

  await page.getByLabel('选择一个观察角度').selectOption('auto-longest');
  await page.getByRole('button', { name: '看最终结果' }).click();
  await expect(page.locator('.auto-card .auto-tokens li:not(.skip)')).toHaveText([
    'Float3.14',
    'Int7',
    'Dot.',
    'Int8',
  ]);
  await page.getByRole('button', { name: 'NFA 回溯对照' }).click();
  await expect(page.locator('.auto-compare')).toContainText('Int / 2 个字符');

  await page.getByLabel('选择一个观察角度').selectOption('auto-book');
  await page.getByRole('button', { name: '看最终结果' }).click();
  await expect(page.locator('.auto-rules')).toContainText('可以匹配空串');
  await page.getByRole('button', { name: 'NFA 回溯对照' }).click();
  await expect(page.locator('.auto-trace')).toContainText('↩ 回溯');
  await expect(page.locator('.auto-trace')).toContainText('还有字符没读');

  const editor = page.getByLabel('词法规则与输入');
  await editor.fill('A: (a\n%%\naaa');
  await expect(page.getByRole('button', { name: '播放', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '生成自动机' }).click();
  await expect(page.locator('.diagnostic')).toContainText('缺少右括号');
  await expect(page.locator('.diagnostic')).toContainText('第 1 行');
  await editor.fill('A: a\n%%\naab');
  await editor.press('Control+Enter');
  await page.getByRole('button', { name: '看最终结果' }).click();
  await expect(page.locator('.auto-final')).toBeVisible();
  await expect(page.locator('.step-explanation')).toContainText('没有规则能匹配');
});

test('automata input is kept apart from the Mini C program and shares without notes', async ({
  page,
}) => {
  const external: string[] = [];
  page.on('request', (request) => {
    if (!new URL(request.url()).hostname.match(/^(127\.0\.0\.1|localhost)$/))
      external.push(request.url());
  });
  await page.goto('/?lab=lex');
  await page.getByLabel('源程序代码').fill('int kept = 1;\nprint(kept);');
  await page.getByRole('button', { name: '运行编译' }).click();
  await page.getByRole('button', { name: '下一站 · 语法分析' }).click();
  // Walk via the sidebar so in-app navigation (not a reload) is exercised.
  if (await page.getByRole('button', { name: '切换课程目录' }).isVisible())
    await page.getByRole('button', { name: '切换课程目录' }).click();
  await page.getByRole('link', { name: /正则与自动机/ }).click();
  await expect(page.getByLabel('词法规则与输入')).toHaveValue(/Int: int/);
  await expect(page.locator('.pipeline-strip')).toHaveCount(0);
  await page.getByRole('button', { name: '上一个实验' }).click();
  await expect(page.getByLabel('源程序代码')).toHaveValue(/kept/);

  await page.goto('/?lab=automata');
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  await page.getByRole('button', { name: '复述自测', exact: true }).click();
  await page.getByRole('button', { name: /可能同时所处的状态集合/ }).click();
  await expect(page.locator('.quiz-feedback')).toContainText('判断正确');
  await page.getByLabel('正则与自动机的复述笔记').fill('DFA 状态是 NFA 状态集合。');
  await page.getByRole('button', { name: '分享实验', exact: false }).click();
  const shared = page.url();
  expect(decodeURIComponent(shared)).not.toContain('状态集合');
  await page.goto(shared);
  await expect(page.getByRole('slider', { name: '当前步骤' })).toHaveValue('1');
  await page.goto('/?lab=notes');
  await expect(page.getByLabel('正则与自动机的笔记', { exact: true })).toHaveValue(
    'DFA 状态是 NFA 状态集合。',
  );
  expect(external).toEqual([]);
});
