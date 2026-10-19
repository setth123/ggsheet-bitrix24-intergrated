import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSync, createSyncRunner, STATUS } from '../src/sync.js';
import { mapping, silentLogger, HEADER, createFakeSheets, createFakeBitrix } from './fakes.js';

const row = (name, email, phone, extra = {}) => [
  name, email, phone, extra.company ?? 'ABC', 'website', extra.budget ?? '1000000', extra.status ?? 'Mới', 'Admin', extra.note ?? '',
];

const run = (sheets, bitrix, now = () => new Date('2026-10-19T08:00:00Z')) =>
  runSync({ sheets, bitrix, mapping, logger: silentLogger, now });

test('TC1: new row creates a lead and writes Lead ID + status back', async () => {
  const sheets = createFakeSheets([HEADER, row('An', 'an@x.com', '0912345678')]);
  const bitrix = createFakeBitrix();

  const { stats } = await run(sheets, bitrix);

  assert.equal(stats.created, 1);
  const r = sheets.row(2);
  assert.equal(r['Trạng thái đồng bộ'], STATUS.SYNCED);
  assert.equal(r['Lead ID Bitrix24'], '1000');
  assert.equal(r['Thời gian đồng bộ cuối'], '2026-10-19T08:00:00.000Z');
  assert.equal(r['Thông báo lỗi'], '');
  assert.ok(r['Sync Hash']);
  const lead = bitrix.store.get('1000');
  assert.equal(lead.NAME, 'An');
  assert.equal(lead.EMAIL[0].VALUE, 'an@x.com');
  assert.equal(lead.PHONE[0].VALUE, '+84912345678');
});

test('re-running without changes is idempotent (rows skipped, nothing sent)', async () => {
  const sheets = createFakeSheets([HEADER, row('An', 'an@x.com', '0912345678')]);
  const bitrix = createFakeBitrix();
  await run(sheets, bitrix);
  const callsAfterFirst = bitrix.calls.length;

  const { stats } = await run(sheets, bitrix);

  assert.deepEqual(stats, { total: 1, created: 0, updated: 0, duplicates: 0, pulled: 0, conflicts: 0, skipped: 1, failed: 0 });
  const writes = bitrix.calls.slice(callsAfterFirst).filter((c) => c.method !== 'crm.lead.get');
  assert.deepEqual(writes, []); // two-way mode only reads leads to check for Bitrix-side changes
  assert.equal(bitrix.store.size, 1);
});

test('TC2: editing a synced row updates the lead and the sync time', async () => {
  const sheets = createFakeSheets([HEADER, row('An', 'an@x.com', '0912345678')]);
  const bitrix = createFakeBitrix();
  await run(sheets, bitrix);

  sheets.grid[1][3] = 'Công ty Mới';
  sheets.grid[1][2] = '0987654321';
  const { stats } = await run(sheets, bitrix, () => new Date('2026-10-19T09:00:00Z'));

  assert.equal(stats.updated, 1);
  const lead = bitrix.store.get('1000');
  assert.equal(lead.COMPANY_TITLE, 'Công ty Mới');
  assert.deepEqual(lead.PHONE.map((p) => p.VALUE), ['+84987654321']); // replaced, not appended
  assert.equal(sheets.row(2)['Thời gian đồng bộ cuối'], '2026-10-19T09:00:00.000Z');
});

test('TC3: email already in Bitrix -> existing lead is updated instead of created', async () => {
  const sheets = createFakeSheets([HEADER, row('An Nguyễn', 'an@x.com', '')]);
  const bitrix = createFakeBitrix({
    leads: [{ ID: '55', NAME: 'An', EMAIL: [{ ID: '1', VALUE: 'an@x.com', VALUE_TYPE: 'WORK' }] }],
  });

  const { stats } = await run(sheets, bitrix);

  assert.equal(stats.created, 0);
  assert.equal(stats.updated, 1);
  assert.equal(stats.duplicates, 1);
  assert.equal(bitrix.store.size, 1);
  assert.equal(bitrix.store.get('55').NAME, 'An Nguyễn');
  assert.equal(bitrix.store.get('55').EMAIL.length, 1);
  assert.equal(sheets.row(2)['Lead ID Bitrix24'], '55');
});

test('duplicate detection also works by phone', async () => {
  const sheets = createFakeSheets([HEADER, row('Bình', '', '0987 654 321')]);
  const bitrix = createFakeBitrix({ leads: [{ ID: '77', PHONE: [{ ID: '1', VALUE: '+84987654321' }] }] });
  const { stats } = await run(sheets, bitrix);
  assert.equal(stats.duplicates, 1);
  assert.equal(sheets.row(2)['Lead ID Bitrix24'], '77');
});

test('invalid rows are marked as errors and do not block valid rows', async () => {
  const sheets = createFakeSheets([
    HEADER,
    row('', 'bad-email', ''),
    row('An', 'an@x.com', ''),
    ['', '', '', '', '', '', '', '', ''], // empty row is ignored
  ]);
  const bitrix = createFakeBitrix();

  const { stats, errors } = await run(sheets, bitrix);

  assert.equal(stats.total, 2);
  assert.equal(stats.failed, 1);
  assert.equal(stats.created, 1);
  assert.equal(errors[0].row, 2);
  assert.equal(sheets.row(2)['Trạng thái đồng bộ'], STATUS.ERROR);
  assert.match(sheets.row(2)['Thông báo lỗi'], /Thiếu "Tên khách hàng".*email không hợp lệ/);
});

test('duplicate rows inside the sheet: only the first creates a lead', async () => {
  const sheets = createFakeSheets([HEADER, row('An', 'an@x.com', ''), row('An 2', 'an@x.com', '')]);
  const bitrix = createFakeBitrix();

  const { stats } = await run(sheets, bitrix);

  assert.equal(stats.created, 1);
  assert.equal(stats.skipped, 1);
  assert.equal(sheets.row(3)['Trạng thái đồng bộ'], STATUS.PENDING);
  assert.match(sheets.row(3)['Thông báo lỗi'], /hàng 2/);

  // Next run: the second row is detected as duplicate of the lead created by row 2.
  const second = await run(sheets, bitrix);
  assert.equal(second.stats.duplicates, 1);
  assert.equal(bitrix.store.size, 1);
});

test('TC4: a Bitrix error on one record is logged and the others continue', async () => {
  const sheets = createFakeSheets([HEADER, row('An', 'an@x.com', ''), row('Bình', 'binh@x.com', '')]);
  const bitrix = createFakeBitrix({
    fail: (method, params) => (method === 'crm.lead.add' && params.fields.NAME === 'An' ? 'QUERY_LIMIT_EXCEEDED' : null),
  });

  const { stats, errors } = await run(sheets, bitrix);

  assert.equal(stats.created, 1);
  assert.equal(stats.failed, 1);
  assert.match(errors[0].message, /Tạo lead thất bại: QUERY_LIMIT_EXCEEDED/);
  assert.equal(sheets.row(2)['Trạng thái đồng bộ'], STATUS.ERROR);
  assert.equal(sheets.row(3)['Trạng thái đồng bộ'], STATUS.SYNCED);

  // The failed row is retried on the next run.
  const retry = await run(sheets, createFakeBitrix());
  assert.equal(retry.stats.created, 1);
});

test('lead deleted in Bitrix -> row marked as error', async () => {
  const sheets = createFakeSheets([HEADER, row('An', 'an@x.com', '')]);
  sheets.grid[0].push('Lead ID Bitrix24');
  sheets.grid[1].push('999');
  const { stats } = await run(sheets, createFakeBitrix());
  assert.equal(stats.failed, 1);
  assert.match(sheets.row(2)['Thông báo lỗi'], /Không đọc được lead #999/);
});

test('failed duplicate lookup prevents creating the lead', async () => {
  const sheets = createFakeSheets([HEADER, row('An', 'an@x.com', '')]);
  const bitrix = createFakeBitrix({ fail: (method) => (method === 'crm.lead.list' ? 'timeout' : null) });
  const { stats } = await run(sheets, bitrix);
  assert.equal(stats.failed, 1);
  assert.equal(bitrix.store.size, 0);
});

test('failed update is reported on the row', async () => {
  const sheets = createFakeSheets([HEADER, row('An', 'an@x.com', '')]);
  const bitrix = createFakeBitrix({
    leads: [{ ID: '5', EMAIL: [{ ID: '1', VALUE: 'an@x.com' }] }],
    fail: (method) => (method === 'crm.lead.update' ? 'Access denied' : null),
  });
  const { stats } = await run(sheets, bitrix);
  assert.equal(stats.failed, 1);
  assert.match(sheets.row(2)['Thông báo lỗi'], /Cập nhật lead #5 thất bại: Access denied/);
});

test('missing required column or empty sheet fails the whole run', async () => {
  await assert.rejects(run(createFakeSheets([['Email']]), createFakeBitrix()), /cột bắt buộc "Tên khách hàng"/);
  await assert.rejects(run(createFakeSheets([]), createFakeBitrix()), /Sheet trống/);
});

test('performance: 150 rows are processed with 3 batch calls and 1 sheet write', async () => {
  const rows = Array.from({ length: 150 }, (_, i) => row(`KH ${i}`, `kh${i}@x.com`, `09${10000000 + i}`));
  const sheets = createFakeSheets([HEADER, ...rows]);
  const bitrix = createFakeBitrix();

  const { stats } = await run(sheets, bitrix);

  assert.equal(stats.created, 150);
  assert.equal(bitrix.batchCount, 3); // duplicate lookup, load leads, add/update
  assert.equal(sheets.writeCalls, 1);
});

test('runner prevents overlapping runs and records failures', async () => {
  let release;
  const sheets = createFakeSheets([HEADER]);
  const slowSheets = { ...sheets, readRows: () => new Promise((r) => { release = () => r(sheets.readRows()); }) };
  const runner = createSyncRunner({ sheets: slowSheets, bitrix: createFakeBitrix(), mapping, logger: silentLogger });

  const first = runner.run('test');
  assert.equal(runner.isRunning(), true);
  assert.equal(await runner.run('again'), null);
  release();
  assert.equal((await first).ok, true);
  assert.equal(runner.lastRun().trigger, 'test');

  const failing = createSyncRunner({ sheets: createFakeSheets([]), bitrix: createFakeBitrix(), mapping, logger: silentLogger });
  const result = await failing.run('cli');
  assert.equal(result.ok, false);
  assert.match(result.error, /Sheet trống/);
});
