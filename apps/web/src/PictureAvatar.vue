<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { initials } from './stage-format';
import { portraitAlt } from './pictures';

const props = defineProps<{ name: string; src?: string | null; size?: number }>();
const broken = ref(false);
watch(() => props.src, () => { broken.value = false; });
const showImage = computed(() => Boolean(props.src) && !broken.value);
const boxStyle = computed(() => (props.size ? { width: `${props.size}px`, height: `${props.size}px` } : undefined));
</script>

<template>
  <span class="avatar picture-avatar" :style="boxStyle"><img v-if="showImage" :src="src!" :alt="portraitAlt(name)" @error="broken = true" /><template v-else>{{ initials(name) }}</template></span>
</template>

<style scoped>
.picture-avatar { overflow: hidden; }
.picture-avatar img { display: block; width: 100%; height: 100%; object-fit: cover; border-radius: 50%; }
</style>
