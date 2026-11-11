import { randomUUID } from 'node:crypto';
import { expect, test, type Browser, type Page } from '@playwright/test';

async function rawApi(page: Page, path: string, body?: unknown, identityOverride?: string) {
  return page.evaluate(async ({ path, body, identityOverride }) => {
    const identity = identityOverride ?? new URL(location.href).searchParams.get('identity');
    const response = await fetch(`/api${path}`, { headers: { ...(identity ? { 'X-RPG-Identity': identity } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() };
  }, { path, body, identityOverride });
}

async function api(page: Page, path: string, body?: unknown, identityOverride?: string) {
  const result = await rawApi(page, path, body, identityOverride);
  expect(result.status, JSON.stringify(result.data).slice(0, 400)).toBe(200);
  return result.data;
}

test.setTimeout(240000);

async function signIn(page: Page) {
  await page.goto('/');
  await page.getByLabel('Host access token').fill('browser-test-host-credential-not-for-deployment');
  await page.getByRole('button', { name: 'Sign in as host' }).click();
  await page.getByRole('button', { name: 'Try it now' }).click();
  await expect(page.getByTestId('director-controls')).toBeVisible();
  return new URL(page.url()).pathname.split('/')[2]!;
}

// The six chip states: no open round, then each stage of an open round in words.
const STATES = [
  { label: 'Live', waiting: false, beat: null },
  { label: 'Taking lines', waiting: true, beat: { phase: 'collecting', planning: false, stakesApproved: false } },
  { label: 'Setting stakes', waiting: true, beat: { phase: 'collecting', planning: true, stakesApproved: false } },
  { label: 'Stakes are set', waiting: false, beat: { phase: 'stakes_review', planning: false, stakesApproved: true } },
  { label: 'Writing the story', waiting: true, beat: { phase: 'locked', planning: false, stakesApproved: true } },
  { label: 'Story coming up', waiting: true, beat: { phase: 'draft_review', planning: false, stakesApproved: true } },
] as const;

// The badge piece box on the 1920 by 1080 canvas: right 96, top 60, 336 by 164.
const BADGE_BOX = { left: 1488, top: 60, right: 1824, bottom: 224 };

test('the stream and the seat name the planning stage at once, and Stop the AI returns both to taking lines even after a reload', async ({ page, browser }) => {
  const sessionId = await signIn(page);
  const path = `/sessions/${sessionId}`;
  let snapshot = await api(page, path);
  const command = async (value: Record<string, unknown>, identity?: string) => {
    const result = await api(page, `${path}/commands`, { commandId: randomUUID(), ...value }, identity);
    if (!identity) snapshot = result.snapshot;
    return result.snapshot;
  };
  await command({ type: 'set_status', status: 'live', expectedStateRevision: snapshot.session.stateRevision });
  const character = snapshot.characters[0];
  const seatIdentity: string = (await api(page, `${path}/test-seat`, { characterId: character.id })).identityId;
  const created = await api(page, `${path}/stream-links`, { commandId: randomUUID(), subject: 'show' });
  const hash = `#token=${encodeURIComponent(created.token)}`;

  await command({ type: 'open_beat', kind: 'action', expectedInputEpoch: snapshot.session.inputEpoch });
  await command({
    type: 'save_submission', contextBeatId: snapshot.activeBeat.id, expectedInputEpoch: snapshot.session.inputEpoch, expectedSubmissionRevision: 0,
    kind: 'act', text: '', intent: 'Hold the AI: study the lantern dock', approach: 'Careful investigation',
  }, seatIdentity);

  const seat = await page.context().newPage();
  await seat.setViewportSize({ width: 390, height: 844 });
  await seat.goto(`${path}/play?identity=${seatIdentity}`);
  const banner = seat.locator('.player-status');
  await expect(banner).toContainText('The director has your line', { timeout: 20000 });

  const streamContext = await browser.newContext({ viewport: { width: 336, height: 164 } });
  try {
    const badge = await streamContext.newPage();
    await badge.goto(`/stream?view=badge${hash}`);
    await expect(badge.locator('.state-chip')).toHaveText('Taking lines', { timeout: 20000 });

    // The director presses the gold button for the ticked line: both pages say the plan is running before the AI answers.
    await page.reload();
    await expect(page.getByTestId('plan')).toBeEnabled({ timeout: 20000 });
    await expect(page.getByTestId('plan')).toHaveText('Plan');
    await page.getByTestId('plan').click();
    await expect(page.getByTestId('beat-status')).toContainText('Planning', { timeout: 3000 });
    await expect(banner).toContainText('Your line is in this round', { timeout: 3000 });
    await expect(badge.locator('.state-chip')).toHaveText('Setting stakes', { timeout: 3000 });
    await expect(badge.locator('.chip-pulse')).toHaveCount(1);

    // Reload the director page mid-wait: Stop the AI is still there and ends the wait.
    await page.reload();
    await expect(page.getByTestId('stop-ai')).toBeVisible({ timeout: 20000 });
    await expect(page.getByTestId('stop-ai')).toBeEnabled();
    await page.getByTestId('stop-ai').click();
    await expect(page.getByTestId('ai-stopped')).toHaveText('You stopped the AI. Nothing from that try was used.', { timeout: 5000 });
    await expect(page.getByTestId('beat-error')).toHaveCount(0);
    await expect(page.getByTestId('plan')).toBeEnabled();
    await expect(banner).toContainText('The director has your line', { timeout: 5000 });
    await expect(banner).not.toContainText('Your line is in this round');
    await expect(badge.locator('.state-chip')).toHaveText('Taking lines', { timeout: 5000 });
    await expect(page.getByTestId('beat-error')).toHaveCount(0);
  } finally { await streamContext.close(); }
});

async function chipFit(browser: Browser, hash: string, surface: 'piece' | 'overlay') {
  const piece = surface === 'piece';
  const context = await browser.newContext({ viewport: piece ? { width: 336, height: 164 } : { width: 1920, height: 1080 } });
  return { context, url: piece ? `/stream?view=badge${hash}` : `/stream?layout=overlay&audio=off${hash}` };
}

for (const surface of ['piece', 'overlay'] as const) {
  test(`every chip state fits inside the badge box on the ${surface === 'piece' ? 'badge piece' : 'overlay'} and only the four waiting stages pulse`, async ({ page, browser }) => {
    const sessionId = await signIn(page);
    const path = `/sessions/${sessionId}`;
    let snapshot = await api(page, path);
    await api(page, `${path}/commands`, { commandId: randomUUID(), type: 'set_status', status: 'live', expectedStateRevision: snapshot.session.stateRevision });
    snapshot = await api(page, path);
    await api(page, `${path}/commands`, { commandId: randomUUID(), type: 'open_beat', kind: 'action', expectedInputEpoch: snapshot.session.inputEpoch });
    const created = await api(page, `${path}/stream-links`, { commandId: randomUUID(), subject: 'show' });
    const hash = `#token=${encodeURIComponent(created.token)}`;

    const { context, url } = await chipFit(browser, hash, surface);
    try {
      let current: (typeof STATES)[number] = STATES[0];
      await context.route(/\/api\/sessions\/[^/?]+\?view=stage$/, async route => {
        const response = await route.fetch();
        const body = await response.json();
        if (!current.beat) body.activeBeat = null;
        else body.activeBeat = { ...body.activeBeat, ...current.beat };
        await route.fulfill({ response, json: body });
      });
      const stream = await context.newPage();
      for (const state of STATES) {
        current = state;
        await stream.goto(url);
        const chip = stream.locator('.state-chip');
        await expect(chip, state.label).toHaveText(state.label, { timeout: 20000 });
        await expect(stream.locator('.state-chip .chip-pulse'), `${state.label} pulse`).toHaveCount(state.waiting ? 1 : 0);
        const fit = await chip.evaluate(element => {
          const rect = element.getBoundingClientRect();
          const pulse = element.querySelector('.chip-pulse')?.getBoundingClientRect() ?? null;
          return {
            left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth,
            pulseRight: pulse ? pulse.right : null, pulseBottom: pulse ? pulse.bottom : null,
          };
        });
        const box = surface === 'piece' ? { left: 0, top: 0, right: 336, bottom: 164 } : BADGE_BOX;
        const where = `${state.label} on ${surface}: ${JSON.stringify(fit)}`;
        test.info().annotations.push({ type: 'chip-fit', description: where });
        expect(fit.left, where).toBeGreaterThanOrEqual(box.left - 1);
        expect(fit.top, where).toBeGreaterThanOrEqual(box.top - 1);
        expect(fit.right, where).toBeLessThanOrEqual(box.right + 1);
        expect(fit.bottom, where).toBeLessThanOrEqual(box.bottom + 1);
        expect(fit.scrollWidth, where).toBeLessThanOrEqual(fit.clientWidth);
        if (fit.pulseRight !== null) {
          // The pulse stays inside the chip's own side padding.
          expect(fit.pulseRight, where).toBeLessThanOrEqual(fit.right - 8);
        }
        if (surface === 'piece') expect(await stream.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight), where).toBe(true);
      }
    } finally { await context.close(); }
  });
}
