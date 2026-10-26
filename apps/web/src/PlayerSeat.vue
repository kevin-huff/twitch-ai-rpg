<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, useId, watch } from 'vue';
import type { SessionSnapshot, Submission } from '@rpg/contracts';
import { identityPath } from './identity';
import { pictureUrl, portraitAlt, shownScenePicture } from './pictures';
import { PAUSE_REQUEST_TEXT, useTable } from './table';
import { playerStatus } from './player-status';
import { clearDraft, loadDraft, saveDraft } from './drafts';
import AudioPanel from './AudioPanel.vue';
import SubmissionList from './SubmissionList.vue';

type LineKind = 'say' | 'act' | 'ooc';

const helpPrefix = useId();
const helpId = (...parts: (string | number)[]) => `${helpPrefix}-help-${encodeURIComponent(JSON.stringify(parts))}`;

const table = useTable();
const { sessionId, snapshot, busy, player, latestHistory, send, work, onSnapshot } = table;
const context = table.inputContext;

const playerReady = computed(() => !player.value?.setup || Boolean(player.value.setup.started && player.value.ownCharacter?.approved && player.value.ownCharacter.ready && player.value.ownCharacter.acceptedBoundariesRevision === player.value.setup.boundariesRevision));

const kind = ref<LineKind>('say');
const sayText = ref('');
const actionText = ref('');
const noteText = ref('');
const recipient = ref('');
const stageDirection = ref('');
const receipt = ref('');
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

const status = computed(() => playerStatus({ sessionStatus: snapshot.value?.session.status ?? 'live', ready: playerReady.value, beat: player.value?.activeBeat ?? null, own: player.value?.submissions ?? [], name: player.value?.ownCharacter?.displayName, inputEpoch: snapshot.value?.session.inputEpoch }));
const toneLabel = computed(() => ({ wait: 'Hold on', act: 'Your turn', done: 'Sent' })[status.value.tone]);
const presentNpcs = computed(() => snapshot.value?.npcs.filter(npc => npc.status === 'present') ?? []);
const submitLabel = computed(() => busy.value ? 'Sending…' : editing.value ? 'Save changes' : kind.value === 'ooc' ? 'Send privately' : 'Send');

function defaultRecipient(next: SessionSnapshot) {
  const present = next.npcs.filter(npc => npc.status === 'present');
  if (recipient.value ? !present.some(npc => npc.id === recipient.value) : !recipientTouched.value) recipient.value = present[0]?.id ?? '';
}
if (snapshot.value) defaultRecipient(snapshot.value);
const unregister = onSnapshot(defaultRecipient);
onUnmounted(unregister);

function linePayload(lineKind: LineKind) {
  if (lineKind === 'say') return { kind: 'say' as const, text: sayText.value, intent: '', approach: '', recipientNpcIds: recipient.value ? [recipient.value] : [], stageDirection: stageDirection.value };
  if (lineKind === 'act') return { kind: 'act' as const, text: '', intent: actionText.value, approach: actionText.value, recipientNpcIds: [], stageDirection: '' };
  return { kind: 'ooc' as const, text: noteText.value, intent: '', approach: '', recipientNpcIds: [], stageDirection: '' };
}

function saveSubmission() { return work(async () => {
  receipt.value = '';
  const lineKind = kind.value;
  const captured = contexts.value[lineKind] ?? context();
  await send({ type: 'save_submission', commandId: crypto.randomUUID(), ...(editing.value ? { submissionId: editing.value.id } : {}), expectedSubmissionRevision: editing.value?.revision ?? 0, contextBeatId: captured.beatId, expectedInputEpoch: captured.epoch, ...linePayload(lineKind), alreadySpokenAloud: true });
  finishLine(lineKind);
  receipt.value = lineKind === 'ooc' ? 'Saved. Only the director sees your note.' : 'Saved. The director has your line.';
}); }

function pauseRequest() { return work(async () => {
  receipt.value = '';
  const captured = context();
  await send({ type: 'save_submission', commandId: crypto.randomUUID(), expectedSubmissionRevision: 0, contextBeatId: captured.beatId, expectedInputEpoch: captured.epoch, kind: 'ooc', text: PAUSE_REQUEST_TEXT, recipientNpcIds: [], intent: '', approach: '', stageDirection: '', alreadySpokenAloud: true });
  receipt.value = 'Pause requested. Say so on the voice call too.';
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
function editSubmission(item: Submission) {
  if (editing.value && editing.value.kind !== item.kind) finishLine(editing.value.kind);
  if (!editing.value) setAside.value = { kind: item.kind, mode: kind.value, text: textOf(item.kind), context: contexts.value[item.kind], recipient: recipient.value, recipientTouched: recipientTouched.value, stageDirection: stageDirection.value };
  kind.value = item.kind;
  if (item.kind === 'say') { sayText.value = item.text; recipient.value = item.recipientNpcIds[0] ?? ''; recipientTouched.value = true; stageDirection.value = item.stageDirection; }
  else if (item.kind === 'act') actionText.value = !item.approach.trim() || item.approach.trim() === item.intent.trim() ? item.intent : `${item.intent}\n${item.approach}`;
  else noteText.value = item.text;
  editing.value = item;
  contexts.value[item.kind] = context();
}
function withdraw(item: Submission) { return work(async () => {
  await send({ type: 'cancel_submission', commandId: crypto.randomUUID(), submissionId: item.id, expectedSubmissionRevision: item.revision });
  if (editing.value?.id === item.id) finishLine(item.kind);
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
        </template>
        <template v-else><h2>Unassigned seat</h2><p class="notice">This seat has no character yet. Ask the director.</p></template>
      </section>
      <div class="player-status" :data-tone="status.tone" aria-live="polite"><span class="tone">{{ toneLabel }}</span><strong>{{ status.headline }}</strong><span>{{ status.detail }}</span></div>
      <details open class="how"><summary>How this works</summary><ol><li>Follow the story on the stream.</li><li>Press Say something or Do something, then write in the box.</li><li>Press Send. The director picks lines, and the story goes on.</li></ol></details>
      <p v-if="player.ownCharacter && !playerReady" class="notice">Finish setup before you play. Open Cast & lobby, read your character card, tick the box and press Mark ready. <a :href="identityPath(`/sessions/${sessionId}/lobby`)">Open Cast & lobby</a></p>
      <section ref="formPanel" class="panel form-panel">
        <form data-testid="submission-form" @submit.prevent="saveSubmission">
          <div class="modes" role="group" aria-label="What do you want to send?">
            <button type="button" class="secondary" :aria-pressed="kind === 'say'" :disabled="Boolean(editing)" @click="kind = 'say'">Say something</button>
            <button type="button" class="secondary" :aria-pressed="kind === 'act'" :disabled="Boolean(editing)" @click="kind = 'act'">Do something</button>
          </div>
          <template v-if="kind === 'say'">
            <div><label>What {{ name }} says<textarea :aria-describedby="helpId('say')" v-model="sayText" data-testid="speech-input" rows="4" maxlength="4000" required placeholder="Type the exact words" @input="beginInput" /></label><p :id="helpId('say')" class="field-help">Viewers see these words on stream exactly as you type them, once the director puts them in the story.</p></div>
            <div v-if="presentNpcs.length"><label>Talking to<select :aria-describedby="helpId('recipient')" v-model="recipient" @change="recipientTouched = true; beginInput()"><option value="">Your group</option><option v-for="npc in presentNpcs" :key="npc.id" :value="npc.id">{{ npc.displayName }} · {{ npc.role }}</option></select></label><p :id="helpId('recipient')" class="field-help">Pick who {{ name }} is talking to. Your group means the other players' characters.</p></div>
          </template>
          <div v-else-if="kind === 'act'"><label>What {{ name }} does<textarea :aria-describedby="helpId('act')" v-model="actionText" data-testid="action-input" rows="4" maxlength="2000" required placeholder="Climb the fire escape and look in the window" @input="beginInput" /></label><p :id="helpId('act')" class="field-help">Describe it in plain words. The storyteller tells what happens, and sometimes dice decide how it goes.</p></div>
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
      <AudioPanel compact :session-id="sessionId" :beat-id="latestHistory[0]?.id" :director="false" />
    </div>
  </template>
</template>

<style scoped>
.seat { display: grid; gap: 1.2rem; max-width: 40rem; margin: 0 auto; min-width: 0; }
.seat > *, .seat > .panel, .seat > .notice { margin: 0; min-width: 0; }
.seat-heading .eyebrow { margin-bottom: .4rem; }
.seat-heading h1 { margin: 0; overflow-wrap: anywhere; }
.seat-heading.with-picture { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 1rem; align-items: center; }
.seat-scene-picture { width: 9rem; aspect-ratio: 1344 / 768; object-fit: cover; border-radius: 6px; border: 1px solid var(--line); }
.own-portrait { float: right; width: 6rem; height: 6rem; object-fit: cover; border-radius: 8px; margin: .4rem 0 .4rem .8rem; }
.character .playing { color: var(--muted); margin: 0 0 .2rem; }
.character h2 { margin: 0; overflow-wrap: anywhere; }
.character .notice { margin: .8rem 0 0; }
.card { margin-top: .4rem; }
.card dl { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: .4rem 1rem; margin: .4rem 0 0; }
.card dt { color: var(--muted); font-size: .86rem; }
.card dd { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; min-width: 0; }
.player-status { display: grid; gap: .2rem; border: 1px solid var(--line); border-left: 4px solid var(--muted); border-radius: 6px; background: var(--panel); padding: .8rem 1rem; }
.player-status[data-tone="act"] { border-left-color: var(--gold); }
.player-status[data-tone="done"] { border-left-color: var(--teal); }
.player-status .tone { color: var(--muted); font-size: .75rem; letter-spacing: .08em; text-transform: uppercase; }
.player-status strong { font-size: 1.05rem; }
.player-status span:last-child { color: var(--muted); font-size: .9rem; }
.how ol { display: grid; gap: .3rem; margin: .3rem 0 0; padding-left: 1.4rem; line-height: 1.55; }
.card > summary, .how > summary { cursor: pointer; min-height: 44px; padding-block: .6rem; box-sizing: border-box; }
.notice a { display: inline-flex; align-items: center; min-height: 44px; }
.modes { display: grid; grid-template-columns: 1fr 1fr; gap: .6rem; }
.modes button[aria-pressed="true"] { border-color: var(--gold); color: var(--gold); background: rgb(221 186 118 / 12%); background: color-mix(in srgb, var(--gold) 12%, transparent); }
.form-panel .notice { margin: 0; }
.form-panel .notice button { margin-top: .6rem; display: flex; }
.form-panel small { display: block; }
.extras { display: flex; flex-wrap: wrap; align-items: center; gap: .4rem .8rem; }
.extras a { display: inline-flex; align-items: center; min-height: 44px; padding: 0 .5rem; }
@media (max-width: 760px) {
  .seat-scene-picture { width: 7rem; }
  .form-panel { padding: 1.1rem; }
  .actions .send { flex: 1 1 100%; }
  .card dl { grid-template-columns: minmax(0, 1fr); gap: .1rem; }
  .card dd { margin-bottom: .5rem; }
}
</style>
