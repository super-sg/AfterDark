'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-not-used-in-production';
process.env.DB_PATH = process.env.DB_PATH || '/tmp/afterdark-wire-test.db';

const { parse, isAllowed } = require('../src/robots');
const { properNouns } = require('../src/topics');

// ---------------------------------------------------------------------------
// robots.txt
// ---------------------------------------------------------------------------

const ROBOTS = `
# comment line
User-agent: *
Disallow: /private/
Disallow: /tmp
Allow: /private/public-bit
Crawl-delay: 5

User-agent: BadBot
Disallow: /

User-agent: AfterDarkWire
Disallow: /admin/
`;

test('the catch-all group applies to an unknown agent', () => {
  const { rules, crawlDelay } = parse(ROBOTS, 'SomeOtherBot/1.0');
  assert.equal(crawlDelay, 5);
  assert.equal(isAllowed(rules, '/news/story-1'), true);
  assert.equal(isAllowed(rules, '/private/secret'), false);
  assert.equal(isAllowed(rules, '/tmp/anything'), false);
});

test('a longer Allow beats a shorter Disallow', () => {
  const { rules } = parse(ROBOTS, 'SomeOtherBot/1.0');
  assert.equal(isAllowed(rules, '/private/public-bit/ok'), true);
});

test('a named group wins over the catch-all', () => {
  const { rules } = parse(ROBOTS, 'AfterDarkWire/2.0 (+https://example.com)');
  // Our own group only bans /admin/, so /private/ is fair game for us.
  assert.equal(isAllowed(rules, '/private/secret'), true);
  assert.equal(isAllowed(rules, '/admin/panel'), false);
});

test('a total ban on another agent does not leak to us', () => {
  const { rules } = parse(ROBOTS, 'AfterDarkWire/2.0');
  assert.equal(isAllowed(rules, '/'), true);
});

test('wildcards and end-anchors are honoured', () => {
  const { rules } = parse('User-agent: *\nDisallow: /*.pdf$\nDisallow: /a/*/b\n', '*');
  assert.equal(isAllowed(rules, '/reports/annual.pdf'), false);
  assert.equal(isAllowed(rules, '/reports/annual.pdf?v=2'), true, '$ anchors to end of path');
  assert.equal(isAllowed(rules, '/a/anything/b'), false);
  assert.equal(isAllowed(rules, '/a/anything/c'), true);
});

test('an empty Disallow means allow everything', () => {
  const { rules } = parse('User-agent: *\nDisallow:\n', '*');
  assert.equal(isAllowed(rules, '/anything'), true);
});

test('an empty or malformed robots.txt allows everything', () => {
  for (const body of ['', '\n\n', 'garbage without colons', '# only a comment']) {
    const { rules } = parse(body, '*');
    assert.equal(isAllowed(rules, '/anything'), true);
  }
});

test('consecutive User-agent lines share one rule block', () => {
  const body = 'User-agent: A\nUser-agent: B\nDisallow: /shared\n';
  assert.equal(isAllowed(parse(body, 'A').rules, '/shared'), false);
  assert.equal(isAllowed(parse(body, 'B').rules, '/shared'), false);
});

// ---------------------------------------------------------------------------
// Topic extraction
//
// The failure mode worth pinning down is not "misses a name" — it is inventing
// one. A wrong topic becomes a page, a filter and a trend nobody meant.
// ---------------------------------------------------------------------------

test('sentence-case headlines yield their subjects', () => {
  assert.deepEqual(
    properNouns('Aylo restores Pornhub access in Arizona after court ruling').sort(),
    ['Arizona', 'Pornhub']
  );
  assert.deepEqual(properNouns('HBO Max is doing clipping'), ['HBO Max']);
  assert.ok(properNouns('Sony Music sues Kink.com over unlicensed tracks').includes('Sony Music'));
});

test('title-case headlines do not invent subjects out of ordinary words', () => {
  // Every word is capitalised here, so capitalisation carries no signal at all.
  const found = properNouns('West Virginia Age Verification Law Takes Effect June 12');
  for (const bogus of ['Verification Law Takes', 'Law Takes Effect', 'Takes Effect June']) {
    assert.ok(!found.includes(bogus), `should not extract "${bogus}"`);
  }
});

test('shouted acronyms survive a title-case headline', () => {
  assert.ok(properNouns('Senate Passes The TAKE IT DOWN Act Unanimously').some((t) => t.includes('TAKE IT DOWN')));
  assert.ok(properNouns('BLEACH Anime Announces Additional Cast, Ending Theme').includes('BLEACH'));
});

test('headline furniture never becomes a topic', () => {
  const junk = ['Additional Cast', 'Ending Theme', 'Anime Announced', 'Main Visual', 'Second Season'];
  for (const headline of ['Anime Announces Additional Cast And Ending Theme Details',
    'Series Reveals Main Visual For Second Season']) {
    const found = properNouns(headline);
    for (const bad of junk) assert.ok(!found.includes(bad), `"${bad}" should not survive`);
  }
});

test('bare years and volume numbers are not subjects', () => {
  for (const headline of ['Report says 2027 will be different', 'Volume 12 arrives in 2026']) {
    for (const topic of properNouns(headline)) {
      assert.ok(/[A-Za-z]{2}/.test(topic), `"${topic}" is not a subject`);
    }
  }
});

test('the extractor never throws on junk input', () => {
  for (const junk of ['', null, undefined, '!!!', '12345', 'a'.repeat(500), '🔥🔥🔥']) {
    assert.doesNotThrow(() => properNouns(junk));
    assert.ok(Array.isArray(properNouns(junk)));
  }
});

// ---------------------------------------------------------------------------
// Relevance filtering
//
// Several sources are general publications that cover this subject among many
// others. Filing them wholesale onto a topical board is how a road-accident
// report ends up on the JAV desk.
// ---------------------------------------------------------------------------

const { isRelevant } = require('../src/wire');

const item = (title, summary = '', tags = []) => ({ title, summary, tags });

test('a source with no filter accepts everything', () => {
  assert.equal(isRelevant({}, item('Anything at all')), true);
  assert.equal(isRelevant({ filter: [] }, item('Anything at all')), true);
});

test('a filtered source only accepts items that touch its terms', () => {
  const source = { filter: ['adult video', 'porn', 'jav'] };
  assert.equal(isRelevant(source, item('AV actress speaks out on adult video contracts')), true);
  assert.equal(isRelevant(source, item('New JAV label launches')), true);
  assert.equal(isRelevant(source, item('Mall worker dies in Kumamoto explosion')), false);
  assert.equal(isRelevant(source, item('Train delays hit the Yamanote line')), false);
});

test('the filter reads the summary and tags, not just the headline', () => {
  const source = { filter: ['hentai'] };
  assert.equal(isRelevant(source, item('Studio announces new OVA', 'A hentai release scheduled for spring.')), true);
  assert.equal(isRelevant(source, item('Studio announces new OVA', '', ['Hentai'])), true);
  assert.equal(isRelevant(source, item('Studio announces new OVA', 'A shonen release.')), false);
});

test('matching is case-insensitive', () => {
  assert.equal(isRelevant({ filter: ['PORN'] }, item('porn studio signs deal')), true);
  assert.equal(isRelevant({ filter: ['porn'] }, item('PORN STUDIO SIGNS DEAL')), true);
});
