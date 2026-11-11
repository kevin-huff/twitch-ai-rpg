import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';

async function api(page: Page, path: string, body?: unknown, identityOverride?: string) {
  const result = await page.evaluate(async ({ path, body, identityOverride }) => {
    const identity = identityOverride ?? new URL(location.href).searchParams.get('identity');
    const response = await fetch(`/api${path}`, { headers: { ...(identity ? { 'X-RPG-Identity': identity } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() };
  }, { path, body, identityOverride });
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

// Stakes are on the page, a late line arrives ticked, the director plans again and the AI stalls. Stop the AI must leave the
// earlier stakes with the line they cover, so the gold button can never roll the late line into the story without stakes.
test('stopping a second plan keeps the earlier stakes for their own line, and the late line still waits outside the plan', async ({ page }) => {
  const sessionId = await signIn(page);
  const path = `/sessions/${sessionId}`;
  let snapshot = await api(page, path);
  const command = async (value: Record<string, unknown>, identity?: string) => {
    const result = await api(page, `${path}/commands`, { commandId: randomUUID(), ...value }, identity);
    if (!identity) snapshot = result.snapshot;
    return result.snapshot;
  };
  await command({ type: 'set_status', status: 'live', expectedStateRevision: snapshot.session.stateRevision });
  const seatIdentity: string = (await api(page, `${path}/test-seat`, { characterId: snapshot.characters[0].id })).identityId;

  await command({ type: 'open_beat', kind: 'action', expectedInputEpoch: snapshot.session.inputEpoch });
  await command({
    type: 'save_submission', contextBeatId: snapshot.activeBeat.id, expectedInputEpoch: snapshot.session.inputEpoch, expectedSubmissionRevision: 0,
    kind: 'act', text: '', intent: 'Study the lantern dock', approach: 'Careful investigation',
  }, seatIdentity);

  // The first plan answers at once, so its stakes are on the page.
  await page.reload();
  await expect(page.getByTestId('plan')).toBeEnabled({ timeout: 20000 });
  await page.getByTestId('plan').click();
  await expect(page.getByTestId('approve-and-roll')).toBeEnabled({ timeout: 20000 });
  snapshot = await api(page, path);
  expect(snapshot.activeBeat.phase).toBe('stakes_review');
  const firstLine: string = snapshot.activeBeat.selectedSubmissionIds[0];
  const stakes = snapshot.activeBeat.contracts;
  expect(stakes).toHaveLength(1);

  // A late line arrives ticked. Its words make the test AI wait until it is stopped.
  await command({
    type: 'save_submission', contextBeatId: snapshot.activeBeat.id, expectedInputEpoch: snapshot.session.inputEpoch, expectedSubmissionRevision: 0,
    kind: 'say', text: 'Hold the AI: what is behind that door?', intent: '', approach: '',
  }, seatIdentity);
  await expect(page.getByTestId('outside-plan')).toHaveText('1 ticked line is not in this plan.', { timeout: 20000 });
  await page.getByTestId('plan-again-bar').click();
  await expect(page.getByTestId('stop-ai')).toBeVisible({ timeout: 5000 });
  await page.getByTestId('stop-ai').click();
  await expect(page.getByTestId('ai-stopped')).toHaveText('You stopped the AI. Nothing from that try was used.', { timeout: 5000 });
  await expect(page.getByTestId('beat-error')).toHaveCount(0);

  // The page tells the truth: the earlier stakes stand, the late line is still outside the plan, and Plan again is offered.
  await expect(page.getByTestId('outside-plan')).toHaveText('1 ticked line is not in this plan.');
  await expect(page.getByTestId('plan-again-bar')).toBeEnabled();
  snapshot = await api(page, path);
  expect(snapshot.activeBeat.selectedSubmissionIds).toEqual([firstLine]);
  expect(snapshot.activeBeat.contracts).toEqual(stakes);
  const lateLine = snapshot.submissions.find((item: { id: string; kind: string }) => item.id !== firstLine && item.kind === 'say');
  expect(lateLine.status).toBe('queued');

  // Going on with the earlier stakes rolls only the line they cover.
  await page.getByTestId('approve-and-roll').click();
  await expect.poll(async () => (await api(page, path)).activeBeat?.phase, { timeout: 30000 }).toMatch(/^(locked|draft_review)$/);
  snapshot = await api(page, path);
  expect(snapshot.activeBeat.lockedSubmissions.map((item: { id: string }) => item.id)).toEqual([firstLine]);
  expect(snapshot.activeBeat.resolution.rolls).toHaveLength(1);
  expect(snapshot.submissions.find((item: { id: string }) => item.id === lateLine.id).status).toBe('queued');
});
