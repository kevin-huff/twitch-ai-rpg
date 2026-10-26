import { randomUUID } from 'node:crypto';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { MOMENT_MODEL, PICTURE_MODELS } from '@rpg/contracts';

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

// Signs in as host, builds a custom show, approves and readies both players, and returns the session id, the host
// identity and a show link in the given layout. The show has not started yet.
async function prepareShow(page: Page, context: BrowserContext, layout: 'scene' | 'overlay') {
  await page.goto('/');
  await page.getByLabel('Host access token').fill('browser-test-host-credential-not-for-deployment');
  await page.getByRole('button', { name: 'Sign in as host' }).click();
  await expect(page.getByTestId('library-link')).toBeVisible();
  const starter = await api(page, '/library/starter');
  const scenario = await api(page, '/library/scenarios', {
    commandId: randomUUID(), expectedVersion: 0,
    definition: {
      ...starter.scenario, title: `Beat picture show ${Date.now()}`, boundaries: ['No graphic injury'],
      openingScene: { ...starter.scenario.openingScene, title: 'The Lantern Dock' },
      tracks: [], facts: [],
    },
  });
  const cards: Array<{ id: string; version: number }> = [];
  for (const name of ['Nia', 'Oren']) {
    const index = cards.length;
    cards.push(await api(page, '/library/characters', {
      commandId: randomUUID(), expectedVersion: 0,
      definition: { ...starter.characters[index], displayName: name, appearance: `${name} wears a flight suit.` },
    }));
  }
  await page.getByTestId('library-link').click();
  await page.getByTestId('show-title').fill('Friday at the Dock');
  await page.getByTestId('show-scenario').selectOption(`${scenario.id}:1`);
  await page.getByTestId('show-seat-0').selectOption(`${cards[0]!.id}:1`);
  await page.getByTestId('show-seat-1').selectOption(`${cards[1]!.id}:1`);
  await page.getByTestId('create-custom').click();
  await page.getByTestId('custom-lobby-link').click();
  const sessionId = new URL(page.url()).pathname.split('/')[2]!;
  const hostIdentity = new URL(page.url()).searchParams.get('identity');
  const snapshot = await api(page, `/sessions/${sessionId}`);
  for (const character of snapshot.characterDetails) await page.getByTestId(`approve-character-${character.id}`).click();
  for (const name of ['Nia', 'Oren']) {
    const popup = context.waitForEvent('page');
    await page.getByRole('link', { name: `Test as ${name} ↗`, exact: true }).click();
    const player = await popup;
    await player.getByRole('link', { name: 'Cast & lobby', exact: true }).first().click();
    await player.getByTestId('accept-boundaries').check();
    await player.getByTestId('ready-character').click();
    await expect(player.getByText('You are ready for this version of the boundaries.', { exact: true })).toBeVisible();
    await player.close();
  }
  await expect(page.getByTestId('start-session')).toBeEnabled();
  const created = await api(page, `/sessions/${sessionId}/stream-links`, { commandId: randomUUID(), subject: 'show' });
  const url = `/stream?layout=${layout}&audio=off#token=${encodeURIComponent(created.token)}`;
  return { sessionId, hostIdentity, url };
}

async function openStream(context: BrowserContext, url: string) {
  const page = await context.newPage();
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto(url);
  return page;
}

async function startShow(page: Page, sessionId: string) {
  await page.getByTestId('start-session').click();
  await expect.poll(async () => (await api(page, `/sessions/${sessionId}`)).setup.started).toBe(true);
}

const COMIC_INK = 'Bold black-ink comic book art, flat bright colors, heavy outlines, halftone shading';

test('picture settings changed mid-show survive a reload, and Draw the last beat puts the newest beat on the stage', async ({ page, context }) => {
  const { sessionId, hostIdentity, url } = await prepareShow(page, context, 'scene');
  const path = `/sessions/${sessionId}`;
  const stream = await openStream(context, url);
  await expect(stream.locator('.stage')).toBeVisible();
  await startShow(page, sessionId);

  // A listed model that is neither the first choice nor the one beat pictures always use.
  const chosen = PICTURE_MODELS.find(entry => entry.id !== PICTURE_MODELS[0]!.id && entry.id !== MOMENT_MODEL)!;
  expect(chosen).toBeTruthy();

  const director = await context.newPage();
  await director.goto(`/sessions/${sessionId}/director?identity=${hostIdentity}`);
  const settings = director.getByTestId('picture-settings');
  await expect(settings).toBeVisible();
  await settings.locator('summary').click();
  await director.getByRole('button', { name: 'Comic book ink', exact: true }).click();
  await expect(director.getByTestId('picture-style')).toHaveValue(COMIC_INK);
  await director.getByLabel('Picture model').selectOption({ label: chosen.label });
  await expect(director.getByTestId('picture-model-description')).toHaveText(chosen.description);
  const saved = director.waitForResponse(response => response.url().endsWith(`/api${path}/picture-settings`) && response.request().method() === 'POST');
  await director.getByRole('button', { name: 'Save picture settings', exact: true }).click();
  expect((await saved).status()).toBe(200);
  await expect(director.getByTestId('picture-settings-save')).toBeDisabled();

  await director.reload();
  await expect(director.getByTestId('picture-settings')).toBeVisible();
  await director.getByTestId('picture-settings').locator('summary').click();
  await expect(director.getByTestId('picture-style')).toHaveValue(COMIC_INK);
  await expect(director.getByTestId('picture-model')).toHaveValue(chosen.id);
  expect((await api(page, path)).pictureSettings).toEqual({ style: COMIC_INK, model: chosen.id });

  // Before any beat, Draw the last beat is greyed out and says why.
  const drawBeat = director.getByRole('button', { name: 'Draw the last beat', exact: true });
  await expect(drawBeat).toBeDisabled();
  await expect(director.getByTestId('scene-picture-beat-reason')).toHaveText('No beat has been published in this scene yet.');
  expect((await api(page, path)).lastSceneBeatId).toBeNull();

  // Publish one conversation beat through the commands API.
  let state = await api(page, path);
  const command = async (value: Record<string, unknown>, identity?: string) => {
    const result = await api(page, `${path}/commands`, { commandId: randomUUID(), ...value }, identity);
    if (!identity) state = result.snapshot;
    return result.snapshot;
  };
  const beat = (value: Record<string, unknown>) => command({ beatId: state.activeBeat.id, expectedBeatRevision: state.activeBeat.revision, ...value });
  const seat: string = (await api(page, `${path}/test-seat`, { characterId: state.characters[0].id })).identityId;
  await command({ type: 'open_beat', kind: 'conversation', expectedInputEpoch: state.session.inputEpoch });
  const npc = state.npcs.find((item: any) => item.status === 'present');
  const line = 'Nia asks who keeps the lanterns lit.';
  const submitted = await command({ type: 'save_submission', contextBeatId: state.activeBeat.id, expectedInputEpoch: state.session.inputEpoch, expectedSubmissionRevision: 0, kind: 'say', text: line, recipientNpcIds: [npc.id] }, seat);
  await beat({ type: 'plan_beat', submissionIds: [submitted.submissions.find((item: any) => item.text === line).id] });
  await beat({ type: 'approve_stakes', classification: 'ordinary', contracts: [] });
  await beat({ type: 'lock_beat' });
  await beat({ type: 'render_beat' });
  if (state.activeBeat.draft?.continuity?.length) await beat({ type: 'approve_continuity', updates: state.activeBeat.draft.continuity });
  await beat({ type: 'publish_beat', expectedStateRevision: state.session.stateRevision, draftRevision: state.activeBeat.draftRevision, textOnly: true });
  const publishedId: string = state.history.at(-1).id;
  expect((await api(page, path)).lastSceneBeatId).toBe(publishedId);

  await expect(drawBeat).toBeEnabled();
  await expect(director.getByTestId('scene-picture-beat-reason')).toHaveCount(0);
  const drawn = director.waitForResponse(response => response.url().endsWith(`/api${path}/beat-picture`) && response.request().method() === 'POST');
  await drawBeat.click();
  const response = await drawn;
  expect(response.status()).toBe(202);
  const { imageId } = await response.json() as { imageId: string };
  expect(imageId).toBeTruthy();

  const status = (await api(page, path)).scenePictureStatus;
  expect(status.imageId === imageId ? ['making', 'ready'] : ['making']).toContain(status.state);
  if (status.state === 'making') expect(status.drawing).toBe('beat');
  await expect.poll(async () => {
    const next = (await api(page, path)).scenePictureStatus;
    return `${next.state}:${next.imageId}`;
  }, { timeout: 20000 }).toBe(`ready:${imageId}`);
  await expect(stream.locator(`.scene-picture img[src*="${imageId}"]`).first()).toBeVisible({ timeout: 20000 });
  await expect(director.locator('.scene-picture-preview')).toHaveAttribute('src', new RegExp(imageId));
});
