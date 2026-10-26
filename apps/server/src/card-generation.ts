import {
  CardDraftSchema, CardGenerationResponseSchema, CharacterCardDefinitionSchema,
  type AiProvider, type CardDraft, type CardGenerationInput, type CardGenerationResponse, type Trait,
} from '@rpg/contracts';
import { ProviderError } from '@rpg/providers';
import { AppError } from './repository';

const TRAITS: Trait[] = ['force', 'finesse', 'wits', 'presence'];
const TEXT_FIELDS = ['displayName', 'appearance', 'personality', 'backstory', 'specialty', 'flaw', 'connection', 'secret'] as const;
const capitalized = (trait: Trait) => trait.charAt(0).toUpperCase() + trait.slice(1);
const words = (value: string) => value.toLowerCase().split(/[^\p{L}]+/u).filter(Boolean);

export function cardFromDraft(draft: CardDraft, input: CardGenerationInput) {
  const notes: string[] = [];
  const current = input.keepFilled ? input.current : undefined;
  const filled = (value: string | undefined) => value !== undefined && value.trim() !== '';

  const fields: Record<(typeof TEXT_FIELDS)[number], string> = {
    displayName: draft.displayName.trim(), appearance: draft.appearance.trim(), personality: draft.personality.trim(),
    backstory: draft.backstory.trim(), specialty: draft.specialty.trim(), flaw: draft.flaw.trim(),
    connection: draft.connection.trim(), secret: draft.secret.trim(),
  };
  let kept = false;
  for (const name of TEXT_FIELDS) {
    const existing = current?.kind === 'character' ? current[name] : undefined;
    if (existing !== undefined && filled(existing)) { fields[name] = existing; kept = true; }
  }

  const strongest = draft.strongestTrait;
  let weakest = draft.weakestTrait;
  if (weakest === strongest) {
    weakest = TRAITS.find(trait => trait !== strongest)!;
    notes.push(`The AI picked the same trait as best and weakest, so ${capitalized(weakest)} is now the weakest.`);
  }
  const traits = Object.fromEntries(TRAITS.map(trait => [trait, trait === strongest ? 2 : trait === weakest ? 0 : 1])) as Record<Trait, number>;

  const heldPossessions = current?.kind === 'character' ? current.possessions ?? [] : [];
  const possessions: string[] = [];
  for (let index = 0; index < 3; index += 1) {
    const mine = heldPossessions[index];
    const value = filled(mine) ? mine!.trim() : (draft.possessions[index] ?? '').trim();
    if (value) possessions.push(value);
  }

  let pronouns: string;
  let pronounsSuggested = false;
  const typed = current?.kind === 'character' ? current.pronouns : undefined;
  if (filled(typed)) pronouns = typed!;
  else {
    pronouns = draft.pronouns.trim();
    if (!pronouns) notes.push('The pronouns box is blank. Add pronouns if you want them.');
    else {
      const promptWords = new Set(words(input.prompt));
      const pronounWords = words(pronouns);
      pronounsSuggested = !(pronounWords.length > 0 && pronounWords.every(word => promptWords.has(word)));
    }
  }
  if (kept) notes.push('Kept what you already wrote.');

  const parsed = CharacterCardDefinitionSchema.safeParse({ schemaVersion: 1, ...fields, pronouns, traits, possessions, extensions: {} });
  if (!parsed.success) throw new AppError(502, 'generation_failed', "The AI's draft did not fit the form. Try again, or fill in the form yourself.");
  return { card: parsed.data, notes, pronounsSuggested };
}

export async function executeCardGeneration(provider: AiProvider, input: CardGenerationInput, timeoutMs = 50_000): Promise<CardGenerationResponse> {
  if (!provider.generateCard) throw new AppError(503, 'generation_unavailable', 'AI drafting is not available right now. You can still fill in the form yourself.');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const output = await Promise.race([
      provider.generateCard(input),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new ProviderError('timeout', 'ClewdR')), timeoutMs); }),
    ]);
    const draft = CardDraftSchema.parse(output);
    const { card, notes, pronounsSuggested } = cardFromDraft(draft, input);
    return CardGenerationResponseSchema.parse({ card, notes: notes.slice(0, 10), pronounsSuggested });
  } catch (error) {
    if (error instanceof ProviderError && error.code === 'timeout') throw new AppError(504, 'generation_timeout', 'The AI took too long. Try again, or fill in the form yourself.');
    throw new AppError(502, 'generation_failed', "The AI's draft did not fit the form. Try again, or fill in the form yourself.");
  } finally { clearTimeout(timer); }
}
