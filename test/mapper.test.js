import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePhone, normalizeEmail, convertValue, mapRow, isEmptyRecord, toBitrixFields, hashFields } from '../src/mapper.js';
import { mapping } from './fakes.js';

test('normalizePhone converts Vietnamese formats to E.164', () => {
  assert.equal(normalizePhone('0912 345 678'), '+84912345678');
  assert.equal(normalizePhone('+84 912-345-678'), '+84912345678');
  assert.equal(normalizePhone('0084912345678'), '+84912345678');
  assert.equal(normalizePhone('912345678'), '+84912345678'); // leading 0 dropped by Sheets
  assert.throws(() => normalizePhone('12'), /không hợp lệ/);
});

test('normalizeEmail lower-cases and validates', () => {
  assert.equal(normalizeEmail('  An.Nguyen@Example.COM '), 'an.nguyen@example.com');
  assert.throws(() => normalizeEmail('abc@xyz'), /email không hợp lệ/);
});

test('convertValue handles number, enum and unknown types', () => {
  assert.equal(convertValue({ type: 'number' }, '50.000.000 đ'), 50000000);
  assert.throws(() => convertValue({ type: 'number' }, 'abc'), /không phải số/);
  assert.equal(convertValue({ type: 'enum', values: { Mới: 'NEW' } }, 'mới'), 'NEW');
  assert.throws(() => convertValue({ type: 'enum', values: { Mới: 'NEW' } }, 'X'), /cho phép: Mới/);
  assert.throws(() => convertValue({ type: 'xml' }, 'x'), /không được hỗ trợ/);
  assert.equal(convertValue({}, 'text'), 'text');
});

test('mapRow maps columns, applies defaults and builds TITLE', () => {
  const { fields, errors } = mapRow({
    'Tên khách hàng': 'An', Email: 'AN@x.com', 'Số điện thoại': '0912345678', 'Công ty': 'ABC',
    'Ngân sách dự kiến': '1,000', 'Trạng thái': 'Mới', 'Người phụ trách': 'Admin',
  }, mapping);
  assert.deepEqual(errors, []);
  assert.equal(fields.NAME, 'An');
  assert.equal(fields.EMAIL, 'an@x.com');
  assert.equal(fields.PHONE, '+84912345678');
  assert.equal(fields.OPPORTUNITY, 1000);
  assert.equal(fields.STATUS_ID, 'NEW');
  assert.equal(fields.ASSIGNED_BY_ID, 1);
  assert.equal(fields.CURRENCY_ID, 'VND');
  assert.equal(fields.TITLE, 'An - ABC');
});

test('mapRow collects validation errors', () => {
  const { errors } = mapRow({ Email: 'bad', 'Trạng thái': '???' }, mapping);
  assert.equal(errors.length, 4);
  assert.match(errors.join('|'), /Thiếu "Tên khách hàng"/);
  assert.match(errors.join('|'), /Cần ít nhất Email hoặc Số điện thoại/);
});

test('hash is stable regardless of key order and changes with data', () => {
  assert.equal(hashFields({ a: 1, b: 2 }), hashFields({ b: 2, a: 1 }));
  assert.notEqual(hashFields({ a: 1 }), hashFields({ a: 2 }));
});

test('isEmptyRecord detects blank rows', () => {
  assert.equal(isEmptyRecord({ Email: '  ' }, mapping), true);
  assert.equal(isEmptyRecord({ Email: 'a@b.c' }, mapping), false);
});

test('toBitrixFields builds multi-fields for new leads', () => {
  assert.deepEqual(toBitrixFields({ NAME: 'An', EMAIL: 'a@b.c' }), {
    NAME: 'An', EMAIL: [{ VALUE: 'a@b.c', VALUE_TYPE: 'WORK' }],
  });
});

test('toBitrixFields skips unchanged multi-fields and replaces changed ones by ID', () => {
  const lead = {
    EMAIL: [{ ID: '7', VALUE: 'A@B.C', VALUE_TYPE: 'HOME' }],
    PHONE: [{ ID: '8', VALUE: '0912345678', VALUE_TYPE: 'WORK' }],
  };
  const out = toBitrixFields({ NAME: 'An', EMAIL: 'a@b.c', PHONE: '+84999999999' }, lead);
  assert.equal(out.EMAIL, undefined); // same email (case-insensitive)
  assert.deepEqual(out.PHONE, [{ ID: '8', VALUE: '+84999999999', VALUE_TYPE: 'WORK' }]);
  assert.equal(toBitrixFields({ PHONE: '+84912345678' }, lead).PHONE, undefined); // same phone, other format
});
