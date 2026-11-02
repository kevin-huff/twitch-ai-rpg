import { expect, test, type Page } from '@playwright/test';

async function api(page: Page, path: string, body?: unknown, identityOverride?: string) {
  const result = await page.evaluate(async ({ path, body, identityOverride }) => {
    const identity = identityOverride ?? new URL(location.href).searchParams.get('identity');
    const response = await fetch(`/api${path}`, { headers: { ...(identity ? { 'X-RPG-Identity': identity } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() };
  }, { path, body, identityOverride });
  expect(result.status, JSON.stringify(result.data)).toBe(200);
  return result.data;
}

async function openFold(page: Page, testId: string) {
  const fold = page.getByTestId(testId);
  if (!(await fold.evaluate(details => (details as HTMLDetailsElement).open))) await fold.locator(':scope > summary').click();
}

const noSideScroll = (page: Page) => expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

test('Who is here and Rest work at phone and desktop width and leave waiting lines alone', async ({ page }) => {
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

  // One published beat gives the correction something to attach to; strain is set through it.
  const character = snapshot.characters[0];
  const seat: string = (await api(page, `${path}/test-seat`, { characterId: character.id })).identityId;
  const mara = snapshot.npcDetails.find((npc: { displayName: string }) => npc.displayName === 'Mara Vale');
  expect(mara).toBeTruthy();
  await command({ type: 'open_beat', kind: 'conversation', expectedInputEpoch: snapshot.session.inputEpoch });
  const first = (await command({ type: 'save_submission', contextBeatId: snapshot.activeBeat.id, expectedInputEpoch: snapshot.session.inputEpoch, expectedSubmissionRevision: 0, kind: 'say', text: 'Who keeps the lanterns lit?', recipientNpcIds: [mara.id], intent: '', approach: '', stageDirection: '', alreadySpokenAloud: true }, seat))
    .submissions.find((input: { text: string }) => input.text === 'Who keeps the lanterns lit?');
  await beatCommand({ type: 'plan_beat', submissionIds: [first.id] });
  await beatCommand({ type: 'approve_stakes', classification: 'ordinary', contracts: [] });
  await beatCommand({ type: 'lock_beat' });
  await beatCommand({ type: 'render_beat' });
  await beatCommand({ type: 'publish_beat', expectedStateRevision: snapshot.session.stateRevision, draftRevision: snapshot.activeBeat.draftRevision, textOnly: true });
  const publishedBeatId: string = snapshot.history[0].id;

  // A line that waits in the queue between rounds, which neither panel may touch.
  const waitingText = 'A line that waits for the next turn.';
  await command({ type: 'save_submission', contextBeatId: null, expectedInputEpoch: snapshot.session.inputEpoch, expectedSubmissionRevision: 0, kind: 'say', text: waitingText, recipientNpcIds: [mara.id], intent: '', approach: '', stageDirection: '', alreadySpokenAloud: true }, seat);
  const waitingStatus = async () => (await api(page, path)).submissions.find((input: { text: string }) => input.text === waitingText)?.status;
  expect(await waitingStatus()).toBe('queued');

  const giveStrain = async (value: number) => {
    snapshot = await api(page, path);
    await command({ type: 'record_correction', expectedStateRevision: snapshot.session.stateRevision, discardQueuedInput: false, reason: 'Give strain for the browser check.', publishedBeatId, publicText: 'The party looks worn out.', changes: [{ kind: 'strain_set', characterId: character.id, value }] });
    expect((await api(page, path)).characters.find((item: { id: string }) => item.id === character.id).strain).toBe(value);
  };

  for (const [width, height, herePresent] of [[390, 844, false], [1280, 900, true]] as const) {
    await giveStrain(2);
    await page.setViewportSize({ width, height });
    await page.reload();
    await openFold(page, 'show-tools');
    await noSideScroll(page);

    // Who is here: send Mara offstage, then (at desktop width) bring her back.
    const cast = page.getByTestId('cast-presence');
    await cast.locator(':scope > summary').click();
    await noSideScroll(page);
    await cast.getByTestId('begin-cast').click();
    if (herePresent) await expect(cast.getByTestId(`here-${mara.id}`)).not.toBeChecked();
    else await expect(cast.getByTestId(`here-${mara.id}`)).toBeChecked();
    await cast.getByTestId(`here-${mara.id}`).setChecked(herePresent);
    await noSideScroll(page);
    const castRevision = (await api(page, path)).session.stateRevision;
    await cast.getByTestId('save-cast').click();
    await expect(cast.getByRole('status')).toHaveText('Saved who is here.');
    await expect.poll(async () => (await api(page, path)).session.stateRevision).toBe(castRevision + 1);
    if (herePresent) await expect(cast.getByTestId('cast-here-now')).toContainText('Mara Vale');
    else await expect(cast.getByTestId('cast-here-now')).not.toContainText('Mara Vale');
    expect(await waitingStatus()).toBe('queued');

    // Rest: strain goes to 0 in one press, after a confirmation.
    const rest = page.getByTestId('rest-controls');
    await rest.locator(':scope > summary').click();
    await expect(rest.getByTestId(`rest-row-${character.id}`)).toContainText('2 of');
    await noSideScroll(page);
    await rest.getByTestId('save-rest').click();
    await expect(rest.getByTestId('rest-confirmation')).toContainText('Rest everyone? Every character\'s strain goes back to 0.');
    await noSideScroll(page);
    await rest.getByTestId('rest-confirm').click();
    await expect(rest.getByTestId('rest-saved')).toHaveText('Rest saved. Strain went down.');
    await expect(rest.getByTestId(`rest-none-${character.id}`)).toBeVisible();
    await expect(rest.getByTestId('rest-nobody')).toBeVisible();
    await noSideScroll(page);
    snapshot = await api(page, path);
    expect(snapshot.characters.every((item: { strain: number }) => item.strain === 0)).toBe(true);
    expect(await waitingStatus()).toBe('queued');
  }
});
