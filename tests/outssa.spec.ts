import { expect, test } from '@playwright/test';
import { lessons } from '../src/content/lessons';

test('out-of-SSA splits a critical edge and executes the real converted bytecode', async ({ page }) => {
  await page.goto('/?lab=outssa');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('去掉 φ');
  await expect(page.getByLabel('选择一个观察角度')).toHaveValue('out-critical');
  await expect(page.getByLabel('边复制计划')).toHaveCount(0);
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  await expect(page.getByLabel('本步 SSA 消除')).toContainText('拆分关键边');
  await expect(page.getByLabel('本步 SSA 消除')).toContainText('B0 → E0 → B2');
  await page.getByRole('button', { name: '看最终结果' }).click();
  await expect(page.getByLabel('SSA 消除行为核对')).toContainText('三种执行的本次输出与错误一致');
  await expect(page.locator('.outssa-output code')).toHaveText('1');
  await expect(page.locator('.outssa-visited')).toContainText('E0');
  await page.getByLabel('SSA 消除对照块').selectOption('E0');
  await expect(page.getByLabel('SSA 与消除后的块对照')).toContainText('新增边块');
  await expect(page.getByLabel('SSA 与消除后的块对照')).toContainText('v1_value.1');
  const source = await page.getByLabel('源程序代码').inputValue();
  await page.getByLabel('源程序代码').fill(source.replace('false', 'true'));
  await expect(page.getByRole('button', { name: '播放', exact: true })).toBeDisabled();
  await page.getByLabel('源程序代码').press('Control+Enter');
  await expect(page.getByRole('slider', { name: '当前步骤' })).toHaveValue('0');
  await page.getByRole('button', { name: '看最终结果' }).click();
  await expect(page.locator('.outssa-output code')).toHaveText('7');
  await expect(page.getByLabel('边复制计划')).toContainText('E0');
  await expect(page.locator('.outssa-visited')).not.toContainText('E0');
  await page.getByRole('button', { name: '重置步骤' }).click();
  await expect(page.locator('.outssa-output code')).toHaveText('等待 print…');
});

test('the parallel-copy workbench exposes swaps and validates live edits', async ({ page }) => {
  await page.goto('/?lab=outssa');
  await page.getByText('并行复制小实验 / 编辑一个复制环', { exact: true }).click();
  await expect(page.locator('.copy-verdict')).toContainText('直接顺序复制改变了结果');
  await expect(page.getByLabel('调度生成的顺序复制')).toContainText('__phi_tmp0');
  await expect(page.locator('.copy-results tbody tr').last()).toHaveText(/b\s*2\s*1\s*2\s*1/);
  await page.getByLabel('选择并行复制场景').selectOption('chain');
  await expect(page.locator('.copy-verdict')).toContainText('调度结果符合并行语义');
  await page.getByLabel('选择并行复制场景').selectOption('identity');
  await expect(page.locator('.copy-verdict')).toContainText('恰好正确');
  await page.getByLabel('并行复制与初始值').fill('a <- b\na <- c\n%%\nb = 1\nc = 2');
  await expect(page.getByRole('alert')).toContainText('每个目标只能写入一次');
  await page.getByLabel('并行复制与初始值').fill('a <- b\n%%\na = 1');
  await expect(page.getByRole('alert')).toContainText('每个复制源都需要初始值');
  await page.getByLabel('选择并行复制场景').selectOption('swap');
  await expect(page.locator('.copy-verdict')).toContainText('调度结果符合并行语义');
  await page.setViewportSize({ width: 320, height: 740 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('loops, no-phi programs, runtime errors and budgets keep explicit outcomes', async ({ page }) => {
  await page.goto('/?lab=outssa');
  await page.getByLabel('选择一个观察角度').selectOption('out-loop');
  await page.getByRole('button', { name: '看最终结果' }).click();
  await expect(page.locator('.outssa-output code')).toHaveText('6');
  await expect(page.getByLabel('SSA 消除行为核对')).toContainText('三种执行的本次输出与错误一致');
  await page.getByRole('button', { name: '上一步', exact: true }).click();
  await expect(page.getByLabel('消除后 VM 当前状态')).toContainText('PC');
  await page.getByLabel('选择一个观察角度').selectOption('out-straight');
  await page.getByRole('button', { name: '看最终结果' }).click();
  await expect(page.getByLabel('边复制计划')).toContainText('不需要边复制');
  await page.getByLabel('选择一个观察角度').selectOption('out-trap');
  await page.getByRole('button', { name: '看最终结果' }).click();
  await expect(page.locator('.outssa-output code')).toHaveText('5');
  await expect(page.getByLabel('SSA 消除行为核对')).toContainText('整数除法的除数不能为 0');
  await page.getByLabel('源程序代码').fill('while (true) {}');
  await page.getByRole('button', { name: '运行编译' }).click();
  await page.getByRole('button', { name: '看最终结果' }).click();
  await expect(page.getByLabel('SSA 消除行为核对')).toContainText('暂不能判定');
});

test('out-of-SSA connects the learning path and keeps notes and share state local', async ({ page }) => {
  const external: string[] = [];
  page.on('request', (request) => {
    if (!['127.0.0.1', 'localhost'].includes(new URL(request.url()).hostname)) external.push(request.url());
  });
  await page.goto('/?lab=ssa');
  await page.getByRole('button', { name: '原理笔记', exact: true }).click();
  await page.getByLabel('阅读衔接').getByRole('button', { name: /继续：15 SSA 消除/ }).click();
  await expect(page).toHaveURL(/lab=outssa/);
  await page.goto('/?lab=outssa');
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  await page.getByRole('button', { name: '分享实验', exact: false }).click();
  const shared = page.url();
  await page.getByRole('button', { name: '原理笔记', exact: true }).click();
  await expect(page.getByLabel('一步一步读懂')).toContainText('关键边');
  await expect(page.locator('.reading-source')).toContainText('2026-11-21');
  await page.getByRole('button', { name: '复述自测', exact: true }).click();
  await page.getByRole('button', { name: /tmp ← a；a ← b；b ← tmp/ }).click();
  await expect(page.locator('.quiz-feedback')).toContainText('判断正确');
  await page.getByLabel('SSA 消除的复述笔记').fill('边上的复制必须保留旧值。');
  await page.getByRole('button', { name: '我能解释了' }).click();
  await page.goto('/?lab=notes');
  await expect(page.getByLabel('SSA 消除的笔记', { exact: true })).toHaveValue('边上的复制必须保留旧值。');
  await expect(page.locator('.notebook-toolbar')).toContainText(`1 / ${lessons.length}`);
  await page.getByLabel('导入笔记文件').setInputFiles({ name: 'old.json', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ version: 1, notes: { ssa: '原有 SSA 笔记' }, completed: ['ssa'] })) });
  await expect(page.getByLabel('静态单赋值的笔记', { exact: true })).toHaveValue('原有 SSA 笔记');
  await expect(page.getByLabel('SSA 消除的笔记', { exact: true })).toHaveValue('边上的复制必须保留旧值。');
  await page.goto(shared);
  await expect(page.getByRole('slider', { name: '当前步骤' })).toHaveValue('1');
  expect(shared).not.toContain('保留旧值');
  expect(external).toEqual([]);
});
