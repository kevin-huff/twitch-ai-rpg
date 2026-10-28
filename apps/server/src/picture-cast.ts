import {
  type Beat, ImageIdSchema, isPlayerSegmentKind, MOMENT_PORTRAIT_MAX, type PictureLine, type PictureMoment, type PicturePerson, type PictureSettings, type PublishedBeat, type SessionState,
} from '@rpg/contracts';
import { namesInState, sceneLocationTitle } from './picture-prompts';

// published is null for a round still in review, where the draft and the locked submissions stand in for it.
export type BeatPictureSource = {
  beat: Pick<Beat, 'contracts' | 'lockedSubmissions' | 'draft' | 'resolution'>;
  published: Pick<PublishedBeat, 'segments'> | null;
};

const spokenBy = (source: BeatPictureSource): string[] => {
  if (source.published) {
    return source.published.segments.flatMap((segment) => (
      (isPlayerSegmentKind(segment.kind) || segment.kind === 'npc_dialogue') && segment.speaker ? [segment.speaker.entityId] : []
    ));
  }
  return [
    ...source.beat.lockedSubmissions.filter((submission) => submission.kind !== 'ooc' && submission.text.trim()).map((submission) => submission.characterId),
    ...(source.beat.draft?.segments ?? []).flatMap((segment) => (segment.kind === 'npc_dialogue' ? [segment.speakerNpcId] : [])),
  ];
};

const addressedCharacters = (source: BeatPictureSource): string[] => (
  source.published ? source.published.segments : source.beat.draft?.segments ?? []
).flatMap((segment) => segment.recipientCharacterIds);

// Everyone involved in the beat, without repeats; only public fields are read.
export function pictureCast(state: SessionState, source: BeatPictureSource): PicturePerson[] {
  const { beat } = source;
  const ids = [
    ...spokenBy(source),
    ...beat.contracts.map((contract) => contract.actorCharacterId),
    ...beat.contracts.flatMap((contract) => contract.helperCharacterIds),
    ...addressedCharacters(source),
    ...beat.lockedSubmissions.flatMap((submission) => submission.recipientNpcIds),
  ];
  const cast: PicturePerson[] = [];
  for (const id of new Set(ids)) {
    const character = state.characters.find((candidate) => candidate.id === id);
    if (character) {
      cast.push({
        name: character.displayName, appearance: character.appearance, role: character.specialty, pronouns: character.pronouns,
        portraitId: ImageIdSchema.safeParse(character.portraitId).success ? character.portraitId! : null, imageNumber: null,
      });
      continue;
    }
    const npc = state.npcs.find((candidate) => candidate.id === id);
    if (npc?.status !== 'present' || npc.locationId !== state.session.scene.locationId) continue;
    cast.push({
      name: npc.displayName, appearance: npc.appearance, role: npc.role, pronouns: '',
      portraitId: ImageIdSchema.safeParse(npc.portraitId).success ? npc.portraitId! : null, imageNumber: null,
    });
  }
  return cast;
}

// The beat's public text in script order; a round in review also carries each contract's intent and approach and the outcome text once dice are rolled.
export function pictureLines(state: SessionState, source: BeatPictureSource): PictureLine[] {
  if (source.published) {
    return source.published.segments.flatMap((segment) => (
      segment.kind === 'system' ? [] : [{ kind: segment.kind, speaker: segment.speaker?.displayName ?? null, text: segment.text }]
    ));
  }
  const { beat } = source;
  const characterName = (id: string) => state.characters.find((character) => character.id === id)?.displayName ?? null;
  const lines: PictureLine[] = [
    ...beat.lockedSubmissions.filter((submission) => submission.kind !== 'ooc' && submission.text.trim()).map((submission): PictureLine => (
      { kind: 'player_dialogue', speaker: characterName(submission.characterId), text: submission.text }
    )),
    ...(beat.draft?.segments ?? []).map((segment): PictureLine => (
      segment.kind === 'npc_dialogue'
        ? { kind: 'npc_dialogue', speaker: state.npcs.find((npc) => npc.id === segment.speakerNpcId)?.displayName ?? null, text: segment.text }
        : { kind: 'narration', speaker: null, text: segment.text }
    )),
  ];
  for (const contract of beat.contracts) {
    const speaker = characterName(contract.actorCharacterId);
    lines.push({ kind: 'intent', speaker, text: contract.intent }, { kind: 'approach', speaker, text: contract.approach });
  }
  for (const outcome of beat.resolution?.outcomes ?? []) {
    if (outcome.publicText.trim()) lines.push({ kind: 'outcome', speaker: characterName(outcome.actorCharacterId), text: outcome.publicText });
  }
  return lines;
}

// The first MOMENT_PORTRAIT_MAX people with a ready portrait are numbered in cast order; everyone else stays in the cast and is drawn from words.
export function buildPictureMoment(
  state: SessionState,
  source: BeatPictureSource,
  settings: PictureSettings,
  readyPortraitIds: ReadonlySet<string>,
): PictureMoment {
  let numbered = 0;
  const cast = pictureCast(state, source).map((person): PicturePerson => {
    if (person.portraitId === null || !readyPortraitIds.has(person.portraitId) || numbered === MOMENT_PORTRAIT_MAX) {
      return { ...person, portraitId: null, imageNumber: null };
    }
    return { ...person, imageNumber: ++numbered };
  });
  const { scene } = state.session;
  return {
    style: settings.style, model: settings.model,
    scene: { title: scene.title, description: scene.description, place: sceneLocationTitle(state) },
    lines: pictureLines(state, source), cast, names: namesInState(state),
  };
}
