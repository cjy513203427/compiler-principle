import { test, expect } from '@playwright/test';
import { lessons } from '../src/content/lessons';

test('CFG replays actual branches, loops and scoped state without stale frames', async ({
  page,
}) => {
  await page.goto('/?lab=cfg');
  await expect(page.getByLabel('源程序代码')).toHaveValue(/score/);
  await expect(page.locator('.cfg-graph')).toBeVisible();
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  await expect(page.locator('.cfg-edge.active text')).toHaveText('true');
  const code = await page.getByLabel('源程序代码').inputValue();
  await page.getByLabel('源程序代码').fill(code.replace('75', '40'));
  await page.getByRole('button', { name: '运行编译' }).click();
  await expect(page.getByRole('slider', { name: '当前步骤' })).toHaveValue('0');
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  await expect(page.locator('.cfg-edge.active text')).toHaveText('false');
  await page.getByRole('button', { name: '看最终结果' }).click();
  await expect(page.locator('.output-console pre')).toHaveText('2');
  await page.getByLabel('选择一个观察角度').selectOption('loop');
  await page.getByRole('button', { name: '看最终结果' }).click();
  await expect(page.locator('.output-console pre')).toHaveText('6');
  await expect(page.locator('.cfg-memory')).toContainText('4');
  await page.getByRole('button', { name: '上一步', exact: true }).click();
  await page.getByRole('button', { name: '重置步骤' }).click();
  await expect(page.locator('.output-console pre')).toHaveText('等待 print…');
  await page.getByRole('button', { name: '检查基本块 B1', exact: true }).click();
  await expect(page.locator('.cfg-inspection summary')).toContainText('B1');
  await page.getByLabel('选择一个观察角度').selectOption('zero-loop');
  await page.getByRole('button', { name: '看最终结果' }).click();
  await expect(page.locator('.output-console pre')).toHaveText('99');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('execution limits remain explicit when cross-block optimization is enabled', async ({
  page,
}) => {
  await page.goto('/?lab=cfg');
  await page.getByLabel('选择一个观察角度').selectOption('loop-limit');
  await expect(page.getByRole('alert')).toContainText('回放已暂停');
  await page.getByRole('button', { name: '看最终结果' }).click();
  await expect(page.locator('.step-explanation')).toContainText('上限');
  await expect(page.locator('.output-console pre')).toHaveText('等待 print…');
  await page.goto('/?lab=optimize&code=' + encodeURIComponent('while (true) {}'));
  await expect(page.getByLabel('常量折叠', { exact: true })).toBeEnabled();
  await expect(page.locator('.equivalence')).toContainText('暂不能判定行为一致');
  await page.getByRole('button', { name: '看最终结果' }).click();
  await expect(page.locator('.step-explanation')).toContainText('活跃变量');
});

test('readable font sizes hold at narrow widths and new notes coexist with old notes', async ({
  page,
}) => {
  await page.goto('/?lab=cfg');
  expect(
    await page
      .getByLabel('源程序代码')
      .evaluate((element) => parseFloat(getComputedStyle(element).fontSize)),
  ).toBeGreaterThanOrEqual(13);
  expect(
    await page
      .locator('.step-explanation p')
      .evaluate((element) => parseFloat(getComputedStyle(element).fontSize)),
  ).toBeGreaterThanOrEqual(13);
  await page.getByRole('button', { name: '原理笔记', exact: true }).click();
  expect(
    await page
      .locator('.reading-page section p')
      .first()
      .evaluate((element) => parseFloat(getComputedStyle(element).fontSize)),
  ).toBeGreaterThanOrEqual(13);
  await page.getByRole('button', { name: '复述自测', exact: true }).click();
  await page.getByLabel('控制流图的复述笔记').fill('循环条件每轮重算。');
  await page.getByRole('button', { name: '我能解释了' }).click();
  await page.goto('/?lab=notes');
  await expect(page.getByLabel('控制流图的笔记')).toHaveValue('循环条件每轮重算。');
  await expect(page.locator('.notebook-toolbar')).toContainText(`1 / ${lessons.length}`);
  await page.setViewportSize({ width: 320, height: 740 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('home computes the example and all labs render with no external requests', async ({
  page,
}) => {
  const failures: string[] = [];
  const external: string[] = [];
  page.on('pageerror', (error) => failures.push(error.message));
  page.on('request', (request) => {
    if (!new URL(request.url()).hostname.match(/^(127\.0\.0\.1|localhost)$/))
      external.push(request.url());
  });
  await page.goto('/');
  await expect(page.locator('.demo-result strong')).toHaveText('14');
  await page.getByRole('button', { name: '给加法加一对括号' }).click();
  await expect(page.locator('.demo-result strong')).toHaveText('20');
  for (const stage of lessons.map((lesson) => lesson.id)) {
    await page.goto(`/?lab=${stage}`);
    await expect(page.locator('.result-content')).toBeVisible();
    await expect(page.getByRole('button', { name: '看最终结果' })).toBeVisible();
    await page.getByRole('button', { name: '看最终结果' }).click();
    await expect(page.locator('.step-explanation')).not.toBeEmpty();
    if (stage === 'vm') await expect(page.locator('.output-console pre')).toHaveText('14');
    if (stage === 'lex') await expect(page.locator('.token-eof')).toBeInViewport();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  }
  expect(failures).toEqual([]);
  expect(external).toEqual([]);
});

test('single stepping, backward, play, reset and source changes rebuild the trace', async ({
  page,
}) => {
  await page.goto('/?lab=lex');
  const range = page.getByRole('slider', { name: '当前步骤' });
  await expect(range).toHaveValue('0');
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  await expect(range).toHaveValue('1');
  await page.getByRole('button', { name: '上一步', exact: true }).click();
  await expect(range).toHaveValue('0');
  await page.getByRole('button', { name: '播放', exact: true }).click();
  await expect.poll(async () => Number(await range.inputValue())).toBeGreaterThan(0);
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  const paused = await range.inputValue();
  await page.waitForTimeout(950);
  await expect(range).toHaveValue(paused);
  await page.getByRole('button', { name: '重置步骤' }).click();
  await expect(range).toHaveValue('0');
  await page.getByLabel('源程序代码').fill('int integer = 7; print(integer);');
  await expect(page.getByRole('button', { name: '播放', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '运行编译' }).click();
  await page.getByRole('button', { name: '看最终结果' }).click();
  await expect(page.locator('.token-identifier code').first()).toHaveText('integer');
  await page.getByLabel('选择一个观察角度').selectOption('shadow');
  await expect(range).toHaveValue('0');
});

test('diagnostics identify semantic and syntax errors while earlier stages remain inspectable', async ({
  page,
}) => {
  await page.goto('/?lab=semantic');
  await page.getByLabel('选择一个观察角度').selectOption('type-error');
  await expect(page.getByRole('alert')).toContainText('不能用 bool 初始化 int');
  await expect(page.locator('.blocked-state')).toBeVisible();
  await page.goto('/?lab=parse');
  await page.getByLabel('选择一个观察角度').selectOption('undefined');
  await expect(page.locator('.ast-tree')).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('尚未声明');
  await page.getByLabel('选择一个观察角度').selectOption('syntax-error');
  await expect(page.getByRole('alert')).toContainText('期望「;」');
});

test('optimization switches preserve observable errors and VM source arithmetic can be replayed', async ({
  page,
}) => {
  await page.goto('/?lab=optimize');
  await page.getByRole('button', { name: '看最终结果' }).click();
  await expect(page.locator('.comparison>div').last()).toContainText('print 14');
  await page.getByLabel('清理无用写入', { exact: true }).uncheck();
  await page.getByRole('button', { name: '看最终结果' }).click();
  await expect(page.locator('.comparison>div').last()).toContainText('v0_result');
  await page.getByLabel('选择一个观察角度').selectOption('trap');
  await expect(page.getByRole('alert')).toContainText('除数不能为 0');
  await expect(page.locator('.equivalence')).toContainText('输出与错误一致');
  await page.goto('/?lab=vm');
  await expect(page.locator('.bytecode')).toContainText('MUL');
  await page.getByRole('button', { name: '看最终结果' }).click();
  await expect(page.locator('.output-console pre')).toHaveText('14');
  await page.getByRole('button', { name: '上一步', exact: true }).click();
  await expect(page.locator('.step-explanation')).toContainText('PRINT');
});

test('recall, private notes, progress, export and import survive reload', async ({ page }) => {
  await page.goto('/?lab=lex');
  await page.getByRole('button', { name: '复述自测', exact: true }).click();
  await page.getByRole('button', { name: 'B 5 个' }).click();
  await expect(page.locator('.quiz-feedback')).toContainText('判断正确');
  await page.getByLabel('词法分析的复述笔记').fill('先最长匹配，再分类。我的私人笔记');
  await page.getByRole('button', { name: '我能解释了' }).click();
  await page.reload();
  await page.getByRole('button', { name: '复述自测', exact: true }).click();
  await expect(page.getByLabel('词法分析的复述笔记')).toHaveValue(
    '先最长匹配，再分类。我的私人笔记',
  );
  await expect(page.getByRole('button', { name: '已复习 · 点击撤销' })).toBeVisible();
  await page.getByRole('button', { name: '分享实验' }).click();
  expect(page.url()).not.toContain('私人');
  expect(page.url()).not.toContain('notes');
  await page.goto('/?lab=notes');
  await expect(page.getByLabel('词法分析的笔记')).toHaveValue('先最长匹配，再分类。我的私人笔记');
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出笔记' }).click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toBe('编译手记.json');
  await page.getByLabel('导入笔记文件').setInputFiles({
    name: 'notes.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({ version: 1, notes: { parse: '导入的语法笔记' }, completed: ['parse'] }),
    ),
  });
  await expect(page.getByLabel('语法分析的笔记')).toHaveValue('导入的语法笔记');
  await expect(page.getByLabel('词法分析的笔记')).toHaveValue('先最长匹配，再分类。我的私人笔记');
});

test('sharing restores code, options and step; invalid URLs stay usable', async ({ page }) => {
  await page.goto('/?lab=vm&code=print(10%20-%203)%3B&step=3&opt=000');
  await expect(page.getByLabel('源程序代码')).toHaveValue('print(10 - 3);');
  await expect(page.getByRole('slider', { name: '当前步骤' })).toHaveValue('3');
  await expect(page.locator('.stack-value')).toHaveText('7');
  await page.goto('/?lab=does-not-exist&step=-900&opt=broken');
  await expect(page.locator('.home-hero')).toBeVisible();
});

test('small viewport navigation, keyboard and reduced motion remain usable', async ({
  page,
  isMobile,
}) => {
  await page.goto('/?lab=lex');
  if (isMobile) {
    await expect(page.locator('aside.sidebar')).toHaveAttribute('inert', '');
    await page.getByRole('button', { name: '切换课程目录' }).click();
    await expect(page.locator('aside.sidebar')).not.toHaveAttribute('inert');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: '切换课程目录' })).toBeFocused();
    await page.getByRole('button', { name: '切换课程目录' }).click();
    await expect(page.getByRole('button', { name: '关闭目录' })).toBeVisible();
    await page
      .locator('nav')
      .getByRole('link', { name: /语法分析/ })
      .click();
    await expect(page.getByRole('heading', { level: 1 })).toContainText('乘法');
    await expect(page.getByRole('button', { name: '关闭目录' })).not.toBeVisible();
  }
  await page.getByLabel('源程序代码').fill('print(7);');
  await page.getByLabel('源程序代码').press('Control+Enter');
  await page.getByRole('button', { name: '看最终结果' }).click();
  await expect(page.locator('.result-content')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});
