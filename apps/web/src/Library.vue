<script setup lang="ts">
import { computed, nextTick, onMounted, ref, useId, watch } from 'vue';
import { CharacterCardDefinitionSchema, PICTURE_MODELS, ScenarioDefinitionSchema } from '@rpg/contracts';
import type { CharacterCardDefinition, ScenarioDefinition, Library as LibraryData, TemplateVersion, TemplateRef, NpcDefinition, FieldGenerationCharacterContext, PortraitDetails } from '@rpg/contracts';
import { api } from './api';
import { identityPath } from './identity';
import { navigate } from './navigate';
import CharacterForm from './CharacterForm.vue';
import { withDescription } from './card-description';
import BuilderInvites from './BuilderInvites.vue';
import ErrorNotice from './ErrorNotice.vue';
import FieldGenerator from './FieldGenerator.vue';
import ScenarioGenerator from './ScenarioGenerator.vue';
import { npcFieldContext } from './field-context';
import NpcPortraitControls from './NpcPortraitControls.vue';
import { BATCH_PORTRAIT_CONCURRENCY, pictureUrl, runPool } from './pictures';

const helpPrefix = useId();
const helpId = (...parts: string[]) => `${helpPrefix}-help-${encodeURIComponent(JSON.stringify(parts))}`;

const makeId = () => crypto.randomUUID();
const library = ref<LibraryData>({ scenarios: [], characters: [] });
const busy = ref(false);
const error = ref('');
const notice = ref('');
const mode = ref<'scenario' | 'character'>('scenario');
const templateId = ref<string>();
const version = ref(0);
const editorEpoch = ref(0);
const picturesEnabled = computed(() => library.value.picturesEnabled === true);
const cardPortraitKey = ref(makeId());
const entityContext = (id: string) => `${editorEpoch.value}:${id}`;
const knowledgeKeys = new WeakMap<object, string>();
function knowledgeKey(knowledge: object) {
  let id = knowledgeKeys.get(knowledge);
  if (!id) { id = makeId(); knowledgeKeys.set(knowledge, id); }
  return id;
}
const nativeJson = ref('');
const starterCards = ref<CharacterCardDefinition[]>([]);
const newCard = (): CharacterCardDefinition => ({ schemaVersion: 1, displayName: '', pronouns: '', appearance: '', personality: '', backstory: '', traits: { force: 2, finesse: 1, wits: 1, presence: 0 }, specialty: '', flaw: '', possessions: ['', '', ''], connection: '', secret: '', extensions: {} });
const newScenario = (): ScenarioDefinition => {
  const locationId = crypto.randomUUID();
  return { schemaVersion: 1, title: 'New scenario', premise: '', genre: '', tone: '', boundaries: [], locations: [{ id: locationId, title: 'Opening location', description: '' }], openingScene: { id: crypto.randomUUID(), title: 'Opening scene', description: '', locationId }, npcs: [], tracks: [], facts: [], playerHooks: [], objectives: [], discoveries: [], opportunities: [], directorNotes: '', rulesVersion: '0.1', pacing: { conversationWords: 90, actionWords: 120 }, extensions: {} };
};
const scenario = ref(newScenario());
const scenarioBaseline = ref(JSON.stringify(scenario.value));
const scenarioDirty = computed(() => JSON.stringify(scenario.value) !== scenarioBaseline.value);
const boundariesAiNote = ref(false);
const openRows = ref<Record<string, boolean>>({});
function rowToggled(id: string, event: Event) { openRows.value[id] = (event.target as HTMLDetailsElement).open; }
const card = ref(newCard());
const cardDescription = ref('');
const showTitle = ref('A new story');
const showScenario = ref('');
const characterPremiseSource = ref('');
const draftPremiseLabel = computed(() => `Current scenario draft: ${scenario.value.title}`);
const hasDraftPremise = computed(() => Boolean(scenario.value.premise.trim()) && scenario.value.premise.trim().length <= 4000);
const selectedShowScenario = computed(() => library.value.scenarios.find(item => key(item) === showScenario.value));
const selectedCharacterScenario = computed(() => library.value.scenarios.find(item => key(item) === characterPremiseSource.value));
const savedPremiseLabel = (item: TemplateVersion<ScenarioDefinition>) => `${item.definition.title} · version ${item.version}`;
const characterPremise = computed(() => characterPremiseSource.value === 'draft' ? scenario.value.premise : selectedCharacterScenario.value?.definition.premise);
const characterPremiseLabel = computed(() => characterPremiseSource.value === 'draft' ? draftPremiseLabel.value : selectedCharacterScenario.value ? savedPremiseLabel(selectedCharacterScenario.value) : undefined);
const characterGenerationContext = computed(() => `${editorEpoch.value}:character-source:${characterPremiseSource.value}`);
// CharacterForm empties its description when this context changes. Picking a scenario or reloading the library keeps
// the same card open, so the typed description comes back; opening or importing a card clears it before the change.
watch(characterGenerationContext, () => {
  const typed = cardDescription.value;
  if (typed) void nextTick(() => { if (!cardDescription.value) cardDescription.value = typed; });
});
const trimmedCharacterPremise = computed(() => { const text = characterPremise.value?.trim() ?? ''; return text && text.length <= 4000 ? text : ''; });
const characterCardNote = computed(() => trimmedCharacterPremise.value ? 'The premise of the scenario you picked is sent too.' : undefined);
const generateCard = (input: { prompt: string; keepFilled: boolean; current: FieldGenerationCharacterContext }) => {
  const premise = trimmedCharacterPremise.value;
  return api.generateCard({ prompt: input.prompt, keepFilled: input.keepFilled, current: input.current as Extract<FieldGenerationCharacterContext, { kind: 'character' }>, ...(premise ? { premise } : {}) });
};
const seats = ref(['player', 'player']);
const listFields = [{ key: 'boundaries', label: 'What the AI won\'t write', help: 'One per line. The AI stays away from these when it writes. Players never see this list.' }, { key: 'playerHooks', label: 'Player hooks', help: 'Public reasons for the party to join the story; these guide AI scene drafts.' }, { key: 'objectives', label: 'Objectives', help: 'Public goals that guide AI scene drafts; they do not complete automatically.' }, { key: 'discoveries', label: 'Discoveries · director only', help: 'Private ideas for director reference in this template; not loaded into running sessions.' }, { key: 'opportunities', label: 'Opportunities · director only', help: 'Private possibilities for director reference in this template; not loaded into running sessions.' }] as const;
const fineListFields = listFields.filter(field => field.key !== 'boundaries');
const npcLists = [{ key: 'aliases', label: 'Aliases', help: 'Other names kept as private reference; reveal them deliberately.' }, { key: 'personality', label: 'Personality', help: 'Traits that guide how the AI plays this character.' }, { key: 'limits', label: 'Limits', help: 'Behavioral boundaries that guide this character’s AI dialogue.' }, { key: 'dialogueExamples', label: 'Dialogue examples', help: 'Sample lines that guide this character’s AI speaking style.' }, { key: 'secrets', label: 'Secrets · director only', help: 'Private information for director reference and deliberate reveals.' }] as const;
const lines = (event: Event) => (event.target as HTMLTextAreaElement).value.split('\n');
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
function scenarioFromForm() {
  const definition = clone(scenario.value);
  for (const { key } of listFields) definition[key] = definition[key].map(value => value.trim()).filter(Boolean);
  for (const npc of definition.npcs) for (const { key } of npcLists) npc[key] = npc[key].map(value => value.trim()).filter(Boolean);
  return ScenarioDefinitionSchema.parse(definition);
}
function message(cause: unknown) {
  if (cause && typeof cause === 'object' && 'issues' in cause) return `Please enter valid content: ${(cause.issues as Array<{ message: string; path: unknown[] }>).slice(0, 3).map(issue => `${issue.path.join('.')}: ${issue.message}`).join(' · ')}`;
  return cause instanceof Error ? cause.message : 'The library request failed.';
}
async function work(task: () => Promise<void> | void) {
  if (busy.value) return;
  busy.value = true; error.value = ''; notice.value = '';
  try { await task(); } catch (cause) { error.value = message(cause); } finally { busy.value = false; }
}
async function load() {
  editorEpoch.value += 1;
  library.value = await api.library();
  if (!showScenario.value && library.value.scenarios[0]) showScenario.value = key(library.value.scenarios[0]);
}
const npcPortraits = ref<Record<string, { state: 'making' | 'failed'; message?: string }>>({});
const portraitsMaking = computed(() => Object.values(npcPortraits.value).some(entry => entry.state === 'making'));
const savedWhileMaking = ref(false);
const portraitsFinishedNote = ref(false);
watch(portraitsMaking, making => { if (!making && savedWhileMaking.value) { savedWhileMaking.value = false; portraitsFinishedNote.value = true; } });
const portraitBatch = ref<{ done: number; total: number; made: number; running: boolean } | null>(null);
const portraitEpoch = ref(0);
// Opening, importing or drafting another scenario starts portrait work over; answers still in flight for the old one are dropped.
function resetPortraits() { portraitEpoch.value += 1; npcPortraits.value = {}; portraitBatch.value = null; savedWhileMaking.value = false; portraitsFinishedNote.value = false; }
const hasPortraitSubject = (npc: NpcDefinition) => Boolean(npc.appearance.trim() || npc.role.trim());
const missingPortraits = computed(() => scenario.value.npcs.filter(npc => !npc.portraitId && hasPortraitSubject(npc) && npcPortraits.value[npc.id]?.state !== 'making'));
const portraitBatchText = computed(() => {
  const batch = portraitBatch.value!;
  if (!batch || (!batch.total && !batch.running)) return '';
  if (batch.running) return `Making portraits: ${batch.done} of ${batch.total} done.`;
  const noun = batch.total === 1 ? 'portrait' : 'portraits';
  return batch.made === batch.total ? `Made ${batch.total} ${noun}.` : `Made ${batch.made} of ${batch.total} ${noun}. Press Create portrait on a character to try again.`;
});
function setPictureModel(value: string) {
  if (value) scenario.value.pictureModel = value;
  else delete scenario.value.pictureModel;
}
async function createPortrait(npcId: string, batch: boolean) {
  const npc = scenario.value.npcs.find(item => item.id === npcId);
  if (!npc || !hasPortraitSubject(npc)) return false;
  const epoch = portraitEpoch.value;
  npcPortraits.value[npcId] = { state: 'making' };
  try {
    const { imageId } = await api.createLibraryPortrait({ subject: 'npc', subjectKey: npcId, details: { appearance: npc.appearance, role: npc.role, pronouns: '', name: npc.displayName }, pictureStyle: scenario.value.pictureStyle ?? '', ...(scenario.value.pictureModel ? { pictureModel: scenario.value.pictureModel } : {}) });
    if (epoch !== portraitEpoch.value) return false;
    const current = scenario.value.npcs.find(item => item.id === npcId);
    if (current && !(batch && current.portraitId)) current.portraitId = imageId;
    delete npcPortraits.value[npcId];
    return Boolean(current);
  } catch (cause) {
    if (epoch !== portraitEpoch.value) return false;
    npcPortraits.value[npcId] = { state: 'failed', message: message(cause) };
    return false;
  }
}
async function createMissingPortraits() {
  if (portraitBatch.value?.running) return;
  const ids = missingPortraits.value.map(npc => npc.id);
  if (!ids.length) return;
  const epoch = portraitEpoch.value;
  portraitBatch.value = { done: 0, total: ids.length, made: 0, running: true };
  const batch = portraitBatch.value!;
  await runPool(ids, BATCH_PORTRAIT_CONCURRENCY, async id => {
    if (epoch !== portraitEpoch.value) return;
    const made = await createPortrait(id, true);
    if (!scenario.value.npcs.some(npc => npc.id === id)) { batch.total -= 1; return; }
    batch.done += 1;
    if (made) batch.made += 1;
  });
  batch.running = false;
}
const generateCardPortrait = (details: PortraitDetails) => api.createLibraryPortrait({ subject: 'card', subjectKey: templateId.value ?? cardPortraitKey.value, details, pictureStyle: '' });
const key = (item: { id: string; version: number }) => `${item.id}:${item.version}`;
const seatChoice = (value: string) => value === 'player' ? { playerWritten: true as const } : refFrom(value);
function refFrom(value: string): TemplateRef {
  const split = value.lastIndexOf(':');
  if (split < 1) throw new Error('Choose a saved scenario. Each seat needs a saved card or Player writes their own character.');
  return { templateId: value.slice(0, split), version: Number(value.slice(split + 1)) };
}
function editScenario(item?: TemplateVersion<ScenarioDefinition>) { editorEpoch.value += 1; resetPortraits(); openScenario(item); }
function openScenario(item?: TemplateVersion<ScenarioDefinition>) { mode.value = 'scenario'; templateId.value = item?.id; version.value = item?.version ?? 0; scenario.value = item ? clone(item.definition) : newScenario(); scenarioBaseline.value = JSON.stringify(scenario.value); boundariesAiNote.value = false; openRows.value = {}; nativeJson.value = ''; error.value = ''; notice.value = ''; }
function editCard(item?: TemplateVersion<CharacterCardDefinition>) { editorEpoch.value += 1; cardPortraitKey.value = makeId(); mode.value = 'character'; characterPremiseSource.value = ''; templateId.value = item?.id; version.value = item?.version ?? 0; card.value = item ? clone(item.definition) : newCard(); cardDescription.value = ''; nativeJson.value = ''; error.value = ''; notice.value = ''; }
function starter() { return work(async () => { const result = await api.starter(); editScenario(); scenario.value = clone(result.scenario); starterCards.value = clone(result.characters); notice.value = 'Rehearsal content loaded as a new template. Review and save the scenario and any cards you want to reuse.'; }); }
function applyScenarioDraft(result: { definition: ScenarioDefinition; suggestedBoundaries: string[] }) {
  mode.value = 'scenario'; scenario.value = clone(result.definition); editorEpoch.value += 1; resetPortraits(); templateId.value = undefined; version.value = 0;
  boundariesAiNote.value = result.suggestedBoundaries.length > 0; openRows.value = {}; nativeJson.value = ''; error.value = '';
  notice.value = 'Loaded the AI draft as a new unsaved scenario. Check every field, then press Save scenario version.';
  if (picturesEnabled.value) { notice.value += ' Portraits for its characters are being made now.'; void createMissingPortraits(); }
}
function listInput(field: string, event: Event) {
  if (field === 'boundaries') boundariesAiNote.value = false;
  scenario.value[field as typeof listFields[number]['key']] = lines(event);
}
function listGenerated(field: string, value: string) {
  if (field === 'boundaries') boundariesAiNote.value = false;
  scenario.value[field as typeof listFields[number]['key']] = value.split('\n');
}
function saveScenario() { return work(async () => {
  const definition = scenarioFromForm();
  const wasMaking = portraitsMaking.value;
  savedWhileMaking.value = false; portraitsFinishedNote.value = false;
  const saved = await api.saveScenario({ ...(templateId.value ? { templateId: templateId.value } : {}), expectedVersion: version.value, definition });
  library.value.scenarios = [...library.value.scenarios.filter(item => item.id !== saved.id), saved];
  const landed = new Map(scenario.value.npcs.filter(npc => npc.portraitId).map(npc => [npc.id, npc.portraitId!]));
  editorEpoch.value += 1; openScenario(saved);
  for (const npc of scenario.value.npcs) { const portraitId = landed.get(npc.id); if (portraitId && npc.portraitId !== portraitId) npc.portraitId = portraitId; }
  showScenario.value = key(saved); notice.value = `Scenario saved as version ${saved.version}. Existing sessions keep their pinned version.`;
  if (portraitsMaking.value) savedWhileMaking.value = true; else if (wasMaking) portraitsFinishedNote.value = true;
}); }
function saveCard() { return work(async () => {
  const definition = CharacterCardDefinitionSchema.parse({ ...withDescription(card.value, cardDescription.value), possessions: card.value.possessions.filter(value => value?.trim()) });
  const saved = await api.saveCharacterTemplate({ ...(templateId.value ? { templateId: templateId.value } : {}), expectedVersion: version.value, definition });
  library.value.characters = [...library.value.characters.filter(item => item.id !== saved.id), saved];
  editCard(saved); seats.value = seats.value.map(value => value !== 'player' && refFrom(value).templateId === saved.id ? key(saved) : value); notice.value = `Character saved as version ${saved.version}. Selected seats now use this version.`;
}); }
function importJson() { return work(() => {
  let parsed: unknown;
  try { parsed = JSON.parse(nativeJson.value); } catch { throw new Error('Enter a valid native JSON document.'); }
  if (mode.value === 'scenario') { const definition = ScenarioDefinitionSchema.parse(parsed); scenario.value = definition; boundariesAiNote.value = false; openRows.value = {}; resetPortraits(); }
  else { const definition = CharacterCardDefinitionSchema.parse(parsed); card.value = definition; cardDescription.value = ''; }
  editorEpoch.value += 1; templateId.value = undefined; version.value = 0; notice.value = 'Imported as a new unsaved template. Review the fields before saving.';
}); }
async function importFile(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  if (file.size > 120_000) { error.value = 'Choose a native JSON file smaller than 120 KB.'; return; }
  nativeJson.value = await file.text(); await importJson();
}
function exportJson() { return work(() => {
  const definition = mode.value === 'scenario' ? scenarioFromForm() : CharacterCardDefinitionSchema.parse({ ...card.value, possessions: card.value.possessions.filter(value => value?.trim()) });
  nativeJson.value = JSON.stringify(definition, null, 2);
  const url = URL.createObjectURL(new Blob([JSON.stringify(definition)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = `${mode.value}.json`; link.click(); URL.revokeObjectURL(url);
  notice.value = 'Native JSON exported. It includes private notes and secrets; share it only with intended collaborators.';
}); }
function addLocation() {
  const id = makeId();
  scenario.value.locations.push({ id, title: 'New location', description: '' });
  openRows.value[id] = true;
}
function addNpc() {
  const id = crypto.randomUUID();
  openRows.value[id] = true;
  scenario.value.npcs.push({ id, displayName: 'New character', role: '', appearance: '', aliases: [], hiddenIdentity: null, personality: [], motivation: '', goal: '', limits: [], dialogueExamples: [], mood: 'neutral', locationId: scenario.value.openingScene.locationId, status: 'present', communicationChannel: null, voiceProfileId: 'narrator', secrets: [], knowledge: [], partyRelationship: null });
}
function partyRelationship(npc: NpcDefinition, event: Event) {
  const stance = (event.target as HTMLSelectElement).value;
  npc.partyRelationship = stance ? { stance: stance as NonNullable<NpcDefinition['partyRelationship']>['stance'], reason: npc.partyRelationship?.reason ?? '' } : null;
}
function createShow() { return work(async () => {
  if (!showTitle.value.trim()) throw new Error('Enter a show title.');
  if (seats.value.length < 2 || seats.value.length > 6) throw new Error('Choose between two and six player seats.');
  const created = await api.createCustom(showTitle.value, refFrom(showScenario.value), seats.value.map(seatChoice));
  navigate(`/sessions/${created.sessionId}/lobby`);
}); }
onMounted(() => { void work(load); });
</script>

<template>
  <main class="shell library-shell">
    <div class="scene-heading"><div><p class="eyebrow">Your story library</p><h1>Build a world. Bring a cast.</h1><p>Save reusable scenarios and character cards, then choose two to six seats for your next show.</p></div><a :href="identityPath('/')">Back to host workspace</a></div>
    <ErrorNotice v-if="error" :message="error" @dismiss="error = ''" /><p v-if="notice" role="status" class="notice">{{ notice }}</p>
    <div class="library-layout">
      <aside class="stack"><section class="panel"><h2>Scenarios</h2><p v-if="!library.scenarios.length" class="muted">No saved scenarios yet.</p><button v-for="item in library.scenarios" :key="item.id" class="library-item secondary" :data-testid="`edit-scenario-${item.id}`" :disabled="busy" @click="editScenario(item)">{{ item.definition.title }} <small>Version {{ item.version }}</small></button><div class="actions"><button class="secondary" :disabled="busy" @click="editScenario()">New scenario</button><button class="quiet" :disabled="busy" @click="starter">Use rehearsal scenario</button></div></section>
      <section class="panel"><h2>Character cards</h2><p v-if="!library.characters.length" class="muted">No saved cards yet.</p><button v-for="item in library.characters" :key="item.id" class="library-item secondary" :data-testid="`edit-character-${item.id}`" :disabled="busy" @click="editCard(item)">{{ item.definition.displayName }} <small>Version {{ item.version }}</small></button><button class="secondary" :disabled="busy" @click="editCard()">New character</button><div v-if="starterCards.length"><h3>Rehearsal cards</h3><button v-for="seed in starterCards" :key="seed.displayName" class="library-item quiet" :disabled="busy" @click="editCard(); card = clone(seed)">Edit {{ seed.displayName }} starter</button></div></section>
      </aside>
      <section class="panel editor"><div class="panel-heading"><h2>{{ mode === 'scenario' ? 'Scenario editor' : 'Character editor' }}</h2><span class="status">{{ version ? `Editing version ${version}` : 'New template' }}</span></div><p class="muted">{{ version ? 'Saving creates a new version. Running sessions keep the version they started with.' : 'Nothing is saved until you choose Save.' }}</p>
      <fieldset class="editor-fields" :disabled="busy"><ScenarioGenerator v-show="mode === 'scenario'" :boundaries="scenario.boundaries" :premise="scenario.premise" :disabled="busy" :replaces-unsaved="scenarioDirty" :start="api.startScenarioDraft" :poll="api.scenarioDraft" @apply="applyScenarioDraft" /><template v-if="mode === 'scenario'">
        <div class="generated-field"><label><span class="field-label">Scenario title</span><input :aria-describedby="helpId('scenario.title')" v-model="scenario.title" data-testid="scenario-title" maxlength="160"></label><p class="field-help" :id="helpId('scenario.title')">Name used to identify this reusable scenario in the library.</p><FieldGenerator :premise="scenario.premise" :premise-label="draftPremiseLabel" class="field-ai" field="scenario.title" v-model="scenario.title" :context-key="editorEpoch" :disabled="busy" /></div><div class="generated-field"><label><span class="field-label">Premise</span><textarea :aria-describedby="helpId('scenario.premise')" v-model="scenario.premise" rows="3" /></label><p class="field-help" :id="helpId('scenario.premise')">The public central situation that guides AI scene drafts and optional field drafting.</p><FieldGenerator :premise="scenario.premise" :premise-label="draftPremiseLabel" class="field-ai" field="scenario.premise" v-model="scenario.premise" :context-key="editorEpoch" :disabled="busy" /></div>
        <div class="generated-field"><label><span class="field-label">What the AI won't write · one per line</span><textarea data-testid="scenario-boundaries" :aria-describedby="helpId('scenario', 'boundaries')" :value="scenario.boundaries.join('\n')" rows="3" @input="listInput('boundaries', $event)" /></label><p class="field-help" :id="helpId('scenario', 'boundaries')">One per line. The AI stays away from these when it writes. Players never see this list.</p><p v-if="boundariesAiNote" class="field-help" data-testid="boundaries-ai-note" role="status">Added by the AI. Edit freely.</p><FieldGenerator :premise="scenario.premise" :premise-label="draftPremiseLabel" class="field-ai" field="scenario.boundaries" :model-value="scenario.boundaries.join('\n')" :context-key="editorEpoch" :disabled="busy" @update:model-value="listGenerated('boundaries', $event)" /></div>
        <section class="scene-block"><h3>Opening scene</h3><div class="generated-field"><label><span class="field-label">Scene title</span><input :aria-describedby="helpId('scenario.openingScene.title')" v-model="scenario.openingScene.title"></label><p class="field-help" :id="helpId('scenario.openingScene.title')">The title of the first scene when a show begins.</p><FieldGenerator :premise="scenario.premise" :premise-label="draftPremiseLabel" class="field-ai" field="scene.title" v-model="scenario.openingScene.title" :context-key="entityContext(scenario.openingScene.id)" :disabled="busy" /></div><div class="generated-field"><label><span class="field-label">Scene description</span><textarea :aria-describedby="helpId('scenario.openingScene.description')" v-model="scenario.openingScene.description" /></label><p class="field-help" :id="helpId('scenario.openingScene.description')">The opening situation shown to the cast and used as scene context.</p><FieldGenerator :premise="scenario.premise" :premise-label="draftPremiseLabel" class="field-ai" field="scene.description" v-model="scenario.openingScene.description" :context-key="entityContext(scenario.openingScene.id)" :disabled="busy" /></div><div class="help-field"><label>Opening location<select :aria-describedby="helpId('scenario.openingScene.locationId')" v-model="scenario.openingScene.locationId"><option v-for="location in scenario.locations" :key="location.id" :value="location.id">{{ location.title }}</option></select></label><p class="field-help" :id="helpId('scenario.openingScene.locationId')">Choose where the opening scene takes place.</p></div></section>
        <section class="scene-block"><h3>Places</h3><details v-for="(location, index) in scenario.locations" :key="location.id" class="row-fold" :open="openRows[location.id]" @toggle="rowToggled(location.id, $event)"><summary data-testid="place-summary">{{ location.title || 'Unnamed place' }}</summary><div class="generated-field"><label><span class="field-label">Location name</span><input :aria-describedby="helpId('location.title', location.id)" v-model="location.title"></label><p class="field-help" :id="helpId('location.title', location.id)">Identifies this place in the director’s location choices.</p><FieldGenerator :premise="scenario.premise" :premise-label="draftPremiseLabel" class="field-ai" field="location.title" v-model="location.title" :context-key="entityContext(location.id)" :disabled="busy" /></div><div class="generated-field"><label><span class="field-label">Location description</span><textarea :aria-describedby="helpId('location.description', location.id)" v-model="location.description" /></label><p class="field-help" :id="helpId('location.description', location.id)">Private location notes for the director. Put details the party should see in the scene description.</p><FieldGenerator :premise="scenario.premise" :premise-label="draftPremiseLabel" class="field-ai" field="location.description" v-model="location.description" :context-key="entityContext(location.id)" :disabled="busy" /></div><button class="quiet" :disabled="scenario.locations.length === 1" @click="scenario.locations.splice(index, 1)">Remove location</button></details><button class="secondary" @click="addLocation">Add location</button></section>
        <section class="scene-block"><h3>Non-player characters · {{ scenario.npcs.length }}</h3><p class="muted">Names, roles, appearances, presence, and voice profile identifiers are public, including offstage characters. Put unrevealed identities and details in hidden identity or secrets.</p><details v-for="(npc, index) in scenario.npcs" :key="npc.id" class="row-fold" :open="openRows[npc.id]" @toggle="rowToggled(npc.id, $event)"><summary data-testid="npc-summary">{{ npc.displayName }}{{ npc.role ? ' · ' + npc.role : '' }}</summary><div class="field-grid"><div class="generated-field"><label><span class="field-label">Name</span><input :aria-describedby="helpId('npc.displayName', npc.id)" v-model="npc.displayName"></label><p class="field-help" :id="helpId('npc.displayName', npc.id)">The public name shown to players, even while this character is offstage.</p><FieldGenerator :character-context="npcFieldContext(npc)" :premise="scenario.premise" :premise-label="draftPremiseLabel" class="field-ai" field="npc.displayName" v-model="npc.displayName" :context-key="entityContext(npc.id)" :disabled="busy" /></div><div class="generated-field"><label><span class="field-label">Role</span><input :aria-describedby="helpId('npc.role', npc.id)" v-model="npc.role"></label><p class="field-help" :id="helpId('npc.role', npc.id)">This character’s public role in the story, such as guide or rival.</p><FieldGenerator :character-context="npcFieldContext(npc)" :premise="scenario.premise" :premise-label="draftPremiseLabel" class="field-ai" field="npc.role" v-model="npc.role" :context-key="entityContext(npc.id)" :disabled="busy" /></div></div><div class="generated-field"><label><span class="field-label">Appearance</span><textarea :aria-describedby="helpId('npc.appearance', npc.id)" v-model="npc.appearance" /></label><p class="field-help" :id="helpId('npc.appearance', npc.id)">Visible details shared with players, including while this character is offstage. Start with age and gender, for example "A woman in her forties", so the portrait matches.</p><FieldGenerator :character-context="npcFieldContext(npc)" :premise="scenario.premise" :premise-label="draftPremiseLabel" class="field-ai" field="npc.appearance" v-model="npc.appearance" :context-key="entityContext(npc.id)" :disabled="busy" /></div><NpcPortraitControls :name="npc.displayName" :image-url="npc.portraitId ? pictureUrl({ kind: 'library' }, npc.portraitId) : null" :state="npcPortraits[npc.id]?.state ?? null" :message="npcPortraits[npc.id]?.message ?? null" :enabled="picturesEnabled" :disabled="busy" :can-create="hasPortraitSubject(npc)" @create="createPortrait(npc.id, false)" @remove="delete npc.portraitId" /><details class="row-fold" data-testid="npc-more"><summary>More about this character</summary><div class="field-grid"><div class="help-field"><label>Location<select :aria-describedby="helpId('npc.locationId', npc.id)" v-model="npc.locationId"><option v-for="location in scenario.locations" :key="location.id" :value="location.id">{{ location.title }}</option></select></label><p class="field-help" :id="helpId('npc.locationId', npc.id)">Where this character starts; present characters must be at the opening location.</p></div><div class="help-field"><label>Presence<select :aria-describedby="helpId('npc.status', npc.id)" v-model="npc.status"><option value="present">Present in opening scene</option><option value="offstage">Offstage</option></select></label><p class="field-help" :id="helpId('npc.status', npc.id)">Whether this character starts physically in the opening scene or offstage; a communication channel can permit remote dialogue.</p></div><div class="help-field"><label>Voice profile · public identifier<input :aria-describedby="helpId('npc.voiceProfileId', npc.id)" v-model="npc.voiceProfileId"></label><p class="field-help" :id="helpId('npc.voiceProfileId', npc.id)">A public voice mapping name for speech; unmapped names use the server’s default voice.</p></div><div class="generated-field"><label><span class="field-label">Mood</span><input :aria-describedby="helpId('npc.mood', npc.id)" v-model="npc.mood"></label><p class="field-help" :id="helpId('npc.mood', npc.id)">The starting mood that guides this character’s AI dialogue.</p><FieldGenerator :character-context="npcFieldContext(npc)" :premise="scenario.premise" :premise-label="draftPremiseLabel" class="field-ai" field="npc.mood" v-model="npc.mood" :context-key="entityContext(npc.id)" :disabled="busy" /></div></div><div class="generated-field"><label><span class="field-label">Motivation</span><textarea :aria-describedby="helpId('npc.motivation', npc.id)" v-model="npc.motivation" /></label><p class="field-help" :id="helpId('npc.motivation', npc.id)">Private director reference for what drives this character; not automatically included in AI dialogue.</p><FieldGenerator :character-context="npcFieldContext(npc)" :premise="scenario.premise" :premise-label="draftPremiseLabel" class="field-ai" field="npc.motivation" v-model="npc.motivation" :context-key="entityContext(npc.id)" :disabled="busy" /></div><div class="generated-field"><label><span class="field-label">Current goal</span><textarea :aria-describedby="helpId('npc.goal', npc.id)" v-model="npc.goal" /></label><p class="field-help" :id="helpId('npc.goal', npc.id)">Private director reference for what this character wants next; not automatically included in AI dialogue.</p><FieldGenerator :character-context="npcFieldContext(npc)" :premise="scenario.premise" :premise-label="draftPremiseLabel" class="field-ai" field="npc.goal" v-model="npc.goal" :context-key="entityContext(npc.id)" :disabled="busy" /></div><div class="generated-field"><label><span class="field-label">Hidden identity</span><input :aria-describedby="helpId('npc.hiddenIdentity', npc.id)" v-model="npc.hiddenIdentity"></label><p class="field-help" :id="helpId('npc.hiddenIdentity', npc.id)">Private identity for director reference and a deliberate reveal.</p><FieldGenerator :character-context="npcFieldContext(npc)" :premise="scenario.premise" :premise-label="draftPremiseLabel" class="field-ai" field="npc.hiddenIdentity" :model-value="npc.hiddenIdentity ?? ''" @update:model-value="npc.hiddenIdentity = $event" :context-key="entityContext(npc.id)" :disabled="busy" /></div><div class="generated-field"><label><span class="field-label">Communication channel</span><input :aria-describedby="helpId('npc.communicationChannel', npc.id)" v-model="npc.communicationChannel"></label><p class="field-help" :id="helpId('npc.communicationChannel', npc.id)">A channel such as radio that permits remote dialogue and guides AI drafts; it does not connect a real service.</p><FieldGenerator :character-context="npcFieldContext(npc)" :premise="scenario.premise" :premise-label="draftPremiseLabel" class="field-ai" field="npc.communicationChannel" :model-value="npc.communicationChannel ?? ''" @update:model-value="npc.communicationChannel = $event" :context-key="entityContext(npc.id)" :disabled="busy" /></div><div v-for="field in npcLists" :key="field.key" class="generated-field"><label><span class="field-label">{{ field.label }} · one per line</span><textarea :aria-describedby="helpId('npc', npc.id, field.key)" :value="npc[field.key].join('\n')" @input="npc[field.key] = lines($event)" /></label><p class="field-help" :id="helpId('npc', npc.id, field.key)">{{ field.help }}</p><FieldGenerator :character-context="npcFieldContext(npc)" :premise="scenario.premise" :premise-label="draftPremiseLabel" class="field-ai" :field="`npc.${field.key}`" :model-value="npc[field.key].join('\n')" :context-key="entityContext(npc.id)" :disabled="busy" @update:model-value="npc[field.key] = $event.split('\n')" /></div><div class="help-field"><label>Relationship to the party<select :aria-describedby="helpId('npc.partyRelationship', npc.id)" :value="npc.partyRelationship?.stance ?? ''" @change="partyRelationship(npc, $event)"><option value="">No established relationship</option><option v-for="stance in ['hostile', 'wary', 'neutral', 'friendly', 'trusting']" :key="stance">{{ stance }}</option></select></label><p class="field-help" :id="helpId('npc.partyRelationship', npc.id)">The starting attitude toward the party, used in AI dialogue context.</p></div><div v-if="npc.partyRelationship" class="generated-field"><label><span class="field-label">Relationship reason</span><textarea :aria-describedby="helpId('npc.partyRelationship.reason', npc.id)" v-model="npc.partyRelationship.reason" /></label><p class="field-help" :id="helpId('npc.partyRelationship.reason', npc.id)">Why this character holds that attitude; guides AI dialogue.</p><FieldGenerator :character-context="npcFieldContext(npc)" :premise="scenario.premise" :premise-label="draftPremiseLabel" class="field-ai" field="npc.relationshipReason" v-model="npc.partyRelationship.reason" :context-key="entityContext(npc.id)" :disabled="busy" /></div><div v-for="(knowledge, memoryIndex) in npc.knowledge" :key="knowledgeKey(knowledge)" class="editor-row"><div class="generated-field"><label><span class="field-label">What this character knows</span><textarea :aria-describedby="helpId('knowledge.statement', npc.id, knowledgeKey(knowledge))" v-model="knowledge.statement" /></label><p class="field-help" :id="helpId('knowledge.statement', npc.id, knowledgeKey(knowledge))">A fact, belief, or claim available to this character’s AI dialogue.</p><FieldGenerator :character-context="npcFieldContext(npc)" :premise="scenario.premise" :premise-label="draftPremiseLabel" class="field-ai" field="npc.knowledge" v-model="knowledge.statement" :context-key="entityContext(knowledgeKey(knowledge))" :disabled="busy" /></div><div class="help-field"><label>Knowledge type<select :aria-describedby="helpId('knowledge.category', npc.id, knowledgeKey(knowledge))" v-model="knowledge.category"><option>fact</option><option>belief</option><option>claim</option></select></label><p class="field-help" :id="helpId('knowledge.category', npc.id, knowledgeKey(knowledge))">Distinguish established knowledge from a belief or a reported claim.</p></div><button class="quiet" @click="npc.knowledge.splice(memoryIndex, 1)">Remove knowledge</button></div><button class="secondary" @click="npc.knowledge.push({ statement: '', category: 'fact' })">Add knowledge</button></details><div class="actions"><button class="quiet" @click="scenario.npcs.splice(index, 1)">Remove character</button></div></details><button class="secondary" @click="addNpc">Add non-player character</button><template v-if="picturesEnabled"><button type="button" class="secondary" data-testid="create-all-portraits" :disabled="busy || portraitBatch?.running || !missingPortraits.length" @click="createMissingPortraits">Create portraits for everyone</button><p v-if="portraitBatchText" role="status" class="muted" data-testid="create-all-portraits-status">{{ portraitBatchText }}</p></template><p v-else class="muted">Pictures are off on this server.</p></section>
        <details class="fine-tune" data-testid="fine-tune"><summary>Fine-tune</summary><div class="field-grid"><div class="generated-field"><label><span class="field-label">Genre</span><input :aria-describedby="helpId('scenario.genre')" v-model="scenario.genre"></label><p class="field-help" :id="helpId('scenario.genre')">The public story genre that guides AI scene drafts, such as mystery or fantasy.</p><FieldGenerator :premise="scenario.premise" :premise-label="draftPremiseLabel" class="field-ai" field="scenario.genre" v-model="scenario.genre" :context-key="editorEpoch" :disabled="busy" /></div><div class="generated-field"><label><span class="field-label">Tone</span><input :aria-describedby="helpId('scenario.tone')" v-model="scenario.tone"></label><p class="field-help" :id="helpId('scenario.tone')">The public mood and style that guide AI scene drafts.</p><FieldGenerator :premise="scenario.premise" :premise-label="draftPremiseLabel" class="field-ai" field="scenario.tone" v-model="scenario.tone" :context-key="editorEpoch" :disabled="busy" /></div></div><div class="generated-field"><label><span class="field-label">Picture style</span><input maxlength="300" :aria-describedby="helpId('scenario.pictureStyle')" :value="scenario.pictureStyle ?? ''" @input="scenario.pictureStyle = ($event.target as HTMLInputElement).value"></label><p class="field-help" :id="helpId('scenario.pictureStyle')">One look for every picture in shows made from this scenario: art style, colors and light, in a short phrase. Leave it blank to use Painterly digital illustration, rich color, cinematic lighting. Do not name characters or places.</p><FieldGenerator field="scenario.pictureStyle" :premise="scenario.premise" :premise-label="draftPremiseLabel" class="field-ai" :model-value="scenario.pictureStyle ?? ''" @update:model-value="scenario.pictureStyle = $event" :context-key="editorEpoch" :disabled="busy" /></div><div class="help-field"><label>Picture model<select data-testid="scenario-picture-model" :aria-describedby="helpId('scenario.pictureModel')" :value="scenario.pictureModel ?? ''" @change="setPictureModel(($event.target as HTMLSelectElement).value)"><option value="">Server default</option><option v-for="model in PICTURE_MODELS" :key="model.id" :value="model.id">{{ model.label }}</option></select></label><p class="field-help" :id="helpId('scenario.pictureModel')">The model that draws place pictures, portraits, and pictures of a beat where nobody has a portrait, in shows made from this scenario. Server default uses the server's setting. When anyone in a beat has a portrait, FLUX 3 Klein draws the picture.</p></div><template v-for="field in fineListFields" :key="field.key"><div class="generated-field"><label><span class="field-label">{{ field.label }} · one per line</span><textarea :aria-describedby="helpId('scenario', field.key)" :value="scenario[field.key].join('\n')" rows="3" @input="listInput(field.key, $event)" /></label><p class="field-help" :id="helpId('scenario', field.key)">{{ field.help }}</p><FieldGenerator :premise="scenario.premise" :premise-label="draftPremiseLabel" class="field-ai" :field="`scenario.${field.key}`" :model-value="scenario[field.key].join('\n')" :context-key="editorEpoch" :disabled="busy" @update:model-value="listGenerated(field.key, $event)" /></div></template><h3>Tracks &amp; facts</h3><article v-for="(track, index) in scenario.tracks" :key="track.id" class="editor-row"><div class="generated-field"><label><span class="field-label">Track label</span><input :aria-describedby="helpId('track.label', track.id)" v-model="track.label"></label><p class="field-help" :id="helpId('track.label', track.id)">The name used to identify this track during play.</p><FieldGenerator :premise="scenario.premise" :premise-label="draftPremiseLabel" class="field-ai" field="track.label" v-model="track.label" :context-key="entityContext(track.id)" :disabled="busy" /></div><div class="field-grid"><div class="help-field"><label>Track kind<select :aria-describedby="helpId('track.kind', track.id)" v-model="track.kind"><option>progress</option><option>danger</option><option>countdown</option></select></label><p class="field-help" :id="helpId('track.kind', track.id)">Use progress for a goal, danger for growing trouble, or countdown for an approaching event. Set automatic ticking separately.</p></div><div class="help-field"><label>Visibility<select :aria-describedby="helpId('track.visibility', track.id)" v-model="track.visibility"><option>public</option><option>director</option></select></label><p class="field-help" :id="helpId('track.visibility', track.id)">Public tracks are shown to players; director tracks stay private.</p></div><div class="help-field"><label>Current<input :aria-describedby="helpId('track.current', track.id)" v-model.number="track.current" type="number" min="0" :max="track.max"></label><p class="field-help" :id="helpId('track.current', track.id)">The starting value, between zero and the maximum.</p></div><div class="help-field"><label>Maximum<input :aria-describedby="helpId('track.max', track.id)" v-model.number="track.max" type="number" min="1" max="8"></label><p class="field-help" :id="helpId('track.max', track.id)">The track’s upper limit, from 1 to 8.</p></div></div><div class="help-field"><label>Tick automatically<select :aria-describedby="helpId('track.trigger', track.id)" v-model="track.trigger"><option :value="null">Never</option><option value="action_round">After each action round</option></select></label><p class="field-help" :id="helpId('track.trigger', track.id)">With “After each action round” selected, enabled countdowns advance by 1 toward their maximum after a published action round; other track kinds do not tick.</p></div><div class="help-field"><label class="check"><input :aria-describedby="helpId('track.enabled', track.id)" v-model="track.enabled" type="checkbox">Enabled at start</label><p class="field-help" :id="helpId('track.enabled', track.id)">Whether this track starts active; inactive countdowns do not tick, but typed effects can still change tracks.</p></div><div class="generated-field"><label><span class="field-label">Completion text</span><textarea :aria-describedby="helpId('track.completionText', track.id)" v-model="track.completionText" /></label><p class="field-help" :id="helpId('track.completionText', track.id)">Describe what happens when this track fills; text alone creates no mechanical effect. On public tracks, this wording is visible immediately.</p><FieldGenerator :premise="scenario.premise" :premise-label="draftPremiseLabel" class="field-ai" field="track.completionText" v-model="track.completionText" :context-key="entityContext(track.id)" :disabled="busy" /></div><small>Completion effects are preserved. Use the complete native JSON below for typed countdown completion effects. Only countdowns tick after action rounds; completion effects may change other progress/danger tracks or add new facts. Public completion text is visible to players.</small><button class="quiet" @click="scenario.tracks.splice(index, 1)">Remove track</button></article><button class="secondary" @click="scenario.tracks.push({ id: makeId(), label: 'New track', kind: 'progress', current: 0, max: 4, visibility: 'public', trigger: null, enabled: true, completionText: '', completionEffects: [] })">Add track</button><article v-for="(fact, index) in scenario.facts" :key="fact.id" class="editor-row"><div class="generated-field"><label><span class="field-label">Established fact</span><textarea :aria-describedby="helpId('fact.text', fact.id)" v-model="fact.text" /></label><p class="field-help" :id="helpId('fact.text', fact.id)">An established detail included in the show’s starting facts.</p><FieldGenerator :premise="scenario.premise" :premise-label="draftPremiseLabel" class="field-ai" field="fact.text" v-model="fact.text" :context-key="entityContext(fact.id)" :disabled="busy" /></div><div class="help-field"><label>Visibility<select :aria-describedby="helpId('fact.visibility', fact.id)" v-model="fact.visibility"><option>public</option><option>director</option></select></label><p class="field-help" :id="helpId('fact.visibility', fact.id)">Public facts are shown to players; director facts stay private.</p></div><button class="quiet" @click="scenario.facts.splice(index, 1)">Remove fact</button></article><button class="secondary" @click="scenario.facts.push({ id: makeId(), text: '', visibility: 'public' })">Add fact</button><div class="generated-field"><label><span class="field-label">Director notes</span><textarea :aria-describedby="helpId('scenario.directorNotes')" v-model="scenario.directorNotes" rows="5" /></label><p class="field-help" :id="helpId('scenario.directorNotes')">Private director reference for running this scenario; not automatically included in AI scene drafts.</p><FieldGenerator :premise="scenario.premise" :premise-label="draftPremiseLabel" class="field-ai" field="scenario.directorNotes" v-model="scenario.directorNotes" :context-key="editorEpoch" :disabled="busy" /></div><div class="field-grid"><div class="help-field"><label>Conversation word target<input :aria-describedby="helpId('scenario.pacing.conversationWords')" v-model.number="scenario.pacing.conversationWords" type="number" min="20" max="300"></label><p class="field-help" :id="helpId('scenario.pacing.conversationWords')">Approximate word target for AI conversation drafts, from 20 to 300.</p></div><div class="help-field"><label>Action word target<input :aria-describedby="helpId('scenario.pacing.actionWords')" v-model.number="scenario.pacing.actionWords" type="number" min="30" max="500"></label><p class="field-help" :id="helpId('scenario.pacing.actionWords')">Approximate word target for AI action drafts, from 30 to 500.</p></div></div></details>
        <p class="field-help">Saving creates a new reusable version; running sessions remain unchanged.</p><p v-if="portraitsFinishedNote" class="field-help" role="status" data-testid="portraits-finished-note">Portraits finished. Save again to keep them in the library.</p><button :disabled="busy" data-testid="save-scenario" @click="saveScenario">Save scenario version</button><p v-if="scenarioDirty" class="muted" data-testid="scenario-unsaved">Unsaved changes</p>
      </template>
      <template v-else><div class="help-field"><label>Scenario for AI drafts<select :aria-describedby="helpId('characterPremiseSource')" v-model="characterPremiseSource" data-testid="character-premise-source" :disabled="busy"><option value="">No scenario selected</option><option v-if="hasDraftPremise" value="draft">{{ draftPremiseLabel }}</option><option v-for="item in library.scenarios" :key="key(item)" :value="key(item)">{{ savedPremiseLabel(item) }}</option></select></label><p class="field-help" :id="helpId('characterPremiseSource')">Choose context for AI drafts; this does not save a link between the character and scenario.</p></div><CharacterForm v-model="card" v-model:description="cardDescription" :disabled="busy" generation-enabled :generation-context="characterGenerationContext" :premise="characterPremise" :premise-label="characterPremiseLabel" :generate-card="generateCard" :card-generation-note="characterCardNote" :pictures-enabled="picturesEnabled" :generate-portrait="generateCardPortrait" :portrait-url="id => pictureUrl({ kind: 'library' }, id)" /><p class="field-help">Saving creates a new reusable version; running sessions remain unchanged.</p><button :disabled="busy" data-testid="save-character" @click="saveCard">Save character version</button></template>
      </fieldset></section>
    </div>
    <section class="panel create-show"><p class="eyebrow">Bring it to the table</p><h2>Create a custom show</h2><div class="generated-field"><label><span class="field-label">Show title</span><input :aria-describedby="helpId('showTitle')" v-model="showTitle" data-testid="show-title" maxlength="160"></label><p class="field-help" :id="helpId('showTitle')">The title displayed for this show.</p><FieldGenerator :premise="selectedShowScenario?.definition.premise" :premise-label="selectedShowScenario ? savedPremiseLabel(selectedShowScenario) : undefined" class="field-ai" field="session.title" v-model="showTitle" :context-key="`${editorEpoch}:new-show:${showScenario}`" :disabled="busy" /></div><div class="help-field"><label>Scenario version<select :aria-describedby="helpId('showScenario')" v-model="showScenario" data-testid="show-scenario" :disabled="busy"><option value="">Choose a saved scenario</option><option v-for="item in library.scenarios" :key="key(item)" :value="key(item)">{{ item.definition.title }} · version {{ item.version }}</option></select></label><p class="field-help" :id="helpId('showScenario')">Choose the saved scenario version to copy into the new show.</p></div><div v-for="(_, index) in seats" :key="index" class="seat-row"><div class="help-field"><label>Player seat {{ index + 1 }}<select :aria-describedby="helpId('seats[index]', String(index))" v-model="seats[index]" :disabled="busy" :data-testid="`show-seat-${index}`"><option value="player">Player writes their own character</option><option v-for="item in library.characters" :key="key(item)" :value="key(item)">{{ item.definition.displayName }} · version {{ item.version }}</option></select></label><p class="field-help" :id="helpId('seats[index]', String(index))">Choose Player writes their own character to let the player write it in Cast &amp; lobby, or pick a saved card. Each seat gets its own copy to change.</p></div><button class="quiet" :disabled="seats.length <= 2" @click="seats.splice(index, 1)">Remove seat</button></div><p class="muted">Each seat gets its own editable card draft. Reusing a template creates independent characters.</p><div class="actions"><button class="secondary" :disabled="seats.length >= 6" @click="seats.push('player')">Add player seat</button><button :disabled="busy || !showScenario" data-testid="create-custom" @click="createShow">Create custom show</button></div>
</section>
    <details class="panel advanced-tools" data-testid="advanced-tools"><summary>Advanced tools</summary><BuilderInvites :disabled="busy" @refresh-library="work(load)" /><fieldset class="editor-fields" :disabled="busy">
      <section class="native-tools"><h3>Native JSON import, export &amp; advanced editing</h3><p class="muted">Only this app’s version 1 format is accepted. Import validates the complete document and opens a new unsaved template. No scripts or external resources are loaded.</p><div class="help-field"><label>Native JSON<textarea :aria-describedby="helpId('nativeJson')" v-model="nativeJson" data-testid="native-json" rows="12" spellcheck="false" /></label><p class="field-help" :id="helpId('nativeJson')">Edit this app’s native JavaScript Object Notation (JSON) document, then import to replace the unsaved form. Exports include private notes and secrets.</p></div><div class="actions"><button class="secondary" :disabled="busy" data-testid="import-json" @click="importJson">Import native JSON</button><button class="secondary" :disabled="busy" @click="exportJson">Export native JSON</button><button class="quiet" @click="nativeJson = JSON.stringify(mode === 'scenario' ? scenario : card, null, 2)">Copy current fields into editor</button></div><div class="help-field"><label>Import a native JSON file<input :aria-describedby="helpId('file')" type="file" accept="application/json,.json" @change="importFile"></label><p class="field-help" :id="helpId('file')">Load a native JSON file up to 120 KB as a new unsaved template for review.</p></div></section>
</fieldset></details>
  </main>
</template>

<style scoped>
.library-layout { display: grid; grid-template-columns: minmax(210px, 1fr) minmax(0, 3fr); gap: 1.5rem; align-items: start; }
.library-item { display: block; width: 100%; text-align: left; margin: .65rem 0; white-space: normal; }
.library-item small { display: block; }
.field-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1rem; margin-bottom: 1rem; }
.editor > label, .editor-row > label, .create-show > label, details > label { margin-bottom: 1rem; }
.seat-row { margin-bottom: 1rem; }
.generated-field { position: relative; min-width: 0; margin-bottom: 1rem; }
.field-label { min-height: 2.75rem; padding-right: 8rem; display: flex; align-items: center; }
.field-ai { position: absolute; top: 0; right: 0; }
.editor-fields { border: 0; margin: 0; padding: 0; min-width: 0; }
.editor-row { margin: 1rem 0; padding: 1rem 0; border-bottom: 1px solid var(--line); }
.editor details { margin: 1.5rem 0; }
.editor details[open] > summary { margin-bottom: 1rem; }
.editor details.row-fold { margin: .5rem 0; padding: .25rem 0; border-bottom: 1px solid var(--line); }
.editor details.row-fold details.row-fold { border-bottom: 0; margin: 1rem 0; }
.scene-block { margin: 1.5rem 0; }
.create-show { margin-top: 2rem; }
.advanced-tools { margin-top: 2rem; }
.seat-row { display: flex; align-items: center; gap: 1rem; }
.seat-row .help-field { flex: 1; min-width: 0; }
@media (max-width: 560px) { .seat-row { flex-direction: column; align-items: stretch; gap: .5rem; } .seat-row .help-field { width: 100%; } .seat-row .help-field select { width: 100%; } .seat-row > button { align-self: flex-start; } }
.help-field { min-width: 0; margin-bottom: 1rem; }
@media (max-width: 800px) { .library-layout { grid-template-columns: 1fr; } .field-grid { grid-template-columns: 1fr; } }
</style>
