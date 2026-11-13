require('dotenv').config();
const qrcode = require('qrcode-terminal');
const express = require('express');
const session = require('express-session');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const basicAuth = require('express-basic-auth');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// Global State Flags
let isWhatsappReady = false;

// Initialize WhatsApp Web Client
const client = new Client({
  authStrategy: new LocalAuth(),
  webVersionCache: {
    type: 'remote',
    remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.3000.1018944747-alpha.html'
  },
  puppeteer: {
    headless: true,
    executablePath: fs.existsSync('/usr/bin/google-chrome-stable') ? '/usr/bin/google-chrome-stable' : undefined,
    protocolTimeout: 0,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu',
      '--dns-result-prefetch-tries=1'
    ]
  }
});

// Production Environment Checks
if (process.env.NODE_ENV === 'production') {
  if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET === 'winga-super-secret-key') {
    console.error('❌ FATAL ERROR: SESSION_SECRET must be explicitly set to a secure string in production!');
    process.exit(1);
  }
  if (!process.env.SUPERADMIN_PASS || process.env.SUPERADMIN_PASS === 'SuperSecurePass123!') {
    console.error('❌ FATAL ERROR: SUPERADMIN_PASS must be explicitly set to a secure password in production!');
    process.exit(1);
  }
}

const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Middleware Setup
app.set('trust proxy', 1);
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use('/uploads', express.static(UPLOADS_DIR));
app.use(express.static(path.join(__dirname, 'public')));

// Unified Session Middleware with Lax cookie settings to prevent loop
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

// Basic Auth Middleware for Superadmin Area
app.use('/superadmin', basicAuth({
  users: { 'admin': process.env.SUPERADMIN_PASS || 'SuperSecurePass123!' },
  challenge: true
}));

// Multer Restricted Storage Configuration (Strict MIME Type Filtering)
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + Math.round(Math.random() * 1E9) + path.extname(file.originalname))
});

const fileFilter = (req, file, cb) => {
  const allowedTypes = /jpeg|jpg|png|webp|gif/;
  const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
  const mimetype = allowedTypes.test(file.mimetype);
  if (extname && mimetype) {
    return cb(null, true);
  }
  cb(new Error('Ruhusiwa kupakia picha pekee (jpeg, jpg, png, webp, gif)!'));
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 }
}).array('images', 4);

// Authentication Guard Middleware
function requireWinga(req, res, next) {
  if (!req.session || !req.session.wingaId) {
    return res.redirect('/login');
  }
  next();
}

// Helper to standardise product image URLs
function getProductImages(product) {
  if (!product) return [];
  let raw = product.imageUrl;
  if (!raw || (typeof raw === 'string' && raw.trim() === '')) {
    raw = product.imageLocalPath;
  }
  if (!raw) return [];
  let list = [];
  try {
    const parsed = typeof raw === 'string' && raw.trim().startsWith('[') ? JSON.parse(raw) : raw;
    list = Array.isArray(parsed) ? parsed : [parsed];
  } catch (e) {
    list = [raw];
  }
  return list.map(img => {
    if (!img) return '';
    img = String(img).trim();
    if (img.startsWith('http://') || img.startsWith('https://')) return img;
    if (img.startsWith('/uploads/')) return img;
    if (img.startsWith('uploads/')) return '/' + img;
    const baseName = path.basename(img);
    return `/uploads/${baseName}`;
  }).filter(Boolean);
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

// Helper: Broadcast New Product Notification
async function notifyShopCustomers(winga, newProduct) {
  try {
    if (!isWhatsappReady || !client || !client.pupPage) return;
    const shopOrders = await db('orders').where({ wingaId: winga.id });
    const customerJids = [...new Set(shopOrders.map(o => o.senderJid).filter(Boolean))];
    if (customerJids.length === 0) return;
    const images = getProductImages(newProduct);
    const firstImage = images[0] ? path.join(UPLOADS_DIR, path.basename(images[0])) : null;
        
    const alertMsg =
      `📢 *TAARIFA ZA BIDHAA MPYA!* 🛍️\n` +
      `-----------------------------------\n` +
      `Duka la *${winga.name}* limeongeza bidhaa mpya sokoni!\n\n` +
      `📦 *Bidhaa:* ${newProduct.name}\n` +
      `💰 *Bei:* TSh ${Number(newProduct.sellingPrice).toLocaleString()}\n` +
      `📁 *Aina:* ${newProduct.category}\n\n` +
      `🔗 *Tazama na uagize hapa:*\n${BASE_URL}/catalog?shop=${winga.id}`;
    for (const jid of customerJids) {
      try {
        if (firstImage && fs.existsSync(firstImage)) {
          const media = MessageMedia.fromFilePath(firstImage);
          await client.sendMessage(jid, media, { caption: alertMsg });
        } else {
          await client.sendMessage(jid, alertMsg);
        }
      } catch (sendErr) {
        console.error(`Failed sending broadcast to ${jid}:`, sendErr.message);
      }
    }
  } catch (err) {
    console.error('Error broadcasting new product notification:', err);
  }
}

// Helper: Notify Winga of New Order
async function notifyWinga(order, product) {
  try {
    if (!isWhatsappReady || !client || !client.pupPage) return;
    const winga = await db('wingas').where({ id: order.wingaId }).first();
    if (!winga || !winga.phone) return;
    let phone = winga.phone.trim().replace('+', '');
    if (phone.startsWith('0')) {
      phone = '255' + phone.slice(1);
    }
    const wingaChatId = phone + '@c.us';
    const alertMessage =
      `🔔 *ODA MPYA IMETOKA KWENYE DUKA YAKO!* 🛍️\n` +
      `-----------------------------------\n` +
      `🔖 *Namba ya Oda:* #${order.orderId}\n` +
      `📦 *Bidhaa:* ${product.name}\n` +
      `💰 *Bei ya Kuuzia:* TSh ${Number(order.sellingPrice).toLocaleString()}\n` +
      `💵 *Faida Yako (Profit):* TSh ${(order.sellingPrice - order.buyingPrice).toLocaleString()}\n` +
      `📍 *Eneo la Mteja:* ${order.location}\n` +
      `📞 *Mteja Simu:* ${order.customerPhone}\n\n` +
      `📲 Angalia dashboard yako hapa: ${BASE_URL}/admin`;
    let targetFilePath = null;
    const images = getProductImages(product);
    if (images.length > 0) {
      const fileName = path.basename(images[0]);
      targetFilePath = path.join(UPLOADS_DIR, fileName);
    }
    let imageSent = false;
    if (targetFilePath && fs.existsSync(targetFilePath)) {
      const media = MessageMedia.fromFilePath(targetFilePath);
      await client.sendMessage(wingaChatId, media, { caption: alertMessage });
      imageSent = true;
    }
    if (!imageSent) {
      await client.sendMessage(wingaChatId, alertMessage);
    }
    console.log(`📲 WhatsApp alert sent to Winga: ${winga.name} (${phone})`);
  } catch (err) {
    console.error('❌ Failed to send alert to Winga:', err);
  }
}

// Express Route: LocalStorage Sync Endpoint
app.post('/api/sync-localStorage', async (req, res) => {
  const { products } = req.body;
  try {
    if (Array.isArray(products)) {
      for (const p of products) {
        await db('products').insert({
          wingaId: p.wingaId || 1,
          name: p.name,
          category: p.category || 'General',
          buyingPrice: p.buyingPrice || 0,
          sellingPrice: p.sellingPrice || p.price || 0,
          price: p.sellingPrice || p.price || 0,
          imageUrl: p.imageUrl || ''
        }).onConflict('id').merge();
      }
    }
    res.json({ success: true, message: 'LocalStorage items migrated to MySQL.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Landing Page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Public Catalog Route (Fully Responsive for Mobile & Desktop)
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
    let shopOptions = wingas.map(w => `<option value="${w.id}" ${shopId == w.id ? 'selected' : ''}>${escapeHtml(w.name)}</option>`).join('');
    let productCards = products.map(p => {
      const sellingPrice = Number(p.sellingPrice || p.price || 0);
      const priceFormatted = sellingPrice > 0 ? sellingPrice.toLocaleString() : 'Haikutajwa';
      const priceDisplay = sellingPrice > 0 ? `TSh ${priceFormatted}` : 'Wasiliana na Muuzaji';
            
      const imageList = getProductImages(p);
      const mainImage = imageList[0] || '';
      const categoryStr = (p.category || 'General').trim();
      const matchedWinga = wingas.find(w => w.id === p.wingaId);
      const sellerName = matchedWinga ? matchedWinga.name : 'Duka Kuu';
      let galleryThumbnailsHtml = '';
      if (imageList.length > 1) {
        galleryThumbnailsHtml = `<div style="display: flex; gap: 6px; margin-bottom: 10px; overflow-x: auto; padding-bottom: 4px;">` +
          imageList.map(img => `<img src="${img}" style="width: 42px; height: 42px; object-fit: cover; border-radius: 6px; border: 1px solid #ccc; cursor: pointer; flex-shrink: 0;" onclick="event.stopPropagation(); document.getElementById('img-${p.id}').src='${img}'; document.getElementById('img-${p.id}').setAttribute('data-fullsrc', '${img}');">`).join('') +
          `</div>`;
      }
      const imageHtml = (mainImage && mainImage.trim() !== '')
        ? `<div style="position: relative; cursor: pointer;" onclick="openImgModal(document.getElementById('img-${p.id}').getAttribute('data-fullsrc') || '${mainImage}')">
            <img id="img-${p.id}" data-fullsrc="${mainImage}" src="${mainImage}" alt="${escapeHtml(p.name)}" style="width: 100%; height: 180px; object-fit: cover; border-radius: 8px; margin-bottom: 8px;">
            <span style="position: absolute; bottom: 12px; right: 8px; background: rgba(0,0,0,0.65); color: white; padding: 2px 6px; border-radius: 4px; font-size: 10px; font-weight: bold; pointer-events: none;">🔍 Kukuza</span>
           </div>${galleryThumbnailsHtml}`
        : `<div style="height: 140px; background: #e9ecef; border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 32px; margin-bottom: 10px; color: #adb5bd;">📦</div>`;
      return `
      <div class="product-card" data-name="${escapeHtml(p.name.toLowerCase())}" data-category="${escapeHtml(categoryStr.toLowerCase())}" data-shop="${p.wingaId}" data-shopname="${escapeHtml(sellerName.toLowerCase())}">
        <div>
          ${imageHtml}
          <div>
            <span style="background: #e3f2fd; color: #0d47a1; font-size: 10px; padding: 2px 6px; border-radius: 10px; font-weight: bold; text-transform: uppercase;">${escapeHtml(categoryStr)}</span>
          </div>
          <h3 style="margin: 6px 0; color: #222; font-size: 15px; line-height: 1.3;">${escapeHtml(p.name)}</h3>
          <p style="color: ${sellingPrice > 0 ? '#28a745' : '#6c757d'}; font-size: 15px; font-weight: bold; margin: 4px 0 10px 0;">${priceDisplay}</p>
        </div>
        <div>
          <div style="font-size: 12px; color: #555; margin-bottom: 8px;">
            <span>🏪 <strong>${escapeHtml(sellerName)}</strong></span>
          </div>
          <button
            data-id="${p.id}"
            data-name="${escapeHtml(p.name)}"
            data-price="${priceFormatted}"
            onclick="handleOrderClick(this)"
            style="background: #25D366; color: white; padding: 10px; border: none; border-radius: 6px; font-weight: bold; cursor: pointer; font-size: 14px; width: 100%;">
            🛒 Agiza Sasa
          </button>
        </div>
      </div>`;
    }).join('');
    if (products.length === 0) {
      productCards = '<p style="grid-column: 1 / -1; text-align: center; color: #666; padding: 40px 0;">Hakuna bidhaa kwenye duka hili kwa sasa.</p>';
    }
    res.send(`
    <!DOCTYPE html>
    <html lang="sw">
    <head>
      <title>${escapeHtml(shopName)}</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f4f6f8; margin: 0; padding: 10px; color: #333; }
        .container { max-width: 1000px; margin: 0 auto; padding: 10px; }
        .header-bar { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px; margin-bottom: 15px; }
        .nav-btns { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
        .track-btn { background: #007bff; color: white; padding: 8px 12px; border-radius: 6px; text-decoration: none; font-weight: bold; font-size: 13px; }
        .contact-btn { background: #25D366; color: white; padding: 8px 12px; border-radius: 6px; text-decoration: none; font-weight: bold; font-size: 13px; display: flex; align-items: center; gap: 4px; }
        .filter-bar { display: flex; gap: 8px; margin-bottom: 15px; flex-wrap: wrap; }
        .filter-bar input, .filter-bar select { padding: 10px; border: 1px solid #ccc; border-radius: 6px; font-size: 14px; }
        .filter-bar input { flex: 2; min-width: 160px; }
        .filter-bar select { flex: 1; min-width: 120px; }
        .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 12px; }
        @media(min-width: 768px) {
          body { padding: 20px; }
          .grid { grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 20px; }
        }
        .product-card { background: white; padding: 12px; border-radius: 8px; box-shadow: 0 2px 6px rgba(0,0,0,0.06); text-align: left; display: flex; flex-direction: column; justify-content: space-between; }
        h1 { color: #111; font-size: 18px; margin: 0; }
        @media(min-width: 768px) { h1 { font-size: 24px; } }
        .modal-overlay { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); justify-content: center; align-items: center; z-index: 1000; padding: 15px; box-sizing: border-box; }
        .modal-content { background: white; padding: 20px; border-radius: 12px; width: 100%; max-width: 360px; box-shadow: 0 4px 20px rgba(0,0,0,0.2); position: relative; }
        .close-btn { position: absolute; top: 10px; right: 12px; font-size: 22px; cursor: pointer; color: #aaa; border: none; background: none; }
        .form-group { margin-bottom: 12px; text-align: left; }
        .form-group label { display: block; font-weight: bold; margin-bottom: 4px; color: #333; font-size: 13px; }
        .form-group input { width: 100%; padding: 10px; border: 1px solid #ccc; border-radius: 6px; box-sizing: border-box; font-size: 14px; }
        .submit-btn { background: #25D366; color: white; border: none; padding: 12px; width: 100%; font-size: 15px; font-weight: bold; border-radius: 6px; cursor: pointer; margin-top: 8px; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header-bar">
          <h1>${escapeHtml(shopName)}</h1>
          <div class="nav-btns">
            <a href="https://wa.me/${botPhone}?text=Habari!%20Naomba%20msaada%20tafadhali" target="_blank" class="contact-btn">💬 Chat</a>
            <a href="${trackBtnUrl}" class="track-btn">🔍 Fuatilia</a>
          </div>
        </div>
        <div class="filter-bar">
          <input type="text" id="searchInput" onkeyup="filterCatalog()" placeholder="🔍 Tafuta bidhaa...">
          <select id="shopSelect" onchange="filterCatalog()">
            <option value="all">🏪 Maduka Yote</option>
            ${shopOptions}
          </select>
          <select id="categorySelect" onchange="filterCatalog()">
            <option value="all">📁 Makundi Yote</option>
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
          <h3 style="margin-top:0; color:#111; font-size:16px;" id="modalProductName">Agiza Bidhaa</h3>
          <p style="color:#28a745; font-weight:bold; margin-top:-4px; font-size:14px;" id="modalProductPrice"></p>
          <input type="hidden" id="selectedProductId">
          <input type="hidden" id="selectedProductName">
          <input type="hidden" id="selectedProductPrice">
          <div class="form-group">
            <label>Namba yako ya Simu:</label>
            <input type="text" id="orderPhone" placeholder="Mfano: 0712345678" required>
          </div>
          <div class="form-group">
            <label>Eneo Unapoishi / Mkoa:</label>
            <input type="text" id="orderLocation" placeholder="Mfano: Dar es Salaam, Sinza" required>
          </div>
          <div class="form-group">
            <label>Saizi (Size - kama ipo):</label>
            <input type="text" id="orderSize" placeholder="Mfano: M, L, XL, 42">
          </div>
          <div class="form-group">
            <label>Idadi (Quantity):</label>
            <input type="number" id="orderQty" value="1" min="1">
          </div>
          <button class="submit-btn" onclick="sendToWhatsApp()">📲 Tuma Oda kwa WhatsApp</button>
        </div>
      </div>
      <script>
        var BOT_PHONE = "${botPhone}";
        function openImgModal(src) {
          if (!src) return;
          var modal = document.getElementById('fullImgModal');
          var img = document.getElementById('lightboxImage');
          img.src = src;
          modal.style.display = 'flex';
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
            if (matchesSearch && matchesCat && matchesShop) {
              cards[i].style.display = 'flex';
            } else {
              cards[i].style.display = 'none';
            }
          }
        }
        function handleOrderClick(btn) {
          var id = btn.getAttribute('data-id');
          var name = btn.getAttribute('data-name');
          var price = btn.getAttribute('data-price');
          openModal(id, name, price);
        }
        function openModal(id, name, price) {
          document.getElementById('selectedProductId').value = id;
          document.getElementById('selectedProductName').value = name;
          document.getElementById('selectedProductPrice').value = price;
          document.getElementById('modalProductName').innerText = '🛒 ' + name;
          document.getElementById('modalProductPrice').innerText = 'Bei: TSh ' + price;
          document.getElementById('orderModal').style.display = 'flex';
        }
        function closeModal() {
          document.getElementById('orderModal').style.display = 'none';
        }
        function sendToWhatsApp() {
          var id = document.getElementById('selectedProductId').value;
          var name = document.getElementById('selectedProductName').value;
          var price = document.getElementById('selectedProductPrice').value;
          var phone = document.getElementById('orderPhone').value || 'Haikutajwa';
          var location = document.getElementById('orderLocation').value || 'Haikutajwa';
          var size = document.getElementById('orderSize').value || 'Haikutajwa';
          var qty = document.getElementById('orderQty').value || 1;
          var message = '!agiza ' + id + '\\n\\n*TAARIFA ZA ODA:*\\n📦 Bidhaa: ' + name + '\\n💰 Bei: TSh ' + price + '\\n📞 Simu: ' + phone + '\\n📍 Eneo: ' + location + '\\n📏 Saizi: ' + size + '\\n🔢 Idadi: ' + qty;
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

// Order Tracking Routes (Database Backed)
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
              <h4 style="margin:0 0 10px 0; font-size:15px;">Toa Maoni & Nyota (Review Order)</h4>
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
                <button type="submit" style="background:#28a745; color:white; border:none; padding:10px; border-radius:4px; font-weight:bold; cursor:pointer; width:100%;">Tuma Feedback</button>
              </form>
            </div>`;
          }
        }
        resultHtml = `
        <div style="background:white; padding:15px; border-radius:8px; box-shadow:0 2px 8px rgba(0,0,0,0.08); margin-top:15px;">
          <h3 style="margin:0 0 10px 0; color:#111; font-size:16px;">Oda #${order.orderId}</h3>
          <p style="margin:4px 0; font-size:14px;"><strong>📦 Bidhaa:</strong> ${escapeHtml(order.productName)}</p>
          <p style="margin:4px 0; font-size:14px;"><strong>💰 Bei:</strong> TSh ${Number(order.sellingPrice || 0).toLocaleString()}</p>
          <p style="margin:4px 0; font-size:14px;"><strong>📍 Eneo:</strong> ${escapeHtml(order.location)}</p>
          <p style="margin:8px 0 0 0; padding:6px 10px; background:#f0f0f0; border-radius:6px; display:inline-block; font-weight:bold; font-size:13px;">Status: ${statusBadge}</p>
          ${reviewSection}
        </div>`;
      } else {
        resultHtml = `<div style="background:#f8d7da; color:#721c24; padding:12px; border-radius:6px; margin-top:15px; text-align:center; font-size:14px;">❌ Hakuna Oda yenye Namba #${searchId}.</div>`;
      }
    }
    const backCatalogUrl = shopId ? `/catalog?shop=${shopId}` : '/catalog';
    res.send(`
    <!DOCTYPE html>
    <html lang="sw">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Fuatilia Oda - Winga Shop</title>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f4f6f8; margin: 0; padding: 15px; color: #333; }
        .container { max-width: 480px; margin: 0 auto; }
        h1 { text-align: center; color: #111; font-size: 20px; }
        .search-box { background: white; padding: 15px; border-radius: 8px; box-shadow: 0 2px 6px rgba(0,0,0,0.06); }
        input[type="number"] { width: 100%; padding: 10px; border: 1px solid #ccc; border-radius: 6px; box-sizing: border-box; font-size: 15px; margin-bottom: 10px; }
        button.btn-search { width: 100%; background: #007bff; color: white; border: none; padding: 10px; border-radius: 6px; font-weight: bold; font-size: 14px; cursor: pointer; }
        .back-link { display: block; text-align: center; margin-top: 15px; color: #666; text-decoration: none; font-size: 13px; }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>🔍 Fuatilia Oda Yako</h1>
        <div class="search-box">
          <form action="/track" method="GET">
            ${shopId ? `<input type="hidden" name="shop" value="${shopId}">` : ''}
            <label style="display:block; margin-bottom:5px; font-weight:600; font-size:13px;">Weka Namba ya Oda (Order ID):</label>
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

// Winga Login Routes
app.get('/login', (req, res) => {
  res.send(`
  <!DOCTYPE html>
  <html lang="sw">
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Winga Login</title>
    <style>
      body { font-family: sans-serif; background: rgb(106, 136, 232); display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
      .login-box { background: white; padding: 25px; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); text-align: center; width: 90%; max-width: 320px; box-sizing: border-box; }
      input { padding: 10px; width: 100%; margin: 8px 0; border: 1px solid #4092e5; border-radius: 4px; box-sizing: border-box; font-size: 14px; }
      button { background: #28a745; color: white; border: none; padding: 10px; border-radius: 4px; cursor: pointer; font-size: 15px; width: 100%; font-weight: bold; margin-top: 8px; }
      a { color: #007bff; text-decoration: none; font-size: 13px; display: block; margin-top: 10px; }
    </style>
  </head>
  <body>
    <div class="login-box">
      <h2>🛍️ Winga Login</h2>
      <form action="/login" method="POST">
        <label style="display:block; text-align:left; font-size:12px; font-weight:bold;">Namba ya Simu:</label>
        <input type="text" name="phone" placeholder="0712345678" required>
        <label style="display:block; text-align:left; font-size:12px; font-weight:bold;">Password:</label>
        <input type="password" name="password" placeholder="••••••••" required>
        <button type="submit">Ingia Dashboard</button>
      </form>
      <a href="/register">📝 Jisajili kama Winga Mpya</a>
      <a href="/forgot-password">🔑 Umesahau Nenosiri?</a>
    </div>
  </body>
  </html>
  `);
});

app.post('/login', async (req, res) => {
  try {
    const phone = (req.body.phone || '').trim();
    const password = (req.body.password || '').trim();
    if (!phone || !password) {
      return res.send('❌ Tafadhali jaza namba ya simu na nywila. <br><a href="/login">Jaribu Tena</a>');
    }
    const matchedWinga = await db('wingas').where({ phone }).first();
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

// Winga Register Routes
app.get('/register', (req, res) => {
  res.send(`
  <!DOCTYPE html>
  <html lang="sw">
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Usajili wa Winga</title>
    <style>
      body { font-family: sans-serif; background: rgb(106, 136, 232); display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
      .box { background: white; padding: 25px; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); text-align: center; width: 90%; max-width: 320px; box-sizing: border-box; }
      input { padding: 10px; width: 100%; margin: 8px 0; border: 1px solid #4092e5; border-radius: 4px; box-sizing: border-box; font-size: 14px; }
      button { background: #28a745; color: white; border: none; padding: 10px; border-radius: 4px; cursor: pointer; font-size: 15px; width: 100%; font-weight: bold; margin-top: 8px; }
      a { color: #007bff; text-decoration: none; font-size: 13px; display: block; margin-top: 12px; }
    </style>
  </head>
  <body>
    <div class="box">
      <h2>📝 Usajili wa Winga</h2>
      <form action="/register" method="POST">
        <input type="text" name="name" placeholder="Jina la Biashara / Lako" required>
        <input type="text" name="phone" placeholder="Namba ya Simu (0712345678)" required>
        <input type="password" name="password" placeholder="Nenosiri (min 6 chars)" required minlength="6">
        <button type="submit">Jisajili Sasa</button>
      </form>
      <a href="/login">← Rudi Kwenye Login</a>
    </div>
  </body>
  </html>
  `);
});

app.post('/register', async (req, res) => {
  try {
    const name = (req.body.name || '').trim();
    const phone = (req.body.phone || '').trim();
    const rawPassword = (req.body.password || '').trim();
    if (!name || !phone || !rawPassword) {
      return res.send('❌ Tafadhali jaza taarifa zote. <br><a href="/register">Jaribu Tena</a>');
    }
    const existing = await db('wingas').where({ phone }).first();
    if (existing) {
      return res.send('❌ Namba hii ya simu imeshasajiliwa tayari. <br><a href="/login">Ingia hapa</a>');
    }
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
    res.redirect('/login');
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).send('Hitilafu ya Server.');
  }
});

// Logout Handler
app.all('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) console.error('Session destruction error:', err);
    res.clearCookie('connect.sid');
    return res.redirect('/');
  });
});

// Admin Dashboard for Winga (Responsive)
app.get('/admin', requireWinga, async (req, res) => {
  try {
    const currentWinga = await db('wingas').where({ id: req.session.wingaId }).first();
    const botPhone = process.env.BOT_PHONE_NUMBER || '255678143403';
    if (currentWinga && currentWinga.status === 'suspended') {
      return res.send(`
      <div style="text-align:center; padding: 40px; font-family:sans-serif;">
        <h1 style="color: #dc3545;">⚠️ Akaunti Imesitishwa</h1>
        <p>Muda wako wa malipo umekwisha. Hauruhusiwi kuingiza bidhaa mpya au kuona oda.</p>
        <p>Wasiliana na Admin (${botPhone}) kufanya malipo ili kufunguliwa.</p>
        <a href="/logout" style="display:inline-block; margin-top:15px; padding:10px 20px; background:#007bff; color:white; text-decoration:none; border-radius:5px;">Rudi Kwenye Login</a>
      </div>
      `);
    }
    const currentWingaId = req.session.wingaId;
    const currentWingaName = req.session.wingaName;
    const products = await db('products').where({ wingaId: currentWingaId });
    const orders = await db('orders').where({ wingaId: currentWingaId });
    const reviews = await db('reviews').select('*');
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
    let productRows = products.map(p => {
      const images = getProductImages(p);
      let productImgHtml = '📦';
      if (images.length > 0) {
        const thumbHtml = images.map(img =>
          `<img src="${img}" onclick="openModal('${img}')" style="width: 32px; height: 32px; object-fit: cover; border-radius: 4px; border: 1px solid #ccc; cursor: pointer; flex-shrink: 0;">`
        ).join('');
        productImgHtml = `<div style="display: flex; gap: 4px; overflow-x: auto;">${thumbHtml}</div>`;
      }
      const safeName = escapeHtml(p.name);
      const safeCategory = escapeHtml(p.category || 'General');
      const safeSize = escapeHtml(p.size || 'Standard');
      const buyingPrice = Number(p.buyingPrice || 0);
      const sellingPrice = Number(p.sellingPrice || p.price || 0);
      return `
      <tr class="seller-product-row">
        <td>#${p.id}</td>
        <td>${productImgHtml}</td>
        <td class="prod-name">${escapeHtml(p.name)}</td>
        <td class="prod-cat">${escapeHtml(p.category || 'General')}</td>
        <td>TSh ${sellingPrice.toLocaleString()}</td>
        <td>
          <div style="display: flex; gap: 4px;">
            <button type="button" data-id="${p.id}" data-name="${safeName}" data-category="${safeCategory}" data-buying="${buyingPrice}" data-selling="${sellingPrice}" data-size="${safeSize}" onclick="handleEditClick(this)" style="background:#ffc107; color:#000; border:none; padding:4px 6px; border-radius:4px; font-size:11px; cursor:pointer;">✏️ Edit</button>
            <form action="/admin/product/delete" method="POST" onsubmit="return confirm('Futa bidhaa hii?');" style="display:inline;">
              <input type="hidden" name="id" value="${p.id}">
              <button type="submit" style="background:#dc3545; color:white; border:none; padding:4px 6px; border-radius:4px; font-size:11px; cursor:pointer;">🗑️ Del</button>
            </form>
          </div>
        </td>
      </tr>`;
    }).join('');

    let orderRows = orders.map(o => {
      const currentStatus = o.status || 'Pending';
      const rev = reviews.find(r => r.orderId === o.orderId);
      let badgeStyle = 'background:#ffc107; color:#000;';
      if (currentStatus === 'Dispatched') badgeStyle = 'background:#17a2b8; color:#fff;';
      if (currentStatus === 'Completed') badgeStyle = 'background:#28a745; color:#fff;';
      let reviewCell = rev ? `${'⭐'.repeat(rev.rating)}<br><small>"${escapeHtml(rev.comment)}"</small>` : '<em style="color:#999; font-size:11px;">Hakuna</em>';
      return `
      <tr>
        <td><strong>#${o.orderId}</strong></td>
        <td>${escapeHtml(o.productName)}<br><small>TSh ${Number(o.sellingPrice || 0).toLocaleString()}</small></td>
        <td>${escapeHtml(o.customerPhone)}<br><small>${escapeHtml(o.location)}</small></td>
        <td><span style="padding: 3px 6px; border-radius: 10px; font-size: 10px; font-weight: bold; ${badgeStyle}">${currentStatus}</span></td>
        <td>${reviewCell}</td>
        <td>
          <form action="/admin/order/status" method="POST" style="display:flex; gap:3px; flex-direction:column;">
            <input type="hidden" name="orderId" value="${o.orderId}">
            ${currentStatus !== 'Dispatched' && currentStatus !== 'Completed' ? `<button type="submit" name="status" value="Dispatched" style="background:#17a2b8; color:white; border:none; padding:3px 6px; border-radius:4px; font-size:10px; cursor:pointer;">🚚 Dispatch</button>` : ''}
            ${currentStatus !== 'Completed' ? `<button type="submit" name="status" value="Completed" style="background:#28a745; color:white; border:none; padding:3px 6px; border-radius:4px; font-size:10px; cursor:pointer;">✅ Complete</button>` : ''}
          </form>
        </td>
      </tr>`;
    }).join('');

    let alertMessage = '';
    if (req.query.added === 'true') {
      alertMessage = `<div style="background: #d4edda; color: #155724; padding: 10px; border-radius: 6px; margin-bottom: 15px; font-size: 13px; font-weight: bold;">✅ Bidhaa imeongezwa na kuarifiwa wateja!</div>`;
    } else if (req.query.error === 'upload') {
      alertMessage = `<div style="background: #f8d7da; color: #721c24; padding: 10px; border-radius: 6px; margin-bottom: 15px; font-size: 13px; font-weight: bold;">❌ Hitilafu ya picha (Max 4 files, 5MB).</div>`;
    }

    res.send(`
    <!DOCTYPE html>
    <html lang="sw">
    <head>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>Dashboard - ${escapeHtml(currentWingaName)}</title>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 0; padding: 10px; background: #f4f6f8; color: #333; }
        .container { max-width: 1000px; margin: 0 auto; }
        .top-nav { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; flex-wrap: wrap; gap: 8px; }
        .stats-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-bottom: 15px; }
        .stat-card { background: white; padding: 12px; border-radius: 6px; box-shadow: 0 1px 3px rgba(0,0,0,0.05); text-align: center; }
        .stat-card h3 { margin: 0; font-size: 11px; color: #666; text-transform: uppercase; }
        .stat-card p { margin: 4px 0 0 0; font-size: 16px; font-weight: bold; color: #111; }
        @media(min-width: 768px) { .stat-card p { font-size: 22px; } .stat-card h3 { font-size: 12px; } }
        .card { background: white; padding: 15px; border-radius: 8px; box-shadow: 0 1px 4px rgba(0,0,0,0.08); margin-bottom: 15px; }
        h1 { font-size: 18px; margin: 0; }
        h2 { font-size: 16px; margin-top: 0; }
        .form-group { margin-bottom: 10px; }
        .form-row { display: grid; grid-template-columns: 1fr; gap: 10px; }
        @media(min-width: 600px) { .form-row { grid-template-columns: 1fr 1fr; } }
        label { display: block; margin-bottom: 3px; font-weight: 600; font-size: 12px; }
        input[type="text"], input[type="number"], input[type="file"], input[type="password"] { width: 100%; padding: 8px; border: 1px solid #ccc; border-radius: 4px; box-sizing: border-box; font-size: 14px; }
        button.btn-add { background: #28a745; color: white; border: none; padding: 10px; border-radius: 4px; font-weight: bold; cursor: pointer; width: 100%; font-size: 14px; }
        table { width: 100%; border-collapse: collapse; margin-top: 5px; font-size: 12px; }
        th, td { text-align: left; padding: 8px; border-bottom: 1px solid #eee; }
        th { background: #f8f9fa; }
        .table-responsive { width: 100%; overflow-x: auto; }
        .contact-support { background: #25D366; color: white; padding: 6px 10px; border-radius: 6px; font-weight: bold; text-decoration: none; font-size: 12px; display: inline-flex; align-items: center; gap: 4px; }
      </style>
    </head>
    <body>
      <div class="container">
        ${alertMessage}
        <div class="top-nav">
          <h1>🛍️ ${escapeHtml(currentWingaName)}</h1>
          <div style="display:flex; gap:6px; align-items:center;">
            <a href="https://wa.me/${botPhone}?text=Habari%20Admin" target="_blank" class="contact-support">💬 Msaada</a>
            <a href="/logout" style="color:#dc3545; font-weight:bold; text-decoration:none; font-size:13px;">Logout</a>
          </div>
        </div>

        <div style="background: #e3f2fd; padding: 10px; border-radius: 6px; border: 1px solid #90caf9; margin-bottom: 15px;">
          <label style="color: #0d47a1; margin-bottom:2px; font-size:11px;">🔗 Link Yako ya Duka:</label>
          <input type="text" value="${BASE_URL}/catalog?shop=${currentWingaId}" readonly style="padding: 6px; font-size: 12px; color: #0d47a1; background: white;">
        </div>

        <div class="stats-grid">
          <div class="stat-card"><h3>Oda</h3><p>${completedOrdersCount}</p></div>
          <div class="stat-card"><h3>Mauzo</h3><p>TSh ${totalRevenue.toLocaleString()}</p></div>
          <div class="stat-card"><h3>Faida</h3><p style="color:#28a745;">TSh ${netProfit.toLocaleString()}</p></div>
        </div>

        <div class="card">
          <h2>➕ Ongeza Bidhaa Mpya (Picha 1 hadi 4)</h2>
          <form action="/admin/add" method="POST" enctype="multipart/form-data">
            <div class="form-row">
              <div class="form-group"><label>Jina la Bidhaa</label><input type="text" name="name" required></div>
              <div class="form-group"><label>Kipengele (Category)</label><input type="text" name="category" required></div>
            </div>
            <div class="form-row">
              <div class="form-group"><label>Bei ya Kununua (TSh)</label><input type="number" name="buyingPrice" required></div>
              <div class="form-group"><label>Bei ya Kuuzia (TSh)</label><input type="number" name="sellingPrice" required></div>
            </div>
            <div class="form-row">
              <div class="form-group"><label>Saizi (Size)</label><input type="text" name="size" value="Standard"></div>
              <div class="form-group">
                <label>Picha za Bidhaa</label>
                <input type="file" name="images" accept="image/*" multiple required onchange="validateImages(this)">
                <small id="fileCountNotice" style="color: #007bff; font-weight: bold; display: block; margin-top: 2px; font-size:11px;"></small>
              </div>
            </div>
            <button type="submit" class="btn-add">Pakia & Weka Sokoni</button>
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
              notice.innerText = '✅ Picha zilizochaguliwa: ' + input.files.length;
            } else {
              notice.innerText = '';
            }
          }
        </script>

        <div class="card">
          <h2>📦 Oda na Feedback za Wateja (${orders.length})</h2>
          <div class="table-responsive">
            <table>
              <thead><tr><th>Oda #</th><th>Bidhaa</th><th>Mteja / Eneo</th><th>Status</th><th>Feedback</th><th>Action</th></tr></thead>
              <tbody>${orderRows || '<tr><td colspan="6">Hakuna oda zilizowekwa bado.</td></tr>'}</tbody>
            </table>
          </div>
        </div>

        <div class="card">
          <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px; margin-bottom:8px;">
            <h2 style="margin:0;">🏷️ Bidhaa Zako (${products.length})</h2>
            <input type="text" id="sellerSearchInput" onkeyup="filterSellerProducts()" placeholder="🔍 Tafuta bidhaa..." style="max-width:200px; padding:6px; font-size:13px;">
          </div>
          <div class="table-responsive">
            <table>
              <thead><tr><th>ID</th><th>Picha</th><th>Jina</th><th>Category</th><th>Bei</th><th>Action</th></tr></thead>
              <tbody id="sellerProductTable">${productRows || '<tr><td colspan="6">Hakuna bidhaa.</td></tr>'}</tbody>
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

        <div class="card">
          <h3>🔑 Badilisha Nenosiri</h3>
          <form id="changePasswordForm">
            <div class="form-group"><label>Nenosiri la Zamani:</label><input type="password" id="oldPassword" required></div>
            <div class="form-group"><label>Nenosiri Jipya:</label><input type="password" id="newPassword" required></div>
            <div class="form-group"><label>Rudia Nenosiri Jipya:</label><input type="password" id="confirmPassword" required></div>
            <button type="submit" style="background:#007bff; color:white; border:none; padding:8px 12px; border-radius:4px; font-weight:bold; cursor:pointer; width:100%; font-size:13px;">Hifadhi Nenosiri</button>
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
            } catch (err) { alert('❌ Hitilafu ya mtandao.'); }
          });
        </script>
      </div>

      <div id="imgModal" onclick="closeModal()" style="display: none; position: fixed; z-index: 9999; left: 0; top: 0; width: 100%; height: 100%; background-color: rgba(0,0,0,0.85); justify-content: center; align-items: center; cursor: pointer; padding: 15px;">
        <img id="modalImage" style="max-width: 95%; max-height: 85vh; border-radius: 6px; object-fit: contain;">
      </div>
      <script>
        function openModal(src) { document.getElementById('modalImage').src = src; document.getElementById('imgModal').style.display = 'flex'; }
        function closeModal() { document.getElementById('imgModal').style.display = 'none'; }
      </script>

      <div id="editModal" style="display: none; position: fixed; z-index: 9999; left: 0; top: 0; width: 100%; height: 100%; background-color: rgba(0,0,0,0.6); justify-content: center; align-items: center; padding: 15px; box-sizing: border-box;">
        <div style="background: #fff; padding: 20px; border-radius: 8px; width: 100%; max-width: 380px;">
          <h3>✏️ Rekebisha Bidhaa</h3>
          <form action="/admin/product/edit" method="POST">
            <input type="hidden" id="editId" name="id">
            <div style="margin-bottom: 8px;"><label>Jina:</label><input type="text" id="editName" name="name" required></div>
            <div style="margin-bottom: 8px;"><label>Kipengele:</label><input type="text" id="editCategory" name="category" required></div>
            <div style="margin-bottom: 8px;"><label>Bei ya Kununua:</label><input type="number" id="editBuyingPrice" name="buyingPrice" required></div>
            <div style="margin-bottom: 8px;"><label>Bei ya Kuuzia:</label><input type="number" id="editSellingPrice" name="sellingPrice" required></div>
            <div style="margin-bottom: 12px;"><label>Saizi:</label><input type="text" id="editSize" name="size"></div>
            <div style="display: flex; gap: 8px; justify-content: flex-end;">
              <button type="button" onclick="closeEditModal()" style="padding: 8px 12px; background: #6c757d; color: white; border: none; border-radius: 4px; cursor: pointer;">Aghana</button>
              <button type="submit" style="padding: 8px 12px; background: #28a745; color: white; border: none; border-radius: 4px; cursor: pointer;">Hifadhi</button>
            </div>
          </form>
        </div>
      </div>
      <script>
        function handleEditClick(btn) {
          document.getElementById('editId').value = btn.getAttribute('data-id');
          document.getElementById('editName').value = btn.getAttribute('data-name');
          document.getElementById('editCategory').value = btn.getAttribute('data-category');
          document.getElementById('editBuyingPrice').value = btn.getAttribute('data-buying');
          document.getElementById('editSellingPrice').value = btn.getAttribute('data-selling');
          document.getElementById('editSize').value = btn.getAttribute('data-size');
          document.getElementById('editModal').style.display = 'flex';
        }
        function closeEditModal() { document.getElementById('editModal').style.display = 'none'; }
      </script>
    </body>
    </html>
    `);
  } catch (err) {
    console.error('Admin page error:', err);
    res.status(500).send('Hitilafu kwenye Server.');
  }
});

// Admin Add Product Route
app.post('/admin/add', requireWinga, (req, res) => {
  upload(req, res, async (err) => {
    if (err) {
      console.error('Upload Error:', err.message);
      return res.redirect('/admin?error=upload');
    }
    try {
      const { name, category, buyingPrice, sellingPrice, size } = req.body;
      const uploadedFiles = req.files || [];
      const imageUrls = uploadedFiles.map(f => `/uploads/${f.filename}`);
      const localPaths = uploadedFiles.map(f => f.path);
      const [insertedId] = await db('products').insert({
        wingaId: req.session.wingaId,
        name: name.trim(),
        category: category ? category.trim() : 'General',
        buyingPrice: parseFloat(buyingPrice || 0),
        sellingPrice: parseFloat(sellingPrice || 0),
        price: parseFloat(sellingPrice || 0),
        size: size ? size.trim() : 'Standard',
        imageUrl: JSON.stringify(imageUrls),
        imageLocalPath: JSON.stringify(localPaths),
        dateAdded: new Date()
      });
      const newProduct = await db('products').where({ id: insertedId }).first();
      const currentWinga = await db('wingas').where({ id: req.session.wingaId }).first();
            
      if (currentWinga && newProduct) {
        notifyShopCustomers(currentWinga, newProduct);
      }
      res.redirect('/admin?added=true');
    } catch (dbErr) {
      console.error('DB Insert product error:', dbErr);
      res.redirect('/admin?error=upload');
    }
  });
});

// Delete Product
app.post('/admin/product/delete', requireWinga, async (req, res) => {
  try {
    const { id } = req.body;
    await db('products').where({ id: parseInt(id), wingaId: req.session.wingaId }).del();
  } catch (err) {
    console.error('❌ Error deleting product:', err);
  }
  res.redirect('/admin');
});

// Edit Product
app.post('/admin/product/edit', requireWinga, async (req, res) => {
  try {
    const { id, name, category, buyingPrice, sellingPrice, size } = req.body;
    await db('products').where({ id: parseInt(id), wingaId: req.session.wingaId }).update({
      name: name ? name.trim() : undefined,
      category: category ? category.trim() : undefined,
      buyingPrice: Number(buyingPrice),
      sellingPrice: Number(sellingPrice),
      price: Number(sellingPrice),
      size: size ? size.trim() : undefined
    });
  } catch (err) {
    console.error('❌ Error updating product:', err);
  }
  res.redirect('/admin');
});

// Order Status Update & Real-Time WhatsApp Alert to Customer
app.post('/admin/order/status', requireWinga, async (req, res) => {
  try {
    const { orderId, status } = req.body;
    const order = await db('orders').where({ orderId: parseInt(orderId), wingaId: req.session.wingaId }).first();
    if (order) {
      await db('orders').where({ orderId: parseInt(orderId), wingaId: req.session.wingaId }).update({ status });
      let customerChatId = order.senderJid;
      if (!customerChatId || !customerChatId.includes('@c.us')) {
        let phone = (order.customerPhone || '').trim().replace('+', '');
        if (phone.startsWith('0')) phone = '255' + phone.slice(1);
        if (phone) customerChatId = phone + '@c.us';
      }
      if (customerChatId && isWhatsappReady && client && client.pupPage) {
        let statusMessage = '';
        const trackUrl = `${BASE_URL}/track?id=${order.orderId}`;
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
            `Habari! Oda #${order.orderId} (${order.productName}) imewasilishwa kikamilifu.\n\n` +
            `⭐ *TUPE MAONI YAKO HAPA HAPA:* ⭐\n` +
            `*!maoni ${order.orderId} [nyota 1-5] [maoni yako]*\n` +
            `Mfano: *!maoni ${order.orderId} 5 Huduma ni nzuri sana!*`;
        }
        if (statusMessage) {
          await client.sendMessage(customerChatId, statusMessage);
        }
      }
    }
  } catch (err) {
    console.error('❌ Error updating status:', err);
  }
  res.redirect('/admin');
});

// Change Password Route
app.post('/admin/change-password', requireWinga, async (req, res) => {
  const wingaId = req.session.wingaId;
  const { oldPassword, newPassword, confirmPassword } = req.body;
  if (!oldPassword || !newPassword || !confirmPassword) {
    return res.status(400).json({ success: false, message: 'Tafadhali jaza nafasi zote.' });
  }
  if (newPassword !== confirmPassword) {
    return res.status(400).json({ success: false, message: 'Nenosiri jipya halifanani na la kurudia.' });
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

// Forgot & Reset Password Routes (WhatsApp OTP)
app.get('/forgot-password', (req, res) => {
  res.send(`
  <!DOCTYPE html>
  <html lang="sw">
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Umesahau Nenosiri</title>
    <style>
      body { font-family: sans-serif; background: rgb(106, 136, 232); display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
      .box { background: white; padding: 25px; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); text-align: center; width: 90%; max-width: 320px; box-sizing: border-box; }
      input { padding: 10px; width: 100%; margin: 8px 0; border: 1px solid #4092e5; border-radius: 4px; box-sizing: border-box; font-size: 14px; }
      button { background: #007bff; color: white; border: none; padding: 10px; border-radius: 4px; cursor: pointer; font-size: 15px; font-weight: bold; width: 100%; margin-top: 8px; }
      a { color: #007bff; text-decoration: none; font-size: 13px; display: block; margin-top: 12px; }
    </style>
  </head>
  <body>
    <div class="box">
      <h2>🔑 Umesahau Nenosiri?</h2>
      <p style="color:#666; font-size:13px;">Weka namba yako ya simu. Tutatuma kodi ya OTP kwenye WhatsApp yako.</p>
      <form action="/forgot-password" method="POST">
        <input type="text" name="phone" placeholder="Mfano: 0712345678" required>
        <button type="submit">Tuma Kodi via WhatsApp</button>
      </form>
      <a href="/login">← Rudi Kwenye Login</a>
    </div>
  </body>
  </html>
  `);
});

app.post('/forgot-password', async (req, res) => {
  try {
    if (!isWhatsappReady || !client || !client.pupPage) {
      isWhatsappReady = false;
      return res.status(503).send('❌ WhatsApp Bot bado haijawa tayari. Tafadhali subiri sekunde chache. <br><a href="/forgot-password">Rudi Nyuma</a>');
    }
    const rawPhone = (req.body.phone || '').trim();
    if (!rawPhone) return res.send('❌ Weka namba ya simu. <br><a href="/forgot-password">Jaribu Tena</a>');
    let cleanedPhone = rawPhone.replace(/\D/g, '');
    if (cleanedPhone.startsWith('0')) cleanedPhone = '255' + cleanedPhone.slice(1);
    
    const winga = await db('wingas').where({ phone: rawPhone }).orWhere({ phone: cleanedPhone }).first();
    if (!winga) return res.send('❌ Namba hii haijasajiliwa. <br><a href="/forgot-password">Jaribu Tena</a>');

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    await db('password_resets').where({ phone: winga.phone }).del();
    await db('password_resets').insert({ phone: winga.phone, otp, expiresAt });
    
    const targetJid = `${cleanedPhone}@c.us`;
    const otpMessage = `🔑 *KODI YA KUBADILISHA NENOSIRI*\n\nHabari *${winga.name}*, kodi yako ya OTP ni:\n👉 *${otp}*\n\nInaisha muda wake baada ya dakika 10.`;
    await client.sendMessage(targetJid, otpMessage);

    res.send(`
    <!DOCTYPE html>
    <html lang="sw">
    <head>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>Weka Nenosiri Jipya</title>
      <style>
        body { font-family: sans-serif; background: rgb(106, 136, 232); display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
        .box { background: white; padding: 25px; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); text-align: center; width: 90%; max-width: 320px; box-sizing: border-box; }
        input { padding: 10px; width: 100%; margin: 8px 0; border: 1px solid #4092e5; border-radius: 4px; box-sizing: border-box; font-size: 14px; }
        button { background: #28a745; color: white; border: none; padding: 10px; border-radius: 4px; cursor: pointer; font-size: 15px; font-weight: bold; width: 100%; margin-top: 8px; }
      </style>
    </head>
    <body>
      <div class="box">
        <h2>🔐 Weka Nenosiri Jipya</h2>
        <p style="color:#28a745; font-size:12px; font-weight:bold;">✅ OTP imetumwa WhatsApp kwenda (${escapeHtml(winga.phone)})</p>
        <form action="/reset-password" method="POST">
          <input type="hidden" name="phone" value="${escapeHtml(winga.phone)}">
          <input type="text" name="otp" placeholder="Kodi ya OTP (Digits 6)" required>
          <input type="password" name="newPassword" placeholder="Nenosiri Jipya" required minlength="6">
          <input type="password" name="confirmPassword" placeholder="Rudia Nenosiri Jipya" required minlength="6">
          <button type="submit">Hifadhi Nenosiri</button>
        </form>
      </div>
    </body>
    </html>
    `);
  } catch (err) {
    console.error('OTP error:', err);
    res.status(500).send(`❌ Hitilafu: ${err.message}`);
  }
});

app.post('/reset-password', async (req, res) => {
  try {
    const { phone, otp, newPassword, confirmPassword } = req.body;
    if (!phone || !otp || !newPassword || !confirmPassword) return res.send('❌ Jaza nafasi zote. <br><a href="/forgot-password">Jaribu Tena</a>');
    if (newPassword !== confirmPassword) return res.send('❌ Nenosiri hazifanani. <br><a href="/forgot-password">Jaribu Tena</a>');
    if (newPassword.length < 6) return res.send('❌ Nenosiri lazima liwe na angalau herufi 6. <br><a href="/forgot-password">Jaribu Tena</a>');
    
    const resetRecord = await db('password_resets').where({ phone: phone.trim(), otp: otp.trim() }).where('expiresAt', '>', new Date()).first();
    if (!resetRecord) return res.send('❌ Kodi si sahihi au imeisha muda wake. <br><a href="/forgot-password">Omba Kodi Mpya</a>');
    
    const hashedPassword = await bcrypt.hash(newPassword.trim(), 10);
    await db('wingas').where({ phone: phone.trim() }).update({ password: hashedPassword });
    await db('password_resets').where({ phone: phone.trim() }).del();
    
    res.send(`
    <!DOCTYPE html>
    <html lang="sw">
    <head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Mafanikio</title></head>
    <body style="font-family:sans-serif; background:rgb(106, 136, 232); display:flex; justify-content:center; align-items:center; height:100vh; margin:0;">
      <div style="background:white; padding:30px; border-radius:8px; text-align:center; width:90%; max-width:340px;">
        <h2 style="color:#28a745;">🎉 Hongera!</h2>
        <p style="font-size:14px;">Nenosiri lako limebadilishwa kikamilifu.</p>
        <a href="/login" style="display:inline-block; margin-top:10px; padding:10px 20px; background:#28a745; color:white; text-decoration:none; border-radius:4px; font-weight:bold; font-size:14px;">Ingia Dashboard</a>
      </div>
    </body>
    </html>
    `);
  } catch (err) {
    res.status(500).send('❌ Hitilafu ya Server.');
  }
});

// Super Admin Routes (Fully Featured)
app.get('/superadmin', async (req, res) => {
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
        ? `<span style="background:#28a745; color:white; padding:2px 6px; border-radius:10px; font-size:10px; font-weight:bold;">Active</span>`
        : `<span style="background:#dc3545; color:white; padding:2px 6px; border-radius:10px; font-size:10px; font-weight:bold;">Suspended</span>`;
      const expiryFormatted = w.expiryDate ? new Date(w.expiryDate).toLocaleDateString() : 'N/A';
      return `
      <tr>
        <td><strong>#${w.id}</strong></td>
        <td>${escapeHtml(w.name)}</td>
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
              <button type="submit" style="background:#28a745; color:white; border:none; padding:3px 6px; border-radius:4px; font-size:10px; cursor:pointer;">Activate</button>
            </form>` : `
            <form action="/superadmin/winga/status" method="POST" style="display:inline;">
              <input type="hidden" name="wingaId" value="${w.id}">
              <input type="hidden" name="status" value="suspended">
              <button type="submit" style="background:#dc3545; color:white; border:none; padding:3px 6px; border-radius:4px; font-size:10px; cursor:pointer;">Suspend</button>
            </form>`}
            <form action="/superadmin/winga/extend" method="POST" style="display:inline;">
              <input type="hidden" name="wingaId" value="${w.id}">
              <button type="submit" style="background:#007bff; color:white; border:none; padding:3px 6px; border-radius:4px; font-size:10px; cursor:pointer;">+30 Days</button>
            </form>
          </div>
        </td>
      </tr>`;
    }).join('');

    let superadminProductRows = products.map(p => {
      const matchedWinga = wingas.find(w => w.id === p.wingaId);
      const sellerName = matchedWinga ? matchedWinga.name : `Winga #${p.wingaId}`;
      const images = getProductImages(p);
      const mainImg = images[0] ? `<img src="${images[0]}" style="width: 32px; height: 32px; object-fit: cover; border-radius: 4px;">` : '📦';
      return `
      <tr class="super-prod-row">
        <td>#${p.id}</td>
        <td>${mainImg}</td>
        <td class="sprod-name">${escapeHtml(p.name)}</td>
        <td>${escapeHtml(sellerName)}</td>
        <td>TSh ${Number(p.sellingPrice || 0).toLocaleString()}</td>
        <td>
          <form action="/superadmin/product/delete" method="POST" onsubmit="return confirm('Futa bidhaa hii?');" style="display:inline;">
            <input type="hidden" name="id" value="${p.id}">
            <button type="submit" style="background:#dc3545; color:white; border:none; padding:4px 8px; border-radius:4px; font-size:11px; cursor:pointer;">🗑️ Delete</button>
          </form>
        </td>
      </tr>`;
    }).join('');

    let superadminFeedbackRows = reviews.map(rev => {
      const matchedOrder = orders.find(o => o.orderId === rev.orderId);
      const matchedWinga = matchedOrder ? wingas.find(w => w.id === matchedOrder.wingaId) : null;
      const shopName = matchedWinga ? matchedWinga.name : 'Unknown';
      const prodName = matchedOrder ? matchedOrder.productName : 'N/A';
      return `
      <tr>
        <td>#${rev.orderId}</td>
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
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>Super Admin Portal</title>
      <style>
        body { font-family: sans-serif; background: #eef2f5; margin: 0; padding: 10px; color: #333; }
        .container { max-width: 1100px; margin: 0 auto; }
        .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; margin-bottom: 15px; }
        .stat-card { background: #1a1a1a; color: white; padding: 15px; border-radius: 8px; }
        .stat-card h3 { margin: 0 0 6px 0; font-size: 12px; color: #aaa; text-transform: uppercase; }
        .stat-card p { margin: 0; font-size: 20px; font-weight: bold; color: #4ade80; }
        .card { background: white; padding: 15px; border-radius: 8px; box-shadow: 0 1px 4px rgba(0,0,0,0.08); margin-bottom: 15px; }
        table { width: 100%; border-collapse: collapse; margin-top: 5px; font-size: 12px; }
        th, td { text-align: left; padding: 8px; border-bottom: 1px solid #eee; }
        th { background: #f8f9fa; }
        .table-responsive { width: 100%; overflow-x: auto; }
        input, button { padding: 8px; border: 1px solid #ccc; border-radius: 4px; font-size: 13px; }
        button { background: #007bff; color: white; border: none; cursor: pointer; }
      </style>
    </head>
    <body>
      <div class="container">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:15px;">
          <h1 style="font-size: 20px; margin:0;">👑 Super Admin</h1>
          <a href="/logout" style="background: #dc3545; color: white; padding: 6px 12px; border-radius: 6px; text-decoration: none; font-weight: bold; font-size: 13px;">🚪 Logout</a>
        </div>

        <div class="stats-grid">
          <div class="stat-card"><h3>Total Wingas</h3><p style="color:white;">${wingas.length}</p></div>
          <div class="stat-card"><h3>Total Revenue</h3><p>TSh ${platformTotalRevenue.toLocaleString()}</p></div>
          <div class="stat-card"><h3>Total Profit</h3><p>TSh ${platformTotalProfit.toLocaleString()}</p></div>
        </div>

        <div class="card">
          <h2>➕ Sajili Winga Mpya</h2>
          <form action="/superadmin/add-winga" method="POST" style="display:flex; gap:8px; flex-wrap:wrap;">
            <input type="text" name="name" placeholder="Jina la Biashara" required style="flex:2; min-width:140px;">
            <input type="text" name="phone" placeholder="Simu (0712...)" required style="flex:2; min-width:130px;">
            <input type="password" name="password" placeholder="Password (def: 123456)" style="flex:2; min-width:130px;">
            <button type="submit" style="background:#28a745; font-weight:bold; flex:1;">Sajili</button>
          </form>
        </div>

        <div class="card">
          <h2>🏢 Orodha ya Maduka (Wingas)</h2>
          <div class="table-responsive">
            <table>
              <thead><tr><th>ID</th><th>Jina</th><th>Simu</th><th>Status</th><th>Expires</th><th>Items</th><th>Orders</th><th>Profit</th><th>Actions</th></tr></thead>
              <tbody>${wingaRows || '<tr><td colspan="9">Hakuna wingas bado.</td></tr>'}</tbody>
            </table>
          </div>
        </div>

        <div class="card">
          <h2>💬 Feedback za Wateja (${reviews.length})</h2>
          <div class="table-responsive">
            <table>
              <thead><tr><th>Oda #</th><th>Duka</th><th>Bidhaa</th><th>Rating</th><th>Maoni</th></tr></thead>
              <tbody>${superadminFeedbackRows || '<tr><td colspan="5">Hakuna feedback.</td></tr>'}</tbody>
            </table>
          </div>
        </div>

        <div class="card">
          <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px; margin-bottom:8px;">
            <h2 style="margin:0;">📦 Usimamizi wa Bidhaa Zote (${products.length})</h2>
            <input type="text" id="superSearchInput" onkeyup="filterSuperadminProducts()" placeholder="🔍 Tafuta bidhaa..." style="max-width:200px; padding:6px;">
          </div>
          <div class="table-responsive">
            <table>
              <thead><tr><th>ID</th><th>Picha</th><th>Jina</th><th>Muuzaji</th><th>Bei</th><th>Action</th></tr></thead>
              <tbody id="superadminProductTable">${superadminProductRows || '<tr><td colspan="6">Hakuna bidhaa.</td></tr>'}</tbody>
            </table>
          </div>
        </div>
        <script>
          function filterSuperadminProducts() {
            var input = document.getElementById('superSearchInput').value.toLowerCase().trim();
            var rows = document.querySelectorAll('#superadminProductTable tr.super-prod-row');
            rows.forEach(function(row) {
              var name = row.querySelector('.sprod-name').innerText.toLowerCase();
              row.style.display = (name.indexOf(input) !== -1) ? '' : 'none';
            });
          }
        </script>
      </div>
    </body>
    </html>
    `);
  } catch (err) {
    res.status(500).send('Hitilafu kwenye Superadmin.');
  }
});

app.post('/superadmin/product/delete', async (req, res) => {
  try {
    await db('products').where({ id: parseInt(req.body.id) }).del();
  } catch (err) {}
  res.redirect('/superadmin');
});

app.post('/superadmin/add-winga', async (req, res) => {
  try {
    const name = (req.body.name || '').trim();
    const phone = (req.body.phone || '').trim();
    const rawPassword = (req.body.password || '123456').trim();
    if (!name || !phone) return res.redirect('/superadmin');
    const hashedPassword = await bcrypt.hash(rawPassword, 10);
    const expiry = new Date();
    expiry.setDate(expiry.getDate() + 30);
    await db('wingas').insert({ name, phone, password: hashedPassword, status: 'active', expiryDate: expiry, dateAdded: new Date() });
  } catch (err) {}
  res.redirect('/superadmin');
});

app.post('/superadmin/winga/status', async (req, res) => {
  try {
    await db('wingas').where({ id: parseInt(req.body.wingaId) }).update({ status: req.body.status });
  } catch (err) {}
  res.redirect('/superadmin');
});

app.post('/superadmin/winga/extend', async (req, res) => {
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

// WhatsApp Bot Event Listeners & Cron Jobs
client.on('qr', (qr) => {
  console.log('⚡ Scan this QR Code with WhatsApp:');
  qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
  console.log('✅ Winga WhatsApp Bot is connected and live!');
  isWhatsappReady = true;
});

client.on('authenticated', () => { console.log('🔒 WhatsApp authenticated'); });
client.on('auth_failure', (msg) => { console.error('❌ WhatsApp auth failure:', msg); isWhatsappReady = false; });
client.on('disconnected', (reason) => { console.warn('⚠️ WhatsApp disconnected:', reason); isWhatsappReady = false; client.initialize(); });

// Daily Cron Job for Subscriptions
cron.schedule('0 8 * * *', async () => {
  try {
    if (!isWhatsappReady || !client || !client.pupPage) return;
    const wingas = await db('wingas').select('*');
    const now = new Date();
    for (let w of wingas) {
      if (!w.expiryDate) continue;
      const expiry = new Date(w.expiryDate);
      const daysLeft = Math.ceil((expiry - now) / (1000 * 60 * 60 * 24));
      const formattedPhone = w.phone.startsWith('0') ? '255' + w.phone.slice(1) : w.phone;
      const chatId = formattedPhone + '@c.us';
      if (daysLeft <= 0 && w.status === 'active') {
        await db('wingas').where({ id: w.id }).update({ status: 'suspended' });
        try { await client.sendMessage(chatId, `⚠️ *AKAUNTI IMESITISHWA*\n\nNdugu ${w.name}, muda wako wa malipo umekwisha.`); } catch (e) {}
      } else if (daysLeft === 3 && w.status === 'active') {
        try { await client.sendMessage(chatId, `🔔 *KUMBUSHO LA MALIPO*\n\nNdugu ${w.name}, akaunti yako itasitishwa ndani ya siku 3.`); } catch (e) {}
      }
    }
  } catch (err) { console.error('Cron error:', err); }
});

// WhatsApp Message Handler (!agiza, !maoni, greetings)
client.on('message', async (msg) => {
  try {
    const text = (msg.body || '').trim();
    const lowerText = text.toLowerCase();
    
    // 1. Review Handler (!maoni)
    if (lowerText.startsWith('!maoni')) {
      const parts = text.split(/\s+/);
      const orderId = parseInt(parts[1]);
      const rating = parseInt(parts[2]);
      const comment = parts.slice(3).join(' ');
      if (!orderId || isNaN(rating) || rating < 1 || rating > 5 || !comment) {
        await msg.reply('❌ Muundo sio sahihi.\nTumia: *!maoni [OdaID] [1-5] [Maoni yako]*');
        return;
      }
      const orderExists = await db('orders').where({ orderId }).first();
      if (!orderExists) {
        await msg.reply(`❌ Haikuwezekana kupata Oda #${orderId}.`);
        return;
      }
      const existingReview = await db('reviews').where({ orderId }).first();
      if (existingReview) {
        await db('reviews').where({ orderId }).update({ rating, comment: comment.trim(), date: new Date() });
      } else {
        await db('reviews').insert({ orderId, rating, comment: comment.trim(), date: new Date() });
      }
      await msg.reply(`🎉 *AHSANTE KWA FEEDBACK YAKO!* ⭐\nTumepokea nyota ${'⭐'.repeat(rating)} kwa Oda #${orderId}.`);
      return;
    }

    // 2. Order Handler (!agiza)
    if (lowerText.startsWith('!agiza') || lowerText.startsWith('!order')) {
      let productID = null;
      let location = 'Haikutajwa';
      let phone = msg.from.replace('@c.us', '').replace('@s.whatsapp.net', '');
      if (text.includes('|')) {
        const payload = text.slice(7).split('|');
        productID = parseInt(payload[0].trim());
        if (payload[1]) location = payload[1].trim();
        if (payload[2]) phone = payload[2].trim();
      } else {
        const lines = text.split(/\r?\n/);
        const parts = lines[0].trim().split(/\s+/);
        if (parts[1]) productID = parseInt(parts[1]);
        for (let line of lines) {
          const trimmed = line.trim();
          const lower = trimmed.toLowerCase();
          if (lower.includes('simu:')) {
            const extPhone = trimmed.split(/simu:/i)[1].trim();
            if (extPhone && extPhone !== 'haikutajwa') phone = extPhone;
          }
          if (lower.includes('eneo:')) {
            const extLoc = trimmed.split(/eneo:/i)[1].trim();
            if (extLoc && extLoc !== 'haikutajwa') location = extLoc;
          }
        }
      }
      const product = await db('products').where({ id: productID }).first();
      if (!product) {
        await msg.reply(`❌ Bidhaa #${productID} haipatikani.`);
        return;
      }
      const maxResult = await db('orders').max('orderId as maxId').first();
      const nextOrderId = (maxResult && maxResult.maxId ? maxResult.maxId : 0) + 1;
      const newOrder = {
        orderId: nextOrderId,
        wingaId: product.wingaId || 1,
        productName: product.name,
        buyingPrice: Number(product.buyingPrice || 0),
        sellingPrice: Number(product.sellingPrice || product.price || 0),
        customerPhone: phone,
        location: location,
        senderJid: msg.from,
        status: 'Pending',
        date: new Date()
      };
      await db('orders').insert(newOrder);
      const trackUrl = `${BASE_URL}/track?id=${newOrder.orderId}`;
      await msg.reply(
        `🛒 *ODA YAKO IMEPOKELEWA!*\n---------------------------\n` +
        `🔖 *Oda:* #${newOrder.orderId}\n` +
        `📦 *Bidhaa:* ${product.name}\n` +
        `💰 *Bei:* TSh ${newOrder.sellingPrice.toLocaleString()}\n` +
        `📞 *Simu:* ${phone}\n` +
        `📍 *Eneo:* ${location}\n\n` +
        `📍 *Fuatilia Oda Yako Hapa:*\n${trackUrl}`
      );
      notifyWinga(newOrder, product);
      return;
    }

    // 3. Greetings
    const greetingKeywords = ['hi', 'hello', 'vp', 'habari', 'mambo', 'catalog', 'katalogi', 'katalog', '1', 'nguo', 'hey', 'niaje'];
    if (greetingKeywords.some(kw => lowerText === kw || lowerText.startsWith(kw + ' '))) {
      await msg.reply(`Karibu WingaShop! 👋\n\nTazama bidhaa zetu hapa:\n${BASE_URL}/catalog`);
      return;
    }
  } catch (err) {
    console.error('Bot message processing error:', err);
  }
});

// Start Express Server
app.listen(PORT, () => {
  console.log(`🌐 Server active on ${BASE_URL}`);
  try {
    client.initialize();
  } catch (err) {
    console.warn('⚠️ WhatsApp client initialization warning:', err.message);
  }
});