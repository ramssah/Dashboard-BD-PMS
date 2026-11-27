// One function per source type. Each returns an array of raw records:
// { title, client, country, deadline, published, value, cur, url, type, ref, scope }
// Network access is isolated here so tests can run offline with FIXTURES=<dir>.
import fs from 'node:fs';
import path from 'node:path';
import { parseCSV, currentFY } from './lib.mjs';

const UA = 'IQT-Tender-Radar/1.0 (+personal business-development use)';

async function http(url, { json = true, timeout = 30000, retries = 2 } = {}) {
  let last;
  for (let i = 0; i <= retries; i++) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeout);
    try {
      const r = await fetch(url, { signal: ac.signal, headers: { 'user-agent': UA, accept: json ? 'application/json' : '*/*' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return json ? await r.json() : await r.text();
    } catch (e) { last = e; await new Promise(r => setTimeout(r, 1500 * (i + 1))); }
    finally { clearTimeout(t); }
  }
  throw last;
}
function fixture(name, json = true) {
  const f = path.join(process.env.FIXTURES, name + (json ? '.json' : '.txt'));
  const s = fs.readFileSync(f, 'utf8');
  return json ? JSON.parse(s) : s;
}
const get = (cfg, url, json = true) => process.env.FIXTURES ? fixture(cfg.type + (cfg.fixture ? '-' + cfg.fixture : ''), json) : http(url, { json });
const pick = (o, ...ks) => { for (const k of ks) { const v = k.split('.').reduce((a, p) => a == null ? a : a[p], o); if (v != null && v !== '') return v; } return ''; };

/** World Bank procurement notices (public JSON API). */
export async function worldbank(cfg) {
  const url = `https://search.worldbank.org/api/v2/procnotices?format=json&rows=${cfg.rows || 200}&os=0&srt=noticedate&order=desc&apilang=en`;
  const j = await get(cfg, url);
  const raw = j.procnotices || j.notices || [];
  const arr = Array.isArray(raw) ? raw : Object.values(raw);
  return arr.map(n => ({
    title: pick(n, 'bid_description', 'project_name', 'title'),
    client: 'World Bank' + (n.project_name ? ' / ' + n.project_name : ''),
    country: pick(n, 'project_ctry_name', 'country_name', 'country_shortname'),
    deadline: pick(n, 'submission_deadline_date', 'deadline'),
    published: pick(n, 'noticedate', 'publication_date'),
    type: pick(n, 'notice_type'), ref: pick(n, 'id', 'bid_reference_no'),
    url: n.id ? 'https://projects.worldbank.org/en/projects-operations/procurement-detail/' + n.id : ''
  }));
}

/** Any OCDS-style or flat JSON tender list. cfg.url may contain {fy}. */
export async function ocds(cfg) {
  const url = cfg.url.replace('{fy}', currentFY());
  const j = await get(cfg, url);
  const list = Array.isArray(j) ? j : (j.releases || j.tenders || j.data || j.results || []);
  return list.map(r => {
    const t = r.tender || r;
    return {
      title: pick(t, 'title', 'description') || pick(r, 'title'),
      client: pick(r, 'buyer.name', 'buyer_name', 'procuring_entity', 'entity', 'tender.procuringEntity.name'),
      country: cfg.country || '',
      deadline: pick(t, 'tenderPeriod.endDate', 'deadline', 'closing_date', 'submission_deadline') || pick(r, 'deadline', 'closing_date'),
      published: pick(r, 'date', 'published', 'publication_date'),
      value: pick(t, 'value.amount', 'estimated_value', 'budget'), cur: pick(t, 'value.currency') || cfg.cur || '',
      type: pick(t, 'procurementMethodDetails', 'procurementMethod', 'category'), ref: pick(t, 'id', 'tender_id') || pick(r, 'ocid'),
      url: pick(t, 'url', 'link') || cfg.linkBase || ''
    };
  });
}

/** RSS or Atom feed. */
export async function rss(cfg) {
  const xml = await get(cfg, cfg.url, false);
  const items = [...xml.matchAll(/<(item|entry)[\s>][\s\S]*?<\/\1>/g)].map(m => m[0]);
  const tag = (s, t) => { const m = new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`).exec(s); return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, ' ').trim() : ''; };
  return items.map(s => ({
    title: tag(s, 'title'), client: cfg.client || cfg.name, country: cfg.country || '', scope: tag(s, 'description') || tag(s, 'summary'),
    published: tag(s, 'pubDate') || tag(s, 'updated') || tag(s, 'published'),
    url: tag(s, 'link') || (/<link[^>]*href="([^"]+)"/.exec(s) || [])[1] || ''
  }));
}

/** Any CSV files dropped in /inbox (exports from aggregators, or typed by hand). */
export async function csv(cfg) {
  const dir = path.resolve(cfg.dir || 'inbox');
  if (!fs.existsSync(dir)) return [];
  const out = [];
  const pat = cfg.pattern ? new RegExp(cfg.pattern, 'i') : /\.(csv|tsv|txt)$/i;
  for (const f of fs.readdirSync(dir).filter(f => pat.test(f))) {
    const rows = parseCSV(fs.readFileSync(path.join(dir, f), 'utf8'));
    if (rows.length < 2) continue;
    const h = rows[0].map(x => x.trim().toLowerCase());
    const ix = (...n) => h.findIndex(x => n.some(k => x.includes(k)));
    const c = { title: ix('title', 'tender', 'name', 'description'), client: ix('client', 'agency', 'authority'), country: ix('country'), deadline: ix('deadline', 'due', 'closing', 'submission'), value: ix('value', 'amount', 'estimate', 'budget'), cur: ix('currency'), url: ix('url', 'link') };
    if (c.title < 0) continue;
    for (const r of rows.slice(1)) { const g = k => c[k] >= 0 ? (r[c[k]] || '').trim() : ''; out.push({ title: g('title'), client: g('client'), country: g('country'), deadline: g('deadline'), value: g('value'), cur: g('cur'), url: g('url'), type: 'Inbox: ' + f }); }
  }
  return out;
}
