'use strict';

/**
 * Loads .env if present. Real environment variables always win, so a container
 * or systemd unit can override the file without editing it.
 */

const fs = require('fs');
const path = require('path');

const ENV_PATH = path.join(__dirname, '..', '.env');

if (fs.existsSync(ENV_PATH)) {
  const before = { ...process.env };
  try {
    // Node ≥20.6 parses .env natively.
    process.loadEnvFile(ENV_PATH);
  } catch {
    for (const line of fs.readFileSync(ENV_PATH, 'utf8').split('\n')) {
      const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
      if (!m || line.trim().startsWith('#')) continue;
      const value = (m[2] || '').replace(/^(['"])([\s\S]*)\1$/, '$2');
      if (process.env[m[1]] === undefined) process.env[m[1]] = value;
    }
  }
  // Restore anything the real environment had set.
  for (const [key, value] of Object.entries(before)) process.env[key] = value;
}

if (!process.env.SESSION_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    console.error('[afterdark] SESSION_SECRET is required in production. See .env.example.');
    process.exit(1);
  }
  // Development convenience only — sessions and age cookies reset on restart.
  process.env.SESSION_SECRET = require('crypto').randomBytes(32).toString('hex');
}

module.exports = {};
