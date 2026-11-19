const db = require('../db');

async function createOrder(req, res) {
  try {
    const {
      wingaId,
      productName,
      buyingPrice,
      sellingPrice,
      price,
      customerPhone,
      location,
      senderJid,
      status
    } = req.body || {};

    if (!productName || !customerPhone) {
      return res.status(400).json({
        success: false,
        message: 'productName na customerPhone zinahitajika.'
      });
    }

    const maxResult = await db('orders').max('orderId as maxId').first();
    const nextOrderId = (maxResult && maxResult.maxId ? Number(maxResult.maxId) : 0) + 1;

    const unitSelling = Number(sellingPrice ?? price ?? 0);
    const unitBuying = Number(buyingPrice ?? 0);

    const newOrder = {
      orderId: nextOrderId,
      wingaId: Number(wingaId) || 1,
      productName: String(productName).trim(),
      buyingPrice: unitBuying,
      sellingPrice: unitSelling,
      customerPhone: String(customerPhone).trim(),
      location: location ? String(location).trim() : 'Haikutajwa',
      senderJid: senderJid ? String(senderJid).trim() : null,
      status: status ? String(status).trim() : 'Pending',
      date: new Date()
    };

    await db('orders').insert(newOrder);

    return res.status(201).json({
      success: true,
      message: 'Oda imehifadhiwa kikamilifu.',
      order: newOrder
    });
  } catch (err) {
    console.error('createOrder error:', err);
    return res.status(500).json({
      success: false,
      message: 'Hitilafu ya server wakati wa kuhifadhi oda.'
    });
  }
}

module.exports = { createOrder };
