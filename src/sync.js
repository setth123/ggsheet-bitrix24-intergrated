import { mapRow, isEmptyRecord, toBitrixFields, diffFromBitrix } from './mapper.js';

export const STATUS = { PENDING: 'Chờ xử lý', SYNCED: 'Đã đồng bộ', ERROR: 'Lỗi' };

/** True if the lead was modified in Bitrix24 after the row's last successful sync. */
function modifiedSince(lead, syncedAt) {
  if (!syncedAt || !lead.DATE_MODIFY) return false;
  return new Date(lead.DATE_MODIFY) > new Date(syncedAt);
}

/**
 * One sync run between the Google Sheet and Bitrix24 leads.
 *
 *  1. Read the sheet, map + validate each row, compute its hash.
 *  2. Decide per row: create (no Lead ID) or check (has Lead ID).
 *  3. For new rows, look for an existing lead with the same Email/Phone -> update it instead.
 *  4. Load linked leads (all of them in two-way mode, only edited rows otherwise).
 *     - Sheet edited only            -> push to Bitrix.
 *     - Bitrix edited only (two-way) -> pull `twoWay` fields into the sheet.
 *     - Both edited (conflict)       -> mapping.sync.conflictPriority decides ("bitrix" | "sheet").
 *  5. crm.lead.add / crm.lead.update via `batch`.
 *  6. Write status, Lead ID, sync time, error, hash (+ pulled cells) back to the sheet in one request.
 *
 * Errors on one row never stop the others. Returns { stats, errors, ... }.
 */
export async function runSync({ sheets, bitrix, mapping, logger, now = () => new Date() }) {
  const startedAt = now();
  const stats = { total: 0, created: 0, updated: 0, duplicates: 0, pulled: 0, conflicts: 0, skipped: 0, failed: 0 };
  const errors = [];
  const writes = [];

  const { header, rows } = await sheets.readRows();
  if (!header.length) throw new Error('Sheet trống: cần có dòng tiêu đề (header) ở hàng 1');
  checkMappedColumns(header, mapping, logger);
  const col = await ensureStatusColumns(sheets, header, mapping.statusColumns);

  const twoWay = mapping.sync?.direction === 'two-way';
  const pullRules = twoWay ? mapping.fields.filter((r) => r.twoWay && header.includes(r.column)) : [];
  const sheetWins = mapping.sync?.conflictPriority === 'sheet';

  const set = (row, key, value) => writes.push({ row, col: col[key], value });
  const fail = (item, message) => {
    stats.failed++;
    errors.push({ row: item.rowNumber, message });
    logger.error(`Hàng ${item.rowNumber}: ${message}`);
    set(item.rowNumber, 'status', STATUS.ERROR);
    set(item.rowNumber, 'error', message);
  };
  const succeed = (item, leadId, kind) => {
    stats[kind]++;
    for (const cell of item.pulledCells || []) writes.push({ row: item.rowNumber, ...cell });
    set(item.rowNumber, 'status', STATUS.SYNCED);
    set(item.rowNumber, 'leadId', String(leadId));
    set(item.rowNumber, 'syncedAt', now().toISOString());
    set(item.rowNumber, 'error', '');
    set(item.rowNumber, 'hash', item.hash);
  };

  // --- 1 & 2. Plan ---
  const toCreate = [];
  const linked = [];
  const newRowKeys = new Map(); // email/phone -> row number, to catch duplicates inside the sheet itself

  for (const { rowNumber, cells } of rows) {
    const record = Object.fromEntries(header.map((name, i) => [name, cells[i] ?? '']));
    if (isEmptyRecord(record, mapping)) continue;
    stats.total++;

    const { fields, errors: invalid, hash } = mapRow(record, mapping);
    const item = {
      rowNumber, record, fields, hash,
      leadId: (cells[col.leadId] ?? '').trim(),
      syncedAt: cells[col.syncedAt] ?? '',
    };

    if (invalid.length) {
      fail(item, `Dữ liệu không hợp lệ: ${invalid.join('; ')}`);
    } else if (item.leadId) {
      item.sheetChanged = !(cells[col.hash] === hash && cells[col.status] === STATUS.SYNCED);
      linked.push(item);
    } else {
      const keys = [fields.EMAIL, fields.PHONE].filter(Boolean);
      const firstRow = keys.map((k) => newRowKeys.get(k)).find(Boolean);
      if (firstRow) {
        // Let the first row create the lead; this one will be matched as a duplicate next run.
        stats.skipped++;
        set(rowNumber, 'status', STATUS.PENDING);
        set(rowNumber, 'error', `Trùng Email/SĐT với hàng ${firstRow}, sẽ xử lý ở lần chạy sau`);
      } else {
        keys.forEach((k) => newRowKeys.set(k, rowNumber));
        toCreate.push(item);
      }
    }
  }

  // --- 3. Duplicate check for new rows ---
  const duplicates = await findDuplicates(bitrix, toCreate);
  const creates = [];
  for (const item of toCreate) {
    const dup = duplicates.get(item.rowNumber);
    if (dup.error) {
      fail(item, `Không kiểm tra được trùng lặp: ${dup.error}`);
    } else if (dup.leadId) {
      logger.info(`Hàng ${item.rowNumber}: trùng với lead #${dup.leadId} trên Bitrix24 -> cập nhật thay vì tạo mới`);
      Object.assign(item, { leadId: String(dup.leadId), duplicate: true, sheetChanged: true });
      linked.push(item);
    } else {
      creates.push(item);
    }
  }

  // --- 4. Load linked leads and resolve changes ---
  const toLoad = linked.filter((it) => it.sheetChanged || pullRules.length);
  const loaded = await bitrix.batch(Object.fromEntries(
    toLoad.map((it) => [`g${it.rowNumber}`, { method: 'crm.lead.get', params: { id: it.leadId } }]),
  ));
  stats.skipped += linked.length - toLoad.length;

  const updates = [];
  for (const item of toLoad) {
    const lead = loaded.results[`g${item.rowNumber}`];
    if (!lead) {
      const reason = loaded.errors[`g${item.rowNumber}`] || 'không tìm thấy';
      if (item.sheetChanged) {
        fail(item, `Không đọc được lead #${item.leadId} trên Bitrix24: ${reason}`);
      } else {
        stats.skipped++;
        logger.warn(`Hàng ${item.rowNumber}: không đọc được lead #${item.leadId} để kiểm tra thay đổi: ${reason}`);
      }
      continue;
    }

    let pulled = [];
    if (pullRules.length && modifiedSince(lead, item.syncedAt)) {
      const diff = diffFromBitrix(item.fields, lead, pullRules);
      diff.warnings.forEach((w) => logger.warn(`Hàng ${item.rowNumber}: ${w}`));
      pulled = diff.changes;
    }

    if (!item.sheetChanged && !pulled.length) {
      stats.skipped++;
      continue;
    }
    if (item.sheetChanged && pulled.length) {
      stats.conflicts++;
      logger.warn(`Hàng ${item.rowNumber}: xung đột, lead #${item.leadId} bị sửa ở cả Sheet và Bitrix24 -> ưu tiên ${sheetWins ? 'Google Sheet' : 'Bitrix24'}`);
      if (sheetWins) pulled = [];
    }
    if (pulled.length) {
      for (const change of pulled) item.record[change.rule.column] = change.value;
      const merged = mapRow(item.record, mapping);
      if (merged.errors.length) {
        fail(item, `Dữ liệu từ Bitrix24 không hợp lệ: ${merged.errors.join('; ')}`);
        continue;
      }
      Object.assign(item, { fields: merged.fields, hash: merged.hash });
      item.pulledCells = pulled.map((c) => ({ col: header.indexOf(c.rule.column), value: c.value }));
      logger.info(`Hàng ${item.rowNumber}: cập nhật từ Bitrix24: ${pulled.map((c) => `${c.rule.column} = "${c.value}"`).join(', ')}`);
    }

    if (item.sheetChanged) updates.push({ item, lead });
    else succeed(item, item.leadId, 'pulled');
  }

  // --- 5. Create / update ---
  const commands = {};
  for (const item of creates) {
    commands[`a${item.rowNumber}`] = { method: 'crm.lead.add', params: { fields: toBitrixFields(item.fields) } };
  }
  for (const { item, lead } of updates) {
    commands[`u${item.rowNumber}`] = {
      method: 'crm.lead.update',
      params: { id: item.leadId, fields: toBitrixFields(item.fields, lead) },
    };
  }
  const saved = await bitrix.batch(commands);

  for (const item of creates) {
    const leadId = saved.results[`a${item.rowNumber}`];
    if (leadId) succeed(item, leadId, 'created');
    else fail(item, `Tạo lead thất bại: ${saved.errors[`a${item.rowNumber}`] || 'không rõ nguyên nhân'}`);
  }
  for (const { item } of updates) {
    if (saved.results[`u${item.rowNumber}`]) {
      succeed(item, item.leadId, 'updated');
      if (item.duplicate) stats.duplicates++;
    } else {
      fail(item, `Cập nhật lead #${item.leadId} thất bại: ${saved.errors[`u${item.rowNumber}`] || 'không rõ nguyên nhân'}`);
    }
  }

  // --- 6. Write back ---
  await sheets.writeCells(writes);

  const finishedAt = now();
  const result = {
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt - startedAt,
    stats,
    errors,
  };
  logger.info('Đồng bộ hoàn tất', { ...stats, durationMs: result.durationMs });
  return result;
}

/** Finds existing leads by Email (preferred) or Phone. Returns Map(rowNumber -> { leadId?, error? }). */
async function findDuplicates(bitrix, items) {
  const listBy = (field, value) => ({
    method: 'crm.lead.list',
    params: { filter: { [field]: value }, select: ['ID'], order: { ID: 'ASC' } },
  });
  const commands = {};
  for (const it of items) {
    if (it.fields.EMAIL) commands[`e${it.rowNumber}`] = listBy('EMAIL', it.fields.EMAIL);
    if (it.fields.PHONE) commands[`p${it.rowNumber}`] = listBy('PHONE', it.fields.PHONE);
  }
  const { results, errors } = await bitrix.batch(commands);

  const found = new Map();
  for (const it of items) {
    const e = `e${it.rowNumber}`;
    const p = `p${it.rowNumber}`;
    found.set(it.rowNumber, {
      error: errors[e] || errors[p],
      leadId: results[e]?.[0]?.ID || results[p]?.[0]?.ID,
    });
  }
  return found;
}

/** Required mapped columns must exist in the header; optional ones only produce a warning. */
function checkMappedColumns(header, mapping, logger) {
  for (const rule of mapping.fields) {
    if (header.includes(rule.column)) continue;
    if (rule.required) throw new Error(`Không tìm thấy cột bắt buộc "${rule.column}" trong sheet`);
    logger.warn(`Không tìm thấy cột "${rule.column}" trong sheet, bỏ qua trường ${rule.field}`);
  }
}

/** Appends missing status columns to the header row. Returns { key: columnIndex }. */
async function ensureStatusColumns(sheets, header, statusColumns) {
  const newHeader = [...header];
  for (const name of Object.values(statusColumns)) {
    if (!newHeader.includes(name)) newHeader.push(name);
  }
  if (newHeader.length !== header.length) await sheets.writeHeader(newHeader);
  return Object.fromEntries(Object.entries(statusColumns).map(([key, name]) => [key, newHeader.indexOf(name)]));
}

/**
 * Wraps runSync so only one run happens at a time, remembers the last result,
 * and lets the mapping be replaced at runtime (admin panel).
 */
export function createSyncRunner(deps) {
  let running = false;
  let lastRun = null;
  let timer = null;
  let queued = null; // trigger requested via schedule() while a run was in progress

  const runner = {
    isRunning: () => running,
    lastRun: () => lastRun,
    getMapping: () => deps.mapping,
    setMapping: (mapping) => { deps.mapping = mapping; },

    /** Returns the run result, or null if another run is already in progress. */
    async run(trigger = 'manual') {
      if (running) {
        deps.logger.warn(`Bỏ qua trigger "${trigger}": đang có phiên đồng bộ chạy`);
        return null;
      }
      running = true;
      deps.logger.info(`Bắt đầu đồng bộ (trigger: ${trigger})`);
      try {
        lastRun = { trigger, ok: true, ...(await runSync(deps)) };
      } catch (err) {
        deps.logger.error(`Đồng bộ thất bại: ${err.message}`);
        lastRun = { trigger, ok: false, error: err.message, finishedAt: new Date().toISOString() };
      } finally {
        running = false;
      }
      if (queued) {
        const next = queued;
        queued = null;
        setImmediate(() => runner.run(next));
      }
      return lastRun;
    },

    /**
     * Debounced run, used by Bitrix24 webhooks: a burst of events within `delayMs` triggers a single
     * sync, and an event arriving during a run queues one more run right after it.
     */
    schedule(trigger, delayMs = 3000) {
      clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        if (running) queued = trigger;
        else runner.run(trigger);
      }, delayMs);
    },
  };
  return runner;
}
