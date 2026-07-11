require('dotenv').config();
const path = require('path');
const express = require('express');
const compression = require('compression');
const { webhookCallback } = require('grammy');

const { getUser, upsertUser, updateUser, touchLastSeen, allUsers, ownedBy, freeUsers, stealableUsers, topByBalance, topByOwned, onlineCount } = require('./db');
const {
  accrue,
  effectiveIncome,
  ownedCount,
  acquisitionCost,
  logEvent,
  refreshRank,
  rankFor,
  nextRankInfo,
  runRebellionTick,
  randomJob,
  jobByKey,
  personPendingIncome,
  collectFromPerson,
  ransomCost,
  stealCost,
  farmStatus,
  tryFarmTap,
  tapUpgradeCost,
  baseTapValue,
  tryBuyTapUpgrade,
  runFarmCooldownTick,
} = require('./game');
const { verifyInitData } = require('./auth');
const { createBot } = require('./bot');
const { listShopItems, getShopItem } = require('./shop');

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
app.use(compression());
app.use(express.json());
app.use(
  express.static(path.join(__dirname, '..', 'public'), {
    maxAge: 0,
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-cache');
      } else if (filePath.endsWith('.jpg') || filePath.endsWith('.png')) {
        // images rarely change — safe to cache longer
        res.setHeader('Cache-Control', 'public, max-age=86400');
      } else {
        // js/css change often during active development — always revalidate
        // so a stale cached copy never gets stuck on someone's phone
        res.setHeader('Cache-Control', 'no-cache');
      }
    },
  })
);

// ---- auth middleware: every API call must carry Telegram's initData ----
// ---- Cached leaderboard positions, refreshed periodically in the
// background instead of being recalculated on every single /api/me call.
// At 100-200 concurrent players polling every several seconds, resorting
// the whole player list on every request adds up fast — this makes each
// request an O(1) lookup instead. ----
let rankCache = { balance: new Map(), owned: new Map() };
let cachedOnlineCount = 0;

function refreshRankCache() {
  const users = allUsers();
  const byBalance = [...users].sort((a, b) => b.balance - a.balance);
  const byOwned = [...users].sort((a, b) => ownedCount(b.id) - ownedCount(a.id));
  const balanceMap = new Map();
  const ownedMap = new Map();
  byBalance.forEach((u, i) => balanceMap.set(u.id, i + 1));
  byOwned.forEach((u, i) => ownedMap.set(u.id, i + 1));
  rankCache = { balance: balanceMap, owned: ownedMap };
}
function refreshOnlineCount() {
  cachedOnlineCount = onlineCount();
}
refreshRankCache();
refreshOnlineCount();

// ---- Real-time push: online count + leaderboard, via Server-Sent Events.
// EventSource can't send custom headers, so the client passes initData as a
// query param for this one connection — it's Telegram's own signed payload
// (verified the same way as everywhere else), not a secret credential. ----
const sseClients = new Set();

function buildLiveSnapshot() {
  const byBalance = topByBalance(20).map((u, i) => ({
    rank: i + 1,
    id: u.id,
    username: u.username,
    first_name: u.first_name,
    balance: u.balance,
    owned_count: ownedCount(u.id),
    rank_title: rankFor(ownedCount(u.id)),
  }));
  const byOwned = topByOwned(ownedCount, 20).map((u, i) => ({
    rank: i + 1,
    id: u.id,
    username: u.username,
    first_name: u.first_name,
    balance: u.balance,
    owned_count: ownedCount(u.id),
    rank_title: rankFor(ownedCount(u.id)),
  }));
  return { online: cachedOnlineCount, leaderboard_balance: byBalance, leaderboard_owned: byOwned };
}

function broadcastLive() {
  if (sseClients.size === 0) return;
  const payload = `data: ${JSON.stringify(buildLiveSnapshot())}\n\n`;
  for (const client of sseClients) client.write(payload);
}

// one shared tick drives the cache AND the live broadcast — every 3s feels
// real-time without recomputing anything per-client
setInterval(() => {
  refreshRankCache();
  refreshOnlineCount();
  broadcastLive();
}, 3000);

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
  touchLastSeen(user.id);
  req.userId = user.id;
  next();
}

function publicUser(u) {
  const owned = ownedCount(u.id);
  const now = Math.floor(Date.now() / 1000);
  const nowMs = Date.now();
  const hoursSinceDaily = (now - u.last_daily) / 3600;
  const owner = u.owner_id ? getUser(u.owner_id) : null;
  return {
    id: u.id,
    username: u.username,
    first_name: u.first_name,
    balance: u.balance,
    protection: u.protection,
    income_per_hour: effectiveIncome(u),
    owned_count: owned,
    is_owned_by: u.owner_id,
    owner_name: owner ? displayName(owner) : null,
    rank_title: rankFor(owned),
    daily_streak: u.daily_streak,
    daily_available: hoursSinceDaily >= 20,
    daily_available_at: (u.last_daily + 20 * 3600) * 1000,
    next_rank: nextRankInfo(owned),
    ransom_cost: u.owner_id ? ransomCost(u) : null,
    shield_active: !!(u.shield_until && nowMs < u.shield_until),
    shield_until: u.shield_until || null,
    tap_boost_active: !!(u.tap_boost_until && nowMs < u.tap_boost_until),
    tap_boost_until: u.tap_boost_until || null,
    rank_by_balance: rankCache.balance.get(u.id) || allUsers().length,
    rank_by_owned: rankCache.owned.get(u.id) || allUsers().length,
    online_count: cachedOnlineCount,
  };
}

// ---- GET /api/live — Server-Sent Events stream: online count + leaderboard,
// pushed every 3 seconds to every connected client ----
app.get('/api/live', (req, res) => {
  const tgUser = verifyInitData(req.query.initData, BOT_TOKEN);
  if (!tgUser) return res.status(401).end();

  upsertUser({ id: tgUser.id, username: tgUser.username, first_name: tgUser.first_name });
  touchLastSeen(tgUser.id);

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();

  res.write(`data: ${JSON.stringify(buildLiveSnapshot())}\n\n`);
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

// ---- GET /api/online — how many players are active right now ----
app.get('/api/online', requireAuth, (req, res) => {
  res.json({ count: cachedOnlineCount });
});

// ---- GET /api/me ----
app.get('/api/me', requireAuth, (req, res) => {
  const u = getUser(req.userId);
  res.json(publicUser(u));
});

// ---- GET /api/market: free players you could try to acquire ----
app.get('/api/market', requireAuth, (req, res) => {
  const now = Date.now();
  const me = getUser(req.userId);
  const rows = freeUsers(req.userId, 15).filter(
    (u) => !(u.shield_until && now < u.shield_until) && u.id !== me.owner_id
  );
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
  if (target.id === attacker.owner_id) {
    return res.status(400).json({ error: 'Сначала выкупи свою свободу в профиле — потом сможешь его захватить' });
  }
  if (target.owner_id) return res.status(400).json({ error: 'Этот игрок уже кому-то принадлежит' });
  if (target.shield_until && Date.now() < target.shield_until) {
    return res.status(400).json({ error: 'Этот игрок сейчас под защитой от рабства' });
  }

  const cost = acquisitionCost(target);
  if (attacker.balance < cost) return res.status(400).json({ error: 'Недостаточно монет', cost });

  updateUser(attacker.id, { balance: attacker.balance - cost });

  // Acquisitions always succeed now — no more chance involved.
  const job = randomJob();
  updateUser(target.id, { owner_id: attacker.id, job: job.key, income_last_claim: Math.floor(Date.now() / 1000) });
  logEvent(target.id, 'acquired', { by: attacker.id, job: job.key });
  refreshRank(attacker.id);
  notify(
    target.id,
    `Тебя поработил игрок ${displayName(attacker)}. Твоя новая работа: ${job.name}. Заработай на выкуп в разделе «Мои люди».`
  );

  res.json({ success: true, spent: cost, balance: getUser(attacker.id).balance });
});

// ---- GET /api/market/stealable: people already owned by SOMEONE ELSE ----
app.get('/api/market/stealable', requireAuth, (req, res) => {
  const now = Date.now();
  const me = getUser(req.userId);
  const rows = stealableUsers(req.userId, 15).filter(
    (u) => !(u.shield_until && now < u.shield_until) && u.id !== me.owner_id
  );
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
  if (target.id === attacker.owner_id) {
    return res.status(400).json({ error: 'Сначала выкупи свою свободу в профиле — потом сможешь его увести' });
  }
  if (!target.owner_id) return res.status(400).json({ error: 'Этот человек свободен — используй «Захватить» на вкладке «Свободные»' });
  if (target.owner_id === attacker.id) return res.status(400).json({ error: 'Он уже твой' });
  if (target.shield_until && Date.now() < target.shield_until) {
    return res.status(400).json({ error: 'Этот игрок сейчас под защитой от рабства' });
  }

  const cost = stealCost(target);
  if (attacker.balance < cost) return res.status(400).json({ error: 'Недостаточно монет', cost });

  const oldOwnerId = target.owner_id;
  const oldOwner = getUser(oldOwnerId);

  updateUser(attacker.id, { balance: attacker.balance - cost });

  // Steals always succeed now — no more chance involved.
  updateUser(target.id, { owner_id: attacker.id }); // keeps their existing job
  logEvent(target.id, 'stolen', { by: attacker.id, from: oldOwnerId });
  refreshRank(attacker.id);
  if (oldOwner) refreshRank(oldOwner.id);
  notify(target.id, `Тебя увели у прежнего владельца. Теперь ты у игрока ${displayName(attacker)}.`);
  notify(oldOwnerId, `Твоего человека ${displayName(target)} увёл игрок ${displayName(attacker)}.`);

  res.json({ success: true, spent: cost, balance: getUser(attacker.id).balance });
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

// ---- POST /api/collect-all — collect income from every owned person at once ----
app.post('/api/collect-all', requireAuth, (req, res) => {
  const people = ownedBy(req.userId);
  let total = 0;
  for (const person of people) {
    total += collectFromPerson(person);
  }
  total = Math.round(total * 10) / 10;

  if (total > 0) {
    const me = getUser(req.userId);
    updateUser(req.userId, { balance: Math.round((me.balance + total) * 10) / 10 });
  }

  res.json({ ok: true, gained: total, balance: getUser(req.userId).balance });
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
  updateUser(me.id, { balance: me.balance - cost, owner_id: null, times_ransomed: (me.times_ransomed || 0) + 1 });
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
  const by = req.query.by === 'owned' ? 'owned' : 'balance';
  const top = by === 'owned' ? topByOwned(ownedCount, 20) : topByBalance(20);
  res.json(
    top.map((u, i) => ({
      rank: i + 1,
      id: u.id,
      username: u.username,
      first_name: u.first_name,
      balance: u.balance,
      owned_count: ownedCount(u.id),
      rank_title: rankFor(ownedCount(u.id)),
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
  const level = me.tap_upgrade_level || 0;
  res.json({
    ...farmStatus(me),
    tap_upgrade_level: level,
    tap_value: Math.round(baseTapValue(me) * 100) / 100,
    tap_upgrade_cost: tapUpgradeCost(level),
  });
});

// ---- POST /api/farm/upgrade-tap — permanent tap-value upgrade, paid in coins ----
app.post('/api/farm/upgrade-tap', requireAuth, (req, res) => {
  const result = tryBuyTapUpgrade(req.userId);
  if (!result.ok) {
    return res.status(400).json({ error: 'Недостаточно монет', cost: result.cost });
  }
  res.json(result);
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

// ---- GET /api/shop/items ----
app.get('/api/shop/items', requireAuth, (req, res) => {
  res.json(listShopItems());
});

// ---- POST /api/shop/invoice { item } — creates a Telegram Stars invoice
// link. The Mini App opens this via Telegram.WebApp.openInvoice(); actual
// fulfillment happens in bot.js once Telegram confirms the payment. ----
app.post('/api/shop/invoice', requireAuth, async (req, res) => {
  const item = getShopItem(req.body.item);
  if (!item) return res.status(404).json({ error: 'Такого товара нет' });

  try {
    const link = await bot.api.createInvoiceLink(
      item.title,
      item.description,
      JSON.stringify({ userId: req.userId, item: req.body.item }),
      '', // provider_token — must be empty string for Telegram Stars
      'XTR',
      [{ label: item.title, amount: item.price }]
    );
    res.json({ link });
  } catch (e) {
    console.error('createInvoiceLink failed:', e);
    res.status(500).json({ error: 'Не удалось создать счёт' });
  }
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
