const { getUser, updateUser, ownedBy, allUsers, logEvent: dbLogEvent } = require('./db');

// ---- Jobs: assigned to a person the moment they're acquired. Each job has
// its own hourly income, balanced so the average stays close to the old
// flat rate — variety without breaking the economy. ----
const JOBS = [
  { key: 'toilet', name: 'Мойщик параши', income: 52, blurb: 'Драит толчки с чувством, с толком, с расстановкой.' },
  { key: 'taxi', name: 'Таксист', income: 74, blurb: 'Возит клиентов в объезд для повышения счётчика.' },
  { key: 'trader', name: 'Трейдер', income: 84, blurb: 'Сливает депозит с уверенным видом.' },
  { key: 'diver', name: 'Водолаз', income: 64, blurb: 'Ищет на дне реки то, что все давно потеряли.' },
  { key: 'lookout', name: 'Смотрящий за подъездом', income: 52, blurb: 'Следит, чтобы лифт работал хотя бы иногда.' },
  { key: 'noodle_dealer', name: 'Барыга доширака', income: 64, blurb: 'Продаёт лапшу втридорога прямо у окна камеры.' },
  { key: 'fortune_teller', name: 'Гадалка на кофейной гуще', income: 52, blurb: 'Предсказывает конец срока с точностью до квартала.' },
  { key: 'ad_copywriter', name: 'Копирайтер объявлений «куплю/продам»', income: 64, blurb: 'Пишет "торг уместен" с настоящей душой.' },
  { key: 'funeral_dj', name: 'Диджей на похоронах', income: 74, blurb: 'Ставит грустные биты за скромный гонорар.' },
  { key: 'scrap_dealer', name: 'Скупщик металлолома', income: 74, blurb: 'Утаскивает всё, что плохо прикручено.' },
  { key: 'bootleg_seller', name: 'Продавец пиратских дисков', income: 64, blurb: '«Держи, брат, HD-качество» — качество не гарантирует.' },
  { key: 'mystery_courier', name: 'Курьер сомнительных посылок', income: 84, blurb: 'Не задаёт вопросов, просто доставляет.' },
  { key: 'background_actor', name: 'Актёр массовки в сериале', income: 52, blurb: 'Играет «прохожего номер три» уже седьмой сезон.' },
  { key: 'shawarma_owner', name: 'Владелец ларька с шаурмой', income: 94, blurb: 'Единственный, у кого доход реально стабилен.' },
  { key: 'pigeon_keeper', name: 'Смотритель голубей', income: 42, blurb: 'Кормит птиц и втайне мечтает о лучшей жизни.' },
  { key: 'charger_tester', name: 'Тестировщик китайских зарядок', income: 52, blurb: 'Проверяет, взорвётся или нет. Пока везёт.' },
  { key: 'cellmate_therapist', name: 'Психолог для сокамерников', income: 64, blurb: 'Слушает всех, советует всем, платят единицы.' },
  { key: 'crypto_evangelist', name: 'Крипто-евангелист', income: 84, blurb: 'Обещает иксы, доставляет нули.' },
  { key: 'cat_shepherd', name: 'Пастух дворовых котов', income: 42, blurb: 'Особая порода терпения.' },
];

function randomJob() {
  return JOBS[Math.floor(Math.random() * JOBS.length)];
}

function jobByKey(key) {
  return JOBS.find((j) => j.key === key) || null;
}

// ---- Ranks: purely cosmetic titles unlocked by number of people owned ----
const RANKS = [
  { min: 0, title: 'Прохожий' },
  { min: 4, title: 'Вербовщик' },
  { min: 8, title: 'Сутенер' },
  { min: 13, title: 'Кингман' },
  { min: 16, title: 'Барон' },
  { min: 21, title: 'Авторитет' },
  { min: 26, title: 'Крестный' },
  { min: 31, title: 'Повелитель' },
];

function rankFor(count) {
  let title = RANKS[0].title;
  for (const r of RANKS) if (count >= r.min) title = r.title;
  return title;
}

// ---- How far a player is from their next title, for a profile progress bar ----
function nextRankInfo(count) {
  for (const r of RANKS) {
    if (count < r.min) return { title: r.title, remaining: r.min - count, needed: r.min };
  }
  return null; // already at the top rank
}

function ownedCount(userId) {
  return ownedBy(userId).length;
}

// ---- Passive income accrual: called whenever we read a user's balance ----
// ---- Passive income accrual: only the player's OWN base income accrues
// automatically. Income from owned people's jobs must be collected by hand
// via the "Забрать доход" button — see personPendingIncome / collectFromPerson. ----
function accrue(userId) {
  const u = getUser(userId);
  if (!u) return;
  const now = Math.floor(Date.now() / 1000);
  const elapsedHours = (now - u.last_claim) / 3600;
  if (elapsedHours <= 0) return;
  const gained = Math.floor(elapsedHours * u.income_per_hour);
  if (gained > 0) {
    updateUser(userId, { balance: u.balance + gained, last_claim: now });
  }
}

// ---- How much a specific owned person has accumulated since the owner
// last collected from them ----
function personPendingIncome(person) {
  const job = jobByKey(person.job);
  const rate = job ? job.income : 12;
  const now = Math.floor(Date.now() / 1000);
  const since = person.income_last_claim || person.created_at || now;
  const elapsedHours = (now - since) / 3600;
  if (elapsedHours <= 0) return 0;
  return Math.round(elapsedHours * rate * 10) / 10;
}

// ---- Owner collects the pending income from one specific owned person ----
function collectFromPerson(person) {
  const gained = personPendingIncome(person);
  if (gained > 0) {
    updateUser(person.id, { income_last_claim: Math.floor(Date.now() / 1000) });
  }
  return gained;
}

function effectiveIncome(u) {
  const owned = ownedBy(u.id);
  const jobIncome = owned.reduce((sum, person) => {
    const job = jobByKey(person.job);
    return sum + (job ? job.income : 12); // 12 = fallback for people acquired before jobs existed
  }, 0);
  return u.income_per_hour + jobIncome;
}

// ---- Cost to acquire a target: scales with their protection + how many people they own ----
function acquisitionCost(target) {
  const owned = ownedCount(target.id);
  return Math.floor(280 * Math.pow(1.35, target.protection - 1) + owned * 140);
}

// ---- Chance attacker succeeds: weighted so weak targets (few/no people of
// their own) are noticeably easy to take, and well-built targets are
// noticeably harder — with a higher overall baseline than before. ----
function successChance(attacker, target) {
  const atkPower = 10 + ownedCount(attacker.id) * 4 + attacker.protection * 2;
  const defPower = 10 + ownedCount(target.id) * 6 + target.protection * 2;
  const raw = atkPower / (atkPower + defPower);
  return Math.min(0.92, Math.max(0.25, raw));
}

// ---- Price to buy your own freedom: reflects how valuable you are as an
// asset (your job income + your own little empire), not just your balance ----
function ransomCost(person) {
  const job = jobByKey(person.job);
  const jobIncome = job ? job.income : 12;
  const owned = ownedCount(person.id);
  return Math.floor(180 + jobIncome * 12 + owned * 70 + person.balance * 0.15);
}

// ---- Stealing someone who's already enslaved: you're not fighting the
// person themselves, you're fighting whoever currently owns them. Cost and
// chance both scale off the CURRENT OWNER's strength — stealing from a big
// established player is much harder than from someone who barely has
// anything built up. ----
function stealCost(target) {
  const owner = getUser(target.owner_id);
  const ownerOwned = owner ? ownedCount(owner.id) : 0;
  const job = jobByKey(target.job);
  const jobIncome = job ? job.income : 12;
  return Math.floor(320 + jobIncome * 8 + ownerOwned * 90 + (owner ? owner.protection : 1) * 40);
}

function stealChance(attacker, target) {
  const owner = getUser(target.owner_id);
  const atkPower = 10 + ownedCount(attacker.id) * 4 + attacker.protection * 2;
  const ownerPower = owner ? 10 + ownedCount(owner.id) * 6 + owner.protection * 2 : 10;
  const raw = atkPower / (atkPower + ownerPower);
  // slightly harder range than a normal acquire — stealing is riskier by design
  return Math.min(0.85, Math.max(0.15, raw));
}

// NOTE: protection upgrades were removed as a player-facing feature per
// request — protection stays at whatever value a user starts with and is
// only used internally by acquisitionCost/successChance below.

function logEvent(userId, type, payload) {
  dbLogEvent(userId, type, payload);
}

function refreshRank(userId) {
  const count = ownedCount(userId);
  updateUser(userId, { rank_title: rankFor(count) });
}

// ===================================================================
// Farm: tap-to-earn. 0.2 coins per tap, max 4 taps/sec, 5000 taps then a
// 3-hour cooldown before the counter resets.
// ===================================================================
const FARM_REWARD = 1;
const FARM_TAP_LIMIT = 5000;
const FARM_COOLDOWN_MS = 3 * 60 * 60 * 1000;
const FARM_MIN_INTERVAL_MS = 60; // ~16 taps/sec — comfortably covers fast two-finger tapping

function farmStatus(user) {
  const now = Date.now();
  if (user.farm_cooldown_until && now >= user.farm_cooldown_until) {
    // cooldown already expired naturally — caller should reset via farmResetIfExpired
    return { locked: false, taps_used: 0, taps_limit: FARM_TAP_LIMIT, unlock_at: null };
  }
  if (user.farm_cooldown_until && now < user.farm_cooldown_until) {
    return { locked: true, taps_used: user.farm_taps, taps_limit: FARM_TAP_LIMIT, unlock_at: user.farm_cooldown_until };
  }
  return { locked: false, taps_used: user.farm_taps || 0, taps_limit: FARM_TAP_LIMIT, unlock_at: null };
}

function farmResetIfExpired(userId) {
  const u = getUser(userId);
  if (!u) return;
  if (u.farm_cooldown_until && Date.now() >= u.farm_cooldown_until) {
    updateUser(userId, { farm_taps: 0, farm_cooldown_until: 0 });
  }
}

// Returns { ok:true, reward, balance, taps_used, taps_remaining }
// or { ok:false, error:'too_fast' | 'locked', unlock_at? }
function tryFarmTap(userId) {
  farmResetIfExpired(userId);
  const u = getUser(userId);
  if (!u) return { ok: false, error: 'not_found' };

  if (u.farm_cooldown_until && Date.now() < u.farm_cooldown_until) {
    return { ok: false, error: 'locked', unlock_at: u.farm_cooldown_until };
  }

  const now = Date.now();
  if (u.farm_last_tap && now - u.farm_last_tap < FARM_MIN_INTERVAL_MS) {
    return { ok: false, error: 'too_fast' };
  }

  const newTaps = (u.farm_taps || 0) + 1;
  const newBalance = Math.round((u.balance + FARM_REWARD) * 10) / 10;
  const patch = { balance: newBalance, farm_taps: newTaps, farm_last_tap: now };

  if (newTaps >= FARM_TAP_LIMIT) {
    patch.farm_cooldown_until = now + FARM_COOLDOWN_MS;
  }

  updateUser(userId, patch);

  return {
    ok: true,
    reward: FARM_REWARD,
    balance: newBalance,
    taps_used: newTaps,
    taps_remaining: Math.max(0, FARM_TAP_LIMIT - newTaps),
    locked: newTaps >= FARM_TAP_LIMIT,
    unlock_at: newTaps >= FARM_TAP_LIMIT ? patch.farm_cooldown_until : null,
  };
}

// ---- background tick: notify players whose farm cooldown just expired ----
function runFarmCooldownTick(notifyFn) {
  const now = Date.now();
  for (const u of allUsers()) {
    if (u.farm_cooldown_until && now >= u.farm_cooldown_until) {
      updateUser(u.id, { farm_taps: 0, farm_cooldown_until: 0 });
      if (notifyFn) notifyFn(u.id);
    }
  }
}
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
  JOBS,
  randomJob,
  jobByKey,
  rankFor,
  nextRankInfo,
  ownedCount,
  accrue,
  personPendingIncome,
  collectFromPerson,
  effectiveIncome,
  acquisitionCost,
  successChance,
  ransomCost,
  stealCost,
  stealChance,
  logEvent,
  refreshRank,
  runRebellionTick,
  FARM_REWARD,
  FARM_TAP_LIMIT,
  farmStatus,
  tryFarmTap,
  runFarmCooldownTick,
};
