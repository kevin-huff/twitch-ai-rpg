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
.error-notice { position: fixed; z-index: 50; top: max(16px, env(safe-area-inset-top)); right: max(16px, env(safe-area-inset-right)); width: min(640px, calc(100% - 32px)); max-height: calc(100dvh - 32px); display: flex; flex-direction: column; gap: 12px; margin: 0; }
.error-message { min-height: 0; max-height: min(25vh, 240px); margin: 0; overflow: auto; overflow-wrap: anywhere; white-space: pre-wrap; }
.error-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; align-items: center; gap: 8px; flex-shrink: 0; }
</style>
