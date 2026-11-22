import { expect, test } from '@playwright/test';
import { lessons } from '../src/content/lessons';

test('register allocation steps through coloring, spills and the register machine', async ({ page }) => {
  await page.goto('/?lab=regalloc');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('K 个寄存器');
  await expect(page.getByLabel('选择一个观察角度')).toHaveValue('ra-loop');
  await expect(page.getByLabel('寄存器个数', { exact: true })).toHaveValue('3');
  await expect(page.getByLabel('本步寄存器分配')).toContainText('live-out');
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  await expect(page.getByRole('region', { name: '干涉图' })).toBeVisible();
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  await expect(page.getByLabel('本步寄存器分配')).toContainText('可能溢出');
  await expect(page.getByLabel('本步寄存器分配')).toContainText('v0_offset');
  await page.getByRole('button', { name: '看最终结果' }).click();
  await expect(page.getByLabel('寄存器分配行为核对')).toContainText('本次输出与错误一致');
  await expect(page.locator('.regalloc-output code')).toHaveText('130');
  await expect(page.getByLabel('寄存器分配结果')).toContainText('v1_scale（溢出变量）');
  await expect(page.getByLabel('寄存器分配结果')).toContainText('每次写入都没有覆盖');
  await expect(page.locator('.regalloc-sweep tr.current')).toContainText('图着色');
  await page.getByRole('button', { name: '上一步', exact: true }).click();
  await expect(page.getByLabel('寄存器机当前状态')).toContainText('执行到程序末尾');
  await page.getByRole('button', { name: '上一步', exact: true }).click();
  await expect(page.getByLabel('寄存器机当前状态')).toContainText('PC');
  await expect(page.getByLabel('寄存器机当前状态')).toContainText('print t4');

  await page.getByRole('radio', { name: '线性扫描' }).check();
  await expect(page.getByRole('slider', { name: '当前步骤' })).toHaveValue('0');
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  await expect(page.getByRole('region', { name: '活跃区间' })).toBeVisible();
  await page.getByRole('button', { name: '看最终结果' }).click();
  await expect(page.getByLabel('寄存器分配结果')).toContainText('v3_sum（溢出变量）');
  await expect(page.locator('.regalloc-sweep tr.current')).toContainText('线性扫描');
  await page.getByRole('button', { name: '分享实验', exact: false }).click();
  const shared = new URL(page.url());
  expect(shared.searchParams.get('regs')).toBe('3');
  expect(shared.searchParams.get('alloc')).toBe('linear');
});

test('live-range holes, copies and traps keep explicit outcomes', async ({ page }) => {
  await page.goto('/?lab=regalloc&regs=2&alloc=linear');
  await expect(page.getByLabel('寄存器个数', { exact: true })).toHaveValue('2');
  await page.getByLabel('选择一个观察角度').selectOption('ra-holes');
  await page.getByRole('button', { name: '看最终结果' }).click();
  await expect(page.getByLabel('寄存器分配结果')).toContainText('v0_t（溢出变量）');
  await page.getByRole('radio', { name: '图着色' }).check();
  await page.getByRole('button', { name: '看最终结果' }).click();
  await expect(page.getByLabel('寄存器分配结果')).not.toContainText('溢出变量');
  await page.getByLabel('选择一个观察角度').selectOption('ra-copy');
  await page.getByRole('button', { name: '看最终结果' }).click();
  await expect(page.getByLabel('寄存器分配结果')).toContainText('2 条复制因两端同寄存器被删除');
  await page.getByLabel('选择一个观察角度').selectOption('ra-trap');
  await page.getByRole('button', { name: '看最终结果' }).click();
  await expect(page.locator('.regalloc-output code')).toHaveText('17');
  await expect(page.getByLabel('寄存器分配行为核对')).toContainText('整数除法的除数不能为 0');
  await page.getByLabel('源程序代码').fill('int i = 0;\nwhile (true) {\n  i = i + 1;\n}');
  await page.getByLabel('源程序代码').press('Control+Enter');
  await page.getByRole('button', { name: '看最终结果' }).click();
  await expect(page.getByLabel('寄存器分配行为核对')).toContainText('暂不能判定');
  await page.setViewportSize({ width: 320, height: 740 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('register allocation connects the learning path and keeps notes local', async ({ page }) => {
  const external: string[] = [];
  page.on('request', (request) => {
    if (!['127.0.0.1', 'localhost'].includes(new URL(request.url()).hostname)) external.push(request.url());
  });
  await page.goto('/?lab=outssa');
  await page.getByRole('button', { name: '原理笔记', exact: true }).click();
  await page.getByLabel('阅读衔接').getByRole('button', { name: /继续：17 寄存器分配/ }).click();
  await expect(page).toHaveURL(/lab=regalloc/);
  await page.getByRole('button', { name: '原理笔记', exact: true }).click();
  await expect(page.getByLabel('一步一步读懂')).toContainText('干涉');
  await expect(page.locator('.reading-source')).toContainText('2026-11-22');
  await page.getByRole('button', { name: '复述自测', exact: true }).click();
  await page.getByRole('button', { name: /总还剩一种/ }).click();
  await expect(page.locator('.quiz-feedback')).toContainText('判断正确');
  await page.getByLabel('寄存器分配的复述笔记').fill('同时活跃才冲突。');
  await page.getByRole('button', { name: '我能解释了' }).click();
  await page.goto('/?lab=notes');
  await expect(page.getByLabel('寄存器分配的笔记', { exact: true })).toHaveValue('同时活跃才冲突。');
  await expect(page.locator('.notebook-toolbar')).toContainText(`1 / ${lessons.length}`);
  expect(external).toEqual([]);
});
