export const CARD_NAME_MESSAGE = 'Give your character a name. Nothing has been saved.';
export const CARD_TRAIT_MESSAGE = 'Give the four traits one +2, two +1 and one +0. They are under More about your character.';

const BOX_NAMES: Record<string, string> = {
  pronouns: 'Pronouns',
  appearance: 'Appearance',
  personality: 'Personality',
  backstory: 'Backstory',
  specialty: 'Specialty',
  flaw: 'Flaw',
  possessions: 'Possessions',
  connection: 'Connection to the party',
  secret: 'Private secret',
};

export function cardSaveMessage(issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey> }>): string {
  const keys = issues.map(issue => issue.path[0]);
  if (keys.includes('displayName')) return CARD_NAME_MESSAGE;
  if (keys.includes('traits')) return CARD_TRAIT_MESSAGE;
  const first = keys[0];
  const box = typeof first === 'string' && Object.hasOwn(BOX_NAMES, first) ? BOX_NAMES[first] : 'the card';
  return `Check ${box} under More about your character. Nothing has been saved.`;
}
