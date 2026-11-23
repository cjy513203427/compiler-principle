import { expect, test } from '@playwright/test';
import { lessons } from '../src/content/lessons';

test('CSE replays available expressions, reuses results and hoists only safe invariants', async ({ page }) => {
  await page.goto('/?lab=cse');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('只算一次');
  await expect(page.getByLabel('选择一个观察角度')).toHaveValue('cse-book');
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  await expect(page.getByLabel('可用表达式，可横向滚动')).toContainText('IN');
  await page.getByRole('button', { name: '看最终结果' }).click();
  await expect(page.getByLabel('冗余消除行为核对')).toContainText('三个版本的输出与错误一致');
  await expect(page.getByLabel('优化前后代码')).toContainText('t1 = t0');

  await page.getByLabel('选择一个观察角度').selectOption('cse-branch');
  await page.getByRole('button', { name: '看最终结果' }).click();
  await expect(page.getByLabel('优化前后代码')).toContainText('cse0');

  await page.getByLabel('选择一个观察角度').selectOption('licm-body');
  await page.getByRole('button', { name: '看最终结果' }).click();
  await page.getByText(/循环 L0：外提 2 条/).click();
  await expect(page.getByLabel('循环 L0 的判断，可横向滚动')).toContainText('不变但保留');

  await page.getByLabel('选择一个观察角度').selectOption('lvn-book');
  await page.getByRole('button', { name: '看最终结果' }).click();
  await expect(page.getByLabel('值编号对照')).toContainText('名字不同');
  await page.setViewportSize({ width: 320, height: 740 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('GC replays counting, cycle detection and tri-color marking, then compares collectors', async ({ page }) => {
  await page.goto('/?lab=gc');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('谁来发现');
  await page.getByLabel('选择一个观察角度').selectOption('gc-mutate');
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  await expect(page.getByLabel('本步垃圾收集')).toContainText('初始计数');
  await page.getByRole('button', { name: '看最终结果' }).click();
  const table = page.getByLabel('各算法对照，可横向滚动');
  await expect(table).toContainText('安全，但有垃圾没回收');
  await expect(table).toContainText('node1、node2 构成或挂在循环上');

  await page.getByLabel('选择一个观察角度').selectOption('gc-fragment');
  await page.getByRole('button', { name: '看最终结果' }).click();
  await expect(table.locator('tr', { hasText: '标记-清除' })).toContainText('失败');
  await expect(table.locator('tr', { hasText: '标记-整理' })).toContainText('成功');

  await page.getByLabel('堆描述与操作').fill('root a\na 2\nb 2\n%%\nlink a -> b');
  await page.getByLabel('堆描述与操作').press('Control+Enter');
  await expect(page.getByRole('alert')).toContainText('当前可达');
  await page.getByLabel('堆描述与操作').fill('root A, F\nA 2 -> B\nB 2\nF 2\nG 2');
  await page.getByLabel('堆描述与操作').press('Control+Enter');
  const slider = page.getByRole('slider', { name: '当前步骤' });
  await expect(slider).toHaveValue('0');
  for (let index = 0; index < 30; index++) {
    if ((await page.locator('.gc-status strong').textContent()) === '三色标记') break;
    await page.getByRole('button', { name: '下一步', exact: true }).click();
  }
  await expect(page.getByLabel('本步垃圾收集')).toContainText('待处理区');
  await page.setViewportSize({ width: 320, height: 740 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('the new labs sit in the backend route, cite their chapters and keep notes local', async ({ page }) => {
  const external: string[] = [];
  page.on('request', (request) => {
    if (!['127.0.0.1', 'localhost'].includes(new URL(request.url()).hostname)) external.push(request.url());
  });
  await page.goto('/');
  await expect(page.getByLabel('建议学习路线')).toContainText('优化、后端与运行时');
  await page.getByLabel('建议学习路线').getByRole('button', { name: '打开实验 19 公共子表达式与循环外提' }).click();
  await expect(page).toHaveURL(/lab=cse/);
  await page.getByRole('button', { name: '原理笔记', exact: true }).click();
  await expect(page.locator('.reading-source')).toContainText('第 07 讲');
  await page.goto('/?lab=gc');
  await page.getByRole('button', { name: '原理笔记', exact: true }).click();
  await expect(page.locator('.reading-source')).toContainText('第 32 讲');
  await page.getByRole('button', { name: '复述自测', exact: true }).click();
  await page.getByRole('button', { name: /计数都是 1/ }).click();
  await expect(page.locator('.quiz-feedback')).toContainText('判断正确');
  await page.getByLabel('垃圾收集的复述笔记').fill('只有可达性说了算。');
  await page.getByRole('button', { name: '我能解释了' }).click();
  await page.goto('/?lab=notes');
  await expect(page.getByLabel('垃圾收集的笔记', { exact: true })).toHaveValue('只有可达性说了算。');
  await expect(page.locator('.notebook-toolbar')).toContainText(`1 / ${lessons.length}`);
  expect(external).toEqual([]);
});
