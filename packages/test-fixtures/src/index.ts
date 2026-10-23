import { SessionStateSchema, type SessionState, type Traits } from '@rpg/contracts';

export function createLedgerState(sessionId: string, makeId: () => string): SessionState {
  const locationId = makeId();
  const sceneId = makeId();
  const seedEventId = `seed:${sessionId}`;
  const traits: Traits[] = [
    { force: 2, finesse: 1, wits: 0, presence: 1 },
    { force: 0, finesse: 2, wits: 1, presence: 1 },
    { force: 1, finesse: 1, wits: 2, presence: 0 },
    { force: 1, finesse: 0, wits: 1, presence: 2 },
  ];
  const names = ['Rook', 'Lark', 'Quill', 'Pip'];
  const specialties = ['Move heavy objects with the right leverage.', 'Open ordinary mechanical locks with tools and time.', 'Read ledgers and notice altered records.', 'Keep a distracted official talking about procedure.'];
  const characters = names.map((displayName, index) => ({
    id: makeId(), displayName, traits: traits[index], strain: 0,
    appearance: ['Rolled sleeves and a battered waistcoat.', 'A neat coat with too many pockets.', 'Ink-stained fingers and round spectacles.', 'An immaculate jacket and a crooked grin.'][index],
    specialty: specialties[index], flaw: ['Too proud to ask for help.', 'Curiosity outruns caution.', 'Cannot leave a bad calculation alone.', 'Promises more than they can deliver.'][index],
    possessions: [['work gloves', 'rope', 'club invitation'], ['lockpick', 'small mirror', 'club invitation'], ['notebook', 'pencil', 'club invitation'], ['calling cards', 'pocket watch', 'club invitation']][index],
    connection: `${names[(index + 1) % names.length]} helped them out of a tight spot.`,
    secret: ['Owes the missing owner a favor.', 'Has been inside this club once before.', 'Recognizes a name in the disputed accounts.', 'The buyer once offered them a job.'][index],
    approved: true,
  }));
  return SessionStateSchema.parse({
    schemaVersion: 1, rulesVersion: '0.1',
    session: {
      id: sessionId, title: 'The Ledger Job', status: 'lobby', mode: 'conversation',
      stateRevision: 0, beatNumber: 0, actionRoundNumber: 0, inputEpoch: 0,
      scene: { id: sceneId, title: 'The Velvet Ledger', locationId,
        description: 'Rain taps the windows of a members-only club. Find the missing owner’s ledger before a buyer arrives. Mara polishes a glass behind the bar; Inspector Dax guards a pile of paperwork.' },
    },
    characters,
    npcs: [
      { id: makeId(), displayName: 'Mara Vale', role: 'Bartender', appearance: 'An unhurried gaze, a folded apron, and a carefully polished glass.',
        aliases: ['Mara'], personality: ['dry humor', 'cautious', 'curious'], motivation: 'Find out what happened to the owner.', goal: 'See evidence before trusting strangers.',
        limits: ['Will not hand over access simply because someone demands it.'], dialogueExamples: ['A receipt is a promise with better handwriting.'],
        mood: 'wary', locationId, status: 'present', voiceProfileId: 'voice_mara',
        secrets: ['The owner left her a brass key, but she will reveal it only after credible evidence earns trust.'],
        knowledge: [{ id: makeId(), statement: 'The club owner is missing. The ledger may explain why.', category: 'fact', acquisition: 'scenario', sourceEventId: seedEventId, sourceEntityId: null, learnedBeatNumber: 0 }],
        relationships: [{ targetCharacterId: null, stance: 'wary', reason: 'The party are unfamiliar visitors.', sourceEventId: seedEventId }],
      },
      { id: makeId(), displayName: 'Inspector Dax', role: 'Visiting official', appearance: 'A spotless badge and a stack of inconvenient forms.',
        aliases: ['Dax'], personality: ['procedural', 'vain'], motivation: 'Be seen enforcing the rules.', goal: 'Inspect the club’s paperwork.',
        dialogueExamples: ['There is a form for unusual circumstances. This is the wrong form.'],
        locationId, status: 'present', voiceProfileId: 'voice_dax',
        secrets: ['His inspection permit expired yesterday.'], knowledge: [{ id: makeId(), statement: 'The club has been late with its reports.', category: 'fact', acquisition: 'scenario', sourceEventId: seedEventId, sourceEntityId: null, learnedBeatNumber: 0 }],
      },
      { id: makeId(), displayName: 'Biscuit', role: 'Guard dog', appearance: 'A broad dog asleep beside the service door.',
        personality: ['attentive to food and familiar handlers'], motivation: 'Guard the service corridor.', goal: 'Nap until something requires attention.',
        limits: ['An ordinary dog; cannot speak human dialogue.'], locationId: makeId(), status: 'offstage', voiceProfileId: 'voice_narrator',
      },
    ],
    tracks: [
      { id: makeId(), label: 'Archive access', kind: 'progress', current: 0, max: 4, visibility: 'public', completionText: 'The archive is accessible.' },
      { id: makeId(), label: 'Security alert', kind: 'danger', current: 0, max: 6, visibility: 'public', completionText: 'The club sounds its alarm.' },
      { id: makeId(), label: 'Buyer arrival', kind: 'countdown', current: 0, max: 3, visibility: 'public', enabled: false, trigger: 'action_round', completionText: 'The buyer arrives at the club.' },
    ],
    facts: [{ id: makeId(), text: 'The ledger may explain the disappearance of the club owner.', visibility: 'public', sourceEventId: seedEventId }],
    directorNotes: 'Keep the essential clue available after setbacks. Mara knows nothing of events in the archive unless someone tells her. The ledger is in the archive safe. Announce the buyer countdown before enabling it.',
  });
}
