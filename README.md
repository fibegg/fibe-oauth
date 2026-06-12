# Gemini/Codex/Antigravity OAuth Service

Small internal Node.js service that owns OAuth browser/device flows requiring
runtime CLIs. Clients call it over HTTP; when it is unavailable, Gemini,
Antigravity, and OpenAI Codex OAuth setup is unavailable.

Current providers:

- `gemini`: runs `gemini -p ""` in an isolated temporary home and returns
  `.gemini/oauth_creds.json`.
- `antigravity`: runs `agy --prompt=... --print-timeout 5m` in an isolated
  temporary home and returns generated `.gemini` credential files.
- `openai-codex`: runs `codex login --device-auth` in an isolated temporary home
  and returns `auth.json`.

Useful local commands:

```sh
npm test
npm start
docker build -t fibe-oauth .
```

Protected endpoints require `Authorization: Bearer $AUTH_SERVICE_TOKEN`
when the token is set. `GET /up` is intentionally unauthenticated for container
health checks.

Example:

```sh
curl -X POST http://localhost:8080/v1/auth/sessions \
  -H 'content-type: application/json' \
  -d '{"provider":"gemini"}'

curl 'http://localhost:8080/v1/auth/sessions/<session_id>?cursor=0'
```

HTTP contract:

- `POST /v1/auth/sessions` with `{ "provider": "gemini" | "antigravity" | "openai-codex" }`
  starts a session, waits briefly for the first prompt, and returns the current
  JSON state.
- `GET /v1/auth/sessions/:id?cursor=n` returns the current JSON state and any
  events after `n`.
- `POST /v1/auth/sessions/:id/code` submits a Gemini OAuth code and returns the
  current JSON state.
- `DELETE /v1/auth/sessions/:id` cancels an active auth session.

Session state shape:

```json
{
  "session_id": "...",
  "status": "pending | awaiting_user | authenticated | unauthenticated | error | cancelled",
  "cursor": 1,
  "events": [{ "type": "auth_url_generated", "url": "https://..." }],
  "auth_url": "https://...",
  "device_code": "ABCD-EFGH"
}
```
