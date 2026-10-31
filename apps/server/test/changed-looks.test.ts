import { describe, expect, it } from 'vitest';
import { MOMENT_PROMPT_MAX, PICTURE_PROMPT_MAX, PictureMomentSchema, type PicturePerson, type SessionState } from '@rpg/contracts';
import { createLedgerState } from '@rpg/test-fixtures';
import { type BeatPictureSource, buildPictureMoment, pictureCast } from '../src/picture-cast';
import { changedLookNumbers, descriptionBudget, MOMENT_CLOSING_REFERENCES, MOMENT_CLOSING_WORDS, momentPrompt } from '../src/picture-prompts';

const STYLE = 'Soft watercolor';
const SETTINGS = { style: STYLE, model: 'krea-2-turbo' };
const PORTRAIT = '11111111-1111-4111-8111-111111111111';

const closingFor = (who: string) => `Keep each person's face, hair and build as in their reference image, and their clothing too, except ${who}, dressed as the words describe instead. Everyone fully clothed. No text, no letters.`;

const person = (extra: Partial<PicturePerson> = {}): PicturePerson => ({
  name: 'Pesto', appearance: 'A cook in a cap', role: 'Cook', pronouns: 'he/him', portraitId: null, imageNumber: null, ...extra,
});

function makeState(): SessionState {
  let sequence = 0;
  return createLedgerState('changed-looks', () => `id-${++sequence}`);
}

describe('changed-look closing', () => {
  it('names one, two and three people by their image numbers', () => {
    expect(momentPrompt(STYLE, 'A scene.', true, [2])).toBe(`${STYLE}. A scene. ${closingFor('the person from image 2')}`);
    expect(momentPrompt(STYLE, 'A scene.', true, [2, 4])).toBe(`${STYLE}. A scene. ${closingFor('the people from images 2 and 4')}`);
    expect(momentPrompt(STYLE, 'A scene.', true, [1, 3, 5])).toBe(`${STYLE}. A scene. ${closingFor('the people from images 1, 3 and 5')}`);
  });

  it('is exactly today\'s output with an empty list or no list', () => {
    for (const withReferences of [true, false]) {
      const closing = withReferences ? MOMENT_CLOSING_REFERENCES : MOMENT_CLOSING_WORDS;
      const expected = `${STYLE}. A scene. ${closing}`;
      expect(momentPrompt(STYLE, 'A scene.', withReferences)).toBe(expected);
      expect(momentPrompt(STYLE, 'A scene.', withReferences, [])).toBe(expected);
      expect(descriptionBudget(STYLE, withReferences, [])).toBe(descriptionBudget(STYLE, withReferences));
    }
  });

  it('never changes a words-only prompt', () => {
    expect(momentPrompt(STYLE, 'A scene.', false, [1, 2])).toBe(`${STYLE}. A scene. ${MOMENT_CLOSING_WORDS}`);
    expect(descriptionBudget(STYLE, false, [1, 2])).toBe(descriptionBudget(STYLE, false));
    expect(descriptionBudget(STYLE, false)).toBeLessThanOrEqual(PICTURE_PROMPT_MAX);
  });

  it('shrinks the budget by exactly the extra closing length', () => {
    const extra = closingFor('the person from image 2').length - MOMENT_CLOSING_REFERENCES.length;
    expect(extra).toBeGreaterThan(0);
    expect(descriptionBudget(STYLE, true) - descriptionBudget(STYLE, true, [2])).toBe(extra);
    const extraThree = closingFor('the people from images 1, 3 and 5').length - MOMENT_CLOSING_REFERENCES.length;
    expect(descriptionBudget(STYLE, true) - descriptionBudget(STYLE, true, [1, 3, 5])).toBe(extraThree);
  });

  it('keeps a very long description within the prompt limit', () => {
    const long = 'The rain fell on the old harbour. '.repeat(400);
    for (const changed of [[], [2], [1, 3, 5]]) {
      const prompt = momentPrompt(STYLE, long, true, changed);
      expect(prompt.length).toBeLessThanOrEqual(MOMENT_PROMPT_MAX);
      expect(prompt.endsWith(changed.length > 0 ? 'No text, no letters.' : MOMENT_CLOSING_REFERENCES)).toBe(true);
      expect(prompt.length).toBeGreaterThan(MOMENT_PROMPT_MAX - 200);
    }
  });
});

describe('changedLookNumbers', () => {
  it('returns the ascending numbers of flagged, numbered people only', () => {
    const cast = [
      person({ imageNumber: 4, lookEdited: true }),
      person({ imageNumber: 1 }),
      person({ imageNumber: 2, lookEdited: true }),
      person({ imageNumber: null, lookEdited: true }),
    ];
    expect(changedLookNumbers(cast)).toEqual([2, 4]);
    expect(changedLookNumbers([])).toEqual([]);
    expect(changedLookNumbers([person({ imageNumber: 1 })])).toEqual([]);
  });
});

describe('pictureCast and buildPictureMoment', () => {
  const sourceFor = (state: SessionState, ids: string[]): BeatPictureSource => ({
    beat: { contracts: [], lockedSubmissions: [], draft: null, resolution: null },
    published: {
      segments: ids.map((id) => {
        const name = [...state.characters, ...state.npcs].find((candidate) => candidate.id === id)!.displayName;
        return {
          id: crypto.randomUUID(), kind: 'player_dialogue' as const, text: 'Hello.', speaker: { entityId: id, displayName: name },
          recipientCharacterIds: [], delivery: 'neutral' as const, sourceSubmissionIds: [], voiceProfileId: null, ttsEnabled: false,
        };
      }),
    },
  });

  it('flags only player characters whose look was edited', () => {
    const state = makeState();
    const [first, second] = state.characters;
    const npc = state.npcs.find((candidate) => candidate.status === 'present' && candidate.locationId === state.session.scene.locationId)!;
    first.lookEditedAt = '2026-10-29T20:00:00.000Z';
    second.lookEditedAt = null;
    const cast = pictureCast(state, sourceFor(state, [first.id, second.id, npc.id]));
    const byName = (name: string) => cast.find((entry) => entry.name === name)!;
    expect(byName(first.displayName).lookEdited).toBe(true);
    expect('lookEdited' in byName(second.displayName)).toBe(false);
    expect('lookEdited' in byName(npc.displayName)).toBe(false);
  });

  it('keeps the flag through numbering and the moment still parses', () => {
    const state = makeState();
    const [first, second] = state.characters;
    first.lookEditedAt = '2026-10-29T20:00:00.000Z';
    first.portraitId = PORTRAIT;
    second.portraitId = '22222222-2222-4222-8222-222222222222';
    const moment = buildPictureMoment(state, sourceFor(state, [first.id, second.id]), SETTINGS, new Set([PORTRAIT, second.portraitId]));
    const edited = moment.cast.find((entry) => entry.name === first.displayName)!;
    expect(edited.imageNumber).not.toBeNull();
    expect(edited.lookEdited).toBe(true);
    expect(moment.cast.find((entry) => entry.name === second.displayName)!.lookEdited).toBeUndefined();
    expect(changedLookNumbers(moment.cast)).toEqual([edited.imageNumber]);
    expect(PictureMomentSchema.safeParse(moment).success).toBe(true);
  });

  it('keeps the flag on an edited person who has no portrait number', () => {
    const state = makeState();
    const [first] = state.characters;
    first.lookEditedAt = '2026-10-29T20:00:00.000Z';
    const moment = buildPictureMoment(state, sourceFor(state, [first.id]), SETTINGS, new Set());
    expect(moment.cast[0]).toMatchObject({ lookEdited: true, imageNumber: null });
    expect(changedLookNumbers(moment.cast)).toEqual([]);
    expect(PictureMomentSchema.safeParse(moment).success).toBe(true);
  });
});
