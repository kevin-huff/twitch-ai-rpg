<script setup lang="ts">
import { computed, ref, useId } from 'vue';
import { CommandSchema, LiveNpcProfileSchema } from '@rpg/contracts';
import type { Command, DirectorSnapshot, LiveNpcProfile } from '@rpg/contracts';
import FieldGenerator from './FieldGenerator.vue';
import { npcFieldContext } from './field-context';

const helpPrefix = useId();
const helpId = (...parts: (string | number)[]) => `${helpPrefix}-help-${encodeURIComponent(JSON.stringify(parts))}`;

const props = defineProps<{ snapshot: DirectorSnapshot; busy: boolean }>();
const emit = defineEmits<{ command: [command: Command, onSaved: () => void] }>();
type Operation = 'scene' | 'npc' | 'reveal';
const operation = ref<Operation | null>(null);
const revision = ref(0);
const draftEpoch = ref(0);
const reason = ref('');
const acknowledged = ref(false);
const error = ref('');
const savedNotice = ref('');
const scene = ref({ title: '', description: '', locationKind: 'existing', locationId: '', locationTitle: '', locationDescription: '', presentNpcIds: [] as string[] });
const npcId = ref('');
const npcVersion = ref(0);
const profile = ref<LiveNpcProfile | null>(null);
const revealNpcId = ref('');
const revealVersion = ref(0);
const revealSource = ref('');
const publicText = ref('');
const witnessNpcIds = ref<string[]>([]);
const locations = computed(() => props.snapshot.locations?.length ? props.snapshot.locations : [{ id: props.snapshot.session.scene.locationId, title: props.snapshot.session.scene.title, description: '' }]);
const voiceProfiles = computed(() => [...new Set(['voice_narrator', ...props.snapshot.npcDetails.map(npc => npc.voiceProfileId)])]);
const chosenNpc = computed(() => props.snapshot.npcDetails.find(npc => npc.id === npcId.value));
const characterContext = computed(() => profile.value ? npcFieldContext(profile.value, chosenNpc.value) : undefined);
const revealNpc = computed(() => props.snapshot.npcDetails.find(npc => npc.id === revealNpcId.value));
const witnesses = computed(() => props.snapshot.npcDetails.filter(npc => npc.status === 'present' && npc.locationId === props.snapshot.session.scene.locationId));
const gate = computed(() => {
  if (props.snapshot.setup && !props.snapshot.setup.started) return 'Start the session from Cast & lobby before making live changes.';
  if (!['live', 'paused'].includes(props.snapshot.session.status)) return 'Live changes are available only while the session is live or paused.';
  if (props.snapshot.activeBeat) return 'Finish or abandon the current beat before making live changes.';
  return '';
});
const stale = computed(() => operation.value !== null && (revision.value !== props.snapshot.session.stateRevision || (operation.value === 'npc' && Boolean(npcId.value) && chosenNpc.value?.version !== npcVersion.value) || (operation.value === 'reveal' && Boolean(revealNpcId.value) && revealNpc.value?.version !== revealVersion.value)));
const locked = computed(() => props.busy || Boolean(gate.value));
const canSave = computed(() => !locked.value && !stale.value && acknowledged.value && Boolean(reason.value.trim()) && reason.value.length <= 1000);
const listFields = [{ key: 'aliases', field: 'npc.alias', label: 'Private aliases', max: 80 }, { key: 'personality', field: 'npc.personalityItem', label: 'Personality', max: 500 }, { key: 'limits', field: 'npc.limit', label: 'Limits', max: 500 }, { key: 'dialogueExamples', field: 'npc.dialogueExample', label: 'Dialogue examples', max: 1000 }, { key: 'secrets', field: 'npc.secret', label: 'Private secrets and reveal conditions', max: 2000 }] as const;
const listHelp = {"aliases": "Private alternate names for reference; these are not automatically included in AI dialogue prompts.", "personality": "Private personality guidance included in AI dialogue prompts.", "limits": "Private boundaries included as guidance in AI dialogue prompts; these are not automatic enforcement rules.", "dialogueExamples": "Private examples of this character’s speech, included in AI dialogue prompts.", "secrets": "Private secret and reveal-condition notes for reference and later reveals; conditions do not trigger automatic reveals or enter AI dialogue prompts."};
const generationContext = computed(() => JSON.stringify([props.snapshot.session.id, props.snapshot.session.stateRevision, draftEpoch.value, operation.value, npcId.value, chosenNpc.value?.version, revealNpcId.value, revealNpc.value?.version, revealSource.value, scene.value.locationKind, scene.value.locationId]));

function capture() { draftEpoch.value++; revision.value = props.snapshot.session.stateRevision; reason.value = ''; acknowledged.value = false; error.value = ''; savedNotice.value = ''; }
function addEntry(key: typeof listFields[number]['key']) {
  if (locked.value || !profile.value || profile.value[key].length >= 10) return;
  draftEpoch.value++; profile.value[key].push('');
}
function removeEntry(key: typeof listFields[number]['key'], index: number) {
  if (locked.value || !profile.value) return;
  draftEpoch.value++; profile.value[key].splice(index, 1);
}
function loadNpc() {
  if (locked.value) return;
  capture();
  const npc = chosenNpc.value;
  npcVersion.value = npc?.version ?? 0;
  if (npc) {
    const { id, version, knowledge, relationships, ...fields } = npc;
    profile.value = JSON.parse(JSON.stringify(fields));
  } else profile.value = LiveNpcProfileSchema.parse({ displayName: 'New character', role: '', locationId: props.snapshot.session.scene.locationId, status: 'present', voiceProfileId: 'voice_narrator' });
}
function loadReveal() {
  if (locked.value) return;
  capture(); revealVersion.value = revealNpc.value?.version ?? 0; revealSource.value = ''; publicText.value = ''; witnessNpcIds.value = [];
}
function begin(next: Operation) {
  if (locked.value) return;
  operation.value = next; capture();
  if (next === 'scene') scene.value = { title: props.snapshot.session.scene.title, description: props.snapshot.session.scene.description, locationKind: 'existing', locationId: props.snapshot.session.scene.locationId, locationTitle: '', locationDescription: '', presentNpcIds: witnesses.value.map(npc => npc.id) };
  if (next === 'npc') { npcId.value = ''; loadNpc(); }
  if (next === 'reveal') { revealNpcId.value = ''; loadReveal(); }
}
function reload() {
  if (locked.value || !operation.value) return;
  if (operation.value === 'npc') loadNpc(); else if (operation.value === 'reveal') loadReveal(); else begin('scene');
}
function save() {
  if (!canSave.value) return;
  const common = { commandId: crypto.randomUUID(), expectedStateRevision: revision.value, reason: reason.value, discardQueuedInput: true };
  let candidate: unknown;
  if (operation.value === 'scene') candidate = { ...common, type: 'change_scene', title: scene.value.title, description: scene.value.description, location: scene.value.locationKind === 'new' ? { kind: 'new', title: scene.value.locationTitle, description: scene.value.locationDescription } : { kind: 'existing', locationId: scene.value.locationId }, presentNpcIds: scene.value.presentNpcIds };
  if (operation.value === 'npc' && profile.value) candidate = { ...common, type: 'save_npc', ...(npcId.value ? { npcId: npcId.value } : {}), expectedNpcVersion: npcVersion.value, profile: { ...profile.value, hiddenIdentity: profile.value.hiddenIdentity || null, communicationChannel: profile.value.communicationChannel || null } };
  if (operation.value === 'reveal') {
    if (!revealSource.value) { error.value = 'Choose the private source for this reveal.'; return; }
    candidate = { ...common, type: 'reveal_npc', npcId: revealNpcId.value, expectedNpcVersion: revealVersion.value, source: revealSource.value === 'identity' ? { kind: 'identity' } : { kind: 'secret', index: Number(revealSource.value.split(':')[1]) }, publicText: publicText.value, witnessNpcIds: witnessNpcIds.value };
  }
  const parsed = CommandSchema.safeParse(candidate);
  if (!parsed.success) { error.value = 'Review the required fields and their length limits before saving.'; return; }
  error.value = '';
  const savedOperation = operation.value;
  emit('command', parsed.data, () => {
    operation.value = null; acknowledged.value = false;
    savedNotice.value = savedOperation === 'scene' ? 'Scene changed.' : savedOperation === 'npc' ? 'Character saved.' : 'Reveal published to the party and stage.';
  });
}
</script>

<template>
  <details class="panel live-controls" data-testid="live-controls">
    <summary>Scene, characters & reveals</summary>
    <p class="muted">Make a live change between beats. Public details appear to the party and on the stage; private notes stay with the director.</p>
    <p v-if="savedNotice" class="notice" role="status">{{ savedNotice }}</p>
    <p v-if="gate" class="notice">{{ gate }}</p>
    <div class="actions"><button v-for="item in (['scene', 'npc', 'reveal'] as const)" :key="item" type="button" class="secondary" :data-testid="`begin-${item}`" :disabled="locked" :aria-pressed="operation === item" @click="begin(item)">{{ item === 'scene' ? 'Change scene' : item === 'npc' ? 'Create or edit character' : 'Reveal a secret' }}</button></div>
    <form v-if="operation" @submit.prevent="save">
      <p v-if="stale" class="notice">The table changed while you were editing. Your unsaved words are preserved. Copy anything you want to keep before loading the latest saved details.<button type="button" class="quiet" data-testid="reload-live" :disabled="locked" @click="reload">Load latest saved details</button></p>
      <fieldset :disabled="locked">
        <template v-if="operation === 'scene'">
          <h3>Change the scene</h3>
          <div class="generated-field"><label><span class="field-label">Public scene title</span><input v-model="scene.title" data-testid="scene-title" :aria-describedby="helpId('scene-title')" required maxlength="160"></label><p class="field-help" :id="helpId('scene-title')">Names the scene shown to the party and stage after saving.</p><FieldGenerator class="field-ai" :premise="snapshot.session.brief?.premise" :premise-label="`Session scenario: ${snapshot.session.title}`" field="scene.title" v-model="scene.title" :context-key="generationContext" :disabled="locked || stale" /></div>
          <div class="generated-field"><label><span class="field-label">Public scene description</span><textarea v-model="scene.description" data-testid="scene-description" :aria-describedby="helpId('scene-description')" maxlength="6000" rows="4" /></label><p class="field-help" :id="helpId('scene-description')">Describes the current scene publicly to the party and stage.</p><FieldGenerator class="field-ai" :premise="snapshot.session.brief?.premise" :premise-label="`Session scenario: ${snapshot.session.title}`" field="scene.description" v-model="scene.description" :context-key="generationContext" :disabled="locked || stale" /></div>
          <label>Destination<select v-model="scene.locationKind" data-testid="scene-location-kind" :aria-describedby="helpId('scene-location-kind')"><option value="existing">Existing location</option><option value="new">New location</option></select></label><p class="field-help" :id="helpId('scene-location-kind')">Choose a saved location or add a new location for this scene.</p>
          <div v-if="scene.locationKind === 'existing'"><label>Location<select v-model="scene.locationId" data-testid="scene-location" :aria-describedby="helpId('scene-location')"><option v-for="location in locations" :key="location.id" :value="location.id">{{ location.title }}</option></select></label><p class="field-help" :id="helpId('scene-location')">Sets the destination for this scene and its selected characters.</p></div>
          <template v-else><div class="generated-field"><label><span class="field-label">Location name</span><input v-model="scene.locationTitle" data-testid="location-title" :aria-describedby="helpId('location-title')" required maxlength="160"></label><p class="field-help" :id="helpId('location-title')">Names the new location added to the location catalog.</p><FieldGenerator class="field-ai" :premise="snapshot.session.brief?.premise" :premise-label="`Session scenario: ${snapshot.session.title}`" field="location.title" v-model="scene.locationTitle" :context-key="generationContext" :disabled="locked || stale" /></div><div class="generated-field"><label><span class="field-label">Private location notes</span><textarea v-model="scene.locationDescription" data-testid="location-description" :aria-describedby="helpId('location-description')" maxlength="4000" rows="3" /></label><p class="field-help" :id="helpId('location-description')">Private catalog notes for the director; these do not become the public scene description.</p><FieldGenerator class="field-ai" :premise="snapshot.session.brief?.premise" :premise-label="`Session scenario: ${snapshot.session.title}`" field="location.description" v-model="scene.locationDescription" :context-key="generationContext" :disabled="locked || stale" /></div></template>
          <h4>Characters present in the new scene</h4><div v-for="npc in snapshot.npcDetails" :key="npc.id"><label class="check"><input v-model="scene.presentNpcIds" type="checkbox" :aria-describedby="helpId('present', npc.id)" :value="npc.id" :data-testid="`present-${npc.id}`">{{ npc.displayName }}</label><p class="field-help" :id="helpId('present', npc.id)">Moves this character to the new scene when selected; unselected characters go offstage.</p></div><p class="muted">Selected characters move here. Everyone else goes offstage.</p>
        </template>
        <template v-else-if="operation === 'npc' && profile">
          <h3>Create or edit a non-player character</h3>
          <label>Character<select v-model="npcId" data-testid="npc-choice" :aria-describedby="helpId('npc-choice')" :disabled="locked" @change="loadNpc"><option value="">Create a new character</option><option v-for="npc in snapshot.npcDetails" :key="npc.id" :value="npc.id">{{ npc.displayName }}</option></select></label><p class="field-help" :id="helpId('npc-choice')">Create a character or load a saved character to edit.</p>
          <p class="notice">Name, role, appearance, presence and voice profile are public, even when the character is offstage. Keep unrevealed details in the private fields.</p>
          <div class="generated-field"><label><span class="field-label">Public name</span><input v-model="profile.displayName" data-testid="npc-name" :aria-describedby="helpId('npc-name')" required maxlength="80"></label><p class="field-help" :id="helpId('npc-name')">The name shown to the party and stage, even while this character is offstage.</p><FieldGenerator :character-context="characterContext" class="field-ai" :premise="snapshot.session.brief?.premise" :premise-label="`Session scenario: ${snapshot.session.title}`" field="npc.displayName" v-model="profile.displayName" :context-key="generationContext" :disabled="locked || stale" /></div>
          <div class="generated-field"><label><span class="field-label">Public role</span><input v-model="profile.role" data-testid="npc-role" :aria-describedby="helpId('npc-role')" maxlength="160"></label><p class="field-help" :id="helpId('npc-role')">The public role shown to the party and stage, even while offstage.</p><FieldGenerator :character-context="characterContext" class="field-ai" :premise="snapshot.session.brief?.premise" :premise-label="`Session scenario: ${snapshot.session.title}`" field="npc.role" v-model="profile.role" :context-key="generationContext" :disabled="locked || stale" /></div>
          <div class="generated-field"><label><span class="field-label">Public appearance</span><textarea v-model="profile.appearance" data-testid="npc-appearance" :aria-describedby="helpId('npc-appearance')" maxlength="1000" rows="3" /></label><p class="field-help" :id="helpId('npc-appearance')">Visible details shown to the party and stage, even while offstage.</p><FieldGenerator :character-context="characterContext" class="field-ai" :premise="snapshot.session.brief?.premise" :premise-label="`Session scenario: ${snapshot.session.title}`" field="npc.appearance" v-model="profile.appearance" :context-key="generationContext" :disabled="locked || stale" /></div>
          <label>Presence<select v-model="profile.status" data-testid="npc-status" :aria-describedby="helpId('npc-status')"><option value="present">Present</option><option value="offstage">Offstage</option></select></label><p class="field-help" :id="helpId('npc-status')">Marks the character present or offstage. Presence is public; present characters must be in the current scene.</p>
          <label>Location<select v-model="profile.locationId" data-testid="npc-location" :aria-describedby="helpId('npc-location')"><option v-for="location in locations" :key="location.id" :value="location.id">{{ location.title }}</option></select></label><p class="field-help" :id="helpId('npc-location')">Sets the character’s location. Present characters must use the current scene’s location.</p><p v-if="profile.status === 'present' && profile.locationId !== snapshot.session.scene.locationId" class="notice">A present character must be in the current scene. Choose the current location or mark them offstage.</p>
          <label>Logical voice profile<select v-model="profile.voiceProfileId" data-testid="npc-voice" :aria-describedby="helpId('npc-voice')"><option v-for="voice in voiceProfiles" :key="voice" :value="voice">{{ voice === 'voice_narrator' ? 'Narrator voice' : snapshot.npcDetails.find(npc => npc.voiceProfileId === voice)?.displayName + ' voice' }}</option></select></label><p class="field-help" :id="helpId('npc-voice')">Selects a public logical voice profile mapped to a server-configured voice, with the default voice as fallback.</p>
          <details><summary>Private characterization & secrets</summary>
            <div class="generated-field"><label><span class="field-label">Hidden identity</span><input v-model="profile.hiddenIdentity" data-testid="npc-identity" :aria-describedby="helpId('npc-identity')" maxlength="160"></label><p class="field-help" :id="helpId('npc-identity')">Private identity kept for reference and a later reveal; it is not automatically included in AI dialogue prompts.</p><FieldGenerator :character-context="characterContext" class="field-ai" :premise="snapshot.session.brief?.premise" :premise-label="`Session scenario: ${snapshot.session.title}`" field="npc.hiddenIdentity" :model-value="profile.hiddenIdentity ?? ''" @update:model-value="profile.hiddenIdentity = $event" :context-key="generationContext" :disabled="locked || stale" /></div>
            <div class="generated-field"><label><span class="field-label">Motivation</span><textarea v-model="profile.motivation" data-testid="npc-motivation" :aria-describedby="helpId('npc-motivation')" maxlength="1000" /></label><p class="field-help" :id="helpId('npc-motivation')">Private reference for what drives this character; it is not automatically included in AI dialogue prompts.</p><FieldGenerator :character-context="characterContext" class="field-ai" :premise="snapshot.session.brief?.premise" :premise-label="`Session scenario: ${snapshot.session.title}`" field="npc.motivation" v-model="profile.motivation" :context-key="generationContext" :disabled="locked || stale" /></div>
            <div class="generated-field"><label><span class="field-label">Current goal</span><textarea v-model="profile.goal" data-testid="npc-goal" :aria-describedby="helpId('npc-goal')" maxlength="1000" /></label><p class="field-help" :id="helpId('npc-goal')">Private reference for what this character wants now; it is not automatically included in AI dialogue prompts.</p><FieldGenerator :character-context="characterContext" class="field-ai" :premise="snapshot.session.brief?.premise" :premise-label="`Session scenario: ${snapshot.session.title}`" field="npc.goal" v-model="profile.goal" :context-key="generationContext" :disabled="locked || stale" /></div>
            <div class="generated-field"><label><span class="field-label">Mood</span><input v-model="profile.mood" data-testid="npc-mood" :aria-describedby="helpId('npc-mood')" maxlength="160"></label><p class="field-help" :id="helpId('npc-mood')">Private mood guidance included in AI dialogue prompts.</p><FieldGenerator :character-context="characterContext" class="field-ai" :premise="snapshot.session.brief?.premise" :premise-label="`Session scenario: ${snapshot.session.title}`" field="npc.mood" v-model="profile.mood" :context-key="generationContext" :disabled="locked || stale" /></div>
            <div class="generated-field"><label><span class="field-label">Communication channel</span><input v-model="profile.communicationChannel" data-testid="npc-channel" :aria-describedby="helpId('npc-channel')" maxlength="160"></label><p class="field-help" :id="helpId('npc-channel')">Private guidance included in AI dialogue prompts; a channel can allow remote dialogue but does not connect an external service.</p><FieldGenerator :character-context="characterContext" class="field-ai" :premise="snapshot.session.brief?.premise" :premise-label="`Session scenario: ${snapshot.session.title}`" field="npc.communicationChannel" :model-value="profile.communicationChannel ?? ''" @update:model-value="profile.communicationChannel = $event" :context-key="generationContext" :disabled="locked || stale" /></div>
            <section v-for="field in listFields" :key="field.key" class="list-field"><h4>{{ field.label }}</h4><div v-for="(_, index) in profile[field.key]" :key="index"><div class="generated-field"><label><span class="field-label">{{ field.label }} {{ index + 1 }}</span><textarea v-model="profile[field.key][index]" :data-testid="`npc-${field.key}-${index}`" :aria-describedby="helpId('list', field.key, index)" :maxlength="field.max" rows="3" /></label><p class="field-help" :id="helpId('list', field.key, index)">{{ listHelp[field.key] }}</p><FieldGenerator class="field-ai" :premise="snapshot.session.brief?.premise" :premise-label="`Session scenario: ${snapshot.session.title}`" :character-context="characterContext" :field="field.field" v-model="profile[field.key][index]" :context-key="`${generationContext}:${field.key}:${index}`" :disabled="locked || stale" /></div><button type="button" class="quiet" @click="removeEntry(field.key, index)">Remove entry {{ index + 1 }}</button></div><button type="button" class="secondary" :data-testid="`add-npc-${field.key}`" :disabled="profile[field.key].length >= 10" @click="addEntry(field.key)">Add {{ field.label.toLowerCase() }}</button></section>
          </details>
          <details v-if="chosenNpc"><summary>Recorded knowledge & relationships · preserved</summary><p class="muted">These records stay unchanged when you save this profile.</p><p v-for="memory in chosenNpc.knowledge" :key="memory.id" class="private-note">{{ memory.category }}: {{ memory.statement }}</p><p v-for="(relationship, index) in chosenNpc.relationships" :key="index" class="private-note">{{ relationship.stance }}: {{ relationship.reason }}</p></details>
        </template>
        <template v-else-if="operation === 'reveal'">
          <h3>Reveal a secret or identity</h3>
          <label>Character<select v-model="revealNpcId" data-testid="reveal-npc" :aria-describedby="helpId('reveal-npc')" @change="loadReveal"><option value="" disabled>Choose a character</option><option v-for="npc in snapshot.npcDetails" :key="npc.id" :value="npc.id">{{ npc.displayName }}</option></select></label><p class="field-help" :id="helpId('reveal-npc')">Chooses the character whose private identity or secret you want to reveal.</p>
          <label>Private source<select v-model="revealSource" data-testid="reveal-source" :aria-describedby="helpId('reveal-source')"><option value="" disabled>Choose a source</option><option v-if="revealNpc?.hiddenIdentity" value="identity">Hidden identity</option><option v-for="(_, index) in revealNpc?.secrets ?? []" :key="index" :value="`secret:${index}`">Secret {{ index + 1 }}</option></select></label><p class="field-help" :id="helpId('reveal-source')">Selects a private identity or secret as the source. Its raw text stays private.</p>
          <p v-if="revealSource" class="private-note">Private source: {{ revealSource === 'identity' ? revealNpc?.hiddenIdentity : revealNpc?.secrets[Number(revealSource.split(':')[1])] }}</p>
          <p class="notice">Your public wording is visible to the party and stage immediately. Write only what they learn; private conditions are never copied. Revealing an identity does not rename the character.</p>
          <div class="generated-field"><label><span class="field-label">Public wording</span><textarea v-model="publicText" data-testid="reveal-text" :aria-describedby="helpId('reveal-text')" required maxlength="6000" rows="4" /></label><p class="field-help" :id="helpId('reveal-text')">Only this wording is published to the party and stage when saved. An identity reveal does not rename the character.</p><FieldGenerator class="field-ai" :premise="snapshot.session.brief?.premise" :premise-label="`Session scenario: ${snapshot.session.title}`" field="live.publicReveal" v-model="publicText" :context-key="generationContext" :disabled="locked || stale" /></div>
          <h4>Non-player witnesses</h4><p class="muted">Only characters present in this location can witness this reveal.</p><div v-for="npc in witnesses" :key="npc.id"><label class="check"><input v-model="witnessNpcIds" type="checkbox" :aria-describedby="helpId('witness', npc.id)" :value="npc.id" :data-testid="`witness-${npc.id}`">{{ npc.displayName }}</label><p class="field-help" :id="helpId('witness', npc.id)">Gives this present character a memory of the public wording when selected.</p></div>
        </template>
        <label>Private reason for this change<textarea v-model="reason" data-testid="live-reason" :aria-describedby="helpId('live-reason')" required maxlength="1000" rows="2" /></label><p class="field-help" :id="helpId('live-reason')">Private audit note explaining why you made this change.</p>
        <label class="check notice"><input v-model="acknowledged" data-testid="discard-input" :aria-describedby="helpId('discard-input')" type="checkbox">I understand this cancels all queued or selected in-character dialogue and actions. Players must submit them again for the changed situation. Out-of-character questions stay.</label><p class="field-help" :id="helpId('discard-input')">Confirms cancellation of queued or selected in-character dialogue and actions. Out-of-character questions stay.</p>
        <p v-if="error" role="alert" class="notice error">{{ error }}</p>
        <button data-testid="save-live" :disabled="!canSave">{{ busy ? 'Saving…' : operation === 'scene' ? 'Change scene' : operation === 'npc' ? 'Save character' : 'Publish reveal' }}</button>
      </fieldset>
    </form>
  </details>
</template>

<style scoped>
.live-controls > summary { font-weight: 600; }
.live-controls > p, form { margin-top: 1rem; }
fieldset { min-width: 0; margin: 0; padding: 0; border: 0; }
fieldset > label, details > label { margin-block: 1rem; }
.list-field { margin: 1rem 0; }
.private-note { white-space: pre-wrap; overflow-wrap: anywhere; }
.generated-field { position: relative; min-width: 0; margin-block: 1rem; }
.field-label { padding-right: 8rem; min-height: 28px; }
.field-ai { position: absolute; top: 0; right: 0; }
</style>
