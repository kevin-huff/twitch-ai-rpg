<script setup lang="ts">
import { computed } from 'vue';
import type { PublicNpc, Submission } from '@rpg/contracts';

const props = defineProps<{ submissions: Submission[]; npcs: PublicNpc[]; busy: boolean }>();
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
  locked: 'Locked in. Watch the stream to see what happens.',
  published: 'This is in the story now.',
  cancelled: 'Not used. You took it back, or the story moved on. Send it again if it still fits.',
};
const sentence = (item: Submission) => item.kind === 'ooc' && item.status === 'queued' ? 'Sent. Only the director sees it.' : sentences[item.status];
const canChange = (item: Submission) => item.status === 'queued' || item.status === 'selected';
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
    <article v-for="item in visible" :key="item.id" class="sub-item" :data-status="item.status">
      <strong class="sub-label">{{ label(item) }}</strong>
      <template v-if="item.kind === 'act'">
        <p>{{ item.intent }}</p>
        <p v-if="extraApproach(item)" class="muted">{{ extraApproach(item) }}</p>
      </template>
      <p v-else>{{ item.text }}</p>
      <p class="sentence">{{ sentence(item) }}</p>
      <div v-if="canChange(item)" class="actions">
        <button type="button" class="secondary" :disabled="busy" @click="emit('edit', item)">Change</button>
        <button type="button" class="quiet" :disabled="busy" @click="emit('withdraw', item)">Take it back</button>
      </div>
    </article>
  </section>
</template>

<style scoped>
.sub-item { border-top: 1px solid var(--line); padding: .7rem 0; display: grid; gap: .3rem; }
.sub-item p { margin: 0; overflow-wrap: anywhere; white-space: pre-wrap; }
.sentence { color: var(--muted); font-size: .9rem; }
</style>
