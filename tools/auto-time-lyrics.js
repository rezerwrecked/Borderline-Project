#!/usr/bin/env node
'use strict';

// Times lyric lines by itself: whisper.cpp listens to the track, then each of
// your lines is matched to the words it heard, and an .lrc is written. Nothing
// is guessed -- the alignment only asks "where does this line start", so a
// misheard word is skipped instead of shifting everything after it.
//
//   node tools/auto-time-lyrics.js music/high.mp3 high.txt
//   node tools/auto-time-lyrics.js high.mp3 high.txt --out high.lrc
//   node tools/auto-time-lyrics.js high.mp3 high.txt --model small.en
//
// Then review it in lyrics-editor.html (Import .lrc) or write it straight into
// the playlist:
//
//   node tools/apply-lyrics.js high.lrc --write
//
// Requires whisper.cpp's whisper-cli and a ggml model, normally kept in
// .whisper/ (see README). whisper-cli decodes mp3, wav, flac and ogg itself, so
// ffmpeg is not involved.

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const WHISPER_DIR = path.join(PROJECT_ROOT, '.whisper');
const AUDIO_EXTENSIONS = ['.mp3', '.wav', '.flac', '.ogg'];
// Alignment tuning. A pair score at or above MATCH_MIN counts as the same
// word; anything below it is cheaper to treat as two unmatched stretches.
const MATCH_MIN = 0.55;
const GAP_PENALTY = 0.6;
const MISMATCH_PENALTY = 1.2;

const HELP = `Times lyric lines with whisper.cpp forced alignment.

Usage:
  node tools/auto-time-lyrics.js <audio> <lyrics.txt> [options]

Arguments:
  <audio>        track to align, e.g. music/high.mp3 (mp3, wav, flac, ogg)
  <lyrics.txt>   one lyric line per line; blank lines and [Section] tags are
                 ignored. Use - to read the lyrics from stdin.

Options:
  --out <file>        where to write the .lrc (default: <track stem>.lrc)
  --model <name>      model name (base.en, small.en, ...) or a path to a
                      ggml .bin (default: $WHISPER_MODEL, else .whisper/models)
  --whisper <path>    whisper-cli binary (default: $WHISPER_CLI, else .whisper)
  --threads <n>       CPU threads for transcription (default: min(8, cores))
  --lang <code>       spoken language, or auto (default: en)
  --keep-temp         keep whisper's JSON output for inspection
  --quiet             only print errors
  --help              show this help

Exit codes: 0 written, 1 nothing usable, 2 whisper.cpp or the model is missing.
`;

function parseArgs(argv) {
    const options = {
        threads: Math.min(8, Math.max(1, (os.cpus() || []).length)),
        lang: 'en',
        model: null,
        whisper: null,	        out: null,
        keepTemp: false,
        quiet: false,
        help: false,
        inputs: []
    };

    const take = (index, flag) => {
        const value = argv[index + 1];
        if (value == null || value.startsWith('--')) throw new Error(`${flag} needs a value.`);
        return value;
    };

    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--help' || arg === '-h') options.help = true;
        else if (arg === '--out') options.out = take(i++, '--out');
        else if (arg === '--model') options.model = take(i++, '--model');
        else if (arg === '--whisper') options.whisper = take(i++, '--whisper');
        else if (arg === '--threads') options.threads = clampInt(take(i++, '--threads'), 1, 128, '--threads');	        else if (arg === '--lang') options.lang = take(i++, '--lang');
        else if (arg === '--keep-temp') options.keepTemp = true;
        else if (arg === '--quiet') options.quiet = true;
        else if (arg.startsWith('-') && arg !== '-') throw new Error(`Unknown option ${arg}. See --help.`);
        else options.inputs.push(arg);
    }

    return options;
}

function clampInt(value, min, max, flag) {
    const number = Number.parseInt(value, 10);
    if (!Number.isFinite(number) || number < min || number > max) {
        throw new Error(`${flag} must be a number between ${min} and ${max}.`);
    }
    return number;
}

function say(message) {
    process.stdout.write(`${message}\n`);
}

function bail(message, code = 1) {
    const error = new Error(message);
    error.expected = true;
    error.code = code;
    throw error;
}

// ---------------------------------------------------------------- environment

function executable(name) {
    return process.platform === 'win32' ? `${name}.exe` : name;
}

function resolveWhisper(explicit) {
    // An explicit path is a promise to the caller: if it is wrong, say so
    // instead of quietly running a different build.
    for (const [value, label] of [[explicit, '--whisper'], [process.env.WHISPER_CLI, 'WHISPER_CLI']]) {
        if (!value) continue;
        const resolved = path.resolve(value);
        if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) return resolved;
        bail(`whisper-cli was not found at ${value} (from ${label}).`, 2);
    }

    const candidates = [];
    for (const dir of [
        path.join(WHISPER_DIR, 'bin', 'Release'),
        path.join(WHISPER_DIR, 'bin'),
        WHISPER_DIR
    ]) {
        candidates.push(path.join(dir, executable('whisper-cli')));
        candidates.push(path.join(dir, executable('main')));
    }

    for (const candidate of candidates) {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    }

    // Last resort: something already on PATH.
    for (const name of ['whisper-cli', 'main']) {
        const probe = spawnSync(executable(name), ['--help'], { encoding: 'utf8' });
        if (!probe.error) return executable(name);
    }

    bail(
        'whisper-cli was not found.\n' +
        '  Put whisper.cpp\'s release build in .whisper/bin/Release/whisper-cli.exe,\n' +
        '  or pass --whisper <path>, or set WHISPER_CLI. See the README ("Auto-timing").',
        2
    );
}

function resolveModel(explicit) {
    const describe = 'Download a ggml model into .whisper/models (base.en is a good start):\n' +
        '  curl -L -o .whisper/models/ggml-base.en.bin \\\n' +
        '    https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin';

    const wanted = explicit || process.env.WHISPER_MODEL;
    if (wanted) {
        // A plain name means the usual ggml-<name>.bin inside .whisper/models.
        const looksLikePath = wanted.includes('/') || wanted.includes('\\') || /\.bin$/i.test(wanted);
        const resolved = looksLikePath && !/^[a-z0-9._-]+$/i.test(wanted)
            ? path.resolve(wanted)
            : path.join(WHISPER_DIR, 'models', /\.bin$/i.test(wanted) ? wanted : `ggml-${wanted}.bin`);
        if (fs.existsSync(resolved)) return resolved;
        bail(`Model not found: ${resolved}\n${describe}`, 2);
    }

    const modelsDir = path.join(WHISPER_DIR, 'models');
    let found = [];
    try {
        found = fs.readdirSync(modelsDir).filter(name => /\.bin$/i.test(name)).sort();
    } catch (error) {
        bail(`No model directory at ${modelsDir}.\n${describe}`, 2);
    }
    if (!found.length) bail(`No ggml model in ${modelsDir}.\n${describe}`, 2);

    const preferred = found.find(name => /base\.en\.bin$/i.test(name))
        || found.find(name => /small\.en\.bin$/i.test(name))
        || found[0];
    return path.join(modelsDir, preferred);
}

// ------------------------------------------------------------------ listening

function transcribe(whisper, model, audio, options) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-time-'));
    const outBase = path.join(tempDir, 'transcript');
    const args = [
        '-m', model,
        '-f', audio,
        '-ojf',               // JSON with per-token offsets
        '-of', outBase,
        '-np',
        '-t', String(options.threads),
        '-l', options.lang
    ];

    const run = spawnSync(whisper, args, { encoding: 'utf8', maxBuffer: 1 << 28, timeout: 45 * 60 * 1000 });
    const jsonPath = `${outBase}.json`;

    if (run.error) {
        cleanup(tempDir);
        bail(`Could not run ${whisper}: ${run.error.message}`, 2);
    }
    if (!fs.existsSync(jsonPath)) {
        const detail = (run.stderr || run.stdout || '').trim().split(/\r?\n/).slice(-4).join('\n');
        cleanup(tempDir);
        bail(`whisper-cli did not produce a transcript (exit ${run.status}).\n${detail}`);
    }

    const json = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    return { json, tempDir };
}

function cleanup(dir) {
    try {
        fs.rmSync(dir, { recursive: true, force: true });
    } catch (error) {
        // A leftover temp folder is harmless.
    }
}

// Flattens whisper's segments into a list of heard words with start times.
// Per-token offsets give word times inside a phrase; a segment whose tokens
// carry no offsets falls back to spreading its text across the segment.
function heardWords(json) {
    const heard = [];
    const segments = Array.isArray(json && json.transcription) ? json.transcription : [];

    for (const segment of segments) {
        // "(upbeat music)", "(applause)": labels whisper invents for audio it
        // could not transcribe. They are never lyrics.
        const rawText = String((segment && segment.text) || '').trim();
        if (/^[(\[].*[)\]]$/.test(rawText)) continue;

        const rawFrom = Number(segment && segment.offsets && segment.offsets.from);
        const rawTo = Number(segment && segment.offsets && segment.offsets.to);
        if (!Number.isFinite(rawFrom)) continue;
        const segmentStart = Math.max(0, rawFrom / 1000);
        const segmentEnd = Number.isFinite(rawTo) ? Math.max(segmentStart, rawTo / 1000) : segmentStart;

        const words = [];
        const tokens = Array.isArray(segment && segment.tokens) ? segment.tokens : [];
        for (const token of tokens) {
            const text = String((token && token.text) || '').trim();
            // Special markers ([_BEG_], [_TT_250]) and punctuation-only tokens
            // carry no sung word; dropping them keeps "don't" from reading as
            // three separate words.
            if (!text || !/[a-z0-9]/i.test(text) || /^[[_\u266a]/.test(text)) continue;
            const from = Number(token && token.offsets && token.offsets.from);
            words.push({
                text,
                time: Number.isFinite(from) ? Math.max(0, from / 1000) : segmentStart
            });
        }

        if (!words.length) {
            const chunks = String((segment && segment.text) || '')
                .split(/\s+/)
                .filter(chunk => /[a-z0-9]/i.test(chunk));
            chunks.forEach((chunk, index) => {
                words.push({
                    text: chunk,
                    time: segmentStart + ((segmentEnd - segmentStart) * index) / Math.max(1, chunks.length)
                });
            });
        }

        repairCollapsedTimes(words, segmentStart, segmentEnd);
        heard.push(...words);
    }

    return heard;
}

// Whisper occasionally parks an entire phrase on the segment's end time, which
// leaves every word of that phrase at the same instant (and makes the line
// look like it starts when it finishes). The words are somewhere inside the
// segment, so they are spread across it instead.
function repairCollapsedTimes(words, segmentStart, segmentEnd) {
    let index = 0;
    while (index < words.length) {
        const time = words[index].time;
        let runEnd = index;
        while (runEnd + 1 < words.length && Math.abs(words[runEnd + 1].time - time) < 0.02) runEnd += 1;

        if (runEnd > index && Math.abs(time - segmentEnd) < 0.02) {
            const from = index === 0 ? segmentStart : words[index - 1].time + 0.01;
            const span = Math.max(0, segmentEnd - from);
            for (let i = index; i <= runEnd; i += 1) {
                words[i].time = from + (span * (i - index)) / (runEnd - index + 1);
            }
        }

        index = runEnd + 1;
    }
}

// ------------------------------------------------------------------ alignment

function normalizeWord(word) {
    return String(word || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]/g, '');
}

function editDistanceWithin(a, b, limit) {
    if (Math.abs(a.length - b.length) > limit) return limit + 1;
    const previous = new Array(b.length + 1);
    const current = new Array(b.length + 1);
    for (let j = 0; j <= b.length; j += 1) previous[j] = j;

    for (let i = 1; i <= a.length; i += 1) {
        current[0] = i;
        let best = current[0];
        for (let j = 1; j <= b.length; j += 1) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
            if (current[j] < best) best = current[j];
        }
        if (best > limit) return limit + 1;
        for (let j = 0; j <= b.length; j += 1) previous[j] = current[j];
    }
    return previous[b.length];
}

// How much two words look like the same sung word. Whisper mangles sung
// vocals in predictable ways (dropped endings, split words), hence the
// prefix and edit-distance tests instead of plain equality.
function similarity(a, b) {
    if (!a || !b) return -1;
    if (a === b) return 2;
    const short = a.length <= b.length ? a : b;
    const long = a.length <= b.length ? b : a;
    if (short.length >= 3 && long.startsWith(short)) return 1.5;
    if (short.length >= 4 && editDistanceWithin(a, b, 1) <= 1) return 1.2;
    if (short.length >= 5 && a.slice(0, 4) === b.slice(0, 4)) return 0.9;
    if (short.length >= 6 && editDistanceWithin(a, b, 2) <= 2) return 0.7;
    return -1;
}

// Monotonic alignment of lyric words against heard words. Returns the pairs
// the two sequences agree on; everything else is a gap in one of them.
function alignTokens(lyricWords, heardWordsList) {
    const n = lyricWords.length;
    const m = heardWordsList.length;
    const dp = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
    const moves = Array.from({ length: n + 1 }, () => new Uint8Array(m + 1));

    for (let i = 1; i <= n; i += 1) {
        dp[i][0] = dp[i - 1][0] - GAP_PENALTY;
        moves[i][0] = 1;
    }
    for (let j = 1; j <= m; j += 1) {
        dp[0][j] = dp[0][j - 1] - GAP_PENALTY;
        moves[0][j] = 2;
    }

    for (let i = 1; i <= n; i += 1) {
        for (let j = 1; j <= m; j += 1) {
            const score = similarity(lyricWords[i - 1], heardWordsList[j - 1]);
            const pair = score >= MATCH_MIN ? score : -MISMATCH_PENALTY;
            const diagonal = dp[i - 1][j - 1] + pair;
            const up = dp[i - 1][j] - GAP_PENALTY;
            const left = dp[i][j - 1] - GAP_PENALTY;

            if (diagonal >= up && diagonal >= left) {
                dp[i][j] = diagonal;
                moves[i][j] = 0;
            } else if (up >= left) {
                dp[i][j] = up;
                moves[i][j] = 1;
            } else {
                dp[i][j] = left;
                moves[i][j] = 2;
            }
        }
    }

    const pairs = [];
    let i = n;
    let j = m;
    while (i > 0 || j > 0) {
        const move = moves[i][j];
        if (i > 0 && j > 0 && move === 0) {
            const score = similarity(lyricWords[i - 1], heardWordsList[j - 1]);
            if (score >= MATCH_MIN) pairs.push({ lyric: i - 1, heard: j - 1, score });
            i -= 1;
            j -= 1;
        } else if (i > 0 && (j === 0 || move === 1)) {
            i -= 1;
        } else {
            j -= 1;
        }
    }

    return pairs.reverse();
}

// --------------------------------------------------------------- lyric lines

function readLyrics(source) {
    const text = source === '-'
        ? fs.readFileSync(0, 'utf8')
        : fs.readFileSync(path.resolve(source), 'utf8');

    const lines = [];
    String(text).split(/\r?\n/).forEach(raw => {
        const line = raw.trim();
        if (!line) return;
        // [Verse 1], [Chorus] and similar markers are structure, not lyrics.
        if (/^\[[^\]]*\]$/.test(line)) return;
        if (/^#/.test(line)) return;
        lines.push(line);
    });
    return lines;
}

function timeLines(lines, heard) {
    // Flatten the lyric lines into one word sequence, remembering which line
    // each word belongs to.
    const tokens = [];
    const lineOfToken = [];
    lines.forEach((line, index) => {
        line.split(/\s+/).forEach(word => {
            const normalized = normalizeWord(word);
            if (!normalized) return;
            tokens.push(normalized);
            lineOfToken.push(index);
        });
    });

    const heardTokens = heard.map(word => normalizeWord(word.text));
    const pairs = alignTokens(tokens, heardTokens);

    // First heard time per line, from the earliest aligned word of that line.
    const timed = new Array(lines.length).fill(null);
    const matchedTokens = new Set();
    pairs.forEach(pair => {
        const lineIndex = lineOfToken[pair.lyric];
        matchedTokens.add(pair.lyric);
        const time = heard[pair.heard].time;
        if (timed[lineIndex] == null || time < timed[lineIndex]) timed[lineIndex] = time;
    });

    // Lines with no match are spaced between their timed neighbours rather
    // than dropped, so the shape of the song stays intact.
    const untimed = [];
    const timedIndices = timed.map((time, index) => (time == null ? -1 : index)).filter(index => index >= 0);

    if (!timedIndices.length) {
        return { times: timed, matchedTokens: matchedTokens.size, totalTokens: tokens.length, untimed: lines.length };
    }

    const gaps = [];
    for (let i = 1; i < timedIndices.length; i += 1) {
        const gap = timed[timedIndices[i]] - timed[timedIndices[i - 1]];
        if (gap > 0) gaps.push(gap);
    }
    gaps.sort((a, b) => a - b);
    const medianGap = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 2.5;
    const fallbackGap = Math.max(0.6, Math.min(6, medianGap));
    // A missing line is only as far from its neighbour as lines normally are.
    // Across a long gap (whisper missing a whole verse) spreading lines evenly
    // invents timings worse than the plain spacing below.
    const maxStep = Math.max(1.2, fallbackGap * 2);

    timed.forEach((time, index) => {
        if (time != null) return;
        untimed.push(index);

        let before = null;
        let after = null;
        for (let i = index - 1; i >= 0; i -= 1) {
            if (timed[i] != null) { before = i; break; }
        }
        for (let i = index + 1; i < timed.length; i += 1) {
            if (timed[i] != null) { after = i; break; }
        }

        if (before != null && after != null) {
            const span = timed[after] - timed[before];
            const step = span / (after - before);
            timed[index] = step <= maxStep
                ? timed[before] + span * ((index - before) / (after - before))
                : timed[before] + fallbackGap * (index - before);
        } else if (before != null) {
            timed[index] = timed[before] + fallbackGap * (index - before);
        } else {
            timed[index] = Math.max(0, timed[after] - fallbackGap * (after - index));
        }
    });

    // Interpolation and coarse word times can cross; keep the order, and leave
    // a line behind the previous one where it came out.
    let previous = -1;
    timed.forEach((time, index) => {
        let value = Number.isFinite(time) ? time : 0;
        if (value <= previous) value = previous + 0.1;
        previous = value;
        timed[index] = value;
    });

    return { times: timed, matchedTokens: matchedTokens.size, totalTokens: tokens.length, untimed: untimed.length };
}

// -------------------------------------------------------------------- output

function lrcTime(seconds) {
    const safe = Math.max(0, Number(seconds) || 0);
    const minutes = Math.floor(safe / 60);
    const rest = safe - minutes * 60;
    return `${String(minutes).padStart(2, '0')}:${rest.toFixed(2).padStart(5, '0')}`;
}

function playlistInfo(audioPath) {
    const wanted = path.basename(audioPath).toLowerCase();
    try {
        const source = fs.readFileSync(path.join(PROJECT_ROOT, 'playlist.js'), 'utf8');
        const sandbox = { window: {} };
        vm.runInNewContext(source, sandbox, { filename: 'playlist.js', timeout: 2000 });
        const tracks = Array.isArray(sandbox.window.myPlaylist) ? sandbox.window.myPlaylist : [];
        const match = tracks.find(track => path.basename(String(track.file || '')).toLowerCase() === wanted);
        if (match) return { title: match.title || '', artist: match.artist || '' };
    } catch (error) {
        // Metadata is a nicety; a broken playlist must not stop alignment.
    }
    return { title: '', artist: '' };
}

function buildLrc(lines, times, info) {
    const rows = [];
    if (info.title) rows.push(`[ti:${info.title}]`);
    if (info.artist) rows.push(`[ar:${info.artist}]`);
    rows.push('[by:auto-time-lyrics]');
    rows.push('');
    lines.forEach((line, index) => {
        rows.push(`[${lrcTime(times[index])}]${line}`);
    });
    rows.push('');
    return rows.join('\n');
}

// ---------------------------------------------------------------------- main

function main() {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
        process.stdout.write(HELP);
        return 0;
    }

    const [audioArg, lyricsArg] = options.inputs;
    if (!audioArg || !lyricsArg) {
        process.stderr.write(HELP);
        return 1;
    }
    if (options.inputs.length > 2) bail('Pass one audio file and one lyrics file. See --help.');

    const audio = path.resolve(audioArg);
    if (!fs.existsSync(audio)) bail(`Audio file not found: ${audioArg}`);
    const extension = path.extname(audio).toLowerCase();
    if (!AUDIO_EXTENSIONS.includes(extension)) {
        bail(`${path.basename(audio)} is not one of ${AUDIO_EXTENSIONS.join(', ')}; convert it first.`);
    }

    const lines = readLyrics(lyricsArg);
    if (!lines.length) bail(`${lyricsArg} has no lyric lines.`);

    const whisper = resolveWhisper(options.whisper);
    const model = resolveModel(options.model);	    if (!options.quiet) {
        say(`Listening to ${path.basename(audio)} with ${path.basename(model)} (${options.threads} threads)...`);
    }
    const started = Date.now();
    const { json, tempDir } = transcribe(whisper, model, audio, options);
    const heard = heardWords(json);
    if (options.keepTemp) say(`whisper JSON kept in ${tempDir}`);
    else cleanup(tempDir);

    if (!heard.length) {
        bail('Nothing was recognised in this track. Is it an instrumental, or is the vocal too buried to hear?');
    }

    const { times, matchedTokens, totalTokens, untimed } = timeLines(lines, heard);
    if (!matchedTokens) {
        bail(
            `None of the ${totalLinesLabel(lines.length)} matched anything whisper heard.\n` +
            '  Check that the lyrics belong to this recording (a different take or a cover will not align).'
        );
    }

    const outPath = options.out
        ? path.resolve(options.out)
        : path.join(process.cwd(), `${path.basename(audio, extension)}.lrc`);

    const info = playlistInfo(audio);
    fs.writeFileSync(outPath, buildLrc(lines, times, info), 'utf8');

    if (!options.quiet) {
        const elapsed = ((Date.now() - started) / 1000).toFixed(0);
        const matchRate = Math.round((matchedTokens / totalTokens) * 100);
        say('');
        say(`${path.basename(audio)} — ${lines.length} lines in ${elapsed}s`);
        say(`  ${heard.length} words heard, ${matchedTokens}/${totalTokens} lyric words matched (${matchRate}%)`);
        say(`  ${lines.length - untimed} lines timed, ${untimed} interpolated`);
        say('');
        say('First lines:');
        lines.slice(0, 3).forEach((line, index) => say(`  [${lrcTime(times[index])}] ${line}`));
        say('');
        say(`Wrote ${path.relative(PROJECT_ROOT, outPath) || outPath}`);
        say(`Review it in lyrics-editor.html, or apply it:`);
        say(`  node tools/apply-lyrics.js ${path.relative(PROJECT_ROOT, outPath) || outPath} --write`);

        if (matchRate < 50) {
            say('');
            say('Low match rate: re-check the lyrics, or try --model small.en for a better ear.');
        }
    }

    return 0;
}

function totalLinesLabel(count) {
    return count === 1 ? 'line' : `${count} lines`;
}

try {
    process.exitCode = main();
} catch (error) {
    if (!error.expected) throw error;
    process.stderr.write(`\n${error.message}\n`);
    process.exitCode = error.code || 1;
}
