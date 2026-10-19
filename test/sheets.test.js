import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSheetsClient, createGoogleAuth, columnLetter, isGoogleRetryable } from '../src/sheets.js';
import { silentLogger } from './fakes.js';

function fakeApi({ values = [], failures = [] } = {}) {
  const calls = [];
  const maybeFail = () => { const err = failures.shift(); if (err) throw err; };
  return {
    calls,
    spreadsheets: {
      values: {
        get: async (params) => { calls.push(['get', params]); maybeFail(); return { data: { values } }; },
        update: async (params) => { calls.push(['update', params]); },
        batchUpdate: async (params) => { calls.push(['batchUpdate', params]); },
      },
    },
  };
}

const client = (api) => createSheetsClient({
  api, spreadsheetId: 'sheet1', sheetName: "Leads's", retry: { retries: 2, baseDelayMs: 0 }, logger: silentLogger,
});

test('columnLetter converts indexes to A1 letters', () => {
  assert.equal(columnLetter(0), 'A');
  assert.equal(columnLetter(25), 'Z');
  assert.equal(columnLetter(26), 'AA');
  assert.equal(columnLetter(701), 'ZZ');
});

test('readRows returns trimmed header and numbered rows', async () => {
  const api = fakeApi({ values: [[' Email ', 'Tên'], ['a@b.c', 'An'], ['x@y.z']] });
  const { header, rows } = await client(api).readRows();
  assert.deepEqual(header, ['Email', 'Tên']);
  assert.deepEqual(rows, [{ rowNumber: 2, cells: ['a@b.c', 'An'] }, { rowNumber: 3, cells: ['x@y.z'] }]);
  assert.equal(api.calls[0][1].range, "'Leads''s'");
});

test('readHeader reads only row 1', async () => {
  const api = fakeApi({ values: [[' Email ', '', 'Tên']] });
  assert.deepEqual(await client(api).readHeader(), ['Email', 'Tên']);
  assert.equal(api.calls[0][1].range, "'Leads''s'!1:1");
  assert.deepEqual(await client(fakeApi({ values: undefined })).readHeader(), []);
});

test('readRows handles an empty sheet', async () => {
  const { header, rows } = await client(fakeApi({ values: undefined })).readRows();
  assert.deepEqual(header, []);
  assert.deepEqual(rows, []);
});

test('readRows retries on quota errors (429)', async () => {
  const quota = Object.assign(new Error('Quota exceeded'), { response: { status: 429 } });
  const api = fakeApi({ values: [['A']], failures: [quota] });
  await client(api).readRows();
  assert.equal(api.calls.length, 2);
});

test('readRows does not retry permission errors', async () => {
  const denied = Object.assign(new Error('The caller does not have permission'), { response: { status: 403 } });
  await assert.rejects(client(fakeApi({ failures: [denied] })).readRows(), /permission/);
});

test('writeHeader and writeCells build A1 ranges', async () => {
  const api = fakeApi();
  const c = client(api);
  await c.writeHeader(['A', 'B']);
  await c.writeCells([{ row: 5, col: 27, value: 'x' }]);
  await c.writeCells([]);
  assert.equal(api.calls[0][1].range, "'Leads''s'!A1");
  assert.deepEqual(api.calls[1][1].requestBody.data, [{ range: "'Leads''s'!AB5", values: [['x']] }]);
  assert.equal(api.calls.length, 2);
});

test('writeCells chunks large writes', async () => {
  const api = fakeApi();
  await client(api).writeCells(Array.from({ length: 2500 }, (_, i) => ({ row: i + 2, col: 0, value: i })));
  assert.equal(api.calls.length, 3);
});

test('isGoogleRetryable', () => {
  assert.equal(isGoogleRetryable({ response: { status: 503 } }), true);
  assert.equal(isGoogleRetryable({ code: 'ECONNRESET' }), true);
  assert.equal(isGoogleRetryable({ response: { status: 404 } }), false);
});

test('createGoogleAuth supports service account and OAuth, errors otherwise', () => {
  assert.equal(createGoogleAuth({ serviceAccountFile: 'sa.json' }).constructor.name, 'GoogleAuth');
  const oauth = createGoogleAuth({ oauth: { clientId: 'id', clientSecret: 's', refreshToken: 'r' } });
  assert.equal(oauth.credentials.refresh_token, 'r');
  assert.throws(() => createGoogleAuth({}), /Chưa cấu hình Google credentials/);
});
