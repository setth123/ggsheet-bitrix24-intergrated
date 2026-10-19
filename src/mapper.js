import crypto from 'node:crypto';

// Bitrix24 "multi-fields" are stored as arrays of {ID, VALUE, VALUE_TYPE}.
const MULTI_FIELDS = new Set(['EMAIL', 'PHONE', 'WEB', 'IM']);
const DEFAULT_COUNTRY_CODE = '84'; // Vietnam
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Normalizes a phone number to E.164 (+84912345678). Throws if invalid. */
export function normalizePhone(raw) {
  let digits = String(raw).replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) digits = digits.slice(1);
  else if (digits.startsWith('00')) digits = digits.slice(2);
  else if (digits.startsWith('0')) digits = DEFAULT_COUNTRY_CODE + digits.slice(1);
  // Google Sheets often drops the leading 0 of numeric cells: "912345678".
  else if (digits.length === 9) digits = DEFAULT_COUNTRY_CODE + digits;

  if (!/^\d{9,15}$/.test(digits)) throw new Error(`số điện thoại không hợp lệ "${raw}"`);
  return '+' + digits;
}

/** Trims and lower-cases an email. Throws if invalid. */
export function normalizeEmail(raw) {
  const email = String(raw).trim().toLowerCase();
  if (!EMAIL_RE.test(email)) throw new Error(`email không hợp lệ "${raw}"`);
  return email;
}

/** Parses "19/10/2026", "19-10-2026", "19.10.2026" or "2026-10-19" into "2026-10-19". Throws if invalid. */
export function normalizeDate(raw) {
  let m = String(raw).trim().match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  let year, month, day;
  if (m) [, day, month, year] = m.map(Number);
  else if ((m = String(raw).trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) [, year, month, day] = m.map(Number);
  else throw new Error(`ngày không hợp lệ "${raw}" (dùng dd/mm/yyyy)`);

  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) throw new Error(`ngày không tồn tại "${raw}"`);
  return date.toISOString().slice(0, 10);
}

/** Converts a raw cell string according to the mapping rule type. */
export function convertValue(rule, raw) {
  switch (rule.type || 'string') {
    case 'string':
      return raw;
    case 'email':
      return normalizeEmail(raw);
    case 'phone':
      return normalizePhone(raw);
    case 'date':
      return normalizeDate(raw);
    case 'number': {
      // "50.000.000 đ" / "50,000,000" -> 50000000 (integer amounts, e.g. VND)
      const digits = raw.replace(/\D/g, '');
      if (!digits) throw new Error(`"${raw}" không phải số`);
      return Number(digits);
    }
    case 'enum': {
      const key = Object.keys(rule.values).find((k) => k.toLowerCase() === raw.toLowerCase());
      if (key === undefined) {
        throw new Error(`giá trị "${raw}" không hợp lệ (cho phép: ${Object.keys(rule.values).join(', ')})`);
      }
      return rule.values[key];
    }
    default:
      throw new Error(`kiểu dữ liệu "${rule.type}" không được hỗ trợ`);
  }
}

/** Stable short hash of the mapped fields, used to detect row changes. */
export function hashFields(fields) {
  const sorted = Object.keys(fields).sort().map((k) => [k, fields[k]]);
  return crypto.createHash('sha256').update(JSON.stringify(sorted)).digest('hex').slice(0, 16);
}

/**
 * Maps one sheet record ({ "Column header": "cell value" }) to Bitrix lead fields.
 * Returns { fields, errors, hash }. `fields` keeps plain values (EMAIL: "a@b.com");
 * conversion to Bitrix multi-field format happens in toBitrixFields().
 */
export function mapRow(record, mapping) {
  const fields = { ...(mapping.defaults || {}) };
  const errors = [];

  for (const rule of mapping.fields) {
    const raw = String(record[rule.column] ?? '').trim();
    if (!raw) {
      if (rule.required) errors.push(`Thiếu "${rule.column}"`);
      continue;
    }
    try {
      if (rule.maxLength && raw.length > rule.maxLength) throw new Error(`dài quá ${rule.maxLength} ký tự`);
      if (rule.pattern && !new RegExp(rule.pattern).test(raw)) {
        throw new Error(rule.patternMessage || `"${raw}" không đúng định dạng yêu cầu`);
      }
      fields[rule.field] = rule.multiple
        ? raw.split(/[,;\n]/).map((v) => v.trim()).filter(Boolean).map((v) => convertValue(rule, v))
        : convertValue(rule, raw);
    } catch (err) {
      errors.push(`${rule.column}: ${err.message}`);
    }
  }

  if (!fields.EMAIL && !fields.PHONE) errors.push('Cần ít nhất Email hoặc Số điện thoại');
  if (!fields.TITLE && fields.NAME) {
    fields.TITLE = fields.COMPANY_TITLE ? `${fields.NAME} - ${fields.COMPANY_TITLE}` : fields.NAME;
  }

  return { fields, errors, hash: hashFields(fields) };
}

/** True when every mapped column of the record is blank. */
export function isEmptyRecord(record, mapping) {
  return mapping.fields.every((rule) => !String(record[rule.column] ?? '').trim());
}

function sameValue(key, a, b) {
  if (key === 'PHONE') {
    try { return normalizePhone(a) === normalizePhone(b); } catch { return a === b; }
  }
  return String(a).toLowerCase() === String(b).toLowerCase();
}

// ---------- Bitrix24 -> Sheet (two-way sync) ----------

function scalarFromBitrix(rule, raw) {
  switch (rule.type || 'string') {
    case 'phone':
      try { return normalizePhone(raw); } catch { return String(raw); }
    case 'email':
      return String(raw).toLowerCase();
    case 'number':
      return Number(raw);
    case 'date':
      return String(raw).slice(0, 10); // "2026-10-19T00:00:00+07:00" -> "2026-10-19"
    case 'enum': {
      // Return the configured value (keeps its type, e.g. 1 vs "1") so it compares with mapRow() output.
      const match = Object.values(rule.values).find((v) => String(v) === String(raw));
      return match ?? String(raw);
    }
    default:
      return String(raw);
  }
}

/** Converts a Bitrix lead value to the same canonical form mapRow() produces (undefined = empty). */
export function fromBitrix(rule, raw) {
  if (MULTI_FIELDS.has(rule.field)) raw = Array.isArray(raw) ? raw[0]?.VALUE : raw;
  if (raw === undefined || raw === null || raw === '' || (Array.isArray(raw) && !raw.length)) return undefined;
  if (rule.multiple) return [].concat(raw).map((v) => scalarFromBitrix(rule, v));
  return scalarFromBitrix(rule, raw);
}

/** Canonical value -> text to put in the sheet cell. Returns undefined if it can't be represented (unknown enum). */
export function toSheetValue(rule, value) {
  if (value === undefined) return '';
  if (Array.isArray(value)) {
    const parts = value.map((v) => toSheetValue({ ...rule, multiple: false }, v));
    return parts.includes(undefined) ? undefined : parts.join(', ');
  }
  if (rule.type === 'enum') return Object.keys(rule.values).find((label) => rule.values[label] === value);
  if (rule.type === 'date') return value.split('-').reverse().join('/');
  return String(value);
}

/**
 * Compares the sheet's mapped fields with a Bitrix lead for the given (two-way) rules.
 * Returns { changes: [{ rule, value }], warnings: [string] } where value is the new cell text.
 */
export function diffFromBitrix(fields, lead, rules) {
  const changes = [];
  const warnings = [];
  for (const rule of rules) {
    const value = fromBitrix(rule, lead[rule.field]);
    if (JSON.stringify(value ?? null) === JSON.stringify(fields[rule.field] ?? null)) continue;
    if (value === undefined && rule.required) {
      warnings.push(`${rule.column}: Bitrix24 để trống trường bắt buộc, giữ giá trị trên Sheet`);
      continue;
    }
    const text = toSheetValue(rule, value);
    if (text === undefined) {
      warnings.push(`${rule.column}: giá trị "${lead[rule.field]}" từ Bitrix24 chưa có trong mapping "values", bỏ qua`);
      continue;
    }
    changes.push({ rule, value: text });
  }
  return { changes, warnings };
}

/**
 * Builds the `fields` payload for crm.lead.add / crm.lead.update.
 * For multi-fields on an existing lead: unchanged values are omitted, otherwise the
 * first existing entry is replaced (by its ID) so we don't pile up duplicate emails/phones.
 */
export function toBitrixFields(fields, existingLead = null) {
  const out = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!MULTI_FIELDS.has(key)) {
      out[key] = value;
      continue;
    }
    const current = existingLead?.[key] || [];
    if (current.some((item) => sameValue(key, item.VALUE, value))) continue;
    out[key] = current.length
      ? [{ ID: current[0].ID, VALUE: value, VALUE_TYPE: current[0].VALUE_TYPE || 'WORK' }]
      : [{ VALUE: value, VALUE_TYPE: 'WORK' }];
  }
  return out;
}
