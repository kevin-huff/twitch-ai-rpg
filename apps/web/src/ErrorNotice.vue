<script setup lang="ts">
defineProps<{ message: string }>();
defineEmits<{ dismiss: [] }>();
</script>

<template>
  <div class="notice error error-notice" role="alert" aria-atomic="true">
    <p class="error-message" tabindex="0">{{ message }}</p>
    <div class="error-actions">
      <slot />
      <button type="button" class="secondary" aria-label="Dismiss error" @click="$emit('dismiss')">Dismiss</button>
    </div>
  </div>
</template>

<style scoped>
.error-notice { position: fixed; z-index: 50; top: max(1rem, env(safe-area-inset-top)); right: max(1rem, env(safe-area-inset-right)); width: min(32rem, calc(100% - 2rem)); max-height: calc(100dvh - 2rem); display: flex; flex-direction: column; gap: .75rem; margin: 0; box-shadow: 0 8px 28px #0008; }
.error-message { min-height: 0; max-height: min(25vh, 12rem); margin: 0; overflow: auto; overflow-wrap: anywhere; white-space: pre-wrap; }
.error-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; align-items: center; gap: .5rem; flex-shrink: 0; }
</style>
