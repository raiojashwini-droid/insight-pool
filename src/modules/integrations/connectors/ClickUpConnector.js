const BaseConnector = require('./BaseConnector');
const crypto = require('crypto');

/**
 * ClickUpConnector
 * Modular connector foundation for ClickUp REST API v2
 */
class ClickUpConnector extends BaseConnector {
    constructor() {
        super('clickup');
        this.baseUrl = 'https://api.clickup.com/api/v2';
        this.processedWebhookIds = new Set();
    }

    /**
     * Resolve configuration from passed object or environment variables
     */
    resolveConfig(config = {}) {
        const apiToken = config.apiToken || process.env.CLICKUP_API_TOKEN || '';
        const teamId = config.teamId || process.env.CLICKUP_TEAM_ID || '';
        const listId = config.listId || process.env.CLICKUP_LIST_ID || '';
        const webhookSecret = config.webhookSecret || process.env.CLICKUP_WEBHOOK_SECRET || '';

        return { apiToken, teamId, listId, webhookSecret };
    }

    validateConfig(config) {
        const resolved = this.resolveConfig(config);
        const missing = [];
        if (!resolved.apiToken) missing.push('apiToken (or CLICKUP_API_TOKEN)');

        if (missing.length > 0) {
            throw new Error(`Missing required ClickUp configuration: ${missing.join(', ')}`);
        }
        return resolved;
    }

    getHeaders(apiToken) {
        return {
            'Authorization': apiToken,
            'Content-Type': 'application/json',
            'Accept': 'application/json',
        };
    }

    /**
     * Test connection to ClickUp instance
     */
    async testConnection(config) {
        const resolved = this.validateConfig(config);
        const url = `${this.baseUrl}/user`;

        this.log('info', 'Testing ClickUp connection...');

        try {
            const response = await fetch(url, {
                method: 'GET',
                headers: this.getHeaders(resolved.apiToken),
            });

            if (!response.ok) {
                const text = await response.text();
                throw { response: { status: response.status, data: text } };
            }

            const data = await response.json();
            const user = data.user || {};
            this.log('info', 'ClickUp connection test successful', { username: user.username, email: user.email });

            return {
                success: true,
                provider: 'clickup',
                authenticatedUser: user.username || user.email,
                userId: user.id,
            };
        } catch (error) {
            throw this.handleApiError(error, 'testConnection');
        }
    }

    /**
     * Fetch tasks from ClickUp
     */
    async fetchTasks(config, options = {}) {
        const resolved = this.validateConfig(config);
        const { limit = 50, page = 0 } = options;

        let url;
        if (resolved.listId) {
            url = `${this.baseUrl}/list/${resolved.listId}/task?page=${page}&subtasks=true&include_closed=true`;
        } else if (resolved.teamId) {
            url = `${this.baseUrl}/team/${resolved.teamId}/task?page=${page}&subtasks=true&include_closed=true`;
        } else {
            // First fetch authorized teams (workspaces)
            const teamsRes = await fetch(`${this.baseUrl}/team`, {
                headers: this.getHeaders(resolved.apiToken),
            });
            if (!teamsRes.ok) throw { response: { status: teamsRes.status, data: await teamsRes.text() } };
            const teamsData = await teamsRes.json();
            const primaryTeam = teamsData.teams?.[0];
            if (!primaryTeam) {
                throw new Error('No ClickUp workspaces/teams found for this API token.');
            }
            url = `${this.baseUrl}/team/${primaryTeam.id}/task?page=${page}&subtasks=true&include_closed=true`;
        }

        this.log('info', 'Fetching ClickUp tasks...', { url: url.split('?')[0] });

        try {
            const response = await fetch(url, {
                method: 'GET',
                headers: this.getHeaders(resolved.apiToken),
            });

            if (!response.ok) {
                const text = await response.text();
                throw { response: { status: response.status, data: text } };
            }

            const data = await response.json();
            const rawTasks = data.tasks || [];

            this.log('info', `Successfully fetched ${rawTasks.length} tasks from ClickUp`);

            return {
                provider: 'clickup',
                total: rawTasks.length,
                tasks: rawTasks.map(t => this.normalizeTask(t)),
            };
        } catch (error) {
            throw this.handleApiError(error, 'fetchTasks');
        }
    }

    /**
     * Normalize ClickUp task to internal canonical format
     */
    normalizeTask(task) {
        if (!task) return null;

        const parseTimestamp = (val) => {
            if (!val) return null;
            const num = Number(val);
            return !isNaN(num) ? new Date(num).toISOString() : new Date(val).toISOString();
        };

        const primaryAssignee = task.assignees?.[0] || null;

        return {
            externalId: task.id,
            internalProvider: 'CLICKUP',
            title: task.name || 'Untitled ClickUp Task',
            description: task.text_content || task.description || '',
            status: task.status?.status || 'Open',
            priority: task.priority?.priority || 'normal',
            assignee: primaryAssignee?.username || 'Unassigned',
            assigneeEmail: primaryAssignee?.email || null,
            createdDate: parseTimestamp(task.date_created) || new Date().toISOString(),
            updatedDate: parseTimestamp(task.date_updated) || new Date().toISOString(),
            dueDate: parseTimestamp(task.due_date),
            project: {
                id: task.project?.id || task.space?.id || null,
                key: task.space?.id || null,
                name: task.project?.name || task.space?.name || 'ClickUp Space',
            },
            rawPayload: {
                id: task.id,
                url: task.url,
                list: task.list?.name || null,
            },
        };
    }

    /**
     * Validate incoming ClickUp Webhook signature (HMAC-SHA256)
     */
    validateWebhookSignature(req, secret) {
        const resolvedSecret = secret || process.env.CLICKUP_WEBHOOK_SECRET;
        if (!resolvedSecret) {
            this.log('warn', 'No ClickUp webhook secret configured; skipping signature validation');
            return true;
        }

        const signature = req.headers['x-signature'];
        if (!signature) {
            this.log('warn', 'ClickUp webhook received without X-Signature header');
            return false;
        }

        const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
        const expected = crypto.createHmac('sha256', resolvedSecret).update(rawBody).digest('hex');

        const sigBuf = Buffer.from(signature);
        const expectedBuf = Buffer.from(expected);
        if (sigBuf.length !== expectedBuf.length) {
            return false;
        }

        return crypto.timingSafeEqual(sigBuf, expectedBuf);
    }

    /**
     * Handle incoming webhook event
     */
    async handleWebhook(payload, headers = {}) {
        const webhookEvent = payload?.event || 'unknown';
        const taskId = payload?.task_id || payload?.history_items?.[0]?.parent_id;

        if (!taskId) {
            return { processed: false, reason: 'No task_id in webhook payload' };
        }

        // Deduplication using webhook_id or event identifier
        const eventKey = payload.id || payload.event_id || `${payload.webhook_id || 'wh'}_${taskId}_${payload.event || ''}_${payload.timestamp || ''}`;
        if (this.processedWebhookIds.has(eventKey)) {
            this.log('info', 'Ignoring duplicate ClickUp webhook event', { eventKey });
            return { processed: false, duplicate: true };
        }

        this.processedWebhookIds.add(eventKey);
        if (this.processedWebhookIds.size > 1000) {
            const first = this.processedWebhookIds.values().next().value;
            this.processedWebhookIds.delete(first);
        }

        this.log('info', 'Received ClickUp webhook event', {
            event: webhookEvent,
            taskId,
        });

        return {
            processed: true,
            event: webhookEvent,
            taskId,
            payload,
        };
    }
}

module.exports = new ClickUpConnector();
