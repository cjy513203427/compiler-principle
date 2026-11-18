import { expect, test } from '@playwright/test';

test('LR lab builds item sets, fills the table and shifts / reduces the book example', async ({
  page,
}) => {
  await page.goto('/?lab=lr');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('先拼小块');
  await expect(page.getByLabel('文法与输入')).toHaveValue(/add -> add \+ mul \| mul/);
  await expect(page.locator('.g-phases li.current')).toHaveText('① 项目集');
  await expect(page.getByLabel('状态 0 的项目')).toContainText('S′ → · start');
  await expect(page.getByLabel('状态 0 的项目')).toContainText('闭包：点后面是 add');
  await page.getByRole('button', { name: '看最终结果' }).click();
  await expect(page.locator('.g-phases li.current')).toHaveText('③ 移进 / 规约');
  await expect(page.locator('.step-explanation')).toContainText('接受');
  await expect(page.getByLabel('最右推导')).toContainText('⇒ add + mul * pri');
  // The finished workspace holds one tree whose leaves spell the input.
  await expect(page.locator('.lr-entry')).toHaveCount(2);
  await expect(page.locator('.lr-piece .g-node.leaf')).toHaveText([
    'Num「2」',
    '+',
    'Num「3」',
    '*',
    'Num「5」',
  ]);
  // Walk back to the step that shifts * although add + mul is complete.
  const slider = page.getByRole('slider', { name: '当前步骤' });
  const last = Number(await slider.getAttribute('max'));
  const message = page.locator('.step-explanation p');
  for (let step = last; step > 0; step--) {
    await slider.fill(String(step));
    if ((await message.textContent())?.includes('先不规约')) break;
  }
  await expect(message).toContainText('不会跟在 add 后面');
  await page.locator('.g-details summary').click();
  await expect(page.locator('.lr-table td.used')).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test('conflicts stop parsing, ε reductions and the LL(1) prefix case work', async ({ page }) => {
  await page.goto('/?lab=lr');
  await page.getByLabel('选择一个观察角度').selectOption('lr-ambiguous');
  await page.getByRole('button', { name: '看最终结果' }).click();
  await expect(page.locator('.g-conflicts')).toContainText('移进/规约冲突');
  await expect(page.locator('.lr-table td.conflict')).toHaveCount(1);
  await page.getByLabel('选择一个观察角度').selectOption('lr-reduce');
  await page.getByRole('button', { name: '看最终结果' }).click();
  await expect(page.locator('.g-conflicts')).toContainText('规约/规约冲突');
  await page.getByLabel('选择一个观察角度').selectOption('lr-empty');
  await page.getByRole('button', { name: '看最终结果' }).click();
  const message = page.locator('.step-explanation p');
  const slider = page.getByRole('slider', { name: '当前步骤' });
  for (let step = Number(await slider.getAttribute('max')); step > 0; step--) {
    await slider.fill(String(step));
    if ((await message.textContent())?.includes('空的 list')) break;
  }
  await expect(message).toContainText('不弹出任何东西');
  await expect(page.locator('.lr-piece .g-node.eps')).toHaveCount(1);
  await page.getByLabel('选择一个观察角度').selectOption('lr-prefix');
  await page.getByRole('button', { name: '看最终结果' }).click();
  await expect(message).toContainText('接受');
  await page.getByLabel('文法与输入').fill('s -> Num ;\n%%\n1 1');
  await page.getByRole('button', { name: '构造 LR 表' }).click();
  await page.getByRole('button', { name: '看最终结果' }).click();
  await expect(page.locator('.g-error')).toContainText('只能出现');
});

test('the LR reading starts from lab 11 and snippets look like an IDE', async ({ page }) => {
  await page.goto('/?lab=lr');
  await page.getByRole('button', { name: '原理笔记', exact: true }).click();
  const walk = page.getByLabel('一步一步读懂');
  await expect(walk.locator('li').first()).toContainText('实验 11');
  await expect(walk.locator('.ide-snippet').first()).toBeVisible();
  const background = await walk
    .locator('.ide-code')
    .first()
    .evaluate((e) => getComputedStyle(e).backgroundColor);
  expect(background).toBe('rgb(30, 30, 30)');
  await expect(walk.locator('.ide-gutter').first()).toHaveText('1');
});
