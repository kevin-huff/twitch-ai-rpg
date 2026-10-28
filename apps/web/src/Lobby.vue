<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue';
import type { Command, DirectorSnapshot, PlayerSnapshot } from '@rpg/contracts';
import CastSeats from './CastSeats.vue';
import FieldGenerator from './FieldGenerator.vue';
import PlayerCard from './PlayerCard.vue';
import ReadyStrip from './ReadyStrip.vue';
import SeatInvites from './SeatInvites.vue';
import StreamLinks from './StreamLinks.vue';
import { identityPath } from './identity';

const props = defineProps<{ snapshot: DirectorSnapshot | PlayerSnapshot; busy: boolean }>();
const emit = defineEmits<{ command: [command: Command] }>();
const castSaving = ref(false);
const helpPrefix = useId();
const helpId = (key: string) => `${helpPrefix}-help-${key}`;
const director = computed(() => props.snapshot.role === 'director' ? props.snapshot : null);
const player = computed(() => props.snapshot.role === 'player' ? props.snapshot : null);
const own = computed(() => player.value?.ownCharacter ?? null);
const setup = computed(() => props.snapshot.setup);
const editable = computed(() => Boolean(setup.value && !setup.value.started && props.snapshot.session.status === 'lobby'));
const seats = computed(() => (director.value?.characterDetails ?? []).map(character => ({ id: character.id, displayName: character.displayName, hasCard: character.approved && !character.draft })));
const boundariesText = ref('');
const boundaryBaseline = ref('');
const boundariesDirty = computed(() => boundariesText.value !== boundaryBaseline.value);
const boundariesChangedElsewhere = ref(false);
const sessionPath = (view: string) => identityPath(`/sessions/${encodeURIComponent(props.snapshot.session.id)}/${view}`);
watch(() => setup.value?.boundariesRevision, () => {
  const next = setup.value?.boundaries.join('\n') ?? '';
  if (!boundariesDirty.value || next === boundariesText.value) resetBoundaries();
  else boundariesChangedElsewhere.value = true;
}, { immediate: true });
function resetBoundaries() {
  boundariesText.value = setup.value?.boundaries.join('\n') ?? '';
  boundaryBaseline.value = boundariesText.value; boundariesChangedElsewhere.value = false;
}
function saveBoundaries() {
  if (boundariesChangedElsewhere.value) return;
  emit('command', { type: 'set_boundaries', commandId: crypto.randomUUID(), expectedStateRevision: props.snapshot.session.stateRevision, boundaries: boundariesText.value.split('\n').map(line => line.trim()).filter(Boolean) });
}
function start() {
  emit('command', { type: 'start_session', commandId: crypto.randomUUID(), expectedStateRevision: props.snapshot.session.stateRevision });
}
</script>

<template>
  <section class="panel lobby">
    <ReadyStrip v-if="director" :session-id="snapshot.session.id" :seats="seats" :show-start="editable" :busy="busy || castSaving" :links-key="snapshot.eventSeq" @start="start" />
    <h2>Cast &amp; lobby</h2>
    <div v-if="snapshot.session.brief" class="session-brief"><p>{{ snapshot.session.brief.premise }}</p><p class="muted">{{ snapshot.session.brief.genre }} · {{ snapshot.session.brief.tone }}</p><h3 v-if="snapshot.session.brief.objectives.length">Objectives</h3><ul><li v-for="objective in snapshot.session.brief.objectives" :key="objective">{{ objective }}</li></ul><h3 v-if="snapshot.session.brief.playerHooks.length">Connections to the story</h3><ul><li v-for="hook in snapshot.session.brief.playerHooks" :key="hook">{{ hook }}</li></ul></div>
    <template v-if="director">
      <CastSeats :snapshot="director" :busy="busy" :editable="editable" @command="emit('command', $event)" @saving="castSaving = $event" />
      <p class="notice">Testing on your own? Open each character in a new tab. Every tab keeps its own seat, and player invitations remain available for your cast.</p>
      <details v-if="setup && editable" class="lobby-section boundaries-section" data-testid="boundaries-section"><summary>What the AI won't write</summary>
        <p v-if="boundariesChangedElsewhere" class="notice">The saved list changed while you were editing. Your unsaved text is preserved. Copy any changes you want to keep, then review the latest list before saving.<button class="quiet" data-testid="load-boundaries" @click="resetBoundaries">Load latest saved list</button></p>
        <label>One per line<textarea :aria-describedby="helpId('boundaries')" v-model="boundariesText" data-testid="boundaries" rows="4" /></label>
        <p :id="helpId('boundaries')" class="field-help">One per line. The AI stays away from these when it writes. Players never see this list.</p>
        <FieldGenerator v-model="boundariesText" field="scenario.boundaries" :context-key="`${snapshot.session.id}:${setup.boundariesRevision}:${editable}`" :disabled="busy || boundariesChangedElsewhere" />
        <button :disabled="busy || !boundariesDirty || boundariesChangedElsewhere" class="secondary" data-testid="save-boundaries" @click="saveBoundaries">Save boundaries</button>
      </details>
      <StreamLinks :session-id="snapshot.session.id" :characters="snapshot.characters" />
      <SeatInvites :session-id="snapshot.session.id" :characters="snapshot.characters" />
    </template>
    <template v-else-if="player">
      <h3>The cast</h3>
      <ul class="cast-list" data-testid="lobby-cast"><li v-for="character in snapshot.characters" :key="character.id">{{ character.approved ? character.displayName : `${character.displayName} · waiting` }}</li></ul>
      <PlayerCard :snapshot="player" :busy="busy" @command="emit('command', $event)" />
      <StreamLinks v-if="own" mode="player" :session-id="snapshot.session.id" :characters="snapshot.characters" :own-character-id="own.id" />
    </template>
    <p class="muted">Keep your voice call open. Anyone can ask for a pause.</p>
    <a v-if="!setup || setup.started" class="button" data-testid="back-to-show" :href="sessionPath(director ? 'director' : 'play')">Back to the show</a>
    <p v-else class="muted">The director starts the show when every seat has a card.</p>
  </section>
</template>

<style scoped>
.lobby-section { border-top: 2px solid var(--night-raised); margin-top: 40px; padding-top: 28px; }
.session-brief { margin: 28px 0; }
.cast-list { list-style: none; margin: 0 0 20px; padding: 0; display: grid; gap: 8px; }
.boundaries-section > summary { cursor: pointer; }
.boundaries-section[open] > summary { margin-bottom: 20px; }
.lobby > .muted { margin-top: 28px; }
</style>
