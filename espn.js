'use strict';

/*
 * ESPN public scoreboard client with an in-memory cache.
 *
 * Cache granularity is one entry per (league slug, ESPN date). Each league is
 * queried for several dates; a failed request keeps the last good payload for
 * that key, so a flaky league or a temporary ESPN outage never empties the
 * list. Reads are stale-while-revalidate: fresh data is returned instantly,
 * moderately stale data is returned instantly while a refresh runs in the
 * background, and only missing / very stale data is awaited (bounded by the
 * fetch timeout).
 */

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const USER_AGENT = 'Mozilla/5.0 (compatible; soccer-live/1.0)';

function ymdUtc(ms) {
  return new Date(ms).toISOString().slice(0, 10).replace(/-/g, '');
}

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function pickLogo(logos) {
  if (!Array.isArray(logos) || logos.length === 0) return null;
  // Site is dark-themed: prefer ESPN's "dark" variant when it exists.
  const dark = logos.find((l) => Array.isArray(l.rel) && l.rel.includes('dark') && l.href);
  const any = dark || logos.find((l) => l && l.href);
  return any ? any.href : null;
}

function findLeague(event, payload) {
  const leagues = Array.isArray(payload.leagues) ? payload.leagues : [];
  const season = event.season || {};
  if (season.slug || season.type) {
    const hit = leagues.find((l) => {
      const ls = l.season || {};
      if (ls.slug && ls.slug === season.slug) return true;
      if (season.slug && slugify(ls.displayName) === season.slug) return true;
      if (season.type && ls.type && String(ls.type.type ?? ls.type.id) === String(season.type)) return true;
      return false;
    });
    if (hit) return hit;
  }
  return leagues[0] || {};
}

function toScore(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(typeof v === 'object' ? v.value ?? v.displayValue : v);
  return Number.isFinite(n) ? n : null;
}

function mapTeam(c, played) {
  const team = (c && c.team) || {};
  const name = team.displayName || team.name || team.shortDisplayName || '?';
  return {
    name,
    short: team.shortDisplayName || team.abbreviation || name,
    logo: team.logo || pickLogo(team.logos) || null,
    score: played ? toScore(c.score) : null,
  };
}

function mapEvent(event, payload, leagueOrder) {
  const comp = Array.isArray(event.competitions) ? event.competitions[0] : null;
  if (!event || !event.id || !comp) return null;
  const status = comp.status || event.status || {};
  const type = status.type || {};
  let state = ['pre', 'in', 'post'].includes(type.state) ? type.state : 'pre';
  const kickoffMs = Date.parse(event.date || comp.date);
  if (!Number.isFinite(kickoffMs)) return null;

  // "post" also covers postponed / cancelled games; those have no real score.
  const played = state === 'in' || (state === 'post' && type.completed !== false);

  const competitors = Array.isArray(comp.competitors) ? comp.competitors : [];
  const home = competitors.find((c) => c.homeAway === 'home') || competitors[0];
  const away = competitors.find((c) => c.homeAway === 'away') || competitors[1];
  if (!home || !away) return null;

  const league = findLeague(event, payload);
  const isHalftime = type.name === 'STATUS_HALFTIME';

  return {
    id: String(event.id),
    kickoff: new Date(kickoffMs).toISOString(),
    state,
    clock: state === 'in' ? (isHalftime ? (type.shortDetail || 'HT') : (status.displayClock || '')) : '',
    statusDetail: type.shortDetail && state !== 'pre' ? type.shortDetail : (type.detail || ''),
    league: {
      name: league.name || league.abbreviation || '',
      logo: pickLogo(league.logos),
    },
    home: mapTeam(home, played),
    away: mapTeam(away, played),
    hasStream: false,
    _order: leagueOrder,
  };
}

function compareMatches(a, b) {
  const la = a.state === 'in' ? 0 : 1;
  const lb = b.state === 'in' ? 0 : 1;
  if (la !== lb) return la - lb;
  const ka = Date.parse(a.kickoff);
  const kb = Date.parse(b.kickoff);
  if (ka !== kb) return ka - kb;
  if (a._order !== b._order) return a._order - b._order;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function publicView(m) {
  const { _order, ...rest } = m;
  return rest;
}

class FixtureService {
  constructor(config, { logger = console, fetchImpl = globalThis.fetch } = {}) {
    this.leagues = config.leagues;
    this.base = config.espnBaseUrl;
    this.ttlMs = config.cacheTtlSeconds * 1000;
    this.staleMaxMs = config.staleMaxSeconds * 1000;
    this.backoffMs = config.failureBackoffSeconds * 1000;
    this.timeoutMs = config.fetchTimeoutMs;
    this.publicOffsets = config.publicDayOffsets;
    this.adminOffsets = config.adminExtraDayOffsets;
    this.adminTtlMs = config.adminCacheTtlSeconds * 1000;
    this.pastMs = config.windowPastHours * HOUR;
    this.futureMs = config.windowFutureDays * DAY;
    this.log = logger;
    this.fetch = fetchImpl;

    /** key `${slug}|${yyyymmdd}` -> { at, failedAt, matches, inflight } */
    this.cache = new Map();
    /** id -> match (latest version seen), pruned to a few days. */
    this.seen = new Map();
  }

  keysFor(offsets, now = Date.now()) {
    const dates = offsets.map((o) => ymdUtc(now + o * DAY));
    const keys = [];
    this.leagues.forEach((slug, order) => {
      for (const date of dates) keys.push({ key: `${slug}|${date}`, slug, date, order });
    });
    return keys;
  }

  async fetchKey({ key, slug, date, order }) {
    const url = `${this.base}/${encodeURIComponent(slug)}/scoreboard?dates=${date}`;
    const entry = this.cache.get(key) || { at: 0, failedAt: 0, matches: null, inflight: null };
    this.cache.set(key, entry);
    if (entry.inflight) return entry.inflight;

    entry.inflight = (async () => {
      try {
        const res = await this.fetch(url, {
          headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const payload = await res.json();
        const events = Array.isArray(payload.events) ? payload.events : [];
        const matches = [];
        for (const ev of events) {
          try {
            const m = mapEvent(ev, payload, order);
            if (m) matches.push(m);
          } catch (err) {
            this.log.warn(`[espn] skip event in ${slug}: ${err.message}`);
          }
        }
        entry.matches = matches;
        entry.at = Date.now();
        entry.failedAt = 0;
        for (const m of matches) this.seen.set(m.id, m);
      } catch (err) {
        entry.failedAt = Date.now();
        this.log.warn(`[espn] ${slug} ${date} failed: ${err.name === 'TimeoutError' ? 'timeout' : err.message}`);
      } finally {
        entry.inflight = null;
      }
    })();
    return entry.inflight;
  }

  /**
   * Make sure the given keys are reasonably fresh. Returns once every key that
   * has no usable data (or data older than staleMax) has been (re)fetched;
   * merely stale keys are refreshed in the background.
   */
  async ensure(keys, ttlMs) {
    const now = Date.now();
    const waits = [];
    for (const k of keys) {
      const e = this.cache.get(k.key);
      const age = e && e.matches ? now - e.at : Infinity;
      if (age < ttlMs) continue;
      if (e && e.inflight) {
        if (age > this.staleMaxMs) waits.push(e.inflight);
        continue;
      }
      if (e && e.failedAt && now - e.failedAt < this.backoffMs) continue;
      const p = this.fetchKey(k);
      if (age > Math.max(this.staleMaxMs, ttlMs)) waits.push(p);
    }
    if (waits.length) await Promise.allSettled(waits);
    this.pruneSeen();
  }

  pruneSeen() {
    const cutoff = Date.now() - 3 * DAY;
    for (const [id, m] of this.seen) {
      if (Date.parse(m.kickoff) < cutoff) this.seen.delete(id);
    }
  }

  collect(keys) {
    const byId = new Map();
    let updated = 0;
    for (const k of keys) {
      const e = this.cache.get(k.key);
      if (!e || !e.matches) continue;
      updated = Math.max(updated, e.at);
      for (const m of e.matches) {
        const prev = byId.get(m.id);
        if (!prev || prev._at < e.at) byId.set(m.id, Object.assign({}, m, { _at: e.at }));
      }
    }
    return { list: [...byId.values()].map(({ _at, ...m }) => m), updated };
  }

  inWindow(m, now) {
    if (m.state === 'in') return true;
    const k = Date.parse(m.kickoff);
    return k >= now - this.pastMs && k <= now + this.futureMs;
  }

  /** Public list: yesterday/today/tomorrow (UTC), filtered to the window. */
  async getMatches() {
    const keys = this.keysFor(this.publicOffsets);
    await this.ensure(keys, this.ttlMs);
    const now = Date.now();
    const { list, updated } = this.collect(keys);
    const matches = list.filter((m) => this.inWindow(m, now)).sort(compareMatches).map(publicView);
    return { updatedAt: new Date(updated || now).toISOString(), matches };
  }

  /** Admin list: public dates plus the following days, upcoming/live only. */
  async getAdminMatches() {
    const pub = this.keysFor(this.publicOffsets);
    const extra = this.keysFor(this.adminOffsets);
    await Promise.all([this.ensure(pub, this.ttlMs), this.ensure(extra, this.adminTtlMs)]);
    const now = Date.now();
    const { list } = this.collect([...pub, ...extra]);
    return list
      .filter((m) => m.state !== 'post' && this.inWindow(m, now))
      .sort(compareMatches)
      .map(publicView);
  }

  /** Look a match up by id, refreshing the public window if needed. */
  async getMatch(id) {
    id = String(id);
    await this.ensure(this.keysFor(this.publicOffsets), this.ttlMs);
    const m = this.seen.get(id);
    return m ? publicView(m) : null;
  }

  /** Synchronous lookup without triggering any fetch. */
  peekMatch(id) {
    const m = this.seen.get(String(id));
    return m ? publicView(m) : null;
  }

  warmUp() {
    return this.ensure(this.keysFor(this.publicOffsets), this.ttlMs);
  }
}

module.exports = { FixtureService, mapEvent, compareMatches };
