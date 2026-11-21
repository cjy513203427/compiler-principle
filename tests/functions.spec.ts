import { expect, test, type Page } from '@playwright/test';

async function openLab(page: Page, name: RegExp) {
  if (await page.getByRole('button', { name: '切换课程目录' }).isVisible()) await page.getByRole('button', { name: '切换课程目录' }).click();
  await page.locator('aside.sidebar').getByRole('link', { name }).click();
}

test('CALL creates real frames and recursive callers retain operands and locals', async ({ page }) => {
  await page.goto('/?lab=functions');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('旧的局部变量');
  await expect(page.getByLabel('函数程序代码')).toHaveValue(/int add/);
  await expect(page.getByLabel('本步调用统计')).toContainText('已调用 0');
  await page.getByRole('button', { name: '看最终结果' }).click();
  await expect(page.getByLabel('本步程序输出')).toContainText('7 · 3');
  await expect(page.getByLabel('本步调用统计')).toContainText('最大深度 2');
  await page.getByLabel('选择一个观察角度').selectOption('call-fact');
  const slider = page.getByRole('slider', { name: '当前步骤' });
  await slider.focus(); await page.keyboard.press('Home');
  for (let i = 0; i < 40; i++) {
    if (await page.getByLabel('本步调用统计').textContent().then((text) => text!.includes('最大深度 4'))) break;
    await page.keyboard.press('ArrowRight');
  }
  await expect(page.getByLabel('本步调用统计')).toContainText('活动帧 4 / 32');
  await page.getByLabel('检查调用帧').selectOption('1');
  await expect(page.getByLabel('选中帧的状态')).toContainText('fact');
  await expect(page.getByLabel('选中帧操作数栈')).toContainText('4');
  await expect(page.getByLabel('选中帧的状态').locator('tbody tr').first()).toContainText('4');
  await page.getByLabel('检查调用帧').selectOption('2');
  await expect(page.getByLabel('选中帧操作数栈')).toContainText('3');
  await page.getByRole('button', { name: '看最终结果' }).click();
  await expect(page.getByLabel('本步程序输出')).toContainText('24');
  await expect(page.getByLabel('本步调用统计')).toContainText('已调用 4');
  await expect(page.locator('.call-outcome')).toContainText('执行完成');
  await page.getByRole('button', { name: '重置步骤' }).click();
  await expect(page.getByLabel('本步程序输出')).toContainText('等待 print');
});

test('edited calls preserve evaluation order, values and error outcomes', async ({ page }) => {
  await page.goto('/?lab=functions');
  await page.getByLabel('选择一个观察角度').selectOption('call-order');
  await page.getByRole('button', { name: '看最终结果' }).click();
  await expect(page.getByLabel('本步程序输出')).toContainText('7 · 2 · 5');
  await page.getByLabel('选择一个观察角度').selectOption('call-value');
  await page.getByRole('button', { name: '看最终结果' }).click();
  await expect(page.getByLabel('本步程序输出')).toContainText('5 · 4');
  await page.getByLabel('函数程序代码').fill('int f(int n) { return n + 2; } print(f(5));');
  await expect(page.getByRole('button', { name: '播放', exact: true })).toBeDisabled();
  await page.getByLabel('函数程序代码').press('Control+Enter');
  await expect(page.getByRole('slider', { name: '当前步骤' })).toHaveValue('0');
  await page.getByRole('button', { name: '看最终结果' }).click();
  await expect(page.getByLabel('本步程序输出')).toContainText('7');
  await page.getByLabel('选择一个观察角度').selectOption('call-trap');
  await page.getByRole('button', { name: '看最终结果' }).click();
  await expect(page.locator('.call-outcome')).toContainText('除数不能为 0');
  await expect(page.getByLabel('本步程序输出')).toContainText('1 · 3');
  await expect(page.getByLabel('本步调用统计')).toContainText('活动帧 2 / 32');
  await page.getByLabel('选择一个观察角度').selectOption('call-missing');
  await expect(page.getByRole('alert')).toContainText('没有返回值');
  await page.getByLabel('选择一个观察角度').selectOption('call-scope');
  await expect(page.getByRole('alert')).toContainText('词法作用域');
  await page.getByLabel('选择一个观察角度').selectOption('call-depth');
  await page.getByRole('button', { name: '看最终结果' }).click();
  await expect(page.locator('.call-outcome')).toContainText('调用深度达到 32');
  await page.getByLabel('函数程序代码').fill('while (true) {}');
  await page.getByRole('button', { name: '编译并执行函数' }).click();
  await page.getByRole('button', { name: '看最终结果' }).click();
  await expect(page.locator('.call-outcome')).toContainText('2000 条字节码');
  await expect(page.locator('.functions-view')).toContainText('保留前 400');
  await page.setViewportSize({ width: 320, height: 740 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('function inputs, unrun drafts, shared steps and local notes remain separate', async ({ page }) => {
  const external: string[] = [];
  page.on('request', (request) => { if (!['127.0.0.1', 'localhost'].includes(new URL(request.url()).hostname)) external.push(request.url()); });
  await page.goto('/?lab=functions');
  const applied = await page.getByLabel('函数程序代码').inputValue();
  const draft = applied.replace('add(x, 4)', 'add(x, 9)');
  await page.getByLabel('函数程序代码').fill(draft);
  await openLab(page, /06 栈式虚拟机/);
  await expect(page.getByLabel('源程序代码')).not.toHaveValue(draft);
  await openLab(page, /16 函数与调用栈/);
  await expect(page.getByLabel('函数程序代码')).toHaveValue(draft);
  await expect(page.locator('.dirty-note')).toBeVisible();
  await page.getByRole('button', { name: '分享实验', exact: false }).click();
  expect(new URL(page.url()).searchParams.get('code')).toBe(applied);
  await page.getByLabel('函数程序代码').press('Control+Enter');
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  await page.getByRole('button', { name: '分享实验', exact: false }).click();
  const shared = page.url();
  await page.getByRole('button', { name: '原理笔记', exact: true }).click();
  await expect(page.getByLabel('一步一步读懂')).toContainText('每次调用各有一帧');
  await expect(page.locator('.reading-source')).toContainText('2026-11-21');
  await page.getByRole('button', { name: '复述自测', exact: true }).click();
  await page.getByRole('button', { name: /压入调用者的操作数栈/ }).click();
  await expect(page.locator('.quiz-feedback')).toContainText('判断正确');
  await page.getByLabel('函数与调用栈的复述笔记').fill('每次调用保留独立的 n。');
  await page.getByRole('button', { name: '我能解释了' }).click();
  await page.goto('/?lab=notes');
  await expect(page.getByLabel('函数与调用栈的笔记', { exact: true })).toHaveValue('每次调用保留独立的 n。');
  await page.goto(shared);
  await expect(page.getByRole('slider', { name: '当前步骤' })).toHaveValue('1');
  expect(shared).not.toContain('独立的 n'); expect(external).toEqual([]);
});
