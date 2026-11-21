import { expect, test, type Page } from '@playwright/test';
import { lessons } from '../src/content/lessons';

async function openLab(page: Page, name: RegExp) {
  if (await page.getByRole('button', { name: '切换课程目录' }).isVisible())
    await page.getByRole('button', { name: '切换课程目录' }).click();
  await page.getByRole('link', { name }).click();
}

test('minimization replays real splits and finds equivalent states and shortest suffixes', async ({ page }) => {
  await page.goto('/?lab=minimize');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('今后的行为');
  await expect(page.getByLabel('词法规则与输入')).toHaveValue('Tok: ab|cb\n%%\nabcb');
  await expect(page.getByLabel('状态能否合并')).toHaveCount(0);
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  await expect(page.locator('.min-evidence')).toContainText('旧组');
  await page.getByRole('button', { name: '看最终结果' }).click();
  await expect(page.getByLabel('最小化状态数')).toContainText('最小化扫描器 3 个状态');
  await expect(page.locator('.min-query-result')).toContainText('两个状态等价');
  await page.getByLabel('区分查询左状态').selectOption('0');
  await page.getByLabel('区分查询右状态').selectOption('1');
  await expect(page.locator('.min-query-result')).toContainText('"b"');
  await expect(page.locator('.min-witness')).toContainText('Dead');
  await expect(page.getByLabel('最小化等价校验')).toContainText('全部后缀的获胜规则一致');
  await expect(page.getByLabel('最小化 DFA 扫描')).toContainText('"ab"');
  await expect(page.getByLabel('最小化 DFA 扫描')).toContainText('"cb"');
  await page.getByRole('button', { name: '上一步', exact: true }).click();
  await expect(page.getByLabel('状态能否合并')).toHaveCount(0);
  await page.getByRole('button', { name: '重置步骤' }).click();
  await expect(page.getByRole('slider', { name: '当前步骤' })).toHaveValue('0');
  await page.getByLabel('选择一个观察角度').selectOption('min-rules');
  await page.getByRole('button', { name: '看最终结果' }).click();
  await page.getByLabel('区分查询左状态').selectOption('3');
  await page.getByLabel('区分查询右状态').selectOption('4');
  await expect(page.locator('.min-query-result')).toContainText('ε（空串）');
  await expect(page.getByLabel('最小化状态数')).toContainText('最小化扫描器 5 个状态');
});

test('priorities, rollback, errors and incomplete input are preserved across edits', async ({ page }) => {
  await page.goto('/?lab=minimize');
  await page.getByLabel('选择一个观察角度').selectOption('min-keyword');
  await page.getByRole('button', { name: '看最终结果' }).click();
  await expect(page.getByLabel('最小化 DFA 扫描')).toContainText('skip / 丢弃');
  await expect(page.getByLabel('最小化 DFA 扫描')).toContainText('"integer"');
  await page.getByLabel('选择一个观察角度').selectOption('min-rollback');
  await page.getByRole('button', { name: '看最终结果' }).click();
  await expect(page.getByLabel('最小化 DFA 扫描')).toContainText('"3.14"');
  await expect(page.getByLabel('最小化 DFA 扫描')).toContainText('"."');
  await page.getByLabel('选择一个观察角度').selectOption('min-error');
  await page.getByRole('button', { name: '看最终结果' }).click();
  await expect(page.getByLabel('原始 DFA 扫描')).toContainText('起始位置 2');
  await expect(page.getByLabel('最小化 DFA 扫描')).toContainText('起始位置 2');
  await page.getByLabel('词法规则与输入').fill('All: (.|\\n)+\n%%\nabc');
  await page.getByLabel('词法规则与输入').press('Control+Enter');
  await page.getByRole('button', { name: '看最终结果' }).click();
  await expect(page.getByLabel('最小化状态数')).toContainText('无可达 Dead');
  await expect(page.getByLabel('本步分割细化')).toContainText('不存在可达 Dead');
  await page.getByLabel('词法规则与输入').fill('A: (a\n%%\na');
  await expect(page.getByRole('button', { name: '播放', exact: true })).toBeDisabled();
  await page.getByLabel('词法规则与输入').press('Control+Enter');
  await expect(page.getByRole('alert')).toContainText('缺少右括号');
  await page.getByLabel('词法规则与输入').fill('Tail: (a|b)*a(a|b)(a|b)(a|b)(a|b)(a|b)(a|b)\n%%\nab');
  await page.getByRole('button', { name: '最小化 DFA', exact: false }).click();
  await expect(page.getByRole('alert')).toContainText('不进行最小化');
  await expect(page.getByLabel('最小化 DFA 扫描')).toHaveCount(0);
});

test('minimization has reading, self-check, private notes and shareable applied state', async ({ page }) => {
  const external: string[] = [];
  page.on('request', (request) => {
    if (!['127.0.0.1', 'localhost'].includes(new URL(request.url()).hostname)) external.push(request.url());
  });
  await page.goto('/?lab=minimize');
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  await page.getByRole('button', { name: '分享实验', exact: false }).click();
  const shared = page.url();
  await page.getByRole('button', { name: '原理笔记', exact: true }).click();
  await expect(page.getByLabel('一步一步读懂')).toContainText('分组');
  await expect(page.locator('.reading-source')).toContainText('2026-11-21');
  await page.getByRole('button', { name: '复述自测', exact: true }).click();
  await page.getByRole('button', { name: /还要比较获胜规则与所有后缀/ }).click();
  await expect(page.locator('.quiz-feedback')).toContainText('判断正确');
  await page.getByLabel('DFA 最小化的复述笔记').fill('不能合并不同获胜规则。');
  await page.getByRole('button', { name: '我能解释了' }).click();
  await page.goto('/?lab=notes');
  await expect(page.getByLabel('DFA 最小化的笔记', { exact: true })).toHaveValue('不能合并不同获胜规则。');
  await expect(page.locator('.notebook-toolbar')).toContainText(`1 / ${lessons.length}`);
  await page.getByLabel('导入笔记文件').setInputFiles({ name: 'old.json', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ version: 1, notes: { ssa: '旧 SSA 笔记' }, completed: ['ssa'] })) });
  await expect(page.getByLabel('静态单赋值的笔记', { exact: true })).toHaveValue('旧 SSA 笔记');
  await expect(page.getByLabel('DFA 最小化的笔记', { exact: true })).toHaveValue('不能合并不同获胜规则。');
  await page.goto(shared);
  await expect(page.getByRole('slider', { name: '当前步骤' })).toHaveValue('1');
  expect(shared).not.toContain('不能合并');
  expect(external).toEqual([]);
});

test('own inputs remain separate and 320px controls work by keyboard', async ({ page }) => {
  await page.goto('/?lab=lex');
  await page.getByLabel('源程序代码').fill('int kept = 2; print(kept);');
  await page.getByRole('button', { name: '运行编译' }).click();
  await openLab(page, /DFA 最小化/);
  await page.getByLabel('词法规则与输入').fill('A: a+\n%%\naaa');
  await page.getByRole('button', { name: '最小化 DFA', exact: false }).click();
  await openLab(page, /正则与自动机/);
  await expect(page.getByLabel('词法规则与输入')).toHaveValue(/Int: int/);
  await openLab(page, /DFA 最小化/);
  await expect(page.getByLabel('词法规则与输入')).toHaveValue('A: a+\n%%\naaa');
  await openLab(page, /词法分析/);
  await expect(page.getByLabel('源程序代码')).toHaveValue('int kept = 2; print(kept);');
  await page.setViewportSize({ width: 320, height: 740 });
  await openLab(page, /DFA 最小化/);
  await page.getByRole('button', { name: '恢复示例', exact: true }).click();
  await page.getByRole('button', { name: '看最终结果' }).click();
  await page.getByLabel('区分查询左状态').focus();
  await page.keyboard.press('Home');
  await expect(page.getByLabel('区分查询左状态')).toHaveValue('0');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
