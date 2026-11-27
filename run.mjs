// Capture job: reads each enabled source, merges new tenders into feed.json.
// Every source (and every portal inside a group) runs on its own with a timeout,
// so one broken site never stops the rest.
import fs from 'node:fs';
import path from 'node:path';
import { toItem } from './lib.mjs';
import * as adapters from './adapters.mjs';

const ROOT = process.env.RADAR_ROOT || process.cwd();
const FEED = path.join(ROOT, 'feed.json');
const SRC = JSON.parse(fs.readFileSync(path.join(ROOT, 'sources.json'), 'utf8'));
const MAX_ITEMS = 6000;
const RANK = { LOW: 0, MEDIUM: 1, HIGH: 2 };
const DAY = 864e5;
const TODAY = new Date().toISOString().slice(0, 10);
const now = new Date().toISOString();

const feed = fs.existsSync(FEED) ? JSON.parse(fs.readFileSync(FEED, 'utf8')) : { version: 1, items: [], runs: [], sources: [] };
const byKey = new Map(feed.items.map(i => [i.key, i]));
const byUrl = new Map(feed.items.filter(i => i.url && !i.lu).map(i => [i.url, i]));
const oldHealth = new Map((feed.sources || []).map(s => [s.name, s]));
const health = [];
const runs = [];
let totalNew = 0;

const withTimeout = (p, ms) => { let t; return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`Timed out after ${ms / 1000}s`)), ms); })]).finally(() => clearTimeout(t)); };

async function runUnit(cfg) {
  const fn = adapters[cfg.type];
  if (!fn) throw new Error('Unknown source type: ' + cfg.type);
  return withTimeout(fn(cfg), cfg.timeoutMs || 90000);
}

/** Run units a few at a time. */
async function pool(units, size, worker) {
  const out = new Array(units.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, units.length) }, async () => {
    while (next < units.length) { const i = next++; out[i] = await worker(units[i]); }
  }));
  return out;
}

for (const cfg of SRC.sources) {
  const h = { ...(oldHealth.get(cfg.name) || {}), name: cfg.name, type: cfg.type, enabled: cfg.enabled !== false, note: cfg.note || '' };
  health.push(h);
  if (cfg.enabled === false) { h.status = 'DISABLED'; continue; }
  const t0 = Date.now();
  const run = { source: cfg.name, at: now };
  const units = cfg.portals
    ? cfg.portals.map(p => ({ ...cfg, ...p, portals: undefined, label: p.name, timeoutMs: cfg.timeoutMs || 35000 }))
    : [cfg];
  const results = await pool(units, cfg.portals ? 5 : 1, async u => {
    try { return { u, raw: await runUnit(u) }; } catch (e) { return { u, error: String(e.message || e).slice(0, 120) }; }
  });

  const failed = results.filter(r => r.error);
  let added = 0, seen = 0, skipped = 0;
  const need = RANK[cfg.minRelevance || 'MEDIUM'];
  const cap = cfg.maxNew ?? 150;
  for (const r of results) {
    for (const rec of r.raw || []) {
      const it = toItem(rec, cfg.name);
      if (!it) continue;
      seen++;
      const old = byKey.get(it.key) || (!it.lu && it.url ? byUrl.get(it.url) : null);
      if (old) {
        old.lastSeen = now;
        for (const k of ['url', 'deadline', 'published', 'country', 'ref']) if (!old[k] && it[k]) old[k] = it[k];
        if (!old.value && it.value) { old.value = it.value; old.cur = it.cur; }
        if (it.deadline && it.deadline !== old.deadline) old.deadline = it.deadline; // the source's date wins
        continue;
      }
      // New tenders must be relevant to IQT, still open, and within the per-run cap.
      if (cfg.type !== 'csv' && (RANK[it.rel] < need || (it.deadline && it.deadline < TODAY) || added >= cap)) { skipped++; continue; }
      const n = { id: 'F' + Buffer.from(it.key).toString('base64url').slice(0, 14), ...it, firstSeen: now, lastSeen: now };
      byKey.set(it.key, n);
      if (n.url && !n.lu) byUrl.set(n.url, n);
      added++;
    }
  }

  const detail = failed.length ? failed.slice(0, 6).map(f => `${f.u.label || f.u.name}: ${f.error}`).join('; ') + (failed.length > 6 ? ` and ${failed.length - 6} more` : '') : '';
  const status = failed.length === results.length ? 'ERROR' : failed.length ? 'PARTIAL' : seen ? 'OK' : 'EMPTY';
  Object.assign(run, { status, fetched: seen, added, skipped, ms: Date.now() - t0 });
  if (detail) run.error = detail;
  Object.assign(h, { status, lastRun: now, lastCount: seen, lastAdded: added, error: detail, units: cfg.portals ? `${results.length - failed.length} of ${results.length} portals reachable` : '' });
  if (seen) h.lastOk = now;
  totalNew += added;
  runs.push(run);
  console.log(`${status.padEnd(7)} ${cfg.name}  fetched=${seen} new=${added} skipped=${skipped} ${h.units || ''} ${detail.slice(0, 160)}`);
}

// Keep the feed small: drop tenders closed for 3 weeks, and undated ones not seen for 75 days.
let items = [...byKey.values()].filter(i =>
  i.deadline ? Date.parse(i.deadline) > Date.now() - 21 * DAY : Date.parse(i.firstSeen || now) > Date.now() - 75 * DAY);
items.sort((a, b) => (b.firstSeen || '').localeCompare(a.firstSeen || ''));
if (items.length > MAX_ITEMS) items = items.slice(0, MAX_ITEMS);

const out = { version: 1, generated: now, newThisRun: totalNew, count: items.length, sources: health, runs: [...runs, ...(feed.runs || [])].slice(0, 120), items };
fs.writeFileSync(FEED + '.tmp', JSON.stringify(out));
fs.renameSync(FEED + '.tmp', FEED);
console.log(`Feed written: ${items.length} tenders, ${totalNew} new this run.`);
process.exit(0);
