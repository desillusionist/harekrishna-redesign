// Reads public pages of harekrishna.ru and saves them as JSON for the redesigned site.
// Read-only and polite: one request at a time, a pause between requests, and a
// limited number of new article pages per run. Run: node scripts/scrape.mjs [--debug]
import * as cheerio from 'cheerio';
import fs from 'node:fs/promises';
import path from 'node:path';

const BASE = process.env.HK_BASE || 'https://harekrishna.ru';
const DATA = path.resolve('data');
const ITEMS = path.join(DATA, 'items');
const DEBUG = process.argv.includes('--debug');
const MAX_NEW_ITEMS = Number(process.env.MAX_NEW_ITEMS || 40);
const PER_LIST = 12;
const PAUSE_MS = Number(process.env.PAUSE_MS || 1500);
const UA = 'Mozilla/5.0 (compatible; harekrishna-redesign-preview/1.0; read-only, every 3 hours; +https://github.com/desillusionist/harekrishna-redesign)';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const MONTHS = {января:1,февраля:2,марта:3,апреля:4,мая:5,июня:6,июля:7,августа:8,сентября:9,октября:10,ноября:11,декабря:12};
const DATE_RE = /(\d{1,2})\s+(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)\s+(\d{4})/i;
const NUM_DATE_RE = /\b(\d{2})\.(\d{2})\.(\d{4})\b/;

function isoDate(text) {
  const m = DATE_RE.exec(text || '');
  if (m) return `${m[3]}-${String(MONTHS[m[2].toLowerCase()]).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  const n = NUM_DATE_RE.exec(text || '');
  if (n) return `${n[3]}-${n[2]}-${n[1]}`;
  return '';
}
const clean = s => (s || '').replace(/\s+/g, ' ').trim();
const stripQuotes = s => clean(s).replace(/^«(.*)»\.?$/, '$1').replace(/\.$/, '');
const ARTICLE_RE = /^\/\d{4}\/\d{2}\/[^/?#]+\/?$/;

let requests = 0, failures = 0;
async function get(url) {
  if (requests++) await sleep(PAUSE_MS);
  if (failures >= 3) throw new Error(`skipped after repeated refusals: ${url}`);
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'ru,en;q=0.8' } });
  if (!res.ok) {
    failures++;
    if (DEBUG && failures === 1) {
      console.log(`--- refused ${res.status} ${url}`);
      for (const [k, v] of res.headers) console.log(`    ${k}: ${v}`);
      console.log((await res.text()).replace(/\s+/g, ' ').slice(0, 800));
    }
    throw new Error(`${res.status} for ${url}`);
  }
  failures = 0;
  return res.text();
}

function absUrl(href) {
  try { const u = new URL(href, BASE); u.hash = ''; return u.href; } catch { return null; }
}
function slugOf(url) {
  const last = new URL(url).pathname.replace(/\/$/, '').split('/').pop();
  return last.toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 120);
}

// Listing pages (/news/video/ etc.): article links with the nearest date and author text.
function parseList($) {
  const seen = new Set(), out = [];
  $('a[href]').each((_, a) => {
    const href = $(a).attr('href');
    const u = absUrl(href); if (!u || !u.startsWith(BASE)) return;
    const p = new URL(u).pathname;
    if (!ARTICLE_RE.test(p) || seen.has(u)) return;
    const title = stripQuotes($(a).text());
    if (title.length < 3) return;
    // climb to a container that holds a date
    let box = $(a).parent(), d = '';
    for (let i = 0; i < 5 && box.length; i++) { d = isoDate(box.text()); if (d) break; box = box.parent(); }
    let author = '';
    if (box.length) {
      const t = clean(box.text().replace($(a).text(), ''));
      const m = /((?:Шрила|Шрипад|Шримати|Шриюкта|Срила|Srila|Sripad)[^,;|]{3,60}?(?:Махарадж|Maharaj|Даси|Прабху|Тхакур|Госвами)|[А-ЯЁ][а-яё]+ (?:Прабху|Деви Даси))/.exec(t);
      if (m) author = clean(m[1]);
    }
    seen.add(u);
    out.push({ title, url: u, date: d, author, slug: slugOf(u) });
  });
  return out.slice(0, PER_LIST);
}

// Home page: banner, "Слово Гуру", calendar, news.
function sectionAfter($, heading) {
  const h = $('*').filter((_, el) => clean($(el).clone().children().remove().end().text()).startsWith(heading)).first();
  if (!h.length) return null;
  let box = h.parent();
  for (let i = 0; i < 3 && box.length && clean(box.text()).length < 80; i++) box = box.parent();
  return box;
}
function parseHome($) {
  const home = {};
  const guru = sectionAfter($, 'Слово Гуру');
  if (guru) {
    const text = clean(guru.text()).replace(/^.*?Слово Гуру\s*/, '');
    const src = /«[^»]+»,?\s*гл\.\s*\d+/.exec(text);
    const quote = clean(text.split(/Шрила Б\.|Шрила Бхакти/)[0]);
    if (quote.length > 20) home.guru = { text: quote, author: 'Шрила Бхакти Сундар Говинда Дев-Госвами Махарадж', source: src ? src[0] : '' };
  }
  const cal = sectionAfter($, 'Вайшнавский календарь');
  if (cal) {
    const days = [];
    cal.find('li, p, div, tr').each((_, el) => {
      const t = clean($(el).text()); const d = isoDate(t) || isoDate(t.replace(/^(\d{1,2})\s+(\S+)/, '$1 $2 ' + new Date().getFullYear()));
      if (!d || t.length > 600) return;
      const items = t.replace(DATE_RE, '').split(/(?<=\.)\s+/).map(s => clean(s).replace(/^\((пн|вт|ср|чт|пт|сб|вс)\)\s*/i, '')).filter(s => s.length > 3 && !/^\(?(пн|вт|ср|чт|пт|сб|вс)\)?$/i.test(s));
      if (items.length && !days.find(x => x.date === d)) days.push({ date: d, items });
    });
    if (days.length >= 3) home.calendar = days;
  }
  const newsBox = sectionAfter($, 'Новости');
  if (newsBox) {
    const items = parseList(cheerio.load(newsBox.html() || ''));
    if (items.length >= 3) home.news = items;
  }
  const banner = $('a[href*="/tag/"]').filter((_, a) => clean($(a).text()).length > 10 || $(a).find('img[alt]').length).first();
  if (banner.length) {
    const title = clean($(banner).text()) || clean($(banner).find('img').attr('alt'));
    if (title) home.banner = { title, url: absUrl(banner.attr('href')) };
  }
  return home;
}

// Article pages: main text (sanitized), audio files, embedded videos, images.
const KEEP = new Set(['p','h2','h3','h4','blockquote','ul','ol','li','em','strong','b','i','br','a','img','figure','figcaption']);
function sanitize($, root) {
  const walk = node => {
    let html = '';
    $(node).contents().each((_, c) => {
      if (c.type === 'text') { html += $('<x>').text(c.data).html(); return; }
      if (c.type !== 'tag') return;
      const tag = c.name.toLowerCase();
      if (['script','style','iframe','form','nav','noscript','button','input','select','header','footer','aside'].includes(tag)) return;
      const inner = walk(c);
      if (!KEEP.has(tag)) { html += /^(div|section|article|tr|center)$/.test(tag) && clean(inner.replace(/<[^>]+>/g, '')) && !/<(p|h\d|ul|ol|blockquote|figure)\b/.test(inner) ? `<p>${inner}</p>` : inner; return; }
      if (tag === 'a') { const u = absUrl($(c).attr('href')); html += u ? `<a href="${u.replace(/"/g,'&quot;')}">${inner}</a>` : inner; return; }
      if (tag === 'img') { const u = absUrl($(c).attr('src')); if (u) html += `<img src="${u.replace(/"/g,'&quot;')}" alt="${($(c).attr('alt')||'').replace(/"/g,'&quot;')}" loading="lazy">`; return; }
      if (tag === 'br') { html += '<br>'; return; }
      html += `<${tag}>${inner}</${tag}>`;
    });
    return html;
  };
  return walk(root).replace(/<p>\s*(<br>\s*)*<\/p>/g, '').replace(/(<br>\s*){3,}/g, '<br><br>');
}
function mainContent($) {
  let best = null, score = 0;
  $('article, main, div, section, td').each((_, el) => {
    const $el = $(el);
    const ps = $el.children('p').length + $el.children('div').filter((_, d) => clean($(d).text()).length > 120).length;
    const text = clean($el.children('p').text()).length;
    const s = ps * 50 + text;
    if (s > score) { score = s; best = $el; }
  });
  return best;
}
function parseItem($, url) {
  const media = { audio: [], video: [], images: [] };
  $('audio[src], audio source[src], source[src]').each((_, el) => { const u = absUrl($(el).attr('src')); if (u && /\.(mp3|m4a|ogg)(\?|$)/i.test(u)) media.audio.push(u); });
  $('a[href]').each((_, a) => { const u = absUrl($(a).attr('href')); if (u && /\.(mp3|m4a)(\?|$)/i.test(u)) media.audio.push(u); });
  $('iframe[src], a[href*="youtu"]').each((_, el) => {
    const src = $(el).attr('src') || $(el).attr('href') || '';
    const yt = /(?:youtube\.com\/(?:embed\/|watch\?v=)|youtu\.be\/)([\w-]{11})/.exec(src);
    if (yt) media.video.push({ type: 'youtube', id: yt[1] });
    else if (/rutube\.ru\/play\/embed\/|vk\.com\/video_ext/.test(src)) media.video.push({ type: 'iframe', src: absUrl(src) });
  });
  const root = mainContent($);
  const html = root ? sanitize($, root) : '';
  if (root) root.find('img[src]').each((_, img) => { const u = absUrl($(img).attr('src')); if (u) media.images.push(u); });
  const uniq = a => [...new Map(a.map(x => [JSON.stringify(x), x])).values()];
  const title = stripQuotes($('h1').first().text()) || stripQuotes($('title').text());
  const ogImage = absUrl($('meta[property="og:image"]').attr('content') || '');
  return { title, url, date: isoDate(clean($('body').text()).slice(0, 4000)), html,
    audio: uniq(media.audio), video: uniq(media.video).slice(0, 3), images: uniq(media.images).slice(0, 12), image: ogImage || media.images[0] || '' };
}

async function readJson(file, fallback) { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; } }

async function main() {
  await fs.mkdir(ITEMS, { recursive: true });
  const prev = await readJson(path.join(DATA, 'site.json'), {});
  const site = { ...prev };
  const report = [];

  for (const [key, page] of [['video', '/news/video/'], ['audio', '/news/audio/'], ['read', '/news/read/']]) {
    try {
      const $ = cheerio.load(await get(BASE + page));
      if (DEBUG) console.log(`--- ${page} sample:\n`, $('a[href^="/20"]').slice(0, 2).map((_, a) => $.html($(a).parent().parent())).get().join('\n').slice(0, 3000));
      const items = parseList($);
      if (items.length >= 3) { site[key] = items; report.push(`${key}: ${items.length}`); }
      else report.push(`${key}: kept old (found ${items.length})`);
    } catch (e) { report.push(`${key}: kept old (${e.message})`); }
  }
  try {
    const $ = cheerio.load(await get(BASE + '/'));
    const home = parseHome($);
    if (DEBUG) console.log('--- home parsed:', JSON.stringify(home).slice(0, 3000));
    if (home.news) { site.news = home.news; delete home.news; }
    site.home = { ...(prev.home || {}), ...home };
    report.push(`home: ${Object.keys(home).join(', ') || 'kept old'}`);
  } catch (e) { report.push(`home: kept old (${e.message})`); }

  // Article pages: fetch the ones we don't have yet.
  const all = ['video', 'audio', 'read', 'news'].flatMap(k => (site[k] || []).map(x => ({ ...x, kind: k })));
  let fetched = 0;
  for (const it of all) {
    if (!it.url || !it.url.startsWith(BASE)) continue;
    it.slug = it.slug || slugOf(it.url);
    const file = path.join(ITEMS, it.slug + '.json');
    if (await readJson(file, null)) continue;
    if (fetched >= MAX_NEW_ITEMS) break;
    try {
      const $ = cheerio.load(await get(it.url));
      const item = parseItem($, it.url);
      if (DEBUG && fetched === 0) console.log('--- first item:', JSON.stringify(item).slice(0, 2500));
      await fs.writeFile(file, JSON.stringify({ ...item, title: it.title || item.title, date: it.date || item.date, author: it.author || '', kind: it.kind, fetchedAt: new Date().toISOString() }, null, 1));
      fetched++;
    } catch (e) { report.push(`item ${it.slug}: ${e.message}`); }
  }
  for (const k of ['video', 'audio', 'read', 'news']) (site[k] || []).forEach(x => { x.slug = x.slug || (x.url && x.url.startsWith(BASE) ? slugOf(x.url) : ''); });
  const gotSomething = report.some(r => !/kept old/.test(r) && !r.startsWith('item ')) || fetched > 0;
  if (gotSomething) site.fetchedAt = new Date().toISOString();
  else { console.log(report.concat('nothing new; data left unchanged').join('\n')); process.exitCode = 1; return; }
  await fs.writeFile(path.join(DATA, 'site.json'), JSON.stringify(site, null, 1));
  console.log(report.concat(`new item pages: ${fetched}`, `requests: ${requests}`).join('\n'));
}
main().catch(e => { console.error(e); process.exit(1); });
