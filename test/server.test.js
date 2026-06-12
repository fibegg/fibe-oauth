import assert from 'node:assert/strict';
import { chmodSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createServer } from '../src/server.js';

const BASE64_CREDENTIAL_PREFIX = '__fibe_base64__:';

test('serves health checks without bearer auth', async () => {
  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/up`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
  });
});

test('requires bearer auth for protected endpoints', async () => {
  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/v1/auth/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'gemini' }),
    });
    assert.equal(response.status, 401);
  });
});

test('returns unknown_provider for unsupported providers', async () => {
  await withServer(async ({ baseUrl }) => {
    const response = await jsonRequest(baseUrl, '/v1/auth/sessions', {
      method: 'POST',
      body: { provider: 'claude' },
    });
    assert.equal(response.status, 422);
    assert.deepEqual(response.body, { error: 'unknown_provider' });
  });
});

test('polls Gemini OAuth state and returns oauth_creds.json credentials', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'oauth-service-test-'));
  const fakeGemini = join(tempDir, 'fake-gemini');
  const oldGeminiBin = process.env.GEMINI_BIN;
  const oldGeminiTransport = process.env.GEMINI_AUTH_TRANSPORT;

  await writeFile(fakeGemini, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
console.log('Open https://accounts.google.com/o/oauth2/v2/auth?client_id=test-client');
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  const code = chunk.trim();
  if (!code) return;
  fs.writeFileSync(path.join(process.env.GEMINI_CLI_HOME, '.gemini', 'oauth_creds.json'), JSON.stringify({ code }));
  process.exit(0);
});
setTimeout(() => process.exit(9), 8000);
`);
  chmodSync(fakeGemini, 0o755);
  process.env.GEMINI_BIN = fakeGemini;
  process.env.GEMINI_AUTH_TRANSPORT = 'pipe';

  try {
    await withServer(async ({ baseUrl }) => {
      const created = await jsonRequest(baseUrl, '/v1/auth/sessions', {
        method: 'POST',
        body: { provider: 'gemini' },
      });
      assert.equal(created.status, 201);
      assert.equal(created.body.events[0].type, 'auth_url_generated');
      assert.match(created.body.auth_url, /^https:\/\/accounts\.google\.com/);

      const response = await jsonRequest(baseUrl, `/v1/auth/sessions/${created.body.session_id}/code`, {
        method: 'POST',
        body: { code: 'gemini-code', cursor: created.body.cursor },
      });
      assert.equal(response.status, 202);

      const result = await pollSession(baseUrl, created.body.session_id, {
        cursor: response.body.cursor,
        until: (state) => state.status === 'authenticated',
      });

      assert.deepEqual(JSON.parse(result.body.credentials['oauth_creds.json']), { code: 'gemini-code' });
    });
  } finally {
    restoreEnv('GEMINI_BIN', oldGeminiBin);
    restoreEnv('GEMINI_AUTH_TRANSPORT', oldGeminiTransport);
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('polls Codex device auth state and returns auth.json credentials', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'oauth-service-test-'));
  const fakeCodex = join(tempDir, 'fake-codex');
  const oldCodexBin = process.env.CODEX_BIN;

  await writeFile(fakeCodex, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
console.log('Visit https://auth.openai.com/device');
console.log('Code ABCD-EFGH');
fs.writeFileSync(path.join(process.env.CODEX_HOME, 'auth.json'), JSON.stringify({ access_token: 'codex-token' }));
setTimeout(() => process.exit(0), 20);
`);
  chmodSync(fakeCodex, 0o755);
  process.env.CODEX_BIN = fakeCodex;

  try {
    await withServer(async ({ baseUrl }) => {
      const created = await jsonRequest(baseUrl, '/v1/auth/sessions', {
        method: 'POST',
        body: { provider: 'openai-codex' },
      });
      assert.equal(created.status, 201);
      assert.equal(created.body.events[0].type, 'auth_url_generated');

      const result = await pollSession(baseUrl, created.body.session_id, {
        cursor: created.body.cursor,
        until: (state) => state.status === 'authenticated',
      });

      const events = [...created.body.events, ...result.events];
      assert.deepEqual(events.map((event) => event.type), [
        'auth_url_generated',
        'auth_device_code',
        'auth_success',
      ]);
      assert.equal(events[1].code, 'ABCD-EFGH');
      assert.deepEqual(JSON.parse(result.body.credentials['auth.json']), { access_token: 'codex-token' });
    });
  } finally {
    restoreEnv('CODEX_BIN', oldCodexBin);
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('polls Antigravity OAuth state and returns credential files', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'oauth-service-test-'));
  const fakeAntigravity = join(tempDir, 'fake-agy');
  const oldAntigravityBin = process.env.ANTIGRAVITY_BIN;
  const oldAntigravityTransport = process.env.ANTIGRAVITY_AUTH_TRANSPORT;

  await writeFile(fakeAntigravity, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const geminiHome = process.env.ANTIGRAVITY_HOME || process.env.SESSION_DIR || path.join(process.env.HOME, '.gemini');
console.log('Open https://accounts.google.com/o/oauth2/v2/auth?client_id=antigravity-test');
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  const code = chunk.trim();
  if (!code) return;
  fs.mkdirSync(path.join(geminiHome, 'antigravity-cli', 'cache'), { recursive: true });
  fs.mkdirSync(path.join(geminiHome, '.local', 'share', 'keyrings'), { recursive: true });
  fs.writeFileSync(path.join(geminiHome, '.local', 'share', 'keyrings', 'login.keyring'), Buffer.from([0, 1, 2, 3, 255]));
  fs.writeFileSync(
    path.join(geminiHome, 'antigravity-cli', 'cache', 'last_conversations.json'),
    JSON.stringify({ [process.cwd()]: 'session-1' })
  );
  fs.writeFileSync(
    path.join(geminiHome, 'antigravity-cli', 'cache', 'history.json'),
    JSON.stringify({ history: 'x'.repeat(96 * 1024) })
  );
  setInterval(() => {}, 1000);
});
setTimeout(() => process.exit(9), 8000);
`);
  chmodSync(fakeAntigravity, 0o755);
  process.env.ANTIGRAVITY_BIN = fakeAntigravity;
  process.env.ANTIGRAVITY_AUTH_TRANSPORT = 'pipe';

  try {
    await withServer(async ({ baseUrl }) => {
      const created = await jsonRequest(baseUrl, '/v1/auth/sessions', {
        method: 'POST',
        body: { provider: 'antigravity' },
      });
      assert.equal(created.status, 201);
      assert.equal(created.body.events[0].type, 'auth_url_generated');
      assert.match(created.body.auth_url, /^https:\/\/accounts\.google\.com/);

      const response = await jsonRequest(baseUrl, `/v1/auth/sessions/${created.body.session_id}/code`, {
        method: 'POST',
        body: { code: 'antigravity-code', cursor: created.body.cursor },
      });
      assert.equal(response.status, 202);

      const result = await pollSession(baseUrl, created.body.session_id, {
        cursor: response.body.cursor,
        until: (state) => state.status === 'authenticated',
      });

      assert.deepEqual(Object.keys(result.body.credentials), ['.local/share/keyrings/login.keyring']);
      const encoded = result.body.credentials['.local/share/keyrings/login.keyring'];
      assert.equal(encoded.startsWith(BASE64_CREDENTIAL_PREFIX), true);
      assert.deepEqual(
        [...Buffer.from(encoded.slice(BASE64_CREDENTIAL_PREFIX.length), 'base64')],
        [0, 1, 2, 3, 255],
      );
    });
  } finally {
    restoreEnv('ANTIGRAVITY_BIN', oldAntigravityBin);
    restoreEnv('ANTIGRAVITY_AUTH_TRANSPORT', oldAntigravityTransport);
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('reports unsupported Antigravity CLI runtime clearly', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'oauth-service-test-'));
  const fakeAntigravity = join(tempDir, 'fake-agy');
  const oldAntigravityBin = process.env.ANTIGRAVITY_BIN;
  const oldAntigravityTransport = process.env.ANTIGRAVITY_AUTH_TRANSPORT;

  await writeFile(fakeAntigravity, `#!/usr/bin/env node
console.error('FATAL ERROR: This binary was compiled with lse enabled');
process.exit(132);
`);
  chmodSync(fakeAntigravity, 0o755);
  process.env.ANTIGRAVITY_BIN = fakeAntigravity;
  process.env.ANTIGRAVITY_AUTH_TRANSPORT = 'pipe';

  try {
    await withServer(async ({ baseUrl }) => {
      const created = await jsonRequest(baseUrl, '/v1/auth/sessions', {
        method: 'POST',
        body: { provider: 'antigravity' },
      });
      assert.equal(created.status, 201);
      assert.equal(created.body.status, 'error');
      assert.match(created.body.message, /requires ARM LSE support/);
    });
  } finally {
    restoreEnv('ANTIGRAVITY_BIN', oldAntigravityBin);
    restoreEnv('ANTIGRAVITY_AUTH_TRANSPORT', oldAntigravityTransport);
    await rm(tempDir, { recursive: true, force: true });
  }
});

async function withServer(callback) {
  const server = createServer({ token: 'secret' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    await callback({ baseUrl, server });
  } finally {
    server.authSessionManager.cancelAll('Test finished.');
    await new Promise((resolve) => server.close(resolve));
  }
}

async function jsonRequest(baseUrl, path, { method = 'GET', body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      authorization: 'Bearer secret',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null,
  };
}

async function pollSession(baseUrl, sessionId, { cursor = 0, until }) {
  const events = [];

  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await jsonRequest(baseUrl, `/v1/auth/sessions/${sessionId}?cursor=${cursor}`);
    assert.equal(response.status, 200);
    events.push(...response.body.events);
    cursor = response.body.cursor;
    if (until?.(response.body)) return { body: response.body, events };
    await delay(25);
  }

  throw new Error('session did not reach expected state');
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
