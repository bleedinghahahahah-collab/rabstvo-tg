const { getUser, updateUser } = require('./db');

// ===================================================================
// Казино: общий раунд «Краш» — все игроки видят один и тот же множитель
// и чужие ставки одновременно. Множитель растёт по времени с момента
// старта раунда (единая формула на сервере — клиент её не диктует),
// точка краша определяется заранее и скрыта до самого краша.
// ===================================================================

const WAITING_MS = 7000; // окно приёма ставок перед стартом
const CRASH_DISPLAY_MS = 3500; // сколько висит финальный множитель перед новым раундом
const TICK_MS = 150; // шаг внутреннего цикла раунда
const GROWTH_PER_MS = 0.00006; // multiplier = e^(GROWTH_PER_MS * elapsedMs)
const HOUSE_EDGE = 0.04; // 4% — часть раундов лопается мгновенно на 1.00x
const MAX_MULTIPLIER = 100;
const MIN_BET = 5;
const MAX_BET = 500000;

let round = freshRound(0);
const history = []; // последние точки краша, самая свежая — первая

function freshRound(id) {
  return {
    id,
    phase: 'waiting', // 'waiting' | 'running' | 'crashed'
    startsAt: Date.now() + WAITING_MS, // когда фаза 'running' начнётся
    runningAt: null, // фактический timestamp старта роста множителя
    crashPoint: generateCrashPoint(),
    crashedAt: null,
    bets: new Map(), // userId -> bet
  };
}

function generateCrashPoint() {
  const r = Math.random();
  if (r < HOUSE_EDGE) return 1.0; // мгновенный краш — тоже часть механики
  const raw = (1 - HOUSE_EDGE) / (1 - r);
  return Math.min(MAX_MULTIPLIER, Math.floor(raw * 100) / 100);
}

function multiplierAt(elapsedMs) {
  if (elapsedMs <= 0) return 1.0;
  return Math.floor(Math.pow(Math.E, GROWTH_PER_MS * elapsedMs) * 100) / 100;
}

function currentMultiplier() {
  if (round.phase !== 'running' || !round.runningAt) return 1.0;
  return multiplierAt(Date.now() - round.runningAt);
}

function tick() {
  const now = Date.now();
  if (round.phase === 'waiting' && now >= round.startsAt) {
    round.phase = 'running';
    round.runningAt = now;
  } else if (round.phase === 'running') {
    if (currentMultiplier() >= round.crashPoint) {
      round.phase = 'crashed';
      round.crashedAt = now;
      for (const bet of round.bets.values()) {
        if (bet.cashedOutAt == null) bet.won = false; // не успел забрать — сгорело
      }
      history.unshift(round.crashPoint);
      if (history.length > 20) history.length = 20;
    }
  } else if (round.phase === 'crashed' && now - round.crashedAt >= CRASH_DISPLAY_MS) {
    round = freshRound(round.id + 1);
  }
}
setInterval(tick, TICK_MS);

function placeBet(userId, amount, meta) {
  if (round.phase !== 'waiting') return { ok: false, error: 'Ставки сейчас не принимаются' };
  if (round.bets.has(userId)) return { ok: false, error: 'Ты уже поставил в этом раунде' };

  const amt = Math.floor(Number(amount));
  if (!Number.isFinite(amt) || amt < MIN_BET) return { ok: false, error: `Минимальная ставка — ${MIN_BET}` };
  if (amt > MAX_BET) return { ok: false, error: `Максимальная ставка — ${MAX_BET}` };

  const u = getUser(userId);
  if (!u) return { ok: false, error: 'Игрок не найден' };
  if (u.balance < amt) return { ok: false, error: 'Недостаточно монет' };

  updateUser(userId, { balance: Math.round((u.balance - amt) * 10) / 10 });
  round.bets.set(userId, {
    userId,
    username: meta.username,
    first_name: meta.first_name,
    amount: amt,
    cashedOutAt: null,
    won: null,
  });
  return { ok: true, balance: getUser(userId).balance };
}

function cashOut(userId) {
  if (round.phase !== 'running') return { ok: false, error: 'Раунд сейчас не идёт' };
  const bet = round.bets.get(userId);
  if (!bet) return { ok: false, error: 'Ты не участвуешь в этом раунде' };
  if (bet.cashedOutAt != null) return { ok: false, error: 'Уже забрано' };

  const mult = currentMultiplier();
  if (mult >= round.crashPoint) return { ok: false, error: 'Опоздал — раунд уже лопнул' };

  const winnings = Math.round(bet.amount * mult * 10) / 10;
  bet.cashedOutAt = mult;
  bet.won = true;

  const u = getUser(userId);
  updateUser(userId, { balance: Math.round((u.balance + winnings) * 10) / 10 });

  return { ok: true, multiplier: mult, winnings, balance: getUser(userId).balance };
}

function displayName(bet) {
  return bet.username ? '@' + bet.username : bet.first_name || 'Аноним';
}

// Снимок раунда, персонализированный под конкретного игрока (is_me / my_bet)
function publicState(forUserId) {
  const now = Date.now();
  const mult = currentMultiplier();

  const bets = [...round.bets.values()]
    .sort((a, b) => b.amount - a.amount)
    .map((b) => ({
      id: b.userId,
      name: displayName(b),
      amount: b.amount,
      cashed_out_at: b.cashedOutAt,
      won: b.cashedOutAt != null ? true : round.phase === 'crashed' ? false : null,
      is_me: b.userId === forUserId,
    }));

  const myBet = forUserId != null ? round.bets.get(forUserId) : null;

  return {
    round_id: round.id,
    phase: round.phase,
    multiplier: round.phase === 'crashed' ? round.crashPoint : mult,
    starts_in_ms: round.phase === 'waiting' ? Math.max(0, round.startsAt - now) : 0,
    crash_point: round.phase === 'crashed' ? round.crashPoint : null,
    bets,
    history: history.slice(0, 15),
    my_bet: myBet
      ? { amount: myBet.amount, cashed_out_at: myBet.cashedOutAt, won: myBet.won }
      : null,
    min_bet: MIN_BET,
    max_bet: MAX_BET,
  };
}

module.exports = { placeBet, cashOut, publicState, MIN_BET, MAX_BET };
