import { describe, expect, it } from 'vitest';
import { type AiDraft, DEFAULT_PICTURE_STYLE, MOMENT_PROMPT_MAX, PICTURE_PROMPT_MAX, PICTURE_STYLE_MAX, PictureDescriptionRequestSchema, type PictureMoment, type PicturePerson, type PortraitDetails, type SessionState } from '@rpg/contracts';
import { createLedgerState } from '@rpg/test-fixtures';
import {
  cleanDescription, clip, descriptionBudget, draftNarration, fallbackDescription, MOMENT_CLOSING_REFERENCES, MOMENT_CLOSING_WORDS,
  momentPrompt, namesInState, pictureDescriptionRequest, pictureStyleOf, portraitPrompt, portraitSubject, sceneLocationTitle, scenePrompt, withoutNames,
} from '../src/picture-prompts';

const STYLE = 'Soft watercolor, muted greens';
const SECRET = (what: string) => `SECRET-${what}`;
const SENTINELS = [
  'npc-secret', 'hidden-identity', 'motivation', 'goal', 'personality', 'knowledge', 'notes', 'fact', 'location',
  'char-secret', 'backstory', 'connection', 'flaw',
].map(SECRET);

function sentinelState(): SessionState {
  let sequence = 0;
  const state = createLedgerState('prompt-session', () => `id-${++sequence}`);
  state.session.scene.title = 'The Velvet Ledger';
  state.locations = [{ id: state.session.scene.locationId, title: 'Members-only club', description: `Hidden vault. ${SECRET('location')}` }];
  state.directorNotes = SECRET('notes');
  state.facts = [{ id: 'fact-1', text: SECRET('fact'), visibility: 'director', sourceEventId: 'seed' }];
  for (const npc of state.npcs) {
    npc.secrets = [SECRET('npc-secret')];
    npc.hiddenIdentity = SECRET('hidden-identity');
    npc.motivation = SECRET('motivation');
    npc.goal = SECRET('goal');
    npc.personality = [SECRET('personality')];
    npc.knowledge = [{ ...npc.knowledge[0] ?? { id: 'k', category: 'fact', acquisition: 'scenario', sourceEventId: 'seed', sourceEntityId: null, learnedBeatNumber: 0 }, statement: SECRET('knowledge') }];
  }
  for (const character of state.characters) {
    character.secret = SECRET('char-secret');
    character.backstory = SECRET('backstory');
    character.connection = SECRET('connection');
    character.flaw = SECRET('flaw');
  }
  return state;
}

// The same fields the image service reads for each kind of picture.
function sceneInput(state: SessionState) {
  const location = state.locations.find((place) => place.id === state.session.scene.locationId);
  return { title: state.session.scene.title, description: state.session.scene.description, locationTitle: location?.title ?? '' };
}
function npcInput(state: SessionState, name: string): PortraitDetails {
  const npc = state.npcs.find((candidate) => candidate.displayName === name)!;
  return { appearance: npc.appearance, role: npc.role, pronouns: '', name: npc.displayName };
}
function cardInput(state: SessionState, index: number): PortraitDetails {
  const character = state.characters[index]!;
  return { appearance: character.appearance, role: character.specialty, pronouns: 'she/her', name: character.displayName };
}

describe('picture prompts', () => {
  it('builds scene prompts from public text only', () => {
    const state = sentinelState();
    const names = namesInState(state);
    const prompt = scenePrompt(sceneInput(state), { style: STYLE, names });
    for (const sentinel of SENTINELS) expect(prompt).not.toContain(sentinel);
    for (const name of names) expect(prompt).not.toContain(name);
    expect(prompt).toContain(STYLE);
    expect(prompt).toContain('The Velvet Ledger');
    expect(prompt).toContain('The place: Members-only club.');
    expect(prompt).toContain('Rain taps the windows of a members-only club.');
    expect(prompt).toContain('arrives. Someone polishes a glass behind the bar');
    expect(prompt).toContain('someone guards a pile of paperwork');
    expect(prompt.endsWith('No text.')).toBe(true);
  });

  it('capitalizes the stand-in where a sentence starts in the finished prompt, and only there', () => {
    const scene = (description: string, names: string[]) => scenePrompt({ title: 'A room', description, locationTitle: '' }, { style: STYLE, names });
    expect(scene('The bar opens. Tamsin waves at Tamsin.', ['Tamsin'])).toContain('The bar opens. Someone waves at someone.');
    expect(scene('Who is there? Tamsin! Tamsin.', ['Tamsin'])).toContain('Who is there? Someone! Someone.');
    expect(scene('"Stop." Tamsin turns.', ['Tamsin'])).toContain('"Stop." Someone turns.');
    expect(scene("'Stop.' Tamsin turns.", ['Tamsin'])).toContain("'Stop.' Someone turns.");
    expect(scene('“Stop.” Tamsin turns.', ['Tamsin'])).toContain('“Stop.” Someone turns.');
    expect(scene('Behind the bar, Tamsin waits; Tamsin smiles.', ['Tamsin'])).toContain('Behind the bar, someone waits; someone smiles.');
  });

  it('writes a removed scene title in lowercase after the colon', () => {
    const prompt = scenePrompt({ title: 'Mara Vale at the docks', description: 'Fog.', locationTitle: '' }, { style: STYLE, names: ['Mara Vale'] });
    expect(prompt).toContain('A wide view of a place in a story: someone at the docks.');
  });

  it('writes a removed name in a role in lowercase', () => {
    const prompt = portraitPrompt({ appearance: 'Tall.', role: "Mara's apprentice", pronouns: 'she/her', name: 'Mara' }, { style: STYLE, names: [] });
    expect(prompt).toContain("portrait of one woman, someone's apprentice.");
  });

  it('builds non-player character portraits from appearance and role only', () => {
    const state = sentinelState();
    const names = namesInState(state);
    for (const name of ['Mara Vale', 'Inspector Dax', 'Biscuit']) {
      const details = npcInput(state, name);
      const prompt = portraitPrompt(details, { style: STYLE, names });
      for (const sentinel of SENTINELS) expect(prompt).not.toContain(sentinel);
      for (const hidden of [...names, 'Mara', 'Dax']) expect(prompt).not.toContain(hidden);
      expect(prompt).toContain(STYLE);
      expect(prompt).toContain(details.appearance);
      expect(prompt).toContain(details.role);
    }
  });

  it('builds player portraits from appearance, specialty and pronouns only', () => {
    const state = sentinelState();
    const names = namesInState(state);
    for (const [index, character] of state.characters.entries()) {
      const prompt = portraitPrompt(cardInput(state, index), { style: STYLE, names });
      for (const sentinel of SENTINELS) expect(prompt).not.toContain(sentinel);
      expect(prompt).not.toContain(character.displayName);
      expect(prompt).toContain(STYLE);
      expect(prompt).toContain(character.appearance.replace(/\.$/, ''));
      expect(prompt).toContain(character.specialty.replace(/\.$/, ''));
      expect(prompt).toContain('one woman');
    }
  });

  it('removes the card name even when the caller passes no names', () => {
    const prompt = portraitPrompt({ appearance: 'Quill wears round spectacles.', role: '', pronouns: '', name: 'Quill' }, { style: '', names: [] });
    expect(prompt).not.toContain('Quill');
    expect(prompt).toContain('Someone wears round spectacles.');
  });

  it('lists every character name, NPC name and alias once', () => {
    const state = sentinelState();
    state.npcs[0]!.aliases = ['Mara', ' Mara ', 'Ms. Vale', ''];
    const names = namesInState(state);
    expect(names).toEqual(expect.arrayContaining(['Rook', 'Lark', 'Quill', 'Pip', 'Mara Vale', 'Mara', 'Ms. Vale', 'Inspector Dax', 'Dax', 'Biscuit']));
    expect(new Set(names).size).toBe(names.length);
    expect(names.every((name) => name === name.trim() && name !== '')).toBe(true);
  });

  describe('pictureStyleOf', () => {
    it('gives the default for blank or missing styles', () => {
      expect(pictureStyleOf(undefined)).toBe(DEFAULT_PICTURE_STYLE);
      expect(pictureStyleOf('')).toBe(DEFAULT_PICTURE_STYLE);
      expect(pictureStyleOf('  \n\t ')).toBe(DEFAULT_PICTURE_STYLE);
      expect(pictureStyleOf('...')).toBe(DEFAULT_PICTURE_STYLE);
    });

    it('collapses whitespace and drops trailing periods', () => {
      expect(pictureStyleOf('  Ink   wash\n and  paper.. ')).toBe('Ink wash and paper');
    });

    it('caps the style at 300 characters', () => {
      const style = pictureStyleOf('a'.repeat(500));
      expect(style).toHaveLength(300);
    });

    it('is used in prompts and capped there too', () => {
      expect(scenePrompt({ title: 'T', description: 'D', locationTitle: '' }, { style: '', names: [] }).startsWith(`${DEFAULT_PICTURE_STYLE}. `)).toBe(true);
      expect(portraitPrompt({ appearance: 'A', role: '', pronouns: '', name: '' }, { style: 'b'.repeat(400), names: [] }).startsWith(`${'b'.repeat(300)}. `)).toBe(true);
    });
  });

  describe('withoutNames', () => {
    it('replaces whole words only and keeps possessives', () => {
      expect(withoutNames("Mara's bar is near Marathon Street.", ['Mara'])).toBe("someone's bar is near Marathon Street.");
    });

    it('is case-sensitive', () => {
      expect(withoutNames('Mara and mara and MARA', ['Mara'])).toBe('someone and mara and MARA');
    });

    it('replaces full names first, then each capitalized word of three letters or more', () => {
      expect(withoutNames('Mara Vale met Vale at the Inn; Mara waved.', ['Mara Vale'])).toBe('someone met someone at the Inn; someone waved.');
      expect(withoutNames('Inspector Dax checked his Dax badge.', ['Inspector Dax'])).toBe('someone checked his someone badge.');
    });

    it('skips short words inside a name but still replaces the full name', () => {
      expect(withoutNames('Ty Bo is Ty Bo. Ty waves.', ['Ty Bo'])).toBe('someone is someone. Ty waves.');
    });

    it('prefers the longest name', () => {
      expect(withoutNames('Mara Vale and Mara Voss', ['Mara', 'Mara Vale', 'Mara Voss'])).toBe('someone and someone');
    });

    it('escapes regular-expression characters in names', () => {
      expect(withoutNames('Dr. Who (the (odd) one) left.', ['Dr. Who (the (odd) one)'])).toBe('someone left.');
      expect(withoutNames('A.B and AxB', ['A.B'])).toBe('someone and AxB');
      expect(() => withoutNames('text', ['[', '*', '\\', '(+'])).not.toThrow();
    });

    it('never scrubs common words or titles that only open a name', () => {
      const names = ['The Ferryman', 'Old Tamsin'];
      expect(withoutNames('The Old Lighthouse', names)).toBe('The Old Lighthouse');
      expect(withoutNames('The fog rolls in', names)).toBe('The fog rolls in');
      expect(withoutNames('Old-world oil painting', names)).toBe('Old-world oil painting');
      expect(withoutNames('Tamsin waves at the Ferryman', names)).toBe('someone waves at the someone');
      expect(withoutNames('The Ferryman and Old Tamsin wave', names)).toBe('someone and someone wave');
    });

    it('always writes the stand-in in lowercase', () => {
      expect(withoutNames('Mara Vale polishes a glass.', ['Mara Vale'])).toBe('someone polishes a glass.');
      expect(withoutNames('  Mara waves.', ['Mara'])).toBe('  someone waves.');
      expect(withoutNames('The bar opens before a buyer arrives. Mara Vale polishes a glass.', ['Mara Vale'])).toBe('The bar opens before a buyer arrives. someone polishes a glass.');
      expect(withoutNames('Who is there? Mara! Mara.', ['Mara'])).toBe('Who is there? someone! someone.');
      expect(withoutNames('Behind the bar, Mara waits; Mara Vale smiles.', ['Mara Vale'])).toBe('Behind the bar, someone waits; someone smiles.');
    });

    it('removes a common word only inside a whole name or alias', () => {
      expect(withoutNames('Grey studies the map.', ['Detective Grey'])).toBe('Grey studies the map.');
      expect(withoutNames('Detective Grey studies the map.', ['Detective Grey'])).toBe('someone studies the map.');
      expect(withoutNames('Mary and Black wait. Sister waves.', ['Sister Mary Black'])).toBe('someone and Black wait. Sister waves.');
      expect(withoutNames('The Red Lantern', ['Erik the Red'])).toBe('The Red Lantern');
      expect(withoutNames('Red lanterns sway.', ['Erik the Red'])).toBe('Red lanterns sway.');
      expect(withoutNames('Erik the Red waves.', ['Erik the Red'])).toBe('someone waves.');
    });

    it('keeps a scene title and description that share a word with a name', () => {
      const prompt = scenePrompt({ title: 'The Red Lantern', description: 'Red lanterns sway.', locationTitle: '' }, { style: STYLE, names: ['Erik the Red'] });
      expect(prompt).toContain(': The Red Lantern.');
      expect(prompt).toContain('Red lanterns sway.');
    });

    it('takes a title abbreviation away with the name', () => {
      expect(withoutNames('Mr. Vale waves; Mr Vale nods.', ['Mara Vale'])).toBe('someone waves; someone nods.');
      expect(withoutNames('Dr Vale and Capt. Vale and Mrs. Vale and Ms Vale and Mx. Vale', ['Mara Vale'])).toBe('someone and someone and someone and someone and someone');
      expect(withoutNames('Mr. Mara Vale left.', ['Mara Vale'])).toBe('someone left.');
    });

    it('takes military and professional title abbreviations away too, with or without a space', () => {
      for (const title of ['Lt. Vale', 'Capt. Vale', 'Dr.Vale', 'Sgt Vale', 'Prof. Vale', 'Col. Vale', 'Gen. Vale', 'Maj. Vale', 'Cmdr. Vale', 'Rev. Vale', 'Fr. Vale', 'Insp. Vale', 'Det. Vale']) {
        expect(withoutNames(`${title} waits.`, ['Mara Vale'])).toBe('someone waits.');
      }
    });

    it('never removes a title abbreviation that is part of a name on its own', () => {
      expect(withoutNames('Capt. Reyes nods. Hollis waits.', ['Capt. Hollis'])).toBe('Capt. Reyes nods. someone waits.');
      expect(withoutNames('Det. Reyes and Prof. Reyes', ['Det. Okafor', 'Prof. Quill'])).toBe('Det. Reyes and Prof. Reyes');
    });

    it('keeps place names that share a word with a name', () => {
      const names = ['The Voice', 'The Room', 'The Mall Mother', 'The Whisper at the Fountain', 'Her in the Water', 'Dolores Pike', 'Mrs. Pike', 'Teddy Okafor', 'Jalen Price', 'Marcus Bell'];
      expect(withoutNames('The Waiting Room', names)).toBe('The Waiting Room');
      expect(withoutNames('Center Court Fountain', names)).toBe('Center Court Fountain');
      expect(withoutNames('Halloway Commons Mall. The Mall Mother.', names)).toBe('Halloway Commons Mall. someone.');
      expect(withoutNames('Then Pike lifts the cap', names)).toBe('Then someone lifts the cap');
      expect(withoutNames('The Room watches', names)).toBe('someone watches');
      expect(withoutNames('Teddy, Jalen and Marcus wait.', names)).toBe('someone, someone and someone wait.');
      expect(withoutNames('Her coat is wet.', names)).toBe('Her coat is wet.');
    });

    it('does not treat St as a title, so a street name stays', () => {
      expect(withoutNames('down Main St. Vale waits', ['Mara Vale'])).toBe('down Main St. someone waits');
    });

    it('leaves a title alone when no name follows it or it is part of another word', () => {
      expect(withoutNames('Mr. Smith waves; Mister Vale nods.', ['Mara Vale'])).toBe('Mr. Smith waves; Mister someone nods.');
      expect(withoutNames('Amr Vale waves.', ['Mara Vale'])).toBe('Amr someone waves.');
    });

    it('leaves text alone when there are no names', () => {
      expect(withoutNames('Nobody here.', [])).toBe('Nobody here.');
    });

    it('leaves the style alone so its words survive', () => {
      const scene = { title: 'A room', description: 'Quiet.', locationTitle: '' };
      const portrait = { appearance: 'Tall.', role: '', pronouns: '', name: 'Jack Black' };
      expect(scenePrompt(scene, { style: 'Grey watercolor, soft light', names: ['Detective Grey'] }).startsWith('Grey watercolor, soft light.')).toBe(true);
      expect(portraitPrompt(portrait, { style: 'Black and white film noir', names: [] }).startsWith('Black and white film noir.')).toBe(true);
      expect(scenePrompt(scene, { style: 'In the manner of Mara', names: ['Mara'] })).toContain('In the manner of Mara.');
      expect(portraitPrompt({ ...portrait, name: 'Mara' }, { style: 'In the manner of Mara', names: ['Mara'] })).toContain('In the manner of Mara.');
    });

    it('capitalizes the stand-in after an opening quote that starts a sentence', () => {
      const scene = (description: string) => scenePrompt({ title: 'A room', description, locationTitle: '' }, { style: STYLE, names: ['Mara'] });
      expect(scene('"Mara!" the crowd shouts.')).toContain('"Someone!" the crowd shouts.');
      expect(scene('"Mara, wait!" she calls.')).toContain('"Someone, wait!" she calls.');
      expect(scene('The door opens. “Mara!” the crowd shouts.')).toContain('The door opens. “Someone!” the crowd shouts.');
      expect(withoutNames('"Mara!" the crowd shouts.', ['Mara'])).toBe('"someone!" the crowd shouts.');
      expect(withoutNames('"Mara, wait!" she calls.', ['Mara'])).toBe('"someone, wait!" she calls.');
    });
  });

  describe('portraitSubject', () => {
    it.each([
      ['she/her', 'woman'], ['She/Her', 'woman'], ['her', 'woman'], ['he/him', 'man'], ['He, him', 'man'], ['him', 'man'],
      ['they/them', 'character'], ['ze/zir', 'character'], ['', 'character'], ['  ', 'character'],
    ])('maps %j to %s', (pronouns, expected) => {
      expect(portraitSubject(pronouns)).toBe(expected);
    });
  });

  describe('templates', () => {
    it('follows the scene template', () => {
      expect(scenePrompt({ title: 'The Cellar', description: 'Damp stone and candles.', locationTitle: 'Old wine cellar' }, { style: 'Ink', names: [] })).toBe(
        'Ink. A wide view of a place in a story: The Cellar. The place: Old wine cellar. Damp stone and candles. '
        + 'Show the setting and its mood. Any people are small, distant figures without clear faces. No text.',
      );
    });

    it('skips the place when it repeats the title', () => {
      const prompt = scenePrompt({ title: 'The Cellar', description: 'Damp.', locationTitle: 'The Cellar' }, { style: 'Ink', names: [] });
      expect(prompt).not.toContain('The place:');
    });

    it('follows the portrait template', () => {
      expect(portraitPrompt({ appearance: 'Silver hair and a scar.', role: 'Ship captain', pronouns: 'he/him', name: '' }, { style: 'Ink', names: [] })).toBe(
        'Ink. Head-and-shoulders portrait of one man, Ship captain. Silver hair and a scar. '
        + 'Facing the viewer, centered, plain softly lit background. No text.',
      );
    });

    it('leaves no double spaces or stray commas when pieces are blank', () => {
      const prompts = [
        scenePrompt({ title: '  ', description: '', locationTitle: '' }, { style: '', names: [] }),
        scenePrompt({ title: 'Hall', description: '   ', locationTitle: ' ' }, { style: ' ', names: [] }),
        portraitPrompt({ appearance: '', role: '', pronouns: '', name: '' }, { style: '', names: [] }),
        portraitPrompt({ appearance: '  ', role: ' \n ', pronouns: 'they', name: '' }, { style: '', names: [] }),
        portraitPrompt({ appearance: 'Tall.\n\nThin.', role: 'Cook.', pronouns: '', name: '' }, { style: 'Ink.', names: [] }),
      ];
      for (const prompt of prompts) {
        expect(prompt).not.toMatch(/ {2}/);
        expect(prompt).not.toMatch(/,\s*[.,]/);
        expect(prompt).not.toMatch(/\.\./);
        expect(prompt).not.toMatch(/\p{Cc}/u);
        expect(prompt).toBe(prompt.trim());
      }
      expect(prompts[2]).toBe(`${DEFAULT_PICTURE_STYLE}. Head-and-shoulders portrait of one character. Facing the viewer, centered, plain softly lit background. No text.`);
      expect(prompts[4]).toContain('one character, Cook. Tall. Thin.');
    });

    it('adds a full stop to text that has none', () => {
      expect(portraitPrompt({ appearance: 'Tall and thin', role: '', pronouns: '', name: '' }, { style: 'Ink', names: [] })).toContain('Tall and thin. Facing');
    });
  });

  describe('caps', () => {
    it('clips long descriptions and appearances to their own limits', () => {
      const long = 'word '.repeat(1000);
      const scene = scenePrompt({ title: 'T', description: long, locationTitle: '' }, { style: 'Ink', names: [] });
      expect(scene.length).toBeLessThan(1200);
      const portrait = portraitPrompt({ appearance: long, role: long, pronouns: '', name: '' }, { style: 'Ink', names: [] });
      expect(portrait.length).toBeLessThan(1400);
    });

    it('cuts the final prompt to 2000 characters', () => {
      const long = 'x'.repeat(5000);
      expect(scenePrompt({ title: long, description: long, locationTitle: long + 'y' }, { style: long, names: [] }).length).toBeLessThanOrEqual(2000);
      expect(portraitPrompt({ appearance: long, role: long, pronouns: '', name: '' }, { style: long, names: [] }).length).toBeLessThanOrEqual(2000);
    });

    it('clip cuts at the last sentence end, else the last space', () => {
      expect(clip('One. Two. Three is long.', 15)).toBe('One. Two.');
      expect(clip('alpha beta gamma delta', 13)).toBe('alpha beta');
      expect(clip('abcdefghij', 4)).toBe('abcd');
      expect(clip('  short  ', 50)).toBe('short');
    });
  });
});

describe('sceneLocationTitle', () => {
  function stateWith(locations: SessionState['locations'], locationId: string): SessionState {
    const state = createLedgerState('location-session', () => 'id');
    state.session.scene.locationId = locationId;
    state.locations = locations;
    return state;
  }

  it('returns the title of the scene location', () => {
    expect(sceneLocationTitle(stateWith([{ id: 'a', title: 'Other', description: '' }, { id: 'club', title: 'Members-only club', description: 'Hidden vault.' }], 'club'))).toBe('Members-only club');
  });

  it('gives nothing for the server placeholder, but keeps a described place with that title', () => {
    expect(sceneLocationTitle(stateWith([{ id: 'x', title: 'Current location', description: '  ' }], 'x'))).toBe('');
    expect(sceneLocationTitle(stateWith([{ id: 'x', title: 'Current location', description: 'A real room.' }], 'x'))).toBe('Current location');
  });

  it('gives nothing for an unnamed numbered place, but keeps it when described or not an exact stand-in', () => {
    expect(sceneLocationTitle(stateWith([{ id: 'x', title: 'Other location 1', description: '' }], 'x'))).toBe('');
    expect(sceneLocationTitle(stateWith([{ id: 'x', title: 'Other location 12', description: '  ' }], 'x'))).toBe('');
    expect(sceneLocationTitle(stateWith([{ id: 'x', title: 'Other location 1', description: 'A cellar.' }], 'x'))).toBe('Other location 1');
    expect(sceneLocationTitle(stateWith([{ id: 'x', title: 'Other location', description: '' }], 'x'))).toBe('Other location');
    expect(sceneLocationTitle(stateWith([{ id: 'x', title: 'Other location 1b', description: '' }], 'x'))).toBe('Other location 1b');
  });

  it('leaves the place sentence out of a scene prompt for a stand-in', () => {
    const state = stateWith([{ id: 'x', title: 'Other location 2', description: '' }], 'x');
    const prompt = scenePrompt({ title: 'A room', description: 'Quiet.', locationTitle: sceneLocationTitle(state) }, { style: 'Oil painting', names: [] });
    expect(prompt).not.toContain('The place:');
  });

  it('gives nothing when the location is missing', () => {
    expect(sceneLocationTitle(stateWith([{ id: 'a', title: 'Other', description: '' }], 'gone'))).toBe('');
    expect(sceneLocationTitle(stateWith([], 'gone'))).toBe('');
  });
});

describe('draftNarration', () => {
  const segment = (kind: 'narration' | 'npc_dialogue', text: string, speakerNpcId?: string) =>
    (kind === 'narration' ? { kind, text, recipientCharacterIds: [], delivery: 'plain' } : { kind, text, speakerNpcId, recipientCharacterIds: [], delivery: 'plain' }) as unknown as AiDraft['segments'][number];
  const draft = (...segments: AiDraft['segments']): AiDraft => ({ segments, continuity: [], directorSummary: '' });

  it('joins the narration segments with one space and skips dialogue', () => {
    expect(draftNarration(draft(segment('narration', 'The door opens.'), segment('npc_dialogue', 'Hello there.', 'n1'), segment('narration', '  Dust falls. ')))).toBe('The door opens.   Dust falls. ');
  });

  it('gives an empty string without a draft', () => {
    expect(draftNarration(null)).toBe('');
    expect(draftNarration(undefined)).toBe('');
  });
});

describe('moment prompts', () => {
  const person = (over: Partial<PicturePerson> = {}): PicturePerson => ({ name: 'Mara Vale', appearance: 'A tall woman in a green coat', role: 'Smuggler', pronouns: 'she/her', portraitId: null, imageNumber: null, ...over });
  const moment = (over: Partial<PictureMoment> = {}): PictureMoment => ({
    style: STYLE,
    model: 'krea-2-turbo',
    scene: { title: 'The Velvet Ledger', description: 'A club.', place: 'Members-only club' },
    lines: [{ kind: 'narration', speaker: null, text: 'Mara slams the ledger shut.' }],
    cast: [person({ portraitId: 'p1', imageNumber: 1 })],
    names: ['Mara Vale'],
    ...over,
  });
  const noControl = (text: string) => expect(text).not.toMatch(/\p{Cc}/u);

  describe('momentPrompt', () => {
    it('joins style, description and the closing with references', () => {
      expect(momentPrompt(STYLE, 'Two people argue.', true)).toBe(`${STYLE}. Two people argue. ${MOMENT_CLOSING_REFERENCES}`);
    });

    it('joins style, description and the closing without references', () => {
      expect(momentPrompt(STYLE, 'Two people argue.', false)).toBe(`${STYLE}. Two people argue. ${MOMENT_CLOSING_WORDS}`);
    });

    it('leaves out a blank description', () => {
      expect(momentPrompt(STYLE, '  ', false)).toBe(`${STYLE}. ${MOMENT_CLOSING_WORDS}`);
    });

    it('never cuts the closing and never passes the prompt limit', () => {
      for (const withReferences of [true, false]) {
        const prompt = momentPrompt(STYLE, 'A crowd gathers in the hall. '.repeat(400), withReferences);
        expect(prompt.length).toBeLessThanOrEqual(withReferences ? MOMENT_PROMPT_MAX : PICTURE_PROMPT_MAX);
        expect(prompt.endsWith(withReferences ? MOMENT_CLOSING_REFERENCES : MOMENT_CLOSING_WORDS)).toBe(true);
        expect(prompt.startsWith(`${STYLE}. A crowd gathers in the hall.`)).toBe(true);
      }
    });

    it('fills the whole budget when the description is exactly that long', () => {
      for (const withReferences of [true, false]) {
        const budget = descriptionBudget(STYLE, withReferences);
        const prompt = momentPrompt(STYLE, 'x'.repeat(budget), withReferences);
        expect(prompt.length).toBe(withReferences ? MOMENT_PROMPT_MAX : PICTURE_PROMPT_MAX);
      }
    });

    it('uses the default style for a blank one and drops control characters', () => {
      const prompt = momentPrompt('   ', 'Line one.\nLine two.\u0007', false);
      expect(prompt).toBe(`${DEFAULT_PICTURE_STYLE}. Line one. Line two. ${MOMENT_CLOSING_WORDS}`);
      noControl(prompt);
    });
  });

  describe('descriptionBudget', () => {
    it('is the prompt limit minus the style and the closing', () => {
      expect(descriptionBudget(STYLE, true)).toBe(MOMENT_PROMPT_MAX - `${STYLE}. `.length - ` ${MOMENT_CLOSING_REFERENCES}`.length);
      expect(descriptionBudget(STYLE, false)).toBe(PICTURE_PROMPT_MAX - `${STYLE}. `.length - ` ${MOMENT_CLOSING_WORDS}`.length);
    });

    it("gives a picture drawn from portraits FLUX 3 Klein's longer limit", () => {
      expect(MOMENT_PROMPT_MAX).toBeGreaterThan(PICTURE_PROMPT_MAX);
      expect(descriptionBudget(STYLE, true)).toBeGreaterThan(descriptionBudget(STYLE, false));
    });

    it('counts the default style for a blank style and only the first 300 characters of a long one', () => {
      expect(descriptionBudget('', true)).toBe(descriptionBudget(DEFAULT_PICTURE_STYLE, true));
      expect(descriptionBudget('x'.repeat(MOMENT_PROMPT_MAX), true)).toBe(descriptionBudget('x'.repeat(PICTURE_STYLE_MAX), true));
    });
  });

  describe('cleanDescription', () => {
    it('removes names, including the parts of a name', () => {
      expect(cleanDescription('Mara Vale glares while Vale waits.', ['Mara Vale'], 500)).toBe('Someone glares while someone waits.');
    });

    it('tidies control characters and whitespace', () => {
      const text = cleanDescription('A hall.\n\n  Candles\tflicker.\u0000\u001b', [], 500);
      expect(text).toBe('A hall. Candles flicker.');
      noControl(text);
    });

    it('cuts an over-long reply at a sentence end', () => {
      const text = cleanDescription('First sentence here. Second sentence here. Third sentence here.', [], 45);
      expect(text).toBe('First sentence here. Second sentence here.');
    });

    it('cuts at a space when there is no sentence end, within the budget', () => {
      const text = cleanDescription('word '.repeat(100), [], 23);
      expect(text.length).toBeLessThanOrEqual(23);
      expect(text).toBe('word word word word');
    });

    it('returns an empty string when nothing is left', () => {
      expect(cleanDescription('  \n\t ', [], 100)).toBe('');
      expect(cleanDescription('Some text.', [], 0)).toBe('');
    });
  });

  describe('fallbackDescription', () => {
    it('follows the action picture shape', () => {
      const text = fallbackDescription(moment(), 1000);
      expect(text).toBe('A single dramatic moment in a story: The Velvet Ledger. The place: Members-only club. Someone slams the ledger shut. The people in it: the person from image 1, a tall woman in a green coat.');
    });

    it('leaves out the place when it matches the title', () => {
      const text = fallbackDescription(moment({ scene: { title: 'The club', description: '', place: 'The club' } }), 1000);
      expect(text).not.toContain('The place:');
    });

    it('uses dialogue text when there is no narration', () => {
      const text = fallbackDescription(moment({ lines: [{ kind: 'npc_dialogue', speaker: 'Mara Vale', text: 'Leave the ledger.' }] }), 1000);
      expect(text).toContain('Leave the ledger.');
    });

    it('describes people without an image number by appearance, role, then someone', () => {
      const cast = [
        person({ name: 'A', appearance: 'A boy with a kite' }),
        person({ name: 'B', appearance: '', role: 'Ferry captain' }),
        person({ name: 'C', appearance: '', role: '' }),
        person({ name: 'D', appearance: '', role: '', portraitId: 'p9', imageNumber: 2 }),
      ];
      const text = fallbackDescription(moment({ cast, names: [] }), 1000);
      expect(text).toContain('The people in it: a boy with a kite; Ferry captain; someone; the person from image 2.');
    });

    it('uses the image numbers it is given', () => {
      const cast = [person({ name: 'A', portraitId: 'a', imageNumber: 3 }), person({ name: 'B', portraitId: 'b', imageNumber: 1 })];
      const text = fallbackDescription(moment({ cast, names: [] }), 1000);
      expect(text.indexOf('image 3')).toBeGreaterThan(-1);
      expect(text.indexOf('image 3')).toBeLessThan(text.indexOf('image 1'));
    });

    it('removes names and control characters, including newlines in the narration', () => {
      const lines = [{ kind: 'narration' as const, speaker: null, text: 'Mara Vale walks in.\nThe door\u0000 closes.\r\n\r\nSilence.' }];
      const text = fallbackDescription(moment({ lines, scene: { title: 'Mara Vale returns', description: '', place: 'Vale Hall' }, names: ['Mara Vale'] }), 1000);
      noControl(text);
      expect(text).not.toContain('Mara');
      expect(text.replaceAll('Vale Hall', '')).not.toContain('Vale');
      expect(text).toContain('Vale Hall');
      expect(text).toContain('Someone walks in. The door closes. Silence.');
    });

    it('lists every person of a twelve-person cast within the budget', () => {
      const cast = Array.from({ length: 12 }, (_, index) => person({
        name: `Person${index}`,
        appearance: `Appearance ${index} ${'with a very long coat and many details. '.repeat(30)}`,
        portraitId: index < 10 ? `p${index}` : null,
        imageNumber: index < 10 ? index + 1 : null,
      }));
      const lines = [{ kind: 'narration' as const, speaker: null, text: 'Everyone shouts at once. '.repeat(200) }];
      const budget = descriptionBudget(STYLE, true);
      const text = fallbackDescription(moment({ cast, lines, names: [] }), budget);
      expect(text.length).toBeLessThanOrEqual(budget);
      for (let number = 1; number <= 10; number++) expect(text).toMatch(new RegExp(`image ${number}(?!\\d)`));
      expect(text).toContain('The people in it:');
    });

    it('keeps each person as the bare phrase when space is very tight', () => {
      const cast = Array.from({ length: 12 }, (_, index) => person({ appearance: 'Long appearance text '.repeat(20), portraitId: index < 10 ? `p${index}` : null, imageNumber: index < 10 ? index + 1 : null }));
      const bareList = `${[...Array.from({ length: 10 }, (_, index) => `the person from image ${index + 1}`), 'someone', 'someone'].join('; ')}.`;
      const budget = 'A single dramatic moment in a story: The Velvet Ledger. The place: Members-only club. The people in it: '.length + bareList.length;
      const text = fallbackDescription(moment({ cast, names: [] }), budget);
      expect(text).toBe(`A single dramatic moment in a story: The Velvet Ledger. The place: Members-only club. The people in it: ${bareList}`);
    });

    it('always fits the budget, clipping only when even the bare list cannot fit', () => {
      const cast = Array.from({ length: 12 }, () => person({ portraitId: null, imageNumber: null }));
      for (const budget of [0, 1, 10, 50, 120]) {
        const text = fallbackDescription(moment({ cast }), budget);
        expect(text.length).toBeLessThanOrEqual(budget);
        noControl(text);
      }
    });

    it('shortens the narration before anyone s words', () => {
      const lines = [{ kind: 'narration' as const, speaker: null, text: 'It was a long night. '.repeat(100) }];
      const cast = [person({ name: 'A', appearance: 'A tall woman in a green coat', portraitId: 'a', imageNumber: 1 })];
      const text = fallbackDescription(moment({ lines, cast, names: [] }), 400);
      expect(text.length).toBeLessThanOrEqual(400);
      expect(text).toContain('the person from image 1, a tall woman in a green coat');
    });
  });

  describe('pictureDescriptionRequest', () => {
    it('maps the moment without portrait ids and adds the budget', () => {
      const source = moment({ cast: [person({ portraitId: 'p1', imageNumber: 1 }), person({ name: 'Pip', portraitId: null, imageNumber: null })] });
      const request = pictureDescriptionRequest(source, 900);
      expect(request).toEqual({
        style: STYLE,
        scene: source.scene,
        lines: source.lines,
        cast: [
          { name: 'Mara Vale', appearance: 'A tall woman in a green coat', role: 'Smuggler', pronouns: 'she/her', imageNumber: 1 },
          { name: 'Pip', appearance: 'A tall woman in a green coat', role: 'Smuggler', pronouns: 'she/her', imageNumber: null },
        ],
        budget: 900,
      });
      expect(PictureDescriptionRequestSchema.safeParse(request).success).toBe(true);
    });
  });
});
