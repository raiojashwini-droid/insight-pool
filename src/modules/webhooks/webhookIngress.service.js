const crypto = require('crypto');
const prisma = require('../../config/db');

/**
 * General-Purpose Webhook Ingress Engine
 * Secure Ingress for:
 * - GitLab (X-Gitlab-Token)
 * - GitHub (X-Hub-Signature-256)
 * - Jira / Atlassian (Shared Secret / JWT)
 * - ClickUp, Asana, Slack, Generic Webhooks
 */

class WebhookIngressEngine {
    constructor() {
        // In-memory circular buffer for fast delivery inspection
        this.deliveryLogs = [];
        this.maxLogs = 200;
    }

    /**
     * Verify incoming webhook authenticity across diverse providers
     */
    verifySignature(provider, req, configuredSecret) {
        if (!configuredSecret) return { verified: true, reason: 'No secret configured (Open Mode)' };

        const p = provider.toLowerCase();

        // 1. GitLab token check
        if (p === 'gitlab') {
            const token = req.headers['x-gitlab-token'];
            const valid = token === configuredSecret;
            return { verified: valid, reason: valid ? 'GitLab Token Verified' : 'Invalid X-Gitlab-Token' };
        }

        // 2. GitHub HMAC SHA-256
        if (p === 'github') {
            const signature = req.headers['x-hub-signature-256'];
            if (!signature) return { verified: false, reason: 'Missing X-Hub-Signature-256 header' };
            try {
                const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
                const hmac = crypto.createHmac('sha256', configuredSecret);
                const digest = 'sha256=' + hmac.update(rawBody).digest('hex');
                const valid = crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest));
                return { verified: valid, reason: valid ? 'GitHub HMAC Verified' : 'HMAC Digest Mismatch' };
            } catch (err) {
                return { verified: false, reason: `HMAC verification error: ${err.message}` };
            }
        }

        // 3. Generic Bearer Token or Query Secret
        const authHeader = req.headers['authorization'] || '';
        const queryToken = req.query?.secret || req.query?.token;
        const headerToken = req.headers['x-webhook-secret'] || authHeader.replace(/^Bearer\s+/i, '');

        if (headerToken === configuredSecret || queryToken === configuredSecret) {
            return { verified: true, reason: 'Standard Secret Token Verified' };
        }

        return { verified: false, reason: 'Secret authentication mismatch' };
    }

    /**
     * Process, Normalize, and Dispatch incoming Webhook payload
     */
    async processIngress(provider, req, organizationId = 'default-org-id') {
        const p = provider.toLowerCase();
        const headers = req.headers;
        const body = req.body || {};
        const timestamp = new Date().toISOString();
        const eventId = headers['x-request-id'] || headers['x-gitlab-event-uuid'] || headers['x-github-delivery'] || `EVT-${Date.now()}`;

        // Get configured secret from DB if available
        let secret = null;
        try {
            const integration = await prisma.integration.findFirst({
                where: {
                    organizationId,
                    integrationId: { in: [p, `${p}_webhook`, 'webhooks_ingress'] }
                }
            });
            secret = integration?.config?.webhookSecret || integration?.config?.secret || null;
        } catch (e) {}

        // Verify Signature
        const verification = this.verifySignature(p, req, secret);
        if (!verification.verified && secret) {
            this.recordLog({
                id: eventId,
                provider: p,
                status: 'REJECTED',
                reason: verification.reason,
                timestamp,
                payloadSummary: 'Authentication Failed'
            });
            throw new Error(`Unauthorized Webhook: ${verification.reason}`);
        }

        // Normalize Event
        let eventType = headers['x-gitlab-event'] || headers['x-github-event'] || body.event || body.object_kind || 'custom.event';
        let action = body.action || body.object_attributes?.action || 'trigger';
        let summary = `${provider.toUpperCase()} [${eventType}] event received`;
        let dispatchedAction = null;

        // Dispatch based on normalized event
        if (eventType.includes('push') || eventType.includes('commit')) {
            const commits = body.commits || [];
            const author = body.user_name || body.pusher?.name || body.sender?.login || 'Developer';
            summary = `${commits.length} commit(s) pushed by ${author}`;
            dispatchedAction = 'LOG_DEVELOPER_ACTIVITY';
        } else if (eventType.includes('issue') || eventType.includes('task')) {
            const title = body.issue?.title || body.object_attributes?.title || body.task?.name || 'Task Event';
            summary = `Issue/Task updated: "${title}"`;
            dispatchedAction = 'SYNC_TASK_BOARD';
        } else if (eventType.includes('merge_request') || eventType.includes('pull_request')) {
            const mrTitle = body.pull_request?.title || body.object_attributes?.title || 'Merge Request';
            summary = `PR/MR: "${mrTitle}"`;
            dispatchedAction = 'UPDATE_QA_STATUS';
        }

        const logEntry = {
            id: eventId,
            provider: p,
            eventType,
            action,
            summary,
            dispatchedAction,
            status: 'PROCESSED',
            verification: verification.reason,
            timestamp,
            payloadSize: JSON.stringify(body).length
        };

        this.recordLog(logEntry);

        return {
            success: true,
            eventId,
            provider: p,
            eventType,
            summary,
            dispatchedAction,
            timestamp
        };
    }

    recordLog(entry) {
        this.deliveryLogs.unshift(entry);
        if (this.deliveryLogs.length > this.maxLogs) {
            this.deliveryLogs.pop();
        }
    }

    getLogs(provider = null) {
        if (provider) {
            return this.deliveryLogs.filter(l => l.provider.toLowerCase() === provider.toLowerCase());
        }
        return this.deliveryLogs;
    }
}

module.exports = new WebhookIngressEngine();
