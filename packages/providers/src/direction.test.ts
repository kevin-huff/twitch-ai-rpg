import { describe, expect, it, vi } from 'vitest';
import { BeatSchema, SubmissionSchema, type AiDraft, type ProviderContext } from '@rpg/contracts';
import { createLedgerState } from '@rpg/test-fixtures';
import { ClewdrAiProvider } from './index.js';

function context(kind: 'conversation' | 'action' = 'conversation'): ProviderContext {
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
    id: 'beat', sessionId: state.session.id, kind, phase: 'locked', revision: 4,
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
const bodyOf = (fetchMock: ReturnType<typeof vi.fn<typeof fetch>>, call = 0) => JSON.parse(String(fetchMock.mock.calls[call][1]?.body));

async function run(ctx: ProviderContext, task: 'plan' | 'render') {
  const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => reply(task === 'plan' ? plan(ctx) : draft(ctx)));
  await provider(fetchMock)[task](ctx);
  return { fetchMock, body: bodyOf(fetchMock) };
}

describe('the director\'s direction in the instructions', () => {
  const planText = 'The story heads for the harbour; the pace stays slow.';
  const standing = 'The fight lasts five rounds.';
  const steering = 'Keep Mara hesitant.';

  it.each(['plan', 'render'] as const)('puts each text in a block after every rule and before the schema for %s', async (task) => {
    const ctx = context();
    ctx.storyPlan = planText; ctx.standingNote = standing; ctx.beat.steering = steering;
    const { body } = await run(ctx, task);
    const lines = body.system.split('\n') as string[];
    const schema = lines.findIndex(line => line.startsWith('Required JSON schema:'));
    const intro = lines.findIndex(line => line.includes('Follow it as instructions'));
    expect(intro).toBeGreaterThan(-1);
    expect(lines[intro]).toContain('not from players or game data');
    expect(lines[intro]).toContain('Only the fixed dice and declared outcomes, the players\' own words and choices, the content boundaries, and what each character knows can limit it');
    expect(lines[intro]).toContain('Never quote it');
    expect(lines.slice(intro + 1, schema)).toEqual(['Plan for the show:', planText, 'Standing note:', standing, 'Note for this beat:', steering]);
    // Every other instruction sits before the block.
    expect(lines.slice(0, intro).some(line => line.startsWith('Continuity updates must cite'))).toBe(true);
    expect(lines.slice(schema + 1)).toEqual([]);
    for (const text of [planText, standing, steering]) expect(body.messages[0].content).not.toContain(text);
    const sent = JSON.parse(body.messages[0].content);
    expect(sent).not.toHaveProperty('directorSteering');
    expect(sent).not.toHaveProperty('directorStandingNote');
  });

  it('leaves out the parts that are not set', async () => {
    const ctx = context();
    ctx.standingNote = standing;
    const { body } = await run(ctx, 'render');
    expect(body.system).toContain(`Standing note:\n${standing}`);
    expect(body.system).not.toContain('Plan for the show:');
    expect(body.system).not.toContain('Note for this beat:');
  });

  it.each(['plan', 'render'] as const)('adds no block when all three are empty for %s', async (task) => {
    const ctx = context();
    ctx.storyPlan = ''; ctx.standingNote = ''; ctx.beat.steering = '';
    const { body } = await run(ctx, task);
    expect(body.system).not.toContain('Follow it as instructions');
    expect(body.system).not.toContain('Plan for the show:');
    expect(body.system).not.toContain('Standing note:');
    expect(body.system).not.toContain('Note for this beat:');
    const bare = await run(context(), task);
    expect(bare.body.system).toBe(body.system);
  });

  it('delivers a 12,000-character plan and 3,000-character notes whole', async () => {
    const ctx = context();
    ctx.storyPlan = `${'p'.repeat(11_999)}!`; ctx.standingNote = `${'s'.repeat(2_999)}!`; ctx.beat.steering = `${'b'.repeat(2_999)}!`;
    const { body } = await run(ctx, 'plan');
    expect(body.system).toContain(`Plan for the show:\n${ctx.storyPlan}\n`);
    expect(body.system).toContain(`Standing note:\n${ctx.standingNote}\n`);
    expect(body.system).toContain(`Note for this beat:\n${ctx.beat.steering}\n`);
  });
});

describe('effort for plans', () => {
  it('asks for low effort on a conversation plan, on the first attempt and on the corrected second', async () => {
    const ctx = context('conversation');
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(reply({ not: 'a plan' }))
      .mockResolvedValue(reply(plan(ctx)));
    await provider(fetchMock).plan(ctx);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bodyOf(fetchMock, 0).output_config).toEqual({ effort: 'low' });
    expect(bodyOf(fetchMock, 1).output_config).toEqual({ effort: 'low' });
    expect(JSON.stringify(bodyOf(fetchMock, 1).messages)).toContain('The application refused that reply');
  });

  it('sends no output_config for an action plan', async () => {
    const { body } = await run(context('action'), 'plan');
    expect(body).not.toHaveProperty('output_config');
  });

  it.each(['conversation', 'action'] as const)('sends no output_config for a %s render', async (kind) => {
    const { body } = await run(context(kind), 'render');
    expect(body).not.toHaveProperty('output_config');
  });
});
