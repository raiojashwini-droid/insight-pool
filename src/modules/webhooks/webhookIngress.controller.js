const webhookIngressEngine = require('./webhookIngress.service');
const { successResponse, errorResponse } = require('../../utils/response');

const webhookIngressController = {
    handleIngress: async (req, res) => {
        try {
            const { provider } = req.params;
            const organizationId = req.query?.orgId || req.headers['x-org-id'] || 'default-org-id';
            const result = await webhookIngressEngine.processIngress(provider, req, organizationId);
            return successResponse(res, result, 'Webhook event received and processed');
        } catch (err) {
            console.error('[Webhook Ingress Error]:', err.message);
            return errorResponse(res, err.message, err.message.includes('Unauthorized') ? 401 : 400);
        }
    },

    getLogs: async (req, res) => {
        try {
            const { provider } = req.query;
            const logs = webhookIngressEngine.getLogs(provider);
            return successResponse(res, logs, 'Webhook ingress logs retrieved');
        } catch (err) {
            return errorResponse(res, err.message, 500);
        }
    },

    getConfig: async (req, res) => {
        try {
            const baseUrl = `${req.protocol}://${req.get('host')}`;
            const orgId = req.user?.organizationId || 'default-org-id';
            return successResponse(res, {
                gitlabWebhookUrl: `${baseUrl}/api/webhooks/ingress/gitlab?orgId=${orgId}`,
                githubWebhookUrl: `${baseUrl}/api/webhooks/ingress/github?orgId=${orgId}`,
                genericWebhookUrl: `${baseUrl}/api/webhooks/ingress/generic?orgId=${orgId}`,
                supportedEvents: ['push', 'issues', 'merge_requests', 'pull_requests', 'task_updates', 'deployments']
            }, 'Webhook configuration generated');
        } catch (err) {
            return errorResponse(res, err.message, 500);
        }
    }
};

module.exports = webhookIngressController;
