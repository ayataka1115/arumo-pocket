/* 手元確認用の静的サーバー。node serve.mjs <root> <port> */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';

const root = process.argv[2] || process.cwd();
const port = Number(process.argv[3] || 5178);
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
};

createServer(async (req, res) => {
  try {
    const url = decodeURIComponent(req.url.split('?')[0]);
    let p = join(root, normalize(url).replace(/^(\.\.[/\\])+/, ''));
    if ((await stat(p).catch(() => null))?.isDirectory()) p = join(p, 'index.html');
    const body = await readFile(p);
    res.writeHead(200, {
      'content-type': TYPES[extname(p)] || 'application/octet-stream',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',   // GASエディタのページから fetch できるように
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  }
}).listen(port, '0.0.0.0', () => console.log(`serving ${root} on http://localhost:${port}`));
