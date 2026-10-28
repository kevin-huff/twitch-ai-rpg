<script setup lang="ts">
import type { PublishedBeat, PublicCharacter, PublicCorrection } from '@rpg/contracts';
import { bandLabel } from './stage-format';
withDefaults(defineProps<{ history: PublishedBeat[]; characters: PublicCharacter[]; stage?: boolean; corrections?: PublicCorrection[] }>(), { corrections: () => [] });
</script>

<template>
  <div class="transcript" aria-label="Published story">
    <p v-if="!history.length" class="empty">The room is waiting. The next exchange will appear here when the director publishes it.</p>
    <article v-for="beat in history" :key="beat.id">
      <div class="beat-label">Beat {{ beat.beatNumber }} · {{ beat.kind }} <span v-if="beat.kind === 'action'">· Round {{ beat.actionRoundNumber }}</span></div>
      <div v-if="beat.rolls.length" class="rolls" aria-label="Server dice results">
        <div v-for="roll in beat.rolls" :key="roll.id" class="roll">
          <strong>{{ roll.total }}</strong> {{ roll.faces.join(' + ') }} + {{ roll.traitModifier }}<span v-if="roll.edge"> + 1 Edge</span>
          <small>{{ characters.find(character => character.id === roll.actorCharacterId)?.displayName }} · {{ bandLabel(roll.band) }}</small>
        </div>
      </div>
      <div v-for="segment in beat.segments" :key="segment.id" class="segment" :class="segment.kind">
        <div class="speaker">{{ segment.speaker?.displayName ?? (segment.kind === 'system' ? 'The show' : 'Narrator') }}<span v-if="segment.kind === 'player_action'" class="segment-tag">Action</span></div>
        <p>{{ segment.text }}</p>
      </div>
    </article>
    <section v-if="corrections.length" class="correction-log" aria-label="Published corrections">
      <p class="eyebrow">Corrections</p>
      <p class="correction-note">Original story and dice remain recorded.</p>
      <article v-for="correction in corrections" :key="correction.id" data-testid="published-correction">
        <div class="beat-label">Beat {{ correction.beatNumber }} · correction <time :datetime="correction.recordedAt">{{ new Date(correction.recordedAt).toLocaleString() }}</time></div>
        <p class="correction-text">{{ correction.publicText }}</p>
      </article>
    </section>
  </div>
</template>

<style scoped>
.correction-log { margin-top: 32px; padding-top: 20px; box-shadow: inset 0 2px 0 0 var(--night-raised); }
.correction-note { font-size: 20px; color: var(--dust); }
.correction-text { white-space: pre-wrap; overflow-wrap: anywhere; }
time { display: block; font-family: var(--font-label); font-size: 16px; line-height: 24px; color: var(--dust); }
</style>
