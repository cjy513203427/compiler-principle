import { expect, test } from '@playwright/test';
import { lessons } from '../src/content/lessons';

test('SSA replays renaming, selects the actual phi input and updates edited branches', async ({ page }) => {
  await page.goto('/?lab=ssa');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('同一个变量');
  await expect(page.getByLabel('源程序代码')).toHaveValue(/bool choose/);
  await expect(page.getByLabel('选择一个观察角度')).toHaveValue('ssa-diamond');
  await expect(page.locator('.ssa-all-blocks')).toHaveCount(0);
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  await expect(page.getByLabel('本步 SSA 操作')).toContainText('入口活跃');
  await page.getByRole('button', { name: '看最终结果' }).click();
  await expect(page.locator('.ssa-status')).toContainText('SSA 校验通过');
  await expect(page.getByLabel('SSA 行为核对')).toContainText('本次输出与错误一致');
  await expect(page.locator('.ssa-output code')).toHaveText('7');
  await page.getByLabel('SSA 对照基本块').selectOption('B3');
  await expect(page.locator('.ssa-code-comparison')).toContainText('φ([B1:');
  await page.getByLabel('SSA 对照基本块').focus();
  await page.keyboard.press('Home');
  await expect(page.getByLabel('SSA 对照基本块')).toHaveValue('B0');
  const code = await page.getByLabel('源程序代码').inputValue();
  await page.getByLabel('源程序代码').fill(code.replace('true', 'false'));
  await expect(page.getByRole('button', { name: '播放', exact: true })).toBeDisabled();
  await page.getByLabel('源程序代码').press('Control+Enter');
  await expect(page.getByRole('slider', { name: '当前步骤' })).toHaveValue('0');
  await expect(page.locator('.ssa-all-blocks')).toHaveCount(0);
  await page.getByRole('button', { name: '看最终结果' }).click();
  await expect(page.locator('.ssa-output code')).toHaveText('9');
  await page.getByLabel('SSA 对照基本块').selectOption('B3');
  await expect(page.locator('.ssa-code-comparison')).toContainText('φ([B1:');
  await page.getByRole('button', { name: '重置步骤' }).click();
  await expect(page.locator('.ssa-output code')).toHaveText('等待 print…');
  await page.getByRole('button', { name: '恢复示例', exact: true }).click();
  await expect(page.getByLabel('选择一个观察角度')).toHaveValue('ssa-diamond');
  await expect(page.getByLabel('源程序代码')).toHaveValue(/choose = true/);
});

test('SSA shows live-in pruning, loop phi selections, runtime errors and limits', async ({ page }) => {
  await page.goto('/?lab=ssa');
  await page.getByLabel('选择一个观察角度').selectOption('ssa-pruned');
  await page.getByRole('button', { name: '看最终结果' }).click();
  await expect(page.getByLabel('φ 候选与活跃性裁剪')).toContainText('裁掉 φ');
  await expect(page.locator('.ssa-output code')).toHaveText('11');
  await page.getByLabel('选择一个观察角度').selectOption('ssa-loop');
  await expect(page.getByLabel('选择一个观察角度')).toHaveValue('ssa-loop');
  await page.getByRole('button', { name: '看最终结果' }).click();
  await expect(page.locator('.ssa-output code')).toHaveText('6');
  await page.getByLabel('SSA 对照基本块').selectOption('B1');
  await expect(page.locator('.ssa-code-comparison')).toContainText('φ([B0:');
  const last = Number(await page.getByRole('slider', { name: '当前步骤' }).getAttribute('max'));
  // Locate an actual phi entry by moving the public replay slider; the source determines the trace.
  let found = false;
  for (let step = last - 1; step >= 0; step--) {
    await page.getByRole('slider', { name: '当前步骤' }).fill(String(step));
    if (await page.getByLabel('本次 φ 输入选择').count()) { found = true; break; }
  }
  expect(found).toBe(true);
  await expect(page.getByLabel('本次 φ 输入选择')).toContainText('来自 B2');
  await expect(page.getByLabel('本次 φ 输入选择')).toContainText('同时写入');
  await page.getByLabel('选择一个观察角度').selectOption('ssa-trap');
  await page.getByRole('button', { name: '看最终结果' }).click();
  await expect(page.locator('.ssa-output code')).toHaveText('5');
  await expect(page.getByLabel('SSA 行为核对')).toContainText('整数除法的除数不能为 0');
  await expect(page.getByLabel('SSA 行为核对')).toContainText('本次输出与错误一致');
  await page.getByLabel('源程序代码').fill('while (true) {}');
  await page.getByRole('button', { name: '运行编译' }).click();
  await page.getByRole('button', { name: '看最终结果' }).click();
  await expect(page.getByLabel('SSA 行为核对')).toContainText('暂不能判定');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('SSA reading, notes, legacy import and sharing stay local', async ({ page }) => {
  const external: string[] = [];
  page.on('request', (request) => {
    if (!['127.0.0.1', 'localhost'].includes(new URL(request.url()).hostname)) external.push(request.url());
  });
  await page.goto('/?lab=ssa');
  await page.getByRole('button', { name: '原理笔记', exact: true }).click();
  await expect(page.getByLabel('一步一步读懂')).toContainText('版本栈');
  await expect(page.locator('.reading-source')).toContainText('2026-11-21');
  await page.getByRole('button', { name: '复述自测', exact: true }).click();
  await page.getByRole('button', { name: /x.2 的值/ }).click();
  await expect(page.locator('.quiz-feedback')).toContainText('判断正确');
  await page.getByLabel('静态单赋值的复述笔记').fill('φ 根据前驱边选择版本。');
  await page.getByRole('button', { name: '我能解释了' }).click();
  await page.goto('/?lab=notes');
  await expect(page.getByLabel('静态单赋值的笔记', { exact: true })).toHaveValue('φ 根据前驱边选择版本。');
  await expect(page.locator('.notebook-toolbar')).toContainText(`1 / ${lessons.length}`);
  await page.getByLabel('导入笔记文件').setInputFiles({ name: 'old.json', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ version: 1, notes: { lex: '旧笔记' }, completed: ['lex'] })) });
  await expect(page.getByLabel('词法分析的笔记', { exact: true })).toHaveValue('旧笔记');
  await expect(page.getByLabel('静态单赋值的笔记', { exact: true })).toHaveValue('φ 根据前驱边选择版本。');
  await page.goto('/?lab=ssa');
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  await page.getByRole('button', { name: '分享实验', exact: false }).click();
  const shared = page.url();
  expect(shared).not.toContain('前驱边选择');
  await page.goto(shared);
  await expect(page.getByRole('slider', { name: '当前步骤' })).toHaveValue('1');
  expect(external).toEqual([]);
});
