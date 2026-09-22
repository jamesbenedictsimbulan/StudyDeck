/* =========================================================
   StudyDeck — data.js
   Local Storage data layer.
   All application data (decks, flashcards, study progress,
   activity log, and user settings) is persisted with the
   browser's localStorage API so it survives app restarts on
   both the website and the Android (Cordova) build.
   ========================================================= */

const STORAGE_KEYS = {
  users: 'studydeck_users',
  session: 'studydeck_session',
  decks: 'studydeck_decks',
  progress: 'studydeck_progress',
  settings: 'studydeck_settings',
  activity: 'studydeck_activity'
};

/* ---------- generic helpers ---------- */
function saveData(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (err) {
    console.error('StudyDeck: failed to save', key, err);
    return false;
  }
}

function loadData(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    return JSON.parse(raw);
  } catch (err) {
    console.error('StudyDeck: failed to load', key, err);
    return fallback;
  }
}

function uid(prefix) {
  return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function todayKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function dayLabel(date) {
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][date.getDay()];
}

/* ---------- per-account data scoping ----------
   Every deck/progress/settings/activity record is namespaced by the
   signed-in account's id, so multiple accounts on the same device each
   keep their own decks and stats instead of sharing one global bucket. */
function scopedKey(base) {
  const userId = loadData(STORAGE_KEYS.session, null);
  return userId ? `${base}::${userId}` : base;
}

/* ---------- password hashing (client-side only, local accounts) ---------- */
async function sha256Hex(text) {
  if (window.crypto && crypto.subtle && crypto.subtle.digest) {
    try {
      const enc = new TextEncoder().encode(text);
      const buf = await crypto.subtle.digest('SHA-256', enc);
      return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
    } catch (err) {
      console.warn('StudyDeck: SubtleCrypto unavailable, using fallback hash', err);
    }
  }
  // Fallback for non-secure contexts (e.g. plain http://) where SubtleCrypto is disabled.
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }
  return 'fb_' + Math.abs(hash).toString(16);
}

function genSalt() {
  const arr = new Uint8Array(16);
  if (window.crypto && crypto.getRandomValues) {
    crypto.getRandomValues(arr);
  } else {
    for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}

function hashPassword(password, salt) {
  return sha256Hex(salt + ':' + password);
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/* ---------- accounts ---------- */
function getUsers() {
  return loadData(STORAGE_KEYS.users, []);
}
function setUsers(users) { saveData(STORAGE_KEYS.users, users); }

function findUserByEmail(email) {
  const e = (email || '').trim().toLowerCase();
  return getUsers().find(u => u.email === e) || null;
}

async function registerUser({ name, email, password }) {
  name = (name || '').trim();
  email = (email || '').trim().toLowerCase();
  if (!name) throw new Error('Please enter your name.');
  if (!isValidEmail(email)) throw new Error('Please enter a valid email address.');
  if (!password || password.length < 6) throw new Error('Password must be at least 6 characters.');
  if (findUserByEmail(email)) throw new Error('An account with this email already exists.');

  const salt = genSalt();
  const passwordHash = await hashPassword(password, salt);
  const user = { id: uid('user'), name, email, salt, passwordHash, created: Date.now() };
  const users = getUsers();
  users.push(user);
  setUsers(users);
  return user;
}

async function loginUser({ email, password }) {
  const user = findUserByEmail(email);
  if (!user) throw new Error('No account found with that email.');
  const hash = await hashPassword(password || '', user.salt);
  if (hash !== user.passwordHash) throw new Error('Incorrect password.');
  return user;
}

function setSession(userId) { saveData(STORAGE_KEYS.session, userId); }
function clearSession() { localStorage.removeItem(STORAGE_KEYS.session); }

function getCurrentUser() {
  const id = loadData(STORAGE_KEYS.session, null);
  if (!id) return null;
  return getUsers().find(u => u.id === id) || null;
}

/* ---------- public getters / setters ---------- */
function getDecks() {
  return loadData(scopedKey(STORAGE_KEYS.decks), []);
}
function setDecks(decks) { saveData(scopedKey(STORAGE_KEYS.decks), decks); }

function getDeckById(id) {
  return getDecks().find(d => d.id === id) || null;
}

function getProgress() {
  let p = loadData(scopedKey(STORAGE_KEYS.progress), null);
  if (p === null) {
    p = { cardsStudied: 0, streak: 0, lastStudyDate: null, byDate: {} };
    saveData(scopedKey(STORAGE_KEYS.progress), p);
  }
  return p;
}
function setProgress(p) { saveData(scopedKey(STORAGE_KEYS.progress), p); }

function getSettings() {
  let s = loadData(scopedKey(STORAGE_KEYS.settings), null);
  if (s === null) {
    const user = getCurrentUser();
    s = { username: (user && user.name) || 'Student', theme: 'light', reminders: true, sound: true };
    saveData(scopedKey(STORAGE_KEYS.settings), s);
  }
  return s;
}
function setSettings(s) { saveData(scopedKey(STORAGE_KEYS.settings), s); }

function getActivity() {
  return loadData(scopedKey(STORAGE_KEYS.activity), []);
}
function addActivity(entry) {
  const list = getActivity();
  list.unshift({ id: uid('act'), date: Date.now(), ...entry });
  saveData(scopedKey(STORAGE_KEYS.activity), list.slice(0, 20));
}

/* ---------- deck CRUD ---------- */
function createDeck({ name, icon, color }) {
  const decks = getDecks();
  const deck = { id: uid('deck'), name, icon: icon || 'book', color: color || 'blue', created: Date.now(), cards: [] };
  decks.push(deck);
  setDecks(decks);
  addActivity({ type: 'create', text: 'You created a new deck', sub: name });
  return deck;
}

function deleteDeck(deckId) {
  const decks = getDecks();
  const deck = decks.find(d => d.id === deckId);
  setDecks(decks.filter(d => d.id !== deckId));
  if (deck) addActivity({ type: 'delete', text: 'You deleted a deck', sub: deck.name });
}

function addCardToDeck(deckId, { front, back }) {
  const decks = getDecks();
  const deck = decks.find(d => d.id === deckId);
  if (!deck) return null;
  const card = { id: uid('card'), front, back };
  deck.cards.push(card);
  setDecks(decks);
  return card;
}

function updateCard(deckId, cardId, { front, back }) {
  const decks = getDecks();
  const deck = decks.find(d => d.id === deckId);
  if (!deck) return;
  const card = deck.cards.find(c => c.id === cardId);
  if (!card) return;
  card.front = front;
  card.back = back;
  setDecks(decks);
}

function deleteCard(deckId, cardId) {
  const decks = getDecks();
  const deck = decks.find(d => d.id === deckId);
  if (!deck) return;
  deck.cards = deck.cards.filter(c => c.id !== cardId);
  setDecks(decks);
}

/* ---------- progress / study tracking ---------- */
function recordStudySession(deckName, cardsReviewed) {
  const p = getProgress();
  p.cardsStudied += cardsReviewed;

  const today = todayKey();
  p.byDate[today] = (p.byDate[today] || 0) + cardsReviewed;

  // streak logic: count consecutive days (including today) with activity
  if (p.lastStudyDate !== today) {
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    p.streak = (p.lastStudyDate === yesterday) ? p.streak + 1 : 1;
    p.lastStudyDate = today;
  }
  setProgress(p);
  addActivity({ type: 'study', text: `You studied ${cardsReviewed} cards`, sub: deckName });
  return p;
}

function getOverallProgressPercent() {
  const decks = getDecks();
  const totalCards = decks.reduce((sum, d) => sum + d.cards.length, 0);
  if (totalCards === 0) return 0;
  const p = getProgress();
  const pct = Math.round((p.cardsStudied / (totalCards * 3)) * 100); // heuristic: 3 reviews per card = "mastered"
  return Math.min(100, pct);
}

function getLast7DaysActivity() {
  const p = getProgress();
  const out = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000);
    const key = d.toISOString().slice(0, 10);
    out.push({ label: dayLabel(d), count: p.byDate[key] || 0 });
  }
  return out;
}

/* ---------- search ---------- */
function searchDecksAndCards(query) {
  const q = query.trim().toLowerCase();
  if (!q) return getDecks();
  return getDecks()
    .map(deck => {
      const nameMatch = deck.name.toLowerCase().includes(q);
      const matchingCards = deck.cards.filter(c =>
        c.front.toLowerCase().includes(q) || c.back.toLowerCase().includes(q)
      );
      if (nameMatch || matchingCards.length) {
        return { ...deck, cards: nameMatch ? deck.cards : matchingCards };
      }
      return null;
    })
    .filter(Boolean);
}

/* ---------- reset / export ---------- */
function resetAllData() {
  [STORAGE_KEYS.decks, STORAGE_KEYS.progress, STORAGE_KEYS.settings, STORAGE_KEYS.activity]
    .forEach(k => localStorage.removeItem(scopedKey(k)));
}

function exportAllData() {
  const bundle = {
    decks: getDecks(),
    progress: getProgress(),
    settings: getSettings(),
    activity: getActivity(),
    exportedAt: new Date().toISOString()
  };
  return JSON.stringify(bundle, null, 2);
}
