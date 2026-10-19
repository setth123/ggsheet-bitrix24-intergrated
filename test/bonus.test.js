// Tests for the bonus features: two-way sync, real-time webhook, advanced data processing, admin API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDate, mapRow, fromBitrix, toSheetValue, diffFromBitrix } from '../src/mapper.js';
import { runSync, createSyncRunner, STATUS } from '../src/sync.js';
import { validateMapping } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import { createServer } from '../src/server.js';
import { mapping, silentLogger, HEADER, createFakeSheets, createFakeBitrix } from './fakes.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Advanced data processing ----------

test('normalizeDate accepts common formats and rejects impossible dates', () => {
  assert.equal(normalizeDate('9/3/2026'), '2026-03-09');
  assert.equal(normalizeDate('19-10-2026'), '2026-10-19');
  assert.equal(normalizeDate('2026-10-19'), '2026-10-19');
  assert.throws(() => normalizeDate('31/02/2026'), /không tồn tại/);
  assert.throws(() => normalizeDate('hôm qua'), /ngày không hợp lệ/);
});

test('mapRow supports multiple values, dates, pattern and maxLength rules', () => {
  const m = {
    fields: [
      { column: 'Tên', field: 'NAME' },
      { column: 'SĐT', field: 'PHONE', type: 'phone' },
      { column: 'Sản phẩm', field: 'UF_CRM_PRODUCTS', type: 'enum', multiple: true, values: { CRM: 11, ERP: 12 } },
      { column: 'Ngày sinh', field: 'BIRTHDATE', type: 'date' },
      { column: 'Mã KH', field: 'UF_CRM_CODE', pattern: '^KH\\d{4}$', patternMessage: 'Mã KH phải dạng KH0001' },
      { column: 'Ghi chú', field: 'COMMENTS', maxLength: 5 },
    ],
  };
  const ok = mapRow({ Tên: 'An', SĐT: '0912345678', 'Sản phẩm': 'CRM, erp', 'Ngày sinh': '01/02/1990', 'Mã KH': 'KH0001' }, m);
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.fields.UF_CRM_PRODUCTS, [11, 12]);
  assert.equal(ok.fields.BIRTHDATE, '1990-02-01');

  const bad = mapRow({ Tên: 'An', SĐT: '0912345678', 'Sản phẩm': 'CRM, HRM', 'Mã KH': 'X1', 'Ghi chú': 'quá dài' }, m);
  assert.equal(bad.errors.length, 3);
  assert.match(bad.errors.join('|'), /HRM.*cho phép: CRM, ERP/);
  assert.match(bad.errors.join('|'), /Mã KH phải dạng KH0001/);
  assert.match(bad.errors.join('|'), /dài quá 5 ký tự/);
});

test('fromBitrix / toSheetValue convert Bitrix values back to sheet text', () => {
  const status = mapping.fields.find((r) => r.field === 'STATUS_ID');
  const assigned = mapping.fields.find((r) => r.field === 'ASSIGNED_BY_ID');
  assert.equal(fromBitrix(status, 'IN_PROCESS'), 'IN_PROCESS');
  assert.equal(toSheetValue(status, 'IN_PROCESS'), 'Đang xử lý');
  assert.equal(fromBitrix(assigned, '1'), 1); // Bitrix returns "1", mapping holds 1
  assert.equal(toSheetValue(status, 'UC_CUSTOM'), undefined); // unknown enum value
  assert.equal(fromBitrix({ field: 'PHONE', type: 'phone' }, [{ VALUE: '0912345678' }]), '+84912345678');
  assert.equal(fromBitrix({ field: 'EMAIL', type: 'email' }, []), undefined);
  assert.equal(fromBitrix({ field: 'OPPORTUNITY', type: 'number' }, '1500.00'), 1500);
  const date = { field: 'BIRTHDATE', type: 'date' };
  assert.equal(toSheetValue(date, fromBitrix(date, '1990-02-01T00:00:00+07:00')), '01/02/1990');
  const multi = { field: 'UF_X', type: 'enum', multiple: true, values: { A: 1, B: 2 } };
  assert.equal(toSheetValue(multi, fromBitrix(multi, ['1', '2'])), 'A, B');
  assert.equal(toSheetValue(multi, fromBitrix(multi, ['1', '9'])), undefined);
  assert.equal(toSheetValue({ field: 'NAME' }, undefined), '');
});

test('diffFromBitrix reports changes and skips values it cannot represent', () => {
  const rules = mapping.fields.filter((r) => r.twoWay);
  const fields = { STATUS_ID: 'NEW', ASSIGNED_BY_ID: 1 };
  assert.deepEqual(diffFromBitrix(fields, { STATUS_ID: 'NEW', ASSIGNED_BY_ID: '1' }, rules).changes, []);

  const { changes, warnings } = diffFromBitrix(fields, { STATUS_ID: 'PROCESSED', ASSIGNED_BY_ID: '42' }, rules);
  assert.deepEqual(changes.map((c) => c.value), ['Đã xử lý']);
  assert.match(warnings[0], /"42".*chưa có trong mapping/);

  const required = [{ column: 'Tên', field: 'NAME', required: true }];
  assert.match(diffFromBitrix({ NAME: 'An' }, { NAME: '' }, required).warnings[0], /trường bắt buộc/);
});

// ---------- Two-way sync ----------

const row = (name, email, status = 'Mới') => [name, email, '', 'ABC', 'website', '1000000', status, 'Admin', ''];
const at = (iso) => () => new Date(iso);
const sync = (sheets, bitrix, m = mapping, now = at('2026-10-19T08:00:00Z')) =>
  runSync({ sheets, bitrix, mapping: m, logger: silentLogger, now });

/** Creates one synced row (lead #1000) and returns { sheets, bitrix, lead }. */
async function syncedRow() {
  const sheets = createFakeSheets([HEADER, row('An', 'an@x.com')]);
  const bitrix = createFakeBitrix();
  await sync(sheets, bitrix);
  return { sheets, bitrix, lead: bitrix.store.get('1000') };
}

/** Simulates a sales rep editing the lead in Bitrix24 after the last sync. */
function editInBitrix(lead, changes) {
  Object.assign(lead, changes, { DATE_MODIFY: '2026-10-19T08:30:00+00:00' });
}

test('two-way: change in Bitrix24 is pulled into the sheet', async () => {
  const { sheets, bitrix, lead } = await syncedRow();
  editInBitrix(lead, { STATUS_ID: 'IN_PROCESS' });

  const { stats } = await sync(sheets, bitrix, mapping, at('2026-10-19T09:00:00Z'));

  assert.equal(stats.pulled, 1);
  assert.equal(stats.updated, 0);
  assert.equal(sheets.row(2)['Trạng thái'], 'Đang xử lý');
  assert.equal(sheets.row(2)['Thời gian đồng bộ cuối'], '2026-10-19T09:00:00.000Z');
  assert.equal(bitrix.calls.filter((c) => c.method === 'crm.lead.update').length, 0);

  // Next run: nothing changed on either side.
  const again = await sync(sheets, bitrix, mapping, at('2026-10-19T09:15:00Z'));
  assert.equal(again.stats.skipped, 1);
});

test('two-way conflict, priority "bitrix": Bitrix value kept, other sheet edits still pushed', async () => {
  const { sheets, bitrix, lead } = await syncedRow();
  editInBitrix(lead, { STATUS_ID: 'PROCESSED' });
  sheets.grid[1][6] = 'Rác'; // status edited in the sheet too
  sheets.grid[1][3] = 'ABC Group'; // and the company

  const { stats } = await sync(sheets, bitrix, mapping, at('2026-10-19T09:00:00Z'));

  assert.equal(stats.conflicts, 1);
  assert.equal(stats.updated, 1);
  assert.equal(sheets.row(2)['Trạng thái'], 'Đã xử lý');
  assert.equal(lead.STATUS_ID, 'PROCESSED');
  assert.equal(lead.COMPANY_TITLE, 'ABC Group');
});

test('two-way conflict, priority "sheet": sheet value overwrites Bitrix', async () => {
  const { sheets, bitrix, lead } = await syncedRow();
  editInBitrix(lead, { STATUS_ID: 'PROCESSED' });
  sheets.grid[1][6] = 'Rác';
  const sheetFirst = { ...mapping, sync: { direction: 'two-way', conflictPriority: 'sheet' } };

  const { stats } = await sync(sheets, bitrix, sheetFirst, at('2026-10-19T09:00:00Z'));

  assert.equal(stats.conflicts, 1);
  assert.equal(sheets.row(2)['Trạng thái'], 'Rác');
  assert.equal(lead.STATUS_ID, 'JUNK');
});

test('two-way: Bitrix value missing from mapping is skipped with a warning', async () => {
  const { sheets, bitrix, lead } = await syncedRow();
  editInBitrix(lead, { ASSIGNED_BY_ID: '42' });
  const warnings = [];
  const logger = { ...silentLogger, warn: (m) => warnings.push(m) };

  const { stats } = await runSync({ sheets, bitrix, mapping, logger, now: at('2026-10-19T09:00:00Z') });

  assert.equal(stats.skipped, 1);
  assert.equal(sheets.row(2)['Người phụ trách'], 'Admin');
  assert.match(warnings.join('\n'), /"42"/);
});

test('two-way: unreadable lead on an unchanged row only logs a warning', async () => {
  const { sheets, bitrix } = await syncedRow();
  bitrix.store.clear();
  const { stats } = await sync(sheets, bitrix, mapping, at('2026-10-19T09:00:00Z'));
  assert.equal(stats.skipped, 1);
  assert.equal(stats.failed, 0);
  assert.equal(sheets.row(2)['Trạng thái đồng bộ'], STATUS.SYNCED);
});

test('one-way mode never reads unchanged leads nor pulls from Bitrix', async () => {
  const oneWay = { ...mapping, sync: { direction: 'one-way' } };
  const { sheets, bitrix, lead } = await syncedRow();
  editInBitrix(lead, { STATUS_ID: 'IN_PROCESS' });
  const before = bitrix.calls.length;

  const { stats } = await sync(sheets, bitrix, oneWay, at('2026-10-19T09:00:00Z'));

  assert.equal(stats.skipped, 1);
  assert.equal(bitrix.calls.length, before);
  assert.equal(sheets.row(2)['Trạng thái'], 'Mới');
});

// ---------- Runner: debounce for real-time webhooks ----------

test('schedule() debounces bursts and queues one run when busy', async () => {
  let runs = 0;
  let release = () => {};
  const sheets = createFakeSheets([HEADER]);
  const slowSheets = {
    ...sheets,
    readRows: () => { runs++; return new Promise((r) => { release = () => r(sheets.readRows()); }); },
  };
  const runner = createSyncRunner({ sheets: slowSheets, bitrix: createFakeBitrix(), mapping, logger: silentLogger });

  runner.schedule('webhook', 10);
  runner.schedule('webhook', 10);
  runner.schedule('webhook', 10);
  await sleep(30);
  assert.equal(runs, 1); // 3 events -> 1 run
  assert.equal(runner.isRunning(), true);

  runner.schedule('webhook', 5); // arrives during the run -> queued
  await sleep(20);
  assert.equal(runs, 1);
  release();
  await sleep(20);
  assert.equal(runs, 2); // queued run started right after
  release();
  await sleep(10);
  assert.equal(runner.lastRun().trigger, 'webhook');

  const newMapping = { ...mapping, sync: { direction: 'one-way' } };
  runner.setMapping(newMapping);
  assert.equal(runner.getMapping(), newMapping);
});

// ---------- Config + logger ----------

test('validateMapping checks bonus options', () => {
  const base = { fields: [{ column: 'A', field: 'B' }], statusColumns: mapping.statusColumns };
  assert.doesNotThrow(() => validateMapping({ ...base, sync: { direction: 'two-way', conflictPriority: 'sheet' } }));
  assert.throws(() => validateMapping({ ...base, sync: { direction: 'both' } }), /sync.direction/);
  assert.throws(() => validateMapping({ ...base, sync: { conflictPriority: 'newest' } }), /conflictPriority/);
  assert.throws(() => validateMapping({ ...base, fields: [{ column: 'A', field: 'EMAIL', type: 'email', multiple: true }] }), /multiple/);
  assert.throws(() => validateMapping({ ...base, fields: [{ column: 'A', field: 'B', pattern: '([' }] }), /regex/);
});

test('logger keeps recent lines in memory', () => {
  const logger = createLogger({ silent: true, keep: 2 });
  logger.info('a');
  logger.warn('b');
  logger.error('c');
  const lines = logger.recent();
  assert.equal(lines.length, 2);
  assert.match(lines[0], /WARN  b/);
  assert.match(lines[1], /ERROR c/);
});

// ---------- HTTP: admin API + Bitrix webhook ----------

async function startServer(overrides = {}) {
  let currentMapping = structuredClone(mapping);
  const scheduled = [];
  const runner = {
    isRunning: () => false,
    lastRun: () => null,
    run: async () => ({ ok: true }),
    getMapping: () => currentMapping,
    setMapping: (m) => { currentMapping = m; },
    schedule: (trigger, delay) => scheduled.push([trigger, delay]),
  };
  const logger = createLogger({ silent: true });
  const server = createServer({
    runner,
    logger,
    adminToken: 'secret',
    webhookToken: 'hook-token',
    webhookDelayMs: 50,
    sheets: { readHeader: async () => ['Email', 'Tên'] },
    bitrix: {
      call: async () => ({
        NAME: { title: 'NAME', listLabel: 'Tên', type: 'string' },
        UF_CRM_1: { title: 'UF_CRM_1', formLabel: 'Sản phẩm', type: 'enumeration', isMultiple: true },
        ID: { title: 'ID', type: 'integer', isReadOnly: true },
      }),
    },
    saveMapping: (m) => { validateMapping(m); runner.setMapping(m); },
    ...overrides,
  }).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, path, body, headers = { Authorization: 'Bearer secret' }) =>
    fetch(base + path, { method, headers, body });
  return { server, call, scheduled, logger, runner };
}

test('admin panel page is served without auth', async () => {
  const { server, call } = await startServer();
  try {
    const res = await call('GET', '/', undefined, {});
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.match(await res.text(), /Google Sheets ↔ Bitrix24/);
  } finally { server.close(); }
});

test('admin API: logs, mapping read/save with validation, sheet columns, Bitrix fields', async () => {
  const { server, call, logger, runner } = await startServer();
  try {
    logger.info('hello admin');
    assert.equal((await call('GET', '/api/logs', undefined, {})).status, 401);
    assert.match((await (await call('GET', '/api/logs?limit=5')).json()).lines.at(-1), /hello admin/);

    const current = await (await call('GET', '/api/mapping')).json();
    assert.equal(current.fields.length, mapping.fields.length);

    const changed = { ...current, sync: { direction: 'one-way', conflictPriority: 'bitrix' } };
    const saved = await call('PUT', '/api/mapping', JSON.stringify(changed));
    assert.equal(saved.status, 200);
    assert.equal(runner.getMapping().sync.direction, 'one-way');

    const invalid = await call('PUT', '/api/mapping', JSON.stringify({ ...current, fields: [{ column: 'A' }] }));
    assert.equal(invalid.status, 400);
    assert.match((await invalid.json()).error, /"column" và "field"/);
    assert.equal((await call('PUT', '/api/mapping', '{oops')).status, 400);
    assert.equal((await call('PUT', '/api/mapping', 'x'.repeat(1024 * 1024 + 1))).status, 413);

    assert.deepEqual((await (await call('GET', '/api/sheet-columns')).json()).columns, ['Email', 'Tên']);
    const { fields } = await (await call('GET', '/api/bitrix-fields')).json();
    assert.deepEqual(fields, [
      { id: 'NAME', title: 'Tên', type: 'string', multiple: false },
      { id: 'UF_CRM_1', title: 'Sản phẩm', type: 'enumeration', multiple: true },
    ]);
  } finally { server.close(); }
});

test('admin API reports upstream errors as JSON', async () => {
  const { server, call } = await startServer({ sheets: { readHeader: async () => { throw new Error('permission denied'); } } });
  try {
    const res = await call('GET', '/api/sheet-columns');
    assert.equal(res.status, 500);
    assert.match((await res.json()).error, /permission denied/);
  } finally { server.close(); }
});

test('Bitrix24 webhook: token checked, ONCRMLEADUPDATE schedules a debounced sync', async () => {
  const { server, call, scheduled, runner } = await startServer();
  const form = (token, event = 'ONCRMLEADUPDATE') =>
    new URLSearchParams({ event, 'data[FIELDS][ID]': '1000', 'auth[application_token]': token }).toString();
  const formHeaders = { 'Content-Type': 'application/x-www-form-urlencoded' };
  try {
    assert.equal((await call('POST', '/webhooks/bitrix', form('wrong'), formHeaders)).status, 401);
    assert.equal((await call('POST', '/webhooks/bitrix', form('hook-token'), formHeaders)).status, 200);
    assert.deepEqual(scheduled, [['webhook', 50]]);

    await call('POST', '/webhooks/bitrix', form('hook-token', 'ONCRMLEADADD'), formHeaders);
    runner.setMapping({ ...mapping, sync: { direction: 'one-way' } });
    await call('POST', '/webhooks/bitrix', form('hook-token'), formHeaders);
    assert.equal(scheduled.length, 1); // other events / one-way mode don't trigger a sync
  } finally { server.close(); }

  const noToken = await startServer({ webhookToken: '' });
  try {
    assert.equal((await noToken.call('POST', '/webhooks/bitrix', 'x', {})).status, 403);
  } finally { noToken.server.close(); }
});
