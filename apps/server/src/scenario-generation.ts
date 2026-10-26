import { randomUUID } from 'node:crypto';
import { ScenarioDefinitionSchema, type ScenarioDefinition, type ScenarioDraft } from '@rpg/contracts';

const MAX_BOUNDARIES = 30;
const MAX_NOTES = 40;
const MAX_NOTE_LENGTH = 300;

const clean = (items: readonly string[]) => items.map(item => item.trim()).filter(Boolean);
const plain = (value: string) => value.replace(/—/g, '-');
const contains = (text: string, needle: string) => text.toLowerCase().includes(needle.toLowerCase());

export function scenarioFromDraft(
  draft: ScenarioDraft,
  boundaries: string[],
  makeId: () => string = randomUUID,
): { definition: ScenarioDefinition; adjustments: string[]; warnings: string[]; suggestedBoundaries: string[] } {
  const adjustments: string[] = [];
  const warnings: string[] = [];
  const adjust = (sentence: string) => { adjustments.push(plain(sentence)); };
  const characterNotes: string[] = [];
  // Notes that must survive the 40-note cut, ahead of every other change note.
  const priorityNotes: string[] = [];
  const adjustCharacter = (sentence: string) => { characterNotes.push(plain(sentence)); };
  const warn = (sentence: string) => { warnings.push(plain(sentence)); };

  const keptPlaces = draft.locations.filter(place => place.title.trim() !== '');
  const droppedPlaces = draft.locations.length - keptPlaces.length;
  if (droppedPlaces > 0) adjust(droppedPlaces === 1 ? 'Dropped a place that had no title.' : `Dropped ${droppedPlaces} places that had no title.`);
  if (keptPlaces.length === 0) throw new Error('The draft has no usable places.');

  const locations = keptPlaces.map(place => ({ id: makeId(), title: place.title.trim(), description: place.description.trim() }));
  const keyToId = new Map<string, string>();
  keptPlaces.forEach((place, index) => {
    const key = place.key.trim();
    if (keyToId.has(key)) adjust(`The place "${place.title.trim()}" reused the key of an earlier place, so characters and scenes that name that key go to the earlier place.`);
    else keyToId.set(key, locations[index]!.id);
  });
  const firstPlaceId = locations[0]!.id;

  const openingKey = draft.openingScene.locationKey.trim();
  const openingKnown = keyToId.has(openingKey);
  const openingLocationId = keyToId.get(openingKey) ?? firstPlaceId;
  if (!openingKnown) adjust(`The opening scene named a place that does not exist, so it now starts at "${locations[0]!.title}".`);
  const openingTitle = draft.openingScene.title.trim();
  if (!openingTitle) adjust('The opening scene had no title, so it is called "Opening scene".');
  const openingScene = {
    id: makeId(), title: openingTitle || 'Opening scene',
    description: draft.openingScene.description.trim(), locationId: openingLocationId,
  };

  const npcs = [];
  for (const npc of draft.npcs) {
    const name = npc.name.trim();
    if (!name) { adjustCharacter('Dropped a character that had no name.'); continue; }
    const mapped = keyToId.get(npc.locationKey.trim());
    if (mapped === undefined) adjustCharacter(`${name} named a place that does not exist, so they now start at the opening place.`);
    const locationId = mapped ?? openingLocationId;
    let status = npc.presence;
    if (status === 'present' && locationId !== openingLocationId) {
      status = 'offstage';
      adjustCharacter(`${name} was marked as present but is not at the opening place, so they are now offstage.`);
    }
    const channel = npc.communicationChannel?.trim() || null;
    if (npc.communicationChannel !== null && channel === null) adjustCharacter(`${name} had a blank way of being reached, so it was cleared.`);
    const hiddenIdentity = npc.hiddenIdentity?.trim() || null;
    if (npc.hiddenIdentity !== null && hiddenIdentity === null) adjustCharacter(`${name} had a blank hidden identity, so it was cleared.`);
    const mood = npc.mood.trim();
    if (!mood) adjustCharacter(`${name} had no mood, so it is set to "neutral".`);
    const knowledge = npc.knowledge
      .map(item => ({ statement: item.statement.trim(), category: item.category }))
      .filter(item => item.statement !== '');
    if (knowledge.length < npc.knowledge.length) adjustCharacter(`Dropped a blank thing ${name} knows.`);
    const stance = npc.partyStance;
    const reason = npc.partyReason.trim();
    const partyRelationship = stance && reason ? { stance, reason } : null;
    if (stance && !reason) adjustCharacter(`${name} had a stance toward the party but no reason, so the stance was dropped.`);
    if (reason && !stance) adjustCharacter(`${name} had a reason for how they feel about the party but no stance, so the reason was dropped.`);
    const cleanList = (items: string[], label: string) => {
      const cleaned = clean(items);
      if (cleaned.length < items.length) adjustCharacter(`Dropped blank entries from the ${label} ${name}.`);
      return cleaned;
    };
    const aliases = cleanList(npc.aliases, 'other names of');
    const personality = cleanList(npc.personality, 'personality of');
    const limits = cleanList(npc.limits, 'limits of');
    const dialogueExamples = cleanList(npc.dialogueExamples, 'sample lines of');
    const secrets = cleanList(npc.secrets, 'secrets of');
    npcs.push({
      id: makeId(), displayName: name, role: npc.role.trim(), appearance: npc.appearance.trim(),
      aliases, hiddenIdentity, personality,
      motivation: npc.motivation.trim(), goal: npc.goal.trim(), limits,
      dialogueExamples, mood: mood || 'neutral', locationId, status,
      communicationChannel: channel, voiceProfileId: 'narrator', secrets,
      knowledge, partyRelationship,
    });
  }

  const tracks = [];
  for (const track of draft.tracks) {
    const label = track.label.trim();
    if (!label) { adjust('Dropped a track that had no label.'); continue; }
    if (track.ticksEachActionRound && track.kind !== 'countdown') adjust(`The track "${label}" was set to tick each action round, but only countdowns can, so it does not tick.`);
    tracks.push({
      id: makeId(), label, kind: track.kind, current: 0, max: track.max, visibility: track.visibility,
      trigger: track.kind === 'countdown' && track.ticksEachActionRound ? ('action_round' as const) : null,
      enabled: true, completionText: track.completionText.trim(), completionEffects: [],
    });
  }

  const facts = [];
  for (const fact of draft.facts) {
    const text = fact.text.trim();
    if (!text) { adjust('Dropped a fact that had no text.'); continue; }
    facts.push({ id: makeId(), text, visibility: fact.visibility });
  }

  const title = draft.title.trim();
  if (!title) adjust('The scenario had no title, so it is called "Untitled scenario".');

  const trimmedList = (items: string[], label: string) => {
    const cleaned = clean(items);
    if (cleaned.length < items.length) adjust(`Dropped blank entries from the ${label}.`);
    return cleaned;
  };
  const playerHooks = trimmedList(draft.playerHooks, 'player hooks');
  const objectives = trimmedList(draft.objectives, 'objectives');
  const discoveries = trimmedList(draft.discoveries, 'discoveries');
  const opportunities = trimmedList(draft.opportunities, 'opportunities');

  const merged = boundaries.slice(0, MAX_BOUNDARIES);
  const seen = new Set(merged.map(item => item.trim().toLowerCase()));
  const suggestedBoundaries: string[] = [];
  let skippedForRoom = 0;
  for (const suggestion of draft.suggestedBoundaries) {
    const text = suggestion.trim();
    const lowered = text.toLowerCase();
    if (!text || seen.has(lowered)) continue;
    if (merged.length >= MAX_BOUNDARIES) { skippedForRoom += 1; continue; }
    seen.add(lowered);
    merged.push(text);
    suggestedBoundaries.push(text);
  }
  if (skippedForRoom > 0) priorityNotes.push(plain('Some suggested boundaries were left out because the list is full.'));

  const publicTracks = tracks.filter(track => track.visibility === 'public');
  const publicText = [
    title, draft.premise, openingScene.title, openingScene.description,
    ...npcs.flatMap(npc => [npc.displayName, npc.role, npc.appearance]),
    ...publicTracks.flatMap(track => [track.label, track.completionText]),
    ...facts.filter(fact => fact.visibility === 'public').map(fact => fact.text),
    ...playerHooks, ...objectives,
  ].join('\n');
  for (const npc of npcs) {
    if (npc.hiddenIdentity && contains(publicText, npc.hiddenIdentity)) {
      warn(`The hidden identity of ${npc.displayName} appears in text every player can read. Remove it from the public text.`);
    }
  }
  if (publicTracks.length > 3) warn('The stage shows three public tracks at most.');
  for (const npc of npcs) {
    const hasPrivate = npc.hiddenIdentity !== null || npc.personality.length > 0 || npc.motivation !== '' || npc.goal !== ''
      || npc.limits.length > 0 || npc.dialogueExamples.length > 0 || npc.secrets.length > 0 || npc.knowledge.length > 0
      || npc.partyRelationship !== null;
    if (!hasPrivate) warn(`${npc.displayName} has only public details. Add the private details by hand.`);
  }

  const definition = ScenarioDefinitionSchema.parse({
    schemaVersion: 1, title: title || 'Untitled scenario', premise: draft.premise.trim(),
    genre: draft.genre.trim(), tone: draft.tone.trim(),
    ...(draft.pictureStyle.trim() ? { pictureStyle: draft.pictureStyle.trim() } : {}),
    boundaries: merged,
    locations, openingScene, npcs, tracks, facts, playerHooks, objectives, discoveries, opportunities,
    directorNotes: draft.directorNotes.trim(), rulesVersion: '0.1',
    pacing: { conversationWords: 90, actionWords: 120 }, extensions: {},
  });

  const limit = (items: string[]) => items.slice(0, MAX_NOTES).map(item => item.slice(0, MAX_NOTE_LENGTH));
  const allNotes = [...priorityNotes, ...adjustments, ...characterNotes];
  const finalNotes = allNotes.length > MAX_NOTES
    ? [...allNotes.slice(0, MAX_NOTES - 1), `The app made ${allNotes.length - (MAX_NOTES - 1)} more changes that are not listed here.`]
    : allNotes;
  return { definition, adjustments: limit(finalNotes), warnings: limit(warnings), suggestedBoundaries };
}
