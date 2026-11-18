const express = require('express');
const router = express.Router();
const webhookIngressController = require('./webhookIngress.controller');
const authMiddleware = require('../../middlewares/auth.middleware');

// Public Webhook Ingress (Authenticated via signature/token check)
router.post('/ingress/:provider', webhookIngressController.handleIngress);

// Protected Webhook Management Routes (Require JWT)
router.get('/logs', authMiddleware, webhookIngressController.getLogs);
router.get('/config', authMiddleware, webhookIngressController.getConfig);

module.exports = router;
