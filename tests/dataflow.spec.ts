import { expect, test } from '@playwright/test';
test('analysis replays and merges equal or conflicting constants independently of execution', async ({
  page,
}) => {
  await page.goto('/?lab=dataflow');
  await expect(page.getByLabel('源程序代码')).toHaveValue(/while/);
  const range = page.getByRole('slider', { name: '当前步骤' });
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  await expect(
    page.locator('.dataflow-facts tr').filter({ hasText: 'v0_i' }).locator('td').nth(2),
  ).toHaveText('0');
  await page.getByRole('button', { name: '上一步', exact: true }).click();
  await expect(range).toHaveValue('0');
  await expect(
    page.locator('.dataflow-facts tr').filter({ hasText: 'v0_i' }).locator('td').nth(2),
  ).toHaveText('⊥');
  await page.getByRole('button', { name: '看最终结果' }).click();
  await expect(page.locator('.dataflow-heading')).toContainText('已达到不动点');
  await expect(
    page.locator('.dataflow-facts tr').filter({ hasText: 'v1_value' }).locator('td').nth(2),
  ).toHaveText('7');
  await expect(page.locator('.dataflow-outcome')).toContainText('原始输出 [7] → 优化输出 [7]');
  await page.getByLabel('选择一个观察角度').selectOption('merge-different');
  await expect(range).toHaveValue('0');
  await page.getByRole('button', { name: '看最终结果' }).click();
  await expect(
    page.locator('.dataflow-facts tr').filter({ hasText: 'v1_value' }).locator('td').nth(2),
  ).toHaveText('⊤');
  await expect(page.locator('.dataflow-outcome')).toContainText('原始输出 [7] → 优化输出 [7]');
  await page.getByLabel('常量传播', { exact: true }).uncheck();
  await expect(range).toHaveValue('0');
  await page.getByRole('button', { name: '看最终结果' }).click();
  await page.getByRole('link', { name: '查看这段程序的优化前后对照' }).click();
  await expect(page.getByLabel('常量传播', { exact: true })).not.toBeChecked();
  await expect(page.getByLabel('源程序代码')).toHaveValue(/value = 9/);
  await page.getByRole('button', { name: '看最终结果' }).click();
  await expect(page.locator('.equivalence')).toContainText('两版程序的输出与错误一致');
});
test('raw-block inspection, live-variable view, quiz and new notebook entry are usable', async ({
  page,
}) => {
  await page.goto('/?lab=dataflow');
  await page.getByRole('button', { name: '看最终结果' }).click();
  await page.getByLabel('检查分析基本块').selectOption('B0');
  await expect(page.locator('.dataflow-instructions summary')).toContainText('B0');
  await page.getByLabel('显示临时变量').check();
  await expect(page.locator('.dataflow-facts tbody')).toContainText('t0');
  await page.locator('.dataflow-liveness summary').click();
  await expect(page.locator('.dataflow-liveness')).toContainText('LIVE IN');
  await expect(page.locator('.dataflow-liveness')).toContainText('已收敛');
  await page.getByRole('button', { name: '复述自测', exact: true }).click();
  await page.getByRole('button', { name: 'C ⊤：无法确定唯一常量' }).click();
  await expect(page.locator('.quiz-feedback')).toContainText('判断正确');
  await page.getByLabel('数据流分析的复述笔记').fill('相同常量保留，不同常量合并为 ⊤。');
  await page.getByRole('button', { name: '我能解释了' }).click();
  await page.goto('/?lab=notes');
  await expect(page.getByLabel('数据流分析的笔记')).toHaveValue('相同常量保留，不同常量合并为 ⊤。');
  await expect(page.locator('.notebook-toolbar')).toContainText('1 / 9');
  await page.setViewportSize({ width: 320, height: 740 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test('proven unreachable arithmetic is removed while selected traps retain observable errors', async ({
  page,
}) => {
  await page.goto('/?lab=optimize');
  await page.getByLabel('选择一个观察角度').selectOption('constant-branch');
  await page.getByRole('button', { name: '看最终结果' }).click();
  const final = page.locator('.comparison > div').last();
  await expect(final).toContainText('print 7');
  await expect(final).not.toContainText('/ 0');
  await expect(page.getByRole('alert')).toHaveCount(0);
  const source = await page.getByLabel('源程序代码').inputValue();
  await page.getByLabel('源程序代码').fill(source.replace('false', 'true'));
  await page.getByRole('button', { name: '运行编译' }).click();
  await page.getByRole('button', { name: '看最终结果' }).click();
  await expect(page.getByRole('alert')).toContainText('除数不能为 0');
  await expect(final).toContainText('/ 0');
  await expect(page.locator('.equivalence')).toContainText('两版程序的输出与错误一致');
});
