// One-off backfill of the `news` collection with the posts from before the API stored the feed (2026-10), from the
// OSRS Wiki's `update` bucket: title, date and category, plus the Jagex link from each Update page's `{{Update|url=}}`.
// Only those facts are stored, never Wiki text (CC BY-NC-SA), so backfilled posts have no `description` or `enclosure`.
// Inserts only (`$setOnInsert`): a post the feed already stored keeps its feed version.
//
// Run from the repo root after the API has deployed (it creates the unique `link` index):
//   node --env-file=.env scripts/backfill-news.mjs           dry run: what it would store, and checks against the feed
//   node --env-file=.env scripts/backfill-news.mjs --write   stores it

import { MongoClient } from 'mongodb';

const WIKI_API = 'https://oldschool.runescape.wiki/api.php';
const FEED_URL = 'https://secure.runescape.com/m=news/latest_news.rss?oldschool=true';
const USER_AGENT = 'osrs-tracker-api news backfill (https://github.com/osrs-tracker/osrs-tracker-api)';
const BUCKET_LIMIT = 5000;
const TITLES_PER_REQUEST = 50; // the API's limit for page content

const write = process.argv.includes('--write');

async function wiki(params) {
  const response = await fetch(
    `${WIKI_API}?${new URLSearchParams({ format: 'json', formatversion: '2', ...params })}`,
    {
      headers: { 'user-agent': USER_AGENT },
    },
  );
  if (!response.ok) throw new Error(`Wiki API: HTTP ${response.status}`);
  return response.json();
}

/** The `update` bucket's rows: `page_name`, `date` (Unix seconds, noon UTC) and `type` (`Game updates`, …). */
async function fetchUpdates() {
  const query = `bucket('update').select('page_name','date','type').limit(${BUCKET_LIMIT}).run()`;
  const { bucket } = await wiki({ action: 'bucket', query });
  if (bucket.length >= BUCKET_LIMIT) throw new Error(`The bucket has ${BUCKET_LIMIT}+ rows: page through it`);
  return bucket;
}

/**
 * Each page's Jagex URL from its `{{Update|…|url=…}}` (`link=` on older pages), by page name. Reads the wikitext, keeps
 * only the URL. Pages without one (`{{Patch Notes}}`, RuneScape's updates from before Old School) aren't news posts.
 */
async function fetchUrls(pageNames) {
  const urls = new Map();
  for (let i = 0; i < pageNames.length; i += TITLES_PER_REQUEST) {
    const titles = pageNames.slice(i, i + TITLES_PER_REQUEST);
    const { query } = await wiki({
      action: 'query',
      prop: 'revisions',
      rvprop: 'content',
      rvslots: 'main',
      titles: titles.join('|'),
    });
    for (const page of query.pages) {
      const wikitext = page.revisions?.[0]?.slots?.main?.content ?? '';
      const url = /\{\{\s*Update\s*\|[^}]*?\b(?:url|link)\s*=\s*([^|}\s]+)/i.exec(wikitext)?.[1];
      if (url) urls.set(page.title, url);
    }
    process.stdout.write(`\rRead ${Math.min(i + TITLES_PER_REQUEST, pageNames.length)}/${pageNames.length} pages`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  process.stdout.write('\n');
  return urls;
}

const slugify = (text) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/**
 * The link in the feed's form, so a post the feed stored matches: `https://secure.runescape.com/m=news/<slug>?oldschool=1`.
 * Only Old School posts: a link without `oldschool` is a RuneScape post.
 */
function normalizeLink(url) {
  // Older links put tracking segments before the slug (`/m=news/a=13/<slug>`, `/m=news/g=runescape/<slug>`)
  const path = /oldschool/.test(url) && /\/m=news\/([^?#\s]+)/.exec(url)?.[1];
  const slug =
    path &&
    path
      .split('/')
      .filter((segment) => segment && !segment.includes('='))
      .at(-1);
  return slug && `https://secure.runescape.com/m=news/${slug}?oldschool=1`;
}

/** The page name without `Update:` and without a Wiki disambiguation like ` (7 October)` that the Jagex slug lacks. */
function toTitle(pageName, link) {
  const title = pageName.replace(/^Update:/, '');
  const paren = /^(.*) \(([^)]*)\)$/.exec(title);
  return paren && !link.includes(slugify(paren[2])) ? paren[1] : title;
}

/** Jagex's category names, as the feed sends them (`Game Updates`, `Community`, `Technical`, `Future Updates`). */
const toCategory = (type) => (type === 'Game updates' ? 'Game Updates' : type.replace(/ updates$/, ''));

async function fetchFeedLinks() {
  const rss = await (await fetch(FEED_URL, { headers: { 'user-agent': USER_AGENT } })).text();
  return [...rss.matchAll(/<item>[\s\S]*?<link>([^<]+)<\/link>/g)].map((match) => match[1]);
}

const updates = await fetchUpdates();
console.log(`${updates.length} posts in the update bucket`);
const urls = await fetchUrls(updates.map((update) => update.page_name));

const byLink = new Map();
const skipped = [];
for (const { page_name, date, type } of updates) {
  const link = normalizeLink(urls.get(page_name) ?? '');
  if (!link || !date || !type) {
    skipped.push(`${page_name} (${urls.get(page_name) ?? 'no url'})`);
    continue;
  }
  // Midnight UTC, as the feed dates its posts
  const pubDate = new Date(Math.floor(date / 86_400) * 86_400_000);
  const post = { title: toTitle(page_name, link), pubDate, category: toCategory(type), link };
  byLink.set(link, [...(byLink.get(link) ?? []), post]);
}

// A link on several pages is a copy-paste slip on the Wiki, or a post Jagex reuses (Game Status Information Centre):
// keep the newest page whose title is the link's slug, if one is (the feed's upsert keeps the newest too)
const posts = new Map();
const letters = (text) => text.toLowerCase().replace(/[^a-z0-9]/g, '');
for (const [link, candidates] of byLink) {
  candidates.sort((a, b) => b.pubDate - a.pubDate);
  const slug = letters(/\/m=news\/([^?]+)/.exec(link)[1]);
  const post = candidates.length === 1 ? candidates[0] : candidates.find((c) => letters(c.title) === slug);
  if (post) posts.set(link, post);
  for (const other of candidates.filter((c) => c !== post)) skipped.push(`${other.title} (shares ${link})`);
}

const docs = [...posts.values()].sort((a, b) => b.pubDate - a.pubDate);
const categories = Object.entries(Object.groupBy(docs, (doc) => doc.category)).map(([name, list]) => [
  name,
  list.length,
]);
console.log(
  `${docs.length} posts to store, ${docs.at(-1)?.pubDate.toISOString()} to ${docs[0]?.pubDate.toISOString()}`,
);
console.log('By category:', Object.fromEntries(categories));
console.log('Newest three:', docs.slice(0, 3));
console.log(`Skipped ${skipped.length}${process.argv.includes('--verbose') ? '' : ' (--verbose lists them)'}`);
if (process.argv.includes('--verbose')) console.log(skipped.join('\n'));

const feedLinks = await fetchFeedLinks();
const missing = feedLinks.filter((link) => !posts.has(link));
console.log(`Feed posts without a Wiki post of the same link: ${missing.length}/${feedLinks.length}`, missing);

if (!write) {
  console.log('Dry run: nothing written. Add --write to store them.');
  process.exit(0);
}

const client = new MongoClient(process.env.MONGODB_URI, {
  auth: { username: process.env.MONGODB_USERNAME, password: process.env.MONGODB_PASSWORD },
});
try {
  const news = client.db(process.env.MONGODB_DATABASE).collection('news');
  const indexes = await news.listIndexes().toArray();
  if (!indexes.some((index) => index.unique && index.key.link === 1)) {
    throw new Error('No unique index on news.link: deploy the API first, it creates it');
  }

  const before = await news.countDocuments();
  const result = await news.bulkWrite(
    docs.map((doc) => ({ updateOne: { filter: { link: doc.link }, update: { $setOnInsert: doc }, upsert: true } })),
    { ordered: false },
  );
  console.log(
    `Before: ${before}. Inserted ${result.upsertedCount}, already stored ${result.matchedCount}. ` +
      `After: ${await news.countDocuments()}`,
  );
} finally {
  await client.close();
}
