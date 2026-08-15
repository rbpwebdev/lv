const $ = selector => document.querySelector(selector);
const state = { user: null, videos: [], viewerPage: 1, viewerPagination: null, viewerCategory: '', viewerQuery: '', viewerSeed: 0, viewerLoading: false, viewerLoadId: 0, searchQuery: '', searchVideos: [], searchPage: 1, searchPagination: null, searchLoading: false, searchLoadId: 0, searchTimer: null, adminTimer: null, adminSearchTimer: null, adminLoadId: 0, adminFilters: { q: '', category: '', status: '', sort: 'newest' }, page: 1, pagination: null, manageVideo: null, uploadFile: null };
const streams = new WeakMap();
const feedVideos = new WeakMap();
let playbackObserver = null;
let bufferObserver = null;

async function api(path, options = {}) {
  const response = await fetch(path, options);
  const body = await response.json().catch(() => ({}));
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
  playbackObserver = null; bufferObserver = null;
  document.querySelectorAll('#feed video').forEach(releaseFeedStream);
}

function shuffleSeed() {
  if (globalThis.crypto?.getRandomValues) return globalThis.crypto.getRandomValues(new Uint32Array(1))[0] % 1000000 + 1;
  return Math.floor(Math.random() * 1000000) + 1;
}

function showLogin() {
  clearTimeout(state.adminTimer); releaseFeed();
  $('#home').hidden = true; $('#viewer').hidden = true; $('#admin').hidden = true; $('#login').hidden = false; $('#username').focus();
}

async function showViewer(user) {
  state.user = user; $('#home').hidden = true; $('#login').hidden = true; $('#admin').hidden = true; $('#viewer').hidden = false; await showWatch();
}

async function showAdmin(user) {
  state.user = user; state.page = 1; $('#home').hidden = true; $('#login').hidden = true; $('#viewer').hidden = true; $('#admin').hidden = false; await loadAdminVideos();
}

function enterApp(user) { return user.role === 'admin' ? showAdmin(user) : showViewer(user); }

function showHome() {
  clearTimeout(state.adminTimer); releaseFeed();
  $('#login').hidden = true; $('#viewer').hidden = true; $('#admin').hidden = true; $('#home').hidden = false;
  const label = state.user?.role === 'admin' ? 'Ke Dasbor' : 'Ke Watch'; $('#home-enter').textContent = label; $('#home-primary').textContent = label;
}

function control(label, title, className = '') {
  const button = document.createElement('button');
  button.type = 'button'; button.className = `player-button ${className}`; button.textContent = label; button.title = title;
  return button;
}

function makeCard(video) {
  const card = document.createElement('article'); card.className = 'video-card';
  const player = document.createElement('video');
  player.loop = true; player.muted = true; player.playsInline = true; player.preload = 'auto';
  feedVideos.set(player, video);
  player.addEventListener('click', () => player.paused ? player.play() : player.pause());

  const meta = document.createElement('div'); meta.className = 'meta';
  const category = document.createElement('span'); category.className = 'category'; category.textContent = (video.categories || [video.category]).join(' · ');
  const title = document.createElement('h2'); title.textContent = video.title;
  meta.append(category, title);
  if (video.caption) { const caption = document.createElement('p'); caption.textContent = video.caption; meta.append(caption); }

  const seek = document.createElement('div'); seek.className = 'seek-controls';
  const back = control('−10', 'Mundur 10 detik');
  const forward = control('+10', 'Maju 10 detik');
  back.addEventListener('click', event => { event.stopPropagation(); player.currentTime = Math.max(0, player.currentTime - 10); });
  forward.addEventListener('click', event => { event.stopPropagation(); player.currentTime = Math.min(player.duration || Infinity, player.currentTime + 10); });
  seek.append(back, forward);

  const rail = document.createElement('div'); rail.className = 'player-rail';
  const love = control(video.liked ? '♥' : '♡', 'Love', video.liked ? 'liked' : '');
  const count = document.createElement('small'); count.textContent = video.likeCount || '';
  const loveWrap = document.createElement('span'); loveWrap.className = 'love-wrap'; loveWrap.append(love, count);
  love.addEventListener('click', async event => {
    event.stopPropagation();
    const next = !video.liked;
    const result = await api(`/api/videos/${video.id}/like`, { method: next ? 'POST' : 'DELETE' });
    video.liked = result.liked; video.likeCount = result.likeCount;
    love.textContent = video.liked ? '♥' : '♡'; love.classList.toggle('liked', video.liked); count.textContent = video.likeCount || '';
  });
  const crop = control('▣', 'Fit / crop');
  crop.addEventListener('click', event => { event.stopPropagation(); player.classList.toggle('crop'); crop.classList.toggle('active'); });
  const fullscreen = control('⛶', 'Layar penuh');
  fullscreen.addEventListener('click', event => {
    event.stopPropagation();
    if (card.requestFullscreen) card.requestFullscreen(); else if (player.webkitEnterFullscreen) player.webkitEnterFullscreen();
  });
  const sound = control('◖', 'Suara');
  sound.addEventListener('click', event => { event.stopPropagation(); player.muted = !player.muted; sound.textContent = player.muted ? '◖' : '♪'; });
  rail.append(loveWrap, crop, fullscreen, sound);

  const timeline = document.createElement('div'); timeline.className = 'timeline';
  const progress = document.createElement('input'); progress.type = 'range'; progress.min = '0'; progress.max = '1000'; progress.value = '0'; progress.ariaLabel = 'Posisi video';
  const clock = document.createElement('span'); clock.textContent = `0:00 / ${formatTime(video.durationSeconds)}`;
  player.addEventListener('timeupdate', () => { if (player.duration) progress.value = String(player.currentTime / player.duration * 1000); clock.textContent = `${formatTime(player.currentTime)} / ${formatTime(player.duration)}`; });
  progress.addEventListener('input', event => { event.stopPropagation(); if (player.duration) player.currentTime = Number(progress.value) / 1000 * player.duration; });
  timeline.append(progress, clock);
  card.append(player, seek, meta, rail, timeline);
  return card;
}

function observePlayback() {
  playbackObserver?.disconnect(); bufferObserver?.disconnect();
  playbackObserver = new IntersectionObserver(entries => entries.forEach(entry => {
    const video = entry.target.querySelector('video');
    if (entry.isIntersecting && entry.intersectionRatio > .75) { ensureFeedStream(video); video.play().catch(() => {}); } else video.pause();
    if (entry.isIntersecting && entry.intersectionRatio > .25) {
      const index = state.videos.findIndex(item => item.id === Number(entry.target.dataset.videoId));
      if (index >= state.videos.length - 2) loadMoreVideos().catch(() => {});
    }
  }), { root: $('#feed'), threshold: [.25, .75] });
  bufferObserver = new IntersectionObserver(entries => entries.forEach(entry => {
    const player = entry.target.querySelector('video');
    if (entry.isIntersecting) ensureFeedStream(player); else releaseFeedStream(player);
  }), { root: $('#feed'), rootMargin: '50% 0px 75% 0px', threshold: 0 });
  document.querySelectorAll('.video-card').forEach(card => { playbackObserver.observe(card); bufferObserver.observe(card); });
}

async function loadVideos(reset = false) {
  if (state.viewerLoading && !reset) return;
  if (!reset && state.viewerPagination && state.viewerPage >= state.viewerPagination.totalPages) return;
  const loadId = reset ? ++state.viewerLoadId : state.viewerLoadId;
  const page = reset ? 1 : state.viewerPage + 1;
  const query = new URLSearchParams({ page, limit: 5 });
  if (state.viewerCategory) query.set('category', state.viewerCategory);
  if (state.viewerQuery) query.set('q', state.viewerQuery);
  if (state.viewerSeed) query.set('seed', state.viewerSeed);
  state.viewerLoading = true;
  try {
    const { videos, pagination } = await api(`/api/videos?${query}`);
    if (loadId !== state.viewerLoadId) return;
    state.viewerPage = pagination.page; state.viewerPagination = pagination;
    if (reset) { state.videos = videos; renderFeed(videos); }
    else { state.videos.push(...videos); renderFeed(videos, true); }
  } finally {
    if (loadId === state.viewerLoadId) state.viewerLoading = false;
  }
}

function loadMoreVideos() { return loadVideos(false); }

function renderFeed(videos, append = false) {
  const cards = videos.map(video => { const card = makeCard(video); card.dataset.videoId = video.id; return card; });
  if (append) $('#feed').append(...cards); else { releaseFeed(); $('#feed').replaceChildren(...cards); $('#feed').scrollTop = 0; }
  $('#empty').textContent = state.viewerCategory ? 'Belum ada video di kategori ini.' : 'Belum ada video.';
  $('#empty').hidden = state.videos.length > 0; observePlayback();
}

async function showWatch(category = '', query = '') {
  $('#search-view').hidden = true; $('#feed').hidden = false; $('#tab-watch').classList.add('active'); $('#tab-search').classList.remove('active');
  state.viewerCategory = category; state.viewerQuery = query; state.viewerSeed = query ? 0 : shuffleSeed(); await loadVideos(true);
}

let reshuffling = false;
async function reshuffleWatch() {
  if (reshuffling || $('#feed').hidden || $('#feed').scrollTop > 1) return;
  reshuffling = true; $('#feed').classList.add('reshuffling'); state.viewerSeed = shuffleSeed();
  try { await loadVideos(true); } finally { $('#feed').classList.remove('reshuffling'); reshuffling = false; }
}

function categoryCard(category) {
  const card = document.createElement('button'); card.type = 'button'; card.className = 'category-card';
  if (category.thumbnail) { const image = document.createElement('img'); image.src = category.thumbnail; image.alt = ''; card.append(image); }
  const overlay = document.createElement('span'); overlay.className = 'category-overlay';
  const name = document.createElement('strong'); name.textContent = category.name;
  const count = document.createElement('small'); count.textContent = `${category.videoCount} video`;
  overlay.append(name, count); card.append(overlay); card.addEventListener('click', () => showWatch(category.name)); return card;
}

function searchVideoCard(video) {
  const card = document.createElement('button'); card.type = 'button'; card.className = 'category-card search-video-card';
  if (video.thumbnail) { const image = document.createElement('img'); image.src = video.thumbnail; image.alt = ''; card.append(image); }
  const overlay = document.createElement('span'); overlay.className = 'category-overlay';
  const title = document.createElement('strong'); title.textContent = video.title;
  const category = document.createElement('small'); category.textContent = (video.categories || [video.category]).join(' · ');
  overlay.append(title, category); card.append(overlay); card.addEventListener('click', () => openSearchResult(video)); return card;
}

async function showSearch() {
  releaseFeed();
  $('#feed').hidden = true; $('#search-view').hidden = false; $('#empty').hidden = true; $('#tab-watch').classList.remove('active'); $('#tab-search').classList.add('active');
  state.searchQuery = $('#viewer-search').value.trim();
  if (state.searchQuery) await loadSearchVideos(true); else await loadSearchCategories();
  requestAnimationFrame(() => $('#viewer-search').focus({ preventScroll: true }));
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

function openSearchResult(video) {
  state.viewerCategory = ''; state.viewerQuery = state.searchQuery; state.viewerSeed = 0; state.viewerPage = state.searchPage; state.viewerPagination = state.searchPagination; state.videos = [...state.searchVideos];
  $('#search-view').hidden = true; $('#feed').hidden = false; $('#tab-search').classList.remove('active'); $('#tab-watch').classList.add('active'); renderFeed(state.videos);
  requestAnimationFrame(() => { const card = document.querySelector(`#feed [data-video-id="${video.id}"]`); if (card) $('#feed').scrollTop = card.offsetTop; });
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
  try {
    const { user } = await api('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: $('#username').value, password: $('#password').value }) });
    $('#password').value = ''; await enterApp(user);
  } catch (error) { $('#login-error').textContent = error.message; }
});

async function logout() { await api('/api/logout', { method: 'POST' }); showLogin(); }
$('#logout').addEventListener('click', logout); $('#admin-logout').addEventListener('click', logout);
$('#viewer-home').addEventListener('click', showHome); $('#admin-home').addEventListener('click', showHome);
$('#home-enter').addEventListener('click', () => enterApp(state.user)); $('#home-primary').addEventListener('click', () => enterApp(state.user));
$('#tab-watch').addEventListener('click', () => showWatch());
$('#tab-search').addEventListener('click', () => showSearch().catch(error => { $('#viewer-search-empty').textContent = error.message; $('#viewer-search-empty').hidden = false; }));
$('#viewer-search-form').addEventListener('submit', event => { event.preventDefault(); clearTimeout(state.searchTimer); state.searchQuery = $('#viewer-search').value.trim(); (state.searchQuery ? loadSearchVideos(true) : loadSearchCategories()).catch(error => { $('#viewer-search-empty').textContent = error.message; $('#viewer-search-empty').hidden = false; }); });
$('#viewer-search').addEventListener('input', () => {
  clearTimeout(state.searchTimer); state.searchTimer = setTimeout(() => {
    state.searchQuery = $('#viewer-search').value.trim();
    (state.searchQuery ? loadSearchVideos(true) : loadSearchCategories()).catch(error => { $('#viewer-search-empty').textContent = error.message; $('#viewer-search-empty').hidden = false; });
  }, 260);
});
$('#search-view').addEventListener('scroll', () => { if (state.searchQuery && $('#search-view').scrollTop + $('#search-view').clientHeight >= $('#search-view').scrollHeight - 320) loadSearchVideos().catch(() => {}); });
$('#feed').addEventListener('wheel', event => { if ($('#feed').scrollTop <= 1 && event.deltaY < -45) reshuffleWatch().catch(() => {}); }, { passive: true });
let feedTouchStart = null; let feedTouchPull = 0;
$('#feed').addEventListener('touchstart', event => { feedTouchStart = $('#feed').scrollTop <= 1 ? event.touches[0]?.clientY ?? null : null; feedTouchPull = 0; }, { passive: true });
$('#feed').addEventListener('touchmove', event => { if (feedTouchStart !== null) feedTouchPull = Math.max(0, (event.touches[0]?.clientY ?? feedTouchStart) - feedTouchStart); }, { passive: true });
$('#feed').addEventListener('touchend', () => { if (feedTouchPull > 72) reshuffleWatch().catch(() => {}); feedTouchStart = null; feedTouchPull = 0; }, { passive: true });
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

api('/api/me').then(({ user }) => user ? enterApp(user) : showLogin()).catch(showLogin);
