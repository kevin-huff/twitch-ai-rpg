<script setup lang="ts">
import { computed } from 'vue';
import PictureAvatar from './PictureAvatar.vue';

const props = defineProps<{
  name: string;
  imageUrl: string | null;
  state?: 'making' | 'failed' | null;
  message?: string | null;
  enabled: boolean;
  disabled?: boolean;
  canCreate: boolean;
}>();
defineEmits<{ create: []; remove: [] }>();

const making = computed(() => props.state === 'making');
const note = computed(() => {
  if (making.value) return 'Making the portrait...';
  if (props.state === 'failed') return props.message || 'The portrait could not be made. Press Create portrait to try again.';
  if (!props.canCreate) return 'Give this character an appearance or a role first.';
  return '';
});
</script>

<template>
  <div v-if="enabled" class="npc-portrait" data-testid="npc-portrait-controls">
    <PictureAvatar :name="name" :src="imageUrl" :size="64" />
    <div>
      <button class="secondary" type="button" data-testid="npc-portrait-create" :disabled="disabled || making || !canCreate" @click="$emit('create')">Create portrait</button>
      <button v-if="imageUrl && !making" class="quiet" type="button" data-testid="npc-portrait-remove" :disabled="disabled" @click="$emit('remove')">Remove portrait</button>
      <p v-if="note" class="muted" data-testid="npc-portrait-note">{{ note }}</p>
    </div>
  </div>
</template>

<style scoped>
.npc-portrait { display: flex; align-items: flex-start; gap: .75rem; margin-top: .5rem; }
</style>
