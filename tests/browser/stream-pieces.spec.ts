import { randomUUID } from 'node:crypto';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

async function api(page: Page, path: string, body?: unknown, identityOverride?: string) {
  const result = await page.evaluate(async ({ path, body, identityOverride }) => {
    const identity = identityOverride ?? new URL(location.href).searchParams.get('identity');
    const response = await fetch(`/api${path}`, {
      headers: { ...(identity ? { 'X-RPG-Identity': identity } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, data: await response.json() };
  }, { path, body, identityOverride });
  expect(result.status, JSON.stringify(result.data).slice(0, 300)).toBe(200);
  return result.data;
}

function track(id: string, label: string, current: number) {
  return { id, label, kind: 'progress', current, max: 4, visibility: 'public', trigger: null, enabled: true, completionText: '', completionEffects: [] };
}

// The nine pieces, with the box each one is cut to and the root element it draws.
const PIECES = [
  { view: 'captions', width: 1440, height: 184, root: '.stage-story' },
  { view: 'dice', width: 1440, height: 144, root: '.dice' },
  { view: 'stakes', width: 960, height: 612, root: '.wager' },
  { view: 'party', width: 1344, height: 76, root: '.cast-chips' },
  { view: 'picture', width: 336, height: 192, root: 'img.scene-corner' },
  { view: 'tracks', width: 352, height: 304, root: '.rail' },
  { view: 'badge', width: 336, height: 164, root: '.top-right' },
  { view: 'facts', width: 464, height: 345, root: 'section.facts' },
  { view: 'corrections', width: 1728, height: 88, root: 'section.correction' },
] as const;

type Piece = (typeof PIECES)[number];

async function openPiece(browser: Browser, piece: Piece, hash: string, extra = '') {
  const context = await browser.newContext({ viewport: { width: piece.width, height: piece.height } });
  const page = await context.newPage();
  await page.goto(`/stream?view=${piece.view}${extra}${hash}`);
  return { context, page };
}

async function expectPieceDrawn(page: Page, piece: Piece) {
  const root = page.locator(piece.root);
  await expect(root).toBeVisible({ timeout: 20000 });
  if (piece.view === 'picture') await expect(root).toHaveJSProperty('complete', true);
  const geometry = await root.evaluate(element => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height, viewport: [innerWidth, innerHeight] };
  });
  const where = `${piece.view}: ${JSON.stringify(geometry)}`;
  expect(geometry.width, where).toBeGreaterThan(0);
  expect(geometry.height, where).toBeGreaterThan(0);
  expect(geometry.left, where).toBeGreaterThanOrEqual(-1);
  expect(geometry.top, where).toBeGreaterThanOrEqual(-1);
  expect(geometry.right, where).toBeLessThanOrEqual(piece.width + 1);
  expect(geometry.bottom, where).toBeLessThanOrEqual(piece.height + 1);
  const backgrounds = await page.evaluate(() => [getComputedStyle(document.documentElement).backgroundColor, getComputedStyle(document.body).backgroundColor]);
  for (const background of backgrounds) expect(background, `${piece.view} background`).toMatch(/^rgba\(\d+, \d+, \d+, 0\)$|^transparent$/);
  await expect(page.locator('button, input, select, textarea, a'), `${piece.view} controls`).toHaveCount(0);
}

test.setTimeout(240000);

test('every piece opens by its own link inside its own box, who= narrows dice and party, an unknown view draws nothing and old layouts still draw', async ({ page, browser }) => {
  // A custom show with two characters, public facts and tracks, so every piece has something to draw.
  await page.goto('/');
  await page.getByLabel('Host access token').fill('browser-test-host-credential-not-for-deployment');
  await page.getByRole('button', { name: 'Sign in as host' }).click();
  await expect(page.getByTestId('library-link')).toBeVisible();
  const starter = await api(page, '/library/starter');
  const scenario = await api(page, '/library/scenarios', {
    commandId: randomUUID(), expectedVersion: 0,
    definition: {
      ...starter.scenario, title: `Pieces show ${Date.now()}`, boundaries: ['No graphic injury'],
      openingScene: { ...starter.scenario.openingScene, title: 'The Lantern Dock' },
      tracks: [track('t-trust', 'Trust', 1), track('t-heat', 'Heat', 2)],
      facts: ['The door is locked.', 'A lamp hums below.'].map((text, index) => ({ id: `f-${index}`, text, visibility: 'public' })),
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
  await page.getByTestId('show-title').fill('Pieces at the Dock');
  await page.getByTestId('show-scenario').selectOption(`${scenario.id}:1`);
  await page.getByTestId('show-seat-0').selectOption(`${cards[0]!.id}:1`);
  await page.getByTestId('show-seat-1').selectOption(`${cards[1]!.id}:1`);
  await page.getByTestId('create-custom').click();
  await page.waitForURL(/\/sessions\/[^/]+\/lobby/);
  const sessionId = new URL(page.url()).pathname.split('/')[2]!;
  const path = `/sessions/${sessionId}`;
  const created = await api(page, `${path}/stream-links`, { commandId: randomUUID(), subject: 'show' });
  const hash = `#token=${encodeURIComponent(created.token)}`;

  await expect(page.getByTestId('start-session')).toBeEnabled();
  await page.getByTestId('start-session').click();
  await page.waitForURL(/\/sessions\/[^/]+\/director/);
  await expect.poll(async () => (await api(page, path)).setup.started).toBe(true);
  await expect.poll(async () => (await api(page, path)).scenePictureStatus?.state, { timeout: 20000 }).toBe('ready');

  let state = await api(page, path);
  const command = async (value: Record<string, unknown>, identity?: string) => {
    const result = await api(page, `${path}/commands`, { commandId: randomUUID(), ...value }, identity);
    if (!identity) state = result.snapshot;
    return result.snapshot;
  };
  const beat = (value: Record<string, unknown>) => command({ beatId: state.activeBeat.id, expectedBeatRevision: state.activeBeat.revision, ...value });
  expect(state.characters).toHaveLength(2);
  const [first, second] = state.characters as Array<{ id: string; displayName: string }>;

  // An action round with both characters: planned, with its stakes approved and up.
  const seats: string[] = [];
  for (const character of state.characters) seats.push((await api(page, `${path}/test-seat`, { characterId: character.id })).identityId);
  await command({ type: 'open_beat', kind: 'action', expectedInputEpoch: state.session.inputEpoch });
  for (let index = 0; index < seats.length; index++) {
    await command({ type: 'save_submission', contextBeatId: state.activeBeat.id, expectedInputEpoch: state.session.inputEpoch, expectedSubmissionRevision: 0, kind: 'act', text: '', intent: `Search the dock ${index}`, approach: 'Careful investigation' }, seats[index]);
  }
  state = await api(page, path);
  await beat({ type: 'plan_beat', submissionIds: state.submissions.filter((item: any) => item.status === 'queued').map((item: any) => item.id) });
  await beat({ type: 'approve_stakes', classification: 'action', contracts: state.activeBeat.contracts });
  expect(state.activeBeat.contracts.length).toBeGreaterThan(0);

  // While the stakes are up, the stakes piece draws them inside its box.
  const stakes = PIECES.find(piece => piece.view === 'stakes')!;
  {
    const { context: viewer, page: stream } = await openPiece(browser, stakes, hash);
    try { await expectPieceDrawn(stream, stakes); } finally { await viewer.close(); }
  }

  // Roll, render and publish the round, then record a correction on it.
  await beat({ type: 'lock_beat' });
  await beat({ type: 'render_beat' });
  await expect.poll(async () => (await api(page, path)).actionPicture?.state, { timeout: 20000 }).toBe('ready');
  state = await api(page, path);
  if (state.activeBeat.draft?.continuity?.length) await beat({ type: 'approve_continuity', updates: state.activeBeat.draft.continuity });
  await beat({ type: 'publish_beat', expectedStateRevision: state.session.stateRevision, draftRevision: state.activeBeat.draftRevision, textOnly: true });
  expect(state.history).toHaveLength(1);
  expect(state.history[0].rolls.length).toBe(2);
  const publishedBeatId: string = state.history[0].id;
  state = await api(page, path);
  const currentStrain: number = state.characters.find((character: any) => character.id === first.id).strain;
  await command({ type: 'record_correction', expectedStateRevision: state.session.stateRevision, discardQueuedInput: false, reason: 'Give a correction for the browser check.', publishedBeatId, publicText: 'The lamp was already lit.', changes: [{ kind: 'strain_set', characterId: first.id, value: currentStrain === 1 ? 2 : 1 }] });
  expect((await api(page, path)).corrections.length).toBeGreaterThan(0);

  // Every other piece, one browser context each, sized to its box.
  const contexts: BrowserContext[] = [];
  try {
    for (const piece of PIECES) {
      if (piece.view === 'stakes') continue;
      const opened = await openPiece(browser, piece, hash);
      contexts.push(opened.context);
      await expectPieceDrawn(opened.page, piece);
      expect(new URL(opened.page.url()).searchParams.get('view')).toBe(piece.view);
    }

    // The stakes piece draws nothing once the stakes are gone.
    {
      const opened = await openPiece(browser, stakes, hash);
      contexts.push(opened.context);
      await expect(opened.page.locator('.stream-view')).toBeVisible();
      await opened.page.waitForTimeout(1500);
      await expect(opened.page.locator('.wager')).toHaveCount(0);
    }

    // who= limits dice to one character's rolls, and party to one chip.
    const dice = PIECES.find(piece => piece.view === 'dice')!;
    const party = PIECES.find(piece => piece.view === 'party')!;
    const all = await openPiece(browser, dice, hash);
    contexts.push(all.context);
    await expect(all.page.locator('.dice .roll')).toHaveCount(2);
    const onlyFirst = await openPiece(browser, dice, hash, `&who=${encodeURIComponent(first.id)}`);
    contexts.push(onlyFirst.context);
    await expect(onlyFirst.page.locator('.dice .roll')).toHaveCount(1);
    await expect(onlyFirst.page.locator('.dice .roll-who')).toHaveText(first.displayName);
    const onlySecond = await openPiece(browser, dice, hash, `&who=${encodeURIComponent(second.id)}`);
    contexts.push(onlySecond.context);
    await expect(onlySecond.page.locator('.dice .roll')).toHaveCount(1);
    await expect(onlySecond.page.locator('.dice .roll-who')).toHaveText(second.displayName);
    const partyAll = await openPiece(browser, party, hash);
    contexts.push(partyAll.context);
    await expect(partyAll.page.locator('.cast-chips .chip')).toHaveCount(2);
    const partyOne = await openPiece(browser, party, hash, `&who=${encodeURIComponent(second.id)}`);
    contexts.push(partyOne.context);
    await expect(partyOne.page.locator('.cast-chips .chip')).toHaveCount(1);
    await expect(partyOne.page.locator('.cast-chips .chip-name')).toHaveText(second.displayName);

    // An unknown view draws nothing and never asks for access.
    const unknownContext = await browser.newContext({ viewport: { width: 800, height: 450 } });
    contexts.push(unknownContext);
    const unknown = await unknownContext.newPage();
    const accessRequests: string[] = [];
    unknown.on('request', request => { if (request.url().includes('/api/stream/access')) accessRequests.push(request.url()); });
    await unknown.goto(`/stream?view=nope${hash}`);
    await expect(unknown.locator('.stream-view')).toHaveAttribute('data-view', 'unknown');
    await unknown.waitForTimeout(2500);
    expect(accessRequests).toEqual([]);
    expect(await unknown.evaluate(() => document.body.innerText.trim())).toBe('');
    await expect(unknown.locator('.stage-story, .dice, .wager, .cast-chips, .scene-corner, .rail, .top-right, .facts, .correction, .overlay, .scene, img, button, input')).toHaveCount(0);

    // The old layout links on the same token draw their layouts as before.
    for (const layout of ['overlay', 'scene'] as const) {
      const old = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
      contexts.push(old);
      const stream = await old.newPage();
      await stream.goto(`/stream?layout=${layout}&audio=off${hash}`);
      await expect(stream.locator(layout === 'overlay' ? '.overlay' : '.scene')).toBeVisible({ timeout: 20000 });
      await expect(stream.locator('.stage-story')).toBeVisible();
      await expect(stream.locator('.stream-view')).toHaveAttribute('data-layout', layout);
    }
  } finally { await Promise.all(contexts.map(item => item.close())); }
});
