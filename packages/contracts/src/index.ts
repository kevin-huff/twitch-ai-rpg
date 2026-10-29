import { z } from 'zod';
export * from './access';
export * from './draft-audio';
export * from './gallery';
export * from './images';
export * from './operations';
export * from './playback';
export * from './voices';
import type { VoiceChoice } from './voices';
import { VoiceRefSchema, elevenVoiceId, voicedWords } from './voices';
import { ActionPictureStatusSchema, PICTURE_STYLE_MAX, PictureLineSchema, PictureModelIdSchema, PicturePersonSchema, PictureSceneSchema, PictureSettingsSchema, PortraitJobSchema, ScenePictureSchema, ScenePictureStatusSchema } from './images';
import { GalleryStatusSchema } from './gallery';
import type { FieldGenerationRequest, FieldGenerationResponse } from './field-generation';
import { FieldGenerationCharacterContextSchema, FieldGenerationRequestSchema, MAX_FIELD_GENERATION_REQUEST_BYTES } from './field-generation';
export * from './field-generation';

export const IdSchema = z.string().min(1).max(128);
const RevisionSchema = z.number().int().nonnegative();
const TextSchema = z.string().min(1).max(6000);
export const RoleSchema = z.enum(['director', 'player', 'stage']);
export type Role = z.infer<typeof RoleSchema>;
export const TraitSchema = z.enum(['force', 'finesse', 'wits', 'presence']);
export type Trait = z.infer<typeof TraitSchema>;
export const TraitsSchema = z.strictObject({
  force: z.number().int().min(0).max(2), finesse: z.number().int().min(0).max(2),
  wits: z.number().int().min(0).max(2), presence: z.number().int().min(0).max(2),
}).refine((traits) => Object.values(traits).sort().join(',') === '0,1,1,2', 'Traits must allocate +2, +1, +1 and +0.');
export type Traits = z.infer<typeof TraitsSchema>;
export const OutcomeBandSchema = z.enum(['clean', 'costly', 'setback', 'critical']);
export type OutcomeBand = z.infer<typeof OutcomeBandSchema>;
export const VisibilitySchema = z.enum(['public', 'director']);
export const DeliverySchema = z.enum(['neutral', 'quiet', 'urgent', 'amused']);

export const TemplateRefSchema = z.strictObject({ templateId: IdSchema, version: z.number().int().positive() });
export type TemplateRef = z.infer<typeof TemplateRefSchema>;
export const MAX_NATIVE_BYTES = 120_000;
const nativeSize = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= MAX_NATIVE_BYTES;
const ExtensionsSchema = z.record(z.string().max(80), z.union([z.string().max(2000), z.number().finite(), z.boolean(), z.null()]))
  .refine(value => Object.keys(value).length <= 30, 'At most 30 extension values are supported.').default({});
const authoredCharacter = {
  displayName: z.string().trim().min(1).max(80), pronouns: z.string().max(80).default(''),
  appearance: z.string().max(1000).default(''), personality: z.string().max(2000).default(''),
  backstory: z.string().max(4000).default(''), traits: TraitsSchema,
  specialty: z.string().max(1000).default(''), flaw: z.string().max(1000).default(''),
  possessions: z.array(z.string().trim().min(1).max(160)).max(3).default([]),
  connection: z.string().max(1000).default(''), secret: z.string().max(2000).default(''),
  portraitId: IdSchema.optional(),
};
export const CharacterCardDefinitionSchema = z.strictObject({ schemaVersion: z.literal(1), ...authoredCharacter, extensions: ExtensionsSchema })
  .refine(nativeSize, 'Native definitions must be no larger than 120 KB.');
export type CharacterCardDefinition = z.infer<typeof CharacterCardDefinitionSchema>;
export const CharacterBuilderDraftSchema = z.strictObject({
  ...CharacterCardDefinitionSchema.shape,
  displayName: z.string().max(80),
  traits: z.strictObject({
    force: z.number().int().min(0).max(2), finesse: z.number().int().min(0).max(2),
    wits: z.number().int().min(0).max(2), presence: z.number().int().min(0).max(2),
  }),
  possessions: z.array(z.string().max(160)).max(3).default([]),
}).refine(nativeSize, 'Character drafts must be no larger than 120 KB.');
export type CharacterBuilderDraft = z.infer<typeof CharacterBuilderDraftSchema>;
export const CreateCharacterBuilderSchema = z.strictObject({
  commandId: IdSchema, label: z.string().trim().min(1).max(80), instructions: z.string().max(4000).default(''),
});
export type CreateCharacterBuilder = z.infer<typeof CreateCharacterBuilderSchema>;
export const SaveCharacterBuilderSchema = z.strictObject({
  commandId: IdSchema, expectedRevision: RevisionSchema, draft: CharacterBuilderDraftSchema,
});
export type SaveCharacterBuilder = z.infer<typeof SaveCharacterBuilderSchema>;
export const SubmitCharacterBuilderSchema = z.strictObject({
  commandId: IdSchema, expectedRevision: RevisionSchema,
  draft: CharacterBuilderDraftSchema.transform((draft, ctx) => {
    const parsed = CharacterCardDefinitionSchema.safeParse({ ...draft, possessions: draft.possessions.map(value => value.trim()).filter(Boolean) });
    if (!parsed.success) {
      for (const issue of parsed.error.issues) ctx.addIssue({ code: 'custom', path: issue.path, message: issue.message });
      return z.NEVER;
    }
    return parsed.data;
  }),
});
export type SubmitCharacterBuilder = z.infer<typeof SubmitCharacterBuilderSchema>;
export const CharacterBuilderSummarySchema = z.strictObject({
  id: IdSchema, label: z.string().min(1).max(80), instructions: z.string().max(4000),
  createdAt: z.string().datetime(), expiresAt: z.string().datetime(), revokedAt: z.string().datetime().nullable(),
  submittedAt: z.string().datetime().nullable(), submittedTemplate: TemplateRefSchema.nullable(),
});
export type CharacterBuilderSummary = z.infer<typeof CharacterBuilderSummarySchema>;
export const CharacterBuilderSnapshotSchema = z.strictObject({
  id: IdSchema, label: z.string().min(1).max(80), instructions: z.string().max(4000),
  revision: RevisionSchema, draft: CharacterBuilderDraftSchema, expiresAt: z.string().datetime(), submittedTemplate: TemplateRefSchema.nullable(),
  picturesEnabled: z.boolean().optional(),
});
export type CharacterBuilderSnapshot = z.infer<typeof CharacterBuilderSnapshotSchema>;
export const CharacterBuilderLinkSchema = z.strictObject({ builder: CharacterBuilderSummarySchema, token: z.string().min(1).max(1024) });
export type CharacterBuilderLink = z.infer<typeof CharacterBuilderLinkSchema>;
export const CharacterBuilderAccessSchema = z.strictObject({ identityId: z.string().regex(/^[a-f0-9]{32}$/), builder: CharacterBuilderSnapshotSchema });
export type CharacterBuilderAccess = z.infer<typeof CharacterBuilderAccessSchema>;
export const SessionSetupSchema = z.strictObject({
  boundaries: z.array(z.string().trim().min(1).max(500)).max(30), boundariesRevision: RevisionSchema,
  started: z.boolean(), scenario: TemplateRefSchema,
});
export type SessionSetup = z.infer<typeof SessionSetupSchema>;
export const PacingSchema = z.strictObject({
  conversationWords: z.number().int().min(20).max(300).default(90), actionWords: z.number().int().min(30).max(500).default(120),
});
export const ScenarioBriefSchema = z.strictObject({
  premise: z.string().max(4000), genre: z.string().max(160), tone: z.string().max(500),
  objectives: z.array(z.string().max(1000)).max(20), playerHooks: z.array(z.string().max(1000)).max(20), pacing: PacingSchema,
  pictureStyle: z.string().max(300).optional(),
});
export type ScenarioBrief = z.infer<typeof ScenarioBriefSchema>;

export const CharacterSchema = z.strictObject({
  id: IdSchema, displayName: z.string().min(1).max(80), traits: TraitsSchema,
  strain: z.number().int().min(0).max(4), appearance: z.string().max(1000).default(''),
  specialty: z.string().max(1000).default(''), flaw: z.string().max(1000).default(''),
  possessions: z.array(z.string().max(160)).max(20).default([]), connection: z.string().max(1000).default(''),
  secret: z.string().max(2000).default(''), approved: z.boolean().default(true),
  pronouns: authoredCharacter.pronouns, personality: authoredCharacter.personality, backstory: authoredCharacter.backstory,
  templateRef: TemplateRefSchema.nullable().default(null), cardRevision: RevisionSchema.default(0),
  draft: CharacterCardDefinitionSchema.nullable().default(null), ready: z.boolean().default(false),
  acceptedBoundariesRevision: RevisionSchema.nullable().default(null), portraitId: authoredCharacter.portraitId,
  cardSource: z.enum(['host', 'player']).optional(), voiceProfileId: IdSchema.nullable().default(null),
});
export type Character = z.infer<typeof CharacterSchema>;
export const PublicCharacterSchema = CharacterSchema.pick({
  id: true, displayName: true, traits: true, strain: true, appearance: true, approved: true, ready: true, portraitId: true,
});
export type PublicCharacter = z.infer<typeof PublicCharacterSchema>;

export const NpcKnowledgeSchema = z.strictObject({
  id: IdSchema, statement: TextSchema, category: z.enum(['fact', 'belief', 'claim']),
  acquisition: z.enum(['scenario', 'witnessed', 'overheard', 'told']), sourceEventId: IdSchema,
  sourceEntityId: IdSchema.nullable(), learnedBeatNumber: RevisionSchema,
});
export type NpcKnowledge = z.infer<typeof NpcKnowledgeSchema>;
export const RelationshipSchema = z.strictObject({
  targetCharacterId: IdSchema.nullable(), stance: z.enum(['hostile', 'wary', 'neutral', 'friendly', 'trusting']),
  reason: TextSchema, sourceEventId: IdSchema,
});
export const NpcSchema = z.strictObject({
  id: IdSchema, displayName: z.string().min(1).max(80), role: z.string().max(160),
  appearance: z.string().max(1000).default(''), aliases: z.array(z.string().max(80)).default([]),
  hiddenIdentity: z.string().max(160).nullable().default(null), personality: z.array(z.string().max(500)).default([]),
  motivation: z.string().max(1000).default(''), goal: z.string().max(1000).default(''),
  limits: z.array(z.string().max(500)).default([]), dialogueExamples: z.array(z.string().max(1000)).default([]),
  mood: z.string().max(160).default('neutral'), locationId: IdSchema, status: z.enum(['present', 'offstage']),
  communicationChannel: z.string().max(160).nullable().default(null), voiceProfileId: IdSchema,
  secrets: z.array(z.string().max(2000)).default([]), knowledge: z.array(NpcKnowledgeSchema).default([]),
  relationships: z.array(RelationshipSchema).default([]), version: RevisionSchema.default(1), portraitId: IdSchema.optional(),
});
export type Npc = z.infer<typeof NpcSchema>;
export const PublicNpcSchema = NpcSchema.pick({
  id: true, displayName: true, role: true, appearance: true, status: true, voiceProfileId: true, portraitId: true,
});
export type PublicNpc = z.infer<typeof PublicNpcSchema>;

const incident = { incidentId: IdSchema.optional() };
export const EffectSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('track_delta'), trackId: IdSchema, delta: z.number().int().min(-8).max(8), ...incident }),
  z.strictObject({ kind: z.literal('strain_delta'), characterId: IdSchema, delta: z.number().int().min(-4).max(4), ...incident }),
  z.strictObject({ kind: z.literal('fact_add'), factId: IdSchema, text: TextSchema, visibility: VisibilitySchema, ...incident }),
  z.strictObject({ kind: z.literal('inventory_add'), characterId: IdSchema, item: z.string().min(1).max(160), ...incident }),
  z.strictObject({ kind: z.literal('inventory_remove'), characterId: IdSchema, item: z.string().min(1).max(160), ...incident }),
]);
export type Effect = z.infer<typeof EffectSchema>;
export const TrackSchema = z.strictObject({
  id: IdSchema, label: z.string().min(1).max(120), kind: z.enum(['progress', 'danger', 'countdown']),
  current: z.number().int().nonnegative(), max: z.number().int().min(1).max(8), visibility: VisibilitySchema,
  trigger: z.enum(['action_round']).nullable().default(null), enabled: z.boolean().default(true),
  completionText: z.string().max(2000).default(''), completionEffects: z.array(EffectSchema).default([]),
}).refine((track) => track.current <= track.max, 'Track current value exceeds its maximum.');
export type Track = z.infer<typeof TrackSchema>;
export const PublicTrackSchema = z.strictObject({
  id: IdSchema, label: z.string(), kind: z.enum(['progress', 'danger', 'countdown']),
  current: z.number().int().nonnegative(), max: z.number().int().positive(),
  completionText: z.string(), enabled: z.boolean(),
});
export const FactSchema = z.strictObject({
  id: IdSchema, text: TextSchema, visibility: VisibilitySchema, sourceEventId: IdSchema,
});
export type Fact = z.infer<typeof FactSchema>;
export const PublicFactSchema = FactSchema.pick({ id: true, text: true });

export const CorrectionChangeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('fact_replace'), factId: IdSchema, text: z.string().trim().min(1).max(6000),
    knowledgeUpdates: z.array(z.strictObject({ npcId: IdSchema, knowledgeId: IdSchema, mode: z.enum(['correct', 'retain_belief']) })) }),
  z.strictObject({ kind: z.literal('strain_set'), characterId: IdSchema, value: z.number().int().min(0).max(4) }),
  z.strictObject({ kind: z.literal('track_set'), trackId: IdSchema, value: z.number().int().min(0).max(8) }),
]);
export type CorrectionChange = z.infer<typeof CorrectionChangeSchema>;
export const CorrectionChangesSchema = z.array(CorrectionChangeSchema).max(10).superRefine((changes, ctx) => {
  const targets = new Set<string>();
  const memories = new Set<string>();
  changes.forEach((change, index) => {
    const target = JSON.stringify([change.kind, change.kind === 'fact_replace' ? change.factId : change.kind === 'strain_set' ? change.characterId : change.trackId]);
    if (targets.has(target)) ctx.addIssue({ code: 'custom', path: [index], message: 'Correct each state value only once.' });
    targets.add(target);
    if (change.kind === 'fact_replace') change.knowledgeUpdates.forEach((update, memoryIndex) => {
      const key = JSON.stringify([update.npcId, update.knowledgeId]);
      if (memories.has(key)) ctx.addIssue({ code: 'custom', path: [index, 'knowledgeUpdates', memoryIndex], message: 'Correct each existing memory only once.' });
      memories.add(key);
    });
  });
});
export const PublicCorrectionSchema = z.strictObject({
  id: IdSchema, publishedBeatId: IdSchema, beatNumber: z.number().int().positive(), stateRevision: RevisionSchema,
  recordedAt: z.string().datetime(), publicText: z.string().trim().min(1).max(3000),
});
export type PublicCorrection = z.infer<typeof PublicCorrectionSchema>;

export const SceneSchema = z.strictObject({
  id: IdSchema, title: z.string().min(1).max(160), description: z.string().max(6000), locationId: IdSchema,
});
export const LocationSchema = z.strictObject({ id: IdSchema, title: z.string().trim().min(1).max(160), description: z.string().max(4000).default('') });
export type Location = z.infer<typeof LocationSchema>;
export const NpcDefinitionSchema = NpcSchema.omit({ version: true, knowledge: true, relationships: true }).extend({
  aliases: z.array(z.string().max(80)).max(10).default([]), personality: z.array(z.string().max(500)).max(10).default([]),
  limits: z.array(z.string().max(500)).max(10).default([]), dialogueExamples: z.array(z.string().max(1000)).max(10).default([]),
  secrets: z.array(z.string().max(2000)).max(10).default([]),
  knowledge: z.array(z.strictObject({ statement: TextSchema, category: z.enum(['fact', 'belief', 'claim']) })).max(30).default([]),
  partyRelationship: z.strictObject({ stance: z.enum(['hostile', 'wary', 'neutral', 'friendly', 'trusting']), reason: TextSchema }).nullable().default(null),
});
export type NpcDefinition = z.infer<typeof NpcDefinitionSchema>;
export const LiveNpcProfileSchema = NpcDefinitionSchema.omit({ id: true, knowledge: true, partyRelationship: true }).extend({
  displayName: z.string().trim().min(1).max(80),
});
export type LiveNpcProfile = z.infer<typeof LiveNpcProfileSchema>;
export const ScenarioDefinitionSchema = z.strictObject({
  schemaVersion: z.literal(1), title: z.string().trim().min(1).max(160), premise: z.string().max(4000).default(''),
  genre: z.string().max(160).default(''), tone: z.string().max(500).default(''),
  pictureStyle: z.string().trim().max(300).optional(),
  pictureModel: PictureModelIdSchema.optional(),
  boundaries: z.array(z.string().trim().min(1).max(500)).max(30).default([]),
  locations: z.array(LocationSchema).min(1).max(30),
  openingScene: SceneSchema, npcs: z.array(NpcDefinitionSchema).max(20).default([]),
  tracks: z.array(TrackSchema).max(20).default([]), facts: z.array(FactSchema.omit({ sourceEventId: true })).max(50).default([]),
  playerHooks: z.array(z.string().max(1000)).max(20).default([]), objectives: z.array(z.string().max(1000)).max(20).default([]),
  discoveries: z.array(z.string().max(2000)).max(20).default([]), opportunities: z.array(z.string().max(2000)).max(20).default([]),
  directorNotes: z.string().max(12000).default(''), rulesVersion: z.literal('0.1').default('0.1'),
  pacing: PacingSchema.default({ conversationWords: 90, actionWords: 120 }), extensions: ExtensionsSchema,
}).superRefine((scenario, ctx) => {
  const ids = [scenario.openingScene.id, ...scenario.locations.map(item => item.id), ...scenario.npcs.map(item => item.id), ...scenario.tracks.map(item => item.id), ...scenario.facts.map(item => item.id)];
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', message: 'Every package entity needs a unique identifier.' });
  const locations = new Set(scenario.locations.map(item => item.id));
  if (!locations.has(scenario.openingScene.locationId)) ctx.addIssue({ code: 'custom', path: ['openingScene', 'locationId'], message: 'Choose an existing location.' });
  scenario.npcs.forEach((npc, index) => {
    if (!locations.has(npc.locationId)) ctx.addIssue({ code: 'custom', path: ['npcs', index, 'locationId'], message: 'Choose an existing location.' });
    if (npc.status === 'present' && npc.locationId !== scenario.openingScene.locationId) ctx.addIssue({ code: 'custom', path: ['npcs', index, 'status'], message: 'Present characters must be at the opening location.' });
  });
  const tracks = new Set(scenario.tracks.map(item => item.id));
  const countdowns = new Set(scenario.tracks.filter(item => item.kind === 'countdown').map(item => item.id));
  const newFacts = new Set<string>();
  scenario.tracks.forEach((track, index) => {
    if (track.completionEffects.length > 20) ctx.addIssue({ code: 'custom', path: ['tracks', index], message: 'At most 20 completion effects are supported.' });
    if (track.completionEffects.length && (track.kind !== 'countdown' || track.trigger !== 'action_round')) ctx.addIssue({ code: 'custom', path: ['tracks', index], message: 'Automatic completion effects require an action-round countdown.' });
    for (const effect of track.completionEffects) {
      if (effect.incidentId) { ctx.addIssue({ code: 'custom', path: ['tracks', index, 'completionEffects'], message: 'Countdown completion effects cannot declare shared player incidents.' }); continue; }
      if (effect.kind === 'track_delta' && tracks.has(effect.trackId) && !countdowns.has(effect.trackId)) continue;
      if (effect.kind === 'fact_add' && !ids.includes(effect.factId) && !newFacts.has(effect.factId)) { newFacts.add(effect.factId); continue; }
      ctx.addIssue({ code: 'custom', path: ['tracks', index, 'completionEffects'], message: 'Use existing track targets or unique new facts; reusable scenarios cannot target player seats.' });
    }
  });
}).refine(nativeSize, 'Native definitions must be no larger than 120 KB.');
export type ScenarioDefinition = z.infer<typeof ScenarioDefinitionSchema>;
const templateSave = { commandId: IdSchema, templateId: IdSchema.optional(), expectedVersion: RevisionSchema };
export const SaveScenarioSchema = z.strictObject({ ...templateSave, definition: ScenarioDefinitionSchema })
  .refine(value => value.templateId ? value.expectedVersion > 0 : value.expectedVersion === 0, 'Supply the current version when editing, or version zero when creating.');
export const SaveCharacterTemplateSchema = z.strictObject({ ...templateSave, definition: CharacterCardDefinitionSchema })
  .refine(value => value.templateId ? value.expectedVersion > 0 : value.expectedVersion === 0, 'Supply the current version when editing, or version zero when creating.');
export type SaveScenario = z.infer<typeof SaveScenarioSchema>;
export type SaveCharacterTemplate = z.infer<typeof SaveCharacterTemplateSchema>;
export interface TemplateVersion<T> { id: string; version: number; definition: T }
export interface Library { scenarios: TemplateVersion<ScenarioDefinition>[]; characters: TemplateVersion<CharacterCardDefinition>[]; picturesEnabled?: boolean }
export const SessionSummarySchema = z.strictObject({
  id: IdSchema, title: z.string().min(1).max(160), status: z.enum(['lobby', 'live', 'paused', 'ended']),
  mode: z.enum(['conversation', 'action']), stateRevision: RevisionSchema, beatNumber: RevisionSchema,
  actionRoundNumber: RevisionSchema, inputEpoch: RevisionSchema, scene: SceneSchema, brief: ScenarioBriefSchema.optional(),
});
export type SessionSummary = z.infer<typeof SessionSummarySchema>;
export const SessionStateSchema = z.strictObject({
  schemaVersion: z.literal(1), rulesVersion: z.literal('0.1'), session: SessionSummarySchema,
  characters: z.array(CharacterSchema), npcs: z.array(NpcSchema), tracks: z.array(TrackSchema), facts: z.array(FactSchema),
  directorNotes: z.string().max(12000).default(''), setup: SessionSetupSchema.optional(),
  locations: z.array(LocationSchema).max(100).default([]),
});
export type SessionState = z.infer<typeof SessionStateSchema>;

export const SubmissionSchema = z.strictObject({
  id: IdSchema, sessionId: IdSchema, characterId: IdSchema, contextBeatId: IdSchema.nullable(), inputEpoch: RevisionSchema,
  revision: RevisionSchema, kind: z.enum(['say', 'act', 'ooc']), text: z.string().max(4000),
  recipientNpcIds: z.array(IdSchema).max(2).default([]), intent: z.string().max(2000).default(''),
  approach: z.string().max(2000).default(''), stageDirection: z.string().max(1000).default(''),
  alreadySpokenAloud: z.boolean().default(true), status: z.enum(['queued', 'selected', 'locked', 'published', 'cancelled']),
});
export type Submission = z.infer<typeof SubmissionSchema>;
export const OutcomeBranchSchema = z.strictObject({ publicText: TextSchema, effects: z.array(EffectSchema).max(30) });
export const ActionContractSchema = z.strictObject({
  id: IdSchema, version: z.number().int().positive(), actorCharacterId: IdSchema,
  helperCharacterIds: z.array(IdSchema).max(5), submissionIds: z.array(IdSchema).min(1).max(6),
  intent: TextSchema, approach: TextSchema, ruling: z.enum(['check', 'no_check', 'blocked']),
  trait: TraitSchema, edge: z.union([z.literal(0), z.literal(1)]), edgeReason: z.string().max(1000).nullable(),
  risk: z.enum(['low', 'normal', 'high']), prerequisites: z.array(z.strictObject({
    contractId: IdSchema, requirement: z.literal('goal_achieved'),
  })).max(5), fallback: z.strictObject({ kind: z.literal('hold') }).default({ kind: 'hold' }),
  outcomes: z.strictObject({ clean: OutcomeBranchSchema, costly: OutcomeBranchSchema, setback: OutcomeBranchSchema, critical: OutcomeBranchSchema.optional() }),
});
export type ActionContract = z.infer<typeof ActionContractSchema>;
export const PublicActionContractSchema = z.strictObject({
  id: IdSchema, version: z.number().int().positive(), actorCharacterId: IdSchema,
  helperCharacterIds: z.array(IdSchema), intent: TextSchema, approach: TextSchema, ruling: z.enum(['check', 'no_check', 'blocked']),
  trait: TraitSchema, edge: z.union([z.literal(0), z.literal(1)]), edgeReason: z.string().nullable(),
  risk: z.enum(['low', 'normal', 'high']),
  outcomes: z.strictObject({ clean: TextSchema, costly: TextSchema, setback: TextSchema, critical: TextSchema.optional() }),
});
export type PublicActionContract = z.infer<typeof PublicActionContractSchema>;
export const RollSchema = z.strictObject({
  id: IdSchema, contractId: IdSchema, contractVersion: z.number().int().positive(), actorCharacterId: IdSchema,
  faces: z.tuple([z.number().int().min(1).max(6), z.number().int().min(1).max(6)]), trait: TraitSchema,
  traitModifier: z.number().int().min(0).max(2), edge: z.union([z.literal(0), z.literal(1)]),
  total: z.number().int().min(2).max(15), band: OutcomeBandSchema,
});
export type Roll = z.infer<typeof RollSchema>;
export const ResolvedOutcomeSchema = z.strictObject({
  contractId: IdSchema, actorCharacterId: IdSchema, status: z.enum(['resolved', 'held', 'blocked']),
  band: OutcomeBandSchema.nullable(), goalAchieved: z.boolean(), publicText: TextSchema,
});
export type ResolvedOutcome = z.infer<typeof ResolvedOutcomeSchema>;
export const ResolutionSchema = z.strictObject({
  rolls: z.array(RollSchema), outcomes: z.array(ResolvedOutcomeSchema), effects: z.array(EffectSchema),
  effectGroups: z.array(z.array(EffectSchema)).optional(),
});
export type Resolution = z.infer<typeof ResolutionSchema>;

const authored = {
  text: TextSchema, recipientCharacterIds: z.array(IdSchema).max(6), delivery: DeliverySchema, voiceText: TextSchema.optional(),
};
export const AiSegmentSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('narration'), speakerNpcId: z.null().optional(), ...authored }),
  z.strictObject({ kind: z.literal('npc_dialogue'), speakerNpcId: IdSchema, ...authored }),
]);
export type AiSegment = z.infer<typeof AiSegmentSchema>;
export const ScriptSegmentSchema = z.strictObject({
  id: IdSchema, kind: z.enum(['narration', 'npc_dialogue', 'player_dialogue', 'player_action', 'system']), text: TextSchema,
  speaker: z.strictObject({ entityId: IdSchema, displayName: z.string().min(1).max(80) }).nullable(),
  recipientCharacterIds: z.array(IdSchema), delivery: DeliverySchema, sourceSubmissionIds: z.array(IdSchema),
  voiceProfileId: IdSchema.nullable(), ttsEnabled: z.boolean(), voiceText: TextSchema.optional(),
});
export type ScriptSegment = z.infer<typeof ScriptSegmentSchema>;
export type PlayerSegmentKind = 'player_dialogue' | 'player_action';
export type SpokenSegmentKind = Exclude<ScriptSegment['kind'], 'system'>;
export function isPlayerSegmentKind(kind: string): kind is PlayerSegmentKind {
  return kind === 'player_dialogue' || kind === 'player_action';
}
export function isSpokenSegmentKind(kind: string): kind is SpokenSegmentKind {
  return kind === 'narration' || kind === 'npc_dialogue' || kind === 'player_dialogue' || kind === 'player_action';
}
export function playerWords(line: Pick<Submission, 'kind' | 'text' | 'intent' | 'approach'>): string {
  if (line.kind === 'say') return line.text;
  if (line.kind !== 'act') return '';
  const parts = [line.intent, line.approach].filter((part) => part.trim());
  if (parts.length === 2 && parts[0]!.trim() === parts[1]!.trim()) return parts[0]!;
  return parts.join('\n');
}
const tidySpoken = (value: string) => value
  .replace(/<\/?[a-z][^>]*>/gi, ' ')
  .replace(/[ \t]+/g, ' ')
  .replace(/ ?\n ?/g, '\n')
  .trim();
export function spokenText(line: {
  kind: string; speaker: string; text: string; voiceText?: string;
  delivery?: 'neutral' | 'quiet' | 'urgent' | 'amused'; voiceProfileId?: string | null;
}): string {
  const words = tidySpoken(voicedWords({ text: line.text, voiceText: line.voiceText, delivery: line.delivery ?? 'neutral' }));
  if (!isPlayerSegmentKind(line.kind)) return words;
  if (line.kind === 'player_dialogue' && elevenVoiceId(line.voiceProfileId) && words) return words;
  const name = line.speaker.replace(/<\/?[a-z][^>]*>/gi, ' ').replace(/\s+/g, ' ').trim();
  if (!words) return name;
  if (!name) return words;
  return `${name}: ${words}`;
}
export const ContinuityUpdateSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('npc_knowledge'), npcId: IdSchema, statement: TextSchema,
    category: z.enum(['fact', 'belief', 'claim']), acquisition: z.enum(['witnessed', 'overheard', 'told']),
    sourceSubmissionIds: z.array(IdSchema).min(1), sourceEntityId: IdSchema.nullable(),
  }),
  z.strictObject({ kind: z.literal('world_fact'), factId: IdSchema, text: TextSchema, visibility: VisibilitySchema,
    sourceSubmissionIds: z.array(IdSchema).min(1) }),
]);
export type ContinuityUpdate = z.infer<typeof ContinuityUpdateSchema>;
export const AiDraftSchema = z.strictObject({
  segments: z.array(AiSegmentSchema).min(1).max(30), continuity: z.array(ContinuityUpdateSchema).max(30),
  directorSummary: z.string().max(3000),
});
export type AiDraft = z.infer<typeof AiDraftSchema>;
export const BeatPhaseSchema = z.enum(['collecting', 'stakes_review', 'locked', 'draft_review', 'published', 'aborted']);
export type BeatPhase = z.infer<typeof BeatPhaseSchema>;
export const BeatSchema = z.strictObject({
  id: IdSchema, sessionId: IdSchema, kind: z.enum(['conversation', 'action']), phase: BeatPhaseSchema,
  revision: RevisionSchema, inputEpoch: RevisionSchema, sourceStateRevision: RevisionSchema,
  selectedSubmissionIds: z.array(IdSchema), lockedSubmissions: z.array(SubmissionSchema),
  contracts: z.array(ActionContractSchema), stakesApproved: z.boolean(),
  classification: z.enum(['ordinary', 'needs_action', 'action']).nullable(),
  inputSnapshotHash: z.string().nullable(), resolution: ResolutionSchema.nullable(),
  draft: AiDraftSchema.nullable(), draftRevision: RevisionSchema, approvedContinuity: z.array(ContinuityUpdateSchema),
  generation: RevisionSchema, lastError: z.string().nullable(),
  steering: z.string().trim().max(3000).optional(),
});
export type Beat = z.infer<typeof BeatSchema>;
export const PublicBeatSchema = z.strictObject({
  id: IdSchema, kind: z.enum(['conversation', 'action']), phase: BeatPhaseSchema, revision: RevisionSchema,
  stakes: z.array(PublicActionContractSchema), locked: z.boolean(), stakesApproved: z.boolean().optional(),
});
export type PublicBeat = z.infer<typeof PublicBeatSchema>;
export const PublishedBeatSchema = z.strictObject({
  id: IdSchema, kind: z.enum(['conversation', 'action']), beatNumber: z.number().int().positive(),
  actionRoundNumber: RevisionSchema, stateRevision: RevisionSchema, publishedAt: z.string(),
  segments: z.array(ScriptSegmentSchema), rolls: z.array(RollSchema), outcomes: z.array(ResolvedOutcomeSchema),
  textOnly: z.boolean(), audioManifestKey: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).refine(value => value.textOnly ? value.audioManifestKey === undefined : value.audioManifestKey !== undefined, 'Voiced publication requires its selected recording.');
export type PublishedBeat = z.infer<typeof PublishedBeatSchema>;
export const GenerationJobSchema = z.strictObject({
  id: IdSchema, beatId: IdSchema, task: z.enum(['plan', 'render']), generation: RevisionSchema,
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']), error: z.string().nullable(),
});
export type GenerationJob = z.infer<typeof GenerationJobSchema>;

const snapshotBase = {
  schemaVersion: z.literal(1), session: SessionSummarySchema, eventSeq: RevisionSchema,
  characters: z.array(PublicCharacterSchema), npcs: z.array(PublicNpcSchema), tracks: z.array(PublicTrackSchema),
  facts: z.array(PublicFactSchema), history: z.array(PublishedBeatSchema), corrections: z.array(PublicCorrectionSchema).default([]),
  picturesEnabled: z.boolean().default(false), scenePicture: ScenePictureSchema.nullable().default(null),
};
export const DirectorSnapshotSchema = z.strictObject({
  ...snapshotBase, role: z.literal('director'), activeBeat: BeatSchema.nullable(),
  submissions: z.array(SubmissionSchema), npcDetails: z.array(NpcSchema), characterDetails: z.array(CharacterSchema),
  jobs: z.array(GenerationJobSchema), directorNotes: z.string(), setup: SessionSetupSchema.optional(),
  locations: z.array(LocationSchema).max(100).default([]),
  scenePictureStatus: ScenePictureStatusSchema.nullable().default(null), actionPicture: ActionPictureStatusSchema.nullable().default(null), portraitJobs: z.array(PortraitJobSchema).max(50).default([]),
  pictureSettings: PictureSettingsSchema.nullable().default(null), lastSceneBeatId: IdSchema.nullable().default(null),
  gallery: GalleryStatusSchema.nullable().default(null),
});
export type DirectorSnapshot = z.infer<typeof DirectorSnapshotSchema>;
export const PlayerSnapshotSchema = z.strictObject({
  ...snapshotBase, role: z.literal('player'), activeBeat: PublicBeatSchema.nullable(),
  ownCharacter: CharacterSchema.nullable(), submissions: z.array(SubmissionSchema), setup: SessionSetupSchema.optional(),
});
export type PlayerSnapshot = z.infer<typeof PlayerSnapshotSchema>;
export const StageSnapshotSchema = z.strictObject({
  ...snapshotBase, role: z.literal('stage'), activeBeat: PublicBeatSchema.nullable(),
});
export type StageSnapshot = z.infer<typeof StageSnapshotSchema>;
export const SessionSnapshotSchema = z.discriminatedUnion('role', [DirectorSnapshotSchema, PlayerSnapshotSchema, StageSnapshotSchema]);
export type SessionSnapshot = z.infer<typeof SessionSnapshotSchema>;

const commandBase = { commandId: IdSchema };
const beatCommand = { ...commandBase, beatId: IdSchema, expectedBeatRevision: RevisionSchema };
const liveCommand = { ...commandBase, expectedStateRevision: RevisionSchema, reason: z.string().trim().min(1).max(1000), discardQueuedInput: z.literal(true) };
const uniqueNpcIds = z.array(IdSchema).max(50).refine(ids => new Set(ids).size === ids.length, 'Choose each character once.');
export const CommandSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('record_correction'), ...liveCommand, publishedBeatId: IdSchema,
    publicText: z.string().trim().min(1).max(3000), changes: CorrectionChangesSchema }),
  z.strictObject({ type: z.literal('set_beat_steering'), ...beatCommand, text: z.string().trim().max(3000) }),
  z.strictObject({ type: z.literal('change_scene'), ...liveCommand, title: z.string().trim().min(1).max(160), description: z.string().max(6000),
    location: z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('existing'), locationId: IdSchema }), z.strictObject({ kind: z.literal('new'), title: z.string().trim().min(1).max(160), description: z.string().max(4000).default('') })]), presentNpcIds: uniqueNpcIds }),
  z.strictObject({ type: z.literal('save_npc'), ...liveCommand, npcId: IdSchema.optional(), expectedNpcVersion: RevisionSchema, profile: LiveNpcProfileSchema })
    .refine(value => value.npcId ? value.expectedNpcVersion > 0 : value.expectedNpcVersion === 0, 'Supply the current NPC version, or zero for a new character.'),
  z.strictObject({ type: z.literal('reveal_npc'), ...liveCommand, npcId: IdSchema, expectedNpcVersion: z.number().int().positive(),
    source: z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('secret'), index: z.number().int().nonnegative() }), z.strictObject({ kind: z.literal('identity') })]),
    publicText: z.string().trim().min(1).max(6000), witnessNpcIds: uniqueNpcIds }),
  z.strictObject({ type: z.literal('save_character'), ...commandBase, expectedCharacterRevision: RevisionSchema, card: CharacterCardDefinitionSchema, characterId: IdSchema.optional() }),
  z.strictObject({ type: z.literal('remove_seat'), ...commandBase, expectedStateRevision: RevisionSchema, characterId: IdSchema }),
  z.strictObject({ type: z.literal('approve_character'), ...commandBase, characterId: IdSchema, expectedCharacterRevision: RevisionSchema }),
  z.strictObject({ type: z.literal('set_ready'), ...commandBase, expectedCharacterRevision: RevisionSchema, expectedBoundariesRevision: RevisionSchema, ready: z.boolean() }),
  z.strictObject({ type: z.literal('set_boundaries'), ...commandBase, expectedStateRevision: RevisionSchema, boundaries: z.array(z.string().trim().min(1).max(500)).max(30) }),
  z.strictObject({ type: z.literal('start_session'), ...commandBase, expectedStateRevision: RevisionSchema, overrideUnreadyReason: z.string().trim().min(1).max(1000).optional() }),
  z.strictObject({
    type: z.literal('save_submission'), ...commandBase, submissionId: IdSchema.optional(), expectedSubmissionRevision: RevisionSchema,
    contextBeatId: IdSchema.nullable(), expectedInputEpoch: RevisionSchema, kind: z.enum(['say', 'act', 'ooc']),
    text: z.string().max(4000), recipientNpcIds: z.array(IdSchema).max(2).default([]),
    intent: z.string().max(2000).default(''), approach: z.string().max(2000).default(''),
    stageDirection: z.string().max(1000).default(''), alreadySpokenAloud: z.boolean().default(true),
  }),
  z.strictObject({ type: z.literal('cancel_submission'), ...commandBase, submissionId: IdSchema, expectedSubmissionRevision: RevisionSchema }),
  z.strictObject({ type: z.literal('open_beat'), ...commandBase, kind: z.enum(['conversation', 'action']), expectedInputEpoch: RevisionSchema }),
  z.strictObject({ type: z.literal('narrate_scene'), ...commandBase, expectedInputEpoch: RevisionSchema }),
  z.strictObject({ type: z.literal('plan_beat'), ...beatCommand, submissionIds: z.array(IdSchema).min(1).max(12) }),
  z.strictObject({ type: z.literal('approve_stakes'), ...beatCommand, contracts: z.array(ActionContractSchema).max(12), classification: z.enum(['ordinary', 'action']) }),
  z.strictObject({ type: z.literal('lock_beat'), ...beatCommand }),
  z.strictObject({ type: z.literal('render_beat'), ...beatCommand }),
  z.strictObject({ type: z.literal('edit_script'), ...beatCommand, segments: z.array(AiSegmentSchema).min(1).max(30) }),
  z.strictObject({ type: z.literal('approve_continuity'), ...beatCommand, updates: z.array(ContinuityUpdateSchema).max(30) }),
  z.strictObject({ type: z.literal('publish_beat'), ...beatCommand, expectedStateRevision: RevisionSchema, draftRevision: RevisionSchema, textOnly: z.boolean(), audioPreparationId: z.uuid().optional() })
    .refine(value => value.textOnly ? value.audioPreparationId === undefined : value.audioPreparationId !== undefined, 'Choose text-only publication or a prepared recording.'),
  z.strictObject({ type: z.literal('abort_beat'), ...beatCommand, reason: TextSchema }),
  z.strictObject({ type: z.literal('set_voice'), ...commandBase, voiceProfileId: VoiceRefSchema.nullable() }),
  z.strictObject({ type: z.literal('set_status'), ...commandBase, status: z.enum(['live', 'paused', 'ended']), expectedStateRevision: RevisionSchema }),
]);
export type Command = z.infer<typeof CommandSchema>;
export const CommandResponseSchema = z.strictObject({ commandId: IdSchema, eventSeq: RevisionSchema, snapshot: SessionSnapshotSchema });
export type CommandResponse = z.infer<typeof CommandResponseSchema>;
export const SeatChoiceSchema = z.union([TemplateRefSchema, z.strictObject({ playerWritten: z.literal(true) })]);
export type SeatChoice = z.infer<typeof SeatChoiceSchema>;
export const CreateSessionSchema = z.strictObject({ commandId: IdSchema, title: z.string().min(1).max(160).optional(),
  scenario: TemplateRefSchema.optional(), characters: z.array(SeatChoiceSchema).min(2).max(6).optional(),
}).refine(value => Boolean(value.scenario) === Boolean(value.characters), 'Select both a scenario and a cast for a custom session.');
export const InviteSchema = z.strictObject({ role: z.enum(['player', 'stage']), characterId: IdSchema.nullable(), token: z.string().min(20) });
export const CreateSessionResponseSchema = z.strictObject({ sessionId: IdSchema, invites: z.array(InviteSchema) });
export type CreateSessionResponse = z.infer<typeof CreateSessionResponseSchema>;
export const RedeemResponseSchema = z.strictObject({
  sessionId: IdSchema, role: RoleSchema, characterId: IdSchema.nullable(),
  identityId: z.string().regex(/^[a-f0-9]{32}$/).optional(),
});
export type RedeemResponse = z.infer<typeof RedeemResponseSchema>;
export const SessionEventSchema = z.strictObject({ schemaVersion: z.literal(1), eventId: IdSchema, sessionId: IdSchema, eventSeq: RevisionSchema });
export type SessionEvent = z.infer<typeof SessionEventSchema>;
export const ErrorResponseSchema = z.strictObject({ code: z.string(), message: z.string(), recoverable: z.boolean() });
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

export interface PlanResult {
  classification: 'ordinary' | 'needs_action' | 'action';
  contracts: ActionContract[];
  directorSummary: string;
}

export interface ProviderContext {
  state: SessionState;
  beat: Beat;
  submissions: Submission[];
  history: PublishedBeat[];
  corrections?: PublicCorrection[];
  place?: string;
}

export const PictureDescriptionRequestSchema = z.strictObject({
  style: z.string().max(PICTURE_STYLE_MAX), scene: PictureSceneSchema, lines: z.array(PictureLineSchema),
  cast: z.array(PicturePersonSchema.omit({ portraitId: true })), budget: z.number().int().positive(),
});
export type PictureDescriptionRequest = z.infer<typeof PictureDescriptionRequestSchema>;

export const LINE_ASSIST_ROUNDS = 3;
export const LineAssistRequestSchema = z.strictObject({
  idea: z.string().trim().min(1).max(4000), recipientNpcIds: z.array(IdSchema).max(2).default([]),
});
export type LineAssistRequest = z.infer<typeof LineAssistRequestSchema>;
export const LineAssistResponseSchema = z.strictObject({ text: z.string().trim().min(1).max(4000) });
export type LineAssistResponse = z.infer<typeof LineAssistResponseSchema>;
export const LineAssistInputSchema = z.strictObject({
  idea: z.string(),
  character: z.strictObject({
    displayName: z.string(), pronouns: z.string(), appearance: z.string(), personality: z.string(), backstory: z.string(),
    specialty: z.string(), flaw: z.string(), connection: z.string(), secret: z.string(), possessions: z.array(z.string()),
  }),
  talkingTo: z.array(z.strictObject({
    displayName: z.string(), role: z.string(), appearance: z.string(), mood: z.string(), personality: z.array(z.string()),
  })),
  present: z.strictObject({
    npcs: z.array(z.strictObject({ displayName: z.string(), role: z.string() })),
    characters: z.array(z.strictObject({ displayName: z.string(), appearance: z.string() })),
  }),
  scene: z.strictObject({ title: z.string(), description: z.string() }),
  story: z.strictObject({ premise: z.string(), genre: z.string(), tone: z.string() }).nullable(),
  facts: z.array(z.string()),
  recentRounds: z.array(z.strictObject({
    beatNumber: z.number().int(),
    lines: z.array(z.strictObject({ speaker: z.string().nullable(), text: z.string() })),
  })),
  boundaries: z.array(z.string()),
});
export type LineAssistInput = z.infer<typeof LineAssistInputSchema>;

export interface AiProvider {
  generateField?(input: FieldGenerationRequest): Promise<FieldGenerationResponse>;
  generateCard?(input: CardGenerationInput): Promise<CardDraft>;
  generateScenario?(input: ScenarioGenerationRequest, options?: { deadlineAt?: number; voices?: VoiceChoice[] }): Promise<ScenarioDraft>;
  suggestLine?(input: LineAssistInput): Promise<LineAssistResponse>;
  describePicture?(input: PictureDescriptionRequest): Promise<string>;   // one paragraph; callers clean it
  plan(context: ProviderContext): Promise<PlanResult>;
  render(context: ProviderContext): Promise<AiDraft>;
}

const CardPromptSchema = z.string().trim().min(1).max(4000);
const cardRequestSize = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length <= MAX_FIELD_GENERATION_REQUEST_BYTES;
const CARD_TOO_LARGE = 'The drafting request is too large. Shorten the description or character notes.';
const cardText = (max: number) => z.string().max(max).default('');
export const CardDraftSchema = z.object({
  displayName: cardText(80), pronouns: cardText(80), appearance: cardText(1000), personality: cardText(2000), backstory: cardText(4000),
  specialty: cardText(1000), flaw: cardText(1000), connection: cardText(1000), secret: cardText(2000),
  possessions: z.array(z.string().max(160)).max(3).default([]),
  strongestTrait: TraitSchema, weakestTrait: TraitSchema,
});
export type CardDraft = z.infer<typeof CardDraftSchema>;
export const CardCharacterContextSchema = FieldGenerationCharacterContextSchema.refine(context => context.kind === 'character', 'Only this character card can be used as context.');
export type CardCharacterContext = z.infer<typeof CardCharacterContextSchema>;
export const CardGenerationInputSchema = z.strictObject({
  prompt: CardPromptSchema, keepFilled: z.boolean(), current: CardCharacterContextSchema.optional(),
  premise: CardPromptSchema.optional(), instructions: CardPromptSchema.optional(),
}).refine(cardRequestSize, CARD_TOO_LARGE);
export type CardGenerationInput = z.infer<typeof CardGenerationInputSchema>;
export const HostCardGenerationRequestSchema = z.strictObject({
  prompt: CardPromptSchema, keepFilled: z.boolean().default(true), current: CardCharacterContextSchema.optional(), premise: CardPromptSchema.optional(),
}).refine(cardRequestSize, CARD_TOO_LARGE);
export type HostCardGenerationRequest = z.infer<typeof HostCardGenerationRequestSchema>;
export const BuilderCardGenerationRequestSchema = z.strictObject({
  expectedRevision: z.number().int().min(0), prompt: CardPromptSchema, keepFilled: z.boolean().default(true), current: CardCharacterContextSchema,
}).refine(cardRequestSize, CARD_TOO_LARGE);
export type BuilderCardGenerationRequest = z.infer<typeof BuilderCardGenerationRequestSchema>;
export const SeatCardGenerationRequestSchema = z.strictObject({
  expectedCharacterRevision: z.number().int().min(0), prompt: CardPromptSchema, keepFilled: z.boolean().default(true), current: CardCharacterContextSchema,
}).refine(cardRequestSize, CARD_TOO_LARGE);
export type SeatCardGenerationRequest = z.infer<typeof SeatCardGenerationRequestSchema>;
export const SeatFieldGenerationRequestSchema = z.strictObject({
  expectedCharacterRevision: z.number().int().min(0),
  field: FieldGenerationRequestSchema.shape.field.refine(field => field.startsWith('character.'), 'Only character fields can be generated here.'),
  seed: FieldGenerationRequestSchema.shape.seed,
  characterContext: CardCharacterContextSchema,
  usePremise: z.boolean().default(false),
}).refine(cardRequestSize, CARD_TOO_LARGE);
export type SeatFieldGenerationRequest = z.infer<typeof SeatFieldGenerationRequestSchema>;
export const CardGenerationResponseSchema = z.strictObject({
  card: CharacterCardDefinitionSchema, notes: z.array(z.string().max(300)).max(10), pronounsSuggested: z.boolean(),
});
export type CardGenerationResponse = z.infer<typeof CardGenerationResponseSchema>;

export const ScenarioSizeSchema = z.enum(['small', 'medium', 'large']);
export type ScenarioSize = z.infer<typeof ScenarioSizeSchema>;
export const ScenarioGenerationRequestSchema = z.strictObject({
  prompt: CardPromptSchema, size: ScenarioSizeSchema.default('medium'),
  boundaries: z.array(z.string().trim().min(1).max(500)).max(30).default([]),
});
export type ScenarioGenerationRequest = z.infer<typeof ScenarioGenerationRequestSchema>;
const draftList = (max: number, count: number) => z.array(z.string().max(max)).max(count).default([]);
export const ScenarioDraftNpcSchema = z.object({
  name: cardText(80), role: cardText(160), appearance: cardText(1000), locationKey: cardText(40),
  presence: z.enum(['present', 'offstage']).default('offstage'),
  communicationChannel: z.string().max(160).nullable().default(null), hiddenIdentity: z.string().max(160).nullable().default(null),
  aliases: draftList(80, 10), personality: draftList(500, 10), limits: draftList(500, 10),
  dialogueExamples: draftList(1000, 10), secrets: draftList(2000, 10),
  motivation: cardText(1000), goal: cardText(1000), mood: cardText(160),
  knowledge: z.array(z.object({ statement: cardText(6000), category: z.enum(['fact', 'belief', 'claim']).default('fact') })).max(30).default([]),
  partyStance: z.enum(['hostile', 'wary', 'neutral', 'friendly', 'trusting']).nullable().default(null),
  partyReason: cardText(6000), voice: z.string().max(128).optional(),
});
export type ScenarioDraftNpc = z.infer<typeof ScenarioDraftNpcSchema>;
export const ScenarioDraftSchema = z.object({
  title: cardText(160), premise: cardText(4000), genre: cardText(160), tone: cardText(500), pictureStyle: cardText(300), directorNotes: cardText(12000),
  playerHooks: draftList(1000, 20), objectives: draftList(1000, 20), discoveries: draftList(2000, 20), opportunities: draftList(2000, 20),
  suggestedBoundaries: z.array(z.string().trim().min(1).max(500)).max(10).default([]),
  locations: z.array(z.object({ key: z.string().trim().min(1).max(40), title: cardText(160), description: cardText(4000) })).min(1).max(30),
  openingScene: z.object({ title: cardText(160), description: cardText(6000), locationKey: cardText(40) }),
  npcs: z.array(ScenarioDraftNpcSchema).max(20).default([]),
  tracks: z.array(z.object({
    label: cardText(120), kind: z.enum(['progress', 'danger', 'countdown']), max: z.number().int().min(1).max(8),
    visibility: VisibilitySchema.default('public'), ticksEachActionRound: z.boolean().default(false), completionText: cardText(2000),
  })).max(20).default([]),
  facts: z.array(z.object({ text: cardText(6000), visibility: VisibilitySchema.default('public') })).max(50).default([]),
});
export type ScenarioDraft = z.infer<typeof ScenarioDraftSchema>;
const jobSuggestedBoundaries = z.array(z.string().trim().min(1).max(500)).max(10);
export const ScenarioDraftJobSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('running'), jobId: IdSchema, size: ScenarioSizeSchema, startedAt: z.string().datetime(), deadlineAt: z.string().datetime() }),
  z.strictObject({
    status: z.literal('succeeded'), jobId: IdSchema, definition: ScenarioDefinitionSchema,
    adjustments: z.array(z.string().max(300)).max(40), warnings: z.array(z.string().max(300)).max(40), suggestedBoundaries: jobSuggestedBoundaries,
  }),
  z.strictObject({ status: z.literal('failed'), jobId: IdSchema, code: z.enum(['generation_timeout', 'generation_failed']), message: z.string().max(300) }),
]);
export type ScenarioDraftJob = z.infer<typeof ScenarioDraftJobSchema>;
