import { randomUUID } from 'node:crypto';
import { expect, test, type Browser, type Page } from '@playwright/test';

async function api(page: Page, path: string, body?: unknown, identity?: string) {
  return page.evaluate(async ({ path, body, identity }) => {
    const id = identity ?? new URL(location.href).searchParams.get('identity');
    const response = await fetch(`/api${path}`, { headers: { ...(id ? { 'X-RPG-Identity': id } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  }, { path, body, identity });
}

async function signInAndTryIt(page: Page) {
  await page.goto('/');
  await page.getByLabel('Host access token').fill('browser-test-host-credential-not-for-deployment');
  await page.getByRole('button', { name: 'Sign in as host' }).click();
  await page.getByRole('button', { name: 'Try it now' }).click();
  await expect(page.getByTestId('director-controls')).toBeVisible();
  return new URL(page.url()).pathname.split('/')[2]!;
}

const noSideways = (page: Page) => expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

// The piece the spec copies and opens, with the box the stream cuts it to.
const PIECE = { view: 'badge', width: 336, height: 164, root: '.top-right' } as const;

async function copyPieceLink(browser: Browser, width: number, height: number) {
  const context = await browser.newContext({ viewport: { width, height } });
  // Capture what the Copy link button writes, so the spec needs no clipboard permission.
  await context.addInitScript(() => {
    const store = window as unknown as { __copied: string[] };
    store.__copied = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { store.__copied.push(text); } } });
  });
  const page = await context.newPage();
  try {
    await signInAndTryIt(page);
    await page.getByTestId('stream-this-show').click();
    await expect(page.getByTestId('stream-setup')).toHaveAttribute('open', '');
    const kit = page.getByTestId('stream-row-show');
    await expect(kit.getByTestId('copy-scene')).toBeVisible();
    await kit.getByTestId('kit-pieces').locator('summary').first().click();
    await expect(kit.getByTestId('kit-pieces')).toHaveAttribute('open', '');
    const card = kit.getByTestId(`kit-piece-${PIECE.view}`);
    await card.scrollIntoViewIfNeeded();
    await expect(card.getByTestId('kit-size')).toHaveText(`${PIECE.width} × ${PIECE.height}`);
    await card.getByTestId('kit-copy').click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __copied: string[] }).__copied.length)).toBe(1);
    const copied = await page.evaluate(() => (window as unknown as { __copied: string[] }).__copied[0]!);
    await noSideways(page);
    return { copied, context, page };
  } catch (error) { await context.close(); throw error; }
}

test.setTimeout(150000);

for (const size of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
  test(`a piece link copied from the Stream kit opens at its own size, and the kit does not scroll sideways at ${size.width} wide`, async ({ browser }) => {
    const { copied, context } = await copyPieceLink(browser, size.width, size.height);
    const piece = await browser.newContext({ viewport: { width: PIECE.width, height: PIECE.height } });
    try {
      const url = new URL(copied);
      expect(url.pathname).toBe('/stream');
      expect(url.searchParams.get('view')).toBe(PIECE.view);
      expect(url.hash).toMatch(/^#token=.+/);
      const page = await piece.newPage();
      await page.goto(copied);
      const root = page.locator(PIECE.root);
      await expect(root).toBeVisible({ timeout: 20000 });
      const box = await root.evaluate(element => { const rect = element.getBoundingClientRect(); return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height }; });
      expect(box.width).toBeGreaterThan(0);
      expect(box.height).toBeGreaterThan(0);
      expect(box.left).toBeGreaterThanOrEqual(-1);
      expect(box.right).toBeLessThanOrEqual(PIECE.width + 1);
      expect(box.bottom).toBeLessThanOrEqual(PIECE.height + 1);
      await expect(page.locator('button, input, select, textarea, a')).toHaveCount(0);
      await noSideways(page);
    } finally { await piece.close(); await context.close(); }
  });
}

test('What I have opens on a phone seat with no sideways scroll, and Use fills the Do box without sending a line', async ({ page, context }) => {
  const sessionId = await signInAndTryIt(page);
  const path = `/sessions/${sessionId}`;
  const state = (await api(page, path)).body;
  const seatCharacter = state.characterDetails[0];

  if (state.session.status !== 'live') {
    const live = await api(page, `${path}/commands`, { type: 'set_status', commandId: randomUUID(), expectedStateRevision: state.session.stateRevision, status: 'live' });
    expect(live.status, JSON.stringify(live.body).slice(0, 300)).toBe(200);
  }

  // Give the character an item through the director's Edit look and items, so the list is never empty.
  const ITEM = 'Brass lockpick set';
  const saved = await api(page, `${path}/commands`, {
    type: 'save_live_character', commandId: randomUUID(), characterId: seatCharacter.id, expectedCharacterRevision: seatCharacter.cardRevision,
    appearance: seatCharacter.appearance, possessions: [ITEM, ...seatCharacter.possessions.filter((item: string) => item !== ITEM)],
  });
  expect(saved.status, JSON.stringify(saved.body).slice(0, 300)).toBe(200);

  await page.getByTestId('open-action').click();
  await expect.poll(async () => (await api(page, path)).body.activeBeat?.kind).toBe('action');
  const before = (await api(page, path)).body.submissions.length;
  await page.reload();
  await expect(page.getByTestId('director-controls')).toBeVisible();
  const queued = await page.locator('.queue-item').count();

  const grant = await api(page, `${path}/test-seat`, { characterId: seatCharacter.id });
  expect(grant.status).toBe(200);
  const seat = await context.newPage();
  await seat.setViewportSize({ width: 390, height: 844 });
  await seat.goto(`${path}/play?identity=${grant.body.identityId}`);

  const items = seat.getByTestId('seat-items');
  await expect(items).toBeVisible();
  await expect(items).not.toHaveAttribute('open', '');
  await noSideways(seat);
  await items.locator('summary').click();
  await expect(items).toHaveAttribute('open', '');
  await expect(seat.getByTestId('seat-item-use-0')).toBeVisible();
  await noSideways(seat);
  await seat.screenshot({ path: 'test-results/kit-and-seat-items.png' });

  const first = await seat.getByTestId('seat-item-use-0').getAttribute('aria-label');
  const item = first!.replace(/^Use /, '');
  expect(item).toBe(ITEM);
  await seat.getByTestId('seat-item-use-0').click();
  const box = seat.getByTestId('action-input');
  await expect(box).toBeVisible();
  await expect.poll(async () => (await box.inputValue()).startsWith(`Use ${item} to `)).toBe(true);
  await noSideways(seat);

  // Nothing was sent: the server holds no new line and the director's queue shows none.
  await seat.waitForTimeout(1000);
  expect((await api(page, path)).body.submissions.length).toBe(before);
  await page.reload();
  await expect(page.getByTestId('director-controls')).toBeVisible();
  await expect(page.locator('.queue-item')).toHaveCount(queued);
  await seat.close();
});
