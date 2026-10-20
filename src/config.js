import fs from 'node:fs';

const FIELD_TYPES = ['string', 'email', 'phone', 'number', 'date', 'enum'];
const DIRECTIONS = ['one-way', 'two-way'];
const PRIORITIES = ['bitrix', 'sheet'];
const STATUS_KEYS = ['status', 'leadId', 'syncedAt', 'error', 'hash'];

/** Validates mapping.json and returns it. Throws with a readable message on problems. */
export function validateMapping(mapping) {
  if (!Array.isArray(mapping?.fields) || !mapping.fields.length) {
    throw new Error('mapping.json: "fields" phải là mảng không rỗng');
  }
  mapping.fields.forEach((rule, i) => {
    const where = `mapping.json: fields[${i}]`;
    if (!rule.column || !rule.field) throw new Error(`${where} cần có "column" và "field"`);
    if (rule.type && !FIELD_TYPES.includes(rule.type)) {
      throw new Error(`${where} có type "${rule.type}" không hợp lệ (cho phép: ${FIELD_TYPES.join(', ')})`);
    }
    if (rule.type === 'enum' && (typeof rule.values !== 'object' || !rule.values)) {
      throw new Error(`${where} type "enum" cần có "values"`);
    }
    if (rule.multiple && ['email', 'phone'].includes(rule.type)) {
      throw new Error(`${where}: "multiple" không dùng được cho type "${rule.type}"`);
    }
    if (rule.pattern) {
      try { new RegExp(rule.pattern); } catch { throw new Error(`${where} có "pattern" không phải regex hợp lệ`); }
    }
  });
  const sync = mapping.sync || {};
  if (sync.direction && !DIRECTIONS.includes(sync.direction)) {
    throw new Error(`mapping.json: sync.direction phải là ${DIRECTIONS.join(' hoặc ')}`);
  }
  if (sync.conflictPriority && !PRIORITIES.includes(sync.conflictPriority)) {
    throw new Error(`mapping.json: sync.conflictPriority phải là ${PRIORITIES.join(' hoặc ')}`);
  }
  for (const key of STATUS_KEYS) {
    if (!mapping.statusColumns?.[key]) throw new Error(`mapping.json: thiếu statusColumns.${key}`);
  }
  return mapping;
}

/** Loads configuration from environment variables + the mapping file. */
export function loadConfig(env = process.env) {
  const required = (name) => {
    if (!env[name]) throw new Error(`Thiếu biến môi trường ${name} (xem .env.example)`);
    return env[name];
  };
  const mappingFile = env.MAPPING_FILE || 'config/mapping.json';

  let mapping;
  try {
    mapping = JSON.parse(fs.readFileSync(mappingFile, 'utf8'));
  } catch (err) {
    throw new Error(`Không đọc được file mapping "${mappingFile}": ${err.message}`);
  }

  return {
    google: {
      spreadsheetId: required('GOOGLE_SHEET_ID'),
      sheetName: env.GOOGLE_SHEET_NAME || 'Leads',
      serviceAccountFile: env.GOOGLE_SERVICE_ACCOUNT_FILE || '',
      oauth: {
        clientId: env.GOOGLE_OAUTH_CLIENT_ID || '',
        clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET || '',
        refreshToken: env.GOOGLE_OAUTH_REFRESH_TOKEN || '',
      },
    },
    bitrix: {
      webhookUrl: required('BITRIX_WEBHOOK_URL'),
      minIntervalMs: Number(env.BITRIX_MIN_INTERVAL_MS || 500),
      // application_token of the outbound webhook (Bitrix24 -> this app), for real-time two-way sync
      outboundToken: env.BITRIX_OUTBOUND_TOKEN || '',
      webhookDebounceMs: Number(env.WEBHOOK_DEBOUNCE_MS || 3000),
    },
    retry: {
      retries: Number(env.RETRY_MAX || 3),
      baseDelayMs: Number(env.RETRY_BASE_DELAY_MS || 1000),
    },
    schedule: env.SYNC_CRON || '*/15 * * * *',
    syncOnStart: env.SYNC_ON_START !== 'false',
    timezone: env.TZ || 'Asia/Ho_Chi_Minh',
    port: Number(env.PORT || 3000),
    adminToken: env.ADMIN_TOKEN || '',
    logFile: env.LOG_FILE ?? 'logs/sync.log',
    mappingFile,
    mapping: validateMapping(mapping),
  };
}
