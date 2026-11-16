const express = require('express');
const router = express.Router();
const integrationsController = require('./integrations.controller');
const authMiddleware = require('../../middlewares/auth.middleware');

// Public Webhook receiver (authenticated via HMAC signature validation inside controller)
router.post('/webhooks/:provider', integrationsController.handleWebhook);

// Protected routes (require JWT auth)
router.use(authMiddleware);

// Connector foundation endpoints (Jira, ClickUp)
router.post('/connectors/:provider/test', integrationsController.testConnector);
router.get('/connectors/:provider/tasks', integrationsController.fetchConnectorTasks);

// Get all configured integrations
router.get('/', integrationsController.getIntegrations);

// Configure (Create/Update) an integration
router.post('/:integrationId', integrationsController.configureIntegration);

// Disconnect (Delete) an integration
router.delete('/:integrationId', integrationsController.disconnectIntegration);

module.exports = router;
