import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';

async function api(page: Page, path: string, body?: unknown) {
  return page.evaluate(async ({ path, body }) => {
    const identity = new URL(location.href).searchParams.get('identity');
    const response = await fetch(`/api${path}`, { headers: { ...(identity ? { 'X-RPG-Identity': identity } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  }, { path, body });
}

test('director previews saved narration privately and publishes that recording once', async ({ page, context }) => {
  await page.addInitScript(() => {
    const NativeAudio = window.Audio;
    (window as any).__privateAudio = [];
    window.Audio = function (src?: string) {
      const audio = new NativeAudio(src);
      (window as any).__privateAudio.push(audio);
      return audio;
    } as unknown as typeof Audio;
  });
  await page.goto('/');
  await page.getByLabel('Host access token').fill('browser-test-host-credential-not-for-deployment');
  await page.getByRole('button', { name: 'Sign in as host' }).click();
  await page.getByRole('button', { name: 'Try it now' }).click();
  await expect(page.getByTestId('director-controls')).toBeVisible();
  const sessionId = new URL(page.url()).pathname.split('/')[2];
  const path = `/sessions/${sessionId}`;
  let state = (await api(page, path)).body;
  const grant = (await api(page, `${path}/test-seat`, { characterId: state.characters[0].id })).body;
  const player = await context.newPage();
  await player.goto(`${path}/play?identity=${grant.identityId}`);
  async function command(value: Record<string, unknown>) {
    const result = await api(page, `${path}/commands`, { commandId: randomUUID(), ...value });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    state = result.body.snapshot;
  }
  const beat = (value: Record<string, unknown>) => command({ beatId: state.activeBeat.id, expectedBeatRevision: state.activeBeat.revision, ...value });
  await command({ type: 'open_beat', kind: 'conversation', expectedInputEpoch: state.session.inputEpoch });
  const quote = 'My exact spoken question stays mine.';
  const submitted = (await api(player, `${path}/commands`, { commandId: randomUUID(), type: 'save_submission', contextBeatId: state.activeBeat.id, expectedInputEpoch: state.session.inputEpoch, expectedSubmissionRevision: 0, kind: 'say', text: quote, recipientNpcIds: [state.npcs[0].id] })).body.snapshot;
  await beat({ type: 'plan_beat', submissionIds: submitted.submissions.map((s: any) => s.id) });
  await beat({ type: 'approve_stakes', classification: 'ordinary', contracts: [] });
  await beat({ type: 'lock_beat' });
  await beat({ type: 'render_beat' });
  const audioPath = `${path}/beats/${state.activeBeat.id}/draft-audio`;
  const before = state;
  await page.reload();
  const panel = page.getByTestId('draft-audio-panel');
  await expect(panel).toBeVisible();
  // The narration prepares by itself; there is nothing to press.
  await expect(panel.getByRole('button', { name: 'Prepare voice again' })).toHaveCount(0);
  const publish = page.getByTestId('publish');
  await expect(page.getByTestId('beat-status')).toHaveText('Voice ready', { timeout: 30000 });
  await expect(publish).toBeEnabled();
  await expect(publish).toHaveText('Publish');
  const ready = (await api(page, audioPath)).body.manifest;
  // The player's quoted line is voiced: it is the first recorded segment, word for word, ahead of the AI's script.
  expect(ready.segments[0]).toMatchObject({ text: quote });
  expect(ready.segments).toHaveLength(before.activeBeat.draft.segments.length + 1);
  expect(ready.segments.slice(1).map((s: any) => s.text)).toEqual(before.activeBeat.draft.segments.map((s: any) => s.text));
  expect((await api(player, audioPath)).status).toBe(403);
  const privateMedia = ready.segments[0].url;
  expect((await api(player, privateMedia.replace(/^\/api/, ''))).status).toBe(403);
  expect((await api(player, path)).body.history).toEqual([]);
  for (const field of ['session', 'history', 'tracks', 'characters']) expect((await api(page, path)).body[field]).toEqual(before[field]);

  await page.getByTestId('script-line-0').click();
  await page.getByTestId('script-segment-0').fill('An unsaved alternative.');
  await expect(publish).toBeDisabled();
  await expect(publish).toHaveText('Publish');
  await page.getByTestId('script-segment-0').fill(before.activeBeat.draft.segments[0].text);
  await expect(publish).toBeEnabled({ timeout: 30000 });
  await page.setViewportSize({ width: 430, height: 920 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await panel.screenshot({ path: 'test-results/draft-audio-director.png' });
  await panel.getByRole('button', { name: 'Preview narration', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Stop preview', exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).__privateAudio.some((audio: HTMLAudioElement) => audio.src.includes('/draft-audio/') && audio.currentTime > 0 && !audio.paused))).toBe(true);
  await expect(panel.getByRole('alert')).not.toBeVisible();
  await panel.getByRole('button', { name: 'Stop preview', exact: true }).click();
  await page.reload();
  await expect(page.getByTestId('beat-status')).toHaveText('Voice ready', { timeout: 30000 });
  await expect(publish).toBeEnabled();
  await expect(panel.getByRole('button', { name: 'Stop preview', exact: true })).not.toBeVisible();
  await publish.click();
  await expect(panel).not.toBeVisible();
  const after = (await api(page, path)).body;
  expect(after.history).toHaveLength(1);
  const publication = after.history[0];
  expect(publication.textOnly).toBe(false);
  expect(publication.audioManifestKey).toMatch(/^[a-f0-9]{64}$/);
  expect(publication.segments.filter((s: any) => s.kind === 'player_dialogue')).toEqual([expect.objectContaining({ text: quote, ttsEnabled: true })]);
  const publicAudio = (await api(player, `${path}/audio/${publication.id}`)).body.manifest;
  expect(publicAudio.segments.map((s: any) => s.text)).toEqual(ready.segments.map((s: any) => s.text));
  expect(publicAudio.segments.map((s: any) => s.id)).toEqual(publication.segments.map((s: any) => s.id));
  expect((await api(page, audioPath)).status).toBe(409);
  expect((await api(page, `${path}/playback`)).body.status).toBe('idle');
  await player.close();
});
