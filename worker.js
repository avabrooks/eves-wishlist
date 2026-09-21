/* Eve's Wishlist: link reader (Cloudflare Worker)
 *
 * Give it a product link and it returns the name, price, photo and color the shop publishes in its page.
 *   GET /?url=<product link>   ->  { ok, title, price, currency, image, color, site, ... }
 *   GET /img?url=<image link>  ->  the image bytes (so the site can save a copy of the photo)
 *
 * Only pages opened from the sites listed in ALLOWED_ORIGINS can use it. To add a custom domain later,
 * add it to the list below (or set an ALLOWED_ORIGINS variable in Cloudflare, comma separated).
 */
const ALLOWED_ORIGINS = ['https://avabrooks.github.io'];

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const MAX_HTML = 1500000;
const MAX_IMG = 6000000;

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = (env && env.ALLOWED_ORIGINS ? String(env.ALLOWED_ORIGINS).split(',').map(s => s.trim()) : ALLOWED_ORIGINS);
    const okOrigin = allowed.indexOf(origin) >= 0;
    const cors = okOrigin ? {
      'Access-Control-Allow-Origin': origin, 'Vary': 'Origin',
      'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400'
    } : {};
    const json = (obj, status) => new Response(JSON.stringify(obj), { status: status || 200, headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, cors) });

    if (request.method === 'OPTIONS') return new Response(null, { status: okOrigin ? 204 : 403, headers: cors });
    if (request.method !== 'GET') return json({ ok: false, reason: 'method' }, 405);

    const reqUrl = new URL(request.url);
    const target = reqUrl.searchParams.get('url');
    if (!target && reqUrl.pathname === '/') return json({ service: "Eve's Wishlist link reader", ok: true });
    if (!okOrigin) return json({ ok: false, reason: 'origin' }, 403);

    const u = checkUrl(target, env);
    if (!u) return json({ ok: false, reason: 'bad_url' }, 400);

    try {
      if (reqUrl.pathname === '/img') return await imageProxy(u, env, cors);
      return json(await lookup(u, env));
    } catch (e) {
      return json({ ok: false, reason: (e && e.name === 'AbortError') ? 'timeout' : 'fetch_failed' });
    }
  }
};

/* ---------------- safety ---------------- */
function checkUrl(raw, env) {
  let u; try { u = new URL(raw); } catch (e) { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (env && env.ALLOW_LOCAL === '1') return u;
  const h = u.hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || h.startsWith('[') || (h.indexOf('.') < 0)) return null;
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) {
    const a = +m[1], b = +m[2];
    if (a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return null;
  }
  return u;
}

async function get(url, accept, timeout, referer) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout || 9000);
  try {
    const headers = { 'User-Agent': UA, 'Accept': accept, 'Accept-Language': 'en-US,en;q=0.9' };
    if (referer) headers['Referer'] = referer;
    return await fetch(url.href, { headers, redirect: 'follow', signal: ctrl.signal });
  } finally { clearTimeout(t); }
}

async function readCapped(res, max) {
  const reader = res.body.getReader();
  const chunks = []; let n = 0, capped = false;
  for (;;) {
    const r = await reader.read();
    if (r.done) break;
    chunks.push(r.value); n += r.value.length;
    if (n >= max) { capped = true; try { await reader.cancel(); } catch (e) {} break; }
  }
  const size = Math.min(n, max);
  const buf = new Uint8Array(size); let o = 0;
  for (const c of chunks) { const take = Math.min(c.length, size - o); buf.set(c.subarray(0, take), o); o += take; if (o >= size) break; }
  return { buf, capped };
}

/* ---------------- image proxy ---------------- */
async function imageProxy(u, env, cors) {
  const res = await get(u, 'image/avif,image/webp,image/png,image/jpeg,*/*;q=0.5', 10000, u.origin + '/');
  const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!res.ok || !/^image\/(jpeg|png|webp|gif|avif)$/.test(type)) {
    return new Response(JSON.stringify({ ok: false, reason: 'not_image' }), { status: 415, headers: Object.assign({ 'Content-Type': 'application/json' }, cors) });
  }
  const { buf, capped } = await readCapped(res, MAX_IMG);
  if (capped) return new Response(JSON.stringify({ ok: false, reason: 'too_large' }), { status: 413, headers: Object.assign({ 'Content-Type': 'application/json' }, cors) });
  return new Response(buf, { headers: Object.assign({ 'Content-Type': type, 'Cache-Control': 'public, max-age=86400' }, cors) });
}

/* ---------------- product lookup ---------------- */
async function lookup(u, env) {
  const res = await get(u, 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5', 9000);
  const finalUrl = checkUrl(res.url || u.href, env);
  if (!finalUrl) return { ok: false, reason: 'bad_url' };
  if ([401, 403, 429, 503].indexOf(res.status) >= 0) return { ok: false, reason: 'blocked' };
  if (!res.ok) return { ok: false, reason: 'not_found' };
  const type = (res.headers.get('content-type') || '').toLowerCase();
  if (type && type.indexOf('html') < 0 && type.indexOf('xml') < 0) return { ok: false, reason: 'not_a_page' };

  const { buf } = await readCapped(res, MAX_HTML);
  let charset = (type.match(/charset=([\w-]+)/) || [])[1] || 'utf-8';
  let html;
  try { html = new TextDecoder(charset).decode(buf); } catch (e) { html = new TextDecoder('utf-8').decode(buf); }

  const out = extract(html, finalUrl);
  if (!out.title && !out.price && !out.image) {
    const walled = /captcha|are you a robot|access denied|verify you are human|unusual traffic/i.test(html.slice(0, 20000));
    return { ok: false, reason: walled ? 'blocked' : 'empty' };
  }
  return Object.assign({ ok: true, url: finalUrl.href }, out);
}

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '-', mdash: '-', rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"', reg: '', trade: '' };
function decode(s) {
  if (s == null) return '';
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    try {
      if (e[0] === '#') { const cp = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return String.fromCodePoint(cp); }
    } catch (err) { return m; }
    const v = NAMED[e.toLowerCase()]; return v === undefined ? m : v;
  }).replace(/\s+/g, ' ').trim();
}

function metaMap(html) {
  const map = {};
  const re = /<meta\b[^>]*>/gi; let m;
  while ((m = re.exec(html))) {
    const tag = m[0]; const attrs = {};
    const ar = /([a-zA-Z:_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g; let a;
    while ((a = ar.exec(tag))) attrs[a[1].toLowerCase()] = a[2] !== undefined ? a[2] : (a[3] !== undefined ? a[3] : a[4]);
    const key = (attrs.property || attrs.name || attrs.itemprop || '').toLowerCase();
    if (key && attrs.content !== undefined && map[key] === undefined) map[key] = decode(attrs.content);
  }
  return map;
}

function jsonLdNodes(html) {
  const nodes = [];
  const re = /<script[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi; let m;
  const walk = (x, depth) => {
    if (!x || depth > 6) return;
    if (Array.isArray(x)) { x.forEach(y => walk(y, depth + 1)); return; }
    if (typeof x !== 'object') return;
    nodes.push(x);
    if (x['@graph']) walk(x['@graph'], depth + 1);
    if (x.hasVariant) walk(x.hasVariant, depth + 1);
    if (x.mainEntity) walk(x.mainEntity, depth + 1);
  };
  while ((m = re.exec(html))) {
    let txt = m[1].replace(/^\s*<!\[CDATA\[/, '').replace(/\]\]>\s*$/, '').trim();
    try { walk(JSON.parse(txt), 0); } catch (e) { /* ignore broken block */ }
  }
  return nodes;
}
const isType = (n, t) => { const ty = n && n['@type']; return Array.isArray(ty) ? ty.indexOf(t) >= 0 : ty === t; };

function firstStr(v) {
  if (!v) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) { for (const x of v) { const s = firstStr(x); if (s) return s; } return ''; }
  if (typeof v === 'object') return firstStr(v.url || v.contentUrl || v.name);
  return '';
}

function pickOffer(o) {
  if (!o) return null;
  if (Array.isArray(o)) { for (const x of o) { const r = pickOffer(x); if (r) return r; } return null; }
  if (typeof o !== 'object') return null;
  const spec = Array.isArray(o.priceSpecification) ? o.priceSpecification[0] : o.priceSpecification;
  const price = o.price != null ? o.price : (o.lowPrice != null ? o.lowPrice : (spec ? spec.price : null));
  const currency = o.priceCurrency || (spec && spec.priceCurrency) || '';
  if (price == null || price === '') return o.offers ? pickOffer(o.offers) : null;
  return { price, currency };
}

function parsePrice(v) {
  if (v == null) return null;
  if (typeof v === 'number') return (isFinite(v) && v > 0 && v < 1e6) ? Math.round(v * 100) / 100 : null;
  const m = String(v).match(/\d[\d.,]*/); if (!m) return null;
  let s = m[0].replace(/[.,]+$/, '');
  const hasC = s.indexOf(',') >= 0, hasD = s.indexOf('.') >= 0;
  if (hasC && hasD) {
    const dec = s.lastIndexOf(',') > s.lastIndexOf('.') ? ',' : '.';
    const thou = dec === ',' ? '.' : ',';
    s = s.split(thou).join('').replace(dec, '.');
  } else if (hasC) {
    s = (/,\d{1,2}$/.test(s) && s.split(',').length === 2) ? s.replace(',', '.') : s.split(',').join('');
  } else if (hasD && s.split('.').length > 2) {
    s = s.split('.').join('');
  }
  const n = parseFloat(s);
  return (isFinite(n) && n > 0 && n < 1e6) ? Math.round(n * 100) / 100 : null;
}

function absUrl(src, base) { if (!src) return ''; try { const x = new URL(decode(src), base); return /^https?:$/.test(x.protocol) ? x.href : ''; } catch (e) { return ''; } }

function cleanTitle(title, site, hostname) {
  if (!title) return '';
  const base = hostname.replace(/^www\./, '').split('.')[0].toLowerCase();
  const s = (site || '').toLowerCase();
  const parts = title.split(/\s+[|–—·-]\s+/);
  if (parts.length < 2) return title.trim();
  const keep = parts.filter(p => {
    const l = p.toLowerCase().replace(/[^a-z0-9]/g, '');
    return !((s && l && (l === s.replace(/[^a-z0-9]/g, '') || s.replace(/[^a-z0-9]/g, '').indexOf(l) >= 0 && l.length > 3)) || (base.length > 2 && l.indexOf(base.replace(/[^a-z0-9]/g, '')) >= 0 && l.length <= base.length + 12));
  });
  return (keep.length ? keep.join(' - ') : parts[0]).trim();
}

function extract(html, url) {
  const meta = metaMap(html);
  const nodes = jsonLdNodes(html);
  const product = nodes.find(n => (isType(n, 'Product') || isType(n, 'ProductGroup')) && n.name) || nodes.find(n => isType(n, 'Product'));
  const titleTag = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];

  let title = (product && decode(product.name)) || meta['og:title'] || meta['twitter:title'] || decode(titleTag) || '';
  const site = meta['og:site_name'] || (product && product.brand && (product.brand.name || (typeof product.brand === 'string' ? product.brand : ''))) || '';
  title = cleanTitle(title, meta['og:site_name'] || '', url.hostname);

  let price = null, currency = '';
  if (product) {
    const offer = pickOffer(product.offers) || (product.hasVariant ? pickOffer((Array.isArray(product.hasVariant) ? product.hasVariant[0] : product.hasVariant).offers) : null);
    if (offer) { price = parsePrice(offer.price); currency = String(offer.currency || '').toUpperCase(); }
  }
  if (price == null) {
    for (const k of ['product:price:amount', 'og:price:amount', 'product:sale_price:amount', 'twitter:data1', 'price', 'itemprop:price']) {
      if (meta[k]) { const p = parsePrice(meta[k]); if (p != null) { price = p; break; } }
    }
    currency = currency || String(meta['product:price:currency'] || meta['og:price:currency'] || meta['pricecurrency'] || '').toUpperCase();
  }

  let image = absUrl((product && firstStr(product.image)) || meta['og:image:secure_url'] || meta['og:image'] || meta['twitter:image'] || meta['twitter:image:src'], url.href);
  const color = product && typeof product.color === 'string' && product.color.length < 30 ? decode(product.color) : '';

  return { title: title.slice(0, 140), price, currency, image, color, site: decode(site).slice(0, 60) };
}

