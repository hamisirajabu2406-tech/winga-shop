require('dotenv').config();
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
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

// Optional modules (loaded safely if present)
let orderRoutes = null;
try {
  orderRoutes = require('./routes/orderRoutes');
} catch (e) {
  orderRoutes = null;
}

let sendSellerOrderSms = null;
try {
  ({ sendSellerOrderSms } = require('./services/smsService'));
} catch (e) {
  sendSellerOrderSms = null;
}

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_URL = (
  process.env.BASE_URL ||
  process.env.RENDER_EXTERNAL_URL ||
  'https://winga-shop.onrender.com'
).replace(/\/$/, '');

// Configure Cloudinary if credentials exist
if (
  process.env.CLOUDINARY_CLOUD_NAME &&
  process.env.CLOUDINARY_API_KEY &&
  process.env.CLOUDINARY_API_SECRET
) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
  });
}

// Global WhatsApp & System State
let sock = null;
let isWhatsappReady = false;
let isReconnecting = false;
let lastConnectedAt = null;
let lastDisconnectCode = null;
const shopBroadcastCooldown = new Map();
const authAttempts = new Map();

// SuperAdmin credentials (defaults to the two requested admin numbers)
const SUPER_ADMINS = [
  {
    phone: (process.env.SUPERADMIN_PHONE_1 || '0678143403').trim(),
    password: (process.env.SUPERADMIN_PASS_1 || 'SuperAdmin@0678').trim()
  },
  {
    phone: (process.env.SUPERADMIN_PHONE_2 || '0745423403').trim(),
    password: (process.env.SUPERADMIN_PASS_2 || 'SuperAdmin@0745').trim()
  }
];

function normalizePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('255') && digits.length >= 12) return digits;
  if (digits.startsWith('0') && digits.length === 10) return '255' + digits.slice(1);
  if (digits.length === 9) return '255' + digits;
  return digits;
}

function phoneVariants(raw) {
  const clean = String(raw || '').trim();
  const digits = clean.replace(/\D/g, '');
  const intl = normalizePhone(digits);
  const localZero = intl.startsWith('255') ? '0' + intl.slice(3) : digits;
  return [...new Set([clean, digits, intl, localZero].filter(Boolean))];
}

function isSamePhone(a, b) {
  const varA = phoneVariants(a);
  const varB = phoneVariants(b);
  return varA.some(x => varB.includes(x));
}

function isSuperAdminLogin(identifier, password) {
  if (!identifier || !password) return false;
  return SUPER_ADMINS.some(
    adm => isSamePhone(adm.phone, identifier) && password === adm.password
  );
}

function rateLimitAuth(maxAttempts = 10, windowMs = 15 * 60 * 1000) {
  return (req, res, next) => {
    const ip =
      req.headers['x-forwarded-for']?.split(',')[0].trim() ||
      req.ip ||
      'unknown';
    const key = `${req.path}:${ip}`;
    const now = Date.now();
    const record = authAttempts.get(key) || { count: 0, resetAt: now + windowMs };

    if (now > record.resetAt) {
      record.count = 0;
      record.resetAt = now + windowMs;
    }

    record.count += 1;
    authAttempts.set(key, record);

    if (record.count > maxAttempts) {
      const minsLeft = Math.ceil((record.resetAt - now) / 60000);
      return res
        .status(429)
        .send(
          `<div style="font-family:sans-serif;max-width:420px;margin:60px auto;padding:24px;border:1px solid #f5c2c7;background:#f8d7da;color:#842029;border-radius:10px;text-align:center;">` +
            `<h3>Majaribio Mengi Sana</h3>` +
            `<p>Tafadhali subiri dakika <strong>${minsLeft}</strong> kabla ya kujaribu tena.</p>` +
            `<a href="/catalog" style="display:inline-block;margin-top:12px;color:#842029;font-weight:bold;">Rudi Kwenye Catalog</a>` +
            `</div>`
        );
    }
    next();
  };
}

function isSmsEnabled(val) {
  return (
    val === true ||
    val === 1 ||
    String(val).toLowerCase() === 'true' ||
    String(val) === '1'
  );
}

function maskPhone(phone) {
  const clean = String(phone || '').replace(/\D/g, '');
  if (clean.length < 7) return clean || '-';
  return clean.slice(0, 5) + '****' + clean.slice(-3);
}

function isHttpUrl(str) {
  return typeof str === 'string' && /^https?:\/\//i.test(str.trim());
}

if (process.env.NODE_ENV === 'production') {
  if (
    !process.env.SESSION_SECRET ||
    process.env.SESSION_SECRET === 'winga-super-secret-key'
  ) {
    console.error(
      '❌ FATAL ERROR: SESSION_SECRET must be explicitly set to a secure string in production!'
    );
    process.exit(1);
  }
}

app.set('trust proxy', 1);
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Dynamic TZ location dataset helper
app.get('/tz-locations.js', (req, res, next) => {
  const staticLocPath = path.join(__dirname, 'public', 'tz-locations.js');
  if (fs.existsSync(staticLocPath)) {
    return next();
  }
  res.type('application/javascript').send(`
    (function() {
      const TZ_DATA = {
        "Dar es Salaam": {
          "Kinondoni": {
            "Kinondoni": ["Ada Estate", "Mkwajuni", "Hananasif", "Kambangwa"],
            "Msasani": ["Masaki", "Oysterbay", "Mikocheni A", "Mikocheni B"],
            "Kawe": ["Mzimuni", "Ukwamani", "Tangibovu", "Kawe Beach"],
            "Mbezi Juu": ["Mbezi Beach", "Tanki Bovu", "Kijitonyama"],
            "Magomeni": ["Magomeni Mwembechai", "Makumbusho", "Dsm Road"]
          },
          "Ilala": {
            "Kariakoo": ["Kariakoo Mashariki", "Kariakoo Magharibi", "Gerezani"],
            "Kisutu": ["Kisutu", "Upanga Mashariki", "Upanga Maghariki"],
            "Buguruni": ["Buguruni Malapa", "Kisiwani", "Mnyamani"],
            "Tabata": ["Tabata Kimanga", "Tabata Segerea", "Tabata Relini"],
            "Ukonga": ["Ukonga Mazizini", "Gongo la Mboto", "Pugu"]
          },
          "Temeke": {
            "Temeke": ["Temeke Wailes", "Yombo Vituka", "Sandali"],
            "Mbagala": ["Mbagala Kuu", "Mbagala Charambe", "Kizinga"],
            "Chang'ombe": ["Chang'ombe A", "Chang'ombe B", "Keko"],
            "Tandika": ["Tandika", "Kurasini", "Azimio"]
          },
          "Ubungo": {
            "Ubungo": ["Ubungo Kibo", "Msewe", "Riverside", "Makuburi"],
            "Sinza": ["Sinza Mori", "Sinza Palestina", "Sinza Vatican"],
            "Kimara": ["Kimara Baruti", "Kimara Stop Over", "Mbezi Luis"],
            "Manzese": ["Manzese Uzuri", "Manzese Argentina", "Mianzini"]
          },
          "Kigamboni": {
            "Kigamboni": ["Feri", "Kigamboni", "Tungi", "Mjimwema"],
            "Vijibweni": ["Vijibweni", "Gezaulole", "Kimbiji"]
          }
        },
        "Arusha": {
          "Arusha Mjini": {
            "Kati": ["Soko Kuu", "Clock Tower", "Sanawari"],
            "Sekei": ["Sekei", "Unga Limited", "Levolosi"],
            "Themi": ["Themi", "Kaloleni", "Ngarenaro"]
          },
          "Arumeru": {
            "Usa River": ["Usa River", "Ngyani", "Tengeru"],
            "Poli": ["Poli", "King'ori", "Kikatiti"]
          },
          "Karatu": { "Karatu": ["Karatu Mjini", "Endabash", "Mang'ola"] },
          "Longido": { "Longido": ["Longido", "Namanga", "Engarenaibor"] },
          "Ngorongoro": { "Loliondo": ["Loliondo", "Wasso", "Ngorongoro"] },
          "Monduli": { "Monduli Juu": ["Monduli Mjini", "Makuyuni", "Mto wa Mbu"] }
        },
        "Dodoma": {
          "Dodoma Mjini": {
            "Majengo": ["Majengo", "Kikuyu", "Chang'ombe Dodoma"],
            "Uhuru": ["Uhuru", "Viwandani", "Area C", "Area D"],
            "Dodoma Makulu": ["Dodoma Makulu", "Nzuguni", "Iyumbu"]
          },
          "Bahi": { "Bahi": ["Bahi", "Chipanga", "Mpinga"] },
          "Chamwino": { "Chamwino": ["Chamwino Ikulu", "Buigiri", "Mlowa"] },
          "Chemba": { "Chemba": ["Chemba", "Farkwa", "Goima"] },
          "Kondoa": { "Kondoa Mjini": ["Kondoa", "Busi", "Kolo"] },
          "Kongwa": { "Kibaigwa": ["Kibaigwa", "Kongwa Mjini", "Sagala"] },
          "Mpwapwa": { "Mpwapwa Mjini", "Kibakwe", "Godegode"] }
        },
        "Mwanza": {
          "Nyamagana": {
            "Pamba": ["Pamba", "Mbugani", "Mirongo"],
            "Mkuyuni": ["Mkuyuni", "Isamilo", "Nyegezi"]
          },
          "Ilemela": {
            "Kirumba": ["Kirumba", "Nyakato", "Buswelu", "Ibanda"]
          },
          "Magu": { "Magu Mjini": ["Magu", "Kisesa", "Kahangara"] },
          "Misungwi": { "Misungwi": ["Misungwi", "Usagara", "Koromije"] },
          "Sengerema": { "Sengerema Mjini", "Nyampulukano", "Tabaruka"] },
          "Ukerewe": { "Nansio": ["Nansio", "Kagunguli", "Muriti"] },
          "Kwimba": { "Ngudu": ["Ngudu", "Sumve", "Mwandoya"] }
        },
        "Mbeya": {
          "Mbeya Mjini": {
            "Mwanjelwa": ["Mwanjelwa", "Sinde", "Forest", "Nonde"],
            "Uyole": ["Uyole", "Iwambi", "Isyesye"]
          },
          "Mbeya Vijijini": { "Inyala": ["Inyala", "Mbalizi", "Santilya"] },
          "Rungwe": { "Tukuyu": ["Tukuyu Mjini", "Kiwira", "Masoko"] },
          "Kyela": { "Kyela": ["Kyela Mjini", "Kasumulu", "Ipinda"] },
          "Mbozi": { "Mbozi": ["Mbozi", "Idiwi", "Halungu"] },
          "Chunya": { "Chunya": ["Chunya", "Lupa", "Mkwajuni Chunya"] }
        },
        "Kilimanjaro": {
          "Moshi Mjini": {
            "Majengo Moshi": ["Majengo", "Pasua", "Kiboriloni", "Soweto"]
          },
          "Moshi Vijijini": { "Himo": ["Himo", "Marangu", "Old Moshi"] },
          "Hai": { "Bomang'ombe": ["Bomang'ombe", "Machame", "Sanya Juu"] },
          "Rombo": { "Mkuu": ["Mkuu", "Tarakea", "Mashati"] },
          "Mwanga": { "Mwanga": ["Mwanga", "Lembeni", "Usangi"] },
          "Same": { "Same": ["Same", "Hedaru", "Maore"] },
          "Siha": { "Siha Kati": ["Siha", "Sanya", "Namwai"] }
        },
        "Tanga": {
          "Tanga Mjini": { "Ngamiani": ["Ngamiani Kati", "Chumbageni", "Nguvumali", "Msambweni"] },
          "Muheza": { "Muheza": ["Muheza", "Amani", "Lusotho"] },
          "Korogwe": { "Korogwe": ["Korogwe Mjini", "Mombo", "Magoma"] },
          "Handeni": { "Chanika Handeni": ["Handeni Mjini", "Kibera", "Kwachaga"] },
          "Pangani": { "Pangani": ["Pangani Mashariki", "Bweni", "Mwera"] },
          "Lushoto": { "Lushoto": ["Lushoto Mjini", "Mlalo", "Soni"] },
          "Kilindi": { "Songe": ["Songe", "Kilindi", "Kwediboma"] }
        },
        "Morogoro": {
          "Morogoro Mjini": { "Mji Mkuu": ["Kichangani", "Mwembesongo", "Msamvu", "Mazimbu"] },
          "Morogoro Vijijini": { "Mkuyuni": ["Mkuyuni", "Kisaki", "Tawa"] },
          "Kilombero": { "Ifakara": ["Ifakara", "Mngeta", "Mang'ula"] },
          "Kilosa": { "Kilosa": ["Kilosa Mjini", "Mikumi", "Kimamba"] },
          "Ulanga": { "Mahenge": ["Mahenge", "Lupiro", "Vigoi"] },
          "Gairo": { "Gairo": ["Gairo", "Chagongwe", "Rubeho"] },
          "Malinyi": { "Malinyi": ["Malinyi", "Mtimbira", "Igawa"] }
        }
      };

      const ALL_REGIONS = [
        "Arusha", "Dar es Salaam", "Dodoma", "Geita", "Iringa", "Kagera", "Katavi",
        "Kigoma", "Kilimanjaro", "Lindi", "Manyara", "Mara", "Mbeya", "Morogoro",
        "Mtwara", "Mwanza", "Njombe", "Pemba Kaskazini", "Pemba Kusini", "Pwani",
        "Rukwa", "Ruvuma", "Shinyanga", "Simiyu", "Singida", "Songwe", "Tabora",
        "Tanga", "Unguja Kaskazini", "Unguja Kusini", "Mjini Magharibi"
      ];

      const DEFAULT_DISTRICTS = {
        "Geita": ["Geita Mjini", "Chato", "Bukombe", "Mbogwe", "Nyang'hwale"],
        "Iringa": ["Iringa Mjini", "Iringa Vijijini", "Kilolo", "Mufindi"],
        "Kagera": ["Bukoba Mjini", "Bukoba Vijijini", "Muleba", "Karagwe", "Ngara", "Biharamulo"],
        "Katavi": ["Mpanda Mjini", "Mlele", "Tanganyika"],
        "Kigoma": ["Kigoma Ujiji", "Kasulu", "Kibondo", "Buhigwe", "Uvinza", "Kakonko"],
        "Lindi": ["Lindi Mjini", "Kilwa", "Nachingwea", "Liwale", "Ruangwa"],
        "Manyara": ["Babati", "Hanang", "Mbulu", "Kiteto", "Simanjiro"],
        "Mara": ["Musoma Mjini", "Tarime", "Serengeti", "Bunda", "Rorya", "Butiama"],
        "Mtwara": ["Mtwara Mjini", "Masasi", "Newala", "Tandahimba", "Nanyumbu"],
        "Njombe": ["Njombe Mjini", "Makambako", "Wanging'ombe", "Ludewa", "Makete"],
        "Pemba Kaskazini": ["Wete", "Micheweni"],
        "Pemba Kusini": ["Chake Chake", "Mkoani"],
        "Pwani": ["Kibaha", "Bagamoyo", "Kisarawe", "Mkuranga", "Rufiji", "Mafia"],
        "Rukwa": ["Sumbawanga Mjini", "Kalambo", "Nkasi"],
        "Ruvuma": ["Songea Mjini", "Mbinga", "Tunduru", "Namtumbo", "Nyasa"],
        "Shinyanga": ["Shinyanga Mjini", "Kahama", "Kishapu"],
        "Simiyu": ["Bariadi", "Maswa", "Meatu", "Itilima", "Busega"],
        "Singida": ["Singida Mjini", "Iramba", "Manyoni", "Ikungi", "Mkalama"],
        "Songwe": ["Vwawa (Mbozi)", "Tunduma", "Ileje", "Momba", "Songwe"],
        "Tabora": ["Tabora Mjini", "Igunga", "Nzega", "Urambo", "Sikonge", "Kaliua"],
        "Unguja Kaskazini": ["Kaskazini A", "Kaskazini B"],
        "Unguja Kusini": ["Kati", "Kusini"],
        "Mjini Magharibi": ["Mjini", "Magharibi A", "Magharibi B"]
      };

      window.initTzLocation = function(regId, distId, wardId, streetId, customStreetId) {
        const rEl = document.getElementById(regId);
        const dEl = document.getElementById(distId);
        const wEl = document.getElementById(wardId);
        const sEl = document.getElementById(streetId);
        const cEl = document.getElementById(customStreetId);
        if (!rEl || !dEl || !wEl || !sEl) return;

        rEl.innerHTML = '<option value="">-- Chagua Mkoa --</option>' +
          ALL_REGIONS.map(r => '<option value="' + r + '">' + r + '</option>').join('');
        dEl.innerHTML = '<option value="">-- Kwanza Chagua Mkoa --</option>';
        wEl.innerHTML = '<option value="">-- Kwanza Chagua Wilaya --</option>';
        sEl.innerHTML = '<option value="">-- Kwanza Chagua Kata --</option>';

        function populateWards(reg, dist) {
          const regObj = TZ_DATA[reg];
          const wards = (regObj && regObj[dist]) ? Object.keys(regObj[dist]) : [];
          let opts = '<option value="">-- Chagua Kata --</option>';
          wards.forEach(w => {
            opts += '<option value="' + w + '">' + w + '</option>';
          });
          opts += '<option value="Kata Kuu">Kata Kuu</option>';
          opts += '<option value="__OTHER_WARD__">Kata Nyingine (Andika)</option>';
          wEl.innerHTML = opts;
          sEl.innerHTML = '<option value="">-- Chagua Mtaa / Kijiji --</option><option value="__OTHER__">Mtaa / Kijiji Kingine (Andika)</option>';
        }

        function populateStreets(reg, dist, ward) {
          const regObj = TZ_DATA[reg];
          const streets = (regObj && regObj[dist] && regObj[dist][ward]) ? regObj[dist][ward] : [];
          let opts = '<option value="">-- Chagua Mtaa / Kijiji --</option>';
          streets.forEach(st => {
            opts += '<option value="' + st + '">' + st + '</option>';
          });
          opts += '<option value="__OTHER__">Mtaa / Kijiji Kingine (Andika)</option>';
          sEl.innerHTML = opts;
        }

        rEl.addEventListener('change', function() {
          const reg = this.value;
          if (!reg) {
            dEl.innerHTML = '<option value="">-- Kwanza Chagua Mkoa --</option>';
            return;
          }
          const dists = TZ_DATA[reg] ? Object.keys(TZ_DATA[reg]) : (DEFAULT_DISTRICTS[reg] || []);
          dEl.innerHTML = '<option value="">-- Chagua Wilaya --</option>' +
            dists.map(d => '<option value="' + d + '">' + d + '</option>').join('');
          wEl.innerHTML = '<option value="">-- Kwanza Chagua Wilaya --</option>';
          sEl.innerHTML = '<option value="">-- Kwanza Chagua Kata --</option>';
          if (cEl) cEl.style.display = 'none';
        });

        dEl.addEventListener('change', function() {
          populateWards(rEl.value, this.value);
          if (cEl) cEl.style.display = 'none';
        });

        wEl.addEventListener('change', function() {
          if (this.value === '__OTHER_WARD__') {
            sEl.innerHTML = '<option value="__OTHER__">Andika Mtaa / Kijiji</option>';
            if (cEl) {
              cEl.style.display = 'block';
              cEl.placeholder = 'Andika Kata, kisha Mtaa (mf: Kata ya Mtaa, Mtaa fulani)...';
            }
          } else {
            populateStreets(rEl.value, dEl.value, this.value);
            if (cEl) {
              cEl.style.display = 'none';
              cEl.placeholder = 'Andika jina la mtaa / kijiji...';
            }
          }
        });

        sEl.addEventListener('change', function() {
          if (cEl) {
            cEl.style.display = (this.value === '__OTHER__' || wEl.value === '__OTHER_WARD__') ? 'block' : 'none';
          }
        });
      };
    })();
  `);
});

// Landing Page
app.get(['/', '/index.html'], (req, res) => {
  const indexPath = path.join(__dirname, 'public', 'index.html');
  fs.readFile(indexPath, 'utf8', (err, html) => {
    if (err) {
      const botPhone = process.env.BOT_PHONE_NUMBER || '255678143403';
      return res.send(`
        <!DOCTYPE html>
        <html lang="sw">
        <head>
          <meta charset="UTF-8">
          <title>Winga Shop - Soko La Mtandaoni Tanzania</title>
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <style>
            body { font-family: sans-serif; background: #f4f6f8; margin: 0; padding: 20px; text-align: center; color: #333; }
            .container { max-width: 600px; margin: 40px auto; background: white; padding: 30px; border-radius: 12px; box-shadow: 0 4px 15px rgba(0,0,0,0.1); }
            h1 { color: #007bff; }
            .btn { display: inline-block; background: #25D366; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: bold; margin: 10px; }
            .btn-admin { background: #007bff; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>🛍️ Karibu Winga Shop</h1>
            <p>Soko bora la mtandaoni linalowaunganisha wauzaji (winga) na wanunuzi Tanzania nzima kwa urahisi kupitia WhatsApp.</p>
            <hr style="margin: 20px 0; border:0; border-top:1px solid #eee;">
            <h3>ℹ️ Kuhusu Sisi (About Us)</h3>
            <p style="font-size: 14px; color: #555;">Winga Shop inakuwezesha wewe muuzaji kutangaza bidhaa zako na wateja kuagiza moja kwa moja kupitia mfumo wa kisasa wa WhatsApp bot.</p>
            <h3>📞 Wasiliana Nasi (Contact Us)</h3>
            <p style="font-size: 14px; color: #555;">Simu / WhatsApp: +${escapeHtml(botPhone)}<br>Barua pepe: support@wingashop.co.tz</p>
            <div style="margin-top: 25px;">
              <a href="/catalog" class="btn">🛒 Ingia Kwenye Catalog</a>
              <a href="/login" class="btn btn-admin">🔐 Ingia / Jisajili (Winga)</a>
            </div>
          </div>
        </body>
        </html>
      `);
    }
    res.send(html);
  });
});

app.use(express.static(path.join(__dirname, 'public')));

app.use(
  session({
    secret: process.env.SESSION_SECRET || 'winga-super-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 24 * 60 * 60 * 1000
    }
  })
);

if (orderRoutes) {
  app.use('/api', orderRoutes);
}

// Multer Memory Upload for Product Images (up to 4 images)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype && file.mimetype.startsWith('image/')) {
      return cb(null, true);
    }
    cb(new Error('Ruhusiwa kupakia faili za picha pekee!'));
  }
}).array('images', 4);

async function uploadBuffersToCloudinary(files) {
  const urls = [];
  if (!files || files.length === 0) return urls;
  if (
    !process.env.CLOUDINARY_CLOUD_NAME ||
    !process.env.CLOUDINARY_API_KEY ||
    !process.env.CLOUDINARY_API_SECRET
  ) {
    throw new Error('Cloudinary credentials hazijawekwa kwenye server');
  }
  for (const file of files) {
    const uploadResult = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder: 'winga_shop_products', resource_type: 'image' },
        (error, result) => {
          if (error) reject(error);
          else resolve(result);
        }
      );
      stream.end(file.buffer);
    });
    if (uploadResult && uploadResult.secure_url) {
      urls.push(uploadResult.secure_url);
    }
  }
  return urls;
}

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

function getProductImages(product) {
  if (!product) return [];
  let raw = product.imageUrl;
  if (!raw) return [];
  let list = [];
  try {
    const parsed =
      typeof raw === 'string' && raw.trim().startsWith('[') ? JSON.parse(raw) : raw;
    list = Array.isArray(parsed) ? parsed : [parsed];
  } catch (e) {
    list = [raw];
  }
  return list.map(img => (img ? String(img).trim() : '')).filter(Boolean);
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function buildLocationString(region, district, ward, street, customStreet) {
  const cleanWard = ward === '__OTHER_WARD__' ? '' : (ward || '').trim();
  const finalStreet = (
    street === '__OTHER__' || ward === '__OTHER_WARD__'
      ? customStreet || ''
      : street || ''
  ).trim();
  return [finalStreet, cleanWard, (district || '').trim(), (region || '').trim()]
    .filter(Boolean)
    .join(', ');
}

function findMatchedProductForOrder(order, productsList) {
  if (!order || !Array.isArray(productsList)) return null;
  if (order.productId) {
    const byId = productsList.find(p => Number(p.id) === Number(order.productId));
    if (byId) return byId;
  }
  const rawName = (order.productName || '').trim().toLowerCase();
  if (!rawName) return null;
  const baseName = rawName.split('(')[0].trim();
  return (
    productsList.find(p => p.name && p.name.trim().toLowerCase() === baseName) ||
    productsList.find(p => p.name && rawName.startsWith(p.name.trim().toLowerCase())) ||
    null
  );
}

// Strict per-product review matcher so feedback never leaks across different products
function getReviewsForProduct(product, allOrders, allReviews) {
  if (!product || !Array.isArray(allOrders) || !Array.isArray(allReviews)) return [];
  const prodNameLower = (product.name || '').trim().toLowerCase();

  const matchingOrderIds = new Set(
    allOrders
      .filter(o => {
        if (Number(o.wingaId) !== Number(product.wingaId)) return false;
        if (o.productId !== undefined && o.productId !== null && Number(o.productId) > 0) {
          return Number(o.productId) === Number(product.id);
        }
        const orderProdBase = (o.productName || '').split('(')[0].trim().toLowerCase();
        return Boolean(prodNameLower && orderProdBase === prodNameLower);
      })
      .map(o => Number(o.orderId))
  );

  return allReviews.filter(r => matchingOrderIds.has(Number(r.orderId)));
}

async function insertOrderSafe(orderObj) {
  try {
    await db('orders').insert(orderObj);
  } catch (err) {
    if (
      orderObj.productId !== undefined &&
      /productId|Unknown column/i.test(err.message || '')
    ) {
      const fallbackObj = { ...orderObj };
      delete fallbackObj.productId;
      await db('orders').insert(fallbackObj);
    } else {
      throw err;
    }
  }
}

function extractIncomingText(msg) {
  if (!msg || !msg.message) return '';
  let m = msg.message;
  if (m.ephemeralMessage?.message) m = m.ephemeralMessage.message;
  if (m.viewOnceMessage?.message) m = m.viewOnceMessage.message;
  if (m.viewOnceMessageV2?.message) m = m.viewOnceMessageV2.message;
  if (m.editedMessage?.message) m = m.editedMessage.message;
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    ''
  ).trim();
}

function isBotSocketReady() {
  return Boolean(sock && isWhatsappReady && sock.user);
}

async function resolveWhatsAppRecipientJid(phoneOrJid) {
  if (!phoneOrJid) return null;
  if (String(phoneOrJid).includes('@')) return String(phoneOrJid).trim();
  const intl = normalizePhone(phoneOrJid);
  if (!intl) return null;
  const standardJid = `${intl}@s.whatsapp.net`;
  if (sock && typeof sock.onWhatsApp === 'function') {
    try {
      const results = await sock.onWhatsApp(intl);
      if (Array.isArray(results) && results.length > 0 && results[0].exists && results[0].jid) {
        return results[0].jid;
      }
    } catch (e) {
      // Fallback to standard JID
    }
  }
  return standardJid;
}

async function connectToWhatsApp() {
  if (isReconnecting) return;
  isReconnecting = true;

  try {
    const authDir = process.env.WA_AUTH_DIR || 'auth_info_baileys';
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    let version;
    try {
      const latest = await fetchLatestBaileysVersion();
      version = latest.version;
    } catch (vErr) {
      console.warn('⚠️ Could not fetch latest Baileys version, using default:', vErr.message);
    }

    sock = makeWASocket({
      ...(version ? { version } : {}),
      auth: state,
      printQRInTerminal: true,
      logger: pino({ level: 'silent' }),
      browser: ['WingaShop', 'Chrome', '1.0.0'],
      markOnlineOnConnect: false
    });

    sock.ev.on('connection.update', update => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        console.log('⚡ Scan this QR Code with WhatsApp:');
        qrcode.generate(qr, { small: true });
      }
      if (connection === 'close') {
        isWhatsappReady = false;
        isReconnecting = false;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        lastDisconnectCode = statusCode || null;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        console.warn(
          `⚠️ WhatsApp connection closed (code: ${statusCode || 'unknown'}), reconnecting: ${shouldReconnect}`
        );
        if (shouldReconnect) {
          setTimeout(() => connectToWhatsApp(), 3000);
        } else {
          console.error(
            '❌ WhatsApp session logged out. Clear auth folder and scan QR again.'
          );
        }
      } else if (connection === 'open') {
        isReconnecting = false;
        isWhatsappReady = true;
        lastConnectedAt = new Date().toISOString();
        console.log('✅ Winga WhatsApp Bot (Baileys) is connected and live!');
      }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const msg of messages) {
        if (!msg.message || msg.key.fromMe) continue;

        const remoteJid = msg.key.remoteJid;
        if (
          !remoteJid ||
          remoteJid.endsWith('@g.us') ||
          remoteJid === 'status@broadcast'
        ) {
          continue;
        }

        const text = extractIncomingText(msg);
        if (!text) continue;
        const lowerText = text.toLowerCase();

        // 1. Feedback command via WhatsApp: !maoni [orderId] [1-5] [comment]
        if (lowerText.startsWith('!maoni')) {
          const parts = text.split(/\s+/);
          const orderId = parseInt(parts[1], 10);
          const rating = parseInt(parts[2], 10);
          const comment = parts.slice(3).join(' ').trim();

          if (!orderId || isNaN(rating) || rating < 1 || rating > 5 || !comment) {
            await sock.sendMessage(remoteJid, {
              text:
                '❌ Muundo sio sahihi.\n\nTumia muundo huu:\n*!maoni [NambaYaOda] [Nyota 1-5] [Maoni yako]*\n\nMfano:\n*!maoni 12 5 Bidhaa ni nzuri sana*'
            });
            continue;
          }

          const orderExists = await db('orders').where({ orderId }).first();
          if (!orderExists) {
            await sock.sendMessage(remoteJid, {
              text: `❌ Haikuwezekana kupata Oda #${orderId}.`
            });
            continue;
          }

          const existingReview = await db('reviews').where({ orderId }).first();
          if (existingReview) {
            await db('reviews')
              .where({ orderId })
              .update({ rating, comment, date: new Date() });
          } else {
            await db('reviews').insert({
              orderId,
              rating,
              comment,
              date: new Date()
            });
          }

          await sock.sendMessage(remoteJid, {
            text: `🎉 *AHSANTE SANA KWA FEEDBACK YAKO!* ⭐\n\nTumepokea tathmini yako ya nyota ${'⭐'.repeat(rating)} kwa Oda #${orderId}.`
          });
          continue;
        }

        // 2. Order command via WhatsApp: !agiza / !order
        if (lowerText.startsWith('!agiza') || lowerText.startsWith('!order')) {
          const senderDigits = remoteJid
            .replace('@s.whatsapp.net', '')
            .replace('@c.us', '')
            .replace('@lid', '');
          let location = 'Haikutajwa';
          let phone = normalizePhone(senderDigits) || senderDigits;
          let notes = '';
          let orderItems = [];

          const lines = text
            .split(/\r?\n/)
            .map(l => l.trim())
            .filter(Boolean);
          const firstLine = lines[0] || '';
          const afterCommand = firstLine.replace(/^!(agiza|order)\s*/i, '').trim();

          let defaultSize = 'Standard';
          let defaultColor = 'Kama pichani';
          let defaultQty = 1;

          for (const line of lines.slice(1)) {
            const lower = line.toLowerCase();
            if (lower.includes('simu:')) {
              const val = line.replace(/^.*?simu:\s*/i, '').trim();
              if (val && val.toLowerCase() !== 'haikutajwa') phone = val;
            } else if (lower.includes('eneo:')) {
              const val = line.replace(/^.*?eneo:\s*/i, '').trim();
              if (val && val.toLowerCase() !== 'haikutajwa') location = val;
            } else if (lower.includes('maelezo:')) {
              const val = line.replace(/^.*?maelezo:\s*/i, '').trim();
              if (val && val.toLowerCase() !== 'hakuna') notes = val;
            } else if (lower.includes('saizi:') || lower.includes('size:')) {
              const val = line.replace(/^.*?(saizi|size):\s*/i, '').trim();
              if (val) defaultSize = val;
            } else if (lower.includes('rangi:') || lower.includes('color:')) {
              const val = line.replace(/^.*?(rangi|color):\s*/i, '').trim();
              if (val && val.toLowerCase() !== 'haijatajwa') defaultColor = val;
            } else if (lower.includes('idadi:')) {
              const q = parseInt(line.replace(/^.*?idadi:\s*/i, '').trim(), 10);
              if (!isNaN(q) && q > 0) defaultQty = q;
            } else if (/^item\s*\d*\s*:/i.test(line)) {
              const itemBody = line.replace(/^item\s*\d*\s*:/i, '').trim();
              const segs = itemBody.split('|').map(s => s.trim());
              const idMatch = segs[0].match(/#?(\d+)/);
              if (idMatch) {
                let itSize = defaultSize;
                let itColor = defaultColor;
                let itQty = defaultQty;
                segs.slice(1).forEach(s => {
                  if (/^(size|saizi):/i.test(s)) {
                    itSize = s.replace(/^(size|saizi):\s*/i, '').trim() || 'Standard';
                  }
                  if (/^(rangi|color):/i.test(s)) {
                    itColor = s.replace(/^(rangi|color):\s*/i, '').trim() || 'Kama pichani';
                  }
                  if (/^idadi:/i.test(s)) {
                    const q = parseInt(s.replace(/^idadi:\s*/i, '').trim(), 10);
                    if (!isNaN(q) && q > 0) itQty = q;
                  }
                });
                orderItems.push({
                  id: parseInt(idMatch[1], 10),
                  size: itSize,
                  color: itColor,
                  qty: itQty
                });
              }
            }
          }

          if (orderItems.length === 0 && afterCommand) {
            if (afterCommand.includes('|')) {
              const payload = afterCommand.split('|');
              const pidMatch = payload[0].match(/#?(\d+)/);
              if (pidMatch) {
                orderItems.push({
                  id: parseInt(pidMatch[1], 10),
                  size: defaultSize,
                  color: defaultColor,
                  qty: defaultQty
                });
              }
              if (payload[1]) location = payload[1].trim();
              if (payload[2]) phone = payload[2].trim();
            } else {
              const commaParts = afterCommand.split(',');
              for (const part of commaParts) {
                const m = part.trim().match(/^#?(\d+)$/);
                if (m) {
                  orderItems.push({
                    id: parseInt(m[1], 10),
                    size: defaultSize,
                    color: defaultColor,
                    qty: defaultQty
                  });
                }
              }
              if (orderItems.length === 0) {
                const firstNumMatch = afterCommand.match(/#?(\d+)/);
                if (firstNumMatch) {
                  orderItems.push({
                    id: parseInt(firstNumMatch[1], 10),
                    size: defaultSize,
                    color: defaultColor,
                    qty: defaultQty
                  });
                }
              }
            }
          }

          if (orderItems.length === 0) {
            await sock.sendMessage(remoteJid, {
              text: `❌ Tafadhali taja namba ya bidhaa (mfano: *!agiza 1*) au chagua bidhaa hapa:\n${PUBLIC_URL}/catalog`
            });
            continue;
          }

          const createdReceipts = [];
          const missingIds = [];

          for (const item of orderItems) {
            const product = await db('products').where({ id: item.id }).first();
            if (!product) {
              missingIds.push(item.id);
              continue;
            }

            const unitBuying = Number(product.buyingPrice || 0);
            const unitSelling = Number(product.sellingPrice || product.price || 0);
            const totalBuying = unitBuying * item.qty;
            const totalSelling = unitSelling * item.qty;

            let detailsSummary = product.name;
            const extras = [];
            if (item.qty > 1) extras.push(`x${item.qty}`);
            if (item.size && item.size !== 'Standard') extras.push(`Size: ${item.size}`);
            if (item.color) extras.push(`Rangi: ${item.color}`);
            if (notes) extras.push(`Maelezo: ${notes}`);
            if (extras.length > 0) detailsSummary += ` (${extras.join(', ')})`;

            const maxRows = await db('orders').max('orderId as maxId');
            const rawMax =
              maxRows && maxRows[0]
                ? maxRows[0].maxId ?? Object.values(maxRows[0])[0]
                : 0;
            const nextOrderId = (rawMax ? Number(rawMax) : 0) + 1;

            const newOrder = {
              orderId: nextOrderId,
              wingaId: product.wingaId || 1,
              productId: product.id,
              productName: detailsSummary,
              buyingPrice: totalBuying,
              sellingPrice: totalSelling,
              customerPhone: phone,
              location: location,
              senderJid: remoteJid,
              status: 'Pending',
              date: new Date()
            };

            await insertOrderSafe(newOrder);
            createdReceipts.push({ order: newOrder, product });

            await notifyWinga(newOrder, product);

            if (typeof sendSellerOrderSms === 'function') {
              const orderWinga = await db('wingas')
                .where({ id: newOrder.wingaId })
                .first();
              if (orderWinga && isSmsEnabled(orderWinga.sms_enabled) && orderWinga.phone) {
                sendSellerOrderSms({
                  phone: orderWinga.phone,
                  sellerName: orderWinga.name,
                  orderId: newOrder.orderId,
                  totalAmount: newOrder.sellingPrice
                }).catch(err => console.error('[SMS Hook] Imeshindwa kutuma SMS:', err));
              }
            }
          }

          if (createdReceipts.length === 0) {
            await sock.sendMessage(remoteJid, {
              text: `❌ Samahani, bidhaa #${missingIds.join(', #')} haikupatikana kwenye mfumo. Tafadhali fungua Catalog upya:\n${PUBLIC_URL}/catalog`
            });
            continue;
          }

          let grandTotal = 0;
          const linesOut = createdReceipts
            .map(({ order }) => {
              grandTotal += Number(order.sellingPrice || 0);
              return (
                `🔖 *Oda #${order.orderId}:* ${order.productName} — TSh ${Number(order.sellingPrice).toLocaleString()}\n` +
                `   🔗 Fuatilia (Weka namba yako kuhakiki): ${PUBLIC_URL}/track?id=${order.orderId}`
              );
            })
            .join('\n\n');

          let replyMsg =
            `🛒 *ODA YAKO IMEPOKELEWA!*\n---------------------------\n` +
            `${linesOut}\n\n` +
            `💰 *Jumla Kuu:* TSh ${grandTotal.toLocaleString()}\n` +
            `📞 *Simu:* ${phone}\n` +
            `📍 *Eneo:* ${location}\n` +
            `📌 *Status:* 🟡 Pending`;

          if (missingIds.length > 0) {
            replyMsg += `\n\n⚠️ Bidhaa ambazo hazikupatikana: #${missingIds.join(', #')}`;
          }

          await sock.sendMessage(remoteJid, { text: replyMsg });
          continue;
        }

        // 3. Greeting / Catalog shortcut
        const greetingKeywords = [
          'hi',
          'hello',
          'vp',
          'habari',
          'mambo',
          'catalog',
          'katalogi',
          'katalog',
          '1',
          'nguo',
          'hey',
          'niaje'
        ];
        if (
          greetingKeywords.some(
            keyword => lowerText === keyword || lowerText.startsWith(keyword + ' ')
          )
        ) {
          await sock.sendMessage(remoteJid, {
            text: `Karibu WingaShop! 👋\n\nTazama na utafute bidhaa zetu hapa:\n${PUBLIC_URL}/catalog`
          });
          continue;
        }
      }
    });
  } catch (err) {
    isReconnecting = false;
    isWhatsappReady = false;
    console.error('❌ connectToWhatsApp error:', err);
    setTimeout(() => connectToWhatsApp(), 5000);
  }
}

async function notifyShopCustomers(winga) {
  try {
    if (!isBotSocketReady() || !winga) return;

    const now = Date.now();
    const lastSent = shopBroadcastCooldown.get(winga.id) || 0;
    const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
    if (now - lastSent < TWENTY_FOUR_HOURS) {
      return;
    }

    const shopOrders = await db('orders').where({ wingaId: winga.id });
    const customerJids = [
      ...new Set(
        shopOrders
          .map(o => o.senderJid)
          .filter(j => j && String(j).includes('@'))
      )
    ];
    if (customerJids.length === 0) return;

    shopBroadcastCooldown.set(winga.id, now);

    const alertMsg =
      `📢 Duka la *${winga.name}* limeongeza bidhaa mpya leo.\n` +
      `Tazama hapa: ${PUBLIC_URL}/catalog?shop=${winga.id}`;

    for (const jid of customerJids) {
      try {
        await sock.sendMessage(jid, { text: alertMsg });
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
    if (!isBotSocketReady()) return;
    const winga = await db('wingas').where({ id: order.wingaId }).first();
    if (!winga || !winga.phone) return;
    const wingaChatId = await resolveWhatsAppRecipientJid(winga.phone);
    if (!wingaChatId) return;

    const alertMessage =
      `🔔 *ODA MPYA IMETOKA KWENYE DUKA YAKO!* 🛍️\n` +
      `-----------------------------------\n` +
      `🔖 *Namba ya Oda:* #${order.orderId}\n` +
      `📦 *Bidhaa:* ${order.productName}\n` +
      `💰 *Bei ya Kuuzia:* TSh ${Number(order.sellingPrice).toLocaleString()}\n` +
      `💵 *Faida Yako (Profit):* TSh ${(Number(order.sellingPrice) - Number(order.buyingPrice)).toLocaleString()}\n` +
      `📍 *Eneo la Mteja:* ${order.location}\n` +
      `📞 *Mteja Simu:* ${order.customerPhone}\n\n` +
      `📲 Angalia dashboard yako hapa: ${PUBLIC_URL}/admin`;

    const images = getProductImages(product);
    if (images.length > 0 && isHttpUrl(images[0])) {
      try {
        await sock.sendMessage(wingaChatId, {
          image: { url: images[0] },
          caption: alertMessage
        });
      } catch (imgErr) {
        console.warn('⚠️ Image alert failed, sending text fallback:', imgErr.message);
        await sock.sendMessage(wingaChatId, { text: alertMessage });
      }
    } else {
      await sock.sendMessage(wingaChatId, { text: alertMessage });
    }
  } catch (err) {
    console.error('❌ Failed to send alert to Winga:', err);
  }
}

// Bot status check route
app.get('/bot-status', (req, res) => {
  res.json({
    ready: isBotSocketReady(),
    isWhatsappReady,
    isReconnecting,
    hasUser: Boolean(sock && sock.user),
    lastConnectedAt,
    lastDisconnectCode
  });
});

// ==========================================
// PUBLIC CATALOG (Product-Specific Reviews Only)
// ==========================================
app.get('/catalog', async (req, res) => {
  try {
    try {
      await db('stats').where({ key: 'catalogVisits' }).increment('value', 1);
    } catch (statErr) {
      // Optional stats table
    }

    const allProducts = await db('products').select('*');
    const wingas = await db('wingas').select('*');
    const allOrders = await db('orders').select('*');
    const allReviews = await db('reviews').select('*');

    const shopId = req.query.shop ? parseInt(req.query.shop, 10) : null;
    let products = allProducts;
    let shopName = 'Soko Letu (All Shops)';
    if (shopId) {
      products = allProducts.filter(p => Number(p.wingaId) === shopId);
      const matchedWinga = wingas.find(w => Number(w.id) === shopId);
      if (matchedWinga) {
        shopName = `🛍️ Duka la ${matchedWinga.name}`;
      } else {
        shopName = '⚠️ Duka halipatikani';
        products = [];
      }
    }

    const trackBtnUrl = shopId ? `/track?shop=${shopId}` : '/track';
    const botPhone = process.env.BOT_PHONE_NUMBER || '255678143403';
    const categories = [
      ...new Set(allProducts.map(p => (p.category || 'General').trim()).filter(Boolean))
    ];

    const categoryOptions = categories
      .map(
        cat =>
          `<option value="${escapeHtml(cat.toLowerCase())}">${escapeHtml(cat)}</option>`
      )
      .join('');
    const shopOptions = wingas
      .map(
        w =>
          `<option value="${w.id}" ${shopId === Number(w.id) ? 'selected' : ''}>${escapeHtml(w.name)} (${escapeHtml(w.location || 'Tanzania')})</option>`
      )
      .join('');

    const catalogProductsMap = {};

    let productCards = products
      .map(p => {
        const sellingPrice = Number(p.sellingPrice || p.price || 0);
        const priceFormatted = sellingPrice > 0 ? sellingPrice.toLocaleString() : 'Haikutajwa';
        const priceDisplay =
          sellingPrice > 0 ? `TSh ${priceFormatted}` : 'Wasiliana na Muuzaji';

        const imageList = getProductImages(p);
        const mainImage = imageList[0] || '';
        const categoryStr = (p.category || 'General').trim();
        const availableSizes = (p.size || 'Standard').trim();
        const availableColors = (p.colors || 'Kama pichani').trim();
        const matchedWinga = wingas.find(w => Number(w.id) === Number(p.wingaId));
        const sellerName = matchedWinga ? matchedWinga.name : 'Duka Kuu';
        const sellerLocation =
          matchedWinga && matchedWinga.location ? matchedWinga.location : 'Tanzania';

        // STRICT: Only reviews for THIS specific product
        const productOnlyReviews = getReviewsForProduct(p, allOrders, allReviews);
        const avgRating =
          productOnlyReviews.length > 0
            ? (
                productOnlyReviews.reduce((sum, r) => sum + Number(r.rating || 0), 0) /
                productOnlyReviews.length
              ).toFixed(1)
            : null;

        catalogProductsMap[p.id] = {
          id: p.id,
          name: p.name,
          priceNum: sellingPrice,
          priceFormatted,
          category: categoryStr,
          sizes: availableSizes,
          colors: availableColors,
          images: imageList,
          sellerName,
          sellerLocation,
          avgRating,
          reviews: productOnlyReviews.slice(0, 15).map(r => ({
            rating: r.rating,
            comment: r.comment,
            date: r.date ? new Date(r.date).toLocaleDateString('sw-TZ') : ''
          }))
        };

        let galleryThumbnailsHtml = '';
        if (imageList.length > 1) {
          galleryThumbnailsHtml =
            `<div style="display: flex; gap: 6px; margin-bottom: 10px; overflow-x: auto; padding-bottom: 4px;">` +
            imageList
              .map(
                img =>
                  `<img src="${escapeHtml(img)}" data-thumb="${escapeHtml(img)}" data-target="img-${p.id}" onclick="event.stopPropagation(); selectThumb(this)" style="width: 42px; height: 42px; object-fit: cover; border-radius: 6px; border: 1px solid #ccc; cursor: pointer; flex-shrink: 0;">`
              )
              .join('') +
            `</div>`;
        }

        const imageHtml = mainImage
          ? `<div onclick="openProductDetailsById(${p.id})" style="position: relative; cursor: pointer;">
              <img id="img-${p.id}" data-fullsrc="${escapeHtml(mainImage)}" src="${escapeHtml(mainImage)}" alt="${escapeHtml(p.name)}" style="width: 100%; height: 180px; object-fit: cover; border-radius: 8px; margin-bottom: 8px;">
              <button type="button" onclick="event.stopPropagation(); zoomCardImage('img-${p.id}')" class="lbl-zoom" style="position: absolute; top: 8px; right: 8px; background: rgba(0,0,0,0.65); color: white; border:none; padding: 4px 8px; border-radius: 4px; font-size: 11px; font-weight: bold; cursor: pointer;">🔍 Kuza</button>
              <span class="lbl-details-badge" style="position: absolute; bottom: 14px; right: 8px; background: rgba(0,0,0,0.72); color: white; padding: 3px 8px; border-radius: 4px; font-size: 11px; font-weight: bold; pointer-events: none;">👁️ Maelezo & Maoni</span>
             </div>${galleryThumbnailsHtml}`
          : `<div onclick="openProductDetailsById(${p.id})" style="height: 140px; background: #e9ecef; border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 36px; margin-bottom: 10px; color: #adb5bd; cursor: pointer;">📦</div>`;

        const ratingBadge = avgRating
          ? `<span style="background:#fff3cd; color:#856404; font-size:11px; padding:2px 6px; border-radius:8px; font-weight:bold;">⭐ ${avgRating} (${productOnlyReviews.length} maoni)</span>`
          : `<span style="background:#f1f3f5; color:#6c757d; font-size:10px; padding:2px 6px; border-radius:8px; font-weight:bold;">Hakuna maoni bado</span>`;

        return `
        <div class="product-card" data-name="${escapeHtml((p.name || '').toLowerCase())}" data-category="${escapeHtml(categoryStr.toLowerCase())}" data-shop="${p.wingaId}" data-shopname="${escapeHtml(sellerName.toLowerCase())}" style="background: white; padding: 12px; border-radius: 10px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); text-align: left; display: flex; flex-direction: column; justify-content: space-between;">
          <div>
            ${imageHtml}
            <div style="margin-bottom: 5px; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:4px;">
              <span style="background: #e3f2fd; color: #0d47a1; font-size: 10px; padding: 3px 7px; border-radius: 12px; font-weight: bold;">${escapeHtml(categoryStr)}</span>
              ${ratingBadge}
            </div>
            <h3 onclick="openProductDetailsById(${p.id})" style="margin: 5px 0; color: #222; font-size: 15px; word-break: break-word; cursor:pointer; text-decoration:underline;">${escapeHtml(p.name)}</h3>
            <p style="color: ${sellingPrice > 0 ? '#28a745' : '#6c757d'}; font-size: 15px; font-weight: bold; margin: 5px 0 8px 0;">${priceDisplay}</p>
          </div>
          <div style="font-size: 12px; color: #555; margin-bottom: 8px;">
            <span>🏪 <strong>${escapeHtml(sellerName)}</strong></span><br>
            <span>📍 <em>${escapeHtml(sellerLocation)}</em></span><br>
            <span>🎨 <em>${escapeHtml(availableColors)}</em></span>
          </div>
          <div style="display:flex; gap:6px;">
            <button type="button" class="details-btn-text" onclick="openProductDetailsById(${p.id})" style="background:#007bff; color:white; padding:9px; border:none; border-radius:6px; font-weight:bold; cursor:pointer; font-size:12px; flex:1;">ℹ️ Maelezo</button>
            <button type="button" class="order-btn-text" onclick="openOrderModalById(${p.id})" style="background:#25D366; color:white; padding:9px; border:none; border-radius:6px; font-weight:bold; cursor:pointer; font-size:12px; flex:1;">🛒 Agiza</button>
          </div>
        </div>`;
      })
      .join('');

    if (products.length === 0) {
      productCards =
        '<p class="no-prod-text" style="grid-column: 1 / -1; text-align: center; color: #666; padding: 40px 0;">Hakuna bidhaa kwenye duka hili kwa sasa.</p>';
    }

    const safeCatalogJson = JSON.stringify(catalogProductsMap).replace(/</g, '\\u003c');

    res.send(`
    <!DOCTYPE html>
    <html lang="sw">
    <head>
      <meta charset="UTF-8">
      <title>${escapeHtml(shopName)}</title>
      <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
      <script src="/tz-locations.js"></script>
      <style>
        * { box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f4f6f8; margin: 0; padding: 12px; color: #333; padding-bottom: 80px; }
        .container { max-width: 950px; margin: 0 auto; }
        .header-bar { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px; margin-bottom: 15px; }
        .nav-btns { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
        .track-btn { background: #007bff; color: white; padding: 9px 12px; border-radius: 6px; text-decoration: none; font-weight: bold; font-size: 13px; }
        .contact-btn { background: #25D366; color: white; padding: 9px 12px; border-radius: 6px; text-decoration: none; font-weight: bold; font-size: 13px; }
        .extra-btn { background: #6c757d; color: white; padding: 9px 12px; border-radius: 6px; font-weight: bold; font-size: 13px; border: none; cursor: pointer; }
        .filter-bar { display: flex; gap: 8px; margin-bottom: 15px; flex-direction: column; }
        @media(min-width: 600px) { .filter-bar { flex-direction: row; } }
        .filter-bar input, .filter-bar select { padding: 10px; border: 1px solid #ccc; border-radius: 6px; font-size: 14px; width: 100%; background: white; }
        .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(165px, 1fr)); gap: 12px; }
        @media(min-width: 500px) { .grid { grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 15px; } }
        h1 { color: #111; font-size: 20px; margin: 0; }
        .modal-overlay { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.65); justify-content: center; align-items: center; z-index: 1000; padding: 10px; }
        .modal-content { background: white; padding: 20px; border-radius: 12px; width: 100%; max-width: 460px; max-height: 92vh; overflow-y: auto; box-shadow: 0 4px 20px rgba(0,0,0,0.25); position: relative; }
        .close-btn { position: absolute; top: 10px; right: 14px; font-size: 26px; cursor: pointer; color: #888; border: none; background: none; }
        .form-group { margin-bottom: 10px; text-align: left; }
        .form-group label { display: block; font-weight: bold; margin-bottom: 4px; color: #333; font-size: 12px; }
        .form-group input, .form-group select, .form-group textarea { width: 100%; padding: 9px; border: 1px solid #ccc; border-radius: 6px; font-size: 14px; font-family: inherit; background: white; }
        .form-row-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
        .submit-btn { background: #25D366; color: white; border: none; padding: 12px; width: 100%; font-size: 15px; font-weight: bold; border-radius: 6px; cursor: pointer; margin-top: 8px; }
        .cart-float { position: fixed; bottom: 16px; right: 16px; background: #111; color: white; padding: 13px 18px; border-radius: 50px; font-weight: bold; box-shadow: 0 4px 15px rgba(0,0,0,0.3); cursor: pointer; z-index: 900; border: 2px solid #25D366; font-size: 14px; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header-bar">
          <h1>${escapeHtml(shopName)}</h1>
          <div class="nav-btns">
            <button type="button" class="extra-btn" onclick="toggleLanguage()" id="langBtn">🌐 EN / SW</button>
            <button type="button" class="extra-btn" onclick="openHelpModal()" id="helpBtn">❓ Msaada / FAQs</button>
            <button type="button" class="extra-btn" onclick="openAboutModal()" id="aboutBtn">ℹ️ About / Contact</button>
            <button type="button" class="extra-btn" onclick="openCartModal()" id="topCartBtn">🛒 Kikapu (<span id="cartCountTop">0</span>)</button>
            <a href="https://wa.me/${escapeHtml(botPhone)}?text=Habari!%20Naomba%20msaada%20tafadhali" target="_blank" rel="noopener noreferrer" class="contact-btn" id="contactUsBtn">💬 Contact Us</a>
            <a href="${trackBtnUrl}" class="track-btn" id="trackOrderBtn">🔍 Fuatilia Oda</a>
          </div>
        </div>
        <div class="filter-bar">
          <input type="text" id="searchInput" oninput="filterCatalog()" onkeyup="filterCatalog()" placeholder="🔍 Tafuta bidhaa au duka...">
          <select id="shopSelect" onchange="filterCatalog()">
            <option value="all" id="optAllShops">🏪 Maduka Yote (All Shops)</option>
            ${shopOptions}
          </select>
          <select id="categorySelect" onchange="filterCatalog()">
            <option value="all" id="optAllCats">📁 Vipengele Vyote (Categories)</option>
            ${categoryOptions}
          </select>
        </div>
        <div class="grid" id="productGrid">
          ${productCards}
        </div>
      </div>

      <button type="button" class="cart-float" onclick="openCartModal()">🛒 <span id="floatCartLabel">Kikapu Chako</span> (<span id="cartCountFloat">0</span>)</button>

      <!-- Help Modal -->
      <div id="helpModal" class="modal-overlay">
        <div class="modal-content">
          <button type="button" class="close-btn" onclick="closeHelpModal()">&times;</button>
          <h3 style="margin-top:0; color:#111; font-size:18px;" id="helpModalTitle">❓ Msaada & Maswali (FAQs)</h3>
          <div style="font-size: 13px; color: #444; line-height: 1.5; text-align: left;">
            <p><strong>1. Jinsi ya kuagiza bidhaa?</strong><br>Bonyeza "Maelezo" kuona taarifa na maoni ya bidhaa husika, au bonyeza "Agiza" kuchagua saizi, idadi, na rangi kisha tuma oda moja kwa moja WhatsApp au weka kwenye Kikapu.</p>
            <p><strong>2. Jinsi ya kufuatilia oda yako?</strong><br>Bofya "Fuatilia Oda", weka namba yako ya oda na namba ya simu uliyotumia kuagiza ili kuona hatua ya oda na kutoa maoni/nyota.</p>
            <p><strong>3. Jinsi ya kuwa muuzaji (Winga)?</strong><br>Unaweza kujisajili kupitia ukurasa wa Login/Register au kuwasiliana na Admin wa mfumo.</p>
          </div>
        </div>
      </div>

      <!-- About Modal -->
      <div id="aboutModal" class="modal-overlay">
        <div class="modal-content">
          <button type="button" class="close-btn" onclick="closeAboutModal()">&times;</button>
          <h3 style="margin-top:0; color:#111; font-size:18px;" id="aboutModalTitle">ℹ️ Kuhusu Sisi & Mawasiliano</h3>
          <div style="font-size: 13px; color: #444; line-height: 1.5; text-align: left;">
            <p><strong>Winga Shop</strong> ni soko la kidijitali linalorahisisha biashara ya mtandaoni kwa wauzaji na wanunuzi nchini Tanzania.</p>
            <p><strong>Wasiliana Nasi:</strong><br>📞 WhatsApp/Simu: +${escapeHtml(botPhone)}<br>📍 Eneo: Dar es Salaam, Tanzania</p>
          </div>
        </div>
      </div>

      <!-- Fullscreen Lightbox Modal -->
      <div id="fullImgModal" onclick="closeImgModal()" style="display: none; position: fixed; z-index: 9999; left: 0; top: 0; width: 100%; height: 100%; background-color: rgba(0,0,0,0.9); justify-content: center; align-items: center; cursor: pointer; padding: 15px;">
        <span style="position: absolute; top: 15px; right: 25px; color: #fff; font-size: 35px; font-weight: bold;">&times;</span>
        <img id="lightboxImage" style="max-width: 95%; max-height: 85vh; border-radius: 8px; object-fit: contain;">
      </div>

      <!-- Product Details Modal -->
      <div id="detailsModal" class="modal-overlay">
        <div class="modal-content">
          <button type="button" class="close-btn" onclick="closeModalById('detailsModal')">&times;</button>
          <div id="detailsBody"></div>
        </div>
      </div>

      <!-- Order Modal -->
      <div id="orderModal" class="modal-overlay">
        <div class="modal-content">
          <button type="button" class="close-btn" onclick="closeModalById('orderModal')">&times;</button>
          <h3 style="margin-top:0; color:#111; font-size:17px;" id="modalProductName">Agiza Bidhaa</h3>
          <p style="color:#28a745; font-weight:bold; margin-top:-5px; margin-bottom: 10px; font-size:14px;" id="modalProductPrice"></p>

          <div class="form-row-2">
            <div class="form-group">
              <label id="lblSize">Size:</label>
              <select id="orderSize"></select>
            </div>
            <div class="form-group">
              <label id="lblQty">Idadi (Quantity):</label>
              <input type="number" id="orderQty" value="1" min="1" max="20" oninput="renderColorPickers()" onchange="renderColorPickers()">
            </div>
          </div>

          <div id="perItemColorsBox" class="form-group" style="background:#f8f9fa; padding:10px; border-radius:6px; border:1px solid #e9ecef;"></div>

          <div style="display:flex; gap:8px; margin-bottom:12px;">
            <button type="button" id="addToCartBtn" onclick="addCurrentToCart()" style="background:#007bff; color:white; border:none; padding:10px; border-radius:6px; font-weight:bold; cursor:pointer; flex:1; font-size:13px;">➕ Ongeza Kwenye Kikapu (Multiple Orders)</button>
          </div>

          <hr style="border:0; border-top:1px solid #eee; margin:12px 0;">
          <h4 style="margin:0 0 8px 0; font-size:14px;" id="lblCustomerInfo">📍 Taarifa za Mteja & Mahali Ulipo</h4>

          <div class="form-group">
            <label id="lblPhone">Namba ya Simu (Tarakimu 10):</label>
            <input type="tel" id="orderPhone" placeholder="0712345678" maxlength="10" oninput="this.value = this.value.replace(/[^0-9]/g, '').slice(0, 10)" required>
          </div>

          <div class="form-row-2">
            <div class="form-group">
              <label id="lblRegion">Mkoa:</label>
              <select id="custRegion" required></select>
            </div>
            <div class="form-group">
              <label id="lblDistrict">Wilaya:</label>
              <select id="custDistrict" required></select>
            </div>
          </div>

          <div class="form-row-2">
            <div class="form-group">
              <label id="lblWard">Kata:</label>
              <select id="custWard" required></select>
            </div>
            <div class="form-group">
              <label id="lblStreet">Mtaa / Kijiji:</label>
              <select id="custStreet" required></select>
            </div>
          </div>
          <div class="form-group">
            <input type="text" id="custCustomStreet" placeholder="Andika jina la mtaa / kijiji..." style="display:none;">
          </div>

          <div class="form-group">
            <label id="lblNotes">Maelezo ya Ziada (Si lazima):</label>
            <textarea id="orderNotes" rows="2" placeholder="Mfano: Niletee jioni..."></textarea>
          </div>

          <button type="button" class="submit-btn" id="submitOrderBtn" onclick="sendSingleOrderWhatsApp()">📲 Tuma Oda Hii Moja WhatsApp</button>
        </div>
      </div>

      <!-- Cart Modal -->
      <div id="cartModal" class="modal-overlay">
        <div class="modal-content">
          <button type="button" class="close-btn" onclick="closeModalById('cartModal')">&times;</button>
          <h3 style="margin-top:0;">🛒 Kikapu Chako (Multiple Orders)</h3>
          <div id="cartItemsList" style="margin-bottom:12px; font-size:13px;"></div>
          <div id="cartCheckoutSection">
            <div class="form-group">
              <label>Namba ya Simu (Tarakimu 10):</label>
              <input type="tel" id="cartPhone" placeholder="0712345678" maxlength="10" oninput="this.value = this.value.replace(/[^0-9]/g, '').slice(0, 10)">
            </div>
            <div class="form-row-2">
              <div class="form-group"><label>Mkoa:</label><select id="cartRegion"></select></div>
              <div class="form-group"><label>Wilaya:</label><select id="cartDistrict"></select></div>
            </div>
            <div class="form-row-2">
              <div class="form-group"><label>Kata:</label><select id="cartWard"></select></div>
              <div class="form-group"><label>Mtaa / Kijiji:</label><select id="cartStreet"></select></div>
            </div>
            <div class="form-group"><input type="text" id="cartCustomStreet" placeholder="Andika jina la mtaa / kijiji..." style="display:none;"></div>
            <div class="form-group"><label>Maelezo ya Ziada:</label><textarea id="cartNotes" rows="2" placeholder="Maelekezo ya ziada..."></textarea></div>
            <button type="button" class="submit-btn" onclick="checkoutCartWhatsApp()">📲 Tuma Oda Zote WhatsApp</button>
          </div>
        </div>
      </div>

      <script>
        var BOT_PHONE = ${JSON.stringify(botPhone)};
        var CATALOG_PRODUCTS = ${safeCatalogJson};
        var activeProduct = null;
        var cart = [];
        try {
          cart = JSON.parse(localStorage.getItem('winga_cart') || '[]');
          if (!Array.isArray(cart)) cart = [];
        } catch (e) {
          cart = [];
        }
        var currentLang = localStorage.getItem('winga_lang') || 'sw';

        function escJsHtml(str) {
          if (str === null || str === undefined) return '';
          return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
        }

        function closeModalById(id) {
          var el = document.getElementById(id);
          if (el) el.style.display = 'none';
        }
        function openHelpModal() { document.getElementById('helpModal').style.display = 'flex'; }
        function closeHelpModal() { document.getElementById('helpModal').style.display = 'none'; }
        function openAboutModal() { document.getElementById('aboutModal').style.display = 'flex'; }
        function closeAboutModal() { document.getElementById('aboutModal').style.display = 'none'; }
        function openImgModal(src) {
          if (!src) return;
          document.getElementById('lightboxImage').src = src;
          document.getElementById('fullImgModal').style.display = 'flex';
        }
        function closeImgModal() { document.getElementById('fullImgModal').style.display = 'none'; }

        function zoomCardImage(imgId) {
          var imgEl = document.getElementById(imgId);
          if (!imgEl) return;
          openImgModal(imgEl.getAttribute('data-fullsrc') || imgEl.getAttribute('src') || '');
        }

        function selectThumb(thumbEl) {
          var targetId = thumbEl.getAttribute('data-target');
          var newSrc = thumbEl.getAttribute('data-thumb');
          var targetImg = document.getElementById(targetId);
          if (targetImg && newSrc) {
            targetImg.src = newSrc;
            targetImg.setAttribute('data-fullsrc', newSrc);
          }
        }

        function openProductDetailsById(id) {
          var p = CATALOG_PRODUCTS[id] || CATALOG_PRODUCTS[String(id)];
          if (p) openProductDetails(p);
        }

        function openOrderModalById(id) {
          var p = CATALOG_PRODUCTS[id] || CATALOG_PRODUCTS[String(id)];
          if (p) openOrderModal(p);
        }

        function updateCartBadges() {
          var topEl = document.getElementById('cartCountTop');
          var floatEl = document.getElementById('cartCountFloat');
          if (topEl) topEl.textContent = cart.length;
          if (floatEl) floatEl.textContent = cart.length;
        }

        function filterCatalog() {
          try {
            var searchVal = (document.getElementById('searchInput').value || '').toLowerCase().trim();
            var catVal = (document.getElementById('categorySelect').value || 'all').toLowerCase();
            var shopVal = document.getElementById('shopSelect').value || 'all';
            var cards = document.getElementsByClassName('product-card');
            for (var i = 0; i < cards.length; i++) {
              var cardName = (cards[i].getAttribute('data-name') || '').toLowerCase();
              var cardCat = (cards[i].getAttribute('data-category') || '').toLowerCase();
              var cardShop = String(cards[i].getAttribute('data-shop') || '');
              var cardShopName = (cards[i].getAttribute('data-shopname') || '').toLowerCase();
              var matchesSearch = !searchVal || cardName.indexOf(searchVal) !== -1 || cardShopName.indexOf(searchVal) !== -1;
              var matchesCat = (catVal === 'all' || cardCat === catVal);
              var matchesShop = (shopVal === 'all' || cardShop === String(shopVal));
              cards[i].style.display = (matchesSearch && matchesCat && matchesShop) ? 'flex' : 'none';
            }
          } catch (e) {
            console.error('filterCatalog error:', e);
          }
        }

        function openProductDetails(p) {
          if (!p) return;
          var imgsHtml = (p.images && p.images.length > 0)
            ? p.images.map(function(u) {
                return '<img src="' + escJsHtml(u) + '" class="detail-zoom-img" data-src="' + escJsHtml(u) + '" style="width:100%; max-height:240px; object-fit:contain; background:#f8f9fa; border-radius:8px; margin-bottom:8px; cursor:pointer;">';
              }).join('')
            : '<div style="height:120px; background:#eee; border-radius:8px; display:flex; align-items:center; justify-content:center; font-size:40px;">📦</div>';

          var trustBadge = p.avgRating
            ? '<span style="background:#fff3cd; color:#856404; padding:4px 8px; border-radius:6px; font-size:12px; font-weight:bold;">⭐ Wastani wa Nyota kwa Bidhaa Hii: ' + escJsHtml(p.avgRating) + ' / 5 (' + p.reviews.length + ' maoni)</span>'
            : '<span style="background:#f1f3f5; color:#555; padding:4px 8px; border-radius:6px; font-size:12px; font-weight:bold;">Hakuna maoni ya bidhaa hii bado</span>';

          var reviewsHtml = '<p style="color:#777; font-size:13px;">Bado hakuna maoni yaliyowekwa mahsusi kwa bidhaa hii.</p>';
          if (p.reviews && p.reviews.length > 0) {
            reviewsHtml = p.reviews.map(function(r) {
              var stars = '⭐'.repeat(Math.max(1, Math.min(5, Number(r.rating) || 5)));
              return '<div style="border-bottom:1px solid #eee; padding:8px 0; font-size:13px;">' +
                '<strong>' + stars + '</strong> <small style="color:#888;">(' + escJsHtml(r.date || '') + ')</small><br>' +
                '<em>"' + escJsHtml(r.comment || '') + '"</em></div>';
            }).join('');
          }

          document.getElementById('detailsBody').innerHTML =
            imgsHtml +
            '<h3 style="margin:6px 0;">' + escJsHtml(p.name || '') + '</h3>' +
            '<p style="color:#28a745; font-size:18px; font-weight:bold; margin:4px 0 10px 0;">TSh ' + escJsHtml(p.priceFormatted || '0') + '</p>' +
            '<div style="margin-bottom:10px;">' + trustBadge + '</div>' +
            '<div style="background:#f8f9fa; padding:10px; border-radius:8px; font-size:13px; line-height:1.6; margin-bottom:12px;">' +
            '<strong>🏪 Duka:</strong> ' + escJsHtml(p.sellerName || '') + '<br>' +
            '<strong>📍 Eneo la Muuzaji:</strong> ' + escJsHtml(p.sellerLocation || '') + '<br>' +
            '<strong>📁 Aina:</strong> ' + escJsHtml(p.category || '') + '<br>' +
            '<strong>📏 Saizi Zilizopo:</strong> ' + escJsHtml(p.sizes || 'Standard') + '<br>' +
            '<strong>🎨 Rangi Zilizopo:</strong> ' + escJsHtml(p.colors || 'Kama pichani') +
            '</div>' +
            '<h4 style="margin:10px 0 6px 0; font-size:14px;">⭐ Maoni ya Bidhaa Hii (' + (p.reviews ? p.reviews.length : 0) + ')</h4>' +
            '<div style="max-height:160px; overflow-y:auto; margin-bottom:12px; border:1px solid #eee; padding:0 10px; border-radius:6px;">' + reviewsHtml + '</div>' +
            '<button type="button" id="detailsOrderNowBtn" class="submit-btn">🛒 Endelea Kuagiza Bidhaa Hii</button>';

          document.getElementById('detailsBody').querySelectorAll('.detail-zoom-img').forEach(function(img) {
            img.addEventListener('click', function() {
              openImgModal(img.getAttribute('data-src'));
            });
          });

          document.getElementById('detailsOrderNowBtn').onclick = function() {
            closeModalById('detailsModal');
            openOrderModal(p);
          };

          document.getElementById('detailsModal').style.display = 'flex';
        }

        function openOrderModal(p) {
          if (!p) return;
          activeProduct = p;
          document.getElementById('modalProductName').innerText = '🛒 ' + (activeProduct.name || '');
          document.getElementById('modalProductPrice').innerText = 'Bei: TSh ' + (activeProduct.priceFormatted || '0');
          document.getElementById('orderQty').value = '1';

          var sizeSelect = document.getElementById('orderSize');
          sizeSelect.innerHTML = '';
          var parsedSizes = (activeProduct.sizes || 'Standard').split(',').map(function(s) { return s.trim(); }).filter(Boolean);
          if (parsedSizes.length === 0) parsedSizes.push('Standard');
          parsedSizes.forEach(function(s) {
            var opt = document.createElement('option');
            opt.value = s;
            opt.textContent = s;
            sizeSelect.appendChild(opt);
          });

          renderColorPickers();
          document.getElementById('orderModal').style.display = 'flex';
        }

        function renderColorPickers() {
          if (!activeProduct) return;
          var qty = Math.max(1, Math.min(20, parseInt(document.getElementById('orderQty').value || '1', 10)));
          var colors = (activeProduct.colors || 'Kama pichani').split(',').map(function(c) { return c.trim(); }).filter(Boolean);
          if (colors.length === 0) colors.push('Kama pichani');
          var box = document.getElementById('perItemColorsBox');

          var html = '<label style="margin-bottom:6px;">🎨 Chagua Rangi kwa Kila Bidhaa (' + qty + '):</label>';
          for (var i = 1; i <= qty; i++) {
            var opts = colors.map(function(c) {
              return '<option value="' + escJsHtml(c) + '">' + escJsHtml(c) + '</option>';
            }).join('');
            html += '<div style="display:flex; align-items:center; gap:8px; margin-bottom:5px;">' +
              '<span style="font-size:12px; min-width:65px;">Bidhaa #' + i + ':</span>' +
              '<select class="item-color-choice" style="padding:6px; font-size:13px;">' + opts + '</select>' +
              '</div>';
          }
          box.innerHTML = html;
        }

        function getSelectedColorsSummary() {
          var selects = document.querySelectorAll('.item-color-choice');
          var counts = {};
          selects.forEach(function(s) {
            counts[s.value] = (counts[s.value] || 0) + 1;
          });
          var summary = Object.keys(counts).map(function(col) {
            var cnt = counts[col];
            return cnt > 1 ? col + ' x' + cnt : col;
          }).join(', ');
          return summary || (activeProduct && activeProduct.colors) || 'Kama pichani';
        }

        function addCurrentToCart() {
          if (!activeProduct) return;
          var qty = Math.max(1, parseInt(document.getElementById('orderQty').value || '1', 10));
          var size = document.getElementById('orderSize').value || 'Standard';
          var colorSummary = getSelectedColorsSummary();

          cart.push({
            id: activeProduct.id,
            name: activeProduct.name,
            priceNum: Number(activeProduct.priceNum || 0),
            size: size,
            color: colorSummary,
            qty: qty
          });
          localStorage.setItem('winga_cart', JSON.stringify(cart));
          updateCartBadges();
          closeModalById('orderModal');
          alert('✅ "' + activeProduct.name + '" imeongezwa kwenye kikapu!');
        }

        function openCartModal() {
          var listEl = document.getElementById('cartItemsList');
          if (!cart || cart.length === 0) {
            listEl.innerHTML = '<p style="color:#666; text-align:center; padding:15px 0;">Kikapu chako hakina bidhaa. Bofya "Agiza" kwenye bidhaa unazotaka kisha chagua "Ongeza Kwenye Kikapu".</p>';
            document.getElementById('cartCheckoutSection').style.display = 'none';
          } else {
            document.getElementById('cartCheckoutSection').style.display = 'block';
            var total = 0;
            listEl.innerHTML = cart.map(function(item, idx) {
              var sub = Number(item.priceNum || 0) * Number(item.qty || 1);
              total += sub;
              return '<div style="border-bottom:1px solid #eee; padding:8px 0; display:flex; justify-content:space-between; align-items:center;">' +
                '<div><strong>' + escJsHtml(item.name) + '</strong> (x' + Number(item.qty || 1) + ')<br><small>Size: ' + escJsHtml(item.size) + ' | Rangi: ' + escJsHtml(item.color) + ' | TSh ' + sub.toLocaleString() + '</small></div>' +
                '<button type="button" onclick="removeFromCart(' + idx + ')" style="background:#dc3545; color:white; border:none; border-radius:4px; padding:4px 8px; cursor:pointer;">✕</button>' +
                '</div>';
            }).join('') + '<p style="font-weight:bold; color:#28a745; font-size:15px; margin-top:10px;">Jumla Kuu: TSh ' + total.toLocaleString() + '</p>';
          }
          document.getElementById('cartModal').style.display = 'flex';
        }

        function removeFromCart(idx) {
          cart.splice(idx, 1);
          localStorage.setItem('winga_cart', JSON.stringify(cart));
          updateCartBadges();
          openCartModal();
        }

        function getLocationText(prefix) {
          var rEl = document.getElementById(prefix + 'Region');
          var dEl = document.getElementById(prefix + 'District');
          var wEl = document.getElementById(prefix + 'Ward');
          var sEl = document.getElementById(prefix + 'Street');
          var cEl = document.getElementById(prefix + 'CustomStreet');
          var r = rEl ? rEl.value : '';
          var d = dEl ? dEl.value : '';
          var w = wEl ? wEl.value : '';
          var s = sEl ? sEl.value : '';
          var c = cEl ? cEl.value.trim() : '';
          var cleanWard = (w === '__OTHER_WARD__') ? '' : w;
          var finalS = (s === '__OTHER__' || w === '__OTHER_WARD__') ? c : s;
          if (!r || !d || !finalS) return null;
          return [finalS, cleanWard, d, r].filter(Boolean).join(', ');
        }

        function sendSingleOrderWhatsApp() {
          if (!activeProduct) return;
          var phone = (document.getElementById('orderPhone').value || '').trim();
          var fullLoc = getLocationText('cust');
          if (!/^[0-9]{10}$/.test(phone)) return alert('❌ Weka namba ya simu yenye tarakimu 10 (mfano: 0712345678).');
          if (!fullLoc) return alert('❌ Tafadhali chagua Mkoa, Wilaya, Kata na Mtaa/Kijiji chako.');

          var size = document.getElementById('orderSize').value || 'Standard';
          var colorSummary = getSelectedColorsSummary();
          var qty = document.getElementById('orderQty').value || 1;
          var notes = (document.getElementById('orderNotes').value || '').trim() || 'Hakuna';

          var message = '!agiza ' + activeProduct.id +
            '\\n\\n*TAARIFA ZA ODA:*' +
            '\\n📦 Bidhaa: ' + activeProduct.name +
            '\\n💰 Bei: TSh ' + activeProduct.priceFormatted +
            '\\n📞 Simu: ' + phone +
            '\\n📍 Eneo: ' + fullLoc +
            '\\n📏 Saizi: ' + size +
            '\\n🎨 Rangi: ' + colorSummary +
            '\\n🔢 Idadi: ' + qty +
            '\\n📝 Maelezo: ' + notes;

          window.open('https://wa.me/' + encodeURIComponent(BOT_PHONE) + '?text=' + encodeURIComponent(message), '_blank', 'noopener,noreferrer');
          closeModalById('orderModal');
        }

        function checkoutCartWhatsApp() {
          if (!cart || cart.length === 0) return;
          var phone = (document.getElementById('cartPhone').value || '').trim();
          var fullLoc = getLocationText('cart');
          if (!/^[0-9]{10}$/.test(phone)) return alert('❌ Weka namba ya simu yenye tarakimu 10.');
          if (!fullLoc) return alert('❌ Tafadhali chagua Mkoa, Wilaya, Kata na Mtaa/Kijiji chako.');
          var notes = (document.getElementById('cartNotes').value || '').trim() || 'Hakuna';

          var itemLines = cart.map(function(it, idx) {
            return 'ITEM ' + (idx + 1) + ': #' + it.id + ' | Size: ' + it.size + ' | Rangi: ' + it.color + ' | Idadi: ' + it.qty;
          }).join('\\n');

          var message = '!agiza' +
            '\\n' + itemLines +
            '\\n📞 Simu: ' + phone +
            '\\n📍 Eneo: ' + fullLoc +
            '\\n📝 Maelezo: ' + notes;

          cart = [];
          localStorage.setItem('winga_cart', '[]');
          updateCartBadges();
          closeModalById('cartModal');
          window.open('https://wa.me/' + encodeURIComponent(BOT_PHONE) + '?text=' + encodeURIComponent(message), '_blank', 'noopener,noreferrer');
        }

        function toggleLanguage() {
          currentLang = currentLang === 'sw' ? 'en' : 'sw';
          localStorage.setItem('winga_lang', currentLang);
          var isEn = currentLang === 'en';
          document.getElementById('contactUsBtn').textContent = '💬 Contact Us';
          document.getElementById('trackOrderBtn').textContent = isEn ? '🔍 Track Order' : '🔍 Fuatilia Oda';
          document.getElementById('searchInput').placeholder = isEn ? '🔍 Search products or shops...' : '🔍 Tafuta bidhaa au duka...';
          document.getElementById('optAllShops').textContent = isEn ? '🏪 All Shops' : '🏪 Maduka Yote (All Shops)';
          document.getElementById('optAllCats').textContent = isEn ? '📁 All Categories' : '📁 Vipengele Vyote (Categories)';
          document.getElementById('helpBtn').textContent = isEn ? '❓ Help / FAQs' : '❓ Msaada / FAQs';
          document.getElementById('aboutBtn').textContent = isEn ? 'ℹ️ About / Contact' : 'ℹ️ About / Contact';
          document.getElementById('floatCartLabel').textContent = isEn ? 'Your Cart' : 'Kikapu Chako';
          document.getElementById('langBtn').textContent = isEn ? '🌐 SW / EN' : '🌐 EN / SW';
          document.querySelectorAll('.details-btn-text').forEach(function(el) { el.textContent = isEn ? 'ℹ️ Details' : 'ℹ️ Maelezo'; });
          document.querySelectorAll('.order-btn-text').forEach(function(el) { el.textContent = isEn ? '🛒 Order' : '🛒 Agiza'; });
        }

        window.addEventListener('DOMContentLoaded', function() {
          try {
            if (typeof window.initTzLocation === 'function') {
              window.initTzLocation('custRegion', 'custDistrict', 'custWard', 'custStreet', 'custCustomStreet');
              window.initTzLocation('cartRegion', 'cartDistrict', 'cartWard', 'cartStreet', 'cartCustomStreet');
            }
          } catch (locErr) {
            console.warn('Location init error:', locErr);
          }
          updateCartBadges();
          if (currentLang === 'en') {
            currentLang = 'sw';
            toggleLanguage();
          }
        });

        window.addEventListener('click', function(e) {
          ['orderModal', 'detailsModal', 'cartModal', 'helpModal', 'aboutModal', 'fullImgModal'].forEach(function(id) {
            var m = document.getElementById(id);
            if (m && e.target === m) m.style.display = 'none';
          });
        });
      </script>
    </body>
    </html>
    `);
  } catch (err) {
    console.error('Catalog route error:', err);
    res.status(500).send('Hitilafu kwenye mfumo.');
  }
});

// ==========================================
// TRACK ORDER, VERIFY, REVIEW & INVOICE
// ==========================================
app.get('/track', async (req, res) => {
  try {
    const searchId = req.query.id ? parseInt(req.query.id, 10) : null;
    let shopId = req.query.shop ? parseInt(req.query.shop, 10) : null;
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
            <p style="font-size:13px; color:#555; margin-bottom:15px;">Ili kulinda faragha ya mteja na kuzuia wengine kuchungulia, tafadhali weka namba ya simu uliyotumia kuagizia <strong>Oda #${searchId}</strong> ili kuona taarifa zake.</p>
            <form action="/track/verify" method="POST">
              <input type="hidden" name="orderId" value="${searchId}">
              ${shopId ? `<input type="hidden" name="shop" value="${shopId}">` : ''}
              <input type="tel" name="phone" placeholder="0712345678" maxlength="10" oninput="this.value = this.value.replace(/[^0-9]/g, '').slice(0, 10)" style="width:100%; padding:10px; border:1px solid #ccc; border-radius:6px; margin-bottom:12px;" required>
              <button type="submit" style="background:#28a745; color:white; border:none; padding:11px; width:100%; font-weight:bold; border-radius:6px; cursor:pointer;">Thibitisha & Tazama Oda</button>
            </form>
          </div>`;
        } else {
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
              reviewSection = `<div style="background:#e8f5e9; padding:15px; border-radius:8px; margin-top:15px;"><h4 style="margin:0 0 5px 0; color:#2e7d32;">AHSANTE KWA FEEDBACK YAKO!</h4><p style="margin:0; font-size:18px;">${'⭐'.repeat(Math.max(1, Math.min(5, Number(existingReview.rating) || 5)))}</p><p style="margin:5px 0 0 0; color:#555;"><em>"${escapeHtml(existingReview.comment)}"</em></p></div>`;
            } else {
              reviewSection = `
              <div style="background:#f8f9fa; padding:15px; border-radius:8px; margin-top:15px; border:1px solid #e9ecef;">
                <h4 style="margin:0 0 10px 0;">Toa Maoni & Nyota (Review Order)</h4>
                <form action="/track/review" method="POST">
                  <input type="hidden" name="orderId" value="${order.orderId}">
                  <select name="rating" style="width:100%; padding:8px; margin-bottom:10px;" required>
                    <option value="5">⭐⭐⭐⭐⭐ (5/5 - Bora Sana)</option>
                    <option value="4">⭐⭐⭐⭐ (4/5 - Nzuri)</option>
                    <option value="3">⭐⭐⭐ (3/5 - Kawaida)</option>
                    <option value="2">⭐⭐ (2/5 - Vibaya)</option>
                    <option value="1">⭐ (1/5 - Mbaya Sana)</option>
                  </select>
                  <textarea name="comment" rows="3" style="width:100%; padding:8px; margin-bottom:10px;" placeholder="Andika maoni yako..." required></textarea>
                  <button type="submit" style="background:#28a745; color:white; border:none; padding:10px; border-radius:4px; font-weight:bold; width:100%; cursor:pointer;">Tuma Feedback</button>
                </form>
              </div>`;
            }
          }

          let publicReviewsHtml = '';
          if (allOrderReviews.length > 0) {
            publicReviewsHtml =
              `<div style="margin-top: 15px; padding: 12px; background: #fff; border: 1px solid #e9ecef; border-radius: 8px;">
              <h4 style="margin: 0 0 8px 0; font-size: 14px; color: #333;">📢 Maoni ya Oda Hii:</h4>` +
              allOrderReviews
                .map(
                  r => `<div style="font-size: 13px; border-bottom: 1px solid #f1f3f5; padding-bottom: 6px; margin-bottom: 6px;">
                <span>${'⭐'.repeat(Math.max(1, Math.min(5, Number(r.rating) || 5)))}</span> <span style="color: #666; font-size: 11px;">(${r.date ? new Date(r.date).toLocaleDateString() : ''})</span><br>
                <em>"${escapeHtml(r.comment)}"</em>
              </div>`
                )
                .join('') +
              `</div>`;
          }

          const reportFraudMsg = encodeURIComponent(
            `🚨 RIPOTI YA DHULUMA / TATIZO:\nNaomba kuripoti oda #${order.orderId} (${order.productName}) yenye thamani ya TSh ${Number(order.sellingPrice).toLocaleString()}. Tatizo ni: `
          );
          resultHtml = `
          <div style="background:white; padding:15px; border-radius:10px; box-shadow:0 2px 8px rgba(0,0,0,0.1); margin-top:20px;">
            <h3>Oda #${order.orderId} ✅</h3>
            <p><strong>📦 Bidhaa:</strong> ${escapeHtml(order.productName)}</p>
            <p><strong>💰 Bei:</strong> TSh ${Number(order.sellingPrice || 0).toLocaleString()}</p>
            <p><strong>📍 Eneo:</strong> ${escapeHtml(order.location)}</p>
            <p><strong>📞 Simu:</strong> ${escapeHtml(maskPhone(order.customerPhone))}</p>
            <p style="padding:8px 12px; background:#f0f0f0; border-radius:6px; font-weight:bold;">Status: ${statusBadge}</p>
            <a href="/track/invoice?id=${order.orderId}" target="_blank" style="background:#007bff; color:white; padding:10px; border-radius:6px; text-decoration:none; font-weight:bold; display:block; text-align:center; margin-top:10px;">📄 Tazama Risiti Yako (Digital Invoice)</a>
            ${reviewSection}
            ${publicReviewsHtml}
            <div style="margin-top:15px; text-align:center;">
              <a href="https://wa.me/${escapeHtml(botPhone)}?text=${reportFraudMsg}" target="_blank" rel="noopener noreferrer" style="color:#dc3545; font-size:12px; font-weight:bold;">🚨 Ripoti Dhuluma / Tatizo hapa</a>
            </div>
          </div>`;
        }
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
        * { box-sizing: border-box; }
        body { font-family: sans-serif; background: #f4f6f8; margin: 0; padding: 15px; }
        .container { max-width: 500px; margin: 0 auto; }
        .search-box { background: white; padding: 15px; border-radius: 10px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
        input { width: 100%; padding: 12px; border: 1px solid #ccc; border-radius: 6px; margin-bottom: 12px; }
        button { width: 100%; background: #007bff; color: white; border: none; padding: 12px; border-radius: 6px; font-weight: bold; cursor: pointer; }
      </style>
    </head>
    <body>
      <div class="container">
        <h1 style="text-align:center;">🔍 Fuatilia Oda Yako</h1>
        <div class="search-box">
          <form action="/track" method="GET">
            ${shopId ? `<input type="hidden" name="shop" value="${shopId}">` : ''}
            <input type="number" name="id" placeholder="Weka Namba ya Oda (mfano: 1)" value="${searchId || ''}" required>
            <button type="submit">Angalia Status</button>
          </form>
        </div>
        ${resultHtml}
        <a href="${backCatalogUrl}" style="display:block; text-align:center; margin-top:15px; color:#666; text-decoration:none;">← Rudi Kwenye Catalog</a>
      </div>
    </body>
    </html>
    `);
  } catch (err) {
    console.error('Track error:', err);
    res.status(500).send('Hitilafu imetokea.');
  }
});

app.post('/track/verify', rateLimitAuth(10, 15 * 60 * 1000), async (req, res) => {
  try {
    const oid = parseInt(req.body.orderId, 10);
    const inputPhone = (req.body.phone || '').trim();
    const shop = req.body.shop;
    const order = await db('orders').where({ orderId: oid }).first();
    if (!order) return res.redirect('/track');

    if (isSamePhone(order.customerPhone, inputPhone)) {
      if (!req.session.verifiedOrders) req.session.verifiedOrders = {};
      req.session.verifiedOrders[oid] = true;
      return res.redirect(`/track?id=${oid}${shop ? '&shop=' + shop : ''}`);
    }
    res.send(
      `<div style="text-align:center; padding:40px; font-family:sans-serif;"><h3 style="color:#dc3545;">❌ Namba ya Simu Si Sahihi!</h3><a href="/track?id=${oid}${shop ? '&shop=' + shop : ''}">Jaribu Tena</a></div>`
    );
  } catch (err) {
    res.redirect('/track');
  }
});

app.get('/track/invoice', async (req, res) => {
  try {
    const orderId = parseInt(req.query.id, 10);
    if (!orderId || !(req.session.verifiedOrders || {})[orderId]) {
      return res.redirect(`/track?id=${orderId || ''}`);
    }
    const order = await db('orders').where({ orderId }).first();
    if (!order) return res.send('❌ Oda haipatikani.');
    const winga = await db('wingas').where({ id: order.wingaId }).first();
    const shopLink = `${PUBLIC_URL}/catalog?shop=${winga ? winga.id : 1}`;
    res.send(
      `<!DOCTYPE html><html lang="sw"><head><meta charset="UTF-8"><title>Risiti #${order.orderId}</title><style>body{font-family:monospace;padding:20px;max-width:420px;margin:20px auto;border:1px solid #ddd;border-radius:8px;}.center{text-align:center;}hr{border:dashed 1px #888;}.btn-print{background:#007bff;color:white;border:none;padding:12px;width:100%;cursor:pointer;font-weight:bold;margin-top:20px;border-radius:6px;}@media print{.btn-print{display:none;}}</style></head><body><div class="center"><h2>🛍️ ${escapeHtml(winga ? winga.name : 'Winga Shop')}</h2><p>Simu: ${escapeHtml(winga ? winga.phone : '-')}</p><p style="font-size:12px;"><a href="${shopLink}">${shopLink}</a></p><hr><h3>RISITI YA MAUZO</h3></div><p><strong>Oda:</strong> #${order.orderId}</p><p><strong>Tarehe:</strong> ${new Date(order.date).toLocaleDateString('sw-TZ')}</p><p><strong>Simu:</strong> ${escapeHtml(order.customerPhone)}</p><p><strong>Eneo:</strong> ${escapeHtml(order.location)}</p><hr><p><strong>Bidhaa:</strong> ${escapeHtml(order.productName)}</p><p><strong>Bei:</strong> TSh ${Number(order.sellingPrice || 0).toLocaleString()}</p><hr><p class="center"><strong>Status:</strong> ${escapeHtml(order.status)}</p><button class="btn-print" onclick="window.print()">🖨️ Chapisha / PDF</button></body></html>`
    );
  } catch (err) {
    res.status(500).send('Hitilafu kwenye risiti.');
  }
});

app.post('/track/review', async (req, res) => {
  try {
    const oid = parseInt(req.body.orderId, 10);
    if (!(req.session.verifiedOrders || {})[oid]) {
      return res.redirect(`/track?id=${oid}`);
    }
    const rating = Math.max(1, Math.min(5, parseInt(req.body.rating, 10) || 5));
    const comment = (req.body.comment || '').trim();
    if (!comment) return res.redirect(`/track?id=${oid}`);

    const existing = await db('reviews').where({ orderId: oid }).first();
    if (existing) {
      await db('reviews').where({ orderId: oid }).update({
        rating,
        comment,
        date: new Date()
      });
    } else {
      await db('reviews').insert({
        orderId: oid,
        rating,
        comment,
        date: new Date()
      });
    }
    res.redirect(`/track?id=${oid}`);
  } catch (err) {
    console.error('Review submit error:', err);
    res.redirect('/track');
  }
});

// ==========================================
// LOGIN, REGISTER & LOGOUT
// ==========================================
app.get('/login', (req, res) => {
  if (req.session && req.session.isSuperAdmin) return res.redirect('/superadmin');
  if (req.session && req.session.wingaId) return res.redirect('/admin');

  res.send(`
  <!DOCTYPE html>
  <html lang="sw">
  <head>
    <meta charset="UTF-8">
    <title>Winga Portal Login</title>
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
      * { box-sizing: border-box; }
      body { font-family: sans-serif; background: rgb(106, 136, 232); display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; padding: 15px; }
      .login-box { background: white; padding: 25px; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.15); text-align: center; width: 100%; max-width: 340px; }
      input { padding: 11px; width: 100%; margin: 8px 0 14px 0; border: 1px solid #4092e5; border-radius: 4px; font-size: 15px; }
      .password-container { position: relative; width: 100%; margin: 8px 0 14px 0; }
      .password-container input { margin: 0; padding-right: 40px; }
      .eye-btn { position: absolute; right: 10px; top: 50%; transform: translateY(-50%); background: none; border: none; cursor: pointer; font-size: 16px; color: #666; padding: 0; }
      button.submit-btn { background: #28a745; color: white; border: none; padding: 12px; border-radius: 4px; cursor: pointer; font-size: 16px; width: 100%; font-weight: bold; }
      a { color: #007bff; text-decoration: none; font-size: 13px; display: block; margin-top: 10px; }
    </style>
  </head>
  <body>
    <div class="login-box">
      <h2 style="margin-top:0;">🛍️ Winga Portal Login</h2>
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

app.post('/login', rateLimitAuth(10, 15 * 60 * 1000), async (req, res) => {
  try {
    const identifier = (req.body.phone || '').trim();
    const password = (req.body.password || '').trim();

    if (isSuperAdminLogin(identifier, password)) {
      req.session.isSuperAdmin = true;
      req.session.superAdminPhone = normalizePhone(identifier);
      return res.redirect('/superadmin');
    }

    const wingas = await db('wingas').select('*');
    const matchedWinga = wingas.find(w => isSamePhone(w.phone, identifier));
    if (matchedWinga && (await bcrypt.compare(password, matchedWinga.password))) {
      req.session.wingaId = matchedWinga.id;
      req.session.wingaName = matchedWinga.name;
      return res.redirect('/admin');
    }

    res.send(
      '❌ Taarifa za kuingia sio sahihi. <br><a href="/login">Jaribu Tena</a>'
    );
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).send('Hitilafu ya Server.');
  }
});

app.get('/register', (req, res) => {
  res.send(`
  <!DOCTYPE html>
  <html lang="sw">
  <head>
    <meta charset="UTF-8">
    <title>Jisajili kama Muuzaji - Winga Shop</title>
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <script src="/tz-locations.js"></script>
    <style>
      * { box-sizing: border-box; }
      body { font-family: sans-serif; background: rgb(106, 136, 232); display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; padding: 15px; }
      .box { background: white; padding: 25px; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); width: 100%; max-width: 390px; }
      input, select { padding: 10px; width: 100%; margin: 5px 0 11px 0; border: 1px solid #4092e5; border-radius: 4px; font-size: 14px; }
      .password-container { position: relative; width: 100%; margin: 5px 0 11px 0; }
      .password-container input { margin: 0; padding-right: 40px; }
      .eye-btn { position: absolute; right: 10px; top: 50%; transform: translateY(-50%); background: none; border: none; cursor: pointer; font-size: 16px; color: #666; padding: 0; }
      label { display: block; text-align: left; font-size: 12px; font-weight: bold; color: #333; }
      button.submit-btn { background: #28a745; color: white; border: none; padding: 12px; border-radius: 4px; cursor: pointer; font-size: 16px; font-weight: bold; width: 100%; margin-top: 8px; }
      a { color: #007bff; text-decoration: none; font-size: 13px; display: block; text-align: center; margin-top: 15px; }
    </style>
  </head>
  <body>
    <div class="box">
      <h2 style="text-align:center; margin-top:0;">📝 Usajili wa Muuzaji</h2>
      <form action="/register" method="POST">
        <label>Jina la Duka / Lako:</label>
        <input type="text" name="name" placeholder="Mf: Boss Store" required>

        <label>Namba ya Simu (WhatsApp):</label>
        <input type="tel" name="phone" placeholder="0712345678" maxlength="10" oninput="this.value = this.value.replace(/[^0-9]/g, '').slice(0, 10)" required>

        <label>Chagua Mkoa (Mikoa Yote):</label>
        <select name="region" id="regRegion" required></select>

        <label>Chagua Wilaya:</label>
        <select name="district" id="regDistrict" required></select>

        <label>Chagua Kata:</label>
        <select name="ward" id="regWard" required></select>

        <label>Chagua Mtaa / Kijiji:</label>
        <select name="street" id="regStreet" required></select>
        <input type="text" name="customStreet" id="regCustomStreet" placeholder="Andika jina la mtaa / kijiji..." style="display:none;">

        <label>Weka Nenosiri (Password):</label>
        <div class="password-container">
          <input type="password" name="password" id="regPassword" placeholder="••••••••" required>
          <button type="button" class="eye-btn" onclick="togglePassword('regPassword', this)">👁️</button>
        </div>

        <button type="submit" class="submit-btn">Jisajili Sasa</button>
      </form>
      <a href="/login">← Tayari una akaunti? Ingia hapa</a>
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
      window.addEventListener('DOMContentLoaded', () => {
        if (typeof window.initTzLocation === 'function') {
          window.initTzLocation('regRegion', 'regDistrict', 'regWard', 'regStreet', 'regCustomStreet');
        }
      });
    </script>
  </body>
  </html>
  `);
});

app.post('/register', async (req, res) => {
  try {
    const name = (req.body.name || '').trim();
    const phone = (req.body.phone || '').trim();
    const fullLocation = buildLocationString(
      req.body.region,
      req.body.district,
      req.body.ward,
      req.body.street,
      req.body.customStreet
    );
    const password = (req.body.password || '').trim();

    if (!name || !phone || !fullLocation || !password) {
      return res.send(
        '❌ Tafadhali jaza taarifa zote na eneo kamili. <br><a href="/register">Jaribu Tena</a>'
      );
    }

    const existingWingas = await db('wingas').select('*');
    if (existingWingas.some(w => isSamePhone(w.phone, phone))) {
      return res.send(
        '❌ Namba hii ya simu tayari imesajiliwa! <br><a href="/login">Ingia Hapa</a>'
      );
    }

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
      <p>Akaunti yako ya duka yenye eneo la <strong>${escapeHtml(fullLocation)}</strong> imetengenezwa.</p>
      <a href="/login" style="padding:10px 20px; background:#007bff; color:white; text-decoration:none; border-radius:5px; display:inline-block; margin-top:15px;">Ingia Kwenye Dashboard Yako</a>
    </div>
    `);
  } catch (err) {
    console.error('Registration error:', err);
    res.status(500).send(`❌ Hitilafu ya Server: ${escapeHtml(err.message)}`);
  }
});

app.all('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    return res.redirect('/login');
  });
});

// ==========================================
// SELLER DASHBOARD (/admin)
// ==========================================
app.get('/admin', requireWinga, async (req, res) => {
  try {
    const currentWinga = await db('wingas').where({ id: req.session.wingaId }).first();
    const botPhone = process.env.BOT_PHONE_NUMBER || '255678143403';

    if (currentWinga && currentWinga.status === 'suspended') {
      const renewalMsg = encodeURIComponent(
        `Habari Admin, nimefanya malipo ya siku 30 ya duka langu (${currentWinga.name} - ${currentWinga.phone}). Naomba unifungulie akaunti yangu.`
      );
      return res.send(`
      <!DOCTYPE html>
      <html lang="sw">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Akaunti Imesitishwa</title>
        <style>
          body { font-family: sans-serif; background: #f8f9fa; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; padding: 20px; text-align: center; }
          .box { background: white; padding: 30px 20px; border-radius: 10px; box-shadow: 0 4px 15px rgba(0,0,0,0.1); max-width: 400px; width: 100%; }
          h1 { color: #dc3545; font-size: 22px; margin-top: 0; }
          p { color: #555; font-size: 14px; line-height: 1.5; }
          .whatsapp-btn { background: #25D366; color: white; padding: 12px 20px; border-radius: 6px; text-decoration: none; font-weight: bold; display: inline-block; margin-top: 15px; font-size: 15px; width: 100%; }
          .logout-link { display: block; margin-top: 20px; color: #007bff; text-decoration: none; font-size: 13px; }
        </style>
      </head>
      <body>
        <div class="box">
          <h1>⚠️ Akaunti Imesitishwa</h1>
          <p>Muda wako wa siku 30 za matumizi umekwisha. Hauruhusiwi kuingiza bidhaa mpya au kupokea oda mpya mpaka pale akaunti itakapohuishwa.</p>
          <p>Tafadhali fanya malipo kupitia namba ya Admin na ubofye kitufe hapa chini kumtumia ujumbe wa WhatsApp ili akufungulie akaunti yako mara moja.</p>
          <a href="https://wa.me/${escapeHtml(botPhone)}?text=${renewalMsg}" target="_blank" rel="noopener noreferrer" class="whatsapp-btn">💬 Wasiliana na Admin (WhatsApp)</a>
          <a href="/logout" class="logout-link">Rudi Kwenye Login</a>
        </div>
      </body>
      </html>
      `);
    }

    const currentWingaId = req.session.wingaId;
    const currentWingaName = req.session.wingaName;
    const products = await db('products')
      .where({ wingaId: currentWingaId })
      .orderBy('id', 'desc');
    const orders = await db('orders')
      .where({ wingaId: currentWingaId })
      .orderBy('orderId', 'desc');
    const reviews = await db('reviews').select('*');

    let subscriptionBanner = '';
    if (currentWinga && currentWinga.expiryDate) {
      const expiryDate = new Date(currentWinga.expiryDate);
      const today = new Date();
      const daysLeft = Math.ceil((expiryDate - today) / (1000 * 60 * 60 * 24));
      const formattedExpiry = expiryDate.toLocaleDateString('sw-TZ', {
        day: 'numeric',
        month: 'short',
        year: 'numeric'
      });

      if (daysLeft <= 5) {
        const renewalMsg = encodeURIComponent(
          `Habari Admin, naomba niongezewe siku 30 za duka langu (${currentWinga.name}).`
        );
        subscriptionBanner = `
        <div style="background: #fff3cd; color: #856404; border: 1px solid #ffeeba; padding: 12px; border-radius: 8px; margin-bottom: 15px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px; font-size: 13px;">
          <span>⚠️ Umebakisha <strong>siku ${daysLeft > 0 ? daysLeft : 0}</strong> (Inaisha: ${formattedExpiry}). Wasiliana na Admin kuongeza siku!</span>
          <a href="https://wa.me/${escapeHtml(botPhone)}?text=${renewalMsg}" target="_blank" rel="noopener noreferrer" style="background: #25D366; color: white; padding: 6px 12px; border-radius: 5px; text-decoration: none; font-size: 12px; font-weight: bold;">💬 Ongeza Siku WhatsApp</a>
        </div>`;
      } else {
        subscriptionBanner = `
        <div style="background: #e8f5e9; color: #2e7d32; border: 1px solid #c8e6c9; padding: 12px; border-radius: 8px; margin-bottom: 15px; font-size: 13px;">
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
          const matchedProduct = findMatchedProductForOrder(o, products);
          buying = matchedProduct ? Number(matchedProduct.buyingPrice || 0) : 0;
        }
        totalRevenue += selling;
        totalCost += buying;
        completedOrdersCount++;
      }
    });
    const netProfit = totalRevenue - totalCost;
    const shopUrl = `${PUBLIC_URL}/catalog?shop=${currentWingaId}`;
    const shareWhatsAppText = encodeURIComponent(
      `Habari! Karibu utazame bidhaa na uagize kupitia duka langu hapa:\n${shopUrl}`
    );

    let orderRows = orders
      .map(o => {
        const currentStatus = o.status || 'Pending';
        const rev = reviews.find(r => Number(r.orderId) === Number(o.orderId));
        let badgeStyle = 'background:#ffc107; color:#000;';
        if (currentStatus === 'Dispatched') badgeStyle = 'background:#17a2b8; color:#fff;';
        if (currentStatus === 'Completed') badgeStyle = 'background:#28a745; color:#fff;';

        const matchedProduct = findMatchedProductForOrder(o, products);
        let productImgHtml = '📦';
        if (matchedProduct) {
          const images = getProductImages(matchedProduct);
          if (images.length > 0) {
            const thumbHtml = images
              .map(
                img =>
                  `<img src="${escapeHtml(img)}" data-zoom="${escapeHtml(img)}" onclick="openModal(this.getAttribute('data-zoom'))" title="Bonyeza kukuza" style="width: 34px; height: 34px; object-fit: cover; border-radius: 4px; border: 1px solid #ccc; cursor: pointer; flex-shrink: 0;">`
              )
              .join('');
            productImgHtml = `<div style="display: flex; gap: 4px; align-items: center; max-width: 110px; overflow-x: auto;">${thumbHtml}</div>`;
          }
        }

        let reviewCell = rev
          ? `${'⭐'.repeat(Math.max(1, Math.min(5, Number(rev.rating) || 5)))}<br><small>"${escapeHtml(rev.comment)}"</small>`
          : '<em style="color:#999; font-size:12px;">Hamna feedback</em>';

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
      })
      .join('');

    let productRows = products
      .map(p => {
        const images = getProductImages(p);
        let productImgHtml = '📦';
        if (images.length > 0) {
          const thumbHtml = images
            .map(
              img =>
                `<img src="${escapeHtml(img)}" data-zoom="${escapeHtml(img)}" onclick="openModal(this.getAttribute('data-zoom'))" title="Bonyeza kukuza" style="width: 34px; height: 34px; object-fit: cover; border-radius: 4px; border: 1px solid #ccc; cursor: pointer; flex-shrink: 0;">`
            )
            .join('');
          productImgHtml = `<div style="display: flex; gap: 4px; align-items: center;">${thumbHtml}</div>`;
        }

        const editData = escapeHtml(
          JSON.stringify({
            id: p.id,
            name: p.name || '',
            category: p.category || 'General / Vinginevyo',
            buyingPrice: Number(p.buyingPrice || 0),
            sellingPrice: Number(p.sellingPrice || p.price || 0),
            size: p.size || 'Standard',
            colors: p.colors || 'Kama pichani',
            images
          })
        );

        return `
        <tr class="seller-product-row">
          <td><strong>#${p.id}</strong></td>
          <td>${productImgHtml}</td>
          <td class="prod-name">${escapeHtml(p.name)}</td>
          <td class="prod-cat">${escapeHtml(p.category || 'General')}</td>
          <td>TSh ${Number(p.buyingPrice || 0).toLocaleString()}</td>
          <td>TSh ${Number(p.sellingPrice || p.price || 0).toLocaleString()}</td>
          <td>${escapeHtml(p.size || 'Standard')}</td>
          <td>${escapeHtml(p.colors || 'Kama pichani')}</td>
          <td>
            <div style="display:flex; gap:5px; align-items:center;">
              <button type="button" class="edit-prod-btn" data-edit="${editData}" style="background:#007bff; color:white; border:none; padding:4px 8px; border-radius:4px; font-size:11px; font-weight:bold; cursor:pointer;">✏️ Edit</button>
              <form action="/admin/product/delete" method="POST" onsubmit="return confirm('Una uhakika unataka kufuta bidhaa hii?');" style="display:inline;">
                <input type="hidden" name="id" value="${p.id}">
                <button type="submit" style="background:#dc3545; color:white; border:none; padding:4px 8px; border-radius:4px; font-size:11px; cursor:pointer;">🗑️ Delete</button>
              </form>
            </div>
          </td>
        </tr>`;
      })
      .join('');

    let alertMessage = '';
    if (req.query.added === 'true') {
      alertMessage = `<div style="background: #d4edda; color: #155724; border: 1px solid #c3e6cb; padding: 10px 15px; border-radius: 6px; margin-bottom: 15px; font-weight: bold; font-size: 13px; display:flex; justify-content:space-between;"><span>✅ Bidhaa mpya imefanikiwa kuongezwa!</span><span onclick="this.parentElement.style.display='none'" style="cursor:pointer;">&times;</span></div>`;
    } else if (req.query.updated === 'true') {
      alertMessage = `<div style="background: #d4edda; color: #155724; border: 1px solid #c3e6cb; padding: 10px 15px; border-radius: 6px; margin-bottom: 15px; font-weight: bold; font-size: 13px; display:flex; justify-content:space-between;"><span>✅ Bidhaa imehaririwa na kuhifadhiwa kikamilifu!</span><span onclick="this.parentElement.style.display='none'" style="cursor:pointer;">&times;</span></div>`;
    } else if (req.query.error === 'upload') {
      const reason = req.query.reason ? ` (${escapeHtml(req.query.reason)})` : '';
      alertMessage = `<div style="background: #f8d7da; color: #721c24; border: 1px solid #f5c6cb; padding: 10px 15px; border-radius: 6px; margin-bottom: 15px; font-weight: bold; font-size: 13px; display:flex; justify-content:space-between;"><span>❌ Hitilafu ya kupakia picha${reason}. Jaribu tena.</span><span onclick="this.parentElement.style.display='none'" style="cursor:pointer;">&times;</span></div>`;
    }

    const availableColorChoices = [
      'Nyeusi (Black)',
      'Nyeupe (White)',
      'Nyekundu (Red)',
      'Bluu (Blue)',
      'Kijani (Green)',
      'Njano (Yellow)',
      'Brown / Kahawia',
      'Grey / Kijivu',
      'Pink',
      'Gold',
      'Silver',
      'Mchanganyiko (Multi-color)'
    ];
    const colorCheckboxesHtml = availableColorChoices
      .map(
        col => `
      <label style="display:inline-flex; align-items:center; gap:5px; font-weight:normal; font-size:12px; background:#f8f9fa; padding:5px 9px; border-radius:6px; border:1px solid #ddd; cursor:pointer;">
        <input type="checkbox" name="colors" value="${escapeHtml(col)}" style="width:auto; margin:0;"> ${escapeHtml(col)}
      </label>
    `
      )
      .join('');

    const editColorCheckboxesHtml = availableColorChoices
      .map(
        col => `
      <label style="display:inline-flex; align-items:center; gap:5px; font-weight:normal; font-size:12px; background:#f8f9fa; padding:5px 8px; border-radius:6px; border:1px solid #ddd; cursor:pointer;">
        <input type="checkbox" class="edit-color-cb" name="colors" value="${escapeHtml(col)}" style="width:auto; margin:0;"> ${escapeHtml(col)}
      </label>
    `
      )
      .join('');

    res.send(`
    <!DOCTYPE html>
    <html lang="sw">
    <head>
      <title>Winga Dashboard - ${escapeHtml(currentWingaName)}</title>
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <style>
        * { box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 0; padding: 12px; background: #f4f6f8; color: #333; }
        .container { max-width: 1100px; margin: 0 auto; }
        .top-nav { display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; flex-wrap: wrap; gap: 10px; }
        .admin-nav-btns { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
        .contact-support { background: #25D366; color: white; border: none; padding: 8px 12px; border-radius: 6px; font-weight: bold; text-decoration: none; font-size: 12px; display: inline-flex; align-items: center; gap: 4px; cursor: pointer; }
        .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 20px; }
        .stat-card { background: white; padding: 15px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.05); }
        .stat-card h3 { margin: 0; font-size: 11px; color: #666; text-transform: uppercase; }
        .stat-card p { margin: 6px 0 0 0; font-size: 20px; font-weight: bold; color: #111; }
        .card { background: white; padding: 16px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); margin-bottom: 20px; }
        .form-group { margin-bottom: 12px; }
        .form-row { display: grid; grid-template-columns: 1fr; gap: 12px; }
        @media(min-width: 600px) { .form-row { grid-template-columns: 1fr 1fr; gap: 15px; } }
        label { display: block; margin-bottom: 4px; font-weight: 600; font-size: 12px; }
        input[type="text"], input[type="number"], input[type="file"], input[type="password"], select { width: 100%; padding: 10px; border: 1px solid #ccc; border-radius: 4px; font-size: 14px; background: white; }
        .password-container { position: relative; width: 100%; }
        .password-container input { padding-right: 40px; }
        .eye-btn { position: absolute; right: 10px; top: 50%; transform: translateY(-50%); background: none; border: none; cursor: pointer; font-size: 16px; color: #666; padding: 0; }
        button.btn-add { background: #28a745; color: white; border: none; padding: 12px; border-radius: 4px; font-weight: bold; cursor: pointer; width: 100%; font-size: 15px; }
        .table-responsive { width: 100%; overflow-x: auto; }
        table { width: 100%; border-collapse: collapse; margin-top: 10px; min-width: 650px; font-size: 13px; }
        th, td { text-align: left; padding: 10px; border-bottom: 1px solid #eee; white-space: nowrap; }
        th { background: #f8f9fa; font-size: 12px; }
        .modal-overlay { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.6); justify-content: center; align-items: center; z-index: 1000; padding: 10px; }
        .modal-content { background: white; padding: 20px; border-radius: 12px; width: 100%; max-width: 480px; max-height: 92vh; overflow-y: auto; box-shadow: 0 4px 20px rgba(0,0,0,0.2); position: relative; }
        .close-btn { position: absolute; top: 12px; right: 15px; font-size: 24px; cursor: pointer; color: #aaa; border: none; background: none; }
        .preview-grid { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
        .preview-thumb { width: 68px; height: 68px; object-fit: cover; border-radius: 6px; border: 1px solid #ccc; }
      </style>
    </head>
    <body>
      <div class="container">
        ${alertMessage}
        ${subscriptionBanner}
        <div class="top-nav">
          <h1 style="margin:0; font-size:20px;">🛍️ Winga Dashboard - ${escapeHtml(currentWingaName)}</h1>
          <div class="admin-nav-btns">
            <button type="button" class="contact-support" onclick="toggleAdminLanguage()" id="adminLangBtn" style="background:#6c757d;">🌐 SW / EN</button>
            <button type="button" class="contact-support" onclick="openAdminHelp()" style="background:#17a2b8;" id="adminHelpBtn">❓ Msaada / FAQs</button>
            <a href="https://wa.me/${escapeHtml(botPhone)}?text=Habari%20Admin" target="_blank" rel="noopener noreferrer" class="contact-support" id="adminContactBtn">💬 Msaada</a>
            <a href="/logout" style="color:#dc3545; font-weight:bold; text-decoration:none; font-size:13px;" id="adminLogoutBtn">Logout</a>
          </div>
        </div>

        <div id="adminHelpModal" class="modal-overlay">
          <div class="modal-content">
            <button type="button" class="close-btn" onclick="closeAdminHelp()">&times;</button>
            <h3 style="margin-top:0; color:#111; font-size:18px;" id="adminHelpTitle">❓ Mwongozo wa Muuzaji (Winga Guide)</h3>
            <div style="font-size: 13px; color: #444; line-height: 1.5; text-align: left;">
              <p><strong>1. Kuweka Bidhaa Mpya:</strong><br>Jaza fomu ya bidhaa, chagua rangi zilizopo na picha hadi 4, kisha bofya "Upload & Add to Catalog".</p>
              <p><strong>2. Kuhariri Bidhaa:</strong><br>Bonyeza "✏️ Edit" kwenye bidhaa yoyote kwenye orodha yako kubadili jina, bei, rangi, saizi au picha.</p>
              <p><strong>3. Kusimamia Oda:</strong><br>Badilisha status kuwa "Dispatched" au "Completed" ili mteja aweze kutoa maoni/nyota.</p>
            </div>
          </div>
        </div>

        <div id="editProductModal" class="modal-overlay">
          <div class="modal-content">
            <button type="button" class="close-btn" onclick="closeEditModal()">&times;</button>
            <h3 style="margin-top:0; color:#111; font-size:18px;">✏️ Hariri Bidhaa</h3>
            <form action="/admin/product/edit" method="POST" enctype="multipart/form-data" id="editProductForm">
              <input type="hidden" name="id" id="editProdId">
              <div class="form-group">
                <label>Jina la Bidhaa</label>
                <input type="text" name="name" id="editProdName" required>
              </div>
              <div class="form-group">
                <label>Aina (Category)</label>
                <select name="category" id="editProdCategory" required>
                  <option value="Clothes">Nguo (Clothes)</option>
                  <option value="Bags">Mifuko / Mikoba (Bags)</option>
                  <option value="Shoes (Men & Women)">Viatu - Wanaume na Wanawake (Shoes)</option>
                  <option value="Electronics (Phones, Laptops, TV, Accessories)">Vifaa vya Kielektroniki (Simu, Laptops, TV)</option>
                  <option value="Cosmetics, Perfumes & Lotions">Mafuta, Losheni & Perfume (Cosmetics)</option>
                  <option value="Car Accessories">Vifaa vya Gari (Car Accessories)</option>
                  <option value="General / Vinginevyo">Vinginevyo (General)</option>
                </select>
              </div>
              <div class="form-row">
                <div class="form-group">
                  <label>Bei ya Kununua (TSh)</label>
                  <input type="number" name="buyingPrice" id="editProdBuying" required>
                </div>
                <div class="form-group">
                  <label>Bei ya Kuuzia (TSh)</label>
                  <input type="number" name="sellingPrice" id="editProdSelling" required>
                </div>
              </div>
              <div class="form-group">
                <label>Available Sizes</label>
                <input type="text" name="size" id="editProdSize" required>
              </div>
              <div class="form-group">
                <label>🎨 Rangi Zilizopo:</label>
                <div style="display:flex; flex-wrap:wrap; gap:6px; margin-bottom:8px;">
                  ${editColorCheckboxesHtml}
                </div>
                <input type="text" name="customColors" id="editProdCustomColors" placeholder="Rangi nyingine (tenganisha kwa koma)">
              </div>
              <div class="form-group">
                <label>Picha za Sasa:</label>
                <div id="editCurrentImages" class="preview-grid"></div>
              </div>
              <div class="form-group">
                <label>Badilisha Picha (Hiari - Max 4 mpya):</label>
                <input type="file" name="images" id="editImageInput" accept="image/*" multiple onchange="previewEditImages(this)">
                <div id="editNewImagePreview" class="preview-grid"></div>
              </div>
              <button type="submit" class="btn-add" style="background:#007bff;">💾 Hifadhi Mabadiliko</button>
            </form>
          </div>
        </div>

        <div class="stats-grid">
          <div class="stat-card"><h3 id="statProducts">Bidhaa Zangu</h3><p>${products.length}</p></div>
          <div class="stat-card"><h3 id="statTotalOrders">Jumla ya Oda</h3><p>${orders.length}</p></div>
          <div class="stat-card"><h3 id="statCompleted">Completed Orders</h3><p>${completedOrdersCount}</p></div>
          <div class="stat-card"><h3 id="statRevenue">Total Revenue</h3><p>TSh ${totalRevenue.toLocaleString()}</p></div>
          <div class="stat-card"><h3 id="statProfit">Net Profit</h3><p style="color:#28a745;">TSh ${netProfit.toLocaleString()}</p></div>
        </div>

        <div class="card">
          <h2 style="margin-top:0; font-size:18px;" id="addProductTitle">➕ Weka Bidhaa Mpya (Max Picha 4)</h2>
          <form action="/admin/add" method="POST" enctype="multipart/form-data">
            <div class="form-row">
              <div class="form-group"><label id="lblProdName">Jina la Bidhaa</label><input type="text" name="name" placeholder="Mf: Smart Watch S8 au Gauni Kali" required></div>
              <div class="form-group">
                <label id="lblCategory">Aina (Category)</label>
                <select name="category" required>
                  <option value="">-- Chagua Aina ya Bidhaa --</option>
                  <option value="Clothes">Nguo (Clothes)</option>
                  <option value="Bags">Mifuko / Mikoba (Bags)</option>
                  <option value="Shoes (Men & Women)">Viatu - Wanaume na Wanawake (Shoes)</option>
                  <option value="Electronics (Phones, Laptops, TV, Accessories)">Vifaa vya Kielektroniki (Simu, Laptops, TV)</option>
                  <option value="Cosmetics, Perfumes & Lotions">Mafuta, Losheni & Perfume (Cosmetics)</option>
                  <option value="Car Accessories">Vifaa vya Gari (Car Accessories)</option>
                  <option value="General / Vinginevyo">Vinginevyo (General)</option>
                </select>
              </div>
            </div>
            <div class="form-row">
              <div class="form-group"><label id="lblBuying">Bei ya Kununua (Buying Price - TSh)</label><input type="number" name="buyingPrice" required></div>
              <div class="form-group"><label id="lblSelling">Bei ya Kuuzia (Selling Price - TSh)</label><input type="number" name="sellingPrice" required></div>
            </div>
            <div class="form-group">
              <label id="lblSizeAdmin">Available Sizes (Mf: S, M, L, XL au Standard)</label>
              <input type="text" name="size" value="Standard">
            </div>
            <div class="form-group">
              <label id="lblColorAdmin">🎨 Chagua Rangi Zilizopo (Unaweza kuchagua zaidi ya moja):</label>
              <div style="display:flex; flex-wrap:wrap; gap:6px; margin-bottom:8px;">
                ${colorCheckboxesHtml}
              </div>
              <input type="text" name="customColors" placeholder="Au andika rangi nyingine hapa (tenganisha kwa koma, mf: Maroon, Cream)">
            </div>
            <div class="form-group">
              <label id="lblImagesAdmin">Picha za Bidhaa (Max 4)</label>
              <input type="file" id="imageInput" name="images" accept="image/*" multiple required onchange="validateAndPreviewImages(this)">
              <small id="fileCountNotice" style="color: #007bff; font-weight: bold; display: block; margin-top: 4px; font-size: 11px;"></small>
              <div id="addImagePreview" class="preview-grid"></div>
            </div>
            <button type="submit" class="btn-add" id="uploadBtn">Upload & Add to Catalog</button>
          </form>
        </div>

        <div class="card" style="background: #e3f2fd; border: 1px solid #90caf9;">
          <h3 style="margin-top: 0; color: #0d47a1; font-size: 16px;" id="storeLinkTitle">🔗 Link Yako ya Duka (Store Link)</h3>
          <div style="display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px;">
            <input type="text" id="storeLinkInput" value="${escapeHtml(shopUrl)}" readonly style="flex: 1; min-width: 200px; padding: 10px; border: 1px solid #90caf9; border-radius: 4px; font-weight: bold; color: #0d47a1; background: white; font-size: 13px;">
            <button type="button" onclick="copyStoreLink()" style="background: #007bff; color: white; border: none; padding: 10px 15px; border-radius: 4px; font-weight: bold; cursor: pointer; font-size: 13px;" id="copyLinkBtn">📋 Nakili Link</button>
          </div>
          <a href="https://wa.me/?text=${shareWhatsAppText}" target="_blank" rel="noopener noreferrer" style="background: #25D366; color: white; padding: 10px 15px; border-radius: 6px; text-decoration: none; font-weight: bold; font-size: 13px; display: inline-block;" id="shareWaBtn">📲 Share to WhatsApp</a>
        </div>

        <div class="card">
          <h2 style="margin-top:0; font-size:18px;" id="ordersTitle">🛒 Customer Orders & Reviews (${orders.length})</h2>
          <div class="table-responsive">
            <table>
              <thead><tr><th>Photo</th><th>Order #</th><th>Product</th><th>Price</th><th>Location</th><th>Phone</th><th>Status</th><th>Feedback</th><th>Action</th></tr></thead>
              <tbody>${orderRows || '<tr><td colspan="9">No orders placed yet.</td></tr>'}</tbody>
            </table>
          </div>
        </div>

        <div class="card">
          <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px; margin-bottom:15px;">
            <h2 style="margin:0; font-size:18px;" id="catalogTitle">📦 Product Catalog (${products.length})</h2>
            <input type="text" id="sellerSearchInput" onkeyup="filterSellerProducts()" placeholder="🔍 Tafuta bidhaa zako..." style="max-width:250px; padding:8px; border:1px solid #ccc; border-radius:6px; font-size:13px;">
          </div>
          <div class="table-responsive">
            <table>
              <thead><tr><th>ID</th><th>Photos</th><th>Name</th><th>Category</th><th>Buying Price</th><th>Selling Price</th><th>Size</th><th>Colors</th><th>Action</th></tr></thead>
              <tbody id="sellerProductTable">${productRows || '<tr><td colspan="9">No products added yet.</td></tr>'}</tbody>
            </table>
          </div>
        </div>

        <div class="card">
          <h3 style="margin-top:0; font-size:16px;" id="changePassTitle">🔑 Badilisha Nenosiri (Change Password)</h3>
          <form id="changePasswordForm">
            <div class="form-row">
              <div class="form-group">
                <label id="lblOldPass">Nenosiri la Zamani:</label>
                <div class="password-container">
                  <input type="password" id="oldPassword" required>
                  <button type="button" class="eye-btn" onclick="togglePassword('oldPassword', this)">👁️</button>
                </div>
              </div>
              <div class="form-group">
                <label id="lblNewPass">Nenosiri Jipya:</label>
                <div class="password-container">
                  <input type="password" id="newPassword" required>
                  <button type="button" class="eye-btn" onclick="togglePassword('newPassword', this)">👁️</button>
                </div>
              </div>
            </div>
            <div class="form-group">
              <label id="lblConfirmPass">Rudia Nenosiri Jipya:</label>
              <div class="password-container">
                <input type="password" id="confirmPassword" required>
                <button type="button" class="eye-btn" onclick="togglePassword('confirmPassword', this)">👁️</button>
              </div>
            </div>
            <button type="submit" style="background:#007bff; color:white; border:none; padding:11px; border-radius:4px; font-weight:bold; cursor:pointer; width:100%;" id="savePassBtn">Hifadhi Nenosiri Jipya</button>
          </form>
        </div>
      </div>

      <div id="imgModal" onclick="closeModal()" style="display: none; position: fixed; z-index: 9999; left: 0; top: 0; width: 100%; height: 100%; background-color: rgba(0,0,0,0.85); justify-content: center; align-items: center; cursor: pointer;">
        <span style="position: absolute; top: 15px; right: 25px; color: #fff; font-size: 35px; font-weight: bold;">&times;</span>
        <img id="modalImage" style="max-width: 85%; max-height: 85%; border-radius: 8px; object-fit: contain;">
      </div>

      <script>
        const KNOWN_COLORS = ${JSON.stringify(availableColorChoices)};

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
        function openAdminHelp() { document.getElementById('adminHelpModal').style.display = 'flex'; }
        function closeAdminHelp() { document.getElementById('adminHelpModal').style.display = 'none'; }
        function closeEditModal() { document.getElementById('editProductModal').style.display = 'none'; }

        function copyStoreLink() {
          var copyText = document.getElementById("storeLinkInput");
          copyText.select();
          navigator.clipboard.writeText(copyText.value);
          alert("✅ Link imenakiliwa!");
        }

        function renderThumbnails(files, containerId) {
          const container = document.getElementById(containerId);
          container.innerHTML = '';
          Array.from(files || []).forEach(file => {
            const url = URL.createObjectURL(file);
            const img = document.createElement('img');
            img.src = url;
            img.className = 'preview-thumb';
            img.onload = () => URL.revokeObjectURL(url);
            container.appendChild(img);
          });
        }

        function validateAndPreviewImages(input) {
          const notice = document.getElementById('fileCountNotice');
          const preview = document.getElementById('addImagePreview');
          if (input.files.length > 4) {
            alert('❌ Unaruhusiwa kuchagua picha zisizozidi 4 pekee.');
            input.value = '';
            notice.innerText = '';
            preview.innerHTML = '';
          } else if (input.files.length > 0) {
            notice.innerText = '✅ Umechagua picha ' + input.files.length + ' kati ya 4 (Preview hapa chini):';
            renderThumbnails(input.files, 'addImagePreview');
          } else {
            notice.innerText = '';
            preview.innerHTML = '';
          }
        }

        function previewEditImages(input) {
          const preview = document.getElementById('editNewImagePreview');
          if (input.files.length > 4) {
            alert('❌ Unaruhusiwa kuchagua picha zisizozidi 4 pekee.');
            input.value = '';
            preview.innerHTML = '';
            return;
          }
          renderThumbnails(input.files, 'editNewImagePreview');
        }

        document.querySelectorAll('.edit-prod-btn').forEach(btn => {
          btn.addEventListener('click', function() {
            const raw = this.getAttribute('data-edit');
            if (!raw) return;
            const p = JSON.parse(raw);

            document.getElementById('editProdId').value = p.id;
            document.getElementById('editProdName').value = p.name || '';
            const catSel = document.getElementById('editProdCategory');
            catSel.value = p.category || 'General / Vinginevyo';
            if (!catSel.value) catSel.value = 'General / Vinginevyo';
            document.getElementById('editProdBuying').value = p.buyingPrice || 0;
            document.getElementById('editProdSelling').value = p.sellingPrice || 0;
            document.getElementById('editProdSize').value = p.size || 'Standard';
            document.getElementById('editImageInput').value = '';
            document.getElementById('editNewImagePreview').innerHTML = '';

            const existingCols = (p.colors || '').split(',').map(c => c.trim()).filter(Boolean);
            const matchedKnown = [];
            const customOnly = [];
            existingCols.forEach(c => {
              if (KNOWN_COLORS.includes(c)) matchedKnown.push(c);
              else if (c.toLowerCase() !== 'kama pichani') customOnly.push(c);
            });

            document.querySelectorAll('.edit-color-cb').forEach(cb => {
              cb.checked = matchedKnown.includes(cb.value);
            });
            document.getElementById('editProdCustomColors').value = customOnly.join(', ');

            const curImgsBox = document.getElementById('editCurrentImages');
            if (p.images && p.images.length > 0) {
              curImgsBox.innerHTML = p.images.map(u => '<img src="' + u + '" class="preview-thumb">').join('');
            } else {
              curImgsBox.innerHTML = '<small style="color:#777;">Hakuna picha iliyohifadhiwa.</small>';
            }

            document.getElementById('editProductModal').style.display = 'flex';
          });
        });

        function filterSellerProducts() {
          var input = document.getElementById('sellerSearchInput').value.toLowerCase().trim();
          document.querySelectorAll('#sellerProductTable tr.seller-product-row').forEach(function(row) {
            var name = row.querySelector('.prod-name').innerText.toLowerCase();
            var cat = row.querySelector('.prod-cat').innerText.toLowerCase();
            row.style.display = (name.indexOf(input) !== -1 || cat.indexOf(input) !== -1) ? '' : 'none';
          });
        }
        function openModal(src) { document.getElementById('modalImage').src = src; document.getElementById('imgModal').style.display = 'flex'; }
        function closeModal() { document.getElementById('imgModal').style.display = 'none'; }

        var adminLang = localStorage.getItem('winga_admin_lang') || 'sw';
        const adminTrans = {
          sw: {
            adminHelp: "❓ Msaada / FAQs",
            contact: "💬 Msaada",
            logout: "Logout",
            storeTitle: "🔗 Link Yako ya Duka (Store Link)",
            copyBtn: "📋 Nakili Link",
            shareBtn: "📲 Share to WhatsApp",
            changePass: "🔑 Badilisha Nenosiri (Change Password)",
            oldPass: "Nenosiri la Zamani:",
            newPass: "Nenosiri Jipya:",
            confirmPass: "Rudia Nenosiri Jipya:",
            saveBtn: "Hifadhi Nenosiri Jipya",
            stat1: "Completed Orders",
            stat2: "Total Revenue",
            stat3: "Net Profit",
            addTitle: "➕ Weka Bidhaa Mpya (Max Picha 4)",
            pName: "Jina la Bidhaa",
            cat: "Aina (Category)",
            buy: "Bei ya Kununua (Buying Price - TSh)",
            sell: "Bei ya Kuuzia (Selling Price - TSh)",
            sizeA: "Available Sizes (Mf: S, M, L, XL au Standard)",
            colA: "🎨 Chagua Rangi Zilizopo (Unaweza kuchagua zaidi ya moja):",
            imgA: "Picha za Bidhaa (Max 4)",
            upBtn: "Upload & Add to Catalog",
            searchP: "🔍 Tafuta bidhaa zako..."
          },
          en: {
            adminHelp: "❓ Help / FAQs",
            contact: "💬 Support",
            logout: "Logout",
            storeTitle: "🔗 Your Store Link",
            copyBtn: "📋 Copy Link",
            shareBtn: "📲 Share to WhatsApp",
            changePass: "🔑 Change Password",
            oldPass: "Old Password:",
            newPass: "New Password:",
            confirmPass: "Confirm New Password:",
            saveBtn: "Save New Password",
            stat1: "Completed Orders",
            stat2: "Total Revenue",
            stat3: "Net Profit",
            addTitle: "➕ Add New Product (Max 4 Images)",
            pName: "Product Name",
            cat: "Category",
            buy: "Buying Price (TSh)",
            sell: "Selling Price (TSh)",
            sizeA: "Available Sizes (e.g., S, M, L, Standard)",
            colA: "🎨 Available Colors (Select multiple):",
            imgA: "Product Images (Max 4)",
            upBtn: "Upload & Add to Catalog",
            searchP: "🔍 Search your products..."
          }
        };

        function applyAdminLang() {
          const t = adminTrans[adminLang];
          document.getElementById('adminHelpBtn').textContent = t.adminHelp;
          document.getElementById('adminContactBtn').textContent = t.contact;
          document.getElementById('adminLogoutBtn').textContent = t.logout;
          document.getElementById('storeLinkTitle').textContent = t.storeTitle;
          document.getElementById('copyLinkBtn').textContent = t.copyBtn;
          document.getElementById('shareWaBtn').textContent = t.shareBtn;
          document.getElementById('changePassTitle').textContent = t.changePass;
          document.getElementById('lblOldPass').textContent = t.oldPass;
          document.getElementById('lblNewPass').textContent = t.newPass;
          document.getElementById('lblConfirmPass').textContent = t.confirmPass;
          document.getElementById('savePassBtn').textContent = t.saveBtn;
          document.getElementById('statCompleted').textContent = t.stat1;
          document.getElementById('statRevenue').textContent = t.stat2;
          document.getElementById('statProfit').textContent = t.stat3;
          document.getElementById('addProductTitle').textContent = t.addTitle;
          document.getElementById('lblProdName').textContent = t.pName;
          document.getElementById('lblCategory').textContent = t.cat;
          document.getElementById('lblBuying').textContent = t.buy;
          document.getElementById('lblSelling').textContent = t.sell;
          document.getElementById('lblSizeAdmin').textContent = t.sizeA;
          document.getElementById('lblColorAdmin').textContent = t.colA;
          document.getElementById('lblImagesAdmin').textContent = t.imgA;
          document.getElementById('uploadBtn').textContent = t.upBtn;
          document.getElementById('sellerSearchInput').placeholder = t.searchP;
          document.getElementById('adminLangBtn').textContent = adminLang === 'sw' ? '🌐 SW / EN' : '🌐 EN / SW';
        }

        function toggleAdminLanguage() {
          adminLang = adminLang === 'sw' ? 'en' : 'sw';
          localStorage.setItem('winga_admin_lang', adminLang);
          applyAdminLang();
        }

        window.addEventListener('DOMContentLoaded', () => {
          applyAdminLang();
        });

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
    const orderId = parseInt(req.query.id, 10);
    const order = await db('orders')
      .where({ orderId, wingaId: req.session.wingaId })
      .first();
    if (!order) return res.send('❌ Oda haipatikani.');
    const winga = await db('wingas').where({ id: req.session.wingaId }).first();
    const shopLink = `${PUBLIC_URL}/catalog?shop=${winga.id}`;
    res.send(
      `<!DOCTYPE html><html lang="sw"><head><meta charset="UTF-8"><title>Risiti #${order.orderId}</title><style>body{font-family:monospace;padding:20px;max-width:420px;margin:20px auto;border:1px solid #ddd;border-radius:8px;}.center{text-align:center;}hr{border:dashed 1px #888;}.btn-print{background:#007bff;color:white;border:none;padding:12px;width:100%;cursor:pointer;font-weight:bold;margin-top:20px;border-radius:6px;}@media print{.btn-print{display:none;}}</style></head><body><div class="center"><h2>🛍️ ${escapeHtml(winga.name)}</h2><p>Simu: ${escapeHtml(winga.phone)}</p><p style="font-size:12px;"><a href="${shopLink}">${shopLink}</a></p><hr><h3>RISITI YA MAUZO</h3></div><p><strong>Oda:</strong> #${order.orderId}</p><p><strong>Tarehe:</strong> ${new Date(order.date).toLocaleDateString('sw-TZ')}</p><p><strong>Simu:</strong> ${escapeHtml(order.customerPhone)}</p><p><strong>Eneo:</strong> ${escapeHtml(order.location)}</p><hr><p><strong>Bidhaa:</strong> ${escapeHtml(order.productName)}</p><p><strong>Bei:</strong> TSh ${Number(order.sellingPrice || 0).toLocaleString()}</p><hr><p class="center"><strong>Status:</strong> ${escapeHtml(order.status)}</p><button class="btn-print" onclick="window.print()">🖨️ Chapisha / PDF</button></body></html>`
    );
  } catch (err) {
    res.status(500).send('Hitilafu kwenye risiti.');
  }
});

// Add Product
app.post('/admin/add', requireWinga, (req, res) => {
  upload(req, res, async err => {
    if (err) {
      console.error('Multer Upload Error:', err.message);
      return res.redirect('/admin?error=upload&reason=' + encodeURIComponent(err.message));
    }
    try {
      const { name, category, buyingPrice, sellingPrice, size, colors, customColors } = req.body;
      if (!name || !name.trim()) {
        return res.redirect(
          '/admin?error=upload&reason=' + encodeURIComponent('Jina la bidhaa linahitajika')
        );
      }
      const imageUrls = await uploadBuffersToCloudinary(req.files || []);

      const selectedList = Array.isArray(colors) ? colors : colors ? [colors] : [];
      const extraList = customColors
        ? customColors
            .split(',')
            .map(c => c.trim())
            .filter(Boolean)
        : [];
      const mergedColors = [...new Set([...selectedList, ...extraList])];
      const finalColorsStr =
        mergedColors.length > 0 ? mergedColors.join(', ') : 'Kama pichani';

      const newProductData = {
        wingaId: req.session.wingaId,
        name: name.trim(),
        category: category ? category.trim() : 'General',
        buyingPrice: parseFloat(buyingPrice || 0),
        sellingPrice: parseFloat(sellingPrice || 0),
        price: parseFloat(sellingPrice || 0),
        size: size ? size.trim() : 'Standard',
        colors: finalColorsStr,
        imageUrl: JSON.stringify(imageUrls),
        dateAdded: new Date()
      };

      await db('products').insert(newProductData);

      const currentWinga = await db('wingas').where({ id: req.session.wingaId }).first();
      if (currentWinga) {
        notifyShopCustomers(currentWinga).catch(e => console.error('Broadcast err:', e));
      }
      res.redirect('/admin?added=true');
    } catch (dbErr) {
      console.error('Cloudinary / DB Insert error:', dbErr);
      res.redirect(
        '/admin?error=upload&reason=' +
          encodeURIComponent(dbErr.message || 'Hitilafu ya kupakia picha')
      );
    }
  });
});

// Edit Product
app.post('/admin/product/edit', requireWinga, (req, res) => {
  upload(req, res, async err => {
    if (err) {
      console.error('Edit Multer Upload Error:', err.message);
      return res.redirect('/admin?error=upload&reason=' + encodeURIComponent(err.message));
    }
    try {
      const prodId = parseInt(req.body.id, 10);
      const existing = await db('products')
        .where({ id: prodId, wingaId: req.session.wingaId })
        .first();
      if (!existing) {
        return res.redirect(
          '/admin?error=upload&reason=' + encodeURIComponent('Bidhaa haikupatikana')
        );
      }

      const { name, category, buyingPrice, sellingPrice, size, colors, customColors } = req.body;
      const selectedList = Array.isArray(colors) ? colors : colors ? [colors] : [];
      const extraList = customColors
        ? customColors
            .split(',')
            .map(c => c.trim())
            .filter(Boolean)
        : [];
      const mergedColors = [...new Set([...selectedList, ...extraList])];
      const finalColorsStr =
        mergedColors.length > 0 ? mergedColors.join(', ') : existing.colors || 'Kama pichani';

      const updatePayload = {
        name: (name || existing.name).trim(),
        category: (category || existing.category || 'General').trim(),
        buyingPrice: parseFloat(
          buyingPrice !== undefined && buyingPrice !== ''
            ? buyingPrice
            : existing.buyingPrice || 0
        ),
        sellingPrice: parseFloat(
          sellingPrice !== undefined && sellingPrice !== ''
            ? sellingPrice
            : existing.sellingPrice || 0
        ),
        price: parseFloat(
          sellingPrice !== undefined && sellingPrice !== ''
            ? sellingPrice
            : existing.price || 0
        ),
        size: (size || existing.size || 'Standard').trim(),
        colors: finalColorsStr
      };

      if (req.files && req.files.length > 0) {
        const newImageUrls = await uploadBuffersToCloudinary(req.files);
        updatePayload.imageUrl = JSON.stringify(newImageUrls);
      }

      await db('products')
        .where({ id: prodId, wingaId: req.session.wingaId })
        .update(updatePayload);
      res.redirect('/admin?updated=true');
    } catch (dbErr) {
      console.error('Edit product error:', dbErr);
      res.redirect(
        '/admin?error=upload&reason=' +
          encodeURIComponent(dbErr.message || 'Hitilafu kuhariri bidhaa')
      );
    }
  });
});

app.post('/admin/product/delete', requireWinga, async (req, res) => {
  try {
    await db('products')
      .where({ id: parseInt(req.body.id, 10), wingaId: req.session.wingaId })
      .del();
  } catch (err) {
    console.error('Delete product error:', err);
  }
  res.redirect('/admin');
});

app.post('/admin/order/status', requireWinga, async (req, res) => {
  try {
    const orderId = parseInt(req.body.orderId, 10);
    const status = req.body.status;
    const order = await db('orders')
      .where({ orderId, wingaId: req.session.wingaId })
      .first();
    if (order) {
      await db('orders')
        .where({ orderId, wingaId: req.session.wingaId })
        .update({ status });

      let customerChatId = order.senderJid;
      if (!customerChatId || !String(customerChatId).includes('@')) {
        customerChatId = await resolveWhatsAppRecipientJid(order.customerPhone);
      }

      if (customerChatId && isBotSocketReady()) {
        const trackUrl = `${PUBLIC_URL}/track?id=${order.orderId}`;
        let statusMessage = '';
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
    console.error('Order status update error:', err);
  }
  res.redirect('/admin');
});

app.post('/admin/change-password', requireWinga, async (req, res) => {
  const wingaId = req.session.wingaId;
  const { oldPassword, newPassword, confirmPassword } = req.body;
  if (!oldPassword || !newPassword || !confirmPassword) {
    return res.status(400).json({ message: 'Tafadhali jaza nafasi zote.' });
  }
  if (newPassword !== confirmPassword) {
    return res.status(400).json({ message: 'Nenosiri jipya halifanani.' });
  }
  if (newPassword.length < 6) {
    return res
      .status(400)
      .json({ message: 'Nenosiri lazima liwe na angalau herufi 6.' });
  }
  try {
    const winga = await db('wingas').where({ id: wingaId }).first();
    if (!winga || !(await bcrypt.compare(oldPassword, winga.password))) {
      return res.status(400).json({ message: 'Nenosiri la zamani si sahihi.' });
    }
    const hashedNewPassword = await bcrypt.hash(newPassword, 10);
    await db('wingas').where({ id: wingaId }).update({ password: hashedNewPassword });
    return res.json({ message: '✅ Nenosiri limebadilishwa kikamilifu!' });
  } catch (err) {
    return res.status(500).json({ message: 'Hitilafu ya server.' });
  }
});

// ==========================================
// FORGOT & RESET PASSWORD (WHATSAPP OTP)
// ==========================================
app.get('/forgot-password', (req, res) => {
  res.send(
    `<!DOCTYPE html><html><head><title>Umesahau Nenosiri</title><meta name="viewport" content="width=device-width, initial-scale=1.0"></head><body style="font-family:sans-serif;background:rgb(106,136,232);display:flex;justify-content:center;align-items:center;height:100vh;margin:0;padding:15px;"><div style="background:white;padding:25px;border-radius:8px;text-align:center;width:100%;max-width:340px;"><h2>🔑 Umesahau Nenosiri?</h2><p style="font-size:12px;color:#555;">Weka namba yako ya simu kupokea OTP WhatsApp.</p><form action="/forgot-password" method="POST"><input type="text" name="phone" placeholder="0712345678" required style="width:100%;padding:11px;margin:10px 0;border:1px solid #4092e5;border-radius:4px;box-sizing:border-box;"><button type="submit" style="background:#007bff;color:white;border:none;padding:12px;width:100%;font-weight:bold;border-radius:4px;cursor:pointer;">Tuma Kodi</button></form><a href="/login" style="display:block;margin-top:15px;color:#007bff;text-decoration:none;font-size:13px;">← Rudi Login</a></div></body></html>`
  );
});

app.post('/forgot-password', rateLimitAuth(8, 15 * 60 * 1000), async (req, res) => {
  try {
    if (!isBotSocketReady()) {
      return res
        .status(503)
        .send(
          `<div style="text-align:center;padding:35px;font-family:sans-serif;max-width:420px;margin:40px auto;background:#fff;border-radius:10px;box-shadow:0 4px 12px rgba(0,0,0,0.1);">` +
            `<h3 style="color:#dc3545;">⚠️ WhatsApp Bot Haijaunganishwa / Ina-reconnect</h3>` +
            `<p style="font-size:14px;color:#555;">Kwa sasa WhatsApp bot haijawa tayari kutuma OTP. Hakikisha bot imeunganishwa (scan QR code ikiwa inaonekana) na subiri sekunde chache kisha ujaribu tena.</p>` +
            `<p style="font-size:12px;color:#777;">Status: ready=${isBotSocketReady()}, reconnecting=${isReconnecting}, lastCode=${lastDisconnectCode || 'none'}</p>` +
            `<a href="/forgot-password" style="display:inline-block;margin-top:12px;padding:10px 18px;background:#007bff;color:#fff;text-decoration:none;border-radius:6px;font-weight:bold;">Jaribu Tena</a>` +
            `</div>`
        );
    }

    const rawPhone = (req.body.phone || '').trim();
    const cleanedPhone = normalizePhone(rawPhone);
    if (!cleanedPhone) {
      return res.send(
        '❌ Tafadhali weka namba sahihi ya simu. <br><a href="/forgot-password">Jaribu Tena</a>'
      );
    }

    const wingas = await db('wingas').select('*');
    const winga = wingas.find(w => isSamePhone(w.phone, rawPhone));
    if (!winga) {
      return res.send(
        '❌ Namba hii haijasajiliwa. <br><a href="/forgot-password">Jaribu Tena</a>'
      );
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    await db('password_resets').where({ phone: winga.phone }).del();
    await db('password_resets').insert({
      phone: winga.phone,
      otp,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000)
    });

    const targetJid = await resolveWhatsAppRecipientJid(cleanedPhone);
    await sock.sendMessage(targetJid, {
      text:
        `🔑 *KODI YA KUBADILISHA NENOSIRI (PASSWORD RESET)*\n` +
        `-----------------------------------\n` +
        `Habari *${winga.name}*, kodi yako ya OTP ni:\n\n` +
        `👉 *${otp}*\n\n` +
        `⚠️ Kodi hii itaisha muda wake ndani ya dakika 10.`
    });

    res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Reset Password</title>
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <style>
        .password-container { position: relative; width: 100%; margin: 8px 0; }
        .password-container input { width: 100%; padding: 10px; box-sizing: border-box; padding-right: 40px; }
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
    <body style="font-family:sans-serif;background:rgb(106,136,232);display:flex;justify-content:center;align-items:center;height:100vh;margin:0;padding:15px;">
      <div style="background:white;padding:25px;border-radius:8px;text-align:center;width:100%;max-width:340px;">
        <h2>🔐 Weka Nenosiri Jipya</h2>
        <p style="font-size:12px;color:#28a745;font-weight:bold;">✅ OTP imetumwa WhatsApp (${escapeHtml(winga.phone)}).</p>
        <form action="/reset-password" method="POST">
          <input type="hidden" name="phone" value="${escapeHtml(winga.phone)}">
          <input type="text" name="otp" placeholder="Kodi ya OTP" required style="width:100%;padding:10px;margin:8px 0;box-sizing:border-box;">
          <div class="password-container">
            <input type="password" name="newPassword" id="resetPass" placeholder="Nenosiri Jipya" required>
            <button type="button" class="eye-btn" onclick="togglePassword('resetPass', this)">👁️</button>
          </div>
          <div class="password-container">
            <input type="password" name="confirmPassword" id="resetConfirmPass" placeholder="Rudia Nenosiri" required>
            <button type="button" class="eye-btn" onclick="togglePassword('resetConfirmPass', this)">👁️</button>
          </div>
          <button type="submit" style="background:#28a745;color:white;border:none;padding:12px;width:100%;font-weight:bold;border-radius:4px;margin-top:8px;cursor:pointer;">Hifadhi</button>
        </form>
      </div>
    </body>
    </html>`);
  } catch (err) {
    console.error('Forgot password error:', err);
    res
      .status(500)
      .send(
        `❌ Hitilafu wakati wa kutuma OTP: ${escapeHtml(err.message)} <br><a href="/forgot-password">Jaribu Tena</a>`
      );
  }
});

app.post('/reset-password', rateLimitAuth(8, 15 * 60 * 1000), async (req, res) => {
  try {
    const { phone, otp, newPassword, confirmPassword } = req.body;
    if (newPassword !== confirmPassword || (newPassword || '').length < 6) {
      return res.send(
        '❌ Nenosiri hazifanani au ni fupi mno (angalau herufi 6). <br><a href="/forgot-password">Jaribu Tena</a>'
      );
    }
    const rec = await db('password_resets')
      .where({ phone: (phone || '').trim(), otp: (otp || '').trim() })
      .where('expiresAt', '>', new Date())
      .first();
    if (!rec) {
      return res.send(
        '❌ Kodi si sahihi au imeisha muda wake. <br><a href="/forgot-password">Omba Mpya</a>'
      );
    }
    const hashedPassword = await bcrypt.hash(newPassword.trim(), 10);
    await db('wingas').where({ phone: rec.phone }).update({ password: hashedPassword });
    await db('password_resets').where({ phone: rec.phone }).del();
    res.send(
      '<div style="text-align:center;padding:50px;font-family:sans-serif;"><h2>🎉 Hongera! Nenosiri limebadilishwa.</h2><a href="/login">Ingia Login</a></div>'
    );
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).send('Hitilafu.');
  }
});

// ==========================================
// SUPER ADMIN DASHBOARD & PASSWORD RESET
// ==========================================
app.get('/superadmin', requireSuperAdmin, async (req, res) => {
  try {
    const wingas = await db('wingas').select('*');
    const products = await db('products').select('*');
    const orders = await db('orders').orderBy('orderId', 'desc').select('*');
    const reviews = await db('reviews').select('*');
    let platformTotalProfit = 0;
    let platformTotalRevenue = 0;

    let statusNotice = '';
    if (req.query.reset === 'success') {
      statusNotice = `<div style="background:#d4edda;color:#155724;border:1px solid #c3e6cb;padding:12px 16px;border-radius:8px;margin-bottom:15px;font-weight:bold;">✅ Password ya muuzaji imebadilishwa kikamilifu!</div>`;
    } else if (req.query.reset === 'short') {
      statusNotice = `<div style="background:#f8d7da;color:#721c24;border:1px solid #f5c6cb;padding:12px 16px;border-radius:8px;margin-bottom:15px;font-weight:bold;">❌ Password mpya lazima iwe na angalau herufi 6!</div>`;
    }

    let wingaRows = wingas
      .map(w => {
        const wProducts = products.filter(p => Number(p.wingaId) === Number(w.id));
        const wOrders = orders.filter(o => Number(o.wingaId) === Number(w.id));
        let wingaRevenue = 0,
          wingaCost = 0,
          completedOrders = 0;
        wOrders.forEach(o => {
          if (o.status === 'Completed') {
            wingaRevenue += Number(o.sellingPrice || o.price || 0);
            wingaCost += Number(o.buyingPrice || 0);
            completedOrders++;
          }
        });
        const wingaProfit = wingaRevenue - wingaCost;
        platformTotalProfit += wingaProfit;
        platformTotalRevenue += wingaRevenue;

        const statusBadge =
          w.status === 'active'
            ? `<span style="background:#28a745; color:white; padding:3px 7px; border-radius:12px; font-size:10px; font-weight:bold;">Active</span>`
            : `<span style="background:#dc3545; color:white; padding:3px 7px; border-radius:12px; font-size:10px; font-weight:bold;">Suspended</span>`;
        const isSmsOn = isSmsEnabled(w.sms_enabled);
        const smsBadge = isSmsOn
          ? `<span style="background:#0ea5e9; color:white; padding:3px 7px; border-radius:12px; font-size:10px; font-weight:bold;">SMS: ON</span>`
          : `<span style="background:#6c757d; color:white; padding:3px 7px; border-radius:12px; font-size:10px; font-weight:bold;">SMS: OFF</span>`;

        return `
        <tr>
          <td><strong>#${w.id}</strong></td>
          <td>${escapeHtml(w.name)}<br><small style="color:#666;">📍 ${escapeHtml(w.location || 'Tanzania')}</small></td>
          <td>${escapeHtml(w.phone)}</td>
          <td>${statusBadge} ${smsBadge}</td>
          <td>${w.expiryDate ? new Date(w.expiryDate).toLocaleDateString() : 'N/A'}</td>
          <td>${wProducts.length} items</td>
          <td>${completedOrders} orders</td>
          <td style="color:#28a745; font-weight:bold;">TSh ${wingaProfit.toLocaleString()}</td>
          <td>
            <div style="display:flex; gap:4px; flex-wrap:wrap; align-items:center;">
              <form action="/superadmin/winga/status" method="POST" style="display:inline;">
                <input type="hidden" name="wingaId" value="${w.id}">
                <input type="hidden" name="status" value="${w.status === 'suspended' ? 'active' : 'suspended'}">
                <button type="submit" style="background:${w.status === 'suspended' ? '#28a745' : '#dc3545'}; color:white; border:none; padding:4px 8px; border-radius:4px; font-size:11px; cursor:pointer;">${w.status === 'suspended' ? 'Activate' : 'Suspend'}</button>
              </form>
              <form action="/superadmin/winga/extend" method="POST" style="display:inline;">
                <input type="hidden" name="wingaId" value="${w.id}">
                <button type="submit" style="background:#007bff; color:white; border:none; padding:4px 8px; border-radius:4px; font-size:11px; cursor:pointer;">+30 Days</button>
              </form>
              <form action="/superadmin/winga/sms" method="POST" style="display:inline;">
                <input type="hidden" name="wingaId" value="${w.id}">
                <input type="hidden" name="sms_enabled" value="${isSmsOn ? '0' : '1'}">
                <button type="submit" style="background:${isSmsOn ? '#6c757d' : '#0ea5e9'}; color:white; border:none; padding:4px 8px; border-radius:4px; font-size:11px; cursor:pointer;">${isSmsOn ? 'Disable SMS' : 'Enable SMS'}</button>
              </form>
              <form action="/superadmin/winga/reset-password" method="POST" style="display:inline-flex; gap:4px; align-items:center;">
                <input type="hidden" name="wingaId" value="${w.id}">
                <input type="text" name="newPassword" placeholder="New Pass" minlength="6" style="padding:4px 6px; width:88px; font-size:11px;" required>
                <button type="submit" style="background:#ffc107; color:#111; border:none; padding:4px 8px; border-radius:4px; font-size:11px; font-weight:bold; cursor:pointer;">🔑 Reset Pass</button>
              </form>
            </div>
          </td>
        </tr>`;
      })
      .join('');

    let superadminOrderRows = orders
      .map(o => {
        const matchedWinga = wingas.find(w => Number(w.id) === Number(o.wingaId));
        const matchedProduct = findMatchedProductForOrder(o, products);
        const images = getProductImages(matchedProduct);

        let photoHtml = '📦';
        if (images.length > 0) {
          photoHtml =
            `<div style="display:flex; gap:4px; align-items:center;">` +
            images
              .map(
                img =>
                  `<img src="${escapeHtml(img)}" data-zoom="${escapeHtml(img)}" onclick="openModal(this.getAttribute('data-zoom'))" style="width: 38px; height: 38px; object-fit: cover; border-radius: 4px; border: 1px solid #ccc; cursor: pointer;" title="Bonyeza kukuza">`
              )
              .join('') +
            `</div>`;
        }

        const currentStatus = o.status || 'Pending';
        let badgeStyle = 'background:#ffc107; color:#000;';
        if (currentStatus === 'Dispatched') badgeStyle = 'background:#17a2b8; color:#fff;';
        if (currentStatus === 'Completed') badgeStyle = 'background:#28a745; color:#fff;';

        return `
        <tr>
          <td><strong>#${o.orderId}</strong></td>
          <td>${photoHtml}</td>
          <td>${escapeHtml(o.productName)}</td>
          <td><strong>${escapeHtml(matchedWinga ? matchedWinga.name : 'Winga #' + o.wingaId)}</strong></td>
          <td>TSh ${Number(o.sellingPrice || 0).toLocaleString()}</td>
          <td>${escapeHtml(o.customerPhone || '-')}</td>
          <td>${escapeHtml(o.location || '-')}</td>
          <td><span style="padding: 3px 7px; border-radius: 12px; font-size: 10px; font-weight: bold; ${badgeStyle}">${escapeHtml(currentStatus)}</span></td>
        </tr>`;
      })
      .join('');

    let superadminProductRows = products
      .map(p => {
        const matchedWinga = wingas.find(w => Number(w.id) === Number(p.wingaId));
        const images = getProductImages(p);
        const mainImg = images[0]
          ? `<img src="${escapeHtml(images[0])}" data-zoom="${escapeHtml(images[0])}" onclick="openModal(this.getAttribute('data-zoom'))" style="width: 36px; height: 36px; object-fit: cover; border-radius: 4px; cursor: pointer;" title="Bonyeza kukuza">`
          : '📦';
        return `
        <tr>
          <td><strong>#${p.id}</strong></td>
          <td>${mainImg}</td>
          <td>${escapeHtml(p.name)}</td>
          <td><strong>${escapeHtml(matchedWinga ? matchedWinga.name : 'Winga #' + p.wingaId)}</strong></td>
          <td>TSh ${Number(p.sellingPrice || 0).toLocaleString()}</td>
          <td>
            <form action="/superadmin/product/delete" method="POST" onsubmit="return confirm('Futa bidhaa hii?');">
              <input type="hidden" name="id" value="${p.id}">
              <button type="submit" style="background:#dc3545; color:white; border:none; padding:5px 10px; border-radius:4px; font-size:11px; cursor:pointer;">🗑️ Delete</button>
            </form>
          </td>
        </tr>`;
      })
      .join('');

    let superadminFeedbackRows = reviews
      .map(rev => {
        const matchedOrder = orders.find(o => Number(o.orderId) === Number(rev.orderId));
        const matchedWinga = matchedOrder
          ? wingas.find(w => Number(w.id) === Number(matchedOrder.wingaId))
          : null;
        return `<tr><td><strong>#${rev.orderId}</strong></td><td>${escapeHtml(matchedWinga ? matchedWinga.name : 'Unknown')}</td><td>${escapeHtml(matchedOrder ? matchedOrder.productName : 'N/A')}</td><td>${'⭐'.repeat(Math.max(1, Math.min(5, Number(rev.rating) || 5)))} (${rev.rating}/5)</td><td>"${escapeHtml(rev.comment)}"</td></tr>`;
      })
      .join('');

    res.send(`
    <!DOCTYPE html>
    <html lang="sw">
    <head>
      <title>Super Admin - Platform Manager</title>
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <script src="/tz-locations.js"></script>
      <style>
        * { box-sizing: border-box; }
        body { font-family: sans-serif; background: #eef2f5; margin: 0; padding: 15px; color: #333; }
        .container { max-width: 1200px; margin: 0 auto; }
        .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 20px; }
        .stat-card { background: #1a1a1a; color: white; padding: 15px; border-radius: 8px; }
        .stat-card h3 { margin: 0 0 6px 0; font-size: 12px; color: #aaa; }
        .stat-card p { margin: 0; font-size: 20px; font-weight: bold; color: #4ade80; }
        .card { background: white; padding: 18px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); margin-bottom: 20px; }
        .form-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; }
        input, select { padding: 10px; border: 1px solid #ccc; border-radius: 4px; width: 100%; font-size: 14px; background: white; }
        button.btn-main { background: #007bff; color: white; border: none; padding: 11px 15px; border-radius: 4px; font-weight: bold; cursor: pointer; width: 100%; margin-top: 10px; }
        .table-responsive { width: 100%; overflow-x: auto; }
        table { width: 100%; border-collapse: collapse; margin-top: 10px; min-width: 650px; font-size: 13px; }
        th, td { text-align: left; padding: 10px; border-bottom: 1px solid #eee; white-space: nowrap; }
        th { background: #f8f9fa; }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>👑 Platform Super Admin</h1>
        <p style="font-size:12px;color:#555;margin-top:-8px;">Admins: <strong>0678143403</strong> & <strong>0745423403</strong></p>
        ${statusNotice}
        <a href="/logout" style="background: #ec0c22; color: white; padding: 8px 16px; border-radius: 6px; text-decoration: none; font-weight: bold; font-size: 13px; display: inline-block; margin-bottom: 15px;">🚪 Logout</a>

        <div class="stats-grid">
          <div class="stat-card"><h3>Total Wingas</h3><p style="color:white;">${wingas.length}</p></div>
          <div class="stat-card"><h3>Total Orders</h3><p style="color:#60a5fa;">${orders.length}</p></div>
          <div class="stat-card"><h3>Total Revenue</h3><p>TSh ${platformTotalRevenue.toLocaleString()}</p></div>
          <div class="stat-card"><h3>Total Profit</h3><p>TSh ${platformTotalProfit.toLocaleString()}</p></div>
        </div>

        <div class="card">
          <h2 style="margin-top:0;">➕ Ongeza Muuzaji Mpya (Register Winga)</h2>
          <form action="/superadmin/add-winga" method="POST">
            <div class="form-grid">
              <input type="text" name="name" placeholder="Jina la Duka / Muuzaji" required>
              <input type="tel" name="phone" placeholder="Namba ya Simu (07...)" maxlength="10" required>
              <input type="password" name="password" placeholder="Password (Default: 123456)">
              <select name="region" id="saRegion" required></select>
              <select name="district" id="saDistrict" required></select>
              <select name="ward" id="saWard" required></select>
              <select name="street" id="saStreet" required></select>
              <input type="text" name="customStreet" id="saCustomStreet" placeholder="Andika jina la mtaa / kijiji..." style="display:none;">
            </div>
            <button type="submit" class="btn-main">Sajili Muuzaji Mpya</button>
          </form>
        </div>

        <div class="card">
          <h2>🛒 Customer Orders & Product Photos (${orders.length})</h2>
          <div class="table-responsive">
            <table>
              <thead><tr><th>Order #</th><th>Product Photo</th><th>Product</th><th>Shop</th><th>Price</th><th>Phone</th><th>Location</th><th>Status</th></tr></thead>
              <tbody>${superadminOrderRows || '<tr><td colspan="8">No orders yet.</td></tr>'}</tbody>
            </table>
          </div>
        </div>

        <div class="card">
          <h2>🏢 Wingas Directory (Status, SMS & Password Reset)</h2>
          <div class="table-responsive">
            <table>
              <thead><tr><th>ID</th><th>Name & Location</th><th>Phone</th><th>Status & SMS</th><th>Expires</th><th>Catalog</th><th>Orders</th><th>Profit</th><th>Actions</th></tr></thead>
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
        function openModal(src) {
          if (!src) return;
          document.getElementById('modalImage').src = src;
          document.getElementById('imgModal').style.display = 'flex';
        }
        function closeModal() { document.getElementById('imgModal').style.display = 'none'; }
        window.addEventListener('DOMContentLoaded', () => {
          if (typeof window.initTzLocation === 'function') {
            window.initTzLocation('saRegion', 'saDistrict', 'saWard', 'saStreet', 'saCustomStreet');
          }
        });
      </script>
    </body>
    </html>
    `);
  } catch (err) {
    console.error('Superadmin view error:', err);
    res.status(500).send('Hitilafu kwenye Superadmin.');
  }
});

// Reset a seller's password from SuperAdmin
app.post('/superadmin/winga/reset-password', requireSuperAdmin, async (req, res) => {
  try {
    const wingaId = parseInt(req.body.wingaId, 10);
    const newPassword = (req.body.newPassword || '').trim();
    if (!wingaId || newPassword.length < 6) {
      return res.redirect('/superadmin?reset=short');
    }
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await db('wingas').where({ id: wingaId }).update({ password: hashedPassword });
    res.redirect('/superadmin?reset=success');
  } catch (err) {
    console.error('Superadmin reset password error:', err);
    res.redirect('/superadmin');
  }
});

app.post('/superadmin/product/delete', requireSuperAdmin, async (req, res) => {
  try {
    await db('products').where({ id: parseInt(req.body.id, 10) }).del();
  } catch (err) {}
  res.redirect('/superadmin');
});

app.post('/superadmin/winga/status', requireSuperAdmin, async (req, res) => {
  try {
    await db('wingas')
      .where({ id: parseInt(req.body.wingaId, 10) })
      .update({ status: req.body.status });
  } catch (err) {}
  res.redirect('/superadmin');
});

app.post('/superadmin/winga/extend', requireSuperAdmin, async (req, res) => {
  try {
    const winga = await db('wingas')
      .where({ id: parseInt(req.body.wingaId, 10) })
      .first();
    if (winga) {
      const baseDate =
        winga.expiryDate && new Date(winga.expiryDate) > new Date()
          ? new Date(winga.expiryDate)
          : new Date();
      baseDate.setDate(baseDate.getDate() + 30);
      await db('wingas')
        .where({ id: parseInt(req.body.wingaId, 10) })
        .update({ expiryDate: baseDate, status: 'active' });
    }
  } catch (err) {}
  res.redirect('/superadmin');
});

app.post('/superadmin/winga/sms', requireSuperAdmin, async (req, res) => {
  try {
    const wingaId = parseInt(req.body.wingaId, 10);
    const smsEnabled = req.body.sms_enabled === '1';
    if (!Number.isNaN(wingaId)) {
      await db('wingas').where({ id: wingaId }).update({ sms_enabled: smsEnabled });
    }
  } catch (err) {}
  res.redirect('/superadmin');
});

app.post('/superadmin/add-winga', requireSuperAdmin, async (req, res) => {
  try {
    const name = (req.body.name || '').trim();
    const phone = (req.body.phone || '').trim();
    const rawPassword = (req.body.password || '123456').trim();
    const fullLocation =
      buildLocationString(
        req.body.region,
        req.body.district,
        req.body.ward,
        req.body.street,
        req.body.customStreet
      ) || 'Tanzania';
    if (!name || !phone) return res.redirect('/superadmin');

    const hashedPassword = await bcrypt.hash(rawPassword, 10);
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
  } catch (err) {
    console.error('Error adding winga:', err);
  }
  res.redirect('/superadmin');
});

// Daily 08:00 AM expiry & reminder cron
cron.schedule('0 8 * * *', async () => {
  try {
    if (!isBotSocketReady()) return;
    const wingas = await db('wingas').select('*');
    const now = new Date();
    for (const w of wingas) {
      if (!w.expiryDate) continue;
      const expiry = new Date(w.expiryDate);
      const daysLeft = Math.ceil((expiry - now) / (1000 * 60 * 60 * 24));
      const chatId = await resolveWhatsAppRecipientJid(w.phone);
      if (!chatId) continue;

      if (daysLeft <= 0 && w.status === 'active') {
        await db('wingas').where({ id: w.id }).update({ status: 'suspended' });
        try {
          await sock.sendMessage(chatId, {
            text: `⚠️ *AKAUNTI IMESITISHWA*\n\nNdugu ${w.name}, muda wako wa siku 30 za matumizi umekwisha. Wasiliana na Admin WhatsApp kufanya malipo ili kufunguliwa tena.`
          });
        } catch (e) {}
      } else if (daysLeft === 3 && w.status === 'active') {
        try {
          await sock.sendMessage(chatId, {
            text: `🔔 *KUMBUSHO LA MALIPO*\n\nNdugu ${w.name}, akaunti yako ya Winga Shop itasitishwa ndani ya siku 3. Wasiliana na Admin kuongeza siku.`
          });
        } catch (e) {}
      }
    }
  } catch (err) {
    console.error('Cron error:', err);
  }
});

app.listen(PORT, () => {
  console.log(`🌐 Server active on ${PUBLIC_URL}`);
  connectToWhatsApp();
});