import { expect, test, type Page } from '@playwright/test';
import { lessons } from '../src/content/lessons';

async function expectNoDoubleEditorScroll(page: Page) {
  const metrics = await page.evaluate(() => {
    const body = document.querySelector<HTMLElement>('.editor-body');
    const ta = document.querySelector<HTMLTextAreaElement>('#source-code');
    if (!body || !ta) return null;
    return {
      taScrollH: ta.scrollHeight,
      taClientH: ta.clientHeight,
      taOverflowY: getComputedStyle(ta).overflowY,
      bodyScrollW: body.scrollWidth,
      bodyClientW: body.clientWidth,
    };
  });
  expect(metrics).not.toBeNull();
  expect(metrics!.taOverflowY).toBe('hidden');
  expect(metrics!.taScrollH).toBeLessThanOrEqual(metrics!.taClientH + 2);
  expect(metrics!.bodyScrollW).toBeLessThanOrEqual(metrics!.bodyClientW + 1);
}

test('instruction selection (isel) compares DP vs Maximal Munch and verifies equivalence', async ({ page }) => {
  await page.goto('/?lab=isel');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('CISC');
  await expectNoDoubleEditorScroll(page);
  await page.getByRole('button', { name: '看最终结果' }).click();
  await expect(page.getByLabel('指令选择行为核对')).toContainText('四个目标版本与原 Mini C 虚拟机输出和错误完全一致');
  await expect(page.getByLabel('四种指令选择结果对比')).toContainText('LEA v2_addr');

  await page.getByLabel('选择一个观察角度').selectOption('isel-greedy-vs-dp');
  await page.getByRole('button', { name: '看最终结果' }).click();
  await expect(page.getByLabel('四种指令选择结果对比')).toContainText('MADD');

  await page.setViewportSize({ width: 320, height: 740 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('SSA optimization (ssaopt) runs SCCP dual worklists and simplifies phis', async ({ page }) => {
  await page.goto('/?lab=ssaopt');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('SSA');
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  await expect(page.getByLabel('本步 SSA 优化')).toContainText('CFG 工作表');
  await page.getByRole('button', { name: '看最终结果' }).click();
  await expect(page.getByLabel('SSA 优化行为核对')).toContainText('三者输出与错误一致');
  await expect(page.getByLabel('SSA 优化前后对照')).toContainText('删除的不可达块');

  await page.setViewportSize({ width: 320, height: 740 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('inlining & escape analysis (escape) unlocks SROA zero-heap allocation', async ({ page }) => {
  await page.goto('/?lab=escape');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('堆上分配');
  await page.getByRole('button', { name: '看最终结果' }).click();
  await expect(page.getByLabel('内联与逃逸行为核对')).toContainText('完全一致');
  const table = page.getByLabel('三版本运行统计，可横向滚动');
  await expect(table.locator('tr', { hasText: '标量替换' })).toContainText('0');

  await page.getByLabel('选择一个观察角度').selectOption('esc-transitive');
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  await expect(page.getByLabel('逃逸状态对照表')).toContainText('GlobalEscape');

  await page.setViewportSize({ width: 320, height: 740 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('OOP vtable dispatch traces layout, vtable slots, and CHA devirtualization', async ({ page }) => {
  await page.goto('/?lab=vtable');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('子类的方法');
  await expectNoDoubleEditorScroll(page);
  await page.getByRole('button', { name: '看最终结果' }).click();
  await expect(page.getByLabel('对象内存布局与虚函数表')).toContainText('Rect::area');
  await expect(page.getByLabel('静态去虚拟化分析')).toContainText('可静态直调');
  await expect(page.locator('.output-console pre')).toContainText('20\n8\n36');

  // Verify vtable class cards never overlap and inner tables stay contained inside their cards.
  const layoutOk = await page.evaluate(() => {
    const cards = [...document.querySelectorAll<HTMLElement>('.vtable-class-box')];
    const rects = cards.map((c) => c.getBoundingClientRect());
    for (let i = 0; i < cards.length; i++) {
      const tableWrap = cards[i].querySelector<HTMLElement>('.table-scroll');
      if (tableWrap && tableWrap.getBoundingClientRect().right > rects[i].right + 1) return false;
      for (let j = i + 1; j < cards.length; j++) {
        const a = rects[i];
        const b = rects[j];
        const overlapX = a.left < b.right - 1 && b.left < a.right - 1;
        const overlapY = a.top < b.bottom - 1 && b.top < a.bottom - 1;
        if (overlapX && overlapY) return false;
      }
    }
    return cards.length === 3;
  });
  expect(layoutOk).toBe(true);

  await page.setViewportSize({ width: 320, height: 740 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('closure lab boxes captured variables into heap cells surviving frame pop', async ({ page }) => {
  await page.goto('/?lab=closure');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('局部变量为什么还活着');
  await expectNoDoubleEditorScroll(page);
  await page.getByRole('button', { name: '看最终结果' }).click();
  await expect(page.getByLabel('运行时栈与堆环境')).toContainText('Cell#1');
  await expect(page.getByLabel('运行时栈与堆环境')).toContainText('原栈帧已弹出');
  await expect(page.locator('.output-console pre')).toContainText('11\n16\n102');

  await page.setViewportSize({ width: 320, height: 740 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('coroutine lab lowers yield to switch(state) and hoists only live-across-yield vars', async ({ page }) => {
  await page.goto('/?lab=coroutine');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('无栈协程');
  await page.getByRole('button', { name: '看最终结果' }).click();
  await expect(page.getByLabel('降级后的状态机代码')).toContainText('switch (frame->state)');
  await expect(page.getByLabel('降级后的状态机代码')).toContainText('留在临时栈：doubled');
  await expect(page.locator('.output-console pre')).toContainText('0\n2\n4\n3\ntrue');

  await page.setViewportSize({ width: 320, height: 740 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('generics lab compares type erasure boxing vs monomorphization specialization', async ({ page }) => {
  await page.goto('/?lab=generics');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Box<T>');
  await page.getByRole('button', { name: '看最终结果' }).click();
  await expect(page.getByLabel('双路线开销与行为对照')).toContainText('类型擦除');
  await expect(page.getByLabel('双路线开销与行为对照')).toContainText('单态化');
  await expect(page.locator('.output-console pre')).toContainText('50\ntrue');

  await page.setViewportSize({ width: 320, height: 740 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('inlinecache lab builds Shape transition tree and tracks IC states', async ({ page }) => {
  await page.goto('/?lab=inlinecache');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('V8');
  await page.getByRole('button', { name: '看最终结果' }).click();
  await expect(page.getByLabel('隐藏类转移树')).toContainText('Shape#2');
  await expect(page.getByLabel('内联缓存状态表')).toContainText('单态 (Monomorphic)');
  await expect(page.locator('.output-console pre')).toContainText('2\n4\n8');

  await page.setViewportSize({ width: 320, height: 740 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('concurgc lab reproduces lost-object bug without barrier and rescues with Dijkstra & SATB', async ({ page }) => {
  await page.goto('/?lab=concurgc');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('三色标记');
  await page.getByRole('button', { name: '看最终结果' }).click();
  await expect(page.getByLabel('无写屏障（Naive）')).toContainText('误杀可达对象 [C]');
  await expect(page.getByLabel('Dijkstra 插入屏障')).toContainText('安全且精确');
  await expect(page.getByLabel('Yuasa SATB 删除屏障')).toContainText('安全且精确');

  await page.setViewportSize({ width: 320, height: 740 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('seaofnodes lab prunes cold branch and deoptimizes safely on out-of-profile input', async ({ page }) => {
  await page.goto('/?lab=seaofnodes');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('分支');
  await page.getByRole('button', { name: '看最终结果' }).click();
  await expect(page.getByLabel('JIT 执行与逆优化核对')).toContainText('JIT 优化快路径');
  await expect(page.getByLabel('JIT 执行与逆优化核对')).toContainText('触发 Deopt');
  await expect(page.getByLabel('JIT 执行与逆优化核对')).toContainText('一致 ✓');

  await page.setViewportSize({ width: 320, height: 740 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('advanced route links all 6 new labs with zero external requests and local notes', async ({ page }) => {
  const external: string[] = [];
  page.on('request', (request) => {
    if (!['127.0.0.1', 'localhost'].includes(new URL(request.url()).hostname)) external.push(request.url());
  });
  await page.goto('/');
  await expect(page.getByLabel('建议学习路线')).toContainText('进阶优化与现代语言实现');
  await page.getByLabel('建议学习路线').getByRole('button', { name: '打开实验 21 指令选择' }).click();
  await expect(page).toHaveURL(/lab=isel/);
  await page.getByRole('button', { name: '复述自测', exact: true }).click();
  await page.getByLabel('指令选择的复述笔记').fill('LEA 可以一次完成基址加比例变址和偏移。');
  await page.getByRole('button', { name: '我能解释了' }).click();
  await page.goto('/?lab=notes');
  await expect(page.getByLabel('指令选择的笔记', { exact: true })).toHaveValue('LEA 可以一次完成基址加比例变址和偏移。');
  await expect(page.locator('.notebook-toolbar')).toContainText(`1 / ${lessons.length}`);
  expect(external).toEqual([]);
});
