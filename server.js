const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = 8080;

const MIME_TYPES = {
    '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
    '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
    '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
};

// All category slugs mapped from local IDs → Sex Porn HD URL slugs
const CATEGORY_SLUG_MAP = {
    'cat-homemade': 'homemade-anal',
    'cat-skinny': 'skinny-teen-anal',
    'cat-mom': 'mom-anal',
    'cat-teen': 'teen-anal-sex',
    'cat-bigass': 'big-ass-anal',
    'cat-three': 'threesome-anal',
    'cat-hardcore': 'hardcore-anal',
    'cat-amateur': 'amateur-anal',
    'cat-extreme': 'anal-extreme',
    'cat-mature': 'mature-anal',
    'cat-bigtits': 'big-tits-anal',
    'cat-first': 'first-anal',
    'cat-asian': 'asian-anal',
    'cat-ebony': 'ebony-anal',
    'cat-pov': 'pov-anal',
    'cat-double': 'double-anal',
    'cat-creampie': 'anal-creampie',
    'cat-vintage': 'vintage-anal',
    'cat-surprise': 'anal-surprise'
};

// Cache: TTL = 15 min for videos, 60 min for meta
const cache = {};
const VIDEO_TTL = 15 * 60 * 1000;
const META_TTL = 60 * 60 * 1000;

function fetchUrl(url) {
    return new Promise((resolve, reject) => {
        const opts = {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,*/*;q=0.9',
                'Accept-Language': 'en-US,en;q=0.5',
                'Connection': 'keep-alive'
            }
        };
        const lib = url.startsWith('https') ? https : http;
        const req = lib.get(url, opts, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                const loc = res.headers.location.startsWith('http')
                    ? res.headers.location
                    : 'https://analgalore.com' + res.headers.location;
                return fetchUrl(loc).then(resolve).catch(reject);
            }
            let data = '';
            res.on('data', c => { data += c; });
            res.on('end', () => resolve(data));
        });
        req.on('error', reject);
        req.setTimeout(12000, () => { req.destroy(); reject(new Error('Timeout')); });
    });
}

function decodeHtml(str = '') {
    return str
        .replace(/&#039;/g, "'")
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .trim();
}

// Decode the base64url-encoded MessagePack payload to extract the actual destination URL
function decodePayloadUrl(payload) {
    try {
        // base64url → standard base64
        let b64 = payload.replace(/-/g, '+').replace(/_/g, '/');
        while (b64.length % 4) b64 += '=';
        const buf = Buffer.from(b64, 'base64');
        // Simple msgpack scanner: walk the bytes looking for strings starting with 'http'
        // This avoids needing a full msgpack lib.
        for (let i = 0; i < buf.length - 4; i++) {
            let len = 0;
            let start = i + 1;
            const b = buf[i];
            // fixstr
            if (b >= 0xa0 && b <= 0xbf) { len = b - 0xa0; start = i + 1; }
            // str 8
            else if (b === 0xd9 && i + 1 < buf.length) { len = buf[i + 1]; start = i + 2; }
            // str 16
            else if (b === 0xda && i + 2 < buf.length) { len = (buf[i + 1] << 8) | buf[i + 2]; start = i + 3; }
            else continue;
            if (len < 10 || start + len > buf.length) continue;
            const s = buf.slice(start, start + len).toString('utf8');
            if (s.startsWith('http://') || s.startsWith('https://')) return s;
        }
    } catch (e) { /* ignore decode errors */ }
    return null;
}

function extractThumbFromCard(cardHtml = '') {
    const direct = cardHtml.match(/(?:src|data-src|data-original)="(https?:\/\/[^\"]*ttcache\.com\/thumbnail\/[^\"]+)"/i);
    if (direct && direct[1]) return direct[1];

    const srcset = cardHtml.match(/srcset="([^"]+)"/i);
    if (srcset && srcset[1]) {
        const first = srcset[1].split(',')[0]?.trim()?.split(/\s+/)?.[0];
        if (first && first.includes('ttcache.com/thumbnail/')) return first;
    }
    return '';
}

function parseVideoCards(html) {
    const videos = [];
    const seenPayloads = new Set();

    const cardRegex = /<a[^>]+href="([^"]*\/out\/\?[^\"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let match;
    while ((match = cardRegex.exec(html)) !== null) {
        const outLinkRaw = match[1] || '';
        const cardHtml = match[2] || '';
        const outLink = outLinkRaw.replace(/&amp;/g, '&');
        const lMatch = outLink.match(/[?&]l=([^&]+)/);
        if (!lMatch) continue;
        const payload = lMatch[1];
        if (seenPayloads.has(payload)) continue;

        const thumb = extractThumbFromCard(cardHtml);
        if (!thumb) continue;

        const alt = cardHtml.match(/<img[^>]+alt="([^"]+)"/i)?.[1] || '';
        const titleAttr = outLinkRaw.match(/title="([^"]+)"/i)?.[1] || '';
        const rawTitle = alt || titleAttr || cardHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        const cleanTitle = decodeHtml(rawTitle).slice(0, 180) || 'Untitled';
        const duration = cardHtml.match(/\b(\d{1,2}:\d{2}(?::\d{2})?)\b/)?.[1] || '';

        const thumbId = thumb.match(/thumbnail\/([^/]+)\//)?.[1] || '';
        seenPayloads.add(payload);
        const resolvedUrl = decodePayloadUrl(payload);
        videos.push({
            id: thumbId || `v-${videos.length}`,
            title: cleanTitle,
            img: thumb,
            duration,
            rating: Math.floor(Math.random() * 10 + 88),
            payload,
            url: resolvedUrl || null
        });
    }

    // Fallback: some pages omit full card blocks but still contain out links + thumb URLs.
    if (videos.length === 0) {
        const links = [...html.matchAll(/href="([^"]*\/out\/\?[^\"]+)"/gi)].map(m => (m[1] || '').replace(/&amp;/g, '&'));
        const thumbs = [...html.matchAll(/(https?:\/\/[^\"']*ttcache\.com\/thumbnail\/[^\"']+)/gi)].map(m => m[1]);
        const limit = Math.min(links.length, thumbs.length, 120);
        for (let i = 0; i < limit; i++) {
            const lMatch = links[i].match(/[?&]l=([^&]+)/);
            if (!lMatch) continue;
            const payload = lMatch[1];
            if (seenPayloads.has(payload)) continue;
            const thumb = thumbs[i];
            const thumbId = thumb.match(/thumbnail\/([^/]+)\//)?.[1] || '';
            seenPayloads.add(payload);
            const resolvedUrl = decodePayloadUrl(payload);
            videos.push({
                id: thumbId || `v-${videos.length}`,
                title: `Video ${videos.length + 1}`,
                img: thumb,
                duration: '',
                rating: Math.floor(Math.random() * 10 + 88),
                payload,
                url: resolvedUrl || null
            });
        }
    }

    return videos;
}

async function cached(key, ttl, fn) {
    if (cache[key] && Date.now() - cache[key].ts < ttl) {
        console.log(`[CACHE] ${key}`);
        return cache[key].data;
    }
    const data = await fn();
    const shouldCache = !(data == null || (Array.isArray(data) && data.length === 0));
    if (shouldCache) cache[key] = { ts: Date.now(), data };
    return data;
}

// ── Scrapers ──────────────────────────────────────────────────────────────────

async function fetchCategoryVideos(catId, page = 1) {
    const slug = CATEGORY_SLUG_MAP[catId];
    if (!slug) throw new Error(`Unknown category: ${catId}`);
    const url = page > 1
        ? `https://analgalore.com/category/${slug}/page/${page}`
        : `https://analgalore.com/category/${slug}`;
    return cached(`cat:${catId}:${page}`, VIDEO_TTL, async () => {
        console.log(`[Fetch] ${url}`);
        const html = await fetchUrl(url);
        const videos = parseVideoCards(html);
        console.log(`[Parsed] ${videos.length} from ${url}`);
        return videos;
    });
}

async function fetchSlugVideos(slug, page = 1) {
    const url = page > 1
        ? `https://analgalore.com/category/${slug}/page/${page}`
        : `https://analgalore.com/category/${slug}`;
    return cached(`slug:${slug}:${page}`, VIDEO_TTL, async () => {
        console.log(`[Fetch slug] ${url}`);
        const html = await fetchUrl(url);
        const videos = parseVideoCards(html);
        console.log(`[Parsed] ${videos.length} from ${url}`);
        return videos;
    });
}

async function fetchListingVideos(sort = 'popular', page = 1) {
    const p = sort === 'new' ? '/new' : sort === 'rating' ? '/rating' : '/popular';
    const url = page > 1 ? `https://analgalore.com${p}/page/${page}` : `https://analgalore.com${p}`;
    return cached(`listing:${sort}:${page}`, VIDEO_TTL, async () => {
        console.log(`[Fetch listing] ${url}`);
        const html = await fetchUrl(url);
        return parseVideoCards(html);
    });
}

async function fetchSearchVideos(q, page = 1) {
    const url = `https://analgalore.com/search?q=${encodeURIComponent(q)}&p=${page}`;
    return cached(`search:${q}:${page}`, VIDEO_TTL, async () => {
        console.log(`[Fetch search] ${url}`);
        try { return parseVideoCards(await fetchUrl(url)); } catch { return []; }
    });
}

async function fetchPornstarVideos(slug, page = 1) {
    const url = page > 1
        ? `https://analgalore.com/pornstar/${slug}/page/${page}`
        : `https://analgalore.com/pornstar/${slug}`;
    return cached(`pornstar:${slug}:${page}`, VIDEO_TTL, async () => {
        console.log(`[Fetch pornstar] ${url}`);
        try { return parseVideoCards(await fetchUrl(url)); } catch { return []; }
    });
}

// Meta: full category list + counts from the A-Z page
async function fetchAllCategories() {
    return cached('meta:categories', META_TTL, async () => {
        console.log('[Fetch] categories meta from /a-z');
        const html = await fetchUrl('https://analgalore.com/a-z');
        const cats = [];
        const seen = new Set();
        const re = /<a[^>]+href="\/category\/([^"]+)"[^>]*>([\s\S]{0,300}?)<\/a>/g;
        let m;
        while ((m = re.exec(html)) !== null) {
            const slug = m[1];
            if (seen.has(slug)) continue;
            seen.add(slug);
            const raw = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
            // Extract trailing count like "1.21M" or "3.9K"
            const countMatch = raw.match(/([\d.,]+[KkMmBb]?)\s*$/);
            const count = countMatch ? countMatch[1] : '';
            const title = raw.replace(count, '').trim();
            if (title && title.length < 80) {
                cats.push({ slug, title, count });
            }
        }
        console.log(`[Meta] ${cats.length} categories`);
        return cats;
    });
}

// Meta: pornstar list from the homepage featured section
async function fetchPornstars() {
    return cached('meta:pornstars', META_TTL, async () => {
        console.log('[Fetch] pornstars from homepage');
        const html = await fetchUrl('https://analgalore.com');
        const seen = new Set();
        const list = [];
        const re = /href="\/pornstar\/([^"]+)"/g;
        let m;
        while ((m = re.exec(html)) !== null) {
            const slug = m[1];
            if (seen.has(slug) || slug === 'a' || slug.length < 3) continue;
            seen.add(slug);
            const name = slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
            list.push({ slug, name });
        }
        // Dedupe properly and keep display names
        const displayed = list.slice(0, 8); // featured
        const alphabetical = list.slice(8);
        return { featured: displayed, all: list };
    });
}

// Batch thumbnail endpoint: first video thumb for each known category
async function fetchBatchThumbs() {
    return cached('meta:thumbs', META_TTL, async () => {
        const results = {};
        await Promise.all(Object.keys(CATEGORY_SLUG_MAP).map(async catId => {
            try {
                const videos = await fetchCategoryVideos(catId, 1);
                if (videos.length > 0) {
                    results[catId] = { img: videos[0].img, payload: videos[0].payload, title: videos[0].title };
                }
            } catch { }
        }));
        return results;
    });
}

async function fetchThumbBySlug(slug) {
    const key = `thumb:${slug}`;
    if (cache[key] && Date.now() - cache[key].ts < VIDEO_TTL) {
        return cache[key].data;
    }

    const videos = await fetchSlugVideos(slug, 1);
    if (!videos || videos.length === 0) {
        delete cache[key];
        return null;
    }

    const data = { img: videos[0].img, payload: videos[0].payload, title: videos[0].title };
    cache[key] = { ts: Date.now(), data };
    return data;
}

// ── HTTP Server ───────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const path_ = url.pathname;

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET');

    const json = (data) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
    };
    const err = (msg, code = 500) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: msg, videos: [] }));
    };

    try {
        // ── /api/category?id=cat-amateur&page=1
        if (path_ === '/api/category') {
            const catId = url.searchParams.get('id') || 'cat-amateur';
            const page = parseInt(url.searchParams.get('page') || '1');
            const videos = await fetchCategoryVideos(catId, page);
            return json({ videos, count: videos.length });
        }

        // ── /api/slug?slug=homemade-anal&page=1  (any raw Sex Porn HD slug)
        if (path_ === '/api/slug') {
            const slug = url.searchParams.get('slug') || 'amateur-anal';
            const page = parseInt(url.searchParams.get('page') || '1');
            const videos = await fetchSlugVideos(slug, page);
            return json({ videos, count: videos.length });
        }

        // ── /api/listing?sort=popular&page=1
        if (path_ === '/api/listing') {
            const sort = url.searchParams.get('sort') || 'popular';
            const page = parseInt(url.searchParams.get('page') || '1');
            const videos = await fetchListingVideos(sort, page);
            return json({ videos, count: videos.length });
        }

        // ── /api/search?q=milf&page=1
        if (path_ === '/api/search') {
            const q = url.searchParams.get('q') || 'anal';
            const page = parseInt(url.searchParams.get('page') || '1');
            const videos = await fetchSearchVideos(q, page);
            return json({ videos, count: videos.length });
        }

        // ── /api/pornstar?slug=gabbie-carter&page=1
        if (path_ === '/api/pornstar') {
            const slug = url.searchParams.get('slug') || 'gabbie-carter';
            const page = parseInt(url.searchParams.get('page') || '1');
            const videos = await fetchPornstarVideos(slug, page);
            return json({ videos, count: videos.length });
        }

        // ── /api/categories  (full list with counts for category grid)
        if (path_ === '/api/categories') {
            const cats = await fetchAllCategories();
            return json(cats);
        }

        // ── /api/pornstars  (featured + full list)
        if (path_ === '/api/pornstars') {
            const data = await fetchPornstars();
            return json(data);
        }

        // ── /api/thumbs  (batch: one thumbnail per known category)
        if (path_ === '/api/thumbs') {
            const data = await fetchBatchThumbs();
            return json(data);
        }

        // ── /api/thumb?slug=SLUG  (single live thumbnail for any category slug)
        if (path_ === '/api/thumb') {
            const raw = (url.searchParams.get('slug') || '').trim();
            if (!raw) return err('Missing slug', 400);
            const slug = CATEGORY_SLUG_MAP[raw] || raw;
            const data = await fetchThumbBySlug(slug);
            return json(data || {});
        }

    } catch (e) {
        console.error('[API Error]', e.message);
        return err(e.message);
    }

    // ── Static file serving ──────────────────────────────────────────────────
    let filePath = path_ === '/' ? '/index.html' : path_;
    filePath = path.normalize(path.join(__dirname, filePath));
    if (!filePath.startsWith(__dirname)) { res.writeHead(403); res.end('Forbidden'); return; }

    fs.readFile(filePath, (e2, data) => {
        if (e2) { res.writeHead(404); res.end('Not Found'); return; }
        const ext = path.extname(filePath);
        const mime = MIME_TYPES[ext] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': mime });
        res.end(data);
    });
});

server.listen(PORT, () => {
    console.log(`✅ Sex Porn HD Scraper Server  →  http://localhost:${PORT}`);
    console.log('   Endpoints:');
    console.log('   /api/listing?sort=popular|new|rating&page=N');
    console.log('   /api/category?id=cat-XXX&page=N');
    console.log('   /api/slug?slug=SLUG&page=N');
    console.log('   /api/search?q=QUERY&page=N');
    console.log('   /api/pornstar?slug=SLUG&page=N');
    console.log('   /api/categories    → full category list');
    console.log('   /api/pornstars     → pornstar list');
    console.log('   /api/thumbs        → batch category thumbnails');
    console.log('   /api/thumb?slug=SLUG → single live category thumbnail');
});
