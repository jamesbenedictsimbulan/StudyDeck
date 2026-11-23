/* =========================================================
   StudyDeck — app.js
   Handles: navigation between pages, DOM rendering of decks /
   cards / progress, Ionic component event handling (ionChange,
   ionInput, click), flashcard study flow, and settings.
   ========================================================= */

/* ---------- state ---------- */
const state = {
  currentPage: 'home',
  activeDeckId: null,
  studyDeckId: null,
  studyIndex: 0,
  studyQueue: [],
  studyResults: { known: 0, learning: 0 },
  editingCardId: null,
  editingDeckId: null
};

const ICON_COLOR_CLASS = { blue: 'clr-blue', purple: 'clr-purple', green: 'clr-green', orange: 'clr-orange', pink: 'clr-pink' };

/* ---------- boot ---------- */
document.addEventListener('DOMContentLoaded', init);

function init() {
  const settings = getSettings();
  applyTheme(settings.theme);

  wireAuthPage();
  wireNavigation();
  wireHomePage();
  wireDecksPage();
  wireExplorePage();
  wireProgressPage();
  wireSettingsPage();
  wireDeckDetailPage();
  wireStudyPage();
  wireDeckModal();
  wireCardModal();
  if (window.Features) Features.init();

  renderAll();

  // Skip the login/signup screen automatically if a session is already active.
  if (getCurrentUser()) {
    enterApp();
  }
}

function enterApp() {
  document.getElementById('page-welcome').classList.add('hidden');
  document.getElementById('shell').classList.remove('hidden');
  renderAll();
}

function showWelcomeScreen() {
  document.getElementById('shell').classList.add('hidden');
  document.getElementById('page-welcome').classList.remove('hidden');
  document.getElementById('auth-form-login').reset();
  document.getElementById('auth-form-signup').reset();
  setAuthMode('login');
}

/* ---------- auth (login / sign up) ---------- */
function setAuthMode(mode) {
  const isLogin = mode === 'login';
  document.getElementById('auth-tab-login').classList.toggle('active', isLogin);
  document.getElementById('auth-tab-signup').classList.toggle('active', !isLogin);
  document.getElementById('auth-form-login').classList.toggle('hidden', !isLogin);
  document.getElementById('auth-form-signup').classList.toggle('hidden', isLogin);
  hideAuthError('login-error');
  hideAuthError('signup-error');
}

function wireAuthPage() {
  document.getElementById('auth-tab-login').addEventListener('click', () => setAuthMode('login'));
  document.getElementById('auth-tab-signup').addEventListener('click', () => setAuthMode('signup'));

  document.getElementById('auth-form-login').addEventListener('submit', async (e) => {
    e.preventDefault();
    hideAuthError('login-error');
    const email = document.getElementById('login-email').value || '';
    const password = document.getElementById('login-password').value || '';
    try {
      const user = await loginUser({ email, password });
      setSession(user.id);
      document.getElementById('auth-form-login').reset();
      enterApp();
    } catch (err) {
      showAuthError('login-error', err.message);
    }
  });

  document.getElementById('auth-form-signup').addEventListener('submit', async (e) => {
    e.preventDefault();
    hideAuthError('signup-error');
    const name = document.getElementById('signup-name').value || '';
    const email = document.getElementById('signup-email').value || '';
    const password = document.getElementById('signup-password').value || '';
    try {
      const user = await registerUser({ name, email, password });
      setSession(user.id);
      document.getElementById('auth-form-signup').reset();
      enterApp();
      showToast('Account created — welcome to StudyDeck!');
    } catch (err) {
      showAuthError('signup-error', err.message);
    }
  });
}

function showAuthError(elId, message) {
  const el = document.getElementById(elId);
  el.textContent = message;
  el.classList.remove('hidden');
}
function hideAuthError(elId) {
  const el = document.getElementById(elId);
  el.textContent = '';
  el.classList.add('hidden');
}

/* ---------- navigation ---------- */
function wireNavigation() {
  document.querySelectorAll('.nav-item, .mobile-tabbar ion-tab-button').forEach(btn => {
    btn.addEventListener('click', () => goToPage(btn.dataset.page));
  });
  document.querySelectorAll('[data-nav]').forEach(el => {
    el.addEventListener('click', () => goToPage(el.dataset.nav));
  });
}

const TOOL_PAGES = ['motion', 'snap', 'compass', 'shake', 'permissions'];

function goToPage(pageName) {
  const pages = ['home', 'decks', 'explore', 'progress', 'settings', 'deck-detail', 'study', 'complete', 'tools'].concat(TOOL_PAGES);
  const previous = state.currentPage;
  pages.forEach(p => {
    const el = document.getElementById('page-' + p);
    if (el) el.classList.toggle('hidden', p !== pageName);
  });
  state.currentPage = pageName;

  // Tool sub-pages keep the "Tools" tab highlighted.
  const navName = TOOL_PAGES.includes(pageName) ? 'tools' : pageName;
  document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.page === navName));
  document.querySelectorAll('.mobile-tabbar ion-tab-button').forEach(b => b.classList.toggle('active', b.dataset.page === navName));

  document.getElementById('main-content').scrollToTop(150);

  if (window.Features && previous !== pageName) Features.onNavigate(previous, pageName);

  if (pageName === 'home') renderHome();
  if (pageName === 'decks') renderDecksPage();
  if (pageName === 'explore') renderExplore('');
  if (pageName === 'progress') renderProgressPage();
}

/* ---------- render everything ---------- */
function renderAll() {
  const settings = getSettings();
  const user = getCurrentUser();
  document.getElementById('mobile-hello').textContent = 'Hello, ' + settings.username;
  document.getElementById('user-chip-name').textContent = settings.username;
  document.getElementById('setting-name').value = settings.username;
  document.getElementById('setting-email').textContent = user ? user.email : '—';
  document.getElementById('setting-theme').checked = settings.theme === 'dark';
  document.getElementById('setting-reminders').checked = !!settings.reminders;
  document.getElementById('setting-sound').checked = !!settings.sound;
  renderHome();
}

/* ---------- HOME ---------- */
function wireHomePage() {
  const search = document.getElementById('global-search');
  search.addEventListener('ionInput', (e) => {
    const q = e.detail.value || '';
    if (q.trim().length) {
      goToPage('explore');
      document.getElementById('explore-search').value = q;
      renderExplore(q);
    }
  });
}

function renderHome() {
  const decks = getDecks();
  const progress = getProgress();
  const pct = getOverallProgressPercent();

  setRing('ring-fg', pct);
  document.getElementById('ring-percent').textContent = pct + '%';
  document.getElementById('stat-decks').textContent = decks.length;
  document.getElementById('stat-cards').textContent = progress.cardsStudied;
  document.getElementById('stat-streak').textContent = progress.streak;

  renderDeckGrid('home-deck-grid', decks.slice(0, 4));
  renderActivity();
}

function renderActivity() {
  const list = document.getElementById('activity-list');
  list.innerHTML = '';
  const icons = { study: ['checkmark-circle', 'blue-100', 'blue'], complete: ['trophy', 'orange-100', 'orange'], create: ['add-circle', 'green-100', 'green'], delete: ['trash', 'red-100', 'red'] };
  getActivity().slice(0, 5).forEach(a => {
    const [icon] = icons[a.type] || icons.study;
    const item = document.createElement('ion-item');
    item.innerHTML = `
      <div class="act-item" style="width:100%;">
        <div class="act-ic clr-${(icons[a.type]||icons.study)[2]}"><ion-icon name="${icon}"></ion-icon></div>
        <div class="act-text">
          <div><b>${escapeHtml(a.text)}</b></div>
          <div class="act-sub">${escapeHtml(a.sub || '')} · ${timeAgo(a.date)}</div>
        </div>
      </div>`;
    list.appendChild(item);
  });
}

function renderDeckGrid(containerId, decks) {
  const grid = document.getElementById(containerId);
  grid.innerHTML = '';
  if (!decks.length) {
    grid.innerHTML = `
      <div class="empty-state">
        <ion-icon name="albums-outline"></ion-icon>
        <p>No decks yet. Create your first deck to get started.</p>
        <ion-button shape="round" class="btn-primary empty-state-btn"><ion-icon slot="start" name="add"></ion-icon>Create Deck</ion-button>
      </div>`;
    grid.querySelector('.empty-state-btn').addEventListener('click', () => openDeckModal());
    return;
  }
  decks.forEach(deck => {
    const card = document.createElement('div');
    card.className = 'deck-card';
    card.innerHTML = `
      <div class="deck-ic ${ICON_COLOR_CLASS[deck.color] || 'clr-blue'}"><ion-icon name="${deck.icon}"></ion-icon></div>
      <h4>${escapeHtml(deck.name)}</h4>
      <div class="count">${deck.cards.length} cards</div>
      <ion-button expand="block">Study</ion-button>
    `;
    card.addEventListener('click', (e) => {
      openDeckDetail(deck.id);
    });
    card.querySelector('ion-button').addEventListener('click', (e) => {
      e.stopPropagation();
      startStudy(deck.id);
    });
    grid.appendChild(card);
  });
}

function setRing(elId, pct) {
  const circumference = 326.7; // 2*pi*52
  const offset = circumference - (pct / 100) * circumference;
  const el = document.getElementById(elId);
  if (el) el.style.strokeDashoffset = offset;
}

/* ---------- MY DECKS ---------- */
function wireDecksPage() {
  document.getElementById('btn-new-deck').addEventListener('click', () => openDeckModal());
}

function renderDecksPage() {
  renderDeckGrid('decks-grid', getDecks());
}

/* ---------- EXPLORE ---------- */
function wireExplorePage() {
  const search = document.getElementById('explore-search');
  search.addEventListener('ionInput', (e) => renderExplore(e.detail.value || ''));
}

function renderExplore(query) {
  const results = searchDecksAndCards(query);
  renderDeckGrid('explore-grid', results);
  document.getElementById('explore-empty').classList.toggle('hidden', results.length > 0 || query.trim() === '');
}

/* ---------- PROGRESS ---------- */
function wireProgressPage() {
  document.getElementById('progress-segment').addEventListener('ionChange', (e) => {
    const val = e.detail.value;
    document.getElementById('progress-overview').classList.toggle('hidden', val !== 'overview');
    document.getElementById('progress-decks').classList.toggle('hidden', val !== 'decks');
  });
}

function renderProgressPage() {
  const decks = getDecks();
  const progress = getProgress();
  const pct = getOverallProgressPercent();

  setRing('ring-fg-2', pct);
  document.getElementById('ring-percent-2').textContent = pct + '%';
  document.getElementById('p-decks').textContent = decks.length;
  document.getElementById('p-cards').textContent = progress.cardsStudied;
  document.getElementById('p-streak').textContent = progress.streak;

  const chart = document.getElementById('bar-chart');
  chart.innerHTML = '';
  const days = getLast7DaysActivity();
  const max = Math.max(1, ...days.map(d => d.count));
  days.forEach(d => {
    const col = document.createElement('div');
    col.className = 'bar-col';
    const h = Math.max(4, Math.round((d.count / max) * 120));
    col.innerHTML = `<div class="bar" style="height:${h}px;" title="${d.count} cards"></div><span>${d.label}</span>`;
    chart.appendChild(col);
  });

  const list = document.getElementById('progress-deck-list');
  list.innerHTML = '';
  decks.forEach(deck => {
    const item = document.createElement('ion-item');
    item.innerHTML = `
      <div class="deck-ic ${ICON_COLOR_CLASS[deck.color] || 'clr-blue'}" slot="start"><ion-icon name="${deck.icon}"></ion-icon></div>
      <ion-label>
        <h3>${escapeHtml(deck.name)}</h3>
        <p>${deck.cards.length} cards</p>
      </ion-label>`;
    item.addEventListener('click', () => openDeckDetail(deck.id));
    list.appendChild(item);
  });
}

/* ---------- SETTINGS ---------- */
function wireSettingsPage() {
  const nameInput = document.getElementById('setting-name');
  nameInput.addEventListener('ionChange', (e) => {
    const s = getSettings();
    s.username = (e.detail.value || 'Student').trim() || 'Student';
    setSettings(s);
    renderAll();
    showToast('Display name saved');
  });

  document.getElementById('setting-theme').addEventListener('ionChange', (e) => {
    const s = getSettings();
    s.theme = e.detail.checked ? 'dark' : 'light';
    setSettings(s);
    applyTheme(s.theme);
  });

  document.getElementById('setting-reminders').addEventListener('ionChange', (e) => {
    const s = getSettings(); s.reminders = e.detail.checked; setSettings(s);
  });
  document.getElementById('setting-sound').addEventListener('ionChange', (e) => {
    const s = getSettings(); s.sound = e.detail.checked; setSettings(s);
  });

  document.getElementById('btn-export-data').addEventListener('click', () => {
    const json = exportAllData();
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'studydeck-export.json';
    document.body.appendChild(a); a.click(); a.remove();
    showToast('Data exported');
  });

  document.getElementById('btn-reset-data').addEventListener('click', async () => {
    const confirmed = await confirmAlert('Reset all data?', 'This deletes every deck, card, and progress record on this device. This cannot be undone.');
    if (confirmed) {
      resetAllData();
      showToast('All data has been reset');
      renderAll();
      goToPage('home');
    }
  });

  document.getElementById('btn-logout').addEventListener('click', () => {
    clearSession();
    showWelcomeScreen();
  });
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme === 'dark' ? 'dark' : 'light');
}

/* ---------- DECK DETAIL ---------- */
function wireDeckDetailPage() {
  document.getElementById('deck-detail-back').addEventListener('click', () => goToPage(state.cameFrom || 'decks'));
  document.getElementById('dd-study-btn').addEventListener('click', () => startStudy(state.activeDeckId));
  document.getElementById('dd-add-card-btn').addEventListener('click', () => openCardModal(state.activeDeckId));
  document.getElementById('dd-delete-deck-btn').addEventListener('click', async () => {
    const deck = getDeckById(state.activeDeckId);
    if (!deck) return;
    const confirmed = await confirmAlert('Delete deck?', `"${deck.name}" and all its ${deck.cards.length} cards will be permanently deleted.`);
    if (confirmed) {
      deleteDeck(deck.id);
      showToast('Deck deleted');
      goToPage('decks');
    }
  });
}

function openDeckDetail(deckId) {
  state.activeDeckId = deckId;
  state.cameFrom = state.currentPage === 'deck-detail' ? state.cameFrom : state.currentPage;
  renderDeckDetail();
  goToPage('deck-detail');
}

function renderDeckDetail() {
  const deck = getDeckById(state.activeDeckId);
  if (!deck) return;
  document.getElementById('dd-title').textContent = deck.name;
  document.getElementById('dd-sub').textContent = `${deck.cards.length} cards`;

  const list = document.getElementById('dd-card-list');
  list.innerHTML = '';
  document.getElementById('dd-empty').classList.toggle('hidden', deck.cards.length > 0);

  deck.cards.forEach((card, idx) => {
    const item = document.createElement('ion-item');
    item.innerHTML = `
      <ion-label class="ion-text-wrap">
        <p style="font-size:.72rem;color:var(--muted);margin-bottom:4px;">Card ${idx + 1}</p>
        <h3>${escapeHtml(card.front)}</h3>
        <p>${escapeHtml(card.back)}</p>
      </ion-label>
      <ion-button slot="end" fill="clear" class="edit-card-btn"><ion-icon slot="icon-only" name="create-outline"></ion-icon></ion-button>
      <ion-button slot="end" fill="clear" color="danger" class="del-card-btn"><ion-icon slot="icon-only" name="trash-outline"></ion-icon></ion-button>
    `;
    item.querySelector('.edit-card-btn').addEventListener('click', () => openCardModal(deck.id, card.id));
    item.querySelector('.del-card-btn').addEventListener('click', async () => {
      const confirmed = await confirmAlert('Delete card?', 'This flashcard will be permanently removed.');
      if (confirmed) { deleteCard(deck.id, card.id); renderDeckDetail(); showToast('Card deleted'); }
    });
    list.appendChild(item);
  });
}

/* ---------- STUDY FLOW ---------- */
function wireStudyPage() {
  document.getElementById('study-back').addEventListener('click', () => goToPage('deck-detail'));
  document.getElementById('flash-card').addEventListener('click', flipCard);
  document.getElementById('study-flip').addEventListener('click', flipCard);
  document.getElementById('study-prev').addEventListener('click', () => stepCard(-1));
  document.getElementById('study-next').addEventListener('click', () => stepCard(1));
  document.getElementById('grade-know').addEventListener('click', () => gradeCard(true));
  document.getElementById('grade-again').addEventListener('click', () => gradeCard(false));
  document.getElementById('complete-again').addEventListener('click', () => startStudy(state.studyDeckId));
  document.getElementById('complete-home').addEventListener('click', () => goToPage('home'));
}

function startStudy(deckId) {
  const deck = getDeckById(deckId);
  if (!deck || !deck.cards.length) { showToast('Add some cards to this deck first'); return; }
  state.studyDeckId = deckId;
  state.studyQueue = [...deck.cards];
  state.studyIndex = 0;
  state.studyResults = { known: 0, learning: 0 };
  document.getElementById('study-title').textContent = deck.name;
  renderStudyCard();
  goToPage('study');
}

function renderStudyCard() {
  const deck = getDeckById(state.studyDeckId);
  const card = state.studyQueue[state.studyIndex];
  document.getElementById('flash-card').classList.remove('flipped');
  document.getElementById('study-grade').classList.add('hidden');
  document.getElementById('flash-front-text').textContent = card.front;
  document.getElementById('flash-back-text').textContent = card.back;
  document.getElementById('study-count').textContent = `${state.studyIndex + 1} / ${state.studyQueue.length}`;
  document.getElementById('study-progress').value = (state.studyIndex) / state.studyQueue.length;
}

function flipCard() {
  const flashcard = document.getElementById('flash-card');
  flashcard.classList.toggle('flipped');
  document.getElementById('study-grade').classList.toggle('hidden', !flashcard.classList.contains('flipped'));
}

function stepCard(dir) {
  const next = state.studyIndex + dir;
  if (next < 0 || next >= state.studyQueue.length) return;
  state.studyIndex = next;
  renderStudyCard();
}

function gradeCard(knewIt) {
  state.studyResults[knewIt ? 'known' : 'learning']++;
  if (state.studyIndex + 1 < state.studyQueue.length) {
    stepCard(1);
  } else {
    finishStudy();
  }
}

function finishStudy() {
  const deck = getDeckById(state.studyDeckId);
  const reviewed = state.studyQueue.length;
  recordStudySession(deck.name, reviewed);
  document.getElementById('complete-summary').textContent =
    `You reviewed ${reviewed} cards — ${state.studyResults.known} known, ${state.studyResults.learning} still learning.`;
  goToPage('complete');
  renderAll();
}

/* ---------- DECK MODAL ---------- */
function wireDeckModal() {
  document.getElementById('modal-deck-close').addEventListener('click', () => document.getElementById('modal-deck').dismiss());
  document.getElementById('deck-add-card-row').addEventListener('click', () => addDeckCardRow());
  document.getElementById('deck-add-card-row-bottom').addEventListener('click', () => addDeckCardRow());

  document.getElementById('deck-save-btn').addEventListener('click', () => {
    const name = document.getElementById('deck-name-input').value.trim();
    const icon = document.getElementById('deck-icon-select').value || 'book';
    const color = document.getElementById('deck-color-select').value || 'blue';
    if (!name) { showToast('Please enter a deck name'); return; }

    if (state.editingDeckId) {
      const decks = getDecks();
      const d = decks.find(x => x.id === state.editingDeckId);
      if (d) { d.name = name; d.icon = icon; d.color = color; setDecks(decks); }
    } else {
      const { cards, error } = collectDeckCardRows();
      if (error) { showToast(error); return; }
      const deck = createDeck({ name, icon, color });
      cards.forEach(c => addCardToDeck(deck.id, c));
    }
    document.getElementById('modal-deck').dismiss();
    showToast('Deck saved');
    renderAll(); renderDecksPage();
    if (state.currentPage === 'deck-detail') renderDeckDetail();
  });
}

function openDeckModal() {
  state.editingDeckId = null;
  document.getElementById('modal-deck-title').textContent = 'New Deck';
  document.getElementById('deck-name-input').value = '';
  document.getElementById('deck-icon-select').value = 'book';
  document.getElementById('deck-color-select').value = 'blue';
  document.getElementById('deck-cards-section').classList.remove('hidden');
  resetDeckCardBuilder();
  document.getElementById('modal-deck').present();
}

/* ---------- inline card builder (inside the New Deck modal) ---------- */
function resetDeckCardBuilder() {
  const builder = document.getElementById('deck-cards-builder');
  builder.innerHTML = '';
  addDeckCardRow();
  addDeckCardRow();
}

function addDeckCardRow() {
  const builder = document.getElementById('deck-cards-builder');
  const row = document.createElement('div');
  row.className = 'deck-card-row';
  row.innerHTML = `
    <div class="deck-card-row-head">
      <span class="row-num"></span>
      <button type="button" class="row-remove" title="Remove card"><ion-icon name="trash-outline"></ion-icon></button>
    </div>
    <ion-item>
      <ion-textarea class="row-front" label="Question" label-placement="stacked" placeholder="What do you want to ask?" auto-grow="true"></ion-textarea>
    </ion-item>
    <ion-item>
      <ion-textarea class="row-back" label="Answer" label-placement="stacked" placeholder="What's the answer?" auto-grow="true"></ion-textarea>
    </ion-item>
  `;
  row.querySelector('.row-remove').addEventListener('click', () => {
    row.remove();
    renumberDeckCardRows();
  });
  builder.appendChild(row);
  renumberDeckCardRows();
}

function renumberDeckCardRows() {
  document.querySelectorAll('#deck-cards-builder .deck-card-row').forEach((row, idx) => {
    row.querySelector('.row-num').textContent = 'Card ' + (idx + 1);
  });
}

function collectDeckCardRows() {
  const rows = Array.from(document.querySelectorAll('#deck-cards-builder .deck-card-row'));
  const cards = [];
  for (const row of rows) {
    const front = row.querySelector('.row-front').value.trim();
    const back = row.querySelector('.row-back').value.trim();
    if (!front && !back) continue;
    if (!front || !back) return { cards: [], error: 'Please fill in both sides of each card, or remove the empty one.' };
    cards.push({ front, back });
  }
  return { cards, error: null };
}

/* ---------- CARD MODAL ---------- */
function wireCardModal() {
  document.getElementById('modal-card-close').addEventListener('click', () => document.getElementById('modal-card').dismiss());
  document.getElementById('card-save-btn').addEventListener('click', () => {
    const front = document.getElementById('card-front-input').value.trim();
    const back = document.getElementById('card-back-input').value.trim();
    if (!front || !back) { showToast('Please fill in both sides of the card'); return; }

    if (state.editingCardId) {
      updateCard(state.activeDeckId, state.editingCardId, { front, back });
    } else {
      addCardToDeck(state.activeDeckId, { front, back });
    }
    document.getElementById('modal-card').dismiss();
    showToast('Card saved');
    renderDeckDetail();
  });
}

function openCardModal(deckId, cardId) {
  state.activeDeckId = deckId;
  state.editingCardId = cardId || null;
  const titleEl = document.getElementById('modal-card-title');
  const frontEl = document.getElementById('card-front-input');
  const backEl = document.getElementById('card-back-input');

  if (cardId) {
    const deck = getDeckById(deckId);
    const card = deck.cards.find(c => c.id === cardId);
    titleEl.textContent = 'Edit Card';
    frontEl.value = card.front;
    backEl.value = card.back;
  } else {
    titleEl.textContent = 'New Card';
    frontEl.value = '';
    backEl.value = '';
  }
  document.getElementById('modal-card').present();
}

/* ---------- small utilities ---------- */
function showToast(message) {
  const toast = document.getElementById('app-toast');
  toast.message = message;
  toast.present();
}

function confirmAlert(header, message) {
  return new Promise((resolve) => {
    const alertEl = document.getElementById('app-alert');
    alertEl.header = header;
    alertEl.message = message;
    alertEl.buttons = [
      { text: 'Cancel', role: 'cancel', handler: () => resolve(false) },
      { text: 'Confirm', role: 'destructive', handler: () => resolve(true) }
    ];
    alertEl.present();
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : str;
  return div.innerHTML;
}

function timeAgo(ts) {
  const diff = Math.max(0, Date.now() - ts);
  const hrs = Math.floor(diff / 3600000);
  if (hrs < 1) return 'just now';
  if (hrs < 24) return hrs + 'h ago';
  const days = Math.floor(hrs / 24);
  return days + 'd ago';
}
