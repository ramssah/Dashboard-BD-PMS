// Shared helpers for the capture job. No dependencies (Node 20+).
export const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
// Same rule is used in the web app, so a tender is never added twice.
export const keyOf = (title, client) => norm(title).slice(0, 120) + '|' + norm(client).slice(0, 60);

export const KEYWORDS = [
  'infrastructure','urban development','urban planning','master plan','township','water supply','wastewater','sewerage','sanitation',
  'storm water','stormwater','drainage','flood','transport','road','highway','railway','metro','mass transit','bus rapid','mobility',
  'logistics','port','airport','bridge','traffic','parking','housing','smart city','municipal','solid waste','waste management',
  'engineering','architect','design consultant','project management','supervision','feasibility','detailed project report','dpr',
  'transaction advis','ppp','public private','public-private','financial advis','infrastructure finance','land use','development planning',
  'technical assistance','capacity building','institutional development','environment','climate'];
export const NEGATIVE = ['hotel','catering','printing','stationery','vehicle hire','laptop','furniture','uniform','airline ticket','venue','cleaning services','security guard'];

export function relevance(text) {
  const s = ' ' + norm(text) + ' ';
  if (NEGATIVE.some(w => s.includes(' ' + w))) return 'LOW';
  const hits = KEYWORDS.filter(w => s.includes(' ' + norm(w))).length;
  return hits >= 2 ? 'HIGH' : hits === 1 ? 'MEDIUM' : 'LOW';
}

const SECT = [
  ['Water Supply', /water supply|drinking water|potable|water treatment|water distribution|waterworks|water utilit/],
  ['Sewerage', /sewer|wastewater|waste water|sanitation|\bstp\b|effluent|drainage/],
  ['Solid Waste Management', /solid waste|garbage|landfill|waste management|refuse/],
  ['Township', /township|new town|smart city/],
  ['Urban & Regional Development', /\burban|municipal|city development|regional development|slum|housing|spatial plan|master plan/],
  ['Transport & Mobility', /\broads?\b|highway|\bbridges?\b|railway|\bmetro\b|transport|mobility|\bports?\b|seaport|airport|corridor|bus rapid|traffic/],
  ['Buildings', /building|hospital|architectur/],
  ['Agriculture & Rural Development', /agricultur|irrigation|rural|livestock|farm|value chain|food security/],
  ['Climate & Sustainability', /climate|resilien|renewable|solar|emission|sustainab|environmental|\bgreen\b/],
  ['TA / PPP', /\bppp\b|public-private|public private|transaction advis|technical assistance/]];
export function sector(text) { const s = String(text || '').toLowerCase(); for (const [n, p] of SECT) if (p.test(s)) return n; return 'Unclassified'; }

const L = s => s.split(' ');
const R = {
  MENA: L('lebanon jordan iraq yemen syria iran west bank gaza middle east saudi kuwait qatar oman emirates'),
  Africa: L('africa kenya malawi rwanda mozambique ethiopia zambia nigeria uganda senegal tanzania niger madagascar tunisia namibia south sudan somalia burundi chad eswatini angola mali gabon cameroon liberia sierra egypt ghana congo benin togo burkina guinea gambia zimbabwe botswana lesotho morocco algeria mauritania djibouti eritrea cote ivoire comoros cabo cape verde seychelles mauritius libya'),
  Asia: L('vietnam china indonesia uzbekistan philippines nepal afghanistan pakistan bangladesh kyrgyz cambodia kazakhstan sri lanka bhutan thailand mongolia laos myanmar korea japan tajikistan turkmenistan timor maldives malaysia fiji papua pacific asia'),
  Europe: L('ukraine russian georgia armenia bosnia albania serbia moldova turkey kosovo montenegro macedonia europe azerbaijan belarus'),
  Americas: L('brazil argentina mexico paraguay peru colombia nicaragua haiti honduras guatemala bolivia ecuador chile uruguay panama costa dominican jamaica caribbean latin america')};
export function region(country) {
  const x = String(country || '').toLowerCase().trim();
  if (!x) return 'Other';
  if (x === 'india') return 'India';
  for (const k of ['MENA', 'Africa', 'Asia', 'Europe', 'Americas']) if (R[k].some(w => x.includes(w))) return k;
  return 'Other';
}

export function isoDate(v) {
  if (!v) return '';
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  return isNaN(d) ? '' : d.toISOString().slice(0, 10);
}
export function parseBudget(v, cur) {
  if (typeof v === 'number') return { value: v, cur: cur || 'INR' };
  const m = /([A-Z]{3})?\s*([\d][\d,\.]*)/.exec(String(v || ''));
  if (!m) return { value: 0, cur: cur || 'INR' };
  return { value: Number(m[2].replace(/,/g, '')) || 0, cur: m[1] || cur || 'INR' };
}

export function parseCSV(s) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '"' && s[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; }
    else if (c === '"') q = true;
    else if (c === ',' || c === '\t') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && s[i + 1] === '\n') i++; row.push(cell); cell = ''; if (row.some(x => x.trim())) rows.push(row); row = []; }
    else cell += c;
  }
  row.push(cell); if (row.some(x => x.trim())) rows.push(row);
  return rows;
}

export function currentFY(d = new Date()) {
  const y = d.getUTCMonth() >= 3 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
  return `${y}-${y + 1}`;
}

/** Turn a raw record from any adapter into the feed's tender shape. */
export function toItem(raw, source) {
  const title = String(raw.title || '').replace(/\s+/g, ' ').trim();
  if (!title) return null;
  const client = String(raw.client || '').replace(/\s+/g, ' ').trim();
  const country = String(raw.country || '').trim();
  const b = parseBudget(raw.value, raw.cur);
  return {
    key: keyOf(title, client), title, client, country,
    region: region(country), sector: sector(title + ' ' + (raw.scope || '')),
    source, url: raw.url || '', value: b.value, cur: b.cur,
    deadline: isoDate(raw.deadline), published: isoDate(raw.published),
    rel: relevance(title + ' ' + (raw.scope || '')), type: raw.type || '', ref: raw.ref || ''
  };
}
