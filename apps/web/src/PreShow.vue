<script setup lang="ts">
import type { Command, PlayerSnapshot } from '@rpg/contracts';
import PlayerCard from './PlayerCard.vue';

defineProps<{ snapshot: PlayerSnapshot; busy: boolean }>();
const seatLabel = (name: string, own: boolean, approved: boolean) => `${name}${own ? ' (you)' : ''}${approved ? '' : ' · waiting'}`;
const emit = defineEmits<{ command: [command: Command] }>();
</script>

<template>
  <section class="panel pre-show" data-testid="pre-show">
    <h1>{{ snapshot.session.title }}</h1>
    <p v-if="snapshot.session.brief?.premise" class="premise">{{ snapshot.session.brief.premise }}</p>
    <h2>The cast</h2>
    <ul class="cast-list" data-testid="pre-show-cast"><li v-for="character in snapshot.characters" :key="character.id">{{ seatLabel(character.displayName, character.id === snapshot.ownCharacter?.id, character.approved) }}</li></ul>
    <PlayerCard :snapshot="snapshot" :busy="busy" @command="emit('command', $event)" />
    <p class="muted">The show will start soon.</p>
  </section>
</template>

<style scoped>
.cast-list { list-style: none; margin: 0 0 20px; padding: 0; display: grid; gap: 8px; }
.premise { white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
