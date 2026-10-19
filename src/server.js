import http from 'node:http';
import fs from 'node:fs';

const ADMIN_HTML = fs.readFileSync(new URL('./admin.html', import.meta.url), 'utf8');
const MAX_BODY_BYTES = 1024 * 1024;
const PUBLIC_ROUTES = new Set(['GET /', 'GET /health', 'POST /webhooks/bitrix']);

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('Dữ liệu gửi lên quá lớn'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * HTTP API + admin panel.
 *
 *   GET  /                    Admin panel (HTML; it calls the API below with the admin token)
 *   GET  /health              { ok: true }  (for Docker / uptime checks)
 *   GET  /status              Running flag + last run result
 *   POST /sync                Run a sync now (409 if one is already running)
 *   GET  /api/logs?limit=N    Recent log lines
 *   GET  /api/mapping         Current mapping
 *   PUT  /api/mapping         Validate + save a new mapping (applies from the next run)
 *   GET  /api/sheet-columns   Column names of the sheet header (for the mapping editor)
 *   GET  /api/bitrix-fields   Lead fields incl. custom UF_CRM_* (for the mapping editor)
 *   POST /webhooks/bitrix     Bitrix24 outbound webhook (ONCRMLEADUPDATE) -> debounced two-way sync
 *
 * If adminToken is set, every non-public route needs "Authorization: Bearer <token>".
 * The webhook is authenticated by the application_token Bitrix24 sends with each event.
 */
export function createServer({
  runner, logger, sheets, bitrix, saveMapping,
  adminToken = '', webhookToken = '', webhookDelayMs = 3000,
}) {
  const handlers = {
    'GET /': (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(ADMIN_HTML);
    },

    'GET /health': () => [200, { ok: true }],

    'GET /status': () => [200, { running: runner.isRunning(), lastRun: runner.lastRun() }],

    'POST /sync': async () => {
      const result = await runner.run('http');
      if (!result) return [409, { error: 'Đang có phiên đồng bộ chạy, thử lại sau' }];
      return [result.ok ? 200 : 500, result];
    },

    'GET /api/logs': (req, res, url) => {
      const limit = Math.min(Number(url.searchParams.get('limit')) || 200, 1000);
      return [200, { lines: logger.recent(limit) }];
    },

    'GET /api/mapping': () => [200, runner.getMapping()],

    'PUT /api/mapping': async (req) => {
      let mapping;
      try {
        mapping = JSON.parse(await readBody(req));
      } catch (err) {
        if (err.status) throw err;
        return [400, { error: 'Dữ liệu gửi lên không phải JSON hợp lệ' }];
      }
      try {
        saveMapping(mapping);
      } catch (err) {
        return [400, { error: err.message }];
      }
      return [200, { ok: true, mapping: runner.getMapping() }];
    },

    'GET /api/sheet-columns': async () => [200, { columns: await sheets.readHeader() }],

    'GET /api/bitrix-fields': async () => {
      const fields = await bitrix.call('crm.lead.fields');
      const list = Object.entries(fields)
        .filter(([, f]) => !f.isReadOnly)
        .map(([id, f]) => ({ id, title: f.listLabel || f.formLabel || f.title || id, type: f.type, multiple: !!f.isMultiple }));
      return [200, { fields: list }];
    },

    'POST /webhooks/bitrix': async (req) => {
      if (!webhookToken) return [403, { error: 'Chưa cấu hình BITRIX_OUTBOUND_TOKEN' }];
      const params = new URLSearchParams(await readBody(req)); // Bitrix sends form-urlencoded
      if (params.get('auth[application_token]') !== webhookToken) {
        logger.warn('Webhook Bitrix24 bị từ chối: sai application_token');
        return [401, { error: 'application_token không hợp lệ' }];
      }
      const event = params.get('event');
      const leadId = params.get('data[FIELDS][ID]');
      const twoWay = runner.getMapping().sync?.direction === 'two-way';
      logger.info(`Webhook Bitrix24: ${event} lead #${leadId}${twoWay ? '' : ' (bỏ qua: chưa bật two-way)'}`);
      if (twoWay && event === 'ONCRMLEADUPDATE') runner.schedule('webhook', webhookDelayMs);
      return [200, { ok: true }];
    },
  };

  return http.createServer(async (req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };
    const url = new URL(req.url, 'http://localhost');
    const route = `${req.method} ${url.pathname}`;
    const handler = handlers[route];

    if (!handler) return send(404, { error: 'Not found' });
    if (adminToken && !PUBLIC_ROUTES.has(route) && req.headers.authorization !== `Bearer ${adminToken}`) {
      return send(401, { error: 'Thiếu hoặc sai ADMIN_TOKEN (header Authorization: Bearer <token>)' });
    }

    try {
      const result = await handler(req, res, url);
      if (result) send(...result);
    } catch (err) {
      logger.error(`${route} lỗi: ${err.message}`);
      send(err.status || 500, { error: err.message });
    }
  });
}
