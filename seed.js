const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const db = require('./db');

function parseDbDate(dateVal) {
  if (!dateVal) return null;
  const d = new Date(dateVal);
  return isNaN(d.getTime()) ? null : d;
}

async function seed() {
  console.log('🔄 Starting data migration from JSON to MySQL...\n');

  try {
    // 1. Migrate Wingas (Ensuring Plaintext Passwords Are Hashed)
    const wingasPath = path.join(__dirname, 'wingas.json');
    if (fs.existsSync(wingasPath)) {
      const wingas = JSON.parse(fs.readFileSync(wingasPath, 'utf8'));
      let count = 0;
      for (const w of wingas) {
        let password = w.password || '123456';
        if (!password.startsWith('$2a$') && !password.startsWith('$2b$')) {
          password = await bcrypt.hash(password, 10);
        }

        await db('wingas').insert({
          id: w.id,
          name: w.name || w.store_name || 'Winga Store',
          phone: String(w.phone || ''),
          password: password,
          status: w.status || 'active',
          expiryDate: parseDbDate(w.expiryDate),
          dateAdded: parseDbDate(w.dateAdded) || new Date()
        }).onConflict('id').merge();
        count++;
      }
      console.log(`✅ Wingas migrated: ${count} records.`);
    }

    // 2. Migrate Products
    const productsPath = path.join(__dirname, 'products.json');
    if (fs.existsSync(productsPath)) {
      const products = JSON.parse(fs.readFileSync(productsPath, 'utf8'));
      let count = 0;
      for (const p of products) {
        const selling = Number(p.sellingPrice ?? p.price ?? 0);
        const buying = Number(p.buyingPrice ?? p.cost_price ?? 0);

        await db('products').insert({
          id: p.id,
          wingaId: Number(p.wingaId ?? p.winga_id ?? 1),
          name: p.name || 'Product',
          category: p.category || 'General',
          buyingPrice: buying,
          sellingPrice: selling,
          price: selling,
          size: p.size || 'Standard',
          imageUrl: p.imageUrl || p.image || '',
          imageLocalPath: p.imageLocalPath || null,
          dateAdded: parseDbDate(p.dateAdded) || new Date()
        }).onConflict('id').merge();
        count++;
      }
      console.log(`✅ Products migrated: ${count} records.`);
    }

    // 3. Migrate Orders
    const ordersPath = path.join(__dirname, 'orders.json');
    if (fs.existsSync(ordersPath)) {
      const orders = JSON.parse(fs.readFileSync(ordersPath, 'utf8'));
      let count = 0;
      for (const o of orders) {
        await db('orders').insert({
          orderId: o.orderId ?? o.id,
          wingaId: Number(o.wingaId ?? o.winga_id ?? 1),
          productName: o.productName || 'Unknown Product',
          buyingPrice: Number(o.buyingPrice || 0),
          sellingPrice: Number(o.sellingPrice ?? o.price ?? 0),
          customerPhone: String(o.customerPhone || o.customer_phone || ''),
          location: o.location || 'Haikutajwa',
          senderJid: o.senderJid || null,
          status: o.status || 'Pending',
          date: parseDbDate(o.date) || new Date()
        }).onConflict('id').merge();
        count++;
      }
      console.log(`✅ Orders migrated: ${count} records.`);
    }

    // 4. Migrate Reviews
    const reviewsPath = path.join(__dirname, 'reviews.json');
    if (fs.existsSync(reviewsPath)) {
      const reviews = JSON.parse(fs.readFileSync(reviewsPath, 'utf8'));
      let count = 0;
      for (const r of reviews) {
        await db('reviews').insert({
          orderId: Number(r.orderId),
          rating: Number(r.rating || 5),
          comment: r.comment || '',
          date: parseDbDate(r.date) || new Date()
        }).onConflict('orderId').merge();
        count++;
      }
      console.log(`✅ Reviews migrated: ${count} records.`);
    }

    console.log('\n🎉 Migration completed successfully!');
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
  } finally {
    process.exit(0);
  }
}

seed();