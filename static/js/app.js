/**
 * FP Analyzer — Main Application JavaScript
 * ==========================================
 * Track-aware navigation for triple-riding false positive annotation.
 * - → / ← : next/prev frame within (or across) tracks
 * - Shift+→ / Shift+← : first image of next/prev track
 * - 1–9: assign class (no auto-advance)
 * - Jump input: go directly to track N
 */

/* ─────────────────────────────────────────
   State
───────────────────────────────────────── */
const PAGE_SIZE = 12;

const AppState = {
  loaded: false,
  totalImages: 0,
  totalTracks: 0,
  annotatedCount: 0,
  currentIndex: 0,
  currentClass: null,
  currentTrackKey: null,   // track_key of the currently displayed image
  classes: [],
  images: [],
  tracks: [],
  trackMap: {},             // track_key -> [img_name, ...]
  imageAnnotationMap: {},
  dashFilter: 'all',
  dashPage: 1,
};

/* ─────────────────────────────────────────
   DOM References
───────────────────────────────────────── */
const $ = id => document.getElementById(id);

const DOM = {
  screens: {
    setup:     $('screen-setup'),
    annotate:  $('screen-annotate'),
    dashboard: $('screen-dashboard'),
  },
  header: {
    status:        $('header-status'),
    progressBar:   $('progress-bar'),
    progressLabel: $('progress-label'),
    btnDashboard:  $('btn-view-dashboard'),
    btnAnnotate:   $('btn-view-annotate'),
    btnExport:     $('btn-export'),
  },
  setup: {
    folderInput: $('folder-path'),
    error:       $('setup-error'),
  },
  annotate: {
    metaFilename:  $('meta-filename'),
    metaIndex:     $('meta-index'),
    classBadge:    $('current-class-badge'),
    classText:     $('current-class-text'),
    classList:     $('class-list'),
    newClassInput: $('new-class-input'),
    mainImage:     $('main-image'),
    imageOverlay:  $('image-overlay'),
    overlayClass:  $('overlay-class'),
    navCounter:    $('nav-counter'),
    btnPrev:       $('btn-prev'),
    btnNext:       $('btn-next'),
    btnPrevTrack:  $('btn-prev-track'),
    btnNextTrack:  $('btn-next-track'),
    btnUnannotate: $('btn-unannotate'),
  },
  trackBar: {
    badge:         $('track-badge'),
    detail:        $('track-detail'),
    frameInfo:     $('track-frame-info'),
    jumpInput:     $('jump-input'),
    totalLabel:    $('total-tracks-label'),
  },
  dashboard: {
    stats: $('dash-stats'),
    grid:  $('image-grid'),
    empty: $('dash-empty'),
  },
  loadingOverlay: $('loading-overlay'),
  toast:          $('toast'),
};

/* ─────────────────────────────────────────
   Utility: API helpers
───────────────────────────────────────── */
async function apiFetch(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

/* ─────────────────────────────────────────
   Utility: Toast
───────────────────────────────────────── */
let _toastTimer = null;
function showToast(msg, type = '') {
  const t = DOM.toast;
  t.textContent = msg;
  t.className = `toast show ${type ? 'toast-' + type : ''}`;
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { t.className = 'toast hidden'; }, 2500);
}

/* ─────────────────────────────────────────
   Utility: Loading
───────────────────────────────────────── */
function setLoading(show) {
  DOM.loadingOverlay.classList.toggle('hidden', !show);
}

/* ─────────────────────────────────────────
   Screen Management
───────────────────────────────────────── */
function showScreen(name) {
  Object.entries(DOM.screens).forEach(([key, el]) => {
    el.classList.toggle('active', key === name);
    el.classList.toggle('hidden', key !== name);
  });

  const loaded = AppState.loaded;
  DOM.header.btnDashboard.style.display = (loaded && name !== 'dashboard') ? '' : 'none';
  DOM.header.btnAnnotate.style.display  = (loaded && name !== 'annotate')  ? '' : 'none';
  DOM.header.btnExport.style.display    = loaded ? '' : 'none';
  DOM.header.status.style.display       = loaded ? '' : 'none';
}

/* ─────────────────────────────────────────
   Progress Bar
───────────────────────────────────────── */
function updateProgress() {
  const pct = AppState.totalImages > 0
    ? (AppState.annotatedCount / AppState.totalImages) * 100
    : 0;
  DOM.header.progressBar.style.width = pct + '%';
  DOM.header.progressLabel.textContent =
    `${AppState.annotatedCount} / ${AppState.totalImages}`;
}

/* ─────────────────────────────────────────
   Track Info Bar
───────────────────────────────────────── */
function updateTrackBar(info) {
  // info: { track_key, track_index (0-based), track_size, track_all_frames, pos_in_track, frame, video_name, aid, index, total, total_tracks }
  if (!info || info.track_key == null) return;

  const trackNum = info.track_index + 1;  // 1-based for display
  const total    = info.total_tracks;

  DOM.trackBar.badge.textContent  = `Track ${trackNum} / ${total}`;
  DOM.trackBar.detail.textContent = `📹 ${info.video_name}  •  AID: ${info.aid}`;

  const allFrames = info.track_all_frames ?? info.track_size;
  DOM.trackBar.frameInfo.textContent =
    `3r crop ${info.pos_in_track} of ${info.track_size}  |  frame# ${info.frame}  |  ${allFrames} total frames in track`;

  DOM.trackBar.totalLabel.textContent = `of ${total} tracks`;

  // Update nav counter
  DOM.annotate.navCounter.textContent = `${info.index + 1} / ${info.total}`;
}

/* ─────────────────────────────────────────
   LOAD FOLDER
───────────────────────────────────────── */
async function loadFolder() {
  const path = DOM.setup.folderInput.value.trim();
  DOM.setup.error.classList.add('hidden');

  if (!path) {
    showSetupError('Please enter a folder path.');
    return;
  }

  setLoading(true);
  try {
    const data = await apiFetch('/api/load_folder', {
      method: 'POST',
      body: JSON.stringify({ folder_path: path }),
    });

    AppState.loaded      = true;
    AppState.totalImages = data.total;
    AppState.totalTracks = data.total_tracks;
    AppState.currentIndex = 0;

    await refreshStatus();

    showScreen('annotate');
    await loadImageAtIndex(0);
  } catch (err) {
    showSetupError(err.message);
  } finally {
    setLoading(false);
  }
}

function showSetupError(msg) {
  DOM.setup.error.textContent = msg;
  DOM.setup.error.classList.remove('hidden');
}

/* ─────────────────────────────────────────
   REFRESH STATUS
───────────────────────────────────────── */
async function refreshStatus() {
  const data = await apiFetch('/api/status');
  if (!data.loaded) return;

  AppState.totalImages       = data.total;
  AppState.totalTracks       = data.total_tracks;
  AppState.annotatedCount    = data.annotated;
  AppState.currentIndex      = data.current_index;
  AppState.classes           = data.classes || [];
  AppState.images            = data.images  || [];
  AppState.tracks            = data.tracks  || [];
  AppState.trackMap          = data.track_map || {};
  AppState.imageAnnotationMap = data.image_annotation_map || {};

  updateProgress();
  renderClassList();

  // Keep jump input max in sync
  DOM.trackBar.totalLabel.textContent = `of ${AppState.totalTracks} tracks`;
  DOM.trackBar.jumpInput.max = AppState.totalTracks;
}

/* ─────────────────────────────────────────
   LOAD IMAGE AT INDEX
───────────────────────────────────────── */
async function loadImageAtIndex(index) {
  setLoading(true);
  try {
    const info = await apiFetch(`/api/image_info/${index}`);
    AppState.currentIndex = index;
    AppState.currentClass = info.class || null;

    // Update image src
    const img = DOM.annotate.mainImage;
    img.style.opacity = '0';
    img.src = `/api/image/${index}?t=${Date.now()}`;
    img.onload = () => { img.style.opacity = '1'; };

    // Update meta
    DOM.annotate.metaFilename.textContent = info.name;
    DOM.annotate.metaIndex.textContent    = `Image ${index + 1} of ${info.total}`;

    // Track bar
    updateTrackBar(info);
    AppState.currentTrackKey = info.track_key || null;

    // Class badge
    updateClassBadge(info.class);

    // Overlay
    if (info.class) {
      DOM.annotate.overlayClass.textContent = info.class;
      DOM.annotate.imageOverlay.classList.remove('hidden');
    } else {
      DOM.annotate.imageOverlay.classList.add('hidden');
    }

    // Unannotate button
    DOM.annotate.btnUnannotate.style.display = info.class ? '' : 'none';

    // Nav button states
    DOM.annotate.btnPrev.disabled      = (index === 0);
    DOM.annotate.btnNext.disabled      = (index === AppState.totalImages - 1);
    DOM.annotate.btnPrevTrack.disabled = (info.track_index === 0);
    DOM.annotate.btnNextTrack.disabled = (info.track_index === AppState.totalTracks - 1);

    renderClassList();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    setLoading(false);
  }
}

function updateClassBadge(cls) {
  if (cls) {
    DOM.annotate.classText.textContent = cls;
    DOM.annotate.classBadge.classList.add('has-class');
  } else {
    DOM.annotate.classText.textContent = 'Unassigned';
    DOM.annotate.classBadge.classList.remove('has-class');
  }
}

/* ─────────────────────────────────────────
   CLASS LIST RENDERING
───────────────────────────────────────── */
function renderClassList() {
  const container = DOM.annotate.classList;
  container.innerHTML = '';

  if (AppState.classes.length === 0) {
    container.innerHTML = `<p style="font-size:12px;color:var(--text-muted);padding:4px 0;">No classes yet. Add one below.</p>`;
    return;
  }

  AppState.classes.forEach((cls, i) => {
    const shortcutKey = i < 9 ? String(i + 1) : null;
    const count = Object.values(AppState.imageAnnotationMap)
                        .filter(c => c === cls).length;

    const btn = document.createElement('button');
    btn.className = 'class-btn' + (cls === AppState.currentClass ? ' active' : '');
    btn.title = `Assign "${cls}"${shortcutKey ? ` (press ${shortcutKey})` : ''}`;
    btn.onclick = () => assignClass(cls);

    btn.innerHTML = `
      ${shortcutKey ? `<span class="class-shortcut">${shortcutKey}</span>` : ''}
      <span class="class-label">${escapeHtml(cls)}</span>
      <span class="class-count">${count}</span>
    `;
    container.appendChild(btn);
  });
}

/* ─────────────────────────────────────────
   ASSIGN CLASS  (no auto-advance)
───────────────────────────────────────── */
async function assignClass(className) {
  try {
    const data = await apiFetch('/api/annotate', {
      method: 'POST',
      body: JSON.stringify({ index: AppState.currentIndex, class_name: className }),
    });

    AppState.annotatedCount = data.annotated;
    AppState.classes        = data.classes;

    // Update imageAnnotationMap locally
    const imgName = AppState.images[AppState.currentIndex];
    Object.keys(AppState.imageAnnotationMap).forEach(k => {
      if (AppState.imageAnnotationMap[k] === imgName) delete AppState.imageAnnotationMap[k];
    });
    AppState.imageAnnotationMap[imgName] = className;
    AppState.currentClass = className;

    updateProgress();
    updateClassBadge(className);

    // Show overlay
    DOM.annotate.overlayClass.textContent = className;
    DOM.annotate.imageOverlay.classList.remove('hidden');
    DOM.annotate.btnUnannotate.style.display = '';

    showToast(`✓ Labeled as "${className}"`, 'success');
    renderClassList();

    // No auto-advance — user navigates manually

  } catch (err) {
    showToast(err.message, 'error');
  }
}

/* ─────────────────────────────────────────
   ADD CLASS
───────────────────────────────────────── */
async function addClass() {
  const input = DOM.annotate.newClassInput;
  const name = input.value.trim();
  if (!name) return;

  if (AppState.classes.includes(name)) {
    showToast(`Class "${name}" already exists`, 'error');
    return;
  }

  AppState.classes.push(name);
  renderClassList();
  input.value = '';
  input.focus();

  await assignClass(name);
}

function handleNewClassKey(e) {
  if (e.key === 'Enter') addClass();
}

/* ─────────────────────────────────────────
   UNANNOTATE
───────────────────────────────────────── */
async function unannotateImage() {
  try {
    const data = await apiFetch('/api/unannotate', {
      method: 'POST',
      body: JSON.stringify({ index: AppState.currentIndex }),
    });

    const imgName = AppState.images[AppState.currentIndex];
    delete AppState.imageAnnotationMap[imgName];
    AppState.currentClass   = null;
    AppState.annotatedCount = data.annotated;
    AppState.classes        = data.classes;

    updateProgress();
    updateClassBadge(null);
    DOM.annotate.imageOverlay.classList.add('hidden');
    DOM.annotate.btnUnannotate.style.display = 'none';
    renderClassList();
    showToast('Label removed', '');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

/* ─────────────────────────────────────────
   NEW TRACK BANNER
───────────────────────────────────────── */
let _bannerTimer = null;
function showNewTrackBanner(info) {
  let banner = document.getElementById('new-track-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'new-track-banner';
    banner.className = 'new-track-banner';
    document.body.appendChild(banner);
  }

  const trackNum = (info.track_index ?? 0) + 1;
  banner.innerHTML = `
    <span class="ntb-pill">New Track</span>
    <span class="ntb-info">Track ${trackNum} of ${info.total_tracks} &nbsp;•&nbsp; AID: <strong>${info.aid}</strong> &nbsp;•&nbsp; ${info.video_name}</span>
  `;
  banner.classList.add('visible');
  clearTimeout(_bannerTimer);
  _bannerTimer = setTimeout(() => banner.classList.remove('visible'), 2800);
}

/* ─────────────────────────────────────────
   NAVIGATION
───────────────────────────────────────── */
async function navigate(direction) {
  try {
    const prevTrackKey = AppState.currentTrackKey;

    const data = await apiFetch('/api/navigate', {
      method: 'POST',
      body: JSON.stringify({ direction }),
    });

    if (data.at_end) {
      showToast('Already at last track', 'error');
      return;
    }
    if (data.at_start) {
      showToast('Already at first track', 'error');
      return;
    }

    AppState.currentIndex = data.index;
    AppState.currentClass = data.class || null;

    await loadImageAtIndex(data.index);

    // Show banner only when frame-level nav (next/prev) crosses a track boundary
    if ((direction === 'next' || direction === 'prev') &&
        data.track_key && data.track_key !== prevTrackKey) {
      showNewTrackBanner(data);
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
}

/* ─────────────────────────────────────────
   JUMP TO TRACK
───────────────────────────────────────── */
async function jumpToTrack() {
  const val = parseInt(DOM.trackBar.jumpInput.value, 10);
  if (isNaN(val) || val < 1 || val > AppState.totalTracks) {
    showToast(`Enter a number between 1 and ${AppState.totalTracks}`, 'error');
    return;
  }

  try {
    const data = await apiFetch('/api/navigate', {
      method: 'POST',
      body: JSON.stringify({ direction: 'goto_track', track_index: val }),
    });

    AppState.currentIndex = data.index;
    AppState.currentClass = data.class || null;
    DOM.trackBar.jumpInput.value = '';

    await loadImageAtIndex(data.index);
    showToast(`Jumped to track ${val}`, 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

/* ─────────────────────────────────────────
   DASHBOARD
───────────────────────────────────────── */
async function openDashboard() {
  AppState.dashPage = 1;
  await refreshStatus();
  renderDashboard();
  showScreen('dashboard');
}

function renderDashboard() {
  const unannotated = AppState.totalImages - AppState.annotatedCount;
  DOM.dashboard.stats.innerHTML = `
    <div class="stat-block">
      <span class="stat-value stat-accent">${AppState.totalImages}</span>
      <span class="stat-label">Total Images</span>
    </div>
    <div class="stat-block">
      <span class="stat-value stat-purple">${AppState.totalTracks}</span>
      <span class="stat-label">Tracks</span>
    </div>
    <div class="stat-block">
      <span class="stat-value stat-green">${AppState.annotatedCount}</span>
      <span class="stat-label">Annotated</span>
    </div>
    <div class="stat-block">
      <span class="stat-value stat-amber">${unannotated}</span>
      <span class="stat-label">Remaining</span>
    </div>
  `;
  renderGrid(AppState.dashFilter);
}

function renderGrid(filter) {
  const grid = DOM.dashboard.grid;
  grid.innerHTML = '';

  let items = AppState.images.map((name, idx) => ({
    name, idx,
    cls: AppState.imageAnnotationMap[name] || null,
  }));

  if (filter === 'annotated')   items = items.filter(x => x.cls);
  if (filter === 'unannotated') items = items.filter(x => !x.cls);

  if (items.length === 0) {
    DOM.dashboard.empty.classList.remove('hidden');
    renderPagination(0, 0);
    return;
  }
  DOM.dashboard.empty.classList.add('hidden');

  const totalPages = Math.ceil(items.length / PAGE_SIZE);
  AppState.dashPage = Math.max(1, Math.min(AppState.dashPage, totalPages));

  const start     = (AppState.dashPage - 1) * PAGE_SIZE;
  const pageItems = items.slice(start, start + PAGE_SIZE);

  pageItems.forEach(({ name, idx, cls }) => {
    const div = document.createElement('div');
    div.className = 'grid-item' + (cls ? ' annotated' : '');
    div.title = name + (cls ? ` → ${cls}` : ' (unannotated)');
    div.onclick = () => goToImage(idx);

    div.innerHTML = `
      <img src="/api/image/${idx}" alt="${escapeHtml(name)}" loading="lazy" />
      <div class="grid-item-overlay">
        <span class="grid-item-name">${escapeHtml(name)}</span>
        ${cls ? `<span class="grid-item-class">✓ ${escapeHtml(cls)}</span>` : ''}
      </div>
      ${cls
        ? '<div class="grid-annotated-badge"></div>'
        : '<div class="grid-unannotated-badge"></div>'
      }
    `;
    grid.appendChild(div);
  });

  renderPagination(AppState.dashPage, totalPages);
}

/* ─────────────────────────────────────────
   PAGINATION
───────────────────────────────────────── */
function renderPagination(currentPage, totalPages) {
  const existing = document.getElementById('dash-pagination');
  if (existing) existing.remove();
  if (totalPages <= 1) return;

  const nav = document.createElement('div');
  nav.id = 'dash-pagination';
  nav.className = 'pagination';

  const prevBtn = document.createElement('button');
  prevBtn.className = 'page-btn page-nav';
  prevBtn.textContent = '← Prev';
  prevBtn.disabled = currentPage === 1;
  prevBtn.onclick = () => goToPage(currentPage - 1);
  nav.appendChild(prevBtn);

  buildPageNumbers(currentPage, totalPages).forEach(p => {
    if (p === '...') {
      const el = document.createElement('span');
      el.className = 'page-ellipsis';
      el.textContent = '…';
      nav.appendChild(el);
    } else {
      const btn = document.createElement('button');
      btn.className = 'page-btn' + (p === currentPage ? ' active' : '');
      btn.textContent = p;
      btn.onclick = () => goToPage(p);
      nav.appendChild(btn);
    }
  });

  const nextBtn = document.createElement('button');
  nextBtn.className = 'page-btn page-nav';
  nextBtn.textContent = 'Next →';
  nextBtn.disabled = currentPage === totalPages;
  nextBtn.onclick = () => goToPage(currentPage + 1);
  nav.appendChild(nextBtn);

  const label = document.createElement('span');
  label.className = 'page-info';
  label.textContent = `Page ${currentPage} of ${totalPages}`;
  nav.appendChild(label);

  DOM.dashboard.grid.after(nav);
}

function buildPageNumbers(current, total) {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const pages = [];
  if (current <= 4) {
    for (let i = 1; i <= 5; i++) pages.push(i);
    pages.push('...', total);
  } else if (current >= total - 3) {
    pages.push(1, '...');
    for (let i = total - 4; i <= total; i++) pages.push(i);
  } else {
    pages.push(1, '...', current - 1, current, current + 1, '...', total);
  }
  return pages;
}

function goToPage(page) {
  AppState.dashPage = page;
  renderGrid(AppState.dashFilter);
  document.getElementById('screen-dashboard').scrollTo({ top: 0, behavior: 'smooth' });
}

function filterDashboard(filter, btn) {
  AppState.dashFilter = filter;
  AppState.dashPage = 1;
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  renderGrid(filter);
}

async function goToImage(index) {
  showScreen('annotate');
  AppState.currentIndex = index;
  await loadImageAtIndex(index);
}

async function startAnnotating() {
  showScreen('annotate');
  await loadImageAtIndex(AppState.currentIndex);
}

/* ─────────────────────────────────────────
   EXPORT
───────────────────────────────────────── */
async function exportAnnotations() {
  try {
    const data = await apiFetch('/api/export');
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = 'annotations.json';
    a.click();
    URL.revokeObjectURL(url);
    showToast('Annotations exported!', 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

/* ─────────────────────────────────────────
   KEYBOARD SHORTCUTS
───────────────────────────────────────── */
document.addEventListener('keydown', async (e) => {
  if (['INPUT', 'TEXTAREA'].includes(e.target.tagName)) return;

  const currentScreen = Object.entries(DOM.screens)
    .find(([, el]) => el.classList.contains('active'))?.[0];

  if (currentScreen === 'annotate') {
    if (e.key === 'ArrowRight' && e.shiftKey) {
      e.preventDefault();
      navigate('next_track');
    } else if (e.key === 'ArrowLeft' && e.shiftKey) {
      e.preventDefault();
      navigate('prev_track');
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      navigate('next');
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      navigate('prev');
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      if (AppState.currentClass) {
        e.preventDefault();
        unannotateImage();
      }
    } else if (e.key >= '1' && e.key <= '9') {
      const idx = parseInt(e.key) - 1;
      if (idx < AppState.classes.length) {
        e.preventDefault();
        assignClass(AppState.classes[idx]);
      }
    }
  }

  if (currentScreen === 'setup') {
    if (e.key === 'Enter') loadFolder();
  }
});

// Jump input: Enter to jump
DOM.trackBar.jumpInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') jumpToTrack();
});

/* ─────────────────────────────────────────
   HEADER BUTTON WIRING
───────────────────────────────────────── */
DOM.header.btnDashboard.onclick = openDashboard;
DOM.header.btnAnnotate.onclick  = () => showScreen('annotate');
DOM.header.btnExport.onclick    = exportAnnotations;

DOM.setup.folderInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') loadFolder();
});

/* ─────────────────────────────────────────
   Utility: escape HTML
───────────────────────────────────────── */
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/* ─────────────────────────────────────────
   INIT
───────────────────────────────────────── */
(async function init() {
  try {
    const data = await apiFetch('/api/status');
    if (data.loaded && data.total > 0) {
      AppState.loaded          = true;
      AppState.totalImages     = data.total;
      AppState.totalTracks     = data.total_tracks;
      AppState.annotatedCount  = data.annotated;
      AppState.currentIndex    = data.current_index;
      AppState.classes         = data.classes;
      AppState.images          = data.images;
      AppState.tracks          = data.tracks;
      AppState.trackMap        = data.track_map;
      AppState.imageAnnotationMap = data.image_annotation_map;

      updateProgress();
      showScreen('annotate');
      await loadImageAtIndex(data.current_index);
      return;
    }
  } catch (_) {}

  showScreen('setup');
})();
