import { describe, expect, it, vi } from 'vitest';
import { BeatSchema, SubmissionSchema, type AiDraft, type ProviderContext, type PublishedBeat } from '@rpg/contracts';
import { createLedgerState } from '@rpg/test-fixtures';
import { ClewdrAiProvider } from './index.js';

function context(): ProviderContext {
  let sequence = 0;
  const state = createLedgerState('session', () => `entity-${++sequence}`);
  state.session.beatNumber = 4;
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

const outcome = { publicText: 'It goes as planned.', effects: [] };
function plan(ctx: ProviderContext) {
  return {
    classification: 'action', directorSummary: 'Every line rolls.',
    contracts: [{
      id: 'ask', version: 1, actorCharacterId: ctx.state.characters[0].id, helperCharacterIds: [], submissionIds: [ctx.submissions[0].id],
      intent: 'Do the thing.', approach: 'Carefully.', ruling: 'check', trait: 'wits', edge: 0, edgeReason: null, risk: 'low', prerequisites: [], fallback: { kind: 'hold' },
      outcomes: { clean: outcome, costly: outcome, setback: outcome, critical: { publicText: 'It goes as badly as it could.', effects: [] } },
    }],
  };
}
function draft(ctx: ProviderContext): AiDraft {
  return { segments: [{ kind: 'narration', text: 'Mara sets the glass down.', recipientCharacterIds: [], delivery: 'neutral' }], continuity: [], directorSummary: 'Mara waits.' };
}
const reply = (value: unknown) => Response.json({ type: 'message', role: 'assistant', content: [{ type: 'text', text: JSON.stringify(value) }], stop_reason: 'end_turn' });
const provider = (fetchMock: typeof fetch) => new ClewdrAiProvider({ baseUrl: 'http://clewdr.test:8484/code/v1', apiKey: 'private-api-key', model: 'configured-model', fetch: fetchMock, timeoutMs: 1000 });

async function run(ctx: ProviderContext, task: 'plan' | 'render') {
  const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => reply(task === 'plan' ? plan(ctx) : draft(ctx)));
  await provider(fetchMock)[task](ctx);
  const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
  return { body, sent: JSON.parse(body.messages[0].content) };
}

function beatOf(number: number, kind: 'conversation' | 'action', segments: Array<[string, string | null, string]>): PublishedBeat {
  return {
    id: `past-${number}`, kind, beatNumber: number, actionRoundNumber: 0, stateRevision: number, publishedAt: '2026-10-22T00:00:00Z',
    rolls: [], outcomes: [], textOnly: true,
    segments: segments.map(([segmentKind, speaker, text], index) => ({
      id: `s-${number}-${index}`, kind: segmentKind as 'narration', text, speaker: speaker ? { entityId: `who-${speaker}`, displayName: speaker } : null,
      recipientCharacterIds: [], delivery: 'neutral' as const, sourceSubmissionIds: [], voiceProfileId: null, ttsEnabled: false,
    })),
  };
}
const history = () => [
  beatOf(1, 'conversation', [['narration', null, 'Old news.']]),
  beatOf(2, 'action', [['narration', null, 'The door slams.'], ['system', null, 'Hidden roll note'], ['player_dialogue', 'Ada', 'Open up!'], ['npc_dialogue', 'Mara Vale', 'Not tonight.']]),
  beatOf(3, 'conversation', [['narration', null, 'Rain falls.']]),
];

describe('where the party came from', () => {
  it.each(['plan', 'render'] as const)('adds scene.cameFrom only when it is set (%s)', async (task) => {
    const ctx = context();
    expect((await run(ctx, task)).sent.scene).not.toHaveProperty('cameFrom');
    ctx.cameFrom = 'The Cellar';
    expect((await run(ctx, task)).sent.scene.cameFrom).toBe('The Cellar');
  });
});

describe('the last two beats', () => {
  it('sends the two newest beats, oldest first, with speakers and no system lines', async () => {
    const ctx = context();
    ctx.history = history();
    const { sent } = await run(ctx, 'plan');
    expect(sent.recentBeats).toEqual([
      { beatNumber: 2, kind: 'action', lines: [
        { kind: 'narration', speaker: null, text: 'The door slams.' },
        { kind: 'player_dialogue', speaker: 'Ada', text: 'Open up!' },
        { kind: 'npc_dialogue', speaker: 'Mara Vale', text: 'Not tonight.' },
      ] },
      { beatNumber: 3, kind: 'conversation', lines: [{ kind: 'narration', speaker: null, text: 'Rain falls.' }] },
    ]);
    expect(JSON.stringify(sent.recentBeats)).not.toContain('Hidden roll note');
  });

  it('sends an empty list with no history and one beat with one', async () => {
    const ctx = context();
    expect((await run(ctx, 'render')).sent.recentBeats).toEqual([]);
    ctx.history = history().slice(0, 1);
    expect((await run(ctx, 'render')).sent.recentBeats.map((beat: { beatNumber: number }) => beat.beatNumber)).toEqual([1]);
  });

  it.each([
    [0, [false, false]], [1, [false, true]], [2, [true, true]],
  ])('marks thisScene for sceneBeatCount %i', async (count, expected) => {
    const ctx = context();
    ctx.history = history();
    ctx.sceneBeatCount = count;
    const { sent } = await run(ctx, 'plan');
    expect(sent.recentBeats.map((beat: { thisScene: boolean }) => beat.thisScene)).toEqual(expected);
  });

  it('leaves thisScene out without sceneBeatCount', async () => {
    const ctx = context();
    ctx.history = history();
    const { sent } = await run(ctx, 'plan');
    for (const beat of sent.recentBeats) expect(beat).not.toHaveProperty('thisScene');
  });
});

describe('character motives and goals', () => {
  it('carry motivation and goal on each NPC sent and on no others', async () => {
    const ctx = context();
    const mara = ctx.state.npcs[0];
    const { sent, body } = await run(ctx, 'plan');
    expect(sent.npcs).toHaveLength(1);
    expect(sent.npcs[0]).toMatchObject({ id: mara.id, motivation: mara.motivation, goal: mara.goal });
    expect(mara.motivation).not.toBe('');
    for (const other of ctx.state.npcs.slice(1)) {
      expect(body.messages[0].content).not.toContain(other.motivation);
      expect(body.messages[0].content).not.toContain(other.goal);
    }
  });

  it('follows the on-stage picks and leaves secrets out', async () => {
    const ctx = context();
    ctx.aiCastNpcIds = [ctx.state.npcs[1].id];
    const { sent } = await run(ctx, 'render');
    expect(sent.npcs.map((npc: { id: string }) => npc.id).sort()).toEqual([ctx.state.npcs[0].id, ctx.state.npcs[1].id].sort());
    for (const npc of sent.npcs) expect(npc.goal).not.toBe('');
    expect(JSON.stringify(sent)).not.toContain('brass key');
  });
});

describe('the rules for arrival, recent beats and agendas', () => {
  it.each(['plan', 'render'] as const)('are in the %s instructions', async (task) => {
    const { body } = await run(context(), task);
    expect(body.system).toContain('When scene.cameFrom is present, the party has just arrived from that place and this is their first beat here, so treat it as an arrival.');
    expect(body.system).toContain('recentBeats is the public text of the last two published beats, to continue from without repeating.');
    expect(body.system).toContain('take precedence over recentNpcDialogue and recentBeats');
    expect(body.system).toContain('In each scene at most one NPC may push their own goal without being spoken to');
  });
});
