import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { AiDraft, DirectorSnapshot, PlanResult, ProviderContext, SessionState } from '@rpg/contracts';
import { buildApp } from '../src/app';
import { createPool, transaction } from '../src/database';
import { readState, saveState } from '../src/repository';
import { FakeAiProvider } from '../src/fake-provider';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const origin = 'http://localhost:3000';
const hostToken = 'live-character-test-host-credential';
const messages = {
  lobby: 'Start the show before changing a character during play.',
  running: 'The AI is planning or writing right now. Wait for it to finish, then save the change.',
  rolled: 'The dice for this round are already rolled. Publish or abandon the round, then change the look and items.',
  missing: 'That character is not in this show.',
  stale: "This character's look or items changed since you opened the form, for example in a published round. Press Cancel, then Edit look and items again.",
  stakes: "These stakes no longer match what the characters carry, for example after Edit look and items. Press Plan again for new stakes, or fix the items under Edit typed effects and approve again.",
};

suite('live look and items for a character', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let pool: ReturnType<typeof createPool>;
  let host: string, player: string, stage: string, sessionId: string;
  let snapshot: DirectorSnapshot;
  let contexts: ProviderContext[];
  let rolls: number;
  let die: number;
  const fake = new FakeAiProvider();
  let plan: (context: ProviderContext) => Promise<PlanResult>;
  let render: (context: ProviderContext) => Promise<AiDraft>;
  const options = { databaseUrl: databaseUrl!, hostToken, origin, serveStatic: false, providerTimeoutMs: 5000, rollDie: () => { rolls++; return die; },
    provider: { plan: (context: ProviderContext) => { contexts.push(context); return plan(context); }, render: (context: ProviderContext) => { contexts.push(context); return render(context); } } };
  const cookie = (response: { headers: Record<string, unknown> }) => String(response.headers['set-cookie']).split(';')[0]!;
  const request = (path: string, payload?: Record<string, unknown>, credential = host) => app.inject({ method: payload === undefined ? 'GET' : 'POST', url: path, headers: { origin, cookie: credential }, ...(payload === undefined ? {} : { payload }) });
  const command = (value: Record<string, unknown>, credential = host) => request(`/api/sessions/${sessionId}/commands`, { commandId: randomUUID(), ...value }, credential);
  const refresh = async () => { const response = await request(`/api/sessions/${sessionId}`); expect(response.statusCode, response.body).toBe(200); snapshot = response.json(); };
  async function ok(value: Record<string, unknown>) {
    const response = await command(value);
    expect(response.statusCode, response.body).toBe(200);
    snapshot = response.json().snapshot;
    return response;
  }
  const beatCommand = (type: string, value: Record<string, unknown> = {}) => ({ type, beatId: snapshot.activeBeat!.id, expectedBeatRevision: snapshot.activeBeat!.revision, ...value });
  const character = () => snapshot.characterDetails[0]!;
  const edit = (value: Record<string, unknown> = {}) => ({ type: 'save_live_character', characterId: character().id, expectedCharacterRevision: character().cardRevision, appearance: character().appearance, possessions: character().possessions, ...value });
  async function refused(value: Record<string, unknown>, status: number, message?: string) {
    const response = await command(value);
    expect(response.statusCode, response.body).toBe(status);
    if (message) expect(response.json().message).toBe(message);
    return response;
  }
  async function mutate(action: (state: SessionState) => void) {
    await transaction(pool, async (client) => { const state = await readState(client, sessionId); action(state); await saveState(client, state); });
    await refresh();
  }
  async function line(kind: 'say' | 'act') {
    const body = kind === 'say' ? { kind, text: 'A question for the room', recipientNpcIds: [] } : { kind, text: '', intent: 'Open the archive', approach: 'Study the latch' };
    const response = await command({ type: 'save_submission', expectedSubmissionRevision: 0, expectedInputEpoch: snapshot.session.inputEpoch, contextBeatId: snapshot.activeBeat?.id ?? null, ...body }, player);
    expect(response.statusCode, response.body).toBe(200);
    await refresh();
  }
  const queued = () => snapshot.submissions.filter((item) => item.status === 'queued' || item.status === 'selected').map((item) => item.id);
  async function openAction() {
    await ok({ type: 'open_beat', kind: 'action', expectedInputEpoch: snapshot.session.inputEpoch });
    await line('act');
  }
  const planBeat = () => ok(beatCommand('plan_beat', { submissionIds: queued() }));

  beforeAll(async () => {
    pool = createPool(databaseUrl!);
    app = await buildApp(options);
    host = cookie(await request('/api/auth/host', { token: hostToken }, ''));
  });
  beforeEach(async () => {
    contexts = []; rolls = 0; die = 4; plan = (value) => fake.plan(value); render = (value) => fake.render(value);
    const created = (await request('/api/sessions', { commandId: randomUUID() })).json(); sessionId = created.sessionId;
    player = cookie(await request('/api/auth/redeem', { token: created.invites[0].token }, ''));
    stage = cookie(await request('/api/auth/redeem', { token: created.invites.at(-1).token }, ''));
    await refresh();
    await ok({ type: 'set_status', status: 'live', expectedStateRevision: snapshot.session.stateRevision });
    await mutate((state) => { state.characters[0]!.appearance = 'A tall courier in a red cap'; state.characters[0]!.possessions = ['Brass bell', 'Red cap']; });
  });
  afterAll(async () => { await app?.close(); await pool.end(); });

  it('changes the look and items with no beat open, stamps the look, bumps the card and keeps the show moving state', async () => {
    const before = snapshot, card = character();
    expect(card.lookEditedAt).toBeNull();
    const response = await ok(edit({ appearance: 'A tall courier, bareheaded', possessions: ['Brass bell', '  Lantern  '] }));
    expect(character().appearance).toBe('A tall courier, bareheaded');
    expect(character().possessions).toEqual(['Brass bell', 'Lantern']);
    expect(character().lookEditedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(character().cardRevision).toBe(card.cardRevision + 1);
    expect(snapshot.session.stateRevision).toBe(before.session.stateRevision);
    expect(snapshot.session.inputEpoch).toBe(before.session.inputEpoch);
    expect(snapshot.activeBeat).toBeNull();
    const rows = (await pool.query("SELECT kind,data FROM audit_events WHERE command_id=$1", [response.json().commandId])).rows;
    expect(rows).toHaveLength(1); expect(rows[0].kind).toBe('save_live_character');
    expect(rows[0].data).toEqual({
      characterId: card.id,
      before: { appearance: 'A tall courier in a red cap', possessions: ['Brass bell', 'Red cap'], lookEditedAt: null },
      after: { appearance: 'A tall courier, bareheaded', possessions: ['Brass bell', 'Lantern'], lookEditedAt: character().lookEditedAt },
    });
    expect(Number((await pool.query("SELECT count(*) FROM facts WHERE session_id=$1", [sessionId])).rows[0].count)).toBe(before.facts.length);
    expect(snapshot.directorNotes).toBe(before.directorNotes);
  });

  it('keeps the look stamp empty when only the items change, and keeps an earlier stamp when the words stay the same', async () => {
    await ok(edit({ possessions: ['Lantern'] }));
    expect(character().possessions).toEqual(['Lantern']);
    expect(character().lookEditedAt).toBeNull();
    await ok(edit({ appearance: 'Soaked to the skin' }));
    const stamp = character().lookEditedAt;
    expect(stamp).not.toBeNull();
    await ok(edit({ possessions: [] }));
    expect(character().lookEditedAt).toBe(stamp);
    expect(character().possessions).toEqual([]);
  });

  it('works while paused and leaves the pause, the queued lines and the epoch alone', async () => {
    await line('say');
    await ok({ type: 'set_status', status: 'paused', expectedStateRevision: snapshot.session.stateRevision });
    const before = snapshot;
    await ok(edit({ appearance: 'Wrapped in a blanket' }));
    expect(snapshot.session.status).toBe('paused');
    expect(snapshot.session.stateRevision).toBe(before.session.stateRevision);
    expect(snapshot.session.inputEpoch).toBe(before.session.inputEpoch);
    expect(snapshot.submissions).toEqual(before.submissions);
  });

  it('works while a round is collecting and leaves queued and selected lines untouched', async () => {
    await ok({ type: 'open_beat', kind: 'conversation', expectedInputEpoch: snapshot.session.inputEpoch });
    await line('say');
    const before = snapshot;
    await ok(edit({ appearance: 'Dripping wet', possessions: ['Red cap'] }));
    expect(snapshot.submissions).toEqual(before.submissions);
    expect(snapshot.submissions.every((item) => item.status === 'queued')).toBe(true);
    expect(snapshot.activeBeat).toEqual(before.activeBeat);
    expect(snapshot.session.inputEpoch).toBe(before.session.inputEpoch);
  });

  it('works during stakes review and leaves the plan and its contracts as they were', async () => {
    await openAction();
    await planBeat();
    expect(snapshot.activeBeat!.phase).toBe('stakes_review');
    const before = snapshot;
    await ok(edit({ appearance: 'Cap gone, hair loose', possessions: ['Brass bell'] }));
    expect(snapshot.activeBeat).toEqual(before.activeBeat);
    expect(snapshot.activeBeat!.contracts).toEqual(before.activeBeat!.contracts);
    expect(snapshot.submissions).toEqual(before.submissions);
    expect(snapshot.session.stateRevision).toBe(before.session.stateRevision);
  });

  it('fails cleanly at Roll the dice when the approved stakes use an item that was removed, and Plan again recovers', async () => {
    await openAction();
    await planBeat();
    const planned = snapshot.activeBeat!.contracts;
    const actor = planned[0]!.actorCharacterId;
    const contracts = structuredClone(planned);
    contracts[0]!.outcomes.clean.effects = [{ kind: 'inventory_remove', characterId: actor, item: 'Brass bell' }] as never;
    const approved = await command(beatCommand('approve_stakes', { classification: 'action', contracts }));
    if (approved.statusCode !== 200) throw new Error(`approve_stakes refused: ${approved.body}`);
    snapshot = approved.json().snapshot;
    expect(snapshot.activeBeat!.contracts[0]!.outcomes.clean.effects).toHaveLength(1);
    await ok(edit({ possessions: ['Red cap'] }));
    expect(snapshot.activeBeat!.contracts[0]!.outcomes.clean.effects).toHaveLength(1);
    const lock = await command(beatCommand('lock_beat'));
    expect(lock.statusCode, lock.body).toBe(409);
    expect(lock.json().message).toBe(messages.stakes);
    expect(rolls).toBe(0);
    await refresh();
    expect(snapshot.activeBeat!.phase).toBe('stakes_review');
    expect(snapshot.activeBeat!.resolution).toBeNull();
    expect(Number((await pool.query('SELECT count(*) FROM action_contracts WHERE session_id=$1', [sessionId])).rows[0].count)).toBe(0);
    await planBeat();
    expect(snapshot.activeBeat!.phase).toBe('stakes_review');
    await ok(beatCommand('approve_stakes', { classification: 'action', contracts: snapshot.activeBeat!.contracts }));
    await ok(beatCommand('lock_beat'));
    expect(snapshot.activeBeat!.phase).toBe('locked');
  });

  async function bellContracts() {
    await openAction();
    await planBeat();
    const contracts = structuredClone(snapshot.activeBeat!.contracts);
    contracts[0]!.outcomes.clean.effects = [{ kind: 'inventory_remove', characterId: contracts[0]!.actorCharacterId, item: 'Brass bell' }] as never;
    return contracts;
  }

  it('refuses Approve and roll with a 409 when the AI stakes use an item that was removed, stores nothing, and Plan again recovers', async () => {
    const contracts = await bellContracts();
    const before = snapshot.activeBeat!;
    await ok(edit({ possessions: ['Red cap'] }));
    await refused(beatCommand('approve_stakes', { classification: 'action', contracts }), 409, messages.stakes);
    await refresh();
    const after = snapshot.activeBeat!;
    expect(after.phase).toBe('stakes_review');
    expect(after.contracts).toEqual(before.contracts);
    expect(after.generation).toBe(before.generation);
    expect(after.resolution).toBeNull();
    expect(Number((await pool.query('SELECT count(*) FROM action_contracts WHERE session_id=$1', [sessionId])).rows[0].count)).toBe(0);
    expect(rolls).toBe(0);
    await planBeat();
    await ok(beatCommand('approve_stakes', { classification: 'action', contracts: snapshot.activeBeat!.contracts }));
    await ok(beatCommand('lock_beat'));
    expect(snapshot.activeBeat!.phase).toBe('locked');
  });

  it('refuses a second approval with a 409 when the item was removed after the first approval', async () => {
    const contracts = await bellContracts();
    await ok(beatCommand('approve_stakes', { classification: 'action', contracts }));
    await ok(edit({ possessions: ['Red cap'] }));
    await refused(beatCommand('approve_stakes', { classification: 'action', contracts }), 409, messages.stakes);
    expect(rolls).toBe(0);
  });

  it('refuses stakes that add an item the character already holds with a 409', async () => {
    const contracts = await bellContracts();
    contracts[0]!.outcomes.clean.effects = [{ kind: 'inventory_add', characterId: contracts[0]!.actorCharacterId, item: 'Red cap' }] as never;
    await refused(beatCommand('approve_stakes', { classification: 'action', contracts }), 409, messages.stakes);
  });

  it('refuses stakes that give a character a twenty-first item with a 409', async () => {
    const contracts = await bellContracts();
    await ok(edit({ possessions: Array.from({ length: 20 }, (_, index) => `Item ${index + 1}`) }));
    contracts[0]!.outcomes.clean.effects = [{ kind: 'inventory_add', characterId: contracts[0]!.actorCharacterId, item: 'Lantern' }] as never;
    await refused(beatCommand('approve_stakes', { classification: 'action', contracts }), 409, messages.stakes);
  });

  it('reports a dice fault at Roll the dice as itself, not as stale stakes', async () => {
    const contracts = await bellContracts();
    contracts[0]!.outcomes.clean.effects = [];
    await ok(beatCommand('approve_stakes', { classification: 'action', contracts }));
    die = 7;
    await refused(beatCommand('lock_beat'), 400, 'Dice must return integer faces between one and six.');
    await refresh();
    expect(snapshot.activeBeat!.phase).toBe('stakes_review');
    expect(snapshot.activeBeat!.resolution).toBeNull();
  });

  it('keeps answering 400 when an edge has no reason', async () => {
    const contracts = await bellContracts();
    contracts[0]!.outcomes.clean.effects = [];
    contracts[0]!.edge = 1; contracts[0]!.edgeReason = '';
    await refused(beatCommand('approve_stakes', { classification: 'action', contracts }), 400, 'Edge requires an established reason.');
  });

  async function publishRound(effects: unknown[]) {
    await openAction();
    await planBeat();
    const contracts = structuredClone(snapshot.activeBeat!.contracts);
    for (const branch of [contracts[0]!.outcomes.clean, contracts[0]!.outcomes.costly, contracts[0]!.outcomes.setback]) branch.effects = structuredClone(effects) as never;
    await ok(beatCommand('approve_stakes', { classification: 'action', contracts }));
    await ok(beatCommand('lock_beat'));
    await ok(beatCommand('render_beat'));
    await ok(beatCommand('approve_continuity', { updates: snapshot.activeBeat!.draft!.continuity }));
    await ok(beatCommand('publish_beat', { expectedStateRevision: snapshot.session.stateRevision, draftRevision: snapshot.activeBeat!.draftRevision, textOnly: true }));
    await refresh();
  }

  it('raises the card revision when a published round removes an item, so an old form is refused and the item stays removed', async () => {
    const opened = character().cardRevision;
    await publishRound([{ kind: 'inventory_remove', characterId: character().id, item: 'Brass bell' }]);
    expect(character().possessions).toEqual(['Red cap']);
    expect(character().cardRevision).toBe(opened + 1);
    await refused(edit({ expectedCharacterRevision: opened, possessions: ['Brass bell', 'Red cap'] }), 409, messages.stale);
    await refresh();
    expect(character().possessions).toEqual(['Red cap']);
    await ok(edit({ appearance: 'Fresh form works' }));
    expect(character().appearance).toBe('Fresh form works');
  });

  it('raises the card revision when a published round swaps one item for another', async () => {
    const opened = character().cardRevision;
    await publishRound([{ kind: 'inventory_remove', characterId: character().id, item: 'Brass bell' }, { kind: 'inventory_add', characterId: character().id, item: 'Lantern' }]);
    expect(character().possessions).toEqual(['Red cap', 'Lantern']);
    expect(character().cardRevision).toBe(opened + 1);
    await refused(edit({ expectedCharacterRevision: opened, possessions: ['Brass bell', 'Red cap'] }), 409, messages.stale);
  });

  it('leaves the card revision alone when a published round changes no items', async () => {
    const opened = character().cardRevision;
    await publishRound([]);
    expect(character().possessions).toEqual(['Brass bell', 'Red cap']);
    expect(character().cardRevision).toBe(opened);
    await ok(edit({ expectedCharacterRevision: opened, appearance: 'Old form still fine' }));
    expect(character().appearance).toBe('Old form still fine');
  });

  it('refuses once the dice are rolled, in the locked and the draft review phases', async () => {
    await openAction();
    await planBeat();
    await ok(beatCommand('approve_stakes', { classification: 'action', contracts: snapshot.activeBeat!.contracts }));
    await ok(beatCommand('lock_beat'));
    expect(snapshot.activeBeat!.phase).toBe('locked');
    const before = snapshot;
    await refused(edit({ appearance: 'Too late' }), 409, messages.rolled);
    await ok(beatCommand('render_beat'));
    expect(snapshot.activeBeat!.phase).toBe('draft_review');
    await refused(edit({ appearance: 'Too late' }), 409, messages.rolled);
    await refresh();
    expect(character().appearance).toBe(before.characterDetails[0]!.appearance);
    expect(character().lookEditedAt).toBeNull();
  });

  it('refuses while the AI is planning, with the exact message, and saves once it finishes', async () => {
    await ok({ type: 'open_beat', kind: 'conversation', expectedInputEpoch: snapshot.session.inputEpoch });
    await line('say');
    let finish!: (result: PlanResult) => void;
    let started: ProviderContext | undefined;
    plan = (context) => { started = context; return new Promise<PlanResult>((resolve) => { finish = resolve; }); };
    const pending = command(beatCommand('plan_beat', { submissionIds: queued() }));
    const deadline = Date.now() + 3000;
    while (!started && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(started).toBeDefined();
    const response = await refused(edit({ appearance: 'Mid-plan change' }), 409, messages.running);
    expect(response.json().recoverable).toBe(true);
    finish(await fake.plan(started!));
    expect((await pending).statusCode).toBe(200);
    await refresh();
    expect(character().appearance).toBe('A tall courier in a red cap');
    await ok(edit({ appearance: 'After the plan' }));
    expect(character().appearance).toBe('After the plan');
  });

  it('refuses in the lobby, for an unknown character and for a stale revision', async () => {
    await refused(edit({ characterId: randomUUID() }), 404, messages.missing);
    await refused(edit({ expectedCharacterRevision: character().cardRevision + 1 }), 409, messages.stale);
    await ok(edit({ appearance: 'First change' }));
    await refused(edit({ expectedCharacterRevision: character().cardRevision - 1, appearance: 'Second change' }), 409, messages.stale);
    expect(character().appearance).toBe('First change');
    await pool.query('UPDATE sessions SET setup=$2 WHERE id=$1', [sessionId, { boundaries: [], boundariesRevision: 0, started: false, scenario: { templateId: 'legacy-scenario', version: 1 } }]);
    await refused(edit(), 409, messages.lobby);
    await pool.query("UPDATE sessions SET setup=NULL,status='lobby' WHERE id=$1", [sessionId]);
    await refused(edit(), 409, messages.lobby);
  });

  it('refuses players and stream pages and writes no audit row', async () => {
    for (const credential of [player, stage]) {
      const response = await command(edit({ appearance: 'Sneaky' }), credential);
      expect(response.statusCode, response.body).toBe(403);
    }
    expect((await command(edit(), '')).statusCode).toBe(401);
    await refresh();
    expect(character().appearance).toBe('A tall courier in a red cap');
    expect(Number((await pool.query("SELECT count(*) FROM audit_events WHERE session_id=$1 AND kind='save_live_character'", [sessionId])).rows[0].count)).toBe(0);
  });

  it('rejects a look over 1000 characters, an item over 160 and more than 20 items', async () => {
    const before = snapshot;
    await refused(edit({ appearance: 'x'.repeat(1001) }), 400);
    await refused(edit({ possessions: ['y'.repeat(161)] }), 400);
    await refused(edit({ possessions: Array.from({ length: 21 }, (_, index) => `Item ${index}`) }), 400);
    await refused(edit({ possessions: [''] }), 400);
    await ok(edit({ appearance: 'x'.repeat(1000), possessions: Array.from({ length: 20 }, (_, index) => `Item ${index}`) }));
    expect(character().possessions).toHaveLength(20);
    expect(before.characterDetails[0]!.cardRevision + 1).toBe(character().cardRevision);
  });

  it('shows the next plan the edited look and items', async () => {
    await ok(edit({ appearance: 'Bareheaded and wet', possessions: ['Lantern'] }));
    await openAction();
    contexts = [];
    await planBeat();
    const seen = contexts[0]!.state.characters.find((item) => item.id === character().id)!;
    expect(seen.appearance).toBe('Bareheaded and wet');
    expect(seen.possessions).toEqual(['Lantern']);
  });
});
