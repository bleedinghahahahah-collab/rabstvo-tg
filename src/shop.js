const { getUser, updateUser } = require('./db');

// ---- Shop catalog: price is in Telegram Stars (XTR), no decimals allowed ----
const SHOP_ITEMS = {
  coins_2000: {
    title: 'Пакет: 2000 монет',
    description: '2000 игровых монет сразу на баланс',
    price: 20,
    kind: 'coins',
    amount: 2000,
  },
  coins_3000: {
    title: 'Пакет: 3000 монет',
    description: '3000 игровых монет сразу на баланс',
    price: 30,
    kind: 'coins',
    amount: 3000,
  },
  coins_4000: {
    title: 'Пакет: 4000 монет',
    description: '4000 игровых монет сразу на баланс',
    price: 40,
    kind: 'coins',
    amount: 4000,
  },
  coins_5000: {
    title: 'Пакет: 5000 монет',
    description: '5000 игровых монет сразу на баланс',
    price: 50,
    kind: 'coins',
    amount: 5000,
  },
  freedom: {
    title: 'Снятие из рабства',
    description: 'Мгновенно выходишь из услужения, без выкупа',
    price: 50,
    kind: 'freedom',
  },
  shield: {
    title: 'Защита от рабства (24 часа)',
    description: 'Тебя нельзя захватить или украсть в течение суток',
    price: 25,
    kind: 'shield',
    durationMs: 24 * 60 * 60 * 1000,
  },
  tap_boost: {
    title: 'Бустер тапа x2 (1 час)',
    description: 'Каждый тап на ферме даёт вдвое больше монет час',
    price: 5,
    kind: 'tap_boost',
    durationMs: 60 * 60 * 1000,
  },
};

function getShopItem(key) {
  return SHOP_ITEMS[key] || null;
}

function listShopItems() {
  return Object.entries(SHOP_ITEMS).map(([key, item]) => ({
    key,
    title: item.title,
    description: item.description,
    price: item.price,
  }));
}

// ---- Applies a purchase after Telegram confirms payment succeeded.
// This is the only place that should ever grant shop rewards — it's called
// from the bot's `successful_payment` handler, which is the authoritative
// server-side confirmation from Telegram itself. ----
function applyPurchase(userId, itemKey) {
  const item = getShopItem(itemKey);
  const user = getUser(userId);
  if (!item || !user) return false;

  const now = Date.now();

  switch (item.kind) {
    case 'coins':
      updateUser(userId, { balance: user.balance + item.amount });
      break;
    case 'freedom':
      updateUser(userId, { owner_id: null, times_ransomed: (user.times_ransomed || 0) + 1 });
      break;
    case 'shield':
      updateUser(userId, { shield_until: now + item.durationMs });
      break;
    case 'tap_boost':
      updateUser(userId, { tap_boost_until: now + item.durationMs });
      break;
    default:
      return false;
  }
  return true;
}

module.exports = { SHOP_ITEMS, getShopItem, listShopItems, applyPurchase };
