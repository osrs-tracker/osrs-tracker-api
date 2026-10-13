// One-off backfill of the image (`enclosure`) and teaser (`description`) of the stored posts that lack them (the posts
// `backfill-news.mjs` stored from the Wiki), from Jagex's own monthly news archive, which lists both for every post.
// Only Jagex's own teaser and image URL are stored, as the feed provides them: never an image file or Wiki text.
// Only sets a field a post lacks, matched on `link`: a post the feed stored keeps its feed version.
// Only `https://cdn.runescape.com/` images are stored, the only ones `GET /news/image` serves: older posts point at
// `services.runescape.com/m=rswikiimages` (gone: it redirects to a web page), a generic `www.runescape.com` fallback or
// imgur, and keep only their teaser.
//
// Jagex blocks an IP for a while (every `m=news` URL answers 404, the feed too) after a few dozen quick requests, so it
// asks for a page every 5s and waits out a block; walking the archive back to 2013 takes about an hour.
// `--cache=<dir>` keeps the pages it fetched there, so a rerun (the `--write` after a dry run) doesn't fetch them again.
// `--proxy` asks through `OSRS_API_BASE_URL` (the API Gateway proxy) instead, which isn't blocked as soon; it stops at
// the first 404 rather than wait, since the API's feed and hiscore lookups use that proxy too: rerun without it.
//
// Run from the repo root:
//   node --env-file=.env scripts/backfill-news-images.mjs --cache=<dir>           dry run: what it would set, the posts
//                                                                                  it can't match
//   node --env-file=.env scripts/backfill-news-images.mjs --cache=<dir> --write   stores it

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MongoClient } from 'mongodb';

const USER_AGENT = 'osrs-tracker-api news backfill (https://github.com/osrs-tracker/osrs-tracker-api)';
const POSTS_PER_PAGE = 10; // the archive's page size: a shorter page is a month's last
const MAX_PAGES_PER_MONTH = 20;
const REQUEST_DELAY_MS = 5000;
const BLOCKED_WAIT_MS = 10 * 60_000; // how long to wait when Jagex blocks (404) before asking again
const MAX_ATTEMPTS = 7; // about an hour of blocks for one page
const IMAGE_ORIGIN = 'https://cdn.runescape.com'; // the only origin `GET /news/image` accepts
const MAX_IMAGE_URL_LENGTH = 512; // and its URL length limit
const IMAGE_TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif' };

const write = process.argv.includes('--write');
const verbose = process.argv.includes('--verbose');
const cacheDir = process.argv.find((arg) => arg.startsWith('--cache='))?.slice('--cache='.length);
const proxy = process.argv.includes('--proxy');
const ARCHIVE_URL = `${proxy ? process.env.OSRS_API_BASE_URL : 'https://secure.runescape.com'}/m=news/archive`;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A page's HTML, from `--cache` or Jagex, decoded as its `content-type` declares: `ISO-8859-1`, which `TextDecoder`
 * reads as windows-1252. A page past a month's last answers 200 (the last page again), so a 404 is a block.
 */
async function fetchPage(year, month, page) {
  const cacheFile = cacheDir && join(cacheDir, `${year}-${month}-${page}.html`);
  const cached = cacheFile && (await readFile(cacheFile, 'utf8').catch(() => undefined));
  if (cached !== undefined) return cached;

  const url = `${ARCHIVE_URL}?${new URLSearchParams({ oldschool: 'true', year, month, page })}`;
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(url, { headers: { 'user-agent': USER_AGENT } });
    await delay(REQUEST_DELAY_MS);
    if (response.ok) {
      const charset = /charset=([^;\s]+)/i.exec(response.headers.get('content-type') ?? '')?.[1] ?? 'windows-1252';
      const html = new TextDecoder(charset).decode(await response.arrayBuffer());
      if (cacheFile) await writeFile(cacheFile, html);
      return html;
    }
    if (attempt === MAX_ATTEMPTS || proxy) throw new Error(`${url}: HTTP ${response.status}`);
    process.stdout.write(`\n${url}: HTTP ${response.status}, waiting ${BLOCKED_WAIT_MS / 60_000} minutes\n`);
    await delay(BLOCKED_WAIT_MS);
  }
}

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…' };
const unknownEntities = new Set();

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (entity, name) => {
    if (name[0] === '#') {
      return String.fromCodePoint(
        name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : Number(name.slice(1)),
      );
    }
    if (name.toLowerCase() in NAMED_ENTITIES) return NAMED_ENTITIES[name.toLowerCase()];
    unknownEntities.add(entity);
    return entity;
  });
}

/** Text without tags, entities decoded, whitespace collapsed. */
const toText = (html) =>
  decodeEntities(html.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();

/** The page's posts: `link`, `image` (as Jagex lists it), `date` (`YYYY-MM-DD`) and `teaser` (without "read more"). */
function parseArticles(html) {
  return [...html.matchAll(/<article class='news-list-article'>([\s\S]*?)<\/article>/g)].map(([, article]) => ({
    link: normalizeLink(decodeEntities(/news-list-article__title-link' href='([^']*)'/.exec(article)?.[1] ?? '')),
    image: decodeEntities(/news-list-article__figure-img' src='([^']*)'/.exec(article)?.[1] ?? ''),
    date: /<time[^>]*datetime='([^']*)'/.exec(article)?.[1],
    teaser: toText(
      /<p class='news-list-article__summary'>([\s\S]*?)(?:<a [^>]*read-?more[\s\S]*?<\/a>\s*)?<\/p>/i.exec(
        article,
      )?.[1] ?? '',
    ),
  }));
}

/** The link in the feed's form, as `backfill-news.mjs` stores it: `https://secure.runescape.com/m=news/<slug>?oldschool=1`. */
function normalizeLink(url) {
  const path = /\/m=news\/([^?#\s]+)/.exec(url)?.[1];
  const slug =
    path &&
    path
      .split('/')
      .filter((segment) => segment && !segment.includes('='))
      .at(-1);
  return slug ? `https://secure.runescape.com/m=news/${slug}?oldschool=1` : undefined;
}

/**
 * The image as `{ url, type }` when `GET /news/image` can serve it (`http://` CDN URLs moved to `https://`), else the
 * reason it can't, for the dry run's summary.
 */
function toEnclosure(image) {
  const url = URL.parse(image.replace(/^http:\/\/cdn\.runescape\.com\//, `${IMAGE_ORIGIN}/`));
  if (!url) return { skipped: 'no image' };
  if (url.origin !== IMAGE_ORIGIN) return { skipped: url.host };
  if (url.search || url.hash || url.username || url.password || url.href.length > MAX_IMAGE_URL_LENGTH) {
    return { skipped: 'unservable CDN URL' };
  }
  const type = IMAGE_TYPES[/\.[a-z]+$/i.exec(url.pathname)?.[0].toLowerCase()];
  return type ? { enclosure: { url: url.href, type } } : { skipped: `extension of ${url.pathname}` };
}

/** Every month from `from` (a Date) to now, as `[year, month]` with `month` 1-12. */
function* months(from) {
  const month = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth()));
  while (month <= new Date()) {
    yield [month.getUTCFullYear(), month.getUTCMonth() + 1];
    month.setUTCMonth(month.getUTCMonth() + 1);
  }
}

const client = new MongoClient(process.env.MONGODB_URI, {
  auth: { username: process.env.MONGODB_USERNAME, password: process.env.MONGODB_PASSWORD },
});
try {
  const news = client.db(process.env.MONGODB_DATABASE).collection('news');
  const missing = await news
    .find(
      { $or: [{ enclosure: { $exists: false } }, { description: { $exists: false } }] },
      { projection: { _id: 0, link: 1, title: 1, pubDate: 1, enclosure: 1, description: 1 } },
    )
    .sort({ pubDate: 1 })
    .toArray();
  if (missing.length === 0) {
    console.log('Every stored post has an image and a teaser: nothing to do.');
    process.exit(0);
  }
  console.log(`${missing.length} of ${await news.countDocuments()} stored posts lack an image or a teaser`);

  // The archive's posts by link; a link listed twice keeps the first
  const archive = new Map();
  let pages = 0; // read, cached or not
  if (cacheDir) await mkdir(cacheDir, { recursive: true });
  for (const [year, month] of months(missing[0].pubDate)) {
    // A page past the month's last repeats the last one, so a month of exactly 10, 20, … posts ends on a page of no new posts
    const found = new Set();
    for (let page = 1; page <= MAX_PAGES_PER_MONTH; page++) {
      const articles = parseArticles(await fetchPage(year, month, page)).filter((article) => article.link);
      pages++;
      const fresh = articles.filter((article) => !found.has(article.link));
      for (const article of fresh) {
        found.add(article.link);
        if (!archive.has(article.link)) archive.set(article.link, article);
      }
      if (articles.length < POSTS_PER_PAGE || fresh.length === 0) break;
      if (page === MAX_PAGES_PER_MONTH) throw new Error(`${year}-${month} has ${MAX_PAGES_PER_MONTH}+ pages`);
    }
    const label = `${year}-${String(month).padStart(2, '0')}`;
    process.stdout.write(`\r${label}: ${found.size} posts (${archive.size} in all, ${pages} pages)  `);
  }
  process.stdout.write('\n');

  const updates = [];
  const unmatched = [];
  const suffixMatches = [];
  const skippedImages = {};
  let enclosures = 0;
  let descriptions = 0;
  // Jagex adds `-1` to a slug already taken (often by a RuneScape post), and the Wiki and the archive don't always agree
  // on it: match those by the slug without it, when one archive post of that day (±3) has it and no stored post its link
  const storedLinks = new Set(await news.distinct('link'));
  const baseSlug = (link) => /\/m=news\/([^?]+)/.exec(link)[1].replace(/-\d+$/, '');
  const byBaseSlug = Map.groupBy(
    [...archive.values()].filter((article) => !storedLinks.has(article.link)),
    (article) => baseSlug(article.link),
  );
  const MAX_DATE_GAP_MS = 3 * 86_400_000;
  const findArticle = (post) => {
    const exact = archive.get(post.link);
    if (exact) return exact;
    const candidates = (byBaseSlug.get(baseSlug(post.link)) ?? []).filter(
      (article) => Math.abs(new Date(article.date) - post.pubDate) <= MAX_DATE_GAP_MS,
    );
    return candidates.length === 1 ? candidates[0] : undefined;
  };

  for (const post of missing) {
    const article = findArticle(post);
    if (!article) {
      unmatched.push(`${post.pubDate.toISOString().slice(0, 10)} ${post.title} (${post.link})`);
      continue;
    }
    if (article.link !== post.link) suffixMatches.push(`${post.link} -> ${article.link}`);
    const { enclosure, skipped } = toEnclosure(article.image);
    if (skipped) skippedImages[skipped] = (skippedImages[skipped] ?? 0) + 1;
    // One update per field, each only where the post lacks it, so a feed refresh in between keeps the feed's version
    if (!post.enclosure && enclosure) {
      enclosures++;
      updates.push({
        updateOne: { filter: { link: post.link, enclosure: { $exists: false } }, update: { $set: { enclosure } } },
      });
    }
    if (post.description === undefined && article.teaser) {
      descriptions++;
      updates.push({
        updateOne: {
          filter: { link: post.link, description: { $exists: false } },
          update: { $set: { description: article.teaser } },
        },
      });
    }
  }

  console.log(`Matched ${missing.length - unmatched.length}/${missing.length} posts`);
  console.log(`Would set ${enclosures} images and ${descriptions} teasers`);
  console.log('Images not stored, by host or reason:', skippedImages);
  console.log(`Matched without the -1 suffix: ${suffixMatches.length}`, suffixMatches);
  console.log(`Unmatched posts: ${unmatched.length}${verbose ? '' : ' (--verbose lists them all)'}`);
  console.log((verbose ? unmatched : unmatched.slice(0, 20)).join('\n'));
  if (unknownEntities.size) console.log('Unknown HTML entities, left as they are:', [...unknownEntities]);
  const samples = [...archive.values()].filter((article) => /["'’“”…&]/.test(article.teaser));
  console.log(
    'Teasers with quotes, ellipses or ampersands (check the decoding):',
    samples.filter((_, i) => i % Math.max(1, Math.floor(samples.length / 8)) === 0).map((article) => article.teaser),
  );

  if (!write) {
    console.log('Dry run: nothing written. Add --write to store them.');
    process.exit(0);
  }

  const result = await news.bulkWrite(updates, { ordered: false });
  console.log(`Matched ${result.matchedCount}, modified ${result.modifiedCount} (expected ${updates.length} each)`);
  console.log(`Without an image now: ${await news.countDocuments({ enclosure: { $exists: false } })}`);
} finally {
  await client.close();
}
