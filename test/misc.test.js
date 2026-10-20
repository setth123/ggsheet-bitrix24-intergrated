import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, validateMapping } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import { withRetry } from '../src/retry.js';
import { createServer } from '../src/server.js';
import { mapping } from './fakes.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-test-'));

test('loadConfig reads env vars and mapping file', () => {
  const config = loadConfig({
    GOOGLE_SHEET_ID: 'abc', BITRIX_WEBHOOK_URL: 'https://x/rest/1/t/', MAPPING_FILE: 'config/mapping.json', SYNC_CRON: '0 * * * *',
  });
  assert.equal(config.google.spreadsheetId, 'abc');
  assert.equal(config.google.sheetName, 'Leads');
  assert.equal(config.schedule, '0 * * * *');
  assert.equal(config.retry.retries, 3);
  assert.equal(config.syncOnStart, true);
  assert.equal(config.mapping.fields.length, mapping.fields.length);
});

test('SYNC_ON_START=false disables the startup sync', () => {
  const config = loadConfig({ GOOGLE_SHEET_ID: 'a', BITRIX_WEBHOOK_URL: 'x', SYNC_ON_START: 'false' });
  assert.equal(config.syncOnStart, false);
});

test('loadConfig reports missing env vars and bad mapping files', () => {
  assert.throws(() => loadConfig({ BITRIX_WEBHOOK_URL: 'x' }), /GOOGLE_SHEET_ID/);
  assert.throws(
    () => loadConfig({ GOOGLE_SHEET_ID: 'a', BITRIX_WEBHOOK_URL: 'x', MAPPING_FILE: path.join(tmp, 'nope.json') }),
    /Không đọc được file mapping/,
  );
});

test('validateMapping rejects invalid rules', () => {
  const statusColumns = mapping.statusColumns;
  assert.throws(() => validateMapping({}), /"fields"/);
  assert.throws(() => validateMapping({ fields: [{ column: 'A' }], statusColumns }), /"column" và "field"/);
  assert.throws(() => validateMapping({ fields: [{ column: 'A', field: 'B', type: 'x' }], statusColumns }), /type "x"/);
  assert.throws(() => validateMapping({ fields: [{ column: 'A', field: 'B', type: 'enum' }], statusColumns }), /cần có "values"/);
  assert.throws(() => validateMapping({ fields: [{ column: 'A', field: 'B' }], statusColumns: {} }), /statusColumns.status/);
  const one = (rule, extra = {}) => validateMapping({ fields: [{ column: 'A', field: 'B', ...rule }], statusColumns, ...extra });
  assert.throws(() => one({ type: 'email', multiple: true }), /"multiple" không dùng được/);
  assert.throws(() => one({ pattern: '(' }), /regex hợp lệ/);
  assert.throws(() => one({}, { sync: { direction: 'both' } }), /sync.direction/);
  assert.throws(() => one({}, { sync: { conflictPriority: 'newest' } }), /sync.conflictPriority/);
  assert.ok(one({ type: 'date', twoWay: true }, { sync: { direction: 'two-way', conflictPriority: 'sheet' } }));
});

test('logger writes formatted lines to file', () => {
  const file = path.join(tmp, 'logs', 'sync.log');
  const logger = createLogger({ file, silent: true });
  logger.info('hello', { created: 1 });
  logger.error('boom');
  const content = fs.readFileSync(file, 'utf8');
  assert.match(content, /INFO {2}hello {"created":1}/);
  assert.match(content, /ERROR boom/);
});

test('withRetry retries only retryable errors', async () => {
  let attempts = 0;
  const warnings = [];
  const result = await withRetry(async () => {
    attempts++;
    if (attempts < 3) throw Object.assign(new Error('busy'), { retryable: true });
    return 'ok';
  }, { retries: 3, baseDelayMs: 0, logger: { warn: (m) => warnings.push(m) } });
  assert.equal(result, 'ok');
  assert.equal(warnings.length, 2);

  attempts = 0;
  await assert.rejects(withRetry(async () => { attempts++; throw new Error('fatal'); }, { baseDelayMs: 0 }), /fatal/);
  assert.equal(attempts, 1);
});

test('HTTP server: health, auth, status and manual sync', async () => {
  let running = false;
  const runner = {
    isRunning: () => running,
    lastRun: () => ({ ok: true }),
    run: async () => (running ? null : { ok: true, stats: { created: 1 } }),
  };
  const server = createServer({ runner, adminToken: 'secret' }).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const auth = { Authorization: 'Bearer secret' };

  try {
    assert.equal((await fetch(`${base}/health`)).status, 200);
    assert.equal((await fetch(`${base}/sync`, { method: 'POST' })).status, 401);
    assert.deepEqual(await (await fetch(`${base}/status`, { headers: auth })).json(), { running: false, lastRun: { ok: true } });
    const sync = await fetch(`${base}/sync`, { method: 'POST', headers: auth });
    assert.equal(sync.status, 200);
    assert.equal((await sync.json()).stats.created, 1);
    running = true;
    assert.equal((await fetch(`${base}/sync`, { method: 'POST', headers: auth })).status, 409);
    assert.equal((await fetch(`${base}/nope`, { headers: auth })).status, 404);
  } finally {
    server.close();
  }
});
