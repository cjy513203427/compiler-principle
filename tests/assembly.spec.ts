import { test, expect, type Page } from '@playwright/test';

test('appendix opens as a book companion, separates conventions and keeps experiments reachable', async ({
  page,
}) => {
  const external: string[] = [];
  page.on('request', (request) => {
    if (!new URL(request.url()).hostname.match(/^(127\.0\.0\.1|localhost)$/))
      external.push(request.url());
  });
  await page.goto('/?lab=home');
  await page.getByRole('button', { name: '打开汇编附录', exact: false }).click();
  await expect(page.getByRole('button', { name: '随书导读', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByRole('navigation', { name: '汇编附录主题' })).toHaveCount(0);
  await expect(page.locator('.asm-convention-list')).toContainText('EDI、ESI');
  await expect(page.locator('.asm-convention-list')).toContainText('ESI、EDX');
  await expect(page.locator('.asm-convention-list')).toContainText('ECX、EDX');
  await page.getByText('PUSH / POP / RET', { exact: true }).click();
  await expect(page.locator('.asm-book-instructions')).toContainText('省略帧指针');
  await page.getByRole('button', { name: '为什么加载指令被提前了？', exact: true }).click();
  await expect(page.getByRole('article', { name: '当前汇编技巧' })).toContainText('可能别名');
  await page.setViewportSize({ width: 320, height: 740 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'LEA 为什么出现在加法里？', exact: true }).click();
  await expect(page.getByRole('article', { name: '当前汇编技巧' })).toContainText(
    'ADD 改标志，LEA 不改',
  );
  await page.getByRole('button', { name: '分享阅读附录' }).click();
  expect(new URL(page.url()).search).toBe('?lab=assembly');
  await page.getByRole('button', { name: '动手区分 LEA 与内存读取' }).click();
  await expect(page.getByLabel('读取方式')).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('button', { name: '随书导读', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect(external).toEqual([]);
});

const finish = (page: Page) => page.getByRole('button', { name: '看汇编最终结果 →' }).click();
const next = (page: Page) => page.getByRole('button', { name: '汇编下一步', exact: true }).click();
async function topic(page: Page, name: string) {
  await page
    .getByRole('navigation', { name: '汇编附录主题' })
    .getByRole('button', { name })
    .click();
}

test('assembly parameters drive replay, integer flags and synchronized code without external requests', async ({
  page,
}) => {
  const external: string[] = [];
  page.on('request', (request) => {
    if (!new URL(request.url()).hostname.match(/^(127\.0\.0\.1|localhost)$/))
      external.push(request.url());
  });
  await page.goto('/?lab=assembly&asm=arithmetic');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('编译中的汇编速查');
  await next(page);
  await expect(page.locator('.asm-registers > div').first()).toContainText('0x0000000000000002');
  await expect(page.locator('.asm-registers > div').nth(1)).toContainText('0x0000000000000002');
  await expect(page.locator('.asm-line.current')).toContainText('mov EAX, ECX');
  await expect(page.locator('.asm-source-line.current')).toContainText('return a + b');
  await page.getByLabel('参数 a', { exact: true }).fill('10');
  await expect(page.getByRole('button', { name: '汇编播放', exact: true })).toBeDisabled();
  await expect(page.locator('.asm-registers > div').first()).toContainText('0x0000000000000002');
  await page.getByRole('button', { name: '应用参数并重算' }).click();
  await finish(page);
  await expect(page.locator('.asm-result strong')).toHaveText('13');
  await page.getByRole('button', { name: '对照：无符号进位' }).click();
  await finish(page);
  await expect(page.locator('.asm-flags')).toContainText('CF = 1');
  await expect(page.locator('.asm-flags')).toContainText('OF = 0');
  await expect(page.locator('.asm-result strong')).toHaveText('0');
  await page.getByRole('button', { name: '对照：有符号溢出位' }).click();
  await finish(page);
  await expect(page.locator('.asm-flags')).toContainText('CF = 0');
  await expect(page.locator('.asm-flags')).toContainText('OF = 1');
  expect(external).toEqual([]);
});
test('branch interpretation, zero-trip loop, and LEA versus memory reads are observable', async ({
  page,
}) => {
  await page.goto('/?lab=assembly&asm=branch');
  await finish(page);
  await expect(page.locator('.asm-result strong')).toHaveText('1');
  await page.getByRole('button', { name: '同样的位 · unsigned' }).click();
  await finish(page);
  await expect(page.locator('.asm-result strong')).toHaveText('0');
  await topic(page, '循环与回边');
  await finish(page);
  await expect(page.locator('.asm-result strong')).toHaveText('6');
  await page.getByRole('button', { name: '对照：零次循环' }).click();
  await finish(page);
  await expect(page.locator('.asm-result strong')).toHaveText('0');
  await topic(page, '数组与地址');
  await page.getByLabel('读取方式').selectOption('lea');
  await page.getByLabel('数组元素 2', { exact: true }).fill('-1');
  await page.getByRole('button', { name: '应用参数并重算' }).click();
  await next(page);
  await expect(page.locator('.asm-array')).toContainText('本步数据内存读取：0 次');
  await expect(page.locator('.asm-registers > div').nth(3)).toContainText('0x0000000000002008');
  await next(page);
  await expect(page.locator('.asm-array > div.changed')).toContainText('a[2]');
  await expect(page.locator('.asm-array')).toContainText('本步数据内存读取：1 次');
  await finish(page);
  await expect(page.locator('.asm-result strong')).toHaveText('-1');
});
test('calls show shadow space, nested frames and return to the caller', async ({ page }) => {
  await page.goto('/?lab=assembly&asm=call');
  for (let i = 0; i < 3; i++) await next(page);
  await expect(page.locator('.asm-registers > div').last()).toContainText('0x0000000000000FE0');
  await expect(page.locator('.asm-stack')).toContainText('32B shadow space · 未写入');
  await next(page);
  await expect(page.locator('.asm-frames > span')).toHaveCount(2);
  await expect(page.locator('.asm-stack-rows .changed')).toContainText('返回位置 #4');
  await expect(page.locator('.asm-registers > div').last()).toContainText('0x0000000000000FD8');
  await finish(page);
  await expect(page.locator('.asm-frames')).toHaveText('已回到外部调用者');
  await expect(page.locator('.asm-result strong')).toHaveText('5');
  await page.getByRole('button', { name: '汇编上一步' }).click();
  await expect(page.locator('.asm-frames > span')).toHaveCount(1);
  await page.getByRole('button', { name: '汇编重置步骤' }).click();
  await expect(page.locator('.asm-stack-rows')).not.toContainText('返回位置 #4');
});
test('8086 register windows preserve or clear high bits; invalid input stays unapplied', async ({
  page,
}) => {
  await page.goto('/?lab=assembly&asm=registers');
  await finish(page);
  await expect(page.locator('.asm-registers > div').first()).toContainText('0x00000000000000AA');
  await page.getByLabel('写入窗口').selectOption('AX');
  await page.getByRole('button', { name: '应用参数并重算' }).click();
  await finish(page);
  await expect(page.locator('.asm-registers > div').first()).toContainText('0x11223344556600AA');
  await page.getByLabel('写入窗口').selectOption('AH');
  await page.getByLabel('寄存器写入值').fill('100');
  await page.getByRole('button', { name: '应用参数并重算' }).click();
  await expect(page.getByRole('alert')).toContainText('8 位范围');
  await expect(page.locator('.asm-registers > div').first()).toContainText('0x11223344556600AA');
  await page.getByRole('button', { name: '原理与边界' }).click();
  await expect(page.locator('.asm-transition-table')).toContainText('段寄存器');
});
test('shares exact applied state, restores history and handles malformed URLs', async ({
  page,
}) => {
  await page.goto('/?lab=assembly&asm=loop');
  await page.getByLabel('循环上界 n').fill('3');
  await page.getByRole('button', { name: '应用参数并重算' }).click();
  await next(page);
  await next(page);
  await page.getByRole('button', { name: '分享当前实验' }).click();
  const shared = page.url();
  expect(new URL(shared).searchParams.has('code')).toBe(false);
  await topic(page, '比较与分支');
  await page.goBack();
  await expect(page.getByLabel('循环上界 n')).toHaveValue('3');
  await expect(page.getByRole('slider', { name: '汇编当前步骤' })).toHaveValue('2');
  await page.goto(shared);
  await expect(page.getByRole('slider', { name: '汇编当前步骤' })).toHaveValue('2');
  await page.goto('/?lab=assembly&asm=memory&args=bad');
  await expect(page.getByRole('alert')).toContainText('参数无效');
  await expect(page.getByLabel('数组索引 i')).toHaveValue('2');
});
test('appendix notes coexist with core notes and export without increasing core progress', async ({
  page,
}) => {
  await page.goto('/?lab=assembly&asm=arithmetic');
  await page.getByRole('button', { name: '复述自测', exact: true }).click();
  await page.getByRole('button', { name: /保持原值/ }).click();
  await expect(page.locator('.quiz-feedback')).toContainText('判断正确');
  await page.getByLabel('赋值与加法的汇编笔记').fill('MOV 复制，源值保留。');
  await page.getByRole('button', { name: '我能解释了，标记附录' }).click();
  await page.goto('/?lab=notes');
  await expect(page.getByLabel('赋值与加法的附录笔记')).toHaveValue('MOV 复制，源值保留。');
  await expect(page.locator('.notebook-toolbar')).toContainText('0 / 8 个实验已复习 · 附录 1 / 6');
  await page.getByLabel('词法分析的笔记', { exact: true }).fill('旧实验笔记。');
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出笔记' }).click();
  const download = await downloadPromise;
  const stream = await download.createReadStream();
  let json = '';
  for await (const chunk of stream!) json += chunk.toString();
  const exported = JSON.parse(json);
  expect(exported.notes.lex).toBe('旧实验笔记。');
  expect(exported.notes['assembly-arithmetic']).toBe('MOV 复制，源值保留。');
  await page.getByLabel('导入笔记文件').setInputFiles({
    name: 'notes.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        version: 1,
        notes: { 'assembly-call': 'CALL 保存返回位置。' },
        completed: ['assembly-call'],
      }),
    ),
  });
  await expect(page.getByLabel('函数与栈的附录笔记')).toHaveValue('CALL 保存返回位置。');
  await page.getByRole('button', { name: '回到本节附录' }).nth(4).click();
  await expect(page.locator('.asm-topic-heading')).toContainText('CALL');
  await page.getByRole('button', { name: '复述自测', exact: true }).click();
  await expect(page.getByLabel('函数与栈的汇编笔记')).toHaveValue('CALL 保存返回位置。');
});
test('real GCC artifacts stay distinct and readable on 320px screens', async ({ page }) => {
  await page.goto('/?lab=assembly&asm=arithmetic');
  await page.getByRole('button', { name: '真实输出', exact: true }).click();
  await expect(page.locator('.asm-real')).toContainText('ms_abi');
  await expect(page.locator('.asm-real')).toContainText('9 native checks passed');
  const output = page.getByLabel('真实编译器汇编输出');
  const original = await output.textContent();
  await page.getByLabel('真实汇编优化级别').selectOption('O2');
  expect(await output.textContent()).not.toBe(original);
  await page.setViewportSize({ width: 320, height: 740 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: '动手对照', exact: true }).click();
  expect(
    await page
      .locator('.asm-source code')
      .first()
      .evaluate((e) => parseFloat(getComputedStyle(e).fontSize)),
  ).toBeGreaterThanOrEqual(16);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: '指令速查', exact: true }).click();
  await expect(page.locator('.asm-card-grid article')).toHaveCount(11);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
