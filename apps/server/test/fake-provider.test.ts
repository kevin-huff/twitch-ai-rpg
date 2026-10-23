import { describe, expect, it } from 'vitest';
import { AiDraftSchema, type Beat, type ProviderContext, type Submission } from '@rpg/contracts';
import { validateContracts } from '@rpg/rules';
import { createLedgerState } from '@rpg/test-fixtures';
import { FakeAiProvider } from '../src/fake-provider';

function context(kind: 'conversation' | 'action' = 'conversation'): ProviderContext {
  let sequence = 0;
  const state = createLedgerState('fixture-session', () => `entity-${++sequence}`);
  const dax = state.npcs.find((npc) => npc.displayName === 'Inspector Dax')!;
  const submission: Submission = {
    id: 'submission', sessionId: state.session.id, characterId: state.characters[0]!.id,
    contextBeatId: 'beat', inputEpoch: 1, revision: 1, kind: 'say', text: 'Someone offered to sell the club to us.',
    recipientNpcIds: [dax.id], intent: '', approach: '', stageDirection: '', alreadySpokenAloud: true, status: 'locked',
  };
  const beat: Beat = {
    id: 'beat', sessionId: state.session.id, kind, phase: 'locked', revision: 1, inputEpoch: 1, sourceStateRevision: 0,
    selectedSubmissionIds: [submission.id], lockedSubmissions: [submission], contracts: [], stakesApproved: true,
    classification: kind === 'conversation' ? 'ordinary' : 'action', inputSnapshotHash: 'fixture-hash',
    resolution: { rolls: [], effects: [], outcomes: kind === 'action' ? [{ contractId: 'contract', actorCharacterId: submission.characterId,
      status: 'resolved', band: 'clean', goalAchieved: true, publicText: 'The archive opens quietly.' }] : [] },
    draft: null, draftRevision: 0, approvedContinuity: [], generation: 1, lastError: null,
  };
  return { state, beat, submissions: [submission], history: [] };
}

const provider = new FakeAiProvider();
describe('fake narrator speaker identity', () => {
  it('offers valid reviewable action stakes for an authored scenario without fixture tracks', async () => {
    const input = context('action');
    input.state.tracks = [];
    input.submissions[0]!.kind = 'act';
    input.submissions[0]!.intent = 'Restore the beacon';
    input.submissions[0]!.approach = 'Trace the broken power circuit';
    const result = await provider.plan(input);
    expect(() => validateContracts(result.contracts, input.state)).not.toThrow();
    expect(result.contracts[0]!.outcomes.clean.effects).toEqual([]);
    expect(result.contracts[0]!.outcomes.costly.effects).toEqual([{ kind: 'strain_delta', characterId: input.submissions[0]!.characterId, delta: 1 }]);
    expect(JSON.stringify(result)).not.toMatch(/security|archive|club/i);
  });
  it('does not import the Ledger story into an authored NPC’s sale memory', async () => {
    const input = context();
    const npc = input.state.npcs[1]!;
    npc.displayName = 'The Keeper';
    input.submissions[0]!.text = 'Someone offered to sell a star chart.';
    const result = await provider.render(input);
    expect(result.continuity[0]).toMatchObject({ category: 'claim', statement: 'The party said: Someone offered to sell a star chart.' });
    expect(JSON.stringify(result)).not.toMatch(/club|ledger|Mara|Dax/);
  });
  it('uses Dax’s identity and characterization when the filtered context contains only Dax', async () => {
    const input = context();
    input.state.npcs = input.state.npcs.filter((npc) => npc.displayName === 'Inspector Dax');
    const result = await provider.render(input);
    expect(AiDraftSchema.safeParse(result).success).toBe(true);
    const spoken = result.segments.find((segment) => segment.kind === 'npc_dialogue')!;
    expect(spoken.kind === 'npc_dialogue' && spoken.speakerNpcId).toBe(input.state.npcs[0]!.id);
    expect(result.segments.map((segment) => segment.text).join(' ')).toContain('Inspector Dax');
    expect(result.segments.map((segment) => segment.text).join(' ')).not.toMatch(/Mara|polishing|glass|survive the paperwork/);
    expect(spoken.text).toMatch(/form|inspection|permit/i);
  });

  it('honors addressed Dax for an action reaction even when Mara is also present', async () => {
    const input = context('action');
    const dax = input.state.npcs.find((npc) => npc.displayName === 'Inspector Dax')!;
    const result = await provider.render(input);
    const spoken = result.segments.find((segment) => segment.kind === 'npc_dialogue')!;
    expect(spoken.kind === 'npc_dialogue' && spoken.speakerNpcId).toBe(dax.id);
    expect(spoken.text).toMatch(/form|inspection|permit/i);
    expect(result.segments[0]!.text).toBe('The archive opens quietly.');
  });

  it.each(['conversation', 'action'] as const)('returns narration without inventing a speaker when a %s has no available NPC', async (kind) => {
    const input = context(kind);
    input.state.npcs = [];
    const result = await provider.render(input);
    expect(AiDraftSchema.safeParse(result).success).toBe(true);
    expect(result.segments.every((segment) => segment.kind === 'narration')).toBe(true);
    expect(result.continuity).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('Mara');
    if (kind === 'action') expect(result.segments[0]!.text).toBe('The archive opens quietly.');
  });

  it('preserves Mara’s established two-exchange fixture and sourced sale memory', async () => {
    const input = context();
    const mara = input.state.npcs.find((npc) => npc.displayName === 'Mara Vale')!;
    input.state.npcs = [mara];
    input.submissions[0]!.recipientNpcIds = [mara.id];
    input.submissions[0]!.text = 'You knew the previous owner. What happened to him?';
    const first = await provider.render(input);
    expect(first.segments[1]!.text).toBe('He learned the difference between owning this place and being allowed to keep it. Why are you asking?');
    input.submissions[0]!.text = 'Because someone just offered to sell it to us.';
    const second = await provider.render(input);
    expect(second.segments[1]!.text).toBe('Then someone expects you not to survive the paperwork. Show me the seller’s name.');
    expect(second.continuity).toContainEqual({ kind: 'npc_knowledge', npcId: mara.id, statement: 'The party reported a sale offer for the club.', category: 'claim', acquisition: 'told', sourceSubmissionIds: ['submission'], sourceEntityId: input.submissions[0]!.characterId });
  });
});
