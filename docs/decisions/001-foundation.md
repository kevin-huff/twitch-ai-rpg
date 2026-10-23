# Decision 001: verified local application foundation

Date: October 22, 2026  
Status: local foundation and provider connectivity verified; authoring, broader live-quality, broadcast, and deployment gates remain open

## Decision

Use an npm TypeScript workspace with Vue, Fastify, Socket.IO, Zod, PostgreSQL, Vitest, and Playwright. One server owns game rules and publication. The example configuration defaults to deterministic fake providers and silent publication. ClewdR and ElevenLabs are enabled in the current private `.env` after mocked tests and a successful live application rehearsal. Speech remains an explicit step after text publication.

The current user instruction authorizes local implementation followed by Railway deployment. It supersedes the design-only scope of the kickoff document. The original first-show product requirements remain in force; a completed fake-provider slice must not be described as the complete show application.

## Pinned dependencies

The root package manifest pins the versions below without range operators. Registry availability was checked during setup. The local installation, typecheck, build, combined tests, and browser rehearsal passed; the container and Railway runtime still require their own checks.

| Component | Pinned version | Use |
| --- | --- | --- |
| Node.js | 24.22.1 | Supported long-term support deployment runtime |
| TypeScript | 5.9.3 | Shared strict types |
| Vue | 3.5.44 | Role views |
| Vite | 8.3.5 | Browser build |
| Vue Vite plugin | 6.0.10 | Single-file components |
| Fastify | 5.12.7 | HTTP server |
| Fastify cookie | 11.1.3 | Session cookies |
| Fastify static | 8.3.0 | Built client assets |
| Socket.IO server/client | 4.8.4 | Saved-state notifications |
| PostgreSQL client (`pg`) | 8.23.1 | SQL transactions and migrations |
| Zod | 4.6.7 | Domain and wire validation |
| Vitest | 5.0.5 | Unit and integration tests |
| Playwright | 1.64.1 | Multi-browser flow tests |
| Vue test utilities | 2.5.1 | Component behavior tests |
| jsdom | 30.1.3 | Browser-like component environment |
| `vue-tsc` | 3.3.13 | Vue type checking |
| `tsx` | 4.23.15 | TypeScript server execution |

`.nvmrc` and the Docker image pin Node 24.22.1. The manifest accepts version 24.22.1 or later within major version 24. Native PostgreSQL 14 supplies the local integration database on port 55432. Compose pins PostgreSQL 17.11, but its container path remains untested because Docker is unavailable. Verify the Railway database version and repeat migration/restore checks there. The [Node.js release record](https://github.com/nodejs/node/releases) was checked during setup.

## Persistence and command authority

Use SQL migrations and the `pg` client. Ownership, session scope, credentials, versions, and lifecycle are relational. Validated JSONB holds domain records, frozen submissions, contracts, and scripts. Startup applies numbered files under an advisory lock and records them in `schema_migrations`. Foundation, audio, authoring, and live-location migrations are implemented.

Reusable scenario and character definitions use immutable host-owned versions. Custom session creation resolves exact versions and stores separate snapshots; editing the library cannot mutate a running session. Card drafts remain private until exact-revision approval. Custom start requires approved cards and boundary acknowledgment, or an audited reason for missing readiness. Native scenario effects are limited to operations the current countdown executor supports.

Live scene, NPC-profile, and reveal commands operate only between beats, using exact revisions and an explicit reason. Every live change cancels pending in-character input after director acknowledgement, so an old line cannot silently enter a changed scene. The original submission remains stored. Reveals publish separately authored wording and give only selected physical witnesses sourced knowledge. Private source text and future-location notes stay out of public projections and provider context. Published history and locked outcomes remain immutable; corrections are a separate unfinished workflow.

Mutations use authenticated HTTP commands with an idempotency key and expected versions. Receipts commit in the same transaction as the mutation and are checked before stale-version rejection. Locking creates immutable rolls. Publication applies effects and writes the public history, audit event, and notification outbox together.

Socket.IO carries small invalidation events. Clients fetch an explicitly selected player, director, or stage projection. This limits the amount of private data moving through socket routing and makes snapshot recovery the primary reconnect path. The tradeoff is one additional HTTP read after a notification, acceptable for the initial cast size.

## Authentication and deployment

Bootstrap the host from deployment configuration, exchange host and invite credentials for HTTP-only cookies, and store token hashes in PostgreSQL. Enforce origin checks and server-side role/ownership checks. Stage credentials remain read-only. Even a host-authenticated stage read uses the stage serializer.

Railway is the selected hosting destination. Start with one application service and PostgreSQL. Add persistent audio storage behind a storage interface when speech is enabled. Do not add Redis, Kubernetes, a vector store, or an autonomous-agent framework for this scope. Deployment must use Railway's assigned port and pass its [health check](https://docs.railway.com/deployments/healthchecks); database setup follows its [PostgreSQL service documentation](https://docs.railway.com/databases/postgresql).

Local native PostgreSQL is a development accommodation because its binaries are available. It does not change the production persistence design. Git initialization, commits, branches, and pushes remain Kevin's responsibility.

The native local database accepts the passwordless development URLs. When running only the Compose database, host-run application and test URLs must include the configured `POSTGRES_PASSWORD`. The full Compose app already overrides its database URL with that password.

The Dockerfile and Railway configuration are prepared but unverified by deployment. Health/readiness routes query PostgreSQL. Database backup restoration and a durable Railway audio volume remain deployment gates.

## Model and speech selection

Use ClewdR locally at `http://10.20.30.79:8484/`, with a configurable replacement endpoint for Railway. The [ClewdR repository](https://github.com/Xerxes-2/clewdr) documents native `/code/v1/messages` and compatible `/code/v1/chat/completions` routes. Real native planning and rendering succeeded with the configured `claude-opus-5-5-thinking` model, even though the advertised model list omitted it. The adapter parses ordinary final JSON and discards valid native thinking metadata before domain validation. It does not assume provider-enforced structured output.

Use ElevenLabs for text-to-speech. Its [conversion endpoint](https://elevenlabs.io/docs/api-reference/text-to-speech/convert) accepts a voice ID and authenticates with an `xi-api-key` header. Real synthesis passed with the user's configured model and voice. The key lacks model-list and voice-list permissions, but the verified synthesis path does not need them. Store stable internal voice-profile IDs on the narrator and NPC records, and keep provider IDs behind the adapter. Voice variety can follow a single-voice rehearsal.

Fake planning/rendering and silent publication remain available for tests and failure recovery. Their outputs are deterministic fixtures; they make no claim about live-provider characterization quality. Live adapters have bounded timeouts and no automatic retries. Calls run outside database transactions and can only update the job generation they were started for. Startup exposes interrupted jobs as retryable failures rather than resuming a paid request automatically.

## Consequences and open checks

The reduced phase model exposes six persistent beat phases and separate job status. Conversations still have an explicit review and lock, including a route into action stakes. This removes extra phase names from the first slice while preserving the authority boundaries in the product plan.

The initial fallback contract permits holding position. A risky fallback requires a later explicit preapproved contract representation. Resolutions store effects in dependency-ordered groups. Validation checks every applicable branch combination for up to six contracts before dice, allowing a prerequisite to supply an item while rejecting independent conflicts and branch-specific missing resources.

Optional speech currently follows text publication and uses an authorized cache/manifest. The live application rehearsal generated four speech segments, reused them on a second preparation without additional synthesis, and enforced stage access while denying anonymous downloads. A playable silent path remains available when speech is unavailable. The audio-preparation lease prevents duplicate work; it is not a broadcast-presenter lease. Preparing audio before publication, synchronized playback, optional player listening, and OBS routing remain M4 gates.

Native scenario/card authoring, cast approval/readiness, live NPC profiles/reveals, and scene changes are implemented. Audited corrections, further continuity/steering tools, broader live-model quality review, and deployment rehearsal remain unfinished. The current playable application does not satisfy the full first-show requirements yet.

Local verification passed 219 tests across 23 files, strict TypeScript/Vue checking, a production build, and five browser rehearsals covering live controls, custom authoring, the complete game flow, and multiple identities in one browser. Host-only test seats preserve invitations; credentials stay in independent HTTP-only cookies, selected by a non-secret URL identifier. A separate live-provider rehearsal verified ordinary conversation publication, exact player captions, speech, caching, and asset authorization. The live-configured launcher also passed startup migrations, database readiness, and homepage checks before its smoke server was stopped. [The implementation plan](../IMPLEMENTATION_PLAN.md) records exact commands and coverage. These results establish the local playable slice; M3 through M5 retain the remaining requirements above.

Before calling the application ready for a show, verify the deployment runtime/database combination, the public ClewdR replacement URL, provider account capabilities, persistent audio storage, backup restoration, browser audio behavior, and the cast rehearsal described in the implementation plan.
