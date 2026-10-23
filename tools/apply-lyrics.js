#!/usr/bin/env node
// Applies lyric timings exported from lyrics-editor.html to playlist.js.
//
//   node tools/apply-lyrics.js lyrics-run.txt            # preview only
//   node tools/apply-lyrics.js lyrics-run.txt --write    # save the change
//   node tools/apply-lyrics.js one.txt two.txt --write   # several at once
//   node tools/apply-lyrics.js run.lrc --write            # standard LRC
//
// Each file is either the entry produced by "Copy playlist entry" / "Download
// .txt" in the editor, or a standard .lrc file. Tracks are matched by their
// file name (run.lrc -> run.mp3), and only the lyrics array is replaced, so
// title, duration and byte counts in playlist.js are left exactly as they
// are. Nothing is written unless verification passes.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const playlistPath = path.join(root, 'playlist.js');

const args = process.argv.slice(2);
const write = args.includes('--write');
const help = args.includes('--help') || args.includes('-h');
const inputFiles = args.filter(arg => !arg.startsWith('--'));

function usage() {
    console.log([
        'Usage: node tools/apply-lyrics.js <entry.txt|lyrics.lrc> [more files] [--write]',
        '',
        'An entry file comes from lyrics-editor.html: use "Download .txt" or',
        '"Copy playlist entry". An .lrc file is matched to a track by its file',
        'name, e.g. run.lrc -> run.mp3. Entries are matched by their file field.',
        'Without --write the script only shows what would change.',
        '',
        'Options:',
        '  --write   Save the patched playlist.js (a dry run otherwise)',
        '  --help    Show this message'
    ].join('\n'));
}

if (help) {
    usage();
    process.exit(0);
}

if (!inputFiles.length) {
    usage();
    process.exitCode = 1;
    process.exit();
}

function fail(message) {
    console.error(`error: ${message}`);
    process.exitCode = 1;
    process.exit();
}

function parseEntry(text, sourceName) {
    let source = text.trim();
    if (!source) fail(`${sourceName} is empty.`);
    if (source.startsWith('{') === false) {
        fail(`${sourceName} does not look like a playlist entry. In the editor, use "Copy playlist entry" or "Download .txt" rather than the lyrics array alone.`);
    }
    // The exported entry carries a trailing comma because it is pasted between
    // other entries; allow it (and a stray semicolon) here.
    source = source.replace(/[,;\s]+$/, '');
    let entry;
    try {
        entry = vm.runInNewContext(`(${source})`, {}, { timeout: 2000, filename: sourceName });
    } catch (error) {
        fail(`${sourceName} is not a valid entry: ${error.message}`);
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        fail(`${sourceName} did not produce an object.`);
    }
    if (typeof entry.file !== 'string' || !entry.file.trim()) {
        fail(`${sourceName} has no file field, so it cannot be matched to a track. Use "Copy playlist entry" in the editor.`);
    }
    if (!Array.isArray(entry.lyrics)) {
        fail(`${sourceName} has no lyrics array.`);
    }
    const lyrics = entry.lyrics.map((line, index) => {
        const where = `${sourceName}: lyric ${index + 1}`;
        if (!line || typeof line !== 'object') fail(`${where} is not an object.`);
        if (typeof line.text !== 'string' || !line.text.trim()) fail(`${where} has no text.`);
        if (typeof line.time !== 'number' || !Number.isFinite(line.time) || line.time < 0) {
            fail(`${where} has an invalid time (${line.time}).`);
        }
        return { time: Math.round(line.time * 10) / 10, text: line.text };
    });
    for (let i = 1; i < lyrics.length; i += 1) {
        if (lyrics[i].time < lyrics[i - 1].time) {
            fail(`${sourceName}: times go backwards at line ${i + 1} (${lyrics[i].time}s after ${lyrics[i - 1].time}s).`);
        }
    }
    return {
        file: entry.file,
        title: typeof entry.title === 'string' ? entry.title : '',
        lyrics,
        count: lyrics.length
    };
}

function normalizeFile(name) {
    const cleaned = String(name).replace(/\\/g, '/').replace(/^\.\//, '');
    const withoutMusic = cleaned.toLowerCase().startsWith('music/') ? cleaned.slice(6) : cleaned;
    return path.basename(withoutMusic).toLowerCase();
}

function fileStem(name) {
    const base = normalizeFile(name);
    return base.slice(0, base.length - path.extname(base).length);
}

// Mirrors the editor's LRC reader so a file applies exactly as it imports
// there: metadata, multiple stamps per line, enhanced word tags and offsets.
function parseLrc(text, sourceName) {
    const meta = {};
    const entries = [];
    const timeTag = /^\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]\s*/;
    const metaTag = /^\[([a-z]+)\s*:\s*(.*?)\]\s*$/i;
    let order = 0;

    String(text).split(/\r?\n/).forEach(raw => {
        const line = raw.trim();
        if (!line) return;

        let rest = line;
        const stamps = [];
        let match;
        while ((match = timeTag.exec(rest))) {
            const fraction = match[3] || '';
            const seconds = Number(match[1]) * 60 + Number(match[2])
                + (fraction ? Number(fraction) / Math.pow(10, fraction.length) : 0);
            stamps.push(seconds);
            rest = rest.slice(match[0].length);
        }

        if (stamps.length) {
            const lyric = rest.replace(/<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g, '').trim();
            if (!lyric) return;
            stamps.forEach(time => entries.push({ time, text: lyric, order: order += 1 }));
            return;
        }

        const metaMatch = metaTag.exec(line);
        if (metaMatch) meta[metaMatch[1].toLowerCase()] = metaMatch[2].trim();
    });

    const rawOffset = Number.parseInt(meta.offset, 10);
    const offsetSeconds = Number.isFinite(rawOffset) ? rawOffset / 1000 : 0;
    const lyrics = entries
        .map(entry => ({ ...entry, time: Math.round(Math.max(0, entry.time + offsetSeconds) * 10) / 10 }))
        .sort((a, b) => a.time - b.time || a.order - b.order)
        .map(({ time, text }) => ({ time, text }));

    if (!lyrics.length) fail(`${sourceName} has no timed lyric lines.`);
    return { title: meta.ti || '', lyrics, count: lyrics.length };
}

function entryFromLrc(input, text, tracks) {
    const parsed = parseLrc(text, path.basename(input));
    const wanted = fileStem(input);
    const matches = tracks.filter(track => fileStem(track.file) === wanted);
    if (!matches.length) {
        fail(`no track in playlist.js matches ${path.basename(input)} by file name.`);
    }
    if (matches.length > 1) {
        fail(`${matches.length} tracks match ${path.basename(input)}; rename the .lrc after the full track file (e.g. ${matches[0].file}).`);
    }
    return { file: matches[0].file, title: parsed.title, lyrics: parsed.lyrics, count: parsed.count };
}

function loadPlaylist(text, label) {
    const sandbox = { window: {} };
    try {
        vm.runInNewContext(text, sandbox, { filename: label, timeout: 2000 });
    } catch (error) {
        fail(`${label} does not run: ${error.message}`);
    }
    if (!Array.isArray(sandbox.window.myPlaylist)) {
        fail(`${label} did not create window.myPlaylist.`);
    }
    return sandbox.window.myPlaylist;
}

function findFileLines(text, file) {
    const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`^[\\t ]*file:[\\t ]*"${escaped}"[\\t ]*,?[\\t ]*$`, 'gm');
    const found = [];
    let match;
    while ((match = pattern.exec(text))) {
        found.push({ index: match.index, length: match[0].length });
    }
    return found;
}

function findMatchingBracket(text, openIndex) {
    let depth = 0;
    let quote = null;
    for (let i = openIndex; i < text.length; i += 1) {
        const char = text[i];
        if (quote) {
            if (char === '\\') i += 1;
            else if (char === quote) quote = null;
            continue;
        }
        if (char === '"' || char === "'" || char === '`') quote = char;
        else if (char === '[') depth += 1;
        else if (char === ']') {
            depth -= 1;
            if (depth === 0) return i;
        }
    }
    return -1;
}

function renderLyrics(indent, eol, lyrics) {
    if (!lyrics.length) return `lyrics: [${eol}${indent}]`;
    const rows = lyrics
        .map(line => `${indent}    { time: ${line.time}, text: ${JSON.stringify(line.text)} },`)
        .join(eol);
    return `lyrics: [${eol}${rows}${eol}${indent}]`;
}

function replaceLyrics(text, file, lyrics) {
    const locations = findFileLines(text, file);
    if (!locations.length) fail(`playlist.js has no entry with file "${file}".`);
    if (locations.length > 1) fail(`playlist.js has ${locations.length} entries with file "${file}"; refusing to guess.`);

    const start = locations[0].index;
    const nextFile = (() => {
        const pattern = /^[ \t]*file:[ \t]*"/gm;
        pattern.lastIndex = start + locations[0].length;
        const match = pattern.exec(text);
        return match ? match.index : text.length;
    })();
    const block = text.slice(start, nextFile);
    const field = /^([ \t]*)lyrics:[ \t]*\[/m.exec(block);
    if (!field) fail(`the ${file} entry has no lyrics array to replace.`);

    const keywordStart = start + field.index + field[1].length;
    const openBracket = start + field.index + field[0].length - 1;
    const closeBracket = findMatchingBracket(text, openBracket);
    if (closeBracket < 0) fail(`could not find the end of the lyrics array for ${file}.`);

    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const indent = field[1];
    const replacement = renderLyrics(indent, eol, lyrics);
    return text.slice(0, keywordStart) + replacement + text.slice(closeBracket + 1);
}

function sameLyrics(a, b) {
    return a.length === b.length && a.every((line, index) =>
        Math.round(line.time * 10) / 10 === Math.round(b[index].time * 10) / 10
        && line.text === b[index].text);
}

function verify(originalText, patchedText, targetIndex, expected) {
    const before = loadPlaylist(originalText, 'playlist.js (before)');
    const after = loadPlaylist(patchedText, 'playlist.js (after)');
    if (before.length !== after.length) fail('verification failed: the number of tracks changed.');

    before.forEach((track, index) => {
        if (index !== targetIndex && JSON.stringify(track) !== JSON.stringify(after[index])) {
            fail(`verification failed: track ${index + 1} (${track.file}) changed unexpectedly.`);
        }
    });

    const target = after[targetIndex];
    if (!Array.isArray(target.lyrics) || !sameLyrics(target.lyrics, expected.lyrics)) {
        fail(`verification failed: the lyrics for ${target.file} did not round-trip.`);
    }
    if (target.title !== expected.title) {
        // The title is not written, but it is worth flagging a mismatched entry.
        console.log(`  note: entry title "${expected.title || '(none)'}" differs from playlist title "${target.title}"; matched by file name.`);
    }
    const beforeTarget = before[targetIndex];
    if (JSON.stringify({ ...beforeTarget, lyrics: [] }) !== JSON.stringify({ ...target, lyrics: [] })) {
        fail(`verification failed: fields other than lyrics changed for ${target.file}.`);
    }
}

// ---------- main ----------

const playlistText = fs.readFileSync(playlistPath, 'utf8');
const tracks = loadPlaylist(playlistText, 'playlist.js');

const reports = [];
const seenFiles = new Set();
let patchedText = playlistText;
let changed = 0;

inputFiles.forEach(input => {
    const sourcePath = path.resolve(process.cwd(), input);
    if (!fs.existsSync(sourcePath)) fail(`${input} does not exist.`);
    const sourceText = fs.readFileSync(sourcePath, 'utf8');
    const entry = /\.lrc$/i.test(input)
        ? entryFromLrc(input, sourceText, tracks)
        : parseEntry(sourceText, path.basename(input));
    const key = normalizeFile(entry.file);

    if (seenFiles.has(key)) fail(`${input} targets ${entry.file}, which another file in this run also targets.`);
    seenFiles.add(key);

    const index = tracks.findIndex(track => normalizeFile(track.file) === key);
    if (index < 0) fail(`no track in playlist.js uses "${entry.file}".`);

    const existing = Array.isArray(tracks[index].lyrics) ? tracks[index].lyrics : [];
    const beforeCount = existing.length;
    if (sameLyrics(existing, entry.lyrics)) {
        reports.push({ input, file: tracks[index].file, beforeCount, afterCount: entry.lyrics.length, unchanged: true });
        return;
    }

    const nextText = replaceLyrics(patchedText, tracks[index].file, entry.lyrics);
    const target = loadPlaylist(nextText, 'playlist.js (after)')[index];
    if (!sameLyrics(target.lyrics, entry.lyrics)) {
        fail(`verification failed for ${tracks[index].file}.`);
    }
    if (nextText === patchedText) {
        fail(`could not rewrite the lyrics block for ${tracks[index].file}.`);
    }

    verify(patchedText, nextText, index, { title: entry.title || tracks[index].title, lyrics: entry.lyrics });
    patchedText = nextText;
    changed += 1;
    reports.push({ input, file: tracks[index].file, beforeCount, afterCount: entry.lyrics.length });
});

reports.forEach(report => {
    console.log(`${report.input} → ${report.file}`);
    if (report.unchanged) {
        console.log(`  already up to date: ${report.afterCount} lyric line${report.afterCount === 1 ? '' : 's'}`);
    } else {
        console.log(`  lyrics: ${report.beforeCount} → ${report.afterCount}${report.afterCount ? '' : ' (cleared)'}`);
    }
});

if (!changed) {
    console.log('\nNothing to write.');
} else if (write) {
    fs.writeFileSync(playlistPath, patchedText, 'utf8');
    console.log(`\nWrote playlist.js — ${changed} entr${changed === 1 ? 'y' : 'ies'} updated.`);
} else {
    console.log(`\nDry run: playlist.js was not changed. Re-run with --write to save ${changed === 1 ? 'this entry' : 'these entries'}.`);
}
