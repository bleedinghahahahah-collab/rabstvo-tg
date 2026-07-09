const tg = window.Telegram?.WebApp;
tg?.ready();
tg?.expand();

const initData = tg?.initData || '';

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
const TAB_ORDER = ['profile', 'market', 'people', 'farm', 'top', 'invite'];
const TRANSITION_MS = 280;
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
  document.getElementById('hdr-status').textContent = me.is_owned_by ? 'В услужении' : 'Свободен';

  document.getElementById('seal-initials').textContent = initials(me.username || me.first_name);
  // Telegram gives us our OWN photo directly in initData — no round trip needed
  const ownPhoto = tg?.initDataUnsafe?.user?.photo_url;
  const avatarImg = document.getElementById('seal-avatar');
  avatarImg.src = ownPhoto || `/api/avatar/${me.id}`;
  avatarImg.onerror = () => { avatarImg.style.display = 'none'; };

  document.getElementById('ransom-hint').style.display = me.is_owned_by ? 'block' : 'none';
  document.getElementById('btn-ransom').style.opacity = me.is_owned_by ? '1' : '.45';
  document.getElementById('btn-ransom').disabled = !me.is_owned_by;

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
async function loadMarket() {
  const list = document.getElementById('market-list');
  list.innerHTML = '<div class="empty-state">Ищем кандидатов…</div>';
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
        toast(r.success ? `Успех! Шанс был ${r.chance}%` : `Не вышло. Шанс был ${r.chance}%`);
        loadMarket();
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
async function loadPeople() {
  const list = document.getElementById('people-list');
  list.innerHTML = '<div class="empty-state">Загрузка…</div>';
  const rows = await api('/api/my-people');
  if (!rows.length) {
    list.innerHTML = '<div class="empty-state">Пока никого нет — попробуй «Рынок».</div>';
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
        <button class="mini-btn" data-action="collect" data-id="${p.id}">Забрать доход</button>
        <button class="mini-btn danger" data-action="free" data-id="${p.id}">Отпустить</button>
      </div>
    `;
    row.querySelector('[data-action="collect"]').addEventListener('click', async (ev) => {
      ev.target.disabled = true;
      try {
        const r = await api(`/api/collect/${p.id}`, { method: 'POST' });
        toast(`Собрано: +${fmtDec(r.gained)}`);
        loadPeople();
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
        loadPeople();
        loadMe();
      } catch (e) {
        toast(e.message);
        ev.target.disabled = false;
      }
    });
    list.appendChild(row);
  });
}

// ===== Leaderboard tab =====
async function loadTop() {
  const list = document.getElementById('top-list');
  list.innerHTML = '<div class="empty-state">Считаем состояния…</div>';
  const rows = await api('/api/leaderboard');
  list.innerHTML = '';
  rows.forEach((p) => {
    const name = p.username ? '@' + p.username : p.first_name || 'Без имени';
    const row = document.createElement('div');
    row.className = 'ledger-row';
    row.innerHTML = `
      <div class="rank-badge">#${p.rank}</div>
      <div class="row-seal">${sealHtml(p.id, p.username || p.first_name)}</div>
      <div>
        <div class="row-name">${name}</div>
        <div class="row-meta">${p.rank_title} · ${p.owned_count} чел. в подчинении</div>
      </div>
      <div class="row-leader"></div>
      <div class="row-value">${fmt(p.balance)}</div>
    `;
    list.appendChild(row);
  });
}

// ===== Farm tab =====
const FARM_MIN_INTERVAL_MS = 110; // matches server-side limit
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

function spawnFarmParticle(btn) {
  const particle = document.createElement('div');
  particle.className = 'farm-particle';
  particle.textContent = '+0.2';
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

  api('/api/farm/tap', { method: 'POST' })
    .then((r) => {
      document.getElementById('farm-counter').textContent = `${r.taps_used} / 5000`;
      document.getElementById('hdr-balance').textContent = fmtDec(r.balance);
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
