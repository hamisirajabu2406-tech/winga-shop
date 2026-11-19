const express = require('express');
const router = express.Router();
const { createOrder } = require('../controllers/orderController');

// POST /api/orders -> Inapokea oda mpya na kuita createOrder
router.post('/orders', createOrder);

module.exports = router;