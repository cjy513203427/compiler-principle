import { expect, test } from '@playwright/test';

test('grammar lab steps through FIRST, FOLLOW, the table and table-driven parsing', async ({
  page,
}) => {
  await page.goto('/?lab=grammar');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('只看下一个 Token');
  await expect(page.getByLabel('文法与输入')).toHaveValue(/exp -> mul add'/);
  await expect(page.locator('.g-phases li.current')).toHaveText('① FIRST');
  await expect(page.locator('.g-intro')).toContainText('可能以哪些 Token 开头');
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  await expect(page.locator('.g-productions li.active')).toHaveCount(1);
  await page.getByRole('button', { name: '看最终结果' }).click();
  await expect(page.locator('.g-phases li.current')).toHaveText('④ 用表解析');
  await expect(page.locator('.step-explanation')).toContainText('解析成功');
  await expect(page.locator('.g-node.leaf.matched')).toHaveText([
    'Num「2」',
    '+',
    'Num「3」',
    '*',
    'Num「4」',
  ]);
  // Slide back to an ε choice at the end of input: the used table cell is highlighted.
  const messages = page.locator('.step-explanation p');
  const slider = page.getByRole('slider', { name: '当前步骤' });
  const last = Number(await slider.getAttribute('max'));
  for (let step = last; step > 0; step--) {
    await slider.fill(String(step));
    if ((await messages.textContent())?.includes("add' -> ε")) break;
  }
  await expect(messages).toContainText("FOLLOW(add')");
  await page.locator('.g-details summary').click();
  await expect(page.locator('.g-table td.used')).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test('left recursion is explained, rewritten and then parsed; conflicts stop parsing', async ({
  page,
}) => {
  await page.goto('/?lab=grammar');
  await page.getByLabel('选择一个观察角度').selectOption('g-left');
  await expect(page.locator('.g-warning').first()).toContainText('add 是左递归');
  await expect(page.locator('.g-chain').first()).toContainText('解析 add()');
  await page.getByRole('button', { name: '看最终结果' }).click();
  await expect(page.locator('.g-conflicts')).toContainText('FIRST/FIRST');
  await expect(page.locator('.step-explanation')).toContainText('不是 LL(1)');
  await page.getByRole('button', { name: '用改写后的文法重新分析' }).click();
  await expect(page.getByLabel('文法与输入')).toHaveValue(/add' -> \+ mul add' \| ε/);
  await expect(page.getByRole('slider', { name: '当前步骤' })).toHaveValue('0');
  await page.getByRole('button', { name: '看最终结果' }).click();
  await expect(page.locator('.step-explanation')).toContainText('解析成功');

  await page.getByLabel('选择一个观察角度').selectOption('g-prefix');
  await page.getByRole('button', { name: '看最终结果' }).click();
  await expect(page.locator('.g-conflicts')).toContainText('提出来');
  await expect(page.locator('.g-table td.conflict')).toHaveCount(1);

  const editor = page.getByLabel('文法与输入');
  await editor.fill('e -> Num + Num\n%%\n2 + x');
  await page.getByRole('button', { name: '计算分析表' }).click();
  await expect(page.locator('.diagnostic')).toContainText('不是文法中的终结符');
  await editor.fill('e -> Num + Num\n%%\n2 + + 3');
  await editor.press('Control+Enter');
  await page.getByRole('button', { name: '看最终结果' }).click();
  await expect(page.locator('.g-error')).toContainText('应该是 Num');
});

test('the reading walks step by step, and each input kind keeps its own text', async ({ page }) => {
  await page.goto('/?lab=grammar');
  await page.getByRole('button', { name: '原理笔记', exact: true }).click();
  const walk = page.getByLabel('一步一步读懂');
  await expect(walk.locator('li')).toHaveCount(9);
  await expect(walk.locator('li').first()).toContainText('实验 02');
  await expect(page.locator('.walkthrough-summary')).toContainText('需要记住的三件事');
  await page.getByRole('button', { name: '动手实验', exact: true }).click();
  await page.getByLabel('文法与输入').fill('s -> Num\n%%\n7');
  await page.getByRole('button', { name: '计算分析表' }).click();
  await page.getByRole('button', { name: '上一个实验' }).click();
  await expect(page.getByLabel('词法规则与输入')).toHaveValue(/Int: int/);
  await page.getByRole('button', { name: '上一个实验' }).click();
  await expect(page.getByLabel('源程序代码')).toHaveValue(/int|bool/);
  await page.getByRole('button', { name: /下一站/ }).click();
  await page.getByRole('button', { name: /下一站/ }).click();
  await expect(page.getByLabel('文法与输入')).toHaveValue('s -> Num\n%%\n7');
});
