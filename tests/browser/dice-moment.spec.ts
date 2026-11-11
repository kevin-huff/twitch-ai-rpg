import { randomUUID } from 'node:crypto';
import { expect, test, type Browser, type Page } from '@playwright/test';

async function api(page: Page, path: string, body?: unknown, identity?: string) {
  return page.evaluate(async ({ path, body, identity }) => {
    const id = identity ?? new URL(location.href).searchParams.get('identity');
    const response = await fetch(`/api${path}`, { headers: { ...(id ? { 'X-RPG-Identity': id } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  }, { path, body, identity });
}

test.setTimeout(240000);

type Body = any;
const NAMES = ['Seraphina Vale', 'Tobias Reed', 'Mara Quillon', 'Elena Torres', 'Jonah Pike', 'Lucia Ferrante', 'Bartholomew Okoro', 'Magdalena Ash', 'Elenora Whitby', 'Cornelius Dray', 'Philippa Stroud', 'Ignatius Bell'];

// Signs in, makes the demo show and a seat for each character, and returns a command helper.
async function startShow(page: Page) {
  await page.goto('/');
  await page.getByLabel('Host access token').fill('browser-test-host-credential-not-for-deployment');
  await page.getByRole('button', { name: 'Sign in as host' }).click();
  await page.getByRole('button', { name: 'Try it now' }).click();
  await expect(page.getByTestId('director-controls')).toBeVisible();
  const sessionId = new URL(page.url()).pathname.split('/')[2]!;
  const path = `/sessions/${sessionId}`;
  const show = { path, state: (await api(page, path)).body as Body, seats: [] as string[] };
  const command = async (value: Record<string, unknown>, identity?: string) => {
    const result = await api(page, `${path}/commands`, { commandId: randomUUID(), ...value }, identity);
    expect(result.status, JSON.stringify(result.body).slice(0, 300)).toBe(200);
    if (!identity) show.state = result.body.snapshot;
    return result.body.snapshot;
  };
  for (const character of show.state.characters) show.seats.push((await api(page, `${path}/test-seat`, { characterId: character.id })).body.identityId);
  return { show, command };
}

// Plays one action round through to a text-only publish and returns the published rolls.
async function publishRound(page: Page, show: { path: string; state: Body; seats: string[] }, command: (value: Record<string, unknown>, identity?: string) => Promise<Body>) {
  const beat = (value: Record<string, unknown>) => command({ beatId: show.state.activeBeat.id, expectedBeatRevision: show.state.activeBeat.revision, ...value });
  await command({ type: 'open_beat', kind: 'action', expectedInputEpoch: show.state.session.inputEpoch });
  for (let index = 0; index < show.seats.length; index++) {
    await command({ type: 'save_submission', contextBeatId: show.state.activeBeat.id, expectedInputEpoch: show.state.session.inputEpoch, expectedSubmissionRevision: 0, kind: 'act', text: '', intent: `Search the cellar ${index}`, approach: 'Careful investigation' }, show.seats[index]);
  }
  show.state = (await api(page, show.path)).body;
  await beat({ type: 'plan_beat', submissionIds: show.state.submissions.filter((item: any) => item.status === 'queued').map((item: any) => item.id) });
  await beat({ type: 'approve_stakes', classification: 'action', contracts: show.state.activeBeat.contracts });
  await beat({ type: 'lock_beat' });
  await beat({ type: 'render_beat' });
  await beat({ type: 'edit_script', segments: [{ kind: 'narration', speakerNpcId: null, recipientCharacterIds: [], delivery: 'neutral', text: 'The cellar goes quiet.' }] });
  if (show.state.activeBeat.draft?.continuity?.length) await beat({ type: 'approve_continuity', updates: show.state.activeBeat.draft.continuity });
  await beat({ type: 'publish_beat', expectedStateRevision: show.state.session.stateRevision, draftRevision: show.state.activeBeat.draftRevision, textOnly: true });
  return show.state.history.at(-1).rolls as Array<{ id: string; faces: [number, number] }>;
}

async function streamLink(page: Page, path: string) {
  const created = await api(page, `${path}/stream-links`, { commandId: randomUUID(), subject: 'show' });
  expect(created.status).toBe(200);
  return `#token=${encodeURIComponent(created.body.token)}`;
}

async function openStream(browser: Browser, url: string, size: { width: number; height: number }, rewrite?: (body: Body) => void) {
  const context = await browser.newContext({ viewport: size });
  if (rewrite) {
    await context.route(/\/api\/sessions\/[^/?]+\?view=stage$/, async route => {
      const response = await route.fetch();
      const body = await response.json();
      rewrite(body);
      await route.fulfill({ response, json: body });
    });
  }
  const page = await context.newPage();
  const loaded = page.waitForResponse(response => response.url().includes('view=stage') && response.ok());
  await page.goto(url);
  await loaded;
  return page;
}

test('a published round plays the dice moment on the overlay, the full scene and the Dice piece, then settles into the strip', async ({ page, browser }) => {
  const { show, command } = await startShow(page);
  const hash = await streamLink(page, show.path);
  const FULL = { width: 1920, height: 1080 };
  // The stream pages open before the round is published, so the round is new to them.
  const surfaces = [
    { name: 'overlay', page: await openStream(browser, `/stream?layout=overlay&audio=off${hash}`, FULL), center: true },
    { name: 'scene', page: await openStream(browser, `/stream?layout=scene&audio=off${hash}`, FULL), center: true },
    { name: 'dice piece', page: await openStream(browser, `/stream?view=dice&audio=off${hash}`, { width: 1440, height: 144 }), center: false },
  ];
  const rolls = await publishRound(page, show, command);
  expect(rolls.length).toBeGreaterThan(0);
  const faces = (locator: ReturnType<Page['locator']>) => locator.evaluateAll(dice => dice.map(die => Number(die.getAttribute('data-face'))));

  // All three pages are checked at once, because the Dice piece's landed dice stay only until the settle.
  await Promise.all(surfaces.map(async ({ name, page: stream, center }) => {
    if (center) {
      await expect(stream.locator('.dice-moment'), name).toBeVisible({ timeout: 10000 });
      await expect(stream.locator('.dice'), name).toHaveClass(/dice-waiting/);
      // Until the dice land, the rest of the stage shows what it showed before the publish.
      await expect(stream.getByText('The cellar goes quiet.'), name).toHaveCount(0);
      for (const roll of rolls) {
        const cell = stream.locator(`.moment-cell[data-roll-id="${roll.id}"]`);
        await expect(cell.locator('.cell-verdict'), `${name} ${roll.id}`).toBeVisible({ timeout: 10000 });
        expect(await faces(cell.locator('.pixel-die'))).toEqual(roll.faces);
      }
    } else {
      await expect(stream.locator('.strip-tray').first(), name).toBeVisible({ timeout: 10000 });
      for (const roll of rolls) {
        const card = stream.locator('.roll', { has: stream.locator(`[data-dice-target="${roll.id}"]`) });
        await expect(card.locator('.roll-band'), `${name} ${roll.id}`).toBeVisible({ timeout: 10000 });
        if (rolls.length <= 6) expect(await faces(card.locator('.pixel-die'))).toEqual(roll.faces);
      }
    }
  }));

  // Each page settles into today's strip, the new lines appear, and a reload never replays the round.
  await Promise.all(surfaces.map(async ({ name, page: stream }) => {
    await expect(stream.locator('.dice-moment'), name).toHaveCount(0, { timeout: 10000 });
    await expect(stream.locator('.strip-tray'), name).toHaveCount(0, { timeout: 10000 });
    await expect(stream.locator('.dice .roll'), name).toHaveCount(rolls.length);
    await expect(stream.locator('.dice'), name).not.toHaveClass(/dice-waiting/);
  }));
  const overlay = surfaces[0]!.page;
  await expect(overlay.getByText('The cellar goes quiet.')).toBeVisible();
  await overlay.reload();
  await expect(overlay.locator('.dice .roll')).toHaveCount(rolls.length);
  await overlay.waitForTimeout(1000);
  await expect(overlay.locator('.dice-moment')).toHaveCount(0);
});

test('a twelve-roll round keeps every chip, verdict and name inside its cell while the dice play', async ({ page, browser }) => {
  const { show, command } = await startShow(page);
  const hash = await streamLink(page, show.path);
  // The stage view of the published round is widened to twelve rolls with the longest trait words and long names.
  const twelve = (body: Body) => {
    while (body.characters.length < 12) body.characters.push({ ...body.characters[body.characters.length % 4], id: `extra-${body.characters.length}` });
    body.characters.forEach((character: Body, index: number) => { character.displayName = NAMES[index]; });
    const latest = body.history.at(-1);
    if (!latest?.rolls?.length) return;
    latest.rolls = body.characters.map((character: Body, index: number) => ({
      id: `wide-${index}`, contractId: latest.rolls[0].contractId, contractVersion: 1, actorCharacterId: character.id, faces: [3, 3],
      trait: index % 2 ? 'presence' : 'finesse', traitModifier: 2, edge: 1, total: 9, band: index % 3 ? 'costly' : 'clean',
    }));
  };
  const overlay = await openStream(browser, `/stream?layout=overlay&audio=off${hash}`, { width: 1920, height: 1080 }, twelve);
  await publishRound(page, show, command);
  await expect(overlay.locator('.dice-moment')).toBeVisible({ timeout: 10000 });
  await expect(overlay.locator('.moment-cell')).toHaveCount(12);
  const issues: string[] = await overlay.evaluate(async () => {
    const found = new Set<string>();
    const until = performance.now() + 5500;
    while (performance.now() < until && document.querySelector('.dice-moment')) {
      for (const cell of Array.from(document.querySelectorAll<HTMLElement>('.moment-cell'))) {
        const box = cell.getBoundingClientRect();
        for (const part of Array.from(cell.querySelectorAll<HTMLElement>('.cell-chip, .cell-verdict, .cell-name'))) {
          const rect = part.getBoundingClientRect();
          if (rect.width && (rect.right > box.right + 0.5 || rect.left < box.left - 0.5)) found.add(`${cell.dataset.rollId} ${part.className.split(' ')[0]} "${part.textContent}" ends ${Math.round(rect.right - box.right)} px past its cell`);
        }
      }
      await new Promise(resolve => requestAnimationFrame(resolve));
    }
    return [...found];
  });
  expect(issues).toEqual([]);
});

