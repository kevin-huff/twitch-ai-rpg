<script setup lang="ts">
import { computed } from 'vue';
import type { CharacterCondition, PublicBeat, PublicNpc, Submission } from '@rpg/contracts';

const props = withDefaults(defineProps<{ submissions: Submission[]; npcs: PublicNpc[]; busy: boolean; beat?: PublicBeat | null; condition?: CharacterCondition; name?: string }>(), { beat: null, condition: undefined, name: undefined });
const emit = defineEmits<{ edit: [item: Submission]; withdraw: [item: Submission] }>();

// The director never picks private notes, so they stay queued. Show only the newest note, beside the newest
// finished line, so neither can push the other out.
const isFinished = (item: Submission) => item.status === 'published' || item.status === 'cancelled';
const visible = computed(() => {
  let noteSeen = false;
  let finishedSeen = false;
  return [...props.submissions].reverse().filter(item => {
    if (item.kind === 'ooc') {
      if (noteSeen) return false;
      noteSeen = true;
      return true;
    }
    if (!isFinished(item)) return true;
    if (finishedSeen) return false;
    finishedSeen = true;
    return true;
  });
});

const sentences: Record<Submission['status'], string> = {
  queued: 'Sent. Waiting for the director to pick lines.',
  selected: 'Picked by the director. You can still change it.',
  locked: 'Locked in. The result will appear under The story.',
  published: 'This is in the story now.',
  cancelled: 'Taken back. Send it again if you still want it.',
};
const pastCollecting = computed(() => props.beat?.phase === 'stakes_review' || props.beat?.phase === 'locked' || props.beat?.phase === 'draft_review');
const waiting = computed(() => props.submissions.filter(item => item.kind !== 'ooc' && (item.status === 'queued' || item.status === 'selected')));
const planning = computed(() => props.beat?.planning === true);
const oneMore = computed(() => waiting.value.length === 1 && !pastCollecting.value && !planning.value);
const sentence = (item: Submission) => {
  if (item.kind === 'ooc' && item.status === 'queued') return 'Sent. Only the director sees it.';
  if (item.kind !== 'ooc' && item.status === 'queued' && (pastCollecting.value || planning.value)) return 'Not in this round. It waits for the next turn.';
  if (item.kind !== 'ooc' && item.status === 'selected' && (planning.value || props.beat?.phase === 'stakes_review')) return 'Picked for this round. If you change it or take it back, the director has to plan again.';
  return sentences[item.status];
};
const canChange = (item: Submission) => item.status === 'queued' || item.status === 'selected';
const blocked = (item: Submission) => props.condition === 'down' && item.kind === 'act' && canChange(item);
const label = (item: Submission) => {
  if (item.kind === 'act') return 'You tried';
  if (item.kind === 'ooc') return 'Private note';
  const npc = props.npcs.find(candidate => candidate.id === item.recipientNpcIds[0]);
  return npc ? `You said to ${npc.displayName}` : 'You said to your group';
};
const extraApproach = (item: Submission) => {
  const approach = (item.approach ?? '').trim();
  return approach && approach !== (item.intent ?? '').trim() ? item.approach : '';
};
</script>

<template>
  <section v-if="visible.length" class="panel sub-list">
    <p class="eyebrow">What you sent</p>
    <p v-if="oneMore" class="muted" data-testid="one-more-line">You can send one more line.</p>
    <article v-for="item in visible" :key="item.id" class="sub-item" :data-status="item.status">
      <strong class="sub-label">{{ label(item) }}</strong>
      <template v-if="item.kind === 'act'">
        <p>{{ item.intent }}</p>
        <p v-if="extraApproach(item)" class="muted">{{ extraApproach(item) }}</p>
      </template>
      <p v-else>{{ item.text }}</p>
      <p class="sentence">{{ sentence(item) }}</p>
      <p v-if="blocked(item)" class="sentence" data-testid="sub-blocked">{{ name ?? 'Your character' }} is down, so this Do line can't be used or changed. You can take it back.</p>
      <div v-if="canChange(item)" class="actions">
        <button v-if="!blocked(item)" type="button" class="secondary" :disabled="busy" @click="emit('edit', item)">Change</button>
        <button type="button" class="quiet" :disabled="busy" @click="emit('withdraw', item)">Take it back</button>
      </div>
    </article>
  </section>
</template>

<style scoped>
.sub-item { box-shadow: inset 0 2px 0 0 var(--night-raised); padding: 14px 0 12px; display: grid; gap: 4px; }
.sub-item p { margin: 0; overflow-wrap: anywhere; white-space: pre-wrap; }
.sub-label { color: var(--candle); }
.sentence { color: var(--dust); font-size: 20px; line-height: 24px; }
</style>
