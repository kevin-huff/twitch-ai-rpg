import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { type ActionContract, type AiDraft, type Beat, MOMENT_PORTRAIT_MAX, PictureMomentSchema, type ScriptSegment, type SessionState } from '@rpg/contracts';
import { createLedgerState } from '@rpg/test-fixtures';
import { fallbackDescription } from '../src/picture-prompts';
import { type BeatPictureSource, buildPictureMoment, pictureCast, pictureLines } from '../src/picture-cast';

const SETTINGS = { style: 'Soft watercolor', model: 'krea-2-turbo' };
const SECRET = (what: string) => `SECRET-${what}`;

function makeState(): SessionState {
  let sequence = 0;
  return createLedgerState('cast-session', () => `id-${++sequence}`);
}

const byName = (state: SessionState, name: string) => [...state.characters, ...state.npcs].find((person) => person.displayName === name)!.id;

function segment(kind: ScriptSegment['kind'], text: string, speaker: { entityId: string; displayName: string } | null = null, recipientCharacterIds: string[] = []): ScriptSegment {
  return { id: randomUUID(), kind, text, speaker, recipientCharacterIds, delivery: 'neutral', sourceSubmissionIds: [], voiceProfileId: null, ttsEnabled: false };
}

function contract(actorCharacterId: string, helperCharacterIds: string[] = [], intent = 'Open the safe', approach = 'Carefully'): ActionContract {
  const branch = { publicText: 'It happens.', effects: [] };
  return {
    id: randomUUID(), version: 1, actorCharacterId, helperCharacterIds, submissionIds: [randomUUID()], intent, approach, ruling: 'check',
    trait: 'wits', edge: 0, edgeReason: SECRET('edge'), risk: 'normal', prerequisites: [], fallback: { kind: 'hold' },
    outcomes: { clean: branch, costly: branch, setback: branch },
  };
}

function submission(state: SessionState, characterId: string, text: string, extra: Partial<Beat['lockedSubmissions'][number]> = {}): Beat['lockedSubmissions'][number] {
  return {
    id: randomUUID(), sessionId: state.session.id, characterId, beatId: 'b', revision: 1, kind: 'say', text, recipientNpcIds: [], intent: '', approach: '',
    stageDirection: SECRET('steering'), alreadySpokenAloud: true, status: 'locked', ...extra,
  } as Beat['lockedSubmissions'][number];
}

function beatOf(parts: Partial<Pick<Beat, 'contracts' | 'lockedSubmissions' | 'draft' | 'resolution'>> = {}): BeatPictureSource['beat'] {
  return { contracts: [], lockedSubmissions: [], draft: null, resolution: null, ...parts };
}

function draftOf(segments: AiDraft['segments']): AiDraft {
  return { segments, continuity: [], directorSummary: SECRET('summary') };
}

describe('pictureCast', () => {
  it('lists speakers in script order, then actors, helpers and the addressed, without repeats', () => {
    const state = makeState();
    const [mara, dax] = [byName(state, 'Mara Vale'), byName(state, 'Inspector Dax')];
    const [rook, lark, quill, pip] = ['Rook', 'Lark', 'Quill', 'Pip'].map((name) => byName(state, name));
    const source: BeatPictureSource = {
      beat: beatOf({
        contracts: [contract(lark, [rook, quill])],
        lockedSubmissions: [submission(state, lark, 'x', { recipientNpcIds: [dax, mara] })],
      }),
      published: {
        segments: [
          segment('narration', 'Rain falls.', null, [pip]),
          segment('npc_dialogue', 'Evening.', { entityId: mara, displayName: 'Mara Vale' }),
          segment('player_dialogue', 'Hello.', { entityId: quill, displayName: 'Quill' }),
          segment('npc_dialogue', 'Again.', { entityId: mara, displayName: 'Mara Vale' }),
          segment('system', 'The score changed.', { entityId: dax, displayName: 'Inspector Dax' }),
        ],
      },
    };
    expect(pictureCast(state, source).map((person) => person.name)).toEqual(['Mara Vale', 'Quill', 'Lark', 'Rook', 'Pip', 'Inspector Dax']);
  });

  it('orders a round in review by quotes, then draft speakers, then actors', () => {
    const state = makeState();
    const [mara, dax] = [byName(state, 'Mara Vale'), byName(state, 'Inspector Dax')];
    const [rook, lark, quill] = ['Rook', 'Lark', 'Quill'].map((name) => byName(state, name));
    const beat = beatOf({
      contracts: [contract(rook), contract(lark)],
      lockedSubmissions: [
        submission(state, quill, 'Hi.'),
        submission(state, rook, 'secret aside', { kind: 'ooc' }),
        submission(state, lark, '   ', { kind: 'act' }),
      ],
      draft: draftOf([{ kind: 'npc_dialogue', speakerNpcId: dax, text: 'Form.', recipientCharacterIds: [], delivery: 'neutral' }, { kind: 'narration', text: 'Rain.', recipientCharacterIds: [mara], delivery: 'neutral' }]),
    });
    expect(pictureCast(state, { beat, published: null }).map((person) => person.name)).toEqual(['Quill', 'Inspector Dax', 'Rook', 'Lark', 'Mara Vale']);
  });

  it('counts a non-player character only while present at the scene, skips unknown ids and never checks players', () => {
    const state = makeState();
    const mara = state.npcs.find((npc) => npc.displayName === 'Mara Vale')!;
    const biscuit = byName(state, 'Biscuit');
    const away = { ...mara, id: 'away', displayName: 'Away Person', locationId: 'elsewhere' };
    const gone = { ...mara, id: 'gone', displayName: 'Gone Person', status: 'offstage' as const };
    state.npcs.push(away, gone);
    const rook = byName(state, 'Rook');
    const source: BeatPictureSource = {
      beat: beatOf({ contracts: [contract(rook)] }),
      published: {
        segments: [
          segment('npc_dialogue', 'a', { entityId: biscuit, displayName: 'Biscuit' }),
          segment('npc_dialogue', 'b', { entityId: 'away', displayName: 'Away Person' }),
          segment('npc_dialogue', 'c', { entityId: 'gone', displayName: 'Gone Person' }),
          segment('npc_dialogue', 'd', { entityId: 'nobody', displayName: 'Nobody' }),
          segment('npc_dialogue', 'e', { entityId: mara.id, displayName: 'Mara Vale' }),
        ],
      },
    };
    expect(pictureCast(state, source).map((person) => person.name)).toEqual(['Mara Vale', 'Rook']);
  });

  it('reads role, pronouns and portrait for each kind of person, ignoring portrait ids that are not UUIDs', () => {
    const state = makeState();
    const rook = state.characters[0];
    const mara = state.npcs.find((npc) => npc.displayName === 'Mara Vale')!;
    const dax = state.npcs.find((npc) => npc.displayName === 'Inspector Dax')!;
    rook.pronouns = 'he/him';
    rook.portraitId = randomUUID();
    mara.portraitId = randomUUID();
    dax.portraitId = 'not-a-uuid';
    const source: BeatPictureSource = {
      beat: beatOf(),
      published: { segments: [
        segment('player_dialogue', 'a', { entityId: rook.id, displayName: rook.displayName }),
        segment('npc_dialogue', 'b', { entityId: mara.id, displayName: mara.displayName }),
        segment('npc_dialogue', 'c', { entityId: dax.id, displayName: dax.displayName }),
      ] },
    };
    expect(pictureCast(state, source)).toEqual([
      { name: 'Rook', appearance: rook.appearance, role: rook.specialty, pronouns: 'he/him', portraitId: rook.portraitId, imageNumber: null },
      { name: 'Mara Vale', appearance: mara.appearance, role: 'Bartender', pronouns: '', portraitId: mara.portraitId, imageNumber: null },
      { name: 'Inspector Dax', appearance: dax.appearance, role: 'Visiting official', pronouns: '', portraitId: null, imageNumber: null },
    ]);
  });
});

describe('pictureLines', () => {
  it('turns a published beat into its segments without system lines', () => {
    const state = makeState();
    const mara = byName(state, 'Mara Vale');
    const source: BeatPictureSource = {
      beat: beatOf(),
      published: { segments: [
        segment('narration', 'Rain falls.'),
        segment('npc_dialogue', 'Evening.', { entityId: mara, displayName: 'Mara Vale' }),
        segment('system', 'Strain rose.'),
        segment('player_dialogue', 'Hello.', { entityId: byName(state, 'Quill'), displayName: 'Quill' }),
      ] },
    };
    expect(pictureLines(state, source)).toEqual([
      { kind: 'narration', speaker: null, text: 'Rain falls.' },
      { kind: 'npc_dialogue', speaker: 'Mara Vale', text: 'Evening.' },
      { kind: 'player_dialogue', speaker: 'Quill', text: 'Hello.' },
    ]);
  });

  it('turns a round in review into quotes, the draft, then intents, approaches and outcomes', () => {
    const state = makeState();
    const [rook, quill, mara] = [byName(state, 'Rook'), byName(state, 'Quill'), byName(state, 'Mara Vale')];
    const beat = beatOf({
      contracts: [contract(rook, [], 'Lift the lid', 'With a crowbar')],
      lockedSubmissions: [submission(state, quill, 'Stand back.'), submission(state, rook, 'aside', { kind: 'ooc' })],
      draft: draftOf([
        { kind: 'narration', text: 'The lid groans.', recipientCharacterIds: [], delivery: 'neutral' },
        { kind: 'npc_dialogue', speakerNpcId: mara, text: 'Careful.', recipientCharacterIds: [], delivery: 'neutral' },
      ]),
      resolution: {
        rolls: [], effects: [],
        outcomes: [
          { contractId: 'c1', actorCharacterId: rook, status: 'resolved', band: 'clean', goalAchieved: true, publicText: 'The lid flies off.' },
          { contractId: 'c2', actorCharacterId: rook, status: 'held', band: null, goalAchieved: false, publicText: '   ' },
        ],
      },
    });
    expect(pictureLines(state, { beat, published: null })).toEqual([
      { kind: 'player_dialogue', speaker: 'Quill', text: 'Stand back.' },
      { kind: 'narration', speaker: null, text: 'The lid groans.' },
      { kind: 'npc_dialogue', speaker: 'Mara Vale', text: 'Careful.' },
      { kind: 'intent', speaker: 'Rook', text: 'Lift the lid' },
      { kind: 'approach', speaker: 'Rook', text: 'With a crowbar' },
      { kind: 'outcome', speaker: 'Rook', text: 'The lid flies off.' },
    ]);
  });

  it('gives a round with no draft and no dice only its quotes and contracts', () => {
    const state = makeState();
    const rook = byName(state, 'Rook');
    const beat = beatOf({ contracts: [contract(rook)], lockedSubmissions: [submission(state, rook, 'Now.')] });
    expect(pictureLines(state, { beat, published: null }).map((line) => line.kind)).toEqual(['player_dialogue', 'intent', 'approach']);
  });
});

describe('buildPictureMoment', () => {
  function crowd(state: SessionState, extra: number) {
    const base = state.characters[0];
    for (let index = 0; index < extra; index++) state.characters.push({ ...base, id: `extra-${index}`, displayName: `Extra ${index}`, portraitId: undefined });
    const people = state.characters;
    for (const person of people) person.portraitId = randomUUID();
    return {
      people,
      source: {
        beat: beatOf(),
        published: { segments: people.map((person) => segment('player_dialogue', 'Here.', { entityId: person.id, displayName: person.displayName })) },
      } satisfies BeatPictureSource,
    };
  }

  it('numbers the first ten ready portraits, draws the rest from words and drops nobody', () => {
    const state = makeState();
    const { people, source } = crowd(state, 8);
    expect(people).toHaveLength(12);
    const withoutPortrait = people[4];
    const ready = new Set(people.filter((person) => person !== withoutPortrait).map((person) => person.portraitId!));
    expect(ready.size).toBe(11);
    const moment = buildPictureMoment(state, source, SETTINGS, ready);
    expect(moment.cast).toHaveLength(12);
    expect(moment.cast.map((person) => person.name)).toEqual(people.map((person) => person.displayName));
    const numbered = moment.cast.filter((person) => person.imageNumber !== null);
    expect(numbered).toHaveLength(MOMENT_PORTRAIT_MAX);
    expect(numbered.map((person) => person.imageNumber)).toEqual(Array.from({ length: MOMENT_PORTRAIT_MAX }, (_, index) => index + 1));
    expect(numbered.every((person) => person.portraitId !== null)).toBe(true);
    const fromWords = moment.cast.filter((person) => person.imageNumber === null);
    expect(fromWords.map((person) => person.name)).toEqual([withoutPortrait.displayName, people[11].displayName]);
    expect(fromWords.every((person) => person.portraitId === null)).toBe(true);
    expect(PictureMomentSchema.safeParse(moment).success).toBe(true);
  });

  it('ignores a portrait that is not in the ready set and numbers the next ready one in its place', () => {
    const state = makeState();
    const { people, source } = crowd(state, 0);
    const ready = new Set([people[1].portraitId!, people[3].portraitId!]);
    const moment = buildPictureMoment(state, source, SETTINGS, ready);
    expect(moment.cast.map((person) => person.imageNumber)).toEqual([null, 1, null, 2]);
    expect(moment.cast.map((person) => person.portraitId)).toEqual([null, people[1].portraitId, null, people[3].portraitId]);
  });

  it('fills style, model, scene, lines and the names to remove', () => {
    const state = makeState();
    const { source } = crowd(state, 0);
    const moment = buildPictureMoment(state, source, SETTINGS, new Set());
    expect(moment.style).toBe('Soft watercolor');
    expect(moment.model).toBe('krea-2-turbo');
    expect(moment.scene).toEqual({ title: state.session.scene.title, description: state.session.scene.description, place: '' });
    expect(moment.lines).toHaveLength(4);
    expect(moment.names).toEqual(expect.arrayContaining(['Rook', 'Mara Vale', 'Mara', 'Inspector Dax']));
    expect(moment.cast.every((person) => person.imageNumber === null && person.portraitId === null)).toBe(true);
  });

  it('carries only public text, never secrets, hidden identities, notes or steering', () => {
    const state = makeState();
    state.directorNotes = SECRET('notes');
    state.facts = [{ id: 'f', text: SECRET('fact'), visibility: 'director', sourceEventId: 'seed' }];
    state.locations = [{ id: state.session.scene.locationId, title: 'Members-only club', description: SECRET('location') }];
    for (const npc of state.npcs) {
      npc.secrets = [SECRET('npc-secret')];
      npc.hiddenIdentity = SECRET('hidden-identity');
      npc.motivation = SECRET('motivation');
      npc.goal = SECRET('goal');
      npc.personality = [SECRET('personality')];
      npc.limits = [SECRET('limits')];
      npc.dialogueExamples = [SECRET('example')];
    }
    for (const character of state.characters) {
      character.secret = SECRET('char-secret');
      character.backstory = SECRET('backstory');
      character.connection = SECRET('connection');
      character.flaw = SECRET('flaw');
      character.personality = SECRET('char-personality');
      character.possessions = [SECRET('possession')];
    }
    const [rook, lark, mara] = [byName(state, 'Rook'), byName(state, 'Lark'), byName(state, 'Mara Vale')];
    const beat: Beat = {
      id: 'b', sessionId: state.session.id, kind: 'action', phase: 'draft_review', revision: 1, inputEpoch: 0, sourceStateRevision: 0,
      selectedSubmissionIds: [], lockedSubmissions: [submission(state, rook, 'Open it.', { recipientNpcIds: [mara] })], contracts: [contract(rook, [lark])],
      stakesApproved: true, classification: 'action', inputSnapshotHash: null, resolution: null,
      draft: draftOf([{ kind: 'narration', text: 'Rain.', recipientCharacterIds: [lark], delivery: 'neutral' }]),
      draftRevision: 1, approvedContinuity: [], generation: 1, lastError: null, steering: SECRET('steering'),
    };
    const moment = buildPictureMoment(state, { beat, published: null }, SETTINGS, new Set());
    expect(moment.cast.map((person) => person.name)).toEqual(['Rook', 'Lark', 'Mara Vale']);
    expect(JSON.stringify(moment)).not.toContain('SECRET-');
  });
});

describe('player actions in a published beat', () => {
  it('puts the actor in the cast and passes the line through with its kind', () => {
    const state = makeState();
    const lark = byName(state, 'Lark');
    const source: BeatPictureSource = {
      beat: beatOf(),
      published: { segments: [segment('player_action', 'Lark climbs the fire escape.', { entityId: lark, displayName: 'Lark' })] },
    };
    expect(pictureCast(state, source).map((person) => person.name)).toEqual(['Lark']);
    expect(pictureLines(state, source)).toEqual([{ kind: 'player_action', speaker: 'Lark', text: 'Lark climbs the fire escape.' }]);
  });

  it('describes the moment from the action words with names removed when nothing else is narrated', () => {
    const state = makeState();
    const [lark, mara] = [byName(state, 'Lark'), byName(state, 'Mara Vale')];
    const source: BeatPictureSource = {
      beat: beatOf(),
      published: {
        segments: [
          segment('player_action', 'Lark climbs the fire escape.', { entityId: lark, displayName: 'Lark' }),
          segment('npc_dialogue', 'Mara Vale waits below.', { entityId: mara, displayName: 'Mara Vale' }),
        ],
      },
    };
    const text = fallbackDescription(buildPictureMoment(state, source, SETTINGS, new Set()), 1000);
    expect(text).toContain('climbs the fire escape');
    expect(text).not.toContain('Lark');
    expect(text).not.toContain('Mara');
  });
});
