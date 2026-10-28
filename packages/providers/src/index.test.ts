import { describe, expect, it, vi } from 'vitest';
import { BeatSchema, CharacterCardDefinitionSchema, SubmissionSchema, FIELD_GENERATION_FIELDS, allowsPremise,
  validateFieldGenerationText, type FieldGenerationField, type FieldGenerationRequest, type AiDraft, type ProviderContext } from '@rpg/contracts';
import { createLedgerState } from '@rpg/test-fixtures';
import { ClewdrAiProvider, ElevenLabsSpeechProvider, ProviderError, speechCacheKey } from './index.js';
import { FakeAiProvider } from '../../../apps/server/src/fake-provider.js';

function context(): ProviderContext {
  let sequence = 0;
  const state = createLedgerState('session', () => `entity-${++sequence}`);
  state.session.beatNumber = 2;
  state.session.status = 'live';
  const submission = SubmissionSchema.parse({
    id: 'submission', sessionId: state.session.id, characterId: state.characters[0].id,
    contextBeatId: 'beat', inputEpoch: 1, revision: 1, kind: 'say', text: 'What happened to the owner?',
    recipientNpcIds: [state.npcs[0].id], status: 'locked',
  });
  const beat = BeatSchema.parse({
    id: 'beat', sessionId: state.session.id, kind: 'conversation', phase: 'locked', revision: 4,
    inputEpoch: 1, sourceStateRevision: state.session.stateRevision,
    selectedSubmissionIds: [submission.id], lockedSubmissions: [submission], contracts: [],
    stakesApproved: true, classification: 'ordinary', inputSnapshotHash: 'saved-input', resolution: { rolls: [], outcomes: [], effects: [] },
    draft: null, draftRevision: 0, approvedContinuity: [], generation: 1, lastError: null,
  });
  return { state, beat, submissions: [submission], history: [] };
}

function draft(ctx: ProviderContext): AiDraft {
  return {
    segments: [
      { kind: 'narration', text: 'Mara sets the glass down.', recipientCharacterIds: [], delivery: 'neutral' },
      { kind: 'npc_dialogue', speakerNpcId: ctx.state.npcs[0].id, text: 'He disappeared. Why are you asking?', recipientCharacterIds: [ctx.state.characters[0].id], delivery: 'quiet' },
    ],
    continuity: [], directorSummary: 'Mara asks for their reason.',
  };
}

const rolledOutcome = { publicText: 'It goes as planned.', effects: [] };
function rolledContract(ctx: ProviderContext, id: string, actor: number, helpers: number[], submissionId: string, overrides: Record<string, unknown> = {}) {
  return {
    id, version: 1, actorCharacterId: ctx.state.characters[actor].id, helperCharacterIds: helpers.map((helper) => ctx.state.characters[helper].id),
    submissionIds: [submissionId], intent: 'Do the thing.', approach: 'Carefully.', ruling: 'check', trait: 'wits', edge: 0, edgeReason: null, risk: 'low',
    prerequisites: [], fallback: { kind: 'hold' },
    outcomes: { clean: rolledOutcome, costly: rolledOutcome, setback: rolledOutcome, critical: { publicText: 'It goes as badly as it could.', effects: [] } },
    ...overrides,
  };
}
function rolledPlan(contracts: unknown[], directorSummary = 'Every line rolls.') {
  return { classification: 'action', directorSummary, contracts };
}
function singleLinePlan(ctx: ProviderContext) {
  return rolledPlan([rolledContract(ctx, 'ask', 0, [], ctx.submissions[0].id)]);
}

function nativeResponse(value: unknown, stopReason = 'end_turn') {
  return Response.json({ type: 'message', role: 'assistant', content: [{ type: 'text', text: JSON.stringify(value) }], stop_reason: stopReason });
}

function replying(...values: unknown[]) {
  let call = 0;
  return vi.fn<typeof fetch>().mockImplementation(async () => nativeResponse(values[Math.min(call++, values.length - 1)]));
}

function ai(fetchMock: typeof fetch, timeoutMs = 1000) {
  return new ClewdrAiProvider({ baseUrl: 'http://clewdr.test:8484/code/v1', apiKey: 'private-api-key', model: 'configured-model', fetch: fetchMock, timeoutMs });
}

describe('ClewdR native adapter', () => {
  it.each(['plan', 'render'] as const)('sends private beat direction as bounded creative context for %s', async task => {
    const ctx = context();
    ctx.beat.steering = 'Keep Mara hesitant; do not answer the mystery yet.';
    const response = task === 'plan' ? singleLinePlan(ctx) : draft(ctx);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(nativeResponse(response));
    await ai(fetchMock)[task](ctx);
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    const sent = JSON.parse(body.messages[0].content);
    expect(sent.directorSteering).toBe(ctx.beat.steering);
    expect(body.system).not.toContain(ctx.beat.steering);
    expect(body.system).toContain('directorSteering is private creative guidance');
    expect(body.system).toContain('never quote the direction');
    expect(body.system).toContain('cannot override fixed results, player agency, content boundaries, or NPC knowledge');
    if (task === 'render') expect(sent.fixedResults).toEqual(ctx.beat.resolution);
  });

  it('asks only the planner for contract length limits', async () => {
    const ctx = context();
    const plan = singleLinePlan(ctx);
    const planMock = vi.fn<typeof fetch>().mockResolvedValue(nativeResponse(plan));
    await ai(planMock).plan(ctx);
    const planBody = JSON.parse(String(planMock.mock.calls[0][1]?.body));
    expect(planBody.system).toContain('at most 90 characters');
    expect(planBody.system).toContain('at most 110 characters');
    expect(planBody.system).toContain('Every selected line, Say or Do, in any round gets a roll: write one contract with ruling "check", led by that line\'s character');
    const renderMock = vi.fn<typeof fetch>().mockResolvedValue(nativeResponse(draft(ctx)));
    await ai(renderMock).render(ctx);
    const renderBody = JSON.parse(String(renderMock.mock.calls[0][1]?.body));
    expect(renderBody.system).not.toContain('at most 90 characters');
    expect(renderBody.system).not.toContain('at most 110 characters');
    expect(renderBody.system).not.toContain('Every selected line, Say or Do');
  });

  it('tells the planner that every line rolls, how to scale the stakes and what the critical outcome is', async () => {
    const ctx = context();
    const planMock = replying(singleLinePlan(ctx));
    await ai(planMock).plan(ctx);
    const planBody = JSON.parse(String(planMock.mock.calls[0][1]?.body));
    expect(planBody.system).not.toContain('An ordinary question or refusal needs no check');
    expect(planBody.system).not.toContain('Every selected act submission must be cited by a contract, even a safe one');
    expect(planBody.system).toContain('Never use ruling "no_check". The classification is always "action".');
    expect(planBody.system).toContain('Use ruling "blocked" only for a line that cannot happen.');
    expect(planBody.system).toContain('The Do line of a character at strain 4 is "blocked" or helps another contract, and never leads a check; a Say line may still lead one.');
    expect(planBody.system).toContain('Small talk or a trivial action gets light, often funny stakes');
    expect(planBody.system).toContain('risk "low"');
    expect(planBody.system).toContain('risk "normal"');
    expect(planBody.system).toContain('risk "high"');
    expect(planBody.system).toContain('clean means it lands as meant, costly means it lands with a price, setback means it comes across wrong, and critical means it comes across as badly as it possibly could');
    expect(planBody.system).toContain('carries a fourth outcome, "critical", used when both dice show 1');
    expect(planBody.system).toContain('a clear step beyond its setback');
    expect(planBody.system).toContain('at most 110 characters, with its own effects');
    expect(planBody.system).not.toContain('narrated as the worst turn');
    expect(JSON.parse(planBody.messages[0].content).rules).toContain('Both dice showing 1 is a critical failure, whatever the total.');
    const renderMock = vi.fn<typeof fetch>().mockResolvedValue(nativeResponse(draft(ctx)));
    await ai(renderMock).render(ctx);
    const renderBody = JSON.parse(String(renderMock.mock.calls[0][1]?.body));
    expect(renderBody.system).toContain('A "critical" band is narrated as the worst turn its outcome describes, in the tone its stakes set.');
    expect(renderBody.system).not.toContain('carries a fourth outcome');
    expect(renderBody.system).not.toContain('An ordinary question or refusal needs no check');
  });

  it('qualifies historical dialogue without teaching correction text to an uninformed NPC', async () => {
    const ctx = context();
    const npc = ctx.state.npcs[0];
    const oldText = 'The key is red.';
    const newText = 'The key is blue.';
    npc.knowledge = [{ id: 'retained', statement: oldText, category: 'belief', acquisition: 'witnessed', sourceEventId: 'correction', sourceEntityId: npc.id, learnedBeatNumber: 1 }];
    ctx.state.facts.push({ id: 'key', text: newText, visibility: 'public', sourceEventId: 'correction' });
    ctx.corrections = Array.from({ length: 15 }, (_, index) => ({ id: `correction-${index}`, publishedBeatId: `past-${index}`, beatNumber: index + 1, stateRevision: index + 2, recordedAt: '2026-10-22T00:00:00Z', publicText: `Correction notice: ${newText}` }));
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(nativeResponse(draft(ctx)));
    await ai(fetchMock).render(ctx);
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    const sent = JSON.parse(body.messages[0].content);
    expect(sent.corrections).toEqual(ctx.corrections.slice(-12).map(({ id, publishedBeatId, beatNumber, stateRevision }) => ({ id, publishedBeatId, beatNumber, stateRevision })));
    expect(JSON.stringify(body)).not.toContain(newText);
    expect(sent.npcs[0].knowledge[0]).toMatchObject({ statement: oldText, category: 'belief' });
    expect(body.system).toContain('Current state and each NPC\'s current sourced knowledge take precedence over recentNpcDialogue');
    expect(body.system).toContain('A retained belief is not a fact');
    expect(body.system).toContain('Neither correction notices nor directorSteering are evidence for continuity');
  });

  it('uses corrected sourced knowledge alongside the original dialogue', async () => {
    const ctx = context();
    const npc = ctx.state.npcs[0];
    npc.knowledge = [{ id: 'corrected', statement: 'The key is blue.', category: 'fact', acquisition: 'witnessed', sourceEventId: 'correction', sourceEntityId: npc.id, learnedBeatNumber: 1 }];
    ctx.state.facts.push({ id: 'key', text: 'The key is blue.', visibility: 'public', sourceEventId: 'correction' });
    ctx.history = [{ id: 'past', kind: 'conversation', beatNumber: 1, actionRoundNumber: 0, stateRevision: 1, publishedAt: '2026-10-22T00:00:00Z', rolls: [], outcomes: [], textOnly: true,
      segments: [{ id: 'old', kind: 'npc_dialogue', text: 'The key is red.', speaker: { entityId: npc.id, displayName: npc.displayName }, recipientCharacterIds: [], delivery: 'neutral', sourceSubmissionIds: [], voiceProfileId: null, ttsEnabled: false }] }];
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(nativeResponse(draft(ctx)));
    await ai(fetchMock).render(ctx);
    const sent = JSON.parse(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).messages[0].content);
    expect(sent.facts).toContainEqual({ id: 'key', text: 'The key is blue.' });
    expect(sent.npcs[0].knowledge[0]).toMatchObject({ statement: 'The key is blue.', category: 'fact' });
    expect(sent.recentNpcDialogue[0].text).toBe('The key is red.');
    expect(sent.directorSteering).toBe('');
  });

  it.each(['fact', 'belief'] as const)('keeps a recently corrected %s when older memories exceed the prompt budget', async category => {
    const ctx = context();
    const npc = ctx.state.npcs[0];
    const corrected = { id: 'old-memory', statement: category === 'fact' ? 'The key is blue.' : 'The key is red.', category, acquisition: 'witnessed' as const, sourceEventId: 'correction', sourceEntityId: npc.id, learnedBeatNumber: 1 };
    npc.knowledge = [corrected, ...Array.from({ length: 25 }, (_, index) => ({ ...corrected, id: `other-${index}`, statement: `Unrelated memory ${index}.`, sourceEventId: 'prior-event' }))];
    ctx.corrections = [{ id: 'correction', publishedBeatId: 'past', beatNumber: 1, stateRevision: 2, recordedAt: '2026-10-22T00:00:00Z', publicText: 'The key was blue.' }];
    ctx.history = [{ id: 'past', kind: 'conversation', beatNumber: 1, actionRoundNumber: 0, stateRevision: 1, publishedAt: '2026-10-22T00:00:00Z', rolls: [], outcomes: [], textOnly: true,
      segments: [{ id: 'old', kind: 'npc_dialogue', text: 'The key is red.', speaker: { entityId: npc.id, displayName: npc.displayName }, recipientCharacterIds: [], delivery: 'neutral', sourceSubmissionIds: [], voiceProfileId: null, ttsEnabled: false }] }];
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(nativeResponse(draft(ctx)));
    await ai(fetchMock).render(ctx);
    const sent = JSON.parse(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).messages[0].content);
    expect(sent.npcs[0].knowledge).toHaveLength(20);
    expect(sent.npcs[0].knowledge).toContainEqual(expect.objectContaining({ statement: corrected.statement, category, sourceEventId: 'correction' }));
    expect(sent.recentNpcDialogue[0].text).toBe('The key is red.');
  });

  it('uses a revealed fact only for a selected witness while withholding its private source and future locations', async () => {
    const ctx = context();
    const witness = ctx.state.npcs[0];
    const uninformed = ctx.state.npcs[1];
    const publicText = 'The courier carries the archive key.';
    ctx.state.facts.push({ id: 'revealed-fact', text: publicText, visibility: 'public', sourceEventId: 'reveal-event' });
    witness.knowledge.push({ id: 'witness-memory', statement: publicText, category: 'fact', acquisition: 'witnessed', sourceEventId: 'reveal-event', sourceEntityId: witness.id, learnedBeatNumber: 2 });
    witness.secrets = ['PRIVATE-REVEAL-CONDITION'];
    witness.hiddenIdentity = 'PRIVATE-IDENTITY';
    ctx.state.locations = [{ id: 'future-location', title: 'PRIVATE-LOCATION', description: 'PRIVATE-DESTINATION' }];
    for (const addressed of [witness, uninformed]) {
      ctx.submissions[0].recipientNpcIds = [addressed.id];
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(nativeResponse(singleLinePlan(ctx)));
      await ai(fetchMock).plan(ctx);
      const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
      const sent = JSON.parse(body.messages[0].content);
      expect(sent.facts.some((fact: { text: string }) => fact.text === publicText)).toBe(addressed.id === witness.id);
      expect(JSON.stringify(body)).not.toContain('PRIVATE-');
      if (addressed.id !== witness.id) expect(JSON.stringify(body)).not.toContain(publicText);
    }
    uninformed.status = 'offstage'; uninformed.communicationChannel = 'Radio';
    const remote = vi.fn<typeof fetch>().mockResolvedValue(nativeResponse(singleLinePlan(ctx)));
    await ai(remote).plan(ctx);
    expect(String(remote.mock.calls[0][1]?.body)).not.toContain(publicText);
  });
  it.each(['plan', 'render'] as const)('uses authored public context and agreed boundaries for %s without importing card drafts or template secrets', async task => {
    const ctx = context();
    ctx.state.session.brief = { premise: 'Find a silent research station.', genre: 'Science fiction', tone: 'Hopeful mystery', objectives: ['Restore the beacon'], playerHooks: ['You answered the call'], pacing: { conversationWords: 70, actionWords: 110 } };
    ctx.state.setup = { boundaries: ['No graphic injury'], boundariesRevision: 2, started: true, scenario: { templateId: 'PRIVATE-TEMPLATE', version: 3 } };
    ctx.state.characters[0].pronouns = 'they/them';
    ctx.state.characters[0].backstory = 'PRIVATE-BACKSTORY';
    ctx.state.characters[0].draft = CharacterCardDefinitionSchema.parse({ schemaVersion: 1, displayName: 'PRIVATE-DRAFT', traits: ctx.state.characters[0].traits, extensions: { secret: 'PRIVATE-EXTENSION' } });
    const response = task === 'plan' ? singleLinePlan(ctx) : draft(ctx);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(nativeResponse(response));
    await ai(fetchMock)[task](ctx);
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    const sent = JSON.parse(body.messages[0].content);
    expect(sent.scenario).toEqual(ctx.state.session.brief);
    expect(sent.boundaries).toEqual(['No graphic injury']);
    expect(sent.characters[0].pronouns).toBe('they/them');
    expect(body.system).toContain('agreed content boundaries');
    for (const forbidden of ['PRIVATE-TEMPLATE', 'PRIVATE-DRAFT', 'PRIVATE-EXTENSION', 'PRIVATE-BACKSTORY']) expect(JSON.stringify(body)).not.toContain(forbidden);
  });
  it('requests validated JSON through the native messages route with no streaming or tools', async () => {
    const ctx = context();
    const result = draft(ctx);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(nativeResponse(result));
    expect(await ai(fetchMock).render(ctx)).toEqual(result);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('http://clewdr.test:8484/code/v1/messages');
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('x-api-key')).toBe('private-api-key');
    expect(new Headers(init?.headers).get('anthropic-version')).toBe('2023-06-01');
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({ model: 'configured-model', stream: false });
    expect(body.tools).toBeUndefined();
    expect(body.system).toContain('JSON');
    expect(body.system).toContain('npc_dialogue');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('whitelists relevant context without private fields or offstage history', async () => {
    const ctx = context();
    const mara = ctx.state.npcs[0];
    mara.hiddenIdentity = 'HIDDEN-IDENTITY';
    mara.secrets = ['NPC-SECRET'];
    ctx.state.characters[0].secret = 'CHARACTER-SECRET';
    ctx.state.directorNotes = 'DIRECTOR-NOTE';
    ctx.state.facts.push({ id: 'secret-fact', text: 'SECRET-FACT', visibility: 'director', sourceEventId: 'hidden-event' });
    ctx.state.npcs[1].knowledge[0].statement = 'UNRELATED-NPC-KNOWLEDGE';
    ctx.history = [{
      id: 'past', kind: 'conversation', beatNumber: 1, actionRoundNumber: 0, stateRevision: 1,
      publishedAt: '2026-10-22T00:00:00Z', rolls: [], outcomes: [], textOnly: true,
      segments: [{ id: 'offstage-event', kind: 'narration', text: 'OFFSTAGE-EVENT', speaker: null,
        recipientCharacterIds: [], delivery: 'neutral', sourceSubmissionIds: [], voiceProfileId: null, ttsEnabled: false }],
    }];
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(nativeResponse(draft(ctx)));
    await ai(fetchMock).render(ctx);
    const body = String(fetchMock.mock.calls[0][1]?.body);
    for (const forbidden of ['HIDDEN-IDENTITY', 'NPC-SECRET', 'CHARACTER-SECRET', 'DIRECTOR-NOTE', 'SECRET-FACT', 'UNRELATED-NPC-KNOWLEDGE', 'OFFSTAGE-EVENT']) {
      expect(body).not.toContain(forbidden);
    }
    expect(body).toContain('Mara Vale');
    expect(body).toContain(mara.knowledge[0].statement);
    const sentContext = JSON.parse(JSON.parse(body).messages[0].content);
    expect(sentContext.npcs.map((npc: { displayName: string }) => npc.displayName)).toEqual(['Mara Vale']);
  });

  it('renders from locked inputs instead of a later queued line', async () => {
    const ctx = context();
    ctx.submissions = [{ ...ctx.submissions[0], text: 'LATER-UNLOCKED-LINE' }];
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(nativeResponse(draft(ctx)));
    await ai(fetchMock).render(ctx);
    expect(String(fetchMock.mock.calls[0][1]?.body)).toContain('What happened to the owner?');
    expect(String(fetchMock.mock.calls[0][1]?.body)).not.toContain('LATER-UNLOCKED-LINE');
  });

  it('instructs continuity to use exact supplied facts and classify new questions as claims or beliefs', async () => {
    const ctx = context();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(nativeResponse(draft(ctx)));
    await ai(fetchMock).render(ctx);
    const { system } = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(system).toContain('use category "fact" only when statement exactly matches');
    expect(system).toContain('facts[].text');
    expect(system).toContain('public fact_add text in fixedResults.effects');
    expect(system).toContain('including questions or requests heard in this beat');
    expect(system).toContain('must use category "claim" or "belief"');
  });

  it('accepts a rolled plan and rejects an invalid contract', async () => {
    const ctx = context();
    const result = singleLinePlan(ctx);
    expect(await ai(vi.fn<typeof fetch>().mockResolvedValue(nativeResponse(result))).plan(ctx)).toEqual(result);
    await expect(ai(replying({ ...result, contracts: [{ id: 'bad' }] })).plan(ctx)).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('accepts a blocked contract for a line that cannot happen without a critical outcome', async () => {
    const ctx = context();
    const outcomes = { clean: rolledOutcome, costly: rolledOutcome, setback: rolledOutcome };
    const result = rolledPlan([rolledContract(ctx, 'ask', 0, [], 'submission', { ruling: 'blocked', outcomes })]);
    const fetchMock = replying(result);
    expect(await ai(fetchMock).plan(ctx)).toEqual(result);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  describe('plan refusals', () => {
    function actLine(ctx: ProviderContext) {
      ctx.submissions[0] = { ...ctx.submissions[0], kind: 'act', text: '', intent: 'I check the clock.', approach: 'I walk over and look.' };
    }
    const noCritical = (ctx: ProviderContext) => {
      const { critical: _critical, ...outcomes } = rolledContract(ctx, 'ask', 0, [], 'submission').outcomes;
      return outcomes;
    };
    const cases: Array<[string, (ctx: ProviderContext) => unknown, string[]]> = [
      ['a classification other than action', (ctx) => ({ ...singleLinePlan(ctx), classification: 'ordinary' }), ['the classification must be "action"', '"ordinary"']],
      ['a needs_action classification', (ctx) => ({ ...singleLinePlan(ctx), classification: 'needs_action' }), ['the classification must be "action"']],
      ['an ordinary plan with no contracts', () => ({ classification: 'ordinary', contracts: [], directorSummary: 'A plain look.' }), ['the classification must be "action"']],
      ['a selected line that no contract cites', (ctx) => rolledPlan([rolledContract(ctx, 'other', 1, [], 'extra')]), ['is cited by no contract', 'line submission']],
      ['ruling no_check', (ctx) => rolledPlan([rolledContract(ctx, 'ask', 0, [], 'submission', { ruling: 'no_check' }), rolledContract(ctx, 'other', 1, [], 'extra')]), ['uses ruling "no_check"', 'Never use "no_check"']],
      ['a check without a critical outcome', (ctx) => rolledPlan([rolledContract(ctx, 'ask', 0, [], 'submission', { outcomes: noCritical(ctx) }), rolledContract(ctx, 'other', 1, [], 'extra')]), ['without outcomes.critical', 'a clear step beyond its setback']],
    ];
    function twoLines() {
      const ctx = context();
      const extra = SubmissionSchema.parse({
        id: 'extra', sessionId: ctx.state.session.id, characterId: ctx.state.characters[1].id,
        contextBeatId: 'beat', inputEpoch: 1, revision: 1, kind: 'say', text: 'And who are you?', recipientNpcIds: [ctx.state.npcs[0].id], status: 'locked',
      });
      ctx.submissions = [...ctx.submissions, extra];
      ctx.beat = { ...ctx.beat, selectedSubmissionIds: ctx.submissions.map((submission) => submission.id), lockedSubmissions: ctx.submissions };
      return ctx;
    }
    it.each(cases)('sends back %s once with the reason and accepts the corrected plan', async (_name, build, reasons) => {
      const ctx = twoLines();
      const refused = build(ctx);
      const corrected = rolledPlan([rolledContract(ctx, 'ask', 0, [], 'submission'), rolledContract(ctx, 'other', 1, [], 'extra')]);
      const fetchMock = replying(refused, corrected);
      expect(await ai(fetchMock).plan(ctx)).toEqual(corrected);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const first = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
      const second = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
      expect(second.system).toBe(first.system);
      expect(second.messages.slice(0, 2)).toEqual([first.messages[0], { role: 'assistant', content: JSON.stringify(refused) }]);
      expect(second.messages[2].role).toBe('user');
      for (const reason of reasons) expect(second.messages[2].content).toContain(reason);
    });

    it('sends back a Do-led check at 4 strain once and accepts the same character leading from a Say line', async () => {
      const ctx = context();
      actLine(ctx);
      ctx.state.characters[0].strain = 4;
      const refused = singleLinePlan(ctx);
      const blocked = rolledPlan([rolledContract(ctx, 'ask', 0, [], 'submission', {
        ruling: 'blocked', outcomes: { clean: rolledOutcome, costly: rolledOutcome, setback: rolledOutcome },
      })]);
      const fetchMock = replying(refused, blocked);
      expect(await ai(fetchMock).plan(ctx)).toEqual(blocked);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const second = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
      expect(second.messages[2].content).toContain('at 4 strain');
      expect(second.messages[2].content).toContain('lead a "check" from a Do line');
      expect(second.messages[2].content).toContain(ctx.state.characters[0].displayName);
    });

    it('accepts a check led from a Say line at 4 strain', async () => {
      const ctx = context();
      ctx.state.characters[0].strain = 4;
      const result = singleLinePlan(ctx);
      const fetchMock = replying(result);
      expect(await ai(fetchMock).plan(ctx)).toEqual(result);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('lets a Do line at 4 strain help another character\'s check', async () => {
      const ctx = twoLines();
      actLine(ctx);
      ctx.state.characters[0].strain = 4;
      const result = rolledPlan([{ ...rolledContract(ctx, 'other', 1, [0], 'extra'), submissionIds: ['extra', 'submission'], edge: 1, edgeReason: 'They work together.' }]);
      const fetchMock = replying(result);
      expect(await ai(fetchMock).plan(ctx)).toEqual(result);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('refuses two selected lines of one character in one contract and accepts the corrected plan', async () => {
      const ctx = twoLines();
      const second = SubmissionSchema.parse({
        id: 'again', sessionId: ctx.state.session.id, characterId: ctx.state.characters[0].id,
        contextBeatId: 'beat', inputEpoch: 1, revision: 1, kind: 'say', text: 'Answer me.', recipientNpcIds: [ctx.state.npcs[0].id], status: 'locked',
      });
      ctx.submissions = [...ctx.submissions, second];
      ctx.beat = { ...ctx.beat, selectedSubmissionIds: ctx.submissions.map((submission) => submission.id), lockedSubmissions: ctx.submissions };
      const refused = rolledPlan([
        { ...rolledContract(ctx, 'ask', 0, [], 'submission'), submissionIds: ['submission', 'again'] },
        rolledContract(ctx, 'other', 1, [], 'extra'),
      ]);
      const corrected = rolledPlan([
        rolledContract(ctx, 'ask', 0, [], 'submission'), rolledContract(ctx, 'again', 0, [], 'again'), rolledContract(ctx, 'other', 1, [], 'extra'),
      ]);
      const fetchMock = replying(refused, corrected);
      expect(await ai(fetchMock).plan(ctx)).toEqual(corrected);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const reply = JSON.parse(String(fetchMock.mock.calls[1][1]?.body)).messages[2].content;
      expect(reply).toContain('more than one selected line from the same character');
      expect(reply).toContain('leads its own contract');
    });

    it('counts a check whose critical outcome is blank as missing', async () => {
      const ctx = twoLines();
      const blank = { ...rolledContract(ctx, 'ask', 0, [], 'submission').outcomes, critical: { publicText: '   ', effects: [] } };
      const corrected = rolledPlan([rolledContract(ctx, 'ask', 0, [], 'submission'), rolledContract(ctx, 'other', 1, [], 'extra')]);
      const fetchMock = replying(rolledPlan([rolledContract(ctx, 'ask', 0, [], 'submission', { outcomes: blank }), rolledContract(ctx, 'other', 1, [], 'extra')]), corrected);
      expect(await ai(fetchMock).plan(ctx)).toEqual(corrected);
      expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body)).messages[2].content).toContain('without outcomes.critical');
    });

    it('sends back a rules refusal such as removing an item the character lacks, once, and uses the corrected plan', async () => {
      const ctx = twoLines();
      ctx.state.characters[0].possessions = [];
      const removal = { kind: 'inventory_remove', characterId: ctx.state.characters[0].id, item: 'Brass key' };
      const refused = rolledPlan([
        rolledContract(ctx, 'ask', 0, [], 'submission', { outcomes: { ...rolledContract(ctx, 'ask', 0, [], 'submission').outcomes, clean: { publicText: 'The key is spent.', effects: [removal] } } }),
        rolledContract(ctx, 'other', 1, [], 'extra'),
      ]);
      const corrected = rolledPlan([rolledContract(ctx, 'ask', 0, [], 'submission'), rolledContract(ctx, 'other', 1, [], 'extra')]);
      const fetchMock = replying(refused, corrected);
      expect(await ai(fetchMock).plan(ctx)).toEqual(corrected);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body)).messages[2].content)
        .toContain('The rules refused this plan: Cannot consume an item the character does not possess.');
    });

    it('fails after a second refusal without a third request and keeps the reason out of the message', async () => {
      const ctx = context();
      const fetchMock = replying({ ...singleLinePlan(ctx), classification: 'ordinary' });
      const error = await ai(fetchMock).plan(ctx).catch((caught) => caught);
      expect(error).toBeInstanceOf(ProviderError);
      expect(error).toMatchObject({ code: 'invalid_response' });
      expect(error.detail).toContain('the classification must be "action"');
      expect(error.message).not.toContain('ordinary');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('one action per line', () => {
    const outcome = { publicText: 'It goes as planned.', effects: [] };
    function lines(...owners: number[]) {
      const ctx = context();
      const submissions = owners.map((owner, index) => SubmissionSchema.parse({
        id: `line-${index}`, sessionId: ctx.state.session.id, characterId: ctx.state.characters[owner].id,
        contextBeatId: 'beat', inputEpoch: 1, revision: 1, kind: 'act', text: '', intent: `Intent ${index}.`, approach: `Approach ${index}.`, status: 'locked',
      }));
      ctx.submissions = submissions;
      ctx.beat = { ...ctx.beat, selectedSubmissionIds: submissions.map((submission) => submission.id), lockedSubmissions: submissions };
      return ctx;
    }
    function contract(ctx: ProviderContext, id: string, actor: number, helpers: number[], submissionId: string) {
      return {
        id, version: 1, actorCharacterId: ctx.state.characters[actor].id, helperCharacterIds: helpers.map((helper) => ctx.state.characters[helper].id),
        submissionIds: [submissionId], intent: 'Do the thing.', approach: 'Carefully.', ruling: 'check', trait: 'wits', edge: 0, edgeReason: null, risk: 'low',
        prerequisites: [], fallback: { kind: 'hold' },
        outcomes: { clean: outcome, costly: outcome, setback: outcome, critical: { publicText: 'It goes as badly as it could.', effects: [] } },
      };
    }
    const plan = (contracts: unknown[]) => ({ classification: 'action', directorSummary: 'Actions.', contracts });

    it('puts the one-action-per-line rule in the planner rules and the shown-first line in the system prompt', async () => {
      const ctx = context();
      const fetchMock = replying(singleLinePlan(ctx));
      await ai(fetchMock).plan(ctx);
      const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
      const sent = JSON.parse(body.messages[0].content);
      expect(sent.rules).toContain('One action per line: each selected line lets its character lead one contract, with its own roll, or help another character\'s contract. A character helps at most one contract per round, and never one they lead.');
      expect(sent.rules).not.toContain('One action per character');
      expect(body.system).toContain('continue from them instead of restating them');
    });

    it('accepts two contracts led by one character on that character\'s two lines', async () => {
      const ctx = lines(0, 0);
      const result = plan([contract(ctx, 'first', 0, [], 'line-0'), contract(ctx, 'second', 0, [], 'line-1')]);
      const fetchMock = replying(result);
      expect(await ai(fetchMock).plan(ctx)).toEqual(result);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('does not refuse seven contracts itself, leaving the refusal to the director', async () => {
      const ctx = lines(0, 0, 0, 1, 1, 2, 3);
      const owners = [0, 0, 0, 1, 1, 2, 3];
      const result = plan(owners.map((owner, index) => contract(ctx, `c${index}`, owner, [], `line-${index}`)));
      expect(await ai(replying(result)).plan(ctx)).toEqual(result);
    });

    it.each([
      ['leading two contracts with one line', () => { const ctx = lines(0, 1); return [ctx, [contract(ctx, 'a', 0, [], 'line-0'), contract(ctx, 'b', 0, [], 'line-0')], 'more actions than they have selected lines'] as const; }],
      ['helping two contracts', () => { const ctx = lines(0, 1, 2, 2); return [ctx, [contract(ctx, 'a', 0, [2], 'line-0'), contract(ctx, 'b', 1, [2], 'line-1')], 'helps at most one contract per round'] as const; }],
      ['helping your own contract', () => { const ctx = lines(0, 1); return [ctx, [contract(ctx, 'a', 0, [0], 'line-0'), contract(ctx, 'b', 1, [], 'line-1')], 'cannot help a contract they lead'] as const; }],
    ])('refuses %s twice and then fails', async (_name, build) => {
      const [ctx, contracts, reason] = build();
      const fetchMock = replying(plan([...contracts]));
      await expect(ai(fetchMock).plan(ctx)).rejects.toMatchObject({ code: 'invalid_response' });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const second = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
      expect(second.messages[2].content).toContain(reason);
    });
  });

  it('sends a refused draft back once with the reason and accepts the corrected draft', async () => {
    const ctx = context();
    const update = {
      kind: 'npc_knowledge', npcId: ctx.state.npcs[0].id, statement: 'The party asked about the owner.',
      category: 'fact', acquisition: 'told', sourceSubmissionIds: ['submission'], sourceEntityId: ctx.state.characters[0].id,
    };
    const corrected = { ...draft(ctx), continuity: [{ ...update, category: 'claim' }] };
    const fetchMock = replying({ ...draft(ctx), continuity: [update] }, corrected);
    expect(await ai(fetchMock).render(ctx)).toEqual(corrected);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const second = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(second.messages).toHaveLength(3);
    expect(second.messages[2].content).toContain('use "claim" or "belief"');
  });

  it('sends a plan with a tag in an intent back once and accepts the corrected plan', async () => {
    const ctx = context();
    const good = singleLinePlan(ctx);
    const refused = rolledPlan([rolledContract(ctx, 'ask', 0, [], ctx.submissions[0].id, { intent: '[sighs] I climb the fire escape.' })]);
    const fetchMock = replying(refused, good);
    expect(await ai(fetchMock).plan(ctx)).toEqual(good);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body)).messages[2].content).toContain('square-bracket tag in its intent');
  });

  it('sends a plan with a tag in an outcome publicText back once and accepts the corrected plan', async () => {
    const ctx = context();
    const good = singleLinePlan(ctx);
    const outcomes = { ...rolledContract(ctx, 'ask', 0, [], ctx.submissions[0].id).outcomes, costly: { publicText: '[laughs] It costs you.', effects: [] } };
    const refused = rolledPlan([rolledContract(ctx, 'ask', 0, [], ctx.submissions[0].id, { outcomes })]);
    const fetchMock = replying(refused, good);
    expect(await ai(fetchMock).plan(ctx)).toEqual(good);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body)).messages[2].content).toContain('square-bracket tag in its outcomes.costly.publicText');
  });

  it('sends a draft with a tag in segment text back once and accepts the corrected draft', async () => {
    const ctx = context();
    const good = draft(ctx);
    const refused = { ...good, segments: [{ ...good.segments[0], text: '[laughs] ' + good.segments[0].text }, ...good.segments.slice(1)] };
    const fetchMock = replying(refused, good);
    expect(await ai(fetchMock).render(ctx)).toEqual(good);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body)).messages[2].content).toContain('square-bracket tag in its text');
  });

  it('states the audio tag rules in the render prompt and the no-copy rule in the plan prompt', async () => {
    const ctx = context();
    const renderFetch = replying(draft(ctx));
    await ai(renderFetch).render(ctx);
    const render = JSON.parse(String(renderFetch.mock.calls[0][1]?.body)).system as string;
    expect(render).toContain('for every narration');
    expect(render).toContain('exactly the words of "text"');
    expect(render).toContain('Never put square brackets in "text"');
    expect(render).toContain('usually one to three tags a line, one per clause');
    expect(render).toContain('[whispers]');
    expect(render).toContain('Sound effects ([door creaking], [thunder rumbling]) belong only in narration, and sparingly');
    expect(render).toContain('Never use accent tags');
    expect(render).toContain('SSML such as <break>');
    expect(render).toContain('a critical failure should sound like one');
    const planFetch = replying(singleLinePlan(ctx));
    await ai(planFetch).plan(ctx);
    const plan = JSON.parse(String(planFetch.mock.calls[0][1]?.body)).system as string;
    expect(plan).toContain('Never copy square-bracket tags from player lines into contract intents or outcomes.');
    expect(plan).not.toContain('Audio tag rules');
  });

  it('keeps a voiceText whose words match its text once the tags are removed', async () => {
    const ctx = context();
    const tagged = draft(ctx);
    tagged.segments[0] = { ...tagged.segments[0], voiceText: '[quietly] Mara sets the glass [pause] down.' };
    const fetchMock = replying(tagged);
    expect(await ai(fetchMock).render(ctx)).toEqual(tagged);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['an unspaced em dash with a spaced tag', 'Wait\u2014you think he ran?', '[shocked] Wait\u2014[incredulous] you think he ran?'],
    ['an unspaced em dash with an unspaced tag', 'Wait\u2014you think he ran?', 'Wait\u2014[incredulous]you think he ran?'],
    ['a tag after an opening quotation mark', 'Mara leans in. "Run."', 'Mara leans in. "[whispers] Run."'],
    ['a tag after an unspaced ellipsis', 'I...I saw nothing.', 'I...[gulps] I saw nothing.'],
  ])('keeps a voiceText with %s', async (_name, text, voiceText) => {
    const ctx = context();
    const tagged = draft(ctx);
    tagged.segments[0] = { ...tagged.segments[0], text, voiceText };
    const fetchMock = replying(tagged);
    expect(await ai(fetchMock).render(ctx)).toEqual(tagged);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['words that differ from the text', '[quietly] Mara drops the glass.', 'differ from its text'],
    ['an angle-bracket tag', '[quietly] Mara sets the glass <break time="1s"/> down.', 'angle-bracket tag'],
  ])('sends back a voiceText with %s once and uses the corrected draft', async (_name, voiceText, reason) => {
    const ctx = context();
    const refused = draft(ctx);
    refused.segments[0] = { ...refused.segments[0], voiceText };
    const corrected = draft(ctx);
    corrected.segments[0] = { ...corrected.segments[0], voiceText: '[quietly] Mara sets the glass down.' };
    const fetchMock = replying(refused, corrected);
    expect(await ai(fetchMock).render(ctx)).toEqual(corrected);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const content = JSON.parse(String(fetchMock.mock.calls[1][1]?.body)).messages[2].content;
    expect(content).toContain('Segment 1');
    expect(content).toContain(reason);
  });

  it('drops a voiceText that still slips on the second reply and keeps the line', async () => {
    const ctx = context();
    const slipped = draft(ctx);
    slipped.segments[0] = { ...slipped.segments[0], voiceText: '[quietly] Mara drops the glass.' };
    const fetchMock = replying(slipped, slipped);
    const result = await ai(fetchMock).render(ctx);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.segments[0].text).toBe(slipped.segments[0].text);
    expect(result.segments[0]).not.toHaveProperty('voiceText');
  });

  it('still fails after two replies when shown text carries a tag', async () => {
    const ctx = context();
    const good = draft(ctx);
    const refused = { ...good, segments: [{ ...good.segments[0], text: '[laughs] ' + good.segments[0].text }, ...good.segments.slice(1)] };
    const fetchMock = replying(refused, refused);
    await expect(ai(fetchMock).render(ctx)).rejects.toBeInstanceOf(ProviderError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(['plan', 'render'] as const)('accepts final %s text and discards thinking and redacted-thinking metadata', async (task) => {
    const ctx = context();
    const result = task === 'plan'
      ? singleLinePlan(ctx)
      : draft(ctx);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      type: 'message', role: 'assistant', stop_reason: 'end_turn',
      content: [
        { type: 'thinking', thinking: 'PRIVATE-THOUGHT', signature: 'PRIVATE-SIGNATURE' },
        { type: 'thinking', thinking: '', signature: 'OMITTED-SIGNATURE' },
        { type: 'redacted_thinking', data: 'PRIVATE-ENCRYPTED-THOUGHT' },
        { type: 'text', text: JSON.stringify(result) },
      ],
    }));
    const actual = await ai(fetchMock)[task](ctx);
    expect(actual).toEqual(result);
    expect(JSON.stringify(actual)).not.toMatch(/PRIVATE|SIGNATURE|thinking/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(['max_tokens', 'refusal', 'tool_use'])('rejects nonfinal stop reason %s', async (reason) => {
    const ctx = context();
    const response = Response.json({
      type: 'message', role: 'assistant', stop_reason: reason,
      content: [
        { type: 'thinking', thinking: 'PRIVATE-THOUGHT', signature: 'PRIVATE-SIGNATURE' },
        { type: 'text', text: JSON.stringify(draft(ctx)) },
      ],
    });
    await expect(ai(vi.fn<typeof fetch>().mockResolvedValue(response)).render(ctx)).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('rejects thinking-only messages and malformed final JSON without exposing reasoning', async () => {
    const thinking = { type: 'thinking', thinking: 'PRIVATE-THOUGHT', signature: 'PRIVATE-SIGNATURE' };
    const redacted = { type: 'redacted_thinking', data: 'PRIVATE-ENCRYPTED-THOUGHT' };
    for (const content of [[thinking], [redacted], [thinking, redacted], [thinking, { type: 'text', text: '{incomplete' }]]) {
      const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ type: 'message', role: 'assistant', stop_reason: 'end_turn', content }));
      const error = await ai(fetchMock).render(context()).catch((caught) => caught);
      expect(error).toBeInstanceOf(ProviderError);
      expect(error).toMatchObject({ code: 'invalid_response' });
      expect(String(error.stack)).not.toContain('PRIVATE');
    }
  });

  it('rejects malformed, unknown, and tool content blocks even alongside valid final text', async () => {
    const ctx = context();
    for (const block of [
      { type: 'thinking', thinking: 'PRIVATE-THOUGHT' },
      { type: 'thinking', thinking: 7, signature: 'PRIVATE-SIGNATURE' },
      { type: 'thinking', thinking: '', signature: null },
      { type: 'redacted_thinking' },
      { type: 'redacted_thinking', data: { secret: 'PRIVATE-THOUGHT' } },
      { type: 'tool_use', id: 'tool', name: 'execute', input: {} },
      { type: 'unknown', text: 'PRIVATE-THOUGHT' },
      { type: 'text', text: 7 },
    ]) {
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
        type: 'message', role: 'assistant', stop_reason: 'end_turn',
        content: [block, { type: 'text', text: JSON.stringify(draft(ctx)) }],
      }));
      const error = await ai(fetchMock).render(ctx).catch((caught) => caught);
      expect(error).toBeInstanceOf(ProviderError);
      expect(error).toMatchObject({ code: 'invalid_response' });
      expect(String(error.stack)).not.toContain('PRIVATE');
    }
  });

  it.each(['unknown', 'offstage', 'player'])('rejects an invalid authored speaker: %s', async (variant) => {
    const ctx = context();
    const result = draft(ctx);
    if (variant === 'unknown') result.segments[1] = { ...result.segments[1], kind: 'npc_dialogue', speakerNpcId: 'invented-npc' };
    if (variant === 'offstage') ctx.state.npcs[0].status = 'offstage';
    const value = variant === 'player' ? { ...result, segments: [{ kind: 'player_dialogue', text: 'I agree.' }] } : result;
    await expect(ai(replying(value)).render(ctx)).rejects.toBeInstanceOf(ProviderError);
  });

  it('rejects invented continuity sources and promotion of a heard claim into fact', async () => {
    const ctx = context();
    const update = {
      kind: 'npc_knowledge', npcId: ctx.state.npcs[0].id, statement: 'The ledger was burned.',
      category: 'claim', acquisition: 'told', sourceSubmissionIds: ['invented-source'], sourceEntityId: ctx.state.characters[0].id,
    };
    for (const continuity of [[update], [{ ...update, sourceSubmissionIds: ['submission'], category: 'fact' }]]) {
      await expect(ai(replying({ ...draft(ctx), continuity })).render(ctx)).rejects.toMatchObject({ code: 'invalid_response' });
    }
  });

  it('accepts a sourced NPC claim without changing objective world facts', async () => {
    const ctx = context();
    const result = { ...draft(ctx), continuity: [{
      kind: 'npc_knowledge', npcId: ctx.state.npcs[0].id, statement: 'The party asked about the owner.',
      category: 'claim', acquisition: 'told', sourceSubmissionIds: ['submission'], sourceEntityId: ctx.state.characters[0].id,
    }] };
    expect(await ai(vi.fn<typeof fetch>().mockResolvedValue(nativeResponse(result))).render(ctx)).toEqual(result);
  });

  it('does not duplicate a mechanical fact as a new continuity proposal', async () => {
    const ctx = context();
    ctx.beat.resolution!.effects.push({ kind: 'fact_add', factId: 'new-fact', text: 'The archive door is open.', visibility: 'public' });
    const continuity = [{ kind: 'world_fact', factId: 'new-fact', text: 'The archive door is open.', visibility: 'public', sourceSubmissionIds: ['submission'] }];
    await expect(ai(replying({ ...draft(ctx), continuity })).render(ctx)).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('redacts provider response bodies and transport errors without automatic retry', async () => {
    for (const fetchMock of [
      vi.fn<typeof fetch>().mockResolvedValue(new Response('private-api-key SECRET-BODY', { status: 401 })),
      vi.fn<typeof fetch>().mockRejectedValue(new Error('private-api-key SECRET-TRANSPORT')),
    ]) {
      const error = await ai(fetchMock).render(context()).catch((caught) => caught);
      expect(error).toBeInstanceOf(ProviderError);
      expect(error.message).not.toMatch(/private-api-key|SECRET/);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  it('bounds a hanging fetch and aborts its signal', async () => {
    let signal: AbortSignal | null | undefined;
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      signal = init?.signal;
      return new Promise<Response>(() => {});
    });
    await expect(ai(fetchMock, 15).render(context())).rejects.toMatchObject({ code: 'timeout' });
    expect(signal?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('field generation', () => {
  const request = { field: 'scenario.premise', seed: 'A ruined station with a quiet beacon.' } as FieldGenerationRequest;

  it('keeps director instructions in request data and preserves field rules, privacy, and player direction', async () => {
    const input: FieldGenerationRequest = { field: 'character.backstory', seed: 'Focus on an apprenticeship', instructions: 'Build a desert courier.', characterContext: { kind: 'character', secret: 'PRIVATE-SECRET' } };
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(nativeResponse({ text: 'A courier learned the desert routes.' }));
    await expect(ai(fetchMock).generateField(input)).resolves.toEqual({ text: 'A courier learned the desert routes.' });
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(JSON.parse(body.messages[0].content)).toEqual(input);
    expect(body.system).toContain('director character instructions');
    expect(body.system).toContain('untrusted creative guidance');
    expect(body.system).toContain('Pronouns');
    expect(body.system).toContain('Do not reveal hidden identities or secrets');
    expect(body.system).toContain('Never put a double quote character inside a string value.');
    expect(body.system).not.toContain(input.instructions);
    expect(body.system).not.toContain('PRIVATE-SECRET');
  });

  it('uses instructions for an empty-card fake draft and still requires explicit pronouns', async () => {
    const fake = new FakeAiProvider();
    const input: FieldGenerationRequest = { field: 'character.backstory', seed: '', instructions: 'Build a desert courier.', characterContext: { kind: 'character', displayName: '' } };
    const output = await fake.generateField(input);
    expect(output.text).toContain('desert courier');
    expect(validateFieldGenerationText(input.field, output.text)).toBe(output.text);
    expect(await fake.generateField(input)).toEqual(output);
    await expect(fake.generateField({ ...input, field: 'character.pronouns' })).rejects.toThrow();
    expect(await fake.generateField({ ...input, field: 'character.pronouns', seed: 'they/them' })).toEqual({ text: 'they/them' });
  });

  it('uses current unsaved character facts as untrusted context with explicit privacy and coherence rules', async () => {
    const characterContext = {
      kind: 'npc' as const, displayName: 'Mara', role: 'Beacon keeper', appearance: 'Weathered coat',
      hiddenIdentity: 'PRIVATE-IDENTITY', secrets: ['PRIVATE-SECRET'], personality: ['Watchful'],
      knowledge: [{ statement: 'The beacon is failing', category: 'belief' as const }],
    };
    const input = { field: 'npc.appearance' as const, seed: '', characterContext };
    const result = { text: 'Mara wears a weathered coat with brass signal buttons.' };
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(nativeResponse(result));
    expect(await ai(fetchMock).generateField(input)).toEqual(result);
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(JSON.parse(body.messages[0].content)).toEqual(input);
    expect(body.system).toContain('untrusted character facts');
    expect(body.system).toContain('preserve supplied values in other fields');
    expect(body.system).toContain('description is primary');
    expect(body.system).toContain('Do not reveal hidden identities or secrets');
    expect(body.system).toContain('public name, role, or appearance');
    expect(body.system).toContain('only the selected field');
    expect(body.system).not.toContain('PRIVATE-');
  });

  it('combines an explicit description, optional premise and current character facts without adding response fields', async () => {
    const input = { field: 'character.backstory' as const, seed: 'Focus on the apprenticeship',
      premise: 'An isolated signal station.', characterContext: { kind: 'character' as const, displayName: 'Rook', specialty: 'Signal repair' } };
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(nativeResponse({ text: 'Rook learned signal repair at the station.' }));
    await expect(ai(fetchMock).generateField(input)).resolves.toEqual({ text: 'Rook learned signal repair at the station.' });
    expect(JSON.parse(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).messages[0].content)).toEqual(input);
    const invalidResponse = vi.fn<typeof fetch>().mockResolvedValue(nativeResponse({ text: 'Rook', characterContext: input.characterContext }));
    await expect(ai(invalidResponse).generateField(input)).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('keeps explicit-only fields dependent on a description even with useful character context', async () => {
    const fake = new FakeAiProvider();
    const fetchMock = vi.fn<typeof fetch>();
    for (const field of ['npc.limit', 'npc.limits', 'character.pronouns'] as const) {
      const characterContext = field.startsWith('npc.') ? { kind: 'npc' as const, displayName: 'Mara' }
        : { kind: 'character' as const, displayName: 'Rook' };
      for (const input of [{ field, seed: '', characterContext }, { field, seed: 'Explicit', characterContext, premise: 'A station' }]) {
        await expect(ai(fetchMock).generateField(input)).rejects.toMatchObject({ code: 'invalid_input' });
        await expect(fake.generateField(input)).rejects.toThrow();
      }
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('makes deterministic fake drafts reflect current identity and role while keeping private facts out of public fields', async () => {
    const fake = new FakeAiProvider();
    const characterContext = { kind: 'npc' as const, displayName: 'Mara', role: 'Beacon keeper',
      appearance: 'Weathered coat', hiddenIdentity: 'PRIVATE-IDENTITY', secrets: ['PRIVATE-SECRET'],
      motivation: 'PRIVATE-MOTIVATION', knowledge: [{ statement: 'PRIVATE-KNOWLEDGE', category: 'fact' as const }] };
    for (const field of ['npc.displayName', 'npc.role', 'npc.appearance'] as const) {
      const input = { field, seed: '', characterContext };
      const result = await fake.generateField(input);
      expect(result.text).toContain('Mara');
      expect(result.text).toContain('Beacon keeper');
      expect(result.text).not.toContain('PRIVATE-');
      expect(await fake.generateField(input)).toEqual(result);
      expect(validateFieldGenerationText(field, result.text)).toBe(result.text);
      expect(await fake.generateField({ ...input, characterContext: { ...characterContext, displayName: 'Dax', role: 'Inspector' } })).not.toEqual(result);
      expect(await fake.generateField({ ...input, characterContext: { ...characterContext, hiddenIdentity: 'OTHER-PRIVATE', secrets: ['OTHER-SECRET'] } })).toEqual(result);
    }
  });

  it('reflects a character core description in fake private drafting without copying the secret into public appearance', async () => {
    const fake = new FakeAiProvider();
    const characterContext = { kind: 'character' as const, displayName: 'Rook', backstory: 'An apprentice signal keeper', secret: 'PRIVATE-SECRET' };
    const result = await fake.generateField({ field: 'character.personality', seed: '', characterContext });
    expect(result.text).toContain('Rook');
    expect(result.text).toContain('apprentice signal keeper');
    expect((await fake.generateField({ field: 'character.appearance', seed: '', characterContext })).text).not.toContain('PRIVATE-SECRET');
    expect(await fake.generateField({ field: 'npc.limits', seed: 'No spiders\nNo gore', characterContext: { kind: 'npc', displayName: 'Mara' } }))
      .toEqual({ text: 'No spiders\nNo gore' });
    expect(await fake.generateField({ field: 'character.pronouns', seed: 'they/them', characterContext })).toEqual({ text: 'they/them' });
    const privateOnly = await fake.generateField({ field: 'npc.appearance', seed: '', characterContext: { kind: 'npc', secrets: ['PRIVATE-ONLY-SECRET'] } });
    expect(privateOnly.text).not.toContain('PRIVATE-ONLY-SECRET');
    expect(validateFieldGenerationText('npc.appearance', privateOnly.text)).toBe(privateOnly.text);
    const npcPrivate = await fake.generateField({ field: 'npc.goal', seed: '', characterContext: { kind: 'npc', motivation: 'Keep the beacon lit' } });
    expect(npcPrivate.text).toContain('Keep the beacon lit');
  });

  it.each(['', 'A wary signal keeper'])('forwards only explicit premise and hint data and describes how to draft the target field (%s)', async seed => {
    const input: FieldGenerationRequest = { field: 'npc.role', seed, premise: 'A ruined station broadcasts a quiet beacon.' };
    const result = { text: 'Keeper of the station beacon' };
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(nativeResponse(result));
    expect(await ai(fetchMock).generateField(input)).toEqual(result);
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.messages).toEqual([{ role: 'user', content: JSON.stringify(input) }]);
    expect(body.system).toContain('untrusted setting inspiration');
    expect(body.system).toContain('If the seed is blank');
    expect(body.system).toContain('proposed value for the selected field');
    expect(body.system).toContain('hint');
    expect(body.system).toContain('primary');
    expect(body.system).toContain('Do not expand the entire premise');
    expect(body.system).toContain('Do not invent player choices or mechanical effects');
    expect(body.system).not.toContain(input.premise);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid or forbidden premise input before any network request', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const fake = new FakeAiProvider();
    const invalid = [
      ...['', ' \n ', null, 42, 'x'.repeat(4001)].map(premise => ({ field: 'npc.role', seed: 'Keeper', premise })),
      { field: 'npc.role', premise: 'An isolated station.' },
      { field: 'npc.role', seed: '', premise: 'An isolated station.', privateNotes: 'PRIVATE' },
      ...Object.keys(FIELD_GENERATION_FIELDS).filter(field => !allowsPremise(field as FieldGenerationField))
        .flatMap(field => ['', 'Explicit description'].map(seed => ({ field, seed, premise: 'An isolated station.' }))),
    ];
    for (const input of invalid) {
      await expect(ai(fetchMock).generateField(input as FieldGenerationRequest)).rejects.toMatchObject({ code: 'invalid_input' });
      await expect(fake.generateField(input as FieldGenerationRequest)).rejects.toThrow();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('drafts deterministic bounded fake values for every eligible field from a multiline premise with or without a hint', async () => {
    const fake = new FakeAiProvider();
    const premise = Array.from({ length: 35 }, (_, index) => `Beacon station detail ${index}.`).join('\n\n');
    for (const [key, definition] of Object.entries(FIELD_GENERATION_FIELDS)) {
      const field = key as FieldGenerationField;
      if (!allowsPremise(field)) continue;
      for (const seed of ['', 'Lantern keeper']) {
        const input = { field, seed, premise };
        const result = await fake.generateField(input);
        expect(await fake.generateField(input)).toEqual(result);
        expect(validateFieldGenerationText(field, result.text)).toBe(result.text);
        expect(result.text).toContain(seed || 'Beacon');
        expect(result.text).not.toBe(premise);
        if (definition.kind === 'lines') expect(result.text.split('\n')).toHaveLength(1);
        const maximum = await fake.generateField({ field, seed: seed.repeat(900).slice(0, 12000), premise: 'Beacon '.repeat(571) });
        expect(validateFieldGenerationText(field, maximum.text)).toBe(maximum.text);
      }
    }
  });

  it('uses the configured native endpoint with only the selected seed and server-owned field metadata', async () => {
    const result = { text: 'A ruined station broadcasts a quiet beacon from beneath the ice.' };
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(nativeResponse(result));
    expect(await ai(fetchMock).generateField(request)).toEqual(result);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('http://clewdr.test:8484/code/v1/messages');
    expect(new Headers(init?.headers).get('x-api-key')).toBe('private-api-key');
    expect(new Headers(init?.headers).get('anthropic-version')).toBe('2023-06-01');
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({ model: 'configured-model', stream: false });
    expect(body.tools).toBeUndefined();
    expect(body.messages).toEqual([{ role: 'user', content: JSON.stringify(request) }]);
    expect(body.system).toContain(FIELD_GENERATION_FIELDS[request.field].instruction);
    expect(body.system).toContain(String(FIELD_GENERATION_FIELDS[request.field].maxChars));
    expect(body.system).toContain('untrusted');
    expect(body.system).toContain('player choices');
    expect(body.system).not.toContain(request.seed);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid input and automatic context before contacting the provider', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    for (const input of [
      { ...request, seed: '' }, { ...request, seed: '  \n ' }, { ...request, seed: 'x'.repeat(12001) },
      { ...request, field: 'character.traits' }, { ...request, context: { secret: 'PRIVATE-CONTEXT' } },
      { ...request, instruction: 'OVERRIDE-INSTRUCTION' },
    ]) {
      await expect(ai(fetchMock).generateField(input as FieldGenerationRequest)).rejects.toMatchObject({ code: 'invalid_input' });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects blank, malformed and overlong results instead of truncating them', async () => {
    for (const value of [null, { text: 7 }, { text: '' }, { text: '  \n ' }, { text: 'valid', private: 'PRIVATE' },
      { text: 'x'.repeat(FIELD_GENERATION_FIELDS[request.field].maxChars + 1) }]) {
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(nativeResponse(value));
      await expect(ai(fetchMock).generateField(request)).rejects.toMatchObject({ code: 'invalid_response' });
    }
  });

  it('accepts every catalog field and preserves text exactly at its permitted boundary', async () => {
    for (const [key, definition] of Object.entries(FIELD_GENERATION_FIELDS)) {
      const text = 'x'.repeat(definition.kind === 'lines' ? definition.maxItemChars! : definition.maxChars);
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(nativeResponse({ text }));
      expect(await ai(fetchMock).generateField({ field: key as FieldGenerationField, seed: 'x'.repeat(12000) })).toEqual({ text });
      expect(JSON.parse(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).messages[0].content).seed).toHaveLength(12000);
    }
  });

  it('enforces every list field item count and individual item length', async () => {
    for (const [key, definition] of Object.entries(FIELD_GENERATION_FIELDS)) {
      if (definition.kind !== 'lines') continue;
      const input = { ...request, field: key as FieldGenerationField };
      for (const text of ['First\n\nSecond', 'x'.repeat(definition.maxItemChars! + 1),
        Array.from({ length: definition.maxItems! + 1 }, () => 'Item').join('\n')]) {
        const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(nativeResponse({ text }));
        await expect(ai(fetchMock).generateField(input)).rejects.toMatchObject({ code: 'invalid_response' });
      }
    }
  });

  it('discards thinking blocks and accepts only final JSON text', async () => {
    const result = { text: 'A quiet beacon flickers beneath a ruined station.' };
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      type: 'message', role: 'assistant', stop_reason: 'end_turn', content: [
        { type: 'thinking', thinking: 'PRIVATE-THOUGHT', signature: 'PRIVATE-SIGNATURE' },
        { type: 'redacted_thinking', data: 'PRIVATE-REDACTED' },
        { type: 'text', text: JSON.stringify(result) },
      ],
    }));
    expect(await ai(fetchMock).generateField(request)).toEqual(result);
  });

  it('keeps native failures bounded and sanitizes transport and response details without retries', async () => {
    const thinking = { type: 'thinking', thinking: 'PRIVATE-THOUGHT', signature: 'PRIVATE-SIGNATURE' };
    const variants = [
      vi.fn<typeof fetch>().mockResolvedValue(new Response('private-api-key PRIVATE-BODY', { status: 401 })),
      vi.fn<typeof fetch>().mockRejectedValue(new Error('private-api-key PRIVATE-TRANSPORT')),
      vi.fn<typeof fetch>().mockResolvedValue(nativeResponse({ text: 'PRIVATE-TRUNCATED' }, 'max_tokens')),
      vi.fn<typeof fetch>().mockResolvedValue(Response.json({ type: 'message', role: 'assistant', stop_reason: 'end_turn', content: [thinking] })),
      vi.fn<typeof fetch>().mockResolvedValue(Response.json({ type: 'message', role: 'assistant', stop_reason: 'end_turn', content: [thinking, { type: 'text', text: '{PRIVATE-MALFORMED' }] })),
      vi.fn<typeof fetch>().mockResolvedValue(new Response('x'.repeat(512001))),
    ];
    for (const fetchMock of variants) {
      const error = await ai(fetchMock).generateField(request).catch(caught => caught);
      expect(error).toBeInstanceOf(ProviderError);
      expect(String(error.stack)).not.toMatch(/private-api-key|PRIVATE/);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
    let signal: AbortSignal | null | undefined;
    const hanging = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      signal = init?.signal;
      return new Promise<Response>(() => {});
    });
    await expect(ai(hanging, 15).generateField(request)).rejects.toMatchObject({ code: 'timeout' });
    expect(signal?.aborted).toBe(true);
    expect(hanging).toHaveBeenCalledTimes(1);
  });

  it('generates deterministic bounded fake text for every field and preserves separate list seeds', async () => {
    const fake = new FakeAiProvider();
    for (const [key, definition] of Object.entries(FIELD_GENERATION_FIELDS)) {
      const input = { field: key as FieldGenerationField, seed: definition.kind === 'lines' ? 'Lantern\nCompass' : 'Lantern' };
      const result = await fake.generateField(input);
      expect(await fake.generateField(input)).toEqual(result);
      expect(validateFieldGenerationText(input.field, result.text)).toBe(result.text);
      expect(result.text).toContain('Lantern');
      const restriction = ['scenario.boundaries', 'npc.limits', 'npc.limit'].includes(key);
      if (restriction) expect(result.text).toBe(input.seed);
      else expect(result.text).not.toBe(input.seed);
      if (definition.kind === 'lines') expect(result.text.split('\n').some(line => line.includes('Compass'))).toBe(true);
      if (restriction) await expect(fake.generateField({ ...input, seed: 'Long seed '.repeat(1200) })).rejects.toThrow();
      else {
        const long = await fake.generateField({ ...input, seed: 'Long seed '.repeat(1200) });
        expect(validateFieldGenerationText(input.field, long.text)).toBe(long.text);
      }
    }
  });

  it.each(['scenario.boundaries', 'npc.limits', 'npc.limit'] as const)('preserves every supplied restriction in fake %s without adding or truncating wording', async field => {
    const seed = '  No gore.  \r\n No spiders.\r\nNo torture. \r\n No harm to children.  ';
    expect(await new FakeAiProvider().generateField({ field, seed })).toEqual({ text: 'No gore.\nNo spiders.\nNo torture.\nNo harm to children.' });
  });

  it.each(['scenario.boundaries', 'npc.limits', 'npc.limit'] as const)('rejects oversized fake %s restrictions instead of losing their meaning', async field => {
    const definition = FIELD_GENERATION_FIELDS[field];
    const fake = new FakeAiProvider();
    const limit = definition.kind === 'lines' ? definition.maxItemChars! : definition.maxChars;
    await expect(fake.generateField({ field, seed: `Never ${'x'.repeat(limit)}` })).rejects.toThrow();
    if (definition.kind === 'lines') {
      const seed = Array.from({ length: definition.maxItems! + 1 }, (_, index) => `No restricted subject ${index}.`).join('\n');
      await expect(fake.generateField({ field, seed })).rejects.toThrow();
    }
  });

  it('preserves all supplied fake list items and rejects excess item counts', async () => {
    const fake = new FakeAiProvider();
    for (const [key, definition] of Object.entries(FIELD_GENERATION_FIELDS)) {
      if (definition.kind !== 'lines') continue;
      const field = key as FieldGenerationField;
      const items = Array.from({ length: definition.maxItems! }, (_, index) => `Item ${index}`);
      const result = await fake.generateField({ field, seed: items.join('\n') });
      expect(result.text.split('\n')).toHaveLength(items.length);
      result.text.split('\n').forEach((line, index) => expect(line).toContain(items[index]));
      await expect(fake.generateField({ field, seed: [...items, 'Excess item'].join('\n') })).rejects.toThrow();
    }
  });
});

describe('ElevenLabs speech adapter', () => {
  const options = { apiKey: 'private-speech-key', model: 'configured-speech-model', voiceId: 'default-voice' };

  it('returns exact audio bytes with configured profile mapping', async () => {
    const bytes = new Uint8Array([73, 68, 51, 0, 255]);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(bytes, { headers: { 'content-type': 'audio/mpeg' } }));
    const provider = new ElevenLabsSpeechProvider({ ...options, voices: { voice_mara: 'mara-voice' }, fetch: fetchMock });
    expect(await provider.synthesize({ text: '  Why are you asking?\n', voiceProfileId: 'voice_mara' })).toEqual({ bytes, contentType: 'audio/mpeg' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://api.elevenlabs.io/v1/text-to-speech/mara-voice?output_format=mp3_44100_128');
    expect(new Headers(init?.headers).get('xi-api-key')).toBe('private-speech-key');
    expect(JSON.parse(String(init?.body))).toEqual({ text: '  Why are you asking?\n', model_id: 'configured-speech-model' });
  });

  it('uses the configured default voice and rejects blank, excessive, or marked-up text before fetch', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array([1]), { headers: { 'content-type': 'audio/mpeg' } }));
    const provider = new ElevenLabsSpeechProvider({ ...options, fetch: fetchMock });
    await provider.synthesize({ text: 'Hello.', voiceProfileId: 'unmapped' });
    expect(String(fetchMock.mock.calls[0][0])).toContain('/default-voice?');
    for (const text of ['   ', 'a'.repeat(6001), '<speak>hello</speak>', 'hello\u0000']) {
      await expect(provider.synthesize({ text, voiceProfileId: 'voice_mara' })).rejects.toMatchObject({ code: 'invalid_input' });
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects non-audio success responses and redacts HTTP failure details', async () => {
    for (const response of [Response.json({ error: 'private-speech-key' }), new Response('private-speech-key', { status: 429 })]) {
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response);
      const error = await new ElevenLabsSpeechProvider({ ...options, fetch: fetchMock }).synthesize({ text: 'Hello.', voiceProfileId: 'voice_mara' }).catch((caught) => caught);
      expect(error).toBeInstanceOf(ProviderError);
      expect(error.message).not.toContain('private-speech-key');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  it('times out without retrying synthesis', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => new Promise<Response>(() => {}));
    await expect(new ElevenLabsSpeechProvider({ ...options, fetch: fetchMock, timeoutMs: 15 }).synthesize({ text: 'Hello.', voiceProfileId: 'voice_mara' })).rejects.toMatchObject({ code: 'timeout' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keys cached audio by exact text, session scope, model, voice and delivery', () => {
    const key = { sessionId: 'one', text: 'Hello.', provider: 'elevenlabs', model: 'model', voiceId: 'voice', delivery: 'quiet' };
    expect(speechCacheKey(key)).toMatch(/^[a-f0-9]{64}$/);
    expect(speechCacheKey({ ...key })).toBe(speechCacheKey(key));
    for (const field of ['sessionId', 'text', 'provider', 'model', 'voiceId', 'delivery'] as const) {
      expect(speechCacheKey({ ...key, [field]: `${key[field]} ` })).not.toBe(speechCacheKey(key));
    }
  });
});
