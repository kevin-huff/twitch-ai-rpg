# Twitch AI Roleplay Engine
## Product, gameplay, and technical design handoff

**Version:** 0.2, planning draft  
**Prepared:** October 22, 2026  
**Owner:** Kevin Huff  
**Intended recipient:** Codex or another implementation agent  
**Planning target:** First playable show on Wednesday, October 28, 2026, subject to rehearsal readiness  
**Status:** Design specification, not an implemented or playtested application

> Build a multiplayer roleplay show, not a chatbot that occasionally rolls dice. Human players portray their characters. The AI portrays the world and its NPCs. A human Sub-DM directs the experience. The application owns the rules, records, and broadcast.

## Reading guide

Read sections 1-8 for the product and game. Read sections 9-17 for application design. Use sections 18-22 for scope, delivery, testing, and Codex's first assignment. Appendix A provides example payloads; Appendix B records sources and their limited relevance.

**Decision language:** MUST identifies a requirement of this handoff. DEFAULT identifies a proposed implementation or tuning choice that Codex may challenge with a specific reason. LATER identifies work outside the first-show scope. Numerical pacing and balance settings are starting hypotheses, not measured results.

---

# 1. Product intent and non-negotiables

## 1.1 The experience

A small cast joins a shared adventure in their browsers. They discuss plans using their existing voice-call setup, submit actions and in-character speech, and interact with an AI Dungeon Master. The AI produces third-person narration and actual, attributed NPC dialogue. A human Sub-DM reviews the experience before it reaches the public stage. A dedicated browser-source view presents the show in OBS with captions, character identification, dice, and TTS.

The first cast is expected to include Abbabox, Skooty, Svphron, and Kawaiikasey. Names are seed examples, not hard-coded users. Design for four simultaneous players initially, with a configurable two-to-six-player roster. The Sub-DM may be an additional person or a player with an explicitly granted director role.

The engine must support different genres, scenarios, and casts without application code changes. The first adventure can be a comedy heist; the engine must not assume fantasy, medieval equipment, or a D&D ruleset.

## 1.2 Requirements retained from planning

- Multiplayer action submissions are resolved into one coherent shared scene.
- A human Sub-DM approves stakes, guides the AI privately, and controls publication.
- Lightweight dice create uncertainty without a full tactical RPG subsystem.
- Reusable scenario packages and character cards are separate from live session state.
- TTS plays on the broadcast and optionally in player browsers.
- Refreshes, reconnects, provider failures, and bad narration do not destroy the session.
- The viewers' ability to follow the show matters as much as the players' ability to play.

## 1.3 New requirement: conversations are core gameplay

NPC conversation is a first-class feature, not flavor text appended to action summaries.

For this specification, **third-person narration with dialogue** means:

> Mara folds her arms and glances toward the service door. "You want the ledger? Tell me why the city inspector arrived with a crowbar."

It does NOT mean:

> Mara asks the party to explain themselves.

The application MUST support short back-and-forth exchanges between player characters and identifiable NPCs, including follow-up questions, banter, negotiation, deception, disagreement, and emotionally meaningful responses. Not every line needs a roll, and not every conversation needs all four players to submit.

**The AI never invents a player character's dialogue, voluntary decisions, or internal feelings.** It may quote an approved player submission exactly and narrate observable, already-established consequences of an approved action. It may not make the character confess, accept a deal, attack, or fall in love on the player's behalf.

## 1.4 Not the first product

Do not build a SillyTavern fork, Character.AI integration, full virtual tabletop, autonomous-agent swarm, public AI companion service, or Twitch monetization platform. These products are inspiration for characterization and presentation, not architectural dependencies.

---

# 2. Roles, authority, and information boundaries

| Role | Controls | Must not control or receive |
|---|---|---|
| Player | Their approved character, their submissions, their audio preferences | Other characters' choices; director-only notes; hidden NPC facts; canonical dice or state |
| AI DM | Proposed rulings, NPC performance, narrative drafts, proposed continuity updates | Direct database writes, final dice, publication, unrestricted tools, player consent |
| Sub-DM / director | Scenario preparation, casting, stakes approval, spotlight, draft editing, publishing, explicit corrections | Silent rerolls or unrecorded changes to established outcomes |
| Rules engine | Dice, arithmetic, typed effects, phase transitions, persistence, authorization | Creative decisions that belong to players |
| Presenter client | Public stage rendering, playback telemetry, approved audio | Director controls or hidden game state |
| Audience | Watching the Twitch show; later, bounded participation | Direct access to player/director credentials or unrestricted story commands |

**Default visibility:** ordinary in-character speech and action outcomes are public to the party and stream after publication. Director notes remain private. Character secrets can be visible to their owner and the director. NPC secrets remain director-only until deliberately revealed. Private player-to-NPC side scenes are LATER; do not accidentally imply that an ordinary speech submission is private.

Public projections MUST be generated on the server using allowlisted fields. Hiding a field with CSS or omitting it from a component is not access control. HTTP responses, sockets, exports, audio URLs, and logs need the same treatment.

A person may hold both player and director roles. The UI must make their active role explicit, and authorization must still be checked per operation.

---

# 3. Shared vocabulary and the two play loops

## 3.1 Terms

- **Session:** one running adventure with a cast, scenario snapshot, history, and current state.
- **Scene:** a meaningful situation or location containing multiple exchanges and actions.
- **Beat:** one published bundle of player input, AI performance, and approved consequences.
- **Conversation beat:** a short exchange that usually has no dice and does not consume an action round.
- **Action round:** a coordinated set of consequential actions, normally one per participating player.
- **Action contract:** the agreed goal, approach, check, and outcome branches before dice are rolled.
- **Canonical state:** facts and mechanical values actually committed by the application.
- **Draft:** proposed content that has not been published or made canonical.

A session has both a monotonically increasing beat number and an action-round number. They are not interchangeable. Scene changes do not reset the session's sequence numbers.

## 3.2 Conversation loop

1. A player submits an exact line of speech, an addressee, and optionally a non-consequential stage direction.
2. The director selects one or several queued lines to address. Do not wait for the entire cast.
3. The planning pass checks context, speaker availability, and whether the request needs a consequential ruling.
4. For an ordinary exchange, the AI drafts a short response using narration and one or two relevant NPC speakers.
5. The director reviews the script and any proposed facts, beliefs, or relationship updates.
6. Approved public audio is prepared. The director publishes the beat, or uses the text-only fallback.
7. The player can ask a follow-up. Other players can join or be given the spotlight.

Examples that normally require no roll: introductions, asking what an NPC knows, jokes, expressing a preference, discussing a previously offered deal, and clarifying an instruction.

**Conversation is not a bypass for consequential actions.** "Give me the keys or I hurt your dog" can be an intimidation attempt. "I casually slip the jewel into my pocket while talking" is an action. A disputed concession, risky lie, resource transfer, or contested secret is classified before publication and escalated into an action contract when appropriate.

If an NPC willingly shares ordinary information or grants an already-established offer, no roll is necessary. The distinction is uncertainty and consequence, not whether the input contains quotation marks.

## 3.3 Action loop

1. The director opens an action round and identifies its current situation.
2. Players submit intent, approach, optional exact dialogue, and an optional fallback.
3. The AI proposes no-roll rulings or action contracts, including dependencies and assistance.
4. The director reviews the whole batch; affected players see the stakes and can revise their submissions.
5. The director locks the accepted input and contracts. The server rolls each required check once.
6. The server selects the approved outcome branches and stages their effects.
7. The AI writes the resulting scene, including NPC dialogue where appropriate, using those fixed results.
8. The director reviews or edits the draft, prepares audio, and publishes the beat.
9. The application commits canonical changes and makes the approved result available to clients.

**Default:** the director manually advances rounds. Ready indicators are helpful, but one missing player does not automatically block play. The director may mark them as holding position. The AI must not invent an action for an absent player.

## 3.4 Switching modes and narrative time

The director explicitly chooses conversation or action mode. The AI may recommend a switch but cannot silently start a roll or publish a new scene.

Conversation beats do not automatically tick action-round countdowns. However, players cannot freeze an urgent situation through endless conversation. The director may declare that a further exchange consumes a meaningful time unit, then use the action workflow with the time consequence visible in advance.

Once an action batch is locked, conversation submissions queue for the next beat. Do not let concurrent replies change facts underneath a pending resolution. Permit only one active canonical-writing beat per session.

Out-of-character questions are marked separately. They are not NPC speech and do not become in-world facts.

---

# 4. Lightweight rules v0.1

This section retains the agreed rules proposal. Implement it as a versioned rules configuration. It is intentionally smaller than a traditional TTRPG.

## 4.1 Character traits

Each character allocates **+2, +1, +1, and +0** across:

| Trait | Typical approaches |
|---|---|
| Force | Strength, endurance, breaking things, direct physical confrontation |
| Finesse | Sneaking, agility, precision, delicate manipulation |
| Wits | Investigation, technical work, knowledge, planning |
| Presence | Persuasion, deception, performance, intimidation |

The described approach determines the trait. Rephrasing a punch as a clever punch does not automatically change it to Wits.

Characters also have one bounded specialty, one voluntary roleplaying flaw, three notable possessions, and one connection to another character. Specialties establish capabilities, not automatic additional modifiers. Flaws never authorize the AI to take over a player character.

Unusual powers require a scope approved before play. Define what an illusion, psychic talent, or technological ability can and cannot do. Character cards are scenario-independent templates; live sessions use approved snapshots with their own mutable state.

## 4.2 Check and outcome

**Total = 2d6 + trait + Edge.** Edge is either 0 or +1.

| Total | Outcome | Contract |
|---|---|---|
| 10+ | Clean success | The agreed goal occurs without a consequence from this check |
| 7-9 | Success with a cost | The agreed goal occurs and the declared cost applies |
| 6 or lower | Setback | The agreed goal is not achieved and the declared setback changes the situation |

A 7-9 is still success. A clean success protects the agreed action, not unrelated characters against independent hazards.

Use server-generated dice from a cryptographically secure random source. Store the two faces, trait, Edge, total, band, contract version, and relevant identifiers. Inject deterministic dice in tests. Do not use model-generated dice or browser-authoritative random values.

No critical hits, critical fumbles, damage dice, hidden target-number adjustments, spendable luck, or rerolls in v0.1.

Exact baseline probabilities from enumerating the 36 equally likely ordered dice pairs:

| Modifier | Setback | Costly success | Clean success |
|---|---:|---:|---:|
| +0 | 41.7% | 41.7% | 16.7% |
| +1 | 27.8% | 44.4% | 27.8% |
| +2 | 16.7% | 41.7% | 41.7% |
| +3, including Edge | 8.3% | 33.3% | 58.3% |

## 4.3 When to roll

Every proposed consequential action is classified as:

- **No check:** achievable without meaningful uncertainty or danger.
- **Check:** achievable, uncertain, and consequential.
- **Blocked:** not currently achievable. Explain the missing requirement and a possible direction.

No repeated-roll fishing against the unchanged situation. A new attempt needs new leverage, resources, approach, or circumstances.

Do not hide the only essential clue behind a successful check. A sensible investigation can find the clue while a check determines exposure, delay, extra detail, or another real consequence.

## 4.4 Stakes and consequences

Each contract states intent, approach, trait, risk, Edge source, success scope, and all three outcome branches. Each branch has public text and typed effects.

Risk changes the severity or scope of the declared result, not the target thresholds:

| Risk | Typical cost on 7-9 | Typical setback on 6 or lower |
|---|---|---|
| Low | Minor narrative complication | Modest complication or 1 strain/danger |
| Normal | 1 strain/danger or equivalent complication | 2 strain/danger or substantial complication |
| High | 2 strain/danger or serious complication | 3 strain/danger or major complication |

These are tuning defaults. A consequence is one agreed package, not permission for the model to pile on unrelated penalties. Costs must fit the action. Complications that do not use a numeric track still need a structured, reviewable record.

Social checks follow the same rule. Agree on an achievable concession, such as temporary access or an answer, not magical control of an NPC's entire personality. A successful roll must deliver that concession. Nobody can roll to dictate another player character's beliefs or decisions.

## 4.5 Multiplayer actions

Each player gets one consequential action per action round, plus ordinary dialogue and incidental movement.

**Independent:** resolve distinct objectives separately and narrate their results coherently in the same moment. Submission arrival order gives no fictional advantage.

**Shared:** one lead rolls; a meaningful helper spends their action to grant +1 Edge. Additional helpers do not stack bonuses. Establish who is exposed to the consequence. One shared alarm incident increments its track once, not once per helper.

**Dependent:** resolve a prerequisite first. If it fails, use a predeclared fallback or hold the dependent action. Do not roll for an opportunity that never existed. Default to shallow chains and reject cycles. A risky fallback requires its own preapproved contract; otherwise hold it for the next round.

A character cannot spend the same action as both a helper and an independent lead. Clarify contradictory plans before locking. No involuntary PvP in v0.1.

Aggregate independent numeric effects against the same snapshot before applying bounds and checking track completion. Explicit dependencies use their declared causal order. Conflicting nonnumeric changes, such as two characters claiming the same unique item, require a ruling before locking rather than arbitrary last-write-wins behavior.

## 4.6 Edge and equipment

Edge is a non-stacking +1 from meaningful assistance or established situational advantage. Trait +2 and Edge +1 is the highest ordinary total modifier.

A specialty or ordinary required tool does not automatically grant Edge. Better preparation may instead remove the need for a roll, lower the risk, or expand the possible result.

Inventory changes must be explicit effects. The AI cannot invent useful equipment, consume an item twice, or destroy a possession outside the approved branch.

## 4.7 Strain and recovery

Each character has **0-4 strain**. Strain never reduces trait values.

At four strain, the character **needs help** and cannot initiate another risky action until recovery. They remain able to talk, decide, and contribute when the circumstances permit. Avoid benching a guest for an extended period.

Helping someone recover uses an action and clears two strain. It succeeds automatically in safety; under threat it uses the normal contract/check process. A genuine safe scene break clears remaining strain. Equipment losses and other enduring consequences do not automatically disappear.

No permanent player-character death by default. Capture, lost objectives, damaged reputation, retreat, and rescue are available failure states. Any lethal variant is a later explicit group option.

## 4.8 Progress, danger, countdowns, and combat

Complex obstacles use 4-, 6-, or 8-segment progress tracks. A typical successful action contributes two segments; a limited or especially effective approach can contribute one or three if declared beforehand. Both successful bands grant the agreed progress.

A **danger track** advances through specified consequences. A **countdown** advances on its declared trigger, such as a committed action round. Do not tick either during generation retries, playback, or ordinary conversation.

A countdown trigger is evaluated once when the round is published. Its completion consequence must already be visible or intentionally recorded as a director-approved hidden event. The UI must distinguish known danger from director-only suspense. A hidden event may reveal new fiction; it must not smuggle in undeclared damage or negate an agreed clean success.

If progress and danger complete together, honor both where possible: the party secures the artifact and the alarm sounds.

Combat uses this same system. No separate initiative, armor math, monster turns, or unannounced extra attacks. An ordinary adversary can be one check; a major adversary can be a progress track with a prerequisite or vulnerability. Separate environmental hazards must be established, not invented after the roll.

---

# 5. NPCs, direct dialogue, and continuity

## 5.1 NPCs are entities, not names in a transcript

Every speaking NPC MUST have a stable session entity ID. Reappearing NPCs retain identity, voice assignment, history, and relationships. Two NPCs may share a name without becoming the same entity. A disguise or alias must not accidentally create a duplicate person.

The scenario can seed NPC templates. The AI can propose new NPCs during play, but they remain draft entities until approved. The server allocates stable IDs and validates every script reference. Do not let an unknown speaker silently enter a published script.

An incidental speaker may use a minimal card, such as "unnamed station attendant," but still needs an ID. Expand their card if they become important. Mark NPCs offstage rather than deleting their history.

## 5.2 NPC record

| Field group | Required information |
|---|---|
| Identity | Stable ID, scenario-template reference if any, display name, aliases, optional hidden identity |
| Public presentation | Role, concise appearance, mannerisms, portrait or initials fallback |
| Characterization | Personality anchors, dialogue examples, vocabulary, current mood |
| Intent | Persistent motivation, immediate goal, limits, current attitude |
| State | Location, present/offstage status, relevant conditions, current involvement |
| Relationships | Stance toward party or particular PCs, reason, supporting event |
| Knowledge | Facts observed, information received, beliefs, source, and when learned |
| Secrets | Hidden facts, who can know them, and approved reveal conditions |
| Voice | Stable voice-profile assignment; fallback profile |
| Continuity | Recent meaningful interactions, promises, debts, unresolved hooks, source event IDs |

Relationship stances can initially be **hostile, wary, neutral, friendly, trusting**. They are descriptive, not numerical bonuses. Changes need an event and a reason, not arbitrary drift on every generated reply.

## 5.3 Facts, beliefs, and lies are different

Store objective world facts separately from NPC beliefs and spoken claims.

If Mara says the ledger was burned, the application records that Mara made the claim. It does not automatically mark the ledger destroyed. An NPC can be wrong, deceptive, uncertain, or deliberately evasive.

An NPC does not know a private event merely because the model has seen it elsewhere in the session. Record how information reached them: witnessed, overheard, told by a named source, or supplied by the scenario.

The prompt builder should select only relevant knowledge and authorized reveals for the NPC performance. Prefer withholding unrelated secrets from the performance prompt entirely. Structural validation cannot prove that generated prose contains no semantic spoilers; director review remains part of the safety boundary.

Summaries are secondary aids. They do not outrank canonical facts, approved cards, event-backed NPC knowledge, or the actual transcript.

## 5.4 Dialogue performance rules

The AI MUST:

- Answer actual player questions, or make the NPC's refusal or evasion explicit.
- Use direct speech when an NPC speaks, interleaved with concise third-person narration.
- Keep voice, personality, knowledge, and relationships consistent.
- Address the relevant player or party, using stable recipient references.
- Let NPCs ask questions, disagree, joke, and pursue goals without monopolizing the scene.
- Stop at a meaningful opening for a player response rather than simulating both sides.

Do not force every NPC to respond to every line. DEFAULT: one primary respondent and at most one relevant interjection per conversation beat. NPC-to-NPC exchanges are allowed, but keep them short and return the spotlight to the players.

Do not turn every interaction into a dice check. Do not force dialogue into a scene with no available speaker. Action-round narration should include NPC reactions when fictionally appropriate, not a mandatory quota of quotes.

DEFAULT spoken budgets: 30-90 words for a conversation response; 60-120 words for an ordinary action resolution. These include narration and NPC speech, but exclude player-authored text unless selected for TTS. Openings and finales can be explicitly longer. Treat these as pacing targets, not hard constraints that truncate a necessary answer.

## 5.5 Player speech and the existing voice call

Players keep using Discord or their existing call. The app does not listen to that call in v0.1. The AI only knows dialogue that has been submitted as text or entered by the director.

Separate these fields in the player UI:

- **Say:** exact in-character words, addressed to an NPC or the party.
- **Act:** intent and approach, with optional exact dialogue as part of the action.
- **Out of character:** clarification for the director, never automatically spoken by an NPC.

A "spoken aloud already" flag prevents duplicate TTS. Player lines are captioned verbatim when published; PC TTS is off by default. The AI may not improve, rewrite, or add to a player's quote. A revised quote requires the player's approval or an explicitly identified director correction.

## 5.6 Example exchange

**Player submission:** Kasey addresses Mara: "You knew the previous owner. What happened to him?"

**Narration:** Mara stops polishing the glass. Her eyes settle on the empty stool beside Kasey.

**Mara:** "He learned the difference between owning this place and being allowed to keep it. Why are you asking?"

**Player follow-up:** "Because someone just offered to sell it to us."

**Narration:** Mara sets the glass down carefully.

**Mara:** "Then someone expects you not to survive the paperwork. Show me the seller's name."

This is two conversation beats, no forced checks, and a new hook. The transcript attributes the words; the NPC record tracks that Mara learned about the sale offer. The AI has not decided that Kasey hands anything over.

---

# 6. Structured scene scripts and public performance

Do not represent the AI output as one undifferentiated paragraph. Use ordered segments with explicit speaker and audience metadata.

Minimum segment kinds:

| Kind | Author / speaker | Purpose |
|---|---|---|
| narration | AI narrator or director | Third-person scene description and observable consequences |
| npc_dialogue | Registered NPC | Direct, speakable NPC words |
| player_dialogue | Player submission reference | Exact player-authored quote; normally captions only |
| system | Application | Dice outcomes, track changes, readiness; not fictional narration |

Each segment has an ID, text, speaker reference where applicable, recipients, visibility, source references, and TTS eligibility. Delivery hints use a bounded vocabulary, such as neutral, quiet, urgent, or amused. The model cannot supply arbitrary TTS provider commands or voice IDs.

NPC dialogue segments contain the spoken words without duplicating the speaker label inside the text. The renderer supplies labels, portraits, and quotation styling. Narration can surround the quote to produce conventional third-person prose in a transcript export.

The storyteller returns AI-authored narration and NPC dialogue only. Player-dialogue segments are inserted by application code from accepted submissions. This prevents paraphrased or invented PC speech from becoming an apparent player quote.

Director notes and model diagnostics are not script segments. Keep them in a separate private structure. Never send raw model output directly to OBS or a TTS provider.

---

# 7. Scenario and character authoring

## 7.1 Scenario package

Provide a form-backed editor plus a native JSON import/export format with `schemaVersion`. The package contains:

- Public title, premise, genre, tone, and opening situation.
- Session boundaries, topics to avoid, and content expectations for the cast and broadcast.
- Locations, relevant objects, initial facts, and initial progress/danger tracks.
- NPC templates, their knowledge, motives, relationships, secrets, and dialogue examples.
- Player hooks, objectives, possible discoveries, and optional story opportunities.
- Director-only notes, secret reveal conditions, and possible escalation/finale paths.
- Default rule configuration, pacing settings, and voice-profile suggestions.

Plot opportunities are not a mandatory screenplay. Do not force players back to a predetermined ending or invalidate a successful plan just because it skipped a planned scene.

When a session starts, snapshot the scenario version. Editing the reusable package must not mutate a live adventure. A director may apply explicit live edits through audited session operations.

## 7.2 Character cards

A native card includes name, pronouns if supplied, appearance, personality, backstory, traits, specialty limits, flaw, possessions, connection, optional secret, and optional portrait.

Validate the trait allocation and scenario compatibility. The director approves cards before active play. No card text may override system rules, role permissions, other players' agency, or safety settings.

Keep an optional extension-data field for future interoperability, but do not claim SillyTavern PNG/JSON compatibility before an actual adapter and fixtures exist. Full external-card and lorebook import is LATER. Do not execute scripts or fetch arbitrary URLs found inside imported content.

---

# 8. User experience and screen inventory

One Vue application can provide role-specific routes. Routes below are design defaults, not a pre-existing API.

| Route | View | Essential content |
|---|---|---|
| `/` | Host home | Create/resume session, scenario library, recent sessions |
| `/scenarios/:id` | Scenario editor | Public brief, cast, NPCs, lore, secrets, opening scene |
| `/join/:token` | Invite redemption | Join identity, assigned seat, token exchange, audio check |
| `/sessions/:id/lobby` | Lobby | Cast, character builder, approvals, readiness, session boundaries |
| `/sessions/:id/play` | Player view | Shared story, active NPCs, Say/Act controls, own character, stakes, status |
| `/sessions/:id/director` | Director workspace | Mode, queues, actions, stakes, script preview, NPC inspector, publication |
| `/sessions/:id/stage` | OBS presenter | Public story, active speaker, dice, tracks, character strip, captions |

## 8.1 Player view

Prioritize the current situation and input, not a wall of settings. Show the selected addressee, whether the input is dialogue or action, and whether it is queued, under review, locked, or published.

Players can edit their own draft until locked. Show pending confirmation for unsaved or offline input. A reconnect must not silently submit a stale message into a later round.

Show public NPC cards and identities only. A secret true name must not leak through tooltips, portrait alt text, debugging identifiers, or accessibility labels.

## 8.2 Director workspace

Keep the routine workflow on one screen: queue on the left, scene/script preview centrally, NPC/state inspector on the right, with clear primary actions.

Required controls: open conversation/action, choose pending speech, request contracts, revise stakes, lock and roll, edit or regenerate script, prepare audio, publish, pause/stop playback, skip audio, manual narration, inspect NPCs, and record a correction.

Batch approvals must be possible. Do not require a modal per player, per NPC line, or per die. Nevertheless, show a visible state-diff preview before publication.

Allow private steering such as "Mara is bluffing; let her become defensive without revealing the ledger's location." Steering is not shown to players or spoken aloud.

## 8.3 Stage

DEFAULT canvas: 1920 by 1080, readable as a reduced-size Twitch video. Use a clear cast strip, one active speaker, short caption chunks, large dice results, and at most a few relevant tracks. Provide initials/neutral artwork when portraits are missing.

Give the audience the wager before showing a roll: actor, goal, possible consequence. Credit helpers visibly. Display both narrator and NPC names correctly; one generic "AI DM" label is insufficient for dialogue.

Use a deliberately different route and server projection from the director view. Never broadcast a cropped director screen as the normal solution.

OBS Browser Source supports web-based layouts and audio [R5]. The app should supply a stage URL and a setup checklist, not require a custom OBS plugin.

## 8.4 Interaction and accessibility

Use explicit status labels, not color alone. Provide keyboard navigation, readable contrast, scalable text, captions, and reduced-motion behavior. Destructive or state-changing shortcuts must not trigger from ordinary text entry.

DEFAULT visual direction: a clean, dark live-show interface with strong typography and restrained animation. This is a recommendation, not a requirement to build a design-system package before gameplay works.

---

# 9. Architecture defaults

Use a small, conventional TypeScript application rather than distributing the first version across microservices.

| Concern | Default |
|---|---|
| Frontend | Vue 3, Vite, TypeScript |
| Backend | Node.js on a supported, pinned LTS release, TypeScript, Fastify |
| Realtime | Socket.IO for server notifications and playback coordination |
| Commands | Authenticated HTTP endpoints with explicit idempotency and version checks |
| Persistence | PostgreSQL, SQL migrations, relational records plus validated JSONB where useful |
| Validation | Shared Zod domain/wire schemas; separate public/private DTOs |
| Model access | One concrete provider adapter plus a fake provider; configurable model IDs |
| Speech | One concrete TTS adapter plus fake/silent mode; cached audio assets |
| Assets | Local persistent volume initially, behind a storage interface |
| Testing | Vitest for unit/integration tests; Playwright for browser flows |
| Development | Workspace repository and Docker Compose for local app/database dependencies |
| Deployment | One persistent application service with PostgreSQL and durable asset storage |

These are project recommendations, not claims that all versions are mutually compatible. Codex must verify current supported versions, pin them, and record its selection when initializing the repository.

**Do not add Redis, a vector database, Kubernetes, a workflow SaaS, or an agent framework for the MVP.** A PostgreSQL-backed job table and a bounded worker loop in the application are adequate design defaults for this scope. Preserve seams for later scaling without building that scaling now.

Suggested repository shape:

```text
apps/
  web/                 # player, director, lobby, and stage views
  server/              # HTTP, sockets, orchestration, provider adapters
packages/
  contracts/           # schemas, public/private DTOs, event contracts
  rules/               # pure dice, outcomes, effects, dependency checks
  test-fixtures/       # scenario, characters, fake AI responses
migrations/
docs/
  PROJECT_PLAN.md
  ARCHITECTURE.md
  IMPLEMENTATION_PLAN.md
  decisions/
```

Keep model/provider-specific shapes inside adapters. An "OpenAI-compatible" endpoint does not imply identical schema, streaming, refusal, or audio behavior. Detect and document the capabilities of the implemented adapter rather than assuming parity.

---

# 10. Server modules and AI responsibilities

## 10.1 Modules

**Session orchestrator:** validates commands, transitions phases, establishes immutable input snapshots, coordinates jobs, and publishes approved beats.

**Rules engine:** pure functions for trait validation, roll bands, assistance, dependency order, branch selection, bounds, and typed effects. It does not call the model.

**Context builder:** assembles the applicable scenario, current state, cards, NPC knowledge, recent transcript, and approved director steering.

**AI adapter:** requests contract plans and performance drafts using versioned schemas and prompts.

**NPC continuity service:** validates identities, knowledge updates, relationships, promises, status, and source references.

**Publication service:** validates a complete beat, commits changes transactionally, writes outbox events, and builds audience-specific projections.

**Speech service:** transforms approved public script segments into cached audio and a playback manifest.

**Playback controller:** maintains playback ID, position, pause state, presenter ownership, and reconnect behavior independently of game-state mutation.

## 10.2 AI calls

Use one DM model role with distinct tasks, not one autonomous agent per NPC.

1. **Plan beat:** classify conversation versus action, identify relevant speakers, propose checks and branches, and flag ambiguity. The model proposes; the director approves.
2. **Render beat:** write narration and direct NPC dialogue from accepted input and fixed results. It may propose bounded continuity additions, but cannot replace the selected mechanical effects.
3. **Summarize:** optionally compact published history into an event-linked summary. This is not on the critical path and never creates canonical facts.

A pure conversation can use the same planning and rendering boundaries, with no roll step. Avoid publishing an NPC concession during planning, before its required check has been resolved.

Use structured outputs where the provider supports them. OpenAI documents schema-constrained responses, but also notes that valid structured output can still contain mistakes and that refusal/incomplete responses need explicit handling [R3]. Semantic validation and human review remain required.

Do not request or store hidden chain-of-thought. Store short ruling summaries, selected evidence, validation messages, and operational metadata sufficient to inspect the decision.

## 10.3 Context policy

Include the rules version, public scene, relevant canonical facts, active player cards, selected NPC records, accepted submissions, approved contracts, fixed rolls, and recent published beats. Retrieve lore using explicit entity/location references and bounded keyword matching initially.

Maintain three forms of continuity: complete published transcript, current canonical state, and a compact summary. NPC memory and knowledge are separate structured records with provenance.

Do not send the entire campaign, every secret, and every NPC card on each request. Treat submitted character text, imported lore, dialogue, and audience suggestions as data, not higher-priority instructions. The application exposes no shell, arbitrary network, or database tool to the DM model.

SillyTavern's documentation offers useful precedents for lore selection and speaker management, while warning that combined character definitions can confuse identities [R1, R2]. This engine instead uses explicit IDs, selected context, and a single reviewed script.

## 10.4 Validation boundary

Schema checks: required fields, enums, lengths, supported segment kinds, valid IDs. The AI rendering schema excludes player-dialogue segments; player quotes enter the public script only through application-controlled insertion.

Domain checks: NPC exists and can participate, PC quotes reference exact submissions, effect bounds hold, selected branches match rolls, no unknown item/track changes, no prerequisite violations, and all proposed changes have provenance.

Presentation checks: required direct speech when the beat depicts an NPC speaking, no unresolved placeholders, no director-only fields, and a useful opening for player response.

Prose consistency, secret leakage, and characterization cannot be perfectly verified with schema checks. Surface warnings and retain director approval rather than claiming these are solved deterministically.

---

# 11. Canonical lifecycle, transactions, and recovery

## 11.1 Session and beat state

Session status: `lobby`, `live`, `paused`, `ended`.

Action beat phases:

```text
collecting -> planning -> stakes_review -> locked_rolled
           -> rendering -> draft_review -> preparing_media -> ready -> published
```

Conversation beat phases:

```text
collecting -> planning -> rendering -> draft_review
           -> preparing_media -> ready -> published
```

Conversation planning can instead return `needs_action`, routing back to stakes review before any consequential response is published. No-roll action plans may pass through lock without creating dice records.

`paused` belongs to the session/playback controls, not a destructive reset. Recoverable job failures preserve the last good beat phase and display retry/manual options. An aborted draft is recorded with a reason; it is not deleted from the audit history.

## 11.2 Lock and roll

Lock the accepted submissions, contracts, current state revision, and input hash. Use a database transaction to create roll records and the selected branch/effect set. A unique constraint on a check's resolution prevents duplicate rolls.

Do not hold a database transaction or row lock open while calling a model or TTS service. External calls operate on a saved snapshot. Their results are accepted only when the snapshot and job lease are still current.

After rolling, do not quietly edit intent, risk, Edge, success scope, or branches. A ruling error requires an explicit, audited correction. Regenerating narration always reuses the same dice and mechanical effects.

## 11.3 Publication is the canonical commit

Draft narration, proposed NPC additions, and staged effects are not live state. In one publication transaction:

1. Verify role, beat identity, expected state revision, approved draft hash, and idempotency key.
2. Validate all referenced entities and selected effects.
3. Apply mechanical changes and approved continuity updates.
4. Save the published script, accepted player lines, and relevant snapshots.
5. Increment the canonical revision and beat number; increment the action-round number only for an action beat.
6. Evaluate applicable countdown triggers once and include their predeclared effects.
7. Write the audit event and role-appropriate outbox notifications.

Prepare the countdown outcome in the staged result before rendering so the narration can reflect it; validate and apply it once at commit. Do not discover an extra mechanical consequence only after the reviewed script has been published.

Publishing must work without TTS when the director explicitly selects text-only mode. Audio failure cannot force a reroll or make a published state partially committed.

## 11.4 Concurrency and idempotency

Use separate versions for canonical state, beat input, and individual submissions. Independent players saving their own submissions should not conflict merely because another player also typed. Locking must verify the complete accepted input snapshot.

Every mutation has an authenticated actor, command ID/idempotency key, relevant expected version, and request hash. A duplicate command returns its recorded result. Reusing a key with a different payload is rejected.

The database is authoritative for session locks and job leases. Enforce at most one resolving/publishing beat per session. Do not rely only on in-memory mutexes.

Job retries may repeat a paid provider request after an ambiguous timeout. Record this possibility and control retry budgets. The guarantee is **no duplicate canonical effect or roll**, not impossible claims of exactly-once external calls or audio delivery.

## 11.5 Reconnect and crash recovery

Socket.IO provides ordering, but default delivery is at-most-once, and connection recovery is not guaranteed [R6, R7]. Use durable session events and a snapshot endpoint with a monotonic revision. After reconnect, reconcile state from the server, then replay authorized events after the client's cursor when available.

Persist jobs, input snapshots, rolls, selected effects, approved script hashes, and publication status. A process restart resumes or exposes a recoverable job, not a new game.

Use an outbox to ensure a commit is eventually announced even when the process crashes before emitting a socket event. Consumers deduplicate events by ID. A reconnect must never apply the same effect again.

Store current relational state plus an append-only audit log and checkpoint snapshots. Full event-sourcing infrastructure is not required for v0.1. Recovery from an ordinary restart uses the database, not a model-generated reconstruction of the story.

Before publication, editing creates a new draft revision and invalidates affected audio. After publication, corrections are new, visible events with a reason. An already-heard line cannot truly be unspoken. General timeline rollback/branching is LATER.

---

# 12. Data model

Use normal relational records for ownership, identity, versions, and lifecycle. Use validated JSONB for bounded scenario definitions and script/effect structures where it simplifies the implementation.

| Entity | Main fields and relationships |
|---|---|
| Host account | Owner identity and access policy; no public host registration required initially |
| Session | Owner, scenario snapshot, rules version, status, mode, canonical revision, current scene/beat |
| Membership / seat | Session, user/session identity, role grants, assigned PC, connection status |
| Invite / credential | Hashed token, scope, expiry, revocation, redemption record |
| Scenario template/version | Reusable package and immutable version data |
| Character template/version | Reusable card and approval data |
| Session character | Template snapshot, owner seat, traits, strain, possessions, public/private fields |
| Scene | Public situation, location, active cast, director notes, lifecycle |
| NPC template | Reusable scenario-level character definition |
| Session NPC | Stable identity, public presentation, private intent, state, voice, version |
| NPC knowledge/belief | NPC, fact/claim reference, source event, acquisition mode, confidence/category |
| Relationship | NPC, PC/party target, stance, reason, source event |
| World fact / claim | Statement, truth/category, visibility, evidence, valid/superseded status |
| Track | Scene/session, progress/danger/countdown kind, current/max, trigger, completion effect |
| Submission | Player, beat/queue context, say/act/OOC kind, recipients, text, revision, status |
| Beat | Conversation/action kind, phase, accepted inputs, snapshot hash, draft and published revisions |
| Action contract | Actor/helpers, trait, Edge, prerequisites, three branches, approval version |
| Roll | Contract, immutable faces/modifiers/total/band, resolution ID |
| Script segment | Beat revision, order, kind, speaker, recipients, text, visibility, provenance |
| Effect / continuity proposal | Typed operation, target, cause, approval, applied event |
| Audio asset / manifest | Content hash, provider/model/voice version, storage key, duration, segment mapping |
| Playback | Publication, playback ID/epoch, status, position, presenter lease |
| Generation job | Task, immutable snapshot, lease, attempt, status, usage, validation errors |
| Audit event / outbox | Sequence, actor, causal command, visibility, payload, dispatch status |

Avoid a single untyped `game_state` blob that the model replaces wholesale. Avoid using the same object type as a database record, director response, player response, and stage response.

Important constraints: valid trait multiset; strain between zero and four; bounded tracks; one active beat; unique roll per check; stable NPC references; script-order uniqueness; one application of each effect; versioned publication uniqueness; membership scoping on every query.

---

# 13. HTTP and realtime contracts

Define schemas before wiring components. These are capability names, not mandatory endpoint spellings.

## 13.1 HTTP capabilities

- Create session, redeem invite, read authorized snapshot, resume membership.
- Read/update own character draft; director approval.
- Create/edit/cancel own submission while permitted.
- Open beat, select queued speech, request plan, edit/approve contracts, lock/roll.
- Request/regenerate script, edit script, approve continuity proposals, prepare media.
- Publish beat, create explicit correction, pause/resume/end session.
- Inspect/edit NPCs and scenario state through director-authorized operations.
- Fetch authorized audio assets and public/private exports as appropriate.

Responses should include stable operation/job IDs for long-running work and clear conflict messages for stale input. Do not expose raw provider exceptions or secrets to guests.

## 13.2 Socket event categories

| Event | Audience |
|---|---|
| `session.snapshot_available` | Authorized clients, with their projection revision |
| `submission.status` | Submitting player and director |
| `party.readiness` | Party/director; public stage gets only an approved aggregate |
| `beat.plan_ready`, `beat.draft_ready`, `job.failed` | Director only |
| `stakes.published` | Relevant players and optionally stage |
| `beat.published` | Public/party/director projections, separately serialized |
| `playback.scheduled`, `playback.paused`, `playback.stopped` | Authorized playback clients |
| `presence.changed` | Appropriate cast/director view |

Each durable event needs `eventId`, session/beat references, sequence/revision, and schema version. Do not emit a director payload to a public room and ask the browser to filter it.

Presence and playback telemetry are not game authority. Player clients cannot mutate canonical state by emitting a familiar-looking event name.

---

# 14. TTS, voices, and broadcast audio

## 14.1 Speech pipeline

Generate audio from the director-approved public script, once per immutable content/voice configuration, then reuse those assets for the presenter and player browsers. Do not generate separate versions for every listener.

Use a manifest of ordered segments with speaker, asset ID, duration, and caption text. Cache keys include exact text, provider, model, voice profile, relevant delivery settings, and access scope. Editing a line invalidates its audio and the corresponding manifest revision.

Keep stable voice-profile assignments for the narrator and recurring NPCs. A small set of configured voices is sufficient; multiple NPCs may share a voice. Attribution and continuity are required even when only one voice is available.

**MVP fallback:** one narrator voice can perform all AI-authored lines, with speaker identification in captions and optional spoken attribution. A more elaborate voice cast must not block the core dialogue feature.

## 14.2 Playback control

One designated presenter client supplies the broadcast mix. Player listening is optional and local. The host/director's ordinary browser should default to muted monitoring when OBS already supplies that audio.

A single active presenter lease prevents two stage tabs from both acting as the broadcast presenter. This is an app-level safeguard, not a guarantee against misconfigured desktop audio capture. The rehearsal must check the actual OBS/Discord routing.

Prepare assets before scheduling playback. Send a unique playback ID/epoch, manifest, server start time, and offset. Clients estimate server-time offset and attempt to align, but do not promise sample-accurate synchronization across browsers and networks.

Provide enable-audio, local volume/mute, director pause/resume/stop, skip segment, text-only continuation, and intentional replay. Replay starts a new playback epoch and does not reapply game effects.

On reconnect, join the current playback position or remain muted with a catch-up option. Do not automatically replay the entire past beat. Optional listeners must never hold up the stream because they failed to acknowledge readiness.

DEFAULT: one public performance at a time. New speech can queue while playback runs. A director stop immediately stops playback locally and sends the stop event; published canon remains intact.

## 14.3 Browser and provider constraints

Browsers may block audible autoplay until user interaction. Catch playback failures and provide an explicit Enable Audio control; test the actual OBS embedded browser separately [R8].

The OpenAI speech documentation supports streaming audio and calls for clear disclosure that the voice is AI-generated [R4]. For this app, use a visible disclosure such as "AI-generated narration and character voices." Streaming synthesis is optional; approved cached segments are the simpler first implementation.

Only approved public content is eligible for broadcast TTS. Private notes, character secrets, internal plans, and diagnostics never enter the broadcast speech request. No voice cloning is needed for the MVP.

Captions are segment-level initially. Word-level alignment and karaoke highlighting are LATER.

---

# 15. Security, privacy, and content controls

The first deployment can be invite-only. It still needs real authorization.

Use an authenticated host/director account. Bootstrap the first host through deployment configuration or a secure enrollment step, not an unauthenticated "become director" button. Player invite tokens should be high-entropy, scoped, revocable, and exchanged for secure session credentials. A public session ID is not a credential.

Use secure, HTTP-only cookies where appropriate; protect state-changing requests against cross-origin abuse, verify socket origins and credentials, and apply per-role authorization on every command. A stage credential is read-only apart from scoped playback telemetry. Never place a director token in an OBS URL.

Redact credentials from logs and referrals. A redeemed invite should leave the address bar. Scope asset access to the appropriate session/audience. Do not serve draft or private audio from guessable public paths.

Treat generated and user text as untrusted content. Render text safely; sanitize any deliberately supported markup. Validate uploads, sizes, MIME types, and JSON schemas. Do not execute imported scripts or allow arbitrary remote fetches from lore/card fields.

Keep provider keys server-side. Model IDs and rate/budget settings are configuration, not client-controlled request parameters.

Session setup includes agreed content boundaries and a pause/stop control. The director can discard unsuitable output before publication. A player can request a pause without a fictional penalty. AI generation does not bypass provider policies or the cast's boundaries.

Use an allowlisted public serializer and automated leakage tests. Prompt instructions alone are not a privacy boundary. Major unrevealed secrets should be absent from performance contexts until needed, with director review covering remaining semantic risk.

---

# 16. Observability, costs, and operational controls

Record session/beat/job IDs, model/provider versions, prompt/schema versions, request durations, retry counts, validation outcomes, token usage when available, TTS usage, and publication latency.

Do not log full secret-bearing prompts by default. A director-only diagnostic export can be added with clear access and retention rules. Never log API keys or invite credentials.

Expose an operator panel with current job status, last successful save, provider failure, audio readiness, and estimated usage. Costs are estimates based on configured current rates, not invented fixed prices. Set bounded retry counts and a per-session generation limit/budget stop.

Track rehearsal measurements: time from input selection to reviewed draft, narration duration, number of manual corrections, failed/repeated playback, unresolved action conflicts, and how often a player has no meaningful participation.

No latency promise is assumed in this specification. Set service targets after measuring the chosen model, TTS provider, and hosting environment. Design every waiting state with a useful status, cancellation boundary, and manual fallback.

Provide persistent volumes, database backups, a restore procedure, migration commands, health/readiness endpoints, and a simple deployment checklist. The running process must not be the only copy of a session or its audio assets.

---

# 17. Seed scenario and vertical-slice fixture

Use a small original fixture named **The Ledger Job**. This is a test scenario, not a required first-show script.

**Premise:** The party needs a ledger from a members-only club before a buyer arrives.

**Locations:** Public bar, service corridor, archive office.

**NPCs:**

- **Mara Vale, bartender:** dry humor, cautious but curious; knows the owner is missing; wants evidence before trusting strangers; does not know what happens in the archive unless told or alerted.
- **Inspector Dax, visiting official:** procedural, vain, easily drawn into arguments about paperwork; expects the club to hide something.
- **Biscuit, guard dog:** attentive to food and familiar handlers; an optional later reveal can make the dog intelligent, but this is not a default fact the AI may introduce casually.

**Tracks:** Archive access 0/4; Security alert 0/6; Buyer arrival after three committed action rounds, enabled only when the director announces that countdown.

**Known clue:** The ledger matters to the missing owner's disappearance. Basic investigation must not lose the only path forward on a failed roll.

**Character fixtures:** Four original PCs with different +2 traits, approved limited specialties, one connection each, and stable IDs. Human display names are configurable.

The fixture must support: two consecutive conversation beats with Mara, an ordinary NPC refusal without dice, a risky persuasion attempt with declared stakes, a shared action with a helper, a dependent action, an independent failure, and a later callback proving Mara remembers what she actually learned.

Create fake-provider responses for each outcome band, invalid JSON/schema, an unknown speaker, an attempted PC quote rewrite, a semantic contradiction, and a timeout. These are test data, not actual live-provider quality claims.

---

# 18. Scope and priority

## P0: first-show requirements

Invite-only host/player access; four-player lobby; native character cards; editable reusable scenario; tracked NPCs; conversation beats with direct speech; coordinated action rounds; approved contracts; server dice; deterministic effects; director draft review; structured script; public OBS stage; narrator/NPC attribution; one working TTS provider and text-only fallback; persistence; reconnect; manual narration/corrections; public/private separation; a complete rehearsal fixture.

Stable NPC voice profiles and per-segment voice selection belong in the data model. A rich palette of unique NPC voices does not have to be delivered before a single-voice rehearsal.

## P1: useful after the core is reliable

AI-assisted character/scenario authoring, more voice presets, richer portraits, improved spotlight suggestions, public transcript exports, manual audience-event cards, and an audience vote whose result the director enters.

## Later

Twitch OAuth and chat/EventSub integration, Channel Points/Bits mechanics, public audience accounts, SillyTavern card adapters, private split-party scenes, speech recognition, interruption-aware voice agents, automatic illustrations, tactical maps, long-term progression, complex economies, timeline branches, multiple simultaneous campaigns at scale, and autonomous NPC simulations.

**Scope-cut order:** remove advanced animation, unique voices, AI authoring helpers, and audience integrations first. Do not cut tracked NPC conversation, state integrity, authorization, director review, or recovery to make room for visual polish.

---

# 19. Milestones and delivery gates

Treat the October 28 date as a planning target, not a promise. Each milestone needs a demonstrable gate. Rehearsal readiness determines whether the first live show proceeds.

| Milestone | Deliverable | Exit gate |
|---|---|---|
| M0: design | Architecture, domain contracts, UX flows, data model, decision log | All non-negotiables mapped to components and tests; no silent substitutions |
| M1: deterministic foundation | Rules package, migrations, sessions, authorization, fake providers | Rule and permission tests pass; state survives restart |
| M2: playable vertical slice | Four player views, director, stage; one conversation and one action loop | Complete a saved multi-player scene with fake AI and a recurring NPC |
| M3: AI and continuity | Real model adapter, structured planning/rendering, NPC knowledge and review | Multiple dialogue follow-ups and mixed action outcomes remain coherent |
| M4: speech and broadcast | Cached segment TTS, voice mapping, captions, playback controls | OBS and optional player browsers play approved content without routine duplicate audio |
| M5: rehearsal/hardening | Failure drills, pacing tuning, deployment/restore notes | Full cast can complete a short adventure and recover from injected failures |

Do not build the most polished screen first and leave the multiplayer orchestration until the end. The earliest end-to-end slice must include **a player talking to a tracked NPC, a follow-up, an approved dice action, and state surviving refresh**.

---

# 20. Acceptance tests

Automate deterministic behavior. Use scripted fixtures and human rehearsal for performance quality. Passing schema tests alone is not evidence of entertaining or consistent roleplay.

## 20.1 Rules

**RULE-01:** Enumerate all 36 dice pairs at modifiers 0-3; verify exact outcome counts and boundaries.

**RULE-02:** A 7-9 delivers the agreed goal and cost. A 10+ cannot apply an unlisted consequence from the same check.

**RULE-03:** Multiple helpers grant at most one Edge; a helper cannot also spend a separate action. Shared incidents apply once.

**RULE-04:** Failed prerequisites skip dependent checks. A missing or invalid fallback does not create an invented action. Dependency cycles are rejected.

**RULE-05:** Strain and tracks remain bounded; recovery clears the declared amount; reaching four strain does not change traits or remove speaking rights.

**RULE-06:** Countdown ticks occur once per specified committed trigger, never on dialogue, retries, or audio replay unless explicitly configured as a different declared trigger.

**RULE-07:** Mechanical effects come from approved branches, not prose extraction. Mixed success cannot quietly become failure.

## 20.2 NPC conversation and agency

**NPC-01:** A player asks Mara a question, receives actual attributed NPC dialogue, and follows up without waiting for three other submissions.

**NPC-02:** A recurring NPC retains the same entity ID, voice profile, and relevant memory after scene changes and process restart.

**NPC-03:** Mara does not know an offstage event until an approved source informs her. NPC claims do not automatically become objective world facts.

**NPC-04:** The storyteller cannot inject player-dialogue segments. Published PC quotes exactly match accepted submissions.

**NPC-05:** A risky conversational concession routes through stakes and dice instead of being granted in an unreviewed chat reply.

**NPC-06:** Unknown speakers require an approved draft NPC; aliases do not duplicate identities; inactive/unavailable NPCs cannot casually speak without a valid communication channel.

**NPC-07:** No model output dictates a player's voluntary action, emotion, or consent. The response leaves an opening for the player.

**NPC-08:** Characterization tests use fixture scenes plus director review. Flag bland summaries, unanswered questions, personality merging, and excessive NPC-to-NPC monologues.

## 20.3 Multiplayer, security, and state

**STATE-01:** Four browsers can edit independent submissions without unnecessary conflicts. An accepted contract becomes stale when its relevant input changes.

**STATE-02:** Double-clicking lock or publish produces one roll set and one canonical commit.

**STATE-03:** Model timeout after rolling preserves the dice. Regeneration and manual narration reuse them.

**STATE-04:** Crash after database commit but before socket emission is recovered through snapshot/outbox delivery without duplicate effects.

**STATE-05:** A late provider response from a cancelled or superseded job cannot publish or overwrite the current draft.

**STATE-06:** Reconnect restores the authorized state and never auto-submits a stale queued action into a new round.

**SEC-01:** A player cannot retrieve another player's secret or director-only NPC fields through HTTP, sockets, exports, audio, or guessed entity IDs.

**SEC-02:** A stage credential cannot invoke director commands. Changing role fields in a client payload does not grant authority.

**SEC-03:** Malicious text in cards or dialogue is rendered as data, not executable markup or privileged instructions.

## 20.4 Audio and show operation

**SHOW-01:** Narration and NPC speech display the correct speaker and use stable configured voice assignments.

**SHOW-02:** TTS failure permits text-only publication or human reading without affecting dice or committed state.

**SHOW-03:** Refreshing a listener does not replay an entire past beat. Intentional replay does not apply effects again.

**SHOW-04:** Draft edits invalidate affected audio. Private notes never reach the stage manifest or TTS request.

**SHOW-05:** Pause/stop works during playback; new player input queues for the next beat without rewriting the published scene.

**SHOW-06:** Rehearsal checks actual OBS routing, browser audio permission, disconnects, player absence, a bad AI response, and a restart mid-resolution.

**SHOW-07:** Viewers can identify who is speaking and what the current objective/risk is. Each player gets meaningful participation across the test scene.

---

# 21. Decisions recorded and open choices

## 21.1 Defaults to preserve unless explicitly revised

Conversation and action use the same canonical story, not separate chatbot sessions. One DM model performs multiple NPCs through explicit speaker segments. The application rolls dice. The director reviews before broadcast. NPCs remember only sourced information. The AI cannot write new PC dialogue. Publication commits state. TTS is downstream of approval. No autonomous audience-driven story mutation.

## 21.2 Choices Codex may resolve during design

- Exact supported library/runtime versions and migration tooling.
- Host authentication implementation appropriate to the existing repository/deployment.
- Initial model and TTS provider/model/voice IDs, selected from current supported options and actual account access.
- Storage implementation, hosting destination, and operational backup mechanism.
- Final schema names and whether particular bounded values are normalized or stored as validated JSONB.
- Visual theme details and pacing defaults after a working prototype.

Do not block the design phase waiting for these preferences. Record reasonable defaults and their trade-offs. No budget, provider account availability, existing repository, or hosting service has been confirmed by this document.

---

# 22. Codex's first assignment

Start with design, not a large unreviewed implementation.

1. Inspect the repository if one is provided. Identify existing conventions and reusable code. Do not assume earlier Twitch projects are present or that this is a modification of an existing bot.
2. Treat sections 1-7 and the acceptance tests as the product contract. Identify contradictions or gaps explicitly rather than silently dropping requirements.
3. Produce `docs/ARCHITECTURE.md`, `docs/IMPLEMENTATION_PLAN.md`, and short decision records for unresolved technical choices.
4. Define the canonical data types, public/private projections, command/event schemas, NPC knowledge model, beat state machines, and transaction boundaries.
5. Describe or wireframe the player, director, and stage flows, including both conversation and action, loading, review, failure, and reconnect states.
6. Split implementation into milestones M1-M5 with concrete acceptance tests and a smallest end-to-end slice.
7. Separate required behavior from optional polish. Flag provider-dependent assumptions and balance parameters that require rehearsal.

When subsequently asked to implement, begin with fake providers and deterministic fixtures. The first useful demonstration is not a static dashboard. It is a player having a two-beat conversation with Mara, joining a coordinated dice action, hearing or viewing the reviewed result, and refreshing without losing the story.

**Do not substitute a generic chat UI for this product. Do not defer NPC dialogue to a future feature.**

---

# Appendix A. Illustrative contracts

These examples specify shape and invariants, not a complete production schema. Codex must expand them into validated TypeScript/Zod contracts. The logical IDs below are readable fixture identifiers; production IDs should be opaque, particularly where names could reveal secrets.

## A.1 Player dialogue input

```json
{
  "schemaVersion": 1,
  "commandId": "cmd_say_001",
  "sessionId": "session_fixture",
  "sceneId": "scene_bar",
  "expectedSubmissionRevision": 0,
  "kind": "say",
  "characterId": "pc_kasey",
  "recipientNpcIds": ["npc_mara"],
  "text": "You knew the previous owner. What happened to him?",
  "stageDirection": "Kasey lowers her voice.",
  "alreadySpokenAloud": true
}
```

The server derives and validates character ownership from the authenticated membership. This payload's character ID does not grant authority. Stage direction is proposed player behavior, not an unchecked world-state update.

## A.2 Approved action contract

```json
{
  "schemaVersion": 1,
  "contractId": "check_archive_lock",
  "version": 1,
  "actorCharacterId": "pc_skooty",
  "helperCharacterIds": [],
  "submissionIds": ["submission_lock"],
  "intent": "Release the first locking mechanism of the archive vault.",
  "approach": "Pick the mechanism while the guard is distracted.",
  "ruling": "check",
  "trait": "finesse",
  "traitModifier": 2,
  "edge": 0,
  "edgeReason": null,
  "risk": "normal",
  "prerequisites": [
    { "contractId": "check_guard_distraction", "requirement": "goal_achieved" }
  ],
  "fallback": { "kind": "hold" },
  "outcomes": {
    "clean": {
      "publicText": "The first locking mechanism opens quietly.",
      "effects": [
        { "kind": "track_delta", "trackId": "track_vault", "delta": 2 }
      ]
    },
    "costly": {
      "publicText": "The mechanism opens, but its loud click attracts attention.",
      "effects": [
        { "kind": "track_delta", "trackId": "track_vault", "delta": 2 },
        { "kind": "track_delta", "trackId": "track_alert", "delta": 1 }
      ]
    },
    "setback": {
      "publicText": "The mechanism remains locked and a tamper signal is sent.",
      "effects": [
        { "kind": "track_delta", "trackId": "track_alert", "delta": 2 }
      ]
    }
  }
}
```

The AI may propose this shape. The application verifies modifiers against the character snapshot, helper availability, dependencies, effects, and approved contract version. The model cannot assert its own final modifier or roll.

## A.3 AI-authored script draft

```json
{
  "schemaVersion": 1,
  "beatId": "beat_conversation_001",
  "inputSnapshotHash": "fixture-input-hash",
  "segments": [
    {
      "kind": "narration",
      "speakerNpcId": null,
      "recipientCharacterIds": [],
      "text": "Mara stops polishing the glass and looks toward the empty stool.",
      "delivery": "neutral"
    },
    {
      "kind": "npc_dialogue",
      "speakerNpcId": "npc_mara",
      "recipientCharacterIds": ["pc_kasey"],
      "text": "He learned the difference between owning this place and being allowed to keep it. Why are you asking?",
      "delivery": "quiet"
    }
  ],
  "proposedNpcCreations": [],
  "proposedContinuityUpdates": [],
  "directorSummary": "Mara responds cautiously without disclosing the protected ledger location."
}
```

All segments in this model response are candidates, not public yet. The application assigns segment IDs, validates speakers, inserts any verbatim PC quote from its source submission, and builds the final authorized script. `directorSummary` never enters the public projection.

## A.4 Published segment shape

```json
{
  "schemaVersion": 1,
  "segmentId": "segment_mara_reply",
  "beatId": "beat_conversation_001",
  "order": 2,
  "kind": "npc_dialogue",
  "speaker": {
    "entityId": "npc_mara",
    "displayName": "Mara Vale"
  },
  "recipientCharacterIds": ["pc_kasey"],
  "text": "He learned the difference between owning this place and being allowed to keep it. Why are you asking?",
  "visibility": "public",
  "tts": {
    "enabled": true,
    "voiceProfileId": "voice_mara",
    "audioAssetId": "audio_mara_reply"
  },
  "sourceSubmissionIds": ["submission_question"]
}
```

Source references are exposed only when appropriate for that projection. The speaker object intentionally excludes private motives, true identity, knowledge, and relationship records.

---

# Appendix B. Sources and implementation checks

The product decisions and numerical rules in this document are proposed requirements, not claims that an external framework provides this application. The references below support specific implementation constraints or design inspiration. Documentation was reviewed for this handoff on October 22, 2026; Codex should verify current SDK details before implementation.

**[R1] SillyTavern: Group Chats.** Speaker selection and combined-character-context behavior are useful inspiration; the documentation also warns about identity confusion in joined character definitions. This engine does not reuse its group-chat architecture.  
https://docs.sillytavern.app/usage/core-concepts/groupchats/

**[R2] SillyTavern: World Info.** Relevant lore can be selected into context rather than always sending all world material. Lore inclusion alone does not guarantee model fidelity.  
https://docs.sillytavern.app/usage/core-concepts/worldinfo/

**[R3] OpenAI: Structured model outputs.** Schema-constrained responses are useful for model boundaries; semantic errors, refusals, and incomplete responses still require handling. No model ID is mandated here.  
https://developers.openai.com/api/docs/guides/structured-outputs

**[R4] OpenAI: Text to speech.** Speech generation, optional streaming, and AI-voice disclosure. Confirm actual model, voice, and format support when implementing.  
https://developers.openai.com/api/docs/guides/text-to-speech

**[R5] OBS: Browser Source.** A web page can supply the stage's visuals and audio. Actual source lifecycle and capture routing need rehearsal.  
https://obsproject.com/kb/browser-source

**[R6] Socket.IO: Delivery guarantees.** Ordering is provided, but default arrival is at-most-once; durable delivery/recovery belongs in the application.  
https://socket.io/docs/v4/delivery-guarantees

**[R7] Socket.IO: Connection state recovery.** Recovery is useful but not guaranteed; retain an authoritative snapshot/reconciliation path.  
https://socket.io/docs/v4/connection-state-recovery

**[R8] MDN: Autoplay guide.** Browser permission and user-interaction constraints require explicit audio enablement and failure handling.  
https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Autoplay

**[R9] Blades in the Dark: Action Roll and Progress Clocks.** Inspiration for declared goals/consequences and visible progress tracking, not a claim of rules compatibility or copied game content. Our 2d6 engine, strain, and thresholds are this project's separate proposed configuration.  
https://bladesinthedark.com/action-roll  
https://bladesinthedark.com/progress-clocks

Before distributing borrowed text, artwork, or third-party code, check the relevant permissions and attribution requirements. The MVP should use original fixture content and its own UI.

---

# Final product check

A player asks a question. A recognizable NPC answers in their own voice. Another player follows up. The NPC remembers what was said but does not know an unrelated secret. A risky request becomes a visible wager. Real server dice settle that wager. The reviewed scene plays on stream, with clear speakers and meaningful consequences. The director can keep it moving, and a refresh does not erase the adventure.

That is the application this plan is asking Codex to design.
