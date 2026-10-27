import type { CharacterCardDefinition } from '@rpg/contracts';

export function withDescription(card: CharacterCardDefinition, description: string): CharacterCardDefinition {
  const text = description.trim();
  if (text === '' || (card.appearance ?? '').trim() !== '') return card;
  return { ...card, appearance: text };
}
