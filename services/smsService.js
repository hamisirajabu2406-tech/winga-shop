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
  const apiKey = (process.env.BEEM_API_KEY || '').trim();
  const secretKey = (process.env.BEEM_SECRET_KEY || '').trim();
  const senderId = (process.env.BEEM_SENDER_ID || 'MAPINDA').trim();

  if (!apiKey || !secretKey) {
    console.warn('[SMS] BEEM_API_KEY au BEEM_SECRET_KEY haijawekwa kwenye mazingira.');
    return { ok: false, reason: 'missing_keys' };
  }

  const destAddr = formatTzPhone(phone);
  if (!destAddr) {
    console.warn('[SMS] Namba ya simu si sahihi:', phone);
    return { ok: false, reason: 'invalid_phone' };
  }

  const safeOrderId = Number(orderId) || 0;
  const safeAmount = Number(totalAmount || 0).toLocaleString();
  const safeSeller = String(sellerName || 'Muuzaji').replace(/[\r\n]+/g, ' ').trim();
  const message = `AgizaSmart: Habari ${safeSeller}, una oda mpya #${safeOrderId} ya TSh ${safeAmount}. Ingia kwenye dashboard kuikagua.`;

  const auth = 'Basic ' + Buffer.from(`${apiKey}:${secretKey}`).toString('base64');

  const payload = {
    source_addr: senderId,
    schedule_time: '',
    encoding: 0,
    message,
    recipients: [
      {
        recipient_id: 1,
        dest_addr: destAddr
      }
    ]
  };

  console.log(`[SMS] Inatuma SMS kwenda ${destAddr} (Order #${safeOrderId}, Sender: ${senderId})...`);

  try {
    const res = await axios.post(BEEM_SMS_URL, payload, {
      headers: {
        Authorization: auth,
        'Content-Type': 'application/json'
      },
      timeout: 12000
    });
    console.log('[SMS] Jibu la Beem:', JSON.stringify(res.data));
    return { ok: true, data: res.data };
  } catch (err) {
    const status = err.response?.status;
    const providerData = err.response?.data;
    console.error(
      `[SMS] Imeshindwa kutuma kupitia Beem (status: ${status || 'N/A'}):`,
      providerData ? JSON.stringify(providerData) : err.message
    );
    return {
      ok: false,
      reason: 'api_error',
      status,
      providerData,
      error: err.message
    };
  }
}

module.exports = {
  formatTzPhone,
  sendSellerOrderSms
};