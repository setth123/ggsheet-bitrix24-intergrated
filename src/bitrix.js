import { withRetry, sleep } from './retry.js';

const BATCH_SIZE = 50; // Bitrix24 limit: max 50 commands per batch call

export class BitrixError extends Error {
  constructor(message, { code, status, retryable = false } = {}) {
    super(message);
    this.name = 'BitrixError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

/**
 * Serializes nested params PHP-style, as Bitrix expects inside batch commands:
 * { filter: { EMAIL: "a@b.c" }, select: ["ID"] } -> "filter[EMAIL]=a%40b.c&select[0]=ID"
 */
export function toQuery(params, prefix = '') {
  const parts = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    const name = prefix ? `${prefix}[${key}]` : key;
    if (typeof value === 'object') parts.push(toQuery(value, name));
    else parts.push(`${encodeURIComponent(name)}=${encodeURIComponent(value)}`);
  }
  return parts.filter(Boolean).join('&');
}

/**
 * Bitrix24 REST client over an inbound webhook URL
 * (https://<portal>.bitrix24.vn/rest/<user_id>/<token>/).
 */
export function createBitrixClient({
  webhookUrl,
  fetchImpl = fetch,
  retry = {},
  minIntervalMs = 500, // Bitrix allows ~2 requests/second per webhook
  timeoutMs = 30000,
  logger,
}) {
  const baseUrl = webhookUrl.replace(/\/+$/, '');
  let lastCallAt = 0;

  async function throttle() {
    const wait = lastCallAt + minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastCallAt = Date.now();
  }

  async function callOnce(method, params) {
    await throttle();
    let res;
    try {
      res = await fetchImpl(`${baseUrl}/${method}.json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // Never include baseUrl in messages: it contains the webhook token.
      throw new BitrixError(`Lỗi kết nối khi gọi ${method}: ${err.message}`, { code: 'NETWORK', retryable: true });
    }

    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.error) {
      const code = body.error || `HTTP_${res.status}`;
      const retryable = res.status === 429 || res.status >= 500 || code === 'QUERY_LIMIT_EXCEEDED';
      throw new BitrixError(`${method}: ${body.error_description || code}`, { code, status: res.status, retryable });
    }
    return body;
  }

  /** Calls a single REST method, retrying rate-limit / network / 5xx errors. */
  async function call(method, params = {}) {
    const body = await withRetry(() => callOnce(method, params), { ...retry, logger, label: `Bitrix ${method}` });
    return body.result;
  }

  /**
   * Executes many commands using the `batch` method (50 per request).
   * commands: { key: { method, params } }
   * Returns { results: { key: result }, errors: { key: message } }.
   * A failing command (or a whole failing chunk) never stops the remaining ones.
   */
  async function batch(commands) {
    const results = {};
    const errors = {};
    const entries = Object.entries(commands);

    for (let i = 0; i < entries.length; i += BATCH_SIZE) {
      const chunk = entries.slice(i, i + BATCH_SIZE);
      const cmd = Object.fromEntries(chunk.map(([key, c]) => [key, `${c.method}?${toQuery(c.params || {})}`]));
      try {
        const res = await call('batch', { halt: 0, cmd });
        Object.assign(results, res.result || {});
        for (const [key, err] of Object.entries(res.result_error || {})) {
          errors[key] = err.error_description || err.error || 'Lỗi không xác định';
        }
      } catch (err) {
        for (const [key] of chunk) errors[key] = err.message;
      }
    }
    return { results, errors };
  }

  return { call, batch };
}
