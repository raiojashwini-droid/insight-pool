const integrationsService = require('./integrations.service');
const { getConnector } = require('./connectors');
const { successResponse, errorResponse } = require('../../utils/response');
const { getOrganizationId } = require('../../utils/orgId');

/**
 * Get all integrations for the current user's organization
 */
const getIntegrations = async (req, res) => {
    try {
        const organizationId = await getOrganizationId(req);
        if (!organizationId) {
            return errorResponse(res, 'Organization ID is missing', 400);
        }

        const integrations = await integrationsService.getIntegrations(organizationId);

        // Transform array into an object format expected by the frontend
        const result = {};
        integrations.forEach(i => {
            result[i.integrationId] = {
                connected: i.connected,
                config: i.config
            };
        });

        return successResponse(res, result, 'Integrations fetched successfully');
    } catch (error) {
        console.error('Error fetching integrations:', error);
        return errorResponse(res, 'Failed to fetch integrations', 500);
    }
};

/**
 * Configure/Create an integration
 */
const configureIntegration = async (req, res) => {
    try {
        const organizationId = await getOrganizationId(req);
        const { integrationId } = req.params;
        const { config } = req.body;

        if (!organizationId) {
            return errorResponse(res, 'Organization ID is missing', 400);
        }

        const integration = await integrationsService.upsertIntegration(
            organizationId,
            integrationId,
            true, // connected
            config
        );

        return successResponse(res, integration, 'Integration configured successfully');
    } catch (error) {
        console.error('Error configuring integration:', error);
        return errorResponse(res, 'Failed to configure integration', 500);
    }
};

/**
 * Disconnect/Delete an integration
 */
const disconnectIntegration = async (req, res) => {
    try {
        const organizationId = await getOrganizationId(req);
        const { integrationId } = req.params;

        if (!organizationId) {
            return errorResponse(res, 'Organization ID is missing', 400);
        }

        await integrationsService.disconnectIntegration(organizationId, integrationId);

        return successResponse(res, null, 'Integration disconnected successfully');
    } catch (error) {
        console.error('Error disconnecting integration:', error);
        return successResponse(res, null, 'Integration disconnected successfully');
    }
};

/**
 * Phase 3 Groundwork: Test connector credentials & connection
 */
const testConnector = async (req, res) => {
    try {
        const { provider } = req.params;
        const connector = getConnector(provider);
        const organizationId = await getOrganizationId(req);

        // Fetch saved config from database if not explicitly passed in body
        let config = req.body?.config || req.body || {};
        if (!config || Object.keys(config).length === 0) {
            const saved = await integrationsService.getIntegrations(organizationId);
            const found = saved.find(i => i.integrationId.toLowerCase() === provider.toLowerCase());
            if (found?.config) config = found.config;
        }

        const result = await connector.testConnection(config);
        return successResponse(res, result, `${provider.toUpperCase()} connection successful`);
    } catch (error) {
        console.error(`[Connector test error] ${req.params.provider}:`, error.message);
        return errorResponse(res, error.message, 400);
    }
};

/**
 * Phase 3 Groundwork: Fetch & normalize external tasks
 */
const fetchConnectorTasks = async (req, res) => {
    try {
        const { provider } = req.params;
        const connector = getConnector(provider);
        const organizationId = await getOrganizationId(req);
        const { limit, jql, listId, teamId } = req.query;

        // Fetch saved config
        let config = {};
        const saved = await integrationsService.getIntegrations(organizationId);
        const found = saved.find(i => i.integrationId.toLowerCase() === provider.toLowerCase());
        if (found?.config) config = found.config;

        const options = {
            limit: limit ? parseInt(limit, 10) : 50,
            jql,
            listId,
            teamId,
        };

        const result = await connector.fetchTasks(config, options);
        return successResponse(res, result, `Successfully fetched tasks from ${provider.toUpperCase()}`);
    } catch (error) {
        console.error(`[Connector fetch tasks error] ${req.params.provider}:`, error.message);
        return errorResponse(res, error.message, 400);
    }
};

/**
 * Phase 3 Groundwork: Webhook receiver with signature verification
 */
const handleWebhook = async (req, res) => {
    try {
        const { provider } = req.params;
        const connector = getConnector(provider);

        // Validate webhook signature
        const isValid = connector.validateWebhookSignature(req);
        if (!isValid) {
            return errorResponse(res, 'Invalid webhook signature', 401);
        }

        const result = await connector.handleWebhook(req.body, req.headers);
        return successResponse(res, result, 'Webhook processed successfully');
    } catch (error) {
        console.error(`[Connector webhook error] ${req.params.provider}:`, error.message);
        return errorResponse(res, error.message, 500);
    }
};

module.exports = {
    getIntegrations,
    configureIntegration,
    disconnectIntegration,
    testConnector,
    fetchConnectorTasks,
    handleWebhook,
};
