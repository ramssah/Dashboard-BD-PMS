// Capture job: reads each enabled source, merges new tenders into docs/data/feed.json.
// Every source runs on its own, with a timeout, so one broken site never stops the rest.
import fs from 'node:fs';
import path from 'node:path';
import { toItem } from './lib.mjs';
import * as adapters from './adapters.mjs';

const ROOT = process.env.RADAR_ROOT || process.cwd();
const FEED = path.join(ROOT, 'feed.json');
const SRC = JSON.parse(fs.readFileSync(path.join(ROOT, 'sources.json'), 'utf8'));
const MAX_ITEMS = 6000;
const RANK = { LOW: 0, MEDIUM: 1, HIGH: 2 };
const TODAY = new Date().toISOString().slice(0, 10);
const now = new Date().toISOString();

const feed = fs.existsSync(FEED) ? JSON.parse(fs.readFileSync(FEED, 'utf8')) : { version: 1, items: [], runs: [], sources: [] };
const byKey = new Map(feed.items.map(i => [i.key, i]));
const health = new Map((feed.sources || []).map(s => [s.name, s]));
const runs = [];
let totalNew = 0;

for (const cfg of SRC.sources) {
  const h = health.get(cfg.name) || { name: cfg.name };
  h.type = cfg.type; h.enabled = cfg.enabled !== false; h.note = cfg.note || '';
  health.set(cfg.name, h);
  if (cfg.enabled === false) { h.status = 'DISABLED'; continue; }
  const t0 = Date.now();
  const run = { source: cfg.name, at: now };
  try {
    const fn = adapters[cfg.type];
    if (!fn) throw new Error('Unknown source type: ' + cfg.type);
    let timer; const raw = await Promise.race([fn(cfg), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('Timed out after 90s')), 90000); })]).finally(() => clearTimeout(timer));
    let added = 0, seen = 0, skipped = 0;
    for (const r of raw) {
      const it = toItem(r, cfg.name);
      if (!it) continue;
      seen++;
      const old = byKey.get(it.key);
      // New tenders must be relevant to IQT and still open. Known tenders are always updated.
      if (!old) {
        const need = RANK[cfg.minRelevance || 'MEDIUM'];
        if (cfg.type !== 'csv' && (RANK[it.rel] < need || (it.deadline && it.deadline < TODAY))) { skipped++; continue; }
      }
      if (old) {
        old.lastSeen = now;
        for (const k of ['url', 'deadline', 'published', 'country', 'ref']) if (!old[k] && it[k]) old[k] = it[k];
        if (!old.value && it.value) { old.value = it.value; old.cur = it.cur; }
        if (it.deadline && it.deadline !== old.deadline) old.deadline = it.deadline; // official date wins
      } else {
        const n = { id: it.key.length > 8 ? 'F' + Buffer.from(it.key).toString('base64url').slice(0, 14) : it.key, ...it, firstSeen: now, lastSeen: now };
        byKey.set(it.key, n); added++;
      }
    }
    Object.assign(run, { status: seen ? 'OK' : 'EMPTY', fetched: seen, added, skipped });
    Object.assign(h, { status: seen ? 'OK' : 'EMPTY', lastRun: now, lastCount: seen, error: '' });
    if (seen) h.lastOk = now;
    totalNew += added;
  } catch (e) {
    Object.assign(run, { status: 'ERROR', error: String(e.message || e).slice(0, 200) });
    Object.assign(h, { status: 'ERROR', lastRun: now, error: run.error });
  }
  run.ms = Date.now() - t0;
  runs.push(run);
  console.log(`${run.status.padEnd(6)} ${cfg.name}  fetched=${run.fetched ?? 0} new=${run.added ?? 0} skipped=${run.skipped ?? 0} ${run.error || ''}`);
}

let items = [...byKey.values()].sort((a, b) => (b.firstSeen || '').localeCompare(a.firstSeen || ''));
if (items.length > MAX_ITEMS) items = items.slice(0, MAX_ITEMS);
const out = { version: 1, generated: now, newThisRun: totalNew, count: items.length, sources: [...health.values()], runs: [...runs, ...(feed.runs || [])].slice(0, 120), items };
fs.mkdirSync(path.dirname(FEED), { recursive: true });
fs.writeFileSync(FEED, JSON.stringify(out));
console.log(`Feed written: ${items.length} tenders, ${totalNew} new this run.`);
process.exit(0);
