# Application architecture

The application runs two to six player seats, a director workspace, and a separate public stage against one server and PostgreSQL. Native scenario and character libraries support custom shows; the four-player Ledger rehearsal includes two consecutive exchanges with Mara, reviewed action stakes, server dice, publication, and recovery after refresh. Fake providers keep that path deterministic for tests; the current private configuration enables live generation and speech after a successful provider rehearsal.

This document describes the implemented foundation and the remaining design boundaries. The local slice has automated coverage for contracts, rules, providers, PostgreSQL operations, browser components, and multiplayer rehearsals; the implementation plan records the current counts and commands. A separate live-provider rehearsal verified conversation publication and cached speech. Audited corrections, private beat direction, private speech preparation, and coordinated published playback are implemented. Broader live-model quality, actual broadcast routing, Railway deployment, and cast rehearsal remain separate gates. The full product requirements are in [PROJECT_PLAN.md](../PROJECT_PLAN.md); [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) records acceptance criteria and evidence, and [CODEX_START_HERE.md](../CODEX_START_HERE.md) has the current run instructions.

## Application boundaries

The Vue application has player, director, lobby, and stage routes. Fastify authenticates each request, validates commands with Zod, orchestrates beats, and returns an explicit audience projection. Socket.IO tells connected clients that saved state has changed. Clients fetch an authorized snapshot to reconcile their state.

PostgreSQL owns credentials, membership, submissions, beat versions, immutable resolutions, published history, and notifications awaiting delivery. The server can restart without reconstructing the story through a model. One application process uses one database. Provider requests run outside transactions with persisted job records and timeouts. Startup marks interrupted jobs failed so the director can retry or provide a manual script. Automatic job resumption and a separate worker loop are not implemented.

| Module | Responsibility | Authority boundary |
| --- | --- | --- |
| `packages/contracts` | Zod schemas, shared types, commands, audience projections, provider interfaces | Reject invalid wire shapes; keep private and public objects distinct |
| `packages/rules` | Validate actions, determine outcomes, order dependencies, stage and apply effects | Pure functions; no provider or browser authority |
| `packages/test-fixtures` | The Ledger Job, four characters, fake responses and failure cases | Original test content, not evidence of live-model quality |
| `packages/providers` | ClewdR model requests, ElevenLabs speech, private-context filtering, response validation | Configured endpoints and model/voice IDs; no automatic paid retries |
| `apps/server` | Authentication, persistence, commands, provider jobs, publication, projections | Check permissions and versions at every mutation |
| `apps/web` | Role-specific controls, saved-state display, stage captions | Submit intent and render server state |
| `migrations` | Versioned SQL changes and database constraints | Preserve durable ownership and lifecycle invariants |

The executable shared contract is [packages/contracts/src/index.ts](../packages/contracts/src/index.ts). Server database records may contain additional operational fields, but API responses must match their audience schema.

## Identity, permissions, and views

The host authenticates with a deployment-configured secret and receives an HTTP-only cookie. There is no public director-registration button. The host identity is global so it can create a session and resume sessions it owns. Player and stage invites contain random, scoped tokens; the server stores hashes and exchanges each invite once for a 12-hour credential. Raw invite tokens are displayed when issued. Expiry and revocation are recorded in the database; guest credential renewal and invite-reissue controls remain unfinished.

Browser login/redemption requests include `tab: true` and receive an independent HTTP-only cookie plus a random 32-character lowercase hexadecimal identity selector. The page URL keeps only that selector; API headers, socket authentication, and audio asset URLs select its matching cookie. Credentials never enter JavaScript or URLs. Explicit invalid, duplicate, conflicting, or unmatched selectors fail closed. A request without a selector retains legacy `rpg_session` compatibility. Logout revokes only the selected credential.

The owning host can open a character from **Cast & lobby** through `POST /api/sessions/:id/test-seat`. The server verifies session ownership and character membership, records the grant, and issues an ordinary scoped player credential without consuming an invitation. The new tab completes this exchange before fetching state or connecting its socket, then replaces its URL with the player selector. Test seats participate in the real session and have ordinary player permissions.

The client sends no trusted role or character ownership. A player command obtains its character from authenticated membership. A stage credential reads the public performance, manages its own presenter lease, and sends scoped playback telemetry. It cannot direct the story or shared transport. Every query is scoped to the authorized session.

Role routes select their snapshot view explicitly: `GET /api/sessions/:id?view=director|player|stage`. The server checks that the identity can use that view, then calls its allowlisted serializer. The lobby can use the membership's default view. A director cookie requesting the stage still receives only a stage projection. This prevents a host opening the stage in the same browser from accidentally receiving private data.

| Projection | Included beyond published public state | Excluded |
| --- | --- | --- |
| Player | Own complete character, own submissions, public current stakes | Other character secrets, NPC knowledge/secrets, unpublished script, director notes |
| Director | Full current beat, all submissions, complete character/NPC cards, job status | Credential hashes and provider keys |
| Stage | Approved public stakes and published segments, outcomes, cast and tracks | Submissions, drafts, continuity proposals, private tracks and private notes |

Secure cookies are required under HTTPS. State-changing requests require an allowed origin; socket connections use the same origin and credential checks. Tokens and secret-bearing request bodies must be redacted from logs. Vue renders submitted and generated text as text. Imported cards never execute code or fetch arbitrary URLs.

## Canonical records and versions

The domain separates reusable templates from session snapshots. Host-owned libraries store immutable scenario and character versions. Form edits append a version after checking the expected version; command receipts make retries idempotent. Native JSON imports use strict version 1 schemas, bounded sizes, unique local identifiers, and validated references. A custom session resolves exact owned versions, copies their definitions into immutable session columns, and allocates opaque IDs for its entities and references. The Ledger Job remains available as a four-seat rehearsal and an editable library starter.

Custom sessions have two to six independent seats. Imported cards begin as private drafts behind neutral public seat placeholders. Players edit their own draft with a character revision; the director approves that exact revision before its public fields enter play. Draft saves do not change canonical game revision. Boundary edits clear readiness and acknowledgment. A durable `setup.started` flag prevents ordinary status or beat commands from bypassing approval. The director may start with a recorded reason for missing readiness, but every card must be approved. Late arrivals can acknowledge boundaries afterward. Card and boundary edits are refused after start.

`SessionState` contains the session summary, characters, NPCs, locations, tracks, facts, rules version, and director notes. The location catalog is director-only and absent from provider contexts, except that the current place's title is sent to the AI, as it already appears in picture prompts and the public gallery; the current scene's public description is separate. This type describes an aggregate for pure rules and context construction; it does not require storing the entire game in one mutable database field. Membership, identity, lifecycle, and versions remain relational. Validated JSONB stores bounded definitions, contracts, frozen inputs, and script revisions.

| Version or identifier | Meaning |
| --- | --- |
| `stateRevision` | Revision of committed session state |
| `beatNumber` | Count of published conversation and action beats |
| `actionRoundNumber` | Count of published action beats only |
| `inputEpoch` | Current collection context; changes when a new collection context opens |
| Submission `revision` | Version of one player's saved input |
| Beat `revision` | Current review/lock/edit version of one beat |
| `draftRevision` | Script version selected for publication |
| `generation` | Provider-job version; superseded responses cannot overwrite a later edit |
| `eventSeq` | Durable notification cursor, independent of canonical publication |

Four players can save independently because submission writes compare their own revision. A save also supplies `contextBeatId` and `expectedInputEpoch`; delayed offline input must fail when its collection context has changed. New lines received while a beat is locked enter the next-beat queue with a null context. They cannot change the locked inputs.

Database constraints enforce one active resolving beat per session, one resolution per check, unique command receipts, and unique publication. Character/NPC/track/fact rows retain session ownership while validated JSONB holds their domain data. Zod and the rules engine enforce strain and track bounds. Session-scoped queries reject cross-session entity conflicts.

Startup applies numbered migrations once, in filename order, including `005_character_builders.sql` for private player drafts, `006_playback.sql` for shared audio state and receipts, `007_draft_audio.sql` for private recordings and preparation receipts, and `008_operations.sql` for usage records and progress counters. A transaction and advisory lock protect migration execution; `schema_migrations` records completed files. The migrations create the game records, credentials, audit/outbox, provider jobs, audio assets, immutable library versions, session setup/snapshots, and runtime location catalogs. Native PostgreSQL 14 is the tested local path; Compose pins PostgreSQL 17.11, whose container path still needs verification.

## Beat lifecycle

Both play loops use explicit director review and a saved input snapshot. The reduced first-slice phases are `collecting`, `stakes_review`, `locked`, `draft_review`, `published`, and `aborted`. Planning and rendering have persisted job states; a failed job leaves the last valid phase intact.

A conversation follows these steps:

1. The director opens a beat and selects one or more queued lines. Other players need not submit.
2. Planning returns `action` for any round with selected lines and one contract per line (a line may instead help another contract). The server still accepts `ordinary` and `needs_action` for old beats and for the director's Ordinary choice. The director reviews the classification.
3. Conversations plan to stakes like action rounds and receive reviewed contracts. Approving stakes never changes the round's kind. A round the director sets to Ordinary conversation is approved with no contracts.
4. Locking freezes the selected submission revisions, source state, and input hash. A conversation with contracts rolls its dice like an action round; an Ordinary round creates none.
5. Rendering proposes narration, attributed NPC dialogue, and continuity updates. The director edits or regenerates the script and approves selected continuity updates.
6. Publication inserts exact player quotes from the frozen submissions and commits the approved result.

An action follows the same path. Its stakes review includes the clean, costly and setback branches, an optional critical branch for a double 1, helpers, prerequisites, and the declared fallback. The director can leave an absent player unselected; the application invents no action for that player. Locking validates the complete batch, rolls each available check once, and stages the selected effects. Rendering receives those fixed results.

Changing selected input before lock invalidates affected stakes and any pending render. After lock, intent, branches, and dice are immutable. Script regeneration changes the performance, not the resolved action. An error in a locked ruling needs an audited correction workflow; general history rollback is outside this slice.

## Commands and HTTP responses

Game-state mutations use `POST /api/sessions/:id/commands` with a `type` discriminant and `commandId`. The schemas reject client-supplied role grants and unknown fields. A successful command returns `{ commandId, eventSeq, snapshot }` for the actor's authorized view. Errors return a code, safe message, and recoverability flag. Audio preparation has a separate endpoint and cannot change game state.

| Command | Required concurrency context | Main inputs |
| --- | --- | --- |
| `save_submission` | Own expected revision, collection epoch, nullable beat context | Say/Act/Out of character, exact text, addressees, intent, approach |
| `cancel_submission` | Own expected revision | Submission ID |
| `open_beat` | Expected input epoch | Conversation or action |
| `plan_beat` | Beat ID and expected beat revision | Selected submission IDs |
| `approve_stakes` | Beat ID and expected beat revision | Ordinary/action classification and complete reviewed contracts |
| `lock_beat` | Beat ID and expected beat revision | No browser-supplied dice |
| `render_beat` | Beat ID and expected beat revision | Uses saved input and fixed resolution |
| `edit_script` | Beat ID and expected beat revision | Narration and NPC dialogue only |
| `approve_continuity` | Beat ID and expected beat revision | Selected typed updates with sources |
| `publish_beat` | Beat, state, and draft revisions | Explicit text-only publication in the first slice |
| `abort_beat` | Beat ID and expected beat revision | Recorded reason |
| `set_status` | Expected state revision | Live, paused, or ended |
| `change_scene` | Expected state revision; no active beat | Public scene, existing/new location, present NPCs, private reason, explicit pending-input cancellation |
| `save_npc` | Expected state revision and NPC version; no active beat | Profile/presence fields, private reason, explicit pending-input cancellation; server assigns new IDs |
| `reveal_npc` | Expected state revision and NPC version; no active beat | Private source selector, approved public wording, physical witnesses, reason and cancellation acknowledgement |

Live director operations require a started live or paused session. They cancel queued/selected in-character submissions, increment each cancelled submission's revision, preserve out-of-character notes, and advance state revision and input epoch once. Scene changes allocate a new scene ID and move selected NPCs without changing their stable identity or voice. NPC profile edits cannot replace sourced knowledge or relationships. A reveal adds an approved public fact and fact knowledge for selected witnesses physically present at the current location, all citing the same persisted audit event. It leaves the private source and public name unchanged. Raw sources, before/after records, reasons, and location catalogs remain director/server data. None of these commands rewrites published history, rolls, effects, or audio.

Host login, invite redemption, and session creation have separate endpoints: `/api/auth/host`, `/api/auth/redeem`, and `/api/sessions`. Creation returns the session ID and the newly issued invites. The first slice uses these capabilities without assuming a wider account-management service.

Socket notifications contain only `{ schemaVersion, eventId, sessionId, eventSeq }`. The durable outbox records the notification in the same transaction as the mutation. Sending a private snapshot to a public socket room is prohibited, even if the browser could hide its fields.

## Rules and transaction boundaries

The rules package exports `outcomeForTotal`, `validateTraits`, `validateContracts` and `resolveContracts` (both take the beat's lines, so each line allows one action), `applyEffects`, and `applyResolution`. Checks use two six-sided dice plus the server-derived trait and zero or one Edge. The server supplies a cryptographically secure die function; tests supply deterministic faces.

Contract validation checks character availability, one action per selected line (each line leads one contract or helps another's; a character helps at most one contract per round and never one they lead), non-stacking assistance, valid effect targets, and an acyclic dependency graph. Failed prerequisites hold dependent actions. The initial fallback shape is `hold`; a later risky fallback requires its own approved contract. Shared incidents apply once. Independent numeric changes aggregate before bounds, while explicit dependencies use their causal order. Strain never changes traits or prevents speech. A character at four strain or more can lead a check only when every line of theirs in that contract is a Say line; a Do line from that character is blocked or helps another contract.

A roll of double 1 is a critical failure when the contract has the optional critical branch: the band is `critical` on the roll and the resolved outcome, the goal is not achieved, and the critical text and effects apply. Without the branch it is a plain setback, and `outcomeForTotal` is unchanged.

Resolutions retain `effectGroups` ordered by dependency depth. `applyResolution` applies each group against the result of earlier groups and aggregates numeric changes within a group before bounds. A parent can therefore supply an item that its dependent consumes. Independent contracts cannot claim or consume the same nonnumeric target. Before rolling, validation simulates all applicable branch combinations for a maximum of six contracts, with four branches each, at most 4^6 = 4,096 combinations, to catch missing items, capacity overflow, and conflicting effects. This validates mechanics; prose consistency and clean-success consequence choices still need director review.

Command processing starts a database transaction, obtains the relevant session or beat lock, and checks for an existing receipt before testing versions. Matching retries return their recorded result. Reusing a command ID with a different request hash is rejected. The receipt and mutation commit together.

Locking stores the accepted submission snapshot, contracts, state revision, and input hash. It inserts immutable roll records and the selected effects in the same transaction. A unique check-resolution constraint prevents another command ID from producing a second roll. No provider request occurs while that transaction is open.

Publication is a separate transaction. It validates the locked resolution, draft revision, approved continuity, referenced entities, and current state. It applies selected effects, inserts the public script and exact player quotes, updates NPC knowledge, advances the appropriate counters, and writes the audit event, command receipt, and outbox entry. Countdown effects must be staged before rendering and applied once at publication. Countdowns tick at lock and the action round number rises at publication; only action rounds tick them, so a conversation round rolls without ticking the countdown.

The server must reject a draft that no longer matches its frozen inputs. Retrying rendering, text-only publication, socket delivery, or audio playback cannot roll again or reapply effects.

## NPC memory and player agency

Each NPC has a stable session ID and voice profile. The private record keeps aliases, intent, knowledge, secrets, relationships, location, and participation status. The public card exposes only the display identity, appearance, role, status, and voice-profile reference.

Knowledge records distinguish facts, beliefs, and claims. Each record has a source event, acquisition mode, source entity when relevant, and learned beat number. Proposed updates refer to accepted submissions; publication assigns their event provenance. Hearing a claim does not create an objective world fact. World facts use a separate typed proposal and require explicit director approval.

The renderer's schema permits only narration and NPC dialogue. The server validates that every speaker exists and can participate, then inserts exact player segments from saved submissions. Published dice and outcomes are separate structured records. Director script editing uses the restricted authored-segment schema. A player quote cannot be edited through the script controls.

Mara's second reply must use information learned in the first published exchange. Offstage archive events remain unavailable to her until a sourced communication establishes that knowledge. The context builder selects relevant records for each performance. A structurally valid draft can still disclose a secret or mischaracterize a player; semantic review remains the director's responsibility.

## Provider and speech boundaries

The owning director reads progress and usage through `GET /api/sessions/:sessionId/operations`, validated by `SessionOperationsSchema`. The browser polls separately from canonical snapshots, so progress updates do not reset editors or advance game revisions. Current beat/generation and exact draft source/configuration select active work; prior attempts remain in usage totals. Readiness, elapsed time, completed clip counts, saved audit time, and allowlisted failure messages form the private response. Player, stage, and foreign-host credentials cannot read it.

Migration `008_operations.sql` records individual adapter attempts and their outcomes, speech input characters, observed cache/shared reuse, tracking coverage, and clip completion counters. Attempts are counted immediately before provider work; duplicate command receipts, status polling, and playback do not add provider attempts. Telemetry writes run outside game transactions and tolerate failure so recording problems cannot change accepted input, dice, provider retries, or publication. A known recording gap marks coverage incomplete. Attempts without a terminal result become interrupted after their deadline; their provider outcome remains unknown.

Usage covers session planning and narration from the recorded activation date. Field generation and pre-show library/character drafting lack a session binding and are excluded. Tokens and provider cost remain null because the adapters do not report them. Application usage limits are literal `unlimited`, with no budget enforcement. Provider deadlines, payload validation, and explicit director review remain in force.

The ClewdR adapter uses the configured base `http://10.20.30.79:8484/code/v1` locally and appends `/messages`. Live planning and rendering succeeded with `claude-opus-5-5-thinking`, although the advertised model list omitted that name. Railway still needs a reachable replacement endpoint. Fake responses remain the example configuration and deterministic test default; the current private `.env` enables ClewdR.

`AiProvider.plan(context)` returns classification and proposed contracts. `AiProvider.render(context)` returns an `AiDraft`. The planner returns `action` when lines are selected, with a `check` contract per line and a critical outcome of at most 110 characters on every check. `validatePlan` refuses a wrong classification, an uncited selected line, `no_check`, a check without a critical outcome, and a four-strain actor leading with a Do line. Each refusal states its reason in words, and the model gets one corrected attempt.

The adapter requests ordinary JSON matching an included schema; it does not assume provider-enforced structured output. It accepts documented `thinking` and `redacted_thinking` metadata alongside final text, discards that metadata during parsing, and applies strict JSON/domain validation to the text alone. Thinking-only, tool, malformed, truncated, and nonfinal responses remain invalid. This follows the [native thinking response format](https://platform.claude.com/docs/en/build-with-claude/thinking); reasoning is neither logged nor retained in game state.

Requests have an abort timeout and no automatic retry. The context builder allowlists the public scene, accepted inputs, fixed results, and participating NPC information, excluding raw secrets, hidden identities, director notes, unrelated NPC records, and offstage transcript narration. The adapter validates speakers and sourced NPC knowledge proposals. A knowledge `fact` must exactly match an established public fact or approved public `fact_add` text. The prompt directs all other new statements, including questions or requests heard in the beat, to use `claim` or `belief`. Mechanical world facts remain the server's responsibility.

The ElevenLabs adapter accepts configured model/voice IDs and bounded plain text, returning MP3 bytes. Mocked tests cover exact audio, errors, timeouts, and cache keys; real synthesis passed both a short standalone sample and the live application rehearsal. The configured key lacks model-list and voice-list permissions but can synthesize the selected voice/model, so the application does not require those listing permissions. Stable internal voice profiles map to provider voices on the server. Saved narration, non-player character dialogue, and player lines and actions all enter speech generation; the narrator reads player lines and actions as "Name: words". The spoken copy of every line drops tag-like spans (anything shaped like an HTML tag) so the voice does not read them out, while captions, manifests and the published words keep the text unchanged. Draft recordings stay private until the director publishes them.

The director prepares a saved draft at `/api/sessions/:sessionId/beats/:beatId/draft-audio`. Separate private records bind the recording to the draft revision, generation, and exact speech projection. The server checks credentials and currentness under the session lock before and after synthesis, without holding that lock during provider work. An active render of the current generation blocks preparation. Script edits, regeneration, private direction, abort, and publication invalidate draft access; continuity approval alone preserves it. Private indexed media routes require the owning director and the current saved draft.

Publication accepts either text only or a selected preparation identifier. The transaction validates that recording, maps its clips onto fresh canonical segment identifiers, and inserts the publication and public manifest together. The immutable publication stores its chosen manifest key. Later provider configuration cannot replace that choice, and publication retries cannot reapply effects. The narrator voices player lines and actions after the character's name, while captions keep the player's words unchanged. Text-only publications retain optional postpublication preparation at `/api/sessions/:sessionId/audio/:beatId`.

The server caches assets under `ASSET_DIR`; keys include exact text, delivery, provider/model/voice, and session scope. File installation preserves an existing winner during concurrent synthesis. Preparation leases expire after five minutes; durable command bindings prevent a retry from repeating paid work or reviving an obsolete preview. A new explicit preparation can retry a failed or expired attempt while reusing cached clips. Public downloads require a ready manifest belonging to a published beat, with the selected manifest key honored. Session membership or knowledge of a cache hash alone does not expose draft audio.

The live application rehearsal published one ordinary conversation and synthesized four speech segments. A second preparation returned cached assets without further synthesis calls. Stage-authorized download succeeded; anonymous download was denied. This verifies the provider/cache/authentication path. Automated browser coordination is covered separately; actual broadcast audio routing still needs rehearsal.

Shared playback has its own row, revisions, presenter lease, and command receipts in PostgreSQL. Every explicit start pins a validated published manifest and creates a new performance identifier. Director transport commands change only playback state. One stage browser owns the presenter lease that renews for ten seconds and reports actual position and segment completion. Players and director monitoring opt in locally; refreshed pages stay silent and can join the current position. Active browsers poll every 250 milliseconds, with a scheduling lead of 500 milliseconds. Listeners correct drift above 750 milliseconds. Local volume does not change the shared performance.

The server locks playback state, rechecks credentials, and reads the database clock after lock waits. Separate renewal and telemetry sequences reject stale messages. Every durable change advances the sample revision; ownership and transport changes also advance the command revision. A receipt replay retains its original result and lease expiry but returns fresh server time. Lease expiry pauses at the last confirmed position and does not automatically resume after a new claim. The browser rejects delayed requests and media callbacks after context, performance, segment, or lease changes. Application startup leaves valid durable leases intact.

The private preview starts only on an explicit click, stops on unsaved edits or context changes, and restores readiness silently after refresh. Publishing audio leaves shared playback idle until an explicit playback command. Actual OBS and voice-call routing remain M4 rehearsal work. Coordinated playback does not promise exact synchronization between audio devices. Restarting or replaying audio never changes game state.

## Player, director, lobby, and stage flows

The host home signs in, opens the scenario/character library, creates The Ledger Job, and lists saved sessions to resume. Custom shows select exact saved versions for a scenario and two to six player seats. Creation exposes player invites plus a stage invite. Invite redemption exchanges the token, removes it from the address bar, and opens the assigned seat.

The host library provides native scenario/card forms, JSON import/export, and creation from two to six selected card versions. The custom lobby shows private card drafts only to their owner and director, approval controls to the director, boundary acknowledgment to each player, readiness, and an explicit Start session action. The director can open independent test seats without consuming invitations. Existing fixture sessions retain their simpler lobby.

The player screen keeps the current scene and latest NPC exchange above separate Say, Act, and Out of character inputs. Say has an addressee and exact words. Act has intent, approach, and optional exact words. Each submission shows queued, selected, locked, or published status. Reviewed stakes appear before locking. A refresh fetches current state; unsent text can remain locally visible, but reconnect never automatically submits it.

The director's **Scene, characters & reveals** panel contains live scene and NPC forms plus explicit public reveals. Forms capture revisions, preserve unsaved words after failed saves or incoming changes, and require cancellation acknowledgement. Saved public facts appear under **Known to the party** in director, player, and stage views. The lobby observes actual card and boundary revisions, so unrelated refreshes do not clear acknowledgement or report a false draft conflict.

The director screen puts queued inputs beside the script preview and an inspector. Its primary controls follow the current phase: select and plan, review classification/stakes, lock, render, review/edit, approve continuity, publish. The inspector shows fixed dice, proposed state changes, NPC sources, and job failures. A failed provider call offers retry or manual narration while retaining fixed results.

The stage is a separate read-only route with the cast strip, scene objective, current approved stakes, large dice outcomes, and attributed published segments. It contains no director controls or unpublished preview. It targets a 1920 by 1080 browser source, with readable reduced-size captions and initials where portraits are absent. Text-only mode is labelled plainly.

Every view shows connection state and the last saved result. Conflicts explain that the scene or submission changed and refresh the relevant data. Loading controls prevent accidental duplicate clicks, while server idempotency remains the guarantee. Status labels accompany color; text inputs and controls remain keyboard accessible.

## Recovery and remaining gates

A restarted server loads state, frozen inputs, rolls, drafts, and jobs from PostgreSQL and marks interrupted generation failed. Provider completion must match the saved job generation, input hash, current state/beat revisions, phase, and running status before changing a draft. A cancelled generation cannot overwrite a manual edit. Failed jobs expose retry/manual paths without replacing canonical state.

After reconnect, the client fetches its explicit audience snapshot and replaces its saved view. Socket notification loss does not lose game state. The outbox retries missed announcements; consumers deduplicate event IDs. Playback recovery remains muted until explicit listening joins the current position; it never automatically replays the last beat.

Railway is the deployment destination after the local acceptance gate. `Dockerfile` pins Node.js 24.22.1; `railway.json` selects that build and `/health/ready`. Both `/health` and `/health/ready` query PostgreSQL. Docker is unavailable in this environment, so the container build is unverified. Railway deployment has not been performed. It still needs server-only secrets, persistent audio storage, a reachable ClewdR endpoint, and backup/restore verification. The October 28 show remains conditional on a complete cast rehearsal.
