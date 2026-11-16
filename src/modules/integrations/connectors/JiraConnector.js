const BaseConnector = require('./BaseConnector');
const crypto = require('crypto');

/**
 * JiraConnector
 * Modular connector foundation for Atlassian Jira Cloud REST API
 */
class JiraConnector extends BaseConnector {
    constructor() {
        super('jira');
        this.processedWebhookIds = new Set();
    }

    /**
     * Resolve configuration from passed object or environment variables
     */
    resolveConfig(config = {}) {
        const host = (config.host || process.env.JIRA_HOST || '').replace(/\/+$/, '');
        const email = config.email || process.env.JIRA_EMAIL || '';
        const apiToken = config.apiToken || process.env.JIRA_API_TOKEN || '';
        const projectKey = config.projectKey || process.env.JIRA_PROJECT_KEY || '';
        const webhookSecret = config.webhookSecret || process.env.JIRA_WEBHOOK_SECRET || '';

        return { host, email, apiToken, projectKey, webhookSecret };
    }

    validateConfig(config) {
        const resolved = this.resolveConfig(config);
        const missing = [];
        if (!resolved.host) missing.push('host (or JIRA_HOST)');
        if (!resolved.email) missing.push('email (or JIRA_EMAIL)');
        if (!resolved.apiToken) missing.push('apiToken (or JIRA_API_TOKEN)');

        if (missing.length > 0) {
            throw new Error(`Missing required Jira configuration: ${missing.join(', ')}`);
        }
        return resolved;
    }

    getAuthHeader(email, apiToken) {
        const token = Buffer.from(`${email}:${apiToken}`).toString('base64');
        return `Basic ${token}`;
    }

    /**
     * Test connection to Jira instance
     */
    async testConnection(config) {
        const resolved = this.validateConfig(config);
        const url = `${resolved.host}/rest/api/3/myself`;

        this.log('info', 'Testing Jira connection...', { host: resolved.host, user: resolved.email });

        try {
            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    'Authorization': this.getAuthHeader(resolved.email, resolved.apiToken),
                    'Accept': 'application/json',
                },
            });

            if (!response.ok) {
                const text = await response.text();
                throw { response: { status: response.status, data: text } };
            }

            const data = await response.json();
            this.log('info', 'Jira connection test successful', { displayName: data.displayName, accountId: data.accountId });

            return {
                success: true,
                provider: 'jira',
                authenticatedUser: data.displayName || data.emailAddress,
                server: resolved.host,
            };
        } catch (error) {
            throw this.handleApiError(error, 'testConnection');
        }
    }

    /**
     * Fetch tasks from Jira via JQL
     */
    async fetchTasks(config, options = {}) {
        const resolved = this.validateConfig(config);
        const { limit = 50, jql: customJql } = options;

        let jql = customJql || '';
        if (!jql && resolved.projectKey) {
            jql = `project = "${resolved.projectKey}" ORDER BY updated DESC`;
        } else if (!jql) {
            jql = 'ORDER BY updated DESC';
        }

        const url = `${resolved.host}/rest/api/3/search?jql=${encodeURIComponent(jql)}&maxResults=${limit}&fields=summary,description,status,assignee,created,updated,duedate,project,priority`;

        this.log('info', 'Fetching Jira tasks...', { jql, limit });

        try {
            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    'Authorization': this.getAuthHeader(resolved.email, resolved.apiToken),
                    'Accept': 'application/json',
                },
            });

            if (!response.ok) {
                const text = await response.text();
                throw { response: { status: response.status, data: text } };
            }

            const data = await response.json();
            const rawIssues = data.issues || [];

            this.log('info', `Successfully fetched ${rawIssues.length} issues from Jira`, { total: data.total });

            return {
                provider: 'jira',
                total: data.total || rawIssues.length,
                tasks: rawIssues.map(issue => this.normalizeTask(issue)),
            };
        } catch (error) {
            throw this.handleApiError(error, 'fetchTasks');
        }
    }

    /**
     * Normalize Jira issue to internal canonical Task format
     */
    normalizeTask(issue) {
        if (!issue) return null;
        const fields = issue.fields || {};

        // Extract description text safely (handle Atlassian ADF or plain string)
        let description = '';
        if (typeof fields.description === 'string') {
            description = fields.description;
        } else if (fields.description?.content) {
            try {
                description = fields.description.content
                    .map(p => p.content?.map(c => c.text || '').join('') || '')
                    .join('\n');
            } catch (e) {
                description = '';
            }
        }

        return {
            externalId: issue.key || issue.id,
            internalProvider: 'JIRA',
            title: fields.summary || 'Untitled Jira Issue',
            description,
            status: fields.status?.name || 'Backlog',
            priority: fields.priority?.name || 'Medium',
            assignee: fields.assignee?.displayName || 'Unassigned',
            assigneeEmail: fields.assignee?.emailAddress || null,
            createdDate: fields.created ? new Date(fields.created).toISOString() : new Date().toISOString(),
            updatedDate: fields.updated ? new Date(fields.updated).toISOString() : new Date().toISOString(),
            dueDate: fields.duedate ? new Date(fields.duedate).toISOString() : null,
            project: {
                id: fields.project?.id || null,
                key: fields.project?.key || null,
                name: fields.project?.name || 'Jira Project',
            },
            rawPayload: {
                id: issue.id,
                key: issue.key,
                self: issue.self,
            },
        };
    }

    /**
     * Validate incoming Jira Webhook request signature
     */
    validateWebhookSignature(req, secret) {
        const resolvedSecret = secret || process.env.JIRA_WEBHOOK_SECRET;
        if (!resolvedSecret) {
            this.log('warn', 'No webhook secret configured; skipping signature validation');
            return true;
        }

        const signature = req.headers['x-hub-signature'] || req.headers['x-atlassian-webhook-identifier'];
        if (!signature) {
            this.log('warn', 'Webhook received without signature header');
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
        const webhookEvent = payload?.webhookEvent || headers['x-atlassian-webhook-event'] || 'unknown';
        const issue = payload?.issue;

        if (!issue) {
            return { processed: false, reason: 'No issue object in payload' };
        }

        // Deduplication
        const eventKey = `${payload.timestamp || Date.now()}_${issue.id}_${issue.fields?.updated || ''}`;
        if (this.processedWebhookIds.has(eventKey)) {
            this.log('info', 'Ignoring duplicate Jira webhook event', { eventKey });
            return { processed: false, duplicate: true };
        }

        this.processedWebhookIds.add(eventKey);
        // Retain only last 1000 items in memory
        if (this.processedWebhookIds.size > 1000) {
            const first = this.processedWebhookIds.values().next().value;
            this.processedWebhookIds.delete(first);
        }

        const normalized = this.normalizeTask(issue);
        this.log('info', 'Processed Jira webhook event', {
            event: webhookEvent,
            issueKey: normalized.externalId,
            status: normalized.status,
        });

        return {
            processed: true,
            event: webhookEvent,
            task: normalized,
        };
    }
}

module.exports = new JiraConnector();
