import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, resolveAuthServiceToken } from '../src/server.js';

test('resolves canonical token, legacy alias and explicit empty local mode', () => {
  assert.equal(resolveAuthServiceToken({}), '');
  assert.equal(resolveAuthServiceToken({ AUTH_SERVICE_TOKEN: '', FIBE_AUTH_SERVICE_TOKEN: '' }), '');
  assert.equal(resolveAuthServiceToken({ AUTH_SERVICE_TOKEN: 'canonical-test' }), 'canonical-test');
  assert.equal(resolveAuthServiceToken({ FIBE_AUTH_SERVICE_TOKEN: 'legacy-test' }), 'legacy-test');
  assert.equal(resolveAuthServiceToken({ AUTH_SERVICE_TOKEN: '', FIBE_AUTH_SERVICE_TOKEN: 'legacy-test' }), 'legacy-test');
  assert.equal(resolveAuthServiceToken({ AUTH_SERVICE_TOKEN: 'same-test', FIBE_AUTH_SERVICE_TOKEN: 'same-test' }), 'same-test');
  assert.throws(() => resolveAuthServiceToken({ AUTH_SERVICE_TOKEN: 'first-test', FIBE_AUTH_SERVICE_TOKEN: 'second-test' }), error => {
    assert.equal(error.message, 'AUTH_SERVICE_TOKEN and FIBE_AUTH_SERVICE_TOKEN conflict');
    assert.ok(!error.message.includes('first-test') && !error.message.includes('second-test'));
    return true;
  });
});

test('each environment name enables bearer authentication and preserves public health', async () => {
  const saved = { canonical: process.env.AUTH_SERVICE_TOKEN, legacy: process.env.FIBE_AUTH_SERVICE_TOKEN };
  try {
    for (const selected of ['AUTH_SERVICE_TOKEN', 'FIBE_AUTH_SERVICE_TOKEN']) {
      delete process.env.AUTH_SERVICE_TOKEN;
      delete process.env.FIBE_AUTH_SERVICE_TOKEN;
      process.env[selected] = 'synthetic-service-token';
      const server = createServer();
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const base = `http://127.0.0.1:${server.address().port}`;
      try {
        assert.equal((await fetch(`${base}/up`)).status, 200);
        for (const authorization of [undefined, 'Bearer wrong', 'synthetic-service-token', 'Basic synthetic-service-token']) {
          const headers = authorization ? { authorization } : {};
          assert.equal((await fetch(`${base}/v1/auth/sessions/missing`, { headers })).status, 401);
        }
        const accepted = await fetch(`${base}/not-a-route`, { headers: { authorization: 'Bearer synthetic-service-token' } });
        assert.equal(accepted.status, 404); // Authorized routing, without starting a provider.
      } finally {
        server.authSessionManager.cancelAll('Test finished.');
        await new Promise(resolve => server.close(resolve));
      }
    }
    process.env.AUTH_SERVICE_TOKEN = 'one-test';
    process.env.FIBE_AUTH_SERVICE_TOKEN = 'two-test';
    assert.throws(() => createServer(), /conflict/);
    const explicit = createServer({ token: '' });
    await new Promise(resolve => explicit.listen(0, '127.0.0.1', resolve));
    try {
      assert.equal((await fetch(`http://127.0.0.1:${explicit.address().port}/not-a-route`)).status, 404);
    } finally {
      await new Promise(resolve => explicit.close(resolve));
    }
  } finally {
    for (const [name, value] of [['AUTH_SERVICE_TOKEN', saved.canonical], ['FIBE_AUTH_SERVICE_TOKEN', saved.legacy]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});
