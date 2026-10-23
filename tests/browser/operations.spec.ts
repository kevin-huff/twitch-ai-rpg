import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';

async function api(page: Page, path: string, body?: unknown) {
  return page.evaluate(async ({ path, body }) => {
    const identity = new URL(location.href).searchParams.get('identity');
    const response = await fetch(`/api${path}`, { headers: { ...(identity ? { 'X-RPG-Identity': identity } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  }, { path, body });
}

test('director sees real task progress, unlimited limits and durable recorded usage', async ({ page, context }) => {
  await page.goto('/');
  await page.getByLabel('Host access token').fill('browser-test-host-credential-not-for-deployment');
  await page.getByRole('button', { name: 'Sign in as host' }).click();
  await page.getByRole('button', { name: 'Create rehearsal session' }).click();
  await page.getByRole('link', { name: 'Enter director workspace' }).click();
  const sessionId = new URL(page.url()).pathname.split('/')[2];
  const path = `/sessions/${sessionId}`;
  const panel = page.getByTestId('operations-panel');
  await expect(panel).toBeVisible();
  await expect(panel).toContainText(/Unlimited/);
  await expect(panel).toContainText(/Not reported/);
  let state = (await api(page, path)).body;
  const grant = (await api(page, `${path}/test-seat`, { characterId: state.characters[0].id })).body;
  const player = await context.newPage();
  await player.goto(`${path}/play?identity=${grant.identityId}`);
  await expect(player.getByTestId('operations-panel')).toHaveCount(0);
  expect((await api(player, `${path}/operations`)).status).toBe(403);
  async function command(value: Record<string, unknown>) {
    const result = await api(page, `${path}/commands`, { commandId: randomUUID(), ...value });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    state = result.body.snapshot;
  }
  const beat = (value: Record<string, unknown>) => command({ beatId: state.activeBeat.id, expectedBeatRevision: state.activeBeat.revision, ...value });
  await command({ type: 'open_beat', kind: 'conversation', expectedInputEpoch: state.session.inputEpoch });
  const submission = await api(player, `${path}/commands`, { commandId: randomUUID(), type: 'save_submission', contextBeatId: state.activeBeat.id, expectedInputEpoch: state.session.inputEpoch, expectedSubmissionRevision: 0, kind: 'say', text: 'Operations rehearsal: where did the owner go?', recipientNpcIds: [state.npcs[0].id] });
  expect(submission.status).toBe(200);
  const planning = beat({ type: 'plan_beat', submissionIds: submission.body.snapshot.submissions.map((item: any) => item.id) });
  await expect(panel.getByTestId('operations-progress')).toContainText(/Planning/);
  await planning;
  await beat({ type: 'approve_stakes', classification: 'ordinary', contracts: [] });
  await beat({ type: 'lock_beat' });
  const rendering = beat({ type: 'render_beat' });
  await expect(panel.getByTestId('operations-progress')).toContainText(/Rendering|Drafting/);
  await rendering;
  await expect(page.getByTestId('draft-audio-panel')).toBeVisible();
  await page.getByRole('button', { name: 'Prepare draft narration', exact: true }).click();
  await expect(panel.getByTestId('operations-progress')).toContainText(/1\s*(?:\/|of)\s*2/);
  await expect(page.getByRole('button', { name: 'Publish with narration', exact: true })).toBeEnabled();
  const operations = (await api(page, `${path}/operations`)).body;
  expect(operations.usage.ai).toMatchObject({ attempts: 2, succeeded: 2 });
  expect(operations.usage.speech).toMatchObject({ attempts: 2, succeeded: 2 });
  expect(operations.speech.draft).toMatchObject({ status: 'ready', completedSegments: 2, totalSegments: 2 });
  const script = page.getByTestId('script-segment-0');
  await script.fill('An unsaved change survives status polling.');
  await page.waitForResponse(response => response.url().endsWith(`${path}/operations`) && response.request().method() === 'GET' && response.status() === 200);
  await expect(script).toHaveValue('An unsaved change survives status polling.');
  await page.reload();
  await expect(panel).toBeVisible();
  expect((await api(page, `${path}/operations`)).body.usage).toEqual(operations.usage);
  await page.setViewportSize({ width: 430, height: 920 });
  await panel.locator('summary').click();
  await panel.scrollIntoViewIfNeeded();
  const bounds = await panel.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(431);
  await panel.screenshot({ path: 'test-results/operations-director.png' });
  await player.close();
});
