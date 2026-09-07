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
const imageDir = path.join(dataDir, 'images');
const thumbnailDir = path.join(dataDir, 'thumbnails');
const hlsDir = path.join(dataDir, 'hls');
const maxUpload = 500 * 1024 * 1024;
const maxImageUpload = 25 * 1024 * 1024;
const maxOptimizedImage = 500 * 1024;
const gibibyte = 1024 ** 3;
const configuredHeadroom = Number.parseInt(process.env.LV_DISK_HEADROOM_BYTES || '', 10);
const storageReservations = new Map();
fs.mkdirSync(uploadDir, { recursive: true, mode: 0o750 });
fs.mkdirSync(imageDir, { recursive: true, mode: 0o750 });
fs.mkdirSync(thumbnailDir, { recursive: true, mode: 0o750 });
fs.mkdirSync(hlsDir, { recursive: true, mode: 0o750 });
db.prepare("UPDATE videos SET conversion_status='failed', conversion_error='Proses terhenti saat layanan dimulai ulang.' WHERE conversion_status='converting'").run();
db.prepare("UPDATE videos SET ingest_status='failed', ingest_error='Download terhenti saat layanan dimulai ulang.' WHERE ingest_status='downloading'").run();
db.prepare("UPDATE videos SET optimization_status='failed', optimization_error='Optimasi terhenti saat layanan dimulai ulang.' WHERE optimization_status='optimizing'").run();

const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t' };
const appRoutes = new Set(['/', '/login', '/home', '/watch', '/images', '/search', '/profile', '/admin']);
const metadataJobs = new Set();
const conversionJobs = new Map();
const remoteJobs = new Map();
const imageJobs = new Set();
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

const feedModes = ['fyp', 'shuffle'];
const publicMediaVisibility = "videos.ingest_status='ready' AND ((videos.media_type='image' AND videos.optimization_status='optimised') OR (videos.media_type='video' AND videos.conversion_status!='converting'))";
function feedMode() {
  const row = db.prepare("SELECT value FROM settings WHERE key='feed_mode'").get();
  return feedModes.includes(row?.value) ? row.value : 'fyp';
}

function dataUsageBytes() {
  const directories = [dataDir];
  let total = 0;
  while (directories.length) {
    const directory = directories.pop();
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) directories.push(target);
      else if (entry.isFile()) {
        try { total += fs.statSync(target).size; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
  }
  return total;
}

function diskHeadroomBytes(totalBytes) {
  if (Number.isSafeInteger(configuredHeadroom) && configuredHeadroom >= 0) {
    return Math.min(configuredHeadroom, Math.floor(totalBytes * 0.9));
  }
  // Default: 5%, minimal 1 GiB, maksimal 10 GiB. Disk kecil menyisakan 20%.
  return Math.floor(Math.min(10 * gibibyte, Math.max(gibibyte, totalBytes * 0.05), totalBytes * 0.2));
}

function storageSnapshot() {
  const stat = fs.statfsSync(dataDir, { bigint: true });
  const totalBytes = Number(stat.bsize * stat.blocks);
  const availableBytes = Number(stat.bsize * stat.bavail);
  const usedBytes = Math.max(0, totalBytes - availableBytes);
  const projectUsedBytes = dataUsageBytes();
  const headroomBytes = diskHeadroomBytes(totalBytes);
  const maximumCustomLimitBytes = Math.max(0, totalBytes - headroomBytes);
  const modeRow = db.prepare("SELECT value FROM settings WHERE key='storage_limit_mode'").get();
  const mode = modeRow?.value === 'custom' ? 'custom' : 'filesystem';
  const customRow = db.prepare("SELECT value FROM settings WHERE key='storage_custom_limit_bytes'").get();
  const savedCustomLimit = Number(customRow?.value);
  const customLimitBytes = Number.isSafeInteger(savedCustomLimit) && savedCustomLimit > 0
    ? Math.min(savedCustomLimit, maximumCustomLimitBytes)
    : maximumCustomLimitBytes;
  const pendingBytes = [...storageReservations.values()].reduce((sum, value) => sum + value, 0);
  const safeDiskRemaining = Math.max(0, availableBytes - headroomBytes);
  const quotaRemaining = mode === 'custom'
    ? Math.max(0, customLimitBytes - projectUsedBytes)
    : Number.MAX_SAFE_INTEGER;
  const uploadCapacityBytes = Math.max(0, Math.min(safeDiskRemaining, quotaRemaining) - pendingBytes);
  const referenceBytes = mode === 'custom' ? customLimitBytes : totalBytes;
  const warningThreshold = Math.max(maxUpload, referenceBytes * 0.1);
  const level = uploadCapacityBytes <= 0 ? 'danger' : uploadCapacityBytes <= warningThreshold ? 'warning' : 'safe';
  return {
    mode,
    totalBytes,
    usedBytes,
    availableBytes,
    projectUsedBytes,
    headroomBytes,
    customLimitBytes,
    maximumCustomLimitBytes,
    pendingBytes,
    uploadCapacityBytes,
    acceptingUploads: uploadCapacityBytes > 0,
    level,
    limits: { videoBytes: maxUpload, imageBytes: maxImageUpload }
  };
}

function reserveStorage(bytes) {
  const requiredBytes = Math.max(0, Math.ceil(Number(bytes) || 0));
  const snapshot = storageSnapshot();
  if (!requiredBytes || requiredBytes > snapshot.uploadCapacityBytes) return null;
  const token = Symbol('storage-reservation');
  storageReservations.set(token, requiredBytes);
  return token;
}

function releaseStorage(token) {
  if (token) storageReservations.delete(token);
}

function insufficientStorageMessage() {
  return 'Ruang penyimpanan aman tidak cukup. Kosongkan media atau naikkan batas proyek.';
}

const feedPrime = 2147483647;
const feedPrimeAlt = 2147483629;
const feedRecentWindow = 3 * 86400000;
const feedAffinityBoost = Math.round(feedPrime * 0.35);
function mixSeed(value) {
  let mixed = (value >>> 0) || 0x9e3779b9;
  mixed = Math.imul(mixed ^ (mixed >>> 16), 2246822507) >>> 0;
  mixed = Math.imul(mixed ^ (mixed >>> 13), 3266489909) >>> 0;
  return (mixed ^ (mixed >>> 16)) >>> 0;
}
// Hashes each id into a per-seed pseudo-random key, so ordering by it is a real shuffle
// that is still stable for the whole seed — which is what keeps paging consistent.
// Two rounds over different primes with an xor-shift between them; SQLite has no xor
// operator, so it is spelled out as (a|b)-(a&b).
function shuffleKey(seed) {
  const multiplier = mixSeed(seed) % (feedPrime - 1) + 1;
  const finalizer = mixSeed(seed ^ 0x9e3779b9) % (feedPrimeAlt - 1) + 1;
  const rotation = mixSeed(seed ^ 0x5bf03635) % 1048573;
  const round = `(((videos.id + ${rotation}) * ${multiplier}) % ${feedPrime})`;
  const scrambled = `((${round} | (${round} >> 12)) - (${round} & (${round} >> 12)))`;
  return `((${scrambled} * ${finalizer}) % ${feedPrimeAlt})`;
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
function sessionCookie(req, token, maxAge) {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  const secure = req.socket.encrypted || forwardedProto === 'https' ? '; Secure' : '';
  return 'lv_session=' + encodeURIComponent(token) + '; Path=/; HttpOnly' + secure + '; SameSite=Strict; Max-Age=' + maxAge;
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
  const isImage = row.media_type === 'image';
  const isHls = Boolean(row.hls_manifest);
  const categories = categoryQuery.all(row.id).map(item => item.name);
  return {
    id: row.id,
    title: row.title,
    caption: row.caption,
    category: categories[0] || row.category || 'Umum',
    categories: categories.length ? categories : [row.category || 'Umum'],
    mediaType: isImage ? 'image' : 'video',
    sourceType: row.source_type,
    src: isImage ? `/media/${row.id}?v=${encodeURIComponent(row.source)}` : (row.source_type === 'url' ? row.source : (isHls ? `/hls/${row.id}/index.m3u8` : `/media/${row.id}`)),
    playbackType: isImage ? 'image' : (isHls ? 'hls' : 'file'),
    sortOrder: row.sort_order,
    durationSeconds: row.duration_seconds,
    sizeBytes: row.size_bytes,
    originalSizeBytes: row.original_size_bytes,
    width: row.width,
    height: row.height,
    thumbnail: row.thumbnail ? `/thumbnail/${row.id}?v=${encodeURIComponent(row.thumbnail)}` : null,
    conversionStatus: row.conversion_status || 'none',
    conversionError: row.conversion_error || null,
    conversionProgress: conversionJobs.get(Number(row.id))?.progress || 0,
    originalDeleted: Boolean(row.original_deleted),
    originalName: row.source_type === 'upload' ? path.basename(row.source) : null,
    nativeTs: !isImage && row.source_type === 'upload' && path.extname(row.source).toLowerCase() === '.ts',
    liked: Boolean(row.liked),
    likeCount: Number(row.like_count || 0),
    ingestStatus: row.ingest_status || 'ready',
    ingestError: row.ingest_error || null,
    ingestProgress: remoteJobs.get(Number(row.id))?.progress || 0,
    optimizationStatus: row.optimization_status || 'none',
    optimizationError: row.optimization_error || null
  };
}
async function inspectVideo(id) {
  id = Number(id);
  if (metadataJobs.has(id)) return;
  const row = db.prepare("SELECT * FROM videos WHERE id=? AND source_type='upload' AND media_type='video'").get(id);
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
  const known = new Set(db.prepare("SELECT source FROM videos WHERE source_type='upload' AND media_type='video'").all().map(row => row.source));
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
  for (const row of db.prepare("SELECT id FROM videos WHERE source_type='upload' AND media_type='video' AND original_deleted=0 AND (duration_seconds IS NULL OR thumbnail IS NULL OR thumbnail_version<2)").all()) scheduleMetadata(row.id);
  return summary;
}
const imageMimeByExtension = new Map([['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.png', 'image/png'], ['.webp', 'image/webp']]);

async function inspectImageFile(input) {
  const { stdout } = await execFileAsync('/usr/bin/ffprobe', [
    '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height',
    '-of', 'json', input
  ], { maxBuffer: 1024 * 1024 });
  const stream = JSON.parse(stdout).streams?.[0];
  if (!stream?.width || !stream?.height) throw new Error('Dimensi gambar tidak terbaca.');
  return { width: Number(stream.width), height: Number(stream.height) };
}

async function makeImageThumbnail(input, target) {
  await execFileAsync('/usr/bin/ffmpeg', [
    '-y', '-i', input, '-frames:v', '1', '-vf', thumbnailFilter,
    '-pix_fmt', 'yuvj420p', '-threads', '1', '-q:v', '4', target
  ], { maxBuffer: 4 * 1024 * 1024 });
}

async function optimizeImage(id) {
  id = Number(id);
  if (imageJobs.has(id)) return;
  const row = db.prepare("SELECT * FROM videos WHERE id=? AND media_type='image' AND source_type='upload'").get(id);
  if (!row || row.ingest_status !== 'ready') return;
  const input = path.join(imageDir, path.basename(row.source));
  if (!fs.existsSync(input)) {
    db.prepare("UPDATE videos SET optimization_status='failed', optimization_error='Berkas gambar tidak ditemukan.' WHERE id=?").run(id);
    return;
  }

  imageJobs.add(id);
  db.prepare("UPDATE videos SET optimization_status='optimizing', optimization_error=NULL WHERE id=?").run(id);
  let working = null;
  let freshThumbnail = null;
  try {
    const inputStat = fs.statSync(input);
    const originalSize = Number(row.original_size_bytes || inputStat.size);
    let selected = input;
    let selectedName = path.basename(row.source);
    let selectedMime = row.mime_type || imageMimeByExtension.get(path.extname(row.source).toLowerCase()) || 'image/jpeg';

    if (inputStat.size > maxOptimizedImage) {
      working = path.join(imageDir, `.optimize-${id}-${crypto.randomUUID()}.webp`);
      const attempts = [
        { side: 1920, quality: 78 },
        { side: 1920, quality: 64 },
        { side: 1600, quality: 50 },
        { side: 1280, quality: 38 }
      ];
      for (const attempt of attempts) {
        fs.rmSync(working, { force: true });
        const scale = `scale='min(${attempt.side},iw)':'min(${attempt.side},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`;
        await execFileAsync('/usr/bin/ffmpeg', [
          '-y', '-i', input, '-frames:v', '1', '-vf', scale, '-map_metadata', '-1',
          '-an', '-c:v', 'libwebp', '-preset', 'picture', '-quality', String(attempt.quality),
          '-compression_level', '4', '-threads', '1', working
        ], { maxBuffer: 8 * 1024 * 1024 });
        if (fs.statSync(working).size <= maxOptimizedImage) break;
      }
      if (!fs.existsSync(working) || fs.statSync(working).size > maxOptimizedImage) {
        throw new Error('Gambar tidak dapat diperkecil hingga 500 KB.');
      }
      selected = working;
      selectedName = `${crypto.randomUUID()}.webp`;
      selectedMime = 'image/webp';
    }

    const dimensions = await inspectImageFile(selected);
    const thumbnailName = `${id}-${Date.now()}.jpg`;
    freshThumbnail = path.join(thumbnailDir, thumbnailName);
    await makeImageThumbnail(selected, freshThumbnail);

    let finalPath = input;
    if (selected !== input) {
      finalPath = path.join(imageDir, selectedName);
      fs.renameSync(selected, finalPath);
      working = null;
      fs.rmSync(input, { force: true });
    }
    if (row.thumbnail) fs.rmSync(path.join(thumbnailDir, path.basename(row.thumbnail)), { force: true });
    db.prepare(`UPDATE videos SET source=?, mime_type=?, size_bytes=?, original_size_bytes=?,
      width=?, height=?, thumbnail=?, thumbnail_version=2, optimization_status='optimised',
      optimization_error=NULL WHERE id=?`).run(
      selectedName, selectedMime, fs.statSync(finalPath).size, originalSize,
      dimensions.width, dimensions.height, thumbnailName, id
    );
    freshThumbnail = null;
  } catch (error) {
    console.error(`image optimize ${id}:`, error.message);
    db.prepare("UPDATE videos SET optimization_status='failed', optimization_error=? WHERE id=?").run(String(error.message || 'Optimasi gagal.').slice(0, 500), id);
  } finally {
    if (working) fs.rmSync(working, { force: true });
    if (freshThumbnail) fs.rmSync(freshThumbnail, { force: true });
    imageJobs.delete(id);
  }
}

function scheduleImageOptimization(id) {
  optimizeImage(id).catch(error => console.error(error));
}

function syncImageDirectory() {
  const known = new Set(db.prepare("SELECT source FROM videos WHERE source_type='upload' AND media_type='image'").all().map(row => row.source));
  const summary = { added: 0, existing: 0, skipped: 0 };
  for (const file of fs.readdirSync(imageDir)) {
    if (file.startsWith('.')) { summary.skipped += 1; continue; }
    const extension = path.extname(file).toLowerCase();
    const originalPath = path.join(imageDir, file);
    let isFile = false;
    try { isFile = fs.statSync(originalPath).isFile(); } catch { /* berkas berpindah saat sync */ }
    if (!isFile || !imageMimeByExtension.has(extension)) { summary.skipped += 1; continue; }
    if (known.has(file)) { summary.existing += 1; continue; }

    const title = path.basename(file, extension).replace(/[-_]+/g, ' ').trim() || 'LV';
    const randomName = `${crypto.randomUUID()}${extension}`;
    const randomPath = path.join(imageDir, randomName);
    try {
      const stat = fs.statSync(originalPath);
      if (stat.size > maxImageUpload) throw new Error('Ukuran gambar melebihi 25 MB.');
      fs.renameSync(originalPath, randomPath);
      const result = db.prepare(`INSERT INTO videos
        (title, caption, source_type, source, mime_type, sort_order, media_type,
         size_bytes, original_size_bytes, optimization_status)
        VALUES (?, ?, 'upload', ?, ?, ?, 'image', ?, ?, 'unoptimised')`)
        .run(title.slice(0, 120), '', randomName, imageMimeByExtension.get(extension), Date.now(), stat.size, stat.size);
      setVideoCategories(result.lastInsertRowid, ['Umum']);
      scheduleImageOptimization(result.lastInsertRowid);
      summary.added += 1;
    } catch (error) {
      if (fs.existsSync(randomPath) && !fs.existsSync(originalPath)) fs.renameSync(randomPath, originalPath);
      console.error(`sync image ${file}:`, error.message);
      summary.skipped += 1;
    }
  }
  for (const row of db.prepare("SELECT id FROM videos WHERE media_type='image' AND source_type='upload' AND ingest_status='ready' AND optimization_status IN ('none','unoptimised')").all()) {
    scheduleImageOptimization(row.id);
  }
  return summary;
}

function syncMediaDirectories() {
  const videos = syncUploadDirectory();
  const images = syncImageDirectory();
  return {
    added: videos.added + images.added,
    existing: videos.existing + images.existing,
    skipped: videos.skipped + images.skipped,
    videos,
    images
  };
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
async function downloadRemote(row, sourceUrl, storageReservation) {
  const id = Number(row.id);
  const job = { progress: 0, controller: new AbortController() };
  remoteJobs.set(id, job);
  const temporary = path.join(dataDir, `.remote-${id}-${crypto.randomUUID()}.part`);
  let output;
  try {
    const { response, finalUrl } = await fetchRemote(sourceUrl, job.controller.signal);
    const type = String(response.headers.get('content-type') || '').split(';')[0].toLowerCase();
    const detailsByType = {
      'video/mp4': { extension: '.mp4', mediaType: 'video' },
      'video/webm': { extension: '.webm', mediaType: 'video' },
      'video/quicktime': { extension: '.mov', mediaType: 'video' },
      'video/mp2t': { extension: '.ts', mediaType: 'video' },
      'image/jpeg': { extension: '.jpg', mediaType: 'image' },
      'image/png': { extension: '.png', mediaType: 'image' },
      'image/webp': { extension: '.webp', mediaType: 'image' }
    };
    const detailsByExtension = {
      '.mp4': { type: 'video/mp4', mediaType: 'video' },
      '.webm': { type: 'video/webm', mediaType: 'video' },
      '.mov': { type: 'video/quicktime', mediaType: 'video' },
      '.ts': { type: 'video/mp2t', mediaType: 'video' },
      '.jpg': { type: 'image/jpeg', mediaType: 'image' },
      '.jpeg': { type: 'image/jpeg', mediaType: 'image' },
      '.png': { type: 'image/png', mediaType: 'image' },
      '.webp': { type: 'image/webp', mediaType: 'image' }
    };
    const urlExtension = path.extname(new URL(finalUrl).pathname).toLowerCase();
    const typed = detailsByType[type];
    const extended = detailsByExtension[urlExtension];
    const extension = typed?.extension || (extended ? urlExtension : null);
    const mediaType = typed?.mediaType || extended?.mediaType;
    const mimeType = typed ? type : extended?.type;
    if (!extension || !mimeType || !mediaType) throw new Error('URL bukan berkas video atau gambar yang didukung.');
    if (row.media_type && row.media_type !== mediaType) throw new Error(`URL tersebut bukan ${row.media_type === 'image' ? 'gambar' : 'video'}.`);

    const limit = mediaType === 'image' ? maxImageUpload : maxUpload;
    const sizeLabel = mediaType === 'image' ? '25 MB' : '500 MB';
    const declaredLength = Number(response.headers.get('content-length') || 0);
    if (declaredLength > limit) throw new Error(`Ukuran ${mediaType === 'image' ? 'gambar' : 'video'} melebihi ${sizeLabel}.`);
    output = fs.createWriteStream(temporary, { mode: 0o640, flags: 'wx' });
    let received = 0;
    for await (const chunk of response.body) {
      received += chunk.length;
      if (received > limit) throw new Error(`Ukuran ${mediaType === 'image' ? 'gambar' : 'video'} melebihi ${sizeLabel}.`);
      job.progress = declaredLength ? Math.min(99, Math.round(received / declaredLength * 100)) : 0;
      if (!output.write(chunk)) await new Promise(resolve => output.once('drain', resolve));
    }
    await new Promise((resolve, reject) => { output.end(resolve); output.on('error', reject); });

    const filename = `${crypto.randomUUID()}${extension}`;
    const destination = path.join(mediaType === 'image' ? imageDir : uploadDir, filename);
    fs.renameSync(temporary, destination);
    db.prepare(`UPDATE videos SET source=?, mime_type=?, source_url=?, media_type=?,
      size_bytes=?, original_size_bytes=?, ingest_status='ready', ingest_error=NULL,
      optimization_status=? WHERE id=?`).run(
      filename, mimeType, finalUrl, mediaType, received,
      mediaType === 'image' ? received : null,
      mediaType === 'image' ? 'unoptimised' : 'none', id
    );
    if (mediaType === 'image') scheduleImageOptimization(id); else scheduleMetadata(id);
  } catch (error) {
    output?.destroy();
    fs.rmSync(temporary, { force: true });
    if (db.prepare('SELECT 1 FROM videos WHERE id=?').get(id)) {
      const detail = error.code === 'ENOSPC' ? insufficientStorageMessage() : error.name === 'AbortError' ? 'Download dibatalkan.' : error.message;
      db.prepare("UPDATE videos SET ingest_status='failed', ingest_error=? WHERE id=?").run(detail.slice(0, 500), id);
    }
  } finally {
    releaseStorage(storageReservation);
    remoteJobs.delete(id);
  }
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
  const video = db.prepare("SELECT source, mime_type, media_type, conversion_status, optimization_status, ingest_status FROM videos WHERE id=? AND source_type='upload'").get(id);
  if (!video) return json(res, 404, { error: 'Media tidak ditemukan.' });
  if (video.ingest_status !== 'ready') return json(res, 404, { error: 'Media belum tersedia.' });
  if (video.media_type === 'image' && user.role !== 'admin' && video.optimization_status !== 'optimised') return json(res, 404, { error: 'Gambar belum tersedia.' });
  if (user.role !== 'admin' && video.conversion_status === 'converting') return json(res, 404, { error: 'Video belum tersedia.' });
  const file = path.join(video.media_type === 'image' ? imageDir : uploadDir, path.basename(video.source));
  if (video.media_type === 'image') return servePrivateFile(req, res, file, video.mime_type || 'image/jpeg');
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
  const supported = {
    'video/mp4': { extension: '.mp4', mediaType: 'video' },
    'video/webm': { extension: '.webm', mediaType: 'video' },
    'video/quicktime': { extension: '.mov', mediaType: 'video' },
    'video/mp2t': { extension: '.ts', mediaType: 'video' },
    'image/jpeg': { extension: '.jpg', mediaType: 'image' },
    'image/png': { extension: '.png', mediaType: 'image' },
    'image/webp': { extension: '.webp', mediaType: 'image' }
  };
  const detail = supported[type];
  if (!detail) return json(res, 415, { error: 'Gunakan MP4, WebM, MOV, TS, JPG, PNG, atau WebP.' });
  const limit = detail.mediaType === 'image' ? maxImageUpload : maxUpload;
  if (!length || length > limit) return json(res, 413, { error: `Ukuran maksimum ${detail.mediaType === 'image' ? '25 MB' : '500 MB'}.` });
  const storageReservation = reserveStorage(length);
  if (!storageReservation) return json(res, 507, { error: insufficientStorageMessage() });

  const filename = `${crypto.randomUUID()}${detail.extension}`;
  const target = path.join(detail.mediaType === 'image' ? imageDir : uploadDir, filename);
  let received = 0;
  const output = fs.createWriteStream(target, { mode: 0o640, flags: 'wx' });
  try {
    for await (const chunk of req) {
      received += chunk.length;
      if (received > limit) throw new Error('TOO_LARGE');
      if (!output.write(chunk)) await new Promise(resolve => output.once('drain', resolve));
    }
    await new Promise((resolve, reject) => { output.end(resolve); output.on('error', reject); });
    const title = (url.searchParams.get('title') || 'Tanpa judul').slice(0, 120);
    const caption = (url.searchParams.get('caption') || '').slice(0, 500);
    const categories = normalizeCategories(url.searchParams.get('category') || 'Umum');
    const result = db.prepare(`INSERT INTO videos
      (title, caption, category, source_type, source, mime_type, sort_order, media_type,
       size_bytes, original_size_bytes, optimization_status)
      VALUES (?, ?, ?, 'upload', ?, ?, ?, ?, ?, ?, ?)`).run(
      title, caption, categories[0], filename, type, Date.now(), detail.mediaType,
      received, detail.mediaType === 'image' ? received : null,
      detail.mediaType === 'image' ? 'unoptimised' : 'none'
    );
    setVideoCategories(result.lastInsertRowid, categories);
    if (detail.mediaType === 'image') scheduleImageOptimization(result.lastInsertRowid);
    else scheduleMetadata(result.lastInsertRowid);
    json(res, 201, cleanVideo(db.prepare('SELECT * FROM videos WHERE id=?').get(result.lastInsertRowid)));
  } catch (error) {
    output.destroy();
    fs.rmSync(target, { force: true });
    const status = error.message === 'TOO_LARGE' ? 413 : error.code === 'ENOSPC' ? 507 : 500;
    json(res, status, { error: status === 507 ? insufficientStorageMessage() : 'Upload gagal.' });
  } finally { releaseStorage(storageReservation); }
}

async function replaceThumbnail(req, res, id) {
  if (!requireUser(req, res, 'admin')) return;
  const row = db.prepare('SELECT * FROM videos WHERE id=?').get(id);
  if (!row) return json(res, 404, { error: 'Media tidak ditemukan.' });
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
  if (!row) return json(res, 404, { error: 'Media tidak ditemukan.' });
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

function runConversion(row, storageReservation) {
  const id = Number(row.id);
  const input = path.join(uploadDir, path.basename(row.source));
  const workingDir = path.join(hlsDir, `${id}.working`);
  const finalDir = path.join(hlsDir, String(id));
  fs.rmSync(workingDir, { recursive: true, force: true });
  fs.mkdirSync(workingDir, { recursive: true, mode: 0o750 });
  db.prepare("UPDATE videos SET conversion_status='converting', conversion_error=NULL WHERE id=?").run(id);
  const job = { progress: 0, process: null, storageReservation };
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
    releaseStorage(storageReservation);
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
    releaseStorage(storageReservation);
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
  if ((req.method === 'GET' || req.method === 'HEAD') && appRoutes.has(url.pathname)) return serveStatic(req, res, 'index.html');
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
    return json(res, 200, { user: { id: user.id, username: user.username, role: user.role } }, { 'Set-Cookie': sessionCookie(req, token, 604800) });
  }
  if (req.method === 'POST' && url.pathname === '/api/logout') {
    const token = parseCookies(req).lv_session; if (token) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(tokenHash(token));
    return json(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, '', 0) });
  }
  if (url.pathname === '/api/settings') {
    if (!requireUser(req, res, 'admin')) return;
    if (req.method === 'GET') return json(res, 200, { feedMode: feedMode() });
    if (req.method === 'PATCH') {
      const body = await readJson(req);
      if (!feedModes.includes(body.feedMode)) return json(res, 400, { error: 'Mode feed tidak dikenal.' });
      db.prepare("INSERT INTO settings (key,value) VALUES ('feed_mode',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(body.feedMode);
      return json(res, 200, { feedMode: body.feedMode });
    }
  }
  if (url.pathname === '/api/storage') {
    if (!requireUser(req, res, 'admin')) return;
    if (req.method === 'GET') return json(res, 200, storageSnapshot());
    if (req.method === 'PATCH') {
      const body = await readJson(req);
      if (!['filesystem', 'custom'].includes(body.mode)) return json(res, 400, { error: 'Dasar batas penyimpanan tidak dikenal.' });
      const current = storageSnapshot();
      let customLimitBytes = current.customLimitBytes;
      if (body.mode === 'custom') {
        customLimitBytes = Math.round(Number(body.customLimitBytes));
        if (!Number.isSafeInteger(customLimitBytes) || customLimitBytes <= 0) return json(res, 400, { error: 'Batas proyek harus lebih dari 0.' });
        if (customLimitBytes > current.maximumCustomLimitBytes) return json(res, 400, { error: 'Batas proyek melebihi kapasitas aman disk server.' });
      }
      db.exec('BEGIN');
      try {
        db.prepare("INSERT INTO settings (key,value) VALUES ('storage_limit_mode',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(body.mode);
        db.prepare("INSERT INTO settings (key,value) VALUES ('storage_custom_limit_bytes',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(customLimitBytes));
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      return json(res, 200, storageSnapshot());
    }
  }
  if (req.method === 'GET' && url.pathname === '/api/categories') {
    if (!requireUser(req, res)) return;
    const mediaType = ['video', 'image'].includes(url.searchParams.get('type')) ? url.searchParams.get('type') : null;
    const sampleMediaClause = mediaType ? `AND sample_videos.media_type='${mediaType}'` : '';
    const categoryMediaClause = mediaType ? `AND videos.media_type='${mediaType}'` : '';
    const categories = db.prepare(`SELECT categories.name, COUNT(*) AS video_count,
      (SELECT sample_videos.id FROM video_categories sample_video_categories
        JOIN videos sample_videos ON sample_videos.id=sample_video_categories.video_id
        WHERE sample_video_categories.category_id=categories.id
          AND sample_videos.ingest_status='ready' AND sample_videos.conversion_status!='converting'
          AND (sample_videos.media_type='video' OR sample_videos.optimization_status='optimised')
          AND sample_videos.thumbnail IS NOT NULL
          ${sampleMediaClause}
        ORDER BY sample_videos.sort_order DESC, sample_videos.id DESC LIMIT 1) AS thumbnail_id
      FROM categories
      JOIN video_categories ON video_categories.category_id=categories.id
      JOIN videos ON videos.id=video_categories.video_id
      WHERE videos.ingest_status='ready' AND videos.conversion_status!='converting'
        AND (videos.media_type='video' OR videos.optimization_status='optimised')
      ${categoryMediaClause}
      GROUP BY categories.id, categories.name
      ORDER BY video_count DESC, categories.name COLLATE NOCASE LIMIT 12`).all().map(category => ({
        name: category.name,
        videoCount: Number(category.video_count),
        mediaCount: Number(category.video_count),
        thumbnail: category.thumbnail_id ? `/thumbnail/${category.thumbnail_id}` : null
      }));
    return json(res, 200, { categories });
  }
  if (req.method === 'GET' && url.pathname === '/api/videos') {
    const user = requireUser(req, res); if (!user) return;
    const requestedPage = Number.parseInt(url.searchParams.get('page') || '', 10);
    if (Number.isFinite(requestedPage) && requestedPage > 0) {
      const limit = Math.min(50, Math.max(1, Number.parseInt(url.searchParams.get('limit') || '10', 10) || 10));
      const clauses = []; const parameters = [];
      if (user.role !== 'admin') clauses.push(publicMediaVisibility);
      const mediaType = url.searchParams.get('type');
      if (mediaType === 'video' || mediaType === 'image') {
        clauses.push('videos.media_type=?');
        parameters.push(mediaType);
      }
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
          ready: "videos.ingest_status='ready' AND ((videos.media_type='image' AND videos.optimization_status='optimised') OR (videos.media_type='video' AND videos.conversion_status='converted'))",
          unoptimised: "videos.ingest_status='ready' AND ((videos.media_type='image' AND videos.optimization_status IN ('none','unoptimised')) OR (videos.media_type='video' AND videos.conversion_status NOT IN ('converted','converting','failed') AND videos.duration_seconds IS NOT NULL AND lower(videos.source) NOT LIKE '%.ts'))",
          processing: "videos.ingest_status='downloading' OR videos.conversion_status='converting' OR videos.optimization_status='optimizing' OR (videos.media_type='video' AND videos.ingest_status='ready' AND videos.duration_seconds IS NULL)",
          failed: "videos.ingest_status='failed' OR videos.conversion_status='failed' OR videos.optimization_status='failed'"
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
      const shuffleSeed = Number.isFinite(requestedSeed) && requestedSeed > 0 ? requestedSeed % feedPrime : 0;
      const shuffled = user.role !== 'admin' && shuffleSeed > 0;
      const personalized = shuffled && feedMode() === 'fyp';
      // Views recorded after the feed session started are ignored so paging stays stable
      // while the user keeps scrolling through the same shuffle. The client sends the age
      // of its session rather than a timestamp, so a skewed browser clock cannot shift it.
      const requestedAge = Number.parseInt(url.searchParams.get('age') || '', 10);
      const since = Date.now() - (Number.isFinite(requestedAge) ? Math.min(86400000, Math.max(0, requestedAge)) : 0);
      const from = personalized
        ? `videos LEFT JOIN (SELECT video_id, MAX(viewed_at) AS viewed_at FROM video_views
            WHERE user_id=${user.id} AND viewed_at<${since} GROUP BY video_id) feed_views ON feed_views.video_id=videos.id`
        : 'videos';
      // Unseen first, then long-unwatched, then just-watched; inside each tier the shuffle
      // decides, nudged by videos sharing a category with something the user has loved.
      const feedOrder = `(CASE WHEN feed_views.viewed_at IS NULL THEN 0
          WHEN feed_views.viewed_at < ${since - feedRecentWindow} THEN 1 ELSE 2 END) ASC,
        (${shuffleKey(shuffleSeed)} - (CASE WHEN EXISTS (
          SELECT 1 FROM video_categories affinity_categories
          JOIN video_categories liked_categories ON liked_categories.category_id=affinity_categories.category_id
          JOIN video_likes affinity_likes ON affinity_likes.video_id=liked_categories.video_id AND affinity_likes.user_id=${user.id}
          WHERE affinity_categories.video_id=videos.id) THEN ${feedAffinityBoost} ELSE 0 END)) ASC,
        videos.id DESC`;
      const order = user.role === 'admin' && Object.hasOwn(sortOrders, requestedSort)
        ? sortOrders[requestedSort]
        : personalized ? feedOrder
          : shuffled ? `${shuffleKey(shuffleSeed)} ASC, videos.id DESC`
            : sortOrders.newest;
      const select = `SELECT videos.*,
        EXISTS(SELECT 1 FROM video_likes WHERE video_likes.user_id=? AND video_likes.video_id=videos.id) AS liked,
        (SELECT COUNT(*) FROM video_likes WHERE video_likes.video_id=videos.id) AS like_count
        FROM ${from} ${where} ORDER BY ${order}`;
      const total = db.prepare(`SELECT COUNT(*) AS total FROM videos ${where}`).get(...parameters).total;
      const totalPages = Math.max(1, Math.ceil(total / limit));
      const page = Math.min(requestedPage, totalPages);
      const rows = db.prepare(`${select} LIMIT ? OFFSET ?`).all(user.id, ...parameters, limit, (page - 1) * limit);
      const facets = user.role === 'admin' ? {
        categories: db.prepare(`SELECT DISTINCT categories.name FROM categories
          JOIN video_categories ON video_categories.category_id=categories.id
          JOIN videos ON videos.id=video_categories.video_id
          ${mediaType ? `WHERE videos.media_type='${mediaType}'` : ''}
          ORDER BY categories.name COLLATE NOCASE`).all().map(item => item.name)
      } : null;
      return json(res, 200, { videos: rows.map(cleanVideo), pagination: { page, limit, total, totalPages }, facets });
    }
    const visibility = user.role === 'admin' ? '' : `WHERE ${publicMediaVisibility}`;
    const select = `SELECT videos.*,
      EXISTS(SELECT 1 FROM video_likes WHERE video_likes.user_id=? AND video_likes.video_id=videos.id) AS liked,
      (SELECT COUNT(*) FROM video_likes WHERE video_likes.video_id=videos.id) AS like_count
      FROM videos ${visibility} ORDER BY sort_order DESC, id DESC`;
    const rows = db.prepare(select).all(user.id);
    return json(res, 200, { videos: rows.map(cleanVideo), pagination: null });
  }
  if (req.method === 'POST' && url.pathname === '/api/videos/sync') {
    if (!requireUser(req, res, 'admin')) return;
    const mediaType = url.searchParams.get('type');
    return json(res, 200, mediaType === 'image' ? syncImageDirectory() : mediaType === 'video' ? syncUploadDirectory() : syncMediaDirectories());
  }
  if (req.method === 'POST' && url.pathname === '/api/videos/upload') return upload(req, res, url);
  if (req.method === 'POST' && url.pathname === '/api/videos/url') {
    if (!requireUser(req, res, 'admin')) return; const body = await readJson(req); let source;
    try { source = await validateRemoteUrl(String(body.url)); } catch (error) { return json(res, 400, { error: error.message || 'URL media tidak valid.' }); }
    const fallbackTitle = path.basename(source.pathname, path.extname(source.pathname)).replace(/[-_]+/g, ' ').trim() || 'Tanpa judul';
    const temporary = `${crypto.randomUUID()}.part`;
    const categories = normalizeCategories(body.categories || body.category);
    const requestedMediaType = body.mediaType === 'image' ? 'image' : 'video';
    const storageReservation = reserveStorage(requestedMediaType === 'image' ? maxImageUpload : maxUpload);
    if (!storageReservation) return json(res, 507, { error: insufficientStorageMessage() });
    try {
      const result = db.prepare("INSERT INTO videos (title,caption,category,source_type,source,sort_order,source_url,ingest_status,media_type,optimization_status) VALUES (?,?,?,?,?,?,?,'downloading',?,?)").run(String(body.title || fallbackTitle).slice(0,120), String(body.caption || '').slice(0,500), categories[0], 'upload', temporary, Date.now(), source.href, requestedMediaType, requestedMediaType === 'image' ? 'unoptimised' : 'none');
      setVideoCategories(result.lastInsertRowid, categories);
      const row = db.prepare('SELECT * FROM videos WHERE id=?').get(result.lastInsertRowid);
      downloadRemote(row, source.href, storageReservation).catch(error => console.error(error));
      return json(res, 202, cleanVideo(row));
    } catch (error) { releaseStorage(storageReservation); throw error; }
  }
  const editMatch = /^\/api\/videos\/(\d+)$/.exec(url.pathname);
  if (req.method === 'GET' && editMatch) {
    const user = requireUser(req, res); if (!user) return;
    const visibility = user.role === 'admin' ? '' : ` AND ${publicMediaVisibility}`;
    const row = db.prepare(`SELECT videos.*,
      EXISTS(SELECT 1 FROM video_likes WHERE video_likes.user_id=? AND video_likes.video_id=videos.id) AS liked,
      (SELECT COUNT(*) FROM video_likes WHERE video_likes.video_id=videos.id) AS like_count
      FROM videos WHERE id=?${visibility}`).get(user.id, editMatch[1]);
    if (!row) return json(res, 404, { error: 'Media tidak ditemukan.' });
    return json(res, 200, { video: cleanVideo(row) });
  }
  if (req.method === 'PATCH' && editMatch) {
    if (!requireUser(req, res, 'admin')) return;
    const row = db.prepare('SELECT id FROM videos WHERE id=?').get(editMatch[1]);
    if (!row) return json(res, 404, { error: 'Media tidak ditemukan.' });
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
  const optimizeMatch = /^\/api\/videos\/(\d+)\/optimize$/.exec(url.pathname);
  if (req.method === 'POST' && optimizeMatch) {
    if (!requireUser(req, res, 'admin')) return;
    const row = db.prepare("SELECT * FROM videos WHERE id=? AND source_type='upload' AND media_type='image'").get(optimizeMatch[1]);
    if (!row) return json(res, 404, { error: 'Gambar lokal tidak ditemukan.' });
    if (row.ingest_status !== 'ready') return json(res, 409, { error: 'Download belum selesai.' });
    if (!fs.existsSync(path.join(imageDir, path.basename(row.source)))) return json(res, 409, { error: 'Berkas gambar tidak tersedia.' });
    if (imageJobs.has(Number(row.id)) || row.optimization_status === 'optimizing') return json(res, 409, { error: 'Optimasi sedang berjalan.' });
    scheduleImageOptimization(row.id);
    return json(res, 202, { ok: true });
  }
  const convertMatch = /^\/api\/videos\/(\d+)\/convert$/.exec(url.pathname);
  if (req.method === 'POST' && convertMatch) {
    if (!requireUser(req, res, 'admin')) return;
    const row = db.prepare("SELECT * FROM videos WHERE id=? AND source_type='upload' AND media_type='video'").get(convertMatch[1]);
    if (!row) return json(res, 404, { error: 'Video lokal tidak ditemukan.' });
    if (row.ingest_status !== 'ready') return json(res, 409, { error: 'Download belum selesai.' });
    if (row.original_deleted || !fs.existsSync(path.join(uploadDir, path.basename(row.source)))) return json(res, 409, { error: 'MP4 asli tidak tersedia.' });
    if (path.extname(row.source).toLowerCase() === '.ts') return json(res, 409, { error: 'Berkas sudah berformat TS.' });
    if (conversionJobs.has(Number(row.id)) || row.conversion_status === 'converting') return json(res, 409, { error: 'Konversi sedang berjalan.' });
    if (row.hls_manifest && row.conversion_status === 'converted') return json(res, 409, { error: 'Video sudah dikonversi.' });
    const sourceSize = fs.statSync(path.join(uploadDir, path.basename(row.source))).size;
    const storageReservation = reserveStorage(Math.ceil(sourceSize * 1.5));
    if (!storageReservation) return json(res, 507, { error: insufficientStorageMessage() });
    try { runConversion(row, storageReservation); } catch (error) { releaseStorage(storageReservation); throw error; }
    return json(res, 202, { ok: true });
  }
  const originalMatch = /^\/api\/videos\/(\d+)\/original$/.exec(url.pathname);
  if (req.method === 'DELETE' && originalMatch) {
    if (!requireUser(req, res, 'admin')) return;
    const row = db.prepare("SELECT * FROM videos WHERE id=? AND source_type='upload' AND media_type='video'").get(originalMatch[1]);
    if (!row) return json(res, 404, { error: 'Media tidak ditemukan.' });
    if (path.extname(row.source).toLowerCase() === '.ts') return json(res, 409, { error: 'Berkas ini berasal dari TS.' });
    if (row.conversion_status !== 'converted' || !row.hls_manifest) return json(res, 409, { error: 'Konversi HLS belum selesai.' });
    fs.rmSync(path.join(uploadDir, path.basename(row.source)), { force: true });
    db.prepare('UPDATE videos SET original_deleted=1 WHERE id=?').run(row.id);
    return json(res, 200, { ok: true });
  }
  const viewMatch = /^\/api\/videos\/(\d+)\/view$/.exec(url.pathname);
  if (req.method === 'POST' && viewMatch) {
    const user = requireUser(req, res); if (!user) return;
    if (!db.prepare('SELECT 1 FROM videos WHERE id=?').get(viewMatch[1])) return json(res, 404, { error: 'Media tidak ditemukan.' });
    db.prepare(`INSERT INTO video_views (user_id,video_id,viewed_at,view_count) VALUES (?,?,?,1)
      ON CONFLICT(user_id,video_id) DO UPDATE SET viewed_at=excluded.viewed_at, view_count=view_count+1`).run(user.id, Number(viewMatch[1]), Date.now());
    return json(res, 200, { ok: true });
  }
  const likeMatch = /^\/api\/videos\/(\d+)\/like$/.exec(url.pathname);
  if ((req.method === 'POST' || req.method === 'DELETE') && likeMatch) {
    const user = requireUser(req, res); if (!user) return;
    if (!db.prepare('SELECT 1 FROM videos WHERE id=?').get(likeMatch[1])) return json(res, 404, { error: 'Media tidak ditemukan.' });
    if (req.method === 'POST') db.prepare('INSERT OR IGNORE INTO video_likes (user_id,video_id) VALUES (?,?)').run(user.id, likeMatch[1]);
    else db.prepare('DELETE FROM video_likes WHERE user_id=? AND video_id=?').run(user.id, likeMatch[1]);
    const count = db.prepare('SELECT COUNT(*) AS count FROM video_likes WHERE video_id=?').get(likeMatch[1]).count;
    return json(res, 200, { liked: req.method === 'POST', likeCount: count });
  }
  const deleteMatch = /^\/api\/videos\/(\d+)$/.exec(url.pathname);
  if (req.method === 'DELETE' && deleteMatch) {
    if (!requireUser(req, res, 'admin')) return; const row = db.prepare('SELECT * FROM videos WHERE id=?').get(deleteMatch[1]);
    if (!row) return json(res, 404, { error: 'Media tidak ditemukan.' });
    if (conversionJobs.has(Number(row.id))) return json(res, 409, { error: 'Tunggu konversi selesai.' });
    if (imageJobs.has(Number(row.id))) return json(res, 409, { error: 'Tunggu optimasi selesai.' });
    if (remoteJobs.has(Number(row.id))) remoteJobs.get(Number(row.id)).controller.abort();
    db.prepare('DELETE FROM videos WHERE id=?').run(row.id);
    if (row.source_type === 'upload') fs.rmSync(path.join(row.media_type === 'image' ? imageDir : uploadDir, path.basename(row.source)), { force: true });
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
