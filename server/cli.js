// Admin commands, run inside the container:
//   docker compose exec finta node server/cli.js backup
//   docker compose exec finta node server/cli.js reset-password you@example.com
//   docker compose exec finta node server/cli.js disable-2fa you@example.com
//   docker compose exec finta node server/cli.js unlock you@example.com
import path from 'node:path';
import crypto from 'node:crypto';
import { loadConfig } from './config.js';
import { openDatabase } from './db.js';
import { hashPassword } from './lib/crypto.js';

const cfg = loadConfig({ ...process.env, NODE_ENV: 'development' });
const db = openDatabase(path.join(cfg.dataDir, 'finta.db'));
const [cmd, arg] = process.argv.slice(2);

function findUser(email) {
  const u = email && db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase());
  if (!u) { console.error(`No account for ${email}`); process.exit(1); }
  return u;
}

switch (cmd) {
  case 'backup': {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const file = path.join(cfg.dataDir, 'backups', `finta-${stamp}.db`);
    (await import('node:fs')).mkdirSync(path.dirname(file), { recursive: true });
    db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    console.log(`Backup written to ${file}`);
    break;
  }
  case 'reset-password': {
    const u = findUser(arg);
    const temp = crypto.randomBytes(9).toString('base64url');
    db.prepare('UPDATE users SET password_hash = ?, failed_logins = 0, locked_until = NULL WHERE id = ?').run(await hashPassword(temp), u.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
    console.log(`Temporary password for ${u.email}: ${temp}\nSign in and change it in Settings → Password.`);
    break;
  }
  case 'disable-2fa': {
    const u = findUser(arg);
    db.prepare('UPDATE users SET totp_secret = NULL, totp_pending = NULL WHERE id = ?').run(u.id);
    db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(u.id);
    console.log(`Two-factor turned off for ${u.email}.`);
    break;
  }
  case 'unlock': {
    const u = findUser(arg);
    db.prepare('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?').run(u.id);
    console.log(`Unlocked ${u.email}.`);
    break;
  }
  default:
    console.log('Commands: backup | reset-password <email> | disable-2fa <email> | unlock <email>');
}
db.close();
