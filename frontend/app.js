'use strict';

// Static mode: on GitHub Pages (or any non-localhost host), read pre-exported JSON files.
// On localhost, hit the Python backend directly.
const STATIC = window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1';

// ── Utility ──────────────────────────────────────────────────────────────────

function $(id) { return document.getElementById(id); }

function showView(id) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  $(id).classList.add('active');
  window.scrollTo(0, 0);
}

function showError(msg) {
  const t = $('error-toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  setTimeout(() => t.classList.add('hidden'), 3500);
}

// Convert a name to a safe filename slug (must match export_static.py's slug())
function slugify(name) {
  return name.toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

// ── Static mode: read pre-exported JSON files ─────────────────────────────────

const _sIdx = { participants: null, teams: null };

async function _loadIdx(type) {
  if (!_sIdx[type]) {
    const r = await fetch(`data/search/${type}.json`);
    if (!r.ok) throw new Error(`Search index not found: ${type}`);
    _sIdx[type] = await r.json();
  }
  return _sIdx[type];
}

function _clientSearch(index, q) {
  const norm = q.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  return index
    .filter(item => {
      const n = item.name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
      return n.includes(norm);
    })
    .slice(0, 15)
    .map(item => ({ name: item.name, years: item.years, teams: item.teams }));
}

async function _staticFetch(path) {
  const [rawPath, qs] = path.split('?');
  const params = new URLSearchParams(qs || '');

  // Search endpoints → client-side index filter
  if (rawPath === '/api/search/participants') {
    const idx = await _loadIdx('participants');
    return _clientSearch(idx, params.get('q') || '');
  }
  if (rawPath === '/api/search/teams') {
    const idx = await _loadIdx('teams');
    return _clientSearch(idx, params.get('q') || '');
  }

  // Participant profile
  const partMatch = rawPath.match(/^\/api\/participant\/(.+)$/);
  if (partMatch) {
    const r = await fetch(`data/participants/${slugify(decodeURIComponent(partMatch[1]))}.json`);
    if (!r.ok) throw new Error('Participant not found');
    return r.json();
  }

  // Team profile / peers / intelligence — all bundled in one file
  const teamPeersMatch = rawPath.match(/^\/api\/team\/(.+)\/peers$/);
  if (teamPeersMatch) {
    const r = await fetch(`data/teams/${slugify(decodeURIComponent(teamPeersMatch[1]))}.json`);
    if (!r.ok) throw new Error('Team not found');
    return (await r.json()).peers;
  }
  const teamIntelMatch = rawPath.match(/^\/api\/team\/(.+)\/intelligence$/);
  if (teamIntelMatch) {
    const r = await fetch(`data/teams/${slugify(decodeURIComponent(teamIntelMatch[1]))}.json`);
    if (!r.ok) throw new Error('Team not found');
    return (await r.json()).intel;
  }
  const teamMatch = rawPath.match(/^\/api\/team\/(.+)$/);
  if (teamMatch) {
    const r = await fetch(`data/teams/${slugify(decodeURIComponent(teamMatch[1]))}.json`);
    if (!r.ok) throw new Error('Team not found');
    return (await r.json()).profile;
  }

  // Rankings
  if (rawPath === '/api/rankings/years') {
    const r = await fetch('data/years.json'); return r.json();
  }
  if (rawPath === '/api/rankings/participants') {
    const y = params.get('year');
    const r = await fetch(y ? `data/rankings/participants_${y}.json` : 'data/rankings/participants.json');
    return r.json();
  }
  if (rawPath === '/api/rankings/teams') {
    const y = params.get('year');
    const r = await fetch(y ? `data/rankings/teams_${y}.json` : 'data/rankings/teams.json');
    return r.json();
  }

  // Analytics + map
  if (rawPath === '/api/analytics/problems') {
    const min = params.get('min_year');
    const r = await fetch('data/analytics/problems.json');
    const d = await r.json();
    if (min) { d.problems = d.problems.filter(p => p.year >= parseInt(min)); }
    return d;
  }
  if (rawPath === '/api/analytics/role-stats') {
    const r = await fetch('data/analytics/role_stats.json'); return r.json();
  }
  if (rawPath === '/api/map/countries') {
    const r = await fetch('data/map.json'); return r.json();
  }

  // Compare participants → load both profiles, compute winner client-side
  if (rawPath === '/api/compare/participants') {
    const [a, b] = [params.get('a'), params.get('b')];
    const [pA, pB] = await Promise.all([
      _staticFetch(`/api/participant/${encodeURIComponent(a)}`),
      _staticFetch(`/api/participant/${encodeURIComponent(b)}`),
    ]);
    const roles = ['Reporter', 'Opponent', 'Reviewer'];
    const w = (av, bv) => av == null && bv == null ? null : av == null ? 'b' : bv == null ? 'a' : av > bv ? 'a' : bv > av ? 'b' : 'tie';
    return {
      a: pA, b: pB,
      winner: {
        overall_z_score: w(pA.overall_z_score, pB.overall_z_score),
        role_avg:   Object.fromEntries(roles.map(r => [r, w(pA.overall_role_avg[r], pB.overall_role_avg[r])])),
        role_z_avg: Object.fromEntries(roles.map(r => [r, w(pA.overall_z_avg[r], pB.overall_z_avg[r])])),
      },
    };
  }

  // Compare teams → load both profiles
  if (rawPath === '/api/compare/teams') {
    const [a, b] = [params.get('a'), params.get('b')];
    const [pA, pB] = await Promise.all([
      _staticFetch(`/api/team/${encodeURIComponent(a)}`),
      _staticFetch(`/api/team/${encodeURIComponent(b)}`),
    ]);
    return { a: pA, b: pB };
  }

  // Room matchup → look up each pair from pre-generated files
  if (rawPath === '/api/room-matchup') {
    const teams = (params.get('teams') || '').split(',').map(t => t.trim()).filter(Boolean);
    const matchups = [];
    for (let i = 0; i < teams.length; i++) {
      for (let j = i + 1; j < teams.length; j++) {
        const [sa, sb] = [slugify(teams[i]), slugify(teams[j])].sort();
        const r = await fetch(`data/room_pairs/${sa}__vs__${sb}.json`);
        if (r.ok) {
          const d = await r.json();
          matchups.push(...d.matchups);
        }
      }
    }
    // Resolve canonical names from the matchup data
    const canonical = teams.map(t => {
      const m = matchups.find(m => slugify(m.team_a) === slugify(t) || slugify(m.team_b) === slugify(t));
      if (!m) return t;
      return slugify(m.team_a) === slugify(t) ? m.team_a : m.team_b;
    });
    return { teams: canonical, matchups };
  }

  throw new Error(`Static: unhandled path ${rawPath}`);
}

async function apiFetch(path) {
  if (STATIC) return _staticFetch(path);
  const res = await fetch(path);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `HTTP ${res.status}`);
  }
  return res.json();
}

function fmt(val, decimals = 2) {
  if (val == null) return '—';
  return Number(val).toFixed(decimals);
}

function fmtZ(val) {
  if (val == null) return '';
  const sign = val >= 0 ? '+' : '';
  return `(z: ${sign}${Number(val).toFixed(2)})`;
}

function initials(name) {
  return name.split(' ').map(p => p[0]).join('').slice(0, 2).toUpperCase();
}

const _ISO = {
  'Australia':'AU','Austria':'AT','Brazil':'BR','Bulgaria':'BG','Canada':'CA',
  'China':'CN','Chinese Taipei':'TW','Croatia':'HR','Czech Republic':'CZ','Czechia':'CZ',
  'Georgia':'GE','Germany':'DE','Greece':'GR','Hong Kong':'HK','Hungary':'HU',
  'India':'IN','Iran':'IR','Italy':'IT','Kazakhstan':'KZ','Korea':'KR',
  'Macao':'MO','Mexico':'MX','Nepal':'NP','New Zealand':'NZ','Pakistan':'PK',
  'Poland':'PL','Romania':'RO','Serbia':'RS','Singapore':'SG','Slovakia':'SK',
  'Slovenia':'SI','South Africa':'ZA','Sweden':'SE','Switzerland':'CH',
  'Thailand':'TH','Turkey':'TR','Türkiye':'TR','USA':'US','Uganda':'UG',
  'Ukraine':'UA','United Kingdom':'GB','Uzbekistan':'UZ',
};
function countryFlag(name) {
  const code = _ISO[name];
  if (!code) return null;
  return String.fromCodePoint(...[...code].map(c => 0x1F1E6 + c.charCodeAt(0) - 65));
}

const _ZTIP = 'Global Z is built in four layers. ① Judge normalization: each score is z-scored within its fight panel, so a 7 from a harsh judge (average 5) outweighs a 7 from a lenient judge (average 8). ② Role adjustment: Reporters score ~0.42σ below Reviewers globally — we subtract each role\'s tournament-wide mean so Reporter, Opponent and Reviewer performances are on the same scale. ③ Bayesian shrinkage × n/(n+3.5): applied independently per tournament year — a participant with 3 fights in a year gets 46% weight (vs 74% for 9 fights), balancing data trust against sample size. ④ Per-year fairness: the shrunk estimates are averaged across years, not pooled — so competing in multiple years does not artificially inflate your sample size; each tournament contributes equally regardless of how many rounds it contained.';
function zLabel(text) {
  return `${text} <span class="info-tip" data-tip="${_ZTIP}">ⓘ</span>`;
}

// Clickable info-tip: toggle active class; click elsewhere closes all
document.addEventListener('click', e => {
  const tip = e.target.closest('.info-tip');
  if (tip) {
    const isActive = tip.classList.contains('active');
    document.querySelectorAll('.info-tip.active').forEach(t => t.classList.remove('active'));
    if (!isActive) tip.classList.add('active');
    e.stopPropagation();
  } else {
    document.querySelectorAll('.info-tip.active').forEach(t => t.classList.remove('active'));
  }
});

// ── Tabs ─────────────────────────────────────────────────────────────────────

document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    tab.classList.add('active');
    $('tab-' + tab.dataset.tab).classList.add('active');
    const isWide = tab.dataset.tab === 'rankings' || tab.dataset.tab === 'analytics';
    document.querySelector('.search-block').classList.toggle('wide', isWide);
    $('view-home').classList.toggle('view-wide', isWide);
  });
});

// ── Autocomplete helper ───────────────────────────────────────────────────────

function autocomplete(inputId, sugId, endpoint, onSelect) {
  const inp = $(inputId);
  const sug = $(sugId);
  let timer = null;
  let selected = null;

  // Pre-load search index in static mode so first keystroke is instant
  if (STATIC) _loadIdx(endpoint).catch(() => {});

  inp.addEventListener('input', () => {
    selected = null;
    clearTimeout(timer);
    const q = inp.value.trim();
    if (q.length < 2) { sug.classList.add('hidden'); return; }
    timer = setTimeout(async () => {
      try {
        const data = await apiFetch(`/api/search/${endpoint}?q=${encodeURIComponent(q)}`);
        renderSuggestions(data);
      } catch { sug.classList.add('hidden'); }
    }, 250);
  });

  function renderSuggestions(items) {
    if (!items.length) { sug.classList.add('hidden'); return; }
    sug.innerHTML = '';
    items.forEach(item => {
      const li = document.createElement('li');
      const name = item.name;
      const sub = [item.years, item.teams].filter(Boolean).join(' · ');
      li.innerHTML = `<div>${name}</div>${sub ? `<div class="sub">${sub}</div>` : ''}`;
      li.addEventListener('mousedown', e => {
        e.preventDefault();
        inp.value = name;
        selected = name;
        sug.classList.add('hidden');
        onSelect && onSelect(name);
      });
      sug.appendChild(li);
    });
    sug.classList.remove('hidden');
  }

  document.addEventListener('click', e => {
    if (!inp.contains(e.target) && !sug.contains(e.target)) sug.classList.add('hidden');
  });

  inp.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      sug.classList.add('hidden');
    }
  });

  return () => selected || inp.value.trim();
}

// ── Wire up inputs ────────────────────────────────────────────────────────────

const getParticipant = autocomplete('inp-participant', 'sug-participant', 'participants', null);
const getTeam = autocomplete('inp-team', 'sug-team', 'teams', null);
const getCtA = autocomplete('inp-ct-a', 'sug-ct-a', 'teams', null);
const getCtB = autocomplete('inp-ct-b', 'sug-ct-b', 'teams', null);
const getDuelA = autocomplete('inp-duel-a', 'sug-duel-a', 'participants', null);
const getDuelB = autocomplete('inp-duel-b', 'sug-duel-b', 'participants', null);

// Mode card quick-search inputs
const getHeroP = autocomplete('inp-hero-p', 'sug-hero-p', 'participants', name => loadProfile(name));
const getHeroT = autocomplete('inp-hero-t', 'sug-hero-t', 'teams', name => loadTeam(name));

// Dream Team role inputs
const getDtR = autocomplete('inp-dt-r', 'sug-dt-r', 'participants', null);
const getDtO = autocomplete('inp-dt-o', 'sug-dt-o', 'participants', null);
const getDtV = autocomplete('inp-dt-v', 'sug-dt-v', 'participants', null);

// Room matchup team inputs (tab)
const getRoomA = autocomplete('inp-room-a', 'sug-room-a', 'teams', null);
const getRoomB = autocomplete('inp-room-b', 'sug-room-b', 'teams', null);
const getRoomC = autocomplete('inp-room-c', 'sug-room-c', 'teams', null);

// Room matchup hero card inputs
const getHeroRoomA = autocomplete('inp-hero-room-a', 'sug-hero-room-a', 'teams', null);
const getHeroRoomB = autocomplete('inp-hero-room-b', 'sug-hero-room-b', 'teams', null);
const getHeroRoomC = autocomplete('inp-hero-room-c', 'sug-hero-room-c', 'teams', null);

// ── Profile ───────────────────────────────────────────────────────────────────

$('btn-participant').addEventListener('click', () => {
  const name = getParticipant();
  if (!name) { showError('Enter a participant name'); return; }
  loadProfile(name);
});

// Hero mode card buttons
$('btn-hero-p').addEventListener('click', () => {
  const name = getHeroP();
  if (!name) { showError('Enter your name'); return; }
  loadCompetitorHub(name);
});
$('btn-hero-t').addEventListener('click', () => {
  const name = getHeroT();
  if (!name) { showError('Enter your team/country'); return; }
  loadTeam(name);
});
$('btn-hero-jury').addEventListener('click', () => loadJury());
$('btn-hero-duel').addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  const t = document.querySelector('[data-tab="duel"]');
  if (t) { t.classList.add('active'); $('tab-duel').classList.add('active'); }
  $('inp-duel-a').focus();
});
$('btn-hero-dt').addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  const t = document.querySelector('[data-tab="dreamteam"]');
  if (t) { t.classList.add('active'); $('tab-dreamteam').classList.add('active'); }
  $('inp-dt-r').focus();
});

// Dream Team assemble
$('btn-dreamteam').addEventListener('click', () => {
  const r = getDtR(), o = getDtO(), v = getDtV();
  if (!r || !o || !v) { showError('Enter all three names'); return; }
  loadDreamTeam(r, o, v);
});

$('back-from-profile').addEventListener('click', () => showView('view-home'));
$('back-from-team').addEventListener('click', () => showView('view-home'));
$('back-from-compare-t').addEventListener('click', () => showView('view-home'));
$('back-from-duel').addEventListener('click', () => showView('view-home'));
$('back-from-dreamteam').addEventListener('click', () => showView('view-home'));
$('back-from-hub').addEventListener('click', () => showView('view-home'));
$('back-from-jury').addEventListener('click', () => showView('view-home'));
$('back-from-room').addEventListener('click', () => showView('view-home'));

$('btn-room').addEventListener('click', () => {
  const a = getRoomA(), b = getRoomB(), c = getRoomC();
  if (!a || !b) { showError('Enter at least 2 teams'); return; }
  loadRoomMatchup([a, b, ...(c ? [c] : [])]);
});

$('btn-hero-room').addEventListener('click', () => {
  const a = getHeroRoomA(), b = getHeroRoomB(), c = getHeroRoomC();
  if (!a || !b) { showError('Enter at least 2 teams'); return; }
  loadRoomMatchup([a, b, ...(c ? [c] : [])]);
});

// ── Share / URL deep-linking ──────────────────────────────────────────────────

function shareUrl(params) {
  const u = new URL(window.location.href.split('?')[0]);
  Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, v));
  navigator.clipboard.writeText(u.toString()).then(() => {
    showToast('Link copied to clipboard!');
  }).catch(() => {
    prompt('Copy this link:', u.toString());
  });
}

function showToast(msg) {
  const t = $('error-toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  t.style.background = 'var(--green)';
  t.style.color = '#fff';
  setTimeout(() => { t.classList.add('hidden'); t.style.background = ''; t.style.color = ''; }, 3000);
}

function shareBtn(params, label = '🔗 Share') {
  const json = JSON.stringify(params).replace(/"/g, '&quot;');
  return `<button class="share-btn" onclick="shareUrl(${json})">${label}</button>`;
}

// Read URL params on page load
(function handleDeepLink() {
  const p = new URLSearchParams(window.location.search);
  const profile  = p.get('profile');
  const duelA    = p.get('duel');
  const duelB    = p.get('vs');
  const dtR      = p.get('dt');
  const dtO      = p.get('dto');
  const dtV      = p.get('dtv');
  const team     = p.get('team');
  const jury     = p.get('jury');
  const room     = p.get('room');
  if (profile)              setTimeout(() => loadProfile(profile), 0);
  else if (duelA && duelB)  setTimeout(() => loadDuel(duelA, duelB), 0);
  else if (dtR && dtO && dtV) setTimeout(() => loadDreamTeam(dtR, dtO, dtV), 0);
  else if (team)            setTimeout(() => loadTeam(team), 0);
  else if (jury !== null)   setTimeout(() => loadJury(), 0);
  else if (room)            setTimeout(() => loadRoomMatchup(room.split(',')), 0);
})();

async function loadProfile(name) {
  showView('view-profile');
  $('profile-content').innerHTML = '<div class="loader">Loading…</div>';
  try {
    const p = await apiFetch(`/api/participant/${encodeURIComponent(name)}`);
    $('profile-content').innerHTML = renderProfile(p);
    renderProfileCharts(p);
    $('profile-content').querySelectorAll('[data-participant]').forEach(el => {
      el.addEventListener('click', () => loadProfile(el.dataset.participant));
    });
    $('profile-content').querySelectorAll('[data-team]').forEach(el => {
      el.addEventListener('click', () => loadTeam(el.dataset.team));
    });
  } catch (err) {
    showError(err.message);
    showView('view-home');
  }
}

function renderProfileCharts(p) {
  const roles = ['Reporter', 'Opponent', 'Reviewer'];
  const roleColors = ['#5b8dee', '#7c5ce0', '#00b894'];
  const C = window.Chart;
  if (!C) return;

  ['chart-radar', 'chart-timeline'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { const existing = C.getChart(el); if (existing) existing.destroy(); }
  });

  const gridColor = 'rgba(46,51,80,.6)';
  const textColor = '#7a7f9a';

  // Inline plugin: draw score labels outward from each radar vertex
  const radarLabels = {
    id: 'radarLabels',
    afterDatasetsDraw(chart) {
      const ctx = chart.ctx;
      const meta = chart.getDatasetMeta(0);
      const dataset = chart.data.datasets[0];
      const cx = chart.chartArea.left + chart.chartArea.width / 2;
      const cy = chart.chartArea.top + chart.chartArea.height / 2;
      meta.data.forEach((pt, i) => {
        const v = dataset.data[i];
        if (v == null) return;
        const dx = pt.x - cx, dy = pt.y - cy;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const lx = pt.x + (dx / dist) * 18;
        const ly = pt.y + (dy / dist) * 18;
        ctx.save();
        ctx.fillStyle = roleColors[i];
        ctx.font = 'bold 12px Segoe UI,system-ui,sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(v.toFixed(1), lx, ly);
        ctx.restore();
      });
    },
  };

  // ── Radar chart ────────────────────────────────
  const radarEl = document.getElementById('chart-radar');
  if (radarEl) {
    const avgs = roles.map(r => p.overall_role_avg[r] ?? null);
    new C(radarEl, {
      type: 'radar',
      plugins: [radarLabels],
      data: {
        labels: roles,
        datasets: [{
          label: 'Avg Score',
          data: avgs,
          backgroundColor: 'rgba(120,100,220,.12)',
          borderColor: 'rgba(120,100,220,.4)',
          pointBackgroundColor: roleColors,
          pointBorderColor: roleColors,
          pointHoverBackgroundColor: roleColors,
          pointRadius: 6,
          pointHoverRadius: 8,
          borderWidth: 2,
        }],
      },
      options: {
        responsive: false,
        scales: {
          r: {
            min: 0, max: 10,
            ticks: { stepSize: 2, color: textColor, font: { size: 10 }, backdropColor: 'transparent' },
            grid: { color: gridColor },
            angleLines: { color: gridColor },
            pointLabels: {
              color: (ctx) => roleColors[ctx.index] || '#e4e6f0',
              font: { size: 12, weight: '600' },
            },
          },
        },
        plugins: { legend: { display: false } },
      },
    });
  }

  // ── Timeline chart — line with category x-axis (years as labels) ──
  const timelineEl = document.getElementById('chart-timeline');
  if (timelineEl && p.years.length >= 2) {
    const years = p.years_data.map(y => String(y.year));
    const rm = p.role_means || {};
    const wtZByYear = p.years_data.map(y => {
      const adjZs = roles.map(r => {
        const z = y.role_z_avg[r];
        return z != null ? z - (rm[r] || 0) : null;
      }).filter(v => v != null);
      if (!adjZs.length) return null;
      const z = adjZs.reduce((a, b) => a + b) / adjZs.length;
      const n = roles.reduce((acc, r) => acc + (y.performances_count[r] || 0), 0);
      return parseFloat((z * n / (n + 5)).toFixed(3));
    });
    const avgByYear = p.years_data.map(y => {
      const vals = roles.map(r => y.role_avg[r]).filter(v => v != null);
      return vals.length ? parseFloat((vals.reduce((a, b) => a + b) / vals.length).toFixed(2)) : null;
    });

    // Symmetric adj-z axis around 0
    const zVals = wtZByYear.filter(v => v != null);
    const absMaxZ = zVals.length ? Math.max(...zVals.map(Math.abs)) : 1;
    const zRange = Math.max(Math.ceil(absMaxZ * 1.5 * 10) / 10, 1.0);

    new C(timelineEl, {
      type: 'line',
      data: {
        labels: years,
        datasets: [
          {
            label: 'Avg Score',
            data: avgByYear,
            backgroundColor: '#5b8dee',
            borderColor: '#5b8dee',
            pointRadius: 5,
            pointHoverRadius: 7,
            tension: 0.3,
            yAxisID: 'yAvg',
          },
          {
            label: 'Global Z',
            data: wtZByYear,
            backgroundColor: '#00b894',
            borderColor: '#00b894',
            pointRadius: 5,
            pointHoverRadius: 7,
            tension: 0.3,
            yAxisID: 'yZ',
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: {
            type: 'category',
            ticks: { color: textColor },
            grid: { color: gridColor },
          },
          yAvg: {
            type: 'linear', position: 'left',
            min: 0, max: 10,
            ticks: { color: '#5b8dee', font: { size: 10 } },
            grid: { color: gridColor },
            title: { display: true, text: 'Avg', color: '#5b8dee', font: { size: 10 } },
          },
          yZ: {
            type: 'linear', position: 'right',
            min: -zRange, max: zRange,
            ticks: { color: '#00b894', font: { size: 10 } },
            grid: { drawOnChartArea: false },
            title: { display: true, text: 'Z', color: '#00b894', font: { size: 10 } },
          },
        },
        plugins: {
          legend: { labels: { color: textColor, font: { size: 11 }, boxWidth: 14 } },
          tooltip: { callbacks: { title: items => items.length ? items[0].label : '' } },
        },
      },
    });
  }
}

function quartileLabel(q) {
  const labels = { 1: 'Top 25%', 2: 'Top 50%', 3: 'Top 75%', 4: 'Bottom 25%' };
  return labels[q] || '—';
}

function renderProfile(p) {
  const roles = ['Reporter', 'Opponent', 'Reviewer'];
  const yearsStr = p.years.join(', ');

  // Overall role averages table
  const totalPerfs = roles.reduce((acc, r) =>
    acc + p.years_data.reduce((a, y) => a + (y.performances_count[r] || 0), 0), 0);

  const roleRows = roles.map(r => {
    const avg = fmt(p.overall_role_avg[r]);
    const total = p.years_data.reduce((acc, y) => acc + (y.performances_count[r] || 0), 0);
    const scored = p.years_data.reduce((acc, y) => acc + (y.scored_count ? (y.scored_count[r] || 0) : (y.performances_count[r] || 0)), 0);
    const countStr = total > scored ? `${scored}/${total}` : `${total}`;
    return `<tr>
      <td>${r}</td>
      <td class="score">${avg}</td>
      <td style="font-size:.82rem">${countStr}</td>
    </tr>`;
  }).join('');

  const roleTotalRow = `<tr style="border-top:2px solid var(--border)">
    <td colspan="2" style="color:var(--muted);font-size:.78rem;text-transform:uppercase;letter-spacing:.4px">Total</td>
    <td style="font-weight:700;font-size:.9rem">${totalPerfs}</td>
  </tr>`;

  // Year cards
  const roleColor = { Reporter: 'var(--accent)', Opponent: 'var(--accent2)', Reviewer: 'var(--green)' };

  const yearCards = p.years_data.map(y => {
    const q = y.quartile;
    const qClass = q ? `quartile-${q.quartile}` : '';
    const qText = q ? `${quartileLabel(q.quartile)} · #${q.rank}/${q.total} (${q.percentile}th pct)` : '—';

    // Per-year averages (consistent with top stat card: average of role averages)
    const fights = y.fights || [];
    const roleAvgVals = roles.map(r => y.role_avg[r]).filter(v => v != null);
    const yearAvg = roleAvgVals.length > 0 ? roleAvgVals.reduce((a, b) => a + b) / roleAvgVals.length : null;
    const roleZVals = roles.map(r => y.role_z_avg[r]).filter(v => v != null);
    const yearZ = roleZVals.length > 0 ? roleZVals.reduce((a, b) => a + b) / roleZVals.length : null;
    const yearAvgStr = yearAvg != null ? `Avg ${fmt(yearAvg)}` : '';

    // Individual fight rows
    const fightRows = fights.map(f => {
      const color = roleColor[f.role] || 'var(--muted)';
      const room = f.fight_room ? ` · ${f.fight_room}` : '';
      const scoreStr = f.avg_score != null ? fmt(f.avg_score) : '—';
      const noGrade = f.avg_score == null ? ' style="opacity:.55"' : '';
      return `<div class="fight-row"${noGrade}>
        <span class="fight-role" style="background:${color}">${f.role[0]}</span>
        <span class="fight-meta">Rd ${f.round}${room}</span>
        <span class="fight-score">${scoreStr}</span>
      </div>`;
    }).join('');

    return `<div class="year-card">
      <div class="year-card-header">
        <div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap">
          <span class="year-badge" data-team="${y.team}" style="cursor:pointer" title="View ${y.team} team page">${y.year}</span>
          <span data-team="${y.team}" style="font-size:.9rem;color:var(--accent);cursor:pointer;text-decoration:underline">${y.team}</span>
          ${yearAvgStr ? `<span style="font-size:.82rem;color:var(--text)">${yearAvgStr}</span>` : ''}
        </div>
        <span class="quartile-badge ${qClass}">${qText}</span>
      </div>
      <div class="fight-list">${fightRows || '<span style="color:var(--muted);font-size:.85rem">No data</span>'}</div>
    </div>`;
  }).join('');

  const overallZ = fmt(p.overall_z_score, 3);
  const overallAvg = fmt(
    Object.values(p.overall_role_avg).filter(v => v != null).reduce((a, b, _, arr) => a + b / arr.length, 0) || null
  );
  const totalFights = roles.reduce((acc, r) =>
    acc + p.years_data.reduce((a, y) => a + (y.performances_count[r] || 0), 0), 0);
  const wtZ = p.global_z != null ? fmt(p.global_z, 3) : '—';

  const firstTeam = p.years_data[0]?.team || '';
  const flag = countryFlag(firstTeam);
  let avatarHtml;
  if (p.photo_url) {
    avatarHtml = `<img class="profile-avatar profile-avatar-photo" src="${p.photo_url}" alt="${p.name}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"><div class="profile-avatar" style="${flag ? 'background:var(--surface);font-size:1.8rem' : ''};display:none">${flag || initials(p.name)}</div>`;
  } else {
    avatarHtml = `<div class="profile-avatar" style="${flag ? 'background:var(--surface);font-size:1.8rem' : ''}">${flag || initials(p.name)}</div>`;
  }

  const socialLinks = Object.entries(p.social || {}).map(([platform, url]) => {
    const icons = { instagram: '📸', linkedin: '💼', twitter: '🐦', facebook: '👤' };
    const icon = icons[platform] || '🔗';
    return `<a class="social-link" href="${url}" target="_blank" rel="noopener noreferrer">${icon} ${platform}</a>`;
  }).join('');
  const socialHtml = socialLinks ? `<div class="social-links">${socialLinks}</div>` : '';

  // Build chart data for radar + timeline
  const hasMultipleRoles = roles.filter(r => p.overall_role_avg[r] != null).length >= 2;
  const hasMultipleYears = p.years.length >= 2;

  const radarSection = hasMultipleRoles ? `
    <div class="section-title">Role Performance</div>
    <div class="charts-row">
      <div class="chart-card">
        <canvas id="chart-radar" width="260" height="260"></canvas>
      </div>
      ${hasMultipleYears ? `<div class="chart-card chart-card-wide" style="height:260px">
        <canvas id="chart-timeline"></canvas>
      </div>` : ''}
    </div>` : '';

  // Best rank across all years for the rank banner
  const bestRankYear = p.years_data.reduce((best, y) => {
    if (!y.quartile?.rank) return best;
    if (!best || y.quartile.rank < best.quartile.rank) return y;
    return best;
  }, null);
  const rankBanner = bestRankYear?.quartile ? (() => {
    const q = bestRankYear.quartile;
    const isRecent = bestRankYear.year === p.years[p.years.length - 1];
    const pct = q.percentile != null ? q.percentile : null;
    const pctStr = pct != null ? `top ${(100 - pct).toFixed(0)}%` : '';
    return `<div class="rank-banner">
      🏅 In <strong>${bestRankYear.year}</strong>${isRecent ? ' (most recent)' : ' (best year)'}, you ranked
      <strong>#${q.rank} of ${q.total}</strong> participants
      ${pctStr ? `<span class="rank-pct">· ${pctStr} of the field</span>` : ''}
    </div>`;
  })() : '';

  const profileShareBtn = shareBtn({ profile: p.name }, '🔗 Share profile');

  return `
    <div class="profile-header">
      ${avatarHtml}
      <div>
        <div class="profile-name">${p.name}</div>
        <div class="profile-years">${yearsStr}</div>
        ${socialHtml}
        <div class="share-row">${profileShareBtn}
          <button class="mode-link-btn" style="font-size:.8rem" onclick="startDuelFrom('${p.name.replace(/'/g,"\\'")}')">⚔ Challenge</button>
        </div>
      </div>
    </div>

    ${rankBanner}

    <div class="cards-row">
      <div class="stat-card">
        <div class="label">Overall Avg</div>
        <div class="value">${overallAvg}</div>
        <div class="sub-value">raw score</div>
      </div>
      <div class="stat-card">
        <div class="label">Global Z ${zLabel('')}</div>
        <div class="value">${wtZ}</div>
        <div class="sub-value">${totalFights} fights total</div>
      </div>
      <div class="stat-card">
        <div class="label">Tournaments</div>
        <div class="value">${p.years.length}</div>
        <div class="sub-value">${yearsStr}</div>
      </div>
    </div>

    ${radarSection}

    <div class="section-title">Scores by Role</div>
    <table class="role-table">
      <thead><tr><th>Role</th><th>Avg Score</th><th># Fights</th></tr></thead>
      <tbody>${roleRows}${roleTotalRow}</tbody>
    </table>

    <div class="section-title">By Tournament</div>
    <div class="year-cards">${yearCards}</div>
  `;
}

// ── Competitor Hub ────────────────────────────────────────────────────────────

async function loadCompetitorHub(name) {
  showView('view-hub');
  $('hub-content').innerHTML = '<div class="loader">Loading…</div>';
  try {
    const p = await apiFetch(`/api/participant/${encodeURIComponent(name)}`);
    $('hub-content').innerHTML = renderCompetitorHub(p);
    $('hub-content').querySelectorAll('[data-action]').forEach(el => {
      el.addEventListener('click', () => {
        const action = el.dataset.action;
        if (action === 'profile') loadProfile(p.name);
        else if (action === 'duel') {
          showView('view-home');
          document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
          document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
          const t = document.querySelector('[data-tab="duel"]');
          if (t) { t.classList.add('active'); $('tab-duel').classList.add('active'); }
          $('inp-duel-a').value = p.name;
          $('inp-duel-b').focus();
        } else if (action === 'dreamteam') {
          showView('view-home');
          document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
          document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
          const t = document.querySelector('[data-tab="dreamteam"]');
          if (t) { t.classList.add('active'); $('tab-dreamteam').classList.add('active'); }
          $('inp-dt-r').value = p.name;
          $('inp-dt-o').focus();
        }
      });
    });
  } catch (err) {
    showError(err.message);
    showView('view-home');
  }
}

function renderCompetitorHub(p) {
  const latestTeam = p.years_data?.[p.years_data.length - 1]?.team || '';
  const flag = countryFlag(latestTeam) || '';
  const avatarContent = flag || initials(p.name);
  const avatarStyle = flag ? 'font-size:2rem;background:var(--surface)' : '';

  // Best stat
  const roles = ['Reporter', 'Opponent', 'Reviewer'];
  const totalFights = roles.reduce((acc, r) =>
    acc + p.years_data.reduce((a, y) => a + (y.performances_count?.[r] || 0), 0), 0);
  const wtZ = p.global_z != null ? p.global_z.toFixed(2) : null;
  const statLine = wtZ != null ? `Global Z: ${wtZ >= 0 ? '+' : ''}${wtZ} · ${totalFights} fights · ${p.years.length} tournament${p.years.length > 1 ? 's' : ''}` : `${totalFights} fights · ${p.years.length} tournament${p.years.length > 1 ? 's' : ''}`;

  return `
    <div class="hub-header">
      <div class="hub-avatar" style="${avatarStyle}">${avatarContent}</div>
      <div class="hub-name">${p.name}</div>
      <div class="hub-sub">${latestTeam}${latestTeam ? ' · ' : ''}${p.years.join(', ')}</div>
      <div class="hub-sub" style="margin-top:4px">${statLine}</div>
    </div>
    <div class="hub-choices">
      <div class="hub-choice" data-action="profile">
        <div class="hub-choice-icon">📊</div>
        <div class="hub-choice-title">Check my performance</div>
        <div class="hub-choice-desc">See your full stats, role breakdown, and how you ranked against all participants</div>
      </div>
      <div class="hub-choice" data-action="duel">
        <div class="hub-choice-icon">⚔</div>
        <div class="hub-choice-title">Duel a rival</div>
        <div class="hub-choice-desc">Pick any participant from IYPT history for a head-to-head role-by-role showdown</div>
      </div>
      <div class="hub-choice" data-action="dreamteam">
        <div class="hub-choice-icon">🤝</div>
        <div class="hub-choice-title">Build a Dream Team</div>
        <div class="hub-choice-desc">Assemble a team with your friends and see where it ranks in IYPT history</div>
      </div>
    </div>
  `;
}

// ── Team Profile ──────────────────────────────────────────────────────────────

$('btn-team').addEventListener('click', () => {
  const name = getTeam();
  if (!name) { showError('Enter a team name'); return; }
  loadTeam(name);
});

async function loadTeam(name) {
  showView('view-team');
  $('team-content').innerHTML = '<div class="loader">Loading…</div>';
  try {
    const [data, intel, peers] = await Promise.all([
      apiFetch(`/api/team/${encodeURIComponent(name)}`),
      apiFetch(`/api/team/${encodeURIComponent(name)}/intelligence`).catch(() => null),
      apiFetch(`/api/team/${encodeURIComponent(name)}/peers`).catch(() => null),
    ]);
    $('team-content').innerHTML = renderTeam(data, intel, peers);
    bindTeamContent(data, peers);
    // Position calculator: wire after render
    if (peers) {
      setTimeout(() => {
        const inp = document.getElementById('pos-climb-input');
        if (inp) {
          renderPosCalcResult(peers, parseInt(inp.value) || 1);
          inp.addEventListener('input', () => {
            renderPosCalcResult(peers, Math.max(1, Math.min(peers.above.length, parseInt(inp.value) || 1)));
          });
        }
      }, 0);
    }
    // Use event delegation on team-content so the handler survives intel section re-renders
    $('team-content').addEventListener('change', async e => {
      if (e.target.id !== 'team-intel-year-filter') return;
      const minYear = e.target.value ? parseInt(e.target.value) : null;
      const selectedVal = e.target.value;
      const intelSection = document.getElementById('team-intel-section');
      if (!intelSection) return;
      intelSection.innerHTML = '<div class="loader" style="padding:12px">Loading…</div>';
      const newIntel = await apiFetch(`/api/team/${encodeURIComponent(data.team)}/intelligence${minYear ? `?min_year=${minYear}` : ''}`).catch(() => null);
      intelSection.innerHTML = renderTeamIntelligence(newIntel, data.years, selectedVal);
      // Restore the selected value after re-render
      const sel = document.getElementById('team-intel-year-filter');
      if (sel) sel.value = selectedVal;
    });
  } catch (err) {
    showError(err.message);
    showView('view-home');
  }
}

function bindTeamContent(data, peers) {
  $('team-content').querySelectorAll('[data-participant]').forEach(el => {
    el.addEventListener('click', () => loadProfile(el.dataset.participant));
  });
  $('team-content').querySelectorAll('[data-team]').forEach(el => {
    el.addEventListener('click', () => loadTeam(el.dataset.team));
  });
}

const _CAT_COLORS = {
  'Mechanics':        '#5b8dee', 'Fluid Dynamics':   '#00b894',
  'Waves & Acoustics':'#fd79a8', 'Thermodynamics':   '#e17055',
  'Electromagnetism': '#a29bfe', 'Optics':           '#fdcb6e',
  'Quantum & Modern': '#00cec9', 'Other':            '#636e72',
};

function renderTeam(t, intel, peers) {
  const roles = ['Reporter', 'Opponent', 'Reviewer'];

  const yearSections = t.years_data.map(y => {
    const rankStr = y.final_rank ? `Final rank: #${y.final_rank.rank} · ${fmt(y.final_rank.tsp)} pts` : '';
    const roleColors = { Reporter: 'var(--accent)', Opponent: 'var(--accent2)', Reviewer: 'var(--green)' };
    const memberRows = Object.entries(y.members).map(([member, roleData]) => {
      const chips = roles
        .filter(r => roleData[r])
        .map(r => `<span class="member-role-chip" style="background:${roleColors[r]}20;color:${roleColors[r]};border:1px solid ${roleColors[r]}40">${r}</span>`)
        .join('');
      return `<div class="member-row">
        <span class="member-name" data-participant="${member}">${member}</span>
        <div class="member-scores">${chips}</div>
      </div>`;
    }).join('');

    return `<div class="team-year-card">
      <div class="team-year-header">
        <span class="year-badge">${y.year}</span>
        <span style="color:var(--muted);font-size:.88rem">${rankStr}</span>
      </div>
      ${memberRows}
    </div>`;
  }).join('');

  const teamFlag = countryFlag(t.team);
  const teamAvatarContent = teamFlag || t.team.slice(0,2).toUpperCase();
  const teamAvatarStyle = teamFlag ? 'background:var(--surface);font-size:1.8rem' : 'font-size:1.1rem';

  const prepSection = renderTeamPrep(t, peers);
  const intelInner = renderTeamIntelligence(intel, t.years, '');

  return `
    <div class="profile-header">
      <div class="profile-avatar" style="${teamAvatarStyle}">${teamAvatarContent}</div>
      <div>
        <div class="profile-name">${t.team}</div>
        <div class="profile-years">${t.years.join(', ')}</div>
      </div>
    </div>
    ${prepSection}
    <div id="team-intel-section">${intelInner}</div>
    <div class="section-title">Team Members by Year</div>
    ${yearSections}
  `;
}

function renderPosCalcResult(peers, n) {
  const el = document.getElementById('pos-calc-result');
  if (!el) return;
  const target = peers.above[n - 1];
  if (!target) { el.innerHTML = ''; return; }

  const roles = [
    { label: 'Reporter', ourAvg: peers.reporter_avg, theirAvg: target.reporter_avg, color: 'var(--accent)' },
    { label: 'Opponent', ourAvg: peers.opponent_avg, theirAvg: target.opponent_avg, color: 'var(--accent2)' },
    { label: 'Reviewer', ourAvg: peers.reviewer_avg, theirAvg: target.reviewer_avg, color: 'var(--green)' },
  ];

  const rankStr = target.final_rank ? `#${target.final_rank} ` : '';
  const rows = roles.map(r => {
    const ours = r.ourAvg, theirs = r.theirAvg;
    if (ours == null && theirs == null) return '';
    const delta = (theirs != null && ours != null) ? theirs - ours : null;
    const ahead = delta != null && delta <= 0;
    const col = ahead ? 'var(--green)' : 'var(--red)';
    const deltaStr = delta != null
      ? (ahead
          ? `already ahead by ${Math.abs(delta).toFixed(2)} pts`
          : `need +${delta.toFixed(2)} pts (${ours != null ? ours.toFixed(2) : '—'} → ${theirs.toFixed(2)})`)
      : '—';
    return `<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border)">
      <span style="color:${r.color};font-weight:700;min-width:76px;font-size:.88rem">${r.label}</span>
      <span style="color:${col};font-size:.88rem">${deltaStr}</span>
    </div>`;
  }).filter(Boolean).join('');

  el.innerHTML = `<div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:14px 18px">
    <div style="font-size:.82rem;color:var(--muted);margin-bottom:10px">
      Target: <strong style="color:var(--text)">${rankStr}${target.team_name}</strong>
      ${target.team_avg != null ? `· their avg: ${target.team_avg.toFixed(2)}` : ''}
      ${peers.team_avg != null ? `· yours: ${peers.team_avg.toFixed(2)}` : ''}
    </div>
    ${rows || '<span style="color:var(--muted);font-size:.85rem">No role data available</span>'}
  </div>`;
}

function renderTeamPrep(t, peers) {
  const roles = ['Reporter', 'Opponent', 'Reviewer'];
  const roleColors = { Reporter: 'var(--accent)', Opponent: 'var(--accent2)', Reviewer: 'var(--green)' };

  // Use most recent year
  const lastYear = t.years_data[t.years_data.length - 1];
  if (!lastYear) return '';

  // ── Role health: avg z per role across all members ────────────────────────
  const roleZLists = { Reporter: [], Opponent: [], Reviewer: [] };
  for (const [, roleData] of Object.entries(lastYear.members)) {
    for (const role of roles) {
      if (roleData[role]?.z_avg != null) roleZLists[role].push(roleData[role].z_avg);
    }
  }
  const roleAvgZ = {};
  for (const role of roles) {
    const arr = roleZLists[role];
    roleAvgZ[role] = arr.length ? arr.reduce((a, b) => a + b) / arr.length : null;
  }

  function zColor(z) {
    if (z == null) return 'var(--muted)';
    if (z >= 0.4) return 'var(--green)';
    if (z >= 0)   return 'var(--accent)';
    if (z >= -0.3) return '#fdcb6e';
    return 'var(--red)';
  }
  function barPct(z) { return Math.min(Math.abs(z ?? 0) / 1.5 * 100, 100); }

  const roleRows = roles.map(role => {
    const z = roleAvgZ[role];
    const sign = z != null ? (z >= 0 ? '+' : '') : '';
    const col = zColor(z);
    const pct = z != null ? barPct(z) : 0;
    return `<div class="role-health-row">
      <span class="rhb-label" style="color:${roleColors[role]}">${role}</span>
      <div class="rhb-track"><div class="rhb-fill" style="width:${pct.toFixed(1)}%;background:${col}"></div></div>
      <span class="rhb-val" style="color:${col}">${z != null ? `${sign}${z.toFixed(2)}` : '—'}</span>
    </div>`;
  }).join('');

  // Weakest role alert
  const rankedRoles = roles.map(r => ({ role: r, z: roleAvgZ[r] })).filter(r => r.z != null).sort((a, b) => a.z - b.z);
  let roleAlert = '';
  if (rankedRoles.length) {
    const weak = rankedRoles[0];
    if (weak.z < -0.1) {
      roleAlert = `<div class="prep-alert prep-alert-warn">⚠ <strong>${weak.role}</strong> is your weakest role (z = ${weak.z.toFixed(2)}). Focus training on ${weak.role === 'Reporter' ? 'presentation and problem depth' : weak.role === 'Opponent' ? 'asking sharp questions and engaging presenters' : 'structured evaluation and feedback'}.</div>`;
    } else {
      const strong = rankedRoles[rankedRoles.length - 1];
      roleAlert = `<div class="prep-alert prep-alert-ok">✓ All roles are at or above average. Strongest: <strong>${strong.role}</strong> (z = ${strong.z >= 0 ? '+' : ''}${strong.z.toFixed(2)}).</div>`;
    }
  }

  // ── Team depth analysis ───────────────────────────────────────────────────
  const memberZ = Object.entries(lastYear.members).map(([name, roleData]) => {
    const zVals = roles.map(r => roleData[r]?.z_avg).filter(z => z != null);
    const avg = zVals.length ? zVals.reduce((a, b) => a + b) / zVals.length : null;
    return { name, z: avg };
  }).filter(m => m.z != null).sort((a, b) => b.z - a.z);

  const maxZ = memberZ[0]?.z ?? 0;
  const minZ = memberZ[memberZ.length - 1]?.z ?? 0;
  const spread = maxZ - minZ;
  const starDependent = spread > 0.5 && maxZ > 0.3;

  const depthBars = memberZ.map(m => {
    const col = zColor(m.z);
    const pct = Math.min(Math.abs(m.z) / 1.5 * 100, 100);
    const sign = m.z >= 0 ? '+' : '';
    return `<div class="depth-row">
      <span class="depth-name" data-participant="${m.name}" title="${m.name}">${m.name}</span>
      <div class="depth-track"><div class="depth-fill" style="width:${pct.toFixed(1)}%;background:${col}"></div></div>
      <span class="depth-val" style="color:${col}">${sign}${m.z.toFixed(2)}</span>
    </div>`;
  }).join('');

  const depthAlert = starDependent
    ? `<div class="prep-alert prep-alert-warn">⚠ Performance is concentrated. <strong>${memberZ[0].name}</strong> leads significantly — develop depth so the team isn't reliant on one person.</div>`
    : memberZ.length > 0
      ? `<div class="prep-alert prep-alert-ok">✓ Balanced team — performance is well distributed across members.</div>`
      : '';

  // ── Peer teams ────────────────────────────────────────────────────────────
  let peerHtml = '';
  if (peers) {
    const peerYear = peers.year;
    const all = [
      ...peers.above.map(p => ({ ...p, isAbove: true })),
      { team_name: peers.team, team_z: peers.team_z, final_rank: peers.final_rank, isOurs: true },
      ...peers.below.map(p => ({ ...p, isAbove: false })),
    ];
    const peerItems = all.map(p => {
      const zSign = p.team_z != null ? (p.team_z >= 0 ? '+' : '') : '';
      const zStr = p.team_z != null ? `${zSign}${p.team_z.toFixed(2)}` : '—';
      const zCol = zColor(p.team_z);
      const rankStr = p.final_rank ? `#${p.final_rank}` : '—';
      if (p.isOurs) {
        return `<div class="peer-item peer-our">
          <span class="peer-rank">${rankStr}</span>
          <span class="peer-name">▶ ${p.team_name}</span>
          <span class="peer-z" style="color:${zCol}">${zStr}</span>
        </div>`;
      }
      const cls = p.isAbove ? 'peer-item peer-above' : 'peer-item';
      return `<div class="${cls}" data-team="${p.team_name}">
        <span class="peer-rank">${rankStr}</span>
        <span class="peer-name">${p.team_name}</span>
        <span class="peer-z" style="color:${zCol}">${zStr}</span>
      </div>`;
    }).join('');
    const rankInField = peers.rank_in_field, total = peers.total_teams;
    peerHtml = `<div>
      <div class="prep-section-label">Peer Teams · ${peerYear}</div>
      <div style="color:var(--muted);font-size:.78rem;margin-bottom:8px">
        Ranked by avg z-score across all fights in ${peerYear} (judge-normalized). Your team is #${rankInField} of ${total}.
        Teams above are closer rivals to overtake; teams below are chasing you.
      </div>
      <div class="peer-list-header" style="display:flex;justify-content:space-between;padding:0 10px 4px;font-size:.7rem;color:var(--muted);text-transform:uppercase;letter-spacing:.4px">
        <span>Rank · Team</span><span>Avg Z</span>
      </div>
      <div class="peer-list">${peerItems}</div>
      <div class="prep-alert prep-alert-info" style="margin-top:8px">💡 Click a team to view their Physics Intelligence and identify where they outperform you.</div>
    </div>`;
  }

  // ── Position improvement calculator ──────────────────────────────────────
  let posCalcHtml = '';
  if (peers && peers.above && peers.above.length > 0) {
    const maxClimb = peers.above.length;
    posCalcHtml = `<div style="margin-top:18px" id="pos-calc-wrap">
      <div class="prep-section-label">What it takes to climb</div>
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px;flex-wrap:wrap">
        <span style="color:var(--muted);font-size:.85rem">I want to move up</span>
        <input type="number" id="pos-climb-input" min="1" max="${maxClimb}" value="1"
          style="width:64px;padding:6px 10px;background:var(--card);border:1px solid var(--border);border-radius:var(--radius);color:var(--text);font-size:.9rem;text-align:center">
        <span style="color:var(--muted);font-size:.85rem">place${maxClimb > 1 ? 's' : ''} (max ${maxClimb})</span>
      </div>
      <div id="pos-calc-result"></div>
    </div>`;
  }

  return `<div class="prep-dashboard">
    <div class="prep-header">📊 Scouting Report — ${lastYear.year}</div>
    <div class="prep-grid">
      <div>
        <div class="prep-section-label">Role Performance (${lastYear.year})</div>
        ${roleRows}
        ${roleAlert}
      </div>
      <div>
        <div class="prep-section-label">Team Depth (${lastYear.year})</div>
        ${depthBars || '<span style="color:var(--muted);font-size:.85rem">No data</span>'}
        ${depthAlert}
      </div>
    </div>
    ${peers ? `<div style="margin-top:18px">${peerHtml}</div>` : ''}
    ${posCalcHtml}
  </div>`;
}

function renderTeamIntelligence(intel, teamYears, currentFilterVal) {
  // Always render the year-filter row (even with no data)
  const yearOpts = teamYears && teamYears.length > 1
    ? `<option value="">All years</option>` + teamYears.map(y => `<option value="${y}">${y}</option>`).join('')
    : '';
  const yearFilterRow = yearOpts ? `<div class="intel-year-row">
    <span class="intel-year-label">Year filter:</span>
    <select class="rk-year-select" id="team-intel-year-filter" style="padding:5px 10px;font-size:.82rem">
      ${yearOpts}
    </select>
  </div>` : '';

  if (!intel) {
    return `<div class="section-title">Physics Intelligence</div>${yearFilterRow}<div style="color:var(--muted);font-size:.85rem;margin-top:8px">No physics data available for this team.</div>`;
  }
  const cats = intel.categories.filter(c => c.reporter_count > 0 || c.opponent_count > 0);
  if (!cats.length) {
    return `<div class="section-title">Physics Intelligence</div>${yearFilterRow}<div style="color:var(--muted);font-size:.85rem;margin-top:8px">No categorized problem data for this filter.</div>`;
  }

  const repMu = intel.reporter_overall_z;
  const oppMu = intel.opponent_overall_z;

  // score = absolute z for this category; mu = team's overall role z (for deviation tooltip)
  function bar(score, mu, count, sig, p) {
    if (score == null) return `<span class="intel-na">—</span>`;

    // Significance tiers
    const reliable = count >= 3;
    const significant = !!sig;

    // Number color: vivid when significant, faded when n.s., very muted when too few fights
    let col;
    if (!reliable)       col = 'var(--muted)';
    else if (significant) col = score >= 0 ? 'var(--green)' : 'var(--red)';
    else                  col = score >= 0 ? 'rgba(0,200,90,.6)' : 'rgba(255,100,100,.6)';

    const sign = score >= 0 ? '+' : '';

    // Centered bar: |z|=2 fills one full half; |z|=0 = nothing
    const halfPct = Math.min(Math.abs(score) / 2 * 50, 50);
    const barColor = score >= 0 ? 'var(--green)' : 'var(--red)';
    const barOpacity = significant ? 1 : (reliable ? 0.3 : 0.12);
    const fillStyle = score >= 0
      ? `left:50%;width:${halfPct.toFixed(1)}%;`
      : `right:50%;width:${halfPct.toFixed(1)}%;`;

    // Badge: sig stars, n.s., or "few" for tiny samples
    let badge;
    if (!reliable) {
      badge = `<span class="intel-badge intel-badge-few" title="Only ${count} fight(s) — too few for reliable testing">few</span>`;
    } else if (!significant) {
      badge = `<span class="intel-badge intel-badge-ns" title="Not statistically significant (p>0.05 vs team's own role mean)">n.s.</span>`;
    } else {
      badge = `<span class="intel-badge intel-badge-sig" title="p=${p != null ? p.toFixed(3) : '?'} — one-sample t-test vs team mean">${sig}</span>`;
    }

    // Deviation from team avg shown on hover of the score number
    const devTip = (mu != null) ? ` title="Absolute z: ${sign}${score.toFixed(2)} | vs team avg: ${(score-mu)>=0?'+':''}${(score-mu).toFixed(2)}"` : '';

    return `<span class="intel-score" style="color:${col}"${devTip}>${sign}${score.toFixed(2)}</span><div class="intel-bar2"><div class="intel-bar2-fill" style="${fillStyle}background:${barColor};opacity:${barOpacity}"></div></div><span class="intel-count">(n=${count})</span>${badge}`;
  }

  const rows = cats.map(c => {
    const color = _CAT_COLORS[c.category] || '#888';
    return `<tr>
      <td><span class="intel-cat-dot" style="background:${color}"></span>${c.category}</td>
      <td class="intel-cell">${bar(c.reporter_avg_z, repMu, c.reporter_count, c.reporter_sig, c.reporter_p)}</td>
      <td class="intel-cell">${bar(c.opponent_avg_z, oppMu, c.opponent_count, c.opponent_sig, c.opponent_p)}</td>
    </tr>`;
  }).join('');

  const filterNote = intel.min_year ? ` · since ${intel.min_year}` : '';
  return `
    <div class="section-title">Physics Intelligence
      <span class="info-tip" data-tip="Z-score = performance normalized across all judges in the tournament. 0 = tournament average. Positive = above average, negative = below. Bar extends from center: right = good, left = bad. Hover a score to see deviation from team's own mean. Sig. badge = statistically significant vs the team's own role average (t-test: * p&lt;0.05 ** p&lt;0.01 *** p&lt;0.001). n.s. = not significant. few = sample too small.">ⓘ</span>
    </div>
    ${yearFilterRow}
    <div class="intel-note">Z-score per category (0 = tournament avg)${filterNote}. Hover score for team-relative deviation.</div>
    <div class="intel-table-wrap">
      <table class="intel-table">
        <thead><tr><th>Category</th><th>Reporter</th><th>Opponent (Challenger)</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

// ── Compare Teams ─────────────────────────────────────────────────────────────

$('btn-compare-t').addEventListener('click', () => {
  const a = getCtA(), b = getCtB();
  if (!a || !b) { showError('Enter both team names'); return; }
  loadCompareTeams(a, b);
});

async function loadCompareTeams(a, b) {
  showView('view-compare-t');
  $('compare-t-content').innerHTML = '<div class="loader">Loading…</div>';
  try {
    const data = await apiFetch(`/api/compare/teams?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`);
    $('compare-t-content').innerHTML = renderCompareTeams(data);
    $('compare-t-content').querySelectorAll('[data-participant]').forEach(el => {
      el.addEventListener('click', () => loadProfile(el.dataset.participant));
    });
  } catch (err) {
    showError(err.message);
    showView('view-home');
  }
}

function renderCompareTeams(data) {
  const { a, b } = data;

  function renderTeamSide(team) {
    return team.years_data.map(y => {
      const rankStr = y.final_rank ? `#${y.final_rank.rank}` : '—';
      const members = Object.entries(y.members).map(([name, roles]) => {
        const scores = Object.entries(roles).map(([r, d]) =>
          d.avg != null ? `${r[0]}:${fmt(d.avg)}` : ''
        ).filter(Boolean).join(' ');
        return `<div class="member-row">
          <span class="member-name" data-participant="${name}">${name}</span>
          <span style="color:var(--muted);font-size:.8rem">${scores}</span>
        </div>`;
      }).join('');
      return `<div style="margin-bottom:14px">
        <div style="display:flex;justify-content:space-between;margin-bottom:8px">
          <span class="year-badge">${y.year}</span>
          <span style="color:var(--muted);font-size:.85rem">Rank ${rankStr}</span>
        </div>
        ${members}
      </div>`;
    }).join('');
  }

  return `
    <div class="compare-header">
      <h2>${a.team} vs ${b.team}</h2>
    </div>
    <div class="compare-grid">
      <div class="compare-col">
        <div class="compare-name" style="color:var(--accent)">${a.team}</div>
        ${renderTeamSide(a)}
      </div>
      <div class="vs-divider"><div class="vs-circle">VS</div></div>
      <div class="compare-col">
        <div class="compare-name" style="color:var(--accent)">${b.team}</div>
        ${renderTeamSide(b)}
      </div>
    </div>
  `;
}

// ── Duel ──────────────────────────────────────────────────────────────────────

$('btn-duel').addEventListener('click', () => {
  const a = getDuelA(), b = getDuelB();
  if (!a || !b) { showError('Enter both fighters'); return; }
  if (a.toLowerCase() === b.toLowerCase()) { showError('Pick two different fighters'); return; }
  loadDuel(a, b);
});

function startDuelFrom(name) {
  showView('view-home');
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === 'duel'));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.toggle('active', c.id === 'tab-duel'));
  $('inp-duel-a').value = name;
  $('inp-duel-b').value = '';
  setTimeout(() => $('inp-duel-b').focus(), 80);
}

async function loadDuel(a, b) {
  showView('view-duel');
  $('duel-content').innerHTML = '<div class="loader">Loading…</div>';
  try {
    const data = await apiFetch(`/api/compare/participants?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`);
    $('duel-content').innerHTML = renderDuel(data);
    $('duel-content').querySelectorAll('[data-participant]').forEach(el => {
      el.addEventListener('click', () => loadProfile(el.dataset.participant));
    });
    animateDuel(data);
  } catch (err) {
    showError(err.message);
    showView('view-home');
  }
}

function renderDuel(data) {
  const { a, b } = data;
  const roles = ['Reporter', 'Opponent', 'Reviewer'];
  const Z_SPLIT_TIP = 'Lost on raw average, but adjusted z-score was higher — this performance was stronger relative to how strict the judges were.';

  function pFlag(profile) { return countryFlag(profile.years_data?.[0]?.team || '') || ''; }
  function pAvatar(profile) {
    const f = pFlag(profile);
    return f ? `<div class="duel-fighter-avatar">${f}</div>`
             : `<div class="duel-fighter-avatar" style="font-size:1.3rem;font-weight:700">${initials(profile.name)}</div>`;
  }
  function pAvg(profile) {
    const vals = roles.map(r => profile.overall_role_avg[r]).filter(v => v != null);
    return vals.length ? vals.reduce((s, v) => s + v) / vals.length : null;
  }

  // Per-role results — round to 2 dp before comparing to avoid float precision bugs
  const roleResults = roles.map(r => {
    const avgA = a.overall_role_avg[r], avgB = b.overall_role_avg[r];
    const zA = a.overall_z_avg[r],   zB = b.overall_z_avg[r];
    const cmpA = avgA != null ? Math.round(avgA * 100) : null;
    const cmpB = avgB != null ? Math.round(avgB * 100) : null;
    let winner = null;
    let zDecided = false;
    if (cmpA != null && cmpB != null) {
      if (cmpA > cmpB) winner = 'a';
      else if (cmpA < cmpB) winner = 'b';
      else {
        // Avg tie — z-score is the tiebreaker
        if (zA != null && zB != null) {
          if (zA > zB)      { winner = 'a'; zDecided = true; }
          else if (zB > zA) { winner = 'b'; zDecided = true; }
          else                winner = 'tie';
        } else if (zA != null) { winner = 'a'; zDecided = true; }
        else if (zB != null)   { winner = 'b'; zDecided = true; }
        else                     winner = 'tie';
      }
    } else if (cmpA != null) winner = 'a';
    else if (cmpB != null)   winner = 'b';
    // z-split bonus only applies when avg decides (not when z already decided a tie)
    const zSplitB = !zDecided && winner === 'a' && zA != null && zB != null && zB > zA;
    const zSplitA = !zDecided && winner === 'b' && zA != null && zB != null && zA > zB;
    return { r, winner, zSplitA, zSplitB, avgA, avgB, zDecided };
  });

  // Score: avg winner gets 1pt; if z contradicts avg the avg-loser also gets 1pt
  let scoreA = 0, scoreB = 0;
  roleResults.forEach(({ winner, zSplitA, zSplitB }) => {
    if (winner === 'a') { scoreA += 1; if (zSplitB) scoreB += 1; }
    else if (winner === 'b') { scoreB += 1; if (zSplitA) scoreA += 1; }
    else if (winner === 'tie') { scoreA += 0.5; scoreB += 0.5; }
  });

  const overallWinner = scoreA > scoreB ? 'a' : scoreB > scoreA ? 'b' : null;

  // Fighter cards
  const teamA = a.years_data?.[0]?.team || '', teamB = b.years_data?.[0]?.team || '';
  const avgA = pAvg(a), avgB = pAvg(b);

  function fighterCard(profile, side, team, avg) {
    return `<div class="duel-fighter" data-side="${side}">
      ${pAvatar(profile)}
      <div class="duel-fighter-name" data-participant="${profile.name}" style="cursor:pointer;color:var(--accent)">${profile.name}</div>
      <div class="duel-fighter-meta">${team}${team ? ' · ' : ''}${profile.years.join(', ')}</div>
      <div class="duel-fighter-score">${fmt(avg)}</div>
      <div class="duel-fighter-score-label">overall avg</div>
    </div>`;
  }

  // Category cards: winner sorted to top, loser below with optional z-bonus chip
  const Z_DECIDED_TIP = 'Raw averages were equal; adjusted z-score broke the tie.';
  function entry(profile, side, avg, isWinner, zBonus, isTie, zWon) {
    const flag = pFlag(profile);
    const cls = isTie ? 'duel-entry-tie' : (isWinner ? 'duel-entry-win' : (avg != null ? 'duel-entry-lose' : ''));
    const badge = isWinner ? ' 🏆' : (isTie ? ' =' : '');
    const zEl = zBonus ? `<span class="duel-z-bonus" data-tip="${Z_SPLIT_TIP}">⚡ z+</span>`
              : zWon   ? `<span class="duel-z-decided" data-tip="${Z_DECIDED_TIP}">⚡ z</span>` : '';
    return `<div class="duel-cat-entry ${cls}">
      <span class="duel-entry-flag">${flag}</span>
      <span class="duel-entry-name">${profile.name.split(' ')[0]}</span>
      <span class="duel-entry-score">${avg != null ? fmt(avg) : '—'}${badge}</span>
      ${zEl}
    </div>`;
  }

  const catCards = roleResults.map(({ r, winner, zSplitA, zSplitB, avgA, avgB, zDecided }) => {
    let top, bottom;
    if (winner === 'a') {
      top    = entry(a, 'a', avgA, true,  false,   false, zDecided);
      bottom = entry(b, 'b', avgB, false, zSplitB, false, false);
    } else if (winner === 'b') {
      top    = entry(b, 'b', avgB, true,  false,   false, zDecided);
      bottom = entry(a, 'a', avgA, false, zSplitA, false, false);
    } else if (winner === 'tie') {
      top    = entry(a, 'a', avgA, false, false, true,  false);
      bottom = entry(b, 'b', avgB, false, false, true,  false);
    } else {
      top    = entry(a, 'a', avgA, false, false, false, false);
      bottom = entry(b, 'b', avgB, false, false, false, false);
    }
    return `<div class="duel-cat-card">
      <div class="duel-cat-title">${r}</div>
      ${top}${bottom}
    </div>`;
  }).join('');

  // Verdict
  const sc = s => Number.isInteger(s) ? s : s.toFixed(1);
  const splits = roleResults.filter(r => r.zSplitA || r.zSplitB).length;
  const verdictText = overallWinner
    ? `🏆 ${overallWinner === 'a' ? a.name : b.name} wins  ${sc(scoreA)} – ${sc(scoreB)}`
    : `🤝 Draw  ${sc(scoreA)} – ${sc(scoreB)}`;
  const verdictSub = splits > 0
    ? `⚡ ${splits} categor${splits > 1 ? 'ies' : 'y'} had a judge-adjusted bonus point (z+)`
    : 'Scores based on average across each role';
  const duelShareBtn = shareBtn({ duel: a.name, vs: b.name }, '🔗 Share this duel');

  return `
    <div class="duel-arena duel-animated" data-winner-side="${overallWinner || ''}">
      <div class="duel-header"><h2>⚔ DUEL RESULT ⚔</h2></div>
      <div class="duel-fighters">
        ${fighterCard(a, 'a', teamA, avgA)}
        <div class="duel-vs"><div class="duel-vs-circle">VS</div></div>
        ${fighterCard(b, 'b', teamB, avgB)}
      </div>
      <div class="duel-cats">${catCards}</div>
      <div class="duel-verdict">
        <div class="duel-verdict-text">${verdictText}</div>
        <div class="duel-verdict-sub">${verdictSub}</div>
        <div class="share-row" style="justify-content:center;margin-top:14px">${duelShareBtn}</div>
      </div>
    </div>
  `;
}

function animateDuel(data) {
  const { a, b } = data;
  const roles = ['Reporter', 'Opponent', 'Reviewer'];
  const arena = $('duel-content').querySelector('.duel-arena');
  if (!arena) return;

  // Sort roles: less decisive first, most decisive (largest avg gap) last
  const gaps = roles.map(r => {
    const avgA = a.overall_role_avg[r], avgB = b.overall_role_avg[r];
    return { r, gap: (avgA != null && avgB != null) ? Math.abs(avgA - avgB) : -1 };
  }).sort((x, y) => x.gap - y.gap);

  const cardByRole = {};
  arena.querySelectorAll('.duel-cat-card').forEach(card => {
    const title = card.querySelector('.duel-cat-title')?.textContent?.trim();
    if (title) cardByRole[title] = card;
  });

  const revealOrder = gaps.map(g => cardByRole[g.r]).filter(Boolean);
  const delay = 800;

  revealOrder.forEach((card, i) => {
    setTimeout(() => card.classList.add('duel-revealed'), i * delay + 200);
  });

  const lastReveal = (revealOrder.length - 1) * delay + 200 + 600;

  setTimeout(() => {
    arena.querySelector('.duel-verdict')?.classList.add('duel-revealed');
    const winnerSide = arena.dataset.winnerSide;
    if (winnerSide) {
      arena.querySelector(`.duel-fighter[data-side="${winnerSide}"]`)?.classList.add('duel-winner');
    }
  }, lastReveal + 350);
}

// ── Dream Team ────────────────────────────────────────────────────────────────

async function loadDreamTeam(rName, oName, vName) {
  showView('view-dreamteam');
  $('dreamteam-content').innerHTML = '<div class="loader">Loading…</div>';
  try {
    const [rData, oData, vData, teamRanks] = await Promise.all([
      apiFetch(`/api/participant/${encodeURIComponent(rName)}`),
      apiFetch(`/api/participant/${encodeURIComponent(oName)}`),
      apiFetch(`/api/participant/${encodeURIComponent(vName)}`),
      apiFetch('/api/rankings/teams').catch(() => []),
    ]);
    $('dreamteam-content').innerHTML = renderDreamTeam(rData, oData, vData, teamRanks);
    $('dreamteam-content').querySelectorAll('[data-participant]').forEach(el => {
      el.addEventListener('click', () => loadProfile(el.dataset.participant));
    });
    // Wire vs-mode inputs after render
    const getDtVsR = autocomplete('inp-dtvs-r', 'sug-dtvs-r', 'participants', null);
    const getDtVsO = autocomplete('inp-dtvs-o', 'sug-dtvs-o', 'participants', null);
    const getDtVsV = autocomplete('inp-dtvs-v', 'sug-dtvs-v', 'participants', null);
    $('btn-dtvs')?.addEventListener('click', async () => {
      const r2 = getDtVsR(), o2 = getDtVsO(), v2 = getDtVsV();
      if (!r2 || !o2 || !v2) { showError('Enter all three names for the challenger team'); return; }
      const resEl = $('dtvs-result');
      resEl.innerHTML = '<div class="loader">Loading…</div>';
      try {
        const [rD2, oD2, vD2] = await Promise.all([
          apiFetch(`/api/participant/${encodeURIComponent(r2)}`),
          apiFetch(`/api/participant/${encodeURIComponent(o2)}`),
          apiFetch(`/api/participant/${encodeURIComponent(v2)}`),
        ]);
        resEl.innerHTML = renderDreamTeamVs(
          { reporter: rData, opponent: oData, reviewer: vData },
          { reporter: rD2, opponent: oD2, reviewer: vD2 },
          teamRanks
        );
        resEl.querySelectorAll('[data-participant]').forEach(el => {
          el.addEventListener('click', () => loadProfile(el.dataset.participant));
        });
      } catch (err) { showError(err.message); }
    });
  } catch (err) {
    showError(err.message);
  }
}

function renderDreamTeam(reporter, opponent, reviewer, teamRanks) {
  const roles = ['Reporter', 'Opponent', 'Reviewer'];
  const roleColors = { Reporter: 'var(--accent)', Opponent: 'var(--accent2)', Reviewer: 'var(--green)' };
  const roleBg    = { Reporter: 'rgba(91,141,238,.18)', Opponent: 'rgba(232,67,147,.18)', Reviewer: 'rgba(0,184,148,.18)' };
  const members   = [
    { profile: reporter,  role: 'Reporter',  roleKey: 'Reporter'  },
    { profile: opponent,  role: 'Opponent',  roleKey: 'Opponent'  },
    { profile: reviewer,  role: 'Reviewer',  roleKey: 'Reviewer'  },
  ];

  // Per-role z for each person in their assigned role
  function roleZ(p, role) {
    const v = p.overall_z_avg?.[role];
    if (v != null) return v;
    return p.overall_z_score ?? null;
  }
  function roleAvg(p, role) {
    const v = p.overall_role_avg?.[role];
    if (v != null) return v;
    return Object.values(p.overall_role_avg || {}).find(x => x != null) ?? null;
  }
  function roleN(p, role) {
    return p.years_data?.reduce((a, y) => a + (y.performances_count?.[role] || 0), 0) || 0;
  }

  const rZ = roleZ(reporter, 'Reporter');
  const oZ = roleZ(opponent, 'Opponent');
  const vZ = roleZ(reviewer, 'Reviewer');
  const validZ = [rZ, oZ, vZ].filter(z => z != null);
  const projZ = validZ.length ? validZ.reduce((a, b) => a + b) / validZ.length : null;

  const totalN = roleN(reporter, 'Reporter') + roleN(opponent, 'Opponent') + roleN(reviewer, 'Reviewer');
  const adjProjZ = projZ != null ? projZ * totalN / (totalN + 5) : null;

  // Rank projection from historical team z distribution
  let projRank = null, fieldSize = null;
  if (projZ != null && teamRanks?.length) {
    const zList = teamRanks.map(t => t.overall_z).filter(z => z != null).sort((a, b) => b - a);
    projRank = zList.filter(z => z > projZ).length + 1;
    fieldSize = zList.length;
  }

  // Tier label based on projected rank percentile
  function tierLabel(rank, total) {
    if (!rank || !total) return { text: 'Unranked', color: 'var(--muted)', bg: 'var(--surface)' };
    const pct = rank / total;
    if (pct <= 0.1)  return { text: 'Tournament Favorites 🥇', color: '#ffd700', bg: 'rgba(255,215,0,.12)' };
    if (pct <= 0.25) return { text: 'Strong Contenders 💪',    color: 'var(--green)',  bg: 'rgba(0,184,148,.12)' };
    if (pct <= 0.5)  return { text: 'Mid-Table Challengers ⚔', color: 'var(--accent)', bg: 'rgba(91,141,238,.12)' };
    if (pct <= 0.75) return { text: 'Fighting for Points',      color: 'var(--muted)',  bg: 'var(--surface)' };
    return { text: 'Building Experience 📈',                    color: 'var(--muted)',  bg: 'var(--surface)' };
  }
  const tier = tierLabel(projRank, fieldSize);

  // History bar: marker at (1 - rank/total) percent
  const histPct = (projRank && fieldSize) ? Math.max(2, Math.min(98, (1 - projRank / fieldSize) * 100)) : null;

  // Member cards
  const memberCards = members.map(({ profile: p, role, roleKey }) => {
    const z = roleZ(p, roleKey);
    const avg = roleAvg(p, roleKey);
    const n = roleN(p, roleKey);
    const zSign = z != null ? (z >= 0 ? '+' : '') : '';
    const zColor = z == null ? 'var(--muted)' : z >= 0.3 ? 'var(--green)' : z >= 0 ? 'var(--accent)' : z >= -0.3 ? '#fdcb6e' : 'var(--red)';
    const latestTeam = p.years_data?.[p.years_data.length - 1]?.team || '';
    const flag = countryFlag(latestTeam) || '';
    return `<div class="dt-member-card">
      <span class="dt-member-role-badge" style="background:${roleBg[role]};color:${roleColors[role]}">${role}</span>
      <div class="dt-member-name" data-participant="${p.name}">${p.name}</div>
      <div class="dt-member-team">${flag} ${latestTeam}</div>
      <div class="dt-member-stat" style="color:${zColor}">${z != null ? `${zSign}${z.toFixed(2)}` : '—'}</div>
      <div class="dt-member-sublabel">z-score as ${role}${n ? ` (${n} fights)` : ''}</div>
      ${avg != null ? `<div style="color:var(--muted);font-size:.75rem;margin-top:4px">avg ${avg.toFixed(2)}</div>` : ''}
    </div>`;
  }).join('');

  // Projection card
  const projSign = adjProjZ != null ? (adjProjZ >= 0 ? '+' : '') : '';
  const projectionCard = `<div class="dt-projection">
    <div class="dt-proj-label">Projected tournament position</div>
    <div class="dt-rank-huge">${projRank != null ? `#${projRank}` : '—'}</div>
    <div class="dt-rank-ctx">${fieldSize ? `out of ${fieldSize} teams in the IYPT historical field` : 'Not enough data'}</div>
    ${adjProjZ != null ? `<div style="color:var(--muted);font-size:.82rem;margin-top:6px">Combined Global Z: ${projSign}${adjProjZ.toFixed(2)}</div>` : ''}
    ${histPct != null ? `<div class="dt-hist-wrap">
      <div class="dt-hist-track">
        <div class="dt-hist-fill" style="width:100%"></div>
        <div class="dt-hist-pin" style="left:${histPct.toFixed(1)}%"></div>
      </div>
      <div class="dt-hist-labels"><span>Weakest</span><span>Strongest</span></div>
    </div>` : ''}
    <div class="dt-tier-badge" style="background:${tier.bg};color:${tier.color}">${tier.text}</div>
  </div>`;

  const dtShareBtn = shareBtn({ dt: reporter.name, dto: opponent.name, dtv: reviewer.name }, '🔗 Share Dream Team');
  const actionRow = `<div class="dt-actions">
    ${dtShareBtn}
    <button class="mode-link-btn" onclick="$('inp-dt-r').value='';$('inp-dt-o').value='';$('inp-dt-v').value='';showView('view-home');document.querySelector('[data-tab=dreamteam]').click()">↩ Change members</button>
    <button class="mode-link-btn" onclick="startDuelFrom('${reporter.name.replace(/'/g,"\\'")}')">⚔ Duel someone</button>
  </div>`;

  // Dream Team vs Dream Team challenge section
  const vsSection = `
    <div class="dt-vs-section">
      <div class="section-title" style="margin-top:24px">Challenge another Dream Team</div>
      <div class="dt-inputs" id="dt-vs-inputs">
        <div class="dt-role-group">
          <div class="dt-role-label rep-label">Reporter</div>
          <div class="autocomplete-wrap">
            <input id="inp-dtvs-r" type="text" placeholder="Reporter name…" autocomplete="off" />
            <ul id="sug-dtvs-r" class="suggestions hidden"></ul>
          </div>
        </div>
        <div class="dt-role-group">
          <div class="dt-role-label opp-label">Opponent</div>
          <div class="autocomplete-wrap">
            <input id="inp-dtvs-o" type="text" placeholder="Opponent name…" autocomplete="off" />
            <ul id="sug-dtvs-o" class="suggestions hidden"></ul>
          </div>
        </div>
        <div class="dt-role-group">
          <div class="dt-role-label rev-label">Reviewer</div>
          <div class="autocomplete-wrap">
            <input id="inp-dtvs-v" type="text" placeholder="Reviewer name…" autocomplete="off" />
            <ul id="sug-dtvs-v" class="suggestions hidden"></ul>
          </div>
        </div>
        <button id="btn-dtvs" class="btn-primary" style="align-self:flex-end;background:linear-gradient(135deg,#e84393,#ff6b6b)">⚔ Fight!</button>
      </div>
      <div id="dtvs-result"></div>
    </div>`;

  return `<div>
    <div class="dt-headline">Dream Team</div>
    <div class="dt-subhead">${reporter.name} · ${opponent.name} · ${reviewer.name}</div>
    <div class="dt-roster-grid">${memberCards}</div>
    ${projectionCard}
    ${actionRow}
    ${vsSection}
  </div>`;
}

function renderDreamTeamVs(teamA, teamB, teamRanks) {
  function teamProjZ(t) {
    const rZ = t.reporter.overall_z_avg?.['Reporter'] ?? t.reporter.overall_z_score ?? null;
    const oZ = t.opponent.overall_z_avg?.['Opponent'] ?? t.opponent.overall_z_score ?? null;
    const vZ = t.reviewer.overall_z_avg?.['Reviewer'] ?? t.reviewer.overall_z_score ?? null;
    const vals = [rZ, oZ, vZ].filter(z => z != null);
    return vals.length ? vals.reduce((a, b) => a + b) / vals.length : null;
  }

  const zA = teamProjZ(teamA), zB = teamProjZ(teamB);
  const zList = (teamRanks || []).map(t => t.overall_z).filter(z => z != null).sort((a, b) => b - a);
  function projRank(z) { return z != null && zList.length ? zList.filter(v => v > z).length + 1 : null; }
  const rankA = projRank(zA), rankB = projRank(zB);
  const field = zList.length;

  function side(t, z, rank, label) {
    const sign = z != null ? (z >= 0 ? '+' : '') : '';
    const col = z == null ? 'var(--muted)' : z >= 0.3 ? 'var(--green)' : z >= 0 ? 'var(--accent)' : 'var(--red)';
    const members = `${t.reporter.name} (R) · ${t.opponent.name} (O) · ${t.reviewer.name} (V)`;
    return `<div style="flex:1;background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:18px;text-align:center">
      <div style="font-size:.72rem;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">${label}</div>
      <div style="font-size:.85rem;color:var(--muted);margin-bottom:14px">${members}</div>
      <div style="font-size:3.5rem;font-weight:900;color:${col};line-height:1">${rank != null ? `#${rank}` : '—'}</div>
      <div style="color:var(--muted);font-size:.8rem;margin-top:4px">${field ? `of ${field} teams` : ''}</div>
      <div style="font-size:.82rem;font-weight:700;color:${col};margin-top:8px">${z != null ? `Global Z: ${sign}${z.toFixed(2)}` : '—'}</div>
    </div>`;
  }

  const winnerA = zA != null && zB != null && zA > zB;
  const winnerB = zA != null && zB != null && zB > zA;
  const verdict = winnerA ? `🏆 Team A wins!` : winnerB ? `🏆 Team B wins!` : `🤝 It's a draw!`;
  const margin = zA != null && zB != null ? Math.abs(zA - zB).toFixed(3) : null;

  return `<div style="margin-top:18px">
    <div style="display:flex;gap:14px;align-items:stretch;flex-wrap:wrap">
      ${side(teamA, zA, rankA, 'Team A')}
      <div style="display:flex;align-items:center;flex-shrink:0;padding:0 8px">
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:50%;width:44px;height:44px;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:.85rem">VS</div>
      </div>
      ${side(teamB, zB, rankB, 'Team B')}
    </div>
    <div style="text-align:center;margin-top:16px;font-size:1.1rem;font-weight:700">${verdict}${margin ? ` <span style="color:var(--muted);font-size:.82rem;font-weight:400">margin: ${margin} z</span>` : ''}</div>
  </div>`;
}

// ── Jury / Problem Analytics ─────────────────────────────────────────────────

let _juryYears = [];

async function loadJury(minYear) {
  showView('view-jury');
  $('jury-content').innerHTML = '<div class="loader">Loading…</div>';
  try {
    if (!_juryYears.length) {
      _juryYears = await apiFetch('/api/rankings/years').catch(() => []);
    }
    const param = minYear ? `?min_year=${minYear}` : '';
    const data = await apiFetch(`/api/analytics/problems${param}`);
    $('jury-content').innerHTML = renderJury(data, minYear || '');
    renderJuryCharts(data);
    $('jury-content').querySelector('#jury-year-filter')?.addEventListener('change', e => {
      const v = e.target.value ? parseInt(e.target.value) : undefined;
      loadJury(v);
    });
  } catch (err) {
    showError(err.message);
    $('jury-content').innerHTML = `<div style="color:var(--red)">${err.message}</div>`;
  }
}

function renderJury(data, currentYear) {
  const yearOpts = `<option value="">All years</option>` +
    _juryYears.map(y => `<option value="${y}" ${String(y) === String(currentYear) ? 'selected' : ''}>${y}</option>`).join('');

  const catColors = _CAT_COLORS;

  // All values use relative z (= absolute z minus the role baseline)
  // so 0 means "average for a reporter", positive = above reporter average
  const repBase = data.rep_baseline_z ?? 0;
  const baseNote = `0 = average reporter (baseline ${repBase >= 0 ? '+' : ''}${repBase.toFixed(2)} tournament z)`;

  // Top 10 most-presented problems
  const sorted = [...data.problems].sort((a, b) => b.n_presented - a.n_presented);
  const top10 = sorted.slice(0, 10);
  const topRows = top10.map(p => {
    const col = catColors[p.category] || '#888';
    const rel = p.rep_rel_z;
    const zSign = rel != null ? (rel >= 0 ? '+' : '') : '';
    const zCol = rel == null ? 'var(--muted)' : rel >= 0.15 ? 'var(--green)' : rel >= -0.15 ? '#fdcb6e' : 'var(--red)';
    return `<tr>
      <td>${p.year}</td>
      <td><span class="prob-cat-dot" style="background:${col}"></span>${p.name}</td>
      <td><span style="color:${col};font-size:.78rem">${p.category}</span></td>
      <td>${p.n_presented}</td>
      <td style="color:${zCol};font-weight:600">${rel != null ? `${zSign}${rel.toFixed(2)}` : '—'}</td>
    </tr>`;
  }).join('');

  // Top 5 highest rel-z and bottom 5 lowest rel-z
  const withZ = data.problems.filter(p => p.rep_rel_z != null && p.n_presented >= 2);
  const highZ = [...withZ].sort((a, b) => b.rep_rel_z - a.rep_rel_z).slice(0, 5);
  const lowZ  = [...withZ].sort((a, b) => a.rep_rel_z - b.rep_rel_z).slice(0, 5);

  function zRow(p, isHigh) {
    const col = catColors[p.category] || '#888';
    const sign = p.rep_rel_z >= 0 ? '+' : '';
    const valCol = isHigh ? 'var(--green)' : 'var(--red)';
    return `<tr>
      <td>${p.year}</td>
      <td><span class="prob-cat-dot" style="background:${col}"></span>${p.name}</td>
      <td style="font-weight:700;color:${valCol}">${sign}${p.rep_rel_z.toFixed(2)}</td>
    </tr>`;
  }

  return `
    <div class="jury-header">
      <div class="jury-title">⚖️ Problem Analytics</div>
      <div class="jury-sub">Explore which problems are most presented and how they score</div>
    </div>
    <div class="jury-filters">
      <span class="intel-year-label">Filter from year:</span>
      <select class="rk-year-select" id="jury-year-filter" style="padding:5px 10px;font-size:.82rem">${yearOpts}</select>
    </div>
    <div class="jury-grid">
      <div class="jury-section">
        <div class="jury-section-title">Problems by Category — times presented</div>
        <div class="jury-chart-wrap"><canvas id="chart-jury-cats"></canvas></div>
      </div>
      <div class="jury-section">
        <div class="jury-section-title">Reporter performance by category <span style="font-weight:400;font-size:.72rem;color:var(--muted)">(relative to reporter avg · ${baseNote})</span></div>
        <div class="jury-chart-wrap"><canvas id="chart-jury-z"></canvas></div>
      </div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-bottom:24px">
      <div class="jury-section">
        <div class="jury-section-title">Easiest to present well <span style="font-weight:400;font-size:.72rem;color:var(--muted)">(rel. to reporter avg)</span></div>
        <table class="prob-table">
          <thead><tr><th>Year</th><th>Problem</th><th>Rel. Z</th></tr></thead>
          <tbody>${highZ.map(p => zRow(p, true)).join('')}</tbody>
        </table>
      </div>
      <div class="jury-section">
        <div class="jury-section-title">Hardest to present well <span style="font-weight:400;font-size:.72rem;color:var(--muted)">(rel. to reporter avg)</span></div>
        <table class="prob-table">
          <thead><tr><th>Year</th><th>Problem</th><th>Rel. Z</th></tr></thead>
          <tbody>${lowZ.map(p => zRow(p, false)).join('')}</tbody>
        </table>
      </div>
    </div>
    <div class="jury-section" style="margin-bottom:24px">
      <div class="jury-section-title">Top 10 most-presented problems</div>
      <div style="overflow-x:auto"><table class="prob-table">
        <thead><tr><th>Year</th><th>Problem</th><th>Category</th><th>Times presented</th><th>Rel. Z (Reporter)</th></tr></thead>
        <tbody>${topRows}</tbody>
      </table></div>
    </div>
  `;
}

function renderJuryCharts(data) {
  const C = window.Chart;
  if (!C) return;
  const gridColor = 'rgba(46,51,80,.6)', textColor = '#7a7f9a';

  // Category bar — times presented
  const catsEl = document.getElementById('chart-jury-cats');
  if (catsEl) {
    const existing = C.getChart(catsEl); if (existing) existing.destroy();
    const cats = data.categories.filter(c => c.n_presented > 0);
    new C(catsEl, {
      type: 'bar',
      data: {
        labels: cats.map(c => c.category),
        datasets: [{ label: 'Times presented', data: cats.map(c => c.n_presented),
          backgroundColor: cats.map(c => (_CAT_COLORS[c.category] || '#888') + 'bb'),
          borderColor:     cats.map(c => _CAT_COLORS[c.category] || '#888'),
          borderWidth: 1.5, borderRadius: 4 }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        scales: {
          x: { ticks: { color: textColor, font: { size: 10 } }, grid: { color: gridColor } },
          y: { ticks: { color: textColor }, grid: { color: gridColor } },
        },
        plugins: { legend: { display: false }, tooltip: { callbacks: { title: i => i[0].label } } },
      },
    });
  }

  // Category relative z-score bar (relative to reporter baseline)
  const zEl = document.getElementById('chart-jury-z');
  if (zEl) {
    const existing = C.getChart(zEl); if (existing) existing.destroy();
    const cats = data.categories.filter(c => c.rep_rel_z != null);
    const absMax = Math.max(...cats.map(c => Math.abs(c.rep_rel_z)), 0.1);
    const yRange = Math.max(Math.ceil(absMax * 1.3 * 10) / 10, 0.2);
    new C(zEl, {
      type: 'bar',
      data: {
        labels: cats.map(c => c.category),
        datasets: [{ label: 'Relative reporter Z', data: cats.map(c => c.rep_rel_z),
          backgroundColor: cats.map(c => {
            const z = c.rep_rel_z;
            return z >= 0.15 ? 'rgba(0,184,148,.75)' : z >= -0.15 ? 'rgba(253,203,110,.75)' : 'rgba(255,107,107,.75)';
          }),
          borderColor: cats.map(c => {
            const z = c.rep_rel_z;
            return z >= 0.15 ? '#00b894' : z >= -0.15 ? '#fdcb6e' : '#ff6b6b';
          }),
          borderWidth: 1.5, borderRadius: 4 }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        scales: {
          x: { ticks: { color: textColor, font: { size: 10 } }, grid: { color: gridColor } },
          y: { min: -yRange, max: yRange, ticks: { color: textColor }, grid: { color: gridColor },
               title: { display: true, text: 'Rel. Z', color: textColor, font: { size: 10 } } },
        },
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: ctx => {
            const sign = ctx.raw >= 0 ? '+' : '';
            return `${sign}${ctx.raw.toFixed(3)} vs reporter avg`;
          }}},
        },
      },
    });
  }
}

// ── Role Distribution Analysis ───────────────────────────────────────────────

document.getElementById('btn-load-role-analysis')?.addEventListener('click', loadRoleAnalysis);

async function loadRoleAnalysis() {
  const el = $('role-analysis-content');
  el.innerHTML = '<div class="loader">Loading…</div>';
  try {
    const data = await apiFetch('/api/analytics/role-stats');
    el.innerHTML = renderRoleAnalysis(data);
    renderRoleCharts(data);
  } catch (err) {
    el.innerHTML = `<div class="error">${err.message}</div>`;
  }
}

function renderRoleAnalysis(data) {
  const { roles, role_means, anova, ranking_comparison, total_participants } = data;
  const ROLE_COLORS = { Reporter: 'var(--accent)', Opponent: 'var(--accent2)', Reviewer: 'var(--green)' };

  const badges = roles.map(rs => {
    const col = ROLE_COLORS[rs.role] || 'var(--muted)';
    const meanStr = rs.mean != null ? (rs.mean >= 0 ? '+' : '') + rs.mean.toFixed(4) : '—';
    const stdStr  = rs.std  != null ? '±' + rs.std.toFixed(4) : '';
    return `<div class="role-mean-badge">
      <div class="rmb-role" style="color:${col}">${rs.role}</div>
      <div class="rmb-mean" style="color:${col}">${meanStr}</div>
      <div class="rmb-n">${stdStr} · n=${rs.n.toLocaleString()}</div>
    </div>`;
  }).join('');

  const f = anova.f != null ? anova.f.toFixed(2) : '—';
  const p = anova.p != null ? anova.p.toFixed(6) : '—';
  const sig = anova.p != null && anova.p < 0.05;
  const sigLabel = anova.p != null
    ? (anova.p < 0.001 ? 'p < 0.001 — highly significant' : sig ? `p = ${p} — significant` : `p = ${p} — not significant`)
    : '—';
  const anovaHtml = `<div class="anova-result">
    <strong>One-way ANOVA</strong>: F = ${f}, ${sigLabel}.<br>
    <span style="color:var(--muted);font-size:.82rem">
      ${sig
        ? 'Role means differ significantly — role adjustment would affect rankings.'
        : 'Role means do not differ significantly — role adjustment likely unnecessary.'}
    </span>
  </div>`;

  const rankRows = ranking_comparison.map(r => {
    const change = r.rank_change;
    const changeStr = change == null ? '—'
      : change > 0 ? `<span class="rank-up">▲${change}</span>`
      : change < 0 ? `<span class="rank-down">▼${Math.abs(change)}</span>`
      : `<span class="rank-same">—</span>`;
    const adjSign = r.adj_z != null && r.adj_z >= 0 ? '+' : '';
    return `<tr>
      <td>${r.current_rank}</td>
      <td>${r.name}</td>
      <td>${r.current_z >= 0 ? '+' : ''}${r.current_z.toFixed(3)}</td>
      <td>${r.adj_rank ?? '—'}</td>
      <td>${r.adj_z != null ? adjSign + r.adj_z.toFixed(3) : '—'}</td>
      <td>${changeStr}</td>
    </tr>`;
  }).join('');

  return `
    <div class="role-mean-badges">${badges}</div>
    ${anovaHtml}
    <div class="role-charts-grid">
      <div class="role-chart-card">
        <div class="section-title" style="font-size:.82rem;margin-bottom:8px">Per-role Z-score distributions</div>
        <canvas id="chart-role-dist" style="max-height:200px"></canvas>
      </div>
      <div class="role-chart-card">
        <div class="section-title" style="font-size:.82rem;margin-bottom:8px">Per-role mean Z (with ±1 SD)</div>
        <canvas id="chart-role-means" style="max-height:200px"></canvas>
      </div>
    </div>
    <div class="section-title" style="font-size:.88rem;margin-bottom:8px">
      Top 30 ranking: Raw Adj Z vs Global Z
      <span style="color:var(--muted);font-weight:400;font-size:.78rem">(rank change = raw rank − Global Z rank; ▲ = rises with role correction)</span>
    </div>
    <table class="role-rank-table">
      <thead><tr><th>#</th><th>Name</th><th>Raw Adj Z</th><th>Global Z #</th><th>Global Z</th><th>Change</th></tr></thead>
      <tbody>${rankRows}</tbody>
    </table>
  `;
}

function renderRoleCharts(data) {
  const C = window.Chart;
  if (!C) return;
  const gridColor = 'rgba(46,51,80,.6)', textColor = '#7a7f9a';
  const ROLE_COLORS = {
    Reporter: { bg: 'rgba(91,141,238,.35)', border: '#5b8dee' },
    Opponent: { bg: 'rgba(124,92,224,.35)', border: '#7c5ce0' },
    Reviewer: { bg: 'rgba(0,184,148,.35)',  border: '#00b894' },
  };

  // Distribution histograms (overlaid lines)
  const distEl = document.getElementById('chart-role-dist');
  if (distEl) {
    const ex = C.getChart(distEl); if (ex) ex.destroy();
    const labels = data.roles[0]?.histogram.map(h => h.bin_center.toFixed(1)) ?? [];
    const datasets = data.roles.map(rs => ({
      label: rs.role,
      data: rs.histogram.map(h => h.count),
      borderColor: ROLE_COLORS[rs.role]?.border,
      backgroundColor: ROLE_COLORS[rs.role]?.bg,
      fill: true,
      tension: 0.35,
      pointRadius: 0,
      borderWidth: 2,
    }));
    new C(distEl, {
      type: 'line',
      data: { labels, datasets },
      options: {
        responsive: true, maintainAspectRatio: false,
        scales: {
          x: { title: { display: true, text: 'Z-score', color: textColor, font: { size: 10 } }, ticks: { color: textColor, maxTicksLimit: 8 }, grid: { color: gridColor } },
          y: { title: { display: true, text: 'Count', color: textColor, font: { size: 10 } }, ticks: { color: textColor }, grid: { color: gridColor } },
        },
        plugins: { legend: { labels: { color: textColor, boxWidth: 12, font: { size: 11 } } } },
      },
    });
  }

  // Mean + SD bar chart
  const meansEl = document.getElementById('chart-role-means');
  if (meansEl) {
    const ex = C.getChart(meansEl); if (ex) ex.destroy();
    const rs = data.roles.filter(r => r.mean != null);
    new C(meansEl, {
      type: 'bar',
      data: {
        labels: rs.map(r => r.role),
        datasets: [{
          label: 'Mean Z',
          data: rs.map(r => r.mean),
          backgroundColor: rs.map(r => ROLE_COLORS[r.role]?.bg),
          borderColor:     rs.map(r => ROLE_COLORS[r.role]?.border),
          borderWidth: 2, borderRadius: 4,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        scales: {
          x: { ticks: { color: textColor }, grid: { color: gridColor } },
          y: { ticks: { color: textColor }, grid: { color: gridColor },
               title: { display: true, text: 'Mean Z-score', color: textColor, font: { size: 10 } } },
        },
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: ctx => {
            const r = rs[ctx.dataIndex];
            return [`Mean: ${ctx.raw >= 0 ? '+' : ''}${ctx.raw.toFixed(4)}`, `SD: ±${r.std.toFixed(4)}`, `n = ${r.n.toLocaleString()}`];
          }}},
        },
      },
    });
  }
}

// ── Analytics / World Map ────────────────────────────────────────────────────

const _CENTROIDS = {
  'Australia':       [-25.0,  135.0], 'Austria':         [ 47.5,   14.5],
  'Brazil':          [-10.0,  -53.0], 'Bulgaria':        [ 42.7,   25.5],
  'Canada':          [ 60.0,  -95.0], 'China':           [ 35.0,  105.0],
  'Chinese Taipei':  [ 23.5,  121.0], 'Croatia':         [ 45.1,   16.4],
  'Czech Republic':  [ 49.8,   15.5], 'Czechia':         [ 49.8,   15.5],
  'Georgia':         [ 42.0,   43.5], 'Germany':         [ 51.0,   10.0],
  'Greece':          [ 39.0,   22.0], 'Hong Kong':       [ 22.3,  114.2],
  'Hungary':         [ 47.0,   19.5], 'India':           [ 22.0,   78.0],
  'Iran':            [ 32.0,   53.0], 'Italy':           [ 42.8,   12.8],
  'Kazakhstan':      [ 48.0,   68.0], 'Korea':           [ 36.5,  127.5],
  'Macao':           [ 22.2,  113.5], 'Mexico':          [ 23.0, -102.0],
  'Nepal':           [ 28.0,   84.0], 'New Zealand':     [-42.0,  174.0],
  'Pakistan':        [ 30.0,   69.0], 'Poland':          [ 51.9,   19.1],
  'Romania':         [ 45.9,   24.9], 'Serbia':          [ 44.0,   21.0],
  'Singapore':       [  1.35, 103.8], 'Slovakia':        [ 48.7,   19.7],
  'Slovenia':        [ 46.1,   14.8], 'South Africa':    [-29.0,   25.0],
  'Sweden':          [ 60.0,   15.0], 'Switzerland':     [ 46.8,    8.2],
  'Thailand':        [ 15.0,  101.0], 'Turkey':          [ 39.0,   35.0],
  'TÃ¼rkiye': [ 39.0, 35.0], 'USA':             [ 38.0,  -97.0],
  'Uganda':          [  1.3,   32.0], 'Ukraine':         [ 49.0,   31.5],
  'United Kingdom':  [ 54.0,   -2.0], 'Uzbekistan':      [ 41.4,   64.6],
  'Russia':          [ 60.0,   90.0], 'Japan':           [ 36.0,  138.0],
  'France':          [ 46.2,    2.2], 'Netherlands':     [ 52.1,    5.3],
  'Belarus':         [ 53.7,   27.9], 'Lithuania':       [ 55.9,   23.9],
  'Latvia':          [ 56.9,   24.6], 'Estonia':         [ 58.6,   25.0],
  'Finland':         [ 64.0,   26.0], 'Norway':          [ 65.0,   13.0],
  'Denmark':         [ 56.0,   10.0], 'Portugal':        [ 39.6,   -8.0],
  'Spain':           [ 40.0,   -4.0], 'Belgium':         [ 50.8,    4.0],
  'Israel':          [ 31.5,   35.0], 'Philippines':     [ 13.0,  122.0],
  'Indonesia':       [ -2.5,  118.0], 'Malaysia':        [  3.0,  110.0],
  'Vietnam':         [ 16.0,  108.0], 'Bangladesh':      [ 24.0,   90.0],
  'Sri Lanka':       [  7.0,   81.0], 'Taiwan':          [ 23.5,  121.0],
  'Argentina':       [-34.0,  -64.0], 'Chile':           [-30.0,  -71.0],
  'Colombia':        [  4.0,  -72.0], 'Peru':            [-10.0,  -76.0],
  'Morocco':         [ 32.0,   -5.0], 'Egypt':           [ 27.0,   30.0],
  'Nigeria':         [ 10.0,    8.0], 'Kenya':           [  1.0,   38.0],
};

function _zColor(z) {
  if (z == null)  return '#4a4f6e';
  if (z >= 1.0)   return '#00b894';
  if (z >= 0.3)   return '#55efc4';
  if (z >= -0.3)  return '#fdcb6e';
  if (z >= -1.0)  return '#e17055';
  return '#d63031';
}

let _leafletMap = null;

const _asState = { year: 'all', teams: [], data: [], yearData: null, years: [], chart: null, yearsLoaded: false, tlYear: null, tlPlaying: false, tlTimer: null };
const _YEAR_COLORS = ['#a29bfe', '#e17055', '#00cec9', '#5b8dee', '#00b894', '#fd79a8', '#fdcb6e'];
const _AS_COLORS = ['#fd79a8', '#fdcb6e', '#00cec9', '#e17055', '#a29bfe'];
// Per-team hue families: pink, cyan, green, amber, purple — vary lightness across years
const _TEAM_HUES = [340, 190, 130, 38, 270];
function _teamYearColor(teamIndex, yearIndex, totalYears) {
  const hue = _TEAM_HUES[teamIndex % _TEAM_HUES.length];
  const l = Math.round(45 + yearIndex * (35 / Math.max(totalYears - 1, 1)));
  return `hsl(${hue},78%,${l}%)`;
}

document.querySelectorAll('.tab').forEach(tab => {
  if (tab.dataset.tab === 'analytics') {
    tab.addEventListener('click', loadAnalytics);
  }
});

// Year selector for scatter
$('as-year-select').addEventListener('change', async e => {
  _asState.year = e.target.value;
  tlStopTimer();
  _asState.tlYear = null;
  _asState.tlChartReady = false;
  await loadAnalyticsScatterData();
  renderAnalyticsTimeline();
});

// Team autocomplete for scatter
autocomplete('inp-as-team', 'sug-as-team', 'teams', name => {
  $('inp-as-team').value = '';
  addAnalyticsTeam(name);
});

async function loadAnalytics() {
  // Scatter: load years + data once
  if (!_asState.yearsLoaded) {
    _asState.yearsLoaded = true;
    try {
      const years = await apiFetch('/api/rankings/years');
      _asState.years = years;
      const sel = $('as-year-select');
      sel.innerHTML = `<option value="all">All Years</option>` +
        years.map(y => `<option value="${y}">${y}</option>`).join('');
    } catch { /* ignore */ }
    await loadAnalyticsScatterData();
  }

  // Map: defer to next animation frame so the tab container has been painted
  // and Leaflet can measure real dimensions (fixes grey-box on display:none→block)
  requestAnimationFrame(initLeafletMap);
}

function initLeafletMap() {
  const L = window.L;
  if (!L) {
    $('map-container').innerHTML = '<p style="color:var(--muted);padding:20px">Map library not available — check internet connection.</p>';
    return;
  }

  if (_leafletMap) {
    _leafletMap.invalidateSize();
    return;
  }

  _leafletMap = L.map('map-container', { center: [25, 15], zoom: 2, minZoom: 1, maxZoom: 7 });
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>',
    subdomains: 'abcd', maxZoom: 19,
  }).addTo(_leafletMap);

  apiFetch('/api/map/countries').then(data => {
    data.forEach(row => {
      const latlng = _CENTROIDS[row.team];
      if (!latlng) return;
      const z = row.overall_z;
      const avg = row.overall_avg ?? 6;
      const radius = Math.max(4, 10 + (avg - 6) * 4);
      const sign = z != null && z >= 0 ? '+' : '';
      L.circleMarker(latlng, {
        radius, fillColor: _zColor(z),
        color: 'rgba(255,255,255,0.25)', weight: 1, fillOpacity: 0.85,
      })
      .bindTooltip(`<b>${row.team}</b><br>Avg: ${avg.toFixed(2)}  Z: ${z != null ? sign + z.toFixed(3) : '—'}`, { sticky: true })
      .on('click', () => loadTeam(row.team))
      .addTo(_leafletMap);
    });
    const grades = [
      { label: '≥ +1.0', color: '#00b894' }, { label: '+0.3 – +1.0', color: '#55efc4' },
      { label: '±0.3',   color: '#fdcb6e' }, { label: '−1.0 – −0.3', color: '#e17055' },
      { label: '≤ −1.0', color: '#d63031' },
    ];
    $('map-legend').innerHTML = '<div class="map-legend">' +
      grades.map(g => `<span class="map-legend-dot" style="background:${g.color}"></span><span>${g.label}</span>`).join('') +
      '<span style="color:var(--muted);font-size:.75rem;margin-left:8px">· circle size = avg score</span></div>';
  }).catch(() => showError('Failed to load map data'));
}

async function loadAnalyticsScatterData() {
  try {
    if (_asState.year === 'all' && _asState.years.length > 0) {
      const results = await Promise.all(
        _asState.years.map(y => apiFetch(`/api/rankings/participants?year=${y}`).then(d => ({ year: y, data: d })))
      );
      _asState.yearData = results;
      _asState.data = [];
    } else {
      const yearParam = _asState.year === 'all' ? '' : `?year=${_asState.year}`;
      _asState.data = await apiFetch(`/api/rankings/participants${yearParam}`);
      _asState.yearData = null;
    }
    renderAnalyticsScatter();
  } catch (e) {
    showError('Failed to load scatter data');
  }
}

function addAnalyticsTeam(name) {
  if (_asState.teams.length >= 5) { showError('Max 5 teams at once'); return; }
  if (_asState.teams.some(t => t.name === name)) return;
  const color = _AS_COLORS[_asState.teams.length];
  _asState.teams.push({ name, color });
  _asState.tlChartReady = false; // team list changed — must rebuild
  renderAnalyticsChips();
  renderAnalyticsTimeline();
  renderAnalyticsScatter();
}

function removeAnalyticsTeam(name) {
  _asState.teams = _asState.teams.filter(t => t.name !== name);
  _asState.teams.forEach((t, i) => { t.color = _AS_COLORS[i]; });
  if (_asState.teams.length === 0) { tlStopTimer(); _asState.tlYear = null; }
  _asState.tlChartReady = false; // team list changed — must rebuild
  renderAnalyticsChips();
  renderAnalyticsTimeline();
  renderAnalyticsScatter();
}

function renderAnalyticsChips() {
  $('as-chips').innerHTML = _asState.teams.map(t =>
    `<span class="as-chip" style="background:${t.color}22;color:${t.color};border:1px solid ${t.color}55">
      ${t.name}
      <span class="as-chip-remove" data-team="${t.name}">×</span>
    </span>`
  ).join('');
  $('as-chips').querySelectorAll('.as-chip-remove').forEach(btn => {
    btn.addEventListener('click', () => removeAnalyticsTeam(btn.dataset.team));
  });
}

// ── Timeline controls ─────────────────────────────────────────────────────────

function tlStopTimer() {
  if (_asState.tlTimer) { clearInterval(_asState.tlTimer); _asState.tlTimer = null; }
  _asState.tlPlaying = false;
}

function tlAdvanceTo(year) {
  _asState.tlYear = year;
  renderAnalyticsTimeline();
  // If the chart is already built in timeline mode, just update point visibility in-place
  if (_asState.tlChartReady) {
    _tlUpdateHighlight();
  } else {
    renderAnalyticsScatter(); // first entry into timeline mode — builds the chart
  }
}

function _tlUpdateHighlight() {
  const { chart, teams, tlYear } = _asState;
  if (!chart || !_asState.tlChartReady) return;
  // Dataset 0 = background (never changes). Datasets 1..N = one per team.
  teams.forEach((t, ti) => {
    const ds = chart.data.datasets[ti + 1];
    if (!ds || !Array.isArray(ds.pointRadius)) return;
    ds.data.forEach((pt, i) => {
      const on = pt.year === tlYear;
      ds.backgroundColor[i] = on ? t.color : 'rgba(0,0,0,0)';
      ds.borderColor[i]      = on ? t.color : 'rgba(0,0,0,0)';
      ds.pointRadius[i]      = on ? 9  : 0;
      ds.pointHoverRadius[i] = on ? 11 : 0;
    });
  });
  chart.update('none');
}

function tlPlay() {
  const years = (_asState.yearData || []).map(yd => yd.year);
  if (!years.length) return;
  tlStopTimer();
  const atEnd = _asState.tlYear === years[years.length - 1];
  if (_asState.tlYear == null || !years.includes(_asState.tlYear) || atEnd) _asState.tlYear = years[0];
  _asState.tlPlaying = true;
  renderAnalyticsTimeline();
  // Build (or keep) the timeline chart; first tick may need a build
  if (!_asState.tlChartReady) renderAnalyticsScatter();
  else _tlUpdateHighlight();
  _asState.tlTimer = setInterval(() => {
    const cur = (_asState.yearData || []).map(yd => yd.year);
    const idx = cur.indexOf(_asState.tlYear);
    if (idx < 0 || idx >= cur.length - 1) { tlStopTimer(); renderAnalyticsTimeline(); return; }
    _asState.tlYear = cur[idx + 1];
    renderAnalyticsTimeline();
    _tlUpdateHighlight();
  }, 1600);
}

function tlPause() {
  tlStopTimer();
  renderAnalyticsTimeline();
}

function tlSetYear(year) {
  tlStopTimer();
  tlAdvanceTo(year);
}

function renderAnalyticsTimeline() {
  const el = $('as-timeline');
  if (!el) return;
  const { teams, yearData, year, tlYear, tlPlaying } = _asState;
  const years = yearData ? yearData.map(yd => yd.year) : [];

  if (year !== 'all' || !yearData || teams.length === 0 || years.length === 0) {
    el.classList.remove('visible');
    el.innerHTML = '';
    return;
  }

  el.classList.add('visible');
  const curIdx = tlYear != null ? years.indexOf(tlYear) : -1;
  const showingAll = tlYear == null;

  const pips = years.map((y, i) =>
    `<div class="as-tl-pip${i === curIdx ? ' active' : ''}" data-y="${y}" title="${y}"></div>`
  ).join('');

  el.innerHTML = `
    <button class="as-tl-btn" id="as-tl-prev" ${curIdx <= 0 ? 'disabled' : ''}>◀</button>
    <div class="as-tl-year">${showingAll ? 'All' : tlYear}</div>
    <button class="as-tl-btn" id="as-tl-next" ${curIdx >= years.length - 1 && !showingAll ? 'disabled' : ''}>▶</button>
    <button class="as-tl-btn${tlPlaying ? ' tl-active' : ''}" id="as-tl-play">${tlPlaying ? '⏸ Pause' : '▶ Play'}</button>
    ${!showingAll ? `<button class="as-tl-btn" id="as-tl-all">All Years</button>` : ''}
    <div class="as-tl-bar">${pips}</div>
  `;

  el.querySelector('#as-tl-prev').onclick = () => {
    if (showingAll) return;
    tlSetYear(years[Math.max(0, curIdx - 1)]);
  };
  el.querySelector('#as-tl-next').onclick = () => {
    if (showingAll) tlSetYear(years[0]);
    else tlSetYear(years[Math.min(years.length - 1, curIdx + 1)]);
  };
  el.querySelector('#as-tl-play').onclick = () => tlPlaying ? tlPause() : tlPlay();
  el.querySelector('#as-tl-all')?.addEventListener('click', () => {
    tlStopTimer(); _asState.tlYear = null; renderAnalyticsTimeline(); renderAnalyticsScatter();
  });
  el.querySelectorAll('.as-tl-pip').forEach(pip => {
    pip.onclick = () => tlSetYear(parseInt(pip.dataset.y));
  });
}

function renderAnalyticsScatter() {
  const C = window.Chart;
  if (!C) return;
  const el = document.getElementById('chart-as');
  if (!el) return;

  const card = document.getElementById('chart-as-card');
  if (card) {
    const top = card.getBoundingClientRect().top;
    card.style.height = Math.max(window.innerHeight - top - 24, 280) + 'px';
  }

  if (_asState.chart) { _asState.chart.destroy(); _asState.chart = null; }
  _asState.tlChartReady = false;

  const { data, yearData, teams, tlYear } = _asState;
  const gridColor = 'rgba(46,51,80,.6)', textColor = '#7a7f9a';
  const timelineMode = tlYear != null && yearData && yearData.length > 0 && teams.length > 0;

  function toPoint(r, year) {
    return { x: r.overall_avg, y: r.global_z ?? null, name: r.name, team: r.team, year: year ?? null };
  }
  function isTeamMember(r, tName) {
    return r.team === tName || (r.team && r.team.split(',').map(s => s.trim()).includes(tName));
  }
  function hasData(r) { return r.overall_avg != null && r.overall_z != null; }

  let xScaleOpts = {}, yScaleOpts = {};
  let bgDatasets, teamDatasets = [];

  if (timelineMode) {
    // ── TIMELINE MODE ──────────────────────────────────────────────────────────
    // Build ALL points once across all years. Only point visibility changes per frame.
    // Background: all participants (all years) minus team members — stays constant.
    // Team datasets: all years' points, per-point color/radius arrays toggled by _tlUpdateHighlight.
    const allYrData = yearData;
    const allPts = allYrData.flatMap(yd => yd.data.filter(hasData).map(r => toPoint(r, yd.year)));
    const xs = allPts.map(p => p.x).filter(v => v != null);
    const ys = allPts.map(p => p.y).filter(v => v != null);
    if (xs.length && ys.length) {
      xScaleOpts = { min: Math.floor(Math.min(...xs) - 0.5), max: Math.ceil(Math.max(...xs) + 0.5) };
      const yAbsMax = Math.max(...ys.map(Math.abs));
      const yRange = Math.max(Math.ceil(yAbsMax * 1.3 * 10) / 10, 0.5);
      yScaleOpts = { min: -yRange, max: yRange };
    }

    // Background: all non-team participants across all years
    const bgPts = allYrData.flatMap(yd =>
      yd.data.filter(r => hasData(r) && !teams.some(t => isTeamMember(r, t.name))).map(r => toPoint(r, yd.year))
    );
    bgDatasets = [{ label: 'Others', data: bgPts, backgroundColor: 'rgba(120,120,160,.15)', borderColor: 'rgba(120,120,160,.22)', pointRadius: 3, pointHoverRadius: 5, order: teams.length + 1 }];

    // Team datasets: all years' points, initially colored for tlYear only
    teams.forEach((t, ti) => {
      const pts = allYrData.flatMap(yd =>
        yd.data.filter(r => hasData(r) && isTeamMember(r, t.name)).map(r => toPoint(r, yd.year))
      );
      const colors = pts.map(p => p.year === tlYear ? t.color : 'rgba(0,0,0,0)');
      const radii  = pts.map(p => p.year === tlYear ? 9 : 0);
      teamDatasets.push({
        label: t.name,
        data: pts,
        backgroundColor: colors,
        borderColor: [...colors],
        pointRadius: radii,
        pointHoverRadius: pts.map(p => p.year === tlYear ? 11 : 0),
        order: teams.length - ti,
      });
    });
    _asState.tlChartReady = true;

  } else if (yearData && yearData.length > 0 && teams.length === 0) {
    // ── ALL YEARS, NO TEAMS ────────────────────────────────────────────────────
    bgDatasets = yearData.map((yd, i) => {
      const col = _YEAR_COLORS[i % _YEAR_COLORS.length];
      return { label: String(yd.year), data: yd.data.filter(hasData).map(r => toPoint(r, yd.year)), backgroundColor: col + '55', borderColor: col, pointRadius: 5, pointHoverRadius: 7, order: yearData.length - i };
    });

  } else if (teams.length > 0 && yearData && yearData.length > 0) {
    // ── ALL YEARS + TEAMS (no animation) ──────────────────────────────────────
    const bgPts = yearData.flatMap(yd => yd.data.filter(r => hasData(r) && !teams.some(t => isTeamMember(r, t.name))).map(r => toPoint(r)));
    bgDatasets = [{ label: 'Others', data: bgPts, backgroundColor: 'rgba(120,120,160,.18)', borderColor: 'rgba(120,120,160,.30)', pointRadius: 4, pointHoverRadius: 6, order: teams.length + 1 }];
    yearData.forEach((yd, i) => {
      teams.forEach((t, ti) => {
        const col = teams.length === 1 ? _YEAR_COLORS[i % _YEAR_COLORS.length] : _teamYearColor(ti, i, yearData.length);
        const src = yd.data.filter(r => hasData(r) && isTeamMember(r, t.name)).map(r => toPoint(r));
        if (!src.length) return;
        teamDatasets.push({ label: teams.length === 1 ? String(yd.year) : `${t.name} · ${yd.year}`, data: src, backgroundColor: col, borderColor: col, pointRadius: 8, pointHoverRadius: 10, order: teams.length - ti });
      });
    });

  } else {
    // ── SINGLE YEAR ────────────────────────────────────────────────────────────
    const bgPts = data.filter(r => hasData(r) && !teams.some(t => isTeamMember(r, t.name))).map(r => toPoint(r));
    bgDatasets = [{ label: 'Others', data: bgPts, backgroundColor: 'rgba(120,120,160,.18)', borderColor: 'rgba(120,120,160,.30)', pointRadius: 4, pointHoverRadius: 6, order: teams.length + 1 }];
    teams.forEach((t, i) => {
      const src = data.filter(r => hasData(r) && isTeamMember(r, t.name)).map(r => toPoint(r));
      teamDatasets.push({ label: t.name, data: src, backgroundColor: t.color, borderColor: t.color, pointRadius: 8, pointHoverRadius: 10, order: teams.length - i });
    });
  }

  const showLegend = timelineMode || (yearData && yearData.length > 0 && teams.length === 0) || teams.length > 0;

  // Watermark reads _asState.tlYear directly so _tlUpdateHighlight doesn't need to touch it
  const watermarkPlugin = {
    id: 'yearWatermark',
    afterDraw(chart) {
      const yr = _asState.tlYear;
      if (!yr) return;
      const { ctx, chartArea: ca } = chart;
      ctx.save();
      ctx.font = `bold ${Math.round(Math.min(ca.width, ca.height) * 0.28)}px system-ui`;
      ctx.fillStyle = 'rgba(255,255,255,0.06)';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(yr), (ca.left + ca.right) / 2, (ca.top + ca.bottom) / 2);
      ctx.restore();
    },
  };

  _asState.chart = new C(el, {
    type: 'scatter',
    data: { datasets: [...bgDatasets, ...teamDatasets] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      scales: {
        x: { ...xScaleOpts, title: { display: true, text: 'Raw Avg Score', color: textColor, font: { size: 11 } }, ticks: { color: textColor }, grid: { color: gridColor } },
        y: { ...yScaleOpts, title: { display: true, text: 'Global Z', color: textColor, font: { size: 11 } }, ticks: { color: textColor }, grid: { color: gridColor } },
      },
      plugins: {
        legend: { display: showLegend, labels: { color: textColor, font: { size: 11 }, boxWidth: 10, padding: 14 } },
        tooltip: { callbacks: { label: ctx => ctx.raw.pointRadius === 0 ? '' : `${ctx.raw.name} · ${ctx.raw.team}  avg ${ctx.raw.x != null ? ctx.raw.x.toFixed(2) : '—'}  global z ${ctx.raw.y != null ? ctx.raw.y.toFixed(3) : '—'}` } },
      },
      onClick: (e, elements) => {
        if (!elements.length) return;
        const { datasetIndex: di, index: i } = elements[0];
        const pt = _asState.chart.data.datasets[di]?.data[i];
        if (pt?.name && pt.pointRadius !== 0) loadProfile(pt.name);
      },
    },
    plugins: [watermarkPlugin],
  });
}

// ── Rankings ──────────────────────────────────────────────────────────────────

const rkState = { mode: 'participants', year: 'all', data: [], sortKey: 'wt_z', sortAsc: false };

// Build columns dynamically — "Years" column only appears in All-Years mode
function participantCols() {
  const allYears = rkState.year === 'all';
  const cols = [
    { key: '_rank',        label: '#',          fmt: v => v,         title: false },
    { key: 'name',         label: 'Name',       fmt: v => v,         title: true  },
    { key: 'team',         label: 'Country',    fmt: v => v,         title: false },
  ];
  if (allYears) cols.push({ key: 'n_years', label: 'Years', fmt: v => v ?? '—', title: false });
  cols.push(
    { key: 'overall_avg',  label: 'Overall Avg', fmt: v => fmt(v),   title: false },
    { key: 'wt_z',         label: 'Global Z',    fmt: v => fmt(v,3), title: false, tip: _ZTIP },
    { key: 'reporter_avg', label: 'Rep Avg',     fmt: v => fmt(v),   title: false },
    { key: 'opponent_avg', label: 'Opp Avg',     fmt: v => fmt(v),   title: false },
    { key: 'reviewer_avg', label: 'Rev Avg',     fmt: v => fmt(v),   title: false },
    { key: 'n_reporter',   label: 'Rep #',       fmt: v => v ?? '—', title: false },
    { key: 'n_opponent',   label: 'Opp #',       fmt: v => v ?? '—', title: false },
    { key: 'n_reviewer',   label: 'Rev #',       fmt: v => v ?? '—', title: false },
  );
  return cols;
}

function teamCols() {
  const allYears = rkState.year === 'all';
  const rankLabel = allYears ? 'Best Rank' : 'Final Rank';
  const tspLabel  = allYears ? 'Total TSP'  : 'Final TSP';
  const cols = [
    { key: 'final_rank',   label: rankLabel,     fmt: v => v ?? '—', title: false },
    { key: 'team',         label: 'Team',        fmt: v => v,         title: true  },
  ];
  if (allYears) cols.push({ key: 'n_years', label: 'Years', fmt: v => v ?? '—', title: false });
  cols.push(
    { key: 'final_tsp',    label: tspLabel,      fmt: v => fmt(v),   title: false },
    { key: 'overall_avg',  label: 'Overall Avg', fmt: v => fmt(v),   title: false },
    { key: 'reporter_avg', label: 'Rep Avg',     fmt: v => fmt(v),   title: false },
    { key: 'opponent_avg', label: 'Opp Avg',     fmt: v => fmt(v),   title: false },
    { key: 'reviewer_avg', label: 'Rev Avg',     fmt: v => fmt(v),   title: false },
    { key: 'n_members',    label: 'Members',     fmt: v => v ?? '—', title: false },
  );
  return cols;
}

// Load available years when Rankings tab is first activated
let rkYearsLoaded = false;
async function ensureRkYears() {
  if (rkYearsLoaded) return;
  rkYearsLoaded = true;
  try {
    const years = await apiFetch('/api/rankings/years');
    const sel = $('rk-year-select');
    sel.innerHTML = `<option value="all">All Years</option>` +
      years.map(y => `<option value="${y}">${y}</option>`).join('');
    rkState.year = 'all';
    sel.value = 'all';
    await loadRankings();
  } catch (e) {
    showError('Failed to load years');
  }
}

// Wire tab activation
document.querySelectorAll('.tab').forEach(tab => {
  if (tab.dataset.tab === 'rankings') {
    tab.addEventListener('click', ensureRkYears);
  }
});

// Mode toggle
document.querySelectorAll('.rk-mode-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    document.querySelectorAll('.rk-mode-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    rkState.mode = btn.dataset.mode;
    rkState.sortKey = btn.dataset.mode === 'participants' ? 'wt_z' : 'overall_z';
    rkState.sortAsc = false;
    await loadRankings();
  });
});

// Year select
$('rk-year-select').addEventListener('change', async e => {
  const v = e.target.value;
  rkState.year = v === 'all' ? 'all' : parseInt(v);
  await loadRankings();
});

async function loadRankings() {
  if (!rkState.year) return;
  const wrap = $('rankings-table-wrap');
  wrap.innerHTML = '<div class="loader">Loading…</div>';
  try {
    const yearParam = rkState.year === 'all' ? '' : `year=${rkState.year}`;
    const endpoint = rkState.mode === 'participants'
      ? `/api/rankings/participants${yearParam ? '?' + yearParam : ''}`
      : `/api/rankings/teams${yearParam ? '?' + yearParam : ''}`;
    rkState.data = await apiFetch(endpoint);
    if (rkState.mode === 'participants') {
      rkState.data.forEach(r => {
        r.wt_z = r.global_z != null ? r.global_z : null;
      });
    }
    renderRankingsTable();
    renderRankingsScatter();
  } catch (e) {
    wrap.innerHTML = `<div class="loader" style="color:var(--red)">${e.message}</div>`;
  }
}

function renderRankingsScatter() {
  const C = window.Chart;
  const chartWrap = $('rankings-chart-wrap');
  if (!C || !chartWrap) return;

  const zKey = rkState.mode === 'participants' ? 'wt_z' : 'overall_z';
  const data = rkState.data.filter(r => r.overall_avg != null && r[zKey] != null);
  if (data.length < 3) { chartWrap.innerHTML = ''; return; }

  chartWrap.innerHTML = `<div class="chart-card" style="padding:20px">
    <canvas id="chart-scatter" height="300"></canvas>
  </div>`;

  const el = document.getElementById('chart-scatter');
  const existing = C.getChart(el); if (existing) existing.destroy();

  const gridColor = 'rgba(46,51,80,.6)';
  const textColor = '#7a7f9a';
  const nameKey = rkState.mode === 'participants' ? 'name' : 'team';

  new C(el, {
    type: 'scatter',
    data: {
      datasets: [{
        label: rkState.mode === 'participants' ? 'Participants' : 'Teams',
        data: data.map(r => ({ x: r.overall_avg, y: r[zKey], name: r[nameKey] })),
        backgroundColor: 'rgba(91,141,238,.55)',
        borderColor: '#5b8dee',
        pointRadius: 5,
        pointHoverRadius: 7,
      }],
    },
    options: {
      responsive: true,
      scales: {
        x: {
          title: { display: true, text: 'Raw Avg Score', color: textColor, font: { size: 11 } },
          ticks: { color: textColor },
          grid: { color: gridColor },
        },
        y: {
          title: { display: true, text: rkState.mode === 'participants' ? 'Global Z' : 'Overall Z-Score', color: textColor, font: { size: 11 } },
          ticks: { color: textColor },
          grid: { color: gridColor },
        },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => `${ctx.raw.name}  avg: ${ctx.raw.x.toFixed(2)}  ${rkState.mode === 'participants' ? 'global z' : 'z'}: ${ctx.raw.y.toFixed(3)}`,
          },
        },
      },
      onClick: (e, elements) => {
        if (!elements.length) return;
        const d = data[elements[0].index];
        if (rkState.mode === 'participants') loadProfile(d[nameKey]);
        else loadTeam(d[nameKey]);
      },
    },
  });
}

function sortData() {
  const key = rkState.sortKey;
  const asc = rkState.sortAsc;
  rkState.data.sort((a, b) => {
    const av = a[key], bv = b[key];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;   // nulls always last
    if (bv == null) return -1;
    if (typeof av === 'string') return asc ? av.localeCompare(bv) : bv.localeCompare(av);
    return asc ? av - bv : bv - av;
  });
}

function renderRankingsTable() {
  sortData();
  const cols = rkState.mode === 'participants' ? participantCols() : teamCols();
  const wrap = $('rankings-table-wrap');
  const key = rkState.sortKey;

  const headerCells = cols.map(c => {
    const arrow = c.key === key ? (rkState.sortAsc ? ' ↑' : ' ↓') : '';
    const sortedClass = c.key === key ? ' sorted' : '';
    const tipAttr = c.tip ? ` title="${c.tip}"` : '';
    const tipIcon = c.tip ? ' ⓘ' : '';
    return `<th class="${sortedClass}" data-col="${c.key}"${tipAttr}>${c.label}${tipIcon}<span class="sort-arrow">${arrow}</span></th>`;
  }).join('');

  const rows = rkState.data.map((row, i) => {
    const cells = cols.map(c => {
      if (c.key === '_rank') return `<td class="rk-rank">${i + 1}</td>`;
      const val = row[c.key];
      const display = val == null ? '<span class="rk-null">—</span>' : c.fmt(val);
      if (c.title) {
        const isParticipant = rkState.mode === 'participants';
        const handler = isParticipant ? `data-participant="${val}"` : `data-team="${val}"`;
        return `<td class="rk-name" ${handler}>${display}</td>`;
      }
      return `<td>${display}</td>`;
    }).join('');
    return `<tr>${cells}</tr>`;
  }).join('');

  wrap.innerHTML = `
    <div class="rk-table-scroll">
      <table class="rk-table">
        <thead><tr>${headerCells}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;

  // Sort on header click (scatter doesn't need re-render on sort)
  wrap.querySelectorAll('th[data-col]').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      if (rkState.sortKey === col) {
        rkState.sortAsc = !rkState.sortAsc;
      } else {
        rkState.sortKey = col;
        // numeric cols default desc (higher = better), string/rank cols default asc
        rkState.sortAsc = (col === '_rank' || col === 'final_rank' || col === 'name' || col === 'team');
      }
      renderRankingsTable();
    });
  });

  // Name clicks → profile
  wrap.querySelectorAll('[data-participant]').forEach(el => {
    el.addEventListener('click', () => loadProfile(el.dataset.participant));
  });
  wrap.querySelectorAll('[data-team]').forEach(el => {
    el.addEventListener('click', () => loadTeam(el.dataset.team));
  });
}

// ── Room Matchup ──────────────────────────────────────────────────────────────

async function loadRoomMatchup(teams) {
  showView('view-room');
  $('room-content').innerHTML = '<div class="loader">Loading…</div>';
  try {
    const params = teams.map(encodeURIComponent).join(',');
    const data = await apiFetch(`/api/room-matchup?teams=${params}`);
    $('room-content').innerHTML = renderRoomMatchup(data);
    $('room-content').querySelectorAll('[data-team]').forEach(el => {
      el.addEventListener('click', () => loadTeam(el.dataset.team));
    });
  } catch (err) {
    showError(err.message);
    showView('view-home');
  }
}

function renderRoomMatchup(data) {
  const { teams, matchups } = data;

  const rankBadge = (rank) => {
    if (rank == null) return '<span class="rm-rank rm-rank-na">—</span>';
    const cls = rank === 1 ? 'rm-rank-1' : rank === 2 ? 'rm-rank-2' : 'rm-rank-3';
    const label = rank === 1 ? '1st' : rank === 2 ? '2nd' : '3rd';
    return `<span class="rm-rank ${cls}">${label}</span>`;
  };

  const teamChip = (name) => {
    const flag = countryFlag(name) || '';
    return `<span class="rm-team-chip" data-team="${name}" style="cursor:pointer">${flag} ${name}</span>`;
  };

  const confidenceLabel = (n) => {
    if (n === 0) return { text: 'No historical data', cls: 'rm-conf-none' };
    if (n <= 2)  return { text: `Low confidence · ${n} fight${n > 1 ? 's' : ''}`, cls: 'rm-conf-low' };
    if (n <= 4)  return { text: `Moderate confidence · ${n} fights`, cls: 'rm-conf-mid' };
    return { text: `High confidence · ${n} fights`, cls: 'rm-conf-high' };
  };

  const roomHeader = `
    <div class="rm-header">
      <h2>🎲 Room Prediction</h2>
      <div class="rm-teams-row">${teams.map(teamChip).join('<span class="rm-sep">+</span>')}</div>
      <div class="share-row" style="margin-top:10px">${shareBtn({ room: teams.join(',') })}</div>
    </div>`;

  if (!matchups.length) {
    return roomHeader + '<div class="rm-empty">No historical encounters found between these teams.</div>';
  }

  const matchupCards = matchups.map(m => {
    const flagA = countryFlag(m.team_a) || '';
    const flagB = countryFlag(m.team_b) || '';
    const pA = m.p_a_wins ?? 0.5;
    const pB = m.p_b_wins ?? 0.5;
    const pctA = Math.round(pA * 100);
    const pctB = Math.round(pB * 100);
    const conf = confidenceLabel(m.n_encounters);

    // Determine favorite
    const isTie = pctA === pctB;
    const favSide = isTie ? null : (pA > pB ? 'a' : 'b');
    const favName = favSide === 'a' ? m.team_a : favSide === 'b' ? m.team_b : null;
    const favFlag = favName ? (countryFlag(favName) || '') : '';
    const underName = favSide === 'a' ? m.team_b : favSide === 'b' ? m.team_a : null;
    const underFlag = underName ? (countryFlag(underName) || '') : '';

    // Verdict banner
    let verdictHtml;
    if (m.n_encounters === 0) {
      verdictHtml = `<div class="rm-verdict rm-verdict-unknown">
        <div class="rm-verdict-main">No shared fights yet — 50 / 50</div>
        <div class="rm-verdict-sub">These teams have never met in historical data. Flip a coin.</div>
      </div>`;
    } else if (isTie) {
      verdictHtml = `<div class="rm-verdict rm-verdict-tie">
        <div class="rm-verdict-main">🤝 Perfectly even matchup</div>
        <div class="rm-verdict-sub">${conf.text}</div>
      </div>`;
    } else {
      const edge = Math.abs(pctA - pctB);
      const edgeWord = edge >= 30 ? 'Strong edge' : edge >= 15 ? 'Slight edge' : 'Narrow edge';
      verdictHtml = `<div class="rm-verdict rm-verdict-winner">
        <div class="rm-verdict-label">BET ON</div>
        <div class="rm-verdict-main">${favFlag} ${favName}</div>
        <div class="rm-verdict-sub">${edgeWord} · ${conf.text}</div>
        ${underName ? `<div class="rm-verdict-under">Underdog: ${underFlag} ${underName} (still ${favSide === 'a' ? pctB : pctA}% chance — worth the risk?)</div>` : ''}
      </div>`;
    }

    // Probability bar
    const barHtml = `
      <div class="rm-prob-wrap">
        <div class="rm-prob-team rm-prob-team-a ${favSide === 'a' ? 'rm-prob-fav' : ''}" data-team="${m.team_a}" style="cursor:pointer">
          <span class="rm-prob-flag">${flagA}</span>
          <span class="rm-prob-name">${m.team_a}</span>
          <span class="rm-prob-pct">${pctA}%</span>
        </div>
        <div class="rm-prob-bar-track">
          <div class="rm-prob-bar-a ${favSide === 'a' ? 'rm-bar-fav' : 'rm-bar-under'}" style="width:${pctA}%"></div>
          <div class="rm-prob-bar-b ${favSide === 'b' ? 'rm-bar-fav' : 'rm-bar-under'}" style="width:${pctB}%"></div>
        </div>
        <div class="rm-prob-team rm-prob-team-b ${favSide === 'b' ? 'rm-prob-fav' : ''}" data-team="${m.team_b}" style="cursor:pointer">
          <span class="rm-prob-pct">${pctB}%</span>
          <span class="rm-prob-name">${m.team_b}</span>
          <span class="rm-prob-flag">${flagB}</span>
        </div>
      </div>
      <div class="rm-prob-note">Estimated probability that each team finishes above the other in a shared room. Based on historical finishes + Bayesian correction for small samples (50/50 prior, shrinks toward certainty with more data).</div>`;

    // Encounter history (collapsed by default if exists)
    let historyHtml = '';
    if (m.n_encounters > 0) {
      const aLabel = m.team_a.split(' ')[0];
      const bLabel = m.team_b.split(' ')[0];
      const rows = m.encounters.map(e => {
        const thirdFlag = e.third_team ? (countryFlag(e.third_team) || '') : '';
        const thirdCell = e.third_team
          ? `${thirdFlag} ${e.third_team} ${rankBadge(e.third_rank)}`
          : '—';
        const aWon = e.team_a_rank != null && e.team_b_rank != null && e.team_a_rank < e.team_b_rank;
        const bWon = e.team_a_rank != null && e.team_b_rank != null && e.team_b_rank < e.team_a_rank;
        return `<tr>
          <td>${e.year}</td>
          <td>R${e.round} · ${e.fight_room || '?'}</td>
          <td class="${aWon ? 'rm-cell-win' : bWon ? 'rm-cell-lose' : ''}">${rankBadge(e.team_a_rank)} ${e.team_a_score != null ? `<span class="rm-score">${e.team_a_score.toFixed(2)}</span>` : ''}</td>
          <td class="${bWon ? 'rm-cell-win' : aWon ? 'rm-cell-lose' : ''}">${rankBadge(e.team_b_rank)} ${e.team_b_score != null ? `<span class="rm-score">${e.team_b_score.toFixed(2)}</span>` : ''}</td>
          <td class="rm-third">${thirdCell}</td>
        </tr>`;
      }).join('');

      historyHtml = `
        <details class="rm-history">
          <summary class="rm-history-toggle">Fight history (${m.n_encounters} encounter${m.n_encounters !== 1 ? 's' : ''})</summary>
          <div class="rm-table-wrap">
            <table class="rm-table">
              <thead><tr><th>Year</th><th>Round · Room</th><th>${aLabel}</th><th>${bLabel}</th><th>3rd team</th></tr></thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
          <p class="rm-note">Position = finish rank within the fight room (1st beats all). Score = avg judge grade.</p>
        </details>`;
    }

    return `<div class="rm-card">
      <div class="rm-card-head">
        <span class="rm-card-team" data-team="${m.team_a}" style="cursor:pointer">${flagA} ${m.team_a}</span>
        <span class="rm-card-vs">vs</span>
        <span class="rm-card-team" data-team="${m.team_b}" style="cursor:pointer">${flagB} ${m.team_b}</span>
      </div>
      ${verdictHtml}
      ${barHtml}
      ${historyHtml}
    </div>`;
  }).join('');

  return roomHeader + `<div class="rm-cards">${matchupCards}</div>`;
}
