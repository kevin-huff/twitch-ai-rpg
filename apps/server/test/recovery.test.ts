import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import type { AiProvider, DirectorSnapshot, ProviderContext, AiDraft, PlanResult, ActionContract } from '@rpg/contracts';
import { buildApp } from '../src/app';
import { FakeAiProvider } from '../src/fake-provider';
import { createPool } from '../src/database';

const databaseUrl = process.env.TEST_DATABASE_URL;
const origin = 'http://localhost:3000';
const suite = databaseUrl ? describe : describe.skip;
suite('adversarial generation and stale input recovery', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let host: string; let player: string; let id: string; let state: DirectorSnapshot;
  const fake = new FakeAiProvider();
  let render: (context: ProviderContext) => Promise<AiDraft>;
  let plan: (context: ProviderContext) => Promise<PlanResult>;
  let rolls: number;
  const cookie = (headers: Record<string, unknown>) => String(headers['set-cookie']).split(';')[0]!;
  const request = (path: string, credential: string, payload?: unknown) => app.inject({ method: payload ? 'POST' : 'GET', url: path, headers: { origin, cookie: credential }, ...(payload ? { payload } : {}) });
  const post = (value: Record<string, unknown>, credential = host) => request(`/api/sessions/${id}/commands`, credential, { commandId: crypto.randomUUID(), ...value });
  async function act(type: string, extras: Record<string, unknown> = {}) {
    const response = await post({ type, ...(state.activeBeat ? { beatId: state.activeBeat.id, expectedBeatRevision: state.activeBeat.revision } : {}), ...extras });
    expect(response.statusCode, response.body).toBe(200); state = response.json().snapshot;
  }
  async function prepareAction() {
    await act('open_beat', { kind: 'action', expectedInputEpoch: state.session.inputEpoch });
    expect((await post({ type: 'save_submission', expectedSubmissionRevision: 0, expectedInputEpoch: state.session.inputEpoch, contextBeatId: state.activeBeat!.id, kind: 'act', text: '', intent: 'Open the archive', approach: 'Study the latch' }, player)).statusCode).toBe(200);
    state = (await request(`/api/sessions/${id}`, host)).json();
    await act('plan_beat', { submissionIds: state.submissions.filter((item) => ['queued', 'selected'].includes(item.status)).map((item) => item.id) });
    await act('approve_stakes', { classification: 'action', contracts: state.activeBeat!.contracts });
  }
  beforeEach(async () => {
    rolls = 0; render = (context) => fake.render(context); plan = (context) => fake.plan(context);
    const provider: AiProvider = { plan: (context) => plan(context), render: (context) => render(context) };
    app = await buildApp({ databaseUrl: databaseUrl!, hostToken: 'recovery-tests-host-credential', origin, provider, providerTimeoutMs: 100, rollDie: () => { rolls++; return 3; } });
    host = cookie((await request('/api/auth/host', '', { token: 'recovery-tests-host-credential' })).headers);
    const created = (await request('/api/sessions', host, { commandId: crypto.randomUUID() })).json(); id = created.sessionId;
    player = cookie((await request('/api/auth/redeem', '', { token: created.invites.find((invite: {role: string}) => invite.role === 'player').token })).headers);
    state = (await request(`/api/sessions/${id}`, host)).json();
  });
  afterEach(async () => { await app.close(); });

  it('invalidates approved stakes when the player changes selected input, and rejects an old input epoch', async () => {
    await prepareAction();
    const approved = structuredClone(state.activeBeat!);
    const submission = state.submissions[0]!;
    expect((await post({ type: 'save_submission', submissionId: submission.id, expectedSubmissionRevision: submission.revision, expectedInputEpoch: state.session.inputEpoch, contextBeatId: approved.id, kind: 'act', text: '', intent: 'Open another door', approach: 'Inspect another lock' }, player)).statusCode).toBe(200);
    expect((await post({ type: 'lock_beat', beatId: approved.id, expectedBeatRevision: approved.revision })).statusCode).toBe(409);
    expect(rolls).toBe(0);
    expect((await post({ type: 'save_submission', expectedSubmissionRevision: 0, expectedInputEpoch: 0, contextBeatId: null, kind: 'say', text: 'An old offline line' }, player)).statusCode).toBe(409);
  });

  it('preserves fixed dice on timeout and permits manual narration without another roll', async () => {
    await prepareAction(); await act('lock_beat'); const fixed = state.activeBeat!.resolution!.rolls;
    render = async () => new Promise<AiDraft>(() => {});
    await act('render_beat');
    expect(state.activeBeat!.lastError).toContain('failed'); expect(state.activeBeat!.phase).toBe('locked');
    await act('edit_script', { segments: [{ kind: 'narration', text: 'The approved outcome unfolds.', recipientCharacterIds: [], delivery: 'neutral' }] });
    await act('publish_beat', { expectedStateRevision: state.session.stateRevision, draftRevision: state.activeBeat!.draftRevision, textOnly: true });
    expect(state.history[0]!.rolls).toEqual(fixed); expect(rolls).toBe(2);
  });

  it('rejects invented player dialogue and unknown NPCs before public publication', async () => {
    await prepareAction(); await act('lock_beat');
    render = async () => ({ segments: [{ kind: 'player_dialogue', text: 'I give up.', recipientCharacterIds: [], delivery: 'neutral' }], continuity: [], directorSummary: '' } as unknown as AiDraft);
    await act('render_beat'); expect(state.activeBeat!.draft).toBeNull(); expect(state.activeBeat!.lastError).toContain('validation');
    render = async () => ({ segments: [{ kind: 'npc_dialogue', speakerNpcId: 'unknown-speaker', text: 'I know your secrets.', recipientCharacterIds: [], delivery: 'neutral' }], continuity: [], directorSummary: '' });
    await act('render_beat'); expect(state.activeBeat!.draft).toBeNull(); expect(state.history).toHaveLength(0); expect(rolls).toBe(2);
  });

  it('discards a late generation after manual replacement and marks its job cancelled', async () => {
    await prepareAction(); await act('lock_beat');
    let finish!: (draft: AiDraft) => void;
    render = () => new Promise<AiDraft>((resolve) => { finish = resolve; });
    const pending = post({ type: 'render_beat', beatId: state.activeBeat!.id, expectedBeatRevision: state.activeBeat!.revision });
    const deadline = Date.now() + 2000;
    while (!finish && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    state = (await request(`/api/sessions/${id}`, host)).json();
    await act('edit_script', { segments: [{ kind: 'narration', text: 'This is the director’s chosen script.', recipientCharacterIds: [], delivery: 'neutral' }] });
    finish({ segments: [{ kind: 'narration', text: 'Late unwanted replacement.', recipientCharacterIds: [], delivery: 'neutral' }], continuity: [], directorSummary: '' });
    expect((await pending).statusCode).toBe(409);
    state = (await request(`/api/sessions/${id}`, host)).json();
    expect(state.activeBeat!.draft!.segments[0]!.text).toContain('director');
    expect(state.jobs.at(-1)!.status).toBe('cancelled');
  });

  it('carries an unselected line into the next beat without changing the player’s authored input', async () => {
    await act('open_beat', { kind: 'conversation', expectedInputEpoch: state.session.inputEpoch });
    const firstBeatId = state.activeBeat!.id;
    for (const text of ['What happened to the owner?', 'Someone offered to sell the club to us.']) {
      expect((await post({ type: 'save_submission', expectedSubmissionRevision: 0, expectedInputEpoch: state.session.inputEpoch, contextBeatId: firstBeatId, kind: 'say', text, recipientNpcIds: [state.npcs[0]!.id] }, player)).statusCode).toBe(200);
    }
    state = (await request(`/api/sessions/${id}`, host)).json();
    const first = state.submissions.find((item) => item.text.startsWith('What'))!;
    const second = structuredClone(state.submissions.find((item) => item.id !== first.id)!);
    await act('plan_beat', { submissionIds: [first.id] });
    await act('approve_stakes', { classification: 'ordinary', contracts: [] });
    await act('lock_beat');
    await act('edit_script', { segments: [{ kind: 'narration', text: 'Mara considers the question.', recipientCharacterIds: [], delivery: 'neutral' }] });
    await act('publish_beat', { expectedStateRevision: state.session.stateRevision, draftRevision: state.activeBeat!.draftRevision, textOnly: true });
    expect(state.submissions.find((item) => item.id === second.id)).toEqual({ ...second, contextBeatId: null, status: 'queued' });
    expect(state.history[0]!.segments.some((segment) => segment.text === second.text)).toBe(false);
    await act('open_beat', { kind: 'conversation', expectedInputEpoch: state.session.inputEpoch });
    expect(state.activeBeat!.selectedSubmissionIds).toEqual([]);
    await act('plan_beat', { submissionIds: [second.id] });
    expect(state.activeBeat!.selectedSubmissionIds).toEqual([second.id]);
    expect(state.submissions.find((item) => item.id === second.id)!.text).toBe(second.text);
  });

  it('returns unlocked selected and queued lines to the queue when their beat is aborted', async () => {
    await act('open_beat', { kind: 'conversation', expectedInputEpoch: state.session.inputEpoch });
    for (const text of ['A selected question.', 'A waiting question.']) {
      expect((await post({ type: 'save_submission', expectedSubmissionRevision: 0, expectedInputEpoch: state.session.inputEpoch, contextBeatId: state.activeBeat!.id, kind: 'say', text }, player)).statusCode).toBe(200);
    }
    state = (await request(`/api/sessions/${id}`, host)).json();
    const original = structuredClone(state.submissions);
    await act('plan_beat', { submissionIds: [original[0]!.id] });
    await act('abort_beat', { reason: 'Change the scene order before anything is locked.' });
    for (const submission of original) expect(state.submissions.find((item) => item.id === submission.id)).toEqual({ ...submission, status: 'queued', contextBeatId: null });
    await act('open_beat', { kind: 'conversation', expectedInputEpoch: state.session.inputEpoch });
    await act('plan_beat', { submissionIds: original.map((item) => item.id) });
    expect(state.activeBeat!.selectedSubmissionIds).toHaveLength(2);
  });

  it('allows manually reviewed stakes after planning times out and publishes without a provider', async () => {
    await act('open_beat', { kind: 'action', expectedInputEpoch: state.session.inputEpoch });
    expect((await post({ type: 'save_submission', expectedSubmissionRevision: 0, expectedInputEpoch: state.session.inputEpoch, contextBeatId: state.activeBeat!.id, kind: 'act', text: '', intent: 'Open the archive', approach: 'Study the latch' }, player)).statusCode).toBe(200);
    state = (await request(`/api/sessions/${id}`, host)).json();
    const submission = state.submissions[0]!;
    plan = () => new Promise<PlanResult>(() => {});
    await act('plan_beat', { submissionIds: [submission.id] });
    expect(state.activeBeat!.phase).toBe('collecting');
    expect(state.activeBeat!.lastError).toContain('failed');
    const contract: ActionContract = {
      id: crypto.randomUUID(), version: 1, actorCharacterId: submission.characterId, helperCharacterIds: [], submissionIds: [submission.id],
      intent: submission.intent, approach: submission.approach, ruling: 'check', trait: 'wits', edge: 0, edgeReason: null, risk: 'normal', prerequisites: [], fallback: { kind: 'hold' },
      outcomes: {
        clean: { publicText: 'The archive opens.', effects: [] },
        costly: { publicText: 'The archive opens with a loud click.', effects: [] },
        setback: { publicText: 'The latch holds and the guard notices.', effects: [{ kind: 'track_delta', trackId: state.tracks.find((track) => track.kind === 'danger')!.id, delta: 2 }] },
      },
    };
    await act('approve_stakes', { classification: 'action', contracts: [contract] });
    await act('lock_beat');
    const fixed = structuredClone(state.activeBeat!.resolution!.rolls);
    await act('edit_script', { segments: [{ kind: 'narration', text: state.activeBeat!.resolution!.outcomes[0]!.publicText, recipientCharacterIds: [], delivery: 'neutral' }] });
    await act('publish_beat', { expectedStateRevision: state.session.stateRevision, draftRevision: state.activeBeat!.draftRevision, textOnly: true });
    expect(state.history[0]!.rolls).toEqual(fixed);
    expect(rolls).toBe(2);
    expect(state.session.actionRoundNumber).toBe(1);
  });


  it('rolls back publication when an approved fact ID belongs to another session', async () => {
    const secondId = (await request('/api/sessions', host, { commandId: crypto.randomUUID() })).json().sessionId;
    const other = (await request(`/api/sessions/${secondId}`, host)).json() as DirectorSnapshot;
    const protectedFact = other.facts[0]!;
    await prepareAction();
    const contracts = structuredClone(state.activeBeat!.contracts);
    for (const outcome of Object.values(contracts[0]!.outcomes)) outcome.effects = [{ kind: 'fact_add', factId: protectedFact.id, text: 'An unauthorized cross-session replacement.', visibility: 'public' }];
    await act('approve_stakes', { classification: 'action', contracts });
    await act('lock_beat');
    await act('edit_script', { segments: [{ kind: 'narration', text: 'A proposed scene.', recipientCharacterIds: [], delivery: 'neutral' }] });
    const response = await post({ type: 'publish_beat', beatId: state.activeBeat!.id, expectedBeatRevision: state.activeBeat!.revision, expectedStateRevision: state.session.stateRevision, draftRevision: state.activeBeat!.draftRevision, textOnly: true });
    expect(response.statusCode, response.body).toBe(409);
    state = (await request(`/api/sessions/${id}`, host)).json();
    const unchanged = (await request(`/api/sessions/${secondId}`, host)).json() as DirectorSnapshot;
    expect(unchanged.facts).toEqual(other.facts);
    expect(state.history).toHaveLength(0);
    expect(state.session.stateRevision).toBe(0);
    expect(state.activeBeat!.phase).toBe('draft_review');
  });


  it('stages countdown completion after approved action effects and ticks only committed action rounds', async () => {
    const countdown = state.tracks.find((track) => track.kind === 'countdown')!;
    const danger = state.tracks.find((track) => track.kind === 'danger')!;
    const pool = createPool(databaseUrl!);
    try {
      const data = (await pool.query('SELECT data FROM tracks WHERE id=$1', [countdown.id])).rows[0].data;
      await pool.query('UPDATE tracks SET data=$2 WHERE id=$1', [countdown.id, { ...data, current: 1, enabled: true, completionEffects: [{ kind: 'track_delta', trackId: danger.id, delta: 1 }] }]);
    } finally { await pool.end(); }
    state = (await request(`/api/sessions/${id}`, host)).json();
    await act('open_beat', { kind: 'conversation', expectedInputEpoch: state.session.inputEpoch });
    await post({ type: 'save_submission', expectedSubmissionRevision: 0, expectedInputEpoch: state.session.inputEpoch, contextBeatId: state.activeBeat!.id, kind: 'say', text: 'What do you know about the owner?' }, player);
    state = (await request(`/api/sessions/${id}`, host)).json();
    await act('plan_beat', { submissionIds: [state.submissions[0]!.id] });
    await act('approve_stakes', { classification: 'ordinary', contracts: [] });
    await act('lock_beat'); await act('render_beat'); await act('render_beat');
    expect(state.tracks.find((track) => track.id === countdown.id)!.current).toBe(1);
    await act('publish_beat', { expectedStateRevision: state.session.stateRevision, draftRevision: state.activeBeat!.draftRevision, textOnly: true });
    expect(state.tracks.find((track) => track.id === countdown.id)!.current).toBe(1);
    await prepareAction();
    const contracts = structuredClone(state.activeBeat!.contracts);
    for (const outcome of Object.values(contracts[0]!.outcomes)) outcome.effects = [{ kind: 'track_delta', trackId: countdown.id, delta: 1 }];
    await act('approve_stakes', { classification: 'action', contracts });
    await act('lock_beat');
    expect(state.activeBeat!.resolution!.effects).toContainEqual({ kind: 'track_delta', trackId: danger.id, delta: 1 });
    await act('render_beat'); await act('render_beat');
    expect(state.tracks.find((track) => track.id === countdown.id)!.current).toBe(1);
    await act('publish_beat', { expectedStateRevision: state.session.stateRevision, draftRevision: state.activeBeat!.draftRevision, textOnly: true });
    expect(state.tracks.find((track) => track.id === countdown.id)!.current).toBe(3);
    expect(state.tracks.find((track) => track.id === danger.id)!.current).toBe(1);
    expect(state.session.actionRoundNumber).toBe(1);
  });

  it('discards a delayed replan after the director approves and locks the existing stakes', async () => {
    await prepareAction();
    const approvedContracts = structuredClone(state.activeBeat!.contracts);
    let finishPlan!: (result: PlanResult) => void;
    plan = () => new Promise<PlanResult>((resolve) => { finishPlan = resolve; });
    const pending = post({ type: 'plan_beat', beatId: state.activeBeat!.id, expectedBeatRevision: state.activeBeat!.revision, submissionIds: state.activeBeat!.selectedSubmissionIds });
    const deadline = Date.now() + 2000;
    while (!finishPlan && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    state = (await request(`/api/sessions/${id}`, host)).json();
    await act('approve_stakes', { classification: 'action', contracts: approvedContracts });
    await act('lock_beat');
    const fixed = structuredClone(state.activeBeat!.resolution);
    finishPlan({ classification: 'ordinary', contracts: [], directorSummary: 'Late replacement' });
    expect((await pending).statusCode).toBe(409);
    state = (await request(`/api/sessions/${id}`, host)).json();
    expect(state.activeBeat!.phase).toBe('locked');
    expect(state.activeBeat!.contracts).toEqual(approvedContracts);
    expect(state.activeBeat!.resolution).toEqual(fixed);
    expect(state.jobs.at(-1)!.status).toBe('cancelled');
    expect(rolls).toBe(2);
  });


  it('rejects ordinary classification when selected input contains an action', async () => {
    await prepareAction();
    const response = await post({ type: 'approve_stakes', beatId: state.activeBeat!.id, expectedBeatRevision: state.activeBeat!.revision, classification: 'ordinary', contracts: [] });
    expect(response.statusCode).toBe(409);
    state = (await request(`/api/sessions/${id}`, host)).json();
    expect(state.activeBeat!.kind).toBe('action');
    expect(state.activeBeat!.classification).toBe('action');
    expect(state.activeBeat!.contracts).toHaveLength(1);
  });

  it('keeps an action round approved as ordinary an action round that ticks time', async () => {
    const countdown = state.tracks.find((track) => track.kind === 'countdown')!;
    const pool = createPool(databaseUrl!);
    try {
      const data = (await pool.query('SELECT data FROM tracks WHERE id=$1', [countdown.id])).rows[0].data;
      await pool.query('UPDATE tracks SET data=$2 WHERE id=$1', [countdown.id, { ...data, current: 1, enabled: true }]);
    } finally { await pool.end(); }
    await act('open_beat', { kind: 'action', expectedInputEpoch: state.session.inputEpoch });
    expect((await post({ type: 'save_submission', expectedSubmissionRevision: 0, expectedInputEpoch: state.session.inputEpoch, contextBeatId: state.activeBeat!.id, kind: 'say', text: 'Do you remember the previous owner?', recipientNpcIds: [state.npcs[0]!.id] }, player)).statusCode).toBe(200);
    state = (await request(`/api/sessions/${id}`, host)).json();
    await act('plan_beat', { submissionIds: [state.submissions[0]!.id] });
    await act('approve_stakes', { classification: 'ordinary', contracts: [] });
    expect(state.activeBeat!.kind).toBe('action');
    expect(state.session.mode).toBe('action');
    await act('lock_beat');
    expect(state.activeBeat!.resolution!.effects).toEqual([{ kind: 'track_delta', trackId: countdown.id, delta: 1 }]);
    await act('edit_script', { segments: [{ kind: 'narration', text: 'Mara pauses to consider the question.', recipientCharacterIds: [], delivery: 'neutral' }] });
    await act('publish_beat', { expectedStateRevision: state.session.stateRevision, draftRevision: state.activeBeat!.draftRevision, textOnly: true });
    expect(state.history[0]!.kind).toBe('action');
    expect(state.session.actionRoundNumber).toBe(1);
    expect(state.tracks.find((track) => track.id === countdown.id)!.current).toBe(2);
    expect(rolls).toBe(0);
  });

});
