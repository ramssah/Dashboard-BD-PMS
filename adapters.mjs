// One function per source type. Each returns an array of raw records:
// { title, client, country, deadline, published, value, cur, url, type, ref, scope }
// Network access is isolated here so tests can run offline with FIXTURES=<dir>.
import fs from 'node:fs';
import path from 'node:path';
import { parseCSV, currentFY, stripTags, decodeEntities, findDate, isoDate } from './lib.mjs';

const UA = 'IQT-Tender-Radar/1.0 (+personal business-development use)';

export async function http(url, { json = true, timeout = 30000, retries = 2 } = {}) {
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


// ---------------------------------------------------------------------------
// Web page readers. They read the saved HTML of a public listing page.
// ---------------------------------------------------------------------------
const BAD_TITLE = /^(read more|more|view|view all|details?|open in a new window|click here|download|all the news|skip to|next|previous|home|login|sign in)\b/i;
const absUrl = (href, base) => { try { return new URL(href, base).href; } catch { return ''; } };

async function getText(cfg, url, i = 0, opt = {}) {
  if (process.env.FIXTURES) {
    const name = cfg.type + (cfg.fixture ? '-' + cfg.fixture : '') + (i ? '-' + i : '');
    return fs.readFileSync(path.join(process.env.FIXTURES, name + '.txt'), 'utf8');
  }
  return http(url, { json: false, ...opt });
}

/** Fill country, client and notice type from the notice title, for sites that put them in it. */
function meta(rec, cfg) {
  rec.client = rec.client || cfg.client || '';
  rec.country = rec.country || cfg.country || '';
  rec.source = cfg.label || undefined;
  const t = rec.title;
  let m;
  if (cfg.titleFormat === 'type-country-title' && (m = /^([A-Za-z]{2,6})\s*[-–]\s*([^-–]{3,40}?)\s*[-–]\s*(.+)$/.exec(t))) {
    rec.type = rec.type || m[1].toUpperCase();
    if (!rec.country) rec.country = m[2].trim();
  } else if (cfg.titleFormat === 'mango' && (m = /^(.*?)\s+[—–-]\s+([^·—–]+?)\s+·\s+Closes\s+(.+)$/.exec(t))) {
    rec.title = m[1].trim(); rec.country = rec.country || m[2].trim(); rec.deadline = rec.deadline || isoDate('Closes ' + m[3].trim());
  } else if (cfg.titleFormat === 'infralens' && (m = /^(.*?)\s+[—–]\s+₹\s*([\d.,]+)\s*(Cr|Crore|L|Lakh)?\s*$/i.exec(t))) {
    rec.title = m[1].trim();
    const n = Number(m[2].replace(/,/g, '')) || 0;
    rec.value = Math.round(n * (/^l/i.test(m[3] || '') ? 1e5 : 1e7)); rec.cur = 'INR'; rec.country = rec.country || 'India';
  }
  return rec;
}

export function extractLinks(html, cfg) {
  const re = new RegExp(cfg.linkPattern || '.', 'i');
  const ex = cfg.exclude ? new RegExp(cfg.exclude, 'i') : null;
  const minLen = cfg.minTitle || 20;
  const seen = new Set(), out = [];
  for (const m of html.matchAll(/<a\b[^>]*?href\s*=\s*["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const url = absUrl(decodeEntities(m[1]), cfg.url);
    if (!url || !re.test(url) || seen.has(url)) continue;
    const title = stripTags(m[2]);
    if (title.length < minLen || BAD_TITLE.test(title) || (ex && ex.test(title + ' ' + url))) continue;
    seen.add(url);
    out.push(meta({ title, url }, cfg));
  }
  return out;
}

/** Listing page with one link per notice. Use {page} in the url to read several pages. */
export async function htmllinks(cfg) {
  const out = [], seen = new Set();
  const paged = cfg.url.includes('{page}');
  const n = paged ? (cfg.pages || 1) : 1;
  for (let i = 0; i < n; i++) {
    const url = paged ? cfg.url.replace('{page}', String(i + (cfg.pageStart || 0))) : cfg.url;
    let html;
    try { html = await getText(cfg, url, i); } catch (e) { if (i === 0) throw e; break; }
    const got = extractLinks(html, { ...cfg, url }).filter(r => !seen.has(r.url));
    if (!got.length) break;
    got.forEach(r => { seen.add(r.url); out.push(r); });
  }
  return out;
}

export function extractRows(html, cfg) {
  const c = cfg.cols || {};
  const out = [];
  // Split on row starts, so rows nested inside layout tables are still read.
  for (const chunk of html.split(/<tr\b/i).slice(1)) {
    const row = chunk.split(/<\/tr>/i)[0];
    if (/<th\b/i.test(row)) continue;
    const cells = [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(m => m[1]);
    if (cells.length < (cfg.minCells || 3)) continue;
    const txt = cells.map(stripTags);
    let title = txt[c.title] || '', ref = c.ref != null ? txt[c.ref] : '';
    if (cfg.bracket) {
      const g = [...title.matchAll(/\[([^\]]*)\]/g)].map(x => x[1].trim());
      if (g.length) { title = g[0]; ref = [g[1], g[2]].filter(Boolean).join(' / ') || ref; }
    }
    if (title.length < (cfg.minTitle || 8) || BAD_TITLE.test(title)) continue;
    const a = /<a\b[^>]*href\s*=\s*["']([^"'#][^"']*)["']/i.exec(cells[c.title] ?? row);
    out.push(meta({
      title, ref,
      client: c.client != null ? txt[c.client].replace(/\s*\|\|\s*/g, ' / ') : '',
      type: c.type != null ? txt[c.type] : '',
      published: c.published != null ? isoDate(txt[c.published]) : '',
      deadline: c.deadline != null ? isoDate(txt[c.deadline]) : '',
      url: cfg.listUrl ? cfg.url : (a ? absUrl(decodeEntities(a[1]), cfg.url) : ''),
      listUrl: !!cfg.listUrl
    }, cfg));
  }
  return out;
}

/** Listing page that is an HTML table. cols maps column numbers: title, client, ref, type, published, deadline. */
export async function htmltable(cfg) {
  return extractRows(await getText(cfg, cfg.url), cfg);
}

/** Indian government e-procurement portals (NIC GePNIC). One adapter reads every portal in cfg.portals. */
export async function gepnic(cfg) {
  const base = cfg.url.replace(/\?.*$/, '').replace(/\/$/, '');
  const url = base + (cfg.path || '?page=FrontEndLatestActiveTenders&service=page');
  const html = await getText(cfg, url, 0, { retries: 0, timeout: 25000 });
  const rows = extractRows(html, { ...cfg, url, listUrl: true, bracket: true, minCells: 5, cols: { published: 1, deadline: 2, title: 4, client: 5 }, country: 'India' });
  if (!rows.length && /captcha/i.test(html)) throw new Error('Portal asks for a captcha');
  return rows;
}

// ---------------------------------------------------------------------------
// Pages that need a real browser (the notice list is loaded by script).
// ---------------------------------------------------------------------------
async function loadPlaywright() {
  try { return await import('playwright'); } catch {}
  try { const { createRequire } = await import('node:module'); return createRequire(process.cwd() + '/')('playwright'); } catch {}
  throw new Error('Browser not available on this runner (playwright is not installed)');
}

function rowToRecord(row, cfg) {
  const lines = row.text.split(/\n+/).map(s => s.trim()).filter(Boolean).filter(l => !BAD_TITLE.test(l));
  const dates = lines.map(findDate).filter(Boolean).sort();
  const title = lines.filter(l => !findDate(l) || l.length > 40).sort((a, b) => b.length - a.length)[0] || '';
  const re = new RegExp(cfg.linkPattern || '.', 'i');
  const link = row.links.find(l => re.test(l.href)) || row.links[0];
  if (title.length < (cfg.minTitle || 15) || !link) return null;
  return meta({ title, url: link.href, published: dates.length > 1 ? dates[0] : '', deadline: dates.length ? dates[dates.length - 1] : '' }, cfg);
}

export async function browser(cfg) {
  if (process.env.FIXTURES) return extractLinks(await getText(cfg, cfg.url), cfg);
  const pw = await loadPlaywright();
  const chromium = pw.chromium || (pw.default && pw.default.chromium);
  const b = await chromium.launch();
  try {
    const page = await (await b.newContext({ locale: 'en-US' })).newPage();
    await page.goto(cfg.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    if (cfg.waitFor) await page.waitForSelector(cfg.waitFor, { timeout: 25000 }).catch(() => {});
    else await page.waitForTimeout(5000);
    if (cfg.rowSelector) {
      const rows = await page.$$eval(cfg.rowSelector, els => els.map(e => ({ text: e.innerText || '', links: [...e.querySelectorAll('a[href]')].map(a => ({ href: a.href, text: a.innerText || '' })) })));
      const recs = rows.map(r => rowToRecord(r, cfg)).filter(Boolean);
      if (recs.length) return recs;
    }
    return extractLinks(await page.content(), { ...cfg, url: page.url() });
  } finally { await b.close(); }
}
