#!/usr/bin/env node
// Regenerates the artwork the site serves from the full-size sources in
// image-masters/. Covers and backgrounds become WebP, square sources also get
// a 160 px tab thumbnail, and PWA icons stay PNG (for iOS) but are reduced to a
// palette. The masters are never modified.
//
//   node tools/optimize-images.js           write the derived files
//   node tools/optimize-images.js --check   report missing or stale files
//
// Needs ffmpeg and ffprobe on PATH. The encoder settings match the files in the
// repository: WebP quality 82 for covers and 78 elsewhere, 160x160 thumbnails
// and 256-colour icons.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const mastersDir = path.join(root, 'image-masters');
const checkOnly = process.argv.includes('--check');
const help = process.argv.includes('--help') || process.argv.includes('-h');

const COVER_QUALITY = 82;
const IMAGE_QUALITY = 78;
const THUMB_SIZE = 160;
const THUMB_QUALITY = 78;
const ICON_COLORS = 256;
const SOURCE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png']);

function fail(message) {
    console.error(`error: ${message}`);
    process.exit(1);
}

function formatBytes(bytes) {
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
    if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${bytes} B`;
}

function formatChange(before, after) {
    if (!before) return `new ${formatBytes(after)}`;
    const saved = before - after;
    if (saved === 0) return 'unchanged';
    if (saved < 0) return `+${formatBytes(-saved)}`;
    return `-${formatBytes(saved)} (${Math.round((saved / before) * 100)}%)`;
}

function run(command, args) {
    const result = spawnSync(command, args, { encoding: 'utf8' });
    if (result.error && result.error.code === 'ENOENT') {
        fail(`${command} was not found on PATH. Install ffmpeg to run this script.`);
    }
    if (result.status !== 0) {
        const detail = (result.stderr || result.stdout || '').trim();
        throw new Error(`${command} failed${detail ? `: ${detail.split('\n').pop()}` : ''}`);
    }
    return result.stdout;
}

function probeSize(file) {
    const output = run('ffprobe', [
        '-v', 'error',
        '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height',
        '-of', 'csv=s=x:p=0',
        file
    ]).trim();
    const match = /^(\d+)x(\d+)$/.exec(output);
    return match ? { width: Number(match[1]), height: Number(match[2]) } : null;
}

function encodeWebp(source, destination, quality, scale) {
    const args = ['-loglevel', 'error', '-y', '-i', source];
    if (scale) args.push('-vf', `scale=${scale}:${scale}:flags=lanczos`);
    args.push('-c:v', 'libwebp', '-quality', String(quality), '-compression_level', '6', destination);
    run('ffmpeg', args);
}

function encodeIcon(source, destination) {
    run('ffmpeg', [
        '-loglevel', 'error', '-y', '-i', source,
        '-vf', `format=rgba,split[a][b];[a]palettegen=max_colors=${ICON_COLORS}:stats_mode=full[p];[b][p]paletteuse=dither=sierra2_4a`,
        destination
    ]);
}

function isIcon(name) {
    return /^icon-/i.test(name) || /^apple-touch-icon/i.test(name);
}

function stemOf(file) {
    return path.basename(file, path.extname(file));
}

function fileSize(file) {
    return fs.existsSync(file) ? fs.statSync(file).size : null;
}

// Writes via a temporary name in the destination directory so an interrupted
// or failed encode never replaces a working asset with a truncated one.
function writeAtomically(destination, encode) {
    const temporary = path.join(path.dirname(destination), `.optimize-${path.basename(destination)}`);
    try {
        encode(temporary);
        if (!fs.existsSync(temporary) || fs.statSync(temporary).size === 0) {
            throw new Error(`encoder produced no output for ${path.basename(destination)}`);
        }
        try {
            fs.renameSync(temporary, destination);
        } catch (error) {
            // Windows can refuse to replace an existing destination; everything
            // else is a real error and should not delete the working asset.
            if (error.code !== 'EEXIST' && error.code !== 'EPERM') throw error;
            fs.rmSync(destination, { force: true });
            fs.renameSync(temporary, destination);
        }
    } catch (error) {
        fs.rmSync(temporary, { force: true });
        throw error;
    }
}

function addOutput(outputs, sourceName, destination, kind) {
    const previous = fileSize(destination);
    outputs.push({
        sourceName,
        destination,
        kind,
        previous,
        stale: previous != null && fs.statSync(path.join(mastersDir, sourceName)).mtimeMs > fs.statSync(destination).mtimeMs
    });
}

function main() {
    if (help) {
        console.log('Usage: node tools/optimize-images.js [--check]\n');
        console.log('Regenerates WebP covers/backgrounds, 160 px thumbnails and palette');
        console.log('PWA icons from image-masters/. --check only verifies the outputs.');
        return;
    }
    if (!fs.existsSync(mastersDir) || !fs.statSync(mastersDir).isDirectory()) {
        fail('image-masters/ was not found next to index.html.');
    }

    const masters = fs.readdirSync(mastersDir)
        .filter(name => SOURCE_EXTENSIONS.has(path.extname(name).toLowerCase()))
        .filter(name => !name.startsWith('.'))
        .sort();

    if (!masters.length) fail('image-masters/ contains no JPEG or PNG files.');

    // Fail early with a clear message instead of halfway through the run.
    run('ffmpeg', ['-version']);
    run('ffprobe', ['-version']);

    const outputs = [];
    masters.forEach(name => {
        const source = path.join(mastersDir, name);
        const dimensions = probeSize(source);
        if (!dimensions) {
            console.warn(`warning: ${name} has no video stream; skipped`);
            return;
        }

        const base = stemOf(name);
        if (isIcon(name)) {
            addOutput(outputs, name, path.join(root, `${base}.png`), 'icon');
            return;
        }

        const square = Math.abs(dimensions.width - dimensions.height) < 2;
        addOutput(outputs, name, path.join(root, `${base}.webp`), square ? 'cover' : 'background');
        if (square) {
            addOutput(outputs, name, path.join(root, `${base}-thumb.webp`), 'thumb');
        }
    });

    const missing = outputs.filter(output => output.previous == null);
    const stale = outputs.filter(output => output.previous != null && output.stale);

    if (checkOnly) {
        [...missing, ...stale].forEach(output => {
            console.log(`${output.previous == null ? 'missing' : 'stale'}  ${output.sourceName} -> ${path.basename(output.destination)}`);
        });
        if (missing.length || stale.length) {
            console.error(`\n${missing.length} missing and ${stale.length} stale file(s). Run: node tools/optimize-images.js`);
            process.exit(1);
        }
        console.log(`All ${outputs.length} derived images are up to date.`);
        return;
    }

    let written = 0;
    outputs.forEach(output => {
        try {
            if (output.kind === 'thumb') {
                writeAtomically(output.destination, temporary => encodeWebp(
                    path.join(mastersDir, output.sourceName), temporary, THUMB_QUALITY, THUMB_SIZE
                ));
            } else if (output.kind === 'icon') {
                writeAtomically(output.destination, temporary => encodeIcon(
                    path.join(mastersDir, output.sourceName), temporary
                ));
            } else {
                writeAtomically(output.destination, temporary => encodeWebp(
                    path.join(mastersDir, output.sourceName), temporary,
                    output.kind === 'cover' ? COVER_QUALITY : IMAGE_QUALITY
                ));
            }
            written += 1;
        } catch (error) {
            fail(error.message);
        }
    });

    const newFiles = outputs.filter(output => output.previous == null).length;
    const beforeTotal = outputs.reduce((sum, output) => sum + (output.previous || 0), 0);
    const afterTotal = outputs.reduce((sum, output) => sum + (fileSize(output.destination) || 0), 0);

    console.log(`Regenerated ${written} file(s) from ${masters.length} master(s).\n`);
    outputs.forEach(output => {
        const after = fileSize(output.destination) || 0;
        const label = `${output.sourceName} -> ${path.basename(output.destination)}`;
        console.log(`${label.padEnd(46)} ${formatChange(output.previous, after).padStart(18)}  ${formatBytes(after)}`);
    });
    if (newFiles) {
        console.log(`\nDerived images: ${formatBytes(afterTotal)} across ${outputs.length} file(s) (${newFiles} new).`);
    } else {
        const change = beforeTotal ? Math.round((1 - afterTotal / beforeTotal) * 100) : 0;
        const summary = afterTotal === beforeTotal ? 'unchanged'
            : change !== 0 ? `${Math.abs(change)}% ${change > 0 ? 'smaller' : 'larger'}`
                : afterTotal < beforeTotal ? '<1% smaller' : '<1% larger';
        console.log(`\nDerived images: ${formatBytes(beforeTotal)} -> ${formatBytes(afterTotal)} (${summary}).`);
    }
    console.log('Add any newly referenced image to SHELL_FILES in sw.js and bump SHELL_CACHE.');
}

main();
