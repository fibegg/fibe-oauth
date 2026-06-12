import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { UnknownProviderError, NotFoundError } from './errors.js';
import { SessionManager } from './session-manager.js';
import { AntigravityProvider } from './providers/antigravity.js';
import { GeminiProvider } from './providers/gemini.js';
import { OpenaiCodexProvider } from './providers/openai-codex.js';

const PROVIDERS = {
  antigravity: AntigravityProvider,
  gemini: GeminiProvider,
  'openai-codex': OpenaiCodexProvider,
};

export function createServer({ manager = new SessionManager(), token = process.env.AUTH_SERVICE_TOKEN || '' } = {}) {
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url || '/', 'http://127.0.0.1');
      const path = url.pathname;

      if (request.method === 'GET' && path === '/up') {
        writeJson(response, 200, { ok: true });
        return;
      }

      if (!authorized(request, token)) {
        writeJson(response, 401, { error: 'unauthorized' });
        return;
      }

      await route({ request, response, manager, path, url });
    } catch (error) {
      handleError(response, error);
    }
  });

  server.authSessionManager = manager;
  return server;
}

async function route({ request, response, manager, path, url }) {
  if (request.method === 'POST' && path === '/v1/auth/sessions') {
    await createSession({ request, response, manager });
    return;
  }

  const match = path.match(/^\/v1\/auth\/sessions\/([^/]+)(?:\/(code))?$/);
  if (!match) {
    writeJson(response, 404, { error: 'not_found' });
    return;
  }

  const sessionId = decodeURIComponent(match[1]);
  const action = match[2];

  if (request.method === 'GET' && !action) {
    showSession({ response, manager, sessionId, cursor: url.searchParams.get('cursor') });
    return;
  }

  if (request.method === 'POST' && action === 'code') {
    const body = await jsonBody(request);
    const session = manager.fetch(sessionId);
    session.submitCode(String(body.code || ''));
    writeJson(response, 202, session.snapshot(Number(body.cursor) || 0));
    return;
  }

  if (request.method === 'DELETE' && !action) {
    manager.fetch(sessionId).cancel('Authentication cancelled.');
    manager.forget(sessionId);
    writeJson(response, 202, { ok: true });
    return;
  }

  writeJson(response, 404, { error: 'not_found' });
}

async function createSession({ request, response, manager }) {
  const body = await jsonBody(request);
  const providerName = String(body.provider || '');
  const Provider = PROVIDERS[providerName];
  if (!Provider) throw new UnknownProviderError('unknown_provider');

  const session = manager.create(new Provider());
  await session.waitForChange(0, createWaitMs());
  writeJson(response, 201, session.snapshot(0));
}

function showSession({ response, manager, sessionId, cursor }) {
  const session = manager.fetch(sessionId);
  writeJson(response, 200, session.snapshot(Number(cursor) || 0));
}

function createWaitMs() {
  return Math.max(0, Number(process.env.AUTH_CREATE_WAIT_SECONDS || 30)) * 1000;
}

function authorized(request, token) {
  if (!token) return true;
  const header = String(request.headers.authorization || '');
  const supplied = header.replace(/^Bearer\s+/i, '');
  const expectedBuffer = Buffer.from(token);
  const suppliedBuffer = Buffer.from(supplied);
  return suppliedBuffer.length === expectedBuffer.length && timingSafeEqual(suppliedBuffer, expectedBuffer);
}

async function jsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_000_000) throw new SyntaxError('request_body_too_large');
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  return JSON.parse(raw);
}

function writeJson(response, statusCode, payload) {
  response.writeHead(statusCode, { 'content-type': 'application/json' });
  response.end(JSON.stringify(payload));
}

function handleError(response, error) {
  if (response.headersSent) {
    response.destroy(error);
    return;
  }

  if (error instanceof SyntaxError) {
    writeJson(response, 400, { error: 'invalid_json' });
    return;
  }

  if (error instanceof UnknownProviderError) {
    writeJson(response, 422, { error: error.message });
    return;
  }

  if (error instanceof NotFoundError) {
    writeJson(response, 404, { error: error.message });
    return;
  }

  console.warn(`[oauth-service] ${error?.stack || error}`);
  writeJson(response, 500, { error: 'internal_error' });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT || 8080);
  const server = createServer();

  const shutdown = () => {
    server.authSessionManager.cancelAll();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  server.listen(port, '0.0.0.0', () => {
    console.log(`[oauth-service] listening on ${port}`);
  });
}
