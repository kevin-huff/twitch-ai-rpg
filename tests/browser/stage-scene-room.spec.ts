import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';

async function api(page: Page, path: string, body?: unknown, identity?: string) {
  return page.evaluate(async ({ path, body, identity }) => {
    const id = identity ?? new URL(location.href).searchParams.get('identity');
    const response = await fetch(`/api${path}`, { headers: { ...(id ? { 'X-RPG-Identity': id } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  }, { path, body, identity });
}

interface Measure {
  rolls: number;
  rollsInsideDice: boolean;
  rollTops: number[];
  diceHeight: number;
  linesHeight: number;
  fullRow: number;
  wagerCards: { bottom: number; wagerBottom: number; text: string }[];
  diceHeld: boolean;
  markerShown: boolean;
  textIssues: string[];
  outcomeLengths: number[];
  markerIssues: string[];
  spotlightName: string;
  detail: string;
}

// Reads every box the checks need in one pass so the numbers all come from the same frame.
function measure(page: Page, options: { checkNames: boolean }): Promise<Measure> {
  return page.evaluate(({ checkNames }) => {
    const box = (el: Element) => el.getBoundingClientRect();
    const story = document.querySelector<HTMLElement>('.stage-story')!;
    const lines = story.querySelector<HTMLElement>('.lines')!;
    const dice = story.querySelector<HTMLElement>('.dice');
    const wager = story.querySelector<HTMLElement>('.wager');
    const storyBox = box(story);
    const linesBox = box(lines);
    const diceBox = dice ? box(dice) : new DOMRect();
    const wagerBox = wager ? box(wager) : new DOMRect();
    const rolls = Array.from(story.querySelectorAll<HTMLElement>('.roll'));
    const diceShown = !!dice && getComputedStyle(dice).display !== 'none';
    const rollsInsideDice = !diceShown || rolls.every(roll => {
      const rect = box(roll);
      return rect.left >= diceBox.left - 0.5 && rect.right <= diceBox.right + 0.5 && rect.top >= diceBox.top - 0.5 && rect.bottom <= diceBox.bottom + 0.5;
    });
    const rollTops = diceShown ? Array.from(new Set(rolls.map(roll => Math.round(box(roll).top)))) : [];
    // The tallest visible stretch of one shown line that sits inside both the lines box and the story box.
    let fullRow = 0;
    for (const line of Array.from(story.querySelectorAll<HTMLElement>('.line[data-segment-id]'))) {
      if (line.classList.contains('off-page')) continue;
      const text = line.querySelector<HTMLElement>('.line-text');
      if (!text) continue;
      const rect = box(text);
      const left = Math.max(rect.left, linesBox.left, storyBox.left);
      const right = Math.min(rect.right, linesBox.right, storyBox.right);
      const top = Math.max(rect.top, linesBox.top, storyBox.top);
      const bottom = Math.min(rect.bottom, linesBox.bottom, storyBox.bottom);
      if (right > left) fullRow = Math.max(fullRow, bottom - top);
    }
    const wagerCards = Array.from(story.querySelectorAll<HTMLElement>('.wager-card')).map(card => {
      const visible = Array.from(card.children).filter(child => getComputedStyle(child).display !== 'none');
      const outcomes = visible.filter(child => child.classList.contains('wager-outcome') || child.classList.contains('wager-results'));
      const last = outcomes.at(-1) ?? visible.at(-1) ?? card;
      return { bottom: box(last).bottom, wagerBottom: wagerBox.bottom, text: (last.textContent ?? '').slice(0, 40) };
    });

    const textRange = (el: Element) => {
      const range = document.createRange();
      range.selectNodeContents(el.firstChild ?? el);
      return range;
    };
    const issues: string[] = [];
    // A wager text is whole when its block sits inside the wager and story boxes and nothing was clamped or clipped away.
    const wagerTextWhole = (el: HTMLElement) => {
      const label = `${el.className} "${(el.textContent ?? '').slice(0, 30)}"`;
      const block = getComputedStyle(el).display === 'inline' ? el.closest<HTMLElement>('p')! : el;
      const rect = box(block);
      const inside = (outer: DOMRect) => rect.left >= outer.left - 0.5 && rect.right <= outer.right + 0.5 && rect.top >= outer.top - 0.5 && rect.bottom <= outer.bottom + 0.5;
      if (!rect.width || !rect.height) issues.push(`${label}: not shown`);
      if (!inside(wagerBox)) issues.push(`${label}: outside the wager box`);
      if (!inside(storyBox)) issues.push(`${label}: outside the story box`);
      for (const target of new Set([el, block])) {
        if (target.scrollHeight > target.clientHeight + 1) issues.push(`${label}: scrollHeight ${target.scrollHeight} > clientHeight ${target.clientHeight}`);
        if (target.scrollWidth > target.clientWidth + 1) issues.push(`${label}: scrollWidth ${target.scrollWidth} > clientWidth ${target.clientWidth}`);
      }
      // Lift the line clamp for one synchronous moment to see how tall the whole text wants to be.
      const saved = block.getAttribute('style');
      const clamped = block.clientHeight;
      block.style.setProperty('-webkit-line-clamp', 'none');
      block.style.setProperty('line-clamp', 'none');
      block.style.setProperty('display', 'block');
      block.style.setProperty('overflow', 'visible');
      const natural = block.getBoundingClientRect().height;
      if (saved === null) block.removeAttribute('style'); else block.setAttribute('style', saved);
      if (natural > clamped + 1) issues.push(`${label}: clamped from ${Math.round(natural)} px to ${clamped} px`);
      const textRect = textRange(el).getBoundingClientRect();
      if (textRect.bottom > rect.bottom + 1) issues.push(`${label}: text ends at ${Math.round(textRect.bottom)}, below its block at ${Math.round(rect.bottom)}`);
    };
    const outcomeLengths: number[] = [];
    if (wager) {
      for (const card of Array.from(wager.querySelectorAll<HTMLElement>('.wager-card'))) {
        for (const text of Array.from(card.querySelectorAll<HTMLElement>('.wager-outcome-text'))) {
          outcomeLengths.push((text.textContent ?? '').length);
          wagerTextWhole(text);
        }
        const goal = card.querySelector<HTMLElement>('.wager-goal');
        if (goal) wagerTextWhole(goal);
      }
    }
    // The width a label wants on one line, measured on a hidden copy because an ellipsis shortens the Range of the real text.
    const wantedWidth = (el: HTMLElement) => {
      const style = getComputedStyle(el);
      const probe = document.createElement('span');
      probe.textContent = el.textContent;
      probe.style.cssText = `position:absolute;visibility:hidden;white-space:nowrap;font:${style.font};letter-spacing:${style.letterSpacing};text-transform:${style.textTransform}`;
      (el.parentElement ?? document.body).appendChild(probe);
      const width = probe.getBoundingClientRect().width;
      probe.remove();
      return Math.max(width, textRange(el).getBoundingClientRect().width);
    };
    // A label is whole when it ends inside its card's content box and renders as wide as its text.
    const labelWhole = (roll: HTMLElement, el: HTMLElement | null, what: string) => {
      if (!el) { issues.push(`${what}: missing`); return; }
      const style = getComputedStyle(roll);
      const content = box(roll).right - Number.parseFloat(style.paddingRight);
      const rect = box(el);
      const wanted = wantedWidth(el);
      const name = `${what} "${el.textContent}"`;
      if (rect.right > content + 0.5) issues.push(`${name}: right ${Math.round(rect.right)} > content ${Math.round(content)}`);
      if (rect.width < wanted - 0.2) issues.push(`${name}: renders ${rect.width.toFixed(2)} px wide for ${wanted.toFixed(2)} px of text`);
      if (el.scrollWidth > el.clientWidth + 1) issues.push(`${name}: scrollWidth ${el.scrollWidth} > clientWidth ${el.clientWidth}`);
    };
    if (diceShown) {
      for (const roll of rolls) {
        labelWhole(roll, roll.querySelector<HTMLElement>('.roll-result'), 'result');
        if (checkNames) labelWhole(roll, roll.querySelector<HTMLElement>('.roll-name'), 'name');
      }
    }

    // Visible text must end above the page marker.
    const marker = story.querySelector<HTMLElement>('.page-marker');
    const markerIssues: string[] = [];
    if (marker) {
      const markerTop = box(marker).top;
      for (const line of Array.from(story.querySelectorAll<HTMLElement>('.line[data-segment-id]'))) {
        if (line.classList.contains('off-page')) continue;
        const rect = box(line);
        if (!rect.height) continue;
        const bottom = Math.min(rect.bottom, linesBox.bottom);
        if (bottom > markerTop + 0.5) markerIssues.push(`line ends at ${Math.round(bottom)}, marker starts at ${Math.round(markerTop)}`);
      }
    }
    const round = (rect: DOMRect) => ({ top: Math.round(rect.top), bottom: Math.round(rect.bottom), height: Math.round(rect.height) });
    const detail = JSON.stringify({ story: round(storyBox), dice: round(diceBox), lines: round(linesBox), wager: round(wagerBox), rollTops, fullRow: Math.round(fullRow), pageMarker: !!marker });
    return {
      rolls: rolls.length, rollsInsideDice, rollTops, diceHeight: diceBox.height, linesHeight: linesBox.height, fullRow, wagerCards,
      diceHeld: !!dice?.classList.contains('dice-held'), markerShown: !!marker, textIssues: issues, outcomeLengths, markerIssues,
      spotlightName: wager?.querySelector('.wager-card .wager-name')?.textContent ?? '', detail,
    };
  }, options);
}

const MEDIUM = ['Seraphina Vale', 'Tobias Reed', 'Mara Quillon', 'Elena Torres', 'Jonah Pike', 'Lucia Ferrante'];
const LONG = ['Seraphina Quillon-Vale', 'Bartholomew Reed-Okoro', 'Magdalena Quillon-Ash', 'Elenora Torres-Whitby'];
const GOALS = [
  'Slip the ledger past the watchers on the stairs and out through the cellar door unseen',
  'Pick the lock on the iron cellar door before the guards return from their night rounds',
  'Talk the night porter into looking the other way for a full hour while the others work',
  'Carry the wounded courier up the coal chute and across the yard before the bells ring',
];
// Each text sits at the stage budget: a goal of at most 90 characters, each of the four outcomes (critical failure too) of at most 110.
const OUTCOMES = [
  { clean: 'You reach the river unseen, the ledger stays dry and whole, and the ferryman is already waiting for you.', costly: 'You reach the river with the ledger, but a watcher saw your lantern and follows you down to the water.', setback: 'The stairs creak, the watchers turn as one, and the ledger is left behind on the cold, hard stone steps.', critical: 'The watchers seize the ledger and you, and by dawn the whole city knows your name and what you tried to steal.' },
  { clean: 'The lock gives way at once and the heavy door swings open without a sound, leaving the cellar all yours.', costly: 'The lock opens, but the pick snaps loudly inside it and the noise carries upstairs to the waiting guards.', setback: 'The lock jams hard, the guards come back early, and you are caught in the hall with the pick in hand.', critical: 'The pick breaks off deep in the lock, the alarm wakes the house, and the cellar door is sealed for the night.' },
  { clean: 'The porter shrugs, pockets the coin, and sleeps soundly through the whole hour without asking a question.', costly: 'The porter agrees, but he will tell the captain who paid him, and why, the moment he is asked directly.', setback: 'The porter shouts for help, the alarm bell rings, and every door in the whole building is barred shut.', critical: 'The porter knocks you down the steps, takes your coin and knife, and sends a runner straight to the captain.' },
  { clean: 'The courier is carried clear of the yard and thanks you, then gives you the name of his master at last.', costly: 'The courier is saved, but his wound reopens on the way and he will need a good healer long before dawn.', setback: 'The chute collapses under you both and the courier is left behind in the dark, calling out for help.', critical: 'The chute gives way on top of you both, and the courier is lost while the bells bring the whole watch running.' },
];

// stakes is the number of pending wagers (0 drops them so the dice show); rolls is the number of dice cards; doubleText repeats each line so a page marker appears.
const CASES = [
  { label: 'one stake', stakes: 1, rolls: 4, names: MEDIUM, doubleText: false, maxDice: 0, minLines: 120, checkNames: false },
  { label: 'two stakes', stakes: 2, rolls: 4, names: MEDIUM, doubleText: false, maxDice: 0, minLines: 120, checkNames: false },
  { label: 'three stakes', stakes: 3, rolls: 4, names: MEDIUM, doubleText: false, maxDice: 0, minLines: 120, checkNames: false },
  { label: 'four stakes', stakes: 4, rolls: 4, names: MEDIUM, doubleText: false, maxDice: 0, minLines: 120, checkNames: false },
  { label: 'four medium names', stakes: 0, rolls: 4, names: MEDIUM, doubleText: false, maxDice: 210, minLines: 120, checkNames: true },
  { label: 'four long names', stakes: 0, rolls: 4, names: LONG, doubleText: false, maxDice: 210, minLines: 120, checkNames: true },
  { label: 'five names', stakes: 0, rolls: 5, names: MEDIUM, doubleText: true, maxDice: 180, minLines: 90, checkNames: false },
  { label: 'six names', stakes: 0, rolls: 6, names: MEDIUM, doubleText: true, maxDice: 180, minLines: 90, checkNames: false },
];

test.setTimeout(180000);

test('the full scene keeps the story lines, dice and stakes inside the story box for long names', async ({ page, browser }) => {
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

  // First round: published text-only with a narration line and two long non-player lines.
  await openRound('Search the cellar');
  await beat({ type: 'lock_beat' });
  await beat({ type: 'render_beat' });
  const npc = state.npcs.find((item: any) => item.status === 'present');
  const first = 'You came down here for the ledger, and I understand that. But there are people upstairs who would pay a great deal to keep it buried, and they have already sent two men to ask me where I hid it. I told them nothing, and I will tell you nothing either, not while that door stays shut.';
  const second = 'Listen to me carefully now. If you take that book out through the front door, they will know within the hour. Leave by the coal chute behind the boiler, and do not stop walking until you reach the river and the old ferry.';
  await beat({ type: 'edit_script', segments: [
    { kind: 'narration', speakerNpcId: null, recipientCharacterIds: [], delivery: 'neutral', text: 'The cellar goes quiet.' },
    { kind: 'npc_dialogue', speakerNpcId: npc.id, recipientCharacterIds: [], delivery: 'neutral', text: first },
    { kind: 'npc_dialogue', speakerNpcId: npc.id, recipientCharacterIds: [], delivery: 'neutral', text: second },
  ] });
  if (state.activeBeat.draft?.continuity?.length) await beat({ type: 'approve_continuity', updates: state.activeBeat.draft.continuity });
  await beat({ type: 'publish_beat', expectedStateRevision: state.session.stateRevision, draftRevision: state.activeBeat.draftRevision, textOnly: true });
  expect(state.history).toHaveLength(1);
  // Each Do line publishes first as its own Action line, one per player, before the three script lines.
  const published = state.history.at(-1).segments;
  expect(published.slice(0, 4).map((segment: any) => segment.kind)).toEqual(['player_action', 'player_action', 'player_action', 'player_action']);
  expect(published).toHaveLength(7);
  // The geometry cases below were built around exactly the three script lines, so the stream page does not see the four action lines.
  const segmentCount = published.filter((segment: any) => segment.kind !== 'player_action').length;
  expect(segmentCount).toBe(3);

  // Second round: opened with its stakes approved so the stakes panel shows beside the dice.
  await openRound('Leave by the coal chute');
  expect(state.activeBeat.contracts.length).toBeGreaterThan(0);

  const created = await api(page, `${path}/stream-links`, { commandId: randomUUID(), subject: 'show' });
  expect(created.status).toBe(200);
  const url = `/stream?layout=scene&audio=off#token=${encodeURIComponent(created.body.token)}`;

  for (const scenario of CASES) {
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    try {
      // Only this stream page sees the rewritten snapshot: more players, longer names, every roll a costly success but the last, a critical failure.
      await context.route(/\/api\/sessions\/[^/?]+\?view=stage$/, async route => {
        const response = await route.fetch();
        const body = await response.json();
        while (body.characters.length < scenario.rolls) {
          const n = body.characters.length;
          body.characters.push({ ...body.characters[n % 4], id: `extra-${n}` });
        }
        body.characters.forEach((character: any, index: number) => { character.displayName = scenario.names[index] ?? character.displayName; });
        const latest = body.history.at(-1);
        latest.segments = latest.segments.filter((segment: any) => segment.kind !== 'player_action');
        if (scenario.doubleText) for (const segment of latest.segments) segment.text = `${segment.text} ${segment.text}`;
        const baseRoll = latest.rolls[0];
        latest.rolls = Array.from({ length: scenario.rolls }, (_, index) => ({ ...baseRoll, id: `roll-${index}`, actorCharacterId: body.characters[index].id, band: 'costly', faces: [4, 3], edge: 1, total: 9 }));
        // The last roll is a double 1, so its Critical failure plate must fit whole beside the costly ones.
        latest.rolls[scenario.rolls - 1] = { ...latest.rolls[scenario.rolls - 1], band: 'critical', faces: [1, 1], edge: 0, total: 2 + baseRoll.traitModifier };
        if (!scenario.stakes) {
          if (body.activeBeat) delete body.activeBeat.stakes;
        } else if (body.activeBeat?.stakes?.length) {
          const stakes = body.activeBeat.stakes;
          body.activeBeat.stakes = Array.from({ length: scenario.stakes }, (_, index) => ({
            ...stakes[index % stakes.length], id: `stake-${index}`, actorCharacterId: body.characters[index].id,
            intent: GOALS[index % GOALS.length], outcomes: OUTCOMES[index % OUTCOMES.length],
          }));
        }
        await route.fulfill({ response, json: body });
      });
      const stream = await context.newPage();
      await stream.goto(url);
      await expect(stream.locator('.stage-story .line[data-segment-id]')).toHaveCount(segmentCount);
      await expect(stream.locator('.stage-story .roll')).toHaveCount(scenario.rolls);
      if (scenario.stakes) await expect(stream.locator('.stage-story .wager-row-item')).toHaveCount(scenario.stakes >= 2 ? scenario.stakes : 0);
      else await expect(stream.locator('.stage-story .wager')).toHaveCount(0);
      await stream.waitForTimeout(1500);

      const check = async (extra = '') => {
        const m = await measure(stream, { checkNames: scenario.checkNames });
        const where = `${scenario.label}${extra}: ${m.detail}`;
        expect(m.rolls, where).toBe(scenario.rolls);
        expect(m.diceHeld, where).toBe(scenario.stakes > 0);
        expect(m.rollsInsideDice, where).toBe(true);
        expect(m.linesHeight, where).toBeGreaterThanOrEqual(scenario.minLines);
        expect(m.fullRow, where).toBeGreaterThanOrEqual(30);
        expect(m.markerIssues, where).toEqual([]);
        if (scenario.doubleText) expect(m.markerShown, `${where} / the doubled text should need a second page`).toBe(true);
        if (scenario.stakes) {
          expect(m.textIssues, where).toEqual([]);
          expect(m.outcomeLengths.length, where).toBe(4);
          for (const length of m.outcomeLengths) expect(length, `${where} / outcome text length`).toBeGreaterThanOrEqual(100);
          expect(m.wagerCards.length, where).toBe(1);
          for (const card of m.wagerCards) expect(card.bottom, `${where} / stake: ${card.text}`).toBeLessThanOrEqual(card.wagerBottom + 0.5);
        } else {
          expect(m.rollTops.length, where).toBe(2);
          expect(m.diceHeight, where).toBeLessThanOrEqual(scenario.maxDice);
          expect(m.wagerCards.length, where).toBe(0);
          expect(m.textIssues, where).toEqual([]);
        }
        return m;
      };

      if (scenario.stakes === 1) {
        await expect(stream.locator('.stage-story .wager-marker')).toHaveCount(0);
        await expect(stream.locator('.stage-story .wager-list[data-count="1"] .wager-card')).toHaveCount(1);
        const m = await check(' / single card');
        expect(m.spotlightName, scenario.label).toBe(scenario.names[0]);
      } else if (scenario.stakes >= 2) {
        // Every actor takes the spotlight in turn; check each one's outcomes once its card is up.
        const marker = stream.locator('.stage-story .wager-marker');
        const seen = new Set<number>();
        for (let turn = 0; turn < scenario.stakes; turn++) {
          const text = (await marker.textContent())!;
          expect(text, scenario.label).toMatch(new RegExp(`^\\d+ of ${scenario.stakes}$`));
          const index = Number(/^(\d+) of /.exec(text)![1]) - 1;
          const m = await check(` / spotlight ${text}`);
          expect(m.spotlightName, text).toBe(scenario.names[index]);
          seen.add(index);
          if (turn < scenario.stakes - 1) {
            await expect(marker).not.toHaveText(text, { timeout: 15000 });
            await stream.waitForTimeout(600);
          }
        }
        expect(seen.size).toBe(scenario.stakes);
      } else {
        await check();
        // A critical failure fills its result plate with heart and sets every word on it in void; a costly roll keeps the night plate.
        const plates = await stream.evaluate(() => {
          const look = (selector: string) => {
            const roll = document.querySelector<HTMLElement>(selector)!;
            const color = (part: string) => getComputedStyle(roll.querySelector(part)!).color;
            return {
              plate: getComputedStyle(roll.querySelector('.roll-detail')!).backgroundColor,
              words: [color('.roll-name'), color('.roll-breakdown'), color('.roll-symbol'), color('.roll-result')],
              result: roll.querySelector('.roll-result')!.textContent,
            };
          };
          const root = getComputedStyle(document.documentElement);
          const token = (name: string) => {
            const probe = document.createElement('span');
            probe.style.color = root.getPropertyValue(name).trim();
            document.body.appendChild(probe);
            const value = getComputedStyle(probe).color;
            probe.remove();
            return value;
          };
          return { critical: look('.stage-story .roll[data-band="critical"]'), costly: look('.stage-story .roll[data-band="costly"]'), heart: token('--heart'), void: token('--void'), night: token('--night') };
        });
        expect(plates.critical.result, scenario.label).toBe('Critical failure');
        expect(plates.critical.plate, scenario.label).toBe(plates.heart);
        expect(plates.critical.words, scenario.label).toEqual([plates.void, plates.void, plates.void, plates.void]);
        expect(plates.costly.plate, scenario.label).toBe(plates.night);
      }
      await expect(stream.locator('.scene-reveal-titles, .scene-picture.revealing, .scene-picture.shrinking')).toHaveCount(0, { timeout: 10000 });
      await stream.screenshot({ path: test.info().outputPath(`scene-${scenario.label.replace(/\s+/g, '-')}.png`) });
    } finally { await context.close(); }
  }
});
