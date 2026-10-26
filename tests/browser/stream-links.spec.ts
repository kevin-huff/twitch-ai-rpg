import { randomUUID } from 'node:crypto';
import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';

async function api(page: Page, path: string, body?: unknown) {
  return page.evaluate(async ({ path, body }) => {
    const identity = new URL(location.href).searchParams.get('identity');
    const response = await fetch(`/api${path}`, { headers: { ...(identity ? { 'X-RPG-Identity': identity } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  }, { path, body });
}

async function publishOneBeat(page: Page, context: { newPage(): Promise<Page> }, sessionId: string) {
  const path = `/sessions/${sessionId}`;
  let state = (await api(page, path)).body;
  const grant = (await api(page, `${path}/test-seat`, { characterId: state.characters[0].id })).body;
  const player = await context.newPage();
  await player.goto(`${path}/play?identity=${grant.identityId}`);
  async function command(caller: Page, value: Record<string, unknown>) {
    const result = await api(caller, `${path}/commands`, { commandId: randomUUID(), ...value });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    return result.body.snapshot;
  }
  const beat = async (value: Record<string, unknown>) => { state = await command(page, { beatId: state.activeBeat.id, expectedBeatRevision: state.activeBeat.revision, ...value }); };
  state = await command(page, { type: 'open_beat', kind: 'conversation', expectedInputEpoch: state.session.inputEpoch });
  const text = 'Who left the ledger on the counter?';
  const submitted = await command(player, { type: 'save_submission', contextBeatId: state.activeBeat.id, expectedInputEpoch: state.session.inputEpoch, expectedSubmissionRevision: 0, kind: 'say', text, recipientNpcIds: [state.npcs[0].id] });
  await beat({ type: 'plan_beat', submissionIds: submitted.submissions.map((s: { id: string }) => s.id) });
  await beat({ type: 'approve_stakes', classification: 'ordinary', contracts: [] });
  await beat({ type: 'lock_beat' });
  await beat({ type: 'render_beat' });
  await beat({ type: 'publish_beat', expectedStateRevision: state.session.stateRevision, draftRevision: state.activeBeat.draftRevision, textOnly: true });
  await player.close();
  expect(state.history).toHaveLength(1);
  return state.history[0].segments.map((segment: { text: string }) => segment.text) as string[];
}

async function chooseLayout(row: Locator, label: string) {
  await row.getByLabel('Layout').selectOption({ label });
}

async function openStream(browser: Browser, url: string) {
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();
  await page.goto(url);
  return { context, page };
}

async function expectPictureOnly(page: Page, lines: string[]) {
  const story = page.locator('.stage-story');
  await expect(story).toBeVisible();
  for (const line of lines) await expect(story).toContainText(line);
  await expect(page.locator('button, input, select, textarea')).toHaveCount(0);
}

test('main show link and a personal link each draw the latest beat in both layouts, then show the holding screen once turned off', async ({ page, context, browser }) => {
  await page.goto('/');
  await page.getByLabel('Host access token').fill('browser-test-host-credential-not-for-deployment');
  await page.getByRole('button', { name: 'Sign in as host' }).click();
  await page.getByRole('button', { name: 'Create rehearsal session' }).click();
  await page.getByRole('link', { name: 'Enter director workspace' }).click();
  await expect(page.getByTestId('director-controls')).toBeVisible();
  const sessionId = new URL(page.url()).pathname.split('/')[2];
  const lines = await publishOneBeat(page, context, sessionId);
  expect(lines.length).toBeGreaterThan(0);

  await page.getByRole('link', { name: 'Cast & lobby' }).click();
  await page.getByRole('button', { name: 'Show stage & OBS links' }).click();
  await page.getByRole('button', { name: 'Create main show link' }).click();
  const showRow = page.locator('.link-row').filter({ hasText: 'The whole show' });
  await expect(showRow.getByLabel('Link address')).toBeVisible();
  await page.getByLabel('Create a personal link for').selectOption({ label: 'You' });
  await page.getByRole('button', { name: 'Create link' }).click();
  const personalRow = page.locator('.link-row').filter({ hasText: 'Host' }).filter({ hasNotText: 'The whole show' });
  await expect(personalRow.getByLabel('Link address')).toBeVisible();

  const urls: Record<string, string> = {};
  for (const [name, row] of [['show', showRow], ['personal', personalRow]] as const) {
    for (const [layout, label] of [['scene', 'Full scene (1920×1080)'], ['overlay', 'Transparent overlay']] as const) {
      await chooseLayout(row, label);
      const url = await row.getByLabel('Link address').inputValue();
      expect(new URL(url).searchParams.get('layout')).toBe(layout);
      expect(new URL(url).pathname).toBe('/stream');
      expect(new URL(url).hash).toMatch(/^#token=.+/);
      urls[`${name}-${layout}`] = url;
    }
  }
  expect(urls['show-scene']).toContain('audio=present');
  expect(urls['personal-scene']).not.toContain('audio=present');

  const open: Page[] = [];
  const contexts: { close(): Promise<void> }[] = [];
  try {
    for (const [key, url] of Object.entries(urls)) {
      const { context: viewer, page: stream } = await openStream(browser, url);
      contexts.push(viewer);
      await expectPictureOnly(stream, lines);
      await expect(stream.locator('.stage')).toBeVisible();
      if (key.endsWith('overlay')) {
        const backgrounds = await stream.evaluate(() => [getComputedStyle(document.documentElement).backgroundColor, getComputedStyle(document.body).backgroundColor]);
        for (const background of backgrounds) expect(background).toMatch(/^rgba\(\d+, \d+, \d+, 0\)$|^transparent$/);
      }
      expect(new URL(stream.url()).searchParams.get('layout')).toBe(key.split('-')[1]);
      if (key === 'show-scene' || key === 'personal-scene') open.push(stream);
    }

    await personalRow.getByRole('button', { name: 'Revoke' }).click();
    await personalRow.getByRole('button', { name: 'Turn off link' }).click();
    await expect(page.locator('.link-row').filter({ hasText: 'Host' }).filter({ hasNotText: 'The whole show' })).toHaveCount(0);
    await showRow.getByRole('button', { name: 'Revoke' }).click();
    await showRow.getByRole('button', { name: 'Turn off link' }).click();
    await expect(showRow).toHaveCount(0);

    for (const stream of open) {
      await expect(stream.getByText('The story continues shortly')).toBeVisible({ timeout: 10000 });
      await expect(stream.locator('button, input, select, textarea')).toHaveCount(0);
    }
    const { context: late, page: lateStream } = await openStream(browser, urls['show-overlay']);
    contexts.push(late);
    await expect(lateStream.getByText('The story continues shortly')).toBeVisible({ timeout: 10000 });
  } finally { await Promise.all(contexts.map(item => item.close())); }
});
