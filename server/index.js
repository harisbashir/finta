// Entry point: node server/index.js
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadConfig } from './config.js';
import { openDatabase } from './db.js';
import { createApp } from './app.js';

const cfg = loadConfig();
const db = openDatabase(path.join(cfg.dataDir, 'finta.db'));

let setupCode = '';
if (!db.prepare('SELECT 1 FROM users LIMIT 1').get()) {
  // Nobody can claim a fresh public instance without reading the server log.
  setupCode = (process.env.SETUP_CODE || crypto.randomBytes(5).toString('hex')).toUpperCase();
  console.log('\n┌──────────────────────────────────────────────┐');
  console.log('│  Finta is ready for setup.                   │');
  console.log(`│  Open ${cfg.appUrl.padEnd(39)}│`);
  console.log(`│  Setup code: ${setupCode.padEnd(32)}│`);
  console.log('└──────────────────────────────────────────────┘\n');
}

const server = http.createServer(createApp({ cfg, db, setupCode }));
server.headersTimeout = 20000;
server.requestTimeout = 30000;
server.keepAliveTimeout = 5000;

server.listen(cfg.port, cfg.host, () => {
  console.log(`Finta listening on ${cfg.host}:${cfg.port} (${cfg.production ? 'production' : 'development'})`);
});

function shutdown(signal) {
  console.log(`${signal} received, closing…`);
  server.close(() => {
    try { db.close(); } catch { /* already closed */ }
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
