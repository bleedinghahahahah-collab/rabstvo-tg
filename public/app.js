const tg = window.Telegram?.WebApp;
tg?.ready();
tg?.expand();
try {
  tg?.requestFullscreen?.();
} catch {
  /* older Telegram clients don't support true fullscreen — expand() above still applies */
}
try {
  // Without this, swiping down anywhere on the page (e.g. scrolling up
  // inside the shop or casino lists) can accidentally minimize/close the
  // whole Mini App. This restricts closing to the explicit collapse
  // button in Telegram's own chrome — no more accidental swipe-closes.
  tg?.disableVerticalSwipes?.();
} catch {
  /* older Telegram clients don't support this — safe to ignore */
}

// In fullscreen mode Telegram floats its own Close/menu controls over the
// top of our content instead of pushing it down — contentSafeAreaInset
// tells us exactly how much room to leave so our header never sits under them.
function updateSafeAreaTop() {
  const top = tg?.contentSafeAreaInset?.top ?? tg?.safeAreaInset?.top ?? 0;
  document.documentElement.style.setProperty('--tg-safe-top', `${top}px`);
}
tg?.onEvent?.('contentSafeAreaChanged', updateSafeAreaTop);
tg?.onEvent?.('safeAreaChanged', updateSafeAreaTop);
tg?.onEvent?.('fullscreenChanged', updateSafeAreaTop);
updateSafeAreaTop();
try {
  tg?.setHeaderColor?.('#0c0c0c');
  tg?.setBackgroundColor?.('#000000');
} catch {
  /* older Telegram clients may not support these — safe to ignore */
}

const initData = tg?.initData || '';

// ===== Splash screen: chain-link build-up + spark burst + fade-out =====
(function runSplash() {
  const splash = document.getElementById('splash');
  const particlesWrap = document.getElementById('splash-particles');
  if (!splash || !particlesWrap) return;

  const SPARK_COUNT = 16;
  for (let i = 0; i < SPARK_COUNT; i++) {
    const spark = document.createElement('div');
    spark.className = 'splash-spark';
    const angle = Math.random() * Math.PI * 2;
    const dist = 50 + Math.random() * 90;
    spark.style.setProperty('--sx', `${Math.cos(angle) * dist}px`);
    spark.style.setProperty('--sy', `${Math.sin(angle) * dist}px`);
    spark.style.animationDelay = `${Math.random() * 0.9}s`;
    particlesWrap.appendChild(spark);
  }

  setTimeout(() => {
    splash.classList.add('fade-out');
    setTimeout(() => splash.remove(), 650);
  }, 1900);
})();

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'x-telegram-init-data': initData,
      ...(options.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || 'Ошибка сервера');
    Object.assign(err, data); // carries through fields like cost, unlock_at, next_in_hours
    throw err;
  }
  return data;
}

function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('show', 'hide');
  // force reflow so the animation restarts even if triggered again quickly
  void el.offsetWidth;
  el.classList.add('show');

  clearTimeout(toast._t);
  clearTimeout(toast._t2);
  toast._t = setTimeout(() => {
    el.classList.remove('show');
    el.classList.add('hide');
    toast._t2 = setTimeout(() => el.classList.remove('hide'), 200);
  }, 2600);
}

function initials(name) {
  return (name || '?').trim().slice(0, 1).toUpperCase();
}

// Fills a seal element (header or row) with a Telegram avatar photo when
// available, falling back silently to initials if there's no photo or it
// fails to load. `imgEl` and `initialsEl` may be the same wrapping element
// for row seals (built via innerHTML) — see sealHtml().
function sealHtml(id, name) {
  return `${initials(name)}<img src="/api/avatar/${id}" alt="" onerror="this.style.display='none'" loading="lazy" />`;
}

function fmt(n) {
  return new Intl.NumberFormat('ru-RU').format(Math.floor(n));
}

function fmtDec(n) {
  const rounded = Math.round(n * 10) / 10;
  return new Intl.NumberFormat('ru-RU', { minimumFractionDigits: rounded % 1 === 0 ? 0 : 1 }).format(rounded);
}

// ===== Tab switching: slide / shift transition =====
// FIX: panels used to be permanently position:absolute, which removed them
// from normal document flow and collapsed the container's height to 0 —
// that's what broke layout, especially visible on desktop viewports.
// Now panels are normal flow by default, and only become position:absolute
// (via the .transitioning class) for the ~280ms the animation runs.
const TAB_ORDER = ['profile', 'market', 'people', 'farm', 'shop', 'top', 'invite'];
const TRANSITION_MS = 300;
let currentTab = 'farm';
let tabTransitionTimer = null;

const tabs = document.querySelectorAll('.tab-btn');
const panelsWrap = document.getElementById('panels');

function finishPendingTransition() {
  // if a previous transition's timer is still pending, snap it to its end
  // state immediately so a new click can never race against it
  if (!tabTransitionTimer) return;
  clearTimeout(tabTransitionTimer);
  tabTransitionTimer = null;
  document.querySelectorAll('.panel').forEach((p) => {
    if (p.dataset.panel !== currentTab) {
      p.classList.remove('active', 'transitioning', 'slide-out-left', 'slide-out-right', 'slide-in-left', 'slide-in-right');
    } else {
      p.classList.remove('transitioning', 'slide-in-left', 'slide-in-right');
    }
  });
  panelsWrap.style.minHeight = '';
}

tabs.forEach((btn) => {
  btn.addEventListener('click', () => {
    const name = btn.dataset.tab;
    if (name === currentTab) return;

    finishPendingTransition(); // cancel/snap any in-flight transition first
    if (currentTab === 'farm' && name !== 'farm') closeCasinoEntirely();

    tabs.forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');

    const oldPanel = document.querySelector(`.panel[data-panel="${currentTab}"]`);
    const newPanel = document.querySelector(`.panel[data-panel="${name}"]`);
    const dir = TAB_ORDER.indexOf(name) > TAB_ORDER.indexOf(currentTab) ? 1 : -1;

    // measure height while still normal flow, BEFORE going absolute
    panelsWrap.style.minHeight = panelsWrap.offsetHeight + 'px';

    oldPanel.classList.add('transitioning');
    newPanel.classList.add('transitioning', 'active');

    // force reflow so the just-added classes are applied before we add the
    // animation classes (otherwise the browser can skip/merge the transition)
    void oldPanel.offsetWidth;

    oldPanel.classList.add(dir === 1 ? 'slide-out-left' : 'slide-out-right');
    newPanel.classList.add(dir === 1 ? 'slide-in-right' : 'slide-in-left');

    loadPanel(name);
    currentTab = name;

    tabTransitionTimer = setTimeout(() => {
      oldPanel.classList.remove('active', 'transitioning', 'slide-out-left', 'slide-out-right');
      newPanel.classList.remove('transitioning', 'slide-in-left', 'slide-in-right');
      panelsWrap.style.minHeight = '';
      tabTransitionTimer = null;
    }, TRANSITION_MS);
  });
});

function loadPanel(name) {
  if (name === 'market') loadMarket();
  if (name === 'people') loadPeople();
  if (name === 'top') loadTop();
  if (name === 'farm') loadFarmStatus();
  if (name === 'shop') loadShop();
}

// ===== Giveaway banner: one copy lives in the main app, one in each of the
// 3 casino screens (see index.html) — all of them jump to «Позвать». =====
document.querySelectorAll('[data-giveaway-banner]').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (typeof closeCasinoEntirely === 'function') closeCasinoEntirely();
    document.querySelector('.tab-btn[data-tab="invite"]')?.click();
  });
});

// Auto-rotating banner: crossfades to the next image every 5s. The badge
// on the banner shows the carousel position ("1/2" = slide 1 of 2) — it
// has nothing to do with the giveaway invite count (that lives on the
// Invite tab's status card instead, via renderGiveawayStatus below).
const GIVEAWAY_BANNER_IMAGES = ['assets/giveaway-banner.png', 'assets/giveaway-banner.png'];
(function initGiveawayCarousel() {
  const slides = document.querySelectorAll('[data-giveaway-slide]');
  const badges = document.querySelectorAll('[data-giveaway-badge]');
  const total = GIVEAWAY_BANNER_IMAGES.length;

  const setBadge = (pictureNumber) => {
    badges.forEach((badge) => { badge.textContent = `${pictureNumber}/${total}`; });
  };
  setBadge(1);
  if (total < 2 || slides.length < 2) return;

  let activeIndex = 0;
  let nextImageIndex = 1 % total;
  setInterval(() => {
    const nextSlide = slides[(activeIndex + 1) % slides.length];
    nextSlide.src = GIVEAWAY_BANNER_IMAGES[nextImageIndex];
    slides[activeIndex].classList.remove('is-active');
    nextSlide.classList.add('is-active');
    activeIndex = (activeIndex + 1) % slides.length;
    nextImageIndex = (nextImageIndex + 1) % total;
    setBadge(nextImageIndex === 0 ? total : nextImageIndex);
  }, 5000);
})();

function pluralPeople(n) {
  if (n === 1) return 'человек';
  if (n >= 2 && n <= 4) return 'человека';
  return 'человек';
}

// Full status card on the Invite tab: red "ВЫ НЕ УЧАСТВУЕТЕ" below the
// minimum, green "ВЫ УЧАСТВУЕТЕ" once qualified, plus the player's own
// ticket numbers once they have any.
function renderGiveawayStatus(giveaway) {
  if (!giveaway) return;
  const card = document.getElementById('giveaway-status-card');
  const pill = document.getElementById('giveaway-status-pill');
  const fill = document.getElementById('giveaway-status-fill');
  const count = document.getElementById('giveaway-status-count');
  const hint = document.getElementById('giveaway-status-hint');
  const serialsEl = document.getElementById('giveaway-serials');
  if (!card) return;

  card.classList.toggle('qualified', giveaway.qualified);
  pill.textContent = giveaway.qualified ? 'ВЫ УЧАСТВУЕТЕ' : 'ВЫ НЕ УЧАСТВУЕТЕ';
  count.textContent = `${giveaway.invites} / ${giveaway.min} приглашено`;
  fill.style.width = Math.min(100, (giveaway.invites / giveaway.min) * 100) + '%';

  if (giveaway.qualified) {
    hint.textContent = 'Ты участвуешь в розыгрыше. Каждый новый приглашённый — ещё один шанс на победу.';
  } else {
    const left = giveaway.min - giveaway.invites;
    hint.textContent = `Пригласи ещё ${left} ${pluralPeople(left)}, чтобы начать участвовать.`;
  }

  if (giveaway.serials && giveaway.serials.length) {
    serialsEl.style.display = 'block';
    serialsEl.textContent = 'Твои номера в розыгрыше: ' + giveaway.serials.map((s) => '№' + s).join(', ');
  } else {
    serialsEl.style.display = 'none';
  }
}

// ===== Header (profile summary) =====
let previousOwnerStatus = undefined; // undefined = not known yet (first load)

async function loadMe() {
  const me = await api('/api/me');
  document.getElementById('online-count').textContent = fmt(me.online_count);
  document.getElementById('hdr-name').textContent = me.username ? '@' + me.username : me.first_name || 'Без имени';
  document.getElementById('hdr-rank').textContent = me.rank_title;
  document.getElementById('hdr-balance').textContent = fmtDec(me.balance);
  currentBalance = me.balance;
  const casinoBalanceEl = document.getElementById('casino-balance');
  if (casinoBalanceEl) casinoBalanceEl.textContent = fmtDec(me.balance);
  const rouletteBalanceEl = document.getElementById('roulette-balance');
  if (rouletteBalanceEl) rouletteBalanceEl.textContent = fmtDec(me.balance);
  document.getElementById('hdr-income').textContent = fmt(me.income_per_hour) + '/ч';
  document.getElementById('hdr-owned').textContent = fmt(me.owned_count);
  renderGiveawayStatus(me.giveaway);

  const statusEl = document.getElementById('profile-status');
  const statusText = document.getElementById('profile-status-text');
  statusEl.classList.toggle('enslaved', !!me.is_owned_by);
  statusText.textContent = me.is_owned_by ? `В услужении у ${me.owner_name || 'неизвестного'}` : 'Свободен';

  document.getElementById('seal-initials').textContent = initials(me.username || me.first_name);
  // Telegram gives us our OWN photo directly in initData — no round trip needed
  const ownPhoto = tg?.initDataUnsafe?.user?.photo_url;
  const avatarImg = document.getElementById('seal-avatar');
  avatarImg.src = ownPhoto || `/api/avatar/${me.id}`;
  avatarImg.onerror = () => { avatarImg.style.display = 'none'; };

  // Rank progress bar
  document.getElementById('rank-progress-current').textContent = me.rank_title;
  if (me.next_rank) {
    document.getElementById('rank-progress-next').textContent = `до «${me.next_rank.title}»: ${me.next_rank.remaining}`;
    const pct = Math.min(100, Math.max(4, (me.owned_count / me.next_rank.needed) * 100));
    document.getElementById('rank-progress-fill').style.width = pct + '%';
  } else {
    document.getElementById('rank-progress-next').textContent = 'максимальное звание';
    document.getElementById('rank-progress-fill').style.width = '100%';
  }

  // Streak dots (10 total, filled up to current streak)
  const dotsWrap = document.getElementById('streak-dots');
  dotsWrap.innerHTML = '';
  for (let i = 1; i <= 10; i++) {
    const dot = document.createElement('div');
    dot.className = 'streak-dot' + (i <= me.daily_streak ? ' filled' : '');
    dotsWrap.appendChild(dot);
  }

  // Daily bonus button: green shimmer when available, pale/disabled once collected
  const dailyBtn = document.getElementById('btn-daily');
  dailyBtn.classList.toggle('available', me.daily_available);
  dailyBtn.classList.toggle('collected', !me.daily_available);
  dailyBtn.disabled = !me.daily_available;
  document.getElementById('daily-sub').textContent = me.daily_available ? 'доступно' : 'уже забрано';

  const dailyTimerHint = document.getElementById('daily-timer-hint');
  if (!me.daily_available) {
    const refreshDate = new Date(me.daily_available_at);
    const timeStr = refreshDate.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    const isToday = refreshDate.toDateString() === new Date().toDateString();
    dailyTimerHint.textContent = isToday
      ? `Обновится сегодня в ${timeStr}`
      : `Обновится завтра в ${timeStr}`;
    dailyTimerHint.style.display = 'block';
  } else {
    dailyTimerHint.style.display = 'none';
  }

  // Your position in both leaderboards
  document.getElementById('my-rank-balance').textContent = '#' + me.rank_by_balance;
  document.getElementById('my-rank-owned').textContent = '#' + me.rank_by_owned;

  // Active shop effects: shield / tap boost
  const badgesWrap = document.getElementById('status-badges');
  badgesWrap.innerHTML = '';
  if (me.shield_active) {
    badgesWrap.innerHTML += `
      <div class="status-badge">
        <span class="badge-title">Защита от рабства активна</span>
        <span class="badge-time">до ${new Date(me.shield_until).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</span>
      </div>`;
  }
  if (me.tap_boost_active) {
    badgesWrap.innerHTML += `
      <div class="status-badge">
        <span class="badge-title">Бустер тапа x2 активен</span>
        <span class="badge-time">до ${new Date(me.tap_boost_until).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</span>
      </div>`;
  }

  // Ransom section: only exists on screen at all while actually enslaved
  document.getElementById('ransom-section').style.display = me.is_owned_by ? 'block' : 'none';
  if (me.is_owned_by) {
    document.getElementById('ransom-cost').textContent = fmtDec(me.ransom_cost);
  }

  // Detect the free -> owned transition and show a big in-app alert.
  // (previousOwnerStatus stays `undefined` on the very first load so we
  // never fire this just because the app opened while already enslaved.)
  if (previousOwnerStatus === false && me.is_owned_by) {
    showBigAlert();
  }
  previousOwnerStatus = !!me.is_owned_by;

  return me;
}

function showBigAlert() {
  const overlay = document.getElementById('big-alert');
  overlay.classList.add('show');
  tg?.HapticFeedback?.notificationOccurred?.('warning');
}

document.getElementById('big-alert-close').addEventListener('click', () => {
  document.getElementById('big-alert').classList.remove('show');
});

// Poll periodically so status (enslaved/freed/income) stays fresh even if
// the mini app is just left open in the background — the mechanism behind
// the "ВАС ВЗЯЛИ В РАБСТВО!!!" alert above. The online count and leaderboard
// are handled separately below via a live push connection instead.
setInterval(() => {
  loadMe().catch(() => {});
}, 10000);

// ===== Real-time online count + leaderboard (Server-Sent Events) =====
// EventSource can't send custom headers, so initData rides along as a query
// param for this one connection — it's Telegram's own signed payload, the
// server verifies it exactly the same way as every other request.
if (initData && typeof EventSource !== 'undefined') {
  const liveSource = new EventSource(`/api/live?initData=${encodeURIComponent(initData)}`);
  liveSource.onmessage = (ev) => {
    let payload;
    try {
      payload = JSON.parse(ev.data);
    } catch {
      return;
    }
    const onlineEl = document.getElementById('online-count');
    if (onlineEl && typeof payload.online === 'number') onlineEl.textContent = fmt(payload.online);

    if (currentTab === 'top') {
      const rows = topMode === 'owned' ? payload.leaderboard_owned : payload.leaderboard_balance;
      if (rows) renderLeaderboard(rows);
    }
  };
  // EventSource reconnects automatically on drop — nothing else to do here
}

// ===== Profile tab actions =====
document.getElementById('btn-daily').addEventListener('click', async () => {
  try {
    const r = await api('/api/daily', { method: 'POST' });
    toast(`+${r.bonus} монет · серия дней: ${r.streak}`);
    loadMe();
  } catch (e) {
    toast(e.message);
  }
});

document.getElementById('btn-ransom').addEventListener('click', async () => {
  try {
    await api('/api/ransom', { method: 'POST' });
    toast('Ты выкупил свою свободу!');
    loadMe();
  } catch (e) {
    toast(e.message);
  }
});

// ===== Market tab: "Свободные" (free agents) / "Украсть" (steal from others) =====
let marketMode = 'free';
let marketSort = 'asc';
let marketSearch = '';
let marketOffset = 0;
let marketTotal = 0;
const MARKET_PAGE_SIZE = 20;
let marketSearchDebounce = null;

document.querySelectorAll('#market-segmented .segmented-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (btn.dataset.mode === marketMode) return;
    document.querySelectorAll('#market-segmented .segmented-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    marketMode = btn.dataset.mode;
    document.getElementById('market-eyebrow').textContent =
      marketMode === 'free' ? 'Свободные люди' : 'Люди с хозяином';
    loadMarket(true);
  });
});

document.querySelectorAll('#market-sort-segmented .segmented-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (btn.dataset.sort === marketSort) return;
    document.querySelectorAll('#market-sort-segmented .segmented-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    marketSort = btn.dataset.sort;
    loadMarket(true);
  });
});

document.getElementById('market-search').addEventListener('input', (ev) => {
  clearTimeout(marketSearchDebounce);
  const value = ev.target.value;
  marketSearchDebounce = setTimeout(() => {
    marketSearch = value.trim();
    loadMarket(true);
  }, 350);
});

document.getElementById('market-load-more').addEventListener('click', async (ev) => {
  const btn = ev.currentTarget;
  btn.disabled = true;
  try {
    await loadMarket(false);
  } finally {
    btn.disabled = false;
  }
});

function updateMarketPager() {
  const countEl = document.getElementById('market-count');
  const loadMoreBtn = document.getElementById('market-load-more');
  const sub = document.getElementById('market-load-more-sub');
  countEl.textContent = marketTotal ? `Показано ${Math.min(marketOffset, marketTotal)} из ${marketTotal}` : '';
  const remaining = marketTotal - marketOffset;
  if (remaining > 0) {
    loadMoreBtn.style.display = 'flex';
    sub.textContent = `ещё ${remaining}`;
  } else {
    loadMoreBtn.style.display = 'none';
  }
}

function marketQuery() {
  const params = new URLSearchParams({ sort: marketSort, offset: String(marketOffset), limit: String(MARKET_PAGE_SIZE) });
  if (marketSearch) params.set('search', marketSearch);
  return params.toString();
}

// reset=true: clear the list and start over from offset 0 (new search/sort/
// mode, or opening the tab). reset=false: append the next page ("Показать ещё").
async function loadMarket(reset = true) {
  if (marketMode === 'free') return loadFreeMarket(reset);
  return loadStealMarket(reset);
}

function appendFreeMarketRow(list, p) {
  const name = p.username ? '@' + p.username : p.first_name || 'Без имени';
  const row = document.createElement('div');
  row.className = 'ledger-row';
  row.style.flexWrap = 'wrap';
  row.innerHTML = `
    <div class="row-seal">${sealHtml(p.id, p.username || p.first_name)}</div>
    <div class="row-name">${name}</div>
    <div class="row-leader"></div>
    <div class="row-value">${fmt(p.cost)}</div>
    <div class="row-actions">
      <button class="mini-btn" data-id="${p.id}">Захватить</button>
    </div>
  `;
  row.querySelector('.mini-btn').addEventListener('click', async (ev) => {
    ev.target.disabled = true;
    try {
      await api('/api/acquire', { method: 'POST', body: JSON.stringify({ targetId: p.id }) });
      toast('Успешно!');
      loadMarket(true);
      loadMe();
    } catch (e) {
      toast(e.message + (e.cost ? ` (нужно ${e.cost})` : ''));
      ev.target.disabled = false;
    }
  });
  list.appendChild(row);
}

async function loadFreeMarket(reset) {
  const list = document.getElementById('market-list');
  if (reset) {
    marketOffset = 0;
    list.innerHTML = '<div class="empty-state">Ищем кандидатов…</div>';
  }
  const data = await api(`/api/market?${marketQuery()}`);
  marketTotal = data.total;
  if (reset) {
    list.innerHTML = '';
    if (!data.rows.length) {
      list.innerHTML = '<div class="empty-state">Никого не нашлось — попробуй другой поиск или загляни позже.</div>';
    }
  }
  data.rows.forEach((p) => appendFreeMarketRow(list, p));
  marketOffset += data.rows.length;
  updateMarketPager();
}

function appendStealMarketRow(list, p) {
  const name = p.username ? '@' + p.username : p.first_name || 'Без имени';
  const row = document.createElement('div');
  row.className = 'ledger-row';
  row.style.flexWrap = 'wrap';
  row.innerHTML = `
    <div class="row-seal">${sealHtml(p.id, p.username || p.first_name)}</div>
    <div style="min-width:0;flex:1;">
      <div class="row-name">${name}</div>
      <div class="row-meta">у ${p.owner_name}</div>
    </div>
    <div class="row-value">${fmt(p.cost)}</div>
    <div class="row-actions">
      <button class="mini-btn danger" data-id="${p.id}">Украсть</button>
    </div>
  `;
  row.querySelector('.mini-btn').addEventListener('click', async (ev) => {
    ev.target.disabled = true;
    try {
      await api('/api/steal', { method: 'POST', body: JSON.stringify({ targetId: p.id }) });
      toast('Успешно!');
      loadMarket(true);
      loadMe();
    } catch (e) {
      toast(e.message + (e.cost ? ` (нужно ${e.cost})` : ''));
      ev.target.disabled = false;
    }
  });
  list.appendChild(row);
}

async function loadStealMarket(reset) {
  const list = document.getElementById('market-list');
  if (reset) {
    marketOffset = 0;
    list.innerHTML = '<div class="empty-state">Ищем чужих людей…</div>';
  }
  const data = await api(`/api/market/stealable?${marketQuery()}`);
  marketTotal = data.total;
  if (reset) {
    list.innerHTML = '';
    if (!data.rows.length) {
      list.innerHTML = '<div class="empty-state">Пока красть не у кого — попробуй другой поиск или загляни позже.</div>';
    }
  }
  data.rows.forEach((p) => appendStealMarketRow(list, p));
  marketOffset += data.rows.length;
  updateMarketPager();
}

// Puts a "Плеть" button into either its ready state or a live countdown
// while its 5-minute per-person cooldown is running.
function applyWhipButtonState(btn, availableAt) {
  clearInterval(btn._whipTimer);
  const tick = () => {
    const msLeft = availableAt - Date.now();
    if (!availableAt || msLeft <= 0) {
      clearInterval(btn._whipTimer);
      btn.disabled = false;
      btn.textContent = 'Плеть';
      return;
    }
    btn.disabled = true;
    const totalSec = Math.ceil(msLeft / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    btn.textContent = `${m}:${String(s).padStart(2, '0')}`;
  };
  tick();
  btn._whipTimer = setInterval(tick, 1000);
}

// ===== My people tab =====
async function loadPeople(silent = false) {
  const list = document.getElementById('people-list');
  // The "Загрузка…" placeholder briefly collapses the list's height while the
  // request is in flight, which is what caused the page to scroll back to
  // the top after tapping a button near the bottom. Skipping it on refresh
  // (silent=true) keeps the existing rows in place until the new ones are
  // ready, so the scroll position never jumps.
  // stop any running whip-cooldown countdown timers before the rows they
  // belong to get thrown away, so they don't keep ticking on detached nodes
  list.querySelectorAll('[data-action="whip"]').forEach((btn) => clearInterval(btn._whipTimer));

  if (!silent) list.innerHTML = '<div class="empty-state">Загрузка…</div>';
  const rows = await api('/api/my-people');
  if (!rows.length) {
    list.innerHTML = '<div class="empty-state">Пока никого нет — попробуй «Рынок».</div>';
    document.getElementById('collect-all-sub').textContent = '';
    return;
  }
  list.innerHTML = '';
  rows.forEach((p) => {
    const name = p.username ? '@' + p.username : p.first_name || 'Без имени';
    const row = document.createElement('div');
    row.className = 'ledger-row';
    row.style.flexWrap = 'wrap';
    row.innerHTML = `
      <div class="row-seal">${sealHtml(p.id, p.username || p.first_name)}</div>
      <div style="min-width:0;flex:1;">
        <div class="row-name">${name}</div>
        <div class="row-meta">${p.job_name} · ${fmt(p.job_income)}/ч${p.acquired_price ? ` · куплен за ${fmt(p.acquired_price)}` : ''}</div>
      </div>
      <div class="row-value">+${fmtDec(p.pending_income)}</div>
      <div class="row-actions">
        <button class="mini-btn collect" data-action="collect" data-id="${p.id}">Забрать доход</button>
        <button class="mini-btn whip" data-action="whip" data-id="${p.id}">Плеть</button>
        <button class="mini-btn danger" data-action="free" data-id="${p.id}">Отпустить</button>
      </div>
    `;
    row.querySelector('[data-action="collect"]').addEventListener('click', async (ev) => {
      ev.target.disabled = true;
      try {
        const r = await api(`/api/collect/${p.id}`, { method: 'POST' });
        ev.target.classList.add('just-collected');
        toast(`Собрано: +${fmtDec(r.gained)}`);
        loadPeople(true);
        loadMe();
      } catch (e) {
        toast(e.message);
      } finally {
        ev.target.disabled = false;
      }
    });
    const whipBtn = row.querySelector('[data-action="whip"]');
    applyWhipButtonState(whipBtn, p.whip_available_at);
    whipBtn.addEventListener('click', async (ev) => {
      ev.target.disabled = true;
      try {
        const r = await api(`/api/whip/${p.id}`, { method: 'POST' });
        toast('Отхлестал плетью!');
        applyWhipButtonState(whipBtn, r.unlock_at);
      } catch (e) {
        toast(e.message);
        applyWhipButtonState(whipBtn, e.unlock_at || 0);
      }
    });
    row.querySelector('[data-action="free"]').addEventListener('click', async (ev) => {
      ev.target.disabled = true;
      try {
        await api(`/api/free/${p.id}`, { method: 'POST' });
        toast('Отпущен на свободу');
        loadPeople(true);
        loadMe();
      } catch (e) {
        toast(e.message);
        ev.target.disabled = false;
      }
    });
    list.appendChild(row);
  });

  const totalPending = rows.reduce((sum, p) => sum + p.pending_income, 0);
  document.getElementById('collect-all-sub').textContent = totalPending > 0 ? `+${fmtDec(totalPending)} суммарно` : 'нечего собирать';
}

document.getElementById('btn-collect-all').addEventListener('click', async (ev) => {
  ev.target.disabled = true;
  try {
    const r = await api('/api/collect-all', { method: 'POST' });
    if (r.gained > 0) {
      toast(`Собрано со всех: +${fmtDec(r.gained)}`);
    } else {
      toast('Пока нечего собирать');
    }
    loadPeople(true);
    loadMe();
  } catch (e) {
    toast(e.message);
  } finally {
    ev.target.disabled = false;
  }
});

// ===== Leaderboard tab =====
let topMode = 'balance';

document.querySelectorAll('#top-segmented .segmented-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (btn.dataset.mode === topMode) return;
    document.querySelectorAll('#top-segmented .segmented-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    topMode = btn.dataset.mode;
    loadTop();
  });
});

function renderLeaderboard(rows) {
  const list = document.getElementById('top-list');
  list.innerHTML = '';
  rows.forEach((p) => {
    const name = p.username ? '@' + p.username : p.first_name || 'Без имени';
    const row = document.createElement('div');
    row.className = 'ledger-row';
    const valueHtml = topMode === 'owned' ? `${fmt(p.owned_count)} чел.` : `${fmt(p.balance)}`;
    row.innerHTML = `
      <div class="rank-badge">#${p.rank}</div>
      <div class="row-seal">${sealHtml(p.id, p.username || p.first_name)}</div>
      <div>
        <div class="row-name">${name}</div>
        <div class="row-meta">${p.rank_title} · ${p.owned_count} чел. в подчинении</div>
      </div>
      <div class="row-leader"></div>
      <div class="row-value">${valueHtml}</div>
    `;
    list.appendChild(row);
  });
}

async function loadTop(silent = false) {
  const list = document.getElementById('top-list');
  if (!silent) list.innerHTML = '<div class="empty-state">Считаем состояния…</div>';
  const rows = await api(`/api/leaderboard?by=${topMode}`);
  renderLeaderboard(rows);
}

// ===== Farm tab =====
const FARM_MIN_INTERVAL_MS = 60; // matches server-side limit
let farmLastClientTap = 0;
let farmLocked = false;
let currentTapValue = 1; // reflects base tap value including any permanent upgrades
let farmCountdownTimer = null;

async function loadFarmStatus() {
  try {
    const status = await api('/api/farm/status');
    applyFarmStatus(status);
    if (typeof status.tap_value === 'number') {
      currentTapValue = status.tap_value;
      document.getElementById('farm-description').textContent =
        `Каждый тап — ${fmtDec(currentTapValue)} монет${currentTapValue === 1 ? 'а' : ''}. После 5000 тапов — перерыв на 3 часа.`;
    }
  } catch (e) {
    toast(e.message);
  }
}

function applyFarmStatus(status) {
  const counterEl = document.getElementById('farm-counter');
  const btn = document.getElementById('farm-btn');
  const lockHint = document.getElementById('farm-lock-hint');

  counterEl.textContent = `${status.taps_used} / ${status.taps_limit}`;
  farmLocked = !!status.locked;

  clearInterval(farmCountdownTimer);

  if (farmLocked) {
    btn.classList.add('locked');
    btn.disabled = true;
    updateFarmLockCountdown(status.unlock_at);
    farmCountdownTimer = setInterval(() => updateFarmLockCountdown(status.unlock_at), 1000);
    lockHint.style.display = 'block';
  } else {
    btn.classList.remove('locked');
    btn.disabled = false;
    lockHint.style.display = 'none';
  }
}

function updateFarmLockCountdown(unlockAt) {
  const lockHint = document.getElementById('farm-lock-hint');
  const msLeft = unlockAt - Date.now();
  if (msLeft <= 0) {
    clearInterval(farmCountdownTimer);
    loadFarmStatus();
    return;
  }
  const totalSec = Math.ceil(msLeft / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n) => String(n).padStart(2, '0');
  lockHint.textContent = `Лимит тапов исчерпан. Обновится через ${pad(h)}:${pad(m)}:${pad(s)}. Придёт уведомление от бота.`;
}

function spawnFarmParticle(btn, text = '+1') {
  const particle = document.createElement('div');
  particle.className = 'farm-particle';
  particle.textContent = text;
  const angle = Math.random() * Math.PI * 2;
  const distance = 60 + Math.random() * 40;
  particle.style.setProperty('--fx', `${Math.cos(angle) * distance}px`);
  particle.style.setProperty('--fy', `${Math.sin(angle) * distance}px`);
  btn.parentElement.appendChild(particle);
  setTimeout(() => particle.remove(), 750);
}

function bumpCounter() {
  const counterEl = document.getElementById('farm-counter');
  counterEl.classList.remove('bump');
  void counterEl.offsetWidth;
  counterEl.classList.add('bump');
}

function attemptFarmTap(btn) {
  if (farmLocked) return;

  const now = Date.now();
  if (now - farmLastClientTap < FARM_MIN_INTERVAL_MS) return; // throttle, mirrors server limit
  farmLastClientTap = now;

  spawnFarmParticle(btn, `+${fmtDec(currentTapValue)}`);
  bumpCounter();
  tg?.HapticFeedback?.impactOccurred?.('light');

  api('/api/farm/tap', { method: 'POST' })
    .then((r) => {
      document.getElementById('farm-counter').textContent = `${r.taps_used} / 5000`;
      document.getElementById('hdr-balance').textContent = fmtDec(r.balance);
      if (r.reward) currentTapValue = r.boosted ? r.reward / 2 : r.reward; // keep the tracked base value in sync
      if (r.boosted) spawnFarmParticle(btn, 'x2');
      if (r.locked) applyFarmStatus({ locked: true, taps_used: r.taps_used, taps_limit: 5000, unlock_at: r.unlock_at });
    })
    .catch((e) => {
      if (e.unlock_at) applyFarmStatus({ locked: true, taps_used: 5000, taps_limit: 5000, unlock_at: e.unlock_at });
      // "too fast" errors are silently ignored — the tap just doesn't register
    });
}

const farmBtnEl = document.getElementById('farm-btn');

// touchstart fires per finger and has no built-in delay, so several fingers
// tapping in quick alternation register independently — much faster than
// waiting on synthetic mouse "click" events one at a time.
farmBtnEl.addEventListener(
  'touchstart',
  (ev) => {
    ev.preventDefault(); // stop the follow-up synthetic click so taps aren't double-counted
    for (let i = 0; i < ev.changedTouches.length; i++) attemptFarmTap(farmBtnEl);
  },
  { passive: false }
);

// keep click as a fallback for desktop/mouse testing (browsers without touch)
farmBtnEl.addEventListener('click', () => attemptFarmTap(farmBtnEl));

// ===== Shop tab: buy with Telegram Stars =====
function renderShopRow(item, listEl) {
  const row = document.createElement('div');
  row.className = 'ledger-row';
  row.style.flexWrap = 'wrap';
  row.innerHTML = `
    <div style="min-width:0;flex:1;">
      <div class="row-name">${item.title}</div>
      <div class="row-meta">${item.description}</div>
    </div>
    <div class="row-value">${item.price} звёзд</div>
    <div class="row-actions">
      <button class="mini-btn buy" data-key="${item.key}">Купить</button>
    </div>
  `;
  row.querySelector('.mini-btn').addEventListener('click', async (ev) => {
    ev.target.disabled = true;
    try {
      const { link } = await api('/api/shop/invoice', {
        method: 'POST',
        body: JSON.stringify({ item: item.key }),
      });
      if (!tg?.openInvoice) {
        toast('Открой это в Telegram, чтобы оплатить звёздами');
        ev.target.disabled = false;
        return;
      }
      tg.openInvoice(link, (status) => {
        ev.target.disabled = false;
        if (status === 'paid') {
          toast('Оплачено! Обновляю...');
          setTimeout(() => {
            loadMe();
          }, 1200); // small delay so the bot's successful_payment handler has time to apply it
        } else if (status === 'cancelled') {
          toast('Оплата отменена');
        } else if (status === 'failed') {
          toast('Платёж не прошёл');
        }
      });
    } catch (e) {
      toast(e.message);
      ev.target.disabled = false;
    }
  });
  listEl.appendChild(row);
}

let shopItemsCache = null;

function loadShop() {
  // always land back on the menu when opening the Shop tab
  document.getElementById('shop-menu').style.display = 'flex';
  document.getElementById('shop-detail').style.display = 'none';
  document.querySelectorAll('#shop-detail .shop-bar').forEach((bar) => (bar.style.display = 'none'));
}

function closeShopCategory() {
  document.getElementById('shop-menu').style.display = 'flex';
  document.getElementById('shop-detail').style.display = 'none';
}

document.querySelectorAll('.shop-menu-btn').forEach((btn) => {
  btn.addEventListener('click', () => openShopCategory(btn.dataset.cat));
});

document.getElementById('btn-shop-back').addEventListener('click', closeShopCategory);

async function openShopCategory(cat) {
  document.getElementById('shop-menu').style.display = 'none';
  document.getElementById('shop-detail').style.display = 'block';
  document.querySelectorAll('#shop-detail .shop-bar').forEach((bar) => (bar.style.display = 'none'));
  document.getElementById(`shop-bar-${cat}`).style.display = 'block';

  if (cat === 'farm') {
    await loadTapUpgradeStatus();
    return;
  }
  if (cat === 'protect') {
    await loadCoinShieldStatus();
    return;
  }

  const listEl = document.getElementById(`shop-list-${cat}`);
  listEl.innerHTML = '<div class="empty-state">Загрузка…</div>';

  if (!shopItemsCache) shopItemsCache = await api('/api/shop/items');
  listEl.innerHTML = '';
  shopItemsCache
    .filter((item) => (item.category || 'coins') === cat)
    .forEach((item) => renderShopRow(item, listEl));
}

async function loadTapUpgradeStatus() {
  const status = await api('/api/farm/status');
  currentTapValue = status.tap_value;
  document.getElementById('tap-upgrade-meta').textContent =
    `Уровень ${status.tap_upgrade_level} · сейчас +${fmtDec(status.tap_value)} за тап`;
  document.getElementById('tap-upgrade-cost').textContent = fmt(status.tap_upgrade_cost);
}

document.getElementById('btn-upgrade-tap').addEventListener('click', async (ev) => {
  ev.target.disabled = true;
  try {
    const r = await api('/api/farm/upgrade-tap', { method: 'POST' });
    toast(`Улучшено! Теперь +${fmtDec(r.tap_value)} за тап`);
    document.getElementById('hdr-balance').textContent = fmtDec(r.balance);
    await loadTapUpgradeStatus();
  } catch (e) {
    toast(e.message + (e.cost ? ` (нужно ${e.cost})` : ''));
  } finally {
    ev.target.disabled = false;
  }
});

async function loadCoinShieldStatus() {
  const status = await api('/api/shield/coin-status');
  const btn = document.getElementById('btn-buy-coin-shield');
  const meta = document.getElementById('coin-shield-meta');
  if (status.active) {
    const until = new Date(status.shield_until).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    meta.textContent = `Уже активна — до ${until}`;
    btn.disabled = true;
  } else {
    meta.textContent = 'Тебя нельзя захватить или украсть в течение часа';
    btn.disabled = false;
  }
}

document.getElementById('btn-buy-coin-shield').addEventListener('click', async (ev) => {
  ev.target.disabled = true;
  try {
    const r = await api('/api/shield/coin-buy', { method: 'POST' });
    toast('Защита активирована на 1 час!');
    document.getElementById('hdr-balance').textContent = fmtDec(r.balance);
    await loadCoinShieldStatus();
  } catch (e) {
    toast(e.message + (e.cost ? ` (нужно ${e.cost})` : ''));
    ev.target.disabled = false;
  }
});

document.getElementById('btn-copy-link').addEventListener('click', async () => {
  try {
    const { link } = await api('/api/invite-link');
    const box = document.getElementById('invite-link-box');
    box.textContent = link;
    box.style.display = 'block';
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(link);
      toast('Ссылка скопирована');
    }
    tg?.HapticFeedback?.notificationOccurred?.('success');
  } catch (e) {
    toast(e.message);
  }
});

// ===== Casino: hub (menu) + shared "crash" round + shared "roulette" round =====
let casinoScreen = 'closed'; // 'closed' | 'menu' | 'crash' | 'roulette'
let casinoSource = null;
let casinoPhase = 'waiting';
let casinoRunningAt = null; // server timestamp the round started climbing, used to interpolate locally
let casinoGrowthPerMs = 0.00006; // fallback; overwritten from the server's own value on first tick
let casinoAnimHandle = null;

// Same growth formula as the server (casino.js) — kept in sync via
// growth_per_ms on every state update, so this is never a guess.
function crashMultiplierAt(elapsedMs) {
  if (elapsedMs <= 0) return 1.0;
  return Math.floor(Math.pow(Math.E, casinoGrowthPerMs * elapsedMs) * 100) / 100;
}

// The crash stage "heats up" visually as the multiplier climbs — gold below
// 2x, warm amber from 2x, glowing hot pink from 5x — so the growing stakes
// actually feel like something, instead of a number quietly ticking up.
function updateCrashStageHeat(mult) {
  const stage = document.getElementById('crash-stage');
  if (!stage) return;
  stage.classList.toggle('mult-warm', mult >= 2 && mult < 5);
  stage.classList.toggle('mult-hot', mult >= 5);
}

// Runs every animation frame while the round is climbing, so the number
// grows smoothly at 60fps instead of jumping once per SSE tick (~250ms).
function stepCasinoMultiplier() {
  if (casinoPhase !== 'running' || casinoRunningAt == null) {
    casinoAnimHandle = null;
    return;
  }
  const mult = crashMultiplierAt(Date.now() - casinoRunningAt);
  const el = document.getElementById('crash-multiplier');
  if (el) el.textContent = `${mult.toFixed(2)}x`;
  updateCrashStageHeat(mult);
  casinoAnimHandle = requestAnimationFrame(stepCasinoMultiplier);
}
function startCasinoMultiplierLoop() {
  if (casinoAnimHandle == null) casinoAnimHandle = requestAnimationFrame(stepCasinoMultiplier);
}
function stopCasinoMultiplierLoop() {
  if (casinoAnimHandle != null) cancelAnimationFrame(casinoAnimHandle);
  casinoAnimHandle = null;
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && casinoPhase === 'running') startCasinoMultiplierLoop();
});
let chainLinksBuilt = false;
let lastToastRoundId = null;
let lastAutoCashoutRoundId = null;
let currentBalance = 0; // kept in sync from loadMe() / bet / cashout responses, used by "Ва-банк" buttons

let rouletteSource = null;
let rouletteWheelBuilt = false;
let lastRouletteToastRoundId = null;
let casinoPollTimer = null;
let roulettePollTimer = null;

// Draws the crash chain once: a row of alternating link shapes, split into
// a left half and a right half so they can fly apart independently on crash.
function buildChainLinks() {
  if (chainLinksBuilt) return;
  chainLinksBuilt = true;
  const leftGroup = document.getElementById('crash-chain-left');
  const rightGroup = document.getElementById('crash-chain-right');
  const totalLinks = 9;
  const spacing = 28;
  const startX = 160 - ((totalLinks - 1) * spacing) / 2;
  for (let i = 0; i < totalLinks; i++) {
    const x = startX + i * spacing;
    const vertical = i % 2 === 1;
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('class', 'chain-link');
    rect.setAttribute('x', '-14');
    rect.setAttribute('y', '-9');
    rect.setAttribute('width', '28');
    rect.setAttribute('height', '18');
    rect.setAttribute('rx', '9');
    rect.setAttribute('transform', `translate(${x},60) rotate(${vertical ? 90 : 0})`);
    (i < 5 ? leftGroup : rightGroup).appendChild(rect);
  }
}

// Draws the roulette wheel once: 21 wedges (1 green + 10 red + 10 black),
// matching the same colour order the server uses for pockets 0..20.
function buildRouletteWheel() {
  if (rouletteWheelBuilt) return;
  rouletteWheelBuilt = true;
  const group = document.getElementById('roulette-wheel-group');
  if (!group) return;
  const segments = 21;
  const cx = 100;
  const cy = 100;
  const r = 88;
  // Black pockets used to be near-invisible #141414 against the dark
  // background — a deep violet-charcoal keeps them dark but visibly part
  // of the wheel rather than vanishing into the void behind it.
  const colorFor = (n) => (n === 0 ? 'var(--green)' : n % 2 === 1 ? 'var(--red)' : 'oklch(24% 0.03 300)');

  // Gold cabinet rim, like a real wheel's outer ring.
  const rim = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  rim.setAttribute('cx', cx);
  rim.setAttribute('cy', cy);
  rim.setAttribute('r', r + 6);
  rim.setAttribute('fill', 'none');
  rim.setAttribute('stroke', 'var(--gold)');
  rim.setAttribute('stroke-width', '3');
  rim.setAttribute('class', 'roulette-rim');
  group.appendChild(rim);

  for (let i = 0; i < segments; i++) {
    const startAngle = (i / segments) * 2 * Math.PI - Math.PI / 2;
    const endAngle = ((i + 1) / segments) * 2 * Math.PI - Math.PI / 2;
    const x1 = (cx + r * Math.cos(startAngle)).toFixed(2);
    const y1 = (cy + r * Math.sin(startAngle)).toFixed(2);
    const x2 = (cx + r * Math.cos(endAngle)).toFixed(2);
    const y2 = (cy + r * Math.sin(endAngle)).toFixed(2);
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', `M${cx},${cy} L${x1},${y1} A${r},${r} 0 0,1 ${x2},${y2} Z`);
    path.style.fill = colorFor(i);
    path.setAttribute('stroke', 'var(--gold)');
    path.setAttribute('stroke-width', '0.6');
    path.setAttribute('stroke-opacity', '0.5');
    group.appendChild(path);

    // A small "bulb" light at each pocket boundary, like the light string
    // around a real casino wheel's cabinet — blinks in a chasing pattern.
    const bx = (cx + (r + 6) * Math.cos(startAngle)).toFixed(2);
    const by = (cy + (r + 6) * Math.sin(startAngle)).toFixed(2);
    const bulb = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    bulb.setAttribute('cx', bx);
    bulb.setAttribute('cy', by);
    bulb.setAttribute('r', '2.2');
    bulb.setAttribute('fill', 'var(--gold)');
    bulb.setAttribute('class', 'roulette-bulb');
    bulb.style.animationDelay = `${(i % 4) * 0.18}s`;
    group.appendChild(bulb);
  }
  const hub = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  hub.setAttribute('cx', cx);
  hub.setAttribute('cy', cy);
  hub.setAttribute('r', '24');
  hub.setAttribute('fill', '#111');
  hub.setAttribute('stroke', 'var(--gold)');
  hub.setAttribute('stroke-width', '2');
  group.appendChild(hub);
}

// Drifting poker chips, purely decorative — built once per container, then
// just loop forever via CSS (no per-frame JS needed). Shared by the menu
// hub and both game screens.
function buildChipsBg(containerId) {
  const wrap = document.getElementById(containerId);
  if (!wrap || wrap.dataset.built) return;
  wrap.dataset.built = '1';
  const colors = ['var(--gold)', 'var(--violet)', 'var(--green)', 'var(--red)', 'var(--neon-pink)', 'var(--neon-cyan)'];
  const count = 16;
  for (let i = 0; i < count; i++) {
    const chip = document.createElement('div');
    chip.className = 'casino-chip';
    const size = 16 + Math.random() * 26;
    chip.style.left = `${Math.random() * 100}%`;
    chip.style.width = `${size}px`;
    chip.style.height = `${size}px`;
    chip.style.setProperty('--chip-color', colors[i % colors.length]);
    chip.style.animationDuration = `${10 + Math.random() * 9}s`;
    chip.style.animationDelay = `-${Math.random() * 18}s`;
    chip.style.opacity = (0.18 + Math.random() * 0.24).toFixed(2);
    wrap.appendChild(chip);
  }
}

// Small twinkling dots scattered across the casino background — cheap
// "lit up at night" texture, built once per container like the chips above.
function buildSparkles(containerId) {
  const wrap = document.getElementById(containerId);
  if (!wrap || wrap.dataset.built) return;
  wrap.dataset.built = '1';
  const colors = ['var(--gold)', 'var(--neon-pink)', 'var(--neon-cyan)', 'var(--violet)'];
  const count = 22;
  for (let i = 0; i < count; i++) {
    const dot = document.createElement('div');
    dot.className = 'casino-sparkle';
    dot.style.left = `${Math.random() * 100}%`;
    dot.style.top = `${Math.random() * 100}%`;
    dot.style.setProperty('--sparkle-color', colors[i % colors.length]);
    dot.style.setProperty('--sparkle-dur', `${1.6 + Math.random() * 2.2}s`);
    dot.style.animationDelay = `-${Math.random() * 3}s`;
    wrap.appendChild(dot);
  }
}

// ---- Navigation: Farm → menu → (crash | roulette), entirely through our
// own in-screen "← Назад" buttons — Telegram's native BackButton is not
// used anywhere in this app anymore (it was rendering on top of our own
// buttons at the top of the screen). ----
function showCasinoMenu() {
  casinoScreen = 'menu';
  buildChipsBg('casino-menu-chips-bg');
  buildSparkles('casino-menu-sparkles');
  document.getElementById('casino-menu-view').classList.add('show');
}
function hideCasinoMenu() {
  document.getElementById('casino-menu-view').classList.remove('show');
}
function openCasinoHub() {
  hideCasinoMenu();
  showCasinoMenu();
}
function closeCasinoEntirely() {
  hideCasinoMenu();
  closeCrash();
  closeRoulette();
  casinoScreen = 'closed';
}

// ===== Crash =====
function connectCasinoSSE() {
  if (casinoSource || !initData || typeof EventSource === 'undefined') return;
  casinoSource = new EventSource(`/api/casino/live?initData=${encodeURIComponent(initData)}`);
  casinoSource.onmessage = (ev) => {
    try {
      renderCasinoState(JSON.parse(ev.data));
    } catch {
      /* ignore malformed tick */
    }
  };
  casinoSource.onerror = () => {
    // The browser retries automatically on a transient drop, but if it gave
    // up entirely (readyState CLOSED), null this out so the next openCrash()
    // actually opens a fresh connection instead of silently no-op'ing.
    if (casinoSource && casinoSource.readyState === EventSource.CLOSED) casinoSource = null;
  };
}
function disconnectCasinoSSE() {
  casinoSource?.close();
  casinoSource = null;
}

function openCrash() {
  buildChainLinks();
  buildChipsBg('casino-chips-bg');
  buildSparkles('casino-crash-sparkles');
  hideCasinoMenu();
  casinoScreen = 'crash';
  document.getElementById('casino-view').classList.add('show');
  connectCasinoSSE();
  api('/api/casino/state').then(renderCasinoState).catch(() => {});
  // Belt-and-braces: if SSE ever gets buffered/blocked somewhere on the
  // network path, this keeps the round from looking frozen — worst case
  // it's a bit less "live" than the SSE stream, never fully stuck.
  clearInterval(casinoPollTimer);
  casinoPollTimer = setInterval(() => {
    api('/api/casino/state').then(renderCasinoState).catch(() => {});
  }, 1500);
}
function closeCrash() {
  const view = document.getElementById('casino-view');
  if (!view) return;
  view.classList.remove('show');
  disconnectCasinoSSE();
  stopCasinoMultiplierLoop();
  clearInterval(casinoPollTimer);
  casinoPollTimer = null;
}

function renderCasinoHistory(history) {
  const wrap = document.getElementById('crash-history');
  wrap.innerHTML = '';
  history.forEach((point) => {
    const pill = document.createElement('div');
    pill.className = 'crash-history-pill' + (point >= 2 ? ' win' : point < 1.2 ? ' bust' : '');
    pill.textContent = `${point.toFixed(2)}x`;
    wrap.appendChild(pill);
  });
}

function renderCasinoBets(bets) {
  const list = document.getElementById('crash-bets-list');
  if (!bets.length) {
    list.innerHTML = '<div class="empty-state">Пока никто не поставил.</div>';
    return;
  }
  list.innerHTML = '';
  bets.forEach((b) => {
    const row = document.createElement('div');
    row.className =
      'ledger-row' +
      (b.won === true ? ' crash-bets-row-won' : b.won === false ? ' crash-bets-row-lost' : '') +
      (b.is_me ? ' crash-bets-row-me' : '');

    let outcomeHtml;
    if (b.cashed_out_at != null) {
      const winnings = Math.round(b.amount * b.cashed_out_at * 10) / 10;
      outcomeHtml = `<div class="row-value">+${fmtDec(winnings)}</div><div class="row-sub">×${b.cashed_out_at.toFixed(2)}</div>`;
    } else if (b.won === false) {
      outcomeHtml = `<div class="row-value">−${fmt(b.amount)}</div><div class="row-sub">сгорело</div>`;
    } else {
      outcomeHtml = `<div class="row-value">${fmt(b.amount)}</div><div class="row-sub">в игре</div>`;
    }

    row.innerHTML = `
      <div style="min-width:0;flex:1;">
        <div class="row-name">${b.is_me ? 'Ты' : b.name}</div>
        <div class="row-meta">ставка ${fmt(b.amount)}</div>
      </div>
      <div class="crash-bet-row-outcome">${outcomeHtml}</div>
    `;
    list.appendChild(row);
  });
}

function updateCasinoActionBtn(state) {
  const btn = document.getElementById('crash-action-btn');
  const label = document.getElementById('crash-action-label');
  const sub = document.getElementById('crash-action-sub');
  const input = document.getElementById('crash-bet-amount');
  const autoInput = document.getElementById('crash-auto-cashout');
  const myBet = state.my_bet;
  const autoSuffix = myBet && myBet.auto_cashout_at ? ` · авто ×${myBet.auto_cashout_at.toFixed(2)}` : '';

  btn.classList.remove('cashout', 'disabled-btn');
  btn.onclick = null;

  if (state.phase === 'waiting') {
    input.disabled = !!myBet;
    autoInput.disabled = !!myBet;
    if (myBet) {
      label.textContent = 'Ставка принята';
      sub.textContent = `${fmt(myBet.amount)} монет${autoSuffix}`;
      btn.classList.add('disabled-btn');
    } else {
      label.textContent = 'Поставить';
      sub.textContent = '';
      btn.onclick = placeCasinoBet;
    }
    return;
  }

  input.disabled = true;
  autoInput.disabled = true;

  if (state.phase === 'running') {
    if (myBet && myBet.cashed_out_at == null) {
      label.textContent = 'Забрать';
      sub.textContent = `×${crashMultiplierAt(casinoRunningAt != null ? Date.now() - casinoRunningAt : 0).toFixed(2)}${autoSuffix}`;
      btn.classList.add('cashout');
      btn.onclick = cashOutCasino;
    } else if (myBet) {
      label.textContent = 'Забрано';
      sub.textContent = `×${myBet.cashed_out_at.toFixed(2)}`;
      btn.classList.add('disabled-btn');
    } else {
      label.textContent = 'Раунд уже идёт';
      sub.textContent = 'жди следующего';
      btn.classList.add('disabled-btn');
    }
    return;
  }

  // phase === 'crashed'
  btn.classList.add('disabled-btn');
  if (myBet && myBet.won) {
    label.textContent = 'Выигрыш забран';
    sub.textContent = `×${myBet.cashed_out_at.toFixed(2)}`;
  } else if (myBet && myBet.won === false) {
    label.textContent = 'Сгорело';
    sub.textContent = `−${fmt(myBet.amount)}`;
  } else {
    label.textContent = 'Новый раунд скоро';
    sub.textContent = '';
  }
}

function renderCasinoState(state) {
  casinoPhase = state.phase;
  if (typeof state.growth_per_ms === 'number') casinoGrowthPerMs = state.growth_per_ms;

  const stage = document.getElementById('crash-stage');
  stage.classList.remove('phase-waiting', 'phase-running', 'phase-crashed');
  stage.classList.add(`phase-${state.phase}`);

  if (state.phase === 'running') {
    // Anchor from the server keeps the local interpolation from drifting;
    // set the text here too as a safety net (in case rAF ever stalls, e.g.
    // a throttled background tab) — the rAF loop then takes over on top of
    // this for smooth per-frame growth.
    casinoRunningAt = state.running_at || casinoRunningAt;
    const el = document.getElementById('crash-multiplier');
    if (el) el.textContent = `${state.multiplier.toFixed(2)}x`;
    startCasinoMultiplierLoop();
  } else {
    stopCasinoMultiplierLoop();
    casinoRunningAt = null;
    document.getElementById('crash-multiplier').textContent = `${state.multiplier.toFixed(2)}x`;
    if (state.phase === 'waiting') updateCrashStageHeat(1);
  }

  const label = document.getElementById('crash-phase-label');
  if (state.phase === 'waiting') {
    label.textContent = `Приём ставок… ${Math.ceil(state.starts_in_ms / 1000)}с`;
  } else if (state.phase === 'running') {
    label.textContent = 'Летит…';
  } else {
    label.textContent = `Лопнуло на ${state.crash_point.toFixed(2)}x`;
  }

  renderCasinoHistory(state.history);
  renderCasinoBets(state.bets);
  updateCasinoActionBtn(state);

  if (state.phase === 'crashed' && state.my_bet && state.my_bet.won === false && lastToastRoundId !== state.round_id) {
    toast('Не успел забрать — ставка сгорела');
    lastToastRoundId = state.round_id;
  }

  // Auto-cashout fired on its own (no button click needed) — let the player
  // know rather than leaving them to notice it in the bets list.
  const mb = state.my_bet;
  if (
    mb &&
    mb.auto_cashout_at != null &&
    mb.cashed_out_at != null &&
    mb.cashed_out_at >= mb.auto_cashout_at &&
    lastAutoCashoutRoundId !== state.round_id
  ) {
    const winnings = Math.round(mb.amount * mb.cashed_out_at * 10) / 10;
    toast(`Авто-вывод сработал: ×${mb.cashed_out_at.toFixed(2)} — +${fmtDec(winnings)}`);
    spawnCasinoWinBurst();
    tg?.HapticFeedback?.notificationOccurred?.('success');
    lastAutoCashoutRoundId = state.round_id;
  }
}

async function placeCasinoBet() {
  const btn = document.getElementById('crash-action-btn');
  const amount = Number(document.getElementById('crash-bet-amount').value);
  if (!amount || amount <= 0) {
    toast('Укажи сумму ставки');
    return;
  }
  const autoRaw = document.getElementById('crash-auto-cashout').value;
  const autoCashoutAt = autoRaw ? Number(autoRaw) : null;
  if (autoRaw && (!Number.isFinite(autoCashoutAt) || autoCashoutAt <= 1)) {
    toast('Авто-вывод должен быть больше 1.00x');
    return;
  }
  btn.disabled = true;
  try {
    const r = await api('/api/casino/bet', { method: 'POST', body: JSON.stringify({ amount, autoCashoutAt }) });
    document.getElementById('hdr-balance').textContent = fmtDec(r.balance);
    currentBalance = r.balance;
    const casinoBalanceEl = document.getElementById('casino-balance');
    if (casinoBalanceEl) casinoBalanceEl.textContent = fmtDec(r.balance);
    toast('Ставка принята');
  } catch (e) {
    toast(e.message);
  } finally {
    btn.disabled = false;
  }
}

// A quick burst of coin/star glyphs from the crash stage on a win — the
// "moment" a delight touch earns its place, not decoration on every tick.
function spawnCasinoWinBurst() {
  const stage = document.getElementById('crash-stage');
  if (!stage) return;
  const symbols = ['✦', '●', '★', '♦'];
  const colors = ['var(--gold)', 'var(--neon-pink, var(--violet))', 'var(--neon-cyan, var(--green))', 'var(--violet)'];
  for (let i = 0; i < 14; i++) {
    const particle = document.createElement('div');
    particle.className = 'casino-win-particle';
    const angle = Math.random() * Math.PI * 2;
    const dist = 70 + Math.random() * 90;
    particle.style.setProperty('--px', `${Math.cos(angle) * dist}px`);
    particle.style.setProperty('--py', `${Math.sin(angle) * dist}px`);
    particle.style.color = colors[i % colors.length];
    particle.style.animationDelay = `${Math.random() * 0.15}s`;
    particle.textContent = symbols[i % symbols.length];
    stage.appendChild(particle);
    setTimeout(() => particle.remove(), 900);
  }
}

async function cashOutCasino() {
  const btn = document.getElementById('crash-action-btn');
  btn.disabled = true;
  try {
    const r = await api('/api/casino/cashout', { method: 'POST' });
    document.getElementById('hdr-balance').textContent = fmtDec(r.balance);
    currentBalance = r.balance;
    const casinoBalanceEl = document.getElementById('casino-balance');
    if (casinoBalanceEl) casinoBalanceEl.textContent = fmtDec(r.balance);
    toast(`Забрано ×${r.multiplier.toFixed(2)} — +${fmtDec(r.winnings)}`);
    spawnCasinoWinBurst();
    tg?.HapticFeedback?.notificationOccurred?.('success');
  } catch (e) {
    toast(e.message);
  } finally {
    btn.disabled = false;
  }
}

// ===== Roulette =====
function connectRouletteSSE() {
  if (rouletteSource || !initData || typeof EventSource === 'undefined') return;
  rouletteSource = new EventSource(`/api/roulette/live?initData=${encodeURIComponent(initData)}`);
  rouletteSource.onmessage = (ev) => {
    try {
      renderRouletteState(JSON.parse(ev.data));
    } catch {
      /* ignore malformed tick */
    }
  };
  rouletteSource.onerror = () => {
    if (rouletteSource && rouletteSource.readyState === EventSource.CLOSED) rouletteSource = null;
  };
}
function disconnectRouletteSSE() {
  rouletteSource?.close();
  rouletteSource = null;
}

function openRoulette() {
  buildRouletteWheel();
  buildChipsBg('roulette-chips-bg');
  buildSparkles('roulette-sparkles');
  hideCasinoMenu();
  casinoScreen = 'roulette';
  document.getElementById('roulette-view').classList.add('show');
  connectRouletteSSE();
  api('/api/roulette/state').then(renderRouletteState).catch(() => {});
  clearInterval(roulettePollTimer);
  roulettePollTimer = setInterval(() => {
    api('/api/roulette/state').then(renderRouletteState).catch(() => {});
  }, 1500);
}
function closeRoulette() {
  const view = document.getElementById('roulette-view');
  if (!view) return;
  view.classList.remove('show');
  disconnectRouletteSSE();
  clearInterval(roulettePollTimer);
  roulettePollTimer = null;
}

function colorLabelRu(color) {
  return color === 'red' ? 'красное' : color === 'black' ? 'чёрное' : 'зелёное';
}

function renderRouletteHistory(history) {
  const wrap = document.getElementById('roulette-history');
  wrap.innerHTML = '';
  history.forEach((r) => {
    const pill = document.createElement('div');
    pill.className = `crash-history-pill roulette-history-pill ${r.color}`;
    pill.textContent = r.number;
    wrap.appendChild(pill);
  });
}

function renderRouletteBets(bets) {
  const list = document.getElementById('roulette-bets-list');
  if (!bets.length) {
    list.innerHTML = '<div class="empty-state">Пока никто не поставил.</div>';
    return;
  }
  list.innerHTML = '';
  bets.forEach((b) => {
    const row = document.createElement('div');
    row.className =
      'ledger-row' +
      (b.won === true ? ' crash-bets-row-won' : b.won === false ? ' crash-bets-row-lost' : '') +
      (b.is_me ? ' crash-bets-row-me' : '');

    let outcomeHtml;
    if (b.won === true) {
      outcomeHtml = `<div class="row-value">+${fmtDec(b.payout)}</div><div class="row-sub">${colorLabelRu(b.color)}</div>`;
    } else if (b.won === false) {
      outcomeHtml = `<div class="row-value">−${fmt(b.amount)}</div><div class="row-sub">${colorLabelRu(b.color)}</div>`;
    } else {
      outcomeHtml = `<div class="row-value">${fmt(b.amount)}</div><div class="row-sub">${colorLabelRu(b.color)}</div>`;
    }

    row.innerHTML = `
      <div style="min-width:0;flex:1;">
        <div class="row-name">${b.is_me ? 'Ты' : b.name}</div>
        <div class="row-meta">ставка ${fmt(b.amount)}</div>
      </div>
      <div class="crash-bet-row-outcome">${outcomeHtml}</div>
    `;
    list.appendChild(row);
  });
}

function updateRouletteControls(state) {
  const input = document.getElementById('roulette-bet-amount');
  const buttons = document.querySelectorAll('.roulette-color-btn');
  const statusEl = document.getElementById('roulette-my-bet-status');
  const myBets = state.my_bets || [];
  const byColor = {};
  myBets.forEach((b) => (byColor[b.color] = b));

  const isWaiting = state.phase === 'waiting';
  let anyAvailable = false;

  buttons.forEach((btn) => {
    const color = btn.dataset.color;
    let disabled = !isWaiting;
    if (!disabled && color === 'red' && byColor.black) disabled = true;
    if (!disabled && color === 'black' && byColor.red) disabled = true;
    btn.classList.toggle('disabled-btn', disabled);
    btn.classList.toggle('selected', !!byColor[color]);
    if (!disabled) anyAvailable = true;
  });

  input.disabled = !anyAvailable;

  if (!myBets.length) {
    statusEl.style.display = 'none';
    return;
  }
  statusEl.style.display = 'block';
  statusEl.innerHTML = myBets
    .map((b) => {
      const label = colorLabelRu(b.color);
      if (state.phase !== 'result') return `Ставка: ${fmt(b.amount)} на ${label}`;
      if (b.won) return `Выигрыш: +${fmtDec(b.payout)} (${label})`;
      return `Сгорело: −${fmt(b.amount)} (${label})`;
    })
    .join('<br>');
}

function renderRouletteState(state) {
  const stage = document.getElementById('roulette-stage');
  stage.classList.remove('phase-waiting', 'phase-spinning', 'phase-result');
  stage.classList.add(`phase-${state.phase}`);

  const badge = document.getElementById('roulette-result-badge');
  const label = document.getElementById('roulette-phase-label');
  badge.classList.remove('red', 'black', 'green');

  if (state.phase === 'waiting') {
    badge.textContent = '?';
    label.textContent = `Приём ставок… ${Math.ceil(state.starts_in_ms / 1000)}с`;
  } else if (state.phase === 'spinning') {
    badge.textContent = '?';
    label.textContent = 'Крутится…';
  } else {
    badge.textContent = state.result.number;
    badge.classList.add(state.result.color);
    label.textContent = `Выпало: ${state.result.number} · ${colorLabelRu(state.result.color)}`;
  }

  renderRouletteHistory(state.history);
  renderRouletteBets(state.bets);
  updateRouletteControls(state);

  if (state.phase === 'result' && state.my_bets?.length && lastRouletteToastRoundId !== state.round_id) {
    const won = state.my_bets.filter((b) => b.won);
    const lost = state.my_bets.filter((b) => b.won === false);
    if (won.length) {
      const total = Math.round(won.reduce((sum, b) => sum + b.payout, 0) * 10) / 10;
      toast(`Выигрыш +${fmtDec(total)}!`);
    } else if (lost.length) {
      toast('Не повезло — ставка сгорела');
    }
    lastRouletteToastRoundId = state.round_id;
  }
}

document.querySelectorAll('.roulette-color-btn').forEach((btn) => {
  btn.addEventListener('click', async () => {
    if (btn.classList.contains('disabled-btn')) return;
    const color = btn.dataset.color;
    const amount = Number(document.getElementById('roulette-bet-amount').value);
    if (!amount || amount <= 0) {
      toast('Укажи сумму ставки');
      return;
    }
    document.querySelectorAll('.roulette-color-btn').forEach((b) => (b.disabled = true));
    try {
      const r = await api('/api/roulette/bet', { method: 'POST', body: JSON.stringify({ color, amount }) });
      document.getElementById('hdr-balance').textContent = fmtDec(r.balance);
      currentBalance = r.balance;
      const rouletteBalanceEl = document.getElementById('roulette-balance');
      if (rouletteBalanceEl) rouletteBalanceEl.textContent = fmtDec(r.balance);
      toast('Ставка принята');
    } catch (e) {
      toast(e.message);
    } finally {
      document.querySelectorAll('.roulette-color-btn').forEach((b) => (b.disabled = false));
    }
  });
});

// ===== Shared bet-amount quick buttons (used by both Краш and Рулетка —
// finds the input in its own row rather than a hardcoded id) =====
document.querySelectorAll('.crash-bet-quick button').forEach((b) => {
  b.addEventListener('click', () => {
    const input = b.closest('.crash-bet-row')?.querySelector('.crash-bet-input');
    if (!input || input.disabled) return;
    if (b.id === 'crash-bet-allin' || b.id === 'roulette-bet-allin') {
      input.value = Math.max(5, Math.floor(currentBalance));
      return;
    }
    const current = Number(input.value) || 0;
    if (b.dataset.add) input.value = current + Number(b.dataset.add);
    if (b.dataset.mult) input.value = Math.max(5, Math.round(current * Number(b.dataset.mult)));
  });
});

document.getElementById('btn-open-casino').addEventListener('click', openCasinoHub);
document.getElementById('btn-casino-menu-back').addEventListener('click', closeCasinoEntirely);
document.getElementById('casino-menu-open-crash').addEventListener('click', openCrash);
document.getElementById('casino-menu-open-roulette').addEventListener('click', openRoulette);
document.getElementById('btn-casino-back').addEventListener('click', () => {
  closeCrash();
  showCasinoMenu();
});
document.getElementById('btn-roulette-back').addEventListener('click', () => {
  closeRoulette();
  showCasinoMenu();
});

// ===== Boot =====
(async function boot() {
  try {
    await loadMe();
    await loadFarmStatus();
  } catch (e) {
    toast('Открой это через кнопку в Telegram-боте');
  }
})();
