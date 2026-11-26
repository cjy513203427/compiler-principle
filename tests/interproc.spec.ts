import { expect, test } from '@playwright/test';
import { lessons } from '../src/content/lessons';

test('interprocedural lab replays summaries, constant propagation, inlining and the comparison', async ({ page }) => {
  await page.goto('/?lab=interproc');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('调用一个函数之前');
  await expect(page.getByLabel('选择一个观察角度')).toHaveValue('ip-book');
  await expect(page.getByLabel('本步跨过程分析')).toContainText('符号栈');
  await expect(page.getByRole('img', { name: /调用图：2 个函数/ })).toBeVisible();
  const slider = page.getByRole('slider', { name: '当前步骤' });
  const max = Number(await slider.getAttribute('max'));
  for (let step = 0; step <= max; step++) {
    await slider.fill(String(step));
    if ((await page.getByLabel('本步跨过程分析').textContent())?.includes('返回值现在是 10')) break;
  }
  await expect(page.getByLabel('本步跨过程分析')).toContainText('返回值现在是 10');
  await page.getByRole('button', { name: '看最终结果' }).click();
  await expect(page.getByLabel('跨过程优化行为核对')).toContainText('都和实验 16 的 VM 一致');
  await page.getByRole('radio', { name: '跨过程改写后' }).check();
  await page.getByLabel('查看的函数').selectOption({ label: 'main' });
  await expect(page.getByLabel('main · 跨过程改写后')).toHaveText(/print 10/);

  await page.getByLabel('选择一个观察角度').selectOption('ip-recursion');
  await page.getByRole('button', { name: '看最终结果' }).click();
  await expect(page.getByLabel('跨过程优化行为核对')).toContainText('跳过');
  await expect(page.getByLabel('跨过程优化行为核对')).toContainText('main 仍调用 fact');
  await expect(page.getByLabel('函数效果摘要')).toContainText('递归');
});

test('a printing call stays, a trap is kept, and the lab fits a small screen', async ({ page }) => {
  await page.goto('/?lab=interproc');
  await page.getByLabel('选择一个观察角度').selectOption('ip-effects');
  await page.getByRole('button', { name: '看最终结果' }).click();
  await page.getByRole('radio', { name: '跨过程改写后' }).check();
  await page.getByLabel('查看的函数').selectOption({ label: 'main' });
  await expect(page.getByLabel('main · 跨过程改写后')).toContainText('call log(5)');
  await expect(page.getByLabel('main · 跨过程改写后')).not.toContainText('same');
  await page.getByLabel('选择一个观察角度').selectOption('ip-trap');
  await page.getByRole('button', { name: '看最终结果' }).click();
  await expect(page.getByLabel('跨过程优化行为核对')).toContainText('整数除法的除数不能为 0');

  await page.setViewportSize({ width: 320, height: 740 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('slider', { name: '当前步骤' }).focus();
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('slider', { name: '当前步骤' })).toHaveValue('1');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('lab 23 follows lab 16, keeps the shared function program, cites sources and keeps notes local', async ({ page }) => {
  const external: string[] = [];
  page.on('request', (request) => {
    if (!['127.0.0.1', 'localhost'].includes(new URL(request.url()).hostname)) external.push(request.url());
  });
  await page.goto('/?lab=functions');
  await page.getByLabel('选择一个观察角度').selectOption('call-fact');
  await page.getByRole('button', { name: '原理笔记', exact: true }).click();
  await page.getByRole('button', { name: /跨过程分析与内联/ }).first().click();
  await expect(page).toHaveURL(/lab=interproc/);
  await expect(page.getByLabel('函数程序代码')).toHaveValue(/fact/);

  await page.getByRole('button', { name: '原理笔记', exact: true }).click();
  await expect(page.locator('.reading-source')).toContainText('Interprocedural Analysis');
  await page.getByRole('button', { name: '复述自测', exact: true }).click();
  await page.getByRole('button', { name: /bool same/ }).click();
  await expect(page.locator('.quiz-feedback')).toContainText('判断正确');
  await page.getByLabel('跨过程分析与内联的复述笔记').fill('只有纯函数的调用才能删。');
  await page.getByRole('button', { name: '我能解释了' }).click();
  await page.goto('/?lab=notes');
  await expect(page.getByLabel('跨过程分析与内联的笔记', { exact: true })).toHaveValue('只有纯函数的调用才能删。');
  await expect(page.locator('.notebook-toolbar')).toContainText(`1 / ${lessons.length}`);
  expect(external).toEqual([]);
});
