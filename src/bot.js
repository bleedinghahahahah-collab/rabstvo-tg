const { Bot, InlineKeyboard } = require('grammy');
const { upsertUser, getUser, updateUser, getUserByUsername } = require('./db');
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

  // ---- /give — personal admin command, works only for your own Telegram ID ----
  // Usage: /give @username 5000   or   /give 123456789 5000
  bot.command('give', (ctx) => {
    const adminId = Number(process.env.ADMIN_ID);
    if (!adminId || ctx.from.id !== adminId) return; // silently ignore everyone else

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

  return bot;
}

module.exports = { createBot };
