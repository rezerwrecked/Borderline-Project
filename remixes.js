// Album definitions for the Tracks panel. Cards appear in this order.
//
// Each album lists its tracks in play order. A track can be:
//   - a file name from playlist.js, e.g. "love.mp3". Title, artist, duration,
//     byte count and lyrics are read from playlist.js; or
//   - a full object in the same shape as a playlist entry, for audio that is
//     not in the main playlist.
//
// `art` is the square cover shown in the player and on the album card. `thumb` is
// an optional 160 px version used by the album tabs; without one the full art is
// loaded there too. `background` and `backgroundTall` are optional page
// backgrounds (desktop and phone); they default to bg-wide.webp and bg-tall.webp.
// `accent` is an optional #rrggbb colour for the play button, active rows and
// lyrics, browser chrome; without it the emerald theme is used. Albums with no
// tracks are hidden. Keep each id stable: it is used in shared links
// (?album=<id>) and in the saved session.
window.myAlbums = [
    {
        id: 'borderline',
        title: 'Borderline',
        art: 'cover1.webp',
        thumb: 'cover1-thumb.webp',
        background: 'bg-wide.webp',
        backgroundTall: 'bg-tall.webp',
        tracks: [
            'sad song.mp3',
            'hymn.mp3',
            'chasin.mp3',
            'deep ii.mp3',
            'enough.mp3',
            'instagramification.mp3',
            'bender.mp3',
            'silence.mp3',
            'sixfeet.mp3',
            'high.mp3',
            'deep.mp3',
            'broken.mp3',
            'exist.mp3',
            'reason.mp3',
            'split.mp3',
            'tides.mp3',
            'wwid.mp3'
        ]
    },
    {
        id: 'extras',
        title: 'Extras',
        art: 'remix-cover.webp',
        thumb: 'remix-cover-thumb.webp',
        background: 'remix-bg.webp',
        backgroundTall: 'remix-bg-tall.webp',
        tracks: [
            'love.mp3',
            'run.mp3'
        ]
    },
    {
        id: 'instrumentals',
        title: 'Instrumentals',
        art: 'bg2-cover.webp',
        thumb: 'bg2-cover-thumb.webp',
        background: 'bg2-wide.webp',
        // No tall banner for this one; the square cover crops better on a phone
        // than the very wide banner would.
        backgroundTall: 'bg2-cover.webp',
        accent: '#e4bc78',
        tracks: [
            'end.mp3',
            'sun.mp3',
            'upside.mp3',
            'zoro.mp3',
            'dementia.mp3'
        ]
    }

    // A remix album, for reference:
    // {
    //     id: 'remixes',
    //     title: 'Detroit House Remix',
    //     art: 'remix-cover.webp',
    //     thumb: 'remix-cover-thumb.webp',
    //     background: 'remix-bg.webp',
    //     backgroundTall: 'remix-bg-tall.webp',
    //     tracks: [
    //         { title: 'Silence (Detroit Remix)', artist: 'Borderline', file: 'silence-remix.mp3', lyrics: [] }
    //     ]
    // }
];
