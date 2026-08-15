const $ = selector => document.querySelector(selector);
const state = { user: null, videos: [], homeVideos: [], homePagination: null, homeLoadId: 0, viewerPage: 1, viewerPagination: null, viewerCategory: '', viewerQuery: '', viewerSeed: 0, viewerSince: 0, viewerStartId: 0, viewerLoading: false, viewerLoadId: 0, feedReady: false, feedIntroTimer: null, lapStart: 0, feedEnded: false, searchQuery: '', searchVideos: [], searchPage: 1, searchPagination: null, searchLoading: false, searchLoadId: 0, searchTimer: null, adminTimer: null, adminSearchTimer: null, adminLoadId: 0, adminFilters: { q: '', category: '', status: '', sort: 'newest' }, page: 1, pagination: null, manageVideo: null, uploadFile: null, route: '', muted: readStore('lv-muted') !== '0' };
const reportedViews = new Set();
const streams = new WeakMap();
const feedVideos = new WeakMap();
const playerActions = new WeakMap();
let playbackObserver = null;
let bufferObserver = null;
let activePlayer = null;

async function api(path, options = {}) {
  const response = await fetch(path, options);
  const body = await response.json().catch(() => ({}));
  if (response.status === 401 && state.user) { state.user = null; navigate('/login', {}, { replace: true }); }
  if (!response.ok) throw new Error(body.error || 'Terjadi kesalahan.');
  return body;
}

function formatTime(value) {
  if (!Number.isFinite(Number(value))) return '—';
  const seconds = Math.max(0, Math.round(Number(value)));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function formatBytes(value) {
  if (!value) return '—';
  const units = ['B', 'KB', 'MB', 'GB']; let size = Number(value); let unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; }
  return `${size.toFixed(unit > 1 ? 1 : 0)} ${units[unit]}`;
}

function attachStream(player, video) {
  streams.get(player)?.destroy();
  streams.delete(player);
  if (video.playbackType !== 'hls') { player.src = video.src; return; }
  if (player.canPlayType('application/vnd.apple.mpegurl')) { player.src = video.src; return; }
  if (window.Hls?.isSupported()) {
    const hls = new window.Hls({ maxBufferLength: 24, backBufferLength: 12 });
    hls.loadSource(video.src); hls.attachMedia(player); streams.set(player, hls);
  }
}

function ensureFeedStream(player) {
  if (player.dataset.streamReady === 'true') return;
  const video = feedVideos.get(player); if (!video) return;
  attachStream(player, video); player.dataset.streamReady = 'true';
}

function releaseFeedStream(player) {
  if (player.dataset.streamReady !== 'true') return;
  streams.get(player)?.destroy(); streams.delete(player); player.pause(); player.removeAttribute('src'); player.load(); delete player.dataset.streamReady;
}

function releaseFeed() {
  playbackObserver?.disconnect(); bufferObserver?.disconnect();
  playbackObserver = null; bufferObserver = null; activePlayer = null;
  document.querySelectorAll('#feed video').forEach(releaseFeedStream);
}

function shuffleSeed() {
  if (globalThis.crypto?.getRandomValues) return globalThis.crypto.getRandomValues(new Uint32Array(1))[0] % 1000000 + 1;
  return Math.floor(Math.random() * 1000000) + 1;
}

const viewerPaths = ['/home', '/watch', '/search', '/profile'];
const appPaths = ['/', '/login', '/admin', ...viewerPaths];

function landingPath() { return state.user?.role === 'admin' ? '/admin' : '/home'; }

function buildUrl(path, params = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== '' && value !== null && value !== undefined) query.set(key, String(value));
  const search = query.toString();
  return search ? `${path}?${search}` : path;
}

function navigate(path, params = {}, { replace = false } = {}) {
  const target = buildUrl(path, params);
  if (target !== location.pathname + location.search) history[replace ? 'replaceState' : 'pushState'](null, '', target);
  return applyRoute();
}

function showTopSection(name) {
  clearTimeout(state.adminTimer);
  if (name !== 'viewer') { releaseFeed(); hideIntro(); }
  $('#home').hidden = name !== 'landing'; $('#login').hidden = name !== 'login';
  $('#viewer').hidden = name !== 'viewer'; $('#admin').hidden = name !== 'admin';
}

async function applyRoute() {
  const path = location.pathname.replace(/(.)\/+$/, '$1');
  const params = new URLSearchParams(location.search);
  if (!appPaths.includes(path)) return navigate(state.user ? landingPath() : '/login', {}, { replace: true });
  if (!state.user) {
    if (path !== '/login') return navigate('/login', {}, { replace: true });
    state.route = path; showTopSection('login'); $('#username').focus(); return;
  }
  if (path === '/login') return navigate(landingPath(), {}, { replace: true });
  if (state.user.role === 'admin' && viewerPaths.includes(path)) return navigate('/admin', {}, { replace: true });
  if (state.user.role !== 'admin' && path === '/admin') return navigate('/home', {}, { replace: true });
  if (path === '/watch' && !params.get('seed')) {
    params.set('seed', String(shuffleSeed()));
    return navigate('/watch', Object.fromEntries(params), { replace: true });
  }
  const signature = `${path}?${params}`;
  const sameRoute = signature === state.route;
  state.route = signature;
  if (path === '/') { showTopSection('landing'); return showLanding(); }
  if (path === '/admin') { showTopSection('admin'); return showAdmin().catch(error => { $('#admin-status').textContent = error.message; }); }
  showTopSection('viewer'); updateViewerIdentity();
  if (path === '/home') return showViewerHome();
  if (path === '/search') return showSearch(params.get('q') || '').catch(routeError);
  if (path === '/profile') return showProfile();
  return showWatch({
    category: params.get('category') || '', query: params.get('q') || '',
    seed: Number(params.get('seed')) || shuffleSeed(), startId: Number(params.get('v')) || 0, keepFeed: sameRoute
  }).catch(error => { $('#empty').textContent = error.message; $('#empty').hidden = false; });
}

function selectViewerTab(tab) {
  for (const name of ['home', 'watch', 'search', 'profile']) {
    $(`#tab-${name}`).classList.toggle('active', name === tab);
  }
}

function showViewerSection(section) {
  $('#viewer-home-view').hidden = section !== 'home';
  $('#feed').hidden = section !== 'watch';
  $('#search-view').hidden = section !== 'search';
  $('#profile-view').hidden = section !== 'profile';
  if (section !== 'watch') { $('#empty').hidden = true; setPull(0); }
  selectViewerTab(section);
}

function updateViewerIdentity() {
  const username = state.user?.username || 'Pengguna';
  const role = state.user?.role === 'admin' ? 'Administrator' : 'Pengguna';
  $('#viewer-name').textContent = username;
  $('#profile-name').textContent = username;
  $('#profile-role').textContent = role;
  $('#profile-avatar').textContent = username.trim().charAt(0).toUpperCase() || 'P';
}

async function showViewerHome() {
  releaseFeed(); hideIntro(); showViewerSection('home');
  await loadHomeVideos();
}

async function showAdmin() {
  state.page = 1;
  api('/api/settings').then(({ feedMode }) => { $('#feed-mode').value = feedMode; }).catch(() => {});
  await loadAdminVideos();
}

function showLanding() {
  const label = state.user?.role === 'admin' ? 'Ke Dasbor' : 'Ke Watch';
  $('#home-enter').textContent = label; $('#home-primary').textContent = label;
}

const icons = {
  back: '<path d="M2.5 4.5v5.5h5.5"/><path d="M4.6 15a8.5 8.5 0 1 0 1.9-8.9L2.5 10"/><text x="12.4" y="15.4">10</text>',
  forward: '<path d="M21.5 4.5v5.5H16"/><path d="M19.4 15a8.5 8.5 0 1 1-1.9-8.9l4 3.9"/><text x="11.6" y="15.4">10</text>',
  heart: '<path d="M20.3 5.3a5 5 0 0 0-7.1 0L12 6.5l-1.2-1.2a5 5 0 0 0-7.1 7.1l8.3 8.3 8.3-8.3a5 5 0 0 0 0-7.1Z"/>',
  crop: '<path d="M6.5 2v13.5a2 2 0 0 0 2 2H22"/><path d="M2 6.5h13.5a2 2 0 0 1 2 2V22"/>',
  fullscreen: '<path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/>',
  volume: '<path d="M11 5 6 9H2v6h4l5 4V5Z" class="solid"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/>',
  mute: '<path d="M11 5 6 9H2v6h4l5 4V5Z" class="solid"/><path d="m16 9.5 5 5m0-5-5 5"/>',
  play: '<path d="M7 4.5v15l13-7.5Z" class="solid"/>',
  pause: '<path d="M9 4.5v15M15 4.5v15"/>'
};

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = icons[name];
  return svg;
}

function control(name, title, className = '') {
  const button = document.createElement('button');
  button.type = 'button'; button.className = `player-button ${className}`.trim(); button.title = title; button.ariaLabel = title;
  button.append(icon(name));
  return button;
}

function setMuted(muted) {
  state.muted = muted; writeStore('lv-muted', muted ? '1' : '0');
  for (const player of document.querySelectorAll('#feed video')) player.muted = muted;
  for (const button of document.querySelectorAll('.sound-button')) button.replaceChildren(icon(muted ? 'mute' : 'volume'));
}

function playPlayer(player) {
  return player.play().catch(() => { player.muted = true; return player.play().catch(() => {}); });
}

function makeCard(video) {
  const card = document.createElement('article'); card.className = 'video-card';
  const player = document.createElement('video');
  player.loop = true; player.muted = state.muted; player.playsInline = true; player.preload = 'auto';
  feedVideos.set(player, video);

  const badge = document.createElement('span'); badge.className = 'tap-badge';
  const buffer = document.createElement('span'); buffer.className = 'buffer-ring';
  function flash(name, className = '') {
    badge.className = `tap-badge ${className}`.trim(); badge.replaceChildren(icon(name));
    void badge.offsetWidth; badge.classList.add('show');
  }
  function togglePlay() {
    if (player.paused) { playPlayer(player); flash('play'); } else { player.pause(); flash('pause'); }
  }
  function seekBy(seconds) {
    player.currentTime = Math.min(player.duration || Infinity, Math.max(0, player.currentTime + seconds));
  }
  async function setLike(next) {
    if (next === video.liked) return;
    const result = await api(`/api/videos/${video.id}/like`, { method: next ? 'POST' : 'DELETE' });
    video.liked = result.liked; video.likeCount = result.likeCount;
    love.classList.toggle('liked', video.liked); count.textContent = video.likeCount || '';
  }

  // Crop memakai object-fit: cover, jadi sisanya digeser lewat object-position.
  const pan = { x: 50, y: 50 };
  let drag = null; let panned = false;
  function panLimits() {
    if (!player.videoWidth || !player.classList.contains('crop')) return { x: 0, y: 0 };
    const rect = player.getBoundingClientRect();
    const scale = Math.max(rect.width / player.videoWidth, rect.height / player.videoHeight);
    return { x: Math.max(0, player.videoWidth * scale - rect.width), y: Math.max(0, player.videoHeight * scale - rect.height) };
  }
  player.addEventListener('pointerdown', event => {
    panned = false;
    if (event.button || !player.classList.contains('crop')) return;
    const limits = panLimits(); if (!limits.x && !limits.y) return;
    drag = { x: event.clientX, y: event.clientY, px: pan.x, py: pan.y, limits };
    player.setPointerCapture(event.pointerId);
  });
  player.addEventListener('pointermove', event => {
    if (!drag) return;
    const dx = event.clientX - drag.x; const dy = event.clientY - drag.y;
    if (!panned && Math.hypot(dx, dy) < 6) return;
    panned = true; player.classList.add('panning');
    if (drag.limits.x) pan.x = Math.min(100, Math.max(0, drag.px - dx / drag.limits.x * 100));
    if (drag.limits.y) pan.y = Math.min(100, Math.max(0, drag.py - dy / drag.limits.y * 100));
    player.style.objectPosition = `${pan.x}% ${pan.y}%`;
  });
  for (const name of ['pointerup', 'pointercancel']) player.addEventListener(name, () => { drag = null; player.classList.remove('panning'); });

  let lastTap = 0;
  player.addEventListener('click', () => {
    if (panned) { panned = false; return; }
    const now = Date.now();
    if (now - lastTap < 300) { lastTap = 0; togglePlay(); flash('heart', 'heart'); setLike(true).catch(() => {}); return; }
    lastTap = now; togglePlay();
  });
  player.addEventListener('waiting', () => card.classList.add('buffering'));
  for (const name of ['playing', 'canplay', 'pause']) player.addEventListener(name, () => card.classList.remove('buffering'));

  const meta = document.createElement('div'); meta.className = 'meta';
  const category = document.createElement('span'); category.className = 'category'; category.textContent = (video.categories || [video.category]).join(' · ');
  const title = document.createElement('h2'); title.textContent = video.title;
  meta.append(category, title);
  if (video.caption) { const caption = document.createElement('p'); caption.textContent = video.caption; meta.append(caption); }

  const seek = document.createElement('div'); seek.className = 'seek-controls';
  const back = control('back', 'Mundur 10 detik');
  const forward = control('forward', 'Maju 10 detik');
  back.addEventListener('click', event => { event.stopPropagation(); seekBy(-10); });
  forward.addEventListener('click', event => { event.stopPropagation(); seekBy(10); });
  seek.append(back, forward);

  const rail = document.createElement('div'); rail.className = 'player-rail';
  const love = control('heart', 'Love', video.liked ? 'liked' : '');
  const count = document.createElement('small'); count.textContent = video.likeCount || '';
  const loveWrap = document.createElement('span'); loveWrap.className = 'love-wrap'; loveWrap.append(love, count);
  love.addEventListener('click', event => { event.stopPropagation(); setLike(!video.liked).catch(() => {}); });
  const crop = control('crop', 'Isi layar');
  crop.addEventListener('click', event => {
    event.stopPropagation();
    const cropped = player.classList.toggle('crop'); crop.classList.toggle('active', cropped);
    if (cropped) player.style.objectPosition = `${pan.x}% ${pan.y}%`; else player.style.removeProperty('object-position');
  });
  const fullscreen = control('fullscreen', 'Layar penuh');
  fullscreen.addEventListener('click', event => {
    event.stopPropagation();
    if (document.fullscreenElement) document.exitFullscreen();
    else if (card.requestFullscreen) card.requestFullscreen(); else if (player.webkitEnterFullscreen) player.webkitEnterFullscreen();
  });
  const sound = control(state.muted ? 'mute' : 'volume', 'Suara', 'sound-button');
  sound.addEventListener('click', event => { event.stopPropagation(); setMuted(!state.muted); });
  rail.append(loveWrap, crop, fullscreen, sound);

  const timeline = document.createElement('div'); timeline.className = 'timeline';
  const progress = document.createElement('input'); progress.type = 'range'; progress.min = '0'; progress.max = '1000'; progress.value = '0'; progress.ariaLabel = 'Posisi video';
  const clock = document.createElement('span'); clock.textContent = `0:00 / ${formatTime(video.durationSeconds)}`;
  player.addEventListener('timeupdate', () => {
    if (player.duration) {
      const ratio = player.currentTime / player.duration;
      progress.value = String(ratio * 1000); progress.style.setProperty('--progress', `${ratio * 100}%`);
    }
    clock.textContent = `${formatTime(player.currentTime)} / ${formatTime(player.duration)}`;
    if (player.currentTime >= 2.5) reportView(video);
  });
  progress.addEventListener('input', event => {
    event.stopPropagation();
    progress.style.setProperty('--progress', `${Number(progress.value) / 10}%`);
    if (player.duration) player.currentTime = Number(progress.value) / 1000 * player.duration;
  });
  progress.addEventListener('pointerdown', () => timeline.classList.add('scrubbing'));
  for (const name of ['pointerup', 'pointercancel']) progress.addEventListener(name, () => timeline.classList.remove('scrubbing'));
  timeline.append(progress, clock);
  playerActions.set(player, { togglePlay, seekBy, fullscreen: () => fullscreen.click(), like: () => setLike(!video.liked).catch(() => {}) });
  card.append(player, buffer, badge, seek, meta, rail, timeline);
  return card;
}

// Reported once per feed session so the FYP ranking can push watched videos down later.
function reportView(video) {
  if (reportedViews.has(video.id)) return;
  reportedViews.add(video.id);
  fetch(`/api/videos/${video.id}/view`, { method: 'POST', keepalive: true }).catch(() => reportedViews.delete(video.id));
}

function playActiveCard() {
  const player = activePlayer; if (!player || !state.feedReady) return;
  ensureFeedStream(player); playPlayer(player);
}

function observePlayback() {
  playbackObserver?.disconnect(); bufferObserver?.disconnect();
  playbackObserver = new IntersectionObserver(entries => entries.forEach(entry => {
    // Kartu yang naik ke layar penuh keluar dari scrollport feed; abaikan supaya
    // videonya tidak ikut dijeda dan streamnya tidak dilepas.
    if (document.fullscreenElement) return;
    const video = entry.target.querySelector('video');
    if (entry.isIntersecting && entry.intersectionRatio > .75) { activePlayer = video; ensureFeedStream(video); if (state.feedReady) playPlayer(video); } else video.pause();
    if (entry.isIntersecting && entry.intersectionRatio > .25 && Number(entry.target.dataset.feedIndex) >= state.videos.length - 2) loadMoreVideos().catch(() => {});
  }), { root: $('#feed'), threshold: [.25, .75] });
  bufferObserver = new IntersectionObserver(entries => entries.forEach(entry => {
    if (document.fullscreenElement) return;
    const player = entry.target.querySelector('video');
    if (entry.isIntersecting) ensureFeedStream(player); else releaseFeedStream(player);
  }), { root: $('#feed'), rootMargin: '50% 0px 75% 0px', threshold: 0 });
  document.querySelectorAll('.video-card').forEach(card => { playbackObserver.observe(card); bufferObserver.observe(card); });
}

async function loadVideos(reset = false) {
  if (state.viewerLoading && !reset) return;
  if (!reset && state.feedEnded) return;
  // Feed tidak pernah mentok: sampai di halaman terakhir, kocok ulang dengan seed baru.
  const relap = !reset && Boolean(state.viewerPagination) && state.viewerPage >= state.viewerPagination.totalPages;
  if (relap) { state.viewerSeed = shuffleSeed(); state.viewerSince = Date.now(); reportedViews.clear(); }
  const loadId = reset ? ++state.viewerLoadId : state.viewerLoadId;
  const page = reset || relap ? 1 : state.viewerPage + 1;
  const query = new URLSearchParams({ page, limit: 5, age: Math.max(0, Date.now() - (state.viewerSince || Date.now())) });
  if (state.viewerCategory) query.set('category', state.viewerCategory);
  if (state.viewerQuery) query.set('q', state.viewerQuery);
  if (state.viewerSeed) query.set('seed', state.viewerSeed);
  state.viewerLoading = true;
  try {
    const [{ videos, pagination }, startVideo] = await Promise.all([
      api(`/api/videos?${query}`),
      reset && state.viewerStartId ? api(`/api/videos/${state.viewerStartId}`).then(body => body.video).catch(() => null) : null
    ]);
    if (loadId !== state.viewerLoadId) return;
    state.viewerPage = pagination.page; state.viewerPagination = pagination;
    if (reset) {
      const opening = startVideo ? [startVideo, ...videos.filter(item => item.id !== startVideo.id)] : videos;
      state.lapStart = 0; state.feedEnded = false; state.videos = opening; renderFeed(opening);
    } else {
      if (relap) state.lapStart = state.videos.length;
      const known = new Set(state.videos.slice(state.lapStart).map(item => item.id));
      const fresh = videos.filter(item => !known.has(item.id));
      if (relap && !fresh.length) state.feedEnded = true;
      state.videos.push(...fresh); renderFeed(fresh, true);
    }
  } finally {
    if (loadId === state.viewerLoadId) state.viewerLoading = false;
  }
}

function loadMoreVideos() { return loadVideos(false); }

function renderFeed(videos, append = false) {
  const offset = append ? state.videos.length - videos.length : 0;
  const cards = videos.map((video, index) => { const card = makeCard(video); card.dataset.feedIndex = offset + index; return card; });
  if (append) $('#feed').append(...cards); else { releaseFeed(); $('#feed').replaceChildren(...cards); $('#feed').scrollTop = 0; }
  $('#empty').textContent = state.viewerCategory ? 'Belum ada video di kategori ini.' : 'Belum ada video.';
  $('#empty').hidden = state.videos.length > 0; observePlayback();
}

async function showWatch({ category = '', query = '', seed = 0, startId = 0, keepFeed = false } = {}) {
  showViewerSection('watch');
  showIntro();
  if (keepFeed && state.videos.length) { observePlayback(); return; }
  state.viewerCategory = category; state.viewerQuery = query; state.viewerSeed = seed; state.viewerStartId = startId;
  state.viewerSince = Date.now(); reportedViews.clear();
  await loadVideos(true);
}

const introDelay = 1900;
function readStore(key) { try { return localStorage.getItem(key); } catch { return null; } }
function writeStore(key, value) { try { localStorage.setItem(key, value); } catch { /* penyimpanan tidak tersedia */ } }
function readFlag(key) { return readStore(key) === '1'; }
function writeFlag(key) { writeStore(key, '1'); }

// Layar instruksi menahan pemutaran sampai penonton siap — bukan langsung menyalak.
function showIntro() {
  const overlay = $('#feed-intro');
  clearTimeout(state.feedIntroTimer);
  state.feedReady = false;
  const seen = readFlag('lv-intro-seen');
  $('#feed-intro-hint').hidden = !seen;
  overlay.classList.remove('visible', 'counting');
  overlay.style.setProperty('--intro-delay', `${introDelay}ms`);
  overlay.hidden = false;
  requestAnimationFrame(() => {
    if (overlay.hidden) return;
    overlay.classList.add('visible');
    if (!seen) return;
    requestAnimationFrame(() => overlay.classList.add('counting'));
    state.feedIntroTimer = setTimeout(dismissIntro, introDelay);
  });
}

function dismissIntro() {
  const overlay = $('#feed-intro');
  clearTimeout(state.feedIntroTimer);
  if (overlay.hidden || state.feedReady) return;
  writeFlag('lv-intro-seen');
  overlay.classList.remove('visible', 'counting');
  setTimeout(() => { if (!overlay.classList.contains('visible')) overlay.hidden = true; }, 320);
  state.feedReady = true;
  playActiveCard();
}

function hideIntro() {
  clearTimeout(state.feedIntroTimer);
  const overlay = $('#feed-intro');
  overlay.classList.remove('visible', 'counting'); overlay.hidden = true;
  state.feedReady = false;
}

function setPull(progress) {
  const indicator = $('#feed-refresh');
  const value = Math.max(0, Math.min(1, progress));
  indicator.style.setProperty('--pull', value.toFixed(3));
  indicator.classList.toggle('armed', value >= 1);
  return value;
}

let reshuffling = false;
async function reshuffleWatch() {
  if (reshuffling || $('#feed').hidden) return;
  reshuffling = true;
  const indicator = $('#feed-refresh'); const startedAt = Date.now();
  indicator.classList.add('spinning'); $('#feed').classList.add('reshuffling');
  state.viewerSeed = shuffleSeed(); state.viewerStartId = 0; state.viewerSince = Date.now(); reportedViews.clear();
  const params = new URLSearchParams(location.search);
  params.set('seed', String(state.viewerSeed)); params.delete('v');
  const target = `/watch?${params}`;
  history.replaceState(null, '', target); state.route = target;
  try { await loadVideos(true); }
  catch (error) { $('#empty').textContent = error.message; $('#empty').hidden = false; }
  finally {
    setTimeout(() => {
      indicator.classList.remove('spinning'); setPull(0);
      $('#feed').classList.remove('reshuffling'); reshuffling = false;
    }, Math.max(0, 520 - (Date.now() - startedAt)));
  }
}

function cardFallback() {
  const fallback = document.createElement('span'); fallback.className = 'card-fallback brand'; fallback.textContent = 'LV'; return fallback;
}

function categoryCard(category, index = 0) {
  const card = document.createElement('button'); card.type = 'button'; card.className = 'category-card'; card.style.setProperty('--i', index);
  if (category.thumbnail) { const image = document.createElement('img'); image.src = category.thumbnail; image.alt = ''; card.append(image); }
  else card.append(cardFallback());
  const overlay = document.createElement('span'); overlay.className = 'category-overlay';
  const name = document.createElement('strong'); name.textContent = category.name;
  const count = document.createElement('small'); count.textContent = `${category.videoCount} video`;
  overlay.append(name, count); card.append(overlay); card.addEventListener('click', () => navigate('/watch', { category: category.name })); return card;
}

function homeVideoCard(video, index = 0) {
  const card = document.createElement('button'); card.type = 'button'; card.className = 'home-video-card'; card.style.setProperty('--i', index);
  const visual = document.createElement('span'); visual.className = 'home-video-visual';
  if (video.thumbnail) {
    const image = document.createElement('img'); image.src = video.thumbnail; image.alt = ''; visual.append(image);
  } else {
    const fallback = document.createElement('span'); fallback.className = 'brand'; fallback.textContent = 'LV'; visual.append(fallback);
  }
  const details = document.createElement('span'); details.className = 'home-video-details';
  const title = document.createElement('strong'); title.textContent = video.title;
  const meta = document.createElement('small'); meta.textContent = `${(video.categories || [video.category]).join(' · ')} · ${formatTime(video.durationSeconds)}`;
  details.append(title, meta); card.append(visual, details); card.addEventListener('click', () => navigate('/watch', { v: video.id })); return card;
}

async function loadHomeVideos() {
  const loadId = ++state.homeLoadId; const empty = $('#home-video-empty');
  empty.textContent = 'Memuat koleksi…'; empty.hidden = false;
  try {
    const { videos, pagination } = await api('/api/videos?page=1&limit=6');
    if (loadId !== state.homeLoadId) return;
    state.homeVideos = videos; state.homePagination = pagination;
    $('#home-video-grid').replaceChildren(...videos.map(homeVideoCard));
    empty.textContent = 'Belum ada video di koleksi.';
    empty.hidden = videos.length > 0;
  } catch (error) {
    if (loadId !== state.homeLoadId) return;
    state.homeVideos = []; state.homePagination = null; $('#home-video-grid').replaceChildren();
    empty.textContent = error.message; empty.hidden = false;
  }
}

function searchVideoCard(video, index = 0) {
  const card = document.createElement('button'); card.type = 'button'; card.className = 'category-card search-video-card'; card.style.setProperty('--i', index);
  if (video.thumbnail) { const image = document.createElement('img'); image.src = video.thumbnail; image.alt = ''; card.append(image); }
  else card.append(cardFallback());
  const overlay = document.createElement('span'); overlay.className = 'category-overlay';
  const title = document.createElement('strong'); title.textContent = video.title;
  const category = document.createElement('small'); category.textContent = (video.categories || [video.category]).join(' · ');
  overlay.append(title, category); card.append(overlay); card.addEventListener('click', () => navigate('/watch', { v: video.id, q: state.searchQuery })); return card;
}

async function showSearch(query = '') {
  releaseFeed(); hideIntro();
  showViewerSection('search');
  if ($('#viewer-search').value !== query) $('#viewer-search').value = query;
  state.searchQuery = query;
  if (query) await loadSearchVideos(true); else await loadSearchCategories();
  if (document.activeElement !== $('#viewer-search')) requestAnimationFrame(() => $('#viewer-search').focus({ preventScroll: true }));
}

async function loadSearchCategories() {
  const loadId = ++state.searchLoadId; state.searchLoading = true; $('#viewer-search-empty').hidden = true;
  try {
    const { categories } = await api('/api/categories'); if (loadId !== state.searchLoadId || state.searchQuery) return;
    $('#search-grid').replaceChildren(...categories.map(categoryCard));
    $('#viewer-search-empty').textContent = 'Belum ada kategori.'; $('#viewer-search-empty').hidden = categories.length > 0;
  } finally { if (loadId === state.searchLoadId) state.searchLoading = false; }
}

async function loadSearchVideos(reset = false) {
  if (!state.searchQuery || (state.searchLoading && !reset)) return;
  if (!reset && state.searchPagination && state.searchPage >= state.searchPagination.totalPages) return;
  const queryValue = state.searchQuery; const loadId = reset ? ++state.searchLoadId : state.searchLoadId;
  const page = reset ? 1 : state.searchPage + 1; const query = new URLSearchParams({ page, limit: 5, q: queryValue });
  state.searchLoading = true;
  try {
    const { videos, pagination } = await api(`/api/videos?${query}`);
    if (loadId !== state.searchLoadId || queryValue !== state.searchQuery) return;
    state.searchPage = pagination.page; state.searchPagination = pagination;
    if (reset) { state.searchVideos = videos; $('#search-grid').replaceChildren(...videos.map(searchVideoCard)); $('#search-view').scrollTop = 0; }
    else { state.searchVideos.push(...videos); $('#search-grid').append(...videos.map(searchVideoCard)); }
    $('#viewer-search-empty').textContent = 'Tidak ada video yang cocok.'; $('#viewer-search-empty').hidden = state.searchVideos.length > 0;
  } finally { if (loadId === state.searchLoadId) state.searchLoading = false; }
}

function showProfile() {
  releaseFeed(); hideIntro(); showViewerSection('profile');
}

async function loadAdminVideos() {
  const loadId = ++state.adminLoadId;
  const query = new URLSearchParams({ page: state.page, limit: 10, sort: state.adminFilters.sort });
  if (state.adminFilters.q) query.set('q', state.adminFilters.q);
  if (state.adminFilters.category) query.set('category', state.adminFilters.category);
  if (state.adminFilters.status) query.set('status', state.adminFilters.status);
  const { videos, pagination, facets } = await api(`/api/videos?${query}`);
  if (loadId !== state.adminLoadId) return;
  state.videos = videos; state.pagination = pagination; state.page = pagination.page; renderAdminList();
  const categorySelect = $('#admin-category'); const selectedCategory = state.adminFilters.category;
  categorySelect.replaceChildren(new Option('Semua kategori', ''), ...(facets?.categories || []).map(category => new Option(category, category)));
  categorySelect.value = selectedCategory;
  clearTimeout(state.adminTimer);
  if (!$('#admin').hidden && videos.some(video => video.ingestStatus === 'downloading' || video.conversionStatus === 'converting' || (video.ingestStatus === 'ready' && video.sourceType === 'upload' && !video.durationSeconds && !video.originalDeleted))) {
    state.adminTimer = setTimeout(loadAdminVideos, 1800);
  }
}

function openPreview(video) {
  $('#preview-title').textContent = video.title;
  attachStream($('#preview-video'), video);
  $('#preview-dialog').showModal();
}

function openMetadata(video) {
  state.manageVideo = video;
  const form = $('#metadata-form'); form.dataset.videoId = video.id;
  $('#metadata-title').value = video.title; $('#metadata-category').value = (video.categories || [video.category]).join(', '); $('#metadata-caption').value = video.caption || '';
  $('#metadata-thumbnail').value = ''; $('#metadata-status').textContent = '';
  if (video.thumbnail) { $('#metadata-preview').src = video.thumbnail; $('#metadata-preview').hidden = false; }
  else { $('#metadata-preview').removeAttribute('src'); $('#metadata-preview').hidden = true; }
  const frameVideo = $('#frame-video');
  $('#frame-picker').hidden = video.sourceType !== 'upload' || video.ingestStatus !== 'ready';
  if (video.sourceType === 'upload' && video.ingestStatus === 'ready') {
    attachStream(frameVideo, video);
    const initialTime = Math.min(5, Math.max(0, Number(video.durationSeconds || 0) * .15));
    $('#frame-time').max = String(video.durationSeconds || 0);
    $('#frame-time').value = String(initialTime);
    $('#frame-clock').textContent = formatTime(initialTime);
    frameVideo.onloadedmetadata = () => { $('#frame-time').max = String(frameVideo.duration || video.durationSeconds || 0); frameVideo.currentTime = initialTime; };
  }
  const canConvert = video.ingestStatus === 'ready' && video.sourceType === 'upload' && !video.originalDeleted && !video.nativeTs && video.conversionStatus !== 'converted';
  $('#manage-convert').hidden = !canConvert;
  $('#manage-convert').disabled = video.conversionStatus === 'converting';
  $('#manage-convert').textContent = video.conversionStatus === 'converting' ? `Konversi ${video.conversionProgress}%` : 'Konversi TS';
  $('#manage-original').hidden = video.sourceType !== 'upload' || video.nativeTs || video.originalDeleted || video.conversionStatus !== 'converted';
  $('#manage-preview').disabled = video.ingestStatus !== 'ready';
  $('#metadata-dialog').showModal();
}

function renderAdminList() {
  if (state.user?.role !== 'admin') return;
  $('#video-count').textContent = state.pagination?.total || 0;
  $('#pagination').hidden = !state.pagination || state.pagination.totalPages <= 1;
  $('#page-info').textContent = `${state.pagination?.page || 1} / ${state.pagination?.totalPages || 1}`;
  $('#page-prev').disabled = !state.pagination || state.pagination.page <= 1;
  $('#page-next').disabled = !state.pagination || state.pagination.page >= state.pagination.totalPages;
  $('#admin-empty').hidden = state.videos.length > 0;
  $('#admin-list').replaceChildren(...state.videos.map(video => {
    const item = document.createElement('article'); item.className = 'admin-item';
    const thumb = document.createElement('div'); thumb.className = 'admin-thumb';
    if (video.thumbnail) { const image = document.createElement('img'); image.src = video.thumbnail; image.alt = ''; thumb.append(image); }
    else thumb.textContent = 'LV';
    const info = document.createElement('div'); info.className = 'admin-info';
    const name = document.createElement('strong'); name.textContent = video.title;
    const details = document.createElement('span'); details.textContent = `${(video.categories || [video.category]).join(', ')} · ${formatTime(video.durationSeconds)} · ${formatBytes(video.sizeBytes)}`;
    const status = document.createElement('span'); status.className = `status status-${video.ingestStatus !== 'ready' ? video.ingestStatus : video.conversionStatus}`;
    status.textContent = video.ingestStatus === 'downloading' ? `Download ${video.ingestProgress ? `${video.ingestProgress}%` : '…'}` : video.ingestStatus === 'failed' ? 'Download gagal' : video.conversionStatus === 'converting' ? `Konversi ${video.conversionProgress}%` : video.conversionStatus === 'failed' ? 'Konversi gagal' : video.conversionStatus === 'converted' ? '' : video.nativeTs ? 'Membaca TS' : 'unoptimised';
    status.hidden = !status.textContent;
    if (video.ingestError || video.conversionError) status.title = video.ingestError || video.conversionError;
    info.append(name, details, status);
    const actions = document.createElement('div'); actions.className = 'admin-actions';
    const manage = document.createElement('button'); manage.textContent = 'Kelola'; manage.addEventListener('click', () => openMetadata(video)); actions.append(manage);
    thumb.addEventListener('click', () => openMetadata(video)); info.addEventListener('click', () => openMetadata(video));
    item.append(thumb, info, actions); return item;
  }));
}

$('#login-form').addEventListener('submit', async event => {
  event.preventDefault(); $('#login-error').textContent = '';
  const submit = event.target.querySelector('button'); submit.disabled = true;
  try {
    const { user } = await api('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: $('#username').value, password: $('#password').value }) });
    $('#password').value = ''; state.user = user; await navigate(landingPath(), {}, { replace: true });
  } catch (error) { $('#login-error').textContent = error.message; }
  finally { submit.disabled = false; }
});

async function logout() { await api('/api/logout', { method: 'POST' }); state.user = null; reportedViews.clear(); await navigate('/login', {}, { replace: true }); }
const routeError = error => { $('#viewer-search-empty').textContent = error.message; $('#viewer-search-empty').hidden = false; };
$('#profile-logout').addEventListener('click', logout); $('#admin-logout').addEventListener('click', logout);
$('#admin-home').addEventListener('click', () => navigate('/'));
$('#home-enter').addEventListener('click', () => navigate(landingPath())); $('#home-primary').addEventListener('click', () => navigate(landingPath()));
$('#tab-home').addEventListener('click', () => navigate('/home'));
$('#home-watch').addEventListener('click', () => navigate('/watch'));
$('#home-see-all').addEventListener('click', () => navigate('/watch'));
$('#tab-watch').addEventListener('click', () => navigate('/watch'));
$('#tab-search').addEventListener('click', () => navigate('/search', { q: state.searchQuery }).catch(routeError));
$('#tab-profile').addEventListener('click', () => navigate('/profile'));
$('#viewer-search-form').addEventListener('submit', event => {
  event.preventDefault(); clearTimeout(state.searchTimer);
  navigate('/search', { q: $('#viewer-search').value.trim() }, { replace: true }).catch(routeError);
});
$('#viewer-search').addEventListener('input', () => {
  clearTimeout(state.searchTimer);
  state.searchTimer = setTimeout(() => navigate('/search', { q: $('#viewer-search').value.trim() }, { replace: true }).catch(routeError), 260);
});
$('#search-view').addEventListener('scroll', () => { if (state.searchQuery && $('#search-view').scrollTop + $('#search-view').clientHeight >= $('#search-view').scrollHeight - 320) loadSearchVideos().catch(() => {}); });
$('#feed-intro').addEventListener('click', dismissIntro);
$('#feed-intro').addEventListener('wheel', dismissIntro, { passive: true });
$('#feed-intro').addEventListener('touchstart', dismissIntro, { passive: true });
document.addEventListener('keydown', event => {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  if (!$('#feed-intro').hidden) { dismissIntro(); return; }
  if ($('#feed').hidden || !state.feedReady) return;
  if (event.target?.closest?.('input, textarea, select, dialog')) return;
  const actions = playerActions.get(activePlayer);
  const keys = {
    ' ': () => actions?.togglePlay(), k: () => actions?.togglePlay(),
    ArrowLeft: () => actions?.seekBy(-10), ArrowRight: () => actions?.seekBy(10),
    ArrowUp: () => $('#feed').scrollBy({ top: -$('#feed').clientHeight, behavior: 'smooth' }),
    ArrowDown: () => $('#feed').scrollBy({ top: $('#feed').clientHeight, behavior: 'smooth' }),
    m: () => setMuted(!state.muted), f: () => actions?.fullscreen(), l: () => actions?.like()
  };
  const action = keys[event.key.length === 1 ? event.key.toLowerCase() : event.key];
  if (action) { event.preventDefault(); action(); }
});

const pullThreshold = 92;
const wheelThreshold = 190;
let feedTouchStart = null; let feedTouchPull = 0; let wheelPull = 0; let wheelTimer = null;
$('#feed').addEventListener('wheel', event => {
  const feed = $('#feed');
  if (reshuffling || feed.scrollTop > 1 || event.deltaY >= 0) { if (wheelPull) { wheelPull = 0; setPull(0); } return; }
  wheelPull += -event.deltaY;
  clearTimeout(wheelTimer); wheelTimer = setTimeout(() => { wheelPull = 0; setPull(0); }, 300);
  if (wheelPull >= wheelThreshold) { wheelPull = 0; clearTimeout(wheelTimer); reshuffleWatch().catch(() => {}); return; }
  setPull(wheelPull / wheelThreshold);
}, { passive: true });
$('#feed').addEventListener('touchstart', event => {
  feedTouchStart = !reshuffling && $('#feed').scrollTop <= 1 && event.touches.length === 1 ? event.touches[0].clientY : null;
  feedTouchPull = 0;
}, { passive: true });
$('#feed').addEventListener('touchmove', event => {
  if (feedTouchStart === null) return;
  if ($('#feed').scrollTop > 1) { feedTouchStart = null; feedTouchPull = 0; setPull(0); return; }
  const distance = (event.touches[0]?.clientY ?? feedTouchStart) - feedTouchStart;
  if (distance <= 0) { if (feedTouchPull) { feedTouchPull = 0; setPull(0); } return; }
  feedTouchPull = distance;
  if (event.cancelable) event.preventDefault();
  setPull(distance / pullThreshold);
}, { passive: false });
for (const eventName of ['touchend', 'touchcancel']) $('#feed').addEventListener(eventName, () => {
  if (feedTouchPull >= pullThreshold) reshuffleWatch().catch(() => {}); else setPull(0);
  feedTouchStart = null; feedTouchPull = 0;
}, { passive: true });
$('#preview-dialog').addEventListener('close', () => { const player = $('#preview-video'); streams.get(player)?.destroy(); player.pause(); player.removeAttribute('src'); player.load(); });
$('#metadata-dialog').addEventListener('close', () => { const player = $('#frame-video'); streams.get(player)?.destroy(); player.pause(); player.removeAttribute('src'); player.load(); });
function selectAddTab(tab) {
  const upload = tab === 'upload';
  $('#upload-form').hidden = !upload; $('#url-form').hidden = upload; $('#upload-tab').classList.toggle('active', upload); $('#url-tab').classList.toggle('active', !upload);
}
$('#upload-open').addEventListener('click', () => { selectAddTab('upload'); $('#upload-dialog').showModal(); });
$('#upload-tab').addEventListener('click', () => selectAddTab('upload'));
$('#url-tab').addEventListener('click', () => selectAddTab('url'));
function setUploadFile(file) { state.uploadFile = file || null; $('#drop-file').textContent = file ? `${file.name} · ${formatBytes(file.size)}` : 'atau klik untuk memilih'; $('#dropzone').classList.toggle('has-file', Boolean(file)); }
$('#dropzone').addEventListener('click', () => $('#video-file').click());
$('#dropzone').addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); $('#video-file').click(); } });
$('#video-file').addEventListener('change', () => setUploadFile($('#video-file').files[0]));
for (const eventName of ['dragenter', 'dragover']) $('#dropzone').addEventListener(eventName, event => { event.preventDefault(); $('#dropzone').classList.add('dragging'); });
for (const eventName of ['dragleave', 'drop']) $('#dropzone').addEventListener(eventName, event => { event.preventDefault(); $('#dropzone').classList.remove('dragging'); });
$('#dropzone').addEventListener('drop', event => { const file = [...event.dataTransfer.files].find(item => /\.(mp4|webm|mov|ts)$/i.test(item.name)); if (file) setUploadFile(file); else $('#upload-status').textContent = 'Gunakan MP4, WebM, MOV, atau TS.'; });
async function applyAdminTools() {
  clearTimeout(state.adminSearchTimer); clearTimeout(state.adminTimer);
  state.adminFilters.q = $('#admin-search').value.trim(); state.adminFilters.category = $('#admin-category').value;
  state.adminFilters.status = $('#admin-status-filter').value; state.adminFilters.sort = $('#admin-sort').value;
  state.page = 1;
  try { await loadAdminVideos(); } catch (error) { $('#admin-status').textContent = error.message; }
}
$('#admin-tools').addEventListener('submit', event => { event.preventDefault(); applyAdminTools(); });
$('#admin-search').addEventListener('input', () => { clearTimeout(state.adminSearchTimer); state.adminSearchTimer = setTimeout(applyAdminTools, 260); });
for (const selector of ['#admin-category', '#admin-status-filter', '#admin-sort']) $(selector).addEventListener('change', applyAdminTools);
$('#page-prev').addEventListener('click', async () => { if (state.page > 1) { state.page -= 1; await loadAdminVideos(); } });
$('#page-next').addEventListener('click', async () => { if (state.pagination && state.page < state.pagination.totalPages) { state.page += 1; await loadAdminVideos(); } });
$('#feed-mode').addEventListener('change', async () => {
  const status = $('#admin-status');
  try {
    const { feedMode } = await api('/api/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ feedMode: $('#feed-mode').value }) });
    status.textContent = feedMode === 'fyp' ? 'Feed pengguna: FYP (belum ditonton dulu, disukai naik).' : 'Feed pengguna: acak murni.';
  } catch (error) { status.textContent = error.message; }
});
$('#sync-videos').addEventListener('click', async () => {
  const status = $('#admin-status');
  try {
    const result = await api('/api/videos/sync', { method: 'POST' });
    status.textContent = `Sync: ${result.added} baru, ${result.existing} sudah ada, ${result.skipped} dilewati.`;
    state.page = 1; await loadAdminVideos();
  } catch (error) { status.textContent = error.message; }
});
$('#upload-form').addEventListener('submit', event => {
  event.preventDefault();
  const file = state.uploadFile || $('#video-file').files[0]; if (!file) { $('#upload-status').textContent = 'Pilih atau tarik video terlebih dahulu.'; return; }
  const status = $('#upload-status'); const progress = $('#upload-progress');
  const query = new URLSearchParams({ title: $('#video-title').value || file.name.replace(/\.[^.]+$/, ''), category: $('#video-category').value || 'Umum', caption: $('#video-caption').value });
  const request = new XMLHttpRequest(); request.open('POST', `/api/videos/upload?${query}`);
  const uploadType = file.type || (file.name.toLowerCase().endsWith('.ts') ? 'video/mp2t' : 'video/mp4');
  request.setRequestHeader('Content-Type', uploadType);
  progress.hidden = false; status.textContent = 'Mengunggah 0%';
  request.upload.onprogress = event => { if (event.lengthComputable) { const percent = Math.round(event.loaded / event.total * 100); progress.value = percent; status.textContent = `Mengunggah ${percent}%`; } };
  request.onload = async () => {
    progress.hidden = true;
    if (request.status >= 200 && request.status < 300) { event.target.reset(); setUploadFile(null); status.textContent = ''; $('#upload-dialog').close(); $('#admin-status').textContent = 'Video ditambahkan.'; state.page = 1; await loadAdminVideos(); }
    else { try { status.textContent = JSON.parse(request.responseText).error; } catch { status.textContent = 'Upload gagal.'; } }
  };
  request.onerror = () => { progress.hidden = true; status.textContent = 'Upload gagal.'; }; request.send(file);
});
$('#url-form').addEventListener('submit', async event => {
  event.preventDefault(); const status = $('#url-status'); status.textContent = 'Menambahkan…';
  try {
    await api('/api/videos/url', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: $('#video-url').value, title: $('#url-title').value, category: $('#url-category').value || 'Umum' }) });
    event.target.reset(); status.textContent = ''; $('#upload-dialog').close(); $('#admin-status').textContent = 'Download URL dimulai di background.'; state.page = 1; await loadAdminVideos();
  } catch (error) { status.textContent = error.message; }
});
$('#metadata-form').addEventListener('submit', async event => {
  event.preventDefault(); const status = $('#metadata-status'); const id = event.target.dataset.videoId; status.textContent = 'Menyimpan…';
  try {
    await api(`/api/videos/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: $('#metadata-title').value, category: $('#metadata-category').value, caption: $('#metadata-caption').value }) });
    const image = $('#metadata-thumbnail').files[0];
    if (image) await api(`/api/videos/${id}/thumbnail`, { method: 'POST', headers: { 'Content-Type': image.type }, body: image });
    status.textContent = ''; $('#metadata-dialog').close(); $('#admin-status').textContent = 'Metadata diperbarui.'; await loadAdminVideos();
  } catch (error) { status.textContent = error.message; }
});
$('#frame-time').addEventListener('input', () => { const time = Number($('#frame-time').value); $('#frame-video').currentTime = time; $('#frame-clock').textContent = formatTime(time); });
$('#frame-video').addEventListener('timeupdate', () => { const player = $('#frame-video'); if (!player.duration) return; $('#frame-time').value = String(player.currentTime); $('#frame-clock').textContent = formatTime(player.currentTime); });
$('#frame-capture').addEventListener('click', async () => {
  const video = state.manageVideo; if (!video) return;
  const status = $('#metadata-status'); let percent = 4; status.textContent = `Mengambil frame ${percent}%`;
  const ticker = setInterval(() => { percent = Math.min(92, percent + Math.max(1, Math.round((94 - percent) * .12))); status.textContent = `Mengambil frame ${percent}%`; }, 160);
  try {
    const result = await api(`/api/videos/${video.id}/thumbnail/frame`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ time: $('#frame-video').currentTime || Number($('#frame-time').value) || 0 }) });
    clearInterval(ticker); $('#metadata-preview').src = result.thumbnail; $('#metadata-preview').hidden = false; status.textContent = 'Mengambil frame 100%'; await loadAdminVideos();
  } catch (error) { clearInterval(ticker); status.textContent = error.message; }
});
$('#manage-preview').addEventListener('click', () => {
  const video = state.manageVideo; if (!video) return;
  $('#metadata-dialog').close(); openPreview(video);
});
$('#manage-convert').addEventListener('click', async () => {
  const video = state.manageVideo; if (!video) return;
  try { await api(`/api/videos/${video.id}/convert`, { method: 'POST' }); $('#metadata-dialog').close(); $('#admin-status').textContent = 'Konversi dimulai.'; await loadAdminVideos(); }
  catch (error) { $('#metadata-status').textContent = error.message; }
});
$('#manage-original').addEventListener('click', async () => {
  const video = state.manageVideo; if (!video || !confirm('Hapus MP4 asli? Versi HLS tetap ditayangkan.')) return;
  try { await api(`/api/videos/${video.id}/original`, { method: 'DELETE' }); $('#metadata-dialog').close(); $('#admin-status').textContent = 'MP4 asli dihapus.'; await loadAdminVideos(); }
  catch (error) { $('#metadata-status').textContent = error.message; }
});
$('#manage-delete').addEventListener('click', async () => {
  const video = state.manageVideo; if (!video || !confirm(`Hapus “${video.title}” beserta seluruh berkasnya?`)) return;
  try { await api(`/api/videos/${video.id}`, { method: 'DELETE' }); $('#metadata-dialog').close(); $('#admin-status').textContent = 'Video dihapus.'; await loadAdminVideos(); }
  catch (error) { $('#metadata-status').textContent = error.message; }
});

window.addEventListener('popstate', () => applyRoute());
api('/api/me')
  .then(({ user }) => { state.user = user || null; })
  .catch(() => { state.user = null; })
  .finally(() => applyRoute());
