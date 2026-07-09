const { Bot, InlineKeyboard } = require('grammy');
const { upsertUser, getUser, updateUser } = require('./db');
const { logEvent, randomJob } = require('./game');
const { getShopItem, applyPurchase } = require('./shop');

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
    // 1000 (instead of the usual 500 for organic joins) and starts out
    // already "in service to" the inviter — ties the invite system directly
    // into the core ownership mechanic. The inviter gets a flat +300.
    let joinedViaReferral = false;
    if (!alreadyExists && refBy) {
      const inviter = getUser(refBy);
      if (inviter) {
        joinedViaReferral = true;
        const job = randomJob();
        updateUser(refBy, { balance: inviter.balance + 300 });
        updateUser(user.id, {
          balance: 1000,
          owner_id: refBy,
          job: job.key,
          income_last_claim: Math.floor(Date.now() / 1000),
        });
        logEvent(refBy, 'acquired', { person_id: user.id, via: 'referral', job: job.key });
      }
    }

    const kb = new InlineKeyboard().webApp('Открыть игру', webAppUrl);
    const welcomeText = joinedViaReferral
      ? 'Добро пожаловать в подполье. Ты пришёл по приглашению — на счету уже 1000 монет для старта.\n\nЗдесь ты либо строишь свою империю, либо становишься чьим-то активом. Выбирай.'
      : 'Добро пожаловать в подполье.\n\nЗдесь ты либо строишь свою империю, либо становишься чьим-то активом. Выбирай.';
    ctx.reply(welcomeText, { reply_markup: kb });
  });

  // ---- Telegram Stars payments ----
  // Telegram asks the bot to confirm the order is still valid right before
  // charging the user. We keep this simple: if the item exists, approve it.
  bot.on('pre_checkout_query', async (ctx) => {
    let payload;
    try {
      payload = JSON.parse(ctx.preCheckoutQuery.invoice_payload);
    } catch {
      payload = null;
    }
    const item = payload ? getShopItem(payload.item) : null;
    if (item) {
      await ctx.answerPreCheckoutQuery(true);
    } else {
      await ctx.answerPreCheckoutQuery(false, { error_message: 'Этот товар больше недоступен.' });
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

  return bot;
}

module.exports = { createBot };
