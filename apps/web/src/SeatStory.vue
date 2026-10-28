<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue';
import { isPlayerSegmentKind } from '@rpg/contracts';
import type { PublicCharacter, PublishedBeat, ScriptSegment } from '@rpg/contracts';
import { bandLabel } from './stage-format';
import { createBeatAudio } from './beat-audio';

const props = defineProps<{ history: PublishedBeat[]; characters: PublicCharacter[]; sessionId?: string }>();
const open = ref(false);
const scroller = ref<HTMLElement | null>(null);

const beats = computed(() => open.value ? props.history : props.history.slice(-1));
const rollName = (id: string) => props.characters.find(character => character.id === id)?.displayName ?? 'Someone';
const playerLines = (beat: PublishedBeat) => beat.segments.filter(segment => isPlayerSegmentKind(segment.kind));
const otherLines = (beat: PublishedBeat) => beat.segments.filter(segment => !isPlayerSegmentKind(segment.kind));
const showsName = (segment: ScriptSegment) => segment.kind !== 'narration' && segment.kind !== 'system';
const nameOf = (segment: ScriptSegment) => segment.speaker?.displayName ?? 'Someone';

async function toBottom() {
  await nextTick();
  if (scroller.value) scroller.value.scrollTop = scroller.value.scrollHeight;
}
async function toTop() {
  await nextTick();
  if (scroller.value) scroller.value.scrollTop = 0;
}
watch(open, value => { void (value ? toBottom() : toTop()); });
watch(() => props.history.length, () => { if (open.value) void toBottom(); });
watch(() => props.history[props.history.length - 1]?.id, () => { if (!open.value) void toTop(); });

// Each part plays on this device alone, from the start, whenever the player presses Play.
const sound = props.sessionId ? createBeatAudio(props.sessionId) : null;
const latestVoiced = computed(() => { const latest = props.history[props.history.length - 1]; return latest && !latest.textOnly ? latest.id : null; });
watch(latestVoiced, id => { if (sound && id) sound.prefetch(id); }, { immediate: true });
onUnmounted(() => sound?.dispose());
function toggleSound(beat: PublishedBeat) {
  if (!sound) return;
  if (sound.state.beatId === beat.id) sound.stop();
  else void sound.play(beat.id);
}
</script>

<template>
  <section class="panel seat-story" data-testid="seat-story">
    <h2>The story</h2>
    <p v-if="!history.length" class="seat-story-empty" data-testid="seat-story-empty">The story starts when the director publishes the first beat.</p>
    <template v-else>
      <div ref="scroller" class="seat-story-scroll" data-testid="seat-story-scroll" tabindex="0" aria-label="The story">
        <article v-for="beat in beats" :key="beat.id" class="seat-story-beat" data-testid="seat-story-beat">
          <p v-if="open" class="seat-story-label">Beat {{ beat.beatNumber }}</p>
          <div v-if="sound && !beat.textOnly" class="seat-story-sound">
            <button type="button" class="secondary" data-testid="seat-story-play" :aria-label="`${sound.state.beatId === beat.id ? 'Stop' : 'Play'} beat ${beat.beatNumber}`" :disabled="sound.state.loading === beat.id" @click="toggleSound(beat)">{{ sound.state.beatId === beat.id ? 'Stop' : sound.state.loading === beat.id ? 'Loading…' : 'Play' }}</button>
            <span v-if="sound.state.errorBeatId === beat.id" class="seat-story-sound-note" role="status">{{ sound.state.error }}</span>
          </div>
          <p v-for="segment in playerLines(beat)" :key="segment.id" class="seat-story-line" :class="segment.kind" data-testid="seat-story-line"><span class="seat-story-name">{{ nameOf(segment) }}{{ ' ' }}</span><span v-if="segment.kind === 'player_action'" class="seat-story-tag">Action{{ ' ' }}</span><span class="seat-story-words">{{ segment.text }}</span></p>
          <p v-for="roll in beat.rolls" :key="roll.id" class="seat-story-roll" data-testid="seat-story-roll">{{ rollName(roll.actorCharacterId) }} rolled {{ roll.total }}: {{ bandLabel(roll.band) }}</p>
          <p v-for="segment in otherLines(beat)" :key="segment.id" class="seat-story-line" :class="segment.kind" data-testid="seat-story-line"><span v-if="showsName(segment)" class="seat-story-name">{{ nameOf(segment) }}{{ ' ' }}</span><span class="seat-story-words">{{ segment.text }}</span></p>
        </article>
      </div>
      <button type="button" class="secondary" data-testid="whole-story-toggle" :aria-expanded="open" @click="open = !open">{{ open ? 'Hide the whole story' : 'Show the whole story' }}</button>
    </template>
  </section>
</template>

<style scoped>
.seat-story h2 { font-family: var(--font-label); font-size: 16px; line-height: 20px; text-transform: uppercase; color: var(--candle); margin-bottom: 12px; }
.seat-story-empty { color: var(--dust); margin: 0; }
.seat-story-scroll { max-height: 320px; overflow-y: auto; overscroll-behavior: contain; margin-bottom: 16px; padding: 12px 12px 4px; background: var(--night-raised); box-shadow: var(--frame-slot); clip-path: var(--cut-1); }
.seat-story-beat + .seat-story-beat { margin-top: 20px; }
.seat-story-beat p { margin: 0 0 8px; font-family: var(--font-body); font-size: 20px; line-height: 24px; overflow-wrap: anywhere; }
.seat-story-label { font-family: var(--font-label); font-size: 16px; line-height: 20px; text-transform: uppercase; color: var(--dust); }
.seat-story-name { color: var(--candle); }
.seat-story-tag { font-family: var(--font-label); font-size: 16px; line-height: 20px; text-transform: uppercase; color: var(--dust); }
.seat-story-words { color: var(--bone); white-space: pre-wrap; }
.seat-story-line.narration .seat-story-words, .seat-story-line.system .seat-story-words { color: var(--dust); }
.seat-story-roll { color: var(--bone); }
.seat-story-sound { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; margin: 0 0 12px; }
.seat-story-sound-note { font-family: var(--font-body); font-size: 20px; line-height: 24px; color: var(--dust); }
@media (max-width: 600px) { .seat-story-scroll { max-height: 216px; } }
</style>
