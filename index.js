const express = require('express');
const cors = require('cors');
const axios = require('axios');
const AdmZip = require('adm-zip');
const iconv = require('iconv-lite');

const app = express();
app.use(cors());

// The SubDL API key is read from the environment (set SUBDL_API_KEY on Render). Never hardcode it.
const SUBDL_API_KEY = process.env.SUBDL_API_KEY || '';

const manifest = {
    id: 'org.moody.arabicsync',
    version: '1.0.1',
    name: 'Arabic Auto-Sync Subtitles',
    description: 'مزامنة تلقائية للترجمة العربية مع نسخة الفيديو',
    resources: ['subtitles'],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    catalogs: []
};

const LABEL = 'Arabic [Auto-Synced]';
const MAX_CANDIDATES = 3;          // how many AR / EN files to try before giving up
const CACHE_MAX = 300;             // simple bound so the free instance doesn't run out of memory
const syncedCache = new Map();

function cacheSet(key, value) {
    if (syncedCache.has(key)) syncedCache.delete(key);
    syncedCache.set(key, value);
    while (syncedCache.size > CACHE_MAX) syncedCache.delete(syncedCache.keys().next().value);
}

// ---------- time helpers ----------
function timeToMs(t) {
    const p = t.trim().replace(',', '.').split(':');
    return Math.round((parseInt(p[0], 10) * 3600 + parseInt(p[1], 10) * 60 + parseFloat(p[2])) * 1000);
}

function msToTime(ms) {
    ms = Math.max(0, Math.round(ms));
    const h = String(Math.floor(ms / 3600000)).padStart(2, '0');
    const m = String(Math.floor((ms % 3600000) / 60000)).padStart(2, '0');
    const s = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0');
    const mill = String(ms % 1000).padStart(3, '0');
    return `${h}:${m}:${s},${mill}`;
}

const CREDIT_RE = /ترجم|تعديل|مزامنة|sync|subtitle|www\.|http|@|حقوق|opensubtitles|subdl/i;

// Collect start times (ms) of real dialogue cues (skips translator credits / ads)
function cueStarts(srtText) {
    const blocks = srtText.replace(/\r/g, '').split(/\n\s*\n/);
    const tsRe = /(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})/;
    const out = [];
    for (const block of blocks) {
        const m = block.match(tsRe);
        if (!m) continue;
        const text = block.slice(block.indexOf(m[0]) + m[0].length).trim();
        if (!text) continue;
        if (CREDIT_RE.test(text)) continue;
        out.push(timeToMs(m[1]));
    }
    return out.sort((a, b) => a - b);
}

// Most-voted offset (en - ar) between a set of Arabic cue starts and all English cue starts
function votedOffset(arTimes, enTimes, maxShift = 600000, bin = 100) {
    const votes = new Map();
    let j0 = 0;
    for (const a of arTimes) {
        while (j0 < enTimes.length && enTimes[j0] < a - maxShift) j0++;
        for (let j = j0; j < enTimes.length && enTimes[j] <= a + maxShift; j++) {
            const k = Math.round((enTimes[j] - a) / bin);
            votes.set(k, (votes.get(k) || 0) + 1);
        }
    }
    let bestK = null, bestV = -1;
    for (const [k, v] of votes) {
        const v3 = v + (votes.get(k - 1) || 0) + (votes.get(k + 1) || 0);
        if (v3 > bestV) { bestV = v3; bestK = k; }
    }
    if (bestK === null) return null;
    return { offset: bestK * bin, votes: bestV };
}

// Re-time the Arabic file so it matches the English one.
// Finds the best offset at the start and at the end of the film (by matching cue start times),
// which gives both a constant shift and a speed (fps) correction.
function syncArabicToEnglish(arSrt, enSrt) {
    const ar = cueStarts(arSrt);
    const en = cueStarts(enSrt);
    if (ar.length < 20 || en.length < 20) return arSrt;

    // Try the common frame-rate conversions (23.976 / 24 / 25 / 29.97 fps) and keep the best one
    const FPS = [23.976, 24, 25, 29.97];
    const scales = [1];
    for (const x of FPS) for (const y of FPS) if (x !== y && Math.abs(x / y - 1) < 0.1) scales.push(x / y);
    let best = null;
    for (const sc of scales) {
        const v = votedOffset(ar.map(t => t * sc), en);
        if (v && (!best || v.votes > best.votes * 1.05)) best = { scale: sc, offset: v.offset, votes: v.votes };
    }
    if (!best) return arSrt;
    const { scale, offset } = best;
    const minVotes = Math.max(8, Math.floor(ar.length * 0.2));
    if (best.votes < minVotes) {
        console.log(`sync: low confidence (${best.votes}/${ar.length} votes), keeping original timing`);
        return arSrt;
    }
    console.log(`sync: scale=${scale.toFixed(5)} offset=${Math.round(offset)}ms votes=${best.votes}/${ar.length}`);

    const rate = (f) => {
        let hit = 0, j = 0;
        for (const a of ar) {
            const t = f(a);
            while (j < en.length - 1 && en[j + 1] <= t) j++;
            if (Math.abs(en[j] - t) < 400 || (en[j + 1] !== undefined && Math.abs(en[j + 1] - t) < 400)) hit++;
        }
        return Math.round(100 * hit / ar.length);
    };
    const before = rate(a => a), after = rate(a => a * scale + offset);
    console.log(`sync: cues within 0.4s of an English cue: before ${before}%, after ${after}%`);
    if (after < before) return arSrt;

    return arSrt.replace(/(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})/g, (full, start, end) => {
        const newStart = msToTime(timeToMs(start) * scale + offset);
        const newEnd = msToTime(timeToMs(end) * scale + offset);
        return `${newStart} --> ${newEnd}`;
    });
}

// ---------- decoding ----------
function isValidUtf8(buf) {
    // TextDecoder with fatal:true throws on invalid sequences
    try {
        new TextDecoder('utf-8', { fatal: true }).decode(buf);
        return true;
    } catch (_) {
        return false;
    }
}

function decodeSubtitle(buf) {
    // UTF-16 BOMs
    if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return iconv.decode(buf, 'utf16le');
    if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return iconv.decode(buf, 'utf16be');
    let text = isValidUtf8(buf) ? buf.toString('utf8') : iconv.decode(buf, 'windows-1256');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return text;
}

// ---------- SubDL ----------
async function downloadSrt(url, season, episode) {
    const full = /^https?:\/\//i.test(url) ? url : `https://dl.subdl.com${url.startsWith('/') ? '' : '/'}${url}`;
    const res = await axios.get(full, { responseType: 'arraybuffer', timeout: 20000 });
    const data = Buffer.from(res.data);
    // zip archive (PK header) or a raw subtitle file
    if (data[0] === 0x50 && data[1] === 0x4b) {
        const zip = new AdmZip(data);
        const entries = zip.getEntries().filter(e => !e.isDirectory && e.entryName.toLowerCase().endsWith('.srt'));
        if (!entries.length) return null;
        if (season && episode && entries.length > 1) {
            const re = new RegExp(`(^|[^0-9])(s0*${season}[ ._-]*e0*${episode}|0*${season}x0*${episode})([^0-9]|$)`, 'i');
            const match = entries.filter(e => re.test(e.entryName.split('/').pop()));
            if (!match.length) return null; // season pack without this episode
            entries.splice(0, entries.length, ...match);
        }
        entries.sort((a, b) => b.header.size - a.header.size); // biggest .srt is usually the real one
        return decodeSubtitle(entries[0].getData());
    }
    const text = decodeSubtitle(data);
    return /-->/.test(text) ? text : null;
}

function langOf(s) {
    return String(s.language || s.lang || '').trim().toUpperCase();
}
function isArabic(s) {
    const l = langOf(s);
    return l === 'AR' || l === 'ARA' || l === 'ARABIC';
}
function isEnglish(s) {
    const l = langOf(s);
    return l === 'EN' || l === 'ENG' || l === 'ENGLISH';
}

async function firstWorking(cands, season, episode) {
    for (const c of cands.slice(0, MAX_CANDIDATES)) {
        if (!c || !c.url) continue;
        try {
            const text = await downloadSrt(c.url, season, episode);
            if (text && /-->/.test(text)) {
                console.log(`picked [${langOf(c)}] ${c.release_name || c.name} (S${c.season ?? '-'}E${c.episode ?? '-'})`);
                return text;
            }
        } catch (e) {
            console.warn('download failed', String(c.url).split('?')[0], e.message);
        }
    }
    return null;
}

// ---------- routes ----------
app.get('/', (req, res) => {
    const host = `${req.protocol === 'http' && !req.get('x-forwarded-proto') ? 'http' : 'https'}://${req.get('host')}`;
    res.type('html').send(`<!doctype html><meta charset="utf-8"><title>${manifest.name}</title>
<body style="font-family:sans-serif;max-width:640px;margin:40px auto;text-align:center" dir="rtl">
<h2>${manifest.name}</h2><p>${manifest.description}</p>
<p>انسخ هذا الرابط وحطه في Stremio → Addons:</p>
<p><code>${host}/manifest.json</code></p>
<p><a href="stremio://${req.get('host')}/manifest.json">تثبيت في Stremio</a></p>
<p style="color:${SUBDL_API_KEY ? 'green' : 'red'}">${SUBDL_API_KEY ? 'SubDL key: OK' : 'SubDL key: NOT SET'}</p>
</body>`);
});

app.get('/health', (req, res) => res.json({ ok: true, subdlKey: Boolean(SUBDL_API_KEY), cached: syncedCache.size }));

app.get('/manifest.json', (req, res) => res.json(manifest));

async function subtitlesHandler(req, res) {
    const empty = () => res.json({ subtitles: [] });
    try {
        const rawId = decodeURIComponent(String(req.params.id || '')).replace(/\.json$/i, '');
        const parts = rawId.split(':');
        const imdbId = parts[0];
        const season = parts[1] || '';
        const episode = parts[2] || '';

        if (!/^tt\d+$/.test(imdbId)) return empty();
        if (!SUBDL_API_KEY) {
            console.warn('SUBDL_API_KEY is not set');
            return empty();
        }

        const cacheId = `${imdbId}_${season}_${episode}`;
        const host = `https://${req.get('host')}`;
        const respond = () => res.json({
            subtitles: [{
                id: `autosync_${cacheId}`,
                url: `${host}/srt/${cacheId}.srt`,
                lang: 'ara',
                label: LABEL,
                name: LABEL
            }]
        });

        if (syncedCache.has(cacheId)) return respond();

        const queryParams = {
            api_key: SUBDL_API_KEY,
            imdb_id: imdbId,
            languages: 'AR,EN',
            subs_per_page: 30,
            client: 'stremio'
        };
        if (season && episode) {
            queryParams.type = 'tv';
            queryParams.season_number = season;
            queryParams.episode_number = episode;
        } else if (req.params.type === 'movie') {
            queryParams.type = 'movie';
        }

        const response = await axios.get('https://api.subdl.com/api/v1/subtitles', { params: queryParams, timeout: 20000 });
        if (!response.data || response.data.status === false) {
            console.warn('SubDL error:', response.data && response.data.error);
            return empty();
        }
        let subs = response.data.subtitles || [];

        // For episodes prefer files that are for this exact episode (not full-season packs)
        if (season && episode) {
            const exact = subs.filter(s => !s.full_season && (s.episode == null || String(s.episode) === String(episode)));
            if (exact.length) subs = exact.concat(subs.filter(s => !exact.includes(s)));
        }

        // Drop files whose name clearly says a different episode
        if (season && episode) {
            subs = subs.filter(s => {
                const names = `${s.release_name || ''} ${s.name || ''}`;
                const m = names.match(/s(\d{1,2})[ ._-]*e(\d{1,3})(?![\d-])/i);
                return !m || (+m[1] === +season && +m[2] === +episode);
            });
        }
        const arCands = subs.filter(isArabic);
        const enCands = subs.filter(isEnglish);
        if (!arCands.length) return empty();

        const arText = await firstWorking(arCands, season, episode);
        if (!arText) return empty();

        let finalSrt = arText;
        if (enCands.length) {
            const enText = await firstWorking(enCands, season, episode);
            if (enText) finalSrt = syncArabicToEnglish(arText, enText);
        }

        cacheSet(cacheId, finalSrt);
        return respond();
    } catch (e) {
        console.warn('subtitles error:', e.message);
        return empty();
    }
}

// Stremio calls /subtitles/:type/:id.json or /subtitles/:type/:id/:extra.json
app.get('/subtitles/:type/:id/:extra.json', subtitlesHandler);
app.get('/subtitles/:type/:id.json', subtitlesHandler);
app.get('/subtitles/:type/:id', subtitlesHandler);

app.get('/srt/:id.srt', (req, res) => {
    const srt = syncedCache.get(req.params.id);
    if (!srt) return res.status(404).send('Not found');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(srt);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Addon running on port ${PORT}`));

module.exports = { syncArabicToEnglish, cueStarts, decodeSubtitle };
