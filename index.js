require('dotenv').config();
const express = require('express');
const session = require('express-session');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const basicAuth = require('express-basic-auth');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

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

// Multer Storage Configuration (Strict MIME Type Filtering)
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

// Authentication Guard Middleware for Winga
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

// Helper: Format phone number for WhatsApp (e.g. 0712... -> 255712...)
function formatPhoneForWhatsApp(phone) {
  if (!phone) return '';
  let p = phone.trim().replace(/[^0-9]/g, '');
  if (p.startsWith('0')) {
    p = '255' + p.slice(1);
  }
  return p;
}

// Landing Page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// API Route: Save Order to Database and Return Direct Winga WhatsApp Link
app.post('/api/orders', async (req, res) => {
  try {
    const { wingaId, productId, productName, sellingPrice, customerPhone, location, size, quantity, sellerPhoneFallback } = req.body;
    
    const parsedWingaId = parseInt(wingaId) || 1;
    const [orderId] = await db('orders').insert({
      wingaId: parsedWingaId,
      productId: productId || null,
      productName: productName || 'Bidhaa',
      sellingPrice: Number(sellingPrice) || 0,
      customerPhone: customerPhone || 'Haikutajwa',
      location: location || 'Haikutajwa',
      size: size || 'Haikutajwa',
      quantity: parseInt(quantity) || 1,
      status: 'Pending',
      date: new Date()
    });

    // Tafuta taarifa za Winga (Muuzaji)
    const winga = await db('wingas').where({ id: parsedWingaId }).first();
    let targetSellerPhone = '';

    if (winga && winga.phone && winga.phone.trim() !== '') {
      targetSellerPhone = formatPhoneForWhatsApp(winga.phone);
    } else if (sellerPhoneFallback) {
      targetSellerPhone = formatPhoneForWhatsApp(sellerPhoneFallback);
    } else {
      targetSellerPhone = process.env.BOT_PHONE_NUMBER || '255678143403';
    }

    const message = `🛍️ *ODA MPYA KUTOKA WINGA-HUB* (#WGA-${orderId})\n` +
                    `-----------------------------------\n` +
                    `📦 *Bidhaa:* ${productName}\n` +
                    `💰 *Bei:* TSh ${Number(sellingPrice).toLocaleString()}\n` +
                    `🔢 *Idadi:* ${quantity || 1}\n` +
                    `📏 *Saizi:* ${size || 'Haikutajwa'}\n` +
                    `📞 *Namba ya Mteja:* ${customerPhone}\n` +
                    `📍 *Eneo la Mteja:* ${location}\n\n` +
                    `Tafadhali thibitisha oda hii. Asante!`;

    const whatsappUrl = `https://wa.me/${targetSellerPhone}?text=` + encodeURIComponent(message);

    res.json({ success: true, orderId, whatsappUrl });
  } catch (err) {
    console.error('API Order Error:', err);
    res.status(500).json({ success: false, error: 'Imeshindwa kuhifadhi oda kwenye mfumo.' });
  }
});

// LocalStorage Sync Endpoint
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

// Public Catalog Route (Database Backed with Click-to-Chat Integration)
app.get('/catalog', async (req, res) => {
  try {
    try {
      await db('stats').where({ key: 'catalogVisits' }).increment('value', 1);
    } catch (e) {}

    const allProducts = await db('products').select('*');
    const wingas = await db('wingas').select('*');
    const shopId = req.query.shop;
    let products = allProducts;
    let shopName = "Soko Letu (All Shops)";
    let currentWingaPhone = '';
    let currentWingaId = shopId || '';

    if (shopId) {
      products = allProducts.filter(p => p.wingaId === parseInt(shopId));
      const matchedWinga = wingas.find(w => w.id === parseInt(shopId));
      if (matchedWinga) {
        shopName = `🛍️ Duka la ${matchedWinga.name}`;
        if (matchedWinga.phone) {
          currentWingaPhone = formatPhoneForWhatsApp(matchedWinga.phone);
        }
      } else {
        shopName = "⚠️ Duka halipatikani";
        products = [];
      }
    }

    const trackBtnUrl = shopId ? `/track?shop=${shopId}` : '/track';
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
      const sellerPhone = matchedWinga && matchedWinga.phone ? formatPhoneForWhatsApp(matchedWinga.phone) : currentWingaPhone;

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
          data-wingaid="${p.wingaId}"
          data-name="${escapeHtml(p.name)}" 
          data-price="${sellingPrice}"
          data-priceformatted="${priceFormatted}"
          data-sellerphone="${sellerPhone}"
          data-sellername="${escapeHtml(sellerName)}"
          onclick="handleOrderClick(this)" 
          style="background: #25D366; color: white; padding: 10px 15px; border: none; border-radius: 6px; font-weight: bold; cursor: pointer; font-size: 14px; width: 100%;">
          🛒 Agiza Kupitia WhatsApp
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
            ${currentWingaPhone ? `<a href="https://wa.me/${currentWingaPhone}?text=Habari!%20Naomba%20msaada%20tafadhali" target="_blank" class="contact-btn">💬 Wasiliana Nasi</a>` : ''}
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
          <input type="hidden" id="selectedWingaId" value="${currentWingaId}">
          <input type="hidden" id="selectedProductName">
          <input type="hidden" id="selectedProductPrice">
          <input type="hidden" id="selectedSellerPhone">
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
          <button class="submit-btn" onclick="submitOrderToDatabase()">📲 Tuma Oda kwa WhatsApp</button>
        </div>
      </div>

      <script>
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
          var wingaId = btn.getAttribute('data-wingaid');
          var name = btn.getAttribute('data-name');
          var price = btn.getAttribute('data-price');
          var priceFormatted = btn.getAttribute('data-priceformatted');
          var sellerPhone = btn.getAttribute('data-sellerphone');
          openModal(id, wingaId, name, price, priceFormatted, sellerPhone);
        }

        function openModal(id, wingaId, name, price, priceFormatted, sellerPhone) {
          document.getElementById('selectedProductId').value = id;
          document.getElementById('selectedWingaId').value = wingaId;
          document.getElementById('selectedProductName').value = name;
          document.getElementById('selectedProductPrice').value = price;
          document.getElementById('selectedSellerPhone').value = sellerPhone || '';
          document.getElementById('modalProductName').innerText = '🛒 ' + name;
          document.getElementById('modalProductPrice').innerText = 'Bei: TSh ' + priceFormatted;
          document.getElementById('orderModal').style.display = 'flex';
        }

        function closeModal() {
          document.getElementById('orderModal').style.display = 'none';
        }

        async function submitOrderToDatabase() {
          var productId = document.getElementById('selectedProductId').value;
          var wingaId = document.getElementById('selectedWingaId').value;
          var productName = document.getElementById('selectedProductName').value;
          var sellingPrice = document.getElementById('selectedProductPrice').value;
          var sellerPhoneFallback = document.getElementById('selectedSellerPhone').value;
          var customerPhone = document.getElementById('orderPhone').value.trim();
          var location = document.getElementById('orderLocation').value.trim();
          var size = document.getElementById('orderSize').value.trim();
          var quantity = document.getElementById('orderQty').value;

          if (!customerPhone || !location) {
            alert('Tafadhali jaza namba yako ya simu na eneo unaloishi.');
            return;
          }

          try {
            const response = await fetch('/api/orders', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ 
                wingaId, 
                productId, 
                productName, 
                sellingPrice, 
                customerPhone, 
                location, 
                size, 
                quantity,
                sellerPhoneFallback 
              })
            });
            const data = await response.json();
            if (data.success && data.whatsappUrl) {
              closeModal();
              window.open(data.whatsappUrl, '_blank');
            } else {
              alert('Hitilafu: ' + (data.error || 'Imeshindwa kusave oda.'));
            }
          } catch (err) {
            console.error(err);
            alert('Hitilafu ya mtandao imetokea.');
          }
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

// Order Tracking Routes
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

// Winga Registration Routes
app.get('/register', (req, res) => {
  res.send(`
  <!DOCTYPE html>
  <html>
  <head>
    <title>Winga Register</title>
    <style>
      body { font-family: sans-serif; background: rgb(106, 136, 232); display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
      .box { background: white; padding: 30px; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); width: 320px; }
      input { padding: 10px; width: 100%; margin: 8px 0 15px 0; border: 1px solid #ccc; border-radius: 4px; box-sizing: border-box; }
      button { background: #28a745; color: white; border: none; padding: 10px; border-radius: 4px; cursor: pointer; font-size: 15px; width: 100%; font-weight: bold; }
      a { color: #007bff; text-decoration: none; font-size: 13px; display: block; text-align: center; margin-top: 15px; }
    </style>
  </head>
  <body>
    <div class="box">
      <h2>📝 Jisajili Kama Winga</h2>
      <form action="/register" method="POST">
        <label style="font-size:12px; font-weight:bold;">Jina la Duka (Shop Name):</label>
        <input type="text" name="name" required>
        <label style="font-size:12px; font-weight:bold;">Namba ya WhatsApp:</label>
        <input type="text" name="phone" placeholder="0712345678" required>
        <label style="font-size:12px; font-weight:bold;">Nenosiri (Password):</label>
        <input type="password" name="password" required>
        <button type="submit">Jisajili Sasa</button>
      </form>
      <a href="/login">Tayari una akaunti? Ingia hapa</a>
    </div>
  </body>
  </html>
  `);
});

app.post('/register', async (req, res) => {
  try {
    const { name, phone, password } = req.body;
    const hashedPassword = bcrypt.hashSync(password, 10);

    await db('wingas').insert({
      name: name.trim(),
      phone: phone.trim(),
      password: hashedPassword,
      createdAt: new Date()
    });

    res.send(`<script>alert('Usajili umefanikiwa! Tafadhali ingia.'); window.location.href='/login';</script>`);
  } catch (err) {
    console.error('Register error:', err);
    res.send(`<script>alert('Namba ya simu imeshatumika au kuna hitilafu.'); window.location.href='/register';</script>`);
  }
});

// Winga Login Routes
app.get('/login', (req, res) => {
  res.send(`
  <!DOCTYPE html>
  <html>
  <head>
    <title>Winga Login</title>
    <style>
      body { font-family: sans-serif; background: rgb(106, 136, 232); display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
      .login-box { background: white; padding: 40px; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); text-align: center; width: 300px; }
      input { padding: 10px; width: 100%; margin: 10px 0; border: 1px solid #4092e5; border-radius: 4px; box-sizing: border-box; }
      button { background: #28a745; color: white; border: none; padding: 10px 20px; border-radius: 4px; cursor: pointer; font-size: 16px; width: 100%; font-weight: bold; }
      a { color: #007bff; text-decoration: none; font-size: 13px; display: block; margin-top: 10px; }
    </style>
  </head>
  <body>
    <div class="login-box">
      <h2>🛍️ Winga Portal Login</h2>
      <form action="/login" method="POST">
        <label style="display:block; text-align:left; font-size:12px; font-weight:bold;">Namba ya Simu:</label>
        <input type="text" name="phone" placeholder="0712345678" required>
        <label style="display:block; text-align:left; font-size:12px; font-weight:bold;">Password:</label>
        <input type="password" name="password" placeholder="••••••••" required>
        <button type="submit">Ingia Dashboard</button>
      </form>
      <a href="/register">Huna akaunti? Jisajili hapa</a>
      <a href="/forgot-password">Umesahau nenosiri?</a>
    </div>
  </body>
  </html>
  `);
});

app.post('/login', async (req, res) => {
  try {
    const phone = (req.body.phone || '').trim();
    const password = req.body.password || '';

    const winga = await db('wingas').where({ phone }).first();
    if (!winga) {
      return res.send(`<script>alert('Namba ya simu haikupatikana!'); window.location.href='/login';</script>`);
    }

    const isMatch = bcrypt.compareSync(password, winga.password);
    if (!isMatch) {
      return res.send(`<script>alert('Nenosiri si sahihi!'); window.location.href='/login';</script>`);
    }

    req.session.wingaId = winga.id;
    req.session.wingaName = winga.name;
    res.redirect('/admin');
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).send('Hitilafu kwenye mfumo wa kuingia.');
  }
});

// Forgot Password Route (Direct Reset without Bot)
app.get('/forgot-password', (req, res) => {
  res.send(`
  <!DOCTYPE html>
  <html>
  <head><title>Reset Password</title>
  <style>body { font-family: sans-serif; background: #f4f6f8; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
  .box { background: white; padding: 30px; border-radius: 8px; width: 300px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
  input { width: 100%; padding: 10px; margin: 10px 0; border: 1px solid #ccc; border-radius: 4px; box-sizing: border-box; }
  button { width: 100%; background: #28a745; color: white; border: none; padding: 10px; font-weight: bold; border-radius: 4px; cursor: pointer; }</style>
  </head>
  <body>
    <div class="box">
      <h3>🔑 Weka Nenosiri Jipya</h3>
      <p style="font-size: 12px; color: #666;">Ingiza namba yako ya simu na nenosiri jipya ili kubadilisha mara moja.</p>
      <form action="/forgot-password" method="POST">
        <label style="font-size:12px; font-weight:bold;">Namba yako ya Simu:</label>
        <input type="text" name="phone" placeholder="0712345678" required>
        <label style="font-size:12px; font-weight:bold;">Nenosiri Jipya:</label>
        <input type="password" name="newPassword" placeholder="••••••••" required>
        <button type="submit">Badilisha Nenosiri</button>
      </form>
      <a href="/login" style="display:block; text-align:center; margin-top:15px; text-decoration:none; color:#007bff; font-size:13px;">Rudi kwenye Login</a>
    </div>
  </body>
  </html>
  `);
});

app.post('/forgot-password', async (req, res) => {
  try {
    const { phone, newPassword } = req.body;
    const hashedPassword = bcrypt.hashSync(newPassword, 10);
    const affected = await db('wingas').where({ phone: phone.trim() }).update({ password: hashedPassword });
    if (affected) {
      res.send(`<script>alert('Nenosiri limebadilishwa kikamilifu!'); window.location.href='/login';</script>`);
    } else {
      res.send(`<script>alert('Namba ya simu haikupatikana kwenye mfumo.'); window.location.href='/forgot-password';</script>`);
    }
  } catch (err) {
    console.error('Forgot password error:', err);
    res.status(500).send('Hitilafu imetokea.');
  }
});

// Winga Admin Dashboard Route
app.get('/admin', requireWinga, async (req, res) => {
  try {
    const wingaId = req.session.wingaId;
    const winga = await db('wingas').where({ id: wingaId }).first();
    const products = await db('products').where({ wingaId });
    const orders = await db('orders').where({ wingaId }).orderBy('orderId', 'desc');

    let productRows = products.map(p => `
      <tr>
        <td>${p.id}</td>
        <td>${escapeHtml(p.name)}</td>
        <td>TSh ${Number(p.sellingPrice || p.price || 0).toLocaleString()}</td>
        <td>${escapeHtml(p.category || 'General')}</td>
        <td>
          <form action="/admin/products/${p.id}/delete" method="POST" onsubmit="return confirm('Una uhakika unataka kufuta bidhaa hii?');" style="display:inline;">
            <button type="submit" style="background:#dc3545; color:white; border:none; padding:5px 10px; border-radius:4px; cursor:pointer;">Futa</button>
          </form>
        </td>
      </tr>
    `).join('');

    let orderRows = orders.map(o => `
      <tr>
        <td>#${o.orderId}</td>
        <td>${escapeHtml(o.productName || 'Bidhaa')}</td>
        <td>TSh ${Number(o.sellingPrice || 0).toLocaleString()}</td>
        <td>${escapeHtml(o.customerPhone || 'Haikutajwa')} (${escapeHtml(o.location || '')})</td>
        <td><strong>${o.status || 'Pending'}</strong></td>
        <td>
          <form action="/admin/orders/${o.orderId}/status" method="POST" style="display:inline;">
            <select name="status" onchange="this.form.submit()" style="padding:4px; border-radius:4px;">
              <option value="Pending" ${o.status === 'Pending' ? 'selected' : ''}>Pending</option>
              <option value="Dispatched" ${o.status === 'Dispatched' ? 'selected' : ''}>Dispatched</option>
              <option value="Completed" ${o.status === 'Completed' ? 'selected' : ''}>Completed</option>
            </select>
          </form>
        </td>
      </tr>
    `).join('');

    res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Winga Dashboard - ${escapeHtml(winga.name)}</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        body { font-family: sans-serif; background: #f4f6f8; margin: 0; padding: 20px; color: #333; }
        .container { max-width: 900px; margin: 0 auto; background: white; padding: 25px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.08); }
        .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #eee; padding-bottom: 15px; margin-bottom: 20px; }
        table { width: 100%; border-collapse: collapse; margin-top: 15px; margin-bottom: 30px; }
        th, td { border: 1px solid #ddd; padding: 10px; text-align: left; font-size: 14px; }
        th { background: #f8f9fa; }
        .form-box { background: #fdfdfd; border: 1px solid #ddd; padding: 15px; border-radius: 6px; margin-bottom: 25px; }
        input, select { padding: 8px; width: 100%; margin: 6px 0 12px 0; border: 1px solid #ccc; border-radius: 4px; box-sizing: border-box; }
        button.btn-primary { background: #007bff; color: white; border: none; padding: 10px 15px; border-radius: 4px; font-weight: bold; cursor: pointer; }
        .logout-btn { background: #dc3545; color: white; padding: 8px 12px; border-radius: 4px; text-decoration: none; font-size: 13px; font-weight: bold; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h2>🏪 Duka la: ${escapeHtml(winga.name)}</h2>
          <a href="/logout" class="logout-btn">🚪 Toka (Logout)</a>
        </div>

        <h3>📦 Weka Bidhaa Mpya</h3>
        <div class="form-box">
          <form action="/admin/products" method="POST" enctype="multipart/form-data">
            <label>Jina la Bidhaa:</label>
            <input type="text" name="name" required>
            <label>Bei ya Kuuzia (TSh):</label>
            <input type="number" name="sellingPrice" required>
            <label>Aina (Category):</label>
            <input type="text" name="category" placeholder="Mfano: Viatu, Nguo, Simu">
            <label>Picha za Bidhaa (Hadi 4):</label>
            <input type="file" name="images" multiple accept="image/*">
            <button type="submit" class="btn-primary">Weka Bidhaa Sokoni</button>
          </form>
        </div>

        <h3>📋 Orodha ya Bidhaa Zako (${products.length})</h3>
        <table>
          <tr><th>ID</th><th>Jina</th><th>Bei</th><th>Category</th><th>Vitendo</th></tr>
          ${productRows || '<tr><td colspan="5" style="text-align:center;">Huna bidhaa kwa sasa.</td></tr>'}
        </table>

        <h3>🛒 Oda Zilizopokelewa (${orders.length})</h3>
        <table>
          <tr><th>Oda #</th><th>Bidhaa</th><th>Bei</th><th>Mteja & Eneo</th><th>Status</th><th>Badilisha Status</th></tr>
          ${orderRows || '<tr><td colspan="6" style="text-align:center;">Hakuna oda bado.</td></tr>'}
        </table>
        <p><a href="/catalog?shop=${winga.id}" target="_blank" class="btn-primary" style="text-decoration:none; display:inline-block;">🔗 Tembelea Duka Lako (Catalog)</a></p>
      </div>
    </body>
    </html>
    `);
  } catch (err) {
    console.error('Admin dashboard error:', err);
    res.status(500).send('Hitilafu kwenye dashboard.');
  }
});

// Admin Actions
app.post('/admin/products', requireWinga, upload, async (req, res) => {
  try {
    const { name, sellingPrice, category } = req.body;
    const wingaId = req.session.wingaId;

    let imagePaths = [];
    if (req.files && req.files.length > 0) {
      imagePaths = req.files.map(f => `/uploads/${f.filename}`);
    }

    await db('products').insert({
      wingaId,
      name,
      category: category || 'General',
      buyingPrice: 0,
      sellingPrice: Number(sellingPrice),
      price: Number(sellingPrice),
      imageUrl: JSON.stringify(imagePaths)
    });

    res.redirect('/admin');
  } catch (err) {
    console.error('Add product error:', err);
    res.status(500).send('Imeshindwa kuongeza bidhaa.');
  }
});

app.post('/admin/products/:id/delete', requireWinga, async (req, res) => {
  try {
    const productId = req.params.id;
    const wingaId = req.session.wingaId;
    await db('products').where({ id: productId, wingaId }).del();
    res.redirect('/admin');
  } catch (err) {
    console.error('Delete product error:', err);
    res.status(500).send('Imeshindwa kufuta bidhaa.');
  }
});

app.post('/admin/orders/:id/status', requireWinga, async (req, res) => {
  try {
    const orderId = req.params.id;
    const { status } = req.body;
    const wingaId = req.session.wingaId;

    await db('orders').where({ orderId, wingaId }).update({ status });
    res.redirect('/admin');
  } catch (err) {
    console.error('Update order status error:', err);
    res.redirect('/admin');
  }
});

// Superadmin Dashboard Route
app.get('/superadmin', async (req, res) => {
  try {
    const wingas = await db('wingas').select('*');
    const orders = await db('orders').select('*');

    let wingaRows = wingas.map(w => `
      <tr>
        <td>${w.id}</td>
        <td>${escapeHtml(w.name)}</td>
        <td>${escapeHtml(w.phone)}</td>
        <td>${w.createdAt || 'N/A'}</td>
      </tr>
    `).join('');

    res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Superadmin Panel</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        body { font-family: sans-serif; background: #f4f6f8; margin: 0; padding: 20px; color: #333; }
        .container { max-width: 950px; margin: 0 auto; background: white; padding: 25px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.08); }
        h2 { color: #d9534f; margin-top: 0; }
        table { width: 100%; border-collapse: collapse; margin-top: 15px; margin-bottom: 30px; }
        th, td { border: 1px solid #ddd; padding: 10px; text-align: left; font-size: 14px; }
        th { background: #f8f9fa; }
      </style>
    </head>
    <body>
      <div class="container">
        <h2>👑 Superadmin Control Panel</h2>
        <p>Jumla ya Mawinga Waliosajiliwa: <strong>${wingas.length}</strong> | Jumla ya Oda Zote: <strong>${orders.length}</strong></p>
        
        <h3>Orodha ya Mawinga (Shops)</h3>
        <table>
          <tr><th>ID</th><th>Jina la Duka</th><th>Simu</th><th>Tarehe ya Usajili</th></tr>
          ${wingaRows || '<tr><td colspan="4" style="text-align:center;">Hakuna winga bado.</td></tr>'}
        </table>
        <p><a href="/catalog" target="_blank" style="color: #007bff; text-decoration: none; font-weight: bold;">🔗 Tembelea Soko Kuu (Catalog)</a></p>
      </div>
    </body>
    </html>
    `);
  } catch (err) {
    console.error('Superadmin error:', err);
    res.status(500).send('Hitilafu kwenye Superadmin panel.');
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

// Anzisha Server ya Express
const PORT_NUM = process.env.PORT || 3000;
app.listen(PORT_NUM, async () => {
  try {
    await db.raw('SELECT 1');
    console.log('✅ Database initialized successfully.');
    console.log(`🌐 Server active on http://localhost:${PORT_NUM}`);
  } catch (err) {
    console.error('❌ Database connection failed:', err);
  }
});