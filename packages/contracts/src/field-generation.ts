import { z } from 'zod';

interface FieldSpec {
  label: string;
  instruction: string;
  kind: 'text' | 'lines';
  maxChars: number;
  maxItems?: number;
  maxItemChars?: number;
}
const text = (label: string, maxChars: number, instruction: string): FieldSpec => ({ label, maxChars, instruction, kind: 'text' });
const lines = (label: string, maxItems: number, maxItemChars: number, instruction: string): FieldSpec => ({ label, maxItems, maxItemChars, maxChars: maxItems * maxItemChars + maxItems - 1, instruction, kind: 'lines' });

// These limits match the native authoring and live command schemas.
export const FIELD_GENERATION_FIELDS = {
  'scenario.title': text('Scenario title', 160, 'Create a concise evocative scenario title.'),
  'scenario.premise': text('Premise', 4000, 'Expand the scenario premise into a playable situation with clear tension.'),
  'scenario.genre': text('Genre', 160, 'Describe the genre concisely.'),
  'scenario.tone': text('Tone', 500, 'Describe the intended atmosphere and tone.'),
  'scenario.pictureStyle': text('Picture style', 300, 'Describe one consistent look for every picture in this show in a short phrase: art medium, color palette and lighting. Do not name characters or places.'),
  'scenario.directorNotes': text('Director notes', 12000, 'Expand private preparation notes for the director.'),
  'scenario.boundaries': lines('Boundaries', 30, 500, 'Clarify only the supplied content boundaries. Preserve every restriction; do not relax them or introduce new permissions.'),
  'scenario.playerHooks': lines('Player hooks', 20, 1000, 'Offer hooks that invite participation without deciding player choices.'),
  'scenario.objectives': lines('Objectives', 20, 1000, 'Describe potential objectives without deciding player choices.'),
  'scenario.discoveries': lines('Discoveries', 20, 2000, 'Develop possible discoveries from the supplied description.'),
  'scenario.opportunities': lines('Opportunities', 20, 2000, 'Develop opportunities available to the party.'),
  'scene.title': text('Scene title', 160, 'Create a concise scene title.'),
  'scene.description': text('Scene description', 6000, 'Describe the public scene with concrete sensory detail, leaving player choices open.'),
  'location.title': text('Location title', 160, 'Create a concise location name.'),
  'location.description': text('Location description', 4000, 'Expand the description of this location.'),
  'npc.displayName': text('Non-player character name', 80, 'Create a name for the non-player character.'),
  'npc.role': text('Role', 160, 'Describe this non-player character role concisely.'),
  'npc.appearance': text('Appearance', 1000, 'Describe outward appearance with concrete visible details.'),
  'npc.hiddenIdentity': text('Hidden identity', 160, 'Describe the private hidden identity concisely.'),
  'npc.motivation': text('Motivation', 1000, 'Expand the motivation of this non-player character.'),
  'npc.goal': text('Goal', 1000, 'Describe a concrete goal for this non-player character.'),
  'npc.mood': text('Mood', 160, 'Describe the current mood concisely.'),
  'npc.communicationChannel': text('Communication channel', 160, 'Describe how this non-player character communicates remotely.'),
  'npc.knowledge': text('Knowledge statement', 6000, 'Expand the supplied knowledge statement, preserving whether it is a fact, belief, or claim when specified.'),
  'npc.relationshipReason': text('Relationship reason', 6000, 'Describe the reason for this non-player character relationship to the party.'),
  'npc.alias': text('Alias', 80, 'Create one alias.'),
  'npc.personalityItem': text('Personality detail', 500, 'Expand one personality detail.'),
  'npc.limit': text('Limit', 500, 'Clarify one personal limit without relaxing it.'),
  'npc.dialogueExample': text('Dialogue example', 1000, 'Write one sample line of non-player character dialogue.'),
  'npc.secret': text('Secret', 2000, 'Develop one private secret.'),
  'npc.aliases': lines('Aliases', 10, 80, 'Suggest aliases, one per line.'),
  'npc.personality': lines('Personality', 10, 500, 'Expand personality details, one per line.'),
  'npc.limits': lines('Limits', 10, 500, 'Clarify the supplied personal limits without relaxing them, one per line.'),
  'npc.dialogueExamples': lines('Dialogue examples', 10, 1000, 'Write example non-player character dialogue, one line per example.'),
  'npc.secrets': lines('Secrets', 10, 2000, 'Develop private secrets, one per line.'),
  'track.label': text('Track label', 120, 'Create a concise label for this progress, danger, or countdown track.'),
  'track.completionText': text('Completion text', 2000, 'Describe the fictional completion of this track without inventing mechanical changes.'),
  'fact.text': text('Fact', 6000, 'Clarify the supplied world fact.'),
  'character.displayName': text('Character name', 80, 'Create a character name.'),
  'character.pronouns': text('Pronouns', 80, 'Format only the pronouns explicitly supplied; do not infer them from other characteristics.'),
  'character.appearance': text('Character appearance', 1000, 'Describe outward appearance with concrete visible details.'),
  'character.personality': text('Character personality', 2000, 'Expand the character personality.'),
  'character.backstory': text('Backstory', 4000, 'Expand the character backstory.'),
  'character.specialty': text('Specialty', 1000, 'Describe the character specialty without inventing mechanical bonuses.'),
  'character.flaw': text('Flaw', 1000, 'Develop a playable character flaw without assigning mechanical effects.'),
  'character.connection': text('Party connection', 1000, 'Describe the character connection to the party without deciding other players choices.'),
  'character.secret': text('Character secret', 2000, 'Develop the private character secret.'),
  'character.possession': text('Possession', 160, 'Name and briefly describe one possession without inventing mechanical bonuses.'),
  'session.title': text('Show title', 160, 'Create a concise title for this show.'),
  'live.publicReveal': text('Public reveal', 6000, 'Write public wording for only the supplied revelation. Do not infer additional secrets.'),
  'script.narration': text('Narration', 6000, 'Expand the narration without choosing actions, speech, feelings, or outcomes for players or changing mechanics.'),
  'script.npcDialogue': text('Non-player character dialogue', 6000, 'Expand this non-player character line while preserving its intent. Do not write player dialogue or change mechanics.'),
} satisfies Record<string, FieldSpec>;

export type FieldGenerationField = keyof typeof FIELD_GENERATION_FIELDS;
export function allowsPremise(field: FieldGenerationField): boolean {
  return !(['scenario.premise', 'scenario.boundaries', 'npc.limit', 'npc.limits', 'character.pronouns', 'live.publicReveal'] as FieldGenerationField[]).includes(field);
}

export const MAX_FIELD_GENERATION_CONTEXT_BYTES = 120_000;
export const MAX_FIELD_GENERATION_REQUEST_BYTES = 256 * 1024;
const serializedBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const draftText = (max: number) => z.string().max(max).optional();
const draftList = (maxItems: number, maxChars: number) => z.array(z.string().max(maxChars)).max(maxItems).optional();
const stance = z.enum(['hostile', 'wary', 'neutral', 'friendly', 'trusting']);
export const FieldGenerationCharacterContextSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('character'), displayName: draftText(80), pronouns: draftText(80), appearance: draftText(1000),
    personality: draftText(2000), backstory: draftText(4000), specialty: draftText(1000), flaw: draftText(1000),
    connection: draftText(1000), secret: draftText(2000), possessions: draftList(3, 160),
    traits: z.strictObject({ force: z.number().int().min(0).max(2).optional(), finesse: z.number().int().min(0).max(2).optional(), wits: z.number().int().min(0).max(2).optional(), presence: z.number().int().min(0).max(2).optional() }).optional(),
  }),
  z.strictObject({
    kind: z.literal('npc'), displayName: draftText(80), role: draftText(160), appearance: draftText(1000),
    aliases: draftList(10, 80), hiddenIdentity: z.string().max(160).nullable().optional(), personality: draftList(10, 500),
    motivation: draftText(1000), goal: draftText(1000), limits: draftList(10, 500), dialogueExamples: draftList(10, 1000),
    mood: draftText(160), locationId: draftText(128), status: z.enum(['present', 'offstage']).optional(),
    communicationChannel: z.string().max(160).nullable().optional(), voiceProfileId: draftText(128), secrets: draftList(10, 2000),
    knowledge: z.array(z.strictObject({ statement: z.string().max(6000), category: z.enum(['fact', 'belief', 'claim']) })).optional(),
    partyRelationship: z.strictObject({ stance, reason: z.string().max(6000) }).nullable().optional(),
    relationships: z.array(z.strictObject({ targetCharacterId: z.string().max(128).nullable(), stance, reason: z.string().max(6000) })).optional(),
  }),
]).refine(value => serializedBytes(value) <= MAX_FIELD_GENERATION_CONTEXT_BYTES, 'Character details exceed 120 KB. Shorten the character notes before generating.');
export type FieldGenerationCharacterContext = z.infer<typeof FieldGenerationCharacterContextSchema>;

export function hasUsefulCharacterContext(context?: FieldGenerationCharacterContext): boolean {
  if (!context) return false;
  const containsText = (value: unknown): boolean => {
    if (typeof value === 'string') return Boolean(value.trim());
    if (Array.isArray(value)) return value.some(containsText);
    if (value && typeof value === 'object') return Object.entries(value).some(([key, entry]) =>
      !['kind', 'traits', 'locationId', 'voiceProfileId', 'status', 'category', 'stance', 'targetCharacterId'].includes(key) && containsText(entry));
    return false;
  };
  return containsText(context);
}

export const FieldGenerationRequestSchema = z.strictObject({
  field: z.enum(Object.keys(FIELD_GENERATION_FIELDS) as [FieldGenerationField, ...FieldGenerationField[]]),
  seed: z.string().trim().max(12000),
  premise: z.string().trim().min(1).max(4000).optional(),
  instructions: z.string().trim().min(1).max(4000).optional(),
  characterContext: FieldGenerationCharacterContextSchema.optional(),
}).refine(input => Boolean(input.seed || input.premise || (allowsPremise(input.field) && (input.instructions || hasUsefulCharacterContext(input.characterContext)))), 'Provide a description, scenario premise, director instructions, or existing character details.')
  .refine(input => input.instructions === undefined || input.field.startsWith('character.'), 'Director character instructions can only guide character fields.')
  .refine(input => input.premise === undefined || allowsPremise(input.field), 'This field needs an explicit description without a premise.')
  .refine(input => input.characterContext === undefined || input.field.startsWith(`${input.characterContext.kind}.`), { message: 'Character details must match the character field being generated.', path: ['characterContext'] })
  .refine(input => serializedBytes(input) <= MAX_FIELD_GENERATION_REQUEST_BYTES, 'The drafting request is too large. Shorten the description or character notes.');
export type FieldGenerationRequest = z.infer<typeof FieldGenerationRequestSchema>;

export const CharacterBuilderFieldGenerationRequestSchema = z.strictObject({
  expectedRevision: z.number().int().min(0),
  field: FieldGenerationRequestSchema.shape.field.refine(field => field.startsWith('character.'), 'Only character fields can be generated here.'),
  seed: FieldGenerationRequestSchema.shape.seed,
  characterContext: FieldGenerationCharacterContextSchema.refine(context => context.kind === 'character', 'Only this character card can be used as context.'),
}).refine(input => serializedBytes(input) <= MAX_FIELD_GENERATION_REQUEST_BYTES, 'The drafting request is too large. Shorten the description or character notes.');
export type CharacterBuilderFieldGenerationRequest = z.infer<typeof CharacterBuilderFieldGenerationRequestSchema>;
export const FieldGenerationResponseSchema = z.strictObject({ text: z.string() });
export type FieldGenerationResponse = z.infer<typeof FieldGenerationResponseSchema>;

export function validateFieldGenerationText(field: FieldGenerationField, value: string): string {
  const spec = FIELD_GENERATION_FIELDS[field];
  const normalized = z.string().parse(value).replace(/\r\n?/g, '\n').trim();
  if (spec.kind === 'text') return z.string().min(1).max(spec.maxChars).parse(normalized);
  const items = z.array(z.string().trim().min(1).max(spec.maxItemChars!)).min(1).max(spec.maxItems!).parse(normalized.split('\n'));
  return items.join('\n');
}
