const axios = require('axios');

const BEEM_SMS_URL = 'https://apisms.beem.africa/v1/send';

function formatTzPhone(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, '');

  if (digits.startsWith('255') && digits.length === 12) return digits;
  if (digits.startsWith('0') && digits.length === 10) return `255${digits.slice(1)}`;
  if ((digits.startsWith('6') || digits.startsWith('7')) && digits.length === 9) {
    return `255${digits}`;
  }
  return null;
}

async function sendSellerOrderSms({ phone, sellerName, orderId, totalAmount }) {
  const apiKey = process.env.BEEM_API_KEY;
  const secretKey = process.env.BEEM_SECRET_KEY;
  const senderId = process.env.BEEM_SENDER_ID || 'MAPINDA';

  if (!apiKey || !secretKey) {
    console.warn('[SMS] BEEM_API_KEY au BEEM_SECRET_KEY haijawekwa kwenye .env');
    return { ok: false, reason: 'missing_keys' };
  }

  const destAddr = formatTzPhone(phone);
  if (!destAddr) {
    console.warn('[SMS] Namba ya simu si sahihi:', phone);
    return { ok: false, reason: 'invalid_phone' };
  }

  const message = `AgizaSmart: Habari ${sellerName || 'Muuzaji'}, una oda mpya #${orderId} ya TSh ${Number(totalAmount || 0).toLocaleString()}. Ingia kwenye dashboard kuikagua.`;

  const auth = 'Basic ' + Buffer.from(`${apiKey}:${secretKey}`).toString('base64');

  const payload = {
    source_addr: senderId,
    schedule_time: '',
    encoding: 0,
    message,
    recipients: [
      {
        recipient_id: 1,
        dest_addr: destAddr,
      },
    ],
  };

  try {
    const res = await axios.post(BEEM_SMS_URL, payload, {
      headers: {
        Authorization: auth,
        'Content-Type': 'application/json',
      },
      timeout: 10000,
    });
    return { ok: true, data: res.data };
  } catch (err) {
    console.error('[SMS] Imeshindwa kutuma kupitia Beem:', err.message);
    return { ok: false, reason: 'api_error' };
  }
}

module.exports = {
  formatTzPhone,
  sendSellerOrderSms,
};