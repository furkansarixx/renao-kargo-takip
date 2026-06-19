const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const TOKEN_STORE = path.join(DATA_DIR, 'shops.json');

const env = {
  port: Number(process.env.PORT || 8787),
  appUrl: String(process.env.APP_URL || '').replace(/\/$/, ''),
  shop: process.env.SHOPIFY_SHOP,
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecret: process.env.SHOPIFY_API_SECRET,
  token: process.env.SHOPIFY_ADMIN_ACCESS_TOKEN,
  apiVersion: process.env.SHOPIFY_API_VERSION || '2026-04',
  scopes: process.env.SHOPIFY_SCOPES || 'read_orders,read_fulfillments',
  allowedOrigin: process.env.ALLOWED_ORIGIN || 'https://renaogift.com',
  defaultCarrier: (process.env.DEFAULT_CARRIER || 'hepsijet').toLowerCase(),
};

const clientCredentialsToken = {
  accessToken: '',
  expiresAt: 0,
};

const safeCompare = (a, b) => {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');

  return left.length === right.length && crypto.timingSafeEqual(left, right);
};

const normalizeShop = (value) => {
  const shop = String(value || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)) return '';
  return shop;
};

const normalizeOrderName = (value) => {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';
  return trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
};

const normalizeEmail = (value) => String(value || '').trim().toLowerCase();

const ensureDataDir = () => {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
};

const readTokenStore = () => {
  try {
    return JSON.parse(fs.readFileSync(TOKEN_STORE, 'utf8'));
  } catch (error) {
    return {};
  }
};

const writeTokenStore = (store) => {
  ensureDataDir();
  fs.writeFileSync(TOKEN_STORE, JSON.stringify(store, null, 2));
};

const saveShopToken = (shop, accessToken) => {
  const store = readTokenStore();
  store[shop] = {
    accessToken,
    installedAt: new Date().toISOString(),
  };
  writeTokenStore(store);
};

const requestClientCredentialsToken = async (shop) => {
  if (!env.apiKey || !env.apiSecret) return '';

  if (clientCredentialsToken.accessToken && clientCredentialsToken.expiresAt > Date.now() + 60_000) {
    return clientCredentialsToken.accessToken;
  }

  const response = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: env.apiKey,
      client_secret: env.apiSecret,
    }).toString(),
  });

  const data = await response.json();

  if (!response.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || 'Shopify token alınamadı.');
  }

  clientCredentialsToken.accessToken = data.access_token;
  clientCredentialsToken.expiresAt = Date.now() + Math.max(Number(data.expires_in || 3600) - 60, 60) * 1000;

  return clientCredentialsToken.accessToken;
};

const getShopAccessToken = async (shop) => {
  if (env.token) return env.token;

  const store = readTokenStore();
  if (store[shop]?.accessToken) return store[shop].accessToken;

  const firstInstalledShop = Object.keys(store).find((installedShop) => store[installedShop]?.accessToken);
  if (firstInstalledShop) return store[firstInstalledShop].accessToken;

  return requestClientCredentialsToken(shop);
};

const send = (res, status, body, headers = {}) => {
  res.writeHead(status, headers);
  res.end(body);
};

const sendJson = (res, status, payload, origin) => {
  send(res, status, JSON.stringify(payload), {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': origin || env.allowedOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store',
  });
};

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let body = '';

    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 20_000) {
        reject(new Error('Request body too large.'));
        req.destroy();
      }
    });

    req.on('end', () => resolve(body));
    req.on('error', reject);
  });

const hmacMessageFromSearchParams = (params) => {
  const pairs = [];

  params.forEach((value, key) => {
    if (key === 'hmac' || key === 'signature') return;
    pairs.push([key, value]);
  });

  return pairs
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
};

const verifyShopifyHmac = (params) => {
  if (!env.apiSecret) return false;

  const hmac = params.get('hmac');
  const digest = crypto
    .createHmac('sha256', env.apiSecret)
    .update(hmacMessageFromSearchParams(params))
    .digest('hex');

  return safeCompare(digest, hmac);
};

const randomState = () => crypto.randomBytes(16).toString('hex');

const buildAuthUrl = (shop, state) => {
  const redirectUri = `${env.appUrl}/auth/callback`;
  const params = new URLSearchParams({
    client_id: env.apiKey,
    scope: env.scopes,
    redirect_uri: redirectUri,
    state,
  });

  return `https://${shop}/admin/oauth/authorize?${params.toString()}`;
};

const exchangeCodeForToken = async (shop, code) => {
  const response = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      client_id: env.apiKey,
      client_secret: env.apiSecret,
      code,
    }),
  });

  const data = await response.json();

  if (!response.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || 'Shopify token alınamadı.');
  }

  return data.access_token;
};

const shopifyRequest = async (shop, path) => {
  const token = await getShopAccessToken(shop);

  if (!shop || !token) {
    throw new Error('Shopify token alınamadı. Render env değerlerini kontrol edin.');
  }

  const url = `https://${shop}/admin/api/${env.apiVersion}${path}`;
  const response = await fetch(url, {
    headers: {
      'X-Shopify-Access-Token': token,
      Accept: 'application/json',
    },
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(typeof data.errors === 'string' ? data.errors : 'Shopify sorgusu başarısız oldu.');
  }

  return data;
};

const buildCarrierTrackingUrl = (trackingNumber, trackingCompany) => {
  const number = String(trackingNumber || '').trim();
  if (!number) return '';

  const company = String(trackingCompany || env.defaultCarrier).toLowerCase();

  if (company.includes('hepsi')) {
    return `https://hepsijet.com/gonderi-takibi/${encodeURIComponent(number)}`;
  }

  if (company.includes('yurti')) {
    return `https://www.yurticikargo.com/tr/online-servisler/gonderi-sorgula?code=${encodeURIComponent(number)}`;
  }

  if (company.includes('aras')) {
    return `https://www.araskargo.com.tr/tracking/${encodeURIComponent(number)}`;
  }

  if (company.includes('mng')) {
    return `https://www.mngkargo.com.tr/gonderi-takip?code=${encodeURIComponent(number)}`;
  }

  return '';
};

const firstTrackingValue = (fulfillment, key) => {
  const plural = `${key}s`;
  return fulfillment[key] || fulfillment[plural]?.[0] || '';
};

const findTracking = (fulfillments) => {
  for (const fulfillment of fulfillments) {
    const trackingUrl = firstTrackingValue(fulfillment, 'tracking_url');
    const trackingNumber = firstTrackingValue(fulfillment, 'tracking_number');
    const trackingCompany = fulfillment.tracking_company || '';
    const generatedUrl = buildCarrierTrackingUrl(trackingNumber, trackingCompany);

    if (trackingUrl || generatedUrl || trackingNumber) {
      return {
        trackingNumber,
        trackingUrl: trackingUrl || generatedUrl,
        trackingCompany,
        status: fulfillment.shipment_status || fulfillment.status || '',
      };
    }
  }

  return null;
};

const loadFulfillments = async (shop, order) => {
  if (Array.isArray(order.fulfillments) && order.fulfillments.length > 0) {
    return order.fulfillments;
  }

  const data = await shopifyRequest(shop, `/orders/${order.id}/fulfillments.json`);
  return Array.isArray(data.fulfillments) ? data.fulfillments : [];
};

const verifyOrder = async ({ orderNumber, email, shop: requestedShop }) => {
  const shop = normalizeShop(env.shop) || normalizeShop(requestedShop);
  const normalizedOrderName = normalizeOrderName(orderNumber);
  const normalizedEmail = normalizeEmail(email);

  if (!shop) {
    return {
      status: 400,
      payload: {
        success: false,
        error: 'Shopify mağazası tanımlı değil.',
      },
    };
  }

  if (!normalizedOrderName || !normalizedEmail) {
    return {
      status: 400,
      payload: {
        success: false,
        error: 'Sipariş numarası ve e-posta gerekli.',
      },
    };
  }

  const searchParams = new URLSearchParams({
    status: 'any',
    name: normalizedOrderName,
    fields: 'id,name,email,contact_email,fulfillments',
  });

  const data = await shopifyRequest(shop, `/orders.json?${searchParams.toString()}`);
  const orders = Array.isArray(data.orders) ? data.orders : [];
  const order = orders.find((item) => {
    const orderEmail = normalizeEmail(item.email || item.contact_email);
    return item.name === normalizedOrderName && orderEmail === normalizedEmail;
  });

  if (!order) {
    return {
      status: 404,
      payload: {
        success: false,
        error: 'Sipariş bilgileri eşleşmedi.',
      },
    };
  }

  const fulfillments = await loadFulfillments(shop, order);
  const tracking = findTracking(fulfillments);

  if (!tracking) {
    return {
      status: 404,
      payload: {
        success: false,
        error: 'Bu sipariş için kargo takip numarası henüz oluşmamış.',
      },
    };
  }

  return {
    status: 200,
    payload: {
      success: true,
      orderName: order.name,
      ...tracking,
    },
  };
};

const handleAuth = (req, res, url) => {
  const shop = normalizeShop(url.searchParams.get('shop') || env.shop);

  if (!env.appUrl || !env.apiKey || !env.apiSecret) {
    send(res, 500, 'APP_URL, SHOPIFY_API_KEY ve SHOPIFY_API_SECRET env değerleri gerekli.');
    return;
  }

  if (!shop) {
    send(res, 400, 'Geçerli shop parametresi gerekli. Örnek: /auth?shop=renaogift.myshopify.com');
    return;
  }

  const state = randomState();
  send(res, 302, '', {
    Location: buildAuthUrl(shop, state),
    'Set-Cookie': `renao_shopify_state=${state}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`,
  });
};

const handleAuthCallback = async (req, res, url) => {
  const shop = normalizeShop(url.searchParams.get('shop'));
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const cookieState = String(req.headers.cookie || '').match(/(?:^|; )renao_shopify_state=([^;]+)/)?.[1] || '';

  if (!verifyShopifyHmac(url.searchParams)) {
    send(res, 401, 'Shopify HMAC doğrulanamadı.');
    return;
  }

  if (!shop || !code || !state || !safeCompare(state, cookieState)) {
    send(res, 400, 'Kurulum bilgileri eksik veya state eşleşmedi.');
    return;
  }

  const accessToken = await exchangeCodeForToken(shop, code);
  saveShopToken(shop, accessToken);

  send(
    res,
    200,
    [
      '<!doctype html><meta charset="utf-8">',
      '<title>Renao Kargo Takip kuruldu</title>',
      '<body style="font-family:Inter,system-ui,sans-serif;padding:40px;line-height:1.5">',
      '<h1>Renao Kargo Takip kuruldu.</h1>',
      '<p>Shopify token guvenli sekilde kaydedildi. Artik tema tarafindaki Tracking API URL alanina endpoint yazilabilir.</p>',
      '<code>/api/verify-order</code>',
      '</body>',
    ].join(''),
    {
      'Content-Type': 'text/html; charset=utf-8',
      'Set-Cookie': 'renao_shopify_state=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0',
    }
  );
};

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || env.allowedOrigin;
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'OPTIONS') {
    sendJson(res, 204, {}, origin);
    return;
  }

  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      const shop = normalizeShop(env.shop);
      const store = readTokenStore();
      let installed = false;
      let tokenMode = 'none';
      let setupError = '';

      try {
        installed = Boolean(shop && (await getShopAccessToken(shop)));
        tokenMode = env.token ? 'static_admin_token' : store[shop]?.accessToken ? 'oauth_saved_token' : 'client_credentials';
      } catch (error) {
        setupError = error.message || 'Token kontrol edilemedi.';
      }

      sendJson(
        res,
        200,
        {
          ok: true,
          shop: shop || null,
          installed,
          tokenMode,
          setupError,
          installedShops: Object.keys(store),
        },
        origin
      );
      return;
    }

    if (req.method === 'GET' && url.pathname === '/auth') {
      handleAuth(req, res, url);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/auth/callback') {
      await handleAuthCallback(req, res, url);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/verify-order') {
      const body = await readBody(req);
      const payload = JSON.parse(body || '{}');
      const result = await verifyOrder(payload);
      sendJson(res, result.status, result.payload, origin);
      return;
    }

    sendJson(res, 404, { success: false, error: 'Not found.' }, origin);
  } catch (error) {
    sendJson(
      res,
      500,
      {
        success: false,
        error: error.message || 'Beklenmeyen bir hata oluştu.',
      },
      origin
    );
  }
});

server.listen(env.port, () => {
  console.log(`Renao kargo takip API listening on :${env.port}`);
});
