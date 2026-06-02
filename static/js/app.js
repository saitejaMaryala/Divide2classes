/**
 * ImageTag — Main Application JavaScript
 * =======================================
 * Handles all UI interactions, API calls, navigation,
 * keyboard shortcuts, and state management.
 */

/* ─────────────────────────────────────────
   State
───────────────────────────────────────── */
const PAGE_SIZE = 10;

const AppState = {
  loaded: false,
  totalImages: 0,
  annotatedCount: 0,
  currentIndex: 0,
  currentClass: null,
  classes: [],
  images: [],
  imageAnnotationMap: {},
  dashFilter: 'all',
  dashPage: 1,      // current page (1-indexed)
  // ── Browse-by-class mode ──
  browseMode: false,
  browseClassName: null,
  browseImages: [],      // [{index, name}, ...] ordered
  browsePosIndex: 0,     // position within browseImages
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
    status:       $('header-status'),
    progressBar:  $('progress-bar'),
    progressLabel:$('progress-label'),
    btnDashboard: $('btn-view-dashboard'),
    btnAnnotate:  $('btn-view-annotate'),
    btnExport:    $('btn-export'),
  },
  setup: {
    folderInput:  $('folder-path'),
    error:        $('setup-error'),
  },
  annotate: {
    metaFilename: $('meta-filename'),
    metaIndex:    $('meta-index'),
    classBadge:   $('current-class-badge'),
    classText:    $('current-class-text'),
    classList:    $('class-list'),
    newClassInput:$('new-class-input'),
    mainImage:    $('main-image'),
    imageOverlay: $('image-overlay'),
    overlayClass: $('overlay-class'),
    navCounter:   $('nav-counter'),
    btnPrev:      $('btn-prev'),
    btnNext:      $('btn-next'),
    btnUnannotate:$('btn-unannotate'),
  },
  dashboard: {
    stats:     $('dash-stats'),
    grid:      $('image-grid'),
    empty:     $('dash-empty'),
  },
  loadingOverlay: $('loading-overlay'),
  toast:          $('toast'),
  classBrowserModal: $('class-browser-modal'),
  modalClassList:    $('modal-class-list'),
  browseBanner:      $('class-browse-banner'),
  browseClassName:   $('browse-class-name'),
  browsePos:         $('browse-pos'),
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
  DOM.header.btnDashboard.style.display  = (loaded && name !== 'dashboard')  ? '' : 'none';
  DOM.header.btnAnnotate.style.display   = (loaded && name !== 'annotate')   ? '' : 'none';
  DOM.header.btnExport.style.display     = loaded ? '' : 'none';
  DOM.header.status.style.display        = loaded ? '' : 'none';
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

    AppState.loaded = true;
    AppState.totalImages = data.total;
    AppState.currentIndex = data.current_index;

    // Fetch full status
    await refreshStatus();

    showScreen('annotate');
    await loadImageAtIndex(AppState.currentIndex);
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
   REFRESH STATUS (global state sync)
───────────────────────────────────────── */
async function refreshStatus() {
  const data = await apiFetch('/api/status');
  if (!data.loaded) return;

  AppState.totalImages       = data.total;
  AppState.annotatedCount    = data.annotated;
  AppState.currentIndex      = data.current_index;
  AppState.classes           = data.classes || [];
  AppState.images            = data.images || [];
  AppState.imageAnnotationMap = data.image_annotation_map || {};

  updateProgress();
  renderClassList();
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

    // Counter — in browse mode show filtered position
    if (AppState.browseMode) {
      // Sync browsePosIndex to the loaded index
      const pos = AppState.browseImages.findIndex(x => x.index === index);
      if (pos !== -1) AppState.browsePosIndex = pos;
      DOM.annotate.navCounter.textContent =
        `${AppState.browsePosIndex + 1} / ${AppState.browseImages.length} (${AppState.browseClassName})`;
      // Nav button states within the browse list
      DOM.annotate.btnPrev.disabled = (AppState.browsePosIndex === 0);
      DOM.annotate.btnNext.disabled = (AppState.browsePosIndex === AppState.browseImages.length - 1);
      DOM.browseBanner.querySelector('#browse-pos').textContent =
        `${AppState.browsePosIndex + 1} / ${AppState.browseImages.length}`;
    } else {
      DOM.annotate.navCounter.textContent   = `${index + 1} / ${info.total}`;
      DOM.annotate.btnPrev.disabled = (index === 0);
      DOM.annotate.btnNext.disabled = (index === AppState.totalImages - 1);
    }

    // Update class badge
    updateClassBadge(info.class);

    // Update overlay
    if (info.class) {
      DOM.annotate.overlayClass.textContent = info.class;
      DOM.annotate.imageOverlay.classList.remove('hidden');
    } else {
      DOM.annotate.imageOverlay.classList.add('hidden');
    }

    // Unannotate button
    DOM.annotate.btnUnannotate.style.display = info.class ? '' : 'none';

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
   ASSIGN CLASS
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
    // Clear old assignment
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

    // Auto-advance to next unannotated
    if (data.next_unannotated !== null && data.next_unannotated !== undefined) {
      setTimeout(() => loadImageAtIndex(data.next_unannotated), 280);
    } else {
      // All annotated — check if this was the last
      if (data.annotated === data.total) {
        showToast('🎉 All images annotated!', 'success');
      }
    }

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

  // Optimistically add and assign immediately
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
   NAVIGATION
───────────────────────────────────────── */
async function navigate(direction) {
  // In browse mode, intercept next/prev to stay within the class
  if (AppState.browseMode && (direction === 'next' || direction === 'prev')) {
    await navigateInClass(direction);
    return;
  }

  try {
    const data = await apiFetch('/api/navigate', {
      method: 'POST',
      body: JSON.stringify({ direction }),
    });

    if (data.all_done) {
      showToast('🎉 All images are annotated!', 'success');
      return;
    }

    AppState.currentIndex = data.index;
    AppState.currentClass = data.class || null;

    await loadImageAtIndex(data.index);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

/* ─────────────────────────────────────────
   CLASS BROWSER
───────────────────────────────────────── */
function openClassBrowser() {
  const modal = DOM.classBrowserModal;
  const list  = DOM.modalClassList;
  list.innerHTML = '';

  if (AppState.classes.length === 0) {
    list.innerHTML = '<p class="modal-empty">No classes annotated yet.</p>';
  } else {
    AppState.classes.forEach(cls => {
      const count = Object.values(AppState.imageAnnotationMap).filter(c => c === cls).length;
      const isActive = AppState.browseMode && AppState.browseClassName === cls;

      const btn = document.createElement('button');
      btn.className = 'modal-class-btn' + (isActive ? ' active' : '');
      btn.onclick = () => selectBrowseClass(cls);
      btn.innerHTML = `
        <span class="modal-cls-label">${escapeHtml(cls)}</span>
        <span class="modal-cls-count">${count} image${count !== 1 ? 's' : ''}</span>
        ${isActive ? '<span class="modal-cls-active-tag">Active</span>' : ''}
      `;
      list.appendChild(btn);
    });
  }

  modal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function closeClassBrowserModal(event) {
  // Close on backdrop click (not on modal-box click)
  if (event && event.target !== DOM.classBrowserModal) return;
  DOM.classBrowserModal.classList.add('hidden');
  document.body.style.overflow = '';
}

async function selectBrowseClass(className) {
  DOM.classBrowserModal.classList.add('hidden');
  document.body.style.overflow = '';

  setLoading(true);
  try {
    const data = await apiFetch(`/api/class_images/${encodeURIComponent(className)}`);
    if (!data.images || data.images.length === 0) {
      showToast(`No images in class "${className}"`, 'error');
      return;
    }

    AppState.browseMode      = true;
    AppState.browseClassName = className;
    AppState.browseImages    = data.images;
    AppState.browsePosIndex  = 0;

    // Show banner
    DOM.browseClassName.textContent = className;
    DOM.browseBanner.classList.remove('hidden');

    // Jump to first image in class
    await loadImageAtIndex(data.images[0].index);
    showToast(`Browsing "${className}" — ${data.images.length} image${data.images.length !== 1 ? 's' : ''}`, 'success');
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    setLoading(false);
  }
}

async function navigateInClass(direction) {
  const list = AppState.browseImages;
  if (!list.length) return;

  let pos = AppState.browsePosIndex;
  if (direction === 'next') pos = Math.min(pos + 1, list.length - 1);
  else                      pos = Math.max(pos - 1, 0);

  AppState.browsePosIndex = pos;
  await loadImageAtIndex(list[pos].index);
}

function clearClassBrowse() {
  AppState.browseMode      = false;
  AppState.browseClassName = null;
  AppState.browseImages    = [];
  AppState.browsePosIndex  = 0;

  DOM.browseBanner.classList.add('hidden');

  // Restore normal nav button states
  const idx = AppState.currentIndex;
  DOM.annotate.btnPrev.disabled = (idx === 0);
  DOM.annotate.btnNext.disabled = (idx === AppState.totalImages - 1);
  DOM.annotate.navCounter.textContent = `${idx + 1} / ${AppState.totalImages}`;

  showToast('Browse mode cleared', '');
}

/* ─────────────────────────────────────────
   DASHBOARD
───────────────────────────────────────── */
async function openDashboard() {
  AppState.dashPage = 1;   // always start at page 1
  await refreshStatus();
  renderDashboard();
  showScreen('dashboard');
}

function renderDashboard() {
  // Stats
  const unannotated = AppState.totalImages - AppState.annotatedCount;
  DOM.dashboard.stats.innerHTML = `
    <div class="stat-block">
      <span class="stat-value stat-accent">${AppState.totalImages}</span>
      <span class="stat-label">Total</span>
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

  // Grid
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

  // ── Pagination ──
  const totalItems = items.length;
  const totalPages = Math.ceil(totalItems / PAGE_SIZE);

  // Clamp current page within valid range
  AppState.dashPage = Math.max(1, Math.min(AppState.dashPage, totalPages));

  const start = (AppState.dashPage - 1) * PAGE_SIZE;
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
   PAGINATION CONTROLS
───────────────────────────────────────── */
function renderPagination(currentPage, totalPages) {
  // Remove old pagination if exists
  const existing = document.getElementById('dash-pagination');
  if (existing) existing.remove();

  if (totalPages <= 1) return;

  const nav = document.createElement('div');
  nav.id = 'dash-pagination';
  nav.className = 'pagination';

  // Prev button
  const prevBtn = document.createElement('button');
  prevBtn.className = 'page-btn page-nav';
  prevBtn.textContent = '← Prev';
  prevBtn.disabled = currentPage === 1;
  prevBtn.onclick = () => goToPage(currentPage - 1);
  nav.appendChild(prevBtn);

  // Page number buttons (show at most 7 around current)
  const pages = buildPageNumbers(currentPage, totalPages);
  pages.forEach(p => {
    if (p === '...') {
      const ellipsis = document.createElement('span');
      ellipsis.className = 'page-ellipsis';
      ellipsis.textContent = '…';
      nav.appendChild(ellipsis);
    } else {
      const btn = document.createElement('button');
      btn.className = 'page-btn' + (p === currentPage ? ' active' : '');
      btn.textContent = p;
      btn.onclick = () => goToPage(p);
      nav.appendChild(btn);
    }
  });

  // Next button
  const nextBtn = document.createElement('button');
  nextBtn.className = 'page-btn page-nav';
  nextBtn.textContent = 'Next →';
  nextBtn.disabled = currentPage === totalPages;
  nextBtn.onclick = () => goToPage(currentPage + 1);
  nav.appendChild(nextBtn);

  // Page counter label
  const label = document.createElement('span');
  label.className = 'page-info';
  label.textContent = `Page ${currentPage} of ${totalPages}`;
  nav.appendChild(label);

  // Insert after the grid
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
  // Scroll grid back to top
  document.getElementById('screen-dashboard').scrollTo({ top: 0, behavior: 'smooth' });
}

function filterDashboard(filter, btn) {
  AppState.dashFilter = filter;
  AppState.dashPage = 1;   // reset to first page on filter change
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
  // Navigate to first unannotated
  try {
    const data = await apiFetch('/api/navigate', {
      method: 'POST',
      body: JSON.stringify({ direction: 'next_unannotated' }),
    });

    if (data.all_done) {
      showToast('🎉 All images are already annotated!', 'success');
      return;
    }

    AppState.currentIndex = data.index;
    showScreen('annotate');
    await loadImageAtIndex(data.index);
  } catch (err) {
    showToast(err.message, 'error');
  }
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
  // Ignore when typing in inputs
  if (['INPUT', 'TEXTAREA'].includes(e.target.tagName)) return;

  const currentScreen = Object.entries(DOM.screens)
    .find(([, el]) => el.classList.contains('active'))?.[0];

  if (currentScreen === 'annotate') {
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      navigate('next');
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      navigate('prev');
    } else if (e.key === 'Enter') {
      e.preventDefault();
      navigate('next_unannotated');
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
    if (e.key === 'Enter') {
      loadFolder();
    }
  }
});

/* ─────────────────────────────────────────
   HEADER BUTTON WIRING
───────────────────────────────────────── */
DOM.header.btnDashboard.onclick = openDashboard;
DOM.header.btnAnnotate.onclick  = () => showScreen('annotate');
DOM.header.btnExport.onclick    = exportAnnotations;

/* ─────────────────────────────────────────
   SETUP SCREEN — Enter key
───────────────────────────────────────── */
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
  // Check if there's already a loaded session
  try {
    const data = await apiFetch('/api/status');
    if (data.loaded && data.total > 0) {
      AppState.loaded         = true;
      AppState.totalImages    = data.total;
      AppState.annotatedCount = data.annotated;
      AppState.currentIndex   = data.current_index;
      AppState.classes        = data.classes;
      AppState.images         = data.images;
      AppState.imageAnnotationMap = data.image_annotation_map;

      updateProgress();
      showScreen('annotate');
      await loadImageAtIndex(data.current_index);
      return;
    }
  } catch (_) {}

  showScreen('setup');
})();
