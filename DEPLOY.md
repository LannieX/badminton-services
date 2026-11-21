# iBadz API on Cloudflare Workers Free

The frontend remains in the separate `badminton` repository. This Worker uses the same Neon tables, validation, transactions and API routes as the local Node server. The Node server remains available via `npm run dev` / `npm start`.

## Commands

Requires Node.js 22+.

```sh
npm ci
npm test
npm run build:worker
npm run cf:login
npm run cf:whoami
```

`build:worker` bundles locally without publishing. Run PostgreSQL integration tests with `node --env-file=.env --test tests/*.test.mjs`; they create and remove an isolated test schema and do not change application records.

## Configuration

- `wrangler.jsonc`: Worker name `ibadz-api`, Workers runtime date, Node compatibility, allowed frontend origins.
- `.env`: existing local Node/PostgreSQL configuration. Never upload or commit it.
- `.dev.vars`: local Workers secrets, ignored by git. Copy `.dev.vars.example` and set `DATABASE_URL` and `CLOUDINARY_URL`. Keep this file private.
- Use exact frontend origins in `ALLOWED_ORIGINS` when the frontend gets its production URL. Do not use wildcard CORS.

All data endpoints now require a logged-in member. Only `/api/health` and `/api/auth/login` are public. Admins can create/edit members, set active/inactive, and manage scores/expenses/payment confirmations. Viewers can read members, history and expenses, and edit their own name/username/avatar through PUT /api/auth/me. Other profile fields (id, role, status, password) are rejected on that endpoint. Viewers can also create tournaments; deleting tournaments and recording results require admin. Member creation always defaults to viewer and rejects role injection. There is no public registration endpoint.

Authentication uses opaque random session cookies (`HttpOnly`, `SameSite=Strict`, `Secure` over HTTPS). Only token hashes are stored in PostgreSQL. Sessions expire 15 days after login, with a bounded 15-day idle timeout; logout invalidates them server-side. Changing password/status invalidates previous sessions. Inactive members cannot log in. Login attempts are limited per username to 10 in 15 minutes. Mutation requests require `X-Requested-With: ibadz` and configured CORS origins.

The frontend must reach the API through the same origin `/api` proxy/rewrite (Vite in development, hosting rewrite in production). Direct cross-site Workers requests do not use this same-origin cookie flow. Do not put session tokens in frontend env or localStorage.

## Local Workers runtime

```sh
npm run dev:worker
```

Wrangler reads `.dev.vars`. Test `/api/health` on `http://localhost:8787`. The Worker opens a Neon serverless pool per request and closes it with `ctx.waitUntil`; no connections are shared across requests. Existing migrations run separately with `npm run migrate`, never on every Worker request.

## Publish

1. Log into the intended Cloudflare account. Remain on Workers Free; these commands do not require upgrading or adding paid bindings.
2. Ensure the existing Neon schema is current with `npm run migrate`.
3. Upload the ignored `.dev.vars` values as encrypted Cloudflare secrets:

```sh
npx wrangler secret bulk .dev.vars
npm run deploy
```

Wrangler will print the API URL `https://ibadz-api.<account-subdomain>.workers.dev`. Keep secrets out of source code, terminal output and browser-visible configuration. A missing `DATABASE_URL` returns 503.

Verify `/api/health` returns HTTP 200 and `{"status":"ok","database":"connected"}`. Verify anonymous `/api/sessions` and `/api/players` return 401, login works, viewer writes return 403, and admin writes succeed.

## Free tier and rollback

No paid Workers features or Hyperdrive bindings are configured. Workers Free limits still apply; Neon Free can suspend its compute when inactive independently of Worker startup. API traffic and database costs remain governed by their respective plans.

Use Cloudflare deployment versions to roll back a Worker release. Migrations here are additive; application data stays in Neon and is not copied to Cloudflare storage.

References: https://developers.cloudflare.com/workers/platform/pricing/ and https://neon.com/docs/serverless/serverless-driver

## Member setup and Cloudinary

1. Run `npm run migrate` before deploying. It maps the previous user role to viewer, preserves existing admins and profiles, and adds sessions/status/payment-member tables. Migrations are repeatable.
2. Create the first admin (or reset/promote an existing username) from a trusted local terminal:

```sh
npm run admin:create -- YOUR_USERNAME "YOUR_NAME"
```

The command prompts for and confirms a hidden password. It never prints the password. No default admin password or public bootstrap route exists. An optional local `BOOTSTRAP_ADMIN_PASSWORD` can be used for automation; never place it in frontend or tracked files.

3. Set `CLOUDINARY_URL` in ignored local `.env` / `.dev.vars`. Set the deployed secret with `npx wrangler secret put CLOUDINARY_URL`, then deploy the Worker and frontend versions together. Existing database/Cloudinary secrets remain usable; no auth signing secret is required.

- `POST /api/auth/login`, `GET /api/auth/me`, `POST /api/auth/logout`.
- `GET /api/players?q=...`, admin-only `POST /api/players` and `PUT /api/players/:id`.
- Members are deactivated rather than deleted, preserving payment history. Self-deactivation and disabling the last active admin are prevented.
- `rally_roles` contains admin/viewer; `rally_players.role_id` references it. Legacy `rally_players.role` is retained only for compatibility; new reads use the join.
- Images upload server-side only on saving a member; database stores URL/public ID. Old images are cleaned up after a successful replacement/removal. Cleanup is best effort if Cloudinary is temporarily unavailable.
- Passwords are salted PBKDF2-SHA256 hashes. Neither passwords nor hashes appear in API responses.
- Payment requests accept optional `memberIds` matching `playerCount`. New UI-created bills select members; legacy anonymous bills remain readable and can be assigned members by editing.
- Amounts are allocated exactly in satang. Admins confirm/unconfirm each member via `PATCH /api/payment-requests/:paymentId/members/:memberId` with `{paid,version}`. This is a manual confirmation, not bank reconciliation.
- Allocation/roster changes reset confirmations when amounts/membership change; recipient-only changes preserve them. Inactive members remain in historical bills and can still have past payments confirmed, but cannot be added to new bills.

Self-service profile changes preserve role, account status and password. Username changes apply on the next login; the current session stays valid. Avatar changes use the existing Cloudinary upload/cleanup flow on save.

Network errors/timeouts and 5xx responses do not invalidate sessions. The frontend retries verification without showing login until authentication is known. Only a confirmed `401` with code `SESSION_INVALID` clears login. `/api/auth/me` refreshes the cookie to the remaining server-side lifetime without extending the original 15-day deadline. Migration extends still-valid older sessions to 15 days from their original login; expired/revoked sessions stay invalid.

Member directory pagination: `GET /api/players?q=...&page=1&pageSize=10` returns `{players,total,page,pageSize}`. Page size is limited to 100, and pages outside the result range clamp to the last page. Omitting paging parameters preserves the directory response for the expense member picker. New/changed passwords require at least 8 characters; existing optional password fields remain unchanged when blank.

## Fixed-pair tournaments

Run `npm run migrate` before deploying this version. Additive tables: `rally_tournaments`, `rally_tournament_players`, `rally_tournament_games`.

- Logged-in members read `GET /api/tournaments?page=1` (10/page) and `GET /api/tournaments/:id`.
- Admins and viewers create with `POST /api/tournaments` and `{id,target,teams:[{playerIds:[uuid,uuid]},...]}`. 4–64 distinct active attendees, 2–32 fixed teams. Optional name is autogenerated when omitted.
- Schedule is generated server-side as a single round robin. Each team plays every other team exactly once (N−1 matches); odd team counts have equal byes.
- Results use `POST /api/tournaments/:id/games/:gameId/result` with `{scores:[home,away]}`. Team names/target are immutable. Win-by-two is required except target 1.
- Finishes lock the tournament and atomically write the result plus the existing daily session/match history. Duplicate identical submissions are idempotent; conflicting results return 409.
- No ranking is invented for ties: UI sorts wins, score difference, then points scored; exact ties share a rank.
- The legacy-import control was removed from the frontend. Existing historical records remain untouched.

Admin-only `DELETE /api/tournaments/:id` soft-deletes the tournament. It disappears from list/detail and cannot receive further results; previously saved daily match history is preserved. Deletion and result writes serialize on the tournament row. Deletion retries are idempotent, deleted IDs cannot be reused, and viewers cannot delete or submit match results. Run migration to add `rally_tournaments.deleted_at`.
