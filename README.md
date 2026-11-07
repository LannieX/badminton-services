# badminton-services

Node.js 22+ HTTP API with PostgreSQL (`pg`) and Zod input validation. Frontend: sibling `badminton` repository.

```sh
npm install
cp .env.example .env
# Set DATABASE_URL in .env (server only).
npm run dev
```

Default: `http://127.0.0.1:3001`. The frontend Vite proxy forwards `/api` here, including requests from phones on the same Wi-Fi. The database URL never belongs in `VITE_*` variables. `.env` is ignored by Git.

Startup applies additive, idempotent migrations. Explicitly migrate with `npm run migrate`. Tables: `rally_sessions` (date, name, version, JSONB expenses/members) and `rally_matches` (normalized match rows). Currency is validated to satang precision. Parameterized SQL, TLS verification, channel binding, connection limits and query timeouts are enabled.

| Method | Route               | Request                                                |
| ------ | ------------------- | ------------------------------------------------------ |
| GET    | `/api/health`       | Database health                                        |
| GET    | `/api/sessions`     | All sessions with nested matches, expenses and members |
| POST   | `/api/sessions`     | `{id,name,date}`                                       |
| PUT    | `/api/sessions/:id` | `{version,expenses,members}`                           |
| POST   | `/api/matches`      | `{id,time,mode,names,scores,target}`                   |

Match completion creates `daily:YYYY-MM-DD` using server time in Asia/Bangkok. Stable match UUIDs make retries idempotent. Transactions and row locks preserve matches submitted simultaneously. Reusing a match ID with different scores returns 409. A stale session version also returns 409; clients reload before retrying. Changing expenses or participant membership resets payment flags on the server.

`npm test` runs validation tests; `node --env-file=.env --test tests/*.test.mjs` also runs database integration tests in a unique temporary schema, removed afterward. Tests do not modify application rows. `npm run format` and `npm run format:check` use Prettier.

This initial API is shared within the local app and has no user accounts or authorization. For remote deployment, keep secrets on the server, use HTTPS, add the intended authentication/access model and proxy `/api` to this service. It is not published by this setup.

`POST /api/import` accepts `{sessions: [...]}` for the History screen's explicit legacy import action. Historical dates are retained. Missing match/expense/member IDs are merged; existing IDs are not overwritten. Adding amounts or participants to an existing session resets payment statuses for review. Import is transactional and safe to repeat. JSON content type is required for mutations; no cross-origin permissions are granted by the API.

`POST /api/payment-requests` accepts `{id, sessionId?, totalCents, playerCount, method, recipient, bankCode?}`. `method` is `promptpay` or `bank`. A missing session ID creates/reuses today's daily session; an explicit ID links to the selected round. Amounts are stored as integer satang. Each request has a stable UUID for idempotent retries. An additive `rally_payment_requests` table stores receiver details and count. GET sessions includes `paymentRequests`; old session data is retained. This stores payment requests only and does not execute transfers or verify payment settlement.

`PUT /api/sessions/:sessionId/payment-requests/:id` accepts `{version, payment}` to update a request. `DELETE` on the same URL accepts `{version}`. Both lock the session, check its version, increment it on changes, and return the updated session. Identical retries are safe. Deleted requests retain a tombstone to prevent creation retries from restoring them; session reads exclude them. These operations do not execute, cancel, or refund bank transfers.
