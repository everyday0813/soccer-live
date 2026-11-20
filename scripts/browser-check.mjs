#!/usr/bin/env node
// Headless-browser UI check using the Chrome DevTools Protocol directly
// (no Playwright download needed when google-chrome / chromium is installed).
//
// Usage: node scripts/browser-check.mjs <baseUrl> <matchId> <outDir>

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [base = 'http://localhost:18117', matchId, outDir = '/tmp/soccer-shots'] = process.argv.slice(2);
if (!matchId) { console.error('usage: browser-check.mjs <baseUrl> <matchId> [outDir]'); process.exit(2); }
mkdirSync(outDir, { recursive: true });

const CANDIDATES = [process.env.CHROME_BIN, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'].filter(Boolean);
const chromeBin = CANDIDATES.find((p) => existsSync(p));
if (!chromeBin) { console.error('No Chrome/Chromium found (set CHROME_BIN or use playwright)'); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), 'soccer-chrome-'));
const port = 9300 + Math.floor(Math.random() * 500);
const chrome = spawn(chromeBin, [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
  '--mute-audio', '--disable-extensions', '--autoplay-policy=no-user-gesture-required',
  ...(process.getuid && process.getuid() === 0 ? ['--no-sandbox'] : []),
  'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });
let chromeErr = '';
chrome.stderr.on('data', (d) => { chromeErr += d; });

let failures = 0;
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  if (!ok) failures++;
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail !== undefined ? ' — ' + detail : ''}`);
}

async function cleanup(code) {
  try { chrome.kill('SIGTERM'); } catch {}
  await sleep(300);
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
  process.exit(code);
}

async function connect() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(250);
  }
  throw new Error('Chrome did not start: ' + chromeErr.slice(0, 500));
}

const wsUrl = await connect().catch(async (e) => { console.error(e.message); await cleanup(2); });
const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let seq = 0;
const pending = new Map();
const listeners = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
  } else if (msg.method && listeners.has(msg.method)) {
    for (const fn of listeners.get(msg.method)) fn(msg.params);
  }
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
const once = (method, timeout = 20000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('timeout waiting for ' + method)), timeout);
  const fn = (p) => { clearTimeout(t); listeners.get(method).delete(fn); resolve(p); };
  if (!listeners.has(method)) listeners.set(method, new Set());
  listeners.get(method).add(fn);
});
async function evaluate(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('eval failed: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
}
async function waitFor(expr, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await evaluate(`!!(${expr})`).catch(() => false)) return true;
    await sleep(150);
  }
  return false;
}
async function goto(url) {
  const loaded = once('Page.loadEventFired', 30000);
  await send('Page.navigate', { url });
  await loaded;
  await evaluate('document.fonts.ready.then(() => true)');
}
async function screenshot(file) {
  const m = await send('Page.getLayoutMetrics');
  const size = m.cssContentSize || m.contentSize;
  const height = Math.min(Math.ceil(size.height), 8000);
  const vp = m.cssLayoutViewport || m.layoutViewport;
  const shot = await send('Page.captureScreenshot', {
    format: 'png', captureBeyondViewport: true,
    clip: { x: 0, y: 0, width: vp.clientWidth, height, scale: 1 },
  });
  writeFileSync(file, Buffer.from(shot.data, 'base64'));
  return { file, height };
}

const KHMER = /[ក-៿]/;
const FONT_CHECK = `(() => {
  const faces = [...document.fonts].filter(f => /Noto Sans Khmer/.test(f.family));
  return {
    check: document.fonts.check('16px "Noto Sans Khmer"'),
    checkKhmer: document.fonts.check('16px "Noto Sans Khmer"', 'ផ្សាយផ្ទាល់'),
    loadedFaces: faces.filter(f => f.status === 'loaded').length,
    totalFaces: faces.length,
  };
})()`;

await send('Page.enable');
await send('Runtime.enable');

const viewports = [
  { name: 'mobile', width: 390, height: 844, mobile: true, dpr: 2 },
  { name: 'desktop', width: 1440, height: 900, mobile: false, dpr: 1 },
];

for (const vp of viewports) {
  console.log(`\n== ${vp.name} ${vp.width}x${vp.height}`);
  await send('Emulation.setDeviceMetricsOverride', {
    width: vp.width, height: vp.height, deviceScaleFactor: vp.dpr, mobile: vp.mobile,
  });
  await send('Emulation.setTouchEmulationEnabled', { enabled: vp.mobile });

  // ---------------------------------------------------------------- home
  await goto(`${base}/`);
  await waitFor(`document.querySelectorAll('.match-row').length > 0`, 20000);
  // Let lazy logos / Khmer font subsets settle before measuring and shooting.
  await sleep(1200);
  await evaluate('document.fonts.ready.then(() => true)');
  const home = await evaluate(`(() => {
    const rows = document.querySelectorAll('.match-row');
    const labels = [...document.querySelectorAll('.tab, .group-head, .brand-name, .nav a, .cd-label, .live-badge, .ft-badge')]
      .map(e => e.textContent.trim()).filter(Boolean);
    const first = rows[0] ? rows[0].getBoundingClientRect() : null;
    const logo = document.querySelector('.match-row img.logo, .match-row .logo');
    const cs = document.querySelector('.countdown');
    const row = rows[0];
    return {
      title: document.title, rows: rows.length, labels: labels.slice(0, 12), labelCount: labels.length,
      firstRowHeight: first && Math.round(first.height), firstRowWidth: first && Math.round(first.width),
      logoPx: logo ? Math.round(logo.getBoundingClientRect().width) : null,
      bodyFont: getComputedStyle(document.body).fontFamily, lineHeight: getComputedStyle(document.body).lineHeight,
      gridCols: row ? getComputedStyle(row).gridTemplateColumns.split(' ').length : 0,
      countdownT0: cs ? cs.textContent : null,
      overflowX: document.documentElement.scrollWidth > window.innerWidth,
    };
  })()`);
  const fontsHome = await evaluate(FONT_CHECK);
  await sleep(2100);
  const cdT1 = await evaluate(`(document.querySelector('.countdown') || {}).textContent || null`);
  const shotHome = await screenshot(join(outDir, `home-${vp.name}.png`));

  console.log(`  title="${home.title}" rows=${home.rows} firstRow=${home.firstRowWidth}x${home.firstRowHeight}px logo=${home.logoPx}px gridCols=${home.gridCols}`);
  console.log(`  labels: ${home.labels.join(' | ')}`);
  console.log(`  fonts: check()=${fontsHome.check} check(khmer)=${fontsHome.checkKhmer} NotoSansKhmer faces loaded=${fontsHome.loadedFaces}/${fontsHome.totalFaces}`);
  console.log(`  countdown: "${home.countdownT0}" -> (2.1 s) -> "${cdT1}"`);
  console.log(`  screenshot: ${shotHome.file} (${vp.width}x${shotHome.height})`);
  check('home: Khmer title', KHMER.test(home.title), home.title);
  check('home: match rows rendered', home.rows >= 5, `${home.rows} rows`);
  check('home: labels are Khmer', home.labels.length > 0 && home.labels.every((l) => KHMER.test(l)), `${home.labelCount} labels`);
  check('home: Noto Sans Khmer loaded (fonts.check)', fontsHome.check === true && fontsHome.checkKhmer === true);
  check('home: countdown ticks', !!home.countdownT0 && home.countdownT0 !== cdT1, `${home.countdownT0} -> ${cdT1}`);
  check('home: logo size', home.logoPx === (vp.mobile ? 30 : 36), `${home.logoPx}px`);
  check(`home: layout (${vp.mobile ? 'stacked cards' : 'table row'})`, vp.mobile ? home.gridCols === 2 : home.gridCols === 6, `${home.gridCols} grid columns`);
  check('home: no horizontal overflow', !home.overflowX);

  // --------------------------------------------------------------- match
  await goto(`${base}/match/${matchId}`);
  await waitFor(`document.querySelector('.player .player-media, .player .no-stream')`, 15000);
  await sleep(2500); // let the HLS stream / fonts settle
  const mp = await evaluate(`(() => {
    const r = (sel) => { const el = document.querySelector(sel); if (!el) return null; const b = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return { x: Math.round(b.left), y: Math.round(b.top + scrollY), w: Math.round(b.width), h: Math.round(b.height),
               visible: b.width > 0 && b.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden' && !el.hidden,
               kind: el.className }; };
    const video = document.querySelector('.player video');
    return {
      title: document.title,
      head: (document.querySelector('.mh-center') || {}).innerText || '',
      s1: r('#slot-1'), s2: r('#slot-2'), s3: r('#slot-3'), player: r('#player'),
      media: (document.querySelector('.player .player-media') || {}).tagName || 'none',
      videoState: video ? { readyState: video.readyState, w: video.videoWidth, h: video.videoHeight } : null,
      labels: [...document.querySelectorAll('.back-link, .section-title, #c-send, .slot-ph span, .no-stream p, .empty-comments:not([hidden])')]
        .map(e => e.textContent.trim()).filter(Boolean),
      placeholders: { name: document.getElementById('c-name').placeholder, body: document.getElementById('c-body').placeholder },
      overflowX: document.documentElement.scrollWidth > window.innerWidth,
    };
  })()`);
  const fontsMatch = await evaluate(FONT_CHECK);
  const shotMatch = await screenshot(join(outDir, `match-${vp.name}.png`));

  const fmt = (s) => s ? `${s.w}x${s.h}@(${s.x},${s.y})${s.visible ? '' : ' HIDDEN'}` : 'missing';
  console.log(`  title="${mp.title}"`);
  console.log(`  slot1=${fmt(mp.s1)} player=${fmt(mp.player)} slot2=${fmt(mp.s2)} slot3=${fmt(mp.s3)}`);
  console.log(`  player media=${mp.media} video=${JSON.stringify(mp.videoState)}`);
  console.log(`  labels: ${mp.labels.join(' | ')} | placeholders: ${mp.placeholders.name} / ${mp.placeholders.body}`);
  console.log(`  fonts: check()=${fontsMatch.check} check(khmer)=${fontsMatch.checkKhmer}`);
  console.log(`  screenshot: ${shotMatch.file} (${vp.width}x${shotMatch.height})`);

  const allVisible = [mp.s1, mp.s2, mp.s3].every((s) => s && s.visible);
  check('match: Khmer title', KHMER.test(mp.title), mp.title);
  check('match: three ad slots visible', allVisible);
  check('match: slot 1 directly above player', mp.s1 && mp.player && mp.s1.y + mp.s1.h <= mp.player.y && mp.player.y - (mp.s1.y + mp.s1.h) <= 24,
    `gap ${mp.player.y - (mp.s1.y + mp.s1.h)}px`);
  check('match: slots 2/3 below player', mp.s2.y >= mp.player.y + mp.player.h && mp.s3.y >= mp.player.y + mp.player.h);
  if (vp.mobile) {
    check('match: slots 2/3 stacked (mobile)', mp.s3.y >= mp.s2.y + mp.s2.h && mp.s2.x === mp.s3.x && mp.s2.w === mp.s3.w,
      `slot2 ${mp.s2.w}px wide, slot3 starts ${mp.s3.y - (mp.s2.y + mp.s2.h)}px below slot2`);
    check('match: slot 1 is 320x100 ratio', Math.abs(mp.s1.w / mp.s1.h - 3.2) < 0.05, `${mp.s1.w}x${mp.s1.h}`);
  } else {
    check('match: slots 2/3 side by side 50/50 (desktop)', mp.s2.y === mp.s3.y && mp.s2.x + mp.s2.w <= mp.s3.x && Math.abs(mp.s2.w - mp.s3.w) <= 1,
      `slot2 ${mp.s2.w}px, slot3 ${mp.s3.w}px, same top=${mp.s2.y === mp.s3.y}`);
    check('match: slot 1 max 970x90', mp.s1.w <= 970 && Math.abs(mp.s1.w / mp.s1.h - 970 / 90) < 0.15, `${mp.s1.w}x${mp.s1.h}`);
  }
  check('match: labels are Khmer', mp.labels.length > 0 && mp.labels.every((l) => KHMER.test(l)) &&
    KHMER.test(mp.placeholders.name) && KHMER.test(mp.placeholders.body), `${mp.labels.length} labels`);
  check('match: Noto Sans Khmer loaded (fonts.check)', fontsMatch.check === true && fontsMatch.checkKhmer === true);
  check('match: no horizontal overflow', !mp.overflowX);
}

// Layout-shift check on the match page (desktop): CLS from PerformanceObserver.
const cls = await evaluate(`new Promise(res => { let v = 0; new PerformanceObserver(l => { for (const e of l.getEntries()) if (!e.hadRecentInput) v += e.value; })
  .observe({ type: 'layout-shift', buffered: true }); setTimeout(() => res(Math.round(v * 1000) / 1000), 300); })`);
console.log(`\n  match page cumulative layout shift (desktop): ${cls}`);
check('match: CLS < 0.1', cls < 0.1, String(cls));

// Admin page (desktop): log in through the real form, list matches + slots.
if (process.env.ADMIN_PASSWORD) {
  console.log('\n== admin 1440x900');
  await goto(`${base}/admin`);
  await waitFor(`!document.getElementById('login').hidden`);
  await evaluate(`(() => { document.getElementById('password').value = ${JSON.stringify(process.env.ADMIN_PASSWORD)};
    document.getElementById('login-form').requestSubmit(); return true; })()`);
  const okAdmin = await waitFor(`document.querySelectorAll('.am-row').length > 0`, 30000);
  const adm = await evaluate(`({ rows: document.querySelectorAll('.am-row').length, withUrl: document.querySelectorAll('.am-row.has-url').length,
    slots: document.querySelectorAll('.slot-card').length, img: !!document.querySelector('.slot-preview img') })`);
  const shotAdmin = await screenshot(join(outDir, 'admin-desktop.png'));
  console.log(`  rows=${adm.rows} withStream=${adm.withUrl} slotCards=${adm.slots} slot1Image=${adm.img}`);
  console.log(`  screenshot: ${shotAdmin.file} (1440x${shotAdmin.height})`);
  check('admin: login + match list', okAdmin && adm.rows > 0 && adm.withUrl === 1 && adm.slots === 3 && adm.img);
}

console.log(`\nbrowser: ${chromeBin}`);
console.log(`${results.length - failures}/${results.length} browser checks passed`);
ws.close();
await cleanup(failures ? 1 : 0);
