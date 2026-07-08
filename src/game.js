const { getUser, updateUser, ownedBy, allUsers, logEvent: dbLogEvent } = require('./db');

// ---- Ranks: purely cosmetic titles unlocked by number of people owned ----
const RANKS = [
  { min: 0, title: 'Бродяга' },
  { min: 1, title: 'Вербовщик' },
  { min: 3, title: 'Надсмотрщик' },
  { min: 7, title: 'Барон' },
  { min: 15, title: 'Магнат' },
  { min: 30, title: 'Владыка' },
  { min: 60, title: 'Император подполья' },
];

function rankFor(count) {
  let title = RANKS[0].title;
  for (const r of RANKS) if (count >= r.min) title = r.title;
  return title;
}

function ownedCount(userId) {
  return ownedBy(userId).length;
}

// ---- Passive income accrual: called whenever we read a user's balance ----
function accrue(userId) {
  const u = getUser(userId);
  if (!u) return;
  const now = Math.floor(Date.now() / 1000);
  const elapsedHours = (now - u.last_claim) / 3600;
  if (elapsedHours <= 0) return;
  const gained = Math.floor(elapsedHours * effectiveIncome(u));
  if (gained > 0) {
    updateUser(userId, { balance: u.balance + gained, last_claim: now });
  }
}

function effectiveIncome(u) {
  const owned = ownedCount(u.id);
  return u.income_per_hour + owned * 6;
}

// ---- Cost to acquire a target: scales with their protection + how many people they own ----
function acquisitionCost(target) {
  const owned = ownedCount(target.id);
  return Math.floor(80 * Math.pow(1.35, target.protection - 1) + owned * 40);
}

// ---- Chance attacker succeeds: power vs target protection ----
function successChance(attacker, target) {
  const atk = attacker.protection + ownedCount(attacker.id) * 0.5;
  const def = target.protection + ownedCount(target.id) * 0.7;
  const raw = atk / (atk + def);
  return Math.min(0.85, Math.max(0.15, raw));
}

function protectionCost(currentLevel) {
  return Math.floor(60 * Math.pow(1.5, currentLevel - 1));
}

function logEvent(userId, type, payload) {
  dbLogEvent(userId, type, payload);
}

function refreshRank(userId) {
  const count = ownedCount(userId);
  updateUser(userId, { rank_title: rankFor(count) });
}

// ---- Rebellion: runs periodically. Each owned person has a small chance per hour to escape,
// lower if the owner's protection is high ----
function runRebellionTick() {
  const owned = allUsers().filter((u) => u.owner_id !== null);
  for (const person of owned) {
    const owner = getUser(person.owner_id);
    if (!owner) continue;
    const escapeChance = Math.max(0.01, 0.06 - owner.protection * 0.006);
    if (Math.random() < escapeChance) {
      updateUser(person.id, { owner_id: null });
      logEvent(person.id, 'rebelled', { from_owner: owner.id });
      logEvent(owner.id, 'lost_person', { person_id: person.id });
      refreshRank(owner.id);
    }
  }
}

module.exports = {
  RANKS,
  rankFor,
  ownedCount,
  accrue,
  effectiveIncome,
  acquisitionCost,
  successChance,
  protectionCost,
  logEvent,
  refreshRank,
  runRebellionTick,
};
