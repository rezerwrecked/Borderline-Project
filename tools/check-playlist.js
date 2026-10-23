#!/usr/bin/env node
// Checks playlist.js against the files in music/ and can refresh the values
// that go stale whenever audio is re-encoded or retagged.
//
//   node tools/check-playlist.js           report problems, exit 1 on errors
//   node tools/check-playlist.js --write   also update duration and bytes
//
// It also checks the albums in remixes.js: unique ids, track entries that
// resolve to playlist.js, and artwork and backgrounds that exist on disk and
// stay within a sensible file size. Those problems are warnings, since the page
// skips a bad album or falls back to the default artwork instead of breaking.
//
// ffprobe (from ffmpeg) is used for durations. Without it, durations are
// skipped with a warning and everything else is still checked.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const playlistPath = path.join(root, 'playlist.js');
const remixesPath = path.join(root, 'remixes.js');
const musicDir = path.join(root, 'music');
const write = process.argv.includes('--write');

// Images above this size add to the first load and the offline shell cache.
const MAX_IMAGE_BYTES = 1024 * 1024;
const DEFAULT_ART = 'cover1.webp';
const DEFAULT_BACKGROUND = 'bg-wide.webp';
const DEFAULT_BACKGROUND_TALL = 'bg-tall.webp';

const errors = [];
const warnings = [];
let ffprobeMissing = false;

function fail(message) { errors.push(message); }
function warn(message) { warnings.push(message); }

function audioPath(file) {
    return path.resolve(root, file.includes('/') ? file : path.join('music', file));
}

function probeDuration(file) {
    if (ffprobeMissing) return null;
    const result = spawnSync('ffprobe', [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        file
    ], { encoding: 'utf8' });
    if (result.error && result.error.code === 'ENOENT') {
        ffprobeMissing = true;
        warn('ffprobe not found; durations were not checked.');
        return null;
    }
    const seconds = parseFloat((result.stdout || '').trim());
    return Number.isFinite(seconds) ? seconds : null;
}

function relPath(abs) {
    return path.relative(root, abs).split(path.sep).join('/');
}

function loadPlaylist() {
    const text = fs.readFileSync(playlistPath, 'utf8');
    const sandbox = { window: {} };
    try {
        vm.runInNewContext(text, sandbox, { filename: 'playlist.js', timeout: 2000 });
    } catch (error) {
        fail(`playlist.js does not run: ${error.message}`);
        return { text, tracks: null };
    }
    if (!Array.isArray(sandbox.window.myPlaylist)) {
        fail('playlist.js did not create window.myPlaylist as an array.');
        return { text, tracks: null };
    }
    return { text, tracks: sandbox.window.myPlaylist };
}

function loadAlbums() {
    if (!fs.existsSync(remixesPath)) {
        warn('remixes.js was not found, so albums were not checked.');
        return null;
    }
    const text = fs.readFileSync(remixesPath, 'utf8');
    const sandbox = { window: {} };
    try {
        vm.runInNewContext(text, sandbox, { filename: 'remixes.js', timeout: 2000 });
    } catch (error) {
        fail(`remixes.js does not run: ${error.message}`);
        return null;
    }
    if (!Array.isArray(sandbox.window.myAlbums)) {
        warn('remixes.js did not create window.myAlbums, so albums were not checked.');
        return null;
    }
    return sandbox.window.myAlbums;
}

// Mirrors the helpers in index.html so the tool resolves album entries exactly
// the way the page does.
function slugify(text) {
    return String(text).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function normalizeTrackFile(file) {
    return String(file || '')
        .replace(/\\/g, '/')
        .replace(/^\.?\//, '')
        .replace(/^music\//i, '')
        .toLowerCase();
}

// Reads the pixel size from a JPEG, PNG or WebP header without loading an image
// library. Other formats return null and are left alone.
function imageSize(file) {
    const buffer = fs.readFileSync(file);
    if (buffer.length >= 30 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
        const chunk = buffer.toString('ascii', 12, 16);
        if (chunk === 'VP8X') {
            return { width: buffer.readUIntLE(24, 3) + 1, height: buffer.readUIntLE(27, 3) + 1 };
        }
        if (chunk === 'VP8 ' && buffer.length >= 30) {
            return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
        }
        if (chunk === 'VP8L' && buffer.length >= 25) {
            const bits = buffer.readUInt32LE(21);
            return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
        }
    }
    if (buffer.length >= 24 && buffer[0] === 0x89 && buffer.toString('ascii', 1, 4) === 'PNG') {
        return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    }
    if (buffer.length >= 4 && buffer[0] === 0xFF && buffer[1] === 0xD8) {
        let offset = 2;
        while (offset + 9 < buffer.length) {
            if (buffer[offset] !== 0xFF) { offset += 1; continue; }
            const marker = buffer[offset + 1];
            if (marker === 0xD8 || marker === 0xD9 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) {
                offset += 2;
                continue;
            }
            const length = buffer.readUInt16BE(offset + 2);
            if (length < 2) return null;
            if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
                return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) };
            }
            offset += 2 + length;
        }
    }
    return null;
}

function checkAlbumImage(where, field, file) {
    if (typeof file !== 'string' || !file.trim()) {
        fail(`${where}: ${field} is not a file name`);
        return;
    }
    const abs = path.resolve(root, file);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
        warn(`${where}: ${field} ${relPath(abs)} does not exist`);
        return;
    }
    const size = fs.statSync(abs).size;
    if (size > MAX_IMAGE_BYTES) {
        const mb = (size / (1024 * 1024)).toFixed(1);
        warn(`${where}: ${field} ${relPath(abs)} is ${mb} MB; keep images at 1 MB or less`);
    }
    // Covers and their small tab versions sit in square frames; a stretched or
    // letterboxed one is obvious.
    if (field === 'art' || field === 'thumb') {
        const pixels = imageSize(abs);
        if (pixels && pixels.width && pixels.height) {
            const ratio = pixels.width / pixels.height;
            if (ratio < 0.95 || ratio > 1.05) {
                warn(`${where}: ${field} ${relPath(abs)} is ${pixels.width}x${pixels.height}; square (1:1) covers fit the frame`);
            }
        }
    }
}

function checkAlbumTracks(where, entries, byFile) {
    if (!Array.isArray(entries)) return;
    entries.forEach((entry, index) => {
        const label = `${where}: track ${index + 1}`;
        if (typeof entry === 'string') {
            if (!byFile.has(normalizeTrackFile(entry))) {
                warn(`${label} "${entry}" is not in playlist.js, so the album skips it`);
            }
            return;
        }
        if (entry && typeof entry === 'object') {
            if (!entry.file) {
                warn(`${label} has no file, so the album skips it`);
            } else if (!entry.title) {
                warn(`${label} (${entry.file}) has no title, so the album skips it`);
            }
            return;
        }
        warn(`${label} is not a file name or a track object, so the album skips it`);
    });
}

// Resolves albums the way index.html does: derived ids, playlist file names,
// and the same artwork defaults, so an album that omits a field still gets the
// default file verified.
function checkAlbums(tracks) {
    const albums = loadAlbums();
    if (!albums) return 0;

    const byFile = new Map();
    tracks.forEach(song => {
        if (!song || !song.file) return;
        const key = normalizeTrackFile(song.file);
        if (!byFile.has(key)) byFile.set(key, song);
    });

    const usedIds = new Map();
    albums.forEach((album, index) => {
        if (!album || typeof album !== 'object') {
            fail(`album ${index + 1}: entry is not an object`);
            return;
        }
        const where = `album ${index + 1} (${album.title || album.id || 'untitled'})`;
        // index.html derives a missing id from the title, then skips duplicates.
        const title = String(album.title || '').trim();
        const id = String(album.id || slugify(title) || `album-${index + 1}`).trim();

        if (!id) {
            warn(`${where}: id is blank, so the album is skipped`);
        } else if (usedIds.has(id)) {
            warn(`${where}: id "${id}" is already used by album ${usedIds.get(id)}, so this one is skipped`);
        } else {
            usedIds.set(id, index + 1);
        }

        if (album.accent && !/^#[0-9a-f]{6}$/i.test(String(album.accent))) {
            warn(`${where}: accent "${album.accent}" is not a #rrggbb colour, so the default theme is used`);
        }

        checkAlbumTracks(where, album.tracks, byFile);
        checkAlbumImage(where, 'art', album.art || DEFAULT_ART);
        checkAlbumImage(where, 'thumb', album.thumb || album.art || DEFAULT_ART);
        checkAlbumImage(where, 'background', album.background || DEFAULT_BACKGROUND);
        checkAlbumImage(where, 'backgroundTall', album.backgroundTall || album.background || DEFAULT_BACKGROUND_TALL);
    });

    return albums.length;
}

function checkLyrics(song, index) {
    const where = `track ${index + 1} (${song.title || 'untitled'})`;
    if (!Array.isArray(song.lyrics)) {
        fail(`${where}: lyrics is not an array`);
        return;
    }
    let previous = -Infinity;
    song.lyrics.forEach((line, i) => {
        if (!line || typeof line !== 'object') {
            fail(`${where}: lyric ${i + 1} is not an object`);
            return;
        }
        if (typeof line.time !== 'number' || !Number.isFinite(line.time) || line.time < 0) {
            fail(`${where}: lyric ${i + 1} has an invalid time (${line.time})`);
        } else if (line.time < previous) {
            fail(`${where}: lyric ${i + 1} goes backwards (${line.time} after ${previous})`);
        } else {
            previous = line.time;
        }
        if (typeof line.text !== 'string' || !line.text.trim()) {
            fail(`${where}: lyric ${i + 1} has empty text`);
        }
    });
    const duration = song.duration;
    if (Number.isFinite(duration) && duration > 0) {
        const beyond = song.lyrics.find(line => line && line.time > duration + 2);
        if (beyond) {
            warn(`${where}: a lyric is timed past the end of the track (${beyond.time}s).`);
        }
    }
}

function updateEntry(text, song, values) {
    if (values.duration == null && values.bytes == null) return text;
    const escaped = song.file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const filePattern = new RegExp(`(^[ \\t]*file:[ \\t]*"${escaped}"[^\\n]*\\n)`, 'm');
    const match = filePattern.exec(text);
    if (!match) {
        warn(`Could not locate the block for ${song.title}; run the checker again.`);
        return text;
    }
    const start = match.index;
    const nextEntry = /^[ \t]*file:[ \t]*"/m;
    const rest = text.slice(start + match[0].length);
    const nextMatch = nextEntry.exec(rest);
    const end = nextMatch ? start + match[0].length + nextMatch.index : text.length;
    let block = text.slice(start, end);

    if (values.bytes != null) {
        block = block.replace(/(^[ \t]*bytes:[ \t]*)\d+/m, `$1${values.bytes}`);
    }
    if (values.duration != null) {
        block = block.replace(/(^[ \t]*duration:[ \t]*)\d+(?:\.\d+)?/m, `$1${values.duration}`);
    }
    return text.slice(0, start) + block + text.slice(end);
}

function main() {
    const { text, tracks } = loadPlaylist();
    if (!tracks) return report();

    const seenFiles = new Map();
    const seenTitles = new Map();
    let updatedCount = 0;
    let output = text;

    tracks.forEach((song, index) => {
        const where = `track ${index + 1}`;
        if (!song || typeof song !== 'object') {
            fail(`${where}: entry is not an object`);
            return;
        }
        if (typeof song.title !== 'string' || !song.title.trim()) fail(`${where}: missing title`);
        if (typeof song.artist !== 'string' || !song.artist.trim()) fail(`${where}: missing artist`);

        if (typeof song.file !== 'string' || !song.file.trim()) {
            fail(`${where}: missing file`);
            return;
        }
        const label = `${where} (${song.title || song.file})`;
        if (seenFiles.has(song.file)) {
            fail(`${label}: file is already used by track ${seenFiles.get(song.file) + 1}`);
        } else {
            seenFiles.set(song.file, index);
        }
        if (song.title && seenTitles.has(song.title)) {
            warn(`${label}: duplicate title with track ${seenTitles.get(song.title) + 1}`);
        } else if (song.title) {
            seenTitles.set(song.title, index);
        }

        const file = audioPath(song.file);
        if (!fs.existsSync(file)) {
            fail(`${label}: ${relPath(file)} does not exist`);
            return;
        }

        const size = fs.statSync(file).size;
        if (song.bytes !== size) {
            warn(`${label}: bytes ${song.bytes} should be ${size}`);
            if (!write) {
                // Reported; --write fixes it below.
            }
        }

        let duration = null;
        const probed = probeDuration(file);
        if (probed != null) {
            duration = Math.round(probed);
            if (song.duration !== duration) {
                warn(`${label}: duration ${song.duration} should be ${duration}`);
            }
        }

        if (write) {
            const before = output;
            output = updateEntry(output, song, {
                bytes: song.bytes !== size ? size : null,
                duration: duration != null && song.duration !== duration ? duration : null
            });
            if (output !== before) updatedCount += 1;
        }

        checkLyrics(song, index);
    });

    const albumCount = checkAlbums(tracks);

    const referenced = new Set([...seenFiles.keys()].map(file => audioPath(file)));
    if (fs.existsSync(musicDir)) {
        fs.readdirSync(musicDir)
            .map(name => path.join(musicDir, name))
            .filter(file => fs.statSync(file).isFile())
            .forEach(file => {
                if (!referenced.has(file)) {
                    warn(`${relPath(file)} is in music/ but not in the playlist.`);
                }
            });
    }

    if (write && output !== text) {
        fs.writeFileSync(playlistPath, output);
    }

    console.log(`Checked ${tracks.length} tracks.`);
    if (albumCount) console.log(`Checked ${albumCount} album${albumCount === 1 ? '' : 's'}.`);
    warnings.forEach(message => console.log(`  warning: ${message}`));
    errors.forEach(message => console.log(`  error:   ${message}`));
    if (write) console.log(`Updated ${updatedCount} entr${updatedCount === 1 ? 'y' : 'ies'}.`);
    if (!errors.length && !warnings.length) console.log('No problems found.');
    return report();
}

function report() {
    if (errors.length) {
        console.log(`\n${errors.length} error${errors.length === 1 ? '' : 's'} found.`);
        process.exitCode = 1;
    }
}

main();
