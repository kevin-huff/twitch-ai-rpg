import { expect, test, type Page } from '@playwright/test';

async function rawApi(page: Page, path: string, body?: unknown, identityOverride?: string) {
  return page.evaluate(async ({ path, body, identityOverride }) => {
    const identity = identityOverride ?? new URL(location.href).searchParams.get('identity');
    const response = await fetch(`/api${path}`, { headers: { ...(identity ? { 'X-RPG-Identity': identity } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() };
  }, { path, body, identityOverride });
}

async function api(page: Page, path: string, body?: unknown, identityOverride?: string) {
  const result = await rawApi(page, path, body, identityOverride);
  expect(result.status, JSON.stringify(result.data)).toBe(200);
  return result.data;
}

const noSideScroll = (page: Page) => expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

test.setTimeout(240000);

test('a downed seat, the party piece, the director chip, a dead seat and Bring back all work', async ({ page, browser }) => {
  await page.goto('/');
  await page.getByLabel('Host access token').fill('browser-test-host-credential-not-for-deployment');
  await page.getByRole('button', { name: 'Sign in as host' }).click();
  await page.getByRole('button', { name: 'Try it now' }).click();
  await expect(page.getByTestId('director-controls')).toBeVisible();
  const sessionId = new URL(page.url()).pathname.split('/')[2]!;
  const path = `/sessions/${sessionId}`;
  let snapshot = await api(page, path);
  const command = async (value: Record<string, unknown>, identity?: string) => {
    const result = await api(page, `${path}/commands`, { commandId: crypto.randomUUID(), ...value }, identity);
    if (!identity) snapshot = result.snapshot;
    return result.snapshot;
  };
  const beatCommand = (value: Record<string, unknown>) => command({ beatId: snapshot.activeBeat.id, expectedBeatRevision: snapshot.activeBeat.revision, ...value });
  await command({ type: 'set_status', status: 'live', expectedStateRevision: snapshot.session.stateRevision });

  const character = snapshot.characters[0];
  const name: string = character.displayName;
  const seatIdentity: string = (await api(page, `${path}/test-seat`, { characterId: character.id })).identityId;
  const mara = snapshot.npcDetails.find((npc: { displayName: string }) => npc.displayName === 'Mara Vale');
  expect(mara).toBeTruthy();
  const created = await api(page, `${path}/stream-links`, { commandId: crypto.randomUUID(), subject: 'show' });
  const hash = `#token=${encodeURIComponent(created.token)}`;

  // One published text-only beat gives corrections something to attach to.
  await command({ type: 'open_beat', kind: 'conversation', expectedInputEpoch: snapshot.session.inputEpoch });
  const first = (await command({ type: 'save_submission', contextBeatId: snapshot.activeBeat.id, expectedInputEpoch: snapshot.session.inputEpoch, expectedSubmissionRevision: 0, kind: 'say', text: 'Who keeps the lanterns lit?', recipientNpcIds: [mara.id], intent: '', approach: '', stageDirection: '', alreadySpokenAloud: true }, seatIdentity))
    .submissions.find((input: { text: string }) => input.text === 'Who keeps the lanterns lit?');
  await beatCommand({ type: 'plan_beat', submissionIds: [first.id] });
  await beatCommand({ type: 'approve_stakes', classification: 'ordinary', contracts: [] });
  await beatCommand({ type: 'lock_beat' });
  await beatCommand({ type: 'render_beat' });
  await beatCommand({ type: 'publish_beat', expectedStateRevision: snapshot.session.stateRevision, draftRevision: snapshot.activeBeat.draftRevision, textOnly: true });
  const publishedBeatId: string = snapshot.history[0].id;

  const setCondition = async (condition: 'up' | 'down' | 'dead') => {
    snapshot = await api(page, path);
    await command({ type: 'record_correction', expectedStateRevision: snapshot.session.stateRevision, discardQueuedInput: false, reason: 'Set a condition for the browser check.', publishedBeatId, publicText: `The story marks ${name} as ${condition}.`, changes: [{ kind: 'condition_set', characterId: character.id, condition }] });
  };
  const conditionOf = async () => (await api(page, path)).characters.find((item: { id: string }) => item.id === character.id).condition;

  // 1. A downed seat at phone width.
  await setCondition('down');
  expect(await conditionOf()).toBe('down');
  const seat = await page.context().newPage();
  await seat.setViewportSize({ width: 390, height: 844 });
  await seat.goto(`${path}/play?identity=${seatIdentity}`);
  await expect(seat.getByTestId('seat-condition')).toHaveText('Down');
  await expect(seat.getByTestId('seat-down-note')).toHaveText(`${name} is down. You can say a few words, up to 8. Someone can still save ${name} until the end of the next round.`);
  await expect(seat.getByTestId('seat-dead-note')).toHaveCount(0);
  await expect(seat.getByRole('button', { name: 'Do something', exact: true })).toHaveCount(0);
  await seat.getByRole('button', { name: 'Say something', exact: true }).click();
  await expect(seat.getByTestId('seat-word-count')).toHaveText('0 of 8 words');
  await seat.getByTestId('speech-input').fill('one two three');
  await expect(seat.getByTestId('seat-word-count')).toHaveText('3 of 8 words');
  await noSideScroll(seat);

  snapshot = await api(page, path);
  const sayLine = (text: string) => rawApi(page, `${path}/commands`, { commandId: crypto.randomUUID(), type: 'save_submission', contextBeatId: null, expectedInputEpoch: snapshot.session.inputEpoch, expectedSubmissionRevision: 0, kind: 'say', text, recipientNpcIds: [mara.id], intent: '', approach: '', stageDirection: '', alreadySpokenAloud: true }, seatIdentity);
  const accepted = await sayLine('one two three four five six seven eight');
  expect(accepted.status, JSON.stringify(accepted.data)).toBe(200);
  const refused = await sayLine('one two three four five six seven eight nine');
  expect(refused.status).toBe(400);
  expect(JSON.stringify(refused.data)).toContain(`${name} is down, so they can say only a few words, up to 8. This line has 9.`);

  // 2. The party piece says Down and keeps its fixed size.
  const stream = await browser.newContext({ viewport: { width: 1344, height: 76 } });
  try {
    const piece = await stream.newPage();
    await piece.goto(`/stream?view=party${hash}`);
    const chip = piece.locator('.cast-chips .chip', { hasText: name });
    await expect(chip).toBeVisible({ timeout: 20000 });
    await expect(chip.locator('.chip-flag')).toHaveText('Down');
    const box = await piece.locator('.cast-chips').evaluate(element => {
      const rect = element.getBoundingClientRect();
      return { right: rect.right, bottom: rect.bottom, viewport: [innerWidth, innerHeight] };
    });
    expect(box.viewport).toEqual([1344, 76]);
    expect(box.right).toBeLessThanOrEqual(1345);
    expect(box.bottom).toBeLessThanOrEqual(77);
    expect(await piece.evaluate(() => document.documentElement.scrollHeight <= innerHeight && document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally { await stream.close(); }

  // 3. The director page lists the rescue window for the downed character.
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.reload();
  const strip = page.getByRole('list', { name: 'Show status' });
  const windowChip = strip.getByTestId(`condition-${character.id}`);
  await expect(windowChip).toBeVisible();
  await expect(windowChip).toContainText(`${name} is down. Someone can save ${name} in the next round.`);
  await expect(windowChip).toContainText('last-chance roll');

  // 4. Dead: the seat says so, has no line boxes, and still shows the story.
  await setCondition('dead');
  expect(await conditionOf()).toBe('dead');
  await seat.reload();
  await expect(seat.getByTestId('seat-condition')).toHaveText('Dead');
  await expect(seat.getByTestId('seat-dead-note')).toHaveText(`${name} has died. You can keep watching the story here.`);
  await expect(seat.getByTestId('seat-down-note')).toHaveCount(0);
  await expect(seat.locator('textarea')).toHaveCount(0);
  await expect(seat.getByRole('button', { name: 'Say something', exact: true })).toHaveCount(0);
  await expect(seat.getByRole('button', { name: 'Do something', exact: true })).toHaveCount(0);
  await expect(seat.getByTestId('seat-story')).toBeVisible();
  await expect(seat.getByTestId('seat-story-beat')).not.toHaveCount(0);
  await noSideScroll(seat);

  // 5. Bring back through the Corrections panel on the director page.
  await page.reload();
  await expect(page.getByTestId('show-tools')).toBeVisible();
  const fold = page.getByTestId('show-tools');
  if (!(await fold.evaluate(details => (details as HTMLDetailsElement).open))) await fold.locator(':scope > summary').click();
  const corrections = page.getByTestId('correction-controls');
  await corrections.locator(':scope > summary').click();
  await corrections.getByTestId('begin-correction').click();
  await corrections.getByTestId('add-correction-condition').click();
  await expect(corrections.getByRole('heading', { name: 'Set a condition' })).toBeVisible();
  await corrections.getByTestId('correction-target-0').selectOption(`character:${character.id}`);
  await corrections.getByTestId('correction-condition-0').selectOption({ label: 'Bring back' });
  await corrections.getByTestId('correction-public-text').fill(`${name} gets up again.`);
  await corrections.getByTestId('correction-reason').fill('Bring the character back for the browser check.');
  await corrections.getByRole('button', { name: 'Publish correction' }).click();
  await expect.poll(conditionOf).toBeUndefined();
  const corrected = (await api(page, path)).corrections.at(-1);
  expect(JSON.stringify(corrected)).toContain(`${name} gets up again.`);

  await seat.reload();
  await expect(seat.getByTestId('seat-condition')).toHaveCount(0);
  await expect(seat.getByTestId('seat-dead-note')).toHaveCount(0);
  await expect(seat.getByRole('button', { name: 'Do something', exact: true })).toBeVisible();
  await noSideScroll(seat);
});
