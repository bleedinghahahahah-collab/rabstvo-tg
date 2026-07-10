const tg = window.Telegram?.WebApp;
tg?.ready();
tg?.expand();

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
let currentTab = 'profile';
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

// ===== Header (profile summary) =====
let previousOwnerStatus = undefined; // undefined = not known yet (first load)

async function loadMe() {
  const me = await api('/api/me');
  document.getElementById('hdr-name').textContent = me.username ? '@' + me.username : me.first_name || 'Без имени';
  document.getElementById('hdr-rank').textContent = me.rank_title;
  document.getElementById('hdr-balance').textContent = fmtDec(me.balance);
  document.getElementById('hdr-income').textContent = fmt(me.income_per_hour) + '/ч';
  document.getElementById('hdr-owned').textContent = fmt(me.owned_count);

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
// the "ВАС ВЗЯЛИ В РАБСТВО!!!" alert above.
setInterval(() => {
  loadMe().catch(() => {});
}, 8000);

// ===== Online-now counter =====
async function loadOnlineCount() {
  try {
    const { count } = await api('/api/online');
    document.getElementById('online-count').textContent = fmt(count);
  } catch {
    /* silent — this is just a nice-to-have indicator */
  }
}
loadOnlineCount();
setInterval(loadOnlineCount, 8000);

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

// ===== Market tab =====
// ===== Market tab: "Свободные" (free agents) / "Украсть" (steal from others) =====
let marketMode = 'free';

document.querySelectorAll('#market-segmented .segmented-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (btn.dataset.mode === marketMode) return;
    document.querySelectorAll('#market-segmented .segmented-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    marketMode = btn.dataset.mode;
    document.getElementById('market-eyebrow').textContent =
      marketMode === 'free' ? 'Свободные люди' : 'Люди с хозяином';
    loadMarket();
  });
});

async function loadMarket(silent = false) {
  if (marketMode === 'free') return loadFreeMarket(silent);
  return loadStealMarket(silent);
}

async function loadFreeMarket(silent = false) {
  const list = document.getElementById('market-list');
  if (!silent) list.innerHTML = '<div class="empty-state">Ищем кандидатов…</div>';
  const rows = await api('/api/market');
  if (!rows.length) {
    list.innerHTML = '<div class="empty-state">Сейчас все либо уже заняты, либо это ты сам. Загляни позже.</div>';
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
        const r = await api('/api/acquire', {
          method: 'POST',
          body: JSON.stringify({ targetId: p.id }),
        });
        toast('Успешно!');
        loadMarket(true);
        loadMe();
      } catch (e) {
        toast(e.message + (e.cost ? ` (нужно ${e.cost})` : ''));
        ev.target.disabled = false;
      }
    });
    list.appendChild(row);
  });
}

async function loadStealMarket(silent = false) {
  const list = document.getElementById('market-list');
  if (!silent) list.innerHTML = '<div class="empty-state">Ищем чужих людей…</div>';
  const rows = await api('/api/market/stealable');
  if (!rows.length) {
    list.innerHTML = '<div class="empty-state">Пока красть не у кого — у всех либо нет людей, либо это твои же.</div>';
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
        const r = await api('/api/steal', {
          method: 'POST',
          body: JSON.stringify({ targetId: p.id }),
        });
        toast('Успешно!');
        loadMarket(true);
        loadMe();
      } catch (e) {
        toast(e.message + (e.cost ? ` (нужно ${e.cost})` : ''));
        ev.target.disabled = false;
      }
    });
    list.appendChild(row);
  });
}

// ===== My people tab =====
async function loadPeople(silent = false) {
  const list = document.getElementById('people-list');
  // The "Загрузка…" placeholder briefly collapses the list's height while the
  // request is in flight, which is what caused the page to scroll back to
  // the top after tapping a button near the bottom. Skipping it on refresh
  // (silent=true) keeps the existing rows in place until the new ones are
  // ready, so the scroll position never jumps.
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
        <div class="row-meta">${p.job_name} · ${fmt(p.job_income)}/ч</div>
      </div>
      <div class="row-value">+${fmtDec(p.pending_income)}</div>
      <div class="row-actions">
        <button class="mini-btn collect" data-action="collect" data-id="${p.id}">Забрать доход</button>
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

async function loadTop(silent = false) {
  const list = document.getElementById('top-list');
  if (!silent) list.innerHTML = '<div class="empty-state">Считаем состояния…</div>';
  const rows = await api(`/api/leaderboard?by=${topMode}`);
  list.innerHTML = '';
  rows.forEach((p) => {
    const name = p.username ? '@' + p.username : p.first_name || 'Без имени';
    const row = document.createElement('div');
    row.className = 'ledger-row';
    const valueHtml =
      topMode === 'owned' ? `${fmt(p.owned_count)} чел.` : `${fmt(p.balance)}`;
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

// ===== Farm tab =====
const FARM_MIN_INTERVAL_MS = 60; // matches server-side limit
let farmLastClientTap = 0;
let farmLocked = false;
let farmCountdownTimer = null;

async function loadFarmStatus() {
  try {
    const status = await api('/api/farm/status');
    applyFarmStatus(status);
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

  spawnFarmParticle(btn);
  bumpCounter();
  tg?.HapticFeedback?.impactOccurred?.('light');

  api('/api/farm/tap', { method: 'POST' })
    .then((r) => {
      document.getElementById('farm-counter').textContent = `${r.taps_used} / 5000`;
      document.getElementById('hdr-balance').textContent = fmtDec(r.balance);
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
async function loadShop() {
  const list = document.getElementById('shop-list');
  list.innerHTML = '<div class="empty-state">Загрузка…</div>';
  const items = await api('/api/shop/items');
  list.innerHTML = '';
  items.forEach((item) => {
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
              loadShop();
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
    list.appendChild(row);
  });
}

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

// ===== Boot =====
(async function boot() {
  try {
    await loadMe();
  } catch (e) {
    toast('Открой это через кнопку в Telegram-боте');
  }
})();
