<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue';
import { CharacterCardDefinitionSchema } from '@rpg/contracts';
import type { Character, CharacterCardDefinition, Command, DirectorSnapshot, PlayerSnapshot } from '@rpg/contracts';
import CharacterForm from './CharacterForm.vue';
import FieldGenerator from './FieldGenerator.vue';
import StreamLinks from './StreamLinks.vue';
import SeatInvites from './SeatInvites.vue';
import { identityPath } from './identity';

const props = defineProps<{ snapshot: DirectorSnapshot | PlayerSnapshot; busy: boolean }>();
const emit = defineEmits<{ command: [command: Command] }>();
const helpPrefix = useId();
const helpId = (key: string) => `${helpPrefix}-help-${key}`;
const director = computed(() => props.snapshot.role === 'director' ? props.snapshot : null);
const player = computed(() => props.snapshot.role === 'player' ? props.snapshot : null);
const own = computed(() => player.value?.ownCharacter ?? null);
const setup = computed(() => props.snapshot.setup);
const editable = computed(() => Boolean(setup.value && !setup.value.started && props.snapshot.session.status === 'lobby'));
const form = ref<CharacterCardDefinition | null>(null);
const formCharacterId = ref('');
const formRevision = ref(0);
const formBaseline = ref('');
const dirty = computed(() => Boolean(form.value && JSON.stringify(form.value) !== formBaseline.value));
const error = ref('');
const changedElsewhere = ref(false);
const acknowledged = ref(false);
const boundariesText = ref('');
const boundaryBaseline = ref('');
const boundariesDirty = computed(() => boundariesText.value !== boundaryBaseline.value);
const boundariesChangedElsewhere = ref(false);
const overrideReason = ref('');
const allApproved = computed(() => props.snapshot.characters.every(character => character.approved) && (director.value?.characterDetails.every(character => !character.draft) ?? true));
const allReady = computed(() => props.snapshot.characters.every(character => character.ready));
const isReady = computed(() => own.value?.ready && own.value.acceptedBoundariesRevision === setup.value?.boundariesRevision);
const canReady = computed(() => own.value?.approved && !own.value.draft && (setup.value?.started || !dirty.value));
const initials = (name: string) => name.split(' ').map(part => part[0]).slice(0, 2).join('').toUpperCase();
const sessionPath = (view: string) => identityPath(`/sessions/${encodeURIComponent(props.snapshot.session.id)}/${view}`);
const testSeatUrl = (characterId: string) => identityPath(`/sessions/${encodeURIComponent(props.snapshot.session.id)}/play?testCharacterId=${encodeURIComponent(characterId)}`);
function characterCard(character: Character): CharacterCardDefinition {
  if (character.draft) return JSON.parse(JSON.stringify(character.draft));
  return CharacterCardDefinitionSchema.parse({ schemaVersion: 1, displayName: character.displayName, pronouns: character.pronouns, appearance: character.appearance, personality: character.personality, backstory: character.backstory, traits: character.traits, specialty: character.specialty, flaw: character.flaw, possessions: character.possessions.slice(0, 3).filter(Boolean), connection: character.connection, secret: character.secret, extensions: {} });
}
function resetDraft() {
  if (!own.value) return;
  form.value = characterCard(own.value); formBaseline.value = JSON.stringify(form.value); formRevision.value = own.value.cardRevision;
  formCharacterId.value = own.value.id; changedElsewhere.value = false; error.value = '';
}
watch([() => own.value?.id, () => own.value?.cardRevision, () => setup.value?.scenario.templateId], () => {
  if (!own.value || !setup.value) { form.value = null; return; }
  const incoming = characterCard(own.value);
  if (!form.value || own.value.id !== formCharacterId.value || !dirty.value || JSON.stringify(incoming) === JSON.stringify(form.value)) resetDraft();
  else changedElsewhere.value = true;
}, { immediate: true });
watch([() => setup.value?.boundariesRevision, () => own.value?.cardRevision, () => own.value?.id], () => { acknowledged.value = false; });
watch(() => setup.value?.boundariesRevision, () => {
  const next = setup.value?.boundaries.join('\n') ?? '';
  if (!boundariesDirty.value || next === boundariesText.value) resetBoundaries();
  else boundariesChangedElsewhere.value = true;
}, { immediate: true });
function resetBoundaries() {
  boundariesText.value = setup.value?.boundaries.join('\n') ?? '';
  boundaryBaseline.value = boundariesText.value; boundariesChangedElsewhere.value = false;
}
function send(command: Command) { error.value = ''; emit('command', command); }
function saveCard() {
  if (!form.value || !editable.value) return;
  try {
    const card = CharacterCardDefinitionSchema.parse({ ...form.value, possessions: form.value.possessions.filter(value => value?.trim()) });
    send({ type: 'save_character', commandId: crypto.randomUUID(), expectedCharacterRevision: formRevision.value, card });
  } catch { error.value = 'Review the card fields and assign exactly +2, +1, +1, and +0 to the traits. Nothing has been submitted.'; }
}
function approve(character: Character) { send({ type: 'approve_character', commandId: crypto.randomUUID(), characterId: character.id, expectedCharacterRevision: character.cardRevision }); }
function ready() {
  if (!own.value || !setup.value || (!isReady.value && (!canReady.value || !acknowledged.value))) return;
  send({ type: 'set_ready', commandId: crypto.randomUUID(), expectedCharacterRevision: own.value.cardRevision, expectedBoundariesRevision: setup.value.boundariesRevision, ready: !isReady.value });
}
function saveBoundaries() {
  if (boundariesChangedElsewhere.value) return;
  send({ type: 'set_boundaries', commandId: crypto.randomUUID(), expectedStateRevision: props.snapshot.session.stateRevision, boundaries: boundariesText.value.split('\n').map(line => line.trim()).filter(Boolean) });
}
function start() {
  if (!allApproved.value || (!allReady.value && !overrideReason.value.trim())) return;
  send({ type: 'start_session', commandId: crypto.randomUUID(), expectedStateRevision: props.snapshot.session.stateRevision, ...(!allReady.value ? { overrideUnreadyReason: overrideReason.value.trim() } : {}) });
}
</script>

<template>
  <section class="panel lobby"><p class="eyebrow">The cast</p><h2>{{ setup ? 'Get ready for your story.' : 'Meet your accomplices.' }}</h2>
    <div v-if="snapshot.session.brief" class="session-brief"><p>{{ snapshot.session.brief.premise }}</p><p class="muted">{{ snapshot.session.brief.genre }} · {{ snapshot.session.brief.tone }}</p><h3 v-if="snapshot.session.brief.objectives.length">Objectives</h3><ul><li v-for="objective in snapshot.session.brief.objectives" :key="objective">{{ objective }}</li></ul><h3 v-if="snapshot.session.brief.playerHooks.length">Connections to the story</h3><ul><li v-for="hook in snapshot.session.brief.playerHooks" :key="hook">{{ hook }}</li></ul></div>
    <div class="cast"><div v-for="character in snapshot.characters" :key="character.id" class="cast-person"><span class="avatar">{{ initials(character.displayName) }}</span><div><strong>{{ character.displayName }}</strong><small>{{ character.approved ? 'Approved character' : 'Awaiting approval' }} · {{ setup ? character.ready ? 'Ready' : 'Not ready' : `Strain ${character.strain}/4` }}</small><p class="muted">{{ character.appearance }}</p><a v-if="director" :href="testSeatUrl(character.id)" target="_blank" rel="noopener">Test as {{ character.displayName }} ↗</a></div></div></div>
    <p v-if="director" class="notice">Testing on your own? Open each character in a new tab. Every tab keeps its own seat, and player invitations remain available for your cast.</p>
    <StreamLinks v-if="director" :session-id="snapshot.session.id" :characters="snapshot.characters" />
    <SeatInvites v-if="director" :session-id="snapshot.session.id" :characters="snapshot.characters" />
    <template v-if="setup">
      <section class="lobby-section"><h3>Content boundaries</h3><template v-if="director && editable"><p v-if="boundariesChangedElsewhere" class="notice">The saved boundaries changed while you were editing. Your unsaved text is preserved. Copy any changes you want to keep, then review the latest boundaries before saving.<button class="quiet" data-testid="load-boundaries" @click="resetBoundaries">Load latest saved boundaries</button></p><label>One boundary per line<textarea :aria-describedby="helpId('boundaries')" v-model="boundariesText" data-testid="boundaries" rows="4" /></label><p :id="helpId('boundaries')" class="field-help">Record the table’s agreed restrictions for players to review and the AI to follow. Saving a change clears everyone’s readiness; each player must accept the new version.</p><FieldGenerator v-model="boundariesText" field="scenario.boundaries" :context-key="`${snapshot.session.id}:${setup.boundariesRevision}:${editable}`" :disabled="busy || boundariesChangedElsewhere" /><button :disabled="busy || !boundariesDirty || boundariesChangedElsewhere" class="secondary" data-testid="save-boundaries" @click="saveBoundaries">Save boundaries</button></template><template v-else><ul v-if="setup.boundaries.length"><li v-for="boundary in setup.boundaries" :key="boundary">{{ boundary }}</li></ul><p v-else class="muted">No additional boundaries have been recorded. Check in with the table before starting.</p></template></section>
      <section v-if="player && own" class="lobby-section"><h3>Your character card</h3><template v-if="editable && form"><p class="muted">Your draft and private secret are visible to you and the director. Only approved public details are shown to the rest of the cast.</p><p v-if="changedElsewhere" class="notice">This card changed while you were editing. Your unsaved words are preserved. Review the latest saved card before replacing it.<button class="quiet" @click="resetDraft">Load latest saved card</button></p><CharacterForm v-model="form" :disabled="busy" /><p v-if="error" role="alert" class="notice error">{{ error }}</p><button :disabled="busy" data-testid="save-character-draft" @click="saveCard">Submit card for approval</button><small v-if="dirty">Unsaved card changes · not submitted automatically</small></template><template v-else><h3>{{ own.displayName }}</h3><p>{{ own.appearance }}</p><p class="private-note">{{ own.secret }}</p><p class="muted">Character cards are fixed once the session starts.</p></template>
        <div v-if="snapshot.session.status !== 'ended'" class="ready-box"><p>{{ own.approved && !own.draft ? 'Your card is approved.' : 'The director must approve your latest card before you can mark ready.' }}</p><label v-if="!isReady" class="check"><input :aria-describedby="helpId('accept')" v-model="acknowledged" data-testid="accept-boundaries" type="checkbox" :disabled="busy || !canReady">I reviewed my approved card and accept the current content boundaries.</label><p v-if="!isReady" :id="helpId('accept')" class="field-help">Confirms you accept this approved card and boundary version before marking ready. Card or boundary changes require a fresh review.</p><button data-testid="ready-character" :disabled="busy || (!isReady && (!canReady || !acknowledged))" @click="ready">{{ isReady ? 'Withdraw readiness' : 'Mark ready' }}</button><p v-if="isReady" class="notice">You are ready for this version of the boundaries.</p></div>
      </section>
      <section v-if="director" class="lobby-section"><h3>Review the cast</h3><article v-for="character in director.characterDetails" :key="character.id" class="card-review"><h3>{{ character.draft?.displayName ?? character.displayName }}</h3><small>Card revision {{ character.cardRevision }} · {{ character.draft ? 'Draft awaiting approval' : character.approved ? 'Approved' : 'Awaiting approval' }}</small><dl><template v-for="field in (['pronouns', 'appearance', 'personality', 'backstory', 'specialty', 'flaw', 'connection', 'secret'] as const)" :key="field"><dt>{{ field === 'secret' ? 'Private secret' : field }}</dt><dd>{{ (character.draft ?? character)[field] || '—' }}</dd></template><dt>Traits</dt><dd><span v-for="(value, trait) in (character.draft ?? character).traits" :key="trait">{{ trait }} +{{ value }} &nbsp;</span></dd><dt>Possessions</dt><dd>{{ (character.draft ?? character).possessions.join(', ') }}</dd></dl><button v-if="editable && (!character.approved || character.draft)" :disabled="busy" :data-testid="`approve-character-${character.id}`" @click="approve(character)">Approve {{ character.draft?.displayName ?? character.displayName }}</button></article>
        <div v-if="editable" class="start-box"><p v-if="!allApproved" class="notice">Approve every character card before starting.</p><label v-if="!allReady">Reason to start with missing players<textarea :aria-describedby="helpId('override')" v-model="overrideReason" data-testid="override-unready" rows="2" placeholder="Optional: explain why the show can start while a seat is not ready." /></label><p v-if="!allReady" :id="helpId('override')" class="field-help">A private record of why you are starting before everyone is ready. Every card must still be approved.</p><p class="muted">Unready players must still accept the current boundaries before submitting in-character dialogue or actions.</p><button data-testid="start-session" :disabled="busy || !allApproved || boundariesDirty || (!allReady && !overrideReason.trim())" @click="start">Start session</button></div><p v-else class="notice">The session has started. Late arrivals can review their approved card and accept the current boundaries here.</p>
      </section>
    </template>
    <StreamLinks v-if="player && own" mode="player" :session-id="snapshot.session.id" :characters="snapshot.characters" :own-character-id="own.id" />
    <p class="muted">Keep your voice call open. Anyone can ask for a pause.</p>
    <a v-if="!setup || setup.started" class="button" :href="sessionPath(director ? 'director' : 'play')">Enter the scene</a>
    <p v-else class="muted">The director starts the session after the cast is approved and ready.</p>
  </section>
</template>

<style scoped>
.lobby-section { border-top: 1px solid var(--line); margin-top: 2rem; padding-top: 1.5rem; }
.session-brief { margin: 1.5rem 0; }
.card-review { padding: 1.25rem 0; border-bottom: 1px solid var(--line); }
.card-review dl { display: grid; grid-template-columns: minmax(100px, 1fr) minmax(0, 4fr); gap: .4rem 1rem; }
.card-review dt { color: var(--muted); text-transform: capitalize; }
.card-review dd { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.ready-box, .start-box { margin: 1.5rem 0; }
.lobby > .muted { margin-top: 1.5rem; }
</style>
