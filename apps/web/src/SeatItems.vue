<script setup lang="ts">
defineProps<{ carrying: string[]; wearing: string[]; disabled: boolean }>();
const emit = defineEmits<{ prefill: [text: string] }>();
</script>

<template>
  <details class="seat-items" data-testid="seat-items">
    <summary>What I have</summary>
    <div class="items-body">
      <h3>Carrying</h3>
      <ul v-if="carrying.length">
        <li v-for="(entry, i) in carrying" :key="`c${i}`" class="item-row">
          <span class="item-name">{{ entry }}</span>
          <span class="item-actions">
            <button type="button" class="secondary" :disabled="disabled" :aria-label="`Use ${entry}`" :data-testid="`seat-item-use-${i}`" @click="emit('prefill', `Use ${entry} to `)">Use</button>
            <button type="button" class="secondary" :disabled="disabled" :aria-label="`Give ${entry}`" :data-testid="`seat-item-give-${i}`" @click="emit('prefill', `Give ${entry} to `)">Give</button>
            <button type="button" class="secondary" :disabled="disabled" :aria-label="`Drop ${entry}`" :data-testid="`seat-item-drop-${i}`" @click="emit('prefill', `Drop ${entry}`)">Drop</button>
            <button type="button" class="secondary" :disabled="disabled" :aria-label="`Put on ${entry}`" :data-testid="`seat-item-put-on-${i}`" @click="emit('prefill', `Put on ${entry}`)">Put on</button>
          </span>
        </li>
      </ul>
      <p v-else class="nothing">Nothing yet.</p>
      <h3>Wearing</h3>
      <ul v-if="wearing.length">
        <li v-for="(entry, i) in wearing" :key="`w${i}`" class="item-row">
          <span class="item-name">{{ entry }}</span>
          <span class="item-actions">
            <button type="button" class="secondary" :disabled="disabled" :aria-label="`Take off ${entry}`" :data-testid="`seat-wear-take-off-${i}`" @click="emit('prefill', `Take off ${entry}`)">Take off</button>
          </span>
        </li>
      </ul>
      <p v-else class="nothing">Nothing yet.</p>
      <div class="pick-up"><button type="button" class="secondary" :disabled="disabled" data-testid="seat-item-pick-up" @click="emit('prefill', 'Pick up ')">Pick up something</button></div>
    </div>
  </details>
</template>

<style scoped>
.seat-items { margin-top: 0; min-width: 0; }
.seat-items > summary { cursor: pointer; min-height: 44px; padding-block: 10px; box-sizing: border-box; }
.seat-items > summary::before { top: 16px; }
.seat-items[open] > summary::before { top: 18px; }
.items-body { display: grid; gap: 8px; min-width: 0; margin-top: 8px; }
.items-body h3 { margin: 8px 0 0; color: var(--dust); font-size: 20px; line-height: 24px; }
ul { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; min-width: 0; }
.item-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; min-width: 0; }
.item-name { flex: 1 1 120px; min-width: 0; overflow-wrap: anywhere; }
.item-actions { display: flex; flex-wrap: wrap; gap: 8px; min-width: 0; }
.nothing { margin: 0; color: var(--dust); }
.pick-up { display: flex; flex-wrap: wrap; margin-top: 8px; }
</style>
