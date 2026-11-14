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
- `.dev.vars`: local Workers secrets, ignored by git. Copy `.dev.vars.example` and set `DATABASE_URL` and a strong `API_TOKEN`. Keep this file private.
- Use exact frontend origins in `ALLOWED_ORIGINS` when the frontend gets its production URL. Do not use wildcard CORS.

The deployed API requires `Authorization: Bearer <API_TOKEN>` for every data endpoint. `/api/health` is a public read-only connection check. The token is for a trusted server/proxy; do not embed it in a public React/Vite bundle. A production frontend must use a trusted backend proxy or a proper end-user authentication integration. CORS alone is not authentication.

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

Wrangler will print the API URL `https://ibadz-api.<account-subdomain>.workers.dev`. Keep secrets out of source code, terminal output and browser-visible configuration. A missing `API_TOKEN` makes data endpoints return 503 rather than expose records.

Verify `/api/health` returns HTTP 200 and `{"status":"ok","database":"connected"}`. Verify an unauthenticated `/api/sessions` returns 401. Verify an authenticated request succeeds without printing the returned account/recipient data.

## Free tier and rollback

No paid Workers features or Hyperdrive bindings are configured. Workers Free limits still apply; Neon Free can suspend its compute when inactive independently of Worker startup. API traffic and database costs remain governed by their respective plans.

Use Cloudflare deployment versions to roll back a Worker release. Migrations here are additive; application data stays in Neon and is not copied to Cloudflare storage.

References: https://developers.cloudflare.com/workers/platform/pricing/ and https://neon.com/docs/serverless/serverless-driver
