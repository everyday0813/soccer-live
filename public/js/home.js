/* Home page: match table with live scores (30 s refresh) and 1 s countdowns. */
(function () {
  'use strict';
  var SL = window.SL, T = SL.T, esc = SL.esc;
  var table = document.getElementById('match-table');
  var matches = [];
  var lastSig = '';
  var filter = 'all';
  var refreshTimer = null;
  var REFRESH_MS = 30000;

  document.getElementById('year').textContent = new Date().getFullYear();

  function statusHtml(m) {
    if (m.state === 'in') {
      return '<span class="live-badge"><i class="dot" aria-hidden="true"></i>' + esc(T.live) + '</span>' +
        '<span class="clock mono">' + esc(m.clock || '') + '</span>';
    }
    if (m.state === 'post') {
      if (m.home.score == null) return '<span class="ft-badge muted">' + esc(m.statusDetail || T.finished) + '</span>';
      return '<span class="ft-badge">' + esc(T.finished) + '</span>';
    }
    return '<span class="s-time mono">' + esc(SL.hhmm(m.kickoff)) + '</span>' +
      '<span class="cd"><span class="cd-label">' + esc(T.countdown) + '</span> ' +
      '<span class="countdown mono" data-kickoff="' + esc(m.kickoff) + '">' + esc(SL.countdown(m.kickoff)) + '</span></span>';
  }

  function scoreText(v) { return v == null ? '' : String(v); }

  function rowHtml(m) {
    var played = m.state !== 'pre' && m.home.score != null;
    var center = played
      ? '<span class="sc">' + scoreText(m.home.score) + '</span><span class="sc-sep">-</span><span class="sc">' + scoreText(m.away.score) + '</span>'
      : '<span class="vs">VS</span>';
    var winH = m.state === 'post' && played && m.home.score > m.away.score;
    var winA = m.state === 'post' && played && m.away.score > m.home.score;
    return '' +
      '<a class="match-row state-' + m.state + '" href="/match/' + encodeURIComponent(m.id) + '" data-id="' + esc(m.id) + '">' +
        '<div class="m-league">' + SL.logo(m.league.logo, m.league.name, 'lg-logo') +
          '<span class="lg-name">' + esc(m.league.name) + '</span>' +
          (m.hasStream ? '<span class="has-stream" title="' + esc(T.streamLink) + '" aria-label="' + esc(T.streamLink) + '"></span>' : '') +
        '</div>' +
        '<div class="m-time mono">' + esc(SL.hhmm(m.kickoff)) + '</div>' +
        '<div class="m-team m-home' + (winH ? ' win' : '') + '">' + SL.logo(m.home.logo, m.home.name) +
          '<span class="t-name">' + esc(m.home.name) + '</span><span class="t-score mono">' + scoreText(m.home.score) + '</span></div>' +
        '<div class="m-score mono" aria-label="' + esc(T.score) + '">' + center + '</div>' +
        '<div class="m-team m-away' + (winA ? ' win' : '') + '">' + SL.logo(m.away.logo, m.away.name) +
          '<span class="t-name">' + esc(m.away.name) + '</span><span class="t-score mono">' + scoreText(m.away.score) + '</span></div>' +
        '<div class="m-status">' + statusHtml(m) + '</div>' +
      '</a>';
  }

  function groupHtml(title, list, cls) {
    if (!list.length) return '';
    return '<section class="group ' + (cls || '') + '"><h2 class="group-head">' + esc(title) +
      ' <span class="group-count">' + list.length + '</span></h2>' + list.map(rowHtml).join('') + '</section>';
  }

  function applyFilter(list) {
    if (filter === 'live') return list.filter(function (m) { return m.state === 'in'; });
    if (filter === 'today' || filter === 'tomorrow') {
      return list.filter(function (m) { return SL.relDay(m.kickoff) === filter || (filter === 'today' && m.state === 'in'); });
    }
    return list;
  }

  function render() {
    var list = applyFilter(matches);
    var live = [], upcoming = [], done = [];
    list.forEach(function (m) { (m.state === 'in' ? live : m.state === 'pre' ? upcoming : done).push(m); });

    var html = groupHtml(T.live, live, 'group-live');
    var byDay = [];
    upcoming.forEach(function (m) {
      var k = SL.dayKey(new Date(m.kickoff));
      var g = byDay[byDay.length - 1];
      if (!g || g.key !== k) byDay.push(g = { key: k, label: SL.dayLabel(m.kickoff), items: [] });
      g.items.push(m);
    });
    byDay.forEach(function (g) { html += groupHtml(g.label, g.items); });
    html += groupHtml(T.finished, done.slice().reverse(), 'group-done');

    if (!html) html = '<div class="empty-state"><span class="empty-ball" aria-hidden="true"></span><p>' + esc(T.matches) + ': 0</p></div>';
    table.innerHTML = html;
    table.setAttribute('aria-busy', 'false');

    var counts = { all: matches.length, live: 0, today: 0, tomorrow: 0 };
    matches.forEach(function (m) {
      if (m.state === 'in') counts.live++;
      var d = SL.relDay(m.kickoff);
      if (d === 'today' || m.state === 'in') counts.today++;
      if (d === 'tomorrow') counts.tomorrow++;
    });
    Object.keys(counts).forEach(function (k) {
      var el = document.querySelector('[data-count="' + k + '"]');
      if (el) el.textContent = counts[k] ? counts[k] : '';
    });
  }

  function load() {
    clearTimeout(refreshTimer);
    return SL.getJSON('/api/matches').then(function (r) {
      if (r.ok && r.data && Array.isArray(r.data.matches)) {
        var sig = JSON.stringify(r.data.matches) + '|' + SL.dayKey(new Date(SL.now()));
        if (sig !== lastSig) {
          lastSig = sig;
          matches = r.data.matches;
          render();
        }
      }
    }).catch(function () { /* keep showing the last good data */ })
      .then(function () { refreshTimer = setTimeout(load, REFRESH_MS); });
  }

  // Countdown tick (1 s). When a countdown reaches zero, refresh soon after.
  var kickoffRefreshQueued = false;
  setInterval(function () {
    var els = table.querySelectorAll('.countdown[data-kickoff]');
    for (var i = 0; i < els.length; i++) {
      var iso = els[i].getAttribute('data-kickoff');
      els[i].textContent = SL.countdown(iso);
      if (!kickoffRefreshQueued && Date.parse(iso) <= SL.now()) {
        kickoffRefreshQueued = true;
        setTimeout(function () { kickoffRefreshQueued = false; load(); }, 15000);
      }
    }
  }, 1000);

  // Tabs (state kept in the URL hash).
  var tabs = document.querySelectorAll('.tab');
  function setFilter(f, push) {
    if (['all', 'live', 'today', 'tomorrow'].indexOf(f) < 0) f = 'all';
    filter = f;
    tabs.forEach(function (t) { t.setAttribute('aria-selected', String(t.dataset.filter === f)); });
    if (push) history.replaceState(null, '', f === 'all' ? location.pathname : '#' + f);
    if (matches.length) render();
  }
  tabs.forEach(function (t) { t.addEventListener('click', function () { setFilter(t.dataset.filter, true); }); });
  setFilter((location.hash || '').slice(1), false);

  // Edge fade on the tab row: only when it overflows and is not scrolled to the end.
  var tabRow = document.querySelector('.tabs');
  function syncTabFade() {
    var over = tabRow.scrollWidth > tabRow.clientWidth + 1;
    tabRow.classList.toggle('is-overflowing', over);
    tabRow.classList.toggle('at-end', over && tabRow.scrollLeft + tabRow.clientWidth >= tabRow.scrollWidth - 1);
  }
  if (tabRow) {
    tabRow.addEventListener('scroll', syncTabFade, { passive: true });
    window.addEventListener('resize', syncTabFade);
    if (window.ResizeObserver) {
      var ro = new ResizeObserver(syncTabFade);
      ro.observe(tabRow);
      tabs.forEach(function (t) { ro.observe(t); }); // tab counts change the row width
    }
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(syncTabFade);
    syncTabFade();
  }

  document.addEventListener('visibilitychange', function () { if (!document.hidden) load(); });

  load();
})();
