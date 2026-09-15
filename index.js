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
const BASE_URL = process.env.RENDER_EXTERNAL_URL || process.env.BASE_URL || `http://localhost:${PORT}`;

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
      '--single-process',
      '--disable-gpu'
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
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use('/uploads', express.static(UPLOADS_DIR));
app.use(express.static(path.join(__dirname, 'public')));

// Unified Session Middleware
app.use(session({
  secret: process.env.SESSION_SECRET || 'winga-super-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
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
  limits: { fileSize: 5 * 1024 * 1024 } // 5 MB Limit
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

// Public Catalog Route (Database Backed)
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
            <img id="img-${p.id}" data-fullsrc="${mainImage}" src="${mainImage}" alt="${escapeHtml(p.name)}" style="width: 100%; height: 200px; object-fit: cover; border-radius: 8px; margin-bottom: 8px; transition: transform 0.2s ease;">
            <span style="position: absolute; bottom: 14px; right: 8px; background: rgba(0,0,0,0.65); color: white; padding: 3px 8px; border-radius: 4px; font-size: 11px; font-weight: bold; pointer-events: none;">🔍 Gusa Kukuza</span>
           </div>${galleryThumbnailsHtml}`
        : `<div style="height: 140px; background: #e9ecef; border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 36px; margin-bottom: 10px; color: #adb5bd;">📦</div>`;

      return `
      <div class="product-card" data-name="${escapeHtml(p.name.toLowerCase())}" data-category="${escapeHtml(categoryStr.toLowerCase())}" data-shop="${p.wingaId}" data-shopname="${escapeHtml(sellerName.toLowerCase())}" style="background: white; padding: 15px; border-radius: 10px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); text-align: left; display: flex; flex-direction: column; justify-content: space-between;">
        <div>
          ${imageHtml}
          <div style="margin-bottom: 5px;">
            <span style="background: #e3f2fd; color: #0d47a1; font-size: 11px; padding: 3px 8px; border-radius: 12px; font-weight: bold; text-transform: uppercase;">${escapeHtml(categoryStr)}</span>
          </div>
          <h3 style="margin: 5px 0; color: #222; font-size: 16px;">${escapeHtml(p.name)}</h3>
          <p style="color: ${sellingPrice > 0 ? '#28a745' : '#6c757d'}; font-size: 16px; font-weight: bold; margin: 5px 0 15px 0;">${priceDisplay}</p>
        </div>
        <div style="font-size: 13px; color: #555; margin-bottom: 8px;">
          <span>🏪 <strong>${escapeHtml(sellerName)}</strong></span><br>
          <span>📍 Dar es Salaam</span>
        </div>
        <button 
          data-id="${p.id}" 
          data-name="${escapeHtml(p.name)}" 
          data-price="${priceFormatted}"
          onclick="handleOrderClick(this)" 
          style="background: #25D366; color: white; padding: 10px 15px; border: none; border-radius: 6px; font-weight: bold; cursor: pointer; font-size: 14px; width: 100%;">
          🛒 Agiza Sasa
        </button>
      </div>`;
    }).join('');

    if (products.length === 0) {
      productCards = '<p style="grid-column: 1 / -1; text-align: center; color: #666; padding: 40px 0;">Hakuna bidhaa kwenye duka hili kwa sasa.</p>';
    }

    res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>${escapeHtml(shopName)}</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f4f6f8; margin: 0; padding: 20px; color: #333; }
        .container { max-width: 900px; margin: 0 auto; }
        .header-bar { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px; margin-bottom: 20px; }
        .nav-btns { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
        .track-btn { background: #007bff; color: white; padding: 10px 16px; border-radius: 6px; text-decoration: none; font-weight: bold; font-size: 14px; }
        .contact-btn { background: #25D366; color: white; padding: 10px 16px; border-radius: 6px; text-decoration: none; font-weight: bold; font-size: 14px; display: flex; align-items: center; gap: 5px; }
        .filter-bar { display: flex; gap: 10px; margin-bottom: 20px; flex-wrap: wrap; }
        .filter-bar input, .filter-bar select { padding: 10px; border: 1px solid #ccc; border-radius: 6px; font-size: 14px; }
        .filter-bar input { flex: 2; min-width: 180px; }
        .filter-bar select { flex: 1; min-width: 140px; }
        .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 20px; }
        h1 { color: #111; font-size: 24px; margin: 0; }
        .modal-overlay { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); justify-content: center; align-items: center; z-index: 1000; }
        .modal-content { background: white; padding: 25px; border-radius: 12px; width: 90%; max-width: 380px; box-shadow: 0 4px 20px rgba(0,0,0,0.2); position: relative; }
        .close-btn { position: absolute; top: 12px; right: 15px; font-size: 24px; cursor: pointer; color: #aaa; border: none; background: none; }
        .form-group { margin-bottom: 15px; text-align: left; }
        .form-group label { display: block; font-weight: bold; margin-bottom: 5px; color: #333; font-size: 13px; }
        .form-group input { width: 100%; padding: 10px; border: 1px solid #ccc; border-radius: 6px; box-sizing: border-box; font-size: 14px; }
        .submit-btn { background: #25D366; color: white; border: none; padding: 12px; width: 100%; font-size: 16px; font-weight: bold; border-radius: 6px; cursor: pointer; margin-top: 10px; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header-bar">
          <h1>${escapeHtml(shopName)}</h1>
          <div class="nav-btns">
            <a href="https://wa.me/${botPhone}?text=Habari!%20Naomba%20msaada%20tafadhali" target="_blank" class="contact-btn">💬 Contact Us</a>
            <a href="${trackBtnUrl}" class="track-btn">🔍 Fuatilia Oda Yako</a>
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

      <div id="fullImgModal" onclick="closeImgModal()" style="display: none; position: fixed; z-index: 9999; left: 0; top: 0; width: 100%; height: 100%; background-color: rgba(0,0,0,0.9); justify-content: center; align-items: center; cursor: pointer; padding: 20px; box-sizing: border-box;">
        <span style="position: absolute; top: 15px; right: 25px; color: #fff; font-size: 35px; font-weight: bold;">&times;</span>
        <img id="lightboxImage" style="max-width: 95%; max-height: 85vh; border-radius: 8px; box-shadow: 0 4px 25px rgba(0,0,0,0.8); object-fit: contain;">
      </div>

      <div id="orderModal" class="modal-overlay">
        <div class="modal-content">
          <button class="close-btn" onclick="closeModal()">&times;</button>
          <h3 style="margin-top:0; color:#111; font-size:18px;" id="modalProductName">Agiza Bidhaa</h3>
          <p style="color:#28a745; font-weight:bold; margin-top:-5px; font-size:15px;" id="modalProductPrice"></p>
          <input type="hidden" id="selectedProductId">
          <input type="hidden" id="selectedProductName">
          <input type="hidden" id="selectedProductPrice">
          <div class="form-group">
            <label>Namba yako ya Simu (Phone Number):</label>
            <input type="text" id="orderPhone" placeholder="Mfano: 0712345678" required>
          </div>
          <div class="form-group">
            <label>Eneo Unapoishi / Mkoa (Location):</label>
            <input type="text" id="orderLocation" placeholder="Mfano: Dar es Salaam, Sinza" required>
          </div>
          <div class="form-group">
            <label>Size / Saizi (kama ipo):</label>
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
        if (currentStatus === 'Completed') statusBadge = '✅ Completed (Imeingizwa Na Kukamilika)';

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
        resultHtml = `
        <div style="background:white; padding:20px; border-radius:10px; box-shadow:0 2px 8px rgba(0,0,0,0.1); margin-top:20px;">
          <h3 style="margin:0 0 10px 0; color:#111;">Oda #${order.orderId}</h3>
          <p style="margin:5px 0;"><strong>📦 Bidhaa:</strong> ${escapeHtml(order.productName)}</p>
          <p style="margin:5px 0;"><strong>💰 Bei:</strong> TSh ${Number(order.sellingPrice || 0).toLocaleString()}</p>
          <p style="margin:5px 0;"><strong>📍 Eneo:</strong> ${escapeHtml(order.location)}</p>
          <p style="margin:10px 0; padding:8px 12px; background:#f0f0f0; border-radius:6px; display:inline-block; font-weight:bold;">Status: ${statusBadge}</p>
          ${reviewSection}
        </div>`;
      } else {
        resultHtml = `<div style="background:#f8d7da; color:#721c24; padding:12px; border-radius:6px; margin-top:20px; text-align:center;">❌ Hakuna Oda yenye Namba #${searchId}.</div>`;
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
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f4f6f8; margin: 0; padding: 20px; color: #333; }
        .container { max-width: 500px; margin: 0 auto; }
        h1 { text-align: center; color: #111; font-size: 24px; }
        .search-box { background: white; padding: 20px; border-radius: 10px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
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
            <label style="display:block; margin-bottom:6px; font-weight:600;">Weka Namba ya Oda (Order ID):</label>
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
  <html>
  <head>
    <title>Seller Login</title>
    <style>
      body { font-family: sans-serif; background: rgb(106, 136, 232); display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
      .login-box { background: white; padding: 40px; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); text-align: center; width: 300px; }
      input { padding: 10px; width: 100%; margin: 10px 0; border: 1px solid #4092e5; border-radius: 4px; box-sizing: border-box; }
      button { background: #28a745; color: white; border: none; padding: 10px 20px; border-radius: 4px; cursor: pointer; font-size: 16px; width: 100%; font-weight: bold; }
      a { color: #007bff; text-decoration: none; font-size: 13px; }
    </style>
  </head>
  <body>
    <div class="login-box">
      <h2>🛍️ Seller Login Portal </h2>
      <p>Enter your registered details</p>
      <form action="/login" method="POST">
        <label style="display:block; text-align:left; font-size:12px; font-weight:bold;">Namba ya Simu:</label>
        <input type="text" name="phone" placeholder="0712345678" required>
        <label style="display:block; text-align:left; font-size:12px; font-weight:bold;">Password:</label>
        <input type="password" name="password" placeholder="••••••••" required>
        <button type="submit">Ingia Dashboard</button>
      </form>
      <p style="margin-top: 15px;">
        <a href="/forgot-password">🔑 Umesahau Nenosiri? (Forgot Password)</a>
      </p>
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
      return res.send('❌ Tafadhali jaza namba ya simu na nywila (password). <br><a href="/login">Jaribu Tena</a>');
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

// Logout Handler
app.all('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) console.error('Session destruction error:', err);
    res.clearCookie('connect.sid'); 
    return res.redirect('/');
  });
});

// Admin Dashboard for Winga (Protected via Middleware)
app.get('/admin', requireWinga, async (req, res) => {
  try {
    const currentWinga = await db('wingas').where({ id: req.session.wingaId }).first();
    const botPhone = process.env.BOT_PHONE_NUMBER || '255678143403';

    if (currentWinga && currentWinga.status === 'suspended') {
      return res.send(`
      <div style="text-align:center; padding: 50px; font-family:sans-serif;">
        <h1 style="color: #dc3545;">⚠️ Akaunti Imesitishwa</h1>
        <p>Muda wako wa malipo umekwisha. Hauruhusiwi kuingiza bidhaa mpya au kuona oda zako.</p>
        <p>Tafadhali wasiliana na Admin (${botPhone}) na kufanya malipo ili kufunguliwa.</p>
        <a href="/logout" style="display:inline-block; margin-top:20px; padding:10px 20px; background:#007bff; color:white; text-decoration:none; border-radius:5px;">Rudi Kwenye Login</a>
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
          `<img src="${img}" onclick="openModal('${img}')" title="Bonyeza kukuza" style="width: 34px; height: 34px; object-fit: cover; border-radius: 4px; border: 1px solid #ccc; cursor: pointer; flex-shrink: 0;">`
        ).join('');
        productImgHtml = `<div style="display: flex; gap: 4px; flex-direction: row; align-items: center; max-width: 110px; overflow-x: auto; padding: 2px 0;">${thumbHtml}</div>`;
      }

      const safeName = escapeHtml(p.name);
      const safeCategory = escapeHtml(p.category || 'General');
      const safeSize = escapeHtml(p.size || 'Standard');
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
        <td>
          <div style="display: flex; gap: 4px;">
            <button type="button" 
              data-id="${p.id}" 
              data-name="${safeName}" 
              data-category="${safeCategory}" 
              data-buying="${buyingPrice}" 
              data-selling="${sellingPrice}" 
              data-size="${safeSize}" 
              onclick="handleEditClick(this)" 
              style="background:#ffc107; color:#000; border:none; padding:4px 8px; border-radius:4px; font-size:11px; cursor:pointer;">✏️ Edit</button>
            <form action="/admin/product/delete" method="POST" onsubmit="return confirm('Una uhakika unataka kufuta bidhaa hii?');" style="display:inline;">
              <input type="hidden" name="id" value="${p.id}">
              <button type="submit" style="background:#dc3545; color:white; border:none; padding:4px 8px; border-radius:4px; font-size:11px; cursor:pointer;">🗑️ Delete</button>
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

      const matchedProduct = products.find(p => parseInt(p.id) === parseInt(o.productId || 0) || (p.name && o.productName && p.name.trim().toLowerCase() === o.productName.trim().toLowerCase()));

      let productImgHtml = '📦';
      if (matchedProduct) {
        const images = getProductImages(matchedProduct);
        if (images.length > 0) {
          const thumbHtml = images.map(img => 
            `<img src="${img}" onclick="openModal('${img}')" title="Bonyeza kukuza" style="width: 34px; height: 34px; object-fit: cover; border-radius: 4px; border: 1px solid #ccc; cursor: pointer; flex-shrink: 0;">`
          ).join('');
          productImgHtml = `<div style="display: flex; gap: 4px; flex-direction: row; align-items: center; max-width: 110px; overflow-x: auto;">${thumbHtml}</div>`;
        }
      }
      let reviewCell = rev ? `${'⭐'.repeat(rev.rating)}<br><small>"${escapeHtml(rev.comment)}"</small>` : '<em style="color:#999;">Hamna feedback</em>';

      return `
      <tr>
        <td>${productImgHtml}</td>
        <td><strong>#${o.orderId}</strong></td>
        <td>${escapeHtml(o.productName)}</td>
        <td>TSh ${Number(o.sellingPrice || 0).toLocaleString()}</td>
        <td>${escapeHtml(o.location)}</td>
        <td>${escapeHtml(o.customerPhone)}</td>
        <td><span style="padding: 4px 8px; border-radius: 12px; font-size: 11px; font-weight: bold; ${badgeStyle}">${currentStatus}</span></td>
        <td>${reviewCell}</td>
        <td>
          <form action="/admin/order/status" method="POST" style="display:inline-flex; gap: 4px;">
            <input type="hidden" name="orderId" value="${o.orderId}">
            ${currentStatus !== 'Dispatched' && currentStatus !== 'Completed' ? `<button type="submit" name="status" value="Dispatched" style="background:#17a2b8; color:white; border:none; padding:4px 8px; border-radius:4px; font-size:11px; cursor:pointer;">🚚 Dispatch</button>` : ''}
            ${currentStatus !== 'Completed' ? `<button type="submit" name="status" value="Completed" style="background:#28a745; color:white; border:none; padding:4px 8px; border-radius:4px; font-size:11px; cursor:pointer;">✅ Complete</button>` : ''}
          </form>
        </td>
      </tr>`;
    }).join('');

    let alertMessage = '';
    if (req.query.added === 'true') {
      alertMessage = `
      <div style="background: #d4edda; color: #155724; border: 1px solid #c3e6cb; padding: 12px 15px; border-radius: 6px; margin-bottom: 20px; font-weight: bold; display: flex; justify-content: space-between; align-items: center;">
        <span>✅ Bidhaa mpya imefanikiwa kuongezwa na kuarifiwa kwa wateja wako!</span>
        <span onclick="this.parentElement.style.display='none'" style="cursor:pointer; font-size: 18px;">&times;</span>
      </div>`;
    } else if (req.query.error === 'upload') {
      alertMessage = `
      <div style="background: #f8d7da; color: #721c24; border: 1px solid #f5c6cb; padding: 12px 15px; border-radius: 6px; margin-bottom: 20px; font-weight: bold; display: flex; justify-content: space-between; align-items: center;">
        <span>❌ Hitilafu ya kupakia: Ruhusiwa kupakia picha pekee (max 4 files, 5MB max each).</span>
        <span onclick="this.parentElement.style.display='none'" style="cursor:pointer; font-size: 18px;">&times;</span>
      </div>`;
    }

    res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Seller Private Dashboard - ${escapeHtml(currentWingaName)}</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 0; padding: 20px; background: #f4f6f8; color: #333; }
        .container { max-width: 1100px; margin: 0 auto; }
        .top-nav { display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; flex-wrap: wrap; gap: 10px; }
        .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 15px; margin-bottom: 24px; }
        .stat-card { background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.05); }
        .stat-card h3 { margin: 0; font-size: 13px; color: #666; text-transform: uppercase; }
        .stat-card p { margin: 8px 0 0 0; font-size: 24px; font-weight: bold; color: #111; }
        .card { background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); margin-bottom: 24px; }
        h1, h2 { color: #111; margin-top: 0; }
        .form-group { margin-bottom: 15px; }
        .form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; }
        label { display: block; margin-bottom: 5px; font-weight: 600; }
        input[type="text"], input[type="number"], input[type="file"], input[type="password"] { width: 100%; padding: 10px; border: 1px solid #ccc; border-radius: 4px; box-sizing: border-box; }
        button.btn-add { background: #28a745; color: white; border: none; padding: 12px 20px; border-radius: 4px; font-weight: bold; cursor: pointer; width: 100%; }
        table { width: 100%; border-collapse: collapse; margin-top: 10px; }
        th, td { text-align: left; padding: 12px; border-bottom: 1px solid #eee; }
        th { background: #f8f9fa; }
        .contact-support { background: #25D366; color: white; border: none; padding: 8px 14px; border-radius: 6px; font-weight: bold; text-decoration: none; font-size: 13px; display: inline-flex; align-items: center; gap: 5px; }
      </style>
    </head>
    <body>
      <div class="container">
        ${alertMessage}
        <div class="top-nav">
          <h1>🛍️ Seller Private Dashboard - ${escapeHtml(currentWingaName)}</h1>
          <div>
            <a href="https://wa.me/${botPhone}?text=Habari%20Admin%20naomba%20msaada%20kuhusu%20duka%20langu" target="_blank" class="contact-support">💬 Contact Admin / Msaada</a>
            <a href="/logout" style="margin-left: 10px; color:#dc3545; font-weight:bold; text-decoration:none;">Logout</a>
          </div>
        </div>

        <div class="card">
          <h3>🔑 Badilisha Nenosiri (Change Password)</h3>
          <form id="changePasswordForm">
            <div class="form-group"><label>Nenosiri la Zamani:</label><input type="password" id="oldPassword" required></div>
            <div class="form-group"><label>Nenosiri Jipya:</label><input type="password" id="newPassword" required></div>
            <div class="form-group"><label>Rudia Nenosiri Jipya:</label><input type="password" id="confirmPassword" required></div>
            <button type="submit" style="background:#007bff; color:white; border:none; padding:10px 15px; border-radius:4px; font-weight:bold; cursor:pointer;">Hifadhi Nenosiri Jipya</button>
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
            } catch (err) {
              alert('❌ Hitilafu ya mtandao. Jaribu tena.');
            }
          });
        </script>

        <div style="background: #e3f2fd; padding: 15px; border-radius: 8px; border: 1px solid #90caf9; margin-bottom: 20px;">
          <h3 style="margin-top: 0; color: #0d47a1;">🔗 Link Yako ya Duka</h3>
          <input type="text" value="${BASE_URL}/catalog?shop=${currentWingaId}" readonly style="width: 100%; padding: 10px; border: 1px solid #90caf9; border-radius: 4px; font-weight: bold; color: #0d47a1; background: white;">
        </div>

        <div class="stats-grid">
          <div class="stat-card"><h3>Completed Orders</h3><p>${completedOrdersCount}</p></div>
          <div class="stat-card"><h3>Total Revenue</h3><p>TSh ${totalRevenue.toLocaleString()}</p></div>
          <div class="stat-card"><h3>Net Profit Earned</h3><p style="color:#28a745;">TSh ${netProfit.toLocaleString()}</p></div>
        </div>

        <div class="card">
          <h2>Add New Product </h2>
          <form action="/admin/add" method="POST" enctype="multipart/form-data">
            <div class="form-row">
              <div class="form-group"><label>Product Name</label><input type="text" name="name" required></div>
              <div class="form-group"><label>Category</label><input type="text" name="category" required></div>
            </div>
            <div class="form-row">
              <div class="form-group"><label>Buying Price / Cost (TSh)</label><input type="number" name="buyingPrice" required></div>
              <div class="form-group"><label>Selling Price (TSh)</label><input type="number" name="sellingPrice" required></div>
            </div>
            <div class="form-row">
              <div class="form-group"><label>Size</label><input type="text" name="size" value="Standard"></div>
              <div class="form-group">
                <label>Product Photos </label>
                <input type="file" id="imageInput" name="images" accept="image/*" multiple required onchange="validateImages(this)">
                <small id="fileCountNotice" style="color: #007bff; font-weight: bold; display: block; margin-top: 4px;"></small>
              </div>
            </div>
            <button type="submit" class="btn-add">Upload & Add to Catalog</button>
          </form>
        </div>

        <script>
          function validateImages(input) {
            const notice = document.getElementById('fileCountNotice');
            if (input.files.length > 4) {
              alert('❌ Umepitia kikomo! Unaruhusiwa kuchagua picha zisizozidi 4 pekee.');
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
          <table>
            <thead><tr><th>Photo</th><th>Order #</th><th>Product</th><th>Price</th><th>Location</th><th>Phone</th><th>Status</th><th>Customer Feedback</th><th>Update Status</th></tr></thead>
            <tbody>${orderRows || '<tr><td colspan="9">No orders placed yet.</td></tr>'}</tbody>
          </table>
        </div>

        <div class="card">
          <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px; margin-bottom:15px;">
            <h2 style="margin:0;">Product Catalog (${products.length})</h2>
            <input type="text" id="sellerSearchInput" onkeyup="filterSellerProducts()" placeholder="🔍 Tafuta bidhaa zako..." style="max-width:300px; padding:8px 12px; border:1px solid #ccc; border-radius:6px; font-size:14px;">
          </div>
          <table>
            <thead><tr><th>ID</th><th>Photos</th><th>Name</th><th>Category</th><th>Buying Price</th><th>Selling Price</th><th>Size</th><th>Action</th></tr></thead>
            <tbody id="sellerProductTable">${productRows || '<tr><td colspan="8">No products added yet.</td></tr>'}</tbody>
          </table>
        </div>

        <script>
          function filterSellerProducts() {
            var input = document.getElementById('sellerSearchInput').value.toLowerCase().trim();
            var rows = document.querySelectorAll('#sellerProductTable tr.seller-product-row');
            rows.forEach(function(row) {
              var name = row.querySelector('.prod-name').innerText.toLowerCase();
              var cat = row.querySelector('.prod-cat').innerText.toLowerCase();
              if (name.indexOf(input) !== -1 || cat.indexOf(input) !== -1) {
                row.style.display = '';
              } else {
                row.style.display = 'none';
              }
            });
          }
        </script>

        <div id="imgModal" onclick="closeModal()" style="display: none; position: fixed; z-index: 9999; left: 0; top: 0; width: 100%; height: 100%; background-color: rgba(0,0,0,0.85); justify-content: center; align-items: center; cursor: pointer;">
          <span style="position: absolute; top: 15px; right: 25px; color: #fff; font-size: 35px; font-weight: bold;">&times;</span>
          <img id="modalImage" style="max-width: 85%; max-height: 85%; border-radius: 8px; box-shadow: 0 4px 20px rgba(0,0,0,0.6); object-fit: contain;">
        </div>

        <script>
          function openModal(src) {
            const modal = document.getElementById('imgModal');
            const modalImg = document.getElementById('modalImage');
            modalImg.src = src;
            modal.style.display = 'flex';
          }
          function closeModal() {
            document.getElementById('imgModal').style.display = 'none';
          }
        </script>
      </div>

      <div id="editModal" style="display: none; position: fixed; z-index: 9999; left: 0; top: 0; width: 100%; height: 100%; background-color: rgba(0,0,0,0.6); justify-content: center; align-items: center;">
        <div style="background: #fff; padding: 20px; border-radius: 8px; width: 90%; max-width: 450px;">
          <h3>✏️ Rekebisha Bidhaa</h3>
          <form action="/admin/product/edit" method="POST">
            <input type="hidden" id="editId" name="id">
            <div style="margin-bottom: 8px;"><label>Jina:</label><input type="text" id="editName" name="name" style="width:100%; padding:6px;" required></div>
            <div style="margin-bottom: 8px;"><label>Kipengele (Category):</label><input type="text" id="editCategory" name="category" style="width:100%; padding:6px;" required></div>
            <div style="margin-bottom: 8px;"><label>Bei ya Kununua (TSh):</label><input type="number" id="editBuyingPrice" name="buyingPrice" style="width:100%; padding:6px;" required></div>
            <div style="margin-bottom: 8px;"><label>Bei ya Kuuzia (TSh):</label><input type="number" id="editSellingPrice" name="sellingPrice" style="width:100%; padding:6px;" required></div>
            <div style="margin-bottom: 12px;"><label>Saizi (Size):</label><input type="text" id="editSize" name="size" style="width:100%; padding:6px;"></div>
            <div style="display: flex; gap: 8px; justify-content: flex-end;">
              <button type="button" onclick="closeEditModal()" style="padding: 6px 12px; background: #6c757d; color: white; border: none; border-radius: 4px; cursor: pointer;">Achana</button>
              <button type="submit" style="padding: 6px 12px; background: #28a745; color: white; border: none; border-radius: 4px; cursor: pointer;">Hifadhi Mabadiliko</button>
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
        function closeEditModal() {
          document.getElementById('editModal').style.display = 'none';
        }
      </script>
    </body>
    </html>
    `);
  } catch (err) {
    console.error('Admin page error:', err);
    res.status(500).send('Hitilafu kwenye Server.');
  }
});

// Admin Add Product Route (Protected)
app.post('/admin/add', requireWinga, (req, res) => {
  upload(req, res, async (err) => {
    if (err) {
      console.error('Upload Security Check Failed:', err.message);
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

// Delete Product (Protected with Authorization Check)
app.post('/admin/product/delete', requireWinga, async (req, res) => {
  try {
    const { id } = req.body;
    await db('products')
      .where({ id: parseInt(id), wingaId: req.session.wingaId })
      .del();
  } catch (err) {
    console.error('❌ Error deleting product:', err);
  }
  res.redirect('/admin');
});

// Edit Product (Protected with Authorization Check)
app.post('/admin/product/edit', requireWinga, async (req, res) => {
  try {
    const { id, name, category, buyingPrice, sellingPrice, size } = req.body;
    await db('products')
      .where({ id: parseInt(id), wingaId: req.session.wingaId })
      .update({
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

// Order Status Update (Protected with Authorization Check)
app.post('/admin/order/status', requireWinga, async (req, res) => {
  try {
    const { orderId, status } = req.body;

    const order = await db('orders')
      .where({ orderId: parseInt(orderId), wingaId: req.session.wingaId })
      .first();

    if (order) {
      await db('orders')
        .where({ orderId: parseInt(orderId), wingaId: req.session.wingaId })
        .update({ status });

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
            `Habari! Oda yako imekamilika kuandaliwa na ipo njiani kuletwa kwako.\n\n` +
            `🔖 *Namba ya Oda:* #${order.orderId}\n` +
            `📦 *Bidhaa:* ${order.productName}\n` +
            `📍 *Hali ya Oda:* 🚚 Dispatched (Ipo Njiani)\n\n` +
            `🔗 *Fuatilia oda yako hapa kwa muda halisi:*\n${trackUrl}`;
        } else if (status === 'Completed') {
          statusMessage = 
            `✅ *ODA YAKO IMEMALIZIKA!* 🎉\n` +
            `-----------------------------------\n` +
            `Habari! Bidhaa yako kwenye Oda #${order.orderId} (${order.productName}) imewasilishwa na kukamilika.\n\n` +
            `⭐ *TAFADHALI TUPE FEEDBACK / MAONI YAKO:* ⭐\n` +
            `1️⃣ **Kupitia Wavuti:** Bonyeza hapa kuweka nyota na maoni:\n${trackUrl}\n\n` +
            `2️⃣ **Kupitia WhatsApp Hapa Hapa:** Jibu ujumbe huu kwa muundo huu:\n` +
            `*!maoni ${order.orderId} [nyota 1-5] [maoni yako]*\n\n` +
            `*Mfano:* !maoni ${order.orderId} 5 Bidhaa ni nzuri sana na huduma ni ya haraka!`;
        }

        if (statusMessage) {
          await client.sendMessage(customerChatId, statusMessage);
          console.log(`📲 Real-time status update (${status}) sent to customer JID: ${customerChatId}`);
        }
      }
    }
  } catch (err) {
    console.error('❌ Error sending status update to customer:', err);
  }

  res.redirect('/admin');
});

// Change Password Route (Protected)
app.post('/admin/change-password', requireWinga, async (req, res) => {
  const wingaId = req.session.wingaId;
  const { oldPassword, newPassword, confirmPassword } = req.body;

  if (!oldPassword || !newPassword || !confirmPassword) {
    return res.status(400).json({ success: false, message: 'Tafadhali jaza nafasi zote.' });
  }
  if (newPassword !== confirmPassword) {
    return res.status(400).json({ success: false, message: 'Nenosiri jipya na la kurudia hayafanani.' });
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ success: false, message: 'Nenosiri jipya lazima liwe na angalau herufi 6.' });
  }

  try {
    const winga = await db('wingas').where({ id: wingaId }).first();

    if (!winga) {
      return res.status(404).json({ success: false, message: 'Winga hakupatikana.' });
    }

    const isValidOld = await bcrypt.compare(oldPassword, winga.password);
    if (!isValidOld) {
      return res.status(400).json({ success: false, message: 'Nenosiri la zamani si sahihi.' });
    }

    const hashedNewPassword = await bcrypt.hash(newPassword, 10);
    await db('wingas').where({ id: wingaId }).update({ password: hashedNewPassword });

    return res.json({ success: true, message: '✅ Nenosiri limebadilishwa kikamilifu!' });
  } catch (err) {
    console.error('Password change error:', err);
    return res.status(500).json({ success: false, message: 'Hitilafu ya server imetokea.' });
  }
});

// ==========================================
// FORGOT & RESET PASSWORD ROUTES (WhatsApp OTP)
// ==========================================

// GET /forgot-password - Render Phone Input Form
app.get('/forgot-password', (req, res) => {
  res.send(`
  <!DOCTYPE html>
  <html>
  <head>
    <title>Umesahau Nenosiri - Seller Shop</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
      body { font-family: sans-serif; background: rgb(106, 136, 232); display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
      .box { background: white; padding: 30px; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); text-align: center; width: 90%; max-width: 360px; }
      input { padding: 10px; width: 100%; margin: 10px 0; border: 1px solid #4092e5; border-radius: 4px; box-sizing: border-box; }
      button { background: #007bff; color: white; border: none; padding: 12px; border-radius: 4px; cursor: pointer; font-size: 16px; font-weight: bold; width: 100%; margin-top: 10px; }
      a { color: #007bff; text-decoration: none; font-size: 14px; }
    </style>
  </head>
  <body>
    <div class="box">
      <h2>🔑 Umesahau Nenosiri?</h2>
      <p style="color:#666; font-size:14px;">Weka namba yako ya simu. Tutatuma kodi ya uhakiki (OTP) kwenye WhatsApp yako.</p>
      <form action="/forgot-password" method="POST">
        <input type="text" name="phone" placeholder="Mfano: 0712345678" required>
        <button type="submit">Tuma Kodi via WhatsApp</button>
      </form>
      <p style="margin-top:15px;"><a href="/login">← Rudi Kwenye Login</a></p>
    </div>
  </body>
  </html>
  `);
});

// POST /forgot-password - Generate OTP & Send via WhatsApp Bot
app.post('/forgot-password', async (req, res) => {
  try {
    if (!isWhatsappReady || !client || !client.pupPage) {
      isWhatsappReady = false;
      return res.status(503).send(
        '❌ Huduma ya WhatsApp kwa sasa haipo tayari (Bot Disconnected). Tafadhali subiri au scan QR code tena. <br><a href="/forgot-password">Rudi Nyuma</a>'
      );
    }

    const rawPhone = (req.body.phone || '').trim();
    if (!rawPhone) {
      return res.send('❌ Tafadhali jaza namba ya simu. <br><a href="/forgot-password">Jaribu Tena</a>');
    }

    let cleanedPhone = rawPhone.replace(/\D/g, '');
    if (cleanedPhone.startsWith('0')) {
      cleanedPhone = '255' + cleanedPhone.slice(1);
    }

    const winga = await db('wingas')
      .where({ phone: rawPhone })
      .orWhere({ phone: cleanedPhone })
      .first();

    if (!winga) {
      return res.send('❌ Namba hii haijasajiliwa kwenye mfumo. <br><a href="/forgot-password">Jaribu Tena</a>');
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await db('password_resets').where({ phone: winga.phone }).del();
    await db('password_resets').insert({ phone: winga.phone, otp, expiresAt });

    const targetJid = `${cleanedPhone}@c.us`;
    const otpMessage = 
      `🔑 *KODI YA KUBADILISHA NENOSIRI (PASSWORD RESET)*\n` +
      `-----------------------------------\n` +
      `Habari *${winga.name}*, kodi yako ya kubadilisha nenosiri ni:\n\n` +
      `👉 *${otp}*\n\n` +
      `⚠️ Kodi hii itaisha muda wake ndani ya dakika 10. Kama hukuomba mabadiliko haya, puzia ujumbe huu.`;

    await client.sendMessage(targetJid, otpMessage);

    res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Reset Password - Seller Shop</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        body { font-family: sans-serif; background: rgb(106, 136, 232); display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
        .box { background: white; padding: 30px; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); text-align: center; width: 90%; max-width: 360px; }
        input { padding: 10px; width: 100%; margin: 8px 0; border: 1px solid #4092e5; border-radius: 4px; box-sizing: border-box; }
        button { background: #28a745; color: white; border: none; padding: 12px; border-radius: 4px; cursor: pointer; font-size: 16px; font-weight: bold; width: 100%; margin-top: 10px; }
      </style>
    </head>
    <body>
      <div class="box">
        <h2>🔐 Weka Nenosiri Jipya</h2>
        <p style="color:#28a745; font-size:13px; font-weight:bold;">✅ Kodi ya OTP imetumwa kwenye WhatsApp yako (${escapeHtml(winga.phone)})</p>
        <form action="/reset-password" method="POST">
          <input type="hidden" name="phone" value="${escapeHtml(winga.phone)}">
          <input type="text" name="otp" placeholder="Ingiza Kodi ya OTP (Digit 6)" required>
          <input type="password" name="newPassword" placeholder="Nenosiri Jipya" required minlength="6">
          <input type="password" name="confirmPassword" placeholder="Rudia Nenosiri Jipya" required minlength="6">
          <button type="submit">Hifadhi Nenosiri Jipya</button>
        </form>
      </div>
    </body>
    </html>
    `);
  } catch (err) {
    console.error('CRITICAL ERROR sending OTP via WhatsApp:', err);
    if (err.message && err.message.includes('evaluate')) {
      isWhatsappReady = false;
    }
    res.status(500).send(`❌ Hitilafu imetokea wakati wa kutuma kodi: ${err.message}. Tafadhali jaribu tena baada ya sekunde chache.`);
  }
});

// POST /reset-password - Validate OTP & Update Password in DB
app.post('/reset-password', async (req, res) => {
  try {
    const { phone, otp, newPassword, confirmPassword } = req.body;

    if (!phone || !otp || !newPassword || !confirmPassword) {
      return res.send('❌ Tafadhali jaza nafasi zote. <br><a href="/forgot-password">Jaribu Tena</a>');
    }

    if (newPassword !== confirmPassword) {
      return res.send('❌ Nenosiri jipya na la kurudia hayafanani. <br><a href="/forgot-password">Jaribu Tena</a>');
    }

    if (newPassword.length < 6) {
      return res.send('❌ Nenosiri lazima liwe na angalau herufi 6. <br><a href="/forgot-password">Jaribu Tena</a>');
    }

    const resetRecord = await db('password_resets')
      .where({ phone: phone.trim(), otp: otp.trim() })
      .where('expiresAt', '>', new Date())
      .first();

    if (!resetRecord) {
      return res.send('❌ Kodi ya OTP si sahihi au imeisha muda wake (Expired). <br><a href="/forgot-password">Omba Kodi Mpya</a>');
    }

    const hashedPassword = await bcrypt.hash(newPassword.trim(), 10);
    await db('wingas').where({ phone: phone.trim() }).update({ password: hashedPassword });

    await db('password_resets').where({ phone: phone.trim() }).del();

    res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Mafanikio - Seller Shop</title>
      <style>
        body { font-family: sans-serif; background: rgb(106, 136, 232); display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
        .box { background: white; padding: 40px; border-radius: 8px; text-align: center; max-width: 380px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); }
        a { display: inline-block; margin-top: 15px; padding: 12px 24px; background: #28a745; color: white; text-decoration: none; border-radius: 4px; font-weight: bold; }
      </style>
    </head>
    <body>
      <div class="box">
        <h2 style="color:#28a745;">🎉 Hongera!</h2>
        <p>Nenosiri lako limebadilishwa kikamilifu. Sasa unaweza kuingia kwenye Dashboard yako.</p>
        <a href="/login">Ingia Dashboard (Login)</a>
      </div>
    </body>
    </html>
    `);
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).send('❌ Hitilafu ya Server.');
  }
});

// Super Admin Routes (Database Backed)
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
        ? `<span style="background:#28a745; color:white; padding:3px 8px; border-radius:12px; font-size:11px; font-weight:bold;">Active</span>`
        : `<span style="background:#dc3545; color:white; padding:3px 8px; border-radius:12px; font-size:11px; font-weight:bold;">Suspended</span>`;

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
          <div style="display:flex; gap:4px;">
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
            <form action="/superadmin/winga/reset-password" method="POST" style="display:inline-flex; gap:4px;">
              <input type="hidden" name="wingaId" value="${w.id}">
              <input type="password" name="newPassword" placeholder="New Pass" style="padding:2px 5px; width:80px; font-size:11px;" required>
              <button type="submit" style="background:#ffc107; color:black; border:none; padding:4px 6px; border-radius:4px; font-size:11px; cursor:pointer;">Reset</button>
            </form>
          </div>
        </td>
      </tr>`;
    }).join('');

    let superadminProductRows = products.map(p => {
      const matchedWinga = wingas.find(w => w.id === p.wingaId);
      const sellerName = matchedWinga ? matchedWinga.name : `Winga #${p.wingaId}`;
      const images = getProductImages(p);
      const mainImg = images[0] ? `<img src="${images[0]}" style="width: 38px; height: 38px; object-fit: cover; border-radius: 4px;">` : '📦';

      return `
      <tr class="super-prod-row">
        <td><strong>#${p.id}</strong></td>
        <td>${mainImg}</td>
        <td class="sprod-name">${escapeHtml(p.name)}</td>
        <td><strong>${escapeHtml(sellerName)}</strong></td>
        <td>${escapeHtml(p.category || 'General')}</td>
        <td>TSh ${Number(p.sellingPrice || 0).toLocaleString()}</td>
        <td>${p.dateAdded ? new Date(p.dateAdded).toLocaleDateString() : 'N/A'}</td>
        <td>
          <form action="/superadmin/product/delete" method="POST" onsubmit="return confirm('ADMIN WARNING: Are you sure you want to delete this product?');" style="display:inline;">
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
        <td>${rev.date ? new Date(rev.date).toLocaleDateString() : 'N/A'}</td>
      </tr>`;
    }).join('');

    res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Super Admin - Platform Manager</title>
      <style>
        body { font-family: sans-serif; background: #eef2f5; margin: 0; padding: 20px; color: #333; }
        .container { max-width: 1200px; margin: 0 auto; }
        .stats-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 15px; margin-bottom: 20px; }
        .stat-card { background: #1a1a1a; color: white; padding: 20px; border-radius: 8px; }
        .stat-card h3 { margin: 0 0 10px 0; font-size: 14px; color: #aaa; text-transform: uppercase; }
        .stat-card p { margin: 0; font-size: 24px; font-weight: bold; color: #4ade80; }
        .card { background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); margin-bottom: 20px; }
        table { width: 100%; border-collapse: collapse; margin-top: 10px; }
        th, td { text-align: left; padding: 12px; border-bottom: 1px solid #eee; }
        th { background: #f8f9fa; }
        button { background: #007bff; color: white; border: none; padding: 10px 15px; border-radius: 4px; cursor: pointer; }
        input { padding: 10px; border: 1px solid #ccc; border-radius: 4px; }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>👑 Platform Super Admin</h1>
        <a href="/logout" style="background: #ec0c22; color: white; padding: 8px 16px; border-radius: 6px; text-decoration: none; font-weight: bold; font-size: 14px; display: inline-block; margin-bottom: 15px;">🚪 Logout</a>
        <div class="stats-grid">
          <div class="stat-card"><h3>Total Wingas</h3><p style="color:white;">${wingas.length}</p></div>
          <div class="stat-card"><h3>Total Revenue</h3><p>TSh ${platformTotalRevenue.toLocaleString()}</p></div>
          <div class="stat-card"><h3>Total Profit</h3><p>TSh ${platformTotalProfit.toLocaleString()}</p></div>
        </div>
        <div class="card">
          <h2>➕ Register a New Winga</h2>
          <form action="/superadmin/add-winga" method="POST" style="display:flex; gap:10px;">
            <input type="text" name="name" placeholder="Winga/Business Name" required>
            <input type="text" name="phone" placeholder="Phone Number" required>
            <input type="password" name="password" placeholder="Initial Password (default: 123456)">
            <button type="submit">Register Winga</button>
          </form>
        </div>
        <div class="card">
          <h2>🏢 Wingas Performance Directory</h2>
          <table>
            <thead>
              <tr><th>ID</th><th>Winga Name</th><th>Phone</th><th>Status</th><th>Expires</th><th>Catalog</th><th>Orders</th><th>Total Profit</th><th>Actions</th></tr>
            </thead>
            <tbody>${wingaRows || '<tr><td colspan="9">No wingas registered yet.</td></tr>'}</tbody>
          </table>
        </div>

        <div class="card">
          <h2>💬 All Customer Reviews & Feedback (${reviews.length})</h2>
          <table>
            <thead>
              <tr><th>Order #</th><th>Shop/Winga</th><th>Product</th><th>Rating</th><th>Comment</th><th>Date</th></tr>
            </thead>
            <tbody>${superadminFeedbackRows || '<tr><td colspan="6">No customer reviews submitted yet.</td></tr>'}</tbody>
          </table>
        </div>

        <div class="card">
          <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px;">
            <h2>📦 Platform Product Moderation (${products.length} Total Items)</h2>
            <input type="text" id="superSearchInput" onkeyup="filterSuperadminProducts()" placeholder="🔍 Search all products by name..." style="padding:8px 12px; border:1px solid #ccc; border-radius:4px;">
          </div>
          <table>
            <thead>
              <tr><th>ID</th><th>Photo</th><th>Product Name</th><th>Seller Shop</th><th>Category</th><th>Price</th><th>Date Added</th><th>Action</th></tr>
            </thead>
            <tbody id="superadminProductTable">${superadminProductRows || '<tr><td colspan="8">No products uploaded across the platform.</td></tr>'}</tbody>
          </table>
        </div>

        <script>
          function filterSuperadminProducts() {
            var input = document.getElementById('superSearchInput').value.toLowerCase().trim();
            var rows = document.querySelectorAll('#superadminProductTable tr.super-prod-row');
            rows.forEach(function(row) {
              var name = row.querySelector('.sprod-name').innerText.toLowerCase();
              if (name.indexOf(input) !== -1) {
                row.style.display = '';
              } else {
                row.style.display = 'none';
              }
            });
          }
        </script>
      </div>
    </body>
    </html>
    `);
  } catch (err) {
    console.error('Superadmin view error:', err);
    res.status(500).send('Hitilafu kwenye Superadmin Portal.');
  }
});

app.post('/superadmin/product/delete', async (req, res) => {
  try {
    const { id } = req.body;
    await db('products').where({ id: parseInt(id) }).del();
  } catch (err) {
    console.error('❌ Error deleting product by Superadmin:', err);
  }
  res.redirect('/superadmin');
});

app.post('/superadmin/add-winga', async (req, res) => {
  try {
    const name = (req.body.name || '').trim();
    const phone = (req.body.phone || '').trim();
    const rawPassword = (req.body.password || '123456').trim();

    if (!name || !phone) {
      return res.send('❌ Tafadhali jaza jina na namba ya simu. <br><a href="/superadmin">Rudi</a>');
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

    res.redirect('/superadmin');
  } catch (err) {
    console.error('Add winga error:', err);
    res.send('❌ Impose: Phone number might already exist.');
  }
});

app.post('/superadmin/winga/status', async (req, res) => {
  try {
    const { wingaId, status } = req.body;
    await db('wingas').where({ id: parseInt(wingaId) }).update({ status });
  } catch (err) {
    console.error('Update winga status error:', err);
  }
  res.redirect('/superadmin');
});

app.post('/superadmin/winga/extend', async (req, res) => {
  try {
    const { wingaId } = req.body;
    const winga = await db('wingas').where({ id: parseInt(wingaId) }).first();

    if (winga) {
      const baseDate = (winga.expiryDate && new Date(winga.expiryDate) > new Date())
        ? new Date(winga.expiryDate)
        : new Date();
      baseDate.setDate(baseDate.getDate() + 30);

      await db('wingas').where({ id: parseInt(wingaId) }).update({
        expiryDate: baseDate,
        status: 'active'
      });
    }
  } catch (err) {
    console.error('Extend winga error:', err);
  }
  res.redirect('/superadmin');
});

// POST /superadmin/winga/reset-password - Admin Override
app.post('/superadmin/winga/reset-password', async (req, res) => {
  try {
    const { wingaId, newPassword } = req.body;
    if (!wingaId || !newPassword) return res.redirect('/superadmin');

    const hashedPassword = await bcrypt.hash(newPassword.trim(), 10);
    await db('wingas').where({ id: parseInt(wingaId) }).update({ password: hashedPassword });
  } catch (err) {
    console.error('Superadmin reset password error:', err);
  }
  res.redirect('/superadmin');
});

// WhatsApp Bot Client Lifecycle Event Listeners
client.on('qr', (qr) => {
  console.log('⚡ Scan this QR Code with WhatsApp:');
  qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
  console.log('✅ Winga WhatsApp Bot is connected and live!');
  isWhatsappReady = true;
});

client.on('authenticated', () => {
  console.log('🔒 WhatsApp client authenticated');
});

client.on('auth_failure', (msg) => {
  console.error('❌ WhatsApp authentication failure:', msg);
  isWhatsappReady = false;
});

client.on('disconnected', (reason) => {
  console.warn('⚠️ WhatsApp client disconnected:', reason);
  isWhatsappReady = false;
  client.initialize();
});

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
        try {
          await client.sendMessage(chatId, `⚠️ *AKAUNTI IMESITISHWA*\n\nNdugu ${w.name}, muda wako wa malipo umekwisha.`);
        } catch (err) { console.error('Notification failed:', w.phone); }
      } else if (daysLeft === 3 && w.status === 'active') {
        try {
          await client.sendMessage(chatId, `🔔 *KUMBUSHO LA MALIPO*\n\nNdugu ${w.name}, akaunti yako itasitishwa ndani ya siku 3.`);
        } catch (err) { console.error('Notification failed:', w.phone); }
      }
    }
  } catch (cronErr) {
    console.error('Cron Job Execution Error:', cronErr);
  }
});

// Bot Message Processing
client.on('message', async (msg) => {
  try {
    const text = (msg.body || '').trim();
    const lowerText = text.toLowerCase();

    // 1. WhatsApp Instant Review/Feedback Handler (!maoni)
    if (lowerText.startsWith('!maoni')) {
      const parts = text.split(/\s+/);
      const orderId = parseInt(parts[1]);
      const rating = parseInt(parts[2]);
      const comment = parts.slice(3).join(' ');

      if (!orderId || isNaN(rating) || rating < 1 || rating > 5 || !comment) {
        await msg.reply('❌ Muundo sio sahihi.\n\nTumia muundo huu:\n*!maoni [NambaYaOda] [Nyota 1-5] [Maoni yako]*\n\nMfano:\n*!maoni 1 5 Nguo ni nzuri sana!*');
        return;
      }

      const orderExists = await db('orders').where({ orderId }).first();

      if (!orderExists) {
        await msg.reply(`❌ Haikuwezekana kupata Oda #${orderId}. Tafadhali hakikisha namba ya oda ni sahihi.`);
        return;
      }

      const existingReview = await db('reviews').where({ orderId }).first();
      if (existingReview) {
        await db('reviews').where({ orderId }).update({
          rating,
          comment: comment.trim(),
          date: new Date()
        });
      } else {
        await db('reviews').insert({
          orderId,
          rating,
          comment: comment.trim(),
          date: new Date()
        });
      }

      await msg.reply(`🎉 *AHSANTE SANA KWA FEEDBACK YAKO!* ⭐\n\nTumepokea tathmini yako ya nyota ${'⭐'.repeat(rating)} kwa Oda #${orderId}.\nMaoni yako yamesaidia sana kuboresha huduma zetu!`);
      return;
    }

    // 2. Order Command (!agiza / !order)
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
        const firstLine = lines[0].trim();
        const parts = firstLine.split(/\s+/);
        if (parts[1]) productID = parseInt(parts[1]);

        for (let line of lines) {
          const trimmed = line.trim();
          const lower = trimmed.toLowerCase();
          if (lower.includes('simu:')) {
            const extractedPhone = trimmed.split(/simu:/i)[1].trim();
            if (extractedPhone && extractedPhone !== 'haikutajwa') phone = extractedPhone;
          }
          if (lower.includes('eneo:')) {
            const extractedLocation = trimmed.split(/eneo:/i)[1].trim();
            if (extractedLocation && extractedLocation !== 'haikutajwa') location = extractedLocation;
          }
        }
      }

      const product = await db('products').where({ id: productID }).first();
      if (!product) {
        await msg.reply(`❌ Bidhaa #${productID} haipo.`);
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
        `📍 *Eneo:* ${location}\n` +
        `📌 *Status:* 🟡 Pending\n\n` +
        `📍 *Fuatilia Oda Yako Hapa:*\n${trackUrl}`
      );

      notifyWinga(newOrder, product);
      return;
    }

    // 3. Greeting Keywords
    const greetingKeywords = ['hi', 'hello', 'vp', 'habari', 'mambo', 'catalog', 'katalogi', 'katalog', '1', 'nguo', 'hey', 'niaje'];
    const isGreeting = greetingKeywords.some(keyword => lowerText === keyword || lowerText.startsWith(keyword + ' '));
    if (isGreeting) {
      const catalogUrl = `${BASE_URL}/catalog`;
      await msg.reply(`Karibu WingaShop! 👋\n\nTazama na utafute nguo zetu hapa:\n${catalogUrl}`);
      return;
    }
  } catch (err) {
    console.error('Handler error:', err);
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Server active on ${BASE_URL}`);
});

client.initialize();