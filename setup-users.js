'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline/promises');

fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true, mode: 0o750 });
const { db, passwordHash } = require('./lib');

async function hiddenPassword(label) {
  if (!process.stdin.isTTY) throw new Error('Jalankan dari terminal interaktif.');
  process.stdout.write(label);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let value = '';
    function cleanup() {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener('data', onData);
      process.stdout.write('\n');
    }
    function onData(data) {
      for (const char of data) {
        if (char === '\u0003') { cleanup(); reject(new Error('Dibatalkan.')); return; }
        if (char === '\r' || char === '\n') { cleanup(); resolve(value); return; }
        if (char === '\u007f') value = value.slice(0, -1);
        else if (char >= ' ') value += char;
      }
    }
    process.stdin.on('data', onData);
  });
}

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const role = (await rl.question('Role (user/admin): ')).trim().toLowerCase();
  const username = (await rl.question('Username: ')).trim();
  rl.close();
  if (!['user', 'admin'].includes(role)) throw new Error('Role harus user atau admin.');
  if (!/^[a-zA-Z0-9_.-]{3,40}$/.test(username)) throw new Error('Username tidak valid.');
  const password = await hiddenPassword('Password (minimal 8 karakter): ');
  const confirm = await hiddenPassword('Ulangi password: ');
  if (password.length < 8) throw new Error('Password minimal 8 karakter.');
  if (password !== confirm) throw new Error('Password tidak sama.');
  db.prepare(`INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)
    ON CONFLICT(username) DO UPDATE SET password_hash=excluded.password_hash, role=excluded.role`)
    .run(username, passwordHash(password), role);
  console.log(`Akun ${username} (${role}) tersimpan.`);
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
