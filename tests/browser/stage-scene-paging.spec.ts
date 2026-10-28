import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';

async function api(page: Page, path: string, body?: unknown, identity?: string) {
  return page.evaluate(async ({ path, body, identity }) => {
    const id = identity ?? new URL(location.href).searchParams.get('identity');
    const response = await fetch(`/api${path}`, { headers: { ...(id ? { 'X-RPG-Identity': id } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  }, { path, body, identity });
}

interface Part { id: string; top: number; bottom: number; height: number }
interface Sample { marker: string; parts: Part[]; visibleBottom: number; markerTop: number | null }

// For every line that is on the current page, reports which vertical part of its text shows inside the line box and inside the text's own clip.
function sampleParts(page: Page): Promise<Sample> {
  return page.evaluate(() => {
    const parts: { id: string; top: number; bottom: number; height: number }[] = [];
    let visibleBottom = 0;
    for (const line of Array.from(document.querySelectorAll<HTMLElement>('.stage-story .line[data-segment-id]'))) {
      if (line.classList.contains('off-page')) continue;
      const text = line.querySelector<HTMLElement>('.line-text')!;
      const box = line.getBoundingClientRect();
      const rect = text.getBoundingClientRect();
      let top = Math.max(box.top, rect.top);
      let bottom = Math.min(box.bottom, rect.bottom);
      const inset = /^inset\(([^)]*)\)/.exec(getComputedStyle(text).clipPath);
      if (inset) {
        const values = inset[1]!.trim().split(/\s+/).map(value => Number.parseFloat(value));
        const clipTop = values[0]!;
        const clipBottom = values[2] ?? values[0]!;
        top = Math.max(top, rect.top + clipTop);
        bottom = Math.min(bottom, rect.bottom - clipBottom);
      }
      parts.push({ id: line.dataset.segmentId!, top: Math.min(top - rect.top, rect.height), bottom: Math.max(bottom - rect.top, 0), height: rect.height });
      if (bottom - top > 1) visibleBottom = Math.max(visibleBottom, bottom);
    }
    const marker = document.querySelector<HTMLElement>('.page-marker');
    return { marker: marker?.textContent ?? '', parts, visibleBottom, markerTop: marker ? marker.getBoundingClientRect().top : null };
  });
}

test.setTimeout(150000);

test('the full scene pages tall lines so every row shows, with the wager featured or the rolls on screen', async ({ page, browser }) => {
  await page.goto('/');
  await page.getByLabel('Host access token').fill('browser-test-host-credential-not-for-deployment');
  await page.getByRole('button', { name: 'Sign in as host' }).click();
  await page.getByRole('button', { name: 'Try it now' }).click();
  await expect(page.getByTestId('director-controls')).toBeVisible();
  const sessionId = new URL(page.url()).pathname.split('/')[2]!;
  const path = `/sessions/${sessionId}`;

  let state = (await api(page, path)).body;
  const command = async (value: Record<string, unknown>, identity?: string) => {
    const result = await api(page, `${path}/commands`, { commandId: randomUUID(), ...value }, identity);
    expect(result.status, JSON.stringify(result.body).slice(0, 300)).toBe(200);
    if (!identity) state = result.body.snapshot;
    return result.body.snapshot;
  };
  const beat = (value: Record<string, unknown>) => command({ beatId: state.activeBeat.id, expectedBeatRevision: state.activeBeat.revision, ...value });

  // Every character gets a test seat so a whole action round can be submitted.
  expect(state.characters.length).toBe(4);
  const seats: string[] = [];
  for (const character of state.characters) seats.push((await api(page, `${path}/test-seat`, { characterId: character.id })).body.identityId);
  const openRound = async (label: string) => {
    await command({ type: 'open_beat', kind: 'action', expectedInputEpoch: state.session.inputEpoch });
    for (let index = 0; index < seats.length; index++) {
      await command({ type: 'save_submission', contextBeatId: state.activeBeat.id, expectedInputEpoch: state.session.inputEpoch, expectedSubmissionRevision: 0, kind: 'act', text: '', intent: `${label} ${index}`, approach: 'Careful investigation' }, seats[index]);
    }
    state = (await api(page, path)).body;
    await beat({ type: 'plan_beat', submissionIds: state.submissions.filter((item: any) => item.status === 'queued').map((item: any) => item.id) });
    await beat({ type: 'approve_stakes', classification: 'action', contracts: state.activeBeat.contracts });
  };

  // First round: four rolls and a script with two long non-player lines, published text-only.
  await openRound('Search the cellar');
  await beat({ type: 'lock_beat' });
  await beat({ type: 'render_beat' });
  const npc = state.npcs.find((item: any) => item.status === 'present');
  const narration = 'The cellar goes quiet.';
  const first = 'You came down here for the ledger, and I understand that. But there are people upstairs who would pay a great deal to keep it buried, and they have already sent two men to ask me where I hid it. I told them nothing, and I will tell you nothing either, not while that door stays shut.';
  const second = 'Listen to me carefully now. If you take that book out through the front door, they will know within the hour. Leave by the coal chute behind the boiler, and do not stop walking until you reach the river and the old ferry.';
  expect(first.length).toBeGreaterThanOrEqual(270);
  expect(first.length).toBeLessThanOrEqual(285);
  expect(second.length).toBeGreaterThanOrEqual(215);
  expect(second.length).toBeLessThanOrEqual(227);
  await beat({ type: 'edit_script', segments: [
    { kind: 'narration', speakerNpcId: null, recipientCharacterIds: [], delivery: 'neutral', text: narration },
    { kind: 'npc_dialogue', speakerNpcId: npc.id, recipientCharacterIds: [], delivery: 'neutral', text: first },
    { kind: 'npc_dialogue', speakerNpcId: npc.id, recipientCharacterIds: [], delivery: 'neutral', text: second },
  ] });
  if (state.activeBeat.draft?.continuity?.length) await beat({ type: 'approve_continuity', updates: state.activeBeat.draft.continuity });
  await beat({ type: 'publish_beat', expectedStateRevision: state.session.stateRevision, draftRevision: state.activeBeat.draftRevision, textOnly: true });
  expect(state.history).toHaveLength(1);
  const published = state.history.at(-1);
  expect(published.rolls.length).toBeGreaterThanOrEqual(3);
  // Each Do line publishes first as its own Action line, one per player, before the three script lines.
  expect(published.segments.slice(0, 4).map((segment: any) => segment.kind)).toEqual(['player_action', 'player_action', 'player_action', 'player_action']);
  expect(published.segments).toHaveLength(7);
  // The page-by-page timing below was built around exactly the three script lines, so the stream pages here do not see the four action lines.
  const segmentIds: string[] = published.segments.filter((segment: any) => segment.kind !== 'player_action').map((segment: any) => segment.id);
  expect(segmentIds).toHaveLength(3);
  const withoutActions = (body: any) => { const latest = body.history.at(-1); latest.segments = latest.segments.filter((segment: any) => segment.kind !== 'player_action'); };

  // Second round: open it and approve its stakes so the public wager shows in the full scene.
  await openRound('Leave by the coal chute');
  expect(state.activeBeat.contracts.length).toBeGreaterThan(0);

  const created = await api(page, `${path}/stream-links`, { commandId: randomUUID(), subject: 'show' });
  expect(created.status).toBe(200);
  const url = `/stream?layout=scene&audio=off#token=${encodeURIComponent(created.body.token)}`;
  const goals = [
    'Pry the cellar ledger out of the locked iron chest',
    'Keep the two watchmen talking at the front door',
    'Copy the old ferry schedule before the lamp burns out',
    'Carry the sleeping child across the flooded corridor',
  ];

  // Pass 1: stakes are up. Four actors, four long goals; the wager is featured and the previous dice are held back.
  const stakesContext = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  try {
    await stakesContext.route(/\/api\/sessions\/[^/?]+\?view=stage$/, async route => {
      const response = await route.fetch();
      const body = await response.json();
      withoutActions(body);
      const stakes = body.activeBeat.stakes;
      body.activeBeat.stakes = body.characters.slice(0, 4).map((character: any, index: number) => ({ ...stakes[index % stakes.length], id: `stake-${index}`, actorCharacterId: character.id, intent: goals[index] }));
      await route.fulfill({ response, json: body });
    });
    const stream = await stakesContext.newPage();
    await stream.goto(url);
    await expect(stream.locator('.stage-story .line[data-segment-id]')).toHaveCount(segmentIds.length);
    // The previous round's rolls stay in the page but are held back while the stakes are up.
    await expect(stream.locator('.stage-story .roll')).toHaveCount(published.rolls.length);
    await expect(stream.locator('.stage-story .dice')).toHaveClass(/dice-held/);
    await expect(stream.locator('.stage-story .dice')).toBeHidden();
    await expect(stream.locator('.stage-story .wager')).toBeVisible();
    await expect(stream.locator('.stage-story .wager-card').first()).toBeVisible();
    await expect(stream.locator('.stage-story .wager-row-item')).toHaveCount(4);
    await expect(stream.locator('.page-marker')).toHaveText(/^Part 1 of \d+$/);

    // Every actor's name and the spotlight card's goal and outcomes are whole, and inside the story box.
    const cut = await stream.evaluate(() => {
      const story = document.querySelector<HTMLElement>('.stage-story')!.getBoundingClientRect();
      const inside = (el: Element) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.left >= story.left - 0.5 && r.right <= story.right + 0.5 && r.top >= story.top - 0.5 && r.bottom <= story.bottom + 0.5; };
      const check = (el: HTMLElement) => ({ text: (el.textContent ?? '').slice(0, 40), cutHeight: el.scrollHeight > el.clientHeight + 1, cutWidth: el.scrollWidth > el.clientWidth + 1, inside: inside(el) });
      return {
        names: Array.from(document.querySelectorAll<HTMLElement>('.stage-story .wager-row-name')).map(check),
        goals: Array.from(document.querySelectorAll<HTMLElement>('.stage-story .wager-card.spotlight .wager-goal')).map(check),
        outcomes: Array.from(document.querySelectorAll<HTMLElement>('.stage-story .wager-card.spotlight .wager-outcome-text')).map(check),
        spotlightCards: document.querySelectorAll('.stage-story .wager-card.spotlight').length,
      };
    });
    const where = JSON.stringify(cut);
    expect(cut.names, where).toHaveLength(4);
    expect(cut.goals, where).toHaveLength(1);
    expect(cut.spotlightCards, where).toBe(1);
    expect(cut.outcomes, where).toHaveLength(4);
    for (const item of [...cut.names, ...cut.goals, ...cut.outcomes]) {
      expect(item.cutHeight, `${item.text} is cut in height: ${where}`).toBe(false);
      expect(item.cutWidth, `${item.text} is cut in width: ${where}`).toBe(false);
      expect(item.inside, `${item.text} sits outside the story box: ${where}`).toBe(true);
    }

    const pageCount = Number(/of (\d+)$/.exec((await stream.locator('.page-marker').textContent()) ?? '')![1]);
    expect(pageCount).toBeGreaterThan(1);

    // Page 1 shows the first segment.
    const opening = await sampleParts(stream);
    expect(opening.marker).toMatch(/^Part 1 of \d+$/);
    expect(opening.parts.map(part => part.id)).toContain(segmentIds[0]);

    // About two full cycles of the page timer (8 s a page), recording what part of each text shows.
    const covered = new Map<string, { height: number; ranges: [number, number][] }>();
    const markers = new Set<string>();
    const deadline = Date.now() + pageCount * 8000 * 2 + 3000;
    while (Date.now() < deadline) {
      const sample = await sampleParts(stream);
      markers.add(sample.marker);
      // The text that shows ends above the page marker, so the two never overlap.
      if (sample.markerTop !== null && sample.visibleBottom > 0) {
        expect(sample.visibleBottom, `visible text ends at ${sample.visibleBottom}px, page marker starts at ${sample.markerTop}px (${sample.marker})`).toBeLessThanOrEqual(sample.markerTop + 1);
      }
      for (const part of sample.parts) {
        const entry = covered.get(part.id) ?? { height: part.height, ranges: [] };
        if (part.bottom - part.top > 1) entry.ranges.push([part.top, part.bottom]);
        covered.set(part.id, entry);
      }
      await stream.waitForTimeout(300);
    }
    expect(markers.size, `markers seen: ${[...markers].join(', ')}`).toBe(pageCount);

    // The parts together must cover the whole text height of every segment, so no row stays hidden.
    for (const id of segmentIds) {
      const entry = covered.get(id);
      expect(entry, `segment ${id} never showed`).toBeDefined();
      const ranges = entry!.ranges.sort((a, b) => a[0] - b[0]);
      let reach = 0;
      for (const [top, bottom] of ranges) {
        expect(top, `segment ${id} has a hidden gap before ${top}px (covered to ${reach}px of ${entry!.height}px)`).toBeLessThanOrEqual(reach + 2);
        reach = Math.max(reach, bottom);
      }
      expect(reach, `segment ${id} never showed past ${reach}px of ${entry!.height}px`).toBeGreaterThanOrEqual(entry!.height - 2);
    }
  } finally { await stakesContext.close(); }

  // Pass 2: no stakes are up. The previous round's rolls are on screen inside the dice block and the story box.
  const diceContext = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  try {
    await diceContext.route(/\/api\/sessions\/[^/?]+\?view=stage$/, async route => {
      const response = await route.fetch();
      const body = await response.json();
      withoutActions(body);
      delete body.activeBeat.stakes;
      await route.fulfill({ response, json: body });
    });
    const stream = await diceContext.newPage();
    await stream.goto(url);
    await expect(stream.locator('.stage-story .line[data-segment-id]')).toHaveCount(segmentIds.length);
    await expect(stream.locator('.stage-story .roll')).toHaveCount(published.rolls.length);
    await expect(stream.locator('.stage-story .roll').first()).toBeVisible();
    await expect(stream.locator('.stage-story .dice')).not.toHaveClass(/dice-held/);
    await expect(stream.locator('.stage-story .wager')).toHaveCount(0);
    // Every roll card, border included, sits inside the dice block, the story box and the picture.
    const boxes = await stream.evaluate(() => {
      const rect = (el: Element) => { const { left, top, right, bottom } = el.getBoundingClientRect(); return { left, top, right, bottom }; };
      return { dice: rect(document.querySelector('.stage-story .dice')!), story: rect(document.querySelector('.stage-story')!), rolls: Array.from(document.querySelectorAll('.stage-story .dice .roll')).map(rect), width: window.innerWidth, height: window.innerHeight };
    });
    expect(boxes.rolls).toHaveLength(published.rolls.length);
    const where = JSON.stringify(boxes);
    for (const roll of boxes.rolls) {
      expect(roll.left, where).toBeGreaterThanOrEqual(boxes.dice.left - 0.5);
      expect(roll.top, where).toBeGreaterThanOrEqual(boxes.dice.top - 0.5);
      expect(roll.right, where).toBeLessThanOrEqual(boxes.dice.right + 0.5);
      expect(roll.bottom, where).toBeLessThanOrEqual(boxes.dice.bottom + 0.5);
      expect(roll.left, where).toBeGreaterThanOrEqual(boxes.story.left - 0.5);
      expect(roll.top, where).toBeGreaterThanOrEqual(boxes.story.top - 0.5);
      expect(roll.right, where).toBeLessThanOrEqual(boxes.story.right + 0.5);
      expect(roll.bottom, where).toBeLessThanOrEqual(boxes.story.bottom + 0.5);
      expect(roll.left).toBeGreaterThanOrEqual(0);
      expect(roll.top).toBeGreaterThanOrEqual(0);
      expect(roll.right).toBeLessThanOrEqual(boxes.width);
      expect(roll.bottom).toBeLessThanOrEqual(boxes.height);
    }
  } finally { await diceContext.close(); }
});
