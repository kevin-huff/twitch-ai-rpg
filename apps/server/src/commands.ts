import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  AiDraftSchema, ActionContractSchema, type AiProvider, type Beat, type Command, type CommandResponse,
  type ContinuityUpdate, type CorrectionChange, type Effect, type ProviderContext, type PublicCorrection, type PublishedBeat, type ScriptSegment, type SessionState, type Submission,
} from '@rpg/contracts';
import { applyResolution, resolveContracts, validateContracts } from '@rpg/rules';
import { transaction } from './database';
import { attachPreparedAudio } from './draft-audio';
import { finishUsageAttempt, startUsageAttempt } from './operations';
import { AppError, authorize, conflict, corrections, currentBeat, history, project, readState, saveBeat, saveState, saveSubmission, submissions, type Actor } from './repository';

export const digest = (data: unknown) => createHash('sha256').update(JSON.stringify(data)).digest('hex');
const liveCommands = new Set(['change_scene', 'save_npc', 'reveal_npc', 'record_correction', 'set_beat_steering']);
const directorCommands = new Set([...liveCommands, 'approve_character', 'set_boundaries', 'start_session', 'open_beat', 'plan_beat', 'approve_stakes', 'lock_beat', 'render_beat', 'edit_script', 'approve_continuity', 'publish_beat', 'abort_beat', 'set_status']);

export async function recordEvent(client: PoolClient, sessionId: string, actor: string | { actor_id: string; producer_grant_id?: string | null }, commandId: string, kind: string, revision: number, data: unknown = {}, eventId = randomUUID()) {
  const actorId = typeof actor === 'string' ? actor : actor.actor_id;
  const producerGrantId = typeof actor === 'string' ? null : actor.producer_grant_id ?? null;
  const result = await client.query('INSERT INTO audit_events(id,session_id,actor_id,command_id,kind,data,producer_grant_id) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING sequence', [eventId, sessionId, actorId, commandId, kind, data, producerGrantId]);
  await client.query('INSERT INTO outbox(event_id,session_id,revision) VALUES($1,$2,$3)', [eventId, sessionId, revision]);
  return { eventId, eventSeq: Number(result.rows[0].sequence) };
}

async function receipt(client: PoolClient, actor: Actor, commandId: string, requestHash: string): Promise<CommandResponse | null> {
  const found = await client.query('SELECT request_hash,response FROM command_receipts WHERE actor_id=$1 AND command_id=$2', [actor.actor_id, commandId]);
  if (!found.rowCount) return null;
  if (found.rows[0].request_hash !== requestHash) conflict('This command ID was already used with different input.');
  return found.rows[0].response;
}
async function finish(client: PoolClient, sessionId: string, actor: Actor, command: Command, requestHash: string): Promise<CommandResponse> {
  const snapshot = await project(client, sessionId, actor);
  const response = { commandId: command.commandId, eventSeq: snapshot.eventSeq, snapshot };
  await client.query('INSERT INTO command_receipts(actor_id,command_id,request_hash,session_id,response) VALUES($1,$2,$3,$4,$5)', [actor.actor_id, command.commandId, requestHash, sessionId, response]);
  return response;
}

function checkBeat(beat: Beat | null, command: Command): asserts beat is Beat {
  if (!beat || !('beatId' in command) || command.beatId !== beat.id) throw new AppError(409, 'conflict', 'This beat is no longer active. Refresh before continuing.');
  if (command.expectedBeatRevision !== beat.revision) conflict('The beat changed. Review the latest version.');
}
async function carryUnconsumed(client: PoolClient, beat: Beat, all: Submission[]) {
  const carried = [];
  for (const submission of all) {
    if (!['queued', 'selected'].includes(submission.status) || (submission.contextBeatId !== beat.id && !beat.selectedSubmissionIds.includes(submission.id))) continue;
    carried.push({ submissionId: submission.id, sourceBeatId: beat.id, previousContextBeatId: submission.contextBeatId, inputEpoch: submission.inputEpoch, revision: submission.revision });
    submission.contextBeatId = null;
    submission.status = 'queued';
    await saveSubmission(client, submission);
  }
  return carried;
}

function validateSources(updates: ContinuityUpdate[], beat: Beat, state: SessionState) {
  for (const update of updates) {
    if (!update.sourceSubmissionIds.every((id) => beat.lockedSubmissions.some((submission) => submission.id === id))) conflict('Continuity must cite accepted player input.');
    if (update.kind === 'npc_knowledge') {
      if (!state.npcs.some((npc) => npc.id === update.npcId && ((npc.status === 'present' && npc.locationId === state.session.scene.locationId) || npc.communicationChannel))) conflict('That NPC cannot witness this exchange.');
      if (update.sourceEntityId && !beat.lockedSubmissions.some((submission) => submission.characterId === update.sourceEntityId && update.sourceSubmissionIds.includes(submission.id))) conflict('The knowledge source does not match its submission.');
    }
  }
}
function validateDraft(draft: unknown, state: SessionState, beat: Beat) {
  const parsed = AiDraftSchema.parse(draft);
  for (const segment of parsed.segments) {
    if (segment.kind === 'npc_dialogue') {
      const speaker = state.npcs.find((npc) => npc.id === segment.speakerNpcId);
      if (!speaker || ((speaker.status !== 'present' || speaker.locationId !== state.session.scene.locationId) && !speaker.communicationChannel)) conflict('An NPC speaker is unknown or unavailable.');
    }
    if (segment.recipientCharacterIds.some((id) => !state.characters.some((character) => character.id === id))) conflict('An unknown player is addressed.');
  }
  validateSources(parsed.continuity, beat, state);
  return parsed;
}
function safeContext(state: SessionState, beat: Beat, selected: Submission[], published: ProviderContext['history'], publicCorrections: PublicCorrection[]): ProviderContext {
  const safe = structuredClone(state);
  safe.directorNotes = '';
  safe.locations = [];
  safe.characters = safe.characters.map((character) => ({ ...character, secret: '', backstory: '', draft: null, templateRef: null }));
  const addressed = new Set(selected.flatMap((submission) => submission.recipientNpcIds));
  safe.npcs = safe.npcs.filter((npc) => ((npc.status === 'present' && npc.locationId === state.session.scene.locationId) || npc.communicationChannel) && (!addressed.size || addressed.has(npc.id))).map((npc) => ({ ...npc, secrets: [], hiddenIdentity: null }));
  safe.facts = safe.facts.filter((fact) => fact.visibility === 'public');
  safe.tracks = safe.tracks.filter((track) => track.visibility === 'public');
  return { state: safe, beat: structuredClone(beat), submissions: structuredClone(selected), history: published.slice(-12), corrections: publicCorrections.slice(-12) };
}

function validateCorrections(changes: CorrectionChange[], state: SessionState) {
  const targets = new Set<string>();
  const memories = new Set<string>();
  for (const change of changes) {
    const targetId = change.kind === 'fact_replace' ? change.factId : change.kind === 'strain_set' ? change.characterId : change.trackId;
    const target = JSON.stringify([change.kind, targetId]);
    if (targets.has(target)) conflict('Correct each fact, character strain, or track only once.');
    targets.add(target);
    if (change.kind === 'strain_set') {
      const character = state.characters.find(item => item.id === change.characterId);
      if (!character) conflict('That character no longer exists.');
      if (character!.strain === change.value) conflict('A strain correction must change the current value.');
    } else if (change.kind === 'track_set') {
      const track = state.tracks.find(item => item.id === change.trackId && item.visibility === 'public');
      if (!track) conflict('Only an existing public track can be corrected.');
      if (change.value > track!.max) conflict('The corrected value exceeds this track’s maximum.');
      if (track!.current === change.value) conflict('A track correction must change the current value.');
    } else {
      const fact = state.facts.find(item => item.id === change.factId && item.visibility === 'public');
      if (!fact) conflict('Only an existing public fact can be corrected.');
      if (fact!.text === change.text) conflict('A fact correction must change its current text.');
      const affected = new Set(state.npcs.flatMap(npc => npc.knowledge
        .filter(memory => memory.category === 'fact' && memory.statement === fact!.text)
        .map(memory => JSON.stringify([npc.id, memory.id]))));
      if (change.knowledgeUpdates.length !== affected.size) conflict('Choose a correction or retained belief for every affected factual memory.');
      for (const update of change.knowledgeUpdates) {
        const key = JSON.stringify([update.npcId, update.knowledgeId]);
        if (!affected.has(key)) conflict('A selected memory is unknown or does not contain this fact.');
        if (memories.has(key)) conflict('Update each affected memory only once across this correction.');
        memories.add(key);
      }
    }
  }
}
function makeScript(beat: Beat, state: SessionState): ScriptSegment[] {
  const quotes: ScriptSegment[] = beat.lockedSubmissions.filter((submission) => submission.kind !== 'ooc' && submission.text.trim()).map((submission) => ({
    id: randomUUID(), kind: 'player_dialogue', text: submission.text,
    speaker: { entityId: submission.characterId, displayName: state.characters.find((character) => character.id === submission.characterId)!.displayName },
    recipientCharacterIds: [], delivery: 'neutral', sourceSubmissionIds: [submission.id], voiceProfileId: null, ttsEnabled: false,
  }));
  const segments: ScriptSegment[] = beat.draft!.segments.map((segment) => {
    const npc = segment.kind === 'npc_dialogue' ? state.npcs.find((npc) => npc.id === segment.speakerNpcId)! : null;
    return { id: randomUUID(), kind: segment.kind, text: segment.text, speaker: npc ? { entityId: npc.id, displayName: npc.displayName } : null,
      recipientCharacterIds: segment.recipientCharacterIds, delivery: segment.delivery, sourceSubmissionIds: beat.lockedSubmissions.map((submission) => submission.id), voiceProfileId: npc?.voiceProfileId ?? 'voice_narrator', ttsEnabled: false };
  });
  return [...quotes, ...segments];
}

export interface CommandDependencies { pool: Pool; provider: AiProvider; rollDie: () => number; providerTimeoutMs?: number; authenticate?(client: PoolClient): Promise<Actor> }
export async function executeCommand(deps: CommandDependencies, sessionId: string, actor: Actor, command: Command): Promise<CommandResponse> {
  if (actor.role === 'stage' || (directorCommands.has(command.type) && actor.role !== 'host')) throw new AppError(403, 'forbidden', 'This command requires a director.');
  if (['save_character', 'set_ready', 'save_submission', 'cancel_submission'].includes(command.type) && actor.role !== 'player') throw new AppError(403, 'forbidden', 'Use the assigned player seat to submit dialogue or actions.');
  const requestHash = digest({ sessionId, command });
  const prepared = await transaction(deps.pool, async (client) => {
    await authorize(client, sessionId, actor);
    await client.query('SELECT id FROM sessions WHERE id=$1 FOR UPDATE', [sessionId]);
    if (deps.authenticate) {
      const current = await deps.authenticate(client);
      if (current.actor_id !== actor.actor_id || current.role !== actor.role) throw new AppError(401, 'unauthorized', 'Sign in again before continuing.');
      await authorize(client, sessionId, current);
    }
    const duplicate = await receipt(client, actor, command.commandId, requestHash);
    if (duplicate) return { response: duplicate };
    let state = await readState(client, sessionId);
    let beat = await currentBeat(client, sessionId);
    const all = await submissions(client, sessionId);
    let eventData: Record<string, unknown> = {};
    if (state.session.status === 'ended') conflict('This session has ended.');
    if (state.session.status === 'paused' && command.type !== 'set_status' && command.type !== 'save_submission' && command.type !== 'set_ready' && !liveCommands.has(command.type)) conflict('Resume the session before advancing the story.');

    if (command.type === 'record_correction') {
      if (!['live', 'paused'].includes(state.session.status) || (state.setup && !state.setup.started)) conflict('Start the session before recording corrections.');
      if (beat) conflict('Finish or abort the active beat before correcting the published story.');
      if (command.expectedStateRevision !== state.session.stateRevision) conflict('The session changed. Review the current state before correcting it.');
      const published = (await client.query('SELECT beat_number FROM published_beats WHERE id=$1 AND session_id=$2', [command.publishedBeatId, sessionId])).rows[0];
      if (!published) throw new AppError(404, 'not_found', 'That published beat was not found in this session.');
      validateCorrections(command.changes, state);
      const before = { facts: structuredClone(state.facts), characters: structuredClone(state.characters), tracks: structuredClone(state.tracks), npcs: structuredClone(state.npcs) };
      const eventId = randomUUID();
      const changedNpcs = new Set<SessionState['npcs'][number]>();
      for (const change of command.changes) {
        if (change.kind === 'strain_set') state.characters.find(item => item.id === change.characterId)!.strain = change.value;
        else if (change.kind === 'track_set') state.tracks.find(item => item.id === change.trackId)!.current = change.value;
        else {
          const fact = state.facts.find(item => item.id === change.factId)!;
          fact.text = change.text; fact.sourceEventId = eventId;
          for (const update of change.knowledgeUpdates) {
            const npc = state.npcs.find(item => item.id === update.npcId)!;
            const memory = npc.knowledge.find(item => item.id === update.knowledgeId)!;
            if (update.mode === 'correct') memory.statement = change.text;
            else memory.category = 'belief';
            memory.sourceEventId = eventId; changedNpcs.add(npc);
          }
        }
      }
      for (const npc of changedNpcs) npc.version++;
      const cancelledSubmissionIds = [];
      for (const submission of all) {
        if (submission.kind === 'ooc' || !['queued', 'selected'].includes(submission.status)) continue;
        submission.status = 'cancelled'; submission.revision++;
        cancelledSubmissionIds.push(submission.id); await saveSubmission(client, submission);
      }
      state.session.stateRevision++; state.session.inputEpoch++;
      const publicCorrection: PublicCorrection = { id: eventId, publishedBeatId: command.publishedBeatId, beatNumber: published.beat_number,
        stateRevision: state.session.stateRevision, recordedAt: new Date().toISOString(), publicText: command.publicText };
      eventData = { public: publicCorrection, reason: command.reason, changes: command.changes, before,
        after: { facts: state.facts, characters: state.characters, tracks: state.tracks, npcs: state.npcs }, cancelledSubmissionIds };
      await recordEvent(client, sessionId, actor, command.commandId, 'correction.recorded', state.session.stateRevision, eventData, eventId);
      await saveState(client, state);
    } else if (command.type === 'change_scene' || command.type === 'save_npc' || command.type === 'reveal_npc') {
      if (!['live', 'paused'].includes(state.session.status) || (state.setup && !state.setup.started)) conflict('Start the session before changing the live scene or cast.');
      if (beat) conflict('Finish or abort the active beat before changing the scene or cast.');
      if (command.expectedStateRevision !== state.session.stateRevision) conflict('The session changed. Review the current state before continuing.');
      const before = { scene: structuredClone(state.session.scene), locations: structuredClone(state.locations), npcs: structuredClone(state.npcs) };
      const nextRevision = state.session.stateRevision + 1;
      let revealTarget: SessionState['npcs'][number] | undefined;
      let witnesses: SessionState['npcs'] = [];
      let privateSource: string | undefined;
      if (command.type === 'change_scene') {
        if (command.presentNpcIds.some(id => !state.npcs.some(npc => npc.id === id))) conflict('A selected NPC no longer exists.');
        let locationId: string;
        if (command.location.kind === 'existing') {
          locationId = command.location.locationId;
          if (!state.locations.some(location => location.id === locationId)) conflict('That location no longer exists.');
        } else {
          if (state.locations.length >= 100) conflict('A session supports at most 100 locations.');
          locationId = randomUUID();
          state.locations.push({ id: locationId, title: command.location.title, description: command.location.description });
        }
        state.session.scene = { id: randomUUID(), title: command.title, description: command.description, locationId };
        for (const npc of state.npcs) {
          if (command.presentNpcIds.includes(npc.id)) { npc.status = 'present'; npc.locationId = locationId; npc.version++; }
          else if (npc.status === 'present') { npc.status = 'offstage'; npc.version++; }
        }
      } else if (command.type === 'save_npc') {
        const npc = command.npcId ? state.npcs.find(item => item.id === command.npcId) : undefined;
        if (command.npcId && (!npc || npc.version !== command.expectedNpcVersion)) conflict('The NPC changed or no longer exists.');
        if (!state.locations.some(location => location.id === command.profile.locationId)) conflict('Choose a known location for this NPC.');
        if (command.profile.status === 'present' && command.profile.locationId !== state.session.scene.locationId) conflict('Present NPCs must be at the current scene location.');
        if (npc) { Object.assign(npc, command.profile); npc.version++; }
        else {
          if (state.npcs.length >= 50) conflict('A session supports at most 50 NPCs.');
          state.npcs.push({ ...command.profile, id: randomUUID(), knowledge: [], relationships: [], version: 1 });
        }
      } else {
        revealTarget = state.npcs.find(npc => npc.id === command.npcId);
        if (!revealTarget || revealTarget.version !== command.expectedNpcVersion) conflict('The NPC changed or no longer exists.');
        privateSource = command.source.kind === 'identity' ? revealTarget!.hiddenIdentity ?? undefined : revealTarget!.secrets[command.source.index];
        if (!privateSource?.trim()) conflict('Choose an existing nonblank secret or hidden identity.');
        witnesses = command.witnessNpcIds.map(id => {
          const npc = state.npcs.find(item => item.id === id);
          if (!npc || npc.status !== 'present' || npc.locationId !== state.session.scene.locationId) conflict('Every witness must be physically present in the current scene.');
          return npc!;
        });
      }
      const cancelledSubmissionIds = [];
      for (const submission of all) {
        if (submission.kind === 'ooc' || !['queued', 'selected'].includes(submission.status)) continue;
        submission.status = 'cancelled'; submission.revision++;
        cancelledSubmissionIds.push(submission.id); await saveSubmission(client, submission);
      }
      state.session.stateRevision = nextRevision; state.session.inputEpoch++;
      eventData = { reason: command.reason, before, cancelledSubmissionIds };
      if (command.type === 'reveal_npc') {
        // Allocate the event once; its identity is the source for both the fact and memories.
        const eventId = randomUUID();
        const fact = { id: randomUUID(), text: command.publicText, visibility: 'public' as const, sourceEventId: eventId };
        state.facts.push(fact);
        for (const npc of witnesses) npc.knowledge.push({ id: randomUUID(), statement: command.publicText, category: 'fact', acquisition: 'witnessed', sourceEventId: eventId, sourceEntityId: revealTarget!.id, learnedBeatNumber: state.session.beatNumber });
        for (const npc of new Set([revealTarget!, ...witnesses])) npc.version++;
        eventData = { ...eventData, source: command.source, privateSource, npcId: revealTarget!.id, witnessNpcIds: command.witnessNpcIds, fact };
        eventData.after = { scene: state.session.scene, locations: state.locations, npcs: state.npcs };
        await recordEvent(client, sessionId, actor, command.commandId, command.type, nextRevision, eventData, eventId);
      } else eventData.after = { scene: state.session.scene, locations: state.locations, npcs: state.npcs };
      await saveState(client, state);
    } else if (command.type === 'save_character' || command.type === 'approve_character' || command.type === 'set_ready' || command.type === 'set_boundaries' || command.type === 'start_session') {
      if (!state.setup) conflict('This session uses the original rehearsal cast rather than an editable lobby.');
      const setup = state.setup!;
      if (command.type !== 'set_ready' && (setup.started || state.session.status !== 'lobby')) conflict('Character and boundary setup is available only before the session starts.');
      if (command.type === 'save_character' || command.type === 'set_ready' || command.type === 'approve_character') {
        const characterId = command.type === 'approve_character' ? command.characterId : actor.character_id;
        const character = state.characters.find((item) => item.id === characterId);
        if (!character) throw new AppError(404, 'not_found', 'That character is not assigned to this session.');
        if (character.cardRevision !== command.expectedCharacterRevision) conflict('The character changed. Review the latest revision before continuing.');
        if (command.type === 'save_character') {
          character.draft = command.card; character.approved = false; character.ready = false; character.acceptedBoundariesRevision = null;
          eventData = { characterId: character.id, cardRevision: character.cardRevision + 1 };
        } else if (command.type === 'approve_character') {
          if (!character.draft) conflict('There is no pending character draft to approve.');
          const { schemaVersion: _schemaVersion, extensions: _extensions, ...approved } = character.draft!;
          Object.assign(character, approved);
          character.draft = null; character.approved = true; character.ready = false; character.acceptedBoundariesRevision = null;
          state.session.stateRevision++;
          eventData = { characterId: character.id, cardRevision: character.cardRevision + 1 };
        } else {
          if (command.expectedBoundariesRevision !== setup.boundariesRevision) conflict('The session boundaries changed. Read and acknowledge the current version.');
          if (command.ready && (!character.approved || character.draft)) conflict('The director must approve the current character before it can be marked ready.');
          character.ready = command.ready;
          character.acceptedBoundariesRevision = command.ready ? setup.boundariesRevision : null;
          eventData = { characterId: character.id, ready: command.ready, boundariesRevision: setup.boundariesRevision };
        }
        character.cardRevision++;
      } else if (command.type === 'set_boundaries') {
        if (command.expectedStateRevision !== state.session.stateRevision) conflict('The session changed. Review the current setup first.');
        setup.boundaries = command.boundaries; setup.boundariesRevision++;
        for (const character of state.characters) { character.ready = false; character.acceptedBoundariesRevision = null; character.cardRevision++; }
        state.session.stateRevision++;
        eventData = { boundariesRevision: setup.boundariesRevision };
      } else {
        if (command.expectedStateRevision !== state.session.stateRevision) conflict('The session changed. Review the current setup first.');
        if (state.characters.some((character) => !character.approved || character.draft)) conflict('Every character must be approved before starting, including absent seats.');
        const unreadyCharacterIds = state.characters.filter((character) => !character.ready || character.acceptedBoundariesRevision !== setup.boundariesRevision).map((character) => character.id);
        if (unreadyCharacterIds.length && !command.overrideUnreadyReason) conflict('Every player must acknowledge the current boundaries and be ready, or the director must record an override reason.');
        setup.started = true; state.session.status = 'live'; state.session.stateRevision++;
        eventData = { unreadyCharacterIds, overrideUnreadyReason: command.overrideUnreadyReason ?? null };
      }
      await saveState(client, state);
    } else if (command.type === 'save_submission') {
      if (state.setup && command.kind !== 'ooc') {
        const character = state.characters.find((item) => item.id === actor.character_id);
        if (!state.setup.started || !character?.approved || !character.ready || character.acceptedBoundariesRevision !== state.setup.boundariesRevision) conflict('Start the session and acknowledge its current boundaries before joining in-character play.');
      }

      if (command.expectedInputEpoch !== state.session.inputEpoch) conflict('The input window changed. Review your input before submitting again.');
      if (command.contextBeatId && (!beat || command.contextBeatId !== beat.id || !['collecting', 'stakes_review'].includes(beat.phase))) conflict('This beat is locked or no longer active. Queue the line for the next beat.');
      if (!command.text.trim() && command.kind !== 'act') throw new AppError(400, 'invalid_input', 'Speech and out-of-character notes need text.');
      if (command.kind === 'act' && (!command.intent.trim() || !command.approach.trim())) throw new AppError(400, 'invalid_input', 'Actions need an intent and an approach.');
      if (command.recipientNpcIds.some((id) => !state.npcs.some((npc) => npc.id === id && ((npc.status === 'present' && npc.locationId === state.session.scene.locationId) || npc.communicationChannel)))) conflict('The addressed NPC is unavailable.');
      const previous = command.submissionId ? all.find((item) => item.id === command.submissionId) : undefined;
      if (command.submissionId && (!previous || previous.characterId !== actor.character_id)) throw new AppError(404, 'not_found', 'Submission was not found.');
      if ((previous?.revision ?? 0) !== command.expectedSubmissionRevision) conflict('Your submission changed. Refresh before saving.');
      if (previous && !['queued', 'selected'].includes(previous.status)) conflict('This submission is already locked.');
      const submission: Submission = { id: previous?.id ?? randomUUID(), sessionId, characterId: actor.character_id!, contextBeatId: command.contextBeatId, inputEpoch: state.session.inputEpoch,
        revision: (previous?.revision ?? 0) + 1, kind: command.kind, text: command.text, intent: command.intent, approach: command.approach, recipientNpcIds: command.recipientNpcIds,
        stageDirection: command.stageDirection, alreadySpokenAloud: command.alreadySpokenAloud, status: 'queued' };
      await saveSubmission(client, submission);
      if (beat?.selectedSubmissionIds.includes(submission.id)) {
        beat.phase = 'collecting'; beat.stakesApproved = false; beat.contracts = []; beat.inputSnapshotHash = null; beat.draft = null; beat.generation++; beat.revision++;
        await saveBeat(client, beat);
      }
    } else if (command.type === 'cancel_submission') {
      const submission = all.find((item) => item.id === command.submissionId && item.characterId === actor.character_id);
      if (!submission) throw new AppError(404, 'not_found', 'Submission was not found.');
      if (submission.revision !== command.expectedSubmissionRevision || !['queued', 'selected'].includes(submission.status)) conflict('Submission can no longer be cancelled.');
      submission.status = 'cancelled'; submission.revision++;
      await saveSubmission(client, submission);
      if (beat?.selectedSubmissionIds.includes(submission.id)) { beat.selectedSubmissionIds = beat.selectedSubmissionIds.filter((id) => id !== submission.id); beat.phase = 'collecting'; beat.stakesApproved = false; beat.contracts = []; beat.generation++; beat.revision++; await saveBeat(client, beat); }
    } else if (command.type === 'open_beat') {
      if (state.setup && !state.setup.started) conflict('Approve the cast and explicitly start the session first.');
      if (beat) conflict('Finish or abort the active beat first.');
      if (command.expectedInputEpoch !== state.session.inputEpoch) conflict('The input window changed.');
      state.session.inputEpoch++; state.session.mode = command.kind; state.session.status = 'live';
      beat = { id: randomUUID(), sessionId, kind: command.kind, phase: 'collecting', revision: 0, inputEpoch: state.session.inputEpoch, sourceStateRevision: state.session.stateRevision,
        selectedSubmissionIds: [], lockedSubmissions: [], contracts: [], stakesApproved: false, classification: null, inputSnapshotHash: null, resolution: null, draft: null, draftRevision: 0, approvedContinuity: [], generation: 0, lastError: null, steering: '' };
      await saveBeat(client, beat); await saveState(client, state);
      await client.query('UPDATE sessions SET current_beat_id=$2 WHERE id=$1', [sessionId, beat.id]);
    } else if (command.type === 'set_status') {
      if (state.setup && !state.setup.started && command.status !== 'ended') conflict('Use the lobby start action after cast approval and boundary acknowledgement.');
      if (command.expectedStateRevision !== state.session.stateRevision) conflict('The session state changed.');
      if (beat && ['locked', 'draft_review'].includes(beat.phase) && command.status === 'ended') conflict('Publish or abort the locked beat before ending the session.');
      state.session.status = command.status; state.session.stateRevision++;
      if (beat && command.status !== 'ended') { beat.sourceStateRevision = state.session.stateRevision; await saveBeat(client, beat); }
      await saveState(client, state);
    } else {
      checkBeat(beat, command);
      if (command.type === 'plan_beat' || command.type === 'render_beat') {
        const task: 'plan' | 'render' = command.type === 'plan_beat' ? 'plan' : 'render';
        const existingJob = await client.query('SELECT request_hash,status FROM generation_jobs WHERE actor_id=$1 AND command_id=$2', [actor.actor_id, command.commandId]);
        if (existingJob.rowCount && existingJob.rows[0].request_hash !== requestHash) conflict('Command ID was already used with different input.');
        if (existingJob.rows[0]?.status === 'running') conflict('This generation is still running. Refresh to see its result.');
        if (task === 'plan') {
          if (!['collecting', 'stakes_review'].includes(beat.phase)) conflict('This beat is already locked.');
          if (new Set(command.type === 'plan_beat' ? command.submissionIds : []).size !== (command.type === 'plan_beat' ? command.submissionIds.length : 0)) conflict('Select each submission once.');
          const previouslySelected = beat.selectedSubmissionIds;
          beat.selectedSubmissionIds = command.type === 'plan_beat' ? command.submissionIds : [];
          for (const submission of all.filter((item) => previouslySelected.includes(item.id) && !beat!.selectedSubmissionIds.includes(item.id) && item.status === 'selected')) {
            submission.status = 'queued'; await saveSubmission(client, submission);
          }
          const selected = all.filter((submission) => beat!.selectedSubmissionIds.includes(submission.id));
          if (selected.length !== beat.selectedSubmissionIds.length || selected.some((submission) => !['queued', 'selected'].includes(submission.status) || submission.kind === 'ooc' || (submission.contextBeatId && submission.contextBeatId !== beat!.id))) conflict('Only current, unlocked in-character submissions can be selected.');
          for (const submission of selected) { submission.status = 'selected'; await saveSubmission(client, submission); }
          beat.stakesApproved = false;
        } else if (!['locked', 'draft_review'].includes(beat.phase)) conflict('Lock the accepted inputs before rendering.');
        beat.generation++; beat.revision++; beat.lastError = null;
        const selected = task === 'render' ? beat.lockedSubmissions : all.filter((submission) => beat!.selectedSubmissionIds.includes(submission.id));
        const context = safeContext(state, beat, selected, await history(client, sessionId), await corrections(client, sessionId));
        const snapshotHash = digest(context);
        const jobId = randomUUID();
        await saveBeat(client, beat);
        await client.query('INSERT INTO generation_jobs(id,session_id,beat_id,snapshot_hash,generation,status,input,task,command_id,actor_id,request_hash) VALUES($1,$2,$3,$4,$5,\'running\',$6,$7,$8,$9,$10) ON CONFLICT(actor_id,command_id) DO UPDATE SET id=excluded.id,snapshot_hash=excluded.snapshot_hash,generation=excluded.generation,status=\'running\',input=excluded.input,error=NULL,created_at=clock_timestamp(),finished_at=NULL', [jobId, sessionId, beat.id, snapshotHash, beat.generation, context, task, command.commandId, actor.actor_id, requestHash]);
        return { generation: { task, context, jobId, snapshotHash, generation: beat.generation } };
      }
      if (command.type === 'set_beat_steering') {
        if (!['live', 'paused'].includes(state.session.status) || (state.setup && !state.setup.started)) conflict('Start the session before steering a beat.');
        const before = beat.steering ?? '';
        beat.steering = command.text;
        if (['collecting', 'stakes_review'].includes(beat.phase)) {
          beat.phase = 'collecting'; beat.classification = null; beat.contracts = []; beat.stakesApproved = false;
          beat.inputSnapshotHash = null;
        } else beat.phase = 'locked';
        beat.draft = null; beat.approvedContinuity = []; beat.lastError = null; beat.generation++;
        eventData = { beatId: beat.id, before, after: beat.steering };
        await client.query("UPDATE generation_jobs SET status='cancelled',finished_at=now() WHERE beat_id=$1 AND status='running'", [beat.id]);
      } else if (command.type === 'approve_stakes') {
        const manualAfterFailure = beat.phase === 'collecting' && beat.lastError !== null;
        if (beat.phase !== 'stakes_review' && !manualAfterFailure) conflict('Select inputs and request a plan before reviewing stakes.');
        const selected = all.filter((submission) => beat!.selectedSubmissionIds.includes(submission.id));
        if (!selected.length || selected.length !== beat.selectedSubmissionIds.length || selected.some((submission) => !['queued', 'selected'].includes(submission.status) || submission.kind === 'ooc' || (submission.contextBeatId && submission.contextBeatId !== beat!.id))) conflict('The selected input is no longer current and unlocked.');
        if (beat.classification === 'needs_action' && command.classification !== 'action') conflict('The risky concession must use the action workflow.');
        if (command.classification === 'ordinary' && selected.some((submission) => submission.kind === 'act')) conflict('Action submissions require reviewed action contracts.');
        if (command.classification === 'ordinary' && command.contracts.length) conflict('An ordinary conversation has no mechanical contracts.');
        if (command.classification === 'action' && !command.contracts.length) conflict('An action needs at least one reviewed contract.');
        validateContracts(command.contracts, state);
        for (const contract of command.contracts) {
          const referenced = all.filter((submission) => contract.submissionIds.includes(submission.id));
          if (referenced.length !== contract.submissionIds.length || referenced.some((submission) => !beat!.selectedSubmissionIds.includes(submission.id))) conflict('Contracts must reference selected submissions.');
          if (!referenced.some((submission) => submission.characterId === contract.actorCharacterId)) conflict('The actor must supply the action.');
          if (contract.helperCharacterIds.some((id) => !referenced.some((submission) => submission.characterId === id))) conflict('Each helper must consent through their own selected action.');
        }
        beat.contracts = command.contracts; beat.classification = command.classification; beat.stakesApproved = true; beat.phase = 'stakes_review'; beat.lastError = null; beat.generation++;
        await client.query("UPDATE generation_jobs SET status='cancelled',finished_at=now() WHERE beat_id=$1 AND task='plan' AND status='running'", [beat.id]);
        beat.kind = command.classification === 'action' ? 'action' : 'conversation';
        state.session.mode = beat.kind;
        await saveState(client, state);
      } else if (command.type === 'lock_beat') {
        if (beat.phase !== 'stakes_review' || !beat.stakesApproved) conflict('Approve current stakes before locking.');
        const selected = all.filter((submission) => beat!.selectedSubmissionIds.includes(submission.id));
        if (!selected.length || selected.some((submission) => !['selected', 'queued'].includes(submission.status))) conflict('The accepted input changed.');
        beat.lockedSubmissions = structuredClone(selected); beat.sourceStateRevision = state.session.stateRevision;
        beat.inputSnapshotHash = digest({ selected, contracts: beat.contracts, stateRevision: state.session.stateRevision });
        for (const contract of beat.contracts) await client.query('INSERT INTO action_contracts(id,session_id,beat_id,version,data) VALUES($1,$2,$3,$4,$5)', [contract.id, sessionId, beat.id, contract.version, contract]);
        beat.resolution = resolveContracts(beat.contracts, state, deps.rollDie);
        if (beat.kind === 'action') {
          const staged = applyResolution(state, beat.resolution);
          const roundEffects: Effect[] = [];
          for (const track of state.tracks.filter((track) => track.kind === 'countdown' && track.enabled && track.trigger === 'action_round' && track.current < track.max)) {
            const afterAction = staged.tracks.find((item) => item.id === track.id)!;
            const tick = afterAction.current < afterAction.max ? 1 : 0;
            if (tick) roundEffects.push({ kind: 'track_delta', trackId: track.id, delta: tick });
            if (afterAction.current + tick >= afterAction.max) roundEffects.push(...track.completionEffects);
          }
          beat.resolution.effectGroups ??= [structuredClone(beat.resolution.effects)];
          beat.resolution.effectGroups.push(roundEffects);
          beat.resolution.effects.push(...roundEffects);
          applyResolution(state, beat.resolution);
        }
        for (const roll of beat.resolution.rolls) await client.query('INSERT INTO rolls(id,session_id,beat_id,contract_id,data) VALUES($1,$2,$3,$4,$5)', [roll.id, sessionId, beat.id, roll.contractId, roll]);
        for (const submission of selected) { submission.status = 'locked'; await saveSubmission(client, submission); }
        beat.phase = 'locked'; beat.generation++;
        await client.query("UPDATE generation_jobs SET status='cancelled',finished_at=now() WHERE beat_id=$1 AND task='plan' AND status='running'", [beat.id]);
      } else if (command.type === 'edit_script') {
        if (!['locked', 'draft_review'].includes(beat.phase)) conflict('Lock the inputs before writing a manual script.');
        beat.draft = validateDraft({ segments: command.segments, continuity: [], directorSummary: 'Manual director narration.' }, state, beat);
        beat.draftRevision++; beat.approvedContinuity = []; beat.phase = 'draft_review'; beat.generation++; beat.lastError = null;
      } else if (command.type === 'approve_continuity') {
        if (beat.phase !== 'draft_review') conflict('Review a script before approving continuity.');
        validateSources(command.updates, beat, state); beat.approvedContinuity = command.updates;
      } else if (command.type === 'abort_beat') {
        beat.phase = 'aborted'; beat.generation++; beat.lastError = command.reason;
        for (const submission of all.filter((submission) => beat!.selectedSubmissionIds.includes(submission.id) && submission.status === 'locked')) { submission.status = 'cancelled'; await saveSubmission(client, submission); }
        eventData = { beatId: beat.id, reason: command.reason, carriedSubmissions: await carryUnconsumed(client, beat, all) };
        state.session.inputEpoch++; await saveState(client, state);
        await client.query('UPDATE generation_jobs SET status=\'cancelled\',finished_at=now() WHERE beat_id=$1 AND status=\'running\'', [beat.id]);
      } else if (command.type === 'publish_beat') {
        if (beat.phase !== 'draft_review' || !beat.draft || !beat.resolution) conflict('Review a completed draft before publication.');
        if (command.expectedStateRevision !== state.session.stateRevision || beat.sourceStateRevision !== state.session.stateRevision || command.draftRevision !== beat.draftRevision) conflict('The state or reviewed draft changed.');
        validateDraft(beat.draft, state, beat); validateSources(beat.approvedContinuity, beat, state);
        const segments = makeScript(beat, state);
        const audio = command.textOnly ? null : await attachPreparedAudio(client, { sessionId, beat, state, segments, preparationId: command.audioPreparationId! });
        if (audio) for (const segment of segments) segment.ttsEnabled = segment.kind === 'narration' || segment.kind === 'npc_dialogue';
        const carriedSubmissions = await carryUnconsumed(client, beat, all);
        const event = await recordEvent(client, sessionId, actor, command.commandId, 'beat.published', state.session.stateRevision + 1, { beatId: beat.id, draftRevision: beat.draftRevision, carriedSubmissions });
        state = applyResolution(state, beat.resolution!, event.eventId);
        state.session.stateRevision++; state.session.beatNumber++; state.session.inputEpoch++;
        if (beat.kind === 'action') state.session.actionRoundNumber++;
        for (const update of beat.approvedContinuity) {
          if (update.kind === 'npc_knowledge') {
            const npc = state.npcs.find((npc) => npc.id === update.npcId)!;
            npc.knowledge.push({ id: randomUUID(), statement: update.statement, category: update.category, acquisition: update.acquisition, sourceEventId: event.eventId, sourceEntityId: update.sourceEntityId, learnedBeatNumber: state.session.beatNumber }); npc.version++;
          } else {
            if (state.facts.some((fact) => fact.id === update.factId)) conflict('That fact already exists.');
            state.facts.push({ id: update.factId, text: update.text, visibility: update.visibility, sourceEventId: event.eventId });
          }
        }
        const publication: PublishedBeat = { id: beat.id, kind: beat.kind, beatNumber: state.session.beatNumber, actionRoundNumber: state.session.actionRoundNumber, stateRevision: state.session.stateRevision,
          publishedAt: new Date().toISOString(), segments, rolls: beat.resolution!.rolls, outcomes: beat.resolution!.outcomes, textOnly: command.textOnly, ...(audio ? { audioManifestKey: audio.configHash } : {}) };
        await client.query('INSERT INTO published_beats(id,session_id,beat_number,data) VALUES($1,$2,$3,$4)', [beat.id, sessionId, state.session.beatNumber, publication]);
        if (audio) await client.query("INSERT INTO audio_manifests(session_id,beat_id,config_hash,status,lease_id,lease_until,manifest) VALUES($1,$2,$3,'ready',$4,clock_timestamp(),$5)", [sessionId, beat.id, audio.configHash, randomUUID(), audio.manifest]);
        for (const submission of all.filter((submission) => beat!.selectedSubmissionIds.includes(submission.id))) { submission.status = 'published'; await saveSubmission(client, submission); }
        beat.phase = 'published'; beat.generation++;
        await saveState(client, state);
      }
      beat.revision++; await saveBeat(client, beat);
    }
    if (command.type !== 'publish_beat' && command.type !== 'reveal_npc' && command.type !== 'record_correction') await recordEvent(client, sessionId, actor, command.commandId, command.type, state.session.stateRevision, eventData);
    return { response: await finish(client, sessionId, actor, command, requestHash) };
  });
  if (prepared.response) return prepared.response;
  const generation = prepared.generation!;
  let output: unknown;
  let failure: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const attemptId = await startUsageAttempt(deps.pool, { sessionId, beatId: generation.context.beat.id, operationId: generation.jobId, kind: generation.task, timeoutMs: deps.providerTimeoutMs ?? 30_000 });
  try {
    output = await Promise.race([
      generation.task === 'plan' ? deps.provider.plan(generation.context) : deps.provider.render(generation.context),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Generation timed out. Retry or write a manual script.')), deps.providerTimeoutMs ?? 30_000); }),
    ]);
  } catch { failure = 'Generation failed. Your accepted inputs and dice are safe. Retry or write a manual script.'; }
  finally { clearTimeout(timer); }
  await finishUsageAttempt(deps.pool, { attemptId, status: failure ? 'failed' : 'succeeded' });
  const completed = await transaction(deps.pool, async (client) => {
    await client.query('SELECT id FROM sessions WHERE id=$1 FOR UPDATE', [sessionId]);
    const duplicate = await receipt(client, actor, command.commandId, requestHash); if (duplicate) return duplicate;
    const beat = await currentBeat(client, sessionId);
    const job = (await client.query('SELECT * FROM generation_jobs WHERE id=$1 FOR UPDATE', [generation.jobId])).rows[0];
    const state = await readState(client, sessionId);
    if (!beat || beat.id !== generation.context.beat.id || beat.generation !== generation.generation || beat.revision !== generation.context.beat.revision || beat.phase !== generation.context.beat.phase || state.session.stateRevision !== generation.context.state.session.stateRevision || job?.status !== 'running' || job.snapshot_hash !== generation.snapshotHash) {
      await client.query('UPDATE generation_jobs SET status=\'cancelled\',finished_at=now() WHERE id=$1', [generation.jobId]);
      return { superseded: true as const };
    }
    try {
      if (!failure && generation.task === 'plan') {
        const plan = output as Awaited<ReturnType<AiProvider['plan']>>;
        if (!['ordinary', 'needs_action', 'action'].includes(plan.classification)) throw new Error('Invalid classification.');
        beat.contracts = plan.contracts.map((contract) => ActionContractSchema.parse(contract));
        validateContracts(beat.contracts, state);
        beat.classification = plan.classification; beat.phase = 'stakes_review';
      } else if (!failure) {
        beat.draft = validateDraft(output, state, beat); beat.draftRevision++; beat.approvedContinuity = []; beat.phase = 'draft_review';
      }
    } catch { failure = 'The generated response failed validation. Retry or provide a manual script.'; }
    beat.lastError = failure; beat.revision++;
    await saveBeat(client, beat);
    await client.query('UPDATE generation_jobs SET status=$2,error=$3,finished_at=now() WHERE id=$1', [generation.jobId, failure ? 'failed' : 'succeeded', failure]);
    await recordEvent(client, sessionId, actor, command.commandId, failure ? 'job.failed' : command.type, state.session.stateRevision);
    return finish(client, sessionId, actor, command, requestHash);
  });
  if ('superseded' in completed) throw new AppError(409, 'superseded', 'The generation was superseded. Its result was discarded.');
  return completed;
}
