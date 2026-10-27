import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';

async function api(page: Page, path: string, body?: unknown) {
  const result = await page.evaluate(async ({ path, body }) => {
    const identity = new URL(location.href).searchParams.get('identity');
    const response = await fetch(`/api${path}`, {
      headers: { ...(identity ? { 'X-RPG-Identity': identity } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, data: await response.json() };
  }, { path, body });
  expect(result.status, JSON.stringify(result.data)).toBe(200);
  return result.data;
}

test('a finished show becomes a public gallery: private link, viewer, public list, and turning it off', async ({ page, context, browser }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/');
  await page.getByLabel('Host access token').fill('browser-test-host-credential-not-for-deployment');
  await page.getByRole('button', { name: 'Sign in as host' }).click();
  await page.getByRole('button', { name: 'Create rehearsal session' }).click();
  await page.getByRole('link', { name: 'Enter director workspace' }).click();
  await expect(page.getByTestId('director-controls')).toBeVisible();
  const sessionId = new URL(page.url()).pathname.split('/')[2]!;
  const path = `/sessions/${sessionId}`;

  const setStatus = async (status: 'live' | 'ended') => {
    const snapshot = await api(page, path);
    await api(page, `${path}/commands`, { type: 'set_status', commandId: randomUUID(), expectedStateRevision: snapshot.session.stateRevision, status });
  };
  const title: string = (await api(page, path)).session.title;
  expect(title).toBeTruthy();

  // Two scene pictures. Hide picture covers every picture of the scene, including the one drawn afterwards.
  await setStatus('live');
  await expect.poll(async () => (await api(page, path)).scenePictureStatus?.state, { timeout: 20000 }).toBe('ready');
  await page.reload();
  await page.getByTestId('scene-picture-hide').click();
  await expect(page.getByTestId('scene-picture-show')).toBeVisible();
  await page.getByTestId('scene-picture-new').click();
  await expect(page.getByTestId('scene-picture-status')).toContainText('Making the picture');
  await expect.poll(async () => (await api(page, path)).scenePictureStatus?.state, { timeout: 20000 }).toBe('ready');
  await setStatus('ended');
  await page.reload();

  // Turn on the gallery and copy its private link.
  const panel = page.getByTestId('gallery-panel');
  await expect(panel).toBeVisible();
  await panel.getByTestId('gallery-on').click();
  await expect(panel.getByTestId('gallery-status')).toContainText('Gallery on · 2 pictures', { timeout: 20000 });
  const link = await panel.getByTestId('gallery-url').inputValue();
  expect(link).toMatch(/\/gallery\/[A-Za-z0-9_-]{43}\/$/);
  await panel.getByTestId('gallery-copy').click();
  const clipboard = await page.evaluate(() => navigator.clipboard.readText().catch(() => null));
  if (clipboard !== null) expect(clipboard).toBe(link);

  // A visitor with no cookies opens it.
  const visitor = await browser.newContext();
  try {
    expect(await visitor.cookies()).toEqual([]);
    const guest = await visitor.newPage();
    const response = await guest.goto(link);
    expect(response!.status()).toBe(200);
    await expect(guest.getByRole('heading', { level: 1 })).toHaveText(title);
    await expect(guest.getByText('Show of', { exact: false })).toBeVisible();
    await expect(guest.locator('.gallery-count')).toHaveText('2 pictures');
    await expect(guest.getByRole('heading', { level: 2, name: /^Scene 1 · / })).toBeVisible();
    await expect(guest.locator('.picture-label')).toHaveText(['The place', 'The place']);
    await expect(guest.locator('.picture-tag').filter({ hasText: 'Hidden' })).toHaveCount(2);
    await expect(guest.locator('.gallery-link img').first()).toHaveJSProperty('complete', true);
    expect(await guest.locator('.gallery-link img').first().evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);

    const drawn = guest.locator('.picture-drawn').first();
    await drawn.getByText('How this was drawn').click();
    await expect(drawn.locator('.picture-model')).toHaveText('Model: fake-image');
    const prompt = (await guest.locator('a.gallery-link').first().getAttribute('data-prompt'))!;
    expect(prompt.length).toBeGreaterThan(0);
    await expect(drawn.locator('.picture-prompt')).toHaveText(prompt);

    // The viewer steps through the pictures.
    const secondPrompt = (await guest.locator('a.gallery-link').nth(1).getAttribute('data-prompt'))!;
    await guest.locator('a.gallery-link').first().click();
    const dialog = guest.getByRole('dialog', { name: 'Picture viewer' });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.viewer-prompt')).toHaveText(prompt);
    await guest.keyboard.press('ArrowRight');
    await expect(dialog.locator('.viewer-prompt')).toHaveText(secondPrompt);
    await guest.keyboard.press('ArrowLeft');
    await expect(dialog.locator('.viewer-prompt')).toHaveText(prompt);
    await guest.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    // The public list shows the show only after Add to public list.
    const cards = async () => {
      const reader = await browser.newContext();
      try {
        const readerPage = await reader.newPage();
        await readerPage.goto(new URL('/gallery/', link).toString());
        return await readerPage.locator('.gallery-card-title').filter({ hasText: title }).count();
      } finally {
        await reader.close();
      }
    };
    expect(await cards()).toBe(0);
    await panel.getByTestId('gallery-list').click();
    await expect(panel.getByTestId('gallery-listed')).toBeVisible();
    expect(await cards()).toBe(1);

    // Turning the gallery off makes the link a 404 with the missing page.
    await panel.getByTestId('gallery-off').click();
    await expect(panel.getByTestId('gallery-confirm')).toBeVisible();
    await panel.getByTestId('gallery-confirm-yes').click();
    await expect(panel.getByTestId('gallery-on')).toBeVisible();
    const stranger = await browser.newContext();
    try {
      const strangerPage = await stranger.newPage();
      const gone = await strangerPage.goto(link);
      expect(gone!.status()).toBe(404);
      await expect(strangerPage.getByText("This gallery isn't available.")).toBeVisible();
    } finally {
      await stranger.close();
    }
    expect(await cards()).toBe(0);
  } finally {
    await visitor.close();
  }
});
