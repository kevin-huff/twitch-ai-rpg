import { describe, expect, it, vi } from 'vitest';
import { BeatSchema, SubmissionSchema, type ProviderContext } from '@rpg/contracts';
import { createLedgerState } from '@rpg/test-fixtures';
import { ClewdrAiProvider } from './index.js';

function context(withLine = true): ProviderContext {
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
    selectedSubmissionIds: withLine ? [submission.id] : [], lockedSubmissions: withLine ? [submission] : [], contracts: [],
    stakesApproved: true, classification: 'ordinary', inputSnapshotHash: 'saved-input', resolution: { rolls: [], outcomes: [], effects: [] },
    draft: null, draftRevision: 0, approvedContinuity: [], generation: 1, lastError: null,
  });
  return { state, beat, submissions: withLine ? [submission] : [], history: [] };
}

const piece = (text: string, answersSubmissionId?: string) => ({
  kind: 'narration' as const, text, recipientCharacterIds: [], delivery: 'neutral' as const, ...(answersSubmissionId ? { answersSubmissionId } : {}),
});
const reply = (value: unknown) => Response.json({ type: 'message', role: 'assistant', content: [{ type: 'text', text: JSON.stringify(value) }], stop_reason: 'end_turn' });
const provider = (fetchMock: typeof fetch) => new ClewdrAiProvider({ baseUrl: 'http://clewdr.test:8484/code/v1', apiKey: 'private-api-key', model: 'configured-model', fetch: fetchMock, timeoutMs: 1000 });

async function render(ctx: ProviderContext, segments: ReturnType<typeof piece>[]) {
  const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => reply({ segments, continuity: [], directorSummary: 'Mara waits.' }));
  const draft = await provider(fetchMock).render(ctx);
  return { draft, fetchMock, system: String(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).system) };
}

describe('reply marks', () => {
  it('states the paired play order and explains the mark in the render prompt only', async () => {
    const { system } = await render(context(), [piece('Mara sets the glass down.')]);
    expect(system).toContain('plays each player line and action word for word just before the first piece of your script that answers it');
    expect(system).toContain('plays lines that no piece answers before the script');
    expect(system).not.toContain('just before your script');
    expect(system).toContain('sets "answersSubmissionId" to that line\'s submission id');
    expect(system).toContain('leaves answersSubmissionId out');
    expect(system).toContain('Write the pieces in the order they should play');
    const plan = vi.fn<typeof fetch>().mockImplementation(async () => reply({}));
    await provider(plan).plan(context()).catch(() => undefined);
    const planSystem = String(JSON.parse(String(plan.mock.calls[0][1]?.body)).system);
    expect(planSystem).toContain('just before the first piece of your script that answers it');
    expect(planSystem).not.toContain('sets "answersSubmissionId"');
  });

  it('keeps a mark that names a selected player line', async () => {
    const { draft, fetchMock } = await render(context(), [piece('Mara answers.', 'submission'), piece('Then she waits.')]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(draft.segments[0]).toMatchObject({ answersSubmissionId: 'submission' });
    expect(draft.segments[1]).not.toHaveProperty('answersSubmissionId');
  });

  it('drops a mark that names no selected line without a refusal or a second call', async () => {
    const { draft, fetchMock } = await render(context(), [piece('Mara answers.', 'made-up-id'), piece('Then she waits.', 'submission')]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(draft.segments[0]).not.toHaveProperty('answersSubmissionId');
    expect(draft.segments[1]).toMatchObject({ answersSubmissionId: 'submission' });
  });

  it('drops every mark in a narrate-the-scene draft that has no player lines', async () => {
    const { draft, fetchMock } = await render(context(false), [piece('The rain falls.', 'submission')]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(draft.segments[0]).not.toHaveProperty('answersSubmissionId');
  });
});
