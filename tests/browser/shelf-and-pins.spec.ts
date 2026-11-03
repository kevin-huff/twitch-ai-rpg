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

async function prepareShow(page: Page) {
  await page.goto('/');
  await page.getByLabel('Host access token').fill('browser-test-host-credential-not-for-deployment');
  await page.getByRole('button', { name: 'Sign in as host' }).click();
  await expect(page.getByTestId('library-link')).toBeVisible();
  const starter = await api(page, '/library/starter');
  const scenario = await api(page, '/library/scenarios', {
    commandId: randomUUID(), expectedVersion: 0,
    definition: { ...starter.scenario, title: `Shelf show ${Date.now()}`, boundaries: ['No graphic injury'], openingScene: { ...starter.scenario.openingScene, title: 'The Lantern Dock' }, tracks: [], facts: [] },
  });
  const cards: Array<{ id: string; version: number }> = [];
  for (const name of ['Nia', 'Oren']) {
    const index = cards.length;
    cards.push(await api(page, '/library/characters', { commandId: randomUUID(), expectedVersion: 0, definition: { ...starter.characters[index], displayName: name, appearance: `${name} wears a flight suit.` } }));
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
  const scene = await api(page, `/sessions/${sessionId}/stream-links`, { commandId: randomUUID(), subject: 'show' });
  const overlay = await api(page, `/sessions/${sessionId}/stream-links`, { commandId: randomUUID(), subject: 'show' });
  return {
    sessionId, hostIdentity,
    sceneUrl: `/stream?layout=scene&audio=off#token=${encodeURIComponent(scene.token)}`,
    overlayUrl: `/stream?layout=overlay&audio=off#token=${encodeURIComponent(overlay.token)}`,
  };
}

async function openStream(context: BrowserContext, url: string) {
  const page = await context.newPage();
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto(url);
  return page;
}

const noSideScroll = (page: Page) => expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

test('shelf and pins: pin, release, draw again and hide, end to end on stream, overlay, seat and director', async ({ page, context }) => {
  test.setTimeout(240000);
  const { sessionId, hostIdentity, sceneUrl, overlayUrl } = await prepareShow(page);
  const path = `/sessions/${sessionId}`;
  const stream = await openStream(context, sceneUrl);
  const overlay = await openStream(context, overlayUrl);
  await expect(stream.locator('.stage')).toBeVisible();
  await page.getByTestId('start-session').click();
  await page.waitForURL(/\/sessions\/[^/]+\/director/);
  await expect.poll(async () => (await api(page, path)).scenePictureStatus?.state, { timeout: 20000 }).toBe('ready');
  await expect(stream.locator('.scene-picture:not(.revealing)')).toBeVisible({ timeout: 20000 });
  await expect(stream.locator('.scene-reveal-titles')).toHaveCount(0, { timeout: 15000 });

  let state = await api(page, path);
  const placeId: string = state.scenePicture.imageId;
  expect(state.scenePicture.kind).toBe('place');
  const command = async (value: Record<string, unknown>, identity?: string) => {
    const result = await api(page, `${path}/commands`, { commandId: randomUUID(), ...value }, identity);
    if (!identity) state = result.snapshot;
    return result.snapshot;
  };
  const beat = (value: Record<string, unknown>) => command({ beatId: state.activeBeat.id, expectedBeatRevision: state.activeBeat.revision, ...value });
  const seats: string[] = [];
  for (const character of state.characters) seats.push((await api(page, `${path}/test-seat`, { characterId: character.id })).identityId);

  async function conversationBeat(text: string) {
    await command({ type: 'open_beat', kind: 'conversation', expectedInputEpoch: state.session.inputEpoch });
    await command({ type: 'save_submission', contextBeatId: state.activeBeat.id, expectedInputEpoch: state.session.inputEpoch, expectedSubmissionRevision: 0, kind: 'say', text, recipientNpcIds: [], intent: '', approach: '', stageDirection: '', alreadySpokenAloud: true }, seats[0]);
    state = await api(page, path);
    await beat({ type: 'plan_beat', submissionIds: state.submissions.filter((item: any) => item.status === 'queued').map((item: any) => item.id) });
    await beat({ type: 'approve_stakes', classification: 'ordinary', contracts: [] });
    await beat({ type: 'lock_beat' });
    await beat({ type: 'render_beat' });
    await expect.poll(async () => (await api(page, path)).actionPicture?.state, { timeout: 20000 }).toBe('ready');
    state = await api(page, path);
    const heldId: string = state.actionPicture.imageId;
    if (state.activeBeat.draft?.continuity?.length) await beat({ type: 'approve_continuity', updates: state.activeBeat.draft.continuity });
    await beat({ type: 'publish_beat', expectedStateRevision: state.session.stateRevision, draftRevision: state.activeBeat.draftRevision, textOnly: true });
    return heldId;
  }

  // 347 + 349: a conversation beat's held picture is shown at publish and swaps in quietly.
  await recordReveals(stream);
  const beat1 = await conversationBeat('Who keeps the lanterns lit?');
  await expect(stream.locator('.scene-picture img')).toHaveAttribute('src', new RegExp(beat1), { timeout: 15000 });
  await stream.waitForTimeout(1500);
  expect(await revealsSeen(stream)).toEqual([]);
  expect((await api(page, path)).scenePicture).toMatchObject({ imageId: beat1, kind: 'beat' });

  // The seat heading follows the scene picture.
  const seat = await context.newPage();
  await seat.goto(`${path}/play?identity=${seats[1]}`);
  await expect(seat.locator('.seat-scene-picture')).toHaveAttribute('src', new RegExp(beat1), { timeout: 15000 });

  // 350 + 351: the shelf lists the pictures, with labels and tags.
  const director = await context.newPage();
  await director.goto(`${path}/director${hostIdentity ? `?identity=${hostIdentity}` : ''}`);
  const shelf = director.getByTestId('picture-shelf');
  await shelf.locator(':scope > summary').click();
  await expect(shelf.getByTestId(`shelf-picture-${beat1}`)).toBeVisible({ timeout: 15000 });
  await expect(shelf.getByTestId(`shelf-picture-${beat1}`)).toContainText('Beat 1');
  await expect(shelf.getByTestId(`shelf-picture-${beat1}`).getByTestId('shelf-tag-stream')).toBeVisible();
  await expect(shelf.getByTestId(`shelf-picture-${placeId}`)).toContainText('The place');
  const list = await api(director, `${path}/pictures`);

  // 352-355: pin the place picture from the shelf. Stream, overlay and seat switch to it with no reveal.
  await recordReveals(stream);
  await shelf.getByTestId(`shelf-pin-${placeId}`).click();
  await expect(director.getByTestId('pinned-line')).toContainText('Pinned: The place', { timeout: 15000 });
  await expect(stream.locator('.scene-picture img')).toHaveAttribute('src', new RegExp(placeId), { timeout: 15000 });
  await expect(overlay.locator('.scene-corner')).toHaveAttribute('src', new RegExp(placeId), { timeout: 15000 });
  await expect(seat.locator('.seat-scene-picture')).toHaveAttribute('src', new RegExp(placeId), { timeout: 15000 });
  await expect(shelf.getByTestId(`shelf-picture-${placeId}`).getByTestId('shelf-tag-pinned')).toBeVisible({ timeout: 15000 });
  await expect(director.getByTestId('scene-picture-status')).toHaveText('Your pinned picture is on the stream and the player seats instead. Press Release to show this one.');

  // The pin stays while a new beat's picture finishes and is published.
  const beat2 = await conversationBeat('And who pays the lamplighter?');
  await expect.poll(async () => (await api(page, path)).scenePicture?.imageId, { timeout: 15000 }).toBe(beat2);
  await stream.waitForTimeout(2500);
  await expect(stream.locator('.scene-picture img')).toHaveAttribute('src', new RegExp(placeId));
  await expect(overlay.locator('.scene-corner')).toHaveAttribute('src', new RegExp(placeId));
  await expect(seat.locator('.seat-scene-picture')).toHaveAttribute('src', new RegExp(placeId));
  expect(await revealsSeen(stream)).toEqual([]);
  // The open shelf picks up beat 2's picture by itself, thumbnail included, with no reload.
  await expect(shelf.getByTestId(`shelf-picture-${beat2}`).locator('img.shelf-thumb')).toBeVisible({ timeout: 15000 });
  await expect(shelf.getByTestId(`shelf-picture-${beat2}`)).toContainText('Beat 2');

  // A scene change keeps the pin too.
  // (Draw again first, on beat 1, which is an older beat.)
  await shelf.getByTestId(`shelf-redraw-${beat1}`).click();
  await expect(shelf.getByTestId('shelf-notice')).toHaveText('Drawing again. The new picture goes on the shelf.');
  await expect.poll(async () => (await api(director, `${path}/pictures`)).pictures.filter((p: any) => p.shelfOnly && p.status === 'ready').length, { timeout: 20000 }).toBe(1);
  const redrawn = (await api(director, `${path}/pictures`)).pictures.find((p: any) => p.shelfOnly);
  expect((await api(page, path)).scenePicture?.imageId).toBe(beat2);
  await expect(shelf.getByTestId(`shelf-picture-${redrawn.imageId}`).locator('img.shelf-thumb')).toBeVisible({ timeout: 15000 });

  // Release: the newest scene picture comes back with no reveal.
  await recordReveals(stream);
  await director.getByTestId('release-pinned').click();
  await expect(director.getByTestId('pinned-line')).toHaveCount(0, { timeout: 15000 });
  await expect(stream.locator('.scene-picture img')).toHaveAttribute('src', new RegExp(beat2), { timeout: 15000 });
  await expect(overlay.locator('.scene-corner')).toHaveAttribute('src', new RegExp(beat2), { timeout: 15000 });
  await expect(seat.locator('.seat-scene-picture')).toHaveAttribute('src', new RegExp(beat2), { timeout: 15000 });
  await stream.waitForTimeout(1500);
  expect(await revealsSeen(stream)).toEqual([]);
  // The redraw never took the stream by itself.
  expect((await api(page, path)).scenePicture?.imageId).toBe(beat2);

  // A portrait pinned shows whole on stream, overlay and seat.
  const readyPortrait = async () => (await api(director, `${path}/pictures`)).pictures.find((p: any) => p.kind === 'portrait' && p.status === 'ready');
  await expect.poll(async () => Boolean(await readyPortrait()), { timeout: 20000 }).toBe(true);
  const portrait = await readyPortrait();
  {
    await shelf.getByTestId(`shelf-pin-${portrait.imageId}`).click();
    await expect(director.getByTestId('pinned-line')).toContainText(`Pinned: ${portrait.label}`, { timeout: 15000 });
    await expect(stream.locator('.scene-picture.fit-whole img')).toHaveAttribute('src', new RegExp(portrait.imageId), { timeout: 15000 });
    await expect(overlay.locator('.scene-corner.fit-whole')).toHaveAttribute('src', new RegExp(portrait.imageId), { timeout: 15000 });
    await expect(seat.locator('.seat-scene-picture.fit-whole')).toHaveAttribute('src', new RegExp(portrait.imageId), { timeout: 15000 });
    expect(await stream.locator('.scene-picture img').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBeGreaterThan(0);
    expect(await seat.locator('.seat-scene-picture').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBeGreaterThan(0);
  }

  // Pin survives a scene change, and the new place's picture does not reveal behind it.
  await recordReveals(stream);
  await command({ type: 'change_scene', expectedStateRevision: state.session.stateRevision, title: 'The Signal Tower', description: 'A narrow stair climbs to a lamp room.', location: { kind: 'new', title: 'The Signal Tower', description: '' }, presentNpcIds: [], reason: 'Move on.' });
  await expect.poll(async () => (await api(page, path)).pinnedPicture?.imageId ?? null, { timeout: 15000 }).toBe(portrait.imageId);

  // Hide releases the pin.
  {
    await expect.poll(async () => (await api(page, path)).scenePictureStatus?.state, { timeout: 20000 }).toBe('ready');
    await stream.waitForTimeout(1500);
    await expect(stream.locator('.scene-picture img')).toHaveAttribute('src', new RegExp(portrait.imageId));
    expect(await revealsSeen(stream)).toEqual([]);
    await director.getByTestId('scene-picture-hide').click();
    await expect(director.getByTestId('pinned-line')).toHaveCount(0, { timeout: 15000 });
    await expect(stream.locator('.scene-picture')).toHaveCount(0, { timeout: 15000 });
    await expect(seat.locator('.seat-scene-picture')).toHaveCount(0, { timeout: 15000 });
  }

  // The shelf keeps to the phone width.
  await director.setViewportSize({ width: 390, height: 844 });
  await director.reload();
  await director.getByTestId('picture-shelf').locator(':scope > summary').click();
  await expect(director.getByTestId('shelf-group-scenes')).toBeVisible({ timeout: 15000 });
  await noSideScroll(director);
});

test('Send both from a real seat sends a Say line and a Do line', async ({ page, context }) => {
  const { sessionId } = await prepareShow(page);
  const path = `/sessions/${sessionId}`;
  await page.getByTestId('start-session').click();
  await page.waitForURL(/\/sessions\/[^/]+\/director/);
  let state = await api(page, path);
  const seatIdentity: string = (await api(page, `${path}/test-seat`, { characterId: state.characters[0].id })).identityId;
  const seat = await context.newPage();
  await seat.setViewportSize({ width: 390, height: 844 });
  await seat.goto(`${path}/play?identity=${seatIdentity}`);
  await seat.getByRole('button', { name: 'Say something', exact: true }).click();
  await seat.getByTestId('speech-input').fill('Hold the lantern steady.');
  await seat.getByRole('button', { name: 'Do something', exact: true }).click();
  await seat.getByTestId('action-input').fill('I climb onto the crates to look over the wall.');
  await expect(seat.locator('button.send')).toHaveText('Send both');
  await seat.locator('button.send').click();
  await expect(seat.getByRole('status').filter({ hasText: 'Saved.' })).toHaveText(/Saved\. (The director has both lines\.|Both lines wait for the next turn\.)/, { timeout: 15000 });
  state = await api(page, path);
  const mine = state.submissions.filter((item: any) => item.status === 'queued');
  expect(mine.map((item: any) => item.kind).sort()).toEqual(['act', 'say']);
  await expect(seat.getByTestId('speech-input').or(seat.getByTestId('action-input'))).toHaveValue('');
  await noSideScroll(seat);
});
