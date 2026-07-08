require('dotenv').config();
const path = require('path');
const express = require('express');
const { webhookCallback } = require('grammy');

const { getUser, upsertUser, updateUser, ownedBy, freeUsers, topByBalance } = require('./db');
const {
  accrue,
  effectiveIncome,
  ownedCount,
  acquisitionCost,
  successChance,
  protectionCost,
  logEvent,
  refreshRank,
  runRebellionTick,
} = require('./game');
const { verifyInitData } = require('./auth');
const { createBot } = require('./bot');

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBAPP_URL = process.env.WEBAPP_URL || `http://localhost:${PORT}`;
const USE_WEBHOOK = process.env.USE_WEBHOOK === 'true';

if (!BOT_TOKEN) {
  console.error('BOT_TOKEN is not set. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const bot = createBot({ token: BOT_TOKEN, webAppUrl: WEBAPP_URL });

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---- auth middleware: every API call must carry Telegram's initData ----
function requireAuth(req, res, next) {
  const initData = req.header('x-telegram-init-data');
  const tgUser = verifyInitData(initData, BOT_TOKEN);
  if (!tgUser) return res.status(401).json({ error: 'Не удалось подтвердить пользователя Telegram' });

  const user = upsertUser({
    id: tgUser.id,
    username: tgUser.username,
    first_name: tgUser.first_name,
  });
  accrue(user.id);
  req.userId = user.id;
  next();
}

function publicUser(u) {
  const owned = ownedCount(u.id);
  return {
    id: u.id,
    username: u.username,
    first_name: u.first_name,
    balance: u.balance,
    protection: u.protection,
    income_per_hour: effectiveIncome(u),
    owned_count: owned,
    is_owned_by: u.owner_id,
    rank_title: u.rank_title,
    daily_streak: u.daily_streak,
  };
}

// ---- GET /api/me ----
app.get('/api/me', requireAuth, (req, res) => {
  const u = getUser(req.userId);
  res.json(publicUser(u));
});

// ---- GET /api/market: free players you could try to acquire ----
app.get('/api/market', requireAuth, (req, res) => {
  const rows = freeUsers(req.userId, 15);
  const list = rows.map((u) => ({
    id: u.id,
    username: u.username,
    first_name: u.first_name,
    protection: u.protection,
    owned_count: ownedCount(u.id),
    cost: acquisitionCost(u),
  }));
  res.json(list);
});

// ---- POST /api/acquire { targetId } ----
app.post('/api/acquire', requireAuth, (req, res) => {
  const { targetId } = req.body;
  const attacker = getUser(req.userId);
  const target = getUser(targetId);
  if (!target) return res.status(404).json({ error: 'Игрок не найден' });
  if (target.id === attacker.id) return res.status(400).json({ error: 'Себя не поработишь' });
  if (target.owner_id) return res.status(400).json({ error: 'Этот игрок уже кому-то принадлежит' });

  const cost = acquisitionCost(target);
  if (attacker.balance < cost) return res.status(400).json({ error: 'Недостаточно монет', cost });

  updateUser(attacker.id, { balance: attacker.balance - cost });

  const chance = successChance(attacker, target);
  const success = Math.random() < chance;

  if (success) {
    updateUser(target.id, { owner_id: attacker.id });
    logEvent(target.id, 'acquired', { by: attacker.id });
    refreshRank(attacker.id);
    notify(target.id, `⛓ Тебя поработил игрок ${displayName(attacker)}. Заработай на выкуп в разделе «Мои люди».`);
  } else {
    logEvent(attacker.id, 'raid_failed', { target: target.id });
    notify(target.id, `🛡 Игрок ${displayName(attacker)} попытался тебя захватить — твоя защита выстояла.`);
  }

  res.json({ success, chance: Math.round(chance * 100), spent: cost, balance: getUser(attacker.id).balance });
});

// ---- GET /api/my-people: people you own ----
app.get('/api/my-people', requireAuth, (req, res) => {
  const rows = ownedBy(req.userId).sort((a, b) => b.balance - a.balance);
  res.json(
    rows.map((u) => ({
      id: u.id,
      username: u.username,
      first_name: u.first_name,
      balance: u.balance,
      ransom_cost: Math.max(50, Math.floor(u.balance * 0.4) + 50),
    }))
  );
});

// ---- POST /api/free/:id — release someone you own, no charge ----
app.post('/api/free/:id', requireAuth, (req, res) => {
  const person = getUser(Number(req.params.id));
  if (!person || person.owner_id !== req.userId) return res.status(400).json({ error: 'Это не твой человек' });
  updateUser(person.id, { owner_id: null });
  logEvent(person.id, 'freed', { by: req.userId });
  refreshRank(req.userId);
  notify(person.id, `🕊 Тебя отпустили на свободу.`);
  res.json({ ok: true });
});

// ---- POST /api/ransom — pay your own way out of ownership ----
app.post('/api/ransom', requireAuth, (req, res) => {
  const me = getUser(req.userId);
  if (!me.owner_id) return res.status(400).json({ error: 'Ты и так свободен' });
  const cost = Math.max(50, Math.floor(me.balance * 0.4) + 50);
  if (me.balance < cost) return res.status(400).json({ error: 'Недостаточно монет для выкупа', cost });
  const oldOwner = me.owner_id;
  updateUser(me.id, { balance: me.balance - cost, owner_id: null });
  logEvent(me.id, 'ransomed', { from: oldOwner });
  refreshRank(oldOwner);
  notify(oldOwner, `💰 Один из твоих людей выкупил свою свободу.`);
  res.json({ ok: true, balance: getUser(me.id).balance });
});

// ---- POST /api/protect — upgrade own protection level ----
app.post('/api/protect', requireAuth, (req, res) => {
  const me = getUser(req.userId);
  const cost = protectionCost(me.protection);
  if (me.balance < cost) return res.status(400).json({ error: 'Недостаточно монет', cost });
  updateUser(me.id, { balance: me.balance - cost, protection: me.protection + 1 });
  const updated = getUser(me.id);
  res.json({ ok: true, protection: updated.protection, balance: updated.balance });
});

// ---- GET /api/leaderboard ----
app.get('/api/leaderboard', requireAuth, (req, res) => {
  const byWealth = topByBalance(20);
  res.json(
    byWealth.map((u, i) => ({
      rank: i + 1,
      id: u.id,
      username: u.username,
      first_name: u.first_name,
      balance: u.balance,
      owned_count: ownedCount(u.id),
      rank_title: u.rank_title,
    }))
  );
});

// ---- POST /api/daily — daily login bonus with streak ----
app.post('/api/daily', requireAuth, (req, res) => {
  const me = getUser(req.userId);
  const now = Math.floor(Date.now() / 1000);
  const hoursSince = (now - me.last_daily) / 3600;
  if (hoursSince < 20) {
    return res.status(400).json({ error: 'Уже забрано сегодня', next_in_hours: Math.ceil(20 - hoursSince) });
  }
  const streak = hoursSince > 48 ? 1 : me.daily_streak + 1;
  const bonus = 40 + Math.min(streak, 10) * 15;
  updateUser(me.id, { balance: me.balance + bonus, last_daily: now, daily_streak: streak });
  res.json({ bonus, streak, balance: getUser(me.id).balance });
});

// ---- GET /api/invite-link ----
app.get('/api/invite-link', requireAuth, async (req, res) => {
  const me = await bot.api.getMe();
  res.json({ link: `https://t.me/${me.username}?start=ref_${req.userId}` });
});

function displayName(u) {
  return u.username ? '@' + u.username : u.first_name || 'Аноним';
}

function notify(userId, text) {
  bot.api.sendMessage(userId, text).catch(() => {
    /* user may have blocked the bot — ignore */
  });
}

// ---- background tick: rebellions roll every 10 minutes ----
setInterval(runRebellionTick, 10 * 60 * 1000);

// ---- bot: webhook in production, long polling in local dev ----
if (USE_WEBHOOK) {
  app.use(`/webhook/${BOT_TOKEN}`, webhookCallback(bot, 'express'));
} else {
  bot.start();
}

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Mini App should be opened at: ${WEBAPP_URL}`);
});
