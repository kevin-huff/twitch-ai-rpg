import { randomUUID } from 'node:crypto';
import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';

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

function track(id: string, label: string, current: number) {
  return { id, label, kind: 'progress', current, max: 4, visibility: 'public', trigger: null, enabled: true, completionText: '', completionEffects: [] };
}

// Signs in as host, builds a custom show from two saved cards with the given tracks and facts, and
// opens the show's main link in the given layout before the show starts. Returns the director page, the session id
// and the link address; the show has not started yet.
async function prepareShow(page: Page, context: BrowserContext, layout: 'scene' | 'overlay', extra: { tracks?: unknown[]; facts?: unknown[] }) {
  await page.goto('/');
  await page.getByLabel('Host access token').fill('browser-test-host-credential-not-for-deployment');
  await page.getByRole('button', { name: 'Sign in as host' }).click();
  await expect(page.getByTestId('library-link')).toBeVisible();
  const starter = await api(page, '/library/starter');
  const scenario = await api(page, '/library/scenarios', {
    commandId: randomUUID(), expectedVersion: 0,
    definition: {
      ...starter.scenario, title: `Picture show ${Date.now()}`, boundaries: ['No graphic injury'],
      openingScene: { ...starter.scenario.openingScene, title: 'The Lantern Dock' },
      tracks: extra.tracks ?? [], facts: extra.facts ?? [],
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
  await page.waitForURL(/\/sessions\/[^/]+\/lobby/);
  const sessionId = new URL(page.url()).pathname.split('/')[2]!;
  const hostIdentity = new URL(page.url()).searchParams.get('identity');
  const snapshot = await api(page, `/sessions/${sessionId}`);
  expect(snapshot.characterDetails.every((character: any) => character.approved && !character.draft)).toBe(true);
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
  await page.waitForURL(/\/sessions\/[^/]+\/director/);
  await expect.poll(async () => (await api(page, `/sessions/${sessionId}`)).setup.started).toBe(true);
}

test('the stream reveals each new scene picture full-frame, shrinks it into a panel, and follows Hide picture and Show picture', async ({ page, context }) => {
  const { sessionId, hostIdentity, url } = await prepareShow(page, context, 'scene', {});
  const stream = await openStream(context, url);
  await expect(stream.locator('.stage')).toBeVisible();
  await expect(stream.locator('.scene-picture')).toHaveCount(0);

  await startShow(page, sessionId);
  const revealing = stream.locator('.scene-picture.revealing');
  await expect(revealing).toBeVisible({ timeout: 15000 });
  await expect(revealing.locator('img')).toHaveAttribute('alt', 'The Lantern Dock');
  await expect(stream.locator('.scene-reveal-titles .reveal-show')).toHaveText('Friday at the Dock');
  await expect(stream.locator('.scene-reveal-titles .reveal-scene')).toHaveText('The Lantern Dock');
  const cover = await revealing.boundingBox();
  expect(cover!.width).toBeGreaterThan(1900);

  const panel = stream.locator('.scene-picture:not(.revealing)');
  await expect(panel).toBeVisible({ timeout: 15000 });
  await expect(stream.locator('.scene-reveal-titles')).toHaveCount(0);
  await expect(stream.locator('.rail')).toHaveClass(/with-picture/);
  await expect.poll(async () => (await panel.boundingBox())?.width ?? 0).toBeLessThan(500);
  const small = await panel.boundingBox();
  expect(small!.x).toBeGreaterThan(1300);
  expect(await panel.locator('img').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBeGreaterThan(0);

  // The director's panel shows the picture; Draw the place shows the making state, keeps the old picture, then replaces it.
  const director = await context.newPage();
  await director.goto(`/sessions/${sessionId}/director${hostIdentity ? `?identity=${hostIdentity}` : ''}`);
  await expect(director.locator('.scene-picture-preview')).toBeVisible();
  await expect(director.getByText('This picture is on the stream and the player seats.', { exact: true })).toBeVisible();
  const firstSrc = await director.locator('.scene-picture-preview').getAttribute('src');
  await director.getByTestId('scene-picture-new').click();
  await expect(director.getByText('Making the picture...', { exact: true })).toBeVisible();
  await expect(director.locator('.scene-picture-preview')).toBeVisible();
  await expect(director.getByText('This picture is on the stream and the player seats.', { exact: true })).toBeVisible({ timeout: 15000 });
  await expect.poll(() => director.locator('.scene-picture-preview').getAttribute('src')).not.toBe(firstSrc);
  await expect(stream.locator('.scene-picture.revealing')).toBeVisible({ timeout: 15000 });
  await expect(stream.locator('.scene-picture:not(.revealing)')).toBeVisible({ timeout: 15000 });

  await director.getByTestId('scene-picture-hide').click();
  await expect(stream.locator('.scene-picture')).toHaveCount(0, { timeout: 15000 });
  await expect(director.getByText(/This picture is hidden\./)).toBeVisible();
  await director.getByTestId('scene-picture-show').click();
  await expect(stream.locator('.scene-picture')).toBeVisible({ timeout: 15000 });
  await expect(director.getByText('This picture is on the stream and the player seats.', { exact: true })).toBeVisible();
  // A picture that was already seen comes back as a plain panel, with no second full-frame reveal.
  await expect(stream.locator('.scene-picture.revealing')).toHaveCount(0);
});

const FACTS = ['The door is locked.', 'A lamp hums below.', 'Mara owes a debt.'];
const TRACKS = [track('t-trust', 'Trust', 1), track('t-heat', 'Heat', 2), track('t-time', 'Time left', 3)];

async function startWithPicture(page: Page, context: BrowserContext, layout: 'scene' | 'overlay') {
  const { sessionId, url } = await prepareShow(page, context, layout, {
    tracks: TRACKS,
    facts: FACTS.map((text, index) => ({ id: `f-${index}`, text, visibility: 'public' })),
  });
  const stream = await openStream(context, url);
  await expect(stream.locator('.stage')).toBeVisible();
  await startShow(page, sessionId);
  await expect.poll(async () => (await api(page, `/sessions/${sessionId}`)).scenePictureStatus?.state, { timeout: 20000 }).toBe('ready');
  return stream;
}

test('with a picture on three public meters, each meter takes one row and at least two facts stay inside the rail', async ({ page, context }) => {
  const stream = await startWithPicture(page, context, 'scene');
  await expect(stream.locator('.scene-picture')).toBeVisible({ timeout: 15000 });
  await expect(stream.locator('.rail')).toHaveClass(/with-picture/);
  await expect(stream.locator('.meter-compact')).toHaveCount(3);
  await expect(stream.locator('.scene-picture:not(.revealing)')).toBeVisible({ timeout: 15000 });
  await expect(stream.locator('.fact')).toHaveCount(3);
  const rows = await stream.locator('.meter-compact').evaluateAll(items => items.map(item => {
    const rect = item.getBoundingClientRect();
    return { height: rect.height, fontSize: parseFloat(getComputedStyle(item.querySelector('.meter-label')!).fontSize) };
  }));
  for (const row of rows) {
    expect(row.height).toBeLessThanOrEqual(32);
    expect(row.fontSize).toBeGreaterThanOrEqual(24);
  }
  const geometry = await stream.evaluate(() => {
    const rail = document.querySelector('.rail')!.getBoundingClientRect();
    const facts = Array.from(document.querySelectorAll('.fact')).map(fact => {
      const rect = fact.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && rect.left >= rail.left - 1 && rect.right <= rail.right + 1 && rect.top >= rail.top - 1 && rect.bottom <= rail.bottom + 1;
    });
    return { rail: [rail.left, rail.top, rail.width, rail.height], facts };
  });
  expect(geometry.rail).toEqual([1360, 455, 464, 345]);
  expect(geometry.facts.filter(Boolean).length).toBeGreaterThanOrEqual(2);
});

test('on the transparent overlay the corner picture stays clear of the camera box', async ({ page, context }) => {
  const stream = await startWithPicture(page, context, 'overlay');
  const corner: Locator = stream.locator('.scene-corner');
  await expect(corner).toBeVisible({ timeout: 15000 });
  await expect(corner).toHaveJSProperty('complete', true);
  const box = await corner.boundingBox();
  expect(box).not.toBeNull();
  const { x, y, width, height } = box!;
  // The camera box is x 480-1440, y 200-760 of the 1920x1080 frame.
  const clear = x + width <= 480 || x >= 1440 || y + height <= 200 || y >= 760;
  expect(clear, JSON.stringify(box)).toBe(true);
  await expect(stream.locator('.scene-picture')).toHaveCount(0);
});

test('an action round\'s picture stays off the stream until the round is published, then gets the full reveal', async ({ page, context }) => {
  const { sessionId, hostIdentity, url } = await prepareShow(page, context, 'scene', {});
  const path = `/sessions/${sessionId}`;
  const stream = await openStream(context, url);
  await expect(stream.locator('.stage')).toBeVisible();
  await startShow(page, sessionId);
  await expect.poll(async () => (await api(page, path)).scenePictureStatus?.state, { timeout: 20000 }).toBe('ready');
  await expect(stream.locator('.scene-picture.revealing')).toBeVisible({ timeout: 15000 });
  await expect(stream.locator('.scene-reveal-titles')).toHaveCount(0, { timeout: 15000 });

  let state = await api(page, path);
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

  // The round's picture is made while the script waits for review, and nothing on the stream shows it yet.
  await expect.poll(async () => (await api(page, path)).actionPicture?.state, { timeout: 20000 }).toBe('ready');
  state = await api(page, path);
  const actionId: string = state.actionPicture.imageId;
  expect(actionId).toBeTruthy();

  const director = await context.newPage();
  await director.goto(`/sessions/${sessionId}/director${hostIdentity ? `?identity=${hostIdentity}` : ''}`);
  await expect(director.getByTestId('action-picture-status')).toHaveText('The picture for this action round is ready. Viewers and players see it when you publish the round.');
  await expect(director.getByTestId('action-picture-preview')).toBeVisible();
  await expect(director.getByTestId('action-picture-preview')).toHaveAttribute('src', new RegExp(actionId));
  await expect(stream.locator(`img[src*="${actionId}"]`)).toHaveCount(0);
  await stream.waitForTimeout(2000);
  await expect(stream.locator(`img[src*="${actionId}"]`)).toHaveCount(0);

  if (state.activeBeat.draft?.continuity?.length) await beat({ type: 'approve_continuity', updates: state.activeBeat.draft.continuity });
  await beat({ type: 'publish_beat', expectedStateRevision: state.session.stateRevision, draftRevision: state.activeBeat.draftRevision, textOnly: true });

  const revealing = stream.locator('.scene-picture.revealing');
  await expect(revealing).toBeVisible({ timeout: 15000 });
  await expect(revealing.locator('img')).toHaveAttribute('src', new RegExp(actionId));
  await expect(stream.locator('.scene-reveal-titles .reveal-scene')).toHaveText('The Lantern Dock');
  await expect(stream.locator('.scene-picture:not(.revealing)')).toBeVisible({ timeout: 8000 });
  await expect(stream.locator('.scene-reveal-titles')).toHaveCount(0);
  await expect(stream.locator('.scene-picture img')).toHaveAttribute('src', new RegExp(actionId));
  await expect(director.getByTestId('action-picture')).toHaveCount(0);
});
