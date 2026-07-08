const { Bot, InlineKeyboard } = require('grammy');
const { upsertUser, getUser, updateUser } = require('./db');
const { logEvent } = require('./game');

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

    // First-time join via referral: give both sides a starter bonus, and the
    // invited player starts out already "in service to" the inviter — ties
    // the invite system directly into the core ownership mechanic.
    if (!alreadyExists && refBy) {
      const inviter = getUser(refBy);
      if (inviter) {
        updateUser(refBy, { balance: inviter.balance + 150 });
        updateUser(user.id, { balance: user.balance + 100, owner_id: refBy });
        logEvent(refBy, 'acquired', { person_id: user.id, via: 'referral' });
      }
    }

    const kb = new InlineKeyboard().webApp('🕯 Открыть игру', webAppUrl);
    ctx.reply(
      'Добро пожаловать в подполье.\n\nЗдесь ты либо строишь свою империю, либо становишься чьим-то активом. Выбирай.',
      { reply_markup: kb }
    );
  });

  bot.command('help', (ctx) => {
    ctx.reply('Открой игру кнопкой из /start. Всё управление — внутри мини-приложения.');
  });

  return bot;
}

module.exports = { createBot };
