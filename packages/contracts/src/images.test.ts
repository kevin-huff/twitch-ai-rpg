import { describe, expect, it } from 'vitest';
import {
  ActionPictureStatusSchema, BuilderPortraitRequestSchema, CharacterBuilderSnapshotSchema, CharacterCardDefinitionSchema, CharacterSchema, DirectorSnapshotSchema,
  LibraryPortraitRequestSchema, NpcDefinitionSchema, NpcSchema, PlayerSnapshotSchema, PortraitDetailsSchema, PortraitJobSchema,
  ScenarioBriefSchema, ScenarioDefinitionSchema, ScenePictureSchema, ScenePictureStatusSchema, SeatPortraitRequestSchema, StageSnapshotSchema,
  ImageIdSchema, MOMENT_MODEL, MOMENT_PORTRAIT_MAX, MOMENT_PROMPT_MAX, PICTURE_LIMITS, PICTURE_MODELS, PICTURE_PROMPT_MAX,
  PICTURE_NEGATIVE_PROMPT, PICTURE_STYLE_MAX, PictureDescriptionRequestSchema, PictureLineSchema, PictureModelIdSchema, PictureMomentSchema,
  PicturePersonSchema, PictureSceneSchema, PictureSettingsSchema,
  imageTypeOf,
} from './index.js';
import type { ImageProvider, ImageReference, ImageRequest } from './index.js';

const uuid = '123e4567-e89b-42d3-a456-426614174000';
const traits = { force: 2, finesse: 1, wits: 1, presence: 0 };
const scene = { id: 'scene', title: 'The bar', description: '', locationId: 'bar' };
const session = { id: 'show', title: 'Show', status: 'live', mode: 'conversation', stateRevision: 7, beatNumber: 2, actionRoundNumber: 0, inputEpoch: 0, scene };
const base = { schemaVersion: 1, eventSeq: 3, session, characters: [], npcs: [], tracks: [], facts: [], history: [] };
const card = { schemaVersion: 1, displayName: 'Rook', traits };
const npc = { id: 'mara', displayName: 'Mara', role: 'Mapmaker', locationId: 'bar', status: 'present', voiceProfileId: 'voice' };
const scenario = {
  schemaVersion: 1, title: 'Fair', locations: [{ id: 'bar', title: 'Bar' }], openingScene: scene,
};
const brief = { premise: '', genre: '', tone: '', objectives: [], playerHooks: [], pacing: {} };
const director = { ...base, role: 'director', activeBeat: null, submissions: [], npcDetails: [], characterDetails: [], jobs: [], directorNotes: '' };
const player = { ...base, role: 'player', activeBeat: null, ownCharacter: null, submissions: [] };
const stage = { ...base, role: 'stage', activeBeat: null };

describe('image type sniffing', () => {
  it('recognises JPEG, PNG and WebP by their first bytes', () => {
    expect(imageTypeOf(Uint8Array.of(0xff, 0xd8, 0xff, 0xe0))).toBe('image/jpeg');
    expect(imageTypeOf(Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0))).toBe('image/png');
    expect(imageTypeOf(Uint8Array.of(0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50))).toBe('image/webp');
  });
  it('rejects empty, short, truncated and junk bytes', () => {
    expect(imageTypeOf(new Uint8Array())).toBeNull();
    expect(imageTypeOf(Uint8Array.of(0xff, 0xd8))).toBeNull();
    expect(imageTypeOf(Uint8Array.of(0x89, 0x50, 0x4e, 0x47))).toBeNull();
    expect(imageTypeOf(Uint8Array.of(0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x41, 0x56, 0x45))).toBeNull();
    expect(imageTypeOf(new TextEncoder().encode('<html>not a picture</html>'))).toBeNull();
  });
});

describe('portrait request bounds', () => {
  it('fills blank details and enforces each length', () => {
    expect(PortraitDetailsSchema.parse({})).toEqual({ appearance: '', role: '', pronouns: '', name: '' });
    expect(PortraitDetailsSchema.safeParse({ appearance: 'a'.repeat(1000), role: 'r'.repeat(1000), pronouns: 'p'.repeat(80), name: 'n'.repeat(80) }).success).toBe(true);
    for (const key of ['appearance', 'role']) expect(PortraitDetailsSchema.safeParse({ [key]: 'x'.repeat(1001) }).success).toBe(false);
    for (const key of ['pronouns', 'name']) expect(PortraitDetailsSchema.safeParse({ [key]: 'x'.repeat(81) }).success).toBe(false);
    expect(PortraitDetailsSchema.safeParse({ extra: true }).success).toBe(false);
  });
  it('checks the seat and builder bodies and rejects extras', () => {
    expect(SeatPortraitRequestSchema.parse({ expectedCharacterRevision: 0, details: {} }).details.appearance).toBe('');
    expect(SeatPortraitRequestSchema.safeParse({ expectedCharacterRevision: -1, details: {} }).success).toBe(false);
    expect(SeatPortraitRequestSchema.safeParse({ expectedCharacterRevision: 1.5, details: {} }).success).toBe(false);
    expect(SeatPortraitRequestSchema.safeParse({ details: {} }).success).toBe(false);
    expect(SeatPortraitRequestSchema.safeParse({ expectedCharacterRevision: 0, details: {}, extra: 1 }).success).toBe(false);
    expect(BuilderPortraitRequestSchema.parse({ expectedRevision: 3, details: { appearance: 'Tall' } }).expectedRevision).toBe(3);
    expect(BuilderPortraitRequestSchema.safeParse({ expectedRevision: -1, details: {} }).success).toBe(false);
    expect(BuilderPortraitRequestSchema.safeParse({ expectedRevision: 0 }).success).toBe(false);
    expect(BuilderPortraitRequestSchema.safeParse({ expectedRevision: 0, details: {}, extra: 1 }).success).toBe(false);
  });
  it('checks the library body, trims the style and caps it at 300', () => {
    const body = { subject: 'npc', subjectKey: 'mara', details: {} };
    expect(LibraryPortraitRequestSchema.parse(body).pictureStyle).toBe('');
    expect(LibraryPortraitRequestSchema.parse({ ...body, pictureStyle: '  Ink wash  ' }).pictureStyle).toBe('Ink wash');
    expect(LibraryPortraitRequestSchema.safeParse({ ...body, pictureStyle: 'x'.repeat(300) }).success).toBe(true);
    expect(LibraryPortraitRequestSchema.safeParse({ ...body, pictureStyle: 'x'.repeat(301) }).success).toBe(false);
    expect(LibraryPortraitRequestSchema.safeParse({ ...body, subject: 'scene' }).success).toBe(false);
    expect(LibraryPortraitRequestSchema.safeParse({ ...body, subjectKey: '' }).success).toBe(false);
    expect(LibraryPortraitRequestSchema.safeParse({ ...body, subjectKey: 'k'.repeat(129) }).success).toBe(false);
    expect(LibraryPortraitRequestSchema.safeParse({ ...body, extra: 1 }).success).toBe(false);
  });
});

describe('picture status shapes', () => {
  it('accepts the public scene picture and nothing more', () => {
    expect(ScenePictureSchema.parse({ imageId: uuid, sceneId: 'scene' })).toEqual({ imageId: uuid, sceneId: 'scene' });
    expect(ScenePictureSchema.safeParse({ imageId: 'not-a-uuid', sceneId: 'scene' }).success).toBe(false);
    expect(ScenePictureSchema.safeParse({ imageId: uuid, sceneId: 'scene', hidden: false }).success).toBe(false);
  });
  it('accepts the director scene status in every state', () => {
    for (const state of ['none', 'making', 'ready', 'failed']) {
      expect(ScenePictureStatusSchema.safeParse({ sceneId: 'scene', state, imageId: null, hidden: false, message: null }).success).toBe(true);
    }
    expect(ScenePictureStatusSchema.parse({ sceneId: 'scene', state: 'failed', imageId: uuid, hidden: true, message: 'It did not work.' }).hidden).toBe(true);
    expect(ScenePictureStatusSchema.parse({ sceneId: 'scene', state: 'making', imageId: null, hidden: false, message: null }).drawing).toBeNull();
    for (const drawing of ['place', 'beat']) {
      expect(ScenePictureStatusSchema.parse({ sceneId: 'scene', state: 'making', imageId: null, hidden: false, message: null, drawing }).drawing).toBe(drawing);
    }
    expect(ScenePictureStatusSchema.safeParse({ sceneId: 'scene', state: 'making', imageId: null, hidden: false, message: null, drawing: 'portrait' }).success).toBe(false);
    expect(ScenePictureStatusSchema.safeParse({ sceneId: 'scene', state: 'done', imageId: null, hidden: false, message: null }).success).toBe(false);
    expect(ScenePictureStatusSchema.safeParse({ sceneId: 'scene', state: 'none', imageId: null, hidden: false }).success).toBe(false);
    expect(ScenePictureStatusSchema.safeParse({ sceneId: 'scene', state: 'none', imageId: null, hidden: false, message: 'x'.repeat(301) }).success).toBe(false);
  });
  it('accepts the director action picture status in every state', () => {
    const making = { beatId: 'beat-1', state: 'making', imageId: null, message: null };
    expect(ActionPictureStatusSchema.parse(making)).toEqual(making);
    expect(ActionPictureStatusSchema.safeParse({ ...making, state: 'ready', imageId: uuid }).success).toBe(true);
    expect(ActionPictureStatusSchema.safeParse({ ...making, state: 'failed', message: 'It did not work.' }).success).toBe(true);
  });
  it('rejects a bad action picture status', () => {
    const making = { beatId: 'beat-1', state: 'making', imageId: null, message: null };
    expect(ActionPictureStatusSchema.safeParse({ ...making, state: 'none' }).success).toBe(false);
    expect(ActionPictureStatusSchema.safeParse({ ...making, imageId: 'not-a-uuid' }).success).toBe(false);
    expect(ActionPictureStatusSchema.safeParse({ ...making, message: 'x'.repeat(301) }).success).toBe(false);
    expect(ActionPictureStatusSchema.safeParse({ ...making, hidden: false }).success).toBe(false);
  });
  it('defaults the director action picture to null and keeps a given one, never on stage or player', () => {
    expect(DirectorSnapshotSchema.parse(director).actionPicture).toBeNull();
    const given = { beatId: 'beat-1', state: 'ready', imageId: uuid, message: null };
    expect(DirectorSnapshotSchema.parse({ ...director, actionPicture: given }).actionPicture).toEqual(given);
    expect(StageSnapshotSchema.safeParse({ ...stage, actionPicture: null }).success).toBe(false);
    expect(PlayerSnapshotSchema.safeParse({ ...player, actionPicture: null }).success).toBe(false);
  });
  it('accepts a portrait job that is making or failed', () => {
    expect(PortraitJobSchema.parse({ npcId: 'mara', state: 'making', message: null })).toEqual({ npcId: 'mara', state: 'making', message: null });
    expect(PortraitJobSchema.safeParse({ npcId: 'mara', state: 'failed', message: 'Try again.' }).success).toBe(true);
    expect(PortraitJobSchema.safeParse({ npcId: 'mara', state: 'ready', message: null }).success).toBe(false);
    expect(PortraitJobSchema.safeParse({ npcId: 'mara', state: 'making' }).success).toBe(false);
  });
});

describe('older data without picture fields', () => {
  it('parses character cards, characters and NPCs without a portrait and round-trips them', () => {
    const parsedCard = CharacterCardDefinitionSchema.parse(card);
    expect('portraitId' in parsedCard).toBe(false);
    expect(CharacterCardDefinitionSchema.parse(parsedCard)).toEqual(parsedCard);
    expect(CharacterCardDefinitionSchema.parse({ ...card, portraitId: 'img-1' }).portraitId).toBe('img-1');
    const character = CharacterSchema.parse({ id: 'rook', displayName: 'Rook', traits, strain: 0 });
    expect('portraitId' in character).toBe(false);
    expect(CharacterSchema.parse(character)).toEqual(character);
    const parsedNpc = NpcSchema.parse({ ...npc, voiceProfileId: 'voice' });
    expect('portraitId' in parsedNpc).toBe(false);
    expect(NpcSchema.parse(parsedNpc)).toEqual(parsedNpc);
    const definitionNpc = NpcDefinitionSchema.parse(npc);
    expect('portraitId' in definitionNpc).toBe(false);
    expect(NpcDefinitionSchema.parse(definitionNpc)).toEqual(definitionNpc);
  });
  it('parses scenarios and briefs without a picture style and round-trips them', () => {
    const parsedScenario = ScenarioDefinitionSchema.parse(scenario);
    expect('pictureStyle' in parsedScenario).toBe(false);
    expect(ScenarioDefinitionSchema.parse(parsedScenario)).toEqual(parsedScenario);
    expect(ScenarioDefinitionSchema.parse({ ...scenario, pictureStyle: '  Ink  ' }).pictureStyle).toBe('Ink');
    const parsedBrief = ScenarioBriefSchema.parse(brief);
    expect('pictureStyle' in parsedBrief).toBe(false);
    expect(ScenarioBriefSchema.parse(parsedBrief)).toEqual(parsedBrief);
  });
  it('defaults the picture fields on stage, player and director snapshots', () => {
    const parsedStage = StageSnapshotSchema.parse(stage);
    expect(parsedStage).toMatchObject({ picturesEnabled: false, scenePicture: null });
    expect(StageSnapshotSchema.parse(parsedStage)).toEqual(parsedStage);
    const parsedPlayer = PlayerSnapshotSchema.parse(player);
    expect(parsedPlayer).toMatchObject({ picturesEnabled: false, scenePicture: null });
    expect(PlayerSnapshotSchema.parse(parsedPlayer)).toEqual(parsedPlayer);
    const parsedDirector = DirectorSnapshotSchema.parse(director);
    expect(parsedDirector).toMatchObject({ picturesEnabled: false, scenePicture: null, scenePictureStatus: null, portraitJobs: [], pictureSettings: null, lastSceneBeatId: null });
    expect(DirectorSnapshotSchema.parse(parsedDirector)).toEqual(parsedDirector);
  });
  it('keeps director-only picture fields out of stage snapshots', () => {
    const status = { sceneId: 'scene', state: 'making', imageId: null, hidden: false, message: null };
    expect(StageSnapshotSchema.safeParse({ ...stage, scenePictureStatus: status }).success).toBe(false);
    expect(StageSnapshotSchema.safeParse({ ...stage, portraitJobs: [] }).success).toBe(false);
    expect(PlayerSnapshotSchema.safeParse({ ...player, portraitJobs: [] }).success).toBe(false);
    const shown = StageSnapshotSchema.parse({ ...stage, picturesEnabled: true, scenePicture: { imageId: uuid, sceneId: 'scene' } });
    expect(shown.scenePicture).toEqual({ imageId: uuid, sceneId: 'scene' });
    const busy = DirectorSnapshotSchema.parse({ ...director, picturesEnabled: true, scenePictureStatus: status, portraitJobs: [{ npcId: 'mara', state: 'making', message: null }] });
    expect(busy.portraitJobs).toHaveLength(1);
  });
  it('lets a character builder snapshot carry picturesEnabled and still round-trip without it', () => {
    const snapshot = {
      id: 'builder', label: 'Guest', instructions: '', revision: 0, expiresAt: '2030-01-01T00:00:00.000Z', submittedTemplate: null,
      draft: { ...card, displayName: '' },
    };
    const without = CharacterBuilderSnapshotSchema.parse(snapshot);
    expect('picturesEnabled' in without).toBe(false);
    expect(CharacterBuilderSnapshotSchema.parse(without)).toEqual(without);
    expect(CharacterBuilderSnapshotSchema.parse({ ...snapshot, picturesEnabled: true }).picturesEnabled).toBe(true);
  });
});

describe('picture models and limits', () => {
  it('lists unique model ids that fit the id format, with the default and the beat model among them', () => {
    const ids = PICTURE_MODELS.map(model => model.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const model of PICTURE_MODELS) {
      expect(PictureModelIdSchema.safeParse(model.id).success).toBe(true);
      expect(model.label.length).toBeGreaterThan(0);
      expect(model.description.length).toBeGreaterThan(0);
    }
    // Every model drew a live picture on 2026-10-25; Real Dream XL lost to CyberRealistic XL.
    expect(ids).toEqual(['krea-2-turbo', 'flux-3-klein', 'z-turbo', 'qwen-2512-lightning', 'chroma1-hd', 'dreamshaper-xl', 'animagine-xl', 'cyberrealistic-xl']);
    expect(ids).toContain(MOMENT_MODEL);
    expect(MOMENT_MODEL).toBe('flux-3-klein');
  });
  it('checks the model id format', () => {
    for (const good of ['krea-2-turbo', 'fake-image', 'a', 'z.1_x']) expect(PictureModelIdSchema.safeParse(good).success).toBe(true);
    for (const bad of ['', '-x', 'Krea', 'a b', 'a/b', 'x'.repeat(65)]) expect(PictureModelIdSchema.safeParse(bad).success).toBe(false);
  });
  it('keeps nudity out of pictures but no longer lists gore, and allows ten at once', () => {
    expect(PICTURE_NEGATIVE_PROMPT).toContain('nudity');
    expect(PICTURE_NEGATIVE_PROMPT).not.toContain('gore');
    expect(PICTURE_LIMITS).toEqual({ concurrent: 10 });
  });
  it('defines the beat picture limits once', () => {
    expect(MOMENT_PORTRAIT_MAX).toBe(10);
    // Sogni refuses a FLUX 3 Klein prompt over 6,000 characters.
    expect(MOMENT_PROMPT_MAX).toBe(6000);
    expect(PICTURE_PROMPT_MAX).toBe(2000);
    expect(PICTURE_STYLE_MAX).toBe(300);
  });
  it('checks the saved picture settings', () => {
    expect(PictureSettingsSchema.parse({ style: '  Ink  ', model: 'krea-2-turbo' })).toEqual({ style: 'Ink', model: 'krea-2-turbo' });
    expect(PictureSettingsSchema.safeParse({ style: '', model: 'krea-2-turbo' }).success).toBe(true);
    expect(PictureSettingsSchema.safeParse({ style: 'x'.repeat(PICTURE_STYLE_MAX), model: 'krea-2-turbo' }).success).toBe(true);
    expect(PictureSettingsSchema.safeParse({ style: 'x'.repeat(PICTURE_STYLE_MAX + 1), model: 'krea-2-turbo' }).success).toBe(false);
    expect(PictureSettingsSchema.safeParse({ style: '', model: 'Bad Model' }).success).toBe(false);
    expect(PictureSettingsSchema.safeParse({ style: '' }).success).toBe(false);
    expect(PictureSettingsSchema.safeParse({ model: 'krea-2-turbo' }).success).toBe(false);
    expect(PictureSettingsSchema.safeParse({ style: '', model: 'krea-2-turbo', extra: 1 }).success).toBe(false);
  });
  it('lets a library portrait request carry a picture model for NPCs', () => {
    const body = { subject: 'npc', subjectKey: 'mara', details: {} };
    expect('pictureModel' in LibraryPortraitRequestSchema.parse(body)).toBe(false);
    expect(LibraryPortraitRequestSchema.parse({ ...body, pictureModel: 'flux-3-klein' }).pictureModel).toBe('flux-3-klein');
    expect(LibraryPortraitRequestSchema.safeParse({ ...body, pictureModel: 'Bad Model' }).success).toBe(false);
  });
});

describe('beat picture moment', () => {
  const scene = { title: 'The bar', description: 'A low room.', place: 'Bar' };
  const line = { kind: 'narration', speaker: null, text: 'Rain falls.' };
  const person = { name: 'Rook', appearance: 'Tall', role: 'Guard', pronouns: 'he/him', portraitId: uuid, imageNumber: 1 };
  const moment = { style: 'Ink', model: 'krea-2-turbo', scene, lines: [line], cast: [person], names: ['Rook'] };
  it('accepts a full moment and a person drawn from words', () => {
    expect(PictureMomentSchema.parse(moment)).toEqual(moment);
    const words = { ...person, portraitId: null, imageNumber: null };
    expect(PicturePersonSchema.parse(words)).toEqual(words);
    expect(PictureMomentSchema.safeParse({ ...moment, lines: [], cast: [], names: [] }).success).toBe(true);
  });
  it('accepts every line kind and rejects others', () => {
    for (const kind of ['narration', 'npc_dialogue', 'player_dialogue', 'intent', 'approach', 'outcome']) {
      expect(PictureLineSchema.safeParse({ ...line, kind }).success).toBe(true);
    }
    expect(PictureLineSchema.safeParse({ ...line, kind: 'shout' }).success).toBe(false);
    expect(PictureLineSchema.safeParse({ ...line, speaker: 'Rook' }).success).toBe(true);
    expect(PictureLineSchema.safeParse({ ...line, speaker: 's'.repeat(81) }).success).toBe(false);
    expect(PictureLineSchema.safeParse({ ...line, text: 'x'.repeat(6000) }).success).toBe(true);
    expect(PictureLineSchema.safeParse({ ...line, text: 'x'.repeat(6001) }).success).toBe(false);
  });
  it('keeps the scene fields within their bounds', () => {
    expect(PictureSceneSchema.safeParse(scene).success).toBe(true);
    expect(PictureSceneSchema.safeParse({ ...scene, title: 'x'.repeat(161) }).success).toBe(false);
    expect(PictureSceneSchema.safeParse({ ...scene, place: 'x'.repeat(161) }).success).toBe(false);
    expect(PictureSceneSchema.safeParse({ ...scene, description: 'x'.repeat(6001) }).success).toBe(false);
  });
  it('keeps the person fields within their bounds and the image number in range', () => {
    expect(PicturePersonSchema.safeParse({ ...person, name: 'x'.repeat(81) }).success).toBe(false);
    expect(PicturePersonSchema.safeParse({ ...person, appearance: 'x'.repeat(1001) }).success).toBe(false);
    expect(PicturePersonSchema.safeParse({ ...person, role: 'x'.repeat(1001) }).success).toBe(false);
    expect(PicturePersonSchema.safeParse({ ...person, pronouns: 'x'.repeat(81) }).success).toBe(false);
    expect(PicturePersonSchema.safeParse({ ...person, portraitId: 'not-a-uuid' }).success).toBe(false);
    expect(PicturePersonSchema.safeParse({ ...person, imageNumber: MOMENT_PORTRAIT_MAX }).success).toBe(true);
    for (const imageNumber of [0, MOMENT_PORTRAIT_MAX + 1, 1.5, -1]) expect(PicturePersonSchema.safeParse({ ...person, imageNumber }).success).toBe(false);
  });
  it('has no maximum on lines, cast or names', () => {
    const many = { ...moment, lines: Array.from({ length: 500 }, () => line), cast: Array.from({ length: 50 }, () => ({ ...person, portraitId: null, imageNumber: null })), names: Array.from({ length: 200 }, () => 'N') };
    expect(PictureMomentSchema.safeParse(many).success).toBe(true);
    expect(PictureMomentSchema.safeParse({ ...moment, names: ['n'.repeat(81)] }).success).toBe(false);
  });
  it('rejects unknown keys and a missing or bad model', () => {
    expect(PictureMomentSchema.safeParse({ ...moment, extra: 1 }).success).toBe(false);
    expect(PictureSceneSchema.safeParse({ ...scene, extra: 1 }).success).toBe(false);
    expect(PictureLineSchema.safeParse({ ...line, extra: 1 }).success).toBe(false);
    expect(PicturePersonSchema.safeParse({ ...person, extra: 1 }).success).toBe(false);
    expect(PictureMomentSchema.safeParse({ ...moment, model: 'Bad Model' }).success).toBe(false);
    expect(PictureMomentSchema.safeParse({ ...moment, style: 'x'.repeat(PICTURE_STYLE_MAX + 1) }).success).toBe(false);
    const { model: _model, ...noModel } = moment;
    expect(PictureMomentSchema.safeParse(noModel).success).toBe(false);
  });
});

describe('picture description request', () => {
  const { portraitId: _portraitId, ...person } = { name: 'Rook', appearance: 'Tall', role: 'Guard', pronouns: 'he/him', portraitId: uuid, imageNumber: 1 };
  const request = {
    style: 'Ink', scene: { title: 'The bar', description: '', place: 'Bar' },
    lines: [{ kind: 'outcome', speaker: null, text: 'Rook wins.' }], cast: [person], budget: 900,
  };
  it('accepts a request without portrait ids and rejects extras', () => {
    expect(PictureDescriptionRequestSchema.parse(request)).toEqual(request);
    expect(PictureDescriptionRequestSchema.safeParse({ ...request, style: '' }).success).toBe(true);
    expect(PictureDescriptionRequestSchema.safeParse({ ...request, cast: [{ ...person, portraitId: uuid }] }).success).toBe(false);
    expect(PictureDescriptionRequestSchema.safeParse({ ...request, extra: 1 }).success).toBe(false);
  });
  it('needs a positive whole budget and a style within the limit', () => {
    for (const budget of [0, -5, 1.5]) expect(PictureDescriptionRequestSchema.safeParse({ ...request, budget }).success).toBe(false);
    expect(PictureDescriptionRequestSchema.safeParse({ ...request, style: 'x'.repeat(PICTURE_STYLE_MAX + 1) }).success).toBe(false);
  });
});

describe('scenario picture model and snapshot fields', () => {
  it('keeps pictureModel optional on a scenario and checks its format', () => {
    const parsed = ScenarioDefinitionSchema.parse(scenario);
    expect('pictureModel' in parsed).toBe(false);
    expect(ScenarioDefinitionSchema.parse({ ...scenario, pictureModel: 'flux-3-klein' }).pictureModel).toBe('flux-3-klein');
    expect(ScenarioDefinitionSchema.safeParse({ ...scenario, pictureModel: 'Bad Model' }).success).toBe(false);
  });
  it('carries the effective settings and the last beat of the scene on a director snapshot only', () => {
    const settings = { style: 'Ink', model: 'krea-2-turbo' };
    const parsed = DirectorSnapshotSchema.parse({ ...director, picturesEnabled: true, pictureSettings: settings, lastSceneBeatId: 'beat-1' });
    expect(parsed.pictureSettings).toEqual(settings);
    expect(parsed.lastSceneBeatId).toBe('beat-1');
    expect(DirectorSnapshotSchema.safeParse({ ...director, pictureSettings: { style: 'x' } }).success).toBe(false);
    expect(DirectorSnapshotSchema.safeParse({ ...director, lastSceneBeatId: '' }).success).toBe(false);
    expect(StageSnapshotSchema.safeParse({ ...stage, pictureSettings: null }).success).toBe(false);
    expect(PlayerSnapshotSchema.safeParse({ ...player, lastSceneBeatId: null }).success).toBe(false);
  });
});

describe('image provider shapes', () => {
  it('lets a request name a model and references, and a provider prepare them', async () => {
    const handle: ImageReference = Object.freeze({ provider: 'fake' });
    const request: ImageRequest = {
      prompt: 'x'.repeat(MOMENT_PROMPT_MAX), negativePrompt: PICTURE_NEGATIVE_PROMPT, width: 1344, height: 768,
      requestId: uuid, title: 'Beat picture', model: MOMENT_MODEL, references: [handle],
    };
    const provider: ImageProvider = {
      name: 'fake', model: 'fake-image',
      generate: async () => { throw new Error('unused'); },
      prepareReferences: async images => images.map(() => handle),
    };
    expect(await provider.prepareReferences?.([Uint8Array.of(1)], { requestId: request.requestId })).toEqual([handle]);
    expect(ImageIdSchema.safeParse(request.requestId).success).toBe(true);
  });
});
