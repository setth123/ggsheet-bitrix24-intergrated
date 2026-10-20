#!/usr/bin/env node
/**
 * Usage:
 *   node src/cli.js sync    Run one sync now and exit (exit code 1 if it failed)
 *   node src/cli.js serve   Start HTTP API + admin panel + scheduled sync (SYNC_CRON)
 */
import fs from 'node:fs';
import cron from 'node-cron';
import { loadConfig, validateMapping } from './config.js';
import { createLogger } from './logger.js';
import { createGoogleAuth, createSheetsApi, createSheetsClient } from './sheets.js';
import { createBitrixClient } from './bitrix.js';
import { createSyncRunner } from './sync.js';
import { createServer } from './server.js';

try { process.loadEnvFile(); } catch { /* no .env file: use real environment variables */ }

function buildApp(config, logger) {
  const sheets = createSheetsClient({
    api: createSheetsApi(createGoogleAuth(config.google)),
    spreadsheetId: config.google.spreadsheetId,
    sheetName: config.google.sheetName,
    retry: config.retry,
    logger,
  });
  const bitrix = createBitrixClient({
    webhookUrl: config.bitrix.webhookUrl,
    minIntervalMs: config.bitrix.minIntervalMs,
    retry: config.retry,
    logger,
  });
  const runner = createSyncRunner({ sheets, bitrix, mapping: config.mapping, logger });

  /** Used by the admin panel: validate, persist to MAPPING_FILE, apply from the next run. */
  const saveMapping = (mapping) => {
    validateMapping(mapping);
    fs.writeFileSync(config.mappingFile, JSON.stringify(mapping, null, 2) + '\n');
    runner.setMapping(mapping);
    logger.info(`Đã lưu cấu hình mapping mới vào ${config.mappingFile}`);
  };

  return { sheets, bitrix, runner, saveMapping };
}

async function main(command) {
  if (!['sync', 'serve'].includes(command)) {
    console.log('Cách dùng: node src/cli.js <sync|serve>');
    process.exitCode = 1;
    return;
  }

  const config = loadConfig();
  const logger = createLogger({ file: config.logFile });
  const app = buildApp(config, logger);
  const { runner } = app;

  if (command === 'sync') {
    const result = await runner.run('cli');
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  if (!cron.validate(config.schedule)) throw new Error(`SYNC_CRON không hợp lệ: "${config.schedule}"`);
  cron.schedule(config.schedule, () => runner.run('schedule'), { timezone: config.timezone });
  createServer({
    ...app,
    logger,
    adminToken: config.adminToken,
    webhookToken: config.bitrix.outboundToken,
    webhookDelayMs: config.bitrix.webhookDebounceMs,
  }).listen(config.port, () => {
    logger.info(`Server chạy ở cổng ${config.port} (admin: http://localhost:${config.port}/), lịch đồng bộ "${config.schedule}" (${config.timezone})`);
    // Cron only fires at the next matching time (e.g. :00/:15/:30/:45), so sync once right away.
    if (config.syncOnStart) runner.run('startup');
  });
}

main(process.argv[2]).catch((err) => {
  console.error(`Lỗi: ${err.message}`);
  process.exitCode = 1;
});
