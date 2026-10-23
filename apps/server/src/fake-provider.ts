import { randomUUID } from 'node:crypto';
import {
  FIELD_GENERATION_FIELDS, FieldGenerationRequestSchema, validateFieldGenerationText,
  type AiProvider, type ProviderContext, type PlanResult, type AiDraft, type ActionContract, type Effect,
  type FieldGenerationRequest, type FieldGenerationResponse, type FieldGenerationCharacterContext,
} from '@rpg/contracts';

function characterInspiration(context: FieldGenerationCharacterContext, field: string): string {
  const publicField = ['npc.displayName', 'npc.role', 'npc.appearance', 'character.displayName', 'character.appearance'].includes(field);
  const facts: (string | undefined | null)[] = [context.displayName];
  if (context.kind === 'npc') {
    facts.push(context.role, context.appearance);
    if (!publicField) facts.push(...(context.personality ?? []), context.motivation, context.goal, context.mood);
    if (!publicField && ['npc.hiddenIdentity', 'npc.secret', 'npc.secrets'].includes(field)) {
      facts.push(context.hiddenIdentity, ...(context.secrets ?? []));
    }
  } else {
    facts.push(context.appearance);
    if (!publicField) facts.push(context.backstory, context.personality, context.specialty, context.flaw, context.connection, context.secret);
  }
  // Deliberately select authored prose; serializing the profile would disclose private facts in public drafts.
  return facts.filter((fact): fact is string => Boolean(fact?.trim())).map(fact => fact.trim().replace(/\s+/g, ' ')).join(' — ');
}

export class FakeAiProvider implements AiProvider {
  async generateField(input: FieldGenerationRequest): Promise<FieldGenerationResponse> {
    const { field, seed, premise, instructions, characterContext } = FieldGenerationRequestSchema.parse(input);
    const definition = FIELD_GENERATION_FIELDS[field];
    if (['scenario.boundaries', 'npc.limits', 'npc.limit'].includes(field)) {
      const text = seed.replace(/\r\n?/g, '\n').split('\n').map(line => line.trim()).join('\n');
      return { text: validateFieldGenerationText(field, text) };
    }
    if (characterContext && field === 'character.pronouns') return { text: validateFieldGenerationText(field, seed) };
    const expand = (source: string, limit: number) => {
      const detail = limit <= 160 ? ` — ${definition.label.toLowerCase()}` : '. A vivid detail invites further exploration.';
      const suffix = detail.slice(0, Math.floor(limit / 2));
      return `${source.trim().replace(/\s+/g, ' ').slice(0, limit - suffix.length).trimEnd()}${suffix}`;
    };
    const inspiration = [premise, instructions].filter(Boolean).join(' ').replace(/\s+/g, ' ');
    const character = characterContext ? characterInspiration(characterContext, field) || undefined : undefined;
    const source = seed || character || inspiration || (characterContext ? 'A character' : '');
    const withInspiration = (brief: string) => {
      const contextual = seed && character ? `${brief} (${character})` : brief;
      return inspiration && (seed || character) ? `${contextual} (${inspiration})` : contextual;
    };
    const text = definition.kind === 'lines'
      ? source.split(/\r\n?|\n/).map(line => line.trim()).filter(Boolean)
        .map(line => expand(withInspiration(line), definition.maxItemChars!)).join('\n')
      : expand(withInspiration(source), definition.maxChars);
    return { text: validateFieldGenerationText(field, text) };
  }

  async plan(context: ProviderContext): Promise<PlanResult> {
    const { beat, submissions, state } = context;
    const risky = submissions.some((submission) => submission.kind === 'act' || /give me|hand over|threaten|steal|persuad|intimidat/i.test(submission.text));
    if (beat.kind === 'conversation' && !risky) return { classification: 'ordinary', contracts: [], directorSummary: 'An ordinary exchange. No automatic concession or mechanical effect.' };
    const progress = state.tracks.find((track) => track.kind === 'progress' && track.visibility === 'public' && track.enabled);
    const danger = state.tracks.find((track) => track.kind === 'danger' && track.visibility === 'public' && track.enabled);
    const progressEffects: Effect[] = progress ? [{ kind: 'track_delta', trackId: progress.id, delta: 2 }] : [];
    const cost = (characterId: string, delta: number): Effect => danger ? { kind: 'track_delta', trackId: danger.id, delta } : { kind: 'strain_delta', characterId, delta };
    const contracts: ActionContract[] = submissions.filter((submission) => submission.kind !== 'ooc').map((submission) => ({
      id: randomUUID(), version: 1, actorCharacterId: submission.characterId, helperCharacterIds: [], submissionIds: [submission.id],
      intent: submission.intent || submission.text, approach: submission.approach || 'Ask the addressed NPC for a consequential concession',
      ruling: 'check', trait: submission.kind === 'say' ? 'presence' : 'wits', edge: 0, edgeReason: null, risk: 'normal', prerequisites: [], fallback: { kind: 'hold' },
      outcomes: {
        clean: { publicText: 'The agreed objective succeeds quietly.', effects: [...progressEffects] },
        costly: { publicText: danger ? 'The agreed objective succeeds, drawing attention.' : 'The agreed objective succeeds at the cost of 1 strain.', effects: [...progressEffects, cost(submission.characterId, 1)] },
        setback: { publicText: danger ? 'The objective remains out of reach and danger increases.' : 'The objective remains out of reach; the effort causes 2 strain.', effects: [cost(submission.characterId, 2)] },
      },
    }));
    return { classification: beat.kind === 'conversation' ? 'needs_action' : 'action', contracts, directorSummary: 'Review these fixture stakes before accepting. They are deterministic rehearsal proposals.' };
  }
  async render(context: ProviderContext): Promise<AiDraft> {
    const submission = context.submissions.at(-1);
    const available = context.state.npcs.filter((npc) => npc.status === 'present' || npc.communicationChannel);
    const recipients = submission?.recipientNpcIds ?? [];
    const npc = recipients.length
      ? recipients.map((id) => available.find((candidate) => candidate.id === id)).find(Boolean)
      : available.find((candidate) => candidate.displayName === 'Mara Vale') ?? available[0];
    const isMara = npc?.displayName === 'Mara Vale';
    const isDax = npc?.displayName === 'Inspector Dax';
    if (context.beat.kind === 'action') {
      const segments: AiDraft['segments'] = [{ kind: 'narration', text: context.beat.resolution?.outcomes.map((outcome) => outcome.publicText).join(' ') || 'The reviewed actions conclude.', recipientCharacterIds: [], delivery: 'neutral' }];
      if (npc) segments.push({ kind: 'npc_dialogue', speakerNpcId: npc.id,
        text: isMara ? 'Subtle. Remind me to charge you for the paperwork. What is your next move?'
          : isDax ? 'I will need an incident form for that. What, precisely, should I record?'
          : 'What happens next?', recipientCharacterIds: [], delivery: isMara ? 'amused' : 'neutral' });
      return { segments, continuity: [], directorSummary: 'The selected branches remain fixed; no extra consequences were added.' };
    }
    if (!npc || !submission) return {
      segments: [{ kind: 'narration', text: 'The question remains unanswered for now.', recipientCharacterIds: [], delivery: 'neutral' }],
      continuity: [], directorSummary: 'No available NPC was selected, so no reply or knowledge update was invented.',
    };
    const sale = /sell|sale|offered/i.test(submission.text);
    const remembersSale = npc.knowledge.some((knowledge) => /sale|sell|offered/i.test(knowledge.statement));
    let narration: string;
    let dialogue: string;
    if (isMara) {
      narration = sale ? 'Mara sets the glass down carefully.' : 'Mara stops polishing the glass and looks toward the empty stool.';
      dialogue = sale ? 'Then someone expects you not to survive the paperwork. Show me the seller’s name.'
        : remembersSale ? 'About that sale offer you mentioned: the paperwork is the trap. Have you found the seller’s name?'
        : /ledger|keys/i.test(submission.text) ? 'I am not handing those over on a stranger’s promise. Bring me a reason to trust you.'
        : 'He learned the difference between owning this place and being allowed to keep it. Why are you asking?';
    } else if (isDax) {
      narration = 'Inspector Dax squares the stack of forms and raises an eyebrow.';
      dialogue = sale ? 'A sale? Then I need the seller’s name and a transfer form. Which of those can you account for?'
        : remembersSale ? 'About the sale you mentioned: the transfer form still needs the seller’s name. Do you have it?'
        : /ledger|keys/i.test(submission.text) ? 'Access requires the appropriate permission form. Which authorization are you relying on?'
        : 'The club’s reports are overdue. I can discuss the inspection, but speculation belongs on a different form. What exactly do you need to know?';
    } else {
      narration = `${npc.displayName} pauses before answering.`;
      dialogue = 'I cannot answer that yet. What can you tell me about it?';
    }
    return {
      segments: [{ kind: 'narration', text: narration, recipientCharacterIds: [], delivery: 'neutral' },
        { kind: 'npc_dialogue', speakerNpcId: npc.id, text: dialogue, recipientCharacterIds: [submission.characterId], delivery: isMara ? 'quiet' : 'neutral' }],
      continuity: sale ? [{ kind: 'npc_knowledge', npcId: npc.id, statement: isMara || isDax ? 'The party reported a sale offer for the club.' : `The party said: ${submission.text}`, category: 'claim', acquisition: 'told', sourceSubmissionIds: [submission.id], sourceEntityId: submission.characterId }] : [],
      directorSummary: `${npc.displayName} uses their own knowledge and leaves the next decision to the player.`,
    };
  }
}
