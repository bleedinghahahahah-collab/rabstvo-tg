const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data.json');

let state = { users: {}, events: [], nextEventId: 1, nextGiveawaySerial: 1 };

function load() {
  if (fs.existsSync(FILE)) {
    try {
      state = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    } catch (e) {
      console.error('data.json было повреждено, начинаю с чистой базы:', e.message);
    }
  }
}
load();

// ---- Saving: async + debounced so a burst of requests only writes to disk
// once, and never blocks the event loop while it does. This used to be
// `fs.writeFileSync` triggered on literally every request (because every
// request touches `last_seen`) — under more than a couple of concurrent
// players that synchronous full-file rewrite was stalling the whole server,
// which is why logins were capping out at just a few people. ----
let saveTimer = null;
let saveInFlight = false;
let saveAgainAfter = false;

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 1200);
}

function save() {
  if (saveInFlight) {
    saveAgainAfter = true;
    return;
  }
  saveInFlight = true;
  const snapshot = JSON.stringify(state);
  fs.writeFile(FILE, snapshot, (err) => {
    saveInFlight = false;
    if (err) console.error('Failed to save data.json:', err);
    if (saveAgainAfter) {
      saveAgainAfter = false;
      scheduleSave();
    }
  });
}

function saveSync() {
  // only used on process shutdown, where async writes can't be awaited
  fs.writeFileSync(FILE, JSON.stringify(state));
}

// make sure the last changes are flushed to disk when the process exits
process.on('exit', saveSync);
process.on('SIGINT', () => { saveSync(); process.exit(0); });
process.on('SIGTERM', () => { saveSync(); process.exit(0); });

function getUser(id) {
  return state.users[id] || null;
}

// ---- Marks a user as active without touching disk at all. Last-seen is
// only used for the "X online now" indicator, which tolerates losing this
// on a restart just fine — not worth a disk write on every single request. ----
function touchLastSeen(id) {
  const u = state.users[id];
  if (u) u.last_seen = Date.now();
}

function upsertUser({ id, username, first_name, ref_by }) {
  let u = state.users[id];
  if (u) {
    if (username) u.username = username;
    if (first_name) u.first_name = first_name;
  } else {
    u = {
      id,
      username: username || null,
      first_name: first_name || null,
      balance: 900,
      protection: 1,
      income_per_hour: 70,
      owner_id: null,
      last_claim: Math.floor(Date.now() / 1000),
      last_daily: 0,
      daily_streak: 0,
      ref_by: ref_by || null,
      rank_title: 'Бродяга',
      created_at: Math.floor(Date.now() / 1000),
      // farm tap-to-earn state
      farm_taps: 0,
      farm_last_tap: 0,
      farm_cooldown_until: 0,
      shield_until: 0,
      tap_boost_until: 0,
      times_ransomed: 0,
      acquired_price: 0,
      tap_upgrade_level: 0,
      last_seen: 0,
      whip_cooldown_until: 0,
      // "РОЗЫГРЫШ 1000 ЗВЁЗД" giveaway: starts at 0 for EVERYONE, including
      // players who already had referrals before this feature shipped —
      // by design, old referrals don't carry over into the giveaway count.
      giveaway_invites: 0,
      giveaway_serials: [],
    };
    state.users[id] = u;
  }
  scheduleSave();
  return u;
}

function updateUser(id, patch) {
  const u = state.users[id];
  if (!u) return null;
  Object.assign(u, patch);
  scheduleSave();
  return u;
}

function allUsers() {
  return Object.values(state.users);
}

function getUserByUsername(username) {
  const clean = (username || '').replace(/^@/, '').toLowerCase();
  return allUsers().find((u) => (u.username || '').toLowerCase() === clean) || null;
}

// ---- How many players have been active in the last `windowMs` — powers the
// "X играют сейчас" indicator. Matches the frontend's 8s status-poll interval
// with some slack so it doesn't flicker between polls. ----
function onlineCount(windowMs = 20000) {
  const now = Date.now();
  return allUsers().filter((u) => u.last_seen && now - u.last_seen < windowMs).length;
}

function ownedBy(ownerId) {
  return allUsers().filter((u) => u.owner_id === ownerId);
}

function matchesSearch(u, q) {
  if (!q) return true;
  const needle = q.toLowerCase();
  return (
    (u.username && u.username.toLowerCase().includes(needle)) ||
    (u.first_name && u.first_name.toLowerCase().includes(needle))
  );
}

// ---- All free (unowned) players, optionally filtered by a name/username
// search. No shuffling or capping here anymore — server.js computes each
// candidate's cost, sorts, and paginates, so this just returns the full
// matching set. ----
function freeUsers(excludeId, search) {
  return allUsers().filter((u) => u.owner_id === null && u.id !== excludeId && matchesSearch(u, search));
}

// ---- People already owned by SOMEONE ELSE — the pool for the "steal" feature ----
function stealableUsers(excludeId, search) {
  return allUsers().filter(
    (u) => u.owner_id !== null && u.owner_id !== excludeId && u.id !== excludeId && matchesSearch(u, search)
  );
}

function topByBalance(limit = 20) {
  return allUsers()
    .sort((a, b) => b.balance - a.balance)
    .slice(0, limit);
}

// ---- Top players by number of people they own (needs an ownedCount fn
// passed in from game.js to avoid a circular require between db.js/game.js) ----
function topByOwned(ownedCountFn, limit = 20) {
  return allUsers()
    .sort((a, b) => ownedCountFn(b.id) - ownedCountFn(a.id))
    .slice(0, limit);
}

// ---- Where does this user rank among EVERYONE (not just the top 20)? ----
function rankPosition(userId, compareFn) {
  const sorted = allUsers().slice().sort(compareFn);
  return sorted.findIndex((u) => u.id === userId) + 1;
}

// ---- Giveaway serial numbers: one global sequential counter shared by
// everyone, so every qualifying invite anywhere in the game gets its own
// unique ticket number in the draw. Defensive against old data.json files
// saved before this feature existed (no nextGiveawaySerial field yet). ----
function issueGiveawaySerial() {
  if (!state.nextGiveawaySerial) state.nextGiveawaySerial = 1;
  const serial = state.nextGiveawaySerial++;
  scheduleSave();
  return serial;
}

function logEvent(userId, type, payload) {
  state.events.push({
    id: state.nextEventId++,
    user_id: userId,
    type,
    payload: payload || null,
    created_at: Math.floor(Date.now() / 1000),
  });
  scheduleSave();
}

module.exports = {
  getUser,
  upsertUser,
  updateUser,
  touchLastSeen,
  allUsers,
  getUserByUsername,
  ownedBy,
  freeUsers,
  stealableUsers,
  topByBalance,
  topByOwned,
  rankPosition,
  onlineCount,
  logEvent,
  issueGiveawaySerial,
};
