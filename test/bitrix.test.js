import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBitrixClient, toQuery, BitrixError } from '../src/bitrix.js';
import { silentLogger } from './fakes.js';

const WEBHOOK = 'https://demo.bitrix24.vn/rest/1/secret-token/';

const json = (status, body) => ({ ok: status < 400, status, json: async () => body });

/** fetch fake returning queued responses (or throwing queued errors). */
function fakeFetch(...responses) {
  const fn = async (url, init) => {
    fn.requests.push({ url, body: JSON.parse(init.body) });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next(JSON.parse(init.body)) : next;
  };
  fn.requests = [];
  return fn;
}

const client = (fetchImpl) => createBitrixClient({
  webhookUrl: WEBHOOK, fetchImpl, minIntervalMs: 0, retry: { retries: 2, baseDelayMs: 0 }, logger: silentLogger,
});

test('toQuery serializes nested params PHP-style', () => {
  assert.equal(
    decodeURIComponent(toQuery({ filter: { EMAIL: 'a@b.c' }, select: ['ID'], skip: undefined })),
    'filter[EMAIL]=a@b.c&select[0]=ID',
  );
});

test('call posts JSON to <webhook>/<method>.json and returns result', async () => {
  const fetchImpl = fakeFetch(json(200, { result: 42 }));
  assert.equal(await client(fetchImpl).call('crm.lead.add', { fields: { NAME: 'An' } }), 42);
  assert.equal(fetchImpl.requests[0].url, 'https://demo.bitrix24.vn/rest/1/secret-token/crm.lead.add.json');
  assert.deepEqual(fetchImpl.requests[0].body, { fields: { NAME: 'An' } });
});

test('call retries rate-limit and network errors with backoff', async () => {
  const fetchImpl = fakeFetch(
    json(503, { error: 'QUERY_LIMIT_EXCEEDED', error_description: 'Too many requests' }),
    new Error('socket hang up'),
    json(200, { result: true }),
  );
  assert.equal(await client(fetchImpl).call('crm.lead.update'), true);
  assert.equal(fetchImpl.requests.length, 3);
});

test('call gives up after max retries', async () => {
  const fetchImpl = fakeFetch(new Error('timeout'), new Error('timeout'), new Error('timeout'));
  await assert.rejects(client(fetchImpl).call('crm.lead.list'), (err) => {
    assert.ok(err instanceof BitrixError);
    assert.equal(err.code, 'NETWORK');
    assert.doesNotMatch(err.message, /secret-token/); // token never leaks into errors/logs
    return true;
  });
  assert.equal(fetchImpl.requests.length, 3);
});

test('call does not retry client errors', async () => {
  const fetchImpl = fakeFetch(json(400, { error: 'ERROR_CORE', error_description: 'Invalid field' }));
  await assert.rejects(client(fetchImpl).call('crm.lead.add'), /crm.lead.add: Invalid field/);
  assert.equal(fetchImpl.requests.length, 1);
});

test('batch splits into chunks of 50 and collects per-command errors', async () => {
  const fetchImpl = fakeFetch(
    ({ cmd }) => json(200, {
      result: {
        result: Object.fromEntries(Object.keys(cmd).filter((k) => k !== 'c1').map((k) => [k, k])),
        result_error: { c1: { error: 'ERR', error_description: 'Bad email' } },
      },
    }),
    ({ cmd }) => json(200, { result: { result: Object.fromEntries(Object.keys(cmd).map((k) => [k, k])), result_error: [] } }),
    ({ cmd }) => json(200, { result: { result: Object.fromEntries(Object.keys(cmd).map((k) => [k, k])), result_error: [] } }),
  );
  const commands = Object.fromEntries(Array.from({ length: 120 }, (_, i) => [`c${i}`, { method: 'crm.lead.get', params: { id: i } }]));

  const { results, errors } = await client(fetchImpl).batch(commands);

  assert.equal(fetchImpl.requests.length, 3);
  assert.equal(Object.keys(fetchImpl.requests[0].body.cmd).length, 50);
  assert.equal(fetchImpl.requests[0].body.cmd.c5, 'crm.lead.get?id=5');
  assert.equal(Object.keys(results).length, 119);
  assert.deepEqual(errors, { c1: 'Bad email' });
});

test('batch marks every command of a failed chunk as failed', async () => {
  const fetchImpl = fakeFetch(json(401, { error: 'expired_token' }));
  const { results, errors } = await client(fetchImpl).batch({ a: { method: 'crm.lead.add' }, b: { method: 'crm.lead.add' } });
  assert.deepEqual(results, {});
  assert.deepEqual(Object.keys(errors), ['a', 'b']);
  assert.match(errors.a, /expired_token/);
});

test('requests are throttled by minIntervalMs', async () => {
  const fetchImpl = fakeFetch(json(200, { result: 1 }), json(200, { result: 2 }));
  const c = createBitrixClient({ webhookUrl: WEBHOOK, fetchImpl, minIntervalMs: 50, logger: silentLogger });
  const start = Date.now();
  await c.call('a');
  await c.call('b');
  assert.ok(Date.now() - start >= 45);
});
