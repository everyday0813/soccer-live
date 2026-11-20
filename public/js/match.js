/* Match page: header/score, player (iframe or HLS), 3 sponsor slots, live comments. */
(function () {
  'use strict';
  var SL = window.SL, T = SL.T, esc = SL.esc;

  var matchId = (location.pathname.match(/^\/match\/(\d+)/) || [])[1] || '';
  var pageData = {};
  try { pageData = JSON.parse(document.getElementById('page-data').textContent || '{}'); } catch (e) { pageData = {}; }

  var headEl = document.getElementById('match-head');
  var playerEl = document.getElementById('player');
  var match = pageData.match || null;
  var stream = pageData.stream || null;
  var notFound = false;

  // ---------------------------------------------------------------- back link
  document.getElementById('back-link').addEventListener('click', function (e) {
    if (document.referrer && document.referrer.indexOf(location.origin + '/') === 0 && history.length > 1) {
      e.preventDefault();
      history.back();
    }
  });

  // ------------------------------------------------------------- match header
  function teamHtml(t, side) {
    return '<div class="mh-team mh-' + side + '">' + SL.logo(t.logo, t.name, 'logo logo-lg') +
      '<span class="mh-name">' + esc(t.name) + '</span></div>';
  }

  function centerHtml(m) {
    var played = m.state !== 'pre' && m.home.score != null;
    var score = played
      ? '<div class="mh-score mono" aria-label="' + esc(T.score) + '">' + m.home.score + '<span class="sc-sep">-</span>' + m.away.score + '</div>'
      : '';
    if (m.state === 'in') {
      return '<span class="live-badge"><i class="dot" aria-hidden="true"></i>' + esc(T.live) + '</span>' + score +
        '<span class="clock mono">' + esc(m.clock || '') + '</span>';
    }
    if (m.state === 'post') {
      return score + '<span class="ft-badge' + (played ? '' : ' muted') + '">' + esc(played ? T.finished : (m.statusDetail || T.finished)) + '</span>';
    }
    return '<span class="pill">' + esc(T.upcoming) + '</span>' +
      '<div class="mh-kick mono">' + esc(SL.hhmm(m.kickoff)) + '</div>' +
      '<div class="mh-day">' + esc(SL.dayLabel(m.kickoff)) + '</div>' +
      '<div class="cd"><span class="cd-label">' + esc(T.countdown) + '</span> ' +
      '<span class="countdown mono" data-kickoff="' + esc(m.kickoff) + '">' + esc(SL.countdown(m.kickoff)) + '</span></div>';
  }

  var lastHeadSig = '';
  function renderHead() {
    if (!match) {
      if (notFound) {
        headEl.innerHTML = '<div class="mh-missing"><p class="big-404">404</p></div>';
      }
      return;
    }
    var sig = JSON.stringify(match);
    if (sig === lastHeadSig) return;
    lastHeadSig = sig;
    headEl.className = 'match-head state-' + match.state;
    headEl.innerHTML =
      '<div class="mh-league">' + SL.logo(match.league.logo, match.league.name, 'lg-logo') +
        '<span>' + esc(match.league.name) + '</span></div>' +
      '<div class="mh-body">' + teamHtml(match.home, 'home') +
        '<div class="mh-center">' + centerHtml(match) + '</div>' + teamHtml(match.away, 'away') + '</div>';
    document.title = match.home.name + ' vs ' + match.away.name + ' · ' + T.site;
  }

  // ------------------------------------------------------------------ player
  var playerKey = null;
  var hls = null;
  var hlsLoading = null;

  function loadHlsJs() {
    if (window.Hls) return Promise.resolve(window.Hls);
    if (hlsLoading) return hlsLoading;
    hlsLoading = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js';
      s.async = true;
      s.crossOrigin = 'anonymous';
      s.onload = function () { resolve(window.Hls); };
      s.onerror = function () { hlsLoading = null; reject(new Error('hls.js failed to load')); };
      document.head.appendChild(s);
    });
    return hlsLoading;
  }

  function noStreamHtml() {
    var cd = match && match.state === 'pre'
      ? '<div class="cd"><span class="cd-label">' + esc(T.countdown) + '</span> <span class="countdown mono" data-kickoff="' +
        esc(match.kickoff) + '">' + esc(SL.countdown(match.kickoff)) + '</span></div>'
      : '';
    return '<div class="no-stream"><span class="no-stream-icon" aria-hidden="true"></span><p>' + esc(T.noStream) + '</p>' + cd + '</div>';
  }

  function renderPlayer() {
    var key = stream ? stream.kind + '|' + stream.url : 'none:' + (match ? match.state : '');
    if (key === playerKey) return;
    playerKey = key;
    if (hls) { hls.destroy(); hls = null; }
    playerEl.innerHTML = '';

    if (!stream) {
      playerEl.innerHTML = noStreamHtml();
      return;
    }

    if (stream.kind === 'hls') {
      var video = document.createElement('video');
      video.controls = true;
      video.playsInline = true;
      video.muted = true;
      video.autoplay = true;
      video.setAttribute('playsinline', '');
      video.className = 'player-media';
      playerEl.appendChild(video);
      if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = stream.url;
      } else {
        loadHlsJs().then(function (Hls) {
          if (!Hls || !Hls.isSupported()) { video.src = stream.url; return; }
          hls = new Hls({ lowLatencyMode: true, backBufferLength: 30 });
          hls.loadSource(stream.url);
          hls.attachMedia(video);
          hls.on(Hls.Events.ERROR, function (evt, data) {
            if (!data.fatal) return;
            if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
            else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
          });
        }).catch(function () { video.src = stream.url; });
      }
      var p = video.play && video.play();
      if (p && p.catch) p.catch(function () {});
      return;
    }

    var iframe = document.createElement('iframe');
    iframe.src = stream.url;
    iframe.className = 'player-media';
    iframe.allow = 'autoplay; fullscreen; picture-in-picture; encrypted-media';
    iframe.setAttribute('allowfullscreen', '');
    iframe.setAttribute('frameborder', '0');
    iframe.setAttribute('scrolling', 'no');
    iframe.title = match ? match.home.name + ' vs ' + match.away.name : T.site;
    playerEl.appendChild(iframe);
  }

  // ------------------------------------------------------------ sponsor slots
  var SIZE_HINTS = { 1: ['970×90', '320×100'], 2: ['728×90', '320×100'], 3: ['728×90', '320×100'] };

  function injectHtml(el, html) {
    el.innerHTML = html;
    // Scripts inserted via innerHTML don't run; re-create them so owner ad code executes.
    var scripts = el.querySelectorAll('script');
    for (var i = 0; i < scripts.length; i++) {
      var old = scripts[i];
      var s = document.createElement('script');
      for (var j = 0; j < old.attributes.length; j++) s.setAttribute(old.attributes[j].name, old.attributes[j].value);
      s.text = old.text;
      old.parentNode.replaceChild(s, old);
    }
  }

  function renderSlots(cfg) {
    cfg = cfg || { showAdPlaceholders: true, slots: [] };
    var bySlot = {};
    (cfg.slots || []).forEach(function (b) { if (b) bySlot[b.slot] = b; });
    [1, 2, 3].forEach(function (n) {
      var el = document.getElementById('slot-' + n);
      var b = bySlot[n];
      el.innerHTML = '';
      el.classList.remove('is-placeholder', 'is-image', 'is-html');
      if (b && b.type === 'image' && b.imageUrl) {
        var a = document.createElement('a');
        a.href = b.linkUrl || '#';
        a.target = '_blank';
        a.rel = 'noopener sponsored';
        var img = document.createElement('img');
        img.src = b.imageUrl;
        img.alt = T.ad;
        img.decoding = 'async';
        a.appendChild(img);
        el.appendChild(a);
        el.classList.add('is-image');
        el.hidden = false;
      } else if (b && b.type === 'html' && b.html) {
        injectHtml(el, b.html);
        el.classList.add('is-html');
        el.hidden = false;
      } else if (cfg.showAdPlaceholders) {
        el.innerHTML = '<div class="slot-ph"><span>' + esc(T.ad) + '</span>' +
          '<small class="mono hint-desktop">' + SIZE_HINTS[n][0] + '</small>' +
          '<small class="mono hint-mobile">' + SIZE_HINTS[n][1] + '</small></div>';
        el.classList.add('is-placeholder');
        el.hidden = false;
      } else {
        el.hidden = true;
      }
    });
  }

  // -------------------------------------------------------------- match data
  function loadMatch() {
    return SL.getJSON('/api/match/' + encodeURIComponent(matchId)).then(function (r) {
      if (r.ok && r.data.match) {
        match = r.data.match;
        stream = r.data.stream || null;
        notFound = false;
      } else if (r.status === 404) {
        notFound = !match;
        stream = (r.data && r.data.stream) || null;
      }
      renderHead();
      renderPlayer();
    }).catch(function () {});
  }

  // ---------------------------------------------------------------- comments
  var listEl = document.getElementById('c-list');
  var emptyEl = document.getElementById('c-empty');
  var countEl = document.getElementById('comment-count');
  var form = document.getElementById('comment-form');
  var nameEl = document.getElementById('c-name');
  var bodyEl = document.getElementById('c-body');
  var sendBtn = document.getElementById('c-send');
  var charEl = document.getElementById('c-count');
  var lastCommentId = 0;
  var seenIds = {};
  var commentCount = 0;

  function hue(s) {
    var h = 0;
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
    return h;
  }

  function commentEl(c) {
    var li = document.createElement('li');
    li.className = 'comment';
    var av = document.createElement('span');
    av.className = 'avatar';
    av.setAttribute('aria-hidden', 'true');
    av.textContent = SL.firstGrapheme(c.name);
    av.style.setProperty('--h', String(hue(c.name || '')));
    var main = document.createElement('div');
    main.className = 'c-main';
    var meta = document.createElement('div');
    meta.className = 'c-meta';
    var nm = document.createElement('span');
    nm.className = 'c-name';
    nm.textContent = c.name;
    var tm = document.createElement('time');
    tm.className = 'c-time';
    tm.dateTime = c.createdAt;
    tm.textContent = SL.timeAgo(c.createdAt);
    meta.appendChild(nm);
    meta.appendChild(tm);
    var body = document.createElement('p');
    body.className = 'c-body';
    body.textContent = c.body;
    main.appendChild(meta);
    main.appendChild(body);
    li.appendChild(av);
    li.appendChild(main);
    return li;
  }

  function addComments(list) {
    var added = 0;
    list.forEach(function (c) {
      if (seenIds[c.id]) return;
      seenIds[c.id] = true;
      listEl.insertBefore(commentEl(c), listEl.firstChild); // newest first
      if (c.id > lastCommentId) lastCommentId = c.id;
      added++;
    });
    var MAX = 300;
    while (listEl.children.length > MAX) listEl.removeChild(listEl.lastChild);
    return added;
  }

  function updateCount(n) {
    commentCount = Math.max(n, listEl.children.length);
    countEl.textContent = String(commentCount);
    emptyEl.hidden = commentCount > 0;
  }

  function pollComments() {
    if (!matchId) return Promise.resolve();
    var url = '/api/match/' + encodeURIComponent(matchId) + '/comments' + (lastCommentId ? '?after=' + lastCommentId : '');
    return SL.getJSON(url).then(function (r) {
      if (!r.ok) return;
      addComments(r.data.comments || []);
      updateCount(r.data.count || 0);
    }).catch(function () {});
  }

  try { nameEl.value = localStorage.getItem('sl_name') || ''; } catch (e) { /* storage disabled */ }

  bodyEl.addEventListener('input', function () {
    charEl.textContent = Array.from(bodyEl.value).length + '/500';
  });
  bodyEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); form.requestSubmit(); }
  });

  var cooldownTimer = null;
  function cooldown(seconds) {
    clearInterval(cooldownTimer);
    var left = seconds;
    sendBtn.disabled = true;
    sendBtn.textContent = T.send + ' (' + left + ')';
    cooldownTimer = setInterval(function () {
      left--;
      if (left <= 0) {
        clearInterval(cooldownTimer);
        sendBtn.disabled = false;
        sendBtn.textContent = T.send;
      } else {
        sendBtn.textContent = T.send + ' (' + left + ')';
      }
    }, 1000);
  }

  function shake(el) {
    el.classList.remove('shake');
    void el.offsetWidth;
    el.classList.add('shake');
    el.focus();
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var body = bodyEl.value.trim();
    if (!body) { shake(bodyEl); return; }
    if (sendBtn.disabled) return;
    var name = nameEl.value.trim();
    try { localStorage.setItem('sl_name', name); } catch (err) { /* ignore */ }
    sendBtn.disabled = true;
    SL.getJSON('/api/match/' + encodeURIComponent(matchId) + '/comments', {
      method: 'POST', body: { name: name, body: body }
    }).then(function (r) {
      if (r.status === 201 && r.data.comment) {
        addComments([r.data.comment]);
        updateCount(commentCount + 1);
        bodyEl.value = '';
        charEl.textContent = '0/500';
        cooldown(10);
      } else if (r.status === 429) {
        cooldown((r.data && r.data.retryAfter) || 10);
      } else {
        sendBtn.disabled = false;
        shake(bodyEl);
      }
    }).catch(function () { sendBtn.disabled = false; shake(bodyEl); });
  });

  // ------------------------------------------------------------------ timers
  setInterval(function () {
    var els = document.querySelectorAll('.countdown[data-kickoff]');
    for (var i = 0; i < els.length; i++) els[i].textContent = SL.countdown(els[i].getAttribute('data-kickoff'));
  }, 1000);

  setInterval(function () {
    var els = listEl.querySelectorAll('time.c-time');
    for (var i = 0; i < els.length; i++) els[i].textContent = SL.timeAgo(els[i].dateTime);
  }, 30000);

  setInterval(function () { if (!document.hidden) pollComments(); }, 8000);
  setInterval(function () { if (!document.hidden) loadMatch(); }, 30000);
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) { pollComments(); loadMatch(); }
  });

  // -------------------------------------------------------------------- boot
  renderSlots(pageData.slots);
  if (match) { renderHead(); renderPlayer(); }
  if (!matchId) { notFound = true; renderHead(); }
  loadMatch();
  pollComments().then(function () { updateCount(commentCount); });
})();
