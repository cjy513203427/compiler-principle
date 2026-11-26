import { expect, test } from '@playwright/test';
import { lessons } from '../src/content/lessons';

test('code generation replays tiling, register constraints and x86-64 execution', async ({ page }) => {
  await page.goto('/?lab=codegen');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('a + b + 10');
  await expect(page.getByLabel('选择一个观察角度')).toHaveValue('cg-lea');
  await expect(page.getByLabel('本步代码生成')).toContainText('最大吞进');
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  await expect(page.locator('.codegen-tree code')).toHaveText('Print(Add(Add(v0_a, v1_b), 10))');
  await expect(page.getByLabel('选中的指令模式')).toContainText('lea');
  await expect(page.getByLabel('指令选择得到的虚拟寄存器代码')).toContainText('条安全检查');
  await page.getByLabel('折叠安全检查（范围、溢出、除零）').uncheck();
  await expect(page.getByLabel('指令选择得到的虚拟寄存器代码')).toContainText('movabs r11, 9007199254740991');

  await page.getByRole('button', { name: '看最终结果' }).click();
  await expect(page.getByLabel('代码生成行为核对')).toContainText('本次输出与错误一致');
  await expect(page.getByLabel('x86-64 机器状态')).toContainText('17');
  await expect(page.getByLabel('分配寄存器并布局栈帧后的 x86-64 汇编')).toContainText('push rbp');
  await expect(page.locator('.codegen-sweep tr.current')).toContainText('树覆盖');
  await page.getByText('导出：完整的 .s 文件与运行时').click();
  await expect(page.getByLabel('program.s')).toContainText('.globl main');
  await expect(page.getByLabel('runtime.c')).toContainText('__mc_print_int');

  await page.getByLabel('选择一个观察角度').selectOption('cg-call');
  await page.getByRole('radio', { name: '紧张：rax rcx rdx rbx' }).check();
  await expect(page.getByRole('slider', { name: '当前步骤' })).toHaveValue('0');
  await page.getByRole('button', { name: '看最终结果' }).click();
  await expect(page.getByLabel('虚拟寄存器的分配')).toContainText('栈槽 0');
  await expect(page.getByLabel('分配寄存器并布局栈帧后的 x86-64 汇编')).toContainText('push rbx');
  await expect(page.getByLabel('代码生成行为核对')).toContainText('本次输出与错误一致');
  await page.getByRole('button', { name: '分享实验', exact: false }).click();
  const shared = new URL(page.url());
  expect(shared.searchParams.get('pool')).toBe('tight');
  expect(shared.searchParams.get('ir')).toBe('raw');
});

test('runtime errors keep earlier output, and the lab works on a small screen with the keyboard', async ({ page }) => {
  await page.goto('/?lab=codegen&pool=full&ir=optimized');
  await expect(page.getByRole('radio', { name: '实验 05 优化后的 IR' })).toBeChecked();
  await page.getByLabel('选择一个观察角度').selectOption('cg-range');
  await page.getByRole('button', { name: '看最终结果' }).click();
  await expect(page.getByLabel('代码生成行为核对')).toContainText('计算结果超出安全整数范围');
  await expect(page.getByLabel('代码生成行为核对')).toContainText('4503599627370495, 9007199254740990');
  await page.getByLabel('选择一个观察角度').selectOption('cg-trap');
  await page.getByRole('button', { name: '看最终结果' }).click();
  await expect(page.getByLabel('代码生成行为核对')).toContainText('整数除法的除数不能为 0');

  await page.setViewportSize({ width: 320, height: 740 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('slider', { name: '当前步骤' }).focus();
  await page.keyboard.press('Home');
  await expect(page.getByRole('slider', { name: '当前步骤' })).toHaveValue('0');
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('slider', { name: '当前步骤' })).toHaveValue('1');
  await expect(page.getByLabel('本步代码生成')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('code generation sits in the backend route, cites sources and keeps notes local', async ({ page }) => {
  const external: string[] = [];
  page.on('request', (request) => {
    if (!['127.0.0.1', 'localhost'].includes(new URL(request.url()).hostname)) external.push(request.url());
  });
  await page.goto('/');
  await page.getByLabel('建议学习路线').getByRole('button', { name: '打开实验 22 指令选择与代码生成' }).click();
  await expect(page).toHaveURL(/lab=codegen/);

  await page.getByRole('button', { name: '原理笔记', exact: true }).click();
  await expect(page.locator('.reading-source')).toContainText('Instruction Selection');
  await expect(page.locator('.reading-source')).toContainText('System V AMD64');

  await page.getByRole('button', { name: '复述自测', exact: true }).click();
  await page.getByRole('button', { name: /只能用 callee-saved 寄存器/ }).click();
  await expect(page.locator('.quiz-feedback')).toContainText('判断正确');
  await page.getByLabel('指令选择与代码生成的复述笔记').fill('跨调用的值只能放 callee-saved 或栈。');
  await page.getByRole('button', { name: '我能解释了' }).click();

  await page.goto('/?lab=notes');
  await expect(page.getByLabel('指令选择与代码生成的笔记', { exact: true })).toHaveValue('跨调用的值只能放 callee-saved 或栈。');
  await expect(page.locator('.notebook-toolbar')).toContainText(`1 / ${lessons.length}`);
  expect(external).toEqual([]);
});
