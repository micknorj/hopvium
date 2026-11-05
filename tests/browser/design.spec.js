import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { uiFixture, PEERS } from './ui-fixtures.js';

const files = [
  { name: `../<img onerror=alert(1)>-${'long-name-'.repeat(16)}.txt`, size: 3 },
  { name: 'original bytes.🪐', size: 131072 },
];
async function fits(page) {
  expect(await page.locator('.shell').evaluate(el => parseFloat(getComputedStyle(el).height) === (innerWidth <= 980 ? 520 : 720))).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await page.locator('.filename, .file-list a, .identity, #panel-title, #transfer-status, .security, .peer').evaluateAll(elements =>
    elements.filter(el => el.getBoundingClientRect().width && el.scrollWidth > el.clientWidth + 1).map(el => el.textContent))).toEqual([]);
}
async function capture(page, testInfo, state) {
  const root = `.private/screenshots/${testInfo.project.name}`;
  await mkdir(root, { recursive: true });
  await page.screenshot({ path: `${root}/${state}.png`, fullPage: true });
}
async function centered(page, selector) {
  const positions = await page.locator(selector).evaluate(el => {
    const range = document.createRange(); range.selectNodeContents(el);
    const text = range.getBoundingClientRect(), area = document.querySelector('.workspace').getBoundingClientRect();
    return { x: Math.abs(text.x + text.width / 2 - area.x - area.width / 2), y: Math.abs(text.y + text.height / 2 - area.y - area.height / 2) };
  });
  expect(positions.x).toBeLessThan(3);
  expect(positions.y).toBeLessThan(3);
}

test('one dark area, centered finding message and exact existing family credit', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await uiFixture(page, []);
  await expect(page.locator('aside, .profile-panel, .privacy, #choose-files, .hint, .file-state')).toHaveCount(0);
  await expect(page.locator('.identity')).toHaveText('Discovered as Enceladus');
  await expect(page.locator('#panel-title')).toHaveText('0 Nearby devices');
  await expect(page.locator('#empty')).toHaveText('Open Hopvium on other devices to send files');
  await expect(page.locator('#security-code')).toHaveText('--- ---');
  await centered(page, '#empty');
  await expect(page.locator('footer')).toHaveText("© 2026 micknorj · Mick's Tools · GitHub");
  await expect(page.locator('footer a')).toHaveCount(1);
  await expect(page.locator('footer a')).toHaveAttribute('href', 'https://github.com/micknorj');
  expect(await page.locator('body').evaluate(el => getComputedStyle(el).backgroundColor)).toBe('rgb(16, 16, 16)');
});

for (const width of [1280, 980, 820, 768, 600, 375, 320]) {
  test(`${width}px: device picker, inline request, progress and centered errors`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const fixture = await uiFixture(page);
    await expect(page.locator('#panel-title')).toHaveText(`${PEERS.length} Nearby devices`);
    const alignment = await page.locator('#peers').evaluate(el => {
      const cards = [...el.children].map(card => card.getBoundingClientRect());
      const area = document.querySelector('.workspace').getBoundingClientRect();
      return {x:Math.abs((Math.min(...cards.map(card=>card.left))+Math.max(...cards.map(card=>card.right)))/2-area.x-area.width/2),y:Math.abs((Math.min(...cards.map(card=>card.top))+Math.max(...cards.map(card=>card.bottom)))/2-area.y-area.height/2)};
    });
    expect(alignment.x).toBeLessThan(2); expect(alignment.y).toBeLessThan(2);
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Send files to Bellatrix', exact: true }).click();
    await chooser;
    await expect(page.locator('.peer').first()).not.toContainText('Available browser');
    expect(await page.locator('.peer-list').evaluate(el => getComputedStyle(el).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
    await fits(page);
    await capture(page, testInfo, `${width}-discovery`);
    await fixture.request(files);
    await expect(page.locator('#devices')).toHaveAttribute('data-view', 'request');
    await expect(page.locator('#incoming-description')).toHaveText('“Ganymede” would like to share 2 files (128 KiB)');
    await expect(page.locator('#security-code')).toHaveText(/^[A-Z0-9]{3} [A-Z0-9]{3}$/);
    await expect(page.locator('.file-progress:visible')).toHaveCount(0);
    expect(await page.locator('#incoming-files img').count()).toBe(0);
    await fits(page);
    const sameBar = await page.evaluate(() => {
      const code = document.querySelector('#verification').getBoundingClientRect(), actions = document.querySelector('#request-actions').getBoundingClientRect();
      return Math.abs((code.top + code.bottom) / 2 - (actions.top + actions.bottom) / 2);
    });
    expect(sameBar).toBeLessThan(2);
    await capture(page, testInfo, `${width}-request`);
    await page.locator('#accept').click();
    await expect(page.locator('#devices')).toHaveAttribute('data-view', 'transfer');
    await expect(page.locator('#transfer-files progress')).toHaveCount(2);
    await expect(page.locator('.file-progress:visible')).toHaveCount(0);
    await expect(page.locator('#transfer-status')).toBeHidden();
    await fixture.bytes(1);
    await expect(page.locator('#transfer-files .file-progress').first()).toBeVisible();
    const firstBarWidth = await page.locator('#transfer-files progress').first().evaluate(el=>el.getBoundingClientRect().width);
    const paint = await page.locator('#transfer-files progress').first().evaluate(el=>({box:el.getBoundingClientRect().toJSON(),background:getComputedStyle(el).backgroundColor,shadow:getComputedStyle(el).boxShadow,pointer:getComputedStyle(el).pointerEvents}));
    expect(paint.pointer).toBe('none');
    await page.mouse.move(paint.box.x + paint.box.width / 2, paint.box.y + paint.box.height / 2);
    expect(await page.locator('#transfer-files progress').first().evaluate(el=>({background:getComputedStyle(el).backgroundColor,shadow:getComputedStyle(el).boxShadow}))).toEqual({background:paint.background,shadow:paint.shadow});
    await fixture.bytes(2); await fixture.control({type:'file-end',index:0});
    await expect(page.locator('#download-list a')).toHaveCount(1);
    expect(await page.locator('#download-list a').getAttribute('download')).toBe(files[0].name);
    await page.waitForTimeout(175);
    await fixture.bytes(65536);
    await expect.poll(() => page.locator('#transfer-files progress').evaluate(el => el.value)).toBe(50);
    await expect(page.locator('#download-list progress')).toHaveJSProperty('value', 100);
    await expect(page.locator('#download-list .file-progress')).toBeHidden();
    expect(Math.abs(await page.locator('#transfer-files progress').evaluate(el=>el.getBoundingClientRect().width) - firstBarWidth)).toBeLessThan(1);
    const progressLine = await page.evaluate(() => {
      const bar = document.querySelector('#transfer-files progress').getBoundingClientRect(), text = document.querySelector('#transfer-files .progress-text').getBoundingClientRect();
      return Math.abs((bar.top + bar.bottom) / 2 - (text.top + text.bottom) / 2);
    });
    expect(progressLine).toBeLessThan(2);
    await fits(page);
    await capture(page, testInfo, `${width}-active`);
    await page.locator('#cancel').click();
    await expect(page.locator('#devices')).toBeFocused();
    await expect(page.locator('#transfer-status')).toHaveText('Transfer cancelled.');
    await expect(page.locator('#download-list a')).toHaveCount(1);
    await page.locator('#done').click();
    await fixture.request([{name:'error.bin',size:1}]);
    await page.evaluate(() => window.__qaChannel.dispatchEvent(new Event('error')));
    await expect(page.locator('#devices')).toHaveAttribute('data-view','discovery');
    await expect(page.locator('#transfer-status')).toContainText(/failed|interrupted/);
    await centered(page, '#transfer-status');
    await fits(page);
    await capture(page, testInfo, `${width}-error`);
  });
}

test('decline and Escape send no acceptance, and Done dismisses the centered message', async ({ page }) => {
  const fixture = await uiFixture(page, ['Ganymede']);
  await fixture.request(files);
  await page.keyboard.press('Tab'); await expect(page.locator('#accept')).toBeFocused();
  await page.keyboard.press('Shift+Tab'); await expect(page.locator('#decline')).toBeFocused();
  expect(await page.locator('#decline').evaluate(el => getComputedStyle(el).outlineStyle)).not.toBe('none');
  await page.keyboard.press('Escape');
  await expect(page.locator('#devices')).toHaveAttribute('data-view','discovery');
  await expect(page.locator('#transfer-status')).toHaveText('Transfer declined.');
  await centered(page, '#transfer-status');
  expect(await page.evaluate(() => window.__qaSent.map(raw => JSON.parse(raw).type))).toContain('decline');
  expect(await page.evaluate(() => window.__qaSent.map(raw => JSON.parse(raw).type))).not.toContain('accept');
  await page.locator('#done').click(); await expect(page.locator('.peer')).toBeVisible();
});

test('remote cancel restores focus; Done clears completed files and returns to discovery', async ({ page }) => {
  await page.addInitScript(() => {
    window.__revokedURLs = [];
    const revoke = URL.revokeObjectURL;
    URL.revokeObjectURL = url => { window.__revokedURLs.push(url); revoke(url); };
  });
  const fixture = await uiFixture(page, ['Ganymede']);
  await fixture.request([{name:'empty.txt',size:0}]); await fixture.control({type:'cancel'});
  await expect(page.locator('#devices')).toBeFocused();
  await page.locator('#done').click();
  await fixture.request([{name:'empty.txt',size:0}]); await page.locator('#accept').click();
  await expect(page.locator('#cancel')).toBeFocused();
  await fixture.control({type:'file-end',index:0}); await fixture.control({type:'done'});
  await page.evaluate(() => window.__qaChannel.close());
  await expect(page.locator('#devices')).toHaveAttribute('data-view','complete');
  await expect(page.locator('#done')).toBeFocused();
  await expect(page.locator('#transfer-status')).toBeHidden();
  await expect(page.locator('#download-list progress')).toHaveJSProperty('value',100);
  await expect(page.locator('.file-progress:visible')).toHaveCount(0);
  await expect(page.locator('#activity-peer')).toHaveText('Received');
  await page.locator('#done').click(); await expect(page.locator('#downloads')).toBeHidden();
  await expect(page.locator('#download-list li, #transfer-files li')).toHaveCount(0);
  expect(await page.evaluate(()=>window.__revokedURLs.length)).toBe(1);
  await expect(page.locator('#devices')).toBeFocused();
  await fixture.request([{name:'another.txt',size:1}]);
});

test('many requested files scroll inside the fixed box; per-file progress stays independent', async ({ page }) => {
  const fixture = await uiFixture(page,['Ganymede']);
  await fixture.request(Array.from({length:40},(_,index)=>({name:`File ${index+1}.bin`,size:index===0?0:65536})));
  const geometry = await page.evaluate(()=>({height:document.querySelector('.shell').getBoundingClientRect().height,scroll:document.querySelector('.workspace').scrollHeight,client:document.querySelector('.workspace').clientHeight}));
  expect(geometry.height).toBe(720); expect(geometry.scroll).toBeGreaterThan(geometry.client);
  await page.keyboard.press('Shift+Tab');
  await expect(page.locator('#incoming-files')).toBeFocused();
  await page.keyboard.press('End');
  await expect.poll(()=>page.locator('.workspace').evaluate(el=>el.scrollTop)).toBeGreaterThan(0);
  await page.keyboard.press('Tab');
  await expect(page.locator('#decline')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.locator('#accept')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#devices')).toHaveAttribute('data-view','transfer');
  await expect(page.locator('#transfer-files progress')).toHaveCount(40);
  await fixture.control({type:'file-end',index:0});
  await expect(page.locator('#download-list progress')).toHaveJSProperty('value',100);
  await expect(page.locator('#download-list .file-progress')).toBeHidden();
  await page.waitForTimeout(175); await fixture.bytes(32768);
  await expect(page.locator('#transfer-files progress').first()).toHaveJSProperty('value',50);
  await expect(page.locator('#transfer-files progress').nth(1)).toHaveJSProperty('value',0);
  await expect(page.locator('.file-progress:visible')).toHaveCount(1);
  await page.locator('#cancel').click(); await page.locator('#done').click();
  await expect(page.locator('#download-list li, #transfer-files li')).toHaveCount(0);
  await fits(page);
});

test('dark-only, keyboard file picker, 200% content zoom, 320px reflow and footer position', async ({ page }, testInfo) => {
  await page.setViewportSize({width:1280,height:900}); await uiFixture(page);
  const background = await page.locator('body').evaluate(el => getComputedStyle(el).backgroundColor);
  for (const colorScheme of ['light','dark','no-preference']) {
    await page.emulateMedia({colorScheme});
    expect(await page.locator('body').evaluate(el => getComputedStyle(el).backgroundColor)).toBe(background);
  }
  await page.keyboard.press('Tab'); await expect(page.locator('.skip-link')).toBeFocused();
  await page.keyboard.press('Enter'); await expect(page.locator('#devices')).toBeFocused();
  await page.keyboard.press('Tab'); await expect(page.locator('.peer').first()).toBeFocused();
  const chooser = page.waitForEvent('filechooser'); await page.keyboard.press('Enter'); await chooser;
  await page.evaluate(() => { document.documentElement.style.zoom='2'; }); await fits(page);
  await capture(page,testInfo,'content-zoom-200');
  await page.evaluate(() => { document.documentElement.style.zoom=''; });
  await page.setViewportSize({width:320,height:720}); await fits(page);
  const positions = await page.evaluate(() => ({ shell:document.querySelector('.shell').getBoundingClientRect().bottom, disclaimer:document.querySelector('.disclaimer').getBoundingClientRect().top, footer:document.querySelector('footer').getBoundingClientRect().top }));
  expect(positions.disclaimer).toBeGreaterThanOrEqual(positions.shell); expect(positions.footer).toBeGreaterThan(positions.disclaimer);
});
