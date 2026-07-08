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
  if (!res.ok) throw new Error(data.error || 'Ошибка сервера');
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

function fmt(n) {
  return new Intl.NumberFormat('ru-RU').format(Math.floor(n));
}

// ===== Tab switching: slide / shift transition =====
const TAB_ORDER = ['profile', 'market', 'people', 'top', 'invite'];
let currentTab = 'profile';

const tabs = document.querySelectorAll('.tab-btn');
const panelsWrap = document.getElementById('panels');

tabs.forEach((btn) => {
  btn.addEventListener('click', () => {
    const name = btn.dataset.tab;
    if (name === currentTab) return;

    tabs.forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');

    const oldPanel = document.querySelector(`.panel[data-panel="${currentTab}"]`);
    const newPanel = document.querySelector(`.panel[data-panel="${name}"]`);
    const dir = TAB_ORDER.indexOf(name) > TAB_ORDER.indexOf(currentTab) ? 1 : -1;

    // lock the container's height for the duration of the transition so the
    // page doesn't jump while both panels are briefly overlapping
    panelsWrap.style.minHeight = panelsWrap.offsetHeight + 'px';

    oldPanel.classList.remove('slide-in-left', 'slide-in-right');
    oldPanel.classList.add(dir === 1 ? 'slide-out-left' : 'slide-out-right');

    newPanel.classList.add('active');
    newPanel.classList.add(dir === 1 ? 'slide-in-right' : 'slide-in-left');

    loadPanel(name);

    const cleanup = () => {
      oldPanel.classList.remove('active', 'slide-out-left', 'slide-out-right');
      newPanel.classList.remove('slide-in-right', 'slide-in-left');
      panelsWrap.style.minHeight = '';
      oldPanel.removeEventListener('animationend', cleanup);
    };
    oldPanel.addEventListener('animationend', cleanup);

    currentTab = name;
  });
});

function loadPanel(name) {
  if (name === 'market') loadMarket();
  if (name === 'people') loadPeople();
  if (name === 'top') loadTop();
}

// ===== Header (profile summary) =====
async function loadMe() {
  const me = await api('/api/me');
  document.getElementById('hdr-name').textContent = me.username ? '@' + me.username : me.first_name || 'Без имени';
  document.getElementById('hdr-rank').textContent = me.rank_title;
  document.getElementById('hdr-balance').textContent = fmt(me.balance);
  document.getElementById('hdr-income').textContent = fmt(me.income_per_hour) + '/ч';
  document.getElementById('hdr-protection').textContent = 'Ур. ' + me.protection;
  document.getElementById('hdr-status').textContent = me.is_owned_by ? 'В услужении' : 'Свободен';
  document.getElementById('seal').textContent = initials(me.username || me.first_name);

  document.getElementById('protect-cost').textContent = '';
  document.getElementById('ransom-hint').style.display = me.is_owned_by ? 'block' : 'none';
  document.getElementById('btn-ransom').style.opacity = me.is_owned_by ? '1' : '.45';
  document.getElementById('btn-ransom').disabled = !me.is_owned_by;

  return me;
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

document.getElementById('btn-protect').addEventListener('click', async () => {
  try {
    const r = await api('/api/protect', { method: 'POST' });
    toast(`Защита повышена до уровня ${r.protection}`);
    loadMe();
  } catch (e) {
    toast(e.message + (e.cost ? ` (нужно ${e.cost})` : ''));
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
      <div class="row-seal">${initials(p.username || p.first_name)}</div>
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
      <div class="row-seal">${initials(p.username || p.first_name)}</div>
      <div class="row-name">${name}</div>
      <div class="row-leader"></div>
      <div class="row-value">${fmt(p.balance)}</div>
      <div class="row-actions">
        <button class="mini-btn danger" data-id="${p.id}">Отпустить</button>
      </div>
    `;
    row.querySelector('.mini-btn').addEventListener('click', async (ev) => {
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
      <div class="row-seal">${initials(p.username || p.first_name)}</div>
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

// ===== Invite tab =====
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
