# The Story Table

The Story Table runs a live roleplay show on Twitch. Players speak and act for their own characters from a web page, an AI plays the world and its non-player characters, and a human director reviews every beat (one exchange of dialogue or one action round) before the audience sees it. The server owns the rules and the record: it rolls the dice and applies the outcomes the director approved. OBS (Open Broadcaster Software) puts the stage on stream with captions, dice, narration and pictures.

## What it does

- Players join with a private invitation, write their own character or take a saved card, and send dialogue or actions from a simple seat page. They follow the story on the stream.
- The director works through each beat in a guided workspace: pick the lines, review the stakes, lock the beat, check the drafted script, then publish. The stakes say what an action is trying to do and what each roll result means, and the server rolls any dice when the beat is locked.
- An AI model behind a ClewdR endpoint plans the stakes and drafts narration and dialogue. Player lines go into the script word for word. The AI is told never to speak or decide for a player character, and it has no way to change a roll. It can also write a whole character card or a whole scenario from one prompt, and a person reviews the draft before anything is saved.
- ElevenLabs voices the narration, and the director can preview the recording privately before publishing it. Only the main show link in OBS plays the broadcast audio.
- Sogni can draw a picture for each scene, action round and beat, plus character portraits. Pictures are optional and never hold up the show.
- Stream links give OBS a full-scene layout or a transparent overlay without a sign-in.
- Producers can help the host run a show. The in-app help at `/help` covers getting started, running a show, the stage in OBS and troubleshooting.

A built-in four-player rehearsal, The Ledger Job, runs without any outside services.

The app is built with TypeScript, Vue, Fastify, Socket.IO, Zod and PostgreSQL, and tested with Vitest and Playwright.

## Requirements

- Node.js 24.22.1, pinned in `.nvmrc`.
- PostgreSQL. The local launcher starts a private database server when it can find the PostgreSQL programs. Version 14 is the one tested locally.
- Optional services: a ClewdR endpoint for the AI, an ElevenLabs account for voices and a Sogni key for pictures. Without them the app uses a fake AI and silent narration, and pictures stay off.

## Run it locally

```sh
nvm install
nvm use
npm ci
npm run local
```

On first run, `npm run local` copies `.env.example` to `.env` with a random host token and database password. If the default local database set in `.env` isn't running, it starts PostgreSQL on `127.0.0.1:55432` with its data under `.local/postgres` and creates the `rpg` and `rpg_test` databases. Then it builds the web app and starts the server, which applies any new migrations as it starts.

Open http://localhost:3000 and sign in with `HOST_TOKEN` from `.env`. Keep that token the same: your saved shows and library belong to it.

If the launcher can't find PostgreSQL, set `PG_BIN` to the folder that holds `pg_ctl`, or start the database with `docker compose up -d db`. With the Compose database, add the `POSTGRES_PASSWORD` from `.env` to `DATABASE_URL` and `TEST_DATABASE_URL`.

## Configuration

Settings come from `.env` (see `.env.example`) or from the environment.

| Setting | What it does |
| --- | --- |
| `DATABASE_URL`, `TEST_DATABASE_URL` | The app's database, and a throwaway database for tests |
| `HOST_TOKEN` | The host's sign-in secret, at least 24 characters |
| `APP_ORIGIN`, `PORT` | The address people open in the browser (requests from any other origin are refused) and the port the server listens on |
| `AI_PROVIDER` | `fake` (default) or `clewdr`. ClewdR also needs `CLEWDR_BASE_URL`, `CLEWDR_API_KEY` and `CLEWDR_MODEL`. |
| `TTS_PROVIDER` | `silent` (default) or `elevenlabs`. ElevenLabs also needs `ELEVENLABS_API_KEY`, `ELEVENLABS_MODEL` and `ELEVENLABS_VOICE_ID`. |
| `ASSET_DIR` | Where narration audio and pictures are stored (default `.local/audio`) |
| `POSTGRES_PASSWORD` | The database password Docker Compose uses |
| `SOGNI_KEY` | Turns pictures on. Export it in the shell that starts the server; the project keeps it out of `.env`. |
| `IMAGE_PROVIDER` | `sogni` or `off`. Defaults to `sogni` when `SOGNI_KEY` is set. |
| `SOGNI_IMAGE_MODEL` | The picture model a show uses unless it picks its own (default `krea-2-turbo`) |
| `SOGNI_HOURLY_LIMIT` | An optional cap on pictures per hour, a whole number from 1 to 1000 |
| `SOGNI_SAFE_FILTER` | `on` or `off` (default) for Sogni's safe-content filter |

The startup log says whether pictures are on.

## Running a show

1. Sign in as the host. Press **Try it now** for a practice show with no setup, or **Make a show** to write or pick a story and add two to six seats (a player writes the card, you describe it in a sentence, or it comes from a saved card).
2. In **Cast & lobby**, press **Copy all invitations** and send each player theirs. Players join, write a short card and wait on one page until the start.
3. Open **Stream this show** and, on a link card, press **Copy overlay link** or **Copy full-scene link**. Paste it into OBS as a browser source. The in-app help walks through the OBS settings.
4. Press **Start show** once every seat has a card. You land on the director page.
5. Players send their lines, which arrive ticked. Press **Answer these lines** and a conversation is planned and drafted; it never rolls dice. An action round is **Open action round**, **Plan**, then **Approve and roll**, which rolls once. Check the script, then press **Publish**, which waits for the narration and starts playback.
6. When the story is done, press **End show**. The gallery starts off. Press **Turn on gallery**, then **Gallery link** and **Copy link** appear.

To try a show alone, use the **Test as** links in Cast & lobby. Each one opens a working player seat in its own tab, and whatever it sends counts as that player's input.

## Tests

| Command | What it runs |
| --- | --- |
| `npm run typecheck` | Strict TypeScript and Vue type checks |
| `npm test` | Unit and component tests. Database tests are skipped unless `TEST_DATABASE_URL` is set. |
| `npm run test:integration` | The database tests, using `TEST_DATABASE_URL` from `.env` |
| `npm run test:e2e` | Playwright browser tests on port 3100, against the `rpg_test` database |
| `npm run check` | Type checks, unit tests and a production build |

The browser tests serve the built app, so run `npm run build` first. Install their browser with `npx playwright install chromium`, or point `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` at a Chromium you already have. They use a fake AI, silent narration and fake pictures, and `BROWSER_PICTURES=off` runs them with pictures turned off. The database and browser tests write to the database they're given, so point them only at a throwaway one, never at the database that holds your shows.

## Project layout

| Path | Contents |
| --- | --- |
| `apps/server` | Fastify server: sign-in, commands, beats, AI and picture jobs, routes |
| `apps/web` | Vue app: host home, library, lobby, director workspace, player seat, stage, stream view and help |
| `packages/contracts` | Zod schemas and types shared by the server and the browser |
| `packages/rules` | Game rules as pure functions: checks, outcomes and effects |
| `packages/providers` | Adapters for ClewdR, ElevenLabs and Sogni |
| `packages/test-fixtures` | The Ledger Job rehearsal content |
| `migrations` | Numbered database migrations, applied at startup |
| `tests/browser` | Playwright tests |
| `scripts/local.mjs` | The local launcher |

## Deployment

The `Dockerfile` and `railway.json` target Railway, which checks `/health/ready`. `compose.yaml` runs the app with PostgreSQL 17.11. Neither the Docker build nor a Railway deployment has been tested yet. A hosted server also needs a ClewdR address it can reach over the internet.

## More documentation

- [CODEX_START_HERE.md](CODEX_START_HERE.md): the current state, how each feature works, test results and known limits
- [PROJECT_PLAN.md](PROJECT_PLAN.md): the product and game design
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how the server, browser and database fit together
- [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md): the delivery gates and the evidence for each
- [docs/decisions/001-foundation.md](docs/decisions/001-foundation.md): the choice of stack

## License

Released into the public domain under the Unlicense. See [LICENSE](LICENSE).
