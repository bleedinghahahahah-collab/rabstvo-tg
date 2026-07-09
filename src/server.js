require('dotenv').config();
const path = require('path');
const express = require('express');
const { webhookCallback } = require('grammy');

const { getUser, upsertUser, updateUser, ownedBy, freeUsers, stealableUsers, topByBalance } = require('./db');
const {
  accrue,
  effectiveIncome,
  ownedCount,
  acquisitionCost,
  successChance,
  logEvent,
  refreshRank,
  nextRankInfo,
  runRebellionTick,
  randomJob,
  jobByKey,
  personPendingIncome,
  collectFromPerson,
  ransomCost,
  stealCost,
  stealChance,
  farmStatus,
  tryFarmTap,
  runFarmCooldownTick,
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
  const now = Math.floor(Date.now() / 1000);
  const hoursSinceDaily = (now - u.last_daily) / 3600;
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
    daily_available: hoursSinceDaily >= 20,
    next_rank: nextRankInfo(owned),
    ransom_cost: u.owner_id ? ransomCost(u) : null,
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
    const job = randomJob();
    updateUser(target.id, { owner_id: attacker.id, job: job.key, income_last_claim: Math.floor(Date.now() / 1000) });
    logEvent(target.id, 'acquired', { by: attacker.id, job: job.key });
    refreshRank(attacker.id);
    notify(
      target.id,
      `Тебя поработил игрок ${displayName(attacker)}. Твоя новая работа: ${job.name}. Заработай на выкуп в разделе «Мои люди».`
    );
  } else {
    logEvent(attacker.id, 'raid_failed', { target: target.id });
    notify(target.id, `Игрок ${displayName(attacker)} попытался тебя захватить — твоя защита выстояла.`);
  }

  res.json({ success, chance: Math.round(chance * 100), spent: cost, balance: getUser(attacker.id).balance });
});

// ---- GET /api/market/stealable: people already owned by SOMEONE ELSE ----
app.get('/api/market/stealable', requireAuth, (req, res) => {
  const rows = stealableUsers(req.userId, 15);
  const list = rows.map((u) => {
    const owner = getUser(u.owner_id);
    return {
      id: u.id,
      username: u.username,
      first_name: u.first_name,
      owner_name: owner ? displayName(owner) : 'Неизвестно',
      cost: stealCost(u),
    };
  });
  res.json(list);
});

// ---- POST /api/steal { targetId } — take someone away from their current owner ----
app.post('/api/steal', requireAuth, (req, res) => {
  const { targetId } = req.body;
  const attacker = getUser(req.userId);
  const target = getUser(targetId);
  if (!target) return res.status(404).json({ error: 'Игрок не найден' });
  if (target.id === attacker.id) return res.status(400).json({ error: 'Себя не поработишь' });
  if (!target.owner_id) return res.status(400).json({ error: 'Этот человек свободен — используй «Захватить» на вкладке «Свободные»' });
  if (target.owner_id === attacker.id) return res.status(400).json({ error: 'Он уже твой' });

  const cost = stealCost(target);
  if (attacker.balance < cost) return res.status(400).json({ error: 'Недостаточно монет', cost });

  const oldOwnerId = target.owner_id;
  const oldOwner = getUser(oldOwnerId);

  updateUser(attacker.id, { balance: attacker.balance - cost });

  const chance = stealChance(attacker, target);
  const success = Math.random() < chance;

  if (success) {
    updateUser(target.id, { owner_id: attacker.id }); // keeps their existing job
    logEvent(target.id, 'stolen', { by: attacker.id, from: oldOwnerId });
    refreshRank(attacker.id);
    if (oldOwner) refreshRank(oldOwner.id);
    notify(target.id, `Тебя увели у прежнего владельца. Теперь ты у игрока ${displayName(attacker)}.`);
    notify(oldOwnerId, `Твоего человека ${displayName(target)} увёл игрок ${displayName(attacker)}.`);
  } else {
    logEvent(attacker.id, 'steal_failed', { target: target.id, owner: oldOwnerId });
    notify(oldOwnerId, `Игрок ${displayName(attacker)} пытался увести твоего человека ${displayName(target)} — не вышло.`);
  }

  res.json({ success, chance: Math.round(chance * 100), spent: cost, balance: getUser(attacker.id).balance });
});

// ---- GET /api/my-people: people you own ----
app.get('/api/my-people', requireAuth, (req, res) => {
  const rows = ownedBy(req.userId).sort((a, b) => b.balance - a.balance);
  res.json(
    rows.map((u) => {
      const job = jobByKey(u.job);
      return {
        id: u.id,
        username: u.username,
        first_name: u.first_name,
        balance: u.balance,
        ransom_cost: ransomCost(u),
        job_name: job ? job.name : 'Без определённой профессии',
        job_blurb: job ? job.blurb : 'Пока просто числится.',
        job_income: job ? job.income : 6,
        pending_income: personPendingIncome(u),
      };
    })
  );
});

// ---- POST /api/collect/:id — collect accrued income from one owned person ----
app.post('/api/collect/:id', requireAuth, (req, res) => {
  const person = getUser(Number(req.params.id));
  if (!person || person.owner_id !== req.userId) return res.status(400).json({ error: 'Это не твой человек' });

  const gained = collectFromPerson(person);
  if (gained <= 0) return res.status(400).json({ error: 'Пока нечего забирать' });

  const me = getUser(req.userId);
  updateUser(req.userId, { balance: Math.round((me.balance + gained) * 10) / 10 });

  res.json({ ok: true, gained, balance: getUser(req.userId).balance });
});

// ---- POST /api/free/:id — release someone you own, no charge ----
app.post('/api/free/:id', requireAuth, (req, res) => {
  const person = getUser(Number(req.params.id));
  if (!person || person.owner_id !== req.userId) return res.status(400).json({ error: 'Это не твой человек' });
  updateUser(person.id, { owner_id: null });
  logEvent(person.id, 'freed', { by: req.userId });
  refreshRank(req.userId);
  notify(person.id, `Тебя отпустили на свободу.`);
  res.json({ ok: true });
});

// ---- POST /api/ransom — pay your own way out of ownership ----
app.post('/api/ransom', requireAuth, (req, res) => {
  const me = getUser(req.userId);
  if (!me.owner_id) return res.status(400).json({ error: 'Ты и так свободен' });
  const cost = ransomCost(me);
  if (me.balance < cost) return res.status(400).json({ error: 'Недостаточно монет для выкупа', cost });
  const oldOwner = me.owner_id;
  updateUser(me.id, { balance: me.balance - cost, owner_id: null });
  logEvent(me.id, 'ransomed', { from: oldOwner });
  refreshRank(oldOwner);
  notify(oldOwner, `Один из твоих людей выкупил свою свободу.`);
  res.json({ ok: true, balance: getUser(me.id).balance });
});

// ---- GET /api/avatar/:id — proxies a user's Telegram profile photo.
// Fetches it server-side via the Bot API so the bot token never reaches
// the client (embedding it directly in an <img src> would leak it). ----
app.get('/api/avatar/:id', requireAuth, async (req, res) => {
  try {
    const userId = Number(req.params.id);
    const photos = await bot.api.getUserProfilePhotos(userId, { limit: 1 });
    if (!photos.total_count) return res.status(404).end();

    const sizes = photos.photos[0];
    const fileId = sizes[0].file_id; // smallest size — plenty for a small avatar circle
    const file = await bot.api.getFile(fileId);
    const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;

    const upstream = await fetch(fileUrl);
    if (!upstream.ok) return res.status(404).end();

    res.set('Content-Type', upstream.headers.get('content-type') || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=3600');
    const buffer = Buffer.from(await upstream.arrayBuffer());
    res.send(buffer);
  } catch (e) {
    res.status(404).end();
  }
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
  const bonus = 140 + Math.min(streak, 10) * 50;
  updateUser(me.id, { balance: me.balance + bonus, last_daily: now, daily_streak: streak });
  res.json({ bonus, streak, balance: getUser(me.id).balance });
});

// ---- GET /api/farm/status ----
app.get('/api/farm/status', requireAuth, (req, res) => {
  const me = getUser(req.userId);
  res.json(farmStatus(me));
});

// ---- POST /api/farm/tap ----
app.post('/api/farm/tap', requireAuth, (req, res) => {
  const result = tryFarmTap(req.userId);
  if (!result.ok) {
    if (result.error === 'locked') {
      return res.status(429).json({ error: 'Лимит тапов исчерпан, жди обновления', unlock_at: result.unlock_at });
    }
    if (result.error === 'too_fast') {
      return res.status(429).json({ error: 'Слишком быстро' });
    }
    return res.status(400).json({ error: 'Не удалось' });
  }
  res.json(result);
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

// ---- background tick: check every minute whether anyone's farm cooldown just expired ----
setInterval(() => {
  runFarmCooldownTick((userId) => {
    notify(userId, 'Лимит тапов на ферме обновился — можно снова собирать монеты.');
  });
}, 60 * 1000);

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
