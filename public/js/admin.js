/* Admin page: login, per-match stream URLs, three sponsor slots, placeholder toggle. */
(function () {
  'use strict';
  var SL = window.SL, T = SL.T, esc = SL.esc;

  var loginEl = document.getElementById('login');
  var dashEl = document.getElementById('dashboard');
  var logoutBtn = document.getElementById('logout');
  var state = null;

  var SIZES = { 1: '970×90 · 320×100', 2: '728×90 · 320×100', 3: '728×90 · 320×100' };

  function showLogin(msg) {
    loginEl.hidden = false;
    dashEl.hidden = true;
    logoutBtn.hidden = true;
    document.getElementById('login-msg').textContent = msg || '';
    document.getElementById('password').focus();
  }

  function flash(el, text, ok) {
    el.textContent = text;
    el.classList.toggle('ok', !!ok);
    el.classList.toggle('err', !ok);
    clearTimeout(el._t);
    el._t = setTimeout(function () { el.textContent = ''; }, 4000);
  }

  function errorText(r) {
    if (r.status === 401) return T.sessionExpired;
    return (r.data && r.data.error) || ('HTTP ' + r.status);
  }

  // -------------------------------------------------------------------- auth
  document.getElementById('login-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var pw = document.getElementById('password');
    SL.getJSON('/api/admin/login', { method: 'POST', body: { password: pw.value } }).then(function (r) {
      if (r.ok) { pw.value = ''; loadState(); return; }
      showLogin(r.status === 429 ? T.tooManyAttempts : T.loginFailed);
    });
  });

  logoutBtn.addEventListener('click', function () {
    SL.getJSON('/api/admin/logout', { method: 'POST', body: {} }).then(function () { showLogin(''); });
  });

  function loadState() {
    return SL.getJSON('/api/admin/state').then(function (r) {
      if (r.status === 401) return showLogin('');
      if (!r.ok) return showLogin(errorText(r));
      state = r.data;
      loginEl.hidden = true;
      dashEl.hidden = false;
      logoutBtn.hidden = false;
      document.getElementById('show-ph').checked = !!state.settings.showAdPlaceholders;
      renderSlots();
      renderMatches();
      loadComments();
    });
  }

  // ---------------------------------------------------------------- settings
  document.getElementById('show-ph').addEventListener('change', function (e) {
    var cb = e.target;
    SL.getJSON('/api/admin/settings', { method: 'POST', body: { showAdPlaceholders: cb.checked } }).then(function (r) {
      if (!r.ok) { cb.checked = !cb.checked; if (r.status === 401) showLogin(''); }
    });
  });

  // ------------------------------------------------------------------- slots
  var slotWrap = document.getElementById('slot-admin');
  var tpl = document.getElementById('slot-template');

  function previewHtml(b) {
    if (!b) return '<div class="slot-ph small"><span>' + esc(T.ad) + '</span></div>';
    if (b.type === 'image') {
      return '<a href="' + esc(b.linkUrl || '#') + '" target="_blank" rel="noopener sponsored"><img src="' + esc(b.imageUrl) + '" alt=""></a>';
    }
    // Never execute ad code inside the admin page; show it as text instead.
    return '<pre class="code-preview">' + esc((b.html || '').slice(0, 400)) + '</pre>';
  }

  function renderSlots() {
    slotWrap.innerHTML = '';
    var bySlot = {};
    (state.banners || []).forEach(function (b) { bySlot[b.slot] = b; });
    [1, 2, 3].forEach(function (n) {
      var b = bySlot[n] || null;
      var form = tpl.content.firstElementChild.cloneNode(true);
      form.querySelector('.slot-title').textContent = T.ad + ' ' + n;
      form.querySelector('.slot-size').textContent = SIZES[n];
      form.querySelector('.slot-preview').innerHTML = previewHtml(b);
      form.querySelector('.slot-delete').hidden = !b;
      // Unique radio group name per slot.
      form.querySelectorAll('input[name="type"]').forEach(function (r) { r.name = 'type-' + n; });
      var type = b && b.type === 'html' ? 'html' : 'image';
      form.querySelector('input[value="' + type + '"]').checked = true;
      if (b && b.linkUrl) form.elements.linkUrl.value = b.linkUrl;
      if (b && b.html) form.elements.html.value = b.html;

      function syncType() {
        var t = form.querySelector('input[name="type-' + n + '"]:checked').value;
        form.querySelector('.type-image').hidden = t !== 'image';
        form.querySelector('.type-html').hidden = t !== 'html';
        return t;
      }
      form.querySelectorAll('input[name="type-' + n + '"]').forEach(function (r) { r.addEventListener('change', syncType); });
      syncType();

      var msg = form.querySelector('.form-msg');
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var t = syncType();
        var req;
        if (t === 'html') {
          req = SL.getJSON('/api/admin/banner', { method: 'POST', body: { slot: n, type: 'html', html: form.elements.html.value } });
        } else {
          var fd = new FormData();
          fd.append('slot', String(n));
          fd.append('linkUrl', form.elements.linkUrl.value.trim());
          var file = form.elements.image.files[0];
          if (file) fd.append('image', file);
          req = SL.getJSON('/api/admin/banner', { method: 'POST', body: fd });
        }
        req.then(function (r) {
          if (r.status === 401) return showLogin('');
          if (!r.ok) return flash(msg, errorText(r), false);
          flash(msg, T.saved, true);
          state.banners = (state.banners || []).filter(function (x) { return x.slot !== n; }).concat([r.data.banner]);
          form.querySelector('.slot-preview').innerHTML = previewHtml(r.data.banner);
          form.querySelector('.slot-delete').hidden = false;
          form.elements.image.value = '';
        });
      });

      form.querySelector('.slot-delete').addEventListener('click', function () {
        if (!confirm(T.deleteSlot + ' ' + n + '?')) return;
        SL.getJSON('/api/admin/banner/' + n, { method: 'DELETE' }).then(function (r) {
          if (r.status === 401) return showLogin('');
          if (!r.ok) return flash(msg, errorText(r), false);
          state.banners = (state.banners || []).filter(function (x) { return x.slot !== n; });
          renderSlots();
        });
      });

      slotWrap.appendChild(form);
    });
  }

  // ----------------------------------------------------------------- matches
  var listEl = document.getElementById('admin-matches');
  var filterEl = document.getElementById('m-filter');

  function renderMatches() {
    var q = filterEl.value.trim().toLowerCase();
    var list = (state.matches || []).filter(function (m) {
      if (!q) return true;
      return (m.home.name + ' ' + m.away.name + ' ' + m.league.name + ' ' + m.id).toLowerCase().indexOf(q) >= 0;
    });
    document.getElementById('m-count').textContent = String(list.length);
    var html = '';
    var lastDay = '';
    list.forEach(function (m) {
      var day = m.state === 'in' ? T.live : SL.dayLabel(m.kickoff);
      if (day !== lastDay) { html += '<h3 class="group-head">' + esc(day) + '</h3>'; lastDay = day; }
      var url = state.streams[m.id] || '';
      html += '<form class="am-row' + (url ? ' has-url' : '') + '" data-id="' + esc(m.id) + '">' +
        '<div class="am-info">' +
          '<span class="am-time mono">' + (m.state === 'in' ? '<span class="live-badge"><i class="dot"></i>' + esc(m.clock) + '</span>' : esc(SL.hhmm(m.kickoff))) + '</span>' +
          '<span class="am-teams">' + SL.logo(m.home.logo, m.home.name, 'logo logo-sm') + esc(m.home.name) +
            ' <span class="muted">vs</span> ' + SL.logo(m.away.logo, m.away.name, 'logo logo-sm') + esc(m.away.name) + '</span>' +
          '<span class="am-league muted">' + esc(m.league.name) + ' · <a href="/match/' + esc(m.id) + '" target="_blank" rel="noopener">#' + esc(m.id) + '</a></span>' +
        '</div>' +
        '<div class="am-input">' +
          '<input type="url" name="url" placeholder="' + esc(T.streamLink) + ' (https://… / .m3u8)" aria-label="' + esc(T.streamLink) + '" value="' + esc(url) + '">' +
          '<button type="submit" class="btn btn-primary btn-sm">' + esc(T.save) + '</button>' +
          '<span class="form-msg" role="status"></span>' +
        '</div>' +
      '</form>';
    });
    listEl.innerHTML = html || '<p class="muted">—</p>';
  }

  listEl.addEventListener('submit', function (e) {
    var form = e.target.closest('.am-row');
    if (!form) return;
    e.preventDefault();
    var id = form.dataset.id;
    var input = form.elements.url;
    var msg = form.querySelector('.form-msg');
    SL.getJSON('/api/admin/stream', { method: 'POST', body: { matchId: id, url: input.value.trim() } }).then(function (r) {
      if (r.status === 401) return showLogin('');
      if (!r.ok) return flash(msg, errorText(r), false);
      if (r.data.stream) { state.streams[id] = r.data.stream.url; input.value = r.data.stream.url; }
      else delete state.streams[id];
      form.classList.toggle('has-url', !!r.data.stream);
      flash(msg, T.saved, true);
    });
  });

  var filterTimer = null;
  filterEl.addEventListener('input', function () {
    clearTimeout(filterTimer);
    filterTimer = setTimeout(renderMatches, 120);
  });

  // -------------------------------------------------------------- moderation
  // Built with DOM APIs + textContent only: comment text is untrusted.
  var modList = document.getElementById('mod-list');
  var modCount = document.getElementById('c-count');
  var modMsg = document.getElementById('c-msg');

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function syncModEmpty() {
    var rows = modList.querySelectorAll('.mod-row').length;
    modCount.textContent = String(rows);
    var empty = modList.querySelector('.mod-empty');
    if (!rows && !empty) modList.appendChild(el('li', 'mod-empty', T.noComments));
    if (rows && empty) empty.remove();
  }

  function commentRow(c) {
    var li = el('li', 'mod-row');
    li.dataset.id = String(c.id);
    var main = el('div', 'c-main');
    var meta = el('div', 'c-meta');
    meta.appendChild(el('span', 'c-name', c.name));
    var time = el('time', 'c-time', SL.timeAgo(c.createdAt));
    time.dateTime = c.createdAt;
    meta.appendChild(time);
    main.appendChild(meta);
    var link = el('a', 'mod-match', c.matchLabel);
    link.href = '/match/' + encodeURIComponent(c.matchId);
    link.target = '_blank';
    link.rel = 'noopener';
    main.appendChild(link);
    main.appendChild(el('p', 'c-body', c.body));
    li.appendChild(main);
    var btn = el('button', 'btn btn-ghost btn-sm mod-del', T.del);
    btn.type = 'button';
    li.appendChild(btn);
    return li;
  }

  function loadComments() {
    return SL.getJSON('/api/admin/comments?limit=50').then(function (r) {
      if (r.status === 401) return showLogin('');
      if (!r.ok) return flash(modMsg, errorText(r), false);
      modList.textContent = '';
      (r.data.comments || []).forEach(function (c) { modList.appendChild(commentRow(c)); });
      syncModEmpty();
    });
  }

  document.getElementById('c-refresh').addEventListener('click', loadComments);

  modList.addEventListener('click', function (e) {
    var btn = e.target.closest('.mod-del');
    if (!btn) return;
    var row = btn.closest('.mod-row');
    btn.disabled = true;
    SL.getJSON('/api/admin/comment/' + encodeURIComponent(row.dataset.id), { method: 'DELETE' }).then(function (r) {
      if (r.status === 401) return showLogin('');
      if (!r.ok) { btn.disabled = false; return flash(modMsg, errorText(r), false); }
      row.remove();
      syncModEmpty();
    }, function () { btn.disabled = false; });
  });

  loadState();
})();
