'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseFeed, parseJson, parseDuration, normaliseTags, pluckList } = require('../src/feedparse');

// ---------------------------------------------------------------------------
// RSS / Atom
// ---------------------------------------------------------------------------

const RSS = `<?xml version="1.0"?>
<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/" xmlns:content="http://purl.org/rss/1.0/modules/content/">
<channel>
  <item>
    <title><![CDATA[Studio signs distribution deal]]></title>
    <link>https://example.com/story/1</link>
    <guid>story-1</guid>
    <pubDate>Wed, 04 Jun 2025 10:30:00 +0000</pubDate>
    <description>A short summary &amp; nothing more.</description>
    <category>Business</category>
    <category>Distribution</category>
    <media:content url="https://cdn.example.com/big.jpg" type="image/jpeg" medium="image" width="1200" height="630"/>
  </item>
  <item>
    <title>Thumbnail only</title>
    <link>https://example.com/story/2</link>
    <media:thumbnail url="https://cdn.example.com/thumb.jpg" width="400" height="300"/>
  </item>
  <item>
    <title>Enclosure fallback</title>
    <link>https://example.com/story/3</link>
    <enclosure url="https://cdn.example.com/encl.png" type="image/png" length="12345"/>
  </item>
  <item>
    <title>Body image fallback</title>
    <link>https://example.com/story/4</link>
    <content:encoded><![CDATA[
      <p><img src="https://cdn.example.com/pixel.gif" width="1" height="1" alt=""/></p>
      <p><img src="https://cdn.example.com/real.jpg" width="900" height="500" alt="The actual art"/></p>
    ]]></content:encoded>
  </item>
</channel></rss>`;

test('RSS items are parsed with title, link, guid and date', () => {
  const items = parseFeed(RSS);
  assert.equal(items.length, 4);
  assert.equal(items[0].title, 'Studio signs distribution deal');
  assert.equal(items[0].link, 'https://example.com/story/1');
  assert.equal(items[0].guid, 'story-1');
  assert.equal(items[0].summary, 'A short summary & nothing more.');
  assert.equal(items[0].publishedAt, Date.parse('Wed, 04 Jun 2025 10:30:00 +0000'));
});

test('media:content is preferred, with its declared dimensions', () => {
  const [first] = parseFeed(RSS);
  assert.equal(first.image, 'https://cdn.example.com/big.jpg');
  assert.equal(first.imageW, 1200);
  assert.equal(first.imageH, 630);
});

test('thumbnail and enclosure are used when no media:content exists', () => {
  const items = parseFeed(RSS);
  assert.equal(items[1].image, 'https://cdn.example.com/thumb.jpg');
  assert.equal(items[2].image, 'https://cdn.example.com/encl.png');
});

/**
 * The body-scrape fallback is where a naive reader picks up tracking pixels and
 * share buttons instead of the article art, so the size floor is load-bearing.
 */
test('a body image wins only if it is big enough to be real art', () => {
  const [, , , fourth] = parseFeed(RSS);
  assert.equal(fourth.image, 'https://cdn.example.com/real.jpg');
  assert.equal(fourth.imageAlt, 'The actual art');
});

test('categories become tags, deduped and denoised', () => {
  const [first] = parseFeed(RSS);
  assert.deepEqual(first.tags, ['Business', 'Distribution']);
});

test('Atom entries parse as well as RSS items', () => {
  const atom = `<feed xmlns="http://www.w3.org/2005/Atom">
    <entry>
      <title>An Atom entry</title>
      <link rel="alternate" href="https://example.com/atom/1"/>
      <id>urn:uuid:1</id>
      <published>2025-06-04T10:30:00Z</published>
      <summary>Body text.</summary>
      <category term="Policy"/>
    </entry>
  </feed>`;
  const [item] = parseFeed(atom);
  assert.equal(item.title, 'An Atom entry');
  assert.equal(item.link, 'https://example.com/atom/1');
  assert.equal(item.guid, 'urn:uuid:1');
  assert.deepEqual(item.tags, ['Policy']);
});

test('malformed feeds yield nothing rather than throwing', () => {
  for (const junk of ['', '<rss>', 'not xml at all', '<item><title>unclosed']) {
    assert.doesNotThrow(() => parseFeed(junk));
  }
});

test('an item with no link is still parsed, and ingest can drop it', () => {
  const [item] = parseFeed('<rss><item><title>Orphan</title></item></rss>');
  assert.equal(item.title, 'Orphan');
  assert.equal(item.link, '');
});

// ---------------------------------------------------------------------------
// Durations
// ---------------------------------------------------------------------------

test('every duration format seen in the wild parses', () => {
  assert.equal(parseDuration('754'), 754);
  assert.equal(parseDuration('12:34'), 754);
  assert.equal(parseDuration('1:02:03'), 3723);
  assert.equal(parseDuration('PT1H2M3S'), 3723);
  assert.equal(parseDuration('PT22M'), 1320);
  assert.equal(parseDuration('PT45S'), 45);
  assert.equal(parseDuration(''), 0);
  assert.equal(parseDuration(null), 0);
  assert.equal(parseDuration('nonsense'), 0);
});

// ---------------------------------------------------------------------------
// JSON adapter
// ---------------------------------------------------------------------------

test('a JSON API maps into the same item shape as a feed', () => {
  const payload = {
    count: 2,
    videos: [
      {
        id: 'abc123',
        title: 'A scene title',
        url: 'https://example.com/video/abc123',
        views: '48210',
        length_sec: 1284,
        added: '2025-06-04 10:30:00',
        keywords: 'one, two, three',
        default_thumb: { src: 'https://cdn.example.com/t.jpg', width: 640, height: 360 },
      },
      { id: 'no-link', title: 'Dropped', url: '' },
    ],
  };

  const items = parseJson(payload, {
    itemsPath: 'videos',
    map: {
      guid: 'id', title: 'title', link: 'url', views: 'views', duration: 'length_sec',
      publishedAt: 'added', tags: 'keywords',
      image: 'default_thumb.src', imageW: 'default_thumb.width', imageH: 'default_thumb.height',
    },
  });

  // The second entry has no usable link and must not become a post.
  assert.equal(items.length, 1);
  const [item] = items;
  assert.equal(item.guid, 'abc123');
  assert.equal(item.link, 'https://example.com/video/abc123');
  assert.equal(item.image, 'https://cdn.example.com/t.jpg');
  assert.equal(item.imageW, 640);
  assert.equal(item.duration, 1284);
  assert.equal(item.views, 48210);
  assert.deepEqual(item.tags, ['one', 'two', 'three']);
});

test('array projection pulls a field out of each element', () => {
  const raw = { tags: [{ tag_name: 'alpha' }, { tag_name: 'beta' }] };
  assert.deepEqual(pluckList(raw, 'tags[].tag_name'), ['alpha', 'beta']);
});

test('nested item paths work for APIs that wrap each row', () => {
  const payload = { videos: [{ video: { video_id: '7', title: 'Wrapped', url: 'https://e.com/7', duration: '10:00' } }] };
  const [item] = parseJson(payload, {
    itemsPath: 'videos',
    map: { guid: 'video.video_id', title: 'video.title', link: 'video.url', duration: 'video.duration' },
  });
  assert.equal(item.guid, '7');
  assert.equal(item.duration, 600);
});

test('a JSON shape that does not match the map degrades to zero items, not a crash', () => {
  for (const payload of [{}, [], null, { videos: 'not an array' }, { error: 'forbidden' }]) {
    assert.doesNotThrow(() => parseJson(payload, { itemsPath: 'videos', map: { title: 'title', link: 'url' } }));
    assert.deepEqual(parseJson(payload, { itemsPath: 'videos', map: { title: 'title', link: 'url' } }), []);
  }
});

test('seconds-vs-milliseconds timestamps are told apart', () => {
  const asSeconds = parseJson({ v: [{ t: 'x', u: 'https://e.com/1', d: 1749033000 }] },
    { itemsPath: 'v', map: { title: 't', link: 'u', publishedAt: 'd' } })[0];
  assert.equal(asSeconds.publishedAt, 1749033000 * 1000);

  const asMillis = parseJson({ v: [{ t: 'x', u: 'https://e.com/1', d: 1749033000000 }] },
    { itemsPath: 'v', map: { title: 't', link: 'u', publishedAt: 'd' } })[0];
  assert.equal(asMillis.publishedAt, 1749033000000);
});

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

test('tag noise is stripped and the list is capped', () => {
  const out = normaliseTags(['Porn', 'HD', 'Business', 'business', ' Policy ', 'x', 'a'.repeat(60),
    'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight']);
  assert.ok(!out.includes('Porn'), 'generic adult words are not topics');
  assert.ok(!out.includes('HD'));
  assert.equal(out.filter((t) => t.toLowerCase() === 'business').length, 1, 'case-insensitive dedupe');
  assert.ok(out.includes('Policy'), 'surrounding whitespace is trimmed');
  assert.ok(out.length <= 8);
});
