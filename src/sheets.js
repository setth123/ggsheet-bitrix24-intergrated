import { sheets as sheetsApi, auth } from '@googleapis/sheets';
import { withRetry } from './retry.js';

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];
const WRITE_CHUNK = 1000; // ranges per values.batchUpdate request

/** Builds a Google auth client: Service Account (preferred) or OAuth 2.0 refresh token. */
export function createGoogleAuth({ serviceAccountFile, oauth = {} }) {
  if (serviceAccountFile) {
    return new auth.GoogleAuth({ keyFile: serviceAccountFile, scopes: SCOPES });
  }
  if (oauth.clientId && oauth.clientSecret && oauth.refreshToken) {
    const client = new auth.OAuth2(oauth.clientId, oauth.clientSecret);
    client.setCredentials({ refresh_token: oauth.refreshToken });
    return client;
  }
  throw new Error('Chưa cấu hình Google credentials: đặt GOOGLE_SERVICE_ACCOUNT_FILE hoặc GOOGLE_OAUTH_CLIENT_ID/SECRET/REFRESH_TOKEN');
}

export function createSheetsApi(authClient) {
  return sheetsApi({ version: 'v4', auth: authClient });
}

/** 0 -> A, 25 -> Z, 26 -> AA ... */
export function columnLetter(index) {
  let letters = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters;
  }
  return letters;
}

/** Retry on quota (429), server errors (5xx) and transient network errors. */
export function isGoogleRetryable(err) {
  const status = Number(err.response?.status ?? err.status ?? err.code);
  if (status === 429 || status >= 500) return true;
  return ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED'].includes(err.code);
}

/**
 * Thin wrapper over Sheets API v4 for one worksheet.
 * `api` is the object returned by createSheetsApi() (injected so tests can fake it).
 */
export function createSheetsClient({ api, spreadsheetId, sheetName, retry = {}, logger }) {
  const sheetRef = `'${sheetName.replace(/'/g, "''")}'`;
  const run = (label, fn) => withRetry(fn, { ...retry, logger, label: `Sheets ${label}`, isRetryable: isGoogleRetryable });

  /** Reads the whole worksheet. Returns { header: string[], rows: [{ rowNumber, cells }] }. */
  async function readRows() {
    const res = await run('values.get', () => api.spreadsheets.values.get({
      spreadsheetId,
      range: sheetRef,
      valueRenderOption: 'FORMATTED_VALUE', // what users see, e.g. keeps "0912..." as text
    }));
    const [header = [], ...data] = res.data.values || [];
    return {
      header: header.map((h) => String(h).trim()),
      rows: data.map((cells, i) => ({ rowNumber: i + 2, cells: cells.map((c) => String(c ?? '')) })),
    };
  }

  /** Reads only the header row (column names), used by the admin panel. */
  async function readHeader() {
    const res = await run('values.get', () => api.spreadsheets.values.get({ spreadsheetId, range: `${sheetRef}!1:1` }));
    return (res.data.values?.[0] || []).map((h) => String(h).trim()).filter(Boolean);
  }

  async function writeHeader(header) {
    await run('values.update', () => api.spreadsheets.values.update({
      spreadsheetId,
      range: `${sheetRef}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [header] },
    }));
  }

  /** Writes single cells in bulk. cells: [{ row (1-based), col (0-based), value }] */
  async function writeCells(cells) {
    for (let i = 0; i < cells.length; i += WRITE_CHUNK) {
      const data = cells.slice(i, i + WRITE_CHUNK).map((c) => ({
        range: `${sheetRef}!${columnLetter(c.col)}${c.row}`,
        values: [[c.value]],
      }));
      await run('values.batchUpdate', () => api.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: { valueInputOption: 'RAW', data },
      }));
    }
  }

  return { readRows, readHeader, writeHeader, writeCells };
}
