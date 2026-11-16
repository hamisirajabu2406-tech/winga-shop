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

// Authentication Guard Middlewares
function requireWinga(req, res, next) {
  if (!req.session || !req.session.wingaId) {
    return res.redirect('/login');
  }
  next();
}

function requireSuperAdmin(req, res, next) {
  if (!req.session || !req.session.isSuperAdmin) {
    return res.redirect('/login');
  }
  next();
}

// Helper to standardise product image URLs
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

// Helper for escaping HTML attributes
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
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
      if (shouldReconnect) {
        connectToWhatsApp();
      }
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
      } catch (sendErr) {
        console.error(`Failed sending broadcast to ${jid}:`, sendErr.message);
      }
    }
  } catch (err) {
    console.error('Error broadcasting new product notification:', err);
  }
}

async function notifyWinga(order, product) {
  try {
    if (!isWhatsappReady || !sock) return;
    const winga = await db('wingas').where({ id: order.wingaId }).first();
    if (!winga || !winga.phone) return;
    let phone = winga.phone.trim().replace('+', '');
    if (phone.startsWith('0')) {
      phone = '255' + phone.slice(1);
    }
    const wingaChatId = phone + '@s.whatsapp.net';
    const alertMessage =
      `🔔 *ODA MPYA IMETOKA KWENYE DUKA YAKO!* 🛍️\n` +
      `-----------------------------------\n` +
      `🔖 *Namba ya Oda:* #${order.orderId}\n` +
      `📦 *Bidhaa:* ${order.productName}\n` +
      `💰 *Bei ya Kuuzia:* TSh ${Number(order.sellingPrice).toLocaleString()}\n` +
      `💵 *Faida Yako (Profit):* TSh ${(order.sellingPrice - order.buyingPrice).toLocaleString()}\n` +
      `📍 *Eneo la Mteja:* ${order.location}\n` +
      `📞 *Mteja Simu:* ${order.customerPhone}\n\n` +
      `📲 Angalia dashboard yako hapa: ${PUBLIC_URL}/admin`;

    const images = getProductImages(product);
    if (images.length > 0 && images[0]) {
      await sock.sendMessage(wingaChatId, { image: { url: images[0] }, caption: alertMessage });
    } else {
      await sock.sendMessage(wingaChatId, { text: alertMessage });
    }
  } catch (err) {
    console.error('❌ Failed to send alert to Winga:', err);
  }
}

// Public Catalog Route
app.get('/catalog', async (req, res) => {
  try {
    await db('stats').where({ key: 'catalogVisits' }).increment('value', 1);
    const allProducts = await db('products').select('*');
    const wingas = await db('wingas').select('*');
    const shopId = req.query.shop;
    let products = allProducts;
    let shopName = "Soko Letu (All Shops)";
    if (shopId) {
      products = allProducts.filter(p => p.wingaId === parseInt(shopId));
      const matchedWinga = wingas.find(w => w.id === parseInt(shopId));
      if (matchedWinga) {
        shopName = `🛍️ Duka la ${matchedWinga.name}`;
      } else {
        shopName = "⚠️ Duka halipatikani";
        products = [];
      }
    }
    const trackBtnUrl = shopId ? `/track?shop=${shopId}` : '/track';
    const botPhone = process.env.BOT_PHONE_NUMBER || '255678143403';
    const categories = [...new Set(allProducts.map(p => (p.category || 'General').trim()))];

    let categoryOptions = categories.map(cat => `<option value="${escapeHtml(cat.toLowerCase())}">${escapeHtml(cat)}</option>`).join('');
    let shopOptions = wingas.map(w => `<option value="${w.id}" ${shopId == w.id ? 'selected' : ''}>${escapeHtml(w.name)} (${escapeHtml(w.location || 'Tanzania')})</option>`).join('');
    
    let productCards = products.map(p => {
      const sellingPrice = Number(p.sellingPrice || p.price || 0);
      const priceFormatted = sellingPrice > 0 ? sellingPrice.toLocaleString() : 'Haikutajwa';
      const priceDisplay = sellingPrice > 0 ? `TSh ${priceFormatted}` : 'Wasiliana na Muuzaji';

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
            <span style="position: absolute; bottom: 14px; right: 8px; background: rgba(0,0,0,0.65); color: white; padding: 3px 8px; border-radius: 4px; font-size: 11px; font-weight: bold; pointer-events: none;">🔍 Gusa Kukuza</span>
           </div>${galleryThumbnailsHtml}`
        : `<div style="height: 140px; background: #e9ecef; border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 36px; margin-bottom: 10px; color: #adb5bd;">📦</div>`;

      return `
      <div class="product-card" data-name="${escapeHtml(p.name.toLowerCase())}" data-category="${escapeHtml(categoryStr.toLowerCase())}" data-shop="${p.wingaId}" data-shopname="${escapeHtml(sellerName.toLowerCase())}" style="background: white; padding: 12px; border-radius: 10px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); text-align: left; display: flex; flex-direction: column; justify-content: space-between;">
        <div>
          ${imageHtml}
          <div style="margin-bottom: 5px;">
            <span style="background: #e3f2fd; color: #0d47a1; font-size: 10px; padding: 3px 7px; border-radius: 12px; font-weight: bold; text-transform: uppercase;">${escapeHtml(categoryStr)}</span>
            <span style="background: #f1f3f5; color: #495057; font-size: 10px; padding: 3px 7px; border-radius: 12px; font-weight: bold; margin-left: 4px;">Size: ${escapeHtml(availableSizes)}</span>
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
    <html lang="sw">
    <head>
      <meta charset="UTF-8">
      <title>${escapeHtml(shopName)}</title>
      <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
      <style>
        * { box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f4f6f8; margin: 0; padding: 12px; color: #333; }
        .container { max-width: 900px; margin: 0 auto; }
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
          body { padding: 20px; }
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
      <div class="container">
        <div class="header-bar">
          <h1>${escapeHtml(shopName)}</h1>
          <div class="nav-btns">
            <a href="https://wa.me/${botPhone}?text=Habari!%20Naomba%20msaada%20tafadhali" target="_blank" class="contact-btn">💬 Contact Us</a>
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
            <option value="all">📁 Vipengele Vyote (Categories)</option>
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
              <select id="orderSize">
                <option value="Standard">Standard</option>
              </select>
            </div>
            <div class="form-group">
              <label>Rangi (Color):</label>
              <select id="orderColor">
                <option value="Kama pichani">Kama pichani</option>
              </select>
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
            var matchesCat = (catVal === 'all' || cardCat === catVal);
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
          const parsedSizes = sizesStr.split(',').map(s => s.trim()).filter(Boolean);
          if (parsedSizes.length > 0) {
            parsedSizes.forEach(s => {
              const opt = document.createElement('option');
              opt.value = s;
              opt.textContent = s;
              sizeSelect.appendChild(opt);
            });
          } else {
            sizeSelect.innerHTML = '<option value="Standard">Standard</option>';
          }

          const colorSelect = document.getElementById('orderColor');
          colorSelect.innerHTML = '';
          const parsedColors = colorsStr.split(',').map(c => c.trim()).filter(Boolean);
          if (parsedColors.length > 0) {
            parsedColors.forEach(c => {
              const opt = document.createElement('option');
              opt.value = c;
              opt.textContent = c;
              colorSelect.appendChild(opt);
            });
          } else {
            colorSelect.innerHTML = '<option value="Kama pichani">Kama pichani</option>';
          }

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

// Track Route with Public Reviews and Fraud Reporting Option
app.get('/track', async (req, res) => {
  try {
    const searchId = req.query.id ? parseInt(req.query.id) : null;
    let shopId = req.query.shop ? parseInt(req.query.shop) : null;
    let resultHtml = '';
    
    if (searchId) {
      const order = await db('orders').where({ orderId: searchId }).first();
      if (order) {
        if (!shopId && order.wingaId) shopId = order.wingaId;
        const currentStatus = order.status || 'Pending';
        const existingReview = await db('reviews').where({ orderId: searchId }).first();
        const allOrderReviews = await db('reviews').where({ orderId: searchId }).select('*');
        const botPhone = process.env.BOT_PHONE_NUMBER || '255678143403';
        
        let statusBadge = '🟡 Pending (Inashughulikiwa)';
        if (currentStatus === 'Dispatched') statusBadge = '🚚 Dispatched (Ipo Njiani Kuja)';
        if (currentStatus === 'Completed') statusBadge = '✅ Completed (Imekamilika)';

        let reviewSection = '';
        if (currentStatus === 'Completed') {
          if (existingReview) {
            reviewSection = `
            <div style="background:#e8f5e9; padding:15px; border-radius:8px; margin-top:15px;">
              <h4 style="margin:0 0 5px 0; color:#2e7d32;">AHSANTE KWA FEEDBACK YAKO!</h4>
              <p style="margin:0; font-size:18px;">${'⭐'.repeat(existingReview.rating)}</p>
              <p style="margin:5px 0 0 0; color:#555;"><em>"${escapeHtml(existingReview.comment)}"</em></p>
            </div>`;
          } else {
            reviewSection = `
            <div style="background:#f8f9fa; padding:15px; border-radius:8px; margin-top:15px; border:1px solid #e9ecef;">
              <h4 style="margin:0 0 10px 0;">Toa Maoni & Nyota (Review Order)</h4>
              <form action="/track/review" method="POST">
                <input type="hidden" name="orderId" value="${order.orderId}">
                <div style="margin-bottom:10px;">
                  <label style="font-size:12px; font-weight:bold;">Chagua Nyota (Rating):</label>
                  <select name="rating" style="width:100%; padding:8px; border-radius:4px; margin-top:4px;" required>
                    <option value="5">⭐⭐⭐⭐⭐ (5/5 - Bora Sana)</option>
                    <option value="4">⭐⭐⭐⭐ (4/5 - Nzuri)</option>
                    <option value="3">⭐⭐⭐ (3/5 - Kawaida)</option>
                    <option value="2">⭐⭐ (2/5 - Vibaya)</option>
                    <option value="1">⭐ (1/5 - Mbaya Sana)</option>
                  </select>
                </div>
                <div style="margin-bottom:10px;">
                  <label style="font-size:12px; font-weight:bold;">Maoni Yako (Comment):</label>
                  <textarea name="comment" rows="3" style="width:100%; padding:8px; border-radius:4px; box-sizing:border-box;" placeholder="Andika maoni yako..." required></textarea>
                </div>
                <button type="submit" style="background:#28a745; color:white; border:none; padding:10px 15px; border-radius:4px; font-weight:bold; cursor:pointer; width:100%;">Tuma Feedback</button>
              </form>
            </div>`;
          }
        }

        // Public Reviews Section for this Order
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
          <h3 style="margin:0 0 10px 0; color:#111; font-size:17px;">Oda #${order.orderId}</h3>
          <p style="margin:5px 0; font-size:14px;"><strong>📦 Bidhaa:</strong> ${escapeHtml(order.productName)}</p>
          <p style="margin:5px 0; font-size:14px;"><strong>💰 Bei:</strong> TSh ${Number(order.sellingPrice || 0).toLocaleString()}</p>
          <p style="margin:5px 0; font-size:14px;"><strong>📍 Eneo:</strong> ${escapeHtml(order.location)}</p>
          <p style="margin:10px 0; padding:8px 12px; background:#f0f0f0; border-radius:6px; display:inline-block; font-weight:bold; font-size:13px;">Status: ${statusBadge}</p>
          
          <div style="margin-top: 12px;">
            <a href="/admin/order/invoice?id=${order.orderId}" target="_blank" style="background: #007bff; color: white; padding: 10px 14px; border-radius: 6px; text-decoration: none; font-weight: bold; font-size: 13px; display: inline-block; width: 100%; text-align: center; box-sizing: border-box;">📄 Tazama Risiti Yako (Digital Invoice)</a>
          </div>

          ${reviewSection}
          ${publicReviewsHtml}

          <div style="margin-top: 15px; text-align: center;">
            <a href="https://wa.me/${botPhone}?text=${reportFraudMsg}" target="_blank" style="color: #dc3545; font-size: 12px; font-weight: bold; text-decoration: underline;">🚨 Ripoti Dhuluma / Tatizo hapa</a>
          </div>
        </div>`;
      } else {
        resultHtml = `<div style="background:#f8d7da; color:#721c24; padding:12px; border-radius:6px; margin-top:20px; text-align:center; font-size:14px;">❌ Hakuna Oda yenye Namba #${searchId}.</div>`;
      }
    }
    const backCatalogUrl = shopId ? `/catalog?shop=${shopId}` : '/catalog';
    res.send(`
    <!DOCTYPE html>
    <html lang="sw">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
      <title>Fuatilia Oda - Winga Shop</title>
      <style>
        * { box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f4f6f8; margin: 0; padding: 15px; color: #333; }
        .container { max-width: 500px; margin: 0 auto; }
        h1 { text-align: center; color: #111; font-size: 22px; }
        .search-box { background: white; padding: 15px; border-radius: 10px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
        input[type="number"] { width: 100%; padding: 12px; border: 1px solid #ccc; border-radius: 6px; box-sizing: border-box; font-size: 16px; margin-bottom: 12px; }
        button.btn-search { width: 100%; background: #007bff; color: white; border: none; padding: 12px; border-radius: 6px; font-weight: bold; font-size: 15px; cursor: pointer; }
        .back-link { display: block; text-align: center; margin-top: 15px; color: #666; text-decoration: none; font-size: 14px; }
      </style>
    </head>
    <body>
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
    console.error('Track error:', err);
    res.status(500).send('Hitilafu imetokea.');
  }
});

app.post('/track/review', async (req, res) => {
  try {
    const { orderId, rating, comment } = req.body;
    const oid = parseInt(orderId);
    const existing = await db('reviews').where({ orderId: oid }).first();
    if (existing) {
      await db('reviews').where({ orderId: oid }).update({
        rating: parseInt(rating),
        comment: comment.trim(),
        date: new Date()
      });
    } else {
      await db('reviews').insert({
        orderId: oid,
        rating: parseInt(rating),
        comment: comment.trim(),
        date: new Date()
      });
    }
    res.redirect(`/track?id=${oid}`);
  } catch (err) {
    console.error('Review submit error:', err);
    res.redirect('/track');
  }
});

// Unified Login Page (Supports Both Sellers and Superadmins via Phone Number)
app.get('/login', (req, res) => {
  if (req.session && req.session.isSuperAdmin) return res.redirect('/superadmin');
  if (req.session && req.session.wingaId) return res.redirect('/admin');

  res.send(`
  <!DOCTYPE html>
  <html lang="sw">
  <head>
    <meta charset="UTF-8">
    <title>Winga Portal Login</title>
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <style>
      * { box-sizing: border-box; }
      body { font-family: sans-serif; background: rgb(106, 136, 232); display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; padding: 15px; }
      .login-box { background: white; padding: 25px; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.15); text-align: center; width: 100%; max-width: 320px; }
      input { padding: 11px; width: 100%; margin: 8px 0 14px 0; border: 1px solid #4092e5; border-radius: 4px; box-sizing: border-box; font-size: 15px; }
      .password-container { position: relative; width: 100%; }
      .password-container input { margin-bottom: 14px; padding-right: 40px; }
      .eye-btn { position: absolute; right: 10px; top: 38%; transform: translateY(-50%); background: none; border: none; cursor: pointer; font-size: 16px; color: #666; padding: 0; }
      button.submit-btn { background: #28a745; color: white; border: none; padding: 12px; border-radius: 4px; cursor: pointer; font-size: 16px; width: 100%; font-weight: bold; }
      a { color: #007bff; text-decoration: none; font-size: 13px; display: block; margin-top: 10px; }
    </style>
  </head>
  <body>
    <div class="login-box">
      <h2 style="margin-top:0; font-size:22px;">🛍️ Winga Portal Login</h2>
      <form action="/login" method="POST">
        <label style="display:block; text-align:left; font-size:12px; font-weight:bold;">Namba ya Simu / Username:</label>
        <input type="text" name="phone" placeholder="0712345678" required>
        
        <label style="display:block; text-align:left; font-size:12px; font-weight:bold;">Password:</label>
        <div class="password-container">
          <input type="password" name="password" id="loginPassword" placeholder="••••••••" required>
          <button type="button" class="eye-btn" onclick="togglePassword('loginPassword', this)">👁️</button>
        </div>

        <button type="submit" class="submit-btn">Ingia Dashboard</button>
      </form>
      <a href="/forgot-password">🔑 Umesahau Nenosiri?</a>
      <a href="/register" style="color: #28a745; font-weight: bold;">📝 Jisajili kama Muuzaji Mpya</a>
    </div>
    <script>
      function togglePassword(fieldId, btn) {
        const input = document.getElementById(fieldId);
        if (input.type === "password") {
          input.type = "text";
          btn.textContent = "🙈";
        } else {
          input.type = "password";
          btn.textContent = "👁️";
        }
      }
    </script>
  </body>
  </html>
  `);
});

app.post('/login', async (req, res) => {
  try {
    const identifier = (req.body.phone || '').trim();
    const password = (req.body.password || '').trim();
    if (!identifier || !password) {
      return res.send('❌ Tafadhali jaza taarifa za kuingia. <br><a href="/login">Jaribu Tena</a>');
    }

    const superAdminPhone1 = process.env.SUPERADMIN_PHONE_1 || '0700000001';
    const superAdminPass1 = process.env.SUPERADMIN_PASS_1 || 'SuperSecurePass123!';
    const superAdminPhone2 = process.env.SUPERADMIN_PHONE_2 || '0700000002';
    const superAdminPass2 = process.env.SUPERADMIN_PASS_2 || 'SuperSecurePass456!';

    if ((identifier === superAdminPhone1 && password === superAdminPass1) || 
        (identifier === superAdminPhone2 && password === superAdminPass2)) {
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

    res.send('❌ Taarifa za kuingia sio sahihi. <br><a href="/login">Jaribu Tena</a>');
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).send('Hitilafu ya Server.');
  }
});

// Winga Self-Registration
app.get('/register', (req, res) => {
  res.send(`
  <!DOCTYPE html>
  <html lang="sw">
  <head>
    <meta charset="UTF-8">
    <title>Jisajili kama Muuzaji - Winga Shop</title>
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <style>
      * { box-sizing: border-box; }
      body { font-family: sans-serif; background: rgb(106, 136, 232); display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; padding: 15px; }
      .box { background: white; padding: 25px; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); width: 100%; max-width: 350px; }
      input, select { padding: 10px; width: 100%; margin: 6px 0 12px 0; border: 1px solid #4092e5; border-radius: 4px; box-sizing: border-box; font-size: 14px; }
      .password-container { position: relative; width: 100%; margin: 6px 0 12px 0; }
      .password-container input { margin: 0; padding-right: 40px; }
      .eye-btn { position: absolute; right: 10px; top: 50%; transform: translateY(-50%); background: none; border: none; cursor: pointer; font-size: 16px; color: #666; padding: 0; }
      label { display: block; text-align: left; font-size: 12px; font-weight: bold; color: #333; }
      button { background: #28a745; color: white; border: none; padding: 12px; border-radius: 4px; cursor: pointer; font-size: 16px; font-weight: bold; width: 100%; margin-top: 10px; }
      a { color: #007bff; text-decoration: none; font-size: 13px; display: block; text-align: center; margin-top: 15px; }
    </style>
    <script>
      const districtsData = {
        "Dar es Salaam": ["Kinondoni", "Ilala", "Temeke", "Ubungo", "Kigamboni"],
        "Arusha": ["Arusha Mjini", "Arumeru", "Karatu", "Longido", "Ngorongoro"],
        "Dodoma": ["Dodoma Mjini", "Bahi", "Chamwino", "Chemba", "Kondoa", "Kongwa", "Mpwapwa"],
        "Mwanza": ["Ilemela", "Nyamagana", "Magu", "Misungwi", "Sengerema", "Ukerewe", "Kwimba"],
        "Mbeya": ["Mbeya Mjini", "Mbeya Vijijini", "Rungwe", "Kyela", "Mbozi", "Chunya"],
        "Kilimanjaro": ["Moshi Mjini", "Moshi Vijijini", "Hai", "Rombo", "Mwanga", "Same", "Siha"],
        "Tanga": ["Tanga Mjini", "Muheza", "Korogwe", "Handeni", "Pangani", "Lushoto", "Kilindi"],
        "Morogoro": ["Morogoro Mjini", "Morogoro Vijijini", "Kilombero", "Kilosa", "Ulanga", "Gairo", "Malinyi"]
      };

      function updateDistricts() {
        const regionSelect = document.getElementById("regionSelect");
        const districtSelect = document.getElementById("districtSelect");
        const selectedRegion = regionSelect.value;

        districtSelect.innerHTML = '<option value="">-- Chagua Wilaya --</option>';
        if (selectedRegion && districtsData[selectedRegion]) {
          districtsData[selectedRegion].forEach(district => {
            const opt = document.createElement("option");
            opt.value = district;
            opt.textContent = district;
            districtSelect.appendChild(opt);
          });
        }
      }

      function togglePassword(fieldId, btn) {
        const input = document.getElementById(fieldId);
        if (input.type === "password") {
          input.type = "text";
          btn.textContent = "🙈";
        } else {
          input.type = "password";
          btn.textContent = "👁️";
        }
      }
    </script>
  </head>
  <body>
    <div class="box">
      <h2 style="text-align:center; margin-top:0;">📝 Usajili wa Muuzaji</h2>
      <form action="/register" method="POST">
        <label>Jina la Duka / Lako:</label>
        <input type="text" name="name" placeholder="Mf: Boss Store" required>

        <label>Namba ya Simu (WhatsApp):</label>
        <input type="tel" name="phone" placeholder="0712345678" maxlength="10" oninput="this.value = this.value.replace(/[^0-9]/g, '').slice(0, 10)" required>

        <label>Chagua Mkoa:</label>
        <select name="region" id="regionSelect" onchange="updateDistricts()" required>
          <option value="">-- Chagua Mkoa --</option>
          <option value="Dar es Salaam">Dar es Salaam</option>
          <option value="Arusha">Arusha</option>
          <option value="Dodoma">Dodoma</option>
          <option value="Mwanza">Mwanza</option>
          <option value="Mbeya">Mbeya</option>
          <option value="Kilimanjaro">Kilimanjaro</option>
          <option value="Tanga">Tanga</option>
          <option value="Morogoro">Morogoro</option>
        </select>

        <label>Chagua Wilaya:</label>
        <select name="district" id="districtSelect" required>
          <option value="">-- Kwanza Chagua Mkoa --</option>
        </select>

        <label>Kata / Mtaa:</label>
        <input type="text" name="ward" placeholder="Mf: Kariakoo, Msimbazi" required>

        <label>Weka Nenosiri (Password):</label>
        <div class="password-container">
          <input type="password" name="password" id="regPassword" placeholder="••••••••" required>
          <button type="button" class="eye-btn" onclick="togglePassword('regPassword', this)">👁️</button>
        </div>

        <button type="submit">Jisajili Sasa</button>
      </form>
      <a href="/login">← Tayari una akaunti? Ingia hapa</a>
    </div>
  </body>
  </html>
  `);
});

app.post('/register', async (req, res) => {
  try {
    const name = (req.body.name || '').trim();
    const phone = (req.body.phone || '').trim();
    const region = (req.body.region || '').trim();
    const district = (req.body.district || '').trim();
    const ward = (req.body.ward || '').trim();
    const password = (req.body.password || '').trim();

    if (!name || !phone || !region || !district || !ward || !password) {
      return res.send('❌ Tafadhali jaza taarifa zote na eneo vizuri. <br><a href="/register">Jaribu Tena</a>');
    }
    const existing = await db('wingas').where({ phone }).first();
    if (existing) {
      return res.send('❌ Namba hii ya simu tayari imesajiliwa! <br><a href="/login">Ingia Hapa</a>');
    }
    const fullLocation = `${ward}, ${district}, ${region}`;
    const hashedPassword = await bcrypt.hash(password, 10);
    const expiry = new Date();
    expiry.setDate(expiry.getDate() + 30);

    await db('wingas').insert({
      name,
      phone,
      location: fullLocation,
      password: hashedPassword,
      status: 'active',
      expiryDate: expiry,
      dateAdded: new Date()
    });

    res.send(`
    <div style="text-align:center; padding:30px; font-family:sans-serif;">
      <h2 style="color:#28a745;">🎉 Usajili Umefanikiwa!</h2>
      <p>Akaunti yako ya duka yenye eneo la <strong>${escapeHtml(fullLocation)}</strong> imetengenezwa kikamilifu.</p>
      <a href="/login" style="padding:10px 20px; background:#007bff; color:white; text-decoration:none; border-radius:5px; display:inline-block; margin-top:15px;">Ingia Kwenye Dashboard Yako</a>
    </div>
    `);
  } catch (err) {
    console.error('Registration error:', err);
    res.status(500).send(`❌ Hitilafu ya Server wakati wa kusajili: ${escapeHtml(err.message)}`);
  }
});

app.all('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) console.error('Session destruction error:', err);
    res.clearCookie('connect.sid');
    return res.redirect('/login');
  });
});

// Admin Dashboard
app.get('/admin', requireWinga, async (req, res) => {
  try {
    const currentWinga = await db('wingas').where({ id: req.session.wingaId }).first();
    const botPhone = process.env.BOT_PHONE_NUMBER || '255678143403';
    
    if (currentWinga && currentWinga.status === 'suspended') {
      const renewalMsg = encodeURIComponent(`Habari Admin, nimefanya malipo ya siku 30 ya duka langu (${currentWinga.name} - ${currentWinga.phone}). Naomba unifungulie akaunti yangu.`);
      return res.send(`
      <!DOCTYPE html>
      <html lang="sw">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
        <title>Akaunti Imesitishwa</title>
        <style>
          body { font-family: sans-serif; background: #f8f9fa; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; padding: 20px; box-sizing: border-box; text-align: center; }
          .box { background: white; padding: 30px 20px; border-radius: 10px; box-shadow: 0 4px 15px rgba(0,0,0,0.1); max-width: 400px; width: 100%; }
          h1 { color: #dc3545; font-size: 22px; margin-top: 0; }
          p { color: #555; font-size: 14px; line-height: 1.5; }
          .whatsapp-btn { background: #25D366; color: white; padding: 12px 20px; border-radius: 6px; text-decoration: none; font-weight: bold; display: inline-block; margin-top: 15px; font-size: 15px; width: 100%; box-sizing: border-box; }
          .logout-link { display: block; margin-top: 20px; color: #007bff; text-decoration: none; font-size: 13px; }
        </style>
      </head>
      <body>
        <div class="box">
          <h1>⚠️ Akaunti Imesitishwa</h1>
          <p>Muda wako wa siku 30 za matumizi umekwisha. Hauruhusiwi kuingiza bidhaa mpya au kupokea oda mpya mpaka pale akaunti itakapohuishwa.</p>
          <p>Tafadhali fanya malipo kupitia namba ya Admin na ubofye kitufe hapa chini kumtumia ujumbe wa WhatsApp ili akufungulie akaunti yako mara moja.</p>
          <a href="https://wa.me/${botPhone}?text=${renewalMsg}" target="_blank" class="whatsapp-btn">💬 Wasiliana na Admin (WhatsApp)</a>
          <a href="/logout" class="logout-link">Rudi Kwenye Login</a>
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
      const today = new Date();
      const daysLeft = Math.ceil((expiryDate - today) / (1000 * 60 * 60 * 24));
      const formattedExpiry = expiryDate.toLocaleDateString('sw-TZ', { day: 'numeric', month: 'short', year: 'numeric' });

      if (daysLeft <= 5) {
        const renewalMsg = encodeURIComponent(`Habari Admin, naomba niongezewe siku 30 za duka langu (${currentWinga.name}).`);
        subscriptionBanner = `
        <div style="background: #fff3cd; color: #856404; border: 1px solid #ffeeba; padding: 12px; border-radius: 8px; margin-bottom: 20px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px; font-size: 13px;">
          <span>⚠️ Umebakisha <strong>siku ${daysLeft > 0 ? daysLeft : 0}</strong> (Inaisha: ${formattedExpiry}). Wasiliana na Admin kuongeza siku!</span>
          <a href="https://wa.me/${botPhone}?text=${renewalMsg}" target="_blank" style="background: #25D366; color: white; padding: 6px 12px; border-radius: 5px; text-decoration: none; font-size: 12px; font-weight: bold;">💬 Ongeza Siku WhatsApp</a>
        </div>`;
      } else {
        subscriptionBanner = `
        <div style="background: #e8f5e9; color: #2e7d32; border: 1px solid #c8e6c9; padding: 12px; border-radius: 8px; margin-bottom: 20px; font-size: 13px;">
          ⏳ Muda wa akaunti: <strong>siku ${daysLeft}</strong> zilizobaki (Inaisha tarehe: <strong>${formattedExpiry}</strong>).
        </div>`;
      }
    }

    let totalRevenue = 0;
    let totalCost = 0;
    let completedOrdersCount = 0;
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
    const shareWhatsAppText = encodeURIComponent(`Habari! Karibu utazame bidhaa na uagize kupitia duka langu hapa:\n${shopUrl}`);

    let productRows = products.map(p => {
      const images = getProductImages(p);
      let productImgHtml = '📦';
      if (images.length > 0) {
        const thumbHtml = images.map(img =>
          `<img src="${img}" onclick="openModal('${img}')" title="Bonyeza kukuza" style="width: 32px; height: 32px; object-fit: cover; border-radius: 4px; border: 1px solid #ccc; cursor: pointer; flex-shrink: 0;">`
        ).join('');
        productImgHtml = `<div style="display: flex; gap: 4px; flex-direction: row; align-items: center; max-width: 100px; overflow-x: auto; padding: 2px 0;">${thumbHtml}</div>`;
      }
      const buyingPrice = Number(p.buyingPrice || 0);
      const sellingPrice = Number(p.sellingPrice || p.price || 0);
      return `
      <tr class="seller-product-row">
        <td><strong>#${p.id}</strong></td>
        <td>${productImgHtml}</td>
        <td class="prod-name">${escapeHtml(p.name)}</td>
        <td class="prod-cat">${escapeHtml(p.category || 'General')}</td>
        <td>TSh ${buyingPrice.toLocaleString()}</td>
        <td>TSh ${sellingPrice.toLocaleString()}</td>
        <td>${escapeHtml(p.size || 'Standard')}</td>
        <td>${escapeHtml(p.colors || 'Kama pichani')}</td>
        <td>
          <form action="/admin/product/delete" method="POST" onsubmit="return confirm('Una uhakika unataka kufuta bidhaa hii?');" style="display:inline;">
            <input type="hidden" name="id" value="${p.id}">
            <button type="submit" style="background:#dc3545; color:white; border:none; padding:4px 8px; border-radius:4px; font-size:11px; cursor:pointer;">🗑️ Delete</button>
          </form>
        </td>
      </tr>`;
    }).join('');

    let orderRows = orders.map(o => {
      const currentStatus = o.status || 'Pending';
      const rev = reviews.find(r => r.orderId === o.orderId);
      let badgeStyle = 'background:#ffc107; color:#000;';
      if (currentStatus === 'Dispatched') badgeStyle = 'background:#17a2b8; color:#fff;';
      if (currentStatus === 'Completed') badgeStyle = 'background:#28a745; color:#fff;';
      const matchedProduct = products.find(p => parseInt(p.id) === parseInt(o.productId || 0) || (p.name && o.productName && p.name.trim().toLowerCase() === o.productName.trim().toLowerCase()));
      let productImgHtml = '📦';
      if (matchedProduct) {
        const images = getProductImages(matchedProduct);
        if (images.length > 0) {
          const thumbHtml = images.map(img =>
            `<img src="${img}" onclick="openModal('${img}')" title="Bonyeza kukuza" style="width: 32px; height: 32px; object-fit: cover; border-radius: 4px; border: 1px solid #ccc; cursor: pointer; flex-shrink: 0;">`
          ).join('');
          productImgHtml = `<div style="display: flex; gap: 4px; flex-direction: row; align-items: center; max-width: 100px; overflow-x: auto;">${thumbHtml}</div>`;
        }
      }
      let reviewCell = rev ? `${'⭐'.repeat(rev.rating)}<br><small>"${escapeHtml(rev.comment)}"</small>` : '<em style="color:#999; font-size:12px;">Hamna feedback</em>';
      return `
      <tr>
        <td>${productImgHtml}</td>
        <td><strong>#${o.orderId}</strong></td>
        <td>${escapeHtml(o.productName)}</td>
        <td>TSh ${Number(o.sellingPrice || 0).toLocaleString()}</td>
        <td>${escapeHtml(o.location)}</td>
        <td>${escapeHtml(o.customerPhone)}</td>
        <td><span style="padding: 3px 7px; border-radius: 12px; font-size: 10px; font-weight: bold; ${badgeStyle}">${currentStatus}</span></td>
        <td>${reviewCell}</td>
        <td>
          <div style="display:flex; gap:4px; flex-wrap:wrap; align-items:center;">
            <a href="/admin/order/invoice?id=${o.orderId}" target="_blank" style="background:#6c757d; color:white; padding:4px 8px; border-radius:4px; font-size:11px; text-decoration:none; font-weight:bold;">📄 Risiti</a>
            <form action="/admin/order/status" method="POST" style="display:inline-flex; gap: 4px;">
              <input type="hidden" name="orderId" value="${o.orderId}">
              ${currentStatus !== 'Dispatched' && currentStatus !== 'Completed' ? `<button type="submit" name="status" value="Dispatched" style="background:#17a2b8; color:white; border:none; padding:4px 8px; border-radius:4px; font-size:11px; cursor:pointer;">🚚 Dispatch</button>` : ''}
              ${currentStatus !== 'Completed' ? `<button type="submit" name="status" value="Completed" style="background:#28a745; color:white; border:none; padding:4px 8px; border-radius:4px; font-size:11px; cursor:pointer;">✅ Complete</button>` : ''}
            </form>
          </div>
        </td>
      </tr>`;
    }).join('');

    let alertMessage = '';
    if (req.query.added === 'true') {
      alertMessage = `
      <div style="background: #d4edda; color: #155724; border: 1px solid #c3e6cb; padding: 10px 15px; border-radius: 6px; margin-bottom: 15px; font-weight: bold; font-size: 13px; display: flex; justify-content: space-between; align-items: center;">
        <span>✅ Bidhaa mpya imefanikiwa kuongezwa!</span>
        <span onclick="this.parentElement.style.display='none'" style="cursor:pointer; font-size: 16px;">&times;</span>
      </div>`;
    } else if (req.query.error === 'upload') {
      alertMessage = `
      <div style="background: #f8d7da; color: #721c24; border: 1px solid #f5c6cb; padding: 10px 15px; border-radius: 6px; margin-bottom: 15px; font-weight: bold; font-size: 13px; display: flex; justify-content: space-between; align-items: center;">
        <span>❌ Hitilafu ya kupakia picha. Jaribu tena.</span>
        <span onclick="this.parentElement.style.display='none'" style="cursor:pointer; font-size: 16px;">&times;</span>
      </div>`;
    }

    res.send(`
    <!DOCTYPE html>
    <html lang="sw">
    <head>
      <title>Winga Dashboard - ${escapeHtml(currentWingaName)}</title>
      <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
      <style>
        * { box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 0; padding: 12px; background: #f4f6f8; color: #333; }
        .container { max-width: 1100px; margin: 0 auto; }
        .top-nav { display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; flex-wrap: wrap; gap: 10px; }
        .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 20px; }
        .stat-card { background: white; padding: 15px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.05); }
        .stat-card h3 { margin: 0; font-size: 11px; color: #666; text-transform: uppercase; }
        .stat-card p { margin: 6px 0 0 0; font-size: 20px; font-weight: bold; color: #111; word-break: break-word; }
        .card { background: white; padding: 15px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); margin-bottom: 20px; }
        h1, h2 { color: #111; margin-top: 0; font-size: 18px; }
        @media(min-width: 600px) {
          body { padding: 20px; }
          h1, h2 { font-size: 22px; }
          .card { padding: 20px; }
        }
        .form-group { margin-bottom: 12px; }
        .form-row { display: grid; grid-template-columns: 1fr; gap: 12px; }
        @media(min-width: 600px) {
          .form-row { grid-template-columns: 1fr 1fr; gap: 15px; }
        }
        label { display: block; margin-bottom: 4px; font-weight: 600; font-size: 12px; }
        input[type="text"], input[type="number"], input[type="file"], input[type="password"] { width: 100%; padding: 10px; border: 1px solid #ccc; border-radius: 4px; box-sizing: border-box; font-size: 14px; }
        .password-container { position: relative; width: 100%; }
        .password-container input { padding-right: 40px; }
        .eye-btn { position: absolute; right: 10px; top: 50%; transform: translateY(-50%); background: none; border: none; cursor: pointer; font-size: 16px; color: #666; padding: 0; }
        button.btn-add { background: #28a745; color: white; border: none; padding: 12px; border-radius: 4px; font-weight: bold; cursor: pointer; width: 100%; font-size: 15px; }
        .table-responsive { width: 100%; overflow-x: auto; -webkit-overflow-scrolling: touch; }
        table { width: 100%; border-collapse: collapse; margin-top: 10px; min-width: 600px; font-size: 13px; }
        th, td { text-align: left; padding: 10px; border-bottom: 1px solid #eee; white-space: nowrap; }
        th { background: #f8f9fa; font-size: 12px; }
        .contact-support { background: #25D366; color: white; border: none; padding: 8px 12px; border-radius: 6px; font-weight: bold; text-decoration: none; font-size: 12px; display: inline-flex; align-items: center; gap: 4px; }
      </style>
    </head>
    <body>
      <div class="container">
        ${alertMessage}
        ${subscriptionBanner}
        <div class="top-nav">
          <h1>🛍️ Winga Dashboard - ${escapeHtml(currentWingaName)}</h1>
          <div>
            <a href="https://wa.me/${botPhone}?text=Habari%20Admin" target="_blank" class="contact-support">💬 Msaada</a>
            <a href="/logout" style="margin-left: 8px; color:#dc3545; font-weight:bold; text-decoration:none; font-size:13px;">Logout</a>
          </div>
        </div>

        <div class="card" style="background: #e3f2fd; border: 1px solid #90caf9;">
          <h3 style="margin-top: 0; color: #0d47a1; font-size: 16px;">🔗 Link Yako ya Duka (Store Link)</h3>
          <div style="display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px;">
            <input type="text" id="storeLinkInput" value="${shopUrl}" readonly style="flex: 1; min-width: 200px; padding: 10px; border: 1px solid #90caf9; border-radius: 4px; font-weight: bold; color: #0d47a1; background: white; font-size: 13px;">
            <button type="button" onclick="copyStoreLink()" style="background: #007bff; color: white; border: none; padding: 10px 15px; border-radius: 4px; font-weight: bold; cursor: pointer; font-size: 13px;">📋 Nakili Link</button>
          </div>
          <div style="display: flex; gap: 8px; flex-wrap: wrap;">
            <a href="https://wa.me/?text=${shareWhatsAppText}" target="_blank" style="background: #25D366; color: white; padding: 10px 15px; border-radius: 6px; text-decoration: none; font-weight: bold; font-size: 13px; display: inline-flex; align-items: center; gap: 6px;">📲 Share to WhatsApp</a>
          </div>
        </div>
        <script>
          function copyStoreLink() {
            var copyText = document.getElementById("storeLinkInput");
            copyText.select();
            copyText.setSelectionRange(0, 99999);
            navigator.clipboard.writeText(copyText.value);
            alert("✅ Link imenakiliwa! Sasa unaweza kui-paste popote.");
          }
        </script>

        <div class="card">
          <h3 style="font-size:16px;">🔑 Badilisha Nenosiri</h3>
          <form id="changePasswordForm">
            <div class="form-group">
              <label>Nenosiri la Zamani:</label>
              <div class="password-container">
                <input type="password" id="oldPassword" required>
                <button type="button" class="eye-btn" onclick="togglePassword('oldPassword', this)">👁️</button>
              </div>
            </div>
            <div class="form-group">
              <label>Nenosiri Jipya:</label>
              <div class="password-container">
                <input type="password" id="newPassword" required>
                <button type="button" class="eye-btn" onclick="togglePassword('newPassword', this)">👁️</button>
              </div>
            </div>
            <div class="form-group">
              <label>Rudia Nenosiri Jipya:</label>
              <div class="password-container">
                <input type="password" id="confirmPassword" required>
                <button type="button" class="eye-btn" onclick="togglePassword('confirmPassword', this)">👁️</button>
              </div>
            </div>
            <button type="submit" style="background:#007bff; color:white; border:none; padding:10px; border-radius:4px; font-weight:bold; cursor:pointer; width:100%;">Hifadhi Nenosiri</button>
          </form>
        </div>
        <script>
          function togglePassword(fieldId, btn) {
            const input = document.getElementById(fieldId);
            if (input.type === "password") {
              input.type = "text";
              btn.textContent = "🙈";
            } else {
              input.type = "password";
              btn.textContent = "👁️";
            }
          }

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
            } catch (err) {
              alert('❌ Hitilafu ya mtandao.');
            }
          });
        </script>

        <div class="stats-grid">
          <div class="stat-card"><h3>Completed Orders</h3><p>${completedOrdersCount}</p></div>
          <div class="stat-card"><h3>Total Revenue</h3><p>TSh ${totalRevenue.toLocaleString()}</p></div>
          <div class="stat-card"><h3>Net Profit</h3><p style="color:#28a745;">TSh ${netProfit.toLocaleString()}</p></div>
        </div>

        <div class="card">
          <h2>Weka Bidhaa Mpya (Max Picha 4)</h2>
          <form action="/admin/add" method="POST" enctype="multipart/form-data">
            <div class="form-row">
              <div class="form-group"><label>Jina la Bidhaa</label><input type="text" name="name" required></div>
              <div class="form-group"><label>Aina (Category)</label><input type="text" name="category" required></div>
            </div>
            <div class="form-row">
              <div class="form-group"><label>Bei ya Kununua (Buying Price)</label><input type="number" name="buyingPrice" required></div>
              <div class="form-group"><label>Bei ya Kuuzia (Selling Price)</label><input type="number" name="sellingPrice" required></div>
            </div>
            <div class="form-row">
              <div class="form-group"><label>Available Sizes (Mf: S, M, L, XL au Standard)</label><input type="text" name="size" value="Standard"></div>
              <div class="form-group"><label>Available Colors (Mf: Nyeusi, Nyekundu, Bluu)</label><input type="text" name="colors" value="Kama pichani"></div>
            </div>
            <div class="form-group">
              <label>Picha za Bidhaa (Max 4)</label>
              <input type="file" id="imageInput" name="images" accept="image/*" multiple required onchange="validateImages(this)">
              <small id="fileCountNotice" style="color: #007bff; font-weight: bold; display: block; margin-top: 4px; font-size: 11px;"></small>
            </div>
            <button type="submit" class="btn-add">Upload & Add to Catalog</button>
          </form>
        </div>
        <script>
          function validateImages(input) {
            const notice = document.getElementById('fileCountNotice');
            if (input.files.length > 4) {
              alert('❌ Unaruhusiwa kuchagua picha zisizozidi 4 pekee.');
              input.value = '';
              notice.innerText = '';
            } else if (input.files.length > 0) {
              notice.innerText = '✅ Umechagua picha ' + input.files.length + ' kati ya 4.';
            } else {
              notice.innerText = '';
            }
          }
        </script>

        <div class="card">
          <h2>Customer Orders & Reviews (${orders.length})</h2>
          <div class="table-responsive">
            <table>
              <thead><tr><th>Photo</th><th>Order #</th><th>Product</th><th>Price</th><th>Location</th><th>Phone</th><th>Status</th><th>Feedback</th><th>Action</th></tr></thead>
              <tbody>${orderRows || '<tr><td colspan="9">No orders placed yet.</td></tr>'}</tbody>
            </table>
          </div>
        </div>

        <div class="card">
          <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px; margin-bottom:15px;">
            <h2 style="margin:0;">Product Catalog (${products.length})</h2>
            <input type="text" id="sellerSearchInput" onkeyup="filterSellerProducts()" placeholder="🔍 Tafuta bidhaa zako..." style="max-width:250px; padding:8px; border:1px solid #ccc; border-radius:6px; font-size:13px;">
          </div>
          <div class="table-responsive">
            <table>
              <thead><tr><th>ID</th><th>Photos</th><th>Name</th><th>Category</th><th>Buying Price</th><th>Selling Price</th><th>Size</th><th>Colors</th><th>Action</th></tr></thead>
              <tbody id="sellerProductTable">${productRows || '<tr><td colspan="9">No products added yet.</td></tr>'}</tbody>
            </table>
          </div>
        </div>
        <script>
          function filterSellerProducts() {
            var input = document.getElementById('sellerSearchInput').value.toLowerCase().trim();
            var rows = document.querySelectorAll('#sellerProductTable tr.seller-product-row');
            rows.forEach(function(row) {
              var name = row.querySelector('.prod-name').innerText.toLowerCase();
              var cat = row.querySelector('.prod-cat').innerText.toLowerCase();
              row.style.display = (name.indexOf(input) !== -1 || cat.indexOf(input) !== -1) ? '' : 'none';
            });
          }
        </script>
      </div>

      <div id="imgModal" onclick="closeModal()" style="display: none; position: fixed; z-index: 9999; left: 0; top: 0; width: 100%; height: 100%; background-color: rgba(0,0,0,0.85); justify-content: center; align-items: center; cursor: pointer;">
        <span style="position: absolute; top: 15px; right: 25px; color: #fff; font-size: 35px; font-weight: bold;">&times;</span>
        <img id="modalImage" style="max-width: 85%; max-height: 85%; border-radius: 8px; object-fit: contain;">
      </div>
      <script>
        function openModal(src) { document.getElementById('modalImage').src = src; document.getElementById('imgModal').style.display = 'flex'; }
        function closeModal() { document.getElementById('imgModal').style.display = 'none'; }
      </script>
    </body>
    </html>
    `);
  } catch (err) {
    console.error('Admin page error:', err);
    res.status(500).send('Hitilafu kwenye Server.');
  }
});

app.get('/admin/order/invoice', requireWinga, async (req, res) => {
  try {
    const orderId = parseInt(req.query.id);
    const order = await db('orders').where({ orderId, wingaId: req.session.wingaId }).first();
    if (!order) return res.send('❌ Oda haipatikani au sio ya duka lako.');

    const winga = await db('wingas').where({ id: req.session.wingaId }).first();
    const shopLink = `${PUBLIC_URL}/catalog?shop=${winga.id}`;

    res.send(`
    <!DOCTYPE html>
    <html lang="sw">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
      <title>Risiti ya Oda #${order.orderId}</title>
      <style>
        body { font-family: monospace; background: #fff; color: #000; padding: 20px; max-width: 420px; margin: 20px auto; border: 1px solid #ddd; box-shadow: 0 4px 12px rgba(0,0,0,0.1); border-radius: 8px; box-sizing: border-box; }
        .center { text-align: center; }
        hr { border: dashed 1px #888; }
        a { color: #007bff; text-decoration: none; }
        .btn-print { background: #007bff; color: white; border: none; padding: 12px; width: 100%; cursor: pointer; font-weight: bold; margin-top: 20px; border-radius: 6px; font-size: 15px; }
        @media print { 
          body { border: none; box-shadow: none; padding: 0; margin: 0; max-width: 100%; }
          .btn-print { display: none; } 
        }
      </style>
    </head>
    <body>
      <div class="center">
        <h2>🛍️ ${escapeHtml(winga.name)}</h2>
        <p>Simu: ${escapeHtml(winga.phone)}</p>
        <p style="font-size: 12px; word-break: break-all;">Link ya Duka:<br><a href="${shopLink}" target="_blank">${shopLink}</a></p>
        <hr>
        <h3>RISITI YA MAUZO (INVOICE)</h3>
      </div>
      <p><strong>Namba ya Oda:</strong> #${order.orderId}</p>
      <p><strong>Tarehe:</strong> ${new Date(order.date).toLocaleDateString('sw-TZ')}</p>
      <p><strong>Mteja Simu:</strong> ${escapeHtml(order.customerPhone)}</p>
      <p><strong>Eneo la Mteja:</strong> ${escapeHtml(order.location)}</p>
      <hr>
      <p><strong>Bidhaa:</strong> ${escapeHtml(order.productName)}</p>
      <p><strong>Bei:</strong> TSh ${Number(order.sellingPrice || order.price || 0).toLocaleString()}</p>
      <hr>
      <p class="center"><strong>Status:</strong> ${escapeHtml(order.status)}</p>
      <p class="center" style="margin-top: 20px; font-size: 13px;"><em>Asante kwa kununua nasi! Karibu tena.</em></p>
      <button class="btn-print" onclick="window.print()">🖨️ Chapisha / Hifadhi kama PDF</button>
    </body>
    </html>
    `);
  } catch (err) {
    console.error('Invoice generation error:', err);
    res.status(500).send('Hitilafu kwenye mfumo wa risiti.');
  }
});

app.post('/admin/add', requireWinga, (req, res) => {
  upload(req, res, async (err) => {
    if (err) {
      console.error('Upload Error:', err.message);
      return res.redirect('/admin?error=upload');
    }
    try {
      const { name, category, buyingPrice, sellingPrice, size, colors } = req.body;
      const files = req.files || [];
      let imageUrls = [];

      for (const file of files) {
        const uploadResult = await new Promise((resolve, reject) => {
          const stream = cloudinary.uploader.upload_stream(
            { folder: 'winga_shop_products' },
            (error, result) => {
              if (error) reject(error);
              else resolve(result);
            }
          );
          stream.end(file.buffer);
        });
        if (uploadResult && uploadResult.secure_url) {
          imageUrls.push(uploadResult.secure_url);
        }
      }

      const [insertedId] = await db('products').insert({
        wingaId: req.session.wingaId,
        name: name.trim(),
        category: category ? category.trim() : 'General',
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
      res.redirect('/admin?added=true');
    } catch (dbErr) {
      console.error('Cloudinary / DB Insert error:', dbErr);
      res.redirect('/admin?error=upload');
    }
  });
});

app.post('/admin/product/delete', requireWinga, async (req, res) => {
  try {
    const { id } = req.body;
    await db('products').where({ id: parseInt(id), wingaId: req.session.wingaId }).del();
  } catch (err) {
    console.error('❌ Error deleting product:', err);
  }
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
          statusMessage =
            `🚚 *TAARIFA ZA ODA - DISPATCHED!* 🚚\n` +
            `-----------------------------------\n` +
            `Habari! Oda yako #${order.orderId} imekamilika kuandaliwa na ipo njiani kuletwa kwako.\n\n` +
            `📦 *Bidhaa:* ${order.productName}\n` +
            `🔗 *Fuatilia hapa:*\n${trackUrl}`;
        } else if (status === 'Completed') {
          statusMessage =
            `✅ *ODA YAKO IMEMALIZIKA!* 🎉\n` +
            `-----------------------------------\n` +
            `Habari! Oda #${order.orderId} (${order.productName}) imewasilishwa.\n\n` +
            `⭐ *TOA MAONI & NYOTA HAPA:* ⭐\n` +
            `Bonyeza link hii kutoa feedback moja kwa moja:\n${trackUrl}\n\n` +
            `Au tuma ujumbe hapa WhatsApp:\n` +
            `*!maoni ${order.orderId} [nyota 1-5] [maoni yako]*`;
        }
        if (statusMessage) {
          await sock.sendMessage(customerChatId, { text: statusMessage });
        }
      }
    }
  } catch (err) {
    console.error('❌ Error updating status:', err);
  }
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

// Forgot & Reset Password
app.get('/forgot-password', (req, res) => {
  res.send(`
  <!DOCTYPE html>
  <html>
  <head>
    <title>Umesahau Nenosiri</title>
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <style>
      * { box-sizing: border-box; }
      body { font-family: sans-serif; background: rgb(106, 136, 232); display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; padding: 15px; }
      .box { background: white; padding: 25px; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); text-align: center; width: 100%; max-width: 320px; }
      input { padding: 11px; width: 100%; margin: 10px 0; border: 1px solid #4092e5; border-radius: 4px; box-sizing: border-box; font-size: 15px; }
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
    <head>
      <title>Reset</title>
      <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
      <style>
        .password-container { position: relative; width: 100%; margin: 8px 0; }
        .password-container input { width: 100%; padding: 11px; box-sizing: border-box; font-size: 15px; padding-right: 40px; }
        .eye-btn { position: absolute; right: 10px; top: 50%; transform: translateY(-50%); background: none; border: none; cursor: pointer; font-size: 16px; color: #666; padding: 0; }
      </style>
      <script>
        function togglePassword(fieldId, btn) {
          const input = document.getElementById(fieldId);
          if (input.type === "password") {
            input.type = "text";
            btn.textContent = "🙈";
          } else {
            input.type = "password";
            btn.textContent = "👁️";
          }
        }
      </script>
    </head>
    <body style="font-family:sans-serif; background:rgb(106, 136, 232); display:flex; justify-content:center; align-items:center; height:100vh; margin:0; padding:15px; box-sizing:border-box;">
      <div style="background:white; padding:25px; border-radius:8px; text-align:center; width:100%; max-width:320px;">
        <h2>🔐 Weka Nenosiri Jipya</h2>
        <form action="/reset-password" method="POST">
          <input type="hidden" name="phone" value="${escapeHtml(winga.phone)}">
          <input type="text" name="otp" placeholder="Kodi ya OTP" required style="width:100%; padding:11px; margin:8px 0; box-sizing:border-box; font-size:15px;">
          
          <div class="password-container">
            <input type="password" name="newPassword" id="resetPass" placeholder="Nenosiri Jipya" required>
            <button type="button" class="eye-btn" onclick="togglePassword('resetPass', this)">👁️</button>
          </div>
          <div class="password-container">
            <input type="password" name="confirmPassword" id="resetConfirmPass" placeholder="Rudia Nenosiri Jipya" required>
            <button type="button" class="eye-btn" onclick="togglePassword('resetConfirmPass', this)">👁️</button>
          </div>

          <button type="submit" style="background:#28a745; color:white; border:none; padding:12px; width:100%; font-weight:bold; cursor:pointer; border-radius:4px; font-size:16px; margin-top:8px;">Hifadhi</button>
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

// Super Admin Dashboard
app.get('/superadmin', requireSuperAdmin, async (req, res) => {
  try {
    const wingas = await db('wingas').select('*');
    const products = await db('products').select('*');
    const orders = await db('orders').select('*');
    const reviews = await db('reviews').select('*');
    let platformTotalProfit = 0;
    let platformTotalRevenue = 0;

    let wingaRows = wingas.map(w => {
      const wProducts = products.filter(p => p.wingaId === w.id);
      const wOrders = orders.filter(o => o.wingaId === w.id);
      let wingaRevenue = 0;
      let wingaCost = 0;
      let completedOrders = 0;
      wOrders.forEach(o => {
        if (o.status === 'Completed') {
          const sell = Number(o.sellingPrice || o.price || 0);
          const buy = Number(o.buyingPrice || 0);
          wingaRevenue += sell;
          wingaCost += buy;
          completedOrders++;
        }
      });
      const wingaProfit = wingaRevenue - wingaCost;
      platformTotalProfit += wingaProfit;
      platformTotalRevenue += wingaRevenue;
      const statusBadge = w.status === 'active'
        ? `<span style="background:#28a745; color:white; padding:3px 7px; border-radius:12px; font-size:10px; font-weight:bold;">Active</span>`
        : `<span style="background:#dc3545; color:white; padding:3px 7px; border-radius:12px; font-size:10px; font-weight:bold;">Suspended</span>`;
      const expiryFormatted = w.expiryDate ? new Date(w.expiryDate).toLocaleDateString() : 'N/A';
      return `
      <tr>
        <td><strong>#${w.id}</strong></td>
        <td>${escapeHtml(w.name)}<br><small style="color:#666;">📍 ${escapeHtml(w.location || 'N/A')}</small></td>
        <td>${escapeHtml(w.phone)}</td>
        <td>${statusBadge}</td>
        <td>${expiryFormatted}</td>
        <td>${wProducts.length} items</td>
        <td>${completedOrders} orders</td>
        <td style="color:#28a745; font-weight:bold;">TSh ${wingaProfit.toLocaleString()}</td>
        <td>
          <div style="display:flex; gap:4px; flex-wrap:wrap;">
            ${w.status === 'suspended' ? `
            <form action="/superadmin/winga/status" method="POST" style="display:inline;">
              <input type="hidden" name="wingaId" value="${w.id}">
              <input type="hidden" name="status" value="active">
              <button type="submit" style="background:#28a745; color:white; border:none; padding:4px 8px; border-radius:4px; font-size:11px; cursor:pointer;">Activate</button>
            </form>` : `
            <form action="/superadmin/winga/status" method="POST" style="display:inline;">
              <input type="hidden" name="wingaId" value="${w.id}">
              <input type="hidden" name="status" value="suspended">
              <button type="submit" style="background:#dc3545; color:white; border:none; padding:4px 8px; border-radius:4px; font-size:11px; cursor:pointer;">Suspend</button>
            </form>`}
            <form action="/superadmin/winga/extend" method="POST" style="display:inline;">
              <input type="hidden" name="wingaId" value="${w.id}">
              <button type="submit" style="background:#007bff; color:white; border:none; padding:4px 8px; border-radius:4px; font-size:11px; cursor:pointer;">+30 Days</button>
            </form>
          </div>
        </td>
      </tr>`;
    }).join('');

    let superadminProductRows = products.map(p => {
      const matchedWinga = wingas.find(w => w.id === p.wingaId);
      const sellerName = matchedWinga ? matchedWinga.name : `Winga #${p.wingaId}`;
      const images = getProductImages(p);
      const mainImg = images[0] ? `<img src="${images[0]}" onclick="openModal('${images[0]}')" style="width: 36px; height: 36px; object-fit: cover; border-radius: 4px; cursor: pointer;" title="Bonyeza kukuza">` : '📦';
      return `
      <tr class="super-prod-row">
        <td><strong>#${p.id}</strong></td>
        <td>${mainImg}</td>
        <td class="sprod-name">${escapeHtml(p.name)}</td>
        <td><strong>${escapeHtml(sellerName)}</strong></td>
        <td>TSh ${Number(p.sellingPrice || 0).toLocaleString()}</td>
        <td>
          <form action="/superadmin/product/delete" method="POST" onsubmit="return confirm('Futa bidhaa hii?');" style="display:inline;">
            <input type="hidden" name="id" value="${p.id}">
            <button type="submit" style="background:#dc3545; color:white; border:none; padding:5px 10px; border-radius:4px; font-size:11px; font-weight:bold; cursor:pointer;">🗑️ Delete</button>
          </form>
        </td>
      </tr>`;
    }).join('');

    let superadminFeedbackRows = reviews.map(rev => {
      const matchedOrder = orders.find(o => o.orderId === rev.orderId);
      const matchedWinga = matchedOrder ? wingas.find(w => w.id === matchedOrder.wingaId) : null;
      const shopName = matchedWinga ? matchedWinga.name : 'Unknown Shop';
      const prodName = matchedOrder ? matchedOrder.productName : 'N/A';
      return `
      <tr>
        <td><strong>#${rev.orderId}</strong></td>
        <td>${escapeHtml(shopName)}</td>
        <td>${escapeHtml(prodName)}</td>
        <td>${'⭐'.repeat(rev.rating)} (${rev.rating}/5)</td>
        <td>"${escapeHtml(rev.comment)}"</td>
      </tr>`;
    }).join('');

    res.send(`
    <!DOCTYPE html>
    <html lang="sw">
    <head>
      <title>Super Admin - Platform Manager</title>
      <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
      <style>
        * { box-sizing: border-box; }
        body { font-family: sans-serif; background: #eef2f5; margin: 0; padding: 12px; color: #333; }
        .container { max-width: 1200px; margin: 0 auto; }
        .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 20px; }
        .stat-card { background: #1a1a1a; color: white; padding: 15px; border-radius: 8px; }
        .stat-card h3 { margin: 0 0 6px 0; font-size: 12px; color: #aaa; text-transform: uppercase; }
        .stat-card p { margin: 0; font-size: 20px; font-weight: bold; color: #4ade80; word-break: break-word; }
        .card { background: white; padding: 15px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); margin-bottom: 20px; }
        @media(min-width: 600px) {
          body { padding: 20px; }
          .card { padding: 20px; }
        }
        .form-row { display: grid; grid-template-columns: 1fr; gap: 10px; }
        @media(min-width: 600px) { .form-row { grid-template-columns: 1fr 1fr 1fr auto; } }
        input { padding: 10px; border: 1px solid #ccc; border-radius: 4px; width: 100%; font-size: 14px; }
        button.btn-main { background: #007bff; color: white; border: none; padding: 10px 15px; border-radius: 4px; font-weight: bold; cursor: pointer; width: 100%; }
        .table-responsive { width: 100%; overflow-x: auto; -webkit-overflow-scrolling: touch; }
        table { width: 100%; border-collapse: collapse; margin-top: 10px; min-width: 600px; font-size: 13px; }
        th, td { text-align: left; padding: 10px; border-bottom: 1px solid #eee; white-space: nowrap; }
        th { background: #f8f9fa; font-size: 12px; }
        h1, h2 { font-size: 18px; }
        @media(min-width: 600px) { h1, h2 { font-size: 22px; } }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>👑 Platform Super Admin</h1>
        <a href="/logout" style="background: #ec0c22; color: white; padding: 8px 16px; border-radius: 6px; text-decoration: none; font-weight: bold; font-size: 13px; display: inline-block; margin-bottom: 15px;">🚪 Logout</a>
        
        <div class="stats-grid">
          <div class="stat-card"><h3>Total Wingas</h3><p style="color:white;">${wingas.length}</p></div>
          <div class="stat-card"><h3>Total Revenue</h3><p>TSh ${platformTotalRevenue.toLocaleString()}</p></div>
          <div class="stat-card"><h3>Total Profit</h3><p>TSh ${platformTotalProfit.toLocaleString()}</p></div>
        </div>

        <div class="card">
          <h2>➕ Ongeza Muuzaji Mpya (Register Winga)</h2>
          <form action="/superadmin/add-winga" method="POST">
            <div class="form-row">
              <input type="text" name="name" placeholder="Jina la Duka / Muuzaji" required>
              <input type="tel" name="phone" placeholder="Namba ya Simu (07...)" maxlength="10" required>
              <input type="password" name="password" placeholder="Password ya Muda (Default: 123456)">
              <button type="submit" class="btn-main">Sajili Muuzaji</button>
            </div>
          </form>
        </div>

        <div class="card">
          <h2>🏢 Wingas Directory</h2>
          <div class="table-responsive">
            <table>
              <thead><tr><th>ID</th><th>Name & Location</th><th>Phone</th><th>Status</th><th>Expires</th><th>Catalog</th><th>Orders</th><th>Profit</th><th>Actions</th></tr></thead>
              <tbody>${wingaRows || '<tr><td colspan="9">No wingas registered.</td></tr>'}</tbody>
            </table>
          </div>
        </div>

        <div class="card">
          <h2>💬 Customer Reviews (${reviews.length})</h2>
          <div class="table-responsive">
            <table>
              <thead><tr><th>Order #</th><th>Shop</th><th>Product</th><th>Rating</th><th>Comment</th></tr></thead>
              <tbody>${superadminFeedbackRows || '<tr><td colspan="5">No reviews.</td></tr>'}</tbody>
            </table>
          </div>
        </div>

        <div class="card">
          <h2>📦 Product Moderation (${products.length})</h2>
          <div class="table-responsive">
            <table>
              <thead><tr><th>ID</th><th>Photo</th><th>Name</th><th>Seller</th><th>Price</th><th>Action</th></tr></thead>
              <tbody>${superadminProductRows || '<tr><td colspan="6">No products.</td></tr>'}</tbody>
            </table>
          </div>
        </div>
      </div>

      <div id="imgModal" onclick="closeModal()" style="display: none; position: fixed; z-index: 9999; left: 0; top: 0; width: 100%; height: 100%; background-color: rgba(0,0,0,0.85); justify-content: center; align-items: center; cursor: pointer;">
        <span style="position: absolute; top: 15px; right: 25px; color: #fff; font-size: 35px; font-weight: bold;">&times;</span>
        <img id="modalImage" style="max-width: 85%; max-height: 85%; border-radius: 8px; object-fit: contain;">
      </div>
      <script>
        function openModal(src) { document.getElementById('modalImage').src = src; document.getElementById('imgModal').style.display = 'flex'; }
        function closeModal() { document.getElementById('imgModal').style.display = 'none'; }
      </script>
    </body>
    </html>
    `);
  } catch (err) {
    res.status(500).send('Hitilafu kwenye Superadmin.');
  }
});

app.post('/superadmin/product/delete', requireSuperAdmin, async (req, res) => {
  try {
    await db('products').where({ id: parseInt(req.body.id) }).del();
  } catch (err) {}
  res.redirect('/superadmin');
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
    const name = (req.body.name || '').trim();
    const phone = (req.body.phone || '').trim();
    const rawPassword = (req.body.password || '123456').trim();
    if (!name || !phone) return res.redirect('/superadmin');

    const hashedPassword = await bcrypt.hash(rawPassword, 10);
    const expiry = new Date();
    expiry.setDate(expiry.getDate() + 30);

    await db('wingas').insert({
      name,
      phone,
      password: hashedPassword,
      status: 'active',
      expiryDate: expiry,
      dateAdded: new Date()
    });
  } catch (err) {
    console.error('Error adding winga:', err);
  }
  res.redirect('/superadmin');
});

cron.schedule('0 8 * * *', async () => {
  try {
    if (!isWhatsappReady || !sock) return;
    const wingas = await db('wingas').select('*');
    const now = new Date();
    for (let w of wingas) {
      if (!w.expiryDate) continue;
      const expiry = new Date(w.expiryDate);
      const daysLeft = Math.ceil((expiry - now) / (1000 * 60 * 60 * 24));
      const formattedPhone = w.phone.startsWith('0') ? '255' + w.phone.slice(1) : w.phone;
      const chatId = formattedPhone + '@s.whatsapp.net';
      if (daysLeft <= 0 && w.status === 'active') {
        await db('wingas').where({ id: w.id }).update({ status: 'suspended' });
        try { await sock.sendMessage(chatId, { text: `⚠️ *AKAUNTI IMESITISHWA*\n\nNdugu ${w.name}, muda wako wa siku 30 za matumizi umekwisha. Wasiliana na Admin WhatsApp kufanya malipo ili kufunguliwa tena.` }); } catch (e) {}
      } else if (daysLeft === 3 && w.status === 'active') {
        try { await sock.sendMessage(chatId, { text: `🔔 *KUMBUSHO LA MALIPO*\n\nNdugu ${w.name}, akaunti yako ya Winga Shop itasitishwa ndani ya siku 3. Wasiliana na Admin kuongeza siku.` }); } catch (e) {}
      }
    }
  } catch (err) { console.error('Cron error:', err); }
});

app.listen(PORT, () => {
  console.log(`🌐 Server active on ${PUBLIC_URL}`);
  connectToWhatsApp();
});