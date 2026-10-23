import type { CharacterCardDefinition, FieldGenerationCharacterContext, LiveNpcProfile, Npc, NpcDefinition } from '@rpg/contracts';

export function characterFieldContext(card: CharacterCardDefinition): FieldGenerationCharacterContext {
  return {
    kind: 'character', displayName: card.displayName, pronouns: card.pronouns,
    appearance: card.appearance, personality: card.personality, backstory: card.backstory,
    traits: { force: card.traits.force, finesse: card.traits.finesse, wits: card.traits.wits, presence: card.traits.presence },
    specialty: card.specialty, flaw: card.flaw, possessions: Array.from(card.possessions, value => value ?? ''),
    connection: card.connection, secret: card.secret,
  };
}

export function npcFieldContext(profile: NpcDefinition | LiveNpcProfile, details?: Pick<Npc, 'knowledge' | 'relationships'>): FieldGenerationCharacterContext {
  return {
    kind: 'npc', displayName: profile.displayName, role: profile.role, appearance: profile.appearance,
    aliases: [...profile.aliases], hiddenIdentity: profile.hiddenIdentity, personality: [...profile.personality],
    motivation: profile.motivation, goal: profile.goal, limits: [...profile.limits], dialogueExamples: [...profile.dialogueExamples],
    mood: profile.mood, locationId: profile.locationId, status: profile.status,
    communicationChannel: profile.communicationChannel, voiceProfileId: profile.voiceProfileId, secrets: [...profile.secrets],
    ...('knowledge' in profile ? { knowledge: profile.knowledge.map(({ statement, category }) => ({ statement, category })) } : {}),
    ...('partyRelationship' in profile ? { partyRelationship: profile.partyRelationship ? { stance: profile.partyRelationship.stance, reason: profile.partyRelationship.reason } : null } : {}),
    ...(details ? {
      knowledge: details.knowledge.map(({ statement, category }) => ({ statement, category })),
      relationships: details.relationships.map(({ targetCharacterId, stance, reason }) => ({ targetCharacterId, stance, reason })),
    } : {}),
  };
}
