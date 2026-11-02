import { randomUUID } from 'node:crypto';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

async function api(page: Page, path: string, body?: unknown, identityOverride?: string) {
  const result = await page.evaluate(async ({ path, body, identityOverride }) => {
    const identity = identityOverride ?? new URL(location.href).searchParams.get('identity');
    const response = await fetch(`/api${path}`, {
      headers: { ...(identity ? { 'X-RPG-Identity': identity } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, data: await response.json() };
  }, { path, body, identityOverride });
  expect(result.status, JSON.stringify(result.data)).toBe(200);
  return result.data;
}

// Records every full-frame reveal that starts on the stream page after this call, so a quiet swap can be checked
// over the whole reveal window rather than after it has already ended.
async function recordReveals(stream: Page) {
  await expect(stream.locator('.scene-picture.revealing, .scene-picture.shrinking, .scene-reveal-titles')).toHaveCount(0, { timeout: 15000 });
  await stream.evaluate(() => {
    const seen: string[] = [];
    (window as unknown as { __reveals: string[] }).__reveals = seen;
    const check = () => {
      if (document.querySelector('.scene-picture.revealing')) seen.push('revealing');
      if (document.querySelector('.scene-picture.shrinking')) seen.push('shrinking');
      if (document.querySelector('.scene-reveal-titles')) seen.push('titles');
    };
    new MutationObserver(check).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
  });
}

async function revealsSeen(stream: Page): Promise<string[]> {
  return stream.evaluate(() => [...new Set((window as unknown as { __reveals: string[] }).__reveals)]);
}

async function status(page: Page, path: string) {
  return page.evaluate(async (path) => {
    const identity = new URL(location.href).searchParams.get('identity');
    return (await fetch(`/api${path}`, { headers: identity ? { 'X-RPG-Identity': identity } : {} })).status;
  }, path);
}

async function openStream(context: BrowserContext, url: string) {
  const page = await context.newPage();
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto(url);
  return page;
}

test('an action round with portrait-bearing characters stays off the stream until publish, then swaps in quietly', async ({ page, context }) => {
  await page.goto('/');
  await page.getByLabel('Host access token').fill('browser-test-host-credential-not-for-deployment');
  await page.getByRole('button', { name: 'Sign in as host' }).click();
  await expect(page.getByTestId('library-link')).toBeVisible();
  const starter = await api(page, '/library/starter');
  const scenario = await api(page, '/library/scenarios', {
    commandId: randomUUID(), expectedVersion: 0,
    definition: {
      ...starter.scenario, title: `Portrait show ${Date.now()}`, boundaries: ['No graphic injury'],
      openingScene: { ...starter.scenario.openingScene, title: 'The Lantern Dock' }, tracks: [], facts: [],
    },
  });

  const portraits: string[] = [];
  const cards: Array<{ id: string; version: number }> = [];
  for (const name of ['Nia', 'Oren']) {
    const index = cards.length;
    const appearance = `${name} wears a flight suit.`;
    const { imageId } = await api(page, '/library/portraits', {
      subject: 'card', subjectKey: `portrait-${name.toLowerCase()}-${randomUUID()}`,
      details: { appearance, role: '', pronouns: '', name: '' }, pictureStyle: '',
    });
    expect(imageId).toBeTruthy();
    await expect.poll(() => status(page, `/library/images/${imageId}`), { timeout: 20000 }).toBe(200);
    portraits.push(imageId);
    cards.push(await api(page, '/library/characters', {
      commandId: randomUUID(), expectedVersion: 0,
      definition: { ...starter.characters[index], displayName: name, appearance, portraitId: imageId },
    }));
  }

  await page.getByTestId('library-link').click();
  await page.getByTestId('show-title').fill('Friday at the Dock');
  await page.getByTestId('show-scenario').selectOption(`${scenario.id}:1`);
  await page.getByTestId('show-seat-0').selectOption(`${cards[0]!.id}:1`);
  await page.getByTestId('show-seat-1').selectOption(`${cards[1]!.id}:1`);
  await page.getByTestId('create-custom').click();
  await page.waitForURL(/\/sessions\/[^/]+\/lobby/);
  const sessionId = new URL(page.url()).pathname.split('/')[2]!;
  const hostIdentity = new URL(page.url()).searchParams.get('identity');
  const path = `/sessions/${sessionId}`;
  const lobby = await api(page, path);
  expect(lobby.characterDetails.every((character: any) => character.approved && !character.draft)).toBe(true);

  // Seats made from saved cards start approved, with their library portraits copied onto the show's characters.
  await expect.poll(async () => (await api(page, path)).characters.map((character: any) => character.portraitId ?? null).sort())
    .toEqual([...portraits].sort());
  const approved = await api(page, path);
  const byName = Object.fromEntries(approved.characters.map((character: any) => [character.displayName, character.portraitId]));
  expect(byName).toEqual({ Nia: portraits[0], Oren: portraits[1] });

  await expect(page.getByTestId('start-session')).toBeEnabled();
  const created = await api(page, `${path}/stream-links`, { commandId: randomUUID(), subject: 'show' });
  const stream = await openStream(context, `/stream?layout=scene&audio=off#token=${encodeURIComponent(created.token)}`);
  await expect(stream.locator('.stage')).toBeVisible();

  await page.getByTestId('start-session').click();
  await page.waitForURL(/\/sessions\/[^/]+\/director/);
  await expect.poll(async () => (await api(page, path)).setup.started).toBe(true);
  await expect.poll(async () => (await api(page, path)).scenePictureStatus?.state, { timeout: 20000 }).toBe('ready');
  await expect(stream.locator('.scene-picture.revealing')).toBeVisible({ timeout: 15000 });
  await expect(stream.locator('.scene-reveal-titles')).toHaveCount(0, { timeout: 15000 });

  let state = await api(page, path);
  expect(state.characters.map((character: any) => character.portraitId).sort()).toEqual([...portraits].sort());
  const command = async (value: Record<string, unknown>, identity?: string) => {
    const result = await api(page, `${path}/commands`, { commandId: randomUUID(), ...value }, identity);
    if (!identity) state = result.snapshot;
    return result.snapshot;
  };
  const beat = (value: Record<string, unknown>) => command({ beatId: state.activeBeat.id, expectedBeatRevision: state.activeBeat.revision, ...value });

  const seats: string[] = [];
  for (const character of state.characters) seats.push((await api(page, `${path}/test-seat`, { characterId: character.id })).identityId);
  await command({ type: 'open_beat', kind: 'action', expectedInputEpoch: state.session.inputEpoch });
  for (let index = 0; index < seats.length; index++) {
    await command({ type: 'save_submission', contextBeatId: state.activeBeat.id, expectedInputEpoch: state.session.inputEpoch, expectedSubmissionRevision: 0, kind: 'act', text: '', intent: `Search the dock ${index}`, approach: 'Careful investigation' }, seats[index]);
  }
  state = await api(page, path);
  await beat({ type: 'plan_beat', submissionIds: state.submissions.filter((item: any) => item.status === 'queued').map((item: any) => item.id) });
  await beat({ type: 'approve_stakes', classification: 'action', contracts: state.activeBeat.contracts });
  await beat({ type: 'lock_beat' });
  await beat({ type: 'render_beat' });

  await expect.poll(async () => (await api(page, path)).actionPicture?.state, { timeout: 20000 }).toBe('ready');
  state = await api(page, path);
  const actionId: string = state.actionPicture.imageId;
  expect(actionId).toBeTruthy();
  expect(portraits).not.toContain(actionId);

  const director = await context.newPage();
  await director.goto(`/sessions/${sessionId}/director${hostIdentity ? `?identity=${hostIdentity}` : ''}`);
  await expect(director.getByTestId('action-picture-status')).toHaveText('This beat\'s picture is ready. Viewers and players see it when you publish the beat.');
  await expect(director.getByTestId('action-picture-preview')).toHaveAttribute('src', new RegExp(actionId));
  await expect(stream.locator('.scene-picture.revealing')).toHaveCount(0);
  await expect(stream.locator(`img[src*="${actionId}"]`)).toHaveCount(0);
  await stream.waitForTimeout(2000);
  await expect(stream.locator(`img[src*="${actionId}"]`)).toHaveCount(0);

  if (state.activeBeat.draft?.continuity?.length) await beat({ type: 'approve_continuity', updates: state.activeBeat.draft.continuity });
  await recordReveals(stream);
  await beat({ type: 'publish_beat', expectedStateRevision: state.session.stateRevision, draftRevision: state.activeBeat.draftRevision, textOnly: true });

  // The round's picture swaps in quietly at publish: the image changes and no full-frame reveal plays for it.
  await expect(stream.locator('.scene-picture img')).toHaveAttribute('src', new RegExp(actionId), { timeout: 15000 });
  await expect(stream.locator('.scene-picture:not(.revealing)')).toBeVisible({ timeout: 1000 });
  await stream.waitForTimeout(1500);
  expect(await revealsSeen(stream)).toEqual([]);
  await expect(director.getByTestId('action-picture')).toHaveCount(0);
});
