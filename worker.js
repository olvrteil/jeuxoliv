/* Jeux d'Oliv - Worker Cloudflare.
 *
 * Le site (fichiers statiques) est servi directement par Cloudflare. Ce Worker ne répond qu'aux
 * adresses /api/* (voir "run_worker_first" dans wrangler.jsonc) :
 *   GET  /api/bgg/search?q=...      recherche de jeux sur BoardGameGeek (fiches complètes des meilleurs résultats)
 *   GET  /api/bgg/game?id=13,822    fiches de jeux par numéro BGG (20 maximum)
 *   GET  /api/bgg/image?u=...       copie d'une image de boîte hébergée par BGG (pour la recopier dans Supabase)
 *   POST /api/translate             traduction anglais -> français d'un texte (Workers AI)
 *
 * Sécurité :
 *   - le jeton BGG est un SECRET du Worker (BGG_TOKEN), jamais envoyé au navigateur ni écrit dans le dépôt ;
 *   - chaque appel doit porter la session Supabase de l'utilisateur ("Authorization: Bearer <jwt>") et
 *     ce compte doit être ADMIN (vérifié auprès de Supabase avec la fonction my_status) : un tiers ne peut
 *     donc ni consommer le jeton BGG ni le quota de traduction ;
 *   - seules les images de cf.geekdo-images.com sont relayées.
 */

const BGG_API = 'https://boardgamegeek.com/xmlapi2/';
const IMG_RE = /^https:\/\/cf\.geekdo-images\.com\/[\w\-.\/=:()~%,+!]+$/;
const MAX_IMG = 8 * 1024 * 1024;
const MAX_TEXT = 6000;
const CHUNK = 380;
const MODEL = '@cf/meta/m2m100-1.2b';
const UA = 'JeuxOliv/1.0 (+https://jeuxoliv.com)';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function json(obj, status, extra) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }, extra || {}),
  });
}
const fail = (status, error, message) => json({ error, message: message || '' }, status);

/* ---------- Droits : compte Supabase connecté ET admin ----------
   Renvoie null si tout va bien, sinon la réponse d'erreur à envoyer (avec la cause exacte, pour que l'écran puisse l'expliquer). */
async function adminCheck(req, env) {
  const SB_URL = env.SUPABASE_URL || 'https://pjsaghnexlsxkkxauibc.supabase.co'; // valeurs publiques (config.js), repli si les variables manquent
  const SB_KEY = env.SUPABASE_ANON_KEY || 'sb_publishable_WRWRUmGY3efJTzY-7o3rnQ_0_DoGOa_';
  if (!SB_URL || !SB_KEY) { console.log('adminCheck: variables SUPABASE_URL / SUPABASE_ANON_KEY absentes'); return fail(500, 'cfg', 'Variables Supabase absentes sur le Worker.'); }
  const auth = req.headers.get('Authorization') || '';
  if (!/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/.test(auth)) return fail(401, 'session', 'Session absente ou illisible.');
  let r;
  try {
    r = await fetch(SB_URL.replace(/\/+$/, '') + '/rest/v1/rpc/my_status', {
      method: 'POST',
      headers: { apikey: SB_KEY, Authorization: auth, 'Content-Type': 'application/json' },
      body: '{}',
    });
  } catch (e) { console.log('adminCheck: Supabase injoignable', String(e && e.message)); return fail(502, 'rpc', 'Supabase injoignable depuis le Worker.'); }
  if (r.status === 401 || r.status === 403) return fail(401, 'session', 'Session refusée par Supabase (expirée ?).');
  if (!r.ok) { console.log('adminCheck: Supabase a répondu', r.status); return fail(502, 'rpc', 'Supabase a répondu ' + r.status + '.'); }
  let j = null; try { j = await r.json(); } catch (e) {}
  if (Array.isArray(j)) j = j[0];
  if (j && typeof j === 'object' && j.my_status && typeof j.my_status === 'object') j = j.my_status;
  if (!(j && (j.admin === true || j.admin === 'true' || j.admin === 't'))) { console.log('adminCheck: compte non admin, réponse', JSON.stringify(j)); return fail(403, 'not_admin', 'Réservé à l’administrateur.'); }
  return null;
}

/* ---------- BoardGameGeek (API XML 2, jeton obligatoire) ---------- */
class BggError extends Error { constructor(code, status) { super(code); this.code = code; this.status = status || 502; } }

async function bggGet(env, path) {
  if (!env.BGG_TOKEN) throw new BggError('no_token', 503);
  let wait = 2000;
  for (let i = 0; i < 4; i++) {
    const r = await fetch(BGG_API + path, {
      headers: { Authorization: 'Bearer ' + env.BGG_TOKEN, 'User-Agent': UA, Accept: 'application/xml' },
      cf: { cacheTtlByStatus: { '200-299': 3600, '202': 0, '300-599': 0 }, cacheEverything: true },
    });
    if (r.status === 202) { await sleep(wait); wait += 1500; continue; }        /* demande mise en file d'attente par BGG */
    if (r.status === 429) { if (i >= 2) throw new BggError('bgg_busy', 429); await sleep(3000 * (i + 1)); continue; }
    if (r.status === 401 || r.status === 403) throw new BggError('bgg_auth', 502);
    if (!r.ok) throw new BggError('bgg_http', 502);
    return r.text();
  }
  throw new BggError('bgg_busy', 503);
}

function xmlDecode(s) {
  return String(s == null ? '' : s)
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => safeChr(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (m, d) => safeChr(parseInt(d, 10)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}
function safeChr(n) { try { return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ''; } catch (e) { return ''; } }
function attrOf(tag, name) {
  const m = new RegExp('\\b' + name + '="([^"]*)"').exec(tag);
  return m ? xmlDecode(m[1]) : '';
}
function firstTag(block, tagName) {
  const m = new RegExp('<' + tagName + '\\b[^>]*>').exec(block);
  return m ? m[0] : '';
}
const intOf = (v) => { const n = parseInt(v, 10); return isFinite(n) && n > 0 ? n : 0; };

/* Un bloc <item> de la réponse "thing" -> objet simple (même forme que l'import GameShelf du site) */
function parseItem(block) {
  const head = /<item\b[^>]*>/.exec(block)[0];
  const type = attrOf(head, 'type');
  const id = attrOf(head, 'id');
  let name = '';
  const names = block.match(/<name\b[^>]*>/g) || [];
  for (const t of names) { if (attrOf(t, 'type') === 'primary') { name = attrOf(t, 'value'); break; } }
  if (!name && names.length) name = attrOf(names[0], 'value');
  const thumb = /<thumbnail>\s*([^<\s]+)\s*<\/thumbnail>/.exec(block);
  const image = /<image>\s*([^<\s]+)\s*<\/image>/.exec(block);
  const desc = /<description>([\s\S]*?)<\/description>/.exec(block);
  const o = {
    id: id,
    type: type,
    name: name,
    yearPublished: intOf(attrOf(firstTag(block, 'yearpublished'), 'value')),
    minPlayers: intOf(attrOf(firstTag(block, 'minplayers'), 'value')),
    maxPlayers: intOf(attrOf(firstTag(block, 'maxplayers'), 'value')),
    playingTime: intOf(attrOf(firstTag(block, 'playingtime'), 'value')),
    minAge: intOf(attrOf(firstTag(block, 'minage'), 'value')),
    thumbnail: thumb ? xmlDecode(thumb[1]) : '',
    image: image ? xmlDecode(image[1]) : '',
    description: desc ? xmlDecode(desc[1]) : '',   /* encore encodé une fois en HTML : le site le nettoie */
    categories: [],
    playersBest: [],
    playersRecommended: [],
    weight: 0,
    usersRated: 0,
  };
  (block.match(/<link\b[^>]*>/g) || []).forEach((t) => { if (attrOf(t, 'type') === 'boardgamecategory') o.categories.push(attrOf(t, 'value')); });

  /* Sondage « nombre de joueurs conseillé » : meilleur à n / recommandé à n */
  const poll = /<poll\b[^>]*name="suggested_numplayers"[\s\S]*?<\/poll>/.exec(block);
  if (poll) {
    const rows = [];
    const re = /<results\b([^>]*)>([\s\S]*?)<\/results>/g;
    let m;
    while ((m = re.exec(poll[0]))) {
      const n = attrOf('<x ' + m[1] + '>', 'numplayers');
      if (!/^\d+$/.test(n)) continue;                                  /* « 4+ » : au-delà du maximum, ignoré */
      const votes = { best: 0, rec: 0, not: 0 };
      (m[2].match(/<result\b[^>]*>/g) || []).forEach((t) => {
        const v = attrOf(t, 'value'), c = intOf(attrOf(t, 'numvotes'));
        if (v === 'Best') votes.best = c; else if (v === 'Recommended') votes.rec = c; else if (v === 'Not Recommended') votes.not = c;
      });
      rows.push({ n: +n, best: votes.best, ok: votes.best + votes.rec > votes.not });
    }
    const okRows = rows.filter((r) => r.ok);
    o.playersRecommended = okRows.map((r) => r.n).sort((a, b) => a - b);
    const top = Math.max.apply(null, [0].concat(okRows.map((r) => r.best)));
    if (top > 0) o.playersBest = okRows.filter((r) => r.best >= top * 0.85).map((r) => r.n).sort((a, b) => a - b);
  }
  const w = parseFloat(attrOf(firstTag(block, 'averageweight'), 'value'));
  if (w >= 1 && w <= 5) o.weight = Math.round(w * 100) / 100;
  o.usersRated = intOf(attrOf(firstTag(block, 'usersrated'), 'value'));
  return o;
}
function parseThings(xml) {
  return (xml.match(/<item\b[\s\S]*?<\/item>/g) || []).map(parseItem).filter((g) => g.id && g.name);
}
function parseSearch(xml) {
  const out = [];
  (xml.match(/<item\b[\s\S]*?<\/item>/g) || []).forEach((b) => {
    const head = /<item\b[^>]*>/.exec(b)[0];
    const names = b.match(/<name\b[^>]*>/g) || [];
    let name = '';
    for (const t of names) { if (attrOf(t, 'type') === 'primary') { name = attrOf(t, 'value'); break; } }
    if (!name && names.length) name = attrOf(names[0], 'value');
    const id = attrOf(head, 'id');
    if (id && name) out.push({ id: id, name: name });
  });
  return out;
}
const fold = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

async function things(env, ids) {
  const list = ids.filter((x) => /^\d{1,9}$/.test(x)).slice(0, 20);
  if (!list.length) return [];
  const xml = await bggGet(env, 'thing?stats=1&id=' + list.join(','));
  const byId = {};
  parseThings(xml).forEach((g) => { byId[g.id] = g; });
  return list.map((i) => byId[i]).filter(Boolean);
}

async function search(env, q) {
  const xml = await bggGet(env, 'search?type=boardgame&query=' + encodeURIComponent(q));
  const hits = parseSearch(xml), f = fold(q);
  /* Les résultats de BGG ne sont pas classés : noms identiques d'abord, puis ceux qui commencent par la recherche, puis ceux qui la contiennent */
  const rank = (name) => { const n = fold(name); return n === f ? 0 : n.indexOf(f) === 0 ? 1 : n.indexOf(f) > 0 ? 2 : 3; };
  const top = hits.map((h, i) => ({ h: h, r: rank(h.name), i: i })).sort((a, b) => a.r - b.r || a.i - b.i).slice(0, 20).map((x) => x.h);
  const full = (await things(env, top.map((h) => h.id))).filter((g) => g.type === 'boardgame');
  /* à rang égal, les jeux les plus notés (donc les plus connus) d'abord */
  full.sort((a, b) => rank(a.name) - rank(b.name) || b.usersRated - a.usersRated);
  return { total: hits.length, games: full };
}

/* ---------- Images ---------- */
async function image(u) {
  if (!IMG_RE.test(u)) return fail(400, 'bad_url', 'Adresse d’image non autorisée.');
  /* redirections suivies à la main, uniquement vers l'hôte d'images autorisé */
  let r, cur = u;
  try {
    for (let i = 0; i < 4; i++) {
      r = await fetch(cur, { headers: { 'User-Agent': UA, Accept: 'image/*' }, redirect: 'manual' });
      const loc = r.status >= 300 && r.status < 400 ? r.headers.get('Location') : '';
      if (!loc) break;
      cur = new URL(loc, cur).href;
      if (!IMG_RE.test(cur)) return fail(502, 'img_http', 'Redirection d’image refusée.');
    }
  } catch (e) { console.log('image: ' + String(e && e.message || e)); return fail(502, 'img_http', 'Image injoignable chez BGG.'); }
  if (!r || !r.ok) { console.log('image: statut ' + (r && r.status)); return fail(502, 'img_http', 'Image introuvable chez BGG (statut ' + (r && r.status) + ').'); }
  const ct = (r.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  if (!/^image\/(jpeg|png|webp|gif)$/.test(ct)) return fail(502, 'img_type', 'Format d’image inattendu.');
  const len = +r.headers.get('Content-Length') || 0;
  if (len > MAX_IMG) return fail(413, 'img_big', 'Image trop lourde.');
  const buf = await r.arrayBuffer();
  if (buf.byteLength > MAX_IMG) return fail(413, 'img_big', 'Image trop lourde.');
  return new Response(buf, { headers: { 'Content-Type': ct, 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' } });
}

/* ---------- Traduction (Workers AI, modèle de traduction M2M100) ---------- */
function chunkText(text) {
  const out = [];
  String(text).split(/\n/).forEach((par, pi, all) => {
    const p = par.trim();
    if (!p) { out.push({ raw: '\n' }); return; }
    const sentences = p.split(/(?<=[.!?…])\s+/);
    let cur = '';
    const flush = () => { if (cur) { out.push({ src: cur }); cur = ''; } };
    sentences.forEach((s) => {
      while (s.length > CHUNK) {                                           /* phrase trop longue : coupée à un espace */
        let k = s.lastIndexOf(' ', CHUNK); if (k < 100) k = CHUNK;
        flush(); out.push({ src: s.slice(0, k).trim() }); s = s.slice(k).trim();
      }
      if (cur && (cur.length + 1 + s.length) > CHUNK) flush();
      cur = cur ? cur + ' ' + s : s;
    });
    flush();
    if (pi < all.length - 1) out.push({ raw: '\n' });
  });
  return out;
}
async function runModel(env, src) {
  const attempts = [{ source_lang: 'en', target_lang: 'fr' }, { source_lang: 'english', target_lang: 'french' }];
  let last;
  for (const a of attempts) {
    try {
      const r = await env.AI.run(MODEL, Object.assign({ text: src }, a));
      const t = r && (r.translated_text || r.response || (r.result && r.result.translated_text));
      if (t && String(t).trim()) return String(t).trim();
    } catch (e) { last = e; if (/neuron|quota|limit|capacity|daily/i.test(String(e && e.message))) throw e; }
  }
  if (last) throw last;
  return src;                                                              /* réponse vide : on garde le texte d'origine */
}
async function translate(env, text) {
  const parts = chunkText(text), todo = parts.filter((p) => p.src);
  if (todo.length > 30) return fail(413, 'too_long', 'Texte trop long.');
  for (let i = 0; i < todo.length; i += 3) {
    await Promise.all(todo.slice(i, i + 3).map(async (p) => { p.out = await runModel(env, p.src); }));
  }
  /* reconstitue les paragraphes : les morceaux d'un même paragraphe sont séparés par une espace */
  let res = '', prevSrc = false;
  parts.forEach((p) => {
    if (p.raw) { res += p.raw; prevSrc = false; } else { res += (prevSrc ? ' ' : '') + p.out; prevSrc = true; }
  });
  return json({ text: res.replace(/\n{3,}/g, '\n\n').trim() });
}

/* ---------- Routage ---------- */
export default {
  async fetch(req, env) {
    const url = new URL(req.url), path = url.pathname;
    if (!path.startsWith('/api/')) return env.ASSETS ? env.ASSETS.fetch(req) : new Response('Not found', { status: 404 });

    const origin = req.headers.get('Origin');
    if (origin && origin !== url.origin) return fail(403, 'origin', 'Origine non autorisée.');
    if (req.method === 'OPTIONS') return new Response(null, { status: 204 });

    const route = path.replace(/\/+$/, '');
    const known = { '/api/bgg/search': 'GET', '/api/bgg/game': 'GET', '/api/bgg/image': 'GET', '/api/translate': 'POST' };
    if (!known[route]) return fail(404, 'not_found');
    if (req.method !== known[route]) return fail(405, 'method');
    const denied = await adminCheck(req, env);
    if (denied) return denied;

    try {
      if (route === '/api/bgg/search') {
        const q = (url.searchParams.get('q') || '').trim().slice(0, 80);
        if (q.length < 2) return fail(400, 'short', 'Tapez au moins 2 caractères.');
        return json(await search(env, q));
      }
      if (route === '/api/bgg/game') {
        const ids = (url.searchParams.get('id') || '').split(',').map((x) => x.trim()).filter(Boolean);
        if (!ids.length || ids.length > 20 || ids.some((x) => !/^\d{1,9}$/.test(x))) return fail(400, 'bad_id', 'Numéro de jeu invalide.');
        return json({ games: await things(env, ids) });
      }
      if (route === '/api/bgg/image') return await image(url.searchParams.get('u') || '');
      /* /api/translate */
      if (!env.AI) return fail(503, 'no_ai', 'La traduction n’est pas activée sur ce Worker.');
      let body; try { body = await req.json(); } catch (e) { return fail(400, 'bad_json'); }
      const text = body && typeof body.text === 'string' ? body.text.trim() : '';
      if (!text) return fail(400, 'empty', 'Aucun texte à traduire.');
      if (text.length > MAX_TEXT) return fail(413, 'too_long', 'Texte trop long (6 000 caractères maximum).');
      return await translate(env, text);
    } catch (e) {
      if (e instanceof BggError) return fail(e.status, e.code);
      const m = String(e && e.message || '');
      if (/neuron|quota|limit|capacity|daily/i.test(m)) return fail(429, 'quota', 'Quota de traduction du jour atteint.');
      console.log('upstream: ' + m); return fail(502, 'upstream', 'Erreur du Worker : ' + m.slice(0, 160));
    }
  },
};
