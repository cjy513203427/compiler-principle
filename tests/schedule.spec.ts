import { expect, test } from '@playwright/test';
import { lessons } from '../src/content/lessons';

test('scheduling replays dependences and cycles, then checks behaviour and timing', async ({ page }) => {
  await page.goto('/?lab=schedule');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('干等');
  await expect(page.getByLabel('选择一个观察角度')).toHaveValue('sc-params');
  await expect(page.getByLabel('本步指令排序')).toContainText('load（从栈槽读取）');
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  await expect(page.getByLabel('本步指令排序')).toContainText('没有找到');
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  await expect(page.getByRole('region', { name: '依赖图' })).toContainText('真依赖');
  await expect(page.getByRole('region', { name: '依赖图' })).toContainText('反依赖');
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  await expect(page.getByRole('region', { name: '逐周期发出' })).toContainText('周期');
  await page.getByRole('button', { name: '看最终结果' }).click();
  await expect(page.getByLabel('指令排序行为核对')).toContainText('和原始 VM 一致');
  await expect(page.getByLabel('选择基本块')).toContainText('29 → 27 周期');
  await expect(page.getByLabel('排序前后对照')).toContainText('先后顺序没有改变');
  await expect(page.locator('.schedule-sweep tr.current')).toContainText('3');
  await page.getByText('查看排序后的执行时间线（前 80 条）').click();
  await expect(page.getByLabel('执行时间线，可横向滚动')).toContainText('load');

  await page.getByLabel('寄存器个数', { exact: true }).selectOption('6');
  await expect(page.getByRole('slider', { name: '当前步骤' })).toHaveValue('0');
  await page.getByRole('button', { name: '看最终结果' }).click();
  await expect(page.getByLabel('选择基本块')).toContainText('13 → 13 周期');
  await page.getByRole('button', { name: '分享实验', exact: false }).click();
  expect(new URL(page.url()).searchParams.get('regs')).toBe('6');
});

test('peephole and exception order are visible; narrow screens do not scroll sideways', async ({ page }) => {
  await page.goto('/?lab=schedule');
  await page.getByLabel('选择一个观察角度').selectOption('sc-peephole');
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  await expect(page.getByLabel('本步指令排序')).toContainText('冗余');
  await expect(page.getByLabel('改写后')).toBeVisible();
  await page.getByRole('button', { name: '看最终结果' }).click();
  await expect(page.getByLabel('三个版本的周期对照，可横向滚动')).toContainText('窥孔优化后');
  await page.getByLabel('选择一个观察角度').selectOption('sc-trap');
  await page.getByRole('button', { name: '看最终结果' }).click();
  await expect(page.getByLabel('指令排序行为核对')).toContainText('整数除法的除数不能为 0');
  await page.setViewportSize({ width: 320, height: 740 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('scheduling follows register allocation in the learning path and keeps notes local', async ({ page }) => {
  const external: string[] = [];
  page.on('request', (request) => {
    if (!['127.0.0.1', 'localhost'].includes(new URL(request.url()).hostname)) external.push(request.url());
  });
  await page.goto('/?lab=regalloc&regs=2');
  await page.getByRole('button', { name: '原理笔记', exact: true }).click();
  await page.getByLabel('阅读衔接').getByRole('button', { name: /继续：18 指令排序与窥孔优化/ }).click();
  await expect(page).toHaveURL(/lab=schedule/);
  await expect(page.getByLabel('寄存器个数', { exact: true })).toHaveValue('2');
  await page.getByRole('button', { name: '原理笔记', exact: true }).click();
  await expect(page.getByLabel('一步一步读懂')).toContainText('列表调度');
  await expect(page.locator('.reading-source')).toContainText('第 08 讲');
  await page.getByRole('button', { name: '复述自测', exact: true }).click();
  await page.getByRole('button', { name: /反依赖/ }).click();
  await expect(page.locator('.quiz-feedback')).toContainText('判断正确');
  await page.getByLabel('指令排序与窥孔优化的复述笔记').fill('伪依赖来自寄存器复用。');
  await page.getByRole('button', { name: '我能解释了' }).click();
  await page.goto('/?lab=notes');
  await expect(page.getByLabel('指令排序与窥孔优化的笔记', { exact: true })).toHaveValue('伪依赖来自寄存器复用。');
  await expect(page.locator('.notebook-toolbar')).toContainText(`1 / ${lessons.length}`);
  expect(external).toEqual([]);
});
