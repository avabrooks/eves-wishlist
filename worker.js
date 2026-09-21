/* Eve's Wishlist: link reader (Cloudflare Worker)
 *
 * Give it a product link and it returns the name, price, photo and color the shop publishes in its page.
 *   GET /?url=<product link>   ->  { ok, title, price, currency, image, color, site, ... }
 *   GET /img?url=<image link>  ->  the image bytes (so the site can save a copy of the photo)
 *   POST /parse  {url, html}   ->  same as above, but reads a page the PHONE already downloaded (used by the
 *                                  iPhone Share Sheet shortcut, so shops that block servers still work)
 *   POST /go     {url, html}   ->  plain text: a link that opens the wishlist with the form already filled in
 *
 * Optional extra power: set two secrets in Cloudflare (CF_ACCOUNT_ID and CF_API_TOKEN) and, when a shop blocks
 * a plain request, the worker asks Cloudflare's own real-browser service to open the page instead.
 *
 * Only pages opened from the sites listed in ALLOWED_ORIGINS can use it. To add a custom domain later,
 * add it to the list below (or set an ALLOWED_ORIGINS variable in Cloudflare, comma separated).
 */
const ALLOWED_ORIGINS = ['https://avabrooks.github.io'];
const SITE = 'https://avabrooks.github.io/eves-wishlist/';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
// Second try: some shops serve a bare-bones page to browser-looking requests from servers but happily show
// link previews (name and photo) to a plainly labelled preview fetcher.
const UA_PREVIEW = 'Mozilla/5.0 (compatible; EvesWishlist-LinkPreview/1.0)';
const MAX_HTML = 1500000;
const MAX_IMG = 6000000;

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = (env && env.ALLOWED_ORIGINS ? String(env.ALLOWED_ORIGINS).split(',').map(s => s.trim()) : ALLOWED_ORIGINS);
    const okOrigin = allowed.indexOf(origin) >= 0;
    const cors = okOrigin ? {
      'Access-Control-Allow-Origin': origin, 'Vary': 'Origin',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400'
    } : {};
    const json = (obj, status) => new Response(JSON.stringify(obj), { status: status || 200, headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, cors) });

    if (request.method === 'OPTIONS') return new Response(null, { status: okOrigin ? 204 : 403, headers: cors });

    const reqUrl = new URL(request.url);

    // The phone shortcut sends a page it already downloaded. Nothing is fetched here, so it is safe to leave open.
    if (request.method === 'POST' && (reqUrl.pathname === '/parse' || reqUrl.pathname === '/go')) {
      return await handlePost(request, reqUrl.pathname, env, cors);
    }
    if (request.method !== 'GET') return json({ ok: false, reason: 'method' }, 405);

    const target = reqUrl.searchParams.get('url');
    if (!target && reqUrl.pathname === '/') return json({ service: "Eve's Wishlist link reader", ok: true, browser: !!(env && env.CF_ACCOUNT_ID && env.CF_API_TOKEN) });
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

async function handlePost(request, path, env, cors) {
  const open = { 'Access-Control-Allow-Origin': '*' };
  const headers = Object.assign({ 'Cache-Control': 'no-store' }, open);
  const reply = (obj, status) => new Response(JSON.stringify(obj), { status: status || 200, headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, headers) });
  let body = {};
  try {
    const len = Number(request.headers.get('content-length') || 0);
    if (len > MAX_HTML * 1.5) return reply({ ok: false, reason: 'too_large' }, 413);
    const raw = await request.text();
    if (raw.length > MAX_HTML * 1.5) return reply({ ok: false, reason: 'too_large' }, 413);
    try { body = JSON.parse(raw); } catch (e) { body = { html: raw, url: new URL(request.url).searchParams.get('url') || '' }; }
  } catch (e) { return reply({ ok: false, reason: 'bad_body' }, 400); }
  const page = checkUrl(String(body.url || ''), env);
  const html = String(body.html || '').slice(0, MAX_HTML);
  const info = html.length > 200 && page ? extract(html, page) : { title: '', price: null, currency: '', image: '', color: '', site: '' };
  const found = !!(info.title || info.price || info.image);
  if (path === '/parse') return reply(found ? Object.assign({ ok: true, url: page.href }, info) : { ok: false, reason: 'empty' });
  // /go: always answer with a link, so the phone always ends up in the wishlist with at least the address filled in.
  const link = wishlistLink(page ? page.href : String(body.url || ''), info, env);
  return new Response(link, { headers: Object.assign({ 'Content-Type': 'text/plain; charset=utf-8' }, headers) });
}

function wishlistLink(url, info, env) {
  const payload = { u: String(url || '').slice(0, 900), t: info.title || '', p: info.price || null, i: info.image || '', c: info.color || '', k: info.currency || '' };
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  let bin = ''; for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  const b64 = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return ((env && env.SITE) || SITE) + '#add=' + b64;
}

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

async function get(url, accept, timeout, referer, ua) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout || 9000);
  try {
    const headers = { 'User-Agent': ua || UA, 'Accept': accept, 'Accept-Language': 'en-US,en;q=0.9' };
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
async function lookupOnce(u, env, ua) {
  const res = await get(u, 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5', 9000, null, ua);
  const finalUrl = checkUrl(res.url || u.href, env);
  const dbg = { status: res.status, type: (res.headers.get('content-type') || '').split(';')[0], ua: ua === UA_PREVIEW ? 'preview' : 'browser' };
  if (!finalUrl) return { ok: false, reason: 'bad_url', debug: dbg };
  if ([401, 403, 429, 503].indexOf(res.status) >= 0) return { ok: false, reason: 'blocked', debug: dbg };
  if (!res.ok) return { ok: false, reason: 'not_found', debug: dbg };
  const type = (res.headers.get('content-type') || '').toLowerCase();
  if (type && type.indexOf('html') < 0 && type.indexOf('xml') < 0) return { ok: false, reason: 'not_a_page', debug: dbg };

  const { buf } = await readCapped(res, MAX_HTML);
  const charset = (type.match(/charset=([\w-]+)/) || [])[1] || 'utf-8';
  let html;
  try { html = new TextDecoder(charset).decode(buf); } catch (e) { html = new TextDecoder('utf-8').decode(buf); }
  dbg.bytes = buf.length; dbg.start = html.replace(/\s+/g, ' ').slice(0, 160);

  const out = extract(html, finalUrl);
  if (!out.title && !out.price && !out.image) {
    const walled = /captcha|are you a robot|access denied|verify you are human|unusual traffic/i.test(html.slice(0, 20000));
    return { ok: false, reason: walled ? 'blocked' : 'empty', debug: dbg };
  }
  return Object.assign({ ok: true, url: finalUrl.href }, out);
}

async function renderedLookup(u, env) {
  if (!(env && env.CF_ACCOUNT_ID && env.CF_API_TOKEN)) return null;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 25000);
  try {
    const res = await fetch('https://api.cloudflare.com/client/v4/accounts/' + encodeURIComponent(env.CF_ACCOUNT_ID) + '/browser-rendering/content', {
      method: 'POST', signal: ctrl.signal,
      headers: { 'Authorization': 'Bearer ' + env.CF_API_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: u.href, gotoOptions: { waitUntil: 'networkidle2', timeout: 20000 }, userAgent: UA, setExtraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' } })
    });
    const dbg = { status: res.status, ua: 'real-browser' };
    if (!res.ok) return { ok: false, reason: 'browser_failed', debug: dbg };
    const j = await res.json();
    const html = String((j && (j.result || j.content)) || '').slice(0, MAX_HTML);
    dbg.bytes = html.length; dbg.start = html.replace(/\s+/g, ' ').slice(0, 160);
    const out = extract(html, u);
    if (!out.title && !out.price && !out.image) return { ok: false, reason: 'empty', debug: dbg };
    return Object.assign({ ok: true, url: u.href, via: 'browser' }, out);
  } catch (e) {
    return { ok: false, reason: 'browser_failed', debug: { error: String(e && e.name || e) } };
  } finally { clearTimeout(t); }
}

// A "good" answer has a price and a photo. If a plain fetch only got part of the way, try harder.
const complete = r => r && r.ok && r.price && r.image;

async function lookup(u, env) {
  const first = await lookupOnce(u, env, UA);
  if (first.reason === 'not_found' || first.reason === 'bad_url' || first.reason === 'not_a_page') return first;
  let best = first.ok ? first : null;
  if (complete(best)) return best;
  if (!first.ok) {
    // Blocked or empty: try once more as a plainly labelled link-preview fetcher.
    try { const second = await lookupOnce(u, env, UA_PREVIEW); if (second.ok) best = second; else first.debug2 = second.debug; } catch (e) {}
  }
  if (complete(best)) return best;
  // Still missing the price or photo: let a real browser open the page.
  const rendered = await renderedLookup(u, env);
  if (rendered && rendered.ok) {
    if (!best) return rendered;
    const merged = Object.assign({}, best);
    ['title', 'price', 'image', 'color', 'site', 'currency'].forEach(k => { if (!merged[k] && rendered[k]) merged[k] = rendered[k]; });
    merged.via = 'browser';
    return merged;
  }
  if (best) return best;
  if (rendered) first.debug3 = rendered.debug;
  return first;
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

const OLD_MARK = /(?:^|[^a-z])(?:old|was|original|strike|strikethrough|through|compare|previous|before|msrp|regular|crossed)(?![a-z])|(?:^|["' _-])(?:del|s)(?:$|["' _-])/i;
const VOID = /^(?:area|base|br|col|embed|hr|img|input|link|meta|source|track|wbr)$/i;
// Is the text at position idx inside a crossed-out or "was" element? Looks at the few hundred characters before it.
function insideOld(html, idx) {
  const win = html.slice(Math.max(0, idx - 700), idx);
  const re = /<(\/?)([a-z0-9]+)\b([^>]*)>/gi; let m; const stack = [];
  while ((m = re.exec(win))) {
    if (m[1]) { for (let i = stack.length - 1; i >= 0; i--) if (stack[i].tag === m[2].toLowerCase()) { stack.length = i; break; } }
    else if (!VOID.test(m[2]) && !/\/\s*$/.test(m[3])) stack.push({ tag: m[2].toLowerCase(), old: /^(?:del|s|strike)$/i.test(m[2]) || OLD_MARK.test(m[3]) });
  }
  return stack.some(x => x.old);
}

// Last resort for shops that only print the price on the page (no structured data): the first price-looking
// text inside an element whose class or test id mentions "price", skipping crossed-out "was" prices.
function visiblePrice(html) {
  const re = /<([a-z0-9]+)\b([^>]*(?:price|amount)[^>]*)>([^<]{0,60})(?=<)/gi; let m;
  const money = /(?:([$£€¥₹])|\b(USD|EUR|GBP|CAD|AUD)\b)\s?(\d[\d.,]*)|(\d[\d.,]*)\s?(?:([$£€])|\b(USD|EUR|GBP)\b)/;
  const SYM = { '$': 'USD', '£': 'GBP', '€': 'EUR', '¥': 'JPY', '₹': 'INR' };
  let tries = 0;
  while ((m = re.exec(html)) && tries++ < 300) {
    const t = decode(m[3]); if (!t) continue;
    const x = t.match(money); if (!x) continue;
    if (/^(del|s|strike)$/i.test(m[1]) || OLD_MARK.test(m[2]) || insideOld(html, m.index)) continue;
    const p = parsePrice(x[3] || x[4]); if (p == null) continue;
    const sym = x[1] || x[5]; const cur = x[2] || x[6] || (sym ? SYM[sym] : '');
    return { price: p, currency: cur || '' };
  }
  return null;
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

  if (price == null) {
    const vp = visiblePrice(html);
    if (vp) { price = vp.price; currency = currency || vp.currency; }
  }

  let image = absUrl((product && firstStr(product.image)) || meta['og:image:secure_url'] || meta['og:image'] || meta['twitter:image'] || meta['twitter:image:src'], url.href);
  const color = product && typeof product.color === 'string' && product.color.length < 30 ? decode(product.color) : '';

  return { title: title.slice(0, 140), price, currency, image, color, site: decode(site).slice(0, 60) };
}

