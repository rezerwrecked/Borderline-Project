# Borderline Project

A static music player with synced lyrics, multiple albums, offline playback and a
separate lyric-timing studio. There is no JavaScript build step: the files are
served as they are, and a service worker caches the shell and audio for offline
use. Artwork is generated once from `image-masters/` by a small script.

## Running locally

Serve the directory over HTTP; the service worker needs an HTTP origin (plain
`file://` works for playback but not offline caching).

```sh
npx serve .
# or
python -m http.server 8000
```

Then open `index.html` (or `/`). The lyric editor is at `lyrics-editor.html`.

## Layout

| File | Purpose |
| --- | --- |
| `index.html` | Player, album switcher, search, offline downloads |
| `playlist.js` | The library: every track's title, artist, file, duration, bytes and lyrics |
| `remixes.js` | Album definitions: which tracks belong together, plus artwork |
| `lyrics-editor.html` | Stamp timings, import/export LRC, copy playlist entries |
| `sw.js` | App-shell and audio caches, Range responses for offline seeking |
| `tailwind.css` | Precompiled utility subset used by the page |
| `music/` | Audio files referenced by `playlist.js` |
| `image-masters/` | Original JPEG/PNG artwork; not loaded by the site |
| `tools/check-playlist.js` | Validates tracks, lyrics, albums and artwork |
| `tools/optimize-images.js` | Regenerates WebP art, thumbnails and icons from `image-masters/` |
| `tools/apply-lyrics.js` | Writes timings from the editor (or `.lrc`) into `playlist.js` |

## Albums

`playlist.js` remains the single library. `remixes.js` only groups its tracks:

```js
{
    id: 'extras',
    title: 'Extras',
    art: 'remix-cover.webp',
    thumb: 'remix-cover-thumb.webp', // optional 160 px tab image
    background: 'remix-bg.webp',
    backgroundTall: 'remix-bg-tall.webp',
    accent: '#e4bc78', // optional
    tracks: ['love.mp3', 'run.mp3']
}
```

- `tracks` entries can be file names from `playlist.js`, or full track objects for
  audio that is not in the library. Unknown names are skipped with a console
  warning rather than breaking the switcher.
- `art`, `background` and `backgroundTall` default to `cover1.webp`,
  `bg-wide.webp` and `bg-tall.webp`. `thumb` falls back to `art`, so custom
  albums still work without a separate tab image.
- Artwork and backgrounds are WebP. `image-masters/` keeps the original JPEGs
  and PNGs; the service worker only caches the optimised files.
- `accent` recolours the play button, active rows, active lyrics and browser
  chrome; without it the emerald theme is used.
- Ids must be unique. Empty albums are hidden. The id is used in shared links
  (`?album=extras&track=love`) and in the saved session, so keep it stable.
- Albums are checked against `playlist.js`, their images and their ids by
  `tools/check-playlist.js`.

Album art sits in a square frame; backgrounds are wide desktop images with an
optional tall phone version. The album tabs use the optional 160 px `thumb`
where one exists, keeping the full cover out of the sidebar's first load.

## Images

`image-masters/` holds the full-size JPEG/PNG sources; the site only loads the
derived WebP files and icons. After adding or replacing a master:

```sh
node tools/optimize-images.js           # write the derived files
node tools/optimize-images.js --check   # fail if one is missing or stale
```

Square sources become a WebP cover plus `<name>-thumb.webp` at 160×160; other
sources become a WebP background. `icon-*` and `apple-touch-icon` stay PNG for
iOS and are palette-optimised. The script prints the size change for every
file; it needs `ffmpeg` and `ffprobe` on `PATH`. It cannot tell which albums use
a new image, so add newly referenced files to `SHELL_FILES` and bump
`SHELL_CACHE` in `sw.js` afterwards.

## Lyrics

Open `lyrics-editor.html`, choose a track, paste the lyrics one line per row,
press Play, and press **Space** as each line starts. `⌫` removes the last stamp,
←/→ seek five seconds and `P` toggles playback. Click a stamped line to change
its time, or type an exact time. Work is saved per track in `localStorage`.

The studio can import and export standard `.lrc` files. Importing one file
replaces the current track's timings; selecting several at once matches each
file to a track by file name (`run.lrc` → `run.mp3`). Untimed lyrics can still be
exported as the editor's JS entry format.

To write timings into the site, copy or download the playlist entry, then:

```sh
node tools/apply-lyrics.js lyrics-run.txt            # preview
node tools/apply-lyrics.js lyrics-run.txt --write    # save
node tools/apply-lyrics.js run.lrc --write           # standard LRC
```

Only the target track's `lyrics` array is replaced; every other field and the
rest of the file stay byte-for-byte unchanged. The script verifies the result
before writing and refuses to write if any input is invalid.

## Checks

```sh
node tools/check-playlist.js            # report problems
node tools/check-playlist.js --write    # also refresh duration and bytes
```

It checks audio files, byte counts and durations (via `ffprobe` when
available), lyric order and text, duplicate track files, unreferenced audio,
and every album's ids, track references and artwork. Missing or oversized
artwork (over 1 MB), non-square covers, bad album references and duplicate
album ids are warnings; structural problems are errors that exit 1.

## Service worker

The shell is network-first so edits appear on the next load; images are
cache-first. When you change `index.html`, CSS, JS or shell images:

1. Add any new image to `SHELL_FILES` in `sw.js`.
2. Bump `SHELL_CACHE` (`borderline-shell-vN` → `vN+1`) so installed clients
   refresh their cached copy. Old shell caches are removed on activate; the
   audio cache is kept so downloaded tracks survive updates.

## Keyboard shortcuts

| Keys | Action |
| --- | --- |
| `Space` or `K` | Play / pause |
| `←` / `→` | Seek 5 seconds |
| `Shift` + `←` / `→` | Previous / next track |
| `↑` / `↓` | Volume |
| `M` | Mute |
| `?` | Show the shortcut help |

## Media controls

Playback appears in the operating system's media panel, the lock screen and
headphone controls through the Media Session API. The current title, artist,
album and square cover are published there, and play/pause, previous/next,
5-second skips and scrubbing all act on the same player. Previous restarts the
current track when it has been playing for more than three seconds.

## Deployment

Upload the directory to any static host over HTTPS. No server-side runtime is
required; `sw.js` and the relative paths assume the site is served from the
directory root (or adjust the scope accordingly).
