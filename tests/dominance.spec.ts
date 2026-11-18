import { expect, test } from '@playwright/test';

test('dominance solves intersections, exposes a bypass witness and ignores this run’s branch choice', async ({
  page,
}) => {
  await page.goto('/?lab=dominance');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('哪些地方一定经过');
  await expect(page.getByLabel('源程序代码')).toHaveValue(/bool choose/);
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  await expect(page.getByLabel('本步支配集合推导')).toContainText('前驱 B0');
  await page.getByRole('button', { name: '看最终结果' }).click();
  await expect(page.locator('.dom-status')).toContainText('支配分析已收敛');
  await page.getByLabel('候选必经块', { exact: true }).selectOption('B1');
  await page.getByLabel('支配查询目标块').selectOption('B3');
  await expect(page.locator('.dom-query-result')).toContainText('不支配');
  await expect(page.locator('.dom-bypass')).toContainText('B0 → B2 → B3');
  await expect(page.locator('.dom-execution-reference code')).toHaveText('7');
  const sets = await page.locator('.dom-all-sets').textContent();
  const source = await page.getByLabel('源程序代码').inputValue();
  await page.getByLabel('源程序代码').fill(source.replace('true', 'false'));
  await expect(page.getByRole('button', { name: '播放', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '运行编译' }).click();
  await expect(page.getByRole('slider', { name: '当前步骤' })).toHaveValue('0');
  await page.getByRole('button', { name: '看最终结果' }).click();
  await expect(page.locator('.dom-execution-reference code')).toHaveText('9');
  expect(await page.locator('.dom-all-sets').textContent()).toBe(sets);
  await page.getByLabel('候选必经块', { exact: true }).selectOption('B0');
  await expect(page.locator('.dom-query-result')).toContainText('B0 支配 B3');
  await page.getByRole('button', { name: '查询基本块 B0', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('支配查询目标块')).toHaveValue('B0');
});

test('natural loop membership distinguishes zero visits, nested loops and parallel loops', async ({
  page,
}) => {
  await page.goto('/?lab=dominance');
  await page.getByLabel('选择一个观察角度').selectOption('dom-zero');
  await page.getByRole('button', { name: '看最终结果' }).click();
  await page.getByRole('button', { name: '自然循环与嵌套', exact: true }).click();
  await expect(page.locator('.dom-loop-panel')).toContainText('识别到 1 个自然循环');
  await expect(page.locator('.dom-execution-reference code')).toHaveText('0');
  await page.getByLabel('选择一个观察角度').selectOption('dom-nested');
  await page.getByRole('button', { name: '看最终结果' }).click();
  await page.getByRole('button', { name: '自然循环与嵌套', exact: true }).click();
  await expect(page.locator('.dom-loop-panel')).toContainText('识别到 2 个自然循环');
  const outer = await page.getByLabel('选择自然循环').inputValue();
  await page.getByLabel('选择自然循环').selectOption({ index: 1 });
  await expect(page.locator('.dom-loop-panel dl > div').last()).toContainText(outer);
  await expect(page.locator('.dom-execution-reference code')).toHaveText('6');
  await expect(page.locator('.dom-edge.natural-back')).toHaveCount(2);
  await page.getByLabel('选择一个观察角度').selectOption('dom-sequential');
  await page.getByRole('button', { name: '看最终结果' }).click();
  await page.getByRole('button', { name: '自然循环与嵌套', exact: true }).click();
  await expect(page.locator('.dom-loop-panel')).toContainText('识别到 2 个自然循环');
  for (const index of [0, 1]) {
    await page.getByLabel('选择自然循环').selectOption({ index });
    await expect(page.locator('.dom-loop-panel dl > div').last()).toContainText('顶层循环');
  }
});

test('frontiers and iterated phi sites remain clearly marked as candidates, with readable narrow layouts', async ({
  page,
}) => {
  await page.goto('/?lab=dominance');
  await page.getByRole('button', { name: '看最终结果' }).click();
  await page.getByRole('button', { name: '支配边界与 φ 候选', exact: true }).click();
  await page.getByLabel('支配边界的基本块').selectOption('B1');
  await expect(page.locator('.dom-frontier-result')).toContainText('DF(B1) = { B3 }');
  await page.getByLabel('φ 候选的变量').selectOption('v1_value');
  await expect(page.locator('.dom-phi-result')).toContainText('{ B3 }');
  await expect(page.locator('.dom-frontier-panel')).toContainText('没有活跃性裁剪');
  await page.getByLabel('选择一个观察角度').selectOption('dom-loop');
  await page.getByRole('button', { name: '看最终结果' }).click();
  await page.getByRole('button', { name: '支配边界与 φ 候选', exact: true }).click();
  await page.getByLabel('支配边界的基本块').selectOption('B1');
  await expect(page.locator('.dom-frontier-result')).toContainText('DF(B1) = { B1 }');
  await page.getByLabel('φ 候选的变量').selectOption('v0_i');
  await expect(page.locator('.dom-phi-result')).toContainText('{ B1 }');
  await page.setViewportSize({ width: 320, height: 740 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(
    await page
      .locator('.dom-frontier-result code')
      .evaluate((e) => parseFloat(getComputedStyle(e).fontSize)),
  ).toBeGreaterThanOrEqual(16);
});

test('dominance notes, self-check and share restore the new stage without losing old notebooks', async ({
  page,
}) => {
  const external: string[] = [];
  page.on('request', (request) => {
    if (!new URL(request.url()).hostname.match(/^(127\.0\.0\.1|localhost)$/))
      external.push(request.url());
  });
  await page.goto('/?lab=dominance');
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  await page.getByRole('button', { name: '分享实验', exact: false }).click();
  const shared = page.url();
  await page.getByRole('button', { name: '复述自测', exact: true }).click();
  await page.getByRole('button', { name: /从入口到 B 的所有/ }).click();
  await expect(page.locator('.quiz-feedback')).toContainText('判断正确');
  await page.getByLabel('支配关系的复述笔记').fill('必经关系考虑所有入口路径。');
  await page.getByRole('button', { name: '我能解释了' }).click();
  await page.goto('/?lab=notes');
  await expect(page.getByLabel('支配关系的笔记', { exact: true })).toHaveValue(
    '必经关系考虑所有入口路径。',
  );
  await expect(page.locator('.notebook-toolbar')).toContainText('1 / 10');
  await page
    .getByLabel('导入笔记文件')
    .setInputFiles({
      name: 'old.json',
      mimeType: 'application/json',
      buffer: Buffer.from(
        JSON.stringify({ version: 1, notes: { lex: '旧笔记。' }, completed: ['lex'] }),
      ),
    });
  await expect(page.getByLabel('词法分析的笔记', { exact: true })).toHaveValue('旧笔记。');
  await expect(page.getByLabel('支配关系的笔记', { exact: true })).toHaveValue(
    '必经关系考虑所有入口路径。',
  );
  await expect(page.locator('.notebook-toolbar')).toContainText('2 / 10');
  await page.goto(shared);
  await expect(page.getByRole('slider', { name: '当前步骤' })).toHaveValue('1');
  expect(shared).not.toContain('必经关系');
  expect(external).toEqual([]);
});
