const fs = require('fs');
const path = require('path');
const fetch = globalThis.fetch || require('node-fetch');
const { PNG } = require('pngjs');
const QRCode = require('qrcode');

const loadDotEnv = () => {
  [path.join(__dirname, '.env'), path.join(__dirname, '..', '.env')]
    .filter((filePath) => fs.existsSync(filePath))
    .forEach((filePath) => {
      fs.readFileSync(filePath, 'utf8')
        .split(/\r?\n/)
        .forEach((line) => {
          const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
          if (!match) return;
          const [, key, rawValue] = match;
          if (process.env[key]) return;
          process.env[key] = rawValue.replace(/^['"]|['"]$/g, '');
        });
    });
};

loadDotEnv();

const env = {
  port: Number(process.env.PORT || 8791),
  clientId: process.env.SPOTIFY_CLIENT_ID,
  clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
  allowedOrigin: process.env.ALLOWED_ORIGIN || 'https://renaogift.com',
  publicBaseUrl: process.env.PUBLIC_BASE_URL || '',
};

const tokenCache = {
  accessToken: '',
  expiresAt: 0,
};

const shortLinksPath = process.env.SHORT_LINKS_PATH || path.join(__dirname, 'short-links.json');
let shortLinks = { urls: {}, codes: {} };

const loadShortLinks = () => {
  if (!fs.existsSync(shortLinksPath)) return;

  try {
    const parsed = JSON.parse(fs.readFileSync(shortLinksPath, 'utf8'));
    if (parsed && typeof parsed === 'object') {
      shortLinks = {
        urls: parsed.urls && typeof parsed.urls === 'object' ? parsed.urls : {},
        codes: parsed.codes && typeof parsed.codes === 'object' ? parsed.codes : {},
      };
    }
  } catch (error) {
    console.warn('Short link dosyasi okunamadi.', error.message);
  }
};

const saveShortLinks = () => {
  fs.writeFileSync(shortLinksPath, JSON.stringify(shortLinks, null, 2));
};

const makeShortCode = (target) => {
  let hash = 2166136261;
  String(target).split('').forEach((character) => {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  });
  return Math.abs(hash >>> 0).toString(36).slice(0, 7);
};

const getPublicBaseUrl = (req, origin) => {
  if (env.publicBaseUrl) return env.publicBaseUrl.replace(/\/$/, '');
  const host = req.headers.host || `127.0.0.1:${env.port}`;
  const isLocalOrigin = (() => {
    try {
      return ['127.0.0.1', 'localhost'].includes(new URL(origin || '').hostname);
    } catch (error) {
      return false;
    }
  })();

  if (origin && !isLocalOrigin) return origin.replace(/\/$/, '');
  return `http://${host}`;
};

const createShortLink = (target, req, origin) => {
  const normalizedTarget = String(target || '').trim();
  if (!/^https?:\/\//i.test(normalizedTarget)) return '';
  if (shortLinks.urls[normalizedTarget]) {
    return `${getPublicBaseUrl(req, origin)}/apps/renao-spotify/r/${shortLinks.urls[normalizedTarget]}`;
  }

  let code = makeShortCode(normalizedTarget);
  let suffix = 0;
  while (shortLinks.codes[code] && shortLinks.codes[code] !== normalizedTarget) {
    suffix += 1;
    code = `${makeShortCode(`${normalizedTarget}:${suffix}`)}`;
  }

  shortLinks.urls[normalizedTarget] = code;
  shortLinks.codes[code] = normalizedTarget;
  saveShortLinks();
  return `${getPublicBaseUrl(req, origin)}/apps/renao-spotify/r/${code}`;
};

loadShortLinks();

const send = (res, status, body, headers = {}) => {
  res.writeHead(status, headers);
  res.end(body);
};

const sendJson = (res, status, payload, origin) => {
  send(res, status, JSON.stringify(payload), {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': origin || env.allowedOrigin,
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store',
  });
};

const sendPng = (res, status, buffer, origin) => {
  send(res, status, buffer, {
    'Content-Type': 'image/png',
    'Access-Control-Allow-Origin': origin || env.allowedOrigin,
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'public, max-age=86400',
  });
};

const sendSvg = (res, status, body, origin) => {
  send(res, status, body, {
    'Content-Type': 'image/svg+xml; charset=utf-8',
    'Access-Control-Allow-Origin': origin || env.allowedOrigin,
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'public, max-age=86400',
  });
};

const readJsonResponse = async (response, fallbackMessage) => {
  const text = await response.text();
  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch (error) {
    const message = text.replace(/\s+/g, ' ').trim().slice(0, 180);
    throw new Error(message || fallbackMessage);
  }
};

const getSpotifyToken = async () => {
  if (!env.clientId || !env.clientSecret) {
    throw new Error('Spotify env degerleri eksik.');
  }

  if (tokenCache.accessToken && tokenCache.expiresAt > Date.now() + 60_000) {
    return tokenCache.accessToken;
  }

  const auth = Buffer.from(`${env.clientId}:${env.clientSecret}`).toString('base64');
  const response = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams({ grant_type: 'client_credentials' }).toString(),
  });

  const data = await readJsonResponse(response, 'Spotify token cevabi okunamadi.');

  if (!response.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || 'Spotify token alinamadi.');
  }

  tokenCache.accessToken = data.access_token;
  tokenCache.expiresAt = Date.now() + Math.max(Number(data.expires_in || 3600) - 60, 60) * 1000;

  return tokenCache.accessToken;
};

const pickArtwork = (images = []) => {
  const sorted = [...images].sort((left, right) => Math.abs((left.width || 0) - 80) - Math.abs((right.width || 0) - 80));
  return sorted[0]?.url || images[0]?.url || '';
};

const mapTrack = (track) => ({
  id: track.id,
  provider: 'Spotify',
  spotifyUri: track.uri || (track.id ? `spotify:track:${track.id}` : ''),
  spotifyUrl: track.external_urls?.spotify || '',
  trackName: track.name || '',
  artistName: Array.isArray(track.artists) ? track.artists.map((artist) => artist.name).filter(Boolean).join(', ') : '',
  trackTimeMillis: track.duration_ms || 0,
  artworkUrl60: pickArtwork(track.album?.images || []),
});

const searchTracks = async (query) => {
  const token = await getSpotifyToken();
  const params = new URLSearchParams({
    q: query,
    type: 'track',
    limit: '8',
    market: 'TR',
  });

  const response = await fetch(`https://api.spotify.com/v1/search?${params.toString()}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  });

  const data = await readJsonResponse(response, 'Spotify arama cevabi okunamadi.');

  if (!response.ok) {
    throw new Error(data.error?.message || 'Spotify aramasi yapilamadi.');
  }

  return Array.isArray(data.tracks?.items) ? data.tracks.items.map(mapTrack) : [];
};

const normalizeSpotifyUri = (value) => {
  const uri = String(value || '').trim();
  if (/^spotify:track:[A-Za-z0-9]+$/.test(uri)) return uri;

  try {
    const url = new URL(uri);
    if (!url.hostname.includes('spotify.com')) return '';
    const match = url.pathname.match(/\/track\/([A-Za-z0-9]+)/);
    return match ? `spotify:track:${match[1]}` : '';
  } catch (error) {
    return '';
  }
};

const normalizeCodeSize = (value) => {
  const size = Number(value || 1280);
  if (!Number.isFinite(size)) return 1280;
  return Math.min(1280, Math.max(640, Math.round(size)));
};

const normalizeQrSize = (value) => {
  const size = Number(value || 960);
  if (!Number.isFinite(size)) return 960;
  return Math.min(1280, Math.max(480, Math.round(size)));
};

const paintPixel = (png, x, y, alpha = 255) => {
  if (x < 0 || y < 0 || x >= png.width || y >= png.height) return;
  const index = (png.width * y + x) * 4;
  png.data[index] = 24;
  png.data[index + 1] = 22;
  png.data[index + 2] = 20;
  png.data[index + 3] = alpha;
};

const clearPixel = (png, x, y) => {
  if (x < 0 || y < 0 || x >= png.width || y >= png.height) return;
  const index = (png.width * y + x) * 4;
  png.data[index + 3] = 0;
};

const paintRoundedRect = (png, left, top, width, height, radius, alpha = 255) => {
  const right = left + width - 1;
  const bottom = top + height - 1;
  const r = Math.max(0, radius);

  for (let y = Math.floor(top); y <= Math.ceil(bottom); y += 1) {
    for (let x = Math.floor(left); x <= Math.ceil(right); x += 1) {
      const dx = x < left + r ? left + r - x : x > right - r ? x - (right - r) : 0;
      const dy = y < top + r ? top + r - y : y > bottom - r ? y - (bottom - r) : 0;
      if ((dx * dx) + (dy * dy) <= r * r + 0.5) paintPixel(png, x, y, alpha);
    }
  }
};

const paintCircle = (png, centerX, centerY, radius, alpha = 255) => {
  const r = Math.max(0, radius);
  for (let y = Math.floor(centerY - r); y <= Math.ceil(centerY + r); y += 1) {
    for (let x = Math.floor(centerX - r); x <= Math.ceil(centerX + r); x += 1) {
      const dx = x - centerX;
      const dy = y - centerY;
      if ((dx * dx) + (dy * dy) <= r * r + 0.5) paintPixel(png, x, y, alpha);
    }
  }
};

const paintQuadraticStroke = (png, start, control, end, width) => {
  const steps = 72;
  const radius = Math.max(1, width / 2);
  for (let index = 0; index <= steps; index += 1) {
    const t = index / steps;
    const mt = 1 - t;
    const x = (mt * mt * start[0]) + (2 * mt * t * control[0]) + (t * t * end[0]);
    const y = (mt * mt * start[1]) + (2 * mt * t * control[1]) + (t * t * end[1]);
    paintCircle(png, x, y, radius);
  }
};

const clearRoundedRect = (png, left, top, width, height, radius) => {
  const right = left + width - 1;
  const bottom = top + height - 1;
  const r = Math.max(0, radius);

  for (let y = Math.floor(top); y <= Math.ceil(bottom); y += 1) {
    for (let x = Math.floor(left); x <= Math.ceil(right); x += 1) {
      const dx = x < left + r ? left + r - x : x > right - r ? x - (right - r) : 0;
      const dy = y < top + r ? top + r - y : y > bottom - r ? y - (bottom - r) : 0;
      if ((dx * dx) + (dy * dy) <= r * r + 0.5) clearPixel(png, x, y);
    }
  }
};

const isFinderArea = (x, y, count) => (
  (x < 7 && y < 7)
  || (x >= count - 7 && y < 7)
  || (x < 7 && y >= count - 7)
);

const QR_QUIET_MODULES = 4;
const QR_ACCENT_MODULES = 4;

const paintFinder = (png, moduleLeft, moduleTop, cell) => {
  const outer = cell * 7;
  const middle = cell * 5;
  const inner = cell * 3;
  paintRoundedRect(png, moduleLeft, moduleTop, outer, outer, cell * 1.35);

  for (let y = moduleTop + cell; y < moduleTop + cell + middle; y += 1) {
    for (let x = moduleLeft + cell; x < moduleLeft + cell + middle; x += 1) {
      const index = (png.width * y + x) * 4;
      png.data[index + 3] = 0;
    }
  }

  paintRoundedRect(png, moduleLeft + (cell * 2), moduleTop + (cell * 2), inner, inner, cell * 0.85);
};

const paintQrAccent = (png, cell) => {
  const stroke = Math.max(5, Math.round(cell * 0.62));
  const center = png.width / 2;
  const inset = Math.round(cell * 1.12);
  const half = Math.round(cell * 5.3);
  const sideHalf = Math.round(cell * 5.6);
  const max = png.width - inset;

  paintQuadraticStroke(png, [center - half, inset], [center, inset - cell * 0.72], [center + half, inset], stroke);
  paintQuadraticStroke(png, [center - half, max], [center, max + cell * 0.72], [center + half, max], stroke);
  paintQuadraticStroke(png, [inset, center - sideHalf], [inset - cell * 0.72, center], [inset, center + sideHalf], stroke);
  paintQuadraticStroke(png, [max, center - sideHalf], [max + cell * 0.72, center], [max, center + sideHalf], stroke);
};

const LETTERS = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  C: ['01111', '10000', '10000', '10000', '10000', '10000', '01111'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
};

const drawPixelText = (png, text, startX, startY, scale, tracking = 1) => {
  let cursor = startX;
  String(text).toUpperCase().split('').forEach((letter) => {
    if (letter === ' ') {
      cursor += scale * 4;
      return;
    }

    const glyph = LETTERS[letter];
    if (!glyph) return;
    glyph.forEach((row, rowIndex) => {
      row.split('').forEach((value, colIndex) => {
        if (value !== '1') return;
        paintRoundedRect(
          png,
          cursor + (colIndex * scale),
          startY + (rowIndex * scale),
          scale,
          scale,
          Math.max(1, scale * 0.18)
        );
      });
    });
    cursor += (glyph[0].length + tracking) * scale;
  });
};

const textPixelWidth = (text, scale, tracking = 1) => {
  let width = 0;
  String(text).toUpperCase().split('').forEach((letter) => {
    if (letter === ' ') {
      width += scale * 4;
      return;
    }
    const glyph = LETTERS[letter];
    if (!glyph) return;
    width += (glyph[0].length + tracking) * scale;
  });
  return Math.max(0, width - (tracking * scale));
};

const paintScanMeBadge = (png, centerX, centerY, cell) => {
  const width = Math.round(cell * 10.8);
  const height = Math.round(cell * 8.7);
  const left = Math.round(centerX - width / 2);
  const top = Math.round(centerY - height / 2);
  clearRoundedRect(png, left, top, width, height, Math.round(cell * 1.1));

  const bracket = Math.max(2, Math.round(cell * 0.28));
  const bracketLen = Math.round(cell * 2.1);
  const inset = Math.round(cell * 0.8);
  [
    [left + inset, top + inset, bracketLen, bracket],
    [left + inset, top + inset, bracket, bracketLen],
    [left + width - inset - bracketLen, top + inset, bracketLen, bracket],
    [left + width - inset - bracket, top + inset, bracket, bracketLen],
    [left + inset, top + height - inset - bracket, bracketLen, bracket],
    [left + inset, top + height - inset - bracketLen, bracket, bracketLen],
    [left + width - inset - bracketLen, top + height - inset - bracket, bracketLen, bracket],
    [left + width - inset - bracket, top + height - inset - bracketLen, bracket, bracketLen],
  ].forEach(([x, y, w, h]) => paintRoundedRect(png, x, y, w, h, Math.max(1, bracket / 2)));

  const scanScale = Math.max(2, Math.round(cell * 0.42));
  const meScale = Math.max(3, Math.round(cell * 0.74));
  drawPixelText(png, 'SCAN', Math.round(centerX - textPixelWidth('SCAN', scanScale) / 2), Math.round(centerY - cell * 2.35), scanScale, 1);
  drawPixelText(png, 'ME', Math.round(centerX - textPixelWidth('ME', meScale) / 2), Math.round(centerY - cell * 0.25), meScale, 1);
};

const makeStyledQrCode = async (text, size = 960) => {
  const qr = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const count = qr.modules.size;
  const quietModules = QR_QUIET_MODULES;
  const accentModules = QR_ACCENT_MODULES;
  const moduleOffset = quietModules + accentModules;
  const cell = Math.max(6, Math.floor(normalizeQrSize(size) / (count + (moduleOffset * 2))));
  const outputSize = cell * (count + (moduleOffset * 2));
  const png = new PNG({ width: outputSize, height: outputSize });

  for (let y = 0; y < count; y += 1) {
    for (let x = 0; x < count; x += 1) {
      if (!qr.modules.get(x, y) || isFinderArea(x, y, count)) continue;
      const px = (x + moduleOffset) * cell;
      const py = (y + moduleOffset) * cell;
      const inset = Math.max(0, Math.floor(cell * 0.04));
      paintRoundedRect(
        png,
        px + inset,
        py + inset,
        cell - inset * 2,
        cell - inset * 2,
        Math.max(0, Math.floor(cell * 0.06))
      );
    }
  }

  paintFinder(png, moduleOffset * cell, moduleOffset * cell, cell);
  paintFinder(png, (moduleOffset + count - 7) * cell, moduleOffset * cell, cell);
  paintFinder(png, moduleOffset * cell, (moduleOffset + count - 7) * cell, cell);
  paintQrAccent(png, cell);

  return PNG.sync.write(png);
};

const makeStyledQrSvg = (text, size = 960) => {
  const qr = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const count = qr.modules.size;
  const quietModules = QR_QUIET_MODULES;
  const accentModules = QR_ACCENT_MODULES;
  const moduleOffset = quietModules + accentModules;
  const cell = Math.max(8, Math.floor(normalizeQrSize(size) / (count + (moduleOffset * 2))));
  const outputSize = cell * (count + (moduleOffset * 2));
  const rects = [];

  const addRect = (x, y, width, height, rx = 0) => {
    rects.push(`<rect x="${x}" y="${y}" width="${width}" height="${height}"${rx ? ` rx="${rx}" ry="${rx}"` : ''} fill="#111"/>`);
  };

  const roundedRectPath = (x, y, width, height, radius) => {
    const r = Math.min(radius, width / 2, height / 2);
    const right = x + width;
    const bottom = y + height;
    return `M${x + r} ${y}H${right - r}Q${right} ${y} ${right} ${y + r}V${bottom - r}Q${right} ${bottom} ${right - r} ${bottom}H${x + r}Q${x} ${bottom} ${x} ${bottom - r}V${y + r}Q${x} ${y} ${x + r} ${y}Z`;
  };

  for (let y = 0; y < count; y += 1) {
    for (let x = 0; x < count; x += 1) {
      if (!qr.modules.get(x, y) || isFinderArea(x, y, count)) continue;
      const px = (x + moduleOffset) * cell;
      const py = (y + moduleOffset) * cell;
      addRect(px, py, cell, cell, Math.max(0, Math.floor(cell * 0.08)));
    }
  }

  const finder = (mx, my) => {
    const x = (mx + moduleOffset) * cell;
    const y = (my + moduleOffset) * cell;
    rects.push(`<path d="${roundedRectPath(x, y, cell * 7, cell * 7, cell * 1.05)} ${roundedRectPath(x + cell, y + cell, cell * 5, cell * 5, cell * 0.72)}" fill="#111" fill-rule="evenodd"/>`);
    addRect(x + cell * 2, y + cell * 2, cell * 3, cell * 3, cell * 0.72);
  };

  const accent = () => {
    const stroke = Math.max(5, Math.round(cell * 0.62));
    const center = outputSize / 2;
    const inset = Math.round(cell * 1.12);
    const half = Math.round(cell * 5.3);
    const sideHalf = Math.round(cell * 5.6);
    const max = outputSize - inset;
    rects.push(`
      <g fill="none" stroke="#111" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round">
        <path d="M${center - half} ${inset} Q${center} ${inset - cell * 0.72} ${center + half} ${inset}"/>
        <path d="M${center - half} ${max} Q${center} ${max + cell * 0.72} ${center + half} ${max}"/>
        <path d="M${inset} ${center - sideHalf} Q${inset - cell * 0.72} ${center} ${inset} ${center + sideHalf}"/>
        <path d="M${max} ${center - sideHalf} Q${max + cell * 0.72} ${center} ${max} ${center + sideHalf}"/>
      </g>
    `);
  };

  finder(0, 0);
  finder(count - 7, 0);
  finder(0, count - 7);
  accent();

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${outputSize} ${outputSize}" width="${outputSize}" height="${outputSize}" fill="none">
  <title>Renao QR Code</title>
  <g shape-rendering="geometricPrecision">${rects.join('')}</g>
</svg>`;
};

const makeTransparentSpotifyCode = async (spotifyUri, size = 1280) => {
  const sourceUrl = `https://scannables.scdn.co/uri/plain/png/FFFFFF/black/${normalizeCodeSize(size)}/${spotifyUri}`;
  const response = await fetch(sourceUrl, { headers: { Accept: 'image/png' } });

  if (!response.ok) {
    throw new Error('Spotify kod gorseli alinamadi.');
  }

  const source = Buffer.from(await response.arrayBuffer());
  const png = PNG.sync.read(source);

  for (let index = 0; index < png.data.length; index += 4) {
    const red = png.data[index];
    const green = png.data[index + 1];
    const blue = png.data[index + 2];
    const luminance = Math.round((red * 0.2126) + (green * 0.7152) + (blue * 0.0722));
    const alpha = Math.max(0, Math.min(255, 255 - luminance));

    png.data[index] = 0;
    png.data[index + 1] = 0;
    png.data[index + 2] = 0;
    png.data[index + 3] = alpha < 6 ? 0 : alpha;
  }

  return PNG.sync.write(png);
};

const handleRequest = async (req, res) => {
  const origin = req.headers.origin || env.allowedOrigin;

  if (req.method === 'OPTIONS') {
    sendJson(res, 204, {}, origin);
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const isSearchPath = url.pathname === '/api/spotify/search' || url.pathname === '/search' || url.pathname === '/apps/renao-spotify/search';
  const isCodePath = url.pathname === '/api/spotify/code' || url.pathname === '/code' || url.pathname === '/apps/renao-spotify/code';
  const isQrPath = url.pathname === '/api/spotify/qr' || url.pathname === '/qr' || url.pathname === '/apps/renao-spotify/qr';
  const isShortenPath = url.pathname === '/api/spotify/shorten' || url.pathname === '/shorten' || url.pathname === '/apps/renao-spotify/shorten';
  const shortRedirectMatch = url.pathname.match(/^(?:\/apps\/renao-spotify)?\/r\/([a-z0-9]{4,12})$/i);

  if (req.method === 'GET' && url.pathname === '/health') {
    sendJson(res, 200, { success: true, status: 'ok' }, origin);
    return;
  }

  if ((req.method === 'GET' || req.method === 'HEAD') && shortRedirectMatch) {
    const target = shortLinks.codes[shortRedirectMatch[1]];
    if (!target) {
      sendJson(res, 404, { success: false, error: 'Kisa link bulunamadi.' }, origin);
      return;
    }

    res.writeHead(302, {
      Location: target,
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
    res.end(req.method === 'HEAD' ? undefined : '');
    return;
  }

  if (req.method !== 'GET' || (!isSearchPath && !isCodePath && !isQrPath && !isShortenPath)) {
    sendJson(res, 404, { success: false, error: 'Endpoint bulunamadi.' }, origin);
    return;
  }

  if (isShortenPath) {
    const target = String(url.searchParams.get('url') || '').trim();
    const shortUrl = createShortLink(target, req, origin);
    if (!shortUrl) {
      sendJson(res, 400, { success: false, error: 'Kisaltilacak URL gecersiz.' }, origin);
      return;
    }

    sendJson(res, 200, { success: true, shortUrl }, origin);
    return;
  }

  if (isQrPath) {
    const text = String(url.searchParams.get('text') || '').trim();
    const size = normalizeQrSize(url.searchParams.get('size'));
    const format = String(url.searchParams.get('format') || 'svg').trim().toLowerCase();

    if (!text) {
      sendJson(res, 400, { success: false, error: 'QR metni gerekli.' }, origin);
      return;
    }

    try {
      if (format === 'png') {
        const png = await makeStyledQrCode(text, size);
        sendPng(res, 200, png, origin);
        return;
      }

      const svg = makeStyledQrSvg(text, size);
      sendSvg(res, 200, svg, origin);
    } catch (error) {
      console.error(error);
      sendJson(res, 500, { success: false, error: 'QR gorseli hazirlanamadi.' }, origin);
    }
    return;
  }

  if (isCodePath) {
    const spotifyUri = normalizeSpotifyUri(url.searchParams.get('uri') || '');
    const size = normalizeCodeSize(url.searchParams.get('size'));

    if (!spotifyUri) {
      sendJson(res, 400, { success: false, error: 'Spotify URI gecersiz.' }, origin);
      return;
    }

    try {
      const png = await makeTransparentSpotifyCode(spotifyUri, size);
      sendPng(res, 200, png, origin);
    } catch (error) {
      console.error(error);
      sendJson(res, 500, { success: false, error: 'Spotify kod gorseli hazirlanamadi.' }, origin);
    }
    return;
  }

  const query = String(url.searchParams.get('q') || '').trim();

  if (query.length < 2) {
    sendJson(res, 200, { success: true, tracks: [] }, origin);
    return;
  }

  try {
    const tracks = await searchTracks(query);
    sendJson(res, 200, { success: true, tracks }, origin);
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { success: false, error: 'Spotify aramasi simdi yapilamadi.' }, origin);
  }
};

module.exports = { handleSpotifyRequest: handleRequest };
