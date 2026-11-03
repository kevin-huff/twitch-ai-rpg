<script setup lang="ts">
import { ref, useId } from 'vue';
import type { PublicCharacter, StreamLinkSummary } from '@rpg/contracts';
import StreamKitLink from './StreamKitLink.vue';
import StreamLinkCard from './StreamLinkCard.vue';
import { STAGE_PIECES, pieceUrl, streamUrl } from './stream';

const props = withDefaults(defineProps<{
  link: StreamLinkSummary; token: string; title: string; characters: PublicCharacter[];
  busy?: boolean; canTurnOff?: boolean; testid?: string;
}>(), { busy: false, canTurnOff: true, testid: undefined });
const emit = defineEmits<{ 'turn-off': [] }>();

const prefix = useId();
const confirming = ref(false);

const origin = () => window.location.origin;
const readyUrl = () => streamUrl(origin(), props.token, { layout: 'overlay', audio: 'listen' });
const soundUrl = () => streamUrl(origin(), props.token, { layout: 'audio' });
const sizeOf = (box: { width: number; height: number }) => `${box.width} × ${box.height}`;

function turnOff() { emit('turn-off'); confirming.value = false; }
</script>

<template>
  <section class="stream-kit" :data-testid="testid">
    <strong class="kit-name">{{ title }}</strong>
    <StreamKitLink v-if="!link.canPresent" testid="kit-ready" title="Ready-made link" copy-label="Copy ready-made link" :url="readyUrl">
      One Browser source with the overlay and the narration. Paste it into OBS and you are set.
    </StreamKitLink>
    <StreamLinkCard :link="link" :token="token" title="Full layouts" testid="kit-layouts" :can-turn-off="false" :busy="busy" />
    <details class="kit-pieces" data-testid="kit-pieces">
      <summary>Pieces for your own scenes</summary>
      <p class="kit-intro">Each piece is its own Browser source, so you can place and size it yourself in any OBS scene. Pieces never play sound.</p>
      <div class="kit-grid">
        <StreamKitLink testid="kit-sound" title="Sound link" copy-label="Copy sound link" :url="soundUrl">
          <template v-if="link.canPresent">
            <p>This link carries the show audio for the whole stream and draws nothing. Add it once, in a scene of its own, then add that scene inside every other scene. Only one OBS should load it.</p>
          </template>
          <template v-else>
            <p>This link plays the narration where it is opened and never carries the show audio.</p>
          </template>
          <p>A full layout link already plays sound, so use the sound link only with pieces.</p>
        </StreamKitLink>
        <p class="kit-badge-note" data-testid="kit-badge-note">Keep the AI badge on screen whenever the narration or voices play. It tells viewers they are made by AI.</p>
        <StreamKitLink
          v-for="piece in STAGE_PIECES" :key="piece.view" :testid="`kit-piece-${piece.view}`" :title="piece.name" copy-label="Copy link"
          :size="sizeOf(piece.box)" tagged :characters="piece.perCharacter ? characters : []" :default-who="piece.perCharacter ? link.characterId : null"
          :url="(who) => pieceUrl(origin(), token, { view: piece.view, who })"
          :preview-url="(who) => pieceUrl(origin(), token, { view: piece.view, who, audio: 'off', checker: true })"
        >{{ piece.about }}</StreamKitLink>
      </div>
      <details class="kit-steps" data-testid="kit-steps">
        <summary>How to add pieces in OBS</summary>
        <ol>
          <li>In OBS, open Sources, press +, and choose Browser.</li>
          <li>Paste the piece's link into URL.</li>
          <li>Set Width and Height to the size on the piece's card.</li>
          <li>Untick Shutdown source when not visible and Refresh browser when scene becomes active.</li>
          <li v-if="link.canPresent">Tick Control audio via OBS for the sound link only.</li>
        </ol>
      </details>
    </details>
    <div v-if="canTurnOff" class="kit-turn-off">
      <button v-if="!confirming" type="button" class="quiet" data-testid="turn-off" :disabled="busy" @click="confirming = true">Turn off</button>
      <div v-else class="kit-confirm" :aria-labelledby="`${prefix}-confirm`">
        <p :id="`${prefix}-confirm`">Turn off this link? OBS sources using it switch to a holding screen, and its pieces go blank, within seconds.</p>
        <button type="button" data-testid="turn-off-confirm" :disabled="busy" @click="turnOff">Turn off</button>
        <button type="button" class="secondary" data-testid="turn-off-keep" :disabled="busy" @click="confirming = false">Keep link</button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.stream-kit { display: grid; gap: 16px; min-width: 0; }
.kit-name { font-size: 24px; line-height: 28px; }
.kit-pieces { display: grid; gap: 12px; }
.kit-pieces[open] > summary { margin-bottom: 12px; }
.kit-intro, .kit-badge-note { margin: 0 0 12px; }
.kit-badge-note { grid-column: 1 / -1; margin: 0; color: var(--candle); }
.kit-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 320px), 1fr)); gap: 16px; }
.kit-steps { margin-top: 16px; }
.kit-steps ol { margin: 8px 0 0; padding-left: 24px; }
.kit-confirm { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; }
.kit-confirm p { flex-basis: 100%; margin: 0; }
</style>
