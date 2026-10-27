<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { CharacterCardDefinition, ScenarioDefinition, SeatChoice, TemplateRef, TemplateVersion } from '@rpg/contracts';
import { api } from './api';

const props = defineProps<{ scenario: { ref: TemplateRef; definition: ScenarioDefinition }; cards: TemplateVersion<CharacterCardDefinition>[] }>();
const emit = defineEmits<{ created: [sessionId: string] }>();

type Kind = 'player' | 'describe' | 'card';
interface Seat { id: number; kind: Kind; sentence: string; cardKey: string; ref: TemplateRef | null; status: 'idle' | 'writing' | 'failed' }
const MIN_SEATS = 2;
const MAX_SEATS = 6;
let nextId = 0;
const newSeat = (): Seat => ({ id: nextId++, kind: 'player', sentence: '', cardKey: '', ref: null, status: 'idle' });

const title = ref(props.scenario.definition.title);
const seats = ref<Seat[]>([newSeat(), newSeat(), newSeat(), newSeat()]);
const busy = ref(false);
const message = ref('');

watch(() => `${props.scenario.ref.templateId}:${props.scenario.ref.version}`, () => {
  title.value = props.scenario.definition.title;
  for (const seat of seats.value) { seat.ref = null; if (seat.status === 'failed') seat.status = 'idle'; }
  message.value = '';
});

const cardKey = (item: { id: string; version: number }) => `${item.id}:${item.version}`;
function refFrom(value: string): TemplateRef {
  const split = value.lastIndexOf(':');
  return { templateId: value.slice(0, split), version: Number(value.slice(split + 1)) };
}
const premise = computed(() => {
  const text = props.scenario.definition.premise.trim();
  return text.length >= 1 && text.length <= 4000 ? text : undefined;
});
const failedCount = computed(() => seats.value.filter(seat => seat.status === 'failed').length);

function changeKind(seat: Seat, kind: Kind) {
  seat.kind = kind; seat.ref = null; seat.status = 'idle'; message.value = '';
}
function changeSentence(seat: Seat, value: string) {
  seat.sentence = value; seat.ref = null; if (seat.status === 'failed') seat.status = 'idle';
}
function addSeat() { if (seats.value.length < MAX_SEATS) seats.value.push(newSeat()); }
function removeSeat(index: number) { if (seats.value.length > MIN_SEATS) seats.value.splice(index, 1); }

function validate(): string {
  if (!title.value.trim()) return 'Give the show a title.';
  if (title.value.trim().length > 160) return 'The show title can be at most 160 characters.';
  for (const [index, seat] of seats.value.entries()) {
    if (seat.kind === 'describe') {
      const sentence = seat.sentence.trim();
      if (!sentence) return `Seat ${index + 1}: write one sentence about this character, or let the player write it.`;
      if (sentence.length > 4000) return `Seat ${index + 1}: keep the sentence under 4,000 characters.`;
    }
    if (seat.kind === 'card' && !props.cards.some(card => cardKey(card) === seat.cardKey)) return `Seat ${index + 1}: choose a saved card, or let the player write it.`;
  }
  return '';
}

async function writeSeat(seat: Seat) {
  seat.status = 'writing';
  try {
    const response = await api.generateCard({ prompt: seat.sentence.trim(), keepFilled: true, ...(premise.value ? { premise: premise.value } : {}) });
    const saved = await api.saveCharacterTemplate({ expectedVersion: 0, definition: response.card });
    seat.ref = { templateId: saved.id, version: saved.version };
    seat.status = 'idle';
  } catch {
    seat.ref = null;
    seat.status = 'failed';
  }
}

function choice(seat: Seat): SeatChoice | null {
  if (seat.kind === 'player') return { playerWritten: true };
  if (seat.kind === 'card') return refFrom(seat.cardKey);
  return seat.ref;
}

async function finish() {
  const choices = seats.value.map(choice);
  const missing = seats.value.findIndex(seat => seat.kind === 'describe' && !seat.ref);
  if (missing >= 0) { message.value = `Seat ${missing + 1} still needs its card written.`; return; }
  if (choices.some(item => item === null) || failedCount.value > 0) return;
  const result = await api.createCustom(title.value.trim(), props.scenario.ref, choices as SeatChoice[]);
  emit('created', result.sessionId);
}

async function run(only?: Seat) {
  if (busy.value) return;
  message.value = '';
  const problem = validate();
  if (problem) { message.value = problem; return; }
  busy.value = true;
  try {
    const waiting = seats.value.filter(seat => seat.kind === 'describe' && !seat.ref);
    const pending = only && !waiting.includes(only) ? [only, ...waiting] : only ? [only, ...waiting.filter(seat => seat !== only)] : waiting;
    await Promise.all(pending.map(writeSeat));
    await finish();
  } catch (cause) {
    message.value = cause instanceof Error ? cause.message : 'The show could not be created.';
  } finally {
    busy.value = false;
  }
}
const letPlayerWrite = (seat: Seat) => changeKind(seat, 'player');
</script>

<template>
  <section class="panel show-form">
    <div class="help-field"><label><span class="field-label">Show title</span><input v-model="title" data-testid="show-title" maxlength="160" :disabled="busy"></label></div>
    <div v-for="(seat, index) in seats" :key="seat.id" class="seat-row" :data-testid="`make-seat-${index}`">
      <div class="help-field">
        <label>Seat {{ index + 1 }}
          <select :value="seat.kind" :data-testid="`make-seat-kind-${index}`" :disabled="busy" @change="changeKind(seat, ($event.target as HTMLSelectElement).value as Kind)">
            <option value="player">Player writes their own</option>
            <option value="describe">Describe a character</option>
            <option value="card">Use a saved card</option>
          </select>
        </label>
      </div>
      <div v-if="seat.kind === 'describe'" class="help-field">
        <label>One sentence about this character<input :value="seat.sentence" maxlength="4000" :data-testid="`make-seat-describe-${index}`" :disabled="busy" @input="changeSentence(seat, ($event.target as HTMLInputElement).value)"></label>
      </div>
      <div v-if="seat.kind === 'card'" class="help-field">
        <label>Saved card
          <select v-model="seat.cardKey" :data-testid="`make-seat-card-${index}`" :disabled="busy">
            <option value="">Choose a saved card</option>
            <option v-for="item in cards" :key="cardKey(item)" :value="cardKey(item)">{{ item.definition.displayName }} · version {{ item.version }}</option>
          </select>
        </label>
      </div>
      <p v-if="seat.status === 'writing'" class="muted" role="status" :data-testid="`make-seat-status-${index}`">Writing this card…</p>
      <div v-else-if="seat.status === 'failed'" class="notice error" role="alert">
        <p :data-testid="`make-seat-status-${index}`">Couldn't write this card.</p>
        <div class="actions">
          <button type="button" :disabled="busy" :data-testid="`make-seat-retry-${index}`" @click="run(seat)">Try again</button>
          <button type="button" class="secondary" :disabled="busy" :data-testid="`make-seat-let-player-${index}`" @click="letPlayerWrite(seat)">Let the player write it</button>
        </div>
      </div>
      <button v-if="seats.length > MIN_SEATS" type="button" class="quiet" :disabled="busy" :data-testid="`make-seat-remove-${index}`" @click="removeSeat(index)">Remove</button>
    </div>
    <p v-if="message" class="notice error" role="alert" data-testid="make-form-error">{{ message }}</p>
    <div class="actions">
      <button v-if="seats.length < MAX_SEATS" type="button" class="secondary" :disabled="busy" data-testid="make-add-seat" @click="addSeat">Add a seat</button>
      <button type="button" :disabled="busy" data-testid="create-show" @click="run()">Create show</button>
    </div>
  </section>
</template>
