// Bonus features: advanced data processing, two-way sync + conflict resolution, debounced (webhook) runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDate, mapRow, fromBitrix, toSheetValue, diffFromBitrix, toBitrixFields } from '../src/mapper.js';
import { runSync, createSyncRunner, STATUS } from '../src/sync.js';
import { mapping, silentLogger, HEADER, createFakeSheets, createFakeBitrix } from './fakes.js';

const STATUS_RULE = mapping.fields.find((r) => r.field === 'STATUS_ID');
const row = (name, email, status = 'Mới') => [name, email, '', 'ABC', 'website', '1000000', status, 'Admin', ''];
const at = (iso) => () => new Date(iso);
const run = (sheets, bitrix, opts = {}) => runSync({
  sheets, bitrix, logger: silentLogger,
  mapping: { ...mapping, sync: { ...mapping.sync, ...opts.sync } },
  now: opts.now || at('2026-10-19T08:00:00Z'),
});

/** Creates one synced row (lead #1000), then simulates a sales rep editing it in Bitrix24 at 08:30. */
async function syncedThenEditedInBitrix(changes, sync) {
  const sheets = createFakeSheets([HEADER, row('An', 'an@x.com')]);
  const bitrix = createFakeBitrix();
  await run(sheets, bitrix, { sync });
  Object.assign(bitrix.store.get('1000'), changes, { DATE_MODIFY: '2026-10-19T15:30:00+07:00' });
  return { sheets, bitrix };
}

// ---------- Advanced data processing ----------

test('normalizeDate accepts common formats and rejects impossible dates', () => {
  assert.equal(normalizeDate('9/1/2026'), '2026-01-09');
  assert.equal(normalizeDate('19-10-2026'), '2026-10-19');
  assert.equal(normalizeDate('2026-10-19'), '2026-10-19');
  assert.throws(() => normalizeDate('31/02/2026'), /không tồn tại/);
  assert.throws(() => normalizeDate('hôm qua'), /dd\/mm\/yyyy/);
});

test('mapRow supports multi-value fields, dates, maxLength and pattern rules', () => {
  const m = {
    fields: [
      { column: 'Tên', field: 'NAME' },
      { column: 'Email', field: 'EMAIL', type: 'email' },
      { column: 'Sở thích', field: 'UF_CRM_TAGS', type: 'enum', multiple: true, values: { Web: 1, App: 2 } },
      { column: 'Ngày hẹn', field: 'UF_CRM_DATE', type: 'date' },
      { column: 'Mã số thuế', field: 'UF_CRM_TAX', pattern: '^\\d{10}$', patternMessage: 'MST phải gồm 10 chữ số' },
      { column: 'Ghi chú', field: 'COMMENTS', maxLength: 5 },
    ],
  };
  const ok = mapRow({ Tên: 'An', Email: 'a@b.c', 'Sở thích': 'web, App', 'Ngày hẹn': '19/10/2026', 'Mã số thuế': '0101234567' }, m);
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.fields.UF_CRM_TAGS, [1, 2]);
  assert.equal(ok.fields.UF_CRM_DATE, '2026-10-19');
  assert.deepEqual(toBitrixFields({ UF_CRM_TAGS: [1, 2] }), { UF_CRM_TAGS: [1, 2] });

  const bad = mapRow({ Tên: 'An', Email: 'a@b.c', 'Mã số thuế': '123', 'Ghi chú': 'quá dài' }, m);
  assert.deepEqual(bad.errors, ['Mã số thuế: MST phải gồm 10 chữ số', 'Ghi chú: dài quá 5 ký tự']);
});

test('fromBitrix / toSheetValue convert Bitrix values back to sheet text', () => {
  const assigned = { field: 'ASSIGNED_BY_ID', type: 'enum', values: { Admin: 1, Lan: 7 } };
  assert.equal(fromBitrix(assigned, '7'), 7); // keeps the configured type
  assert.equal(toSheetValue(assigned, 7), 'Lan');
  assert.equal(toSheetValue(assigned, '99'), undefined); // unknown user -> can't be shown
  assert.equal(fromBitrix({ field: 'PHONE', type: 'phone' }, [{ VALUE: '0912345678' }]), '+84912345678');
  assert.equal(fromBitrix({ field: 'EMAIL', type: 'email' }, [{ VALUE: 'A@B.C' }]), 'a@b.c');
  assert.equal(fromBitrix({ field: 'OPPORTUNITY', type: 'number' }, '50000.00'), 50000);
  assert.equal(fromBitrix({ field: 'X', type: 'date' }, '2026-10-19T00:00:00+07:00'), '2026-10-19');
  assert.equal(toSheetValue({ type: 'date' }, '2026-10-19'), '19/10/2026');
  assert.equal(fromBitrix({ field: 'COMMENTS' }, ''), undefined);
  assert.equal(toSheetValue({}, undefined), '');
  const tags = { field: 'UF', type: 'enum', multiple: true, values: { Web: 1, App: 2 } };
  assert.deepEqual(fromBitrix(tags, ['1', '2']), [1, 2]);
  assert.equal(toSheetValue(tags, [1, 2]), 'Web, App');
  assert.equal(toSheetValue(tags, [1, 3]), undefined);
});

test('diffFromBitrix reports changed fields and skips values it cannot represent', () => {
  const rules = [
    STATUS_RULE,
    { column: 'Tên', field: 'NAME', required: true },
    { column: 'Ghi chú', field: 'COMMENTS' },
  ];
  const { changes, warnings } = diffFromBitrix(
    { STATUS_ID: 'NEW', NAME: 'An', COMMENTS: 'x' },
    { STATUS_ID: 'UC_CUSTOM', NAME: '', COMMENTS: '' },
    rules,
  );
  assert.deepEqual(changes.map((c) => [c.rule.column, c.value]), [['Ghi chú', '']]);
  assert.equal(warnings.length, 2);
  assert.match(warnings.join('|'), /UC_CUSTOM.*chưa có trong mapping/);
  assert.match(warnings.join('|'), /trường bắt buộc/);
});

// ---------- Two-way sync ----------

test('two-way: status changed in Bitrix24 is pulled into the sheet', async () => {
  const { sheets, bitrix } = await syncedThenEditedInBitrix({ STATUS_ID: 'IN_PROCESS' });

  const { stats } = await run(sheets, bitrix, { now: at('2026-10-19T09:00:00Z') });

  assert.equal(stats.pulled, 1);
  assert.equal(stats.updated, 0);
  const r = sheets.row(2);
  assert.equal(r['Trạng thái'], 'Đang xử lý');
  assert.equal(r['Trạng thái đồng bộ'], STATUS.SYNCED);
  assert.equal(r['Thời gian đồng bộ cuối'], '2026-10-19T09:00:00.000Z');
  assert.equal(bitrix.calls.filter((c) => c.method === 'crm.lead.update').length, 0); // nothing pushed back

  // Stable afterwards: nothing changed on either side.
  const again = await run(sheets, bitrix, { now: at('2026-10-19T10:00:00Z') });
  assert.equal(again.stats.skipped, 1);
});

test('two-way conflict, priority "bitrix": Bitrix value wins, other sheet edits are still pushed', async () => {
  const { sheets, bitrix } = await syncedThenEditedInBitrix({ STATUS_ID: 'PROCESSED' });
  sheets.grid[1][6] = 'Rác'; // sheet changed the same field...
  sheets.grid[1][3] = 'Công ty Mới'; // ...and another one

  const { stats } = await run(sheets, bitrix, { now: at('2026-10-19T09:00:00Z') });

  assert.equal(stats.conflicts, 1);
  assert.equal(stats.updated, 1);
  assert.equal(sheets.row(2)['Trạng thái'], 'Đã xử lý');
  const lead = bitrix.store.get('1000');
  assert.equal(lead.STATUS_ID, 'PROCESSED');
  assert.equal(lead.COMPANY_TITLE, 'Công ty Mới');
});

test('two-way conflict, priority "sheet": sheet value overwrites Bitrix24', async () => {
  const sync = { conflictPriority: 'sheet' };
  const { sheets, bitrix } = await syncedThenEditedInBitrix({ STATUS_ID: 'PROCESSED' }, sync);
  sheets.grid[1][6] = 'Rác';

  const { stats } = await run(sheets, bitrix, { sync, now: at('2026-10-19T09:00:00Z') });

  assert.equal(stats.conflicts, 1);
  assert.equal(sheets.row(2)['Trạng thái'], 'Rác');
  assert.equal(bitrix.store.get('1000').STATUS_ID, 'JUNK');
});

test('two-way: unknown Bitrix value is skipped with a warning, row stays unchanged', async () => {
  const { sheets, bitrix } = await syncedThenEditedInBitrix({ ASSIGNED_BY_ID: '42' });
  const { stats } = await run(sheets, bitrix, { now: at('2026-10-19T09:00:00Z') });
  assert.equal(stats.skipped, 1);
  assert.equal(sheets.row(2)['Người phụ trách'], 'Admin');
});

test('two-way: deleted lead on an unchanged row is only a warning', async () => {
  const { sheets, bitrix } = await syncedThenEditedInBitrix({});
  bitrix.store.delete('1000');
  const { stats } = await run(sheets, bitrix);
  assert.equal(stats.skipped, 1);
  assert.equal(stats.failed, 0);
});

test('one-way mode never reads or pulls unchanged leads', async () => {
  const sync = { direction: 'one-way' };
  const { sheets, bitrix } = await syncedThenEditedInBitrix({ STATUS_ID: 'IN_PROCESS' }, sync);
  const before = bitrix.calls.length;

  const { stats } = await run(sheets, bitrix, { sync, now: at('2026-10-19T09:00:00Z') });

  assert.equal(stats.skipped, 1);
  assert.equal(bitrix.calls.length, before);
  assert.equal(sheets.row(2)['Trạng thái'], 'Mới');
});

// ---------- Debounced runs (webhook) ----------

test('runner.schedule debounces bursts and queues one more run if a sync is in progress', async () => {
  const sheets = createFakeSheets([HEADER]);
  const runner = createSyncRunner({ sheets, bitrix: createFakeBitrix(), mapping, logger: silentLogger });
  let reads = 0;
  const readRows = sheets.readRows.bind(sheets);
  sheets.readRows = async () => { reads++; await new Promise((r) => setTimeout(r, 30)); return readRows(); };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  runner.schedule('webhook', 10);
  runner.schedule('webhook', 10);
  runner.schedule('webhook', 10);
  await wait(25);
  assert.equal(reads, 1); // 3 events -> 1 run
  assert.equal(runner.isRunning(), true);

  runner.schedule('webhook', 0); // arrives while running -> queued
  await wait(100);
  assert.equal(reads, 2);
  assert.equal(runner.lastRun().trigger, 'webhook');

  runner.setMapping({ ...mapping, sync: { direction: 'one-way' } });
  assert.equal(runner.getMapping().sync.direction, 'one-way');
});
