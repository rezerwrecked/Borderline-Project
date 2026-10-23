// Borderline Project service worker.
//
// Two caches:
//   - the app shell. Pages, styles, scripts and the manifest are fetched from the
//     network first so a deploy shows up on the next load; images stay cache-first.
//     Everything falls back to the cache when offline;
//   - the audio, filled once a track has streamed without asking for more bytes
//     (or on an explicit download), with HTTP Range support so seeking works
//     offline too.
//
// Bump SHELL_CACHE whenever the shell files change; old shell caches are dropped
// on activate. The audio cache is kept across shell updates so downloaded tracks
// stay available offline.
const SHELL_CACHE = 'borderline-shell-v38';
const AUDIO_CACHE = 'borderline-audio-v1';

const SCOPE = self.registration.scope;

const SHELL_FILES = [
    '', // the start URL
    'index.html',
    'tailwind.css',
    'playlist.js',
    'remixes.js',
    'manifest.webmanifest',
    'cover1.webp',
    'cover1-thumb.webp',
    'remix-cover.webp',
    'remix-cover-thumb.webp',
    'bg-wide.webp',
    'bg-tall.webp',
    'bg2-wide.webp',
    'bg2-cover.webp',
    'bg2-cover-thumb.webp',
    'remix-bg.webp',
    'remix-bg-tall.webp',
    'icon-192.png',
    'icon-512.png',
    'icon-maskable-512.png',
    'apple-touch-icon.png'
];

// Requests for the same uncached track arrive several times in a row (the audio
// element asks for byte ranges); share one download instead of one per request.
const pendingSeeds = new Map();

self.addEventListener('install', event => {
    event.waitUntil((async () => {
        const cache = await caches.open(SHELL_CACHE);
        // allSettled: one missing or offline file must not block the install.
        await Promise.allSettled(SHELL_FILES.map(file => {
            const url = new URL(file, SCOPE).href;
            return cache.add(new Request(url, { cache: 'reload' }));
        }));
        await self.skipWaiting();
    })());
});

self.addEventListener('activate', event => {
    event.waitUntil((async () => {
        const keep = new Set([SHELL_CACHE, AUDIO_CACHE]);
        const names = await caches.keys();
        await Promise.all(names
            .filter(name => name.startsWith('borderline-') && !keep.has(name))
            .map(name => caches.delete(name)));
        await self.clients.claim();
    })());
});

self.addEventListener('fetch', event => {
    const request = event.request;
    if (request.method !== 'GET' || !request.url.startsWith('http')) return;

    const url = new URL(request.url);

    if (url.origin !== self.location.origin) return;

    if (url.pathname.includes('/music/') || request.destination === 'audio') {
        event.respondWith(audioResponse(event));
        return;
    }

    event.respondWith(shellResponse(event));
});

// Anything that changes when the site is edited is fetched from the network
// first, so a saved playlist or deploy is visible on the next load instead of
// one load later. Images and icons stay cache-first.
function wantsFreshCopy(request) {
    if (request.mode === 'navigate') return true;
    const pathname = new URL(request.url).pathname;
    return /\.(?:html|css|js|webmanifest)$/.test(pathname);
}

async function shellResponse(event) {
    const request = event.request;
    const cache = await caches.open(SHELL_CACHE);
    const cached = await cache.match(request, { ignoreSearch: true });

    if (wantsFreshCopy(request)) {
        try {
            const response = await fetch(request, { cache: 'no-store' });
            if (response && response.ok) {
                event.waitUntil(cache.put(stripSearch(request.url), response.clone()).catch(() => {}));
                return response;
            }
        } catch (error) {
            // Offline: the cached copy below is the whole point of the cache.
        }
        if (cached) return cached;
        if (request.mode === 'navigate') {
            const fallback = await cache.match(new URL('index.html', SCOPE).href);
            if (fallback) return fallback;
        }
        return offlineResponse();
    }

    const network = fetch(request).then(response => {
        // Cache by path: query strings here only ever cache-bust, and keying by
        // them would grow the cache with duplicate copies of the same file.
        // A failed write (quota, private mode) must not break the response.
        if (response && response.ok) cache.put(stripSearch(request.url), response.clone()).catch(() => {});
        return response;
    }).catch(() => null);

    if (cached) {
        event.waitUntil(network);
        return cached;
    }

    const response = await network;
    if (response) return response;

    // Track artwork is cached only once it has been seen; offline, an unseen
    // one falls back to the album cover instead of a broken image.
    if (request.destination === 'image') {
        const fallback = await cache.match(new URL('cover1.webp', SCOPE).href);
        if (fallback) return fallback;
    }

    return offlineResponse();
}

function offlineResponse() {
    return new Response('Offline', {
        status: 503,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
}

// Cached tracks are answered from storage with working byte ranges; a track that
// has never been played streams from the network and is downloaded once it has
// stopped asking for bytes, so the copy never competes with playback.
//
// Anything unexpected here falls through to the network instead of rejecting the
// fetch event: a rejected respondWith is a hard network error for the media
// element, which shows up as a dead track in the middle of a seek.
async function audioResponse(event) {
    const request = event.request;

    try {
        // Cache by path so a ?v= copy of a track can't become a second download.
        const key = stripSearch(request.url);
        const cache = await caches.open(AUDIO_CACHE);
        const cached = await cache.match(key);

        if (cached) {
            const response = await cachedAudioResponse(cache, key, request, cached);
            if (response) return response;
            // The stored copy was unusable and has been dropped; fall through so
            // this request is served from the network.
        }

        // A HEAD probe (the bitrate badge) must never pull a whole track down.
        // Save-Data users keep streaming without the background full download.
        if (request.method === 'GET' && request.headers.get('Save-Data') !== 'on') {
            event.waitUntil(scheduleSeed(cache, key));
        }
    } catch (error) {
        console.warn('Audio cache lookup failed, using the network:', request.url, error);
    }

    try {
        return await fetch(request);
    } catch (error) {
        // Offline and uncached: fail cleanly instead of rejecting respondWith.
        return new Response(null, { status: 504, statusText: 'Gateway Timeout' });
    }
}

async function cachedAudioResponse(cache, key, request, cached) {
    const contentType = cached.headers.get('Content-Type') || 'audio/mpeg';
    const blob = await audioBlob(key, cached);
    const declared = parseInt(cached.headers.get('Content-Length'), 10);

    // A stored entry that is shorter than its own headers (an interrupted write)
    // cannot answer byte ranges: media would stall or error part way through a
    // seek. Drop it and let the network serve this request.
    if (Number.isFinite(declared) && declared > 0 && declared !== blob.size) {
        audioBlobs.delete(key);
        await cache.delete(key).catch(() => {});
        return null;
    }

    const size = blob.size;
    const baseHeaders = {
        'Content-Type': contentType,
        'Accept-Ranges': 'bytes'
    };

    // showQuality() probes the file with HEAD; a body here would be a full track.
    if (request.method === 'HEAD') {
        return new Response(null, {
            status: 200,
            headers: Object.assign({}, baseHeaders, { 'Content-Length': String(size) })
        });
    }

    const range = request.headers.get('range');
    if (!range) {
        return new Response(blob, {
            status: 200,
            headers: Object.assign({}, baseHeaders, { 'Content-Length': String(size) })
        });
    }

    const bounds = parseRange(range, size);
    if (!bounds) {
        return new Response(null, {
            status: 416,
            headers: { 'Content-Range': `bytes */${size}`, 'Accept-Ranges': 'bytes' }
        });
    }

    let [start, end] = bounds;
    // Answer with a bounded chunk instead of "everything to the end of the file".
    // An open-ended range on a 25 MB FLAC hands the element a body it routinely
    // aborts part way through a seek, and the demuxer reports that abort as a
    // dead data source. Small chunks are read completely, so nothing is aborted.
    if (end - start + 1 > MAX_RANGE_BYTES) end = start + MAX_RANGE_BYTES - 1;

    return new Response(blob.slice(start, end + 1), {
        status: 206,
        statusText: 'Partial Content',
        headers: Object.assign({}, baseHeaders, {
            'Content-Length': String(end - start + 1),
            'Content-Range': `bytes ${start}-${end}/${size}`
        })
    });
}

// Slices of a cached track come from a Blob, so a seek costs one cheap slice
// instead of reading the whole file again. Only a few tracks are held at once.
const audioBlobs = new Map();
const AUDIO_BLOB_LIMIT = 3;
const MAX_RANGE_BYTES = 1024 * 1024;

function audioBlob(url, cached) {
    const existing = audioBlobs.get(url);
    if (existing) {
        audioBlobs.delete(url);
        audioBlobs.set(url, existing);
        return existing;
    }

    const blob = cached.blob().catch(error => {
        audioBlobs.delete(url);
        throw error;
    });

    audioBlobs.set(url, blob);
    while (audioBlobs.size > AUDIO_BLOB_LIMIT) {
        audioBlobs.delete(audioBlobs.keys().next().value);
    }
    return blob;
}

// "bytes=start-end", "bytes=start-" and "bytes=-suffix" are the only forms a
// media element sends. Anything else (or a range past the end) gets a 416 rather
// than a misleading full-file response.
function parseRange(range, size) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!match || (match[1] === '' && match[2] === '')) return null;

    let start;
    let end;

    if (match[1] === '') {
        const suffix = parseInt(match[2], 10);
        if (!Number.isFinite(suffix) || suffix <= 0) return null;
        start = Math.max(size - suffix, 0);
        end = size - 1;
    } else {
        start = parseInt(match[1], 10);
        end = match[2] === '' ? size - 1 : Math.min(parseInt(match[2], 10), size - 1);
    }

    if (!Number.isFinite(start) || start < 0 || start > end || start >= size) return null;
    return [start, end];
}

// Playing a track used to start a second full download immediately, which both
// doubled the bytes and starved the stream (a seek could then read as a dead
// file). The copy now starts only after the element has stopped asking for
// ranges. waitUntil keeps the worker alive for the delay.
const SEED_DELAY_MS = 4000;
const seedRequests = new Map();

function scheduleSeed(cache, url) {
    const generation = (seedRequests.get(url) || 0) + 1;
    seedRequests.set(url, generation);

    return new Promise(resolve => setTimeout(resolve, SEED_DELAY_MS))
        .then(() => {
            // A newer request arrived while waiting: the element is still reading
            // this track, so keep the download out of its way.
            if (seedRequests.get(url) !== generation) return false;
            seedRequests.delete(url);
            return seedAudio(cache, url);
        })
        .catch(() => false);
}

function seedAudio(cache, url) {
    if (pendingSeeds.has(url)) return pendingSeeds.get(url);

    const seed = (async () => {
        // A download may have finished while this one was queued.
        if (await cache.match(url)) return true;

        const response = await fetch(url);
        // Only a complete 200 body can answer byte ranges correctly.
        if (response.status !== 200) return false;

        const total = Number(response.headers.get('content-length')) || 0;
        const encoding = (response.headers.get('content-encoding') || 'identity').toLowerCase();
        let progressTask = Promise.resolve();
        // Read a clone alongside cache.put so the cached response keeps its
        // original headers and bytes. Counted only for identity responses, where
        // Content-Length matches the decoded body. Two-percent steps keep
        // postMessage traffic down.
        if (total > 0 && response.body && encoding === 'identity') {
            const reader = response.clone().body.getReader();
            progressTask = (async () => {
                let received = 0;
                let lastPercent = -1;
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    received += value.byteLength;
                    const percent = Math.min(100, Math.floor((received / total) * 100));
                    if (percent !== lastPercent && (percent % 2 === 0 || percent === 100)) {
                        lastPercent = percent;
                        notifyTrackProgress(url, Math.min(received / total, 1));
                    }
                }
                notifyTrackProgress(url, 1);
            })().catch(() => {});
        }

        await cache.put(url, response);
        await progressTask;
        await notifyTrackCached(url);
        return true;
    })()
        .catch(() => false)
        .finally(() => pendingSeeds.delete(url));

    pendingSeeds.set(url, seed);
    return seed;
}

async function notifyTrackProgress(url, fraction) {
    try {
        const clients = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
        clients.forEach(client => client.postMessage({ type: 'audio-progress', url, fraction }));
    } catch (error) {
        // No open clients; there is no ring to fill.
    }
}

async function notifyTrackCached(url) {
    try {
        const clients = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
        clients.forEach(client => client.postMessage({ type: 'audio-cached', url }));
    } catch (error) {
        // No open clients; the markers also refresh on the next page load.
    }
}

async function notifyCacheFailed(url) {
    try {
        const clients = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
        clients.forEach(client => client.postMessage({ type: 'audio-cache-failed', url }));
    } catch (error) {
        // No open clients.
    }
}

// Explicit download requested from the playlist, so a track can be cached
// without being played first.
self.addEventListener('message', event => {
    const data = event.data;
    if (!data || data.type !== 'download-track' || typeof data.url !== 'string') return;
    event.waitUntil(downloadTrack(data.url));
});

async function downloadTrack(url) {
    try {
        if (!url.startsWith(self.location.origin + '/')) return;
        const key = stripSearch(url);
        const cache = await caches.open(AUDIO_CACHE);
        if (await cache.match(key)) {
            await notifyTrackCached(key);
            return;
        }
        const stored = await seedAudio(cache, key);
        if (!stored) await notifyCacheFailed(key);
    } catch (error) {
        await notifyCacheFailed(url);
    }
}

function stripSearch(url) {
    const parsed = new URL(url);
    parsed.search = '';
    return parsed.href;
}
