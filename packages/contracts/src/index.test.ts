import { describe, expect, it } from 'vitest';
import {
  AiSegmentSchema,
  CharacterSchema,
  CommandSchema,
  EffectSchema,
  CardListSchema,
  CARD_LIST_MAX,
  LineAssistInputSchema,
  cardListChange,
  InvitePreviewRequestSchema,
  InvitePreviewResponseSchema,
  PublicCharacterSchema,
  NpcKnowledgeSchema,
  RedeemResponseSchema,
  ScriptSegmentSchema,
  SessionSnapshotSchema,
  isPlayerSegmentKind,
  isSpokenSegmentKind,
  playerWords,
  spokenText,
  OutcomeBandSchema,
  ActionContractSchema,
  PublicActionContractSchema,
  PublicBeatSchema,
  PlanThrownAwaySchema,
  DirectorSnapshotSchema,
  RollSchema,
  TraitsSchema,
  NpcSchema,
  NpcDefinitionSchema,
  LiveNpcProfileSchema,
  CorrectionChangesSchema,
  strainStep,
  incidentKey,
  countWords,
  conditionLineRefusal,
  canSpeakInScene,
  RESCUE_STRAIN,
  LAST_CHANCE_STRAIN,
  DOWNED_SAY_WORDS,
} from './index.js';
import { PicturePersonSchema } from './images.js';

describe('rules and authority contracts', () => {
  it('accepts a tab identity selector without accepting bearer credentials or malformed selectors', () => {
    const legacy = { sessionId: 'session', role: 'player', characterId: 'rook' };
    expect(RedeemResponseSchema.parse(legacy)).toEqual(legacy);
    const scoped = { ...legacy, identityId: 'a'.repeat(32) };
    expect(RedeemResponseSchema.parse(scoped)).toEqual(scoped);
    for (const identityId of ['', 'A'.repeat(32), 'a'.repeat(31), 'not-a-selector']) {
      expect(RedeemResponseSchema.safeParse({ ...legacy, identityId }).success).toBe(false);
    }
    expect(RedeemResponseSchema.safeParse({ ...scoped, credential: 'private-token' }).success).toBe(false);
  });
  it('accepts exactly the four-trait allocation', () => {
    expect(TraitsSchema.safeParse({ force: 2, finesse: 1, wits: 1, presence: 0 }).success).toBe(true);
    expect(TraitsSchema.safeParse({ force: 2, finesse: 2, wits: 0, presence: 0 }).success).toBe(false);
  });

  it('excludes player quotes and provider commands from authored scripts', () => {
    expect(AiSegmentSchema.safeParse({ kind: 'player_dialogue', text: 'I agree.', characterId: 'pc' }).success).toBe(false);
    expect(AiSegmentSchema.safeParse({
      kind: 'npc_dialogue', speakerNpcId: 'mara', recipientCharacterIds: ['pc'], text: 'Why?', delivery: 'quiet',
    }).success).toBe(true);
    expect(AiSegmentSchema.safeParse({
      kind: 'npc_dialogue', speakerNpcId: 'mara', recipientCharacterIds: [], text: 'Why?', delivery: 'quiet', voiceId: 'arbitrary',
    }).success).toBe(false);
  });

  it('requires a submission context and forbids client role grants', () => {
    const input = {
      type: 'save_submission', commandId: 'command-1', expectedSubmissionRevision: 0,
      contextBeatId: null, expectedInputEpoch: 2, kind: 'say', text: 'Hello Mara.',
      recipientNpcIds: ['mara'], alreadySpokenAloud: true,
    };
    expect(CommandSchema.safeParse(input).success).toBe(true);
    const { expectedInputEpoch: ignored, ...staleInput } = input;
    expect(ignored).toBe(2);
    expect(CommandSchema.safeParse(staleInput).success).toBe(false);
    expect(CommandSchema.safeParse({ ...input, role: 'director' }).success).toBe(false);
  });

  it('requires provenance on learned information and keeps claims classified', () => {
    const knowledge = {
      id: 'knowledge-1', statement: 'The ledger was burned.', category: 'claim', acquisition: 'told',
      sourceEventId: 'event-1', sourceEntityId: 'pc-1', learnedBeatNumber: 1,
    };
    expect(NpcKnowledgeSchema.parse(knowledge).category).toBe('claim');
    const { sourceEventId: ignored, ...unsourced } = knowledge;
    expect(ignored).toBe('event-1');
    expect(NpcKnowledgeSchema.safeParse(unsourced).success).toBe(false);
  });
});

describe('stage projection contract', () => {
  const snapshot = {
    schemaVersion: 1, role: 'stage', eventSeq: 0,
    session: {
      id: 'session-1', title: 'The Ledger Job', status: 'live', mode: 'conversation',
      stateRevision: 0, beatNumber: 0, actionRoundNumber: 0, inputEpoch: 0,
      scene: { id: 'scene-1', title: 'The bar', description: 'A quiet club.', locationId: 'bar' },
    },
    characters: [], npcs: [], tracks: [], facts: [], history: [], activeBeat: null,
  };

  it('permits only allowlisted public fields', () => {
    expect(SessionSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(SessionSnapshotSchema.safeParse({ ...snapshot, directorNotes: 'Secret ledger location.' }).success).toBe(false);
    expect(SessionSnapshotSchema.safeParse({ ...snapshot, role: 'player' }).success).toBe(false);
  });
});

describe('Sprint A contracts', () => {
  const base = { id: 'c1', displayName: 'Ana', traits: { force: 2, finesse: 1, wits: 1, presence: 0 }, strain: 0 };
  it('cardSource is optional and limited to host or player', () => {
    const char = base;
    expect(CharacterSchema.safeParse(char).success).toBe(true);
    expect(CharacterSchema.safeParse({ ...char, cardSource: 'host' }).success).toBe(true);
    expect(CharacterSchema.safeParse({ ...char, cardSource: 'player' }).success).toBe(true);
    expect(CharacterSchema.safeParse({ ...char, cardSource: 'ai' }).success).toBe(false);
    const parsed = CharacterSchema.parse({ ...char, cardSource: 'host' });
    expect(PublicCharacterSchema.shape).not.toHaveProperty('cardSource');
    const { id, displayName, traits, strain, appearance, approved, ready, portraitId } = parsed;
    const pub = PublicCharacterSchema.parse({ id, displayName, traits, strain, appearance, approved, ready, portraitId });
    expect(pub).not.toHaveProperty('cardSource');
    expect(PublicCharacterSchema.safeParse({ ...pub, cardSource: 'host' }).success).toBe(false);
  });
  const cmd = { commandId: 'cmd-1' };
  it('save_character takes an optional characterId', () => {
    const card = { schemaVersion: 1, displayName: 'Nia', traits: base.traits, possessions: ['scanner'] };
    const without = CommandSchema.safeParse({ type: 'save_character', ...cmd, expectedCharacterRevision: 0, card });
    const withId = CommandSchema.safeParse({ type: 'save_character', ...cmd, expectedCharacterRevision: 0, card, characterId: 'c1' });
    expect(without.success).toBe(true);
    expect(withId.success).toBe(true);
  });
  it('remove_seat parses and is strict', () => {
    const ok = { type: 'remove_seat', ...cmd, expectedStateRevision: 0, characterId: 'c1' };
    expect(CommandSchema.safeParse(ok).success).toBe(true);
    expect(CommandSchema.safeParse({ ...ok, characterId: undefined }).success).toBe(false);
    expect(CommandSchema.safeParse({ ...ok, extra: 1 }).success).toBe(false);
  });
  it('invite preview schemas accept valid input and reject extras', () => {
    expect(InvitePreviewRequestSchema.safeParse({ token: 'abc' }).success).toBe(true);
    expect(InvitePreviewRequestSchema.safeParse({ token: 'abc', x: 1 }).success).toBe(false);
    expect(InvitePreviewResponseSchema.safeParse({ title: 'T', role: 'player', characterName: 'Ana' }).success).toBe(true);
    expect(InvitePreviewResponseSchema.safeParse({ title: 'T', role: 'stage' }).success).toBe(true);
    expect(InvitePreviewResponseSchema.safeParse({ title: 'T', role: 'stage', x: 1 }).success).toBe(false);
  });
});

describe('player line helpers', () => {
  const act = (intent: string, approach: string) => ({ kind: 'act' as const, text: '', intent, approach });
  it('parses a player_action segment', () => {
    const segment = { id: 's1', kind: 'player_action', text: 'I climb.', speaker: { entityId: 'c1', displayName: 'Dash' }, recipientCharacterIds: [], delivery: 'neutral', sourceSubmissionIds: ['u1'], voiceProfileId: null, ttsEnabled: false };
    expect(ScriptSegmentSchema.parse(segment).kind).toBe('player_action');
  });
  it('returns say text unchanged', () => {
    expect(playerWords({ kind: 'say', text: '  hello   there \n', intent: 'x', approach: 'y' })).toBe('  hello   there \n');
  });
  it('returns a seat-style act once', () => {
    expect(playerWords(act('I climb up.', 'I climb up.'))).toBe('I climb up.');
  });
  it('joins differing intent and approach with a newline', () => {
    expect(playerWords(act('Get in', ' quietly '))).toBe('Get in\n quietly ');
  });
  it('skips a blank approach or intent', () => {
    expect(playerWords(act('Get in', '  '))).toBe('Get in');
    expect(playerWords(act('', 'Slowly'))).toBe('Slowly');
  });
  it('returns nothing for ooc', () => {
    expect(playerWords({ kind: 'ooc', text: 'brb', intent: '', approach: '' })).toBe('');
  });
  it('prefixes the speaker for player kinds only', () => {
    expect(spokenText({ kind: 'player_dialogue', speaker: 'Dash', text: 'Hi.' })).toBe('Dash: Hi.');
    expect(spokenText({ kind: 'player_action', speaker: 'Dash', text: 'I run.' })).toBe('Dash: I run.');
    expect(spokenText({ kind: 'narration', speaker: 'Narrator', text: 'Night falls.' })).toBe('Night falls.');
  });
  it('classifies every kind', () => {
    const kinds = ['narration', 'npc_dialogue', 'player_dialogue', 'player_action', 'system'];
    expect(kinds.map(isSpokenSegmentKind)).toEqual([true, true, true, true, false]);
    expect(kinds.map(isPlayerSegmentKind)).toEqual([false, false, true, true, false]);
  });
});

describe('critical band and tag-free speech', () => {
  const branch = { publicText: 'It works.', effects: [] };
  const contract = {
    id: 'c1', version: 1, actorCharacterId: 'a', helperCharacterIds: [], submissionIds: ['s1'],
    intent: 'Pick the lock', approach: 'Carefully', ruling: 'check', trait: 'finesse', edge: 0, edgeReason: null,
    risk: 'normal', prerequisites: [], fallback: { kind: 'hold' },
    outcomes: { clean: branch, costly: branch, setback: branch },
  };
  const publicContract = {
    id: 'c1', version: 1, actorCharacterId: 'a', helperCharacterIds: [], intent: 'Pick the lock',
    approach: 'Carefully', ruling: 'check', trait: 'finesse', edge: 0, edgeReason: null, risk: 'normal',
    outcomes: { clean: 'a', costly: 'b', setback: 'c' },
  };
  it('has four bands', () => {
    expect(OutcomeBandSchema.options).toEqual(['clean', 'costly', 'setback', 'critical']);
  });
  it('parses contracts with and without a critical branch', () => {
    expect(ActionContractSchema.safeParse(contract).success).toBe(true);
    const withCritical = { ...contract, outcomes: { ...contract.outcomes, critical: branch } };
    expect(ActionContractSchema.safeParse(withCritical).success).toBe(true);
    expect(ActionContractSchema.safeParse({ ...contract, outcomes: { ...contract.outcomes, extra: branch } }).success).toBe(false);
  });
  it('parses public contracts with and without a critical text', () => {
    expect(PublicActionContractSchema.safeParse(publicContract).success).toBe(true);
    expect(PublicActionContractSchema.safeParse({ ...publicContract, outcomes: { ...publicContract.outcomes, critical: 'd' } }).success).toBe(true);
    expect(PublicActionContractSchema.safeParse({ ...publicContract, outcomes: { ...publicContract.outcomes, extra: 'd' } }).success).toBe(false);
  });
  it('accepts a critical roll', () => {
    const roll = { id: 'r1', contractId: 'c1', contractVersion: 1, actorCharacterId: 'a', faces: [1, 1], trait: 'finesse', traitModifier: 0, edge: 0, total: 2, band: 'critical' };
    const parsed = RollSchema.safeParse(roll);
    expect(parsed.success).toBe(true);
  });
  it('drops tags from the spoken copy', () => {
    expect(spokenText({ kind: 'player_dialogue', speaker: 'Dash', text: '<grin> Nice hat.' })).toBe('Dash: Nice hat.');
    expect(spokenText({ kind: 'player_dialogue', speaker: 'Dash', text: 'Nice</b> hat.' })).toBe('Dash: Nice hat.');
    expect(spokenText({ kind: 'player_dialogue', speaker: 'Dash', text: 'Nice <wink> hat.' })).toBe('Dash: Nice hat.');
  });
  it('keeps non-tags', () => {
    expect(spokenText({ kind: 'player_dialogue', speaker: 'Dash', text: 'I <3 you' })).toBe('Dash: I <3 you');
    expect(spokenText({ kind: 'player_dialogue', speaker: 'Dash', text: 'a < b' })).toBe('Dash: a < b');
  });
  it('cleans narration and keeps newlines', () => {
    expect(spokenText({ kind: 'narration', speaker: 'Narrator', text: 'Night <pause> falls.' })).toBe('Night falls.');
    expect(spokenText({ kind: 'player_action', speaker: 'Dash', text: 'Get in\nquietly' })).toBe('Dash: Get in\nquietly');
  });
  it('speaks a tag-only line as the name', () => {
    expect(spokenText({ kind: 'player_dialogue', speaker: 'Dash', text: '<grin>' })).toBe('Dash');
  });
});

describe('public beat stakes approval flag', () => {
  const beat = { id: 'b1', kind: 'action', phase: 'locked', revision: 1, stakes: [], locked: true };
  it('accepts stakesApproved true, accepts a beat without it, and rejects a non-boolean', () => {
    expect(PublicBeatSchema.safeParse({ ...beat, stakesApproved: true }).success).toBe(true);
    expect(PublicBeatSchema.safeParse(beat).success).toBe(true);
    expect(PublicBeatSchema.safeParse({ ...beat, stakesApproved: 'yes' }).success).toBe(false);
  });
});

describe('card lists and outcome kinds', () => {
  const base = { id: 'c1', displayName: 'Ana', traits: { force: 2, finesse: 1, wits: 1, presence: 0 }, strain: 0 };
  const list = (n: number, text = 'x') => Array.from({ length: n }, () => text);
  it('parses a stored character without the four card keys and adds none of them', () => {
    const parsed = CharacterSchema.parse(base);
    for (const key of ['wearing', 'looksChanged', 'owes', 'feelings']) expect(parsed).not.toHaveProperty(key);
  });
  it('keeps the list and note limits', () => {
    expect(CharacterSchema.safeParse({ ...base, wearing: list(12), owes: list(8), feelings: list(8), looksChanged: 'x'.repeat(300) }).success).toBe(true);
    expect(CharacterSchema.safeParse({ ...base, wearing: list(13) }).success).toBe(false);
    expect(CharacterSchema.safeParse({ ...base, owes: list(9) }).success).toBe(false);
    expect(CharacterSchema.safeParse({ ...base, feelings: list(9) }).success).toBe(false);
    expect(CharacterSchema.safeParse({ ...base, wearing: ['x'.repeat(161)] }).success).toBe(false);
    expect(CharacterSchema.safeParse({ ...base, looksChanged: 'x'.repeat(301) }).success).toBe(false);
    expect(CARD_LIST_MAX).toEqual({ possessions: 20, wearing: 12, owes: 8, feelings: 8 });
    expect(CardListSchema.safeParse('possessions').success).toBe(false);
  });
  it('parses the three new effects and refuses malformed ones', () => {
    expect(EffectSchema.safeParse({ kind: 'card_add', characterId: 'c1', list: 'wearing', entry: 'red coat' }).success).toBe(true);
    expect(EffectSchema.safeParse({ kind: 'card_remove', characterId: 'c1', list: 'owes', entry: 'a favour', incidentId: 'i1' }).success).toBe(true);
    expect(EffectSchema.safeParse({ kind: 'looks_set', characterId: 'c1', text: '' }).success).toBe(true);
    expect(EffectSchema.safeParse({ kind: 'card_add', characterId: 'c1', list: 'possessions', entry: 'x' }).success).toBe(false);
    expect(EffectSchema.safeParse({ kind: 'card_add', characterId: 'c1', list: 'wearing', entry: '' }).success).toBe(false);
    expect(EffectSchema.safeParse({ kind: 'looks_set', characterId: 'c1', text: 'x'.repeat(301) }).success).toBe(false);
  });
  it('maps list effects with cardListChange and returns null for others', () => {
    const c = 'c1';
    expect(cardListChange({ kind: 'inventory_add', characterId: c, item: 'key' })).toEqual({ list: 'possessions', op: 'add', characterId: c, entry: 'key' });
    expect(cardListChange({ kind: 'inventory_remove', characterId: c, item: 'key' })).toEqual({ list: 'possessions', op: 'remove', characterId: c, entry: 'key' });
    for (const l of ['wearing', 'owes', 'feelings'] as const) {
      expect(cardListChange({ kind: 'card_add', characterId: c, list: l, entry: 'e' })).toEqual({ list: l, op: 'add', characterId: c, entry: 'e' });
      expect(cardListChange({ kind: 'card_remove', characterId: c, list: l, entry: 'e' })).toEqual({ list: l, op: 'remove', characterId: c, entry: 'e' });
    }
    expect(cardListChange({ kind: 'strain_delta', characterId: c, delta: 1 })).toBeNull();
    expect(cardListChange({ kind: 'looks_set', characterId: c, text: 'x' })).toBeNull();
  });
  it('keeps old save_live_character bodies and trims new entries', () => {
    const old = { type: 'save_live_character', commandId: 'cmd', characterId: 'c1', expectedCharacterRevision: 1, appearance: 'tall', possessions: ['key'] };
    const parsed = CommandSchema.parse(old);
    for (const key of ['wearing', 'owes', 'feelings', 'looksChanged']) expect(parsed).not.toHaveProperty(key);
    const next = CommandSchema.parse({ ...old, wearing: ['  red coat '], owes: [' a favour'], feelings: ['trusted  '], looksChanged: '  singed  ' });
    expect(next).toMatchObject({ wearing: ['red coat'], owes: ['a favour'], feelings: ['trusted'], looksChanged: 'singed' });
    expect(CommandSchema.safeParse({ ...old, wearing: ['   '] }).success).toBe(false);
    expect(CommandSchema.safeParse({ ...old, owes: list(9) }).success).toBe(false);
  });
  it('accepts the new fields on picture people and line help', () => {
    const person = { name: 'Ana', appearance: '', role: '', pronouns: '', portraitId: null, imageNumber: null };
    expect(PicturePersonSchema.safeParse(person).success).toBe(true);
    expect(PicturePersonSchema.safeParse({ ...person, wearing: ['red coat'], looksChanged: 'singed' }).success).toBe(true);
    expect(PicturePersonSchema.safeParse({ ...person, wearing: list(13) }).success).toBe(false);
    const input = {
      idea: 'hi', character: { displayName: 'Ana', pronouns: '', appearance: '', personality: '', backstory: '', specialty: '', flaw: '', connection: '', secret: '', possessions: [] },
      talkingTo: [], present: { npcs: [], characters: [] }, scene: { title: '', description: '' }, story: null, facts: [], recentRounds: [], boundaries: [],
    };
    expect(LineAssistInputSchema.parse(input).character.wearing).toEqual([]);
    expect(LineAssistInputSchema.parse({ ...input, character: { ...input.character, wearing: ['red coat'] } }).character.wearing).toEqual(['red coat']);
  });
});

describe('death ladder contracts', () => {
  const char = { id: 'c1', displayName: 'Ana', traits: { force: 2, finesse: 1, wits: 1, presence: 0 }, strain: 3 };
  const npc = {
    id: 'n1', displayName: 'Mara', role: 'guard', locationId: 'hall', status: 'present', voiceProfileId: 'v1',
  };
  const npcDefinition = { id: 'n1', displayName: 'Mara', role: 'guard', locationId: 'hall', status: 'present', voiceProfileId: 'v1' };

  it('parses old characters and non-player characters with no condition', () => {
    expect(CharacterSchema.parse(char)).not.toHaveProperty('condition');
    expect(NpcSchema.parse(npc)).not.toHaveProperty('condition');
    expect(CharacterSchema.parse({ ...char, condition: 'down' }).condition).toBe('down');
    expect(CharacterSchema.safeParse({ ...char, condition: 'up' }).success).toBe(false);
    expect(NpcSchema.parse({ ...npc, condition: 'dead' }).condition).toBe('dead');
    expect(NpcSchema.safeParse({ ...npc, condition: 'down' }).success).toBe(false);
  });
  it('keeps condition on the public character only when set', () => {
    const pub = { id: 'c1', displayName: 'Ana', traits: char.traits, strain: 3, appearance: '', approved: true, ready: true };
    expect(PublicCharacterSchema.parse(pub)).not.toHaveProperty('condition');
    expect(PublicCharacterSchema.parse({ ...pub, condition: 'dead' }).condition).toBe('dead');
  });
  it('parses the three new outcome kinds and a last-chance roll', () => {
    expect(EffectSchema.safeParse({ kind: 'character_down', characterId: 'c1' }).success).toBe(true);
    expect(EffectSchema.safeParse({ kind: 'character_rescue', characterId: 'c1', incidentId: 'i1' }).success).toBe(true);
    expect(EffectSchema.safeParse({ kind: 'npc_death', npcId: 'n1' }).success).toBe(true);
    expect(EffectSchema.safeParse({ kind: 'npc_death', characterId: 'n1' }).success).toBe(false);
    const roll = {
      id: 'last-chance:c1', contractId: 'last-chance:c1', contractVersion: 1, actorCharacterId: 'c1', faces: [1, 1], trait: 'force',
      traitModifier: 0, edge: 0, total: 2, band: 'critical', lastChance: true,
    };
    expect(RollSchema.parse(roll).lastChance).toBe(true);
    expect(RollSchema.safeParse({ ...roll, lastChance: false }).success).toBe(false);
    const { lastChance: ignored, ...plain } = roll;
    expect(ignored).toBe(true);
    expect(RollSchema.parse(plain)).not.toHaveProperty('lastChance');
  });
  it('refuses blank items and entries and trims padded ones', () => {
    for (const item of ['', '   ']) {
      expect(EffectSchema.safeParse({ kind: 'inventory_add', characterId: 'c1', item }).success).toBe(false);
      expect(EffectSchema.safeParse({ kind: 'inventory_remove', characterId: 'c1', item }).success).toBe(false);
      expect(EffectSchema.safeParse({ kind: 'card_add', characterId: 'c1', list: 'owes', entry: item }).success).toBe(false);
      expect(EffectSchema.safeParse({ kind: 'card_remove', characterId: 'c1', list: 'owes', entry: item }).success).toBe(false);
    }
    expect(EffectSchema.parse({ kind: 'inventory_add', characterId: 'c1', item: ' scarf ' })).toMatchObject({ item: 'scarf' });
    expect(EffectSchema.parse({ kind: 'card_add', characterId: 'c1', list: 'wearing', entry: ' red coat ' })).toMatchObject({ entry: 'red coat' });
  });
  it('keeps condition out of scenarios but lets a live profile carry it', () => {
    expect(NpcDefinitionSchema.safeParse(npcDefinition).success).toBe(true);
    expect(NpcDefinitionSchema.safeParse({ ...npcDefinition, condition: 'dead' }).success).toBe(false);
    const { id: ignored, ...profile } = npcDefinition;
    expect(ignored).toBe('n1');
    expect(LiveNpcProfileSchema.parse({ ...profile, condition: 'dead' }).condition).toBe('dead');
    expect(LiveNpcProfileSchema.safeParse(profile).success).toBe(true);
  });
  it('checks condition corrections one change per target', () => {
    const set = { kind: 'condition_set', characterId: 'c1', condition: 'up' } as const;
    expect(CorrectionChangesSchema.safeParse([set]).success).toBe(true);
    expect(CorrectionChangesSchema.safeParse([set, { ...set, condition: 'dead' }]).success).toBe(false);
    expect(CorrectionChangesSchema.safeParse([set, { kind: 'strain_set', characterId: 'c1', value: 2 }]).success).toBe(true);
    const npcSet = { kind: 'npc_condition_set', npcId: 'n1', condition: 'dead' } as const;
    expect(CorrectionChangesSchema.safeParse([npcSet, { ...npcSet, condition: 'alive' }]).success).toBe(false);
    expect(CorrectionChangesSchema.safeParse([npcSet, { kind: 'condition_set', characterId: 'n1', condition: 'down' }]).success).toBe(true);
    expect(CorrectionChangesSchema.safeParse([{ kind: 'condition_set', characterId: 'c1', condition: 'alive' }]).success).toBe(false);
  });
  it('steps strain with the going-down rule', () => {
    expect(strainStep(7, undefined, 2)).toEqual({ strain: 8, down: false, over: 1 });
    expect(strainStep(8, undefined, 1)).toEqual({ strain: 8, down: true, over: 0 });
    expect(strainStep(8, 'down', 1)).toEqual({ strain: 8, down: false, over: 1 });
    expect(strainStep(8, undefined, 0)).toEqual({ strain: 8, down: false, over: 0 });
    expect(strainStep(2, undefined, -4)).toEqual({ strain: 0, down: false, over: 0 });
  });
  it('keys shared incidents by list and entry', () => {
    const add = { kind: 'card_add', characterId: 'c1', list: 'owes', entry: 'a favour', incidentId: 'i' } as const;
    expect(incidentKey(add)).not.toBe(incidentKey({ ...add, list: 'feelings' }));
    expect(incidentKey(add)).not.toBe(incidentKey({ ...add, entry: 'a debt' }));
    expect(incidentKey(add)).toBe(incidentKey({ ...add }));
    expect(incidentKey({ kind: 'strain_delta', characterId: 'c1', delta: 1 })).toBe(JSON.stringify([null, 'strain_delta', 'c1']));
    expect(incidentKey({ kind: 'inventory_add', characterId: 'c1', item: 'key' })).toBe(JSON.stringify([null, 'inventory_add', 'c1:key']));
    expect(incidentKey({ kind: 'npc_death', npcId: 'n1', incidentId: 'i' })).toBe(JSON.stringify(['i', 'npc_death', 'n1']));
  });
  it('counts words without audio tags', () => {
    expect(countWords('[whispers] help me  please')).toBe(3);
    expect(countWords('   ')).toBe(0);
    expect([RESCUE_STRAIN, LAST_CHANCE_STRAIN, DOWNED_SAY_WORDS]).toEqual([6, 7, 8]);
  });
  it('words every refusal exactly', () => {
    const up = { displayName: 'Ana' };
    const down = { displayName: 'Ana', condition: 'down' } as const;
    const dead = { displayName: 'Ana', condition: 'dead' } as const;
    expect(conditionLineRefusal(up, 'act', 50)).toBeNull();
    expect(conditionLineRefusal(down, 'ooc', 50)).toBeNull();
    expect(conditionLineRefusal(dead, 'ooc', 50)).toBeNull();
    expect(conditionLineRefusal(down, 'say', 8)).toBeNull();
    expect(conditionLineRefusal(dead, 'say', 1)).toBe('Ana has died, so they cannot send lines. You can keep watching the story.');
    expect(conditionLineRefusal(dead, 'act', 1)).toBe('Ana has died, so they cannot send lines. You can keep watching the story.');
    expect(conditionLineRefusal(down, 'act', 1)).toBe('Ana is down, so they cannot do anything. They can say a few words, up to 8.');
    expect(conditionLineRefusal(down, 'say', 9)).toBe('Ana is down, so they can say only a few words, up to 8. This line has 9.');
  });
  it('never lets a dead non-player character speak, even over a channel', () => {
    const present = { status: 'present', locationId: 'hall', communicationChannel: null } as const;
    expect(canSpeakInScene(present, 'hall')).toBe(true);
    expect(canSpeakInScene({ ...present, condition: 'dead' }, 'hall')).toBe(false);
    expect(canSpeakInScene({ status: 'offstage', locationId: 'x', communicationChannel: 'radio', condition: 'dead' }, 'hall')).toBe(false);
    expect(canSpeakInScene({ status: 'offstage', locationId: 'x', communicationChannel: 'radio' }, 'hall')).toBe(true);
  });
});

describe('planning stage contracts', () => {
  const beat = { id: 'b1', kind: 'action', phase: 'collecting', revision: 1, stakes: [], locked: false };
  it('public round takes planning and lastChanceFor as optional typed fields', () => {
    expect(PublicBeatSchema.safeParse(beat).success).toBe(true);
    expect(PublicBeatSchema.safeParse({ ...beat, planning: true, lastChanceFor: ['c1'] }).success).toBe(true);
    expect(PublicBeatSchema.safeParse({ ...beat, planning: 'yes' }).success).toBe(false);
    expect(PublicBeatSchema.safeParse({ ...beat, lastChanceFor: 'c1' }).success).toBe(false);
    expect(PublicBeatSchema.safeParse({ ...beat, lastChanceFor: [1] }).success).toBe(false);
  });
  it('director snapshot carries an optional planThrownAway', () => {
    const field = DirectorSnapshotSchema.shape.planThrownAway;
    expect(field.safeParse(undefined).success).toBe(true);
    expect(field.safeParse({ characterId: 'c1', change: 'changed' }).success).toBe(true);
    expect(PlanThrownAwaySchema.safeParse({ characterId: 'c1', change: 'took_back' }).success).toBe(true);
    expect(field.safeParse({ characterId: 'c1', change: 'edited' }).success).toBe(false);
  });
  it('stop_ai needs commandId and beatId only', () => {
    expect(CommandSchema.safeParse({ type: 'stop_ai', commandId: 'k1', beatId: 'b1' }).success).toBe(true);
    expect(CommandSchema.safeParse({ type: 'stop_ai', commandId: 'k1', beatId: 'b1', expectedBeatRevision: 1 }).success).toBe(false);
    expect(CommandSchema.safeParse({ type: 'stop_ai', commandId: 'k1' }).success).toBe(false);
  });
});
