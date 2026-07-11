const { getUser, updateUser } = require('./db');

// ===================================================================
// Рулетка: общий раунд, ставка на цвет — красное / чёрное / зелёное.
// Красное и чёрное платят x2, зелёное (только число 0) — x20.
// Пул из 21 ячейки (0 зелёная, 10 красных, 10 чёрных) даёт ровный эдж
// ~4.8% на каждый вид ставки — того же порядка, что и в Краше.
//
// Игрок может держать НЕ БОЛЕЕ одной ставки на цвет за раунд, а красное
// и чёрное взаимоисключающие — либо одно, либо другое. Зелёное можно
// комбинировать с любым из них (красное+зелёное или чёрное+зелёное).
// ===================================================================

const WAITING_MS = 7000; // окно приёма ставок
const SPIN_MS = 4200; // сколько "крутится" барабан
const RESULT_DISPLAY_MS = 3500; // сколько висит результат перед новым раундом
const TICK_MS = 150;

const MIN_BET = 5;
const MAX_BET = 500000;

const RED_MULT = 2;
const BLACK_MULT = 2;
const GREEN_MULT = 20;

// 21 ячеек: 0 зелёная, нечётные 1..19 красные (10 шт.), чётные 2..20 чёрные (10 шт.)
const POCKETS = (() => {
  const pockets = [{ number: 0, color: 'green' }];
  for (let n = 1; n <= 20; n++) pockets.push({ number: n, color: n % 2 === 1 ? 'red' : 'black' });
  return pockets;
})();

function pickResult() {
  return POCKETS[Math.floor(Math.random() * POCKETS.length)];
}

function multiplierFor(color) {
  if (color === 'green') return GREEN_MULT;
  if (color === 'red') return RED_MULT;
  if (color === 'black') return BLACK_MULT;
  return 0;
}

function freshRound(id) {
  return {
    id,
    phase: 'waiting', // 'waiting' | 'spinning' | 'result'
    startsAt: Date.now() + WAITING_MS,
    spinResolveAt: null,
    resultedAt: null,
    result: null, // {number, color} — скрыто до фазы 'result'
    bets: new Map(), // userId -> { red?: bet, black?: bet, green?: bet }
  };
}

let round = freshRound(0);
const history = []; // последние результаты {number,color}, самый свежий первый

function allBetsFlat() {
  const flat = [];
  for (const userBets of round.bets.values()) {
    for (const color of ['red', 'black', 'green']) {
      if (userBets[color]) flat.push(userBets[color]);
    }
  }
  return flat;
}

function tick() {
  const now = Date.now();
  if (round.phase === 'waiting' && now >= round.startsAt) {
    round.phase = 'spinning';
    round.result = pickResult();
    round.spinResolveAt = now + SPIN_MS;
  } else if (round.phase === 'spinning' && now >= round.spinResolveAt) {
    round.phase = 'result';
    round.resultedAt = now;
    for (const bet of allBetsFlat()) {
      const won = bet.color === round.result.color;
      bet.won = won;
      if (won) {
        const payout = Math.round(bet.amount * multiplierFor(bet.color) * 10) / 10;
        bet.payout = payout;
        const u = getUser(bet.userId);
        if (u) updateUser(bet.userId, { balance: Math.round((u.balance + payout) * 10) / 10 });
      }
    }
    history.unshift(round.result);
    if (history.length > 20) history.length = 20;
  } else if (round.phase === 'result' && now - round.resultedAt >= RESULT_DISPLAY_MS) {
    round = freshRound(round.id + 1);
  }
}
setInterval(tick, TICK_MS);

function placeBet(userId, color, amount, meta) {
  if (round.phase !== 'waiting') return { ok: false, error: 'Ставки сейчас не принимаются' };
  if (!['red', 'black', 'green'].includes(color)) return { ok: false, error: 'Неверный цвет' };

  const userBets = round.bets.get(userId) || {};
  if (userBets[color]) return { ok: false, error: 'Ты уже поставил на этот цвет' };
  if (color === 'red' && userBets.black) return { ok: false, error: 'Нельзя ставить одновременно на красное и чёрное' };
  if (color === 'black' && userBets.red) return { ok: false, error: 'Нельзя ставить одновременно на красное и чёрное' };

  const amt = Math.floor(Number(amount));
  if (!Number.isFinite(amt) || amt < MIN_BET) return { ok: false, error: `Минимальная ставка — ${MIN_BET}` };
  if (amt > MAX_BET) return { ok: false, error: `Максимальная ставка — ${MAX_BET}` };

  const u = getUser(userId);
  if (!u) return { ok: false, error: 'Игрок не найден' };
  if (u.balance < amt) return { ok: false, error: 'Недостаточно монет' };

  updateUser(userId, { balance: Math.round((u.balance - amt) * 10) / 10 });
  userBets[color] = {
    userId,
    username: meta.username,
    first_name: meta.first_name,
    color,
    amount: amt,
    won: null,
    payout: null,
  };
  round.bets.set(userId, userBets);
  return { ok: true, balance: getUser(userId).balance };
}

function displayName(bet) {
  return bet.username ? '@' + bet.username : bet.first_name || 'Аноним';
}

function publicState(forUserId) {
  const now = Date.now();

  const bets = allBetsFlat()
    .sort((a, b) => b.amount - a.amount)
    .map((b) => ({
      id: b.userId,
      name: displayName(b),
      color: b.color,
      amount: b.amount,
      won: round.phase === 'result' ? b.won : null,
      payout: b.payout,
      is_me: b.userId === forUserId,
    }));

  const myUserBets = forUserId != null ? round.bets.get(forUserId) : null;
  const myBets = myUserBets
    ? ['red', 'black', 'green']
        .filter((c) => myUserBets[c])
        .map((c) => ({
          color: c,
          amount: myUserBets[c].amount,
          won: myUserBets[c].won,
          payout: myUserBets[c].payout,
        }))
    : [];

  return {
    round_id: round.id,
    phase: round.phase,
    starts_in_ms: round.phase === 'waiting' ? Math.max(0, round.startsAt - now) : 0,
    result: round.phase === 'result' ? round.result : null,
    bets,
    history: history.slice(0, 15),
    my_bets: myBets,
    min_bet: MIN_BET,
    max_bet: MAX_BET,
  };
}

module.exports = { placeBet, publicState, MIN_BET, MAX_BET };
