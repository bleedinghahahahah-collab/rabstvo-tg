const path = require('path');
const { Bot, InlineKeyboard, InputFile } = require('grammy');
const { upsertUser, getUser, updateUser, getUserByUsername, allUsers } = require('./db');
const { logEvent, randomJob } = require('./game');
const { getShopItem, applyPurchase } = require('./shop');
const { recordGiveawayInvite, GIVEAWAY_REMINDER_TEXT } = require('./giveaway');

const GIVEAWAY_REMINDER_IMAGE = path.join(__dirname, '..', 'public', 'assets', 'giveaway-square.jpg');

function displayName(u) {
  return u.username ? '@' + u.username : u.first_name || `ID ${u.id}`;
}

// ---- Admin IDs: whoever is listed in ADMIN_ID can use /give and is the only
// audience for automated ops notifications (e.g. daily peak online count).
// Supports one ID or several, e.g.:
//   ADMIN_ID=123456789
//   ADMIN_ID=123456789,987654321
//   ADMIN_ID=[123456789,987654321]   (brackets are fine too, just ignored)
function getAdminIds() {
  return (process.env.ADMIN_ID || '')
    .replace(/[[\]\s]/g, '')
    .split(',')
    .map(Number)
    .filter(Number.isFinite);
}

// Same "Открыть игру"-style WebApp button as /start, just labeled for this
// message — lets someone jump straight into the Mini App from the reminder
// instead of having to go dig up the bot chat first. Sent as a photo (the
// square banner art) with the reminder as its caption, rather than plain
// text. Sends to everyone with a small delay between messages — Telegram's
// Bot API rate-limits bulk sends, and this keeps well under that (~20/s)
// without needing a queueing library for what's at most a once-a-day (or
// manually triggered) job. Used both by the scheduled 12:00 MSK tick
// (server.js) and the /broadcast admin command below, so there's exactly
// one place this logic lives.
async function broadcastGiveawayReminder(bot, webAppUrl) {
  const keyboard = new InlineKeyboard().webApp('ПОДПОЛЬЕ', webAppUrl);
  const users = allUsers();
  for (const u of users) {
    // A fresh InputFile per send — it wraps a lazily-opened read stream,
    // so reusing one instance across many sendPhoto calls isn't safe.
    const photo = new InputFile(GIVEAWAY_REMINDER_IMAGE);
    bot.api.sendPhoto(u.id, photo, { caption: GIVEAWAY_REMINDER_TEXT, reply_markup: keyboard }).catch(() => {
      /* user may have blocked the bot, or never opened a DM with it — ignore */
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return users.length;
}

function createBot({ token, webAppUrl }) {
  const bot = new Bot(token);

  bot.command('start', (ctx) => {
    const payload = ctx.match; // e.g. "ref_123456"
    let refBy = null;
    if (payload && payload.startsWith('ref_')) {
      const candidate = Number(payload.replace('ref_', ''));
      if (Number.isFinite(candidate) && candidate !== ctx.from.id) refBy = candidate;
    }

    const alreadyExists = getUser(ctx.from.id);
    const user = upsertUser({
      id: ctx.from.id,
      username: ctx.from.username,
      first_name: ctx.from.first_name,
      ref_by: refBy,
    });

    // First-time join via referral: the invited player starts with a flat
    // 900 (same as the usual organic-join balance) and starts out
    // already "in service to" the inviter — ties the invite system directly
    // into the core ownership mechanic. The inviter gets a flat +1250.
    let joinedViaReferral = false;
    if (!alreadyExists && refBy) {
      const inviter = getUser(refBy);
      if (inviter) {
        joinedViaReferral = true;
        const job = randomJob();
        updateUser(refBy, { balance: inviter.balance + 1250 });
        updateUser(user.id, {
          balance: 900,
          owner_id: refBy,
          job: job.key,
          acquired_price: 0, // came in free via referral, not bought on the market
          income_last_claim: Math.floor(Date.now() / 1000),
        });
        logEvent(refBy, 'acquired', { person_id: user.id, via: 'referral', job: job.key });

        // "РОЗЫГРЫШ 1000 ЗВЁЗД": every new referral hands the inviter one
        // fresh numbered ticket, regardless of any referrals they made
        // before this feature existed — see giveaway.js.
        const giveawayResult = recordGiveawayInvite(refBy);
        if (giveawayResult) {
          const invitee = getUser(user.id);
          const qualifiedLine = giveawayResult.qualified
            ? 'уже участвует ✅'
            : `${giveawayResult.invites}/3 — ещё не участвует`;
          const adminText =
            `🎟 Новый билет в розыгрыше «1000 звёзд»\n` +
            `№${giveawayResult.serial} — ${displayName(inviter)} (ID ${inviter.id})\n` +
            `Пригласил: ${displayName(invitee)} (ID ${invitee.id})\n` +
            `Всего приглашений: ${qualifiedLine}`;
          for (const adminId of getAdminIds()) {
            bot.api.sendMessage(adminId, adminText).catch(() => {});
          }
        }
      }
    }

    const kb = new InlineKeyboard().webApp('Открыть игру', webAppUrl);
    const welcomeText = joinedViaReferral
      ? 'Добро пожаловать в подполье. Ты пришёл по приглашению — на счету уже 900 монет для старта.\n\nЗдесь ты либо строишь свою империю, либо становишься чьим-то активом. Выбирай.'
      : 'Добро пожаловать в подполье.\n\nЗдесь ты либо строишь свою империю, либо становишься чьим-то активом. Выбирай.';
    ctx.reply(welcomeText, { reply_markup: kb });
  });

  // ---- Telegram Stars payments ----
  // Telegram asks the bot to confirm the order is still valid right before
  // charging the user. We keep this simple: if the item exists, approve it.
  bot.on('pre_checkout_query', async (ctx) => {
    console.log('[payments] pre_checkout_query received:', ctx.preCheckoutQuery.invoice_payload);
    let payload;
    try {
      payload = JSON.parse(ctx.preCheckoutQuery.invoice_payload);
    } catch {
      payload = null;
    }
    const item = payload ? getShopItem(payload.item) : null;
    try {
      if (item) {
        await ctx.answerPreCheckoutQuery(true);
        console.log('[payments] approved pre-checkout for item:', payload.item);
      } else {
        await ctx.answerPreCheckoutQuery(false, { error_message: 'Этот товар больше недоступен.' });
        console.log('[payments] rejected pre-checkout — unknown item:', payload);
      }
    } catch (e) {
      console.error('[payments] answerPreCheckoutQuery failed:', e);
    }
  });

  // This fires only after Telegram has actually confirmed the Stars payment
  // succeeded — the one place purchases are actually granted.
  bot.on('message:successful_payment', (ctx) => {
    let payload;
    try {
      payload = JSON.parse(ctx.message.successful_payment.invoice_payload);
    } catch {
      payload = null;
    }
    if (!payload) return;

    const applied = applyPurchase(ctx.from.id, payload.item);
    const item = getShopItem(payload.item);
    if (applied && item) {
      ctx.reply(`Оплата прошла! «${item.title}» уже применено — загляни в игру.`);
    }
  });

  bot.command('help', (ctx) => {
    ctx.reply('Открой игру кнопкой из /start. Всё управление — внутри мини-приложения.');
  });

  // ---- /give — personal admin command, works only for the Telegram ID(s)
  // listed in ADMIN_ID. Supports one ID or several, e.g.:
  //   ADMIN_ID=123456789
  //   ADMIN_ID=123456789,987654321
  //   ADMIN_ID=[123456789,987654321]   (brackets are fine too, just ignored)
  bot.command('give', (ctx) => {
    if (!getAdminIds().includes(ctx.from.id)) return; // silently ignore everyone else

    const args = (ctx.match || '').trim().split(/\s+/).filter(Boolean);
    if (args.length < 2) {
      return ctx.reply('Использование:\n/give @username 5000\nили\n/give 123456789 5000');
    }

    const [target, amountStr] = args;
    const amount = Number(amountStr);
    if (!Number.isFinite(amount)) {
      return ctx.reply('Сумма должна быть числом, например: /give @friend 5000');
    }

    const user = target.startsWith('@') ? getUserByUsername(target) : getUser(Number(target));
    if (!user) {
      return ctx.reply('Игрок не найден — он должен хотя бы раз открыть бота через /start.');
    }

    updateUser(user.id, { balance: user.balance + amount });
    const name = user.username ? '@' + user.username : user.first_name || user.id;
    ctx.reply(`Готово: ${name} теперь ${getUser(user.id).balance} монет (${amount >= 0 ? '+' : ''}${amount}).`);
  });

  // ---- /broadcast — admin-only, manually fires the same giveaway-reminder
  // DM blast that otherwise goes out automatically at 12:00 MSK (see
  // checkGiveawayReminderTick in server.js). Doesn't touch that daily
  // schedule or its dedup flag — this is just an on-demand extra send. ----
  bot.command('broadcast', async (ctx) => {
    if (!getAdminIds().includes(ctx.from.id)) return; // silently ignore everyone else

    const total = allUsers().length;
    await ctx.reply(`Запускаю рассылку про розыгрыш — получателей: ${total}. Разошлю с паузами, это займёт около ${Math.ceil((total * 50) / 1000)} сек.`);
    const sent = await broadcastGiveawayReminder(bot, webAppUrl);
    ctx.reply(`Готово: рассылка отправлена ${sent} игрокам (кто заблокировал бота — пропущен молча).`);
  });

  return bot;
}

module.exports = { createBot, getAdminIds, broadcastGiveawayReminder };
