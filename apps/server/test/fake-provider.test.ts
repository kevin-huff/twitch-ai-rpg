import { describe, expect, it } from 'vitest';
import { AiDraftSchema, CardDraftSchema, PictureDescriptionRequestSchema, ScenarioDraftSchema, type CardGenerationInput, type Beat, type PictureDescriptionRequest, type ProviderContext, type Submission } from '@rpg/contracts';
import { validateContracts } from '@rpg/rules';
import { createLedgerState } from '@rpg/test-fixtures';
import { FAKE_PICTURE_DESCRIPTION, FakeAiProvider } from '../src/fake-provider';

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
  it.each(['conversation', 'action'] as const)('rolls every selected line with four outcomes in a %s round', async (kind) => {
    const input = context(kind);
    const act: Submission = { ...input.submissions[0]!, id: 'second', kind: 'act', text: 'I pick the lock.' };
    input.submissions.push(act);
    const result = await provider.plan(input);
    expect(result.classification).toBe('action');
    expect(result.contracts).toHaveLength(2);
    for (const submission of input.submissions) {
      const contract = result.contracts.find((candidate) => candidate.submissionIds.includes(submission.id))!;
      expect(contract.ruling).toBe('check');
      expect(Object.keys(contract.outcomes).sort()).toEqual(['clean', 'costly', 'critical', 'setback']);
      expect(contract.outcomes.critical!.publicText.length).toBeLessThanOrEqual(110);
    }
    expect(() => validateContracts(result.contracts, input.state, input.submissions)).not.toThrow();
  });
  it('blocks a Do line from a character at four strain and keeps four outcomes', async () => {
    const input = context();
    input.state.characters[0]!.strain = 4;
    input.submissions[0]!.kind = 'act';
    const result = await provider.plan(input);
    expect(result.contracts[0]!.ruling).toBe('blocked');
    expect(Object.keys(result.contracts[0]!.outcomes).sort()).toEqual(['clean', 'costly', 'critical', 'setback']);
    expect(() => validateContracts(result.contracts, input.state, input.submissions)).not.toThrow();
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

describe('fake whole-card writer', () => {
  const ask = (prompt: string, extra: Partial<CardGenerationInput> = {}) => provider.generateCard({ prompt, keepFilled: false, ...extra });

  it('returns a draft that parses and carries the prompt text', async () => {
    const draft = await ask('A weary lighthouse keeper');
    expect(CardDraftSchema.parse(draft)).toEqual(draft);
    expect(draft.backstory).toContain('A weary lighthouse keeper');
  });

  it('uses explicit pronouns and falls back to they/them', async () => {
    expect((await ask('A pilot, she/her, dry humor')).pronouns).toBe('she/her');
    expect((await ask('A quiet pilot')).pronouns).toBe('they/them');
  });

  it('picks traits by keyword with wits as the default', async () => {
    const traits = async (prompt: string) => { const d = await ask(prompt); return [d.strongestTrait, d.weakestTrait]; };
    expect(await traits('A tough soldier')).toEqual(['force', 'wits']);
    expect(await traits('A nimble thief')).toEqual(['finesse', 'force']);
    expect(await traits('A clever scholar')).toEqual(['wits', 'force']);
    expect(await traits('A charming singer')).toEqual(['presence', 'force']);
    expect(await traits('A baker')).toEqual(['wits', 'force']);
  });

  it('is deterministic', async () => {
    expect(await ask('A sneaky courier')).toEqual(await ask('A sneaky courier'));
  });

  it('stays within every limit for a 4,000 character prompt and a full card', async () => {
    const full = (n: number) => 'x'.repeat(n);
    const draft = await ask('p'.repeat(4000), {
      keepFilled: true,
      current: { kind: 'character', displayName: full(80), appearance: full(1000), personality: full(2000), backstory: full(4000),
        specialty: full(1000), flaw: full(1000), connection: full(1000), secret: full(2000) } as CardGenerationInput['current'],
    });
    expect(CardDraftSchema.safeParse(draft).success).toBe(true);
    expect(draft.displayName.length).toBeLessThanOrEqual(80);
  });
});

describe('fake whole-scenario writer', () => {
  const ask = (prompt: string) => provider.generateScenario!({ prompt, size: 'medium', boundaries: [] });

  it('returns a draft that parses with the draft schema', async () => {
    const draft = await ask('A haunted harbor town');
    expect(ScenarioDraftSchema.parse(draft)).toEqual(draft);
    expect(draft.suggestedBoundaries).toEqual(['Keep serious injuries off screen.']);
  });

  it('only uses listed location keys and seats the present character at the opening', async () => {
    const draft = await ask('A haunted harbor town');
    const keys = draft.locations.map(place => place.key);
    expect(keys).toEqual(['opening', 'second', 'third']);
    expect(keys).toContain(draft.openingScene.locationKey);
    for (const npc of draft.npcs) expect(keys).toContain(npc.locationKey);
    const present = draft.npcs.filter(npc => npc.presence === 'present');
    expect(present).toHaveLength(1);
    expect(present[0].locationKey).toBe(draft.openingScene.locationKey);
    expect(present[0].hiddenIdentity).toBeNull();
    const remote = draft.npcs.find(npc => npc.presence === 'offstage');
    expect(remote).toMatchObject({ locationKey: 'second', communicationChannel: 'radio' });
  });

  it('has the expected tracks and facts', async () => {
    const draft = await ask('A haunted harbor town');
    expect(draft.tracks.map(track => track.kind)).toEqual(['progress', 'countdown']);
    expect(draft.tracks[1].ticksEachActionRound).toBe(true);
    expect(draft.facts.filter(fact => fact.visibility === 'director')).toHaveLength(1);
    expect(draft.facts).toHaveLength(3);
  });

  it('carries the prompt text in the title or premise', async () => {
    const draft = await ask('A haunted harbor town');
    expect(`${draft.title} ${draft.premise}`).toContain('A haunted harbor town');
  });

  it('is deterministic and never returns a boundaries key', async () => {
    expect(await ask('A haunted harbor town')).toEqual(await ask('A haunted harbor town'));
    expect(Object.keys(await ask('A haunted harbor town'))).not.toContain('boundaries');
  });

  it('stays within limits for a 4,000 character prompt', async () => {
    expect(ScenarioDraftSchema.safeParse(await ask('p'.repeat(4000))).success).toBe(true);
  });
});

describe('fake picture description', () => {
  const request: PictureDescriptionRequest = {
    style: 'Painterly digital illustration', scene: { title: 'The Hall', description: 'A busy hall.', place: 'Meeting Hall' },
    lines: [{ kind: 'narration', speaker: null, text: 'The bell rings.' }],
    cast: [{ name: 'Ines Park', appearance: 'A tall guide.', role: 'Guide', pronouns: 'she/her', imageNumber: null }],
    budget: 400,
  };

  it('returns the pinned description', async () => {
    expect(await new FakeAiProvider().describePicture(request)).toBe(FAKE_PICTURE_DESCRIPTION);
  });

  it('records each parsed request in order', async () => {
    const fake = new FakeAiProvider();
    await fake.describePicture(request);
    await fake.describePicture({ ...request, budget: 500 });
    expect(fake.pictureRequests).toEqual([request, { ...request, budget: 500 }]);
  });

  it('rejects an invalid request and records nothing', async () => {
    const fake = new FakeAiProvider();
    await expect(fake.describePicture({ ...request, budget: 0 })).rejects.toThrow();
    await expect(fake.describePicture({ ...request, extra: true } as unknown as PictureDescriptionRequest)).rejects.toThrow();
    expect(fake.pictureRequests).toEqual([]);
    expect(PictureDescriptionRequestSchema.safeParse(request).success).toBe(true);
  });
});
