// Regenerates public/assets/img/og.png (1200×630) in the v3 brand: grey grid field, lime pixel blocks, logo card. Run: node scripts/gen-og.mjs
import sharp from 'sharp';
import fs from 'fs';
const W = 1200, H = 630;
const logo = fs.readFileSync('public/assets/img/logo.png');
const logoResized = await sharp(logo).resize({ height: 200 }).png().toBuffer();
const grid = Array.from({ length: 17 }, (_, i) => `<line x1="${i * 72}" y1="0" x2="${i * 72}" y2="${H}" stroke="#030712" stroke-opacity="0.05"/>`).join('') +
  Array.from({ length: 9 }, (_, i) => `<line x1="0" y1="${i * 72}" x2="${W}" y2="${i * 72}" stroke="#030712" stroke-opacity="0.05"/>`).join('');
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <rect width="${W}" height="${H}" fill="#f3f4f6"/>
  ${grid}
  <rect x="0" y="0" width="60" height="60" fill="#98ff03"/><rect x="120" y="0" width="120" height="60" fill="#98ff03"/><rect x="60" y="60" width="60" height="60" fill="#98ff03"/><rect x="0" y="120" width="60" height="60" fill="#98ff03"/>
  <rect x="${W-60}" y="${H-120}" width="60" height="120" fill="#98ff03"/><rect x="${W-180}" y="${H-60}" width="120" height="60" fill="#98ff03"/><rect x="${W-180}" y="${H-120}" width="60" height="60" fill="#98ff03"/><rect x="${W-120}" y="${H-180}" width="60" height="60" fill="#98ff03"/>
  <rect x="${W/2-150}" y="120" width="300" height="300" rx="36" fill="#ffffff" stroke="#030712" stroke-opacity="0.1"/>
  <circle cx="${W/2}" cy="270" r="120" fill="#e9eaee"/>
  <text x="${W/2}" y="500" text-anchor="middle" font-family="Helvetica Neue, Arial, sans-serif" font-weight="700" font-size="54" fill="#030712" letter-spacing="-2">barabashflow.pl</text>
  <text x="${W/2}" y="548" text-anchor="middle" font-family="Helvetica Neue, Arial, sans-serif" font-weight="500" font-size="22" fill="#6b7280">Strony · Sklepy · Platformy · CMS — Warszawa</text>
  <rect x="${W/2-140}" y="572" width="280" height="30" fill="#030712"/>
  <text x="${W/2}" y="593" text-anchor="middle" font-family="Menlo, monospace" font-size="14" fill="#98ff03" letter-spacing="2">WYCENA W 24 H · PL EN RU</text>
</svg>`;
await sharp(Buffer.from(svg)).composite([{ input: logoResized, top: 170, left: Math.round(W / 2 - 81) }]).png().toFile('public/assets/img/og.png');
const meta = await sharp('public/assets/img/og.png').metadata();
console.log('og.png', meta.width, meta.height, fs.statSync('public/assets/img/og.png').size, 'bytes');
