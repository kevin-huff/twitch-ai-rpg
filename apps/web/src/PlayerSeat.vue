<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, useId, watch } from 'vue';
import type { SessionSnapshot, Submission } from '@rpg/contracts';
import { identityPath } from './identity';
import { pictureUrl, portraitAlt, shownScenePicture } from './pictures';
import { PAUSE_REQUEST_TEXT, useTable } from './table';
import { playerStatus } from './player-status';
import { clearDraft, loadDraft, saveDraft } from './drafts';
import LineAssist from './LineAssist.vue';
import SeatStory from './SeatStory.vue';
import SeatVoice from './SeatVoice.vue';
import SubmissionList from './SubmissionList.vue';

type LineKind = 'say' | 'act' | 'ooc';

const helpPrefix = useId();
const helpId = (...parts: (string | number)[]) => `${helpPrefix}-help-${encodeURIComponent(JSON.stringify(parts))}`;

const table = useTable();
const { sessionId, snapshot, busy, player, send, work, onSnapshot } = table;
const context = table.inputContext;

const playerReady = computed(() => !player.value?.setup || Boolean(player.value.setup.started && player.value.ownCharacter?.approved));

const kind = ref<LineKind>('say');
const sayText = ref('');
const assistKey = ref(0);
const actionText = ref('');
const noteText = ref('');
const recipient = ref('');
const stageDirection = ref('');
const receipt = ref('');
const receiptFor = ref<string | null>(null);
const recipientTouched = ref(false);
const editing = ref<Submission | null>(null);
const formPanel = ref<HTMLElement | null>(null);
type InputContext = { epoch: number; beatId: string | null };
const contexts = ref<Record<LineKind, InputContext | null>>({ say: null, act: null, ooc: null });
const textOf = (lineKind: LineKind) => ({ say: sayText, act: actionText, ooc: noteText })[lineKind].value;
const visibleBlank = () => !textOf(kind.value).trim();
const activeContext = computed(() => contexts.value[kind.value]);
const draftContext = computed(() => {
  const used = (['say', 'act', 'ooc'] as const).filter(lineKind => textOf(lineKind).trim()).map(lineKind => contexts.value[lineKind]).filter((ctx): ctx is InputContext => Boolean(ctx));
  return used.reduce<InputContext | null>((lowest, ctx) => !lowest || ctx.epoch < lowest.epoch ? ctx : lowest, null);
});
const draftRestored = ref(false);

const name = computed(() => player.value?.ownCharacter?.displayName ?? 'your character');
const card = computed(() => {
  const own = player.value?.ownCharacter;
  if (!own) return [];
  const rows: [string, string | undefined][] = [
    ['Pronouns', own.pronouns], ['Looks', own.appearance], ['Personality', own.personality], ['Good at', own.specialty],
    ['Struggles with', own.flaw], ['Carrying', (own.possessions ?? []).map(item => item.trim()).filter(Boolean).join(', ')],
    ['Connection', own.connection], ['Your secret', own.secret],
  ];
  return rows.map(([label, value]) => ({ label, value: (value ?? '').trim() })).filter(row => row.value);
});

const scenePictureSrc = computed(() => {
  const picture = snapshot.value ? shownScenePicture(snapshot.value) : null;
  return picture ? pictureUrl({ kind: 'session', sessionId }, picture.imageId) : null;
});
const ownPortraitSrc = computed(() => {
  const portraitId = snapshot.value?.picturesEnabled === true ? player.value?.ownCharacter?.portraitId : null;
  return portraitId ? pictureUrl({ kind: 'session', sessionId }, portraitId) : null;
});
const brokenPictures = ref<string[]>([]);
const showable = (src: string | null) => (src && !brokenPictures.value.includes(src) ? src : null);
const pictureFailed = (src: string | null) => { if (src && !brokenPictures.value.includes(src)) brokenPictures.value = [...brokenPictures.value, src]; };
// A failure is remembered only while that same picture stays shown; when it reappears it gets one fresh try.
watch([scenePictureSrc, ownPortraitSrc], shown => {
  const kept = brokenPictures.value.filter(src => shown.includes(src));
  if (kept.length !== brokenPictures.value.length) brokenPictures.value = kept;
});

const turnDefault = computed<LineKind>(() => {
  const beat = player.value?.activeBeat;
  return beat?.kind === 'action' && (beat.phase === 'collecting' || beat.phase === 'stakes_review') ? 'act' : 'say';
});

const ownCharacterId = computed(() => player.value?.ownCharacter?.id ?? '');
watch(ownCharacterId, id => {
  if (!id || Object.values(contexts.value).some(Boolean)) return;
  const saved = loadDraft(sessionId, id);
  if (!saved) return;
  // Drafts from the old seat kept a private question in speech and an action as separate goal and method.
  const legacyNote = Boolean(saved.legacy) && saved.kind === 'ooc';
  const twoBoxAction = Boolean(saved.legacy) && saved.intent.trim() && saved.approach.trim() && saved.approach.trim() !== saved.intent.trim();
  kind.value = saved.kind; sayText.value = legacyNote ? '' : saved.speech; noteText.value = legacyNote ? saved.speech : saved.note;
  stageDirection.value = sayText.value.trim() ? saved.stageDirection : '';
  actionText.value = twoBoxAction ? `${saved.intent}\n${saved.approach}` : saved.intent || saved.approach;
  recipient.value = saved.recipient; recipientTouched.value = true;
  if (!textOf(kind.value).trim()) kind.value = (['say', 'act', 'ooc'] as const).find(lineKind => textOf(lineKind).trim()) ?? kind.value;
  for (const lineKind of ['say', 'act', 'ooc'] as const) if (textOf(lineKind).trim()) contexts.value[lineKind] = saved.context ?? context();
  draftRestored.value = true;
}, { immediate: true });
watch([kind, sayText, actionText, noteText, stageDirection, recipient, draftContext], () => {
  const id = ownCharacterId.value;
  if (!id || editing.value) return;
  if ([sayText.value, actionText.value, noteText.value, stageDirection.value].some(text => text.trim())) saveDraft(sessionId, id, { kind: kind.value, speech: sayText.value, intent: actionText.value, approach: '', note: noteText.value, stageDirection: stageDirection.value, recipient: recipient.value, context: draftContext.value });
  else clearDraft(sessionId, id);
});
watch([() => player.value?.activeBeat?.id, () => player.value?.activeBeat?.kind], () => {
  if (visibleBlank() && !editing.value && kind.value !== 'ooc') kind.value = turnDefault.value;
}, { immediate: true });

function beginInput() {
  const lineKind = kind.value;
  if (visibleBlank()) contexts.value[lineKind] = null;
  else if (!contexts.value[lineKind]) contexts.value[lineKind] = context();
}

const status = computed(() => playerStatus({ sessionStatus: snapshot.value?.session.status ?? 'live', beat: player.value?.activeBeat ?? null, own: player.value?.submissions ?? [], name: player.value?.ownCharacter?.displayName, inputEpoch: snapshot.value?.session.inputEpoch }));
const toneLabel = computed(() => ({ wait: 'Hold on', act: 'Your turn', done: 'Sent' })[status.value.tone]);
const presentNpcs = computed(() => snapshot.value?.npcs.filter(npc => npc.status === 'present') ?? []);
const changingRecipient = ref(false);
const talkingTo = computed(() => {
  const npc = presentNpcs.value.find(candidate => candidate.id === recipient.value);
  return npc ? `Talking to ${npc.displayName}` : 'Talking to your group';
});
const submitLabel = computed(() => busy.value ? 'Sending…' : editing.value ? 'Save changes' : kind.value === 'ooc' ? 'Send privately' : 'Send');

function defaultRecipient(next: SessionSnapshot) {
  const present = next.npcs.filter(npc => npc.status === 'present');
  if (recipient.value ? !present.some(npc => npc.id === recipient.value) : !recipientTouched.value) recipient.value = present[0]?.id ?? '';
}
if (snapshot.value) defaultRecipient(snapshot.value);
const unregister = onSnapshot(defaultRecipient);
onUnmounted(unregister);

function ownIds() { return new Set((player.value?.submissions ?? []).map(item => item.id)); }
function newOwnId(before: Set<string>) { return (player.value?.submissions ?? []).find(item => !before.has(item.id))?.id ?? null; }
watch(snapshot, () => {
  if (!receipt.value || !receiptFor.value) return;
  const item = player.value?.submissions.find(own => own.id === receiptFor.value);
  if (!item || (item.status !== 'queued' && item.status !== 'selected')) { receipt.value = ''; receiptFor.value = null; }
});

function linePayload(lineKind: LineKind) {
  if (lineKind === 'say') return { kind: 'say' as const, text: sayText.value, intent: '', approach: '', recipientNpcIds: recipient.value ? [recipient.value] : [], stageDirection: stageDirection.value };
  if (lineKind === 'act') return { kind: 'act' as const, text: '', intent: actionText.value, approach: actionText.value, recipientNpcIds: [], stageDirection: '' };
  return { kind: 'ooc' as const, text: noteText.value, intent: '', approach: '', recipientNpcIds: [], stageDirection: '' };
}

function saveSubmission() { return work(async () => {
  receipt.value = ''; receiptFor.value = null;
  const lineKind = kind.value;
  const captured = contexts.value[lineKind] ?? context();
  const editedId = editing.value?.id ?? null;
  const before = ownIds();
  await send({ type: 'save_submission', commandId: crypto.randomUUID(), ...(editing.value ? { submissionId: editing.value.id } : {}), expectedSubmissionRevision: editing.value?.revision ?? 0, contextBeatId: captured.beatId, expectedInputEpoch: captured.epoch, ...linePayload(lineKind), alreadySpokenAloud: true });
  finishLine(lineKind);
  receipt.value = lineKind === 'ooc' ? 'Saved. Only the director sees your note.' : 'Saved. The director has your line.';
  receiptFor.value = editedId ?? newOwnId(before);
}); }

function pauseRequest() { return work(async () => {
  receipt.value = ''; receiptFor.value = null;
  const captured = context();
  const before = ownIds();
  await send({ type: 'save_submission', commandId: crypto.randomUUID(), expectedSubmissionRevision: 0, contextBeatId: captured.beatId, expectedInputEpoch: captured.epoch, kind: 'ooc', text: PAUSE_REQUEST_TEXT, recipientNpcIds: [], intent: '', approach: '', stageDirection: '', alreadySpokenAloud: true });
  receipt.value = 'Pause requested. Say so on the voice call too.';
  receiptFor.value = newOwnId(before);
}); }

// Words already in a box when Change is pressed wait here, and come back when the change is saved or cancelled.
type SetAside = { kind: LineKind; mode: LineKind; text: string; context: InputContext | null; recipient: string; recipientTouched: boolean; stageDirection: string };
const setAside = ref<SetAside | null>(null);
const setText = (lineKind: LineKind, text: string) => { ({ say: sayText, act: actionText, ooc: noteText })[lineKind].value = text; };

function finishLine(lineKind: LineKind) {
  const kept = setAside.value?.kind === lineKind ? setAside.value : null;
  setAside.value = null;
  setText(lineKind, kept?.text ?? '');
  if (lineKind === 'say') {
    assistKey.value += 1;
    stageDirection.value = kept?.stageDirection ?? '';
    if (kept) {
      recipient.value = kept.recipient; recipientTouched.value = kept.recipientTouched;
      if (snapshot.value) defaultRecipient(snapshot.value);
    }
  }
  contexts.value[lineKind] = kept?.text.trim() ? kept.context : null;
  editing.value = null; draftRestored.value = false;
  if (![sayText.value, actionText.value, noteText.value].some(text => text.trim()) && ownCharacterId.value) clearDraft(sessionId, ownCharacterId.value);
  if (kept && (kept.mode !== 'ooc' || noteText.value.trim())) kind.value = kept.mode;
  else if (kept || lineKind === 'ooc') kind.value = turnDefault.value;
}
function cancel() {
  if (editing.value) finishLine(editing.value.kind);
  else kind.value = turnDefault.value;
}
const actionOf = (item: Submission) => !item.approach.trim() || item.approach.trim() === item.intent.trim() ? item.intent : `${item.intent}\n${item.approach}`;
function returnWords(item: Submission) {
  const lineKind = item.kind;
  const words = lineKind === 'act' ? actionOf(item) : item.text;
  const held = textOf(lineKind);
  if (lineKind === 'say') {
    if (!held.trim()) { recipient.value = item.recipientNpcIds[0] ?? ''; recipientTouched.value = true; }
    if (!stageDirection.value.trim()) stageDirection.value = item.stageDirection;
  }
  setText(lineKind, held.trim() ? `${held}\n${words}` : words);
  receipt.value = ''; receiptFor.value = null;
  kind.value = lineKind;
  contexts.value[lineKind] = context();
}
function editSubmission(item: Submission) {
  if (editing.value && editing.value.kind !== item.kind) finishLine(editing.value.kind);
  if (!editing.value) setAside.value = { kind: item.kind, mode: kind.value, text: textOf(item.kind), context: contexts.value[item.kind], recipient: recipient.value, recipientTouched: recipientTouched.value, stageDirection: stageDirection.value };
  kind.value = item.kind;
  if (item.kind === 'say') { sayText.value = item.text; recipient.value = item.recipientNpcIds[0] ?? ''; recipientTouched.value = true; stageDirection.value = item.stageDirection; }
  else if (item.kind === 'act') actionText.value = actionOf(item);
  else noteText.value = item.text;
  editing.value = item;
  receipt.value = ''; receiptFor.value = null;
  contexts.value[item.kind] = context();
}
function withdraw(item: Submission) { return work(async () => {
  await send({ type: 'cancel_submission', commandId: crypto.randomUUID(), submissionId: item.id, expectedSubmissionRevision: item.revision });
  if (item.kind === 'ooc' && item.text === PAUSE_REQUEST_TEXT) return;
  // Taking back any line ends a change in progress, as Cancel would, so Save changes can never point at the wrong line.
  if (editing.value) finishLine(editing.value.kind);
  returnWords(item);
}); }
async function startEdit(item: Submission) {
  editSubmission(item);
  await nextTick();
  const field = formPanel.value?.querySelector<HTMLElement>('textarea');
  formPanel.value?.scrollIntoView?.({ block: 'start' });
  field?.focus();
}
async function askPrivately() {
  kind.value = 'ooc';
  await nextTick();
  formPanel.value?.querySelector<HTMLElement>('[data-testid="note-input"]')?.focus();
}
</script>

<template>
  <template v-if="snapshot && player">
    <div class="seat">
      <header class="seat-heading" :class="{ 'with-picture': showable(scenePictureSrc) }">
        <img v-if="showable(scenePictureSrc)" class="seat-scene-picture" :src="scenePictureSrc!" :alt="snapshot.session.scene.title" @error="pictureFailed(scenePictureSrc)">
        <div v-if="showable(scenePictureSrc)"><p class="eyebrow">{{ snapshot.session.title }}</p><h1>{{ snapshot.session.scene.title }}</h1></div>
        <template v-else><p class="eyebrow">{{ snapshot.session.title }}</p><h1>{{ snapshot.session.scene.title }}</h1></template>
      </header>
      <section class="character">
        <template v-if="player.ownCharacter">
          <p class="playing">You are playing</p><h2>{{ player.ownCharacter.displayName }}</h2>
          <details v-if="card.length || showable(ownPortraitSrc)" class="card"><summary>Who is {{ player.ownCharacter.displayName }}?</summary><img v-if="showable(ownPortraitSrc)" class="own-portrait" :src="ownPortraitSrc!" :alt="portraitAlt(name)" @error="pictureFailed(ownPortraitSrc)"><dl><template v-for="row in card" :key="row.label"><dt>{{ row.label }}</dt><dd>{{ row.value }}</dd></template></dl></details>
          <SeatVoice :snapshot="player" :busy="busy" @command="command => work(() => send(command))" />
        </template>
        <template v-else><h2>Unassigned seat</h2><p class="notice">This seat has no character yet. Ask the director.</p></template>
      </section>
      <div class="player-status" :data-tone="status.tone" aria-live="polite"><span class="tone">{{ toneLabel }}</span><strong>{{ status.headline }}</strong><span>{{ status.detail }}</span></div>
      <SeatStory :history="snapshot.history" :characters="snapshot.characters" :session-id="sessionId" />
      <details class="how"><summary>How this works</summary><ol><li>Follow the story on the stream.</li><li>Press Say something or Do something, then write in the box.</li><li>Press Send. The director picks lines, and the story goes on.</li></ol></details>
      <section ref="formPanel" class="panel form-panel">
        <form data-testid="submission-form" @submit.prevent="saveSubmission">
          <div class="modes" role="group" aria-label="What do you want to send?">
            <button type="button" class="secondary" :aria-pressed="kind === 'say'" :disabled="Boolean(editing)" @click="kind = 'say'">Say something</button>
            <button type="button" class="secondary" :aria-pressed="kind === 'act'" :disabled="Boolean(editing)" @click="kind = 'act'">Do something</button>
          </div>
          <template v-if="kind === 'say'">
            <div><label>What {{ name }} says<textarea :aria-describedby="helpId('say')" v-model="sayText" data-testid="speech-input" rows="4" maxlength="4000" required placeholder="Type the exact words" @input="beginInput" /></label><LineAssist :key="assistKey" :session-id="sessionId" :idea="sayText" :recipient-npc-ids="recipient ? [recipient] : []" :can-send="Boolean(player.ownCharacter) && playerReady && snapshot.session.status !== 'ended' && !busy" @use="text => { sayText = text; beginInput(); }" /><p :id="helpId('say')" class="field-help">Viewers see these words on stream, and hear them read aloud, once the director puts them in the story. Words in square brackets, like [laughs], set how the line is read and are never shown.</p></div>
            <div v-if="presentNpcs.length === 1 && !changingRecipient" class="talking"><span data-testid="talking-to">{{ talkingTo }}</span><button type="button" class="quiet" data-testid="talking-to-change" @click="changingRecipient = true">Change</button></div>
            <div v-else-if="presentNpcs.length"><label>Talking to<select :aria-describedby="helpId('recipient')" v-model="recipient" @change="recipientTouched = true; beginInput()"><option value="">Your group</option><option v-for="npc in presentNpcs" :key="npc.id" :value="npc.id">{{ npc.displayName }} · {{ npc.role }}</option></select></label><p :id="helpId('recipient')" class="field-help">Pick who {{ name }} is talking to. Your group means the other players' characters.</p></div>
          </template>
          <div v-else-if="kind === 'act'"><label>What {{ name }} does<textarea :aria-describedby="helpId('act')" v-model="actionText" data-testid="action-input" rows="4" maxlength="2000" required placeholder="Climb the fire escape and look in the window" @input="beginInput" /></label><p :id="helpId('act')" class="field-help">Describe it in plain words. Viewers see these words on stream as you write them, and hear them read aloud, once the director puts them in the story. Sometimes dice decide how it goes.</p></div>
          <div v-else><label>Private note for the director<textarea :aria-describedby="helpId('note')" v-model="noteText" data-testid="note-input" rows="3" maxlength="4000" required @input="beginInput" /></label><p :id="helpId('note')" class="field-help">Only the director sees this. It never appears on stream.</p></div>
          <div class="actions"><button class="send" :disabled="busy || !player.ownCharacter || (kind !== 'ooc' && !playerReady)">{{ submitLabel }}</button><button v-if="editing || kind === 'ooc'" type="button" class="quiet" @click="cancel">Cancel</button></div>
          <p v-if="receipt" class="notice" role="status">{{ receipt }}</p>
          <small v-if="activeContext">Not sent yet</small>
          <small v-if="draftRestored" class="draft-restored">Your unsent words are back.</small>
          <small v-if="editing">You are changing a line you already sent.</small>
          <div v-if="activeContext && (activeContext.epoch !== snapshot.session.inputEpoch || activeContext.beatId !== context().beatId)" class="notice">The story moved on while you were typing. Read your words again. Do they still fit?<button type="button" class="secondary" data-testid="review-current-input" @click="contexts[kind] = context()">Yes, they still fit</button></div>
        </form>
      </section>
      <SubmissionList :submissions="player.submissions" :npcs="snapshot.npcs" :busy="busy" @edit="startEdit" @withdraw="withdraw" />
      <div class="extras"><button type="button" class="quiet" :disabled="Boolean(editing)" @click="askPrivately">Ask the director privately</button><button type="button" class="quiet" :disabled="busy" @click="pauseRequest()">Ask for a pause</button><a :href="identityPath(`/sessions/${sessionId}/lobby`)">Cast & lobby</a></div>
    </div>
  </template>
</template>

<style scoped>
.seat { display: grid; gap: 24px; max-width: 800px; margin: 0 auto; min-width: 0; }
.seat > *, .seat > .panel, .seat > .notice { margin: 0; min-width: 0; }
.seat-heading .eyebrow { margin-bottom: 8px; }
.seat-heading h1 { margin: 0; overflow-wrap: anywhere; }
.seat-heading.with-picture { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 16px; align-items: center; }
.seat-scene-picture { width: 180px; aspect-ratio: 1344 / 768; object-fit: cover; padding: 2px; background: var(--void); clip-path: var(--cut-1); }
.own-portrait { float: right; width: 120px; height: 120px; object-fit: cover; padding: 2px; background: var(--void); clip-path: var(--cut-1); margin: 8px 0 8px 16px; }
.character .playing { color: var(--dust); margin: 0 0 4px; }
.character h2 { margin: 0; overflow-wrap: anywhere; }
.character .notice { margin: 16px 0 0; }
.card { margin-top: 8px; }
.card dl { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 8px 16px; margin: 8px 0 0; }
.card dt { color: var(--dust); font-size: 20px; line-height: 24px; }
.card dd { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; min-width: 0; }
.player-status { --tone-colour: var(--dust); display: grid; gap: 4px; background: var(--night); box-shadow: inset 8px 0 0 0 var(--tone-colour), var(--frame-window); clip-path: var(--cut-1); padding: 12px 16px 12px 24px; }
.player-status[data-tone="act"] { --tone-colour: var(--candle); }
.player-status[data-tone="done"] { --tone-colour: var(--herb); }
.player-status .tone { color: var(--dust); font-family: var(--font-label); font-size: 16px; line-height: 20px; text-transform: uppercase; }
.player-status strong { font-size: 20px; line-height: 24px; }
.player-status span:last-child { color: var(--dust); font-size: 20px; line-height: 24px; }
.how ol { display: grid; gap: 4px; margin: 4px 0 0; padding-left: 28px; line-height: 28px; }
.card > summary, .how > summary, .sound > summary { cursor: pointer; min-height: 44px; padding-block: 10px; box-sizing: border-box; }
.card > summary::before, .how > summary::before, .sound > summary::before { top: 16px; }
.card[open] > summary::before, .how[open] > summary::before, .sound[open] > summary::before { top: 18px; }
.notice a { display: inline-flex; align-items: center; min-height: 44px; }
.talking { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; }
.modes { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.modes button[aria-pressed="true"] { color: var(--candle); }
.modes button[aria-pressed="true"]::before { background: var(--night-raised); box-shadow: inset 0 0 0 2px var(--void), inset 0 0 0 4px var(--candle), inset 0 0 0 6px var(--void); }
.form-panel .notice { margin: 0; }
.form-panel .notice button { margin-top: 12px; display: flex; }
.form-panel small { display: block; }
.extras { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; }
.extras a { display: inline-flex; align-items: center; min-height: 44px; padding: 0 8px; }
@media (max-width: 760px) {
  .seat-scene-picture { width: 140px; }
  .form-panel { padding: 16px; }
  .actions .send { flex: 1 1 100%; }
  .card dl { grid-template-columns: minmax(0, 1fr); gap: 4px; }
  .card dd { margin-bottom: 8px; }
}
@media (max-width: 480px) {
  .seat-heading h1 { font-size: 24px; line-height: 24px; }
}
</style>
