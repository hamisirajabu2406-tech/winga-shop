require('dotenv').config();
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const cron = require('node-cron');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const cloudinary = require('cloudinary').v2;
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_URL = (process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || 'https://winga-shop.onrender.com').replace(/\/$/, '');

// Configure Cloudinary using Environment Variables
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// Global State Flags
let sock = null;
let isWhatsappReady = false;

// Production Environment Checks
if (process.env.NODE_ENV === 'production') {
  if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET === 'winga-super-secret-key') {
    console.error('❌ FATAL ERROR: SESSION_SECRET must be explicitly set to a secure string in production!');
    process.exit(1);
  }
}

// Middleware Setup & Proxy Trust for Render Cloud
app.set('trust proxy', 1);
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Landing Page
app.get(['/', '/index.html'], (req, res) => {
  const indexPath = path.join(__dirname, 'public', 'index.html');
  fs.readFile(indexPath, 'utf8', (err, html) => {
    if (err) {
      return res.redirect('/catalog');
    }
    res.send(html);
  });
});

app.use(express.static(path.join(__dirname, 'public')));

// Unified Session Middleware
app.use(session({
  secret: process.env.SESSION_SECRET || 'winga-super-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000
  }
}));

// Language Middleware (Swahili / English support)
app.use((req, res, next) => {
  if (req.query.lang) {
    req.session.lang = req.query.lang === 'en' ? 'en' : 'sw';
  }
  req.lang = req.session.lang || 'sw';
  res.locals.lang = req.lang;
  next();
});

// Multer Memory Storage Configuration
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|webp|gif/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    if (extname && mimetype) {
      return cb(null, true);
    }
    cb(new Error('Ruhusiwa kupakia picha pekee (jpeg, jpg, png, webp, gif)!'));
  }
}).array('images', 4);

// Authentication & Real-time Expiry Guard Middleware
async function requireWinga(req, res, next) {
  if (!req.session || !req.session.wingaId) {
    return res.redirect('/login');
  }
  try {
    const currentWinga = await db('wingas').where({ id: req.session.wingaId }).first();
    if (!currentWinga) return res.redirect('/login');

    if (currentWinga.expiryDate) {
      const expiry = new Date(currentWinga.expiryDate);
      const now = new Date();
      if (now > expiry && currentWinga.status === 'active') {
        await db('wingas').where({ id: currentWinga.id }).update({ status: 'suspended' });
      }
    }
  } catch (err) {
    console.error('requireWinga error:', err);
  }
  next();
}

function requireSuperAdmin(req, res, next) {
  if (!req.session || !req.session.isSuperAdmin) {
    return res.redirect('/login');
  }
  next();
}

// Helpers
function getProductImages(product) {
  if (!product) return [];
  let raw = product.imageUrl;
  if (!raw) return [];
  let list = [];
  try {
    const parsed = typeof raw === 'string' && raw.trim().startsWith('[') ? JSON.parse(raw) : raw;
    list = Array.isArray(parsed) ? parsed : [parsed];
  } catch (e) {
    list = [raw];
  }
  return list.map(img => (img ? String(img).trim() : '')).filter(Boolean);
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Predefined Options for Categories and Colors
const PREDEFINED_CATEGORIES = [
  'Clothes (Nguo)',
  'Bags (Mifuko / Mikoba)',
  'Shoes - Men (Viatu vya Kiume)',
  'Shoes - Women (Viatu vya Kike)',
  'Electronics (Simu, Laptops, TV)',
  'Cosmetics & Perfumes (Mafuta, Losheni, Sabuni)',
  'Car Accessories (Vifaa vya Gari)',
  'General (Mengineyo)'
];

const PREDEFINED_COLORS = [
  'Kama pichani',
  'Nyeusi (Black)',
  'Nyeupe (White)',
  'Nyekundu (Red)',
  'Bluu (Blue)',
  'Kijani (Green)',
  'Hudhurungi (Brown)',
  'Kijivu (Grey)',
  'Manjano (Yellow)',
  'Pinki (Pink)'
];

// Language Switcher Helper Bar HTML
function getLangBar(req) {
  const currentLang = req.lang || 'sw';
  return `
  <div style="background: #222; color: #fff; padding: 6px 15px; font-size: 12px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 5px;">
    <span>🛍️ Winga Shop Tanzania</span>
    <div style="display: flex; gap: 10px; align-items: center;">
      <a href="/about" style="color: #ccc; text-decoration: none;">${currentLang === 'en' ? 'About Us' : 'Kuhusu Sisi'}</a> | 
      <a href="/help" style="color: #ccc; text-decoration: none;">${currentLang === 'en' ? 'Need Help?' : 'Msaada / FAQ'}</a>
      <span style="margin-left: 10px;">| Lugha:</span>
      <a href="?lang=sw" style="color: ${currentLang === 'sw' ? '#28a745' : '#fff'}; font-weight: bold; text-decoration: none;">Swahili</a> | 
      <a href="?lang=en" style="color: ${currentLang === 'en' ? '#28a745' : '#fff'}; font-weight: bold; text-decoration: none;">English</a>
    </div>
  </div>`;
}

// Initialize Baileys WhatsApp Connection
async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
    logger: pino({ level: 'silent' })
  });

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      console.log('⚡ Scan this QR Code with WhatsApp:');
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'close') {
      isWhatsappReady = false;
      const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
      console.warn('⚠️ WhatsApp connection closed, reconnecting:', shouldReconnect);
      if (shouldReconnect) connectToWhatsApp();
    } else if (connection === 'open') {
      console.log('✅ Winga WhatsApp Bot (Baileys) is connected and live!');
      isWhatsappReady = true;
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;

      const remoteJid = msg.key.remoteJid;
      const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();
      const lowerText = text.toLowerCase();

      if (lowerText.startsWith('!maoni')) {
        const parts = text.split(/\s+/);
        const orderId = parseInt(parts[1]);
        const rating = parseInt(parts[2]);
        const comment = parts.slice(3).join(' ');
        if (!orderId || isNaN(rating) || rating < 1 || rating > 5 || !comment) {
          await sock.sendMessage(remoteJid, { text: '❌ Muundo sio sahihi.\n\nTumia muundo huu:\n*!maoni [NambaYaOda] [Nyota 1-5] [Maoni yako]*' });
          continue;
        }
        const orderExists = await db('orders').where({ orderId }).first();
        if (!orderExists) {
          await sock.sendMessage(remoteJid, { text: `❌ Haikuwezekana kupata Oda #${orderId}.` });
          continue;
        }
        const existingReview = await db('reviews').where({ orderId }).first();
        if (existingReview) {
          await db('reviews').where({ orderId }).update({ rating, comment: comment.trim(), date: new Date() });
        } else {
          await db('reviews').insert({ orderId, rating, comment: comment.trim(), date: new Date() });
        }
        await sock.sendMessage(remoteJid, { text: `🎉 *AHSANTE SANA KWA FEEDBACK YAKO!* ⭐\n\nTumepokea tathmini yako ya nyota ${'⭐'.repeat(rating)} kwa Oda #${orderId}.` });
        continue;
      }

      if (lowerText.startsWith('!agiza') || lowerText.startsWith('!order')) {
        let productID = null;
        let location = 'Haikutajwa';
        let phone = remoteJid.replace('@s.whatsapp.net', '').replace('@c.us', '');
        let size = 'Standard';
        let color = 'Kama pichani';
        let qty = 1;
        let notes = '';

        if (text.includes('|')) {
          const payload = text.slice(7).split('|');
          productID = parseInt(payload[0].trim());
          if (payload[1]) location = payload[1].trim();
          if (payload[2]) phone = payload[2].trim();
        } else {
          const lines = text.split(/\r?\n/);
          const firstLine = lines[0].trim();
          const parts = firstLine.split(/\s+/);
          if (parts[1]) productID = parseInt(parts[1]);
          for (let line of lines) {
            const trimmed = line.trim();
            const lower = trimmed.toLowerCase();
            if (lower.includes('simu:')) {
              const extractedPhone = trimmed.split(/simu:/i)[1].trim();
              if (extractedPhone && extractedPhone.toLowerCase() !== 'haikutajwa') phone = extractedPhone;
            }
            if (lower.includes('eneo:')) {
              const extractedLocation = trimmed.split(/eneo:/i)[1].trim();
              if (extractedLocation && extractedLocation.toLowerCase() !== 'haikutajwa') location = extractedLocation;
            }
            if (lower.includes('saizi:') || lower.includes('size:')) {
              const extractedSize = trimmed.split(/saizi:|size:/i)[1].trim();
              if (extractedSize) size = extractedSize;
            }
            if (lower.includes('rangi:') || lower.includes('color:')) {
              const extractedColor = trimmed.split(/rangi:|color:/i)[1].trim();
              if (extractedColor && extractedColor.toLowerCase() !== 'haijatajwa') color = extractedColor;
            }
            if (lower.includes('idadi:')) {
              const extractedQty = parseInt(trimmed.split(/idadi:/i)[1].trim());
              if (!isNaN(extractedQty) && extractedQty > 0) qty = extractedQty;
            }
            if (lower.includes('maelezo:')) {
              const extractedNotes = trimmed.split(/maelezo:/i)[1].trim();
              if (extractedNotes && extractedNotes.toLowerCase() !== 'hakuna') notes = extractedNotes;
            }
          }
        }

        const product = await db('products').where({ id: productID }).first();
        if (!product) {
          await sock.sendMessage(remoteJid, { text: `❌ Bidhaa #${productID} haipo.` });
          continue;
        }

        const unitBuying = Number(product.buyingPrice || 0);
        const unitSelling = Number(product.sellingPrice || product.price || 0);
        const totalBuying = unitBuying * qty;
        const totalSelling = unitSelling * qty;

        let detailsSummary = product.name;
        const extras = [];
        if (qty > 1) extras.push(`x${qty}`);
        if (size && size !== 'Standard') extras.push(`Size: ${size}`);
        if (color) extras.push(`Rangi: ${color}`);
        if (notes) extras.push(`Maelezo: ${notes}`);
        if (extras.length > 0) {
          detailsSummary += ` (${extras.join(', ')})`;
        }

        const maxResult = await db('orders').max('orderId as maxId').first();
        const nextOrderId = (maxResult && maxResult.maxId ? maxResult.maxId : 0) + 1;
        const newOrder = {
          orderId: nextOrderId,
          wingaId: product.wingaId || 1,
          productName: detailsSummary,
          buyingPrice: totalBuying,
          sellingPrice: totalSelling,
          customerPhone: phone,
          location: location,
          senderJid: remoteJid,
          status: 'Pending',
          date: new Date()
        };
        await db('orders').insert(newOrder);

        const trackUrl = `${PUBLIC_URL}/track?id=${newOrder.orderId}`;
        await sock.sendMessage(remoteJid, {
          text: `🛒 *ODA YAKO IMEPOKELEWA!*\n---------------------------\n` +
                `🔖 *Oda:* #${newOrder.orderId}\n` +
                `📦 *Bidhaa:* ${detailsSummary}\n` +
                `💰 *Jumla ya Bei:* TSh ${newOrder.sellingPrice.toLocaleString()}\n` +
                `📞 *Simu:* ${phone}\n` +
                `📍 *Eneo:* ${location}\n` +
                `📌 *Status:* 🟡 Pending\n\n` +
                `📍 *Fuatilia Oda Yako Hapa:*\n${trackUrl}`
        });
        await notifyWinga(newOrder, product);
        continue;
      }

      const greetingKeywords = ['hi', 'hello', 'vp', 'habari', 'mambo', 'catalog', 'katalogi', 'katalog', '1', 'nguo', 'hey', 'niaje'];
      if (greetingKeywords.some(keyword => lowerText === keyword || lowerText.startsWith(keyword + ' '))) {
        await sock.sendMessage(remoteJid, { text: `Karibu WingaShop! 👋\n\nTazama na utafute bidhaa zetu hapa:\n${PUBLIC_URL}/catalog` });
        continue;
      }
    }
  });
}

async function notifyShopCustomers(winga, newProduct) {
  try {
    if (!isWhatsappReady || !sock) return;
    const shopOrders = await db('orders').where({ wingaId: winga.id });
    const customerJids = [...new Set(shopOrders.map(o => o.senderJid).filter(Boolean))];
    if (customerJids.length === 0) return;
    const images = getProductImages(newProduct);

    const alertMsg =
      `📢 *TAARIFA ZA BIDHAA MPYA!* 🛍️\n` +
      `-----------------------------------\n` +
      `Duka la *${winga.name}* limeongeza bidhaa mpya sokoni!\n\n` +
      `📦 *Bidhaa:* ${newProduct.name}\n` +
      `💰 *Bei:* TSh ${Number(newProduct.sellingPrice).toLocaleString()}\n` +
      `📁 *Aina:* ${newProduct.category}\n\n` +
      `🔗 *Tazama na uagize hapa:*\n${PUBLIC_URL}/catalog?shop=${winga.id}`;

    for (const jid of customerJids) {
      try {
        if (images.length > 0 && images[0]) {
          await sock.sendMessage(jid, { image: { url: images[0] }, caption: alertMsg });
        } else {
          await sock.sendMessage(jid, { text: alertMsg });
        }
      } catch (sendErr) {}
    }
  } catch (err) {}
}

async function notifyWinga(order, product) {
  try {
    if (!isWhatsappReady || !sock) return;
    const winga = await db('wingas').where({ id: order.wingaId }).first();
    if (!winga || !winga.phone) return;
    let phone = winga.phone.trim().replace('+', '');
    if (phone.startsWith('0')) phone = '255' + phone.slice(1);
    const wingaChatId = phone + '@s.whatsapp.net';
    const alertMessage =
      `🔔 *ODA MPYA IMETOKA KWENYE DUKA YAKO!* 🛍️\n` +
      `-----------------------------------\n` +
      `🔖 *Namba ya Oda:* #${order.orderId}\n` +
      `📦 *Bidhaa:* ${order.productName}\n` +
      `💰 *Bei:* TSh ${Number(order.sellingPrice).toLocaleString()}\n` +
      `📍 *Eneo:* ${order.location}\n` +
      `📞 *Simu:* ${order.customerPhone}\n\n` +
      `📲 Angalia dashboard yako hapa: ${PUBLIC_URL}/admin`;

    const images = getProductImages(product);
    if (images.length > 0 && images[0]) {
      await sock.sendMessage(wingaChatId, { image: { url: images[0] }, caption: alertMessage });
    } else {
      await sock.sendMessage(wingaChatId, { text: alertMessage });
    }
  } catch (err) {}
}

// About Us Page
app.get('/about', (req, res) => {
  const isEn = req.lang === 'en';
  res.send(`
    <!DOCTYPE html>
    <html lang="${req.lang}">
    <head>
      <meta charset="UTF-8">
      <title>${isEn ? 'About Us - Winga Shop' : 'Kuhusu Sisi - Winga Shop'}</title>
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <style>
        body { font-family: sans-serif; background: #f4f6f8; margin: 0; padding: 0; color: #333; line-height: 1.6; }
        .container { max-width: 700px; margin: 30px auto; background: white; padding: 30px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.08); }
        h1 { color: #007bff; }
        a.back { display: inline-block; margin-top: 20px; color: #007bff; text-decoration: none; font-weight: bold; }
      </style>
    </head>
    <body>
      ${getLangBar(req)}
      <div class="container">
        <h1>${isEn ? 'About Winga Shop' : 'Kuhusu Winga Shop'}</h1>
        <p>${isEn ? 'Winga Shop is a premier e-commerce platform designed for Tanzanian resellers (mawinga) and merchants to easily manage product catalogs, customer orders, digital invoices, and automated WhatsApp notifications.' : 'Winga Shop ni mfumo madhubuti wa kibiashara mtandaoni ulioundwa maalum kwa ajili ya wauzaji na wajasiriamali wa Kitanzania kurahisisha usimamizi wa maduka yao, katalogi za bidhaa, oda za wateja, risiti za kidijitali, na huduma za WhatsApp.'}</p>
        <p>${isEn ? 'Our mission is to empower local businesses with lightweight, secure, and fast digital tools to scale their sales effortlessly.' : 'Lengo letu ni kuwawezesha wafanyabiashara wa ndani na zana nyepesi, salama za kidijitali ili kukuza mauzo yao kwa urahisi.'}</p>
        <a href="/catalog" class="back">← ${isEn ? 'Back to Catalog' : 'Rudi kwenye Katalogi'}</a>
      </div>
    </body>
    </html>
  `);
});

// Help Center / FAQ Page ("Do You Need Help")
app.get('/help', (req, res) => {
  const isEn = req.lang === 'en';
  res.send(`
    <!DOCTYPE html>
    <html lang="${req.lang}">
    <head>
      <meta charset="UTF-8">
      <title>${isEn ? 'Help & Support - Winga Shop' : 'Msaada na Maswali - Winga Shop'}</title>
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <style>
        body { font-family: sans-serif; background: #f4f6f8; margin: 0; padding: 0; color: #333; line-height: 1.5; }
        .container { max-width: 700px; margin: 30px auto; background: white; padding: 30px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.08); }
        h1 { color: #28a745; }
        .faq-item { margin-bottom: 15px; border-bottom: 1px solid #eee; padding-bottom: 10px; }
        .faq-q { font-weight: bold; color: #007bff; }
        a.back { display: inline-block; margin-top: 20px; color: #007bff; text-decoration: none; font-weight: bold; }
      </style>
    </head>
    <body>
      ${getLangBar(req)}
      <div class="container">
        <h1>${isEn ? '❓ Do You Need Help? (FAQ)' : '❓ Je Unahitaji Msaada? (Maswali Yanayoulizwa Mara kwa Mara)'}</h1>
        
        <div class="faq-item">
          <div class="faq-q">${isEn ? '1. How do I track my order?' : '1. Ninawezaje kufuatilia oda yangu?'}</div>
          <div class="faq-a">${isEn ? 'Go to the Tracking page, enter your Order ID, and verify your 10-digit phone number.' : 'Nenda kwenye ukurasa wa Kufuatilia Oda, weka namba yako ya oda, kisha thibitisha namba ya simu uliyotumia kuagizia.'}</div>
        </div>

        <div class="faq-item">
          <div class="faq-q">${isEn ? '2. What should I do if my account expires?' : '2. Nafanyaje kama akaunti yangu imekwisha muda?'}</div>
          <div class="faq-a">${isEn ? 'Contact the main Admin via WhatsApp provided on your dashboard banner to renew your subscription for 30 days.' : 'Wasiliana na Admin mkuu kupitia namba ya WhatsApp iliyopo kwenye dashboard yako ili kuhuisha akaunti yako kwa siku 30.'}</div>
        </div>

        <div class="faq-item">
          <div class="faq-q">${isEn ? '3. How can I upload product images?' : '3. Nawezaje kupakia picha za bidhaa?'}</div>
          <div class="faq-a">${isEn ? 'You can upload up to 4 clear images per product directly from your admin dashboard.' : 'Unaweza kupakia hadi picha 4 safi kwa kila bidhaa moja kwa moja kupitia dashboard yako ya muuzaji.'}</div>
        </div>

        <a href="/catalog" class="back">← ${isEn ? 'Back to Catalog' : 'Rudi kwenye Katalogi'}</a>
      </div>
    </body>
    </html>
  `);
});

// Public Catalog Route with Predefined Categories & Dynamic Size/Color Selection
app.get('/catalog', async (req, res) => {
  try {
    await db('stats').where({ key: 'catalogVisits' }).increment('value', 1);
    const allProducts = await db('products').select('*');
    const wingas = await db('wingas').select('*');
    const shopId = req.query.shop;
    let products = allProducts;
    let shopName = req.lang === 'en' ? "All Shops Catalog" : "Soko Kuu (Maduka Yote)";
    
    if (shopId) {
      products = allProducts.filter(p => p.wingaId === parseInt(shopId));
      const matchedWinga = wingas.find(w => w.id === parseInt(shopId));
      if (matchedWinga) {
        shopName = `🛍️ ${matchedWinga.name}`;
      } else {
        shopName = "⚠️ Shop not found";
        products = [];
      }
    }
    const trackBtnUrl = shopId ? `/track?shop=${shopId}` : '/track';
    const botPhone = process.env.BOT_PHONE_NUMBER || '255678143403';
    
    let categoryOptions = PREDEFINED_CATEGORIES.map(cat => `<option value="${escapeHtml(cat.toLowerCase())}">${escapeHtml(cat)}</option>`).join('');
    let shopOptions = wingas.map(w => `<option value="${w.id}" ${shopId == w.id ? 'selected' : ''}>${escapeHtml(w.name)} (${escapeHtml(w.location || 'Tanzania')})</option>`).join('');
    
    let productCards = products.map(p => {
      const sellingPrice = Number(p.sellingPrice || p.price || 0);
      const priceFormatted = sellingPrice > 0 ? sellingPrice.toLocaleString() : 'Haikutajwa';
      const priceDisplay = sellingPrice > 0 ? `TSh ${priceFormatted}` : 'Contact Seller';

      const imageList = getProductImages(p);
      const mainImage = imageList[0] || '';
      const categoryStr = (p.category || 'General').trim();
      const availableSizes = (p.size || 'Standard').trim();
      const availableColors = (p.colors || 'Kama pichani').trim();
      const matchedWinga = wingas.find(w => w.id === p.wingaId);
      const sellerName = matchedWinga ? matchedWinga.name : 'Duka Kuu';
      const sellerLocation = matchedWinga && matchedWinga.location ? matchedWinga.location : 'Tanzania';

      let galleryThumbnailsHtml = '';
      if (imageList.length > 1) {
        galleryThumbnailsHtml = `<div style="display: flex; gap: 6px; margin-bottom: 10px; overflow-x: auto; padding-bottom: 4px;">` +
          imageList.map(img => `<img src="${img}" style="width: 42px; height: 42px; object-fit: cover; border-radius: 6px; border: 1px solid #ccc; cursor: pointer; flex-shrink: 0;" onclick="event.stopPropagation(); document.getElementById('img-${p.id}').src='${img}'; document.getElementById('img-${p.id}').setAttribute('data-fullsrc', '${img}');">`).join('') +
          `</div>`;
      }
      const imageHtml = (mainImage && mainImage.trim() !== '')
        ? `<div style="position: relative; cursor: pointer;" onclick="openImgModal(document.getElementById('img-${p.id}').getAttribute('data-fullsrc') || '${mainImage}')">
            <img id="img-${p.id}" data-fullsrc="${mainImage}" src="${mainImage}" alt="${escapeHtml(p.name)}" style="width: 100%; height: 180px; object-fit: cover; border-radius: 8px; margin-bottom: 8px;">
            <span style="position: absolute; bottom: 14px; right: 8px; background: rgba(0,0,0,0.65); color: white; padding: 3px 8px; border-radius: 4px; font-size: 11px; font-weight: bold; pointer-events: none;">🔍 Zoom</span>
           </div>${galleryThumbnailsHtml}`
        : `<div style="height: 140px; background: #e9ecef; border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 36px; margin-bottom: 10px; color: #adb5bd;">📦</div>`;

      return `
      <div class="product-card" data-name="${escapeHtml(p.name.toLowerCase())}" data-category="${escapeHtml(categoryStr.toLowerCase())}" data-shop="${p.wingaId}" data-shopname="${escapeHtml(sellerName.toLowerCase())}" style="background: white; padding: 12px; border-radius: 10px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); text-align: left; display: flex; flex-direction: column; justify-content: space-between;">
        <div>
          ${imageHtml}
          <div style="margin-bottom: 5px;">
            <span style="background: #e3f2fd; color: #0d47a1; font-size: 10px; padding: 3px 7px; border-radius: 12px; font-weight: bold; text-transform: uppercase;">${escapeHtml(categoryStr)}</span>
          </div>
          <h3 style="margin: 5px 0; color: #222; font-size: 15px; word-break: break-word;">${escapeHtml(p.name)}</h3>
          <p style="color: ${sellingPrice > 0 ? '#28a745' : '#6c757d'}; font-size: 15px; font-weight: bold; margin: 5px 0 10px 0;">${priceDisplay}</p>
        </div>
        <div style="font-size: 12px; color: #555; margin-bottom: 8px;">
          <span>🏪 <strong>${escapeHtml(sellerName)}</strong></span><br>
          <span>📍 <em>${escapeHtml(sellerLocation)}</em></span>
        </div>
        <button
          data-id="${p.id}"
          data-name="${escapeHtml(p.name)}"
          data-price="${priceFormatted}"
          data-sizes="${escapeHtml(availableSizes)}"
          data-colors="${escapeHtml(availableColors)}"
          onclick="handleOrderClick(this)"
          style="background: #25D366; color: white; padding: 10px; border: none; border-radius: 6px; font-weight: bold; cursor: pointer; font-size: 14px; width: 100%;">
          🛒 Agiza Sasa
        </button>
      </div>`;
    }).join('');

    if (products.length === 0) {
      productCards = '<p style="grid-column: 1 / -1; text-align: center; color: #666; padding: 40px 0;">Hakuna bidhaa kwenye duka hili kwa sasa.</p>';
    }

    res.send(`
    <!DOCTYPE html>
    <html lang="${req.lang}">
    <head>
      <meta charset="UTF-8">
      <title>${escapeHtml(shopName)}</title>
      <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
      <style>
        * { box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f4f6f8; margin: 0; padding: 0; color: #333; }
        .container { max-width: 900px; margin: 0 auto; padding: 15px; }
        .header-bar { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px; margin-bottom: 15px; }
        .nav-btns { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; width: 100%; }
        .track-btn { background: #007bff; color: white; padding: 9px 14px; border-radius: 6px; text-decoration: none; font-weight: bold; font-size: 13px; flex: 1; text-align: center; }
        .contact-btn { background: #25D366; color: white; padding: 9px 14px; border-radius: 6px; text-decoration: none; font-weight: bold; font-size: 13px; display: flex; align-items: center; justify-content: center; gap: 5px; flex: 1; text-align: center; }
        .filter-bar { display: flex; gap: 8px; margin-bottom: 15px; flex-direction: column; }
        @media(min-width: 600px) {
          .filter-bar { flex-direction: row; }
          .nav-btns { width: auto; flex: unset; }
          .track-btn, .contact-btn { flex: unset; }
        }
        .filter-bar input, .filter-bar select { padding: 10px; border: 1px solid #ccc; border-radius: 6px; font-size: 14px; width: 100%; }
        .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 12px; }
        @media(min-width: 500px) {
          .grid { grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 15px; }
        }
        h1 { color: #111; font-size: 20px; margin: 0; word-break: break-word; }
        .modal-overlay { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.6); justify-content: center; align-items: center; z-index: 1000; padding: 10px; box-sizing: border-box; }
        .modal-content { background: white; padding: 20px; border-radius: 12px; width: 100%; max-width: 380px; max-height: 90vh; overflow-y: auto; box-shadow: 0 4px 20px rgba(0,0,0,0.2); position: relative; }
        .close-btn { position: absolute; top: 12px; right: 15px; font-size: 24px; cursor: pointer; color: #aaa; border: none; background: none; }
        .form-group { margin-bottom: 12px; text-align: left; }
        .form-group label { display: block; font-weight: bold; margin-bottom: 4px; color: #333; font-size: 12px; }
        .form-group input, .form-group select, .form-group textarea { width: 100%; padding: 10px; border: 1px solid #ccc; border-radius: 6px; box-sizing: border-box; font-size: 14px; font-family: inherit; }
        .form-row-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
        .submit-btn { background: #25D366; color: white; border: none; padding: 12px; width: 100%; font-size: 15px; font-weight: bold; border-radius: 6px; cursor: pointer; margin-top: 8px; }
      </style>
    </head>
    <body>
      ${getLangBar(req)}
      <div class="container">
        <div class="header-bar">
          <h1>${escapeHtml(shopName)}</h1>
          <div class="nav-btns">
            <a href="https://wa.me/${botPhone}?text=Habari!%20Naomba%20msaada%20tafadhali" target="_blank" class="contact-btn">💬 WhatsApp Us</a>
            <a href="${trackBtnUrl}" class="track-btn">🔍 Fuatilia Oda</a>
          </div>
        </div>
        <div class="filter-bar">
          <input type="text" id="searchInput" onkeyup="filterCatalog()" placeholder="🔍 Tafuta bidhaa au duka...">
          <select id="shopSelect" onchange="filterCatalog()">
            <option value="all">🏪 Maduka Yote (All Shops)</option>
            ${shopOptions}
          </select>
          <select id="categorySelect" onchange="filterCatalog()">
            <option value="all">📁 Kategoria Zote (All Categories)</option>
            ${categoryOptions}
          </select>
        </div>
        <div class="grid" id="productGrid">
          ${productCards}
        </div>
      </div>

      <div id="fullImgModal" onclick="closeImgModal()" style="display: none; position: fixed; z-index: 9999; left: 0; top: 0; width: 100%; height: 100%; background-color: rgba(0,0,0,0.9); justify-content: center; align-items: center; cursor: pointer; padding: 15px; box-sizing: border-box;">
        <span style="position: absolute; top: 15px; right: 25px; color: #fff; font-size: 35px; font-weight: bold;">&times;</span>
        <img id="lightboxImage" style="max-width: 95%; max-height: 85vh; border-radius: 8px; object-fit: contain;">
      </div>

      <div id="orderModal" class="modal-overlay">
        <div class="modal-content">
          <button class="close-btn" onclick="closeModal()">&times;</button>
          <h3 style="margin-top:0; color:#111; font-size:17px;" id="modalProductName">Agiza Bidhaa</h3>
          <p style="color:#28a745; font-weight:bold; margin-top:-5px; margin-bottom: 12px; font-size:14px;" id="modalProductPrice"></p>
          <input type="hidden" id="selectedProductId">
          <input type="hidden" id="selectedProductName">
          <input type="hidden" id="selectedProductPrice">

          <div class="form-group">
            <label>Namba ya Simu (Tarakimu 10):</label>
            <input type="tel" id="orderPhone" placeholder="0712345678" maxlength="10" oninput="this.value = this.value.replace(/[^0-9]/g, '').slice(0, 10)" required>
          </div>

          <div class="form-row-2">
            <div class="form-group">
              <label>Mkoa:</label>
              <select id="orderRegion" onchange="updateOrderDistricts()" required>
                <option value="">-- Mkoa --</option>
                <option value="Dar es Salaam">Dar es Salaam</option>
                <option value="Arusha">Arusha</option>
                <option value="Dodoma">Dodoma</option>
                <option value="Mwanza">Mwanza</option>
                <option value="Mbeya">Mbeya</option>
                <option value="Kilimanjaro">Kilimanjaro</option>
                <option value="Tanga">Tanga</option>
                <option value="Morogoro">Morogoro</option>
                <option value="Mtwara">Mtwara</option>
                <option value="Iringa">Iringa</option>
                <option value="Tabora">Tabora</option>
                <option value="Kigoma">Kigoma</option>
                <option value="Shinyanga">Shinyanga</option>
                <option value="Kagera">Kagera</option>
                <option value="Mara">Mara</option>
                <option value="Pwani">Pwani</option>
                <option value="Singida">Singida</option>
                <option value="Rukwa">Rukwa</option>
                <option value="Ruvuma">Ruvuma</option>
                <option value="Lindi">Lindi</option>
                <option value="Geita">Geita</option>
                <option value="Simiyu">Simiyu</option>
                <option value="Njombe">Njombe</option>
                <option value="Katavi">Katavi</option>
                <option value="Songwe">Songwe</option>
                <option value="Manyara">Manyara</option>
                <option value="Zanzibar">Zanzibar</option>
              </select>
            </div>
            <div class="form-group">
              <label>Wilaya:</label>
              <select id="orderDistrict" required>
                <option value="">-- Kwanza Mkoa --</option>
              </select>
            </div>
          </div>

          <div class="form-group">
            <label>Kata / Mtaa Unapoishi:</label>
            <input type="text" id="orderWard" placeholder="Mfano: Sinza, Kariakoo" required>
          </div>

          <div class="form-row-2">
            <div class="form-group">
              <label>Size:</label>
              <select id="orderSize"></select>
            </div>
            <div class="form-group">
              <label>Rangi (Color):</label>
              <select id="orderColor"></select>
            </div>
          </div>

          <div class="form-group">
            <label>Idadi (Quantity):</label>
            <input type="number" id="orderQty" value="1" min="1">
          </div>

          <div class="form-group">
            <label>Maelezo ya Ziada (Si lazima):</label>
            <textarea id="orderNotes" rows="2" placeholder="Mfano: Niletee jioni..."></textarea>
          </div>

          <button class="submit-btn" onclick="sendToWhatsApp()">📲 Tuma Oda kwa WhatsApp</button>
        </div>
      </div>

      <script>
        var BOT_PHONE = "${botPhone}";
        const orderDistrictsData = {
          "Dar es Salaam": ["Kinondoni", "Ilala", "Temeke", "Ubungo", "Kigamboni"],
          "Arusha": ["Arusha Mjini", "Arumeru", "Karatu", "Longido", "Ngorongoro", "Monduli"],
          "Dodoma": ["Dodoma Mjini", "Bahi", "Chamwino", "Chemba", "Kondoa", "Kongwa", "Mpwapwa"],
          "Mwanza": ["Ilemela", "Nyamagana", "Magu", "Misungwi", "Sengerema", "Ukerewe", "Kwimba"],
          "Mbeya": ["Mbeya Mjini", "Mbeya Vijijini", "Rungwe", "Kyela", "Mbozi", "Chunya"],
          "Kilimanjaro": ["Moshi Mjini", "Moshi Vijijini", "Hai", "Rombo", "Mwanga", "Same", "Siha"],
          "Tanga": ["Tanga Mjini", "Muheza", "Korogwe", "Handeni", "Pangani", "Lushoto", "Kilindi"],
          "Morogoro": ["Morogoro Mjini", "Morogoro Vijijini", "Kilombero", "Kilosa", "Ulanga", "Gairo", "Malinyi"],
          "Mtwara": ["Mtwara Mjini", "Masasi", "Newala", "Tandahimba", "Nanyumbu"],
          "Iringa": ["Iringa Mjini", "Iringa Vijijini", "Kilolo", "Mufindi"],
          "Tabora": ["Tabora Mjini", "Igunga", "Nzega", "Urambo", "Sikonge", "Kaliua"],
          "Kigoma": ["Kigoma Ujiji", "Kasulu", "Kibondo", "Buhigwe", "Uvinza", "Kakonko"],
          "Shinyanga": ["Shinyanga Mjini", "Kahama", "Kishapu"],
          "Kagera": ["Bukoba Mjini", "Bukoba Vijijini", "Muleba", "Karagwe", "Ngara", "Biharamulo"],
          "Mara": ["Musoma Mjini", "Tarime", "Serengeti", "Bunda", "Rorya", "Butiama"],
          "Pwani": ["Kibaha", "Bagamoyo", "Kisarawe", "Mkuranga", "Rufiji", "Mafia"],
          "Singida": ["Singida Mjini", "Iramba", "Manyoni", "Ikungi", "Mkalama"],
          "Rukwa": ["Sumbawanga Mjini", "Kalambo", "Nkasi"],
          "Ruvuma": ["Songea Mjini", "Mbinga", "Tunduru", "Namtumbo", "Nyasa"],
          "Lindi": ["Lindi Mjini", "Kilwa", "Nachingwea", "Liwale", "Ruangwa"],
          "Geita": ["Geita Mjini", "Chato", "Bukombe", "Mbogwe", "Nyang'hwale"],
          "Simiyu": ["Bariadi", "Maswa", "Meatu", "Itilima", "Busega"],
          "Njombe": ["Njombe Mjini", "Makambako", "Wanging'ombe", "Ludewa", "Makete"],
          "Katavi": ["Mpanda Mjini", "Mlele", "Tanganyika"],
          "Songwe": ["Vwawa (Mbozi)", "Tunduma", "Ileje", "Momba", "Songwe"],
          "Manyara": ["Babati", "Hanang", "Mbulu", "Kiteto", "Simanjiro"],
          "Zanzibar": ["Mjini Magharibi", "Kaskazini Unguja", "Kusini Unguja", "Kaskazini Pemba", "Kusini Pemba"]
        };

        function updateOrderDistricts() {
          const regionSelect = document.getElementById("orderRegion");
          const districtSelect = document.getElementById("orderDistrict");
          const selectedRegion = regionSelect.value;
          districtSelect.innerHTML = '<option value="">-- Chagua Wilaya --</option>';
          if (selectedRegion && orderDistrictsData[selectedRegion]) {
            orderDistrictsData[selectedRegion].forEach(district => {
              const opt = document.createElement("option");
              opt.value = district;
              opt.textContent = district;
              districtSelect.appendChild(opt);
            });
          }
        }

        function openImgModal(src) {
          if (!src) return;
          document.getElementById('lightboxImage').src = src;
          document.getElementById('fullImgModal').style.display = 'flex';
        }
        function closeImgModal() {
          document.getElementById('fullImgModal').style.display = 'none';
        }

        function filterCatalog() {
          var searchVal = document.getElementById('searchInput').value.toLowerCase().trim();
          var catVal = document.getElementById('categorySelect').value.toLowerCase();
          var shopVal = document.getElementById('shopSelect').value;
          var cards = document.getElementsByClassName('product-card');
          for (var i = 0; i < cards.length; i++) {
            var cardName = cards[i].getAttribute('data-name');
            var cardCat = cards[i].getAttribute('data-category');
            var cardShop = cards[i].getAttribute('data-shop');
            var cardShopName = cards[i].getAttribute('data-shopname');
            var matchesSearch = cardName.indexOf(searchVal) !== -1 || cardShopName.indexOf(searchVal) !== -1;
            var matchesCat = (catVal === 'all' || cardCat.indexOf(catVal) !== -1);
            var matchesShop = (shopVal === 'all' || cardShop === shopVal);
            cards[i].style.display = (matchesSearch && matchesCat && matchesShop) ? 'flex' : 'none';
          }
        }

        function handleOrderClick(btn) {
          var id = btn.getAttribute('data-id');
          var name = btn.getAttribute('data-name');
          var price = btn.getAttribute('data-price');
          var sizesStr = btn.getAttribute('data-sizes') || 'Standard';
          var colorsStr = btn.getAttribute('data-colors') || 'Kama pichani';
          openModal(id, name, price, sizesStr, colorsStr);
        }

        function openModal(id, name, price, sizesStr, colorsStr) {
          document.getElementById('selectedProductId').value = id;
          document.getElementById('selectedProductName').value = name;
          document.getElementById('selectedProductPrice').value = price;
          document.getElementById('modalProductName').innerText = '🛒 ' + name;
          document.getElementById('modalProductPrice').innerText = 'Bei: TSh ' + price;

          document.getElementById('orderPhone').value = '';
          document.getElementById('orderRegion').value = '';
          document.getElementById('orderDistrict').innerHTML = '<option value="">-- Kwanza Mkoa --</option>';
          document.getElementById('orderWard').value = '';
          document.getElementById('orderQty').value = '1';
          document.getElementById('orderNotes').value = '';

          const sizeSelect = document.getElementById('orderSize');
          sizeSelect.innerHTML = '';
          sizesStr.split(',').map(s => s.trim()).filter(Boolean).forEach(s => {
            const opt = document.createElement('option');
            opt.value = s;
            opt.textContent = s;
            sizeSelect.appendChild(opt);
          });

          const colorSelect = document.getElementById('orderColor');
          colorSelect.innerHTML = '';
          colorsStr.split(',').map(c => c.trim()).filter(Boolean).forEach(c => {
            const opt = document.createElement('option');
            opt.value = c;
            opt.textContent = c;
            colorSelect.appendChild(opt);
          });

          document.getElementById('orderModal').style.display = 'flex';
        }

        function closeModal() {
          document.getElementById('orderModal').style.display = 'none';
        }

        function sendToWhatsApp() {
          var id = document.getElementById('selectedProductId').value;
          var name = document.getElementById('selectedProductName').value;
          var price = document.getElementById('selectedProductPrice').value;
          var phone = document.getElementById('orderPhone').value.trim();
          var region = document.getElementById('orderRegion').value;
          var district = document.getElementById('orderDistrict').value;
          var ward = document.getElementById('orderWard').value.trim();
          var size = document.getElementById('orderSize').value || 'Standard';
          var color = document.getElementById('orderColor').value || 'Kama pichani';
          var qty = document.getElementById('orderQty').value || 1;
          var notes = document.getElementById('orderNotes').value.trim() || 'Hakuna';

          if (!/^[0-9]{10}$/.test(phone)) {
            alert('❌ Tafadhali weka namba ya simu sahihi yenye tarakimu 10 (mfano: 0712345678).');
            return;
          }
          if (!region || !district || !ward) {
            alert('❌ Tafadhali chagua Mkoa, Wilaya, na ujaze Kata unapoishi.');
            return;
          }

          var fullLocation = ward + ', ' + district + ', ' + region;
          var message = '!agiza ' + id +
            '\\n\\n*TAARIFA ZA ODA:*' +
            '\\n📦 Bidhaa: ' + name +
            '\\n💰 Bei: TSh ' + price +
            '\\n📞 Simu: ' + phone +
            '\\n📍 Eneo: ' + fullLocation +
            '\\n📏 Saizi: ' + size +
            '\\n🎨 Rangi: ' + color +
            '\\n🔢 Idadi: ' + qty +
            '\\n📝 Maelezo: ' + notes;

          var waUrl = 'https://wa.me/' + BOT_PHONE + '?text=' + encodeURIComponent(message);
          window.open(waUrl, '_blank');
          closeModal();
        }

        window.onclick = function(e) {
          if (e.target === document.getElementById('orderModal')) closeModal();
        };
      </script>
    </body>
    </html>
    `);
  } catch (err) {
    console.error('Catalog route error:', err);
    res.status(500).send('Hitilafu kwenye mfumo.');
  }
});

// Secure Track Route with Phone Verification & Public Reviews/Fraud Reporting
app.get('/track', async (req, res) => {
  try {
    const searchId = req.query.id ? parseInt(req.query.id) : null;
    let shopId = req.query.shop ? parseInt(req.query.shop) : null;
    let resultHtml = '';
    
    if (searchId) {
      const order = await db('orders').where({ orderId: searchId }).first();
      if (order) {
        if (!shopId && order.wingaId) shopId = order.wingaId;

        const verifiedOrders = req.session.verifiedOrders || {};
        const isVerified = verifiedOrders[searchId] === true;

        if (!isVerified) {
          resultHtml = `
          <div style="background:white; padding:20px; border-radius:10px; box-shadow:0 2px 8px rgba(0,0,0,0.1); margin-top:20px;">
            <h3 style="margin:0 0 10px 0; color:#111; font-size:16px;">🔒 Uhakiki wa Usalama (Security Verification)</h3>
            <p style="font-size:13px; color:#555; margin-bottom:15px;">Weka namba ya simu iliyotumika kuagizia <strong>Oda #${searchId}</strong> ili kuona taarifa zake.</p>
            <form action="/track/verify" method="POST">
              <input type="hidden" name="orderId" value="${searchId}">
              ${shopId ? `<input type="hidden" name="shop" value="${shopId}">` : ''}
              <div style="margin-bottom:12px;">
                <label style="display:block; font-size:12px; font-weight:bold; margin-bottom:4px;">Namba ya Simu (Tarakimu 10):</label>
                <input type="tel" name="phone" placeholder="0712345678" maxlength="10" oninput="this.value = this.value.replace(/[^0-9]/g, '').slice(0, 10)" style="width:100%; padding:10px; border:1px solid #ccc; border-radius:6px; box-sizing:border-box; font-size:14px;" required>
              </div>
              <button type="submit" style="background:#28a745; color:white; border:none; padding:11px; width:100%; font-weight:bold; border-radius:6px; cursor:pointer; font-size:14px;">Thibitisha & Tazama Oda</button>
            </form>
          </div>`;
        } else {
          const currentStatus = order.status || 'Pending';
          const existingReview = await db('reviews').where({ orderId: searchId }).first();
          const allOrderReviews = await db('reviews').where({ orderId: searchId }).select('*');
          const botPhone = process.env.BOT_PHONE_NUMBER || '255678143403';
          
          let statusBadge = '🟡 Pending (Inashughulikiwa)';
          if (currentStatus === 'Dispatched') statusBadge = '🚚 Dispatched (Ipo Njiani)';
          if (currentStatus === 'Completed') statusBadge = '✅ Completed (Imekamilika)';

          let reviewSection = '';
          if (currentStatus === 'Completed') {
            if (existingReview) {
              reviewSection = `
              <div style="background:#e8f5e9; padding:15px; border-radius:8px; margin-top:15px;">
                <h4 style="margin:0 0 5px 0; color:#2e7d32;">AHSANTE KWA MAONI YAKO!</h4>
                <p style="margin:0; font-size:18px;">${'⭐'.repeat(existingReview.rating)}</p>
                <p style="margin:5px 0 0 0; color:#555;"><em>"${escapeHtml(existingReview.comment)}"</em></p>
              </div>`;
            } else {
              reviewSection = `
              <div style="background:#f8f9fa; padding:15px; border-radius:8px; margin-top:15px; border:1px solid #e9ecef;">
                <h4 style="margin:0 0 10px 0;">Toa Maoni & Nyota (Review)</h4>
                <form action="/track/review" method="POST">
                  <input type="hidden" name="orderId" value="${order.orderId}">
                  <div style="margin-bottom:10px;">
                    <label style="font-size:12px; font-weight:bold;">Chagua Nyota:</label>
                    <select name="rating" style="width:100%; padding:8px; border-radius:4px; margin-top:4px;" required>
                      <option value="5">⭐⭐⭐⭐⭐ (5/5 - Bora Sana)</option>
                      <option value="4">⭐⭐⭐⭐ (4/5 - Nzuri)</option>
                      <option value="3">⭐⭐⭐ (3/5 - Kawaida)</option>
                      <option value="2">⭐⭐ (2/5 - Vibaya)</option>
                      <option value="1">⭐ (1/5 - Mbaya Sana)</option>
                    </select>
                  </div>
                  <div style="margin-bottom:10px;">
                    <label style="font-size:12px; font-weight:bold;">Maoni Yako:</label>
                    <textarea name="comment" rows="3" style="width:100%; padding:8px; border-radius:4px; box-sizing:border-box;" placeholder="Andika maoni yako..." required></textarea>
                  </div>
                  <button type="submit" style="background:#28a745; color:white; border:none; padding:10px 15px; border-radius:4px; font-weight:bold; cursor:pointer; width:100%;">Tuma Feedback</button>
                </form>
              </div>`;
            }
          }

          let publicReviewsHtml = '';
          if (allOrderReviews.length > 0) {
            publicReviewsHtml = `<div style="margin-top: 15px; padding: 12px; background: #fff; border: 1px solid #e9ecef; border-radius: 8px;">
              <h4 style="margin: 0 0 8px 0; font-size: 14px; color: #333;">📢 Maoni ya Umma (Public Reviews):</h4>` +
              allOrderReviews.map(r => `<div style="font-size: 13px; border-bottom: 1px solid #f1f3f5; padding-bottom: 6px; margin-bottom: 6px;">
                <span>${'⭐'.repeat(r.rating)}</span> <span style="color: #666; font-size: 11px;">(${new Date(r.date).toLocaleDateString()})</span><br>
                <em>"${escapeHtml(r.comment)}"</em>
              </div>`).join('') + `</div>`;
          }

          const reportFraudMsg = encodeURIComponent(`🚨 RIPOTI YA DHULUMA / TATIZO:\nNaomba kuripoti oda #${order.orderId} ya bidhaa (${order.productName}) yenye thamani ya TSh ${Number(order.sellingPrice).toLocaleString()}. Tatizo ni: `);

          resultHtml = `
          <div style="background:white; padding:15px; border-radius:10px; box-shadow:0 2px 8px rgba(0,0,0,0.1); margin-top:20px; word-break:break-word;">
            <h3 style="margin:0 0 10px 0; color:#111; font-size:17px;">Oda #${order.orderId} ✅</h3>
            <p style="margin:5px 0; font-size:14px;"><strong>📦 Bidhaa:</strong> ${escapeHtml(order.productName)}</p>
            <p style="margin:5px 0; font-size:14px;"><strong>💰 Bei:</strong> TSh ${Number(order.sellingPrice || 0).toLocaleString()}</p>
            <p style="margin:5px 0; font-size:14px;"><strong>📍 Eneo:</strong> ${escapeHtml(order.location)}</p>
            <p style="margin:5px 0; font-size:14px;"><strong>📞 Simu:</strong> ${escapeHtml(order.customerPhone)}</p>
            <p style="margin:10px 0; padding:8px 12px; background:#f0f0f0; border-radius:6px; display:inline-block; font-weight:bold; font-size:13px;">Status: ${statusBadge}</p>
            
            <div style="margin-top: 12px;">
              <a href="/track/invoice?id=${order.orderId}" target="_blank" style="background: #007bff; color: white; padding: 10px 14px; border-radius: 6px; text-decoration: none; font-weight: bold; font-size: 13px; display: inline-block; width: 100%; text-align: center; box-sizing: border-box;">📄 Tazama Risiti Yako (Digital Invoice)</a>
            </div>

            ${reviewSection}
            ${publicReviewsHtml}

            <div style="margin-top: 15px; text-align: center;">
              <a href="https://wa.me/${botPhone}?text=${reportFraudMsg}" target="_blank" style="color: #dc3545; font-size: 12px; font-weight: bold; text-decoration: underline;">🚨 Ripoti Dhuluma / Tatizo hapa</a>
            </div>
          </div>`;
        }
      } else {
        resultHtml = `<div style="background:#f8d7da; color:#721c24; padding:12px; border-radius:6px; margin-top:20px; text-align:center; font-size:14px;">❌ Hakuna Oda yenye Namba #${searchId}.</div>`;
      }
    }
    const backCatalogUrl = shopId ? `/catalog?shop=${shopId}` : '/catalog';
    res.send(`
    <!DOCTYPE html>
    <html lang="${req.lang}">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Fuatilia Oda - Winga Shop</title>
      <style>
        * { box-sizing: border-box; }
        body { font-family: sans-serif; background: #f4f6f8; margin: 0; padding: 0; color: #333; }
        .container { max-width: 500px; margin: 0 auto; padding: 15px; }
        h1 { text-align: center; color: #111; font-size: 22px; }
        .search-box { background: white; padding: 15px; border-radius: 10px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
        input[type="number"] { width: 100%; padding: 12px; border: 1px solid #ccc; border-radius: 6px; box-sizing: border-box; font-size: 16px; margin-bottom: 12px; }
        button.btn-search { width: 100%; background: #007bff; color: white; border: none; padding: 12px; border-radius: 6px; font-weight: bold; font-size: 15px; cursor: pointer; }
        .back-link { display: block; text-align: center; margin-top: 15px; color: #666; text-decoration: none; font-size: 14px; }
      </style>
    </head>
    <body>
      ${getLangBar(req)}
      <div class="container">
        <h1>🔍 Fuatilia Oda Yako</h1>
        <div class="search-box">
          <form action="/track" method="GET">
            ${shopId ? `<input type="hidden" name="shop" value="${shopId}">` : ''}
            <label style="display:block; margin-bottom:6px; font-weight:600; font-size:13px;">Weka Namba ya Oda (Order ID):</label>
            <input type="number" name="id" placeholder="mfano: 1" value="${searchId || ''}" required>
            <button type="submit" class="btn-search">Angalia Status</button>
          </form>
        </div>
        ${resultHtml}
        <a href="${backCatalogUrl}" class="back-link">← Rudi Kwenye Catalog</a>
      </div>
    </body>
    </html>
    `);
  } catch (err) {
    res.status(500).send('Hitilafu imetokea.');
  }
});

app.post('/track/verify', async (req, res) => {
  try {
    const { orderId, phone, shop } = req.body;
    const oid = parseInt(orderId);
    const inputPhone = (phone || '').trim();
    if (!oid || !inputPhone) return res.redirect('/track');

    const order = await db('orders').where({ orderId: oid }).first();
    if (!order) return res.redirect('/track');

    const dbPhone = (order.customerPhone || '').trim().replace(/\D/g, '');
    const cleanInput = inputPhone.replace(/\D/g, '');

    const isMatch = dbPhone === cleanInput || dbPhone.endsWith(cleanInput) || cleanInput.endsWith(dbPhone);
    if (isMatch) {
      if (!req.session.verifiedOrders) req.session.verifiedOrders = {};
      req.session.verifiedOrders[oid] = true;
    } else {
      return res.send(`<div style="text-align:center; padding:40px; font-family:sans-serif;"><h3 style="color:#dc3545;">❌ Namba ya Simu Si Sahihi!</h3><a href="/track?id=${oid}">Jaribu Tena</a></div>`);
    }
    res.redirect(`/track?id=${oid}${shop ? '&shop=' + shop : ''}`);
  } catch (err) {
    res.redirect('/track');
  }
});

app.get('/track/invoice', async (req, res) => {
  try {
    const orderId = parseInt(req.query.id);
    if (!orderId) return res.send('❌ Oda haipatikani.');

    const verifiedOrders = req.session.verifiedOrders || {};
    if (!verifiedOrders[orderId]) {
      return res.send(`<div style="text-align:center; padding:40px; font-family:sans-serif;"><h3 style="color:#dc3545;">❌ Huna Ruhusa!</h3><p>Thibitisha namba yako kwanza.</p><a href="/track?id=${orderId}">Fuatilia Oda</a></div>`);
    }

    const order = await db('orders').where({ orderId }).first();
    if (!order) return res.send('❌ Oda haipatikani.');
    const winga = await db('wingas').where({ id: order.wingaId }).first();
    const shopLink = `${PUBLIC_URL}/catalog?shop=${winga ? winga.id : 1}`;

    res.send(`
    <!DOCTYPE html>
    <html lang="sw">
    <head>
      <meta charset="UTF-8">
      <title>Risiti #${order.orderId}</title>
      <style>
        body { font-family: monospace; background: #fff; color: #000; padding: 20px; max-width: 420px; margin: 20px auto; border: 1px solid #ddd; border-radius: 8px; box-sizing: border-box; }
        .center { text-align: center; }
        hr { border: dashed 1px #888; }
        .btn-print { background: #007bff; color: white; border: none; padding: 12px; width: 100%; cursor: pointer; font-weight: bold; margin-top: 20px; border-radius: 6px; }
        @media print { .btn-print { display: none; } }
      </style>
    </head>
    <body>
      <div class="center">
        <h2>🛍️ ${escapeHtml(winga ? winga.name : 'Winga Shop')}</h2>
        <p>Simu: ${escapeHtml(winga ? winga.phone : '-')}</p>
        <hr>
        <h3>RISITI YA MAUZO (INVOICE)</h3>
      </div>
      <p><strong>Oda #:</strong> #${order.orderId}</p>
      <p><strong>Tarehe:</strong> ${new Date(order.date).toLocaleDateString('sw-TZ')}</p>
      <p><strong>Mteja:</strong> ${escapeHtml(order.customerPhone)}</p>
      <p><strong>Eneo:</strong> ${escapeHtml(order.location)}</p>
      <hr>
      <p><strong>Bidhaa:</strong> ${escapeHtml(order.productName)}</p>
      <p><strong>Bei:</strong> TSh ${Number(order.sellingPrice || 0).toLocaleString()}</p>
      <hr>
      <p class="center"><strong>Status:</strong> ${escapeHtml(order.status)}</p>
      <button class="btn-print" onclick="window.print()">🖨️ Chapisha / Hifadhi kama PDF</button>
    </body>
    </html>
    `);
  } catch (err) {
    res.status(500).send('Hitilafu kwenye risiti.');
  }
});

app.post('/track/review', async (req, res) => {
  try {
    const { orderId, rating, comment } = req.body;
    const oid = parseInt(orderId);
    const verifiedOrders = req.session.verifiedOrders || {};
    if (!verifiedOrders[oid]) return res.redirect(`/track?id=${oid}`);

    const existing = await db('reviews').where({ orderId: oid }).first();
    if (existing) {
      await db('reviews').where({ orderId: oid }).update({ rating: parseInt(rating), comment: comment.trim(), date: new Date() });
    } else {
      await db('reviews').insert({ orderId: oid, rating: parseInt(rating), comment: comment.trim(), date: new Date() });
    }
    res.redirect(`/track?id=${oid}`);
  } catch (err) {
    res.redirect('/track');
  }
});

// Login Page
app.get('/login', (req, res) => {
  if (req.session && req.session.isSuperAdmin) return res.redirect('/superadmin');
  if (req.session && req.session.wingaId) return res.redirect('/admin');

  res.send(`
  <!DOCTYPE html>
  <html lang="${req.lang}">
  <head>
    <meta charset="UTF-8">
    <title>Winga Portal Login</title>
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
      * { box-sizing: border-box; }
      body { font-family: sans-serif; background: rgb(106, 136, 232); margin: 0; padding: 0; display: flex; flex-direction: column; min-height: 100vh; }
      .content { flex: 1; display: flex; justify-content: center; align-items: center; padding: 15px; }
      .login-box { background: white; padding: 25px; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.15); text-align: center; width: 100%; max-width: 320px; }
      input { padding: 11px; width: 100%; margin: 8px 0 14px 0; border: 1px solid #4092e5; border-radius: 4px; box-sizing: border-box; font-size: 15px; }
      button.submit-btn { background: #28a745; color: white; border: none; padding: 12px; border-radius: 4px; cursor: pointer; font-size: 16px; width: 100%; font-weight: bold; }
      a { color: #007bff; text-decoration: none; font-size: 13px; display: block; margin-top: 10px; }
    </style>
  </head>
  <body>
    ${getLangBar(req)}
    <div class="content">
      <div class="login-box">
        <h2 style="margin-top:0; font-size:22px;">🛍️ Winga Portal Login</h2>
        <form action="/login" method="POST">
          <label style="display:block; text-align:left; font-size:12px; font-weight:bold;">Namba ya Simu:</label>
          <input type="text" name="phone" placeholder="0712345678" required>
          
          <label style="display:block; text-align:left; font-size:12px; font-weight:bold;">Password:</label>
          <input type="password" name="password" placeholder="••••••••" required>

          <button type="submit" class="submit-btn">Ingia Dashboard</button>
        </form>
        <a href="/forgot-password">🔑 Umesahau Nenosiri?</a>
        <a href="/register" style="color: #28a745; font-weight: bold;">📝 Jisajili kama Muuzaji Mpya</a>
      </div>
    </div>
  </body>
  </html>
  `);
});

app.post('/login', async (req, res) => {
  try {
    const identifier = (req.body.phone || '').trim();
    const password = (req.body.password || '').trim();
    if (!identifier || !password) return res.send('❌ Jaza taarifa zote.');

    const superAdminPhone1 = process.env.SUPERADMIN_PHONE_1 || '0700000001';
    const superAdminPass1 = process.env.SUPERADMIN_PASS_1 || 'SuperSecurePass123!';
    const superAdminPhone2 = process.env.SUPERADMIN_PHONE_2 || '0700000002';
    const superAdminPass2 = process.env.SUPERADMIN_PASS_2 || 'SuperSecurePass456!';
    
    if ((identifier === superAdminPhone1 && password === superAdminPass1) || (identifier === superAdminPhone2 && password === superAdminPass2)) {
      req.session.isSuperAdmin = true;
      return res.redirect('/superadmin');
    }

    const matchedWinga = await db('wingas').where({ phone: identifier }).first();
    if (matchedWinga) {
      const isPasswordValid = await bcrypt.compare(password, matchedWinga.password);
      if (isPasswordValid) {
        req.session.wingaId = matchedWinga.id;
        req.session.wingaName = matchedWinga.name;
        return res.redirect('/admin');
      }
    }
    res.send('❌ Taarifa za kuingia sio sahihi. <a href="/login">Jaribu Tena</a>');
  } catch (err) {
    res.status(500).send('Hitilafu ya Server.');
  }
});

// Self Registration
app.get('/register', (req, res) => {
  res.send(`
  <!DOCTYPE html>
  <html lang="${req.lang}">
  <head>
    <meta charset="UTF-8">
    <title>Usajili - Winga Shop</title>
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
      body { font-family: sans-serif; background: rgb(106, 136, 232); margin: 0; display: flex; flex-direction: column; min-height: 100vh; }
      .content { flex: 1; display: flex; justify-content: center; align-items: center; padding: 15px; }
      .box { background: white; padding: 25px; border-radius: 8px; width: 100%; max-width: 350px; }
      input, select { padding: 10px; width: 100%; margin: 6px 0 12px 0; border: 1px solid #4092e5; border-radius: 4px; box-sizing: border-box; font-size: 14px; }
      label { display: block; text-align: left; font-size: 12px; font-weight: bold; color: #333; }
      button { background: #28a745; color: white; border: none; padding: 12px; border-radius: 4px; cursor: pointer; font-size: 16px; font-weight: bold; width: 100%; margin-top: 10px; }
      a { color: #007bff; text-decoration: none; font-size: 13px; display: block; text-align: center; margin-top: 15px; }
    </style>
  </head>
  <body>
    ${getLangBar(req)}
    <div class="content">
      <div class="box">
        <h2 style="text-align:center; margin-top:0;">📝 Usajili wa Muuzaji</h2>
        <form action="/register" method="POST">
          <label>Jina la Duka / Lako:</label>
          <input type="text" name="name" placeholder="Mf: Boss Store" required>

          <label>Namba ya Simu (WhatsApp):</label>
          <input type="tel" name="phone" placeholder="0712345678" maxlength="10" required>

          <label>Mkoa:</label>
          <input type="text" name="region" placeholder="Mf: Dar es Salaam" required>

          <label>Wilaya:</label>
          <input type="text" name="district" placeholder="Mf: Kinondoni" required>

          <label>Kata / Mtaa:</label>
          <input type="text" name="ward" placeholder="Mf: Mwenge" required>

          <label>Nenosiri (Password):</label>
          <input type="password" name="password" placeholder="••••••••" required>

          <button type="submit">Jisajili Sasa</button>
        </form>
        <a href="/login">← Tayari una akaunti? Ingia hapa</a>
      </div>
    </div>
  </body>
  </html>
  `);
});

app.post('/register', async (req, res) => {
  try {
    const { name, phone, region, district, ward, password } = req.body;
    if (!name || !phone || !region || !district || !ward || !password) {
      return res.send('❌ Jaza taarifa zote. <a href="/register">Jaribu Tena</a>');
    }
    const existing = await db('wingas').where({ phone }).first();
    if (existing) return res.send('❌ Namba hii imesajiliwa tayari! <a href="/login">Ingia</a>');

    const fullLocation = `${ward}, ${district}, ${region}`;
    const hashedPassword = await bcrypt.hash(password, 10);
    const expiry = new Date();
    expiry.setDate(expiry.getDate() + 30);

    await db('wingas').insert({
      name, phone, location: fullLocation, password: hashedPassword, status: 'active', expiryDate: expiry, dateAdded: new Date()
    });

    res.send(`<div style="text-align:center; padding:30px; font-family:sans-serif;"><h2 style="color:#28a745;">🎉 Usajili Umefanikiwa!</h2><a href="/login">Ingia Kwenye Dashboard Yako</a></div>`);
  } catch (err) {
    res.status(500).send('Hitilafu ya Server.');
  }
});

app.all('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.redirect('/login');
  });
});

// Forgot Password & Reset Password Routes
app.get('/forgot-password', (req, res) => {
  res.send(`
  <!DOCTYPE html>
  <html>
  <head>
    <title>Umesahau Nenosiri</title>
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
      body { font-family: sans-serif; background: rgb(106, 136, 232); display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; padding: 15px; }
      .box { background: white; padding: 25px; border-radius: 8px; text-align: center; width: 100%; max-width: 320px; }
      input { padding: 11px; width: 100%; margin: 10px 0; border: 1px solid #4092e5; border-radius: 4px; box-sizing: border-box; }
      button { background: #007bff; color: white; border: none; padding: 12px; border-radius: 4px; cursor: pointer; font-size: 16px; font-weight: bold; width: 100%; }
      a { color: #007bff; text-decoration: none; font-size: 14px; display: block; margin-top: 15px; }
    </style>
  </head>
  <body>
    <div class="box">
      <h2>🔑 Umesahau Nenosiri?</h2>
      <p style="color:#666; font-size:13px;">Weka namba yako ya simu kupata OTP WhatsApp.</p>
      <form action="/forgot-password" method="POST">
        <input type="text" name="phone" placeholder="0712345678" required>
        <button type="submit">Tuma Kodi</button>
      </form>
      <a href="/login">← Rudi Kwenye Login</a>
    </div>
  </body>
  </html>
  `);
});

app.post('/forgot-password', async (req, res) => {
  try {
    if (!isWhatsappReady || !sock) {
      return res.status(503).send('❌ WhatsApp haijawa tayari. Subiri sekunde chache ujaribu tena. <br><a href="/forgot-password">Rudi Nyuma</a>');
    }
    const rawPhone = (req.body.phone || '').trim();
    let cleanedPhone = rawPhone.replace(/\D/g, '');
    if (cleanedPhone.startsWith('0')) cleanedPhone = '255' + cleanedPhone.slice(1);

    const winga = await db('wingas').where({ phone: rawPhone }).orWhere({ phone: cleanedPhone }).first();
    if (!winga) return res.send('❌ Namba hii haijasajiliwa. <br><a href="/forgot-password">Jaribu Tena</a>');

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    await db('password_resets').where({ phone: winga.phone }).del();
    await db('password_resets').insert({ phone: winga.phone, otp, expiresAt });

    const targetJid = `${cleanedPhone}@s.whatsapp.net`;
    await sock.sendMessage(targetJid, { text: `🔑 Kodi yako ya OTP ni: *${otp}* (Inaisha baada ya dakika 10).` });

    res.send(`
    <!DOCTYPE html>
    <html>
    <head><title>Reset Password</title></head>
    <body style="font-family:sans-serif; background:rgb(106, 136, 232); display:flex; justify-content:center; align-items:center; height:100vh; margin:0; padding:15px;">
      <div style="background:white; padding:25px; border-radius:8px; text-align:center; width:100%; max-width:320px;">
        <h2>🔐 Weka Nenosiri Jipya</h2>
        <form action="/reset-password" method="POST">
          <input type="hidden" name="phone" value="${escapeHtml(winga.phone)}">
          <input type="text" name="otp" placeholder="Kodi ya OTP" required style="width:100%; padding:11px; margin:8px 0; box-sizing:border-box;">
          <input type="password" name="newPassword" placeholder="Nenosiri Jipya" required style="width:100%; padding:11px; margin:8px 0; box-sizing:border-box;">
          <input type="password" name="confirmPassword" placeholder="Rudia Nenosiri Jipya" required style="width:100%; padding:11px; margin:8px 0; box-sizing:border-box;">
          <button type="submit" style="background:#28a745; color:white; border:none; padding:12px; width:100%; font-weight:bold; cursor:pointer; border-radius:4px; margin-top:8px;">Hifadhi</button>
        </form>
      </div>
    </body>
    </html>
    `);
  } catch (err) {
    res.status(500).send(`❌ Hitilafu: ${escapeHtml(err.message)}`);
  }
});

app.post('/reset-password', async (req, res) => {
  try {
    const { phone, otp, newPassword, confirmPassword } = req.body;
    if (newPassword !== confirmPassword || newPassword.length < 6) {
      return res.send('❌ Nenosiri hazifanani au ni fupi mno. <br><a href="/forgot-password">Jaribu Tena</a>');
    }
    const resetRecord = await db('password_resets').where({ phone: phone.trim(), otp: otp.trim() }).where('expiresAt', '>', new Date()).first();
    if (!resetRecord) return res.send('❌ Kodi si sahihi au imeisha muda wake. <br><a href="/forgot-password">Omba Mpya</a>');

    const hashedPassword = await bcrypt.hash(newPassword.trim(), 10);
    await db('wingas').where({ phone: phone.trim() }).update({ password: hashedPassword });
    await db('password_resets').where({ phone: phone.trim() }).del();

    res.send(`<div style="text-align:center; padding:50px; font-family:sans-serif;"><h2 style="color:#28a745;">🎉 Hongera!</h2><p>Nenosiri limebadilishwa.</p><a href="/login">Ingia Login</a></div>`);
  } catch (err) {
    res.status(500).send('❌ Hitilafu ya Server.');
  }
});

// Admin Dashboard with Predefined Category and Color Dropdowns & Change Password
app.get('/admin', requireWinga, async (req, res) => {
  try {
    const currentWinga = await db('wingas').where({ id: req.session.wingaId }).first();
    const botPhone = process.env.BOT_PHONE_NUMBER || '255678143403';
    
    if (currentWinga && currentWinga.status === 'suspended') {
      const renewalMsg = encodeURIComponent(`Habari Admin, nimefanya malipo ya siku 30 ya duka langu (${currentWinga.name}). Naomba unifungulie akaunti.`);
      return res.send(`
      <!DOCTYPE html>
      <html lang="sw">
      <head>
        <meta charset="UTF-8"><title>Akaunti Imesitishwa</title>
        <style>
          body { font-family: sans-serif; background: #f8f9fa; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; text-align: center; padding: 20px; }
          .box { background: white; padding: 30px; border-radius: 10px; max-width: 400px; box-shadow: 0 4px 15px rgba(0,0,0,0.1); }
          h1 { color: #dc3545; }
          .whatsapp-btn { background: #25D366; color: white; padding: 12px 20px; border-radius: 6px; text-decoration: none; font-weight: bold; display: inline-block; margin-top: 15px; width: 100%; box-sizing: border-box; }
        </style>
      </head>
      <body>
        <div class="box">
          <h1>⚠️ Akaunti Imesitishwa</h1>
          <p>Muda wako wa siku 30 umekwisha. Fanya malipo kupitia namba ya Admin kisha bonyeza hapa chini kuomba kufunguliwa.</p>
          <a href="https://wa.me/${botPhone}?text=${renewalMsg}" target="_blank" class="whatsapp-btn">💬 Wasiliana na Admin (WhatsApp)</a>
          <a href="/logout" style="display:block; margin-top:15px; color:#007bff; text-decoration:none;">Logout</a>
        </div>
      </body>
      </html>
      `);
    }

    const currentWingaId = req.session.wingaId;
    const currentWingaName = req.session.wingaName;
    const products = await db('products').where({ wingaId: currentWingaId });
    const orders = await db('orders').where({ wingaId: currentWingaId });
    const reviews = await db('reviews').select('*');

    let subscriptionBanner = '';
    if (currentWinga && currentWinga.expiryDate) {
      const expiryDate = new Date(currentWinga.expiryDate);
      const daysLeft = Math.ceil((expiryDate - new Date()) / (1000 * 60 * 60 * 24));
      subscriptionBanner = `<div style="background: ${daysLeft <= 3 ? '#fff3cd' : '#e8f5e9'}; color: ${daysLeft <= 3 ? '#856404' : '#2e7d32'}; padding: 12px; border-radius: 8px; margin-bottom: 20px; font-size: 13px;">⏳ Muda wa akaunti: <strong>siku ${daysLeft > 0 ? daysLeft : 0}</strong> zilizobaki.</div>`;
    }

    let totalRevenue = 0, totalCost = 0, completedOrdersCount = 0;
    orders.forEach(o => {
      if (o.status === 'Completed') {
        const selling = Number(o.sellingPrice || o.price || 0);
        let buying = Number(o.buyingPrice || 0);
        if (!buying) {
          const matchedProduct = products.find(p => p.name === o.productName);
          buying = matchedProduct ? Number(matchedProduct.buyingPrice || 0) : 0;
        }
        totalRevenue += selling;
        totalCost += buying;
        completedOrdersCount++;
      }
    });
    const netProfit = totalRevenue - totalCost;
    const shopUrl = `${PUBLIC_URL}/catalog?shop=${currentWingaId}`;

    let categorySelectOptions = PREDEFINED_CATEGORIES.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
    let colorSelectOptions = PREDEFINED_COLORS.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');

    let productRows = products.map(p => `
      <tr>
        <td><strong>#${p.id}</strong></td>
        <td>${escapeHtml(p.name)}</td>
        <td>${escapeHtml(p.category)}</td>
        <td>TSh ${Number(p.buyingPrice || 0).toLocaleString()}</td>
        <td>TSh ${Number(p.sellingPrice || 0).toLocaleString()}</td>
        <td>${escapeHtml(p.size || 'Standard')}</td>
        <td>${escapeHtml(p.colors || 'Kama pichani')}</td>
        <td>
          <form action="/admin/product/delete" method="POST" onsubmit="return confirm('Futa bidhaa hii?');">
            <input type="hidden" name="id" value="${p.id}">
            <button type="submit" style="background:#dc3545; color:white; border:none; padding:4px 8px; border-radius:4px; cursor:pointer;">🗑️ Delete</button>
          </form>
        </td>
      </tr>
    `).join('');

    let orderRows = orders.map(o => `
      <tr>
        <td><strong>#${o.orderId}</strong></td>
        <td>${escapeHtml(o.productName)}</td>
        <td>TSh ${Number(o.sellingPrice || 0).toLocaleString()}</td>
        <td>${escapeHtml(o.location)}</td>
        <td>${escapeHtml(o.customerPhone)}</td>
        <td><strong>${escapeHtml(o.status)}</strong></td>
        <td>
          <a href="/admin/order/invoice?id=${o.orderId}" target="_blank" style="background:#007bff; color:white; padding:4px 8px; border-radius:4px; text-decoration:none; font-size:11px;">📄 Risiti</a>
          <form action="/admin/order/status" method="POST" style="display:inline; margin-left:4px;">
            <input type="hidden" name="orderId" value="${o.orderId}">
            ${o.status !== 'Dispatched' && o.status !== 'Completed' ? `<button type="submit" name="status" value="Dispatched" style="background:#17a2b8; color:white; border:none; padding:4px 6px; border-radius:4px; font-size:11px; cursor:pointer;">🚚 Dispatch</button>` : ''}
            ${o.status !== 'Completed' ? `<button type="submit" name="status" value="Completed" style="background:#28a745; color:white; border:none; padding:4px 6px; border-radius:4px; font-size:11px; cursor:pointer;">✅ Complete</button>` : ''}
          </form>
        </td>
      </tr>
    `).join('');

    res.send(`
    <!DOCTYPE html>
    <html lang="sw">
    <head>
      <title>Winga Dashboard - ${escapeHtml(currentWingaName)}</title>
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <style>
        body { font-family: sans-serif; background: #f4f6f8; margin: 0; padding: 15px; color: #333; }
        .container { max-width: 1000px; margin: 0 auto; }
        .card { background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); margin-bottom: 20px; }
        input, select { width: 100%; padding: 10px; margin: 6px 0 12px 0; border: 1px solid #ccc; border-radius: 4px; box-sizing: border-box; }
        button.btn-add { background: #28a745; color: white; border: none; padding: 12px; width: 100%; font-weight: bold; border-radius: 4px; cursor: pointer; }
        table { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 13px; }
        th, td { text-align: left; padding: 8px; border-bottom: 1px solid #eee; }
        th { background: #f8f9fa; }
      </style>
    </head>
    <body>
      <div class="container">
        ${subscriptionBanner}
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:15px;">
          <h2>🛍️ Dashboard: ${escapeHtml(currentWingaName)}</h2>
          <a href="/logout" style="color:#dc3545; font-weight:bold; text-decoration:none;">Logout</a>
        </div>

        <div class="card" style="background: #e3f2fd;">
          <h3>🔗 Link Yako ya Duka</h3>
          <input type="text" value="${shopUrl}" readonly style="background:white; font-weight:bold;">
        </div>

        <div class="card">
          <h2>🔑 Badilisha Nenosiri</h2>
          <form id="changePasswordForm">
            <label>Nenosiri la Zamani:</label>
            <input type="password" id="oldPassword" required>
            <label>Nenosiri Jipya:</label>
            <input type="password" id="newPassword" required>
            <label>Rudia Nenosiri Jipya:</label>
            <input type="password" id="confirmPassword" required>
            <button type="submit" style="background:#007bff; color:white; border:none; padding:10px; border-radius:4px; font-weight:bold; cursor:pointer; width:100%;">Hifadhi Nenosiri</button>
          </form>
        </div>
        <script>
          document.getElementById('changePasswordForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            const oldPassword = document.getElementById('oldPassword').value;
            const newPassword = document.getElementById('newPassword').value;
            const confirmPassword = document.getElementById('confirmPassword').value;
            try {
              const res = await fetch('/admin/change-password', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ oldPassword, newPassword, confirmPassword })
              });
              const data = await res.json();
              alert(data.message);
              if (res.ok) document.getElementById('changePasswordForm').reset();
            } catch (err) { alert('Hitilafu ya mtandao.'); }
          });
        </script>

        <div class="card">
          <h2>Weka Bidhaa Mpya kwenye Katalogi</h2>
          <form action="/admin/add" method="POST" enctype="multipart/form-data">
            <label>Jina la Bidhaa:</label>
            <input type="text" name="name" required>

            <label>Aina (Category):</label>
            <select name="category" required>
              <option value="">-- Chagua Category --</option>
              ${categorySelectOptions}
            </select>

            <div style="display:flex; gap:10px;">
              <div style="flex:1;"><label>Bei ya Kununua:</label><input type="number" name="buyingPrice" required></div>
              <div style="flex:1;"><label>Bei ya Kuuzia:</label><input type="number" name="sellingPrice" required></div>
            </div>

            <label>Size Zinazopatikana (Tenganisha kwa koma):</label>
            <input type="text" name="size" value="Standard, S, M, L, XL" required>

            <label>Rangi (Chagua auandike):</label>
            <select name="colors" required>
              ${colorSelectOptions}
            </select>

            <label>Picha za Bidhaa (Max 4):</label>
            <input type="file" name="images" accept="image/*" multiple required>

            <button type="submit" class="btn-add">Upload & Add Product</button>
          </form>
        </div>

        <div class="card">
          <h2>Oda za Wateja (${orders.length})</h2>
          <table>
            <thead><tr><th>Oda #</th><th>Bidhaa</th><th>Bei</th><th>Eneo</th><th>Simu</th><th>Status</th><th>Action</th></tr></thead>
            <tbody>${orderRows || '<tr><td colspan="7">Hakuna oda bado.</td></tr>'}</tbody>
          </table>
        </div>

        <div class="card">
          <h2>Bidhaa Zako kwenye Katalogi (${products.length})</h2>
          <table>
            <thead><tr><th>ID</th><th>Jina</th><th>Category</th><th>Kununua</th><th>Kuuzia</th><th>Size</th><th>Rangi</th><th>Action</th></tr></thead>
            <tbody>${productRows || '<tr><td colspan="8">Huna bidhaa zilizosajiliwa.</td></tr>'}</tbody>
          </table>
        </div>
      </div>
    </body>
    </html>
    `);
  } catch (err) {
    res.status(500).send('Hitilafu ya Server.');
  }
});

app.get('/admin/order/invoice', requireWinga, async (req, res) => {
  try {
    const orderId = parseInt(req.query.id);
    const order = await db('orders').where({ orderId, wingaId: req.session.wingaId }).first();
    if (!order) return res.send('❌ Oda haipatikani.');
    const winga = await db('wingas').where({ id: req.session.wingaId }).first();

    res.send(`
    <!DOCTYPE html>
    <html lang="sw">
    <head><title>Risiti #${order.orderId}</title>
    <style>body { font-family: monospace; padding: 20px; max-width: 400px; margin: auto; border: 1px solid #ccc; }</style>
    </head>
    <body>
      <h2 style="text-align:center;">${escapeHtml(winga.name)}</h2>
      <hr>
      <p><strong>Oda #:</strong> #${order.orderId}</p>
      <p><strong>Mteja:</strong> ${escapeHtml(order.customerPhone)}</p>
      <p><strong>Bidhaa:</strong> ${escapeHtml(order.productName)}</p>
      <p><strong>Bei:</strong> TSh ${Number(order.sellingPrice || 0).toLocaleString()}</p>
      <button onclick="window.print()" style="width:100%; padding:10px; background:#007bff; color:white; border:none; margin-top:15px; cursor:pointer;">Chapisha</button>
    </body>
    </html>
    `);
  } catch (err) {
    res.status(500).send('Hitilafu.');
  }
});

app.post('/admin/add', requireWinga, (req, res) => {
  upload(req, res, async (err) => {
    if (err) return res.redirect('/admin');
    try {
      const { name, category, buyingPrice, sellingPrice, size, colors } = req.body;
      const files = req.files || [];
      let imageUrls = [];

      for (const file of files) {
        const uploadResult = await new Promise((resolve, reject) => {
          const stream = cloudinary.uploader.upload_stream({ folder: 'winga_shop_products' }, (error, result) => {
            if (error) reject(error); else resolve(result);
          });
          stream.end(file.buffer);
        });
        if (uploadResult && uploadResult.secure_url) imageUrls.push(uploadResult.secure_url);
      }

      const [insertedId] = await db('products').insert({
        wingaId: req.session.wingaId,
        name: name.trim(),
        category: category.trim(),
        buyingPrice: parseFloat(buyingPrice || 0),
        sellingPrice: parseFloat(sellingPrice || 0),
        price: parseFloat(sellingPrice || 0),
        size: size ? size.trim() : 'Standard',
        colors: colors ? colors.trim() : 'Kama pichani',
        imageUrl: JSON.stringify(imageUrls),
        dateAdded: new Date()
      });

      const newProduct = await db('products').where({ id: insertedId }).first();
      const currentWinga = await db('wingas').where({ id: req.session.wingaId }).first();
      if (currentWinga && newProduct) {
        await notifyShopCustomers(currentWinga, newProduct);
      }

      res.redirect('/admin');
    } catch (dbErr) {
      res.redirect('/admin');
    }
  });
});

app.post('/admin/product/delete', requireWinga, async (req, res) => {
  try {
    await db('products').where({ id: parseInt(req.body.id), wingaId: req.session.wingaId }).del();
  } catch (err) {}
  res.redirect('/admin');
});

app.post('/admin/order/status', requireWinga, async (req, res) => {
  try {
    const { orderId, status } = req.body;
    const order = await db('orders').where({ orderId: parseInt(orderId), wingaId: req.session.wingaId }).first();
    if (order) {
      await db('orders').where({ orderId: parseInt(orderId), wingaId: req.session.wingaId }).update({ status });
      let customerChatId = order.senderJid;
      if (!customerChatId || !customerChatId.includes('@s.whatsapp.net')) {
        let phone = (order.customerPhone || '').trim().replace('+', '');
        if (phone.startsWith('0')) phone = '255' + phone.slice(1);
        if (phone) customerChatId = phone + '@s.whatsapp.net';
      }
      if (customerChatId && isWhatsappReady && sock) {
        let statusMessage = '';
        const trackUrl = `${PUBLIC_URL}/track?id=${order.orderId}`;
        if (status === 'Dispatched') {
          statusMessage = `🚚 *ODA YAKO IPO NJIANI!* 🚚\nOda #${order.orderId} (${order.productName}) imeandaliwa na iko njiani.\n\nFuatilia hapa:\n${trackUrl}`;
        } else if (status === 'Completed') {
          statusMessage = `✅ *ODA YAKO IMEKAMILIKA!* 🎉\nOda #${order.orderId} imewasilishwa.\n\nTafadhali toa maoni na nyota kwa kubonyeza link hii:\n${trackUrl}`;
        }
        if (statusMessage) {
          await sock.sendMessage(customerChatId, { text: statusMessage });
        }
      }
    }
  } catch (err) {}
  res.redirect('/admin');
});

app.post('/admin/change-password', requireWinga, async (req, res) => {
  const wingaId = req.session.wingaId;
  const { oldPassword, newPassword, confirmPassword } = req.body;
  if (!oldPassword || !newPassword || !confirmPassword) {
    return res.status(400).json({ success: false, message: 'Tafadhali jaza nafasi zote.' });
  }
  if (newPassword !== confirmPassword) {
    return res.status(400).json({ success: false, message: 'Nenosiri jipya halifanani.' });
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ success: false, message: 'Nenosiri lazima liwe na angalau herufi 6.' });
  }
  try {
    const winga = await db('wingas').where({ id: wingaId }).first();
    if (!winga) return res.status(404).json({ success: false, message: 'Winga hakupatikana.' });
    const isValidOld = await bcrypt.compare(oldPassword, winga.password);
    if (!isValidOld) return res.status(400).json({ success: false, message: 'Nenosiri la zamani si sahihi.' });
    const hashedNewPassword = await bcrypt.hash(newPassword, 10);
    await db('wingas').where({ id: wingaId }).update({ password: hashedNewPassword });
    return res.json({ success: true, message: '✅ Nenosiri limebadilishwa kikamilifu!' });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Hitilafu ya server.' });
  }
});

// Super Admin Dashboard
app.get('/superadmin', requireSuperAdmin, async (req, res) => {
  try {
    const wingas = await db('wingas').select('*');
    const products = await db('products').select('*');
    const orders = await db('orders').select('*');

    let wingaRows = wingas.map(w => `
      <tr>
        <td><strong>#${w.id}</strong></td>
        <td>${escapeHtml(w.name)} (${escapeHtml(w.location || '')})</td>
        <td>${escapeHtml(w.phone)}</td>
        <td>${escapeHtml(w.status)}</td>
        <td>
          <div style="display:flex; gap:4px;">
            <form action="/superadmin/winga/status" method="POST" style="display:inline;">
              <input type="hidden" name="wingaId" value="${w.id}">
              <input type="hidden" name="status" value="${w.status === 'active' ? 'suspended' : 'active'}">
              <button type="submit" style="background:${w.status === 'active' ? '#dc3545' : '#28a745'}; color:white; border:none; padding:4px 8px; border-radius:4px; cursor:pointer;">${w.status === 'active' ? 'Suspend' : 'Activate'}</button>
            </form>
            <form action="/superadmin/winga/extend" method="POST" style="display:inline;">
              <input type="hidden" name="wingaId" value="${w.id}">
              <button type="submit" style="background:#007bff; color:white; border:none; padding:4px 8px; border-radius:4px; cursor:pointer;">+30 Days</button>
            </form>
          </div>
        </td>
      </tr>
    `).join('');

    let productRows = products.map(p => `
      <tr>
        <td><strong>#${p.id}</strong></td>
        <td>${escapeHtml(p.name)}</td>
        <td>TSh ${Number(p.sellingPrice || 0).toLocaleString()}</td>
        <td>
          <form action="/superadmin/product/delete" method="POST" onsubmit="return confirm('Futa bidhaa hii?');">
            <input type="hidden" name="id" value="${p.id}">
            <button type="submit" style="background:#dc3545; color:white; border:none; padding:4px 8px; border-radius:4px; cursor:pointer;">🗑️ Delete</button>
          </form>
        </td>
      </tr>
    `).join('');

    res.send(`
    <!DOCTYPE html>
    <html lang="sw">
    <head><title>Super Admin</title>
    <style>body { font-family: sans-serif; background: #eef2f5; padding: 20px; } table { width:100%; border-collapse:collapse; background:white; margin-bottom:20px; } th,td { padding:10px; border-bottom:1px solid #ddd; text-align:left; }</style>
    </head>
    <body>
      <h1>👑 Super Admin Dashboard</h1>
      <a href="/logout" style="color:red; font-weight:bold; display:inline-block; margin-bottom:15px;">Logout</a>
      
      <h2>➕ Ongeza Muuzaji Mpya</h2>
      <form action="/superadmin/add-winga" method="POST" style="background:white; padding:15px; border-radius:8px; margin-bottom:20px; display:flex; gap:10px; flex-wrap:wrap;">
        <input type="text" name="name" placeholder="Jina la Duka" required style="flex:1; padding:8px;">
        <input type="tel" name="phone" placeholder="Simu (07...)" maxlength="10" required style="flex:1; padding:8px;">
        <input type="password" name="password" placeholder="Password" required style="flex:1; padding:8px;">
        <button type="submit" style="background:#28a745; color:white; border:none; padding:8px 15px; border-radius:4px; cursor:pointer; font-weight:bold;">Sajili</button>
      </form>

      <h2>Wachuuzi (Wingas)</h2>
      <table>
        <thead><tr><th>ID</th><th>Jina</th><th>Simu</th><th>Status</th><th>Action</th></tr></thead>
        <tbody>${wingaRows || '<tr><td colspan="5">Hakuna wachuuzi.</td></tr>'}</tbody>
      </table>

      <h2>Simamia Bidhaa Zote (Product Moderation)</h2>
      <table>
        <thead><tr><th>ID</th><th>Bidhaa</th><th>Bei</th><th>Action</th></tr></thead>
        <tbody>${productRows || '<tr><td colspan="4">Hakuna bidhaa.</td></tr>'}</tbody>
      </table>
    </body>
    </html>
    `);
  } catch (err) {
    res.status(500).send('Hitilafu.');
  }
});

app.post('/superadmin/winga/status', requireSuperAdmin, async (req, res) => {
  try {
    await db('wingas').where({ id: parseInt(req.body.wingaId) }).update({ status: req.body.status });
  } catch (err) {}
  res.redirect('/superadmin');
});

app.post('/superadmin/winga/extend', requireSuperAdmin, async (req, res) => {
  try {
    const winga = await db('wingas').where({ id: parseInt(req.body.wingaId) }).first();
    if (winga) {
      const baseDate = (winga.expiryDate && new Date(winga.expiryDate) > new Date()) ? new Date(winga.expiryDate) : new Date();
      baseDate.setDate(baseDate.getDate() + 30);
      await db('wingas').where({ id: parseInt(req.body.wingaId) }).update({ expiryDate: baseDate, status: 'active' });
    }
  } catch (err) {}
  res.redirect('/superadmin');
});

app.post('/superadmin/add-winga', requireSuperAdmin, async (req, res) => {
  try {
    const { name, phone, password } = req.body;
    if (!name || !phone || !password) return res.redirect('/superadmin');
    const hashedPassword = await bcrypt.hash(password, 10);
    const expiry = new Date();
    expiry.setDate(expiry.getDate() + 30);

    await db('wingas').insert({
      name, phone, password: hashedPassword, status: 'active', expiryDate: expiry, dateAdded: new Date()
    });
  } catch (err) {}
  res.redirect('/superadmin');
});

app.post('/superadmin/product/delete', requireSuperAdmin, async (req, res) => {
  try {
    await db('products').where({ id: parseInt(req.body.id) }).del();
  } catch (err) {}
  res.redirect('/superadmin');
});

// Cron Job for Expiry Notifications & Suspensions
cron.schedule('0 8 * * *', async () => {
  try {
    if (!isWhatsappReady || !sock) return;
    const wingas = await db('wingas').select('*');
    const now = new Date();
    for (let w of wingas) {
      if (!w.expiryDate) continue;
      const daysLeft = Math.ceil((new Date(w.expiryDate) - now) / (1000 * 60 * 60 * 24));
      const chatId = (w.phone.startsWith('0') ? '255' + w.phone.slice(1) : w.phone) + '@s.whatsapp.net';
      if (daysLeft <= 0 && w.status === 'active') {
        await db('wingas').where({ id: w.id }).update({ status: 'suspended' });
        try { await sock.sendMessage(chatId, { text: `⚠️ Akaunti yako imesitishwa kwa sababu muda wa siku 30 umekwisha.` }); } catch (e) {}
      } else if (daysLeft === 3 && w.status === 'active') {
        try { await sock.sendMessage(chatId, { text: `🔔 Kumbuka: Muda wa duka lako unaisha baada ya siku 3.` }); } catch (e) {}
      }
    }
  } catch (err) {}
});

app.listen(PORT, () => {
  console.log(`🌐 Server active on ${PUBLIC_URL}`);
  connectToWhatsApp();
});