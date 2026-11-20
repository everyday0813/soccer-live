/* Shared helpers for all pages. Exposes window.SL. No dependencies. */
(function () {
  'use strict';

  // All visible UI strings (Khmer, verbatim from the product brief).
  var T = {
    site: 'បាល់ទាត់ផ្ទាល់',
    home: 'ផ្ទះ',
    matches: 'ការប្រកួត',
    today: 'ថ្ងៃនេះ',
    tomorrow: 'ថ្ងៃស្អែក',
    live: 'ផ្សាយផ្ទាល់',
    finished: 'បានបញ្ចប់',
    upcoming: 'មិនទាន់ចាប់ផ្តើម',
    countdown: 'ចាប់ផ្តើមក្នុង',
    score: 'ពិន្ទុ',
    comments: 'មតិយោបល់',
    noComments: 'គ្មានមតិយោបល់នៅឡើយទេ',
    writeComment: 'សរសេរមតិយោបល់...',
    namePlaceholder: 'ឈ្មោះ (ស្រេចចិត្ត)',
    send: 'ផ្ញើ',
    noStream: 'មិនទាន់មានតំណផ្សាយសម្រាប់ការប្រកួតនេះទេ',
    back: 'ត្រឡប់ក្រោយ',
    ad: 'ផ្ទាំងពាណិជ្ជកម្ម',
    admin: 'គ្រប់គ្រង',
    streamLink: 'តំណផ្សាយ',
    save: 'រក្សាទុក',
    saved: 'បានរក្សាទុក',
    loginFailed: 'ពាក្យសម្ងាត់មិនត្រឹមត្រូវ។',
    tooManyAttempts: 'ប្រើច្រើនដងពេក — សូមព្យាយាមម្តងទៀតក្នុងរយៈពេល 15 នាទី។',
    sessionExpired: 'សម័យបានផុតកំណត់',
    deleteSlot: 'លុបផ្ទាំងទី',
    recentComments: 'មតិយោបល់ថ្មីៗ',
    refresh: 'ធ្វើឱ្យស្រស់',
    del: 'លុប',
    deleteComment: 'លុបមតិយោបល់នេះ?',
    fan: 'អ្នកគាំទ្រ',
    justNow: 'ទើបនេះ',
    minutesAgo: 'នាទីមុន',
    hoursAgo: 'ម៉ោងមុន',
    days: ['អាទិត្យ', 'ចន្ទ', 'អង្គារ', 'ពុធ', 'ព្រហស្បតិ៍', 'សុក្រ', 'សៅរ៍']
  };

  // Server/client clock skew, estimated from the HTTP Date header.
  var skewMs = 0;

  function now() { return Date.now() + skewMs; }

  function getJSON(url, opts) {
    opts = opts || {};
    var init = { method: opts.method || 'GET', credentials: 'same-origin', headers: { accept: 'application/json' } };
    if (opts.body !== undefined) {
      if (opts.body instanceof FormData) init.body = opts.body;
      else { init.body = JSON.stringify(opts.body); init.headers['content-type'] = 'application/json'; }
    }
    return fetch(url, init).then(function (res) {
      var d = res.headers.get('date');
      if (d) {
        var server = Date.parse(d);
        // The header has 1 s resolution; only correct clearly wrong clocks.
        if (!isNaN(server) && Math.abs(server - Date.now()) > 5000) skewMs = server - Date.now();
      }
      return res.json().catch(function () { return {}; }).then(function (data) {
        return { ok: res.ok, status: res.status, data: data };
      });
    });
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function hhmm(iso) {
    var d = new Date(iso);
    return pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function dayKey(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }

  /** "ថ្ងៃនេះ", "ថ្ងៃស្អែក" or "<weekday> dd/mm" in the viewer's local time. */
  function dayLabel(iso) {
    var d = new Date(iso);
    var t = new Date(now());
    var tm = new Date(now() + 86400000);
    var base = T.days[d.getDay()] + ' ' + pad(d.getDate()) + '/' + pad(d.getMonth() + 1);
    if (dayKey(d) === dayKey(t)) return T.today + ' · ' + base;
    if (dayKey(d) === dayKey(tm)) return T.tomorrow + ' · ' + base;
    return base;
  }

  function relDay(iso) {
    var d = new Date(iso);
    if (dayKey(d) === dayKey(new Date(now()))) return 'today';
    if (dayKey(d) === dayKey(new Date(now() + 86400000))) return 'tomorrow';
    return 'other';
  }

  /** Countdown "HH:MM:SS" (hours may exceed 24). */
  function countdown(iso) {
    var ms = Math.max(0, Date.parse(iso) - now());
    var s = Math.floor(ms / 1000);
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    return pad(h) + ':' + pad(m) + ':' + pad(s % 60);
  }

  function timeAgo(iso) {
    var diff = Math.max(0, now() - Date.parse(iso));
    var min = Math.floor(diff / 60000);
    if (min < 1) return T.justNow;
    if (min < 60) return min + ' ' + T.minutesAgo;
    var h = Math.floor(min / 60);
    if (h < 24) return h + ' ' + T.hoursAgo;
    var d = new Date(iso);
    return pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + ' ' + hhmm(iso);
  }

  function firstGrapheme(s) {
    s = String(s || '').trim();
    if (!s) return '?';
    if (window.Intl && Intl.Segmenter) {
      var it = new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s)[Symbol.iterator]().next();
      if (!it.done) return it.value.segment.toUpperCase();
    }
    return Array.from(s)[0].toUpperCase();
  }

  /** <img> logo with a neutral fallback circle (see the global error handler below). */
  function logo(url, name, cls) {
    cls = cls || 'logo';
    if (!url) return '<span class="' + cls + ' logo-fallback" aria-hidden="true">' + esc(firstGrapheme(name)) + '</span>';
    return '<img class="' + cls + '" src="' + esc(url) + '" alt="" width="36" height="36" loading="lazy" ' +
      'decoding="async" referrerpolicy="no-referrer" data-name="' + esc(name) + '">';
  }

  document.addEventListener('error', function (e) {
    var el = e.target;
    if (!el || el.tagName !== 'IMG' || !/\b(logo|lg-logo)\b/.test(el.className) || el.dataset.failed) return;
    el.dataset.failed = '1';
    var span = document.createElement('span');
    span.className = el.className + ' logo-fallback';
    span.setAttribute('aria-hidden', 'true');
    span.textContent = firstGrapheme(el.dataset.name || '');
    el.replaceWith(span);
  }, true);

  window.SL = {
    T: T, getJSON: getJSON, esc: esc, pad: pad, hhmm: hhmm, dayLabel: dayLabel, dayKey: dayKey, relDay: relDay,
    countdown: countdown, timeAgo: timeAgo, firstGrapheme: firstGrapheme, logo: logo, now: now
  };
})();
