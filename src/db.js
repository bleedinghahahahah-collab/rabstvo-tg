const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data.json');

let state = { users: {}, events: [], nextEventId: 1 };

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

let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 150);
}
function save() {
  fs.writeFileSync(FILE, JSON.stringify(state, null, 2));
}
// make sure the last changes are flushed to disk when the process exits
process.on('exit', save);
process.on('SIGINT', () => { save(); process.exit(0); });
process.on('SIGTERM', () => { save(); process.exit(0); });

function getUser(id) {
  return state.users[id] || null;
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
      balance: 200,
      protection: 1,
      income_per_hour: 10,
      owner_id: null,
      last_claim: Math.floor(Date.now() / 1000),
      last_daily: 0,
      daily_streak: 0,
      ref_by: ref_by || null,
      rank_title: 'Бродяга',
      created_at: Math.floor(Date.now() / 1000),
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

function ownedBy(ownerId) {
  return allUsers().filter((u) => u.owner_id === ownerId);
}

function freeUsers(excludeId, limit = 15) {
  const candidates = allUsers().filter((u) => u.owner_id === null && u.id !== excludeId);
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }
  return candidates.slice(0, limit);
}

function topByBalance(limit = 20) {
  return allUsers()
    .sort((a, b) => b.balance - a.balance)
    .slice(0, limit);
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
  allUsers,
  ownedBy,
  freeUsers,
  topByBalance,
  logEvent,
};
