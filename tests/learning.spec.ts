import { expect, test, type Page } from '@playwright/test';

async function openLab(page: Page, name: RegExp) {
  if (await page.getByRole('button', { name: '切换课程目录' }).isVisible())
    await page.getByRole('button', { name: '切换课程目录' }).click();
  await page.locator('aside.sidebar').getByRole('link', { name }).click();
}

test('learning routes and reading connections link topics with keyboard and narrow layouts', async ({ page }) => {
  await page.goto('/');
  const routes = page.getByLabel('建议学习路线');
  await expect(routes).toContainText('先跑通编译流程');
  await expect(routes).toContainText('词法与文法进阶');
  await expect(routes).toContainText('程序表示与调用');
  await routes.getByRole('button', { name: '打开实验 14 DFA 最小化' }).focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/lab=minimize/);
  await page.getByRole('button', { name: '原理笔记', exact: true }).click();
  await page.getByLabel('阅读衔接').getByRole('button', { name: /先学：10 正则与自动机/ }).click();
  await expect(page).toHaveURL(/lab=automata/);
  await page.getByRole('button', { name: '原理笔记', exact: true }).click();
  await page.getByLabel('阅读衔接').getByRole('button', { name: /继续：14 DFA 最小化/ }).click();
  await expect(page).toHaveURL(/lab=minimize/);
  await page.goto('/?lab=ssa');
  await page.getByRole('button', { name: '原理笔记', exact: true }).click();
  await expect(page.getByLabel('阅读衔接')).toContainText('09 支配关系');
  await expect(page.getByLabel('阅读衔接')).toContainText('08 数据流分析');
  await page.setViewportSize({ width: 320, height: 740 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.goto('/');
  await expect(page.getByLabel('建议学习路线')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('pending programs and rules survive switching input kinds without entering share URLs', async ({ page }) => {
  const applied = 'int kept = 2; print(kept);';
  const pending = 'int kept = 9; print(kept);';
  const pendingRule = 'Tok: xyz\n%%\nxyz';
  await page.goto('/?lab=lex');
  await page.getByLabel('源程序代码').fill(applied);
  await page.getByRole('button', { name: '运行编译' }).click();
  await page.getByLabel('源程序代码').fill(pending);
  await openLab(page, /DFA 最小化/);
  await page.getByLabel('词法规则与输入').fill(pendingRule);
  await openLab(page, /词法分析/);
  await expect(page.getByLabel('源程序代码')).toHaveValue(pending);
  await expect(page.locator('.dirty-note')).toBeVisible();
  await expect(page.getByRole('button', { name: '播放', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '分享实验', exact: false }).click();
  expect(new URL(page.url()).searchParams.get('code')).toBe(applied);
  await openLab(page, /DFA 最小化/);
  await expect(page.getByLabel('词法规则与输入')).toHaveValue(pendingRule);
  await expect(page.locator('.dirty-note')).toBeVisible();
  await page.getByRole('button', { name: '分享实验', exact: false }).click();
  expect(new URL(page.url()).searchParams.get('code')).toBe('Tok: ab|cb\n%%\nabcb');
  await page.getByLabel('词法规则与输入').press('Control+Enter');
  await expect(page.locator('.dirty-note')).toHaveCount(0);
  await page.getByRole('button', { name: '看最终结果' }).click();
  await expect(page.getByLabel('最小化 DFA 扫描')).toContainText('"xyz"');
});

test('a pending edit of the default program is not replaced by a control-flow preset', async ({ page }) => {
  await page.goto('/?lab=lex');
  const applied = await page.getByLabel('源程序代码').inputValue();
  await page.getByLabel('源程序代码').fill('print(9);');
  await openLab(page, /控制流图/);
  await expect(page.getByLabel('源程序代码')).toHaveValue('print(9);');
  await expect(page.locator('.dirty-note')).toBeVisible();
  await page.getByRole('button', { name: '分享实验', exact: false }).click();
  expect(new URL(page.url()).searchParams.get('code')).toBe(applied);
  await openLab(page, /正则与自动机/);
  await openLab(page, /控制流图/);
  await expect(page.getByLabel('源程序代码')).toHaveValue('print(9);');
  await page.getByLabel('源程序代码').press('Control+Enter');
  await page.getByRole('button', { name: '看最终结果' }).click();
  await expect(page.locator('.output-console pre')).toHaveText('9');
});
