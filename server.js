'use strict';

const crypto = require('node:crypto');
const { execFile, spawn } = require('node:child_process');
const dns = require('node:dns').promises;
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { promisify } = require('node:util');
const { appRoot, dataDir, db, passwordMatches, tokenHash } = require('./lib');

const execFileAsync = promisify(execFile);

const host = process.env.LV_HOST || '127.0.0.1';
const port = Number(process.env.LV_PORT || 3100);
const publicDir = path.join(appRoot, 'public');
const uploadDir = path.join(dataDir, 'uploads');
const thumbnailDir = path.join(dataDir, 'thumbnails');
const hlsDir = path.join(dataDir, 'hls');
const maxUpload = 500 * 1024 * 1024;
fs.mkdirSync(uploadDir, { recursive: true, mode: 0o750 });
fs.mkdirSync(thumbnailDir, { recursive: true, mode: 0o750 });
fs.mkdirSync(hlsDir, { recursive: true, mode: 0o750 });
db.prepare("UPDATE videos SET conversion_status='failed', conversion_error='Proses terhenti saat layanan dimulai ulang.' WHERE conversion_status='converting'").run();
db.prepare("UPDATE videos SET ingest_status='failed', ingest_error='Download terhenti saat layanan dimulai ulang.' WHERE ingest_status='downloading'").run();

const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t' };
const metadataJobs = new Set();
const conversionJobs = new Map();
const remoteJobs = new Map();
const thumbnailFilter = 'scale=360:640:force_original_aspect_ratio=increase,crop=360:640';
const categoryQuery = db.prepare('SELECT categories.name FROM video_categories JOIN categories ON categories.id=video_categories.category_id WHERE video_categories.video_id=? ORDER BY categories.name COLLATE NOCASE');

function normalizeCategories(value) {
  const input = Array.isArray(value) ? value : String(value || '').split(',');
  const unique = new Map();
  for (const item of input) {
    const name = String(item || '').trim().slice(0, 40); if (name) unique.set(name.toLocaleLowerCase('id'), name);
    if (unique.size >= 10) break;
  }
  return unique.size ? [...unique.values()] : ['Umum'];
}
function setVideoCategories(videoId, value) {
  const names = normalizeCategories(value);
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM video_categories WHERE video_id=?').run(videoId);
    for (const name of names) {
      db.prepare('INSERT OR IGNORE INTO categories (name) VALUES (?)').run(name);
      const category = db.prepare('SELECT id FROM categories WHERE name=? COLLATE NOCASE').get(name);
      db.prepare('INSERT INTO video_categories (video_id,category_id) VALUES (?,?)').run(videoId, category.id);
    }
    db.prepare('UPDATE videos SET category=? WHERE id=?').run(names[0], videoId);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return names;
}

function securityHeaders(extra = {}) {
  return { 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'X-Robots-Tag': 'noindex, nofollow, noarchive', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store', ...extra };
}
function json(res, status, body, extra) {
  res.writeHead(status, securityHeaders({ 'Content-Type': 'application/json; charset=utf-8', ...extra }));
  res.end(JSON.stringify(body));
}
function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map(v => v.trim().split('=').map(decodeURIComponent)).filter(v => v.length === 2));
}
function currentUser(req) {
  const token = parseCookies(req).lv_session;
  if (!token) return null;
  return db.prepare(`SELECT users.id, users.username, users.role FROM sessions JOIN users ON users.id=sessions.user_id
    WHERE sessions.token_hash=? AND sessions.expires_at>?`).get(tokenHash(token), Date.now()) || null;
}
function requireUser(req, res, role) {
  const user = currentUser(req);
  if (!user) { json(res, 401, { error: 'Silakan login.' }); return null; }
  if (role && user.role !== role) { json(res, 403, { error: 'Akses ditolak.' }); return null; }
  return user;
}
async function readJson(req, limit = 64 * 1024) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw new Error('PAYLOAD_TOO_LARGE'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw new Error('INVALID_JSON'); }
}
function cleanVideo(row) {
  const isHls = Boolean(row.hls_manifest);
  const categories = categoryQuery.all(row.id).map(item => item.name);
  return {
    id: row.id,
    title: row.title,
    caption: row.caption,
    category: categories[0] || row.category || 'Umum',
    categories: categories.length ? categories : [row.category || 'Umum'],
    sourceType: row.source_type,
    src: row.source_type === 'url' ? row.source : (isHls ? `/hls/${row.id}/index.m3u8` : `/media/${row.id}`),
    playbackType: isHls ? 'hls' : 'file',
    sortOrder: row.sort_order,
    durationSeconds: row.duration_seconds,
    sizeBytes: row.size_bytes,
    thumbnail: row.thumbnail ? `/thumbnail/${row.id}?v=${encodeURIComponent(row.thumbnail)}` : null,
    conversionStatus: row.conversion_status || 'none',
    conversionError: row.conversion_error || null,
    conversionProgress: conversionJobs.get(Number(row.id))?.progress || 0,
    originalDeleted: Boolean(row.original_deleted),
    originalName: row.source_type === 'upload' ? path.basename(row.source) : null,
    nativeTs: row.source_type === 'upload' && path.extname(row.source).toLowerCase() === '.ts',
    liked: Boolean(row.liked),
    likeCount: Number(row.like_count || 0),
    ingestStatus: row.ingest_status || 'ready',
    ingestError: row.ingest_error || null,
    ingestProgress: remoteJobs.get(Number(row.id))?.progress || 0
  };
}
async function inspectVideo(id) {
  id = Number(id);
  if (metadataJobs.has(id)) return;
  const row = db.prepare("SELECT * FROM videos WHERE id=? AND source_type='upload'").get(id);
  if (!row || row.original_deleted) return;
  const input = path.join(uploadDir, path.basename(row.source));
  if (!fs.existsSync(input)) return;
  metadataJobs.add(id);
  try {
    const stat = fs.statSync(input);
    const { stdout } = await execFileAsync('/usr/bin/ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', input], { maxBuffer: 1024 * 1024 });
    const duration = Number.parseFloat(stdout) || null;
    const thumbnail = `${id}.jpg`;
    const thumbnailPath = path.join(thumbnailDir, thumbnail);
    const seek = duration ? Math.min(Math.max(duration * 0.15, 0), 5).toFixed(2) : '0';
    await execFileAsync('/usr/bin/ffmpeg', ['-y', '-i', input, '-ss', seek, '-frames:v', '1', '-vf', thumbnailFilter, '-pix_fmt', 'yuvj420p', '-threads', '1', '-q:v', '4', thumbnailPath], { maxBuffer: 4 * 1024 * 1024 });
    if (path.extname(row.source).toLowerCase() === '.ts' && duration) {
      const target = path.join(hlsDir, String(id));
      fs.mkdirSync(target, { recursive: true, mode: 0o750 });
      const playlist = `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:${Math.max(1, Math.ceil(duration))}\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:${duration.toFixed(6)},\nsource.ts\n#EXT-X-ENDLIST\n`;
      fs.writeFileSync(path.join(target, 'index.m3u8'), playlist, { mode: 0o640 });
      db.prepare("UPDATE videos SET duration_seconds=?, size_bytes=?, thumbnail=?, thumbnail_version=2, hls_manifest='index.m3u8', conversion_status='converted', conversion_error=NULL WHERE id=?").run(duration, stat.size, thumbnail, id);
    } else {
      db.prepare('UPDATE videos SET duration_seconds=?, size_bytes=?, thumbnail=?, thumbnail_version=2 WHERE id=?').run(duration, stat.size, thumbnail, id);
    }
  } catch (error) {
    console.error(`metadata ${id}:`, error.message);
  } finally {
    metadataJobs.delete(id);
  }
}
function scheduleMetadata(id) { inspectVideo(id).catch(error => console.error(error)); }
function syncUploadDirectory() {
  const known = new Set(db.prepare("SELECT source FROM videos WHERE source_type='upload'").all().map(row => row.source));
  const allowed = new Map([['.mp4', 'video/mp4'], ['.webm', 'video/webm'], ['.mov', 'video/quicktime'], ['.ts', 'video/mp2t']]);
  const summary = { added: 0, existing: 0, skipped: 0 };
  for (const file of fs.readdirSync(uploadDir)) {
    const extension = path.extname(file).toLowerCase();
    const isFile = fs.statSync(path.join(uploadDir, file)).isFile();
    if (!isFile || !allowed.has(extension)) { summary.skipped += 1; continue; }
    if (known.has(file)) { summary.existing += 1; continue; }
    if (!known.has(file)) {
      const title = path.basename(file, extension).replace(/[-_]+/g, ' ').trim() || 'LV';
      const randomName = `${crypto.randomUUID()}${extension}`;
      const originalPath = path.join(uploadDir, file);
      const randomPath = path.join(uploadDir, randomName);
      try {
        fs.renameSync(originalPath, randomPath);
        const result = db.prepare('INSERT INTO videos (title, caption, source_type, source, mime_type, sort_order) VALUES (?, ?, ?, ?, ?, ?)')
          .run(title.slice(0, 120), '', 'upload', randomName, allowed.get(extension), Date.now());
        setVideoCategories(result.lastInsertRowid, ['Umum']);
        scheduleMetadata(result.lastInsertRowid);
        summary.added += 1;
      } catch (error) {
        if (fs.existsSync(randomPath) && !fs.existsSync(originalPath)) fs.renameSync(randomPath, originalPath);
        console.error(`sync ${file}:`, error.message);
        summary.skipped += 1;
      }
    }
  }
  for (const row of db.prepare("SELECT id FROM videos WHERE source_type='upload' AND original_deleted=0 AND (duration_seconds IS NULL OR thumbnail IS NULL OR thumbnail_version<2)").all()) scheduleMetadata(row.id);
  return summary;
}
function isPrivateAddress(address) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
    const [, , c] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 0 && c === 2))) || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113) || a >= 224;
  }
  if (net.isIPv6(address)) {
    const value = address.toLowerCase();
    if (value === '::' || value === '::1' || value.startsWith('fc') || value.startsWith('fd') || value.startsWith('ff') || value.startsWith('2001:db8') || /^fe[89ab]/.test(value)) return true;
    if (value.startsWith('::ffff:')) return isPrivateAddress(value.slice(7));
    return false;
  }
  return true;
}
async function validateRemoteUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('URL tidak valid.');
  if (url.hostname === 'localhost' || url.hostname.endsWith('.local')) throw new Error('Alamat internal tidak diizinkan.');
  const addresses = await dns.lookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(item => isPrivateAddress(item.address))) throw new Error('Alamat internal tidak diizinkan.');
  return url;
}
async function fetchRemote(value, signal, redirects = 0) {
  if (redirects > 5) throw new Error('Terlalu banyak redirect.');
  const url = await validateRemoteUrl(value);
  const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.any([signal, AbortSignal.timeout(10 * 60 * 1000)]), headers: { 'User-Agent': 'LV/1.0' } });
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const location = response.headers.get('location'); if (!location) throw new Error('Redirect tidak valid.');
    return fetchRemote(new URL(location, url).href, signal, redirects + 1);
  }
  if (!response.ok || !response.body) throw new Error(`Server sumber merespons ${response.status}.`);
  return { response, finalUrl: url.href };
}
async function downloadRemote(row, sourceUrl) {
  const id = Number(row.id);
  const job = { progress: 0, controller: new AbortController() };
  remoteJobs.set(id, job);
  const temporary = path.join(uploadDir, path.basename(row.source));
  let output;
  try {
    const { response, finalUrl } = await fetchRemote(sourceUrl, job.controller.signal);
    const type = String(response.headers.get('content-type') || '').split(';')[0].toLowerCase();
    const typeExtensions = { 'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov', 'video/mp2t': '.ts' };
    const urlExtension = path.extname(new URL(finalUrl).pathname).toLowerCase();
    const extensionTypes = { '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.ts': 'video/mp2t' };
    const extension = typeExtensions[type] || (extensionTypes[urlExtension] ? urlExtension : null);
    const mimeType = typeExtensions[type] ? type : extensionTypes[urlExtension];
    if (!extension || !mimeType) throw new Error('URL bukan berkas MP4, WebM, MOV, atau TS.');
    const declaredLength = Number(response.headers.get('content-length') || 0);
    if (declaredLength > maxUpload) throw new Error('Ukuran video melebihi 500 MB.');
    output = fs.createWriteStream(temporary, { mode: 0o640, flags: 'wx' });
    let received = 0;
    for await (const chunk of response.body) {
      received += chunk.length; if (received > maxUpload) throw new Error('Ukuran video melebihi 500 MB.');
      job.progress = declaredLength ? Math.min(99, Math.round(received / declaredLength * 100)) : 0;
      if (!output.write(chunk)) await new Promise(resolve => output.once('drain', resolve));
    }
    await new Promise((resolve, reject) => { output.end(resolve); output.on('error', reject); });
    const filename = `${crypto.randomUUID()}${extension}`;
    fs.renameSync(temporary, path.join(uploadDir, filename));
    db.prepare("UPDATE videos SET source=?, mime_type=?, source_url=?, ingest_status='ready', ingest_error=NULL WHERE id=?").run(filename, mimeType, finalUrl, id);
    scheduleMetadata(id);
  } catch (error) {
    output?.destroy(); fs.rmSync(temporary, { force: true });
    if (db.prepare('SELECT 1 FROM videos WHERE id=?').get(id)) db.prepare("UPDATE videos SET ingest_status='failed', ingest_error=? WHERE id=?").run((error.name === 'AbortError' ? 'Download dibatalkan.' : error.message).slice(0, 500), id);
  } finally { remoteJobs.delete(id); }
}
function serveStatic(req, res, name) {
  const file = path.join(publicDir, name);
  fs.readFile(file, (error, data) => {
    if (error) return json(res, 404, { error: 'Tidak ditemukan.' });
    res.writeHead(200, securityHeaders({ 'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'Content-Security-Policy': "default-src 'self'; media-src 'self' https: blob:; style-src 'self'; script-src 'self'; connect-src 'self'" }));
    if (req.method === 'HEAD') { res.end(); return; }
    res.end(data);
  });
}
function servePrivateFile(req, res, file, contentType, cache = 'private, max-age=3600') {
  let stat; try { stat = fs.statSync(file); } catch { return json(res, 404, { error: 'Berkas tidak ditemukan.' }); }
  if (!stat.isFile()) return json(res, 404, { error: 'Berkas tidak ditemukan.' });
  res.writeHead(200, securityHeaders({ 'Content-Type': contentType, 'Content-Length': stat.size, 'Cache-Control': cache }));
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}
function serveMedia(req, res, id) {
  const user = requireUser(req, res); if (!user) return;
  const video = db.prepare("SELECT source, mime_type, conversion_status, ingest_status FROM videos WHERE id=? AND source_type='upload'").get(id);
  if (!video) return json(res, 404, { error: 'Video tidak ditemukan.' });
  if (video.ingest_status !== 'ready') return json(res, 404, { error: 'Video belum tersedia.' });
  if (user.role !== 'admin' && video.conversion_status === 'converting') return json(res, 404, { error: 'Video belum tersedia.' });
  const file = path.join(uploadDir, path.basename(video.source));
  let stat; try { stat = fs.statSync(file); } catch { return json(res, 404, { error: 'Berkas tidak ditemukan.' }); }
  const range = req.headers.range;
  if (!range) {
    res.writeHead(200, securityHeaders({ 'Content-Type': video.mime_type || 'video/mp4', 'Content-Length': stat.size, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=3600' }));
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(file).pipe(res); return;
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) { res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); res.end(); return; }
  const start = match[1] ? Number(match[1]) : 0;
  const end = match[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1;
  if (start > end || start >= stat.size) { res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); res.end(); return; }
  res.writeHead(206, securityHeaders({ 'Content-Type': video.mime_type || 'video/mp4', 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=3600' }));
  if (req.method === 'HEAD') { res.end(); return; }
  fs.createReadStream(file, { start, end }).pipe(res);
}

async function upload(req, res, url) {
  if (!requireUser(req, res, 'admin')) return;
  const length = Number(req.headers['content-length'] || 0);
  const type = String(req.headers['content-type'] || '').split(';')[0];
  if (!['video/mp4', 'video/webm', 'video/quicktime', 'video/mp2t'].includes(type)) return json(res, 415, { error: 'Gunakan MP4, WebM, MOV, atau TS.' });
  if (!length || length > maxUpload) return json(res, 413, { error: 'Ukuran maksimum 500 MB.' });
  const extension = { 'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov', 'video/mp2t': '.ts' }[type];
  const filename = `${crypto.randomUUID()}${extension}`;
  const target = path.join(uploadDir, filename);
  let received = 0;
  const output = fs.createWriteStream(target, { mode: 0o640, flags: 'wx' });
  try {
    for await (const chunk of req) { received += chunk.length; if (received > maxUpload) throw new Error('TOO_LARGE'); if (!output.write(chunk)) await new Promise(resolve => output.once('drain', resolve)); }
    await new Promise((resolve, reject) => { output.end(resolve); output.on('error', reject); });
    const title = (url.searchParams.get('title') || 'Tanpa judul').slice(0, 120);
    const caption = (url.searchParams.get('caption') || '').slice(0, 500);
    const category = (url.searchParams.get('category') || 'Umum').trim().slice(0, 40) || 'Umum';
    const result = db.prepare('INSERT INTO videos (title, caption, category, source_type, source, mime_type, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)').run(title, caption, category, 'upload', filename, type, Date.now());
    setVideoCategories(result.lastInsertRowid, category);
    scheduleMetadata(result.lastInsertRowid);
    json(res, 201, cleanVideo(db.prepare('SELECT * FROM videos WHERE id=?').get(result.lastInsertRowid)));
  } catch (error) { output.destroy(); fs.rmSync(target, { force: true }); json(res, error.message === 'TOO_LARGE' ? 413 : 500, { error: 'Upload gagal.' }); }
}

async function replaceThumbnail(req, res, id) {
  if (!requireUser(req, res, 'admin')) return;
  const row = db.prepare('SELECT * FROM videos WHERE id=?').get(id);
  if (!row) return json(res, 404, { error: 'Video tidak ditemukan.' });
  const length = Number(req.headers['content-length'] || 0);
  const type = String(req.headers['content-type'] || '').split(';')[0];
  const extensions = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
  if (!extensions[type]) return json(res, 415, { error: 'Gunakan JPG, PNG, atau WebP.' });
  if (!length || length > 5 * 1024 * 1024) return json(res, 413, { error: 'Thumbnail maksimum 5 MB.' });
  const temporary = path.join(thumbnailDir, `${id}-${crypto.randomUUID()}${extensions[type]}`);
  const filename = `${id}-${Date.now()}.jpg`;
  const target = path.join(thumbnailDir, filename);
  const output = fs.createWriteStream(temporary, { mode: 0o640, flags: 'wx' });
  try {
    let received = 0;
    for await (const chunk of req) { received += chunk.length; if (received > 5 * 1024 * 1024) throw new Error('TOO_LARGE'); if (!output.write(chunk)) await new Promise(resolve => output.once('drain', resolve)); }
    await new Promise((resolve, reject) => { output.end(resolve); output.on('error', reject); });
    await execFileAsync('/usr/bin/ffmpeg', ['-y', '-i', temporary, '-frames:v', '1', '-vf', thumbnailFilter, '-pix_fmt', 'yuvj420p', '-threads', '1', '-q:v', '4', target], { maxBuffer: 4 * 1024 * 1024 });
    if (row.thumbnail) fs.rmSync(path.join(thumbnailDir, path.basename(row.thumbnail)), { force: true });
    db.prepare('UPDATE videos SET thumbnail=?, thumbnail_version=2 WHERE id=?').run(filename, row.id);
    return json(res, 200, { thumbnail: `/thumbnail/${row.id}?v=${encodeURIComponent(filename)}` });
  } catch (error) {
    fs.rmSync(target, { force: true });
    return json(res, error.message === 'TOO_LARGE' ? 413 : 400, { error: 'Thumbnail tidak dapat diproses.' });
  } finally { output.destroy(); fs.rmSync(temporary, { force: true }); }
}

async function captureThumbnail(req, res, id) {
  if (!requireUser(req, res, 'admin')) return;
  const row = db.prepare('SELECT * FROM videos WHERE id=?').get(id);
  if (!row) return json(res, 404, { error: 'Video tidak ditemukan.' });
  const body = await readJson(req);
  const requestedTime = Number(body.time || 0);
  const time = Math.max(0, Math.min(Number.isFinite(requestedTime) ? requestedTime : 0, Math.max(0, Number(row.duration_seconds || 0) - 0.05)));
  const original = row.source_type === 'upload' ? path.join(uploadDir, path.basename(row.source)) : null;
  const manifest = row.hls_manifest ? path.join(hlsDir, String(row.id), path.basename(row.hls_manifest)) : null;
  const input = original && fs.existsSync(original) ? original : (manifest && fs.existsSync(manifest) ? manifest : null);
  if (!input) return json(res, 409, { error: 'Frame hanya dapat diambil dari video lokal.' });
  const filename = `${row.id}-${Date.now()}.jpg`;
  const target = path.join(thumbnailDir, filename);
  try {
    await execFileAsync('/usr/bin/ffmpeg', ['-y', '-i', input, '-ss', time.toFixed(3), '-frames:v', '1', '-vf', thumbnailFilter, '-pix_fmt', 'yuvj420p', '-threads', '1', '-q:v', '4', target], { maxBuffer: 4 * 1024 * 1024 });
    if (row.thumbnail) fs.rmSync(path.join(thumbnailDir, path.basename(row.thumbnail)), { force: true });
    db.prepare('UPDATE videos SET thumbnail=?, thumbnail_version=2 WHERE id=?').run(filename, row.id);
    return json(res, 200, { thumbnail: `/thumbnail/${row.id}?v=${encodeURIComponent(filename)}` });
  } catch (error) {
    fs.rmSync(target, { force: true });
    console.error(`thumbnail frame ${row.id}:`, error.message);
    return json(res, 400, { error: 'Frame tidak dapat digunakan.' });
  }
}

function runConversion(row) {
  const id = Number(row.id);
  const input = path.join(uploadDir, path.basename(row.source));
  const workingDir = path.join(hlsDir, `${id}.working`);
  const finalDir = path.join(hlsDir, String(id));
  fs.rmSync(workingDir, { recursive: true, force: true });
  fs.mkdirSync(workingDir, { recursive: true, mode: 0o750 });
  db.prepare("UPDATE videos SET conversion_status='converting', conversion_error=NULL WHERE id=?").run(id);
  const job = { progress: 0, process: null };
  conversionJobs.set(id, job);
  const args = [
    '-y', '-i', input, '-threads', '1',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
    '-c:a', 'aac', '-b:a', '128k',
    '-hls_time', '4', '-hls_playlist_type', 'vod',
    '-hls_segment_filename', path.join(workingDir, 'segment_%05d.ts'),
    '-progress', 'pipe:2', '-nostats', path.join(workingDir, 'index.m3u8')
  ];
  const child = spawn('/usr/bin/ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] });
  job.process = child;
  child.stdin.end();
  child.stdout.resume();
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => {
    stderr = (stderr + chunk).slice(-8000);
    const matches = [...chunk.matchAll(/out_time_us=(\d+)/g)];
    if (matches.length && row.duration_seconds) job.progress = Math.min(99, Math.round((Number(matches.at(-1)[1]) / 1000000) / row.duration_seconds * 100));
  });
  child.on('error', error => {
    fs.rmSync(workingDir, { recursive: true, force: true });
    db.prepare("UPDATE videos SET conversion_status='failed', conversion_error=? WHERE id=?").run(error.message.slice(0, 500), id);
    conversionJobs.delete(id);
  });
  child.on('close', code => {
    if (code === 0 && fs.existsSync(path.join(workingDir, 'index.m3u8'))) {
      fs.rmSync(finalDir, { recursive: true, force: true });
      fs.renameSync(workingDir, finalDir);
      db.prepare("UPDATE videos SET hls_manifest='index.m3u8', conversion_status='converted', conversion_error=NULL WHERE id=?").run(id);
    } else {
      fs.rmSync(workingDir, { recursive: true, force: true });
      const detail = stderr.split('\n').filter(Boolean).slice(-3).join(' ').slice(0, 500) || `ffmpeg keluar dengan kode ${code}`;
      db.prepare("UPDATE videos SET conversion_status='failed', conversion_error=? WHERE id=?").run(detail, id);
    }
    conversionJobs.delete(id);
  });
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/robots.txt') {
    res.writeHead(200, securityHeaders({ 'Content-Type': 'text/plain; charset=utf-8' }));
    if (req.method === 'HEAD') return res.end();
    return res.end('User-agent: *\nDisallow: /\n');
  }
  if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/') return serveStatic(req, res, 'index.html');
  if ((req.method === 'GET' || req.method === 'HEAD') && ['/app.css', '/app.js'].includes(url.pathname)) return serveStatic(req, res, url.pathname.slice(1));
  if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/vendor/hls.min.js') {
    return servePrivateFile(req, res, path.join(appRoot, 'node_modules', 'hls.js', 'dist', 'hls.min.js'), 'application/javascript; charset=utf-8', 'private, max-age=86400');
  }
  if (req.method === 'GET' && url.pathname === '/api/me') { const user = currentUser(req); return json(res, 200, { user }); }
  if (req.method === 'POST' && url.pathname === '/api/login') {
    const body = await readJson(req); const username = String(body.username || '').slice(0, 40); const password = String(body.password || '');
    const user = db.prepare('SELECT * FROM users WHERE username=? COLLATE NOCASE').get(username);
    if (!user || !passwordMatches(password, user.password_hash)) return json(res, 401, { error: 'Username atau password salah.' });
    const token = crypto.randomBytes(32).toString('base64url'); const expires = Date.now() + 7 * 86400000;
    db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(Date.now());
    db.prepare('INSERT INTO sessions (token_hash,user_id,expires_at) VALUES (?,?,?)').run(tokenHash(token), user.id, expires);
    return json(res, 200, { user: { id: user.id, username: user.username, role: user.role } }, { 'Set-Cookie': `lv_session=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=604800` });
  }
  if (req.method === 'POST' && url.pathname === '/api/logout') {
    const token = parseCookies(req).lv_session; if (token) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(tokenHash(token));
    return json(res, 200, { ok: true }, { 'Set-Cookie': 'lv_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0' });
  }
  if (req.method === 'GET' && url.pathname === '/api/categories') {
    if (!requireUser(req, res)) return;
    const categories = db.prepare(`SELECT categories.name, COUNT(*) AS video_count,
      (SELECT sample_videos.id FROM video_categories sample_video_categories
        JOIN videos sample_videos ON sample_videos.id=sample_video_categories.video_id
        WHERE sample_video_categories.category_id=categories.id
          AND sample_videos.ingest_status='ready' AND sample_videos.conversion_status!='converting'
          AND sample_videos.thumbnail IS NOT NULL
        ORDER BY random() LIMIT 1) AS thumbnail_id
      FROM categories
      JOIN video_categories ON video_categories.category_id=categories.id
      JOIN videos ON videos.id=video_categories.video_id
      WHERE videos.ingest_status='ready' AND videos.conversion_status!='converting'
      GROUP BY categories.id, categories.name
      ORDER BY random() LIMIT 10`).all().map(category => ({
        name: category.name,
        videoCount: Number(category.video_count),
        thumbnail: category.thumbnail_id ? `/thumbnail/${category.thumbnail_id}?browse=${Date.now()}` : null
      }));
    return json(res, 200, { categories });
  }
  if (req.method === 'GET' && url.pathname === '/api/videos') {
    const user = requireUser(req, res); if (!user) return;
    const requestedPage = Number.parseInt(url.searchParams.get('page') || '', 10);
    if (Number.isFinite(requestedPage) && requestedPage > 0) {
      const limit = Math.min(50, Math.max(1, Number.parseInt(url.searchParams.get('limit') || '10', 10) || 10));
      const clauses = []; const parameters = [];
      if (user.role !== 'admin') clauses.push("videos.conversion_status!='converting' AND videos.ingest_status='ready'");
      const category = String(url.searchParams.get('category') || '').trim().slice(0, 40);
      if (category) {
        clauses.push(`EXISTS (SELECT 1 FROM video_categories filter_video_categories
          JOIN categories filter_categories ON filter_categories.id=filter_video_categories.category_id
          WHERE filter_video_categories.video_id=videos.id AND filter_categories.name=? COLLATE NOCASE)`);
        parameters.push(category);
      }
      const search = String(url.searchParams.get('q') || '').trim().slice(0, 80);
      if (search) {
        const pattern = `%${search.replace(/[\\%_]/g, value => `\\${value}`)}%`;
        clauses.push(`(videos.title LIKE ? ESCAPE '\\' COLLATE NOCASE
          OR videos.caption LIKE ? ESCAPE '\\' COLLATE NOCASE
          OR EXISTS (SELECT 1 FROM video_categories search_video_categories
            JOIN categories search_categories ON search_categories.id=search_video_categories.category_id
            WHERE search_video_categories.video_id=videos.id
              AND search_categories.name LIKE ? ESCAPE '\\' COLLATE NOCASE))`);
        parameters.push(pattern, pattern, pattern);
      }
      if (user.role === 'admin') {
        const status = url.searchParams.get('status') || '';
        const statusClauses = {
          ready: "videos.ingest_status='ready' AND videos.conversion_status='converted'",
          unoptimised: "videos.ingest_status='ready' AND videos.conversion_status NOT IN ('converted','converting','failed') AND videos.duration_seconds IS NOT NULL AND lower(videos.source) NOT LIKE '%.ts'",
          processing: "videos.ingest_status='downloading' OR videos.conversion_status='converting' OR (videos.ingest_status='ready' AND videos.duration_seconds IS NULL)",
          failed: "videos.ingest_status='failed' OR videos.conversion_status='failed'"
        };
        if (Object.hasOwn(statusClauses, status)) clauses.push(`(${statusClauses[status]})`);
      }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const sortOrders = {
        newest: 'videos.sort_order DESC, videos.id DESC',
        oldest: 'videos.sort_order ASC, videos.id ASC',
        'title-asc': 'videos.title COLLATE NOCASE ASC, videos.id DESC',
        'duration-desc': 'videos.duration_seconds IS NULL ASC, videos.duration_seconds DESC, videos.id DESC',
        'size-desc': 'videos.size_bytes IS NULL ASC, videos.size_bytes DESC, videos.id DESC'
      };
      const requestedSort = url.searchParams.get('sort') || '';
      const requestedSeed = Number.parseInt(url.searchParams.get('seed') || '', 10);
      const shuffleSeed = Number.isFinite(requestedSeed) && requestedSeed > 0 ? Math.min(1000000, requestedSeed) : 0;
      const shuffleFactor = shuffleSeed * 2 + 1;
      const shuffleOffset = shuffleSeed * 48271 % 2147483647;
      const order = user.role === 'admin' && Object.hasOwn(sortOrders, requestedSort)
        ? sortOrders[requestedSort]
        : user.role !== 'admin' && shuffleSeed
          ? `((videos.id * ${shuffleFactor} + ${shuffleOffset}) & 2147483647) ASC, videos.id DESC`
          : sortOrders.newest;
      const select = `SELECT videos.*,
        EXISTS(SELECT 1 FROM video_likes WHERE video_likes.user_id=? AND video_likes.video_id=videos.id) AS liked,
        (SELECT COUNT(*) FROM video_likes WHERE video_likes.video_id=videos.id) AS like_count
        FROM videos ${where} ORDER BY ${order}`;
      const total = db.prepare(`SELECT COUNT(*) AS total FROM videos ${where}`).get(...parameters).total;
      const totalPages = Math.max(1, Math.ceil(total / limit));
      const page = Math.min(requestedPage, totalPages);
      const rows = db.prepare(`${select} LIMIT ? OFFSET ?`).all(user.id, ...parameters, limit, (page - 1) * limit);
      const facets = user.role === 'admin' ? {
        categories: db.prepare(`SELECT DISTINCT categories.name FROM categories
          JOIN video_categories ON video_categories.category_id=categories.id
          ORDER BY categories.name COLLATE NOCASE`).all().map(item => item.name)
      } : null;
      return json(res, 200, { videos: rows.map(cleanVideo), pagination: { page, limit, total, totalPages }, facets });
    }
    const visibility = user.role === 'admin' ? '' : "WHERE videos.conversion_status!='converting' AND videos.ingest_status='ready'";
    const select = `SELECT videos.*,
      EXISTS(SELECT 1 FROM video_likes WHERE video_likes.user_id=? AND video_likes.video_id=videos.id) AS liked,
      (SELECT COUNT(*) FROM video_likes WHERE video_likes.video_id=videos.id) AS like_count
      FROM videos ${visibility} ORDER BY sort_order DESC, id DESC`;
    const rows = db.prepare(select).all(user.id);
    return json(res, 200, { videos: rows.map(cleanVideo), pagination: null });
  }
  if (req.method === 'POST' && url.pathname === '/api/videos/sync') {
    if (!requireUser(req, res, 'admin')) return;
    return json(res, 200, syncUploadDirectory());
  }
  if (req.method === 'POST' && url.pathname === '/api/videos/upload') return upload(req, res, url);
  if (req.method === 'POST' && url.pathname === '/api/videos/url') {
    if (!requireUser(req, res, 'admin')) return; const body = await readJson(req); let source;
    try { source = await validateRemoteUrl(String(body.url)); } catch (error) { return json(res, 400, { error: error.message || 'URL video tidak valid.' }); }
    const fallbackTitle = path.basename(source.pathname, path.extname(source.pathname)).replace(/[-_]+/g, ' ').trim() || 'Tanpa judul';
    const temporary = `${crypto.randomUUID()}.part`;
    const categories = normalizeCategories(body.categories || body.category);
    const result = db.prepare("INSERT INTO videos (title,caption,category,source_type,source,sort_order,source_url,ingest_status) VALUES (?,?,?,?,?,?,?,'downloading')").run(String(body.title || fallbackTitle).slice(0,120), String(body.caption || '').slice(0,500), categories[0], 'upload', temporary, Date.now(), source.href);
    setVideoCategories(result.lastInsertRowid, categories);
    const row = db.prepare('SELECT * FROM videos WHERE id=?').get(result.lastInsertRowid);
    downloadRemote(row, source.href).catch(error => console.error(error));
    return json(res, 202, cleanVideo(row));
  }
  const editMatch = /^\/api\/videos\/(\d+)$/.exec(url.pathname);
  if (req.method === 'PATCH' && editMatch) {
    if (!requireUser(req, res, 'admin')) return;
    const row = db.prepare('SELECT id FROM videos WHERE id=?').get(editMatch[1]);
    if (!row) return json(res, 404, { error: 'Video tidak ditemukan.' });
    const body = await readJson(req);
    const title = String(body.title || '').trim().slice(0, 120);
    if (!title) return json(res, 400, { error: 'Judul wajib diisi.' });
    const categories = normalizeCategories(body.categories || body.category);
    const caption = String(body.caption || '').trim().slice(0, 500);
    db.prepare('UPDATE videos SET title=?, caption=? WHERE id=?').run(title, caption, row.id);
    setVideoCategories(row.id, categories);
    return json(res, 200, { ok: true });
  }
  const thumbnailUploadMatch = /^\/api\/videos\/(\d+)\/thumbnail$/.exec(url.pathname);
  if (req.method === 'POST' && thumbnailUploadMatch) return replaceThumbnail(req, res, thumbnailUploadMatch[1]);
  const thumbnailFrameMatch = /^\/api\/videos\/(\d+)\/thumbnail\/frame$/.exec(url.pathname);
  if (req.method === 'POST' && thumbnailFrameMatch) return captureThumbnail(req, res, thumbnailFrameMatch[1]);
  const convertMatch = /^\/api\/videos\/(\d+)\/convert$/.exec(url.pathname);
  if (req.method === 'POST' && convertMatch) {
    if (!requireUser(req, res, 'admin')) return;
    const row = db.prepare("SELECT * FROM videos WHERE id=? AND source_type='upload'").get(convertMatch[1]);
    if (!row) return json(res, 404, { error: 'Video lokal tidak ditemukan.' });
    if (row.ingest_status !== 'ready') return json(res, 409, { error: 'Download belum selesai.' });
    if (row.original_deleted || !fs.existsSync(path.join(uploadDir, path.basename(row.source)))) return json(res, 409, { error: 'MP4 asli tidak tersedia.' });
    if (path.extname(row.source).toLowerCase() === '.ts') return json(res, 409, { error: 'Berkas sudah berformat TS.' });
    if (conversionJobs.has(Number(row.id)) || row.conversion_status === 'converting') return json(res, 409, { error: 'Konversi sedang berjalan.' });
    if (row.hls_manifest && row.conversion_status === 'converted') return json(res, 409, { error: 'Video sudah dikonversi.' });
    runConversion(row);
    return json(res, 202, { ok: true });
  }
  const originalMatch = /^\/api\/videos\/(\d+)\/original$/.exec(url.pathname);
  if (req.method === 'DELETE' && originalMatch) {
    if (!requireUser(req, res, 'admin')) return;
    const row = db.prepare("SELECT * FROM videos WHERE id=? AND source_type='upload'").get(originalMatch[1]);
    if (!row) return json(res, 404, { error: 'Video tidak ditemukan.' });
    if (path.extname(row.source).toLowerCase() === '.ts') return json(res, 409, { error: 'Berkas ini berasal dari TS.' });
    if (row.conversion_status !== 'converted' || !row.hls_manifest) return json(res, 409, { error: 'Konversi HLS belum selesai.' });
    fs.rmSync(path.join(uploadDir, path.basename(row.source)), { force: true });
    db.prepare('UPDATE videos SET original_deleted=1 WHERE id=?').run(row.id);
    return json(res, 200, { ok: true });
  }
  const likeMatch = /^\/api\/videos\/(\d+)\/like$/.exec(url.pathname);
  if ((req.method === 'POST' || req.method === 'DELETE') && likeMatch) {
    const user = requireUser(req, res); if (!user) return;
    if (!db.prepare('SELECT 1 FROM videos WHERE id=?').get(likeMatch[1])) return json(res, 404, { error: 'Video tidak ditemukan.' });
    if (req.method === 'POST') db.prepare('INSERT OR IGNORE INTO video_likes (user_id,video_id) VALUES (?,?)').run(user.id, likeMatch[1]);
    else db.prepare('DELETE FROM video_likes WHERE user_id=? AND video_id=?').run(user.id, likeMatch[1]);
    const count = db.prepare('SELECT COUNT(*) AS count FROM video_likes WHERE video_id=?').get(likeMatch[1]).count;
    return json(res, 200, { liked: req.method === 'POST', likeCount: count });
  }
  const deleteMatch = /^\/api\/videos\/(\d+)$/.exec(url.pathname);
  if (req.method === 'DELETE' && deleteMatch) {
    if (!requireUser(req, res, 'admin')) return; const row = db.prepare('SELECT * FROM videos WHERE id=?').get(deleteMatch[1]);
    if (!row) return json(res, 404, { error: 'Video tidak ditemukan.' });
    if (conversionJobs.has(Number(row.id))) return json(res, 409, { error: 'Tunggu konversi selesai.' });
    if (remoteJobs.has(Number(row.id))) remoteJobs.get(Number(row.id)).controller.abort();
    db.prepare('DELETE FROM videos WHERE id=?').run(row.id);
    if (row.source_type === 'upload') fs.rmSync(path.join(uploadDir, path.basename(row.source)), { force: true });
    if (row.thumbnail) fs.rmSync(path.join(thumbnailDir, path.basename(row.thumbnail)), { force: true });
    fs.rmSync(path.join(hlsDir, String(row.id)), { recursive: true, force: true });
    return json(res, 200, { ok: true });
  }
  const thumbnailMatch = /^\/thumbnail\/(\d+)$/.exec(url.pathname);
  if ((req.method === 'GET' || req.method === 'HEAD') && thumbnailMatch) {
    if (!requireUser(req, res)) return;
    const row = db.prepare('SELECT thumbnail FROM videos WHERE id=?').get(thumbnailMatch[1]);
    if (!row?.thumbnail) return json(res, 404, { error: 'Thumbnail belum tersedia.' });
    return servePrivateFile(req, res, path.join(thumbnailDir, path.basename(row.thumbnail)), 'image/jpeg');
  }
  const hlsMatch = /^\/hls\/(\d+)\/(index\.m3u8|segment_\d{5}\.ts|source\.ts)$/.exec(url.pathname);
  if ((req.method === 'GET' || req.method === 'HEAD') && hlsMatch) {
    if (!requireUser(req, res)) return;
    const row = db.prepare("SELECT hls_manifest FROM videos WHERE id=? AND conversion_status='converted'").get(hlsMatch[1]);
    if (!row?.hls_manifest) return json(res, 404, { error: 'HLS belum tersedia.' });
    const rowDetail = db.prepare('SELECT source FROM videos WHERE id=?').get(hlsMatch[1]);
    const file = hlsMatch[2] === 'source.ts' ? path.join(uploadDir, path.basename(rowDetail.source)) : path.join(hlsDir, hlsMatch[1], hlsMatch[2]);
    return servePrivateFile(req, res, file, mime[path.extname(file)] || 'application/octet-stream');
  }
  const mediaMatch = /^\/media\/(\d+)$/.exec(url.pathname);
  if ((req.method === 'GET' || req.method === 'HEAD') && mediaMatch) return serveMedia(req, res, mediaMatch[1]);
  json(res, 404, { error: 'Tidak ditemukan.' });
}

http.createServer((req, res) => route(req, res).catch(error => {
  console.error(error); json(res, error.message === 'PAYLOAD_TOO_LARGE' ? 413 : 400, { error: 'Permintaan tidak valid.' });
})).listen(port, host, () => console.log(`LV listening on http://${host}:${port}`));
