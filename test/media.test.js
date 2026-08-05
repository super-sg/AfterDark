'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-not-used-in-production';

const { isPrivateAddress, assertPublicUrl, parseVideo, parseMetaTags } = require('../src/media');
const { proxyUrl, sign, verify, PRESETS } = require('../src/imageproxy');

/**
 * A user-supplied link is an instruction to make an outbound request from
 * inside our network. Everything below is the reason that is safe.
 */

test('every private and reserved range is rejected', () => {
  const priv = [
    '127.0.0.1', '127.1.2.3', '0.0.0.0', '10.0.0.1', '10.255.255.255',
    '172.16.0.1', '172.31.255.254', '192.168.1.1', '192.0.0.1',
    '169.254.169.254', // AWS/GCP metadata — the classic SSRF target
    '100.64.0.1', '198.18.0.1', '224.0.0.1', '255.255.255.255',
    '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', '::ffff:127.0.0.1',
  ];
  for (const ip of priv) {
    assert.equal(isPrivateAddress(ip), true, `${ip} should be private`);
  }
});

test('ordinary public addresses are allowed', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '192.169.0.1', '2606:4700::1111']) {
    assert.equal(isPrivateAddress(ip), false, `${ip} should be public`);
  }
});

test('unparseable input is refused rather than assumed safe', () => {
  for (const junk of ['', 'not-an-ip', '999.999.999.999', '0x7f000001']) {
    assert.equal(isPrivateAddress(junk), true, `${junk} should be refused`);
  }
});

test('assertPublicUrl blocks localhost, private literals and odd schemes', async () => {
  const blocked = [
    'http://127.0.0.1/admin',
    'http://localhost:8080/',
    'http://169.254.169.254/latest/meta-data/',
    'http://10.0.0.5/',
    'http://[::1]/',
    'http://printer.local/',
    'file:///etc/passwd',
    'gopher://example.com/',
    'javascript:alert(1)',
    'http://user:pass@example.com/',
    'not a url at all',
  ];
  for (const url of blocked) {
    await assert.rejects(() => assertPublicUrl(url), `${url} should be rejected`);
  }
});

test('assertPublicUrl allows an ordinary public https URL', async () => {
  const url = await assertPublicUrl('https://example.com/story?a=1');
  assert.equal(url.hostname, 'example.com');
});

// ---------------------------------------------------------------------------

test('video URLs are recognised across their many shapes', () => {
  const cases = [
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'youtube', 'dQw4w9WgXcQ'],
    ['https://youtube.com/watch?v=dQw4w9WgXcQ&t=42', 'youtube', 'dQw4w9WgXcQ'],
    ['https://youtu.be/dQw4w9WgXcQ', 'youtube', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/shorts/abc123XYZ_-', 'youtube', 'abc123XYZ_-'],
    ['https://www.youtube.com/embed/dQw4w9WgXcQ', 'youtube', 'dQw4w9WgXcQ'],
    ['https://vimeo.com/123456789', 'vimeo', '123456789'],
    ['https://player.vimeo.com/video/123456789', 'vimeo', '123456789'],
  ];
  for (const [url, kind, id] of cases) {
    const v = parseVideo(url);
    assert.ok(v, `${url} should parse`);
    assert.equal(v.kind, kind);
    assert.equal(v.id, id);
  }
});

test('non-video links and junk return null', () => {
  for (const url of ['https://xbiz.com/news/1', 'https://example.com/watch?v=', 'nonsense', '']) {
    assert.equal(parseVideo(url), null, `${url} should not be a video`);
  }
});

test('youtube embeds use the no-cookie host', () => {
  const v = parseVideo('https://youtu.be/dQw4w9WgXcQ');
  assert.match(v.embedUrl, /youtube-nocookie\.com/);
  assert.match(v.poster, /i\.ytimg\.com/);
});

// ---------------------------------------------------------------------------

test('meta tags are extracted from property, name and itemprop', () => {
  const html = `<html><head>
    <meta property="og:title" content="A headline">
    <meta name="twitter:image" content="https://cdn.example.com/a.jpg">
    <meta property="og:image:width" content="1200">
    <meta name="description" content="Body &amp; more">
    <title>Fallback</title>
  </head><body><meta property="og:title" content="should not win"></body></html>`;

  const meta = parseMetaTags(html);
  assert.equal(meta.get('og:title'), 'A headline');
  assert.equal(meta.get('twitter:image'), 'https://cdn.example.com/a.jpg');
  assert.equal(meta.get('og:image:width'), '1200');
  assert.equal(meta.get('description'), 'Body & more');
});

test('meta parsing survives malformed markup', () => {
  assert.doesNotThrow(() => parseMetaTags('<meta content="orphan">'));
  assert.doesNotThrow(() => parseMetaTags(''));
  assert.doesNotThrow(() => parseMetaTags('<html><head><meta'));
});

// ---------------------------------------------------------------------------

test('proxy URLs are signed, and a tampered signature does not verify', () => {
  const remote = 'https://cdn.example.com/hero.jpg';
  const url = proxyUrl(remote, 'card');

  assert.match(url, /^\/i\/card\//);
  assert.ok(url.includes(encodeURIComponent(remote)));

  const signature = url.split('/')[3].split('?')[0];
  assert.equal(verify(remote, 'card', signature), true);

  // Wrong signature, wrong preset and wrong URL must all fail.
  assert.equal(verify(remote, 'card', 'AAAAAAAAAAAAAAAAAAAAAA'), false);
  assert.equal(verify(remote, 'thumb', signature), false);
  assert.equal(verify('https://cdn.example.com/other.jpg', 'card', signature), false);
});

test('a signature for one preset cannot be replayed against another', () => {
  const remote = 'https://cdn.example.com/hero.jpg';
  for (const preset of Object.keys(PRESETS)) {
    const own = sign(remote, preset);
    for (const other of Object.keys(PRESETS)) {
      assert.equal(verify(remote, other, own), preset === other,
        `${preset} signature should only verify for ${preset}`);
    }
  }
});

test('proxyUrl refuses unknown presets and non-http URLs', () => {
  assert.equal(proxyUrl('https://cdn.example.com/a.jpg', 'nope'), '');
  assert.equal(proxyUrl('data:image/png;base64,AAAA', 'card'), '');
  assert.equal(proxyUrl('javascript:alert(1)', 'card'), '');
  assert.equal(proxyUrl('', 'card'), '');
});
