require('dotenv').config();
const express = require('express');
const session = require('express-session');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const basicAuth = require('express-basic-auth');
const qrcode = require('qrcode-terminal');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// Global WhatsApp Socket Instance
let sock = null;
let isWhatsappReady = false;

// Initialize Baileys WhatsApp Connection
async function connectToWhatsApp() {
  const authFolder = path.join(__dirname, 'auth_info_baileys');
  if (!fs.existsSync(authFolder)) {
    fs.mkdirSync(authFolder, { recursive: true });
  }

  const { state, saveCreds } = await useMultiFileAuthState(authFolder);

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
    browser: ["WingaShop", "Chrome", "10.0"]
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    
    if (qr) {
      console.log('⚡ Scan this QR Code with WhatsApp:');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      isWhatsappReady = false;
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.warn('⚠️ WhatsApp connection closed. Reconnecting...', shouldReconnect);
      if (shouldReconnect) {
        connectToWhatsApp();
      }
    } else if (connection === 'open') {
      console.log('✅ Winga WhatsApp Bot is connected and live via Baileys!');
      isWhatsappReady = true;
    }
  });

  sock.ev.on('creds.update', saveCreds);

  // Incoming Messages Handler for Baileys
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;
      
      const remoteJid = msg.key.remoteJid;
      const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();
      const lowerText = text.toLowerCase();

      try {
        // 1. WhatsApp Review/Feedback Handler (!maoni)
        if (lowerText.startsWith('!maoni')) {
          const parts = text.split(/\s+/);
          const orderId = parseInt(parts[1]);
          const rating = parseInt(parts[2]);
          const comment = parts.slice(3).join(' ');

          if (!orderId || isNaN(rating) || rating < 1 || rating > 5 || !comment) {
            await sock.sendMessage(remoteJid, { text: '❌ Muundo sio sahihi.\n\nTumia muundo huu:\n*!maoni [NambaYaOda] [Nyota 1-5] [Maoni yako]*\n\nMfano:\n*!maoni 1 5 Nguo ni nzuri sana!*' });
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

        // 2. Order Command (!agiza / !order)
        if (lowerText.startsWith('!agiza') || lowerText.startsWith('!order')) {
          let productID = null;
          let location = 'Haikutajwa';
          let phone = remoteJid.replace('@s.whatsapp.net', '').replace('@c.us', '');

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
            await sock.sendMessage(remoteJid, { text: `❌ Bidhaa #${productID} haipo.` });
            continue;
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
            senderJid: remoteJid,
            status: 'Pending',
            date: new Date()
          };

          await db('orders').insert(newOrder);
          const trackUrl = `${BASE_URL}/track?id=${newOrder.orderId}`;

          await sock.sendMessage(remoteJid, {
            text: `🛒 *ODA YAKO IMEPOKELEWA!*\n---------------------------\n` +
                  `🔖 *Oda:* #${newOrder.orderId}\n` +
                  `📦 *Bidhaa:* ${product.name}\n` +
                  `💰 *Bei:* TSh ${newOrder.sellingPrice.toLocaleString()}\n` +
                  `📞 *Simu:* ${phone}\n` +
                  `📍 *Eneo:* ${location}\n\n` +
                  `📍 *Fuatilia Oda Yako Hapa:*\n${trackUrl}`
          });

          // Notify Winga
          notifyWinga(newOrder, product);
          continue;
        }

        // 3. Greeting Keywords
        const greetingKeywords = ['hi', 'hello', 'vp', 'habari', 'mambo', 'catalog', 'katalogi', 'katalog', 'hey', 'niaje'];
        if (greetingKeywords.some(k => lowerText === k || lowerText.startsWith(k + ' '))) {
          const catalogUrl = `${BASE_URL}/catalog`;
          await sock.sendMessage(remoteJid, { text: `Karibu WingaShop! 👋\n\nTazama na utafute bidhaa zetu hapa:\n${catalogUrl}` });
          continue;
        }

      } catch (handlerErr) {
        console.error('Baileys message handler error:', handlerErr);
      }
    }
  });
}

// Helper: Notify Winga of New Order
async function notifyWinga(order, product) {
  try {
    if (!isWhatsappReady || !sock) return;
    const winga = await db('wingas').where({ id: order.wingaId }).first();
    if (!winga || !winga.phone) return;

    let phone = winga.phone.trim().replace('+', '');
    if (phone.startsWith('0')) phone = '255' + phone.slice(1);
    const wingaChatId = phone + '@s.whatsapp.net';

    const alertMessage = `🔔 *ODA MPYA IMETOKA KWENYE DUKA YAKO!* 🛍️\n` +
                         `-----------------------------------\n` +
                         `🔖 *Namba ya Oda:* #${order.orderId}\n` +
                         `📦 *Bidhaa:* ${product.name}\n` +
                         `💰 *Bei ya Kuuzia:* TSh ${Number(order.sellingPrice).toLocaleString()}\n` +
                         `📍 *Eneo la Mteja:* ${order.location}\n` +
                         `📞 *Mteja Simu:* ${order.customerPhone}\n\n` +
                         `📲 Angalia dashboard yako: ${BASE_URL}/admin`;

    await sock.sendMessage(wingaChatId, { text: alertMessage });
  } catch (err) {
    console.error('❌ Failed to alert Winga via Baileys:', err);
  }
}

// Helper: Broadcast New Product Notification
async function notifyShopCustomers(winga, newProduct) {
  try {
    if (!isWhatsappReady || !sock) return;
    const shopOrders = await db('orders').where({ wingaId: winga.id });
    const customerJids = [...new Set(shopOrders.map(o => o.senderJid).filter(Boolean))];
    if (customerJids.length === 0) return;

    const alertMsg = `📢 *TAARIFA ZA BIDHAA MPYA!* 🛍️\n` +
                     `Duka la *${winga.name}* limeongeza bidhaa mpya sokoni!\n\n` +
                     `📦 *Bidhaa:* ${newProduct.name}\n` +
                     `💰 *Bei:* TSh ${Number(newProduct.sellingPrice).toLocaleString()}\n\n` +
                     `🔗 *Tazama hapa:*\n${BASE_URL}/catalog?shop=${winga.id}`;

    for (const jid of customerJids) {
      try {
        await sock.sendMessage(jid, { text: alertMsg });
      } catch (e) {}
    }
  } catch (err) {
    console.error('Broadcast error:', err);
  }
}

// Production Checks
if (process.env.NODE_ENV === 'production') {
  if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET === 'winga-super-secret-key') {
    console.error('❌ FATAL ERROR: SESSION_SECRET must be explicitly set!');
    process.exit(1);
  }
  if (!process.env.SUPERADMIN_PASS || process.env.SUPERADMIN_PASS === 'SuperSecurePass123!') {
    console.error('❌ FATAL ERROR: SUPERADMIN_PASS must be explicitly set!');
    process.exit(1);
  }
}

const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use('/uploads', express.static(UPLOADS_DIR));
app.use(express.static(path.join(__dirname, 'public')));

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

app.use('/superadmin', basicAuth({
  users: { 'admin': process.env.SUPERADMIN_PASS || 'SuperSecurePass123!' },
  challenge: true
}));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + Math.round(Math.random() * 1E9) + path.extname(file.originalname))
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }
}).array('images', 4);

function requireWinga(req, res, next) {
  if (!req.session || !req.session.wingaId) return res.redirect('/login');
  next();
}

function getProductImages(product) {
  if (!product) return [];
  let raw = product.imageUrl || product.imageLocalPath;
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
    return `/uploads/${path.basename(img)}`;
  }).filter(Boolean);
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

// Routes
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

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
      if (matchedWinga) shopName = `🛍️ Duka la ${matchedWinga.name}`;
      else { shopName = "⚠️ Duka halipatikani"; products = []; }
    }

    const trackBtnUrl = shopId ? `/track?shop=${shopId}` : '/track';
    const botPhone = process.env.BOT_PHONE_NUMBER || '255678143403';
    const categories = [...new Set(allProducts.map(p => (p.category || 'General').trim()))];
    let categoryOptions = categories.map(cat => `<option value="${escapeHtml(cat.toLowerCase())}">${escapeHtml(cat)}</option>`).join('');
    let shopOptions = wingas.map(w => `<option value="${w.id}" ${shopId == w.id ? 'selected' : ''}>${escapeHtml(w.name)}</option>`).join('');

    let productCards = products.map(p => {
      const sellingPrice = Number(p.sellingPrice || p.price || 0);
      const priceFormatted = sellingPrice > 0 ? sellingPrice.toLocaleString() : 'Haikutajwa';
      const imageList = getProductImages(p);
      const mainImage = imageList[0] || '';
      const matchedWinga = wingas.find(w => w.id === p.wingaId);
      const sellerName = matchedWinga ? matchedWinga.name : 'Duka Kuu';

      return `
      <div class="product-card" data-name="${escapeHtml(p.name.toLowerCase())}" data-category="${escapeHtml((p.category||'General').toLowerCase())}" data-shop="${p.wingaId}" style="background: white; padding: 15px; border-radius: 10px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); text-align: left; display: flex; flex-direction: column; justify-content: space-between;">
        <div>
          ${mainImage ? `<img src="${mainImage}" style="width: 100%; height: 200px; object-fit: cover; border-radius: 8px; margin-bottom: 8px;">` : '<div style="height:140px; background:#e9ecef; border-radius:8px; display:flex; align-items:center; justify-content:center;">📦</div>'}
          <h3 style="margin: 5px 0; font-size: 16px;">${escapeHtml(p.name)}</h3>
          <p style="color: #28a745; font-size: 16px; font-weight: bold;">TSh ${priceFormatted}</p>
        </div>
        <button data-id="${p.id}" data-name="${escapeHtml(p.name)}" data-price="${priceFormatted}" onclick="handleOrderClick(this)" style="background: #25D366; color: white; padding: 10px; border: none; border-radius: 6px; font-weight: bold; cursor: pointer; width: 100%;">🛒 Agiza Sasa</button>
      </div>`;
    }).join('');

    res.send(`
    <!DOCTYPE html>
    <html>
    <head><title>${escapeHtml(shopName)}</title><meta name="viewport" content="width=device-width, initial-scale=1"></head>
    <body style="font-family:sans-serif; background:#f4f6f8; margin:0; padding:20px;">
      <div style="max-width:900px; margin:0 auto;">
        <h1>${escapeHtml(shopName)}</h1>
        <div style="display:flex; gap:10px; margin-bottom:20px;">
          <a href="https://wa.me/${botPhone}?text=Habari!%20Naomba%20msaada" target="_blank" style="background:#25D366; color:white; padding:10px; text-decoration:none; border-radius:6px; font-weight:bold;">💬 Wasiliana Nasi</a>
          <a href="${trackBtnUrl}" style="background:#007bff; color:white; padding:10px; text-decoration:none; border-radius:6px; font-weight:bold;">🔍 Fuatilia Oda</a>
        </div>
        <div style="display:grid; grid-template-columns:repeat(auto-fill, minmax(220px, 1fr)); gap:20px;">${productCards || '<p>Hakuna bidhaa.</p>'}</div>
      </div>
      <div id="orderModal" style="display:none; position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.5); justify-content:center; align-items:center;">
        <div style="background:white; padding:25px; border-radius:12px; width:90%; max-width:380px;">
          <h3 id="modalProductName">Agiza</h3>
          <input type="hidden" id="selectedProductId"><input type="hidden" id="selectedProductName"><input type="hidden" id="selectedProductPrice">
          <label>Namba ya Simu:</label><input type="text" id="orderPhone" placeholder="0712345678" style="width:100%; padding:10px; margin:5px 0 10px 0; box-sizing:border-box;" required>
          <label>Eneo:</label><input type="text" id="orderLocation" placeholder="Dar es Salaam" style="width:100%; padding:10px; margin:5px 0 10px 0; box-sizing:border-box;" required>
          <button onclick="sendToWhatsApp()" style="background:#25D366; color:white; border:none; padding:12px; width:100%; font-weight:bold; border-radius:6px; cursor:pointer;">Tuma Oda kwa WhatsApp</button>
          <button onclick="document.getElementById('orderModal').style.display='none'" style="background:#ccc; border:none; padding:8px; width:100%; margin-top:5px; border-radius:6px; cursor:pointer;">Aghana</button>
        </div>
      </div>
      <script>
        var BOT_PHONE = "${botPhone}";
        function handleOrderClick(btn) {
          document.getElementById('selectedProductId').value = btn.getAttribute('data-id');
          document.getElementById('selectedProductName').value = btn.getAttribute('data-name');
          document.getElementById('selectedProductPrice').value = btn.getAttribute('data-price');
          document.getElementById('modalProductName').innerText = '🛒 ' + btn.getAttribute('data-name');
          document.getElementById('orderModal').style.display = 'flex';
        }
        function sendToWhatsApp() {
          var id = document.getElementById('selectedProductId').value;
          var name = document.getElementById('selectedProductName').value;
          var price = document.getElementById('selectedProductPrice').value;
          var phone = document.getElementById('orderPhone').value || 'Haikutajwa';
          var location = document.getElementById('orderLocation').value || 'Haikutajwa';
          var message = '!agiza ' + id + '\\n\\n*TAARIFA ZA ODA:*\\n📦 Bidhaa: ' + name + '\\n💰 Bei: TSh ' + price + '\\n📞 Simu: ' + phone + '\\n📍 Eneo: ' + location;
          window.open('https://wa.me/' + BOT_PHONE + '?text=' + encodeURIComponent(message), '_blank');
          document.getElementById('orderModal').style.display = 'none';
        }
      </script>
    </body>
    </html>
    `);
  } catch (err) {
    res.status(500).send('Hitilafu ya mfumo.');
  }
});

// Auth & Admin routes
app.get('/login', (req, res) => {
  res.send(`
  <!DOCTYPE html><html><head><title>Login</title></head>
  <body style="font-family:sans-serif; background:#6a88e8; display:flex; justify-content:center; align-items:center; height:100vh; margin:0;">
    <div style="background:white; padding:30px; border-radius:8px; width:300px; text-align:center;">
      <h2>🛍️ Winga Login</h2>
      <form action="/login" method="POST">
        <input type="text" name="phone" placeholder="Namba ya Simu" style="width:100%; padding:10px; margin:8px 0; box-sizing:border-box;" required>
        <input type="password" name="password" placeholder="Password" style="width:100%; padding:10px; margin:8px 0; box-sizing:border-box;" required>
        <button type="submit" style="background:#28a745; color:white; border:none; padding:10px; width:100%; font-weight:bold; border-radius:4px; cursor:pointer;">Ingia</button>
      </form>
    </div>
  </body></html>
  `);
});

app.post('/login', async (req, res) => {
  try {
    const { phone, password } = req.body;
    const winga = await db('wingas').where({ phone: phone.trim() }).first();
    if (winga && bcrypt.compareSync(password, winga.password)) {
      req.session.wingaId = winga.id;
      req.session.wingaName = winga.name;
      return res.redirect('/admin');
    }
    res.send('❌ Taarifa si sahihi. <a href="/login">Jaribu Tena</a>');
  } catch (err) {
    res.status(500).send('Hitilafu ya server.');
  }
});

app.get('/admin', requireWinga, async (req, res) => {
  try {
    const products = await db('products').where({ wingaId: req.session.wingaId });
    const orders = await db('orders').where({ wingaId: req.session.wingaId });
    res.send(`
    <!DOCTYPE html><html><head><title>Admin Dashboard</title></head>
    <body style="font-family:sans-serif; background:#f4f6f8; padding:20px;">
      <div style="max-width:900px; margin:0 auto; background:white; padding:20px; border-radius:8px;">
        <h2>🛍️ Dashboard ya ${escapeHtml(req.session.wingaName)}</h2>
        <a href="/logout" style="color:red; font-weight:bold; text-decoration:none;">Logout</a>
        <hr style="margin:20px 0;">
        <h3>Weka Bidhaa Mpya</h3>
        <form action="/admin/add" method="POST" enctype="multipart/form-data">
          <input type="text" name="name" placeholder="Jina la Bidhaa" style="width:100%; padding:8px; margin-bottom:8px;" required>
          <input type="text" name="category" placeholder="Category" style="width:100%; padding:8px; margin-bottom:8px;" required>
          <input type="number" name="sellingPrice" placeholder="Bei ya Kuuzia (TSh)" style="width:100%; padding:8px; margin-bottom:8px;" required>
          <input type="file" name="images" multiple accept="image/*" style="margin-bottom:8px;" required>
          <button type="submit" style="background:#28a745; color:white; border:none; padding:10px 20px; font-weight:bold; cursor:pointer;">Weka Sokoni</button>
        </form>
        <h3>Bidhaa Zako (${products.length})</h3>
        <ul>${products.map(p => `<li>${escapeHtml(p.name)} - TSh ${p.sellingPrice}</li>`).join('')}</ul>
      </div>
    </body></html>
    `);
  } catch (err) {
    res.status(500).send('Hitilafu kwenye Dashboard.');
  }
});

app.post('/admin/add', requireWinga, (req, res) => {
  upload(req, res, async (err) => {
    if (err) return res.redirect('/admin');
    try {
      const { name, category, sellingPrice } = req.body;
      const uploadedFiles = req.files || [];
      const imageUrls = uploadedFiles.map(f => `/uploads/${f.filename}`);

      await db('products').insert({
        wingaId: req.session.wingaId,
        name: name.trim(),
        category: category ? category.trim() : 'General',
        sellingPrice: parseFloat(sellingPrice || 0),
        price: parseFloat(sellingPrice || 0),
        imageUrl: JSON.stringify(imageUrls),
        dateAdded: new Date()
      });
      res.redirect('/admin');
    } catch (e) {
      res.redirect('/admin');
    }
  });
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// Start Server and Connect Baileys
app.listen(PORT, async () => {
  try {
    await db.raw('SELECT 1');
    console.log(`🌐 Server active on ${BASE_URL}`);
    connectToWhatsApp();
  } catch (err) {
    console.error('❌ Database connection failed:', err);
  }
});