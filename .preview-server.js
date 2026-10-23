const http = require('http');
const fs = require('fs');
const path = require('path');

const root = __dirname;
const port = Number(process.env.PORT) || 8141;
const types = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.webmanifest': 'application/manifest+json',
    '.mp3': 'audio/mpeg',
    '.jpg': 'image/jpeg',
    '.png': 'image/png',
    '.ico': 'image/x-icon'
};

http.createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const file = path.join(root, urlPath === '/' ? 'index.html' : urlPath);
    if (!file.startsWith(root)) return res.writeHead(403).end();
    fs.stat(file, (err, stat) => {
        if (err || !stat.isFile()) return res.writeHead(404, { 'Cache-Control': 'no-store' }).end('not found');
        const headers = {
            'Content-Type': types[path.extname(file).toLowerCase()] || 'application/octet-stream',
            'Cache-Control': 'no-store',
            'Accept-Ranges': 'bytes',
            'Content-Length': stat.size
        };
        const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
        if (range) {
            const start = range[1] ? Number(range[1]) : 0;
            const end = range[2] ? Number(range[2]) : stat.size - 1;
            headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
            headers['Content-Length'] = end - start + 1;
            res.writeHead(206, headers);
            fs.createReadStream(file, { start, end }).pipe(res);
            return;
        }
        res.writeHead(200, headers);
        fs.createReadStream(file).pipe(res);
    });
}).listen(port, '127.0.0.1', () => console.log(`serving ${root} on http://127.0.0.1:${port}`));
