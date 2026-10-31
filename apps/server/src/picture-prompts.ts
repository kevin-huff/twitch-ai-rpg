import {
  type AiDraft, type Beat, DEFAULT_PICTURE_STYLE, MOMENT_PROMPT_MAX, PICTURE_PROMPT_MAX, PICTURE_STYLE_MAX, type PictureDescriptionRequest, type PictureMoment, type PicturePerson, type PortraitDetails, type SessionState,
} from '@rpg/contracts';

const WORD = '\\p{L}\\p{N}_';
// A title abbreviation directly before a removed name goes with it ("Mr. Vale").
const TITLE_BEFORE_NAME = `(?:(?<![${WORD}])(?:Mrs|Mr|Ms|Mx|Dr|Capt|Lt|Sgt|Col|Gen|Maj|Cmdr|Prof|Rev|Fr|Insp|Det)(?:\\.\\s*|\\s+))?`;

// Titles and everyday words that appear in names ("The Ferryman", "Old Tamsin", "Detective Grey", "Capt. Hollis"); they are never removed on their own, only inside a whole name or alias, because picture models read "Grey" as a color.
const COMMON_NAME_WORDS = new Set([
  'the', 'and', 'von', 'van', 'del', 'sir', 'dame', 'lady', 'lord', 'madam', 'mister', 'miss', 'mrs', 'captain', 'sergeant', 'officer', 'agent',
  'capt', 'sgt', 'col', 'gen', 'maj', 'cmdr', 'prof', 'rev', 'insp', 'det',
  'detective', 'inspector', 'doctor', 'professor', 'father', 'mother', 'sister', 'brother', 'aunt', 'uncle', 'king', 'queen', 'prince', 'princess',
  'duke', 'duchess', 'baron', 'count', 'saint', 'master', 'mistress', 'elder', 'old', 'young', 'big', 'little', 'tall', 'red', 'black', 'white', 'grey', 'gray',
  'her', 'his', 'its', 'who', 'one',
]);

// Collapses whitespace and drops control characters, so no piece can leave double spaces or break a request.
const tidy = (text: string | undefined) => (text ?? '').replace(/\p{Cc}/gu, ' ').replace(/\s+/g, ' ').trim();
const withoutPeriods = (text: string) => text.replace(/[.\s]+$/, '');
const sentence = (text: string) => (text && !/[.!?]$/.test(text) ? `${text}.` : text);
const escapePattern = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Cuts at the last sentence end, or failing that the last space, at or before max characters.
export function clip(text: string, max: number): string {
  const value = tidy(text);
  if (value.length <= max) return value;
  const head = value.slice(0, max);
  const ends = [...head.matchAll(/[.!?](?=\s|$)/g)];
  if (ends.length > 0) return head.slice(0, ends[ends.length - 1].index + 1);
  const space = head.lastIndexOf(' ');
  return space > 0 ? head.slice(0, space) : head;
}

export function pictureStyleOf(style: string | undefined): string {
  const value = withoutPeriods(tidy(style)).slice(0, PICTURE_STYLE_MAX).trim();
  return value === '' ? DEFAULT_PICTURE_STYLE : value;
}

// The stand-in is lowercase; the finished prompt capitalizes it where a sentence starts, also next to a quote mark.
const capitalizeSomeone = (text: string) => text.replace(new RegExp(`(^["'“‘]?|[.!?]["'”’]?\\s+["'“‘]?)someone(?![${WORD}])`, 'gu'), '$1Someone');

// Models draw names as garbled text and a name would not match the portraits, so the picture never sees one.
export function withoutNames(text: string, names: string[]): string {
  const full = [...new Set(names.map(tidy).filter(Boolean))].sort((a, b) => b.length - a.length || a.localeCompare(b));
  const nameParts = (name: string) => {
    const found = name.match(/\p{Lu}\p{L}{2,}/gu) ?? [];
    return found.filter(part => !COMMON_NAME_WORDS.has(part.toLowerCase()));
  };
  const parts = [...new Set(full.flatMap(nameParts))].sort((a, b) => b.length - a.length || a.localeCompare(b));
  const partSet = new Set(parts);
  let result = text;
  for (const name of full) {
    result = result.replace(new RegExp(`${TITLE_BEFORE_NAME}(?<![${WORD}])${escapePattern(name)}(?![${WORD}])`, 'gu'), 'someone');
  }
  for (const part of parts) {
    result = result.replace(
      new RegExp(`${TITLE_BEFORE_NAME}(?<![${WORD}])${escapePattern(part)}(?![${WORD}])`, 'gu'),
      (match: string, offset: number, whole: string) => (insideAnotherName(whole, offset, offset + match.length, partSet) ? match : 'someone'),
    );
  }
  return result;
}

// A word that only shares a part with a name stays when it sits in another proper noun ("The Waiting Room", "Center Court Fountain"): a capitalised neighbour one space away that is no common word, no name part and, before it, not just a sentence's first word.
function insideAnotherName(text: string, start: number, end: number, nameParts: Set<string>): boolean {
  const properNoun = (word: string | undefined) => word !== undefined && /^\p{Lu}/u.test(word) && !COMMON_NAME_WORDS.has(word.toLowerCase()) && !nameParts.has(word);
  const after = new RegExp(`^ ([${WORD}]+)`, 'u').exec(text.slice(end))?.[1];
  if (properNoun(after)) return true;
  const before = new RegExp(`(?<![${WORD}])([${WORD}]+) $`, 'u').exec(text.slice(0, start));
  if (!before || !properNoun(before[1])) return false;
  const opensSentence = /(?:^|[.!?]["'”’]?\s)["'“‘]?\s*$/u.test(text.slice(0, before.index));
  return !opensSentence;
}

// The title of the scene's place, or '' when it is missing or only the server's stand-in for an unnamed place ("Current location" or "Other location N").
export function sceneLocationTitle(state: SessionState): string {
  const location = state.locations.find((place) => place.id === state.session.scene.locationId);
  if (!location) return '';
  const standIn = location.title === 'Current location' || /^Other location \d+$/.test(location.title);
  return standIn && tidy(location.description) === '' ? '' : location.title;
}

export function namesInState(state: SessionState): string[] {
  const names = [
    ...state.characters.map((character) => character.displayName),
    ...state.npcs.flatMap((npc) => [npc.displayName, ...npc.aliases]),
  ].map(tidy).filter(Boolean);
  return [...new Set(names)];
}

export function portraitSubject(pronouns: string): 'woman' | 'man' | 'character' {
  const first = tidy(pronouns).toLowerCase().split(/[/\s,]+/).find(Boolean) ?? '';
  if (first === 'she' || first === 'her') return 'woman';
  if (first === 'he' || first === 'him') return 'man';
  return 'character';
}

export function scenePrompt(
  scene: { title: string; description: string; locationTitle: string },
  options: { style: string; names: string[] },
): string {
  const clean = (text: string) => tidy(withoutNames(tidy(text), options.names));
  const style = pictureStyleOf(options.style);
  const title = withoutPeriods(clean(scene.title));
  const place = withoutPeriods(clean(scene.locationTitle));
  const description = sentence(clip(clean(scene.description), 900));
  return capitalizeSomeone([
    `${style}.`,
    `A wide view of a place in a story${title ? `: ${title}` : ''}.`,
    place && place !== title ? `The place: ${place}.` : '',
    description,
    'Show the setting and its mood. Any people are small, distant figures without clear faces. No text.',
  ].filter(Boolean).join(' ')).slice(0, PICTURE_PROMPT_MAX).trim();
}

export function portraitPrompt(details: PortraitDetails, options: { style: string; names: string[] }): string {
  const names = [...options.names, details.name];
  const clean = (text: string) => tidy(withoutNames(tidy(text), names));
  const style = pictureStyleOf(options.style);
  const role = withoutPeriods(clip(clean(details.role), 200));
  const appearance = sentence(clip(clean(details.appearance), 900));
  return capitalizeSomeone([
    `${style}.`,
    `Head-and-shoulders portrait of one ${portraitSubject(details.pronouns)}${role ? `, ${role}` : ''}.`,
    appearance,
    'Facing the viewer, centered, plain softly lit background. No text.',
  ].filter(Boolean).join(' ')).slice(0, PICTURE_PROMPT_MAX).trim();
}

// The draft's narration text in order, without dialogue; '' when there is no draft.
export function draftNarration(draft: AiDraft | null | undefined): string {
  return (draft?.segments ?? []).filter((segment) => segment.kind === 'narration').map((segment) => segment.text).join(' ');
}

export const MOMENT_CLOSING_REFERENCES = "Keep each person's face, hair, build and clothing as in their reference image. Everyone fully clothed. No text, no letters.";
export const MOMENT_CLOSING_WORDS = 'Everyone fully clothed. No text.';

// "the person from image 2", "the people from images 2 and 4", "the people from images 1, 3 and 5".
const changedLookWho = (changed: number[]) => {
  if (changed.length === 1) return `the person from image ${changed[0]}`;
  return `the people from images ${changed.slice(0, -1).join(', ')} and ${changed[changed.length - 1]}`;
};

// The numbers of people whose look was edited since their portrait was made, ascending; only numbered people have a reference image to be overridden.
export function changedLookNumbers(cast: PicturePerson[]): number[] {
  return cast.flatMap((person) => (person.lookEdited && person.imageNumber !== null ? [person.imageNumber] : [])).sort((a, b) => a - b);
}

const momentClosing = (withReferences: boolean, changed: number[] = []) => {
  if (withReferences && changed.length > 0) {
    return `Keep each person's face, hair and build as in their reference image, and their clothing too, except ${changedLookWho(changed)}, dressed as the words describe instead. Everyone fully clothed. No text, no letters.`;
  }
  return withReferences ? MOMENT_CLOSING_REFERENCES : MOMENT_CLOSING_WORDS;
};

// The room the description has: the prompt limit minus the style and the closing, which are never cut. Only a picture drawn from portraits goes to FLUX 3 Klein, which takes the longer prompt.
export function descriptionBudget(style: string, withReferences: boolean, changed: number[] = []): number {
  const limit = withReferences ? MOMENT_PROMPT_MAX : PICTURE_PROMPT_MAX;
  return Math.max(0, limit - `${pictureStyleOf(style)}. `.length - ` ${momentClosing(withReferences, changed)}`.length);
}

export function momentPrompt(style: string, description: string, withReferences: boolean, changed: number[] = []): string {
  const head = `${pictureStyleOf(style)}.`;
  const closing = momentClosing(withReferences, changed);
  const text = clip(description, descriptionBudget(style, withReferences, changed));
  return [head, text, closing].filter(Boolean).join(' ');
}

// Cleans the story AI's reply: names out, whitespace and control characters tidied, cut at a sentence end to fit the budget.
export function cleanDescription(text: string, names: string[], budget: number): string {
  return clip(capitalizeSomeone(tidy(withoutNames(tidy(text), names))), budget);
}

// A piece of text with the moment's names and every control character removed.
const momentText = (text: string, names: string[]) => tidy(withoutNames(tidy(text), names));

function momentNarration(moment: PictureMoment, names: string[]): string {
  const of = (kinds: PictureMoment['lines'][number]['kind'][]) => moment.lines.filter((line) => kinds.includes(line.kind)).map((line) => momentText(line.text, names)).filter(Boolean).join(' ');
  return of(['narration']) || of(['npc_dialogue', 'player_dialogue', 'player_action']) || of(['outcome']);
}

// A leading article is lowercased so the words read on after "the person from image 1,".
const lowerArticle = (text: string) => text.replace(/^(A|An|The)(?=\s)/, (word) => word.toLowerCase());
const trimEnd = (text: string) => text.replace(/[\s.,;:]+$/, '');

export function fallbackDescription(moment: PictureMoment, budget: number): string {
  if (budget <= 0) return '';
  const names = moment.names;
  const title = withoutPeriods(momentText(moment.scene.title, names));
  const place = withoutPeriods(momentText(moment.scene.place, names));
  const narration = momentNarration(moment, names);
  const head = [`A single dramatic moment in a story${title ? `: ${title}` : ''}.`, place && place !== title ? `The place: ${place}.` : ''].filter(Boolean).join(' ');
  const words = moment.cast.map((person: PicturePerson) => ({
    numbered: person.imageNumber !== null,
    number: person.imageNumber,
    text: lowerArticle(momentText(person.appearance, names) || (person.imageNumber === null ? momentText(person.role, names) : '')),
  }));
  const longest = Math.max(0, ...words.map((person) => person.text.length));
  const build = (narrationMax: number, personMax: number) => {
    const people = words.map((person) => {
      const text = trimEnd(clip(person.text, personMax));
      if (person.numbered) return text ? `the person from image ${person.number}, ${text}` : `the person from image ${person.number}`;
      return text || 'someone';
    });
    const body = narrationMax > 0 ? sentence(clip(narration, narrationMax)) : '';
    const list = people.length > 0 ? `The people in it: ${people.join('; ')}.` : '';
    return capitalizeSomeone([head, body, list].filter(Boolean).join(' '));
  };
  // The longest value that still fits; the length only grows with the limit.
  const largest = (high: number, fits: (limit: number) => boolean) => {
    let low = 0;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (fits(middle)) low = middle; else high = middle - 1;
    }
    return low;
  };
  const fits = (text: string) => text.length <= budget;
  if (fits(build(narration.length, longest))) return build(narration.length, longest);
  if (fits(build(0, longest))) return build(largest(narration.length, (limit) => fits(build(limit, longest))), longest);
  return build(0, largest(longest, (limit) => fits(build(0, limit)))).slice(0, budget).trim();
}

export function pictureDescriptionRequest(moment: PictureMoment, budget: number): PictureDescriptionRequest {
  return {
    style: moment.style,
    scene: moment.scene,
    lines: moment.lines,
    cast: moment.cast.map(({ portraitId: _portraitId, ...person }) => person),
    budget,
  };
}
