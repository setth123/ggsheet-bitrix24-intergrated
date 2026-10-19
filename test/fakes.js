// In-memory fakes used by the tests (no real Google / Bitrix calls).
import fs from 'node:fs';

export const mapping = JSON.parse(fs.readFileSync(new URL('../config/mapping.json', import.meta.url), 'utf8'));

export const silentLogger = { info() {}, warn() {}, error() {} };

export const HEADER = ['Tên khách hàng', 'Email', 'Số điện thoại', 'Công ty', 'Nguồn lead', 'Ngân sách dự kiến', 'Trạng thái', 'Người phụ trách', 'Ghi chú'];

/** Fake sheets client backed by a 2D array (row 0 = header). */
export function createFakeSheets(grid) {
  const g = grid.map((r) => [...r]);
  return {
    grid: g,
    writeCalls: 0,
    async readRows() {
      const [header = [], ...data] = g;
      return { header: [...header], rows: data.map((cells, i) => ({ rowNumber: i + 2, cells: cells.map(String) })) };
    },
    async writeHeader(header) {
      g[0] = [...header];
    },
    async writeCells(cells) {
      this.writeCalls++;
      for (const c of cells) {
        const row = g[c.row - 1];
        while (row.length <= c.col) row.push('');
        row[c.col] = c.value;
      }
    },
    /** Returns row `n` (1-based sheet row) as { header: value }. */
    row(n) {
      return Object.fromEntries(g[0].map((h, i) => [h, g[n - 1][i] ?? '']));
    },
  };
}

/**
 * Fake Bitrix client implementing batch() over an in-memory lead store.
 * `modifiedAt` is the DATE_MODIFY stamped on add/update (same as the sync clock used in tests).
 */
export function createFakeBitrix({ leads = [], fail = () => null, modifiedAt = '2026-10-19T08:00:00+00:00' } = {}) {
  const store = new Map(leads.map((l) => [String(l.ID), structuredClone(l)]));
  let nextId = 1000;
  let nextMultiId = 1;

  const applyFields = (lead, fields) => {
    for (const [key, value] of Object.entries(fields)) {
      if (!['EMAIL', 'PHONE'].includes(key)) { lead[key] = value; continue; }
      lead[key] = lead[key] || [];
      for (const item of value) {
        const existing = item.ID && lead[key].find((x) => x.ID === item.ID);
        if (existing) existing.VALUE = item.VALUE;
        else lead[key].push({ ID: String(nextMultiId++), VALUE: item.VALUE, VALUE_TYPE: item.VALUE_TYPE });
      }
    }
    lead.DATE_MODIFY = modifiedAt;
    return lead;
  };

  const exec = (method, params) => {
    switch (method) {
      case 'crm.lead.list': {
        const [field, value] = Object.entries(params.filter)[0];
        return [...store.values()].filter((l) => (l[field] || []).some((x) => x.VALUE === value)).map((l) => ({ ID: l.ID }));
      }
      case 'crm.lead.get': {
        const lead = store.get(String(params.id));
        if (!lead) throw new Error('Not found');
        return structuredClone(lead);
      }
      case 'crm.lead.add': {
        const id = String(nextId++);
        store.set(id, applyFields({ ID: id }, params.fields));
        return Number(id);
      }
      case 'crm.lead.update': {
        const lead = store.get(String(params.id));
        if (!lead) throw new Error('Not found');
        applyFields(lead, params.fields);
        return true;
      }
      default:
        throw new Error(`Unknown method ${method}`);
    }
  };

  return {
    store,
    calls: [], // [{ key, method, params }]
    batchCount: 0,
    async batch(commands) {
      this.batchCount++;
      const results = {};
      const errors = {};
      for (const [key, { method, params }] of Object.entries(commands)) {
        this.calls.push({ key, method, params });
        try {
          const forced = fail(method, params);
          if (forced) throw new Error(forced);
          results[key] = exec(method, params);
        } catch (err) {
          errors[key] = err.message;
        }
      }
      return { results, errors };
    },
  };
}
