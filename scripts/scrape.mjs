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
const REFRESH = process.argv.includes('--refresh');
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

// Titles on harekrishna.ru: <b>«Title».</b> Author. Date | Place | <b>English</b>
const AUTHOR_RE = /^(.+?(?:Махараджа|Махарадж|Прабху|Даси|Тхакура|Тхакур|Госвами|Гхош|Деви|Maharaj|Prabhu))(?=[.,;]|\s*$)/;
function splitTitle($, $a) {
  const full = clean($a.text());
  const first = full.split('|')[0].trim();
  let bold = clean($a.find('b').map((_, b) => clean($(b).text())).get().filter(t => t && first.includes(t)).join(''));
  let title = stripQuotes(bold.replace(/^«\s*/, '«')) || '';
  title = title.split(/»\.?\s*«/)[0];
  title = title.replace(/^«|»\.?$/g, '').replace(/\.$/, '').trim();
  if (title.length < 3) { const m = /^«([^»]+)»/.exec(first); title = m ? m[1] : stripQuotes(first); }
  const dm = /\.\s+(\d{1,2}\s+[а-яё]+\s+\d{4}\s+года.*|\d{4}(?:-е)?\s+год.*)$/i.exec(title);
  if (dm) title = title.slice(0, dm.index);
  let rest = first;
  const idx = rest.indexOf(title); if (idx >= 0) rest = rest.slice(idx + title.length);
  rest = rest.replace(/^[»".\s]+/, '').trim();
  const am = AUTHOR_RE.exec(rest);
  const author = am && am[1].length < 80 ? clean(am[1]) : '';
  const subtitle = clean(author ? rest.slice(am[0].length).replace(/^[.,\s]+/, '') : rest).replace(/\.$/, '');
  return { title, author, subtitle };
}
const bgUrl = style => { const m = /url\(\s*['"]?([^'")]+)['"]?\s*\)/.exec(style || ''); return m ? absUrl(m[1]) : ''; };

function parseList($) {
  const seen = new Set(), out = [];
  const add = (u, $a, $box) => {
    if (!u || !u.startsWith(BASE) || seen.has(u) || !ARTICLE_RE.test(new URL(u).pathname)) return;
    const t = splitTitle($, $a); if (t.title.length < 3) return;
    const date = isoDate($box.find('span').first().text()) || isoDate($box.text());
    const image = bgUrl($box.find('img[style*="url("]').attr('style'));
    seen.add(u);
    out.push({ title: t.title, subtitle: t.subtitle, url: u, date, author: t.author, image, slug: slugOf(u) });
  };
  // Known layout: a thumbnail link (.news_element__link) and a text link in the same row.
  $('a.news_element__link').each((_, th) => {
    const u = absUrl($(th).attr('href'));
    let $box = $(th).closest('.row, p'); if (!$box.length) $box = $(th).parent();
    const $a = $box.find('a[href]').not('.news_element__link').filter((_, a) => absUrl($(a).attr('href')) === u).first();
    if ($a.length) add(u, $a, $box);
  });
  // Fallback for other layouts.
  if (out.length < 3) $('a[href]').each((_, a) => { let $box = $(a).parent(); for (let i = 0; i < 3 && !isoDate($box.text()); i++) $box = $box.parent(); add(absUrl($(a).attr('href')), $(a), $box); });
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
  const q = $('.quote').first();
  if (q.length) {
    const text = clean(q.find('p').not('.quote-source').text());
    const src = q.find('.quote-source');
    src.find('br').replaceWith(' | ');
    const parts = clean(src.text()).split('|').map(clean);
    if (text.length > 20) home.guru = { text, author: parts[0] || '', source: parts[1] || '' };
  } else {
    const guru = sectionAfter($, 'Слово Гуру');
    if (guru) { const t = clean(guru.text()).replace(/^.*?Слово Гуру\s*/, ''); if (t.length > 20) home.guru = { text: t.split('Шрила')[0].trim(), author: '', source: '' }; }
  }
  const days = [];
  $('.calendar p.date, p.date[title]').each((_, el) => {
    const d = isoDate($(el).attr('title') || '');
    const $c = $(el).clone(); $c.find('b').first().remove();
    const items = clean($c.text()).split(/(?<=\.)\s+/).map(clean).filter(s => s.length > 2);
    if (d && items.length && !days.find(x => x.date === d)) days.push({ date: d, items });
  });
  if (days.length >= 2) home.calendar = days;
  const newsBox = $('h2').filter((_, h) => clean($(h).text()) === 'Новости').first().closest('.content-block');
  if (newsBox.length) { const items = parseList(cheerio.load(newsBox.html() || '')); if (items.length >= 3) home.news = items; }
  const banner = $('a[href*="/tag/"]').filter((_, a) => $(a).find('img[alt]').length || clean($(a).text()).length > 10).first();
  if (banner.length) {
    const title = clean($(banner).find('img').attr('alt')) || clean($(banner).text());
    const image = absUrl($(banner).find('img').attr('src') || '');
    if (title) home.banner = { title, url: absUrl(banner.attr('href')), image: image || '' };
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
  const root = $('.news-body').first().length ? $('.news-body').first() : mainContent($);
  const scope = root || $('body');
  scope.find('audio[src], audio source[src]').each((_, el) => { const u = absUrl($(el).attr('src')); if (u) media.audio.push(u); });
  scope.find('a[href]').each((_, a) => { const u = absUrl($(a).attr('href')); if (u && /\.(mp3|m4a)(\?|$)/i.test(u)) media.audio.push(u); });
  scope.find('video source[src], video[src]').each((_, el) => { const u = absUrl($(el).attr('src')); if (u && /\.(mp4|webm)(\?|$)/i.test(u)) media.video.push({ type: 'file', src: u }); });
  scope.find('iframe[src], a[href*="youtu"]').each((_, el) => {
    const src = $(el).attr('src') || $(el).attr('href') || '';
    const yt = /(?:youtube(?:-nocookie)?\.com\/(?:embed\/|watch\?v=)|youtu\.be\/)([\w-]{11})/.exec(src);
    if (yt) media.video.push({ type: 'youtube', id: yt[1] });
    else if (/rutube\.ru\/play\/embed\/|vk\.com\/video_ext/.test(src)) media.video.push({ type: 'iframe', src: absUrl(src) });
  });
  let html = '';
  if (root) {
    root.find('iframe, video, audio, object, embed, script, style, a[download]').remove();
    root.find('a[href*="get.adobe.com"]').each((_, a) => { const $p = $(a).closest('p, div'); ($p.length && !$p.is(root) ? $p : $(a)).remove(); });
    root.find('small').filter((_, el) => /скачать/i.test($(el).text())).remove();
    root.find('img[src]').each((_, img) => { const u = absUrl($(img).attr('src')); if (u && !/\/local\/templates\//.test(u)) media.images.push(u); });
    const t0 = h1Title($);
    root.find('h2, h3').each((_, h) => { const ht = stripQuotes($(h).text()); if (ht && (ht === t0.title || ht === t0.author || authorsOf($).includes(ht))) $(h).remove(); });
    root.find('p').each((_, el) => { const pt = clean($(el).text()).replace(/\u00a0/g, ''); if (/^(Russian|English|Русский)$/i.test(pt) || (!pt && !$(el).find('img').length)) $(el).remove(); });
    html = sanitize($, root).replace(/Get the Flash Player to see this player\.?/gi, '').replace(/\s*\n\s*/g, '\n').trim();
    if (/Основатель-ачарья|2003–20\d\d\s*©/.test(html) && html.length < 1500) html = '';
  }
  const authors = authorsOf($);
  const t = h1Title($);
  const uniq = a => [...new Map(a.map(x => [JSON.stringify(x), x])).values()];
  return { title: t.title, subtitle: t.subtitle, author: authors.join(', ') || t.author, url, html,
    audio: uniq(media.audio), video: uniq(media.video).slice(0, 3), images: uniq(media.images).slice(0, 24) };
}
function h1Title($) { const h1 = $('h1').first(); return h1.length ? splitTitle($, h1) : { title: stripQuotes($('title').text()), subtitle: '', author: '' }; }
function authorsOf($) {
  const authors = [];
  $('li').filter((_, li) => /Автор:/.test($(li).find('.tag-prefix').text())).each((_, li) => {
    $(li).find('.tag-meat a.tag').each((_, a) => { const t = clean($(a).clone().children('small').remove().end().text()); if (t && !/^\(\d+\)$/.test(t) && !authors.includes(t)) authors.push(t); });
  });
  return authors;
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
  const all = ['video', 'audio', 'read', 'news'].flatMap(k => (site[k] || []).map(x => Object.assign(x, { kind: k })));
  let fetched = 0;
  for (const it of all) {
    if (!it.url || !it.url.startsWith(BASE)) continue;
    it.slug = it.slug || slugOf(it.url);
    const file = path.join(ITEMS, it.slug + '.json');
    const existing = await readJson(file, null);
    if (existing && !REFRESH) { if (existing.author && !it.author) it.author = existing.author; continue; }
    if (fetched >= MAX_NEW_ITEMS) break;
    try {
      const $ = cheerio.load(await get(it.url));
      const item = parseItem($, it.url);
      if (DEBUG && fetched === 0) console.log('--- first item:', JSON.stringify(item).slice(0, 2500));
      await fs.writeFile(file, JSON.stringify({ ...item, title: item.title || it.title, subtitle: item.subtitle || it.subtitle || '', date: it.date || '', author: item.author || it.author || '', image: it.image || item.images[0] || '', kind: it.kind, fetchedAt: new Date().toISOString() }, null, 1));
      if (item.author) it.author = item.author;
      fetched++;
    } catch (e) { report.push(`item ${it.slug}: ${e.message}`); }
  }
  for (const k of ['video', 'audio', 'read', 'news']) (site[k] || []).forEach(x => { delete x.kind; x.slug = x.slug || (x.url && x.url.startsWith(BASE) ? slugOf(x.url) : ''); });
  const gotSomething = report.some(r => !/kept old/.test(r) && !r.startsWith('item ')) || fetched > 0;
  if (gotSomething) site.fetchedAt = new Date().toISOString();
  else { console.log(report.concat('nothing new; data left unchanged').join('\n')); process.exitCode = 1; return; }
  await fs.writeFile(path.join(DATA, 'site.json'), JSON.stringify(site, null, 1));
  console.log(report.concat(`new item pages: ${fetched}`, `requests: ${requests}`).join('\n'));
}
main().catch(e => { console.error(e); process.exit(1); });
