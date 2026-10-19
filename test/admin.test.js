// Admin panel API + Bitrix24 outbound webhook endpoint.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.js';
import { validateMapping } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import { mapping } from './fakes.js';

let server;
let base;
let current;
const scheduled = [];
const logger = createLogger({ silent: true });
const auth = { Authorization: 'Bearer secret' };

before(async () => {
  current = structuredClone(mapping);
  const runner = {
    isRunning: () => false,
    lastRun: () => null,
    run: async () => ({ ok: false, error: 'Sheet trống' }),
    getMapping: () => current,
    schedule: (trigger) => scheduled.push(trigger),
  };
  server = createServer({
    runner,
    logger,
    adminToken: 'secret',
    webhookToken: 'hook-token',
    webhookDelayMs: 0,
    sheets: { readHeader: async () => ['Tên khách hàng', 'Email'] },
    bitrix: {
      call: async () => ({
        NAME: { type: 'string', title: 'NAME', formLabel: 'Tên' },
        ID: { type: 'integer', isReadOnly: true },
        UF_CRM_1: { type: 'enumeration', listLabel: 'Sở thích', isMultiple: true },
      }),
    },
    saveMapping: (m) => { validateMapping(m); current = m; },
  }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

const call = (method, path, { body, headers = auth } = {}) => fetch(`${base}${path}`, {
  method, headers: { 'Content-Type': 'application/json', ...headers }, body,
});

test('admin page is served without auth, API requires the token', async () => {
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Google Sheets ↔ Bitrix24/);
  assert.equal((await call('GET', '/api/mapping', { headers: {} })).status, 401);
});

test('failed manual sync returns 500 with the reason', async () => {
  const res = await call('POST', '/sync');
  assert.equal(res.status, 500);
  assert.equal((await res.json()).error, 'Sheet trống');
});

test('GET /api/logs returns recent log lines', async () => {
  logger.info('xin chào');
  const { lines } = await (await call('GET', '/api/logs?limit=5')).json();
  assert.match(lines.at(-1), /INFO {2}xin chào/);
});

test('mapping can be read and saved; invalid mapping gives a readable 400', async () => {
  assert.deepEqual(await (await call('GET', '/api/mapping')).json(), mapping);

  const updated = { ...mapping, sync: { direction: 'one-way', conflictPriority: 'sheet' } };
  const ok = await call('PUT', '/api/mapping', { body: JSON.stringify(updated) });
  assert.equal(ok.status, 200);
  assert.equal(current.sync.direction, 'one-way');

  const invalid = await call('PUT', '/api/mapping', { body: JSON.stringify({ ...mapping, fields: [{ column: 'A' }] }) });
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json()).error, /cần có "column" và "field"/);

  const notJson = await call('PUT', '/api/mapping', { body: '{oops' });
  assert.equal(notJson.status, 400);

  const tooBig = await call('PUT', '/api/mapping', { body: 'x'.repeat(1024 * 1024 + 1) });
  assert.equal(tooBig.status, 413);
  current = structuredClone(mapping);
});

test('sheet columns and Bitrix fields feed the mapping editor', async () => {
  assert.deepEqual(await (await call('GET', '/api/sheet-columns')).json(), { columns: ['Tên khách hàng', 'Email'] });
  const { fields } = await (await call('GET', '/api/bitrix-fields')).json();
  assert.deepEqual(fields, [
    { id: 'NAME', title: 'Tên', type: 'string', multiple: false },
    { id: 'UF_CRM_1', title: 'Sở thích', type: 'enumeration', multiple: true },
  ]);
});

test('Bitrix24 webhook: checks application_token and schedules a two-way sync', async () => {
  const hook = (body) => fetch(`${base}/webhooks/bitrix`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
  });
  const event = (token) => new URLSearchParams({
    event: 'ONCRMLEADUPDATE', 'data[FIELDS][ID]': '1000', 'auth[application_token]': token,
  }).toString();

  assert.equal((await hook(event('wrong'))).status, 401);
  assert.equal(scheduled.length, 0);

  assert.equal((await hook(event('hook-token'))).status, 200);
  assert.deepEqual(scheduled, ['webhook']);

  current = { ...mapping, sync: { direction: 'one-way' } };
  assert.equal((await hook(event('hook-token'))).status, 200);
  assert.equal(scheduled.length, 1); // ignored in one-way mode
  current = structuredClone(mapping);
});

test('webhook is disabled when BITRIX_OUTBOUND_TOKEN is not configured', async () => {
  const s = createServer({ runner: {}, logger }).listen(0);
  await new Promise((r) => s.once('listening', r));
  try {
    const res = await fetch(`http://127.0.0.1:${s.address().port}/webhooks/bitrix`, { method: 'POST', body: '' });
    assert.equal(res.status, 403);
  } finally {
    s.close();
  }
});

test('unexpected handler errors become a JSON 500', async () => {
  const s = createServer({ runner: {}, logger, sheets: { readHeader: async () => { throw new Error('Sheets down'); } } }).listen(0);
  await new Promise((r) => s.once('listening', r));
  try {
    const res = await fetch(`http://127.0.0.1:${s.address().port}/api/sheet-columns`);
    assert.equal(res.status, 500);
    assert.equal((await res.json()).error, 'Sheets down');
  } finally {
    s.close();
  }
});
