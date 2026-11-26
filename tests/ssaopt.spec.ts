import { expect, test } from '@playwright/test';
import { lessons } from '../src/content/lessons';

test('SSA optimization replays SCCP, detects lost-copy interference and coalesces safe copies', async ({ page }) => {
  await page.goto('/?lab=ssaopt');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('突然变简单');
  await expect(page.getByLabel('选择一个观察角度')).toHaveValue('ssaopt-sccp');

  await page.getByRole('button', { name: '下一步', exact: true }).click();
  await expect(page.getByLabel('本步 SSA 优化')).toContainText('入口块');

  await page.getByRole('button', { name: '看最终结果' }).click();
  await expect(page.getByLabel('SSA 优化行为核对')).toContainText('输出与错误一致');
  await expect(page.getByLabel('SSA 优化行为核对')).toContainText('15');
  await expect(page.getByLabel('SSA 优化对照块')).toContainText('已裁剪');

  await page.getByLabel('选择一个观察角度').selectOption('ssaopt-loop');
  await page.getByRole('button', { name: '看最终结果' }).click();
  await expect(page.getByLabel('复制合并决策表，可横向滚动')).toContainText('安全合并');
  await expect(page.getByLabel('SSA 优化行为核对')).toContainText('6');

  await page.getByLabel('选择一个观察角度').selectOption('ssaopt-lostcopy');
  await page.getByRole('button', { name: '看最终结果' }).click();
  await expect(page.getByLabel('复制合并决策表，可横向滚动')).toContainText('干涉拒绝');
  await expect(page.getByLabel('SSA 优化行为核对')).toContainText('4, 3');

  await page.getByLabel('选择一个观察角度').selectOption('ssaopt-trap');
  await page.getByRole('button', { name: '看最终结果' }).click();
  await expect(page.getByLabel('SSA 优化行为核对')).toContainText('除数不能为 0');

  await page.setViewportSize({ width: 320, height: 740 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('SSA optimization sits in the middle route, cites references and keeps notes local', async ({ page }) => {
  const external: string[] = [];
  page.on('request', (request) => {
    if (!['127.0.0.1', 'localhost'].includes(new URL(request.url()).hostname)) external.push(request.url());
  });

  await page.goto('/');
  await page.getByLabel('建议学习路线').getByRole('button', { name: '打开实验 21 SSA 优化与复制合并' }).click();
  await expect(page).toHaveURL(/lab=ssaopt/);

  await page.getByRole('button', { name: '原理笔记', exact: true }).click();
  await expect(page.locator('.reading-source')).toContainText('Sparse Conditional Constant Propagation');

  await page.getByRole('button', { name: '复述自测', exact: true }).click();
  await page.getByRole('button', { name: /没有干涉边时/ }).click();
  await expect(page.locator('.quiz-feedback')).toContainText('判断正确');

  await page.getByLabel('SSA 优化与复制合并的复述笔记').fill('先查干涉图再合并，防止丢失复制。');
  await page.getByRole('button', { name: '我能解释了' }).click();

  await page.goto('/?lab=notes');
  await expect(page.getByLabel('SSA 优化与复制合并的笔记', { exact: true })).toHaveValue(
    '先查干涉图再合并，防止丢失复制。',
  );
  await expect(page.locator('.notebook-toolbar')).toContainText(`1 / ${lessons.length}`);
  expect(external).toEqual([]);
});
