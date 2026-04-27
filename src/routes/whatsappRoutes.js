const express = require('express');
const { handleWebhook } = require('../controllers/whatsappController');

const router = express.Router();

router.post('/webhook', handleWebhook);

module.exports = router;
