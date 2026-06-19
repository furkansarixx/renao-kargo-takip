# Renao Kargo Takip API

Bu mini servis, kargo takip sayfasındaki `siparis numarasi + e-posta` formunu gercek Shopify siparis bilgisiyle eslestirir.

## Mantik

1. Musteri siparis numarasi ve e-posta girer.
2. API Shopify Admin REST API ile siparisi arar.
3. E-posta eslesirse fulfillment icindeki takip linkini veya takip numarasini bulur.
4. Tema tarafina `trackingUrl` dondurur.

## ForSpaceOn mantigi

ForSpaceOn storefront tarafindan bir `onrender.com` endpointine istek atiyor. Token veya Admin API bilgisi front-end'de gorunmuyor. Bu servis de ayni guvenli mimariyi kullanir: Shopify token backend tarafinda saklanir.

## Calistirma

```bash
cd automation/kargo-takip
cp .env.example .env
npm run check
npm start
```

## Render env degerleri

```text
APP_URL=https://render-uygulama-urlin.onrender.com
SHOPIFY_SHOP=renaogift.myshopify.com
SHOPIFY_API_KEY=Dev Dashboard istemci kimligi
SHOPIFY_API_SECRET=Dev Dashboard gizli anahtar
SHOPIFY_SCOPES=read_orders,read_fulfillments
SHOPIFY_API_VERSION=2026-04
ALLOWED_ORIGIN=https://renaogift.com
DEFAULT_CARRIER=hepsijet
```

`SHOPIFY_ADMIN_ACCESS_TOKEN` bos kalabilir. Servis once bu statik tokeni kullanir; yoksa Dev Dashboard `SHOPIFY_API_KEY` ve `SHOPIFY_API_SECRET` degerleriyle Shopify'in `client_credentials` akisini kullanarak gecici Admin API token alir ve suresi dolunca yeniler.

## Shopify Dev Dashboard ayarlari

Uygulama URL'si:

```text
https://render-uygulama-urlin.onrender.com
```

Allowed redirection URL:

```text
https://render-uygulama-urlin.onrender.com/auth/callback
```

Scopes:

```text
read_orders,read_fulfillments
```

Eski OAuth kurulum URL'si. Client credentials akisi kullanilirken normalde gerekmez:

```text
https://render-uygulama-urlin.onrender.com/auth?shop=renaogift.myshopify.com
```

## Theme Editor

Kargo takip sayfasindaki `Tracking API URL` alanina deploy edilen endpointi gir:

```text
https://senin-domainin.com/api/verify-order
```

## Gerekli Shopify izinleri

Admin API token icin siparis okuma izni gerekir:

```text
read_orders
read_fulfillments
```

## Donen cevap

Basarili:

```json
{
  "success": true,
  "trackingNumber": "HJ123456789",
  "trackingUrl": "https://hepsijet.com/gonderi-takibi/HJ123456789",
  "trackingCompany": "HepsiJet"
}
```

Basarisiz:

```json
{
  "success": false,
  "error": "Siparis bilgileri eslesmedi."
}
```
