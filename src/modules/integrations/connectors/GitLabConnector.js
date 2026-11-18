const axios = require('axios');
const BaseConnector = require('./BaseConnector');
const prisma = require('../../../config/db');

/**
 * GitLabConnector
 * Full integration with GitLab REST API v4 & Webhooks
 * Supports:
 * - Projects & Issues fetching
 * - Push events, Issue events, Merge Request events
 * - Secret token signature validation (X-Gitlab-Token)
 * - Automatic Task status synchronization
 */
class GitLabConnector extends BaseConnector {
    constructor() {
        super('gitlab');
    }

    /**
     * Validate GitLab credentials
     */
    validateConfig(config = {}) {
        const { token, gitlabUrl } = config;
        const errors = [];
        if (!token) errors.push('GitLab Personal Access Token or Project Token is required.');
        if (gitlabUrl && !gitlabUrl.startsWith('http://') && !gitlabUrl.startsWith('https://')) {
            errors.push('GitLab URL must be a valid HTTP/HTTPS URL.');
        }
        return {
            isValid: errors.length === 0,
            errors,
        };
    }

    /**
     * Test connection to GitLab API
     */
    async testConnection(config = {}) {
        const validation = this.validateConfig(config);
        if (!validation.isValid) {
            throw new Error(validation.errors.join(' '));
        }

        const baseUrl = (config.gitlabUrl || 'https://gitlab.com').replace(/\/+$/, '');
        const token = config.token;

        try {
            const response = await axios.get(`${baseUrl}/api/v4/user`, {
                headers: { 'PRIVATE-TOKEN': token },
                timeout: 8000
            });

            this.log('info', 'GitLab connection successful', { username: response.data?.username });
            return {
                connected: true,
                user: response.data?.username,
                name: response.data?.name,
                email: response.data?.email,
                avatarUrl: response.data?.avatar_url
            };
        } catch (err) {
            // If user token fails, try project token
            try {
                const projRes = await axios.get(`${baseUrl}/api/v4/projects`, {
                    headers: { 'PRIVATE-TOKEN': token },
                    params: { per_page: 1, membership: true },
                    timeout: 8000
                });
                return {
                    connected: true,
                    projectAccess: true,
                    projectsCount: projRes.data?.length || 1
                };
            } catch (err2) {
                const status = err.response?.status;
                const msg = err.response?.data?.message || err.message;
                this.log('error', 'GitLab connection test failed', { error: msg, status });
                throw new Error(`GitLab authentication failed (${status || 'Network'}): ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
            }
        }
    }

    /**
     * Fetch external issues / tasks from GitLab
     */
    async fetchTasks(config = {}, options = {}) {
        const baseUrl = (config.gitlabUrl || 'https://gitlab.com').replace(/\/+$/, '');
        const token = config.token;
        const projectId = options.projectId || config.projectId;
        const limit = options.limit || 50;

        let endpoint = `${baseUrl}/api/v4/issues`;
        if (projectId) {
            endpoint = `${baseUrl}/api/v4/projects/${encodeURIComponent(projectId)}/issues`;
        }

        try {
            const res = await axios.get(endpoint, {
                headers: { 'PRIVATE-TOKEN': token },
                params: { per_page: limit, scope: 'all' },
                timeout: 10000
            });

            const rawIssues = Array.isArray(res.data) ? res.data : [];
            const normalized = rawIssues.map(issue => this.normalizeTask(issue));

            return {
                tasks: normalized,
                total: normalized.length
            };
        } catch (err) {
            this.log('error', 'Failed fetching GitLab issues', { error: err.message });
            throw new Error(`GitLab fetch tasks failed: ${err.response?.data?.message || err.message}`);
        }
    }

    /**
     * Normalize GitLab issue into unified Task format
     */
    normalizeTask(issue) {
        let status = 'BACKLOG';
        if (issue.state === 'closed') status = 'FINALIZED';
        else if (issue.labels?.includes('QA') || issue.labels?.includes('quality-assurance')) status = 'QUALITY_ASSURANCE';
        else if (issue.labels?.includes('In Progress') || issue.labels?.includes('doing')) status = 'IN_OPERATIONS';

        return {
            externalId: `gitlab-${issue.id}`,
            iid: issue.iid,
            title: issue.title || 'Untitled Issue',
            description: issue.description || '',
            status,
            priority: issue.weight ? (issue.weight > 3 ? 'High' : 'Medium') : 'Medium',
            dueDate: issue.due_date || null,
            externalUrl: issue.web_url || '',
            assignee: issue.assignee?.name || issue.assignees?.[0]?.name || 'Unassigned',
            labels: issue.labels || [],
            source: 'gitlab',
            raw: issue
        };
    }

    /**
     * Validate incoming GitLab Webhook Secret Token
     */
    validateWebhookSignature(req, secret) {
        const receivedToken = req.headers['x-gitlab-token'];
        if (!secret) return true; // If no secret configured, allow with warning
        return receivedToken === secret;
    }

    /**
     * Process incoming GitLab Webhook Event
     */
    async handleWebhook(payload = {}, headers = {}) {
        const eventType = headers['x-gitlab-event'] || payload.object_kind || 'unknown';
        this.log('info', `Received GitLab Webhook Event: ${eventType}`);

        if (eventType === 'Issue Hook' || payload.object_kind === 'issue') {
            const issue = payload.object_attributes || payload;
            const action = issue.action || 'update';
            const mappedTask = this.normalizeTask(issue);

            // Sync with internal tasks if matching externalId or title exists
            const existing = await prisma.task.findFirst({
                where: {
                    OR: [
                        { id: mappedTask.externalId },
                        { title: mappedTask.title }
                    ]
                }
            });

            if (existing) {
                await prisma.task.update({
                    where: { id: existing.id },
                    data: {
                        status: mappedTask.status,
                        description: mappedTask.description || existing.description
                    }
                });
            }

            return {
                processed: true,
                eventType: 'issue',
                action,
                taskTitle: mappedTask.title,
                status: mappedTask.status
            };
        }

        if (eventType === 'Push Hook' || payload.object_kind === 'push') {
            const commits = payload.commits || [];
            const user = payload.user_name || payload.user_username || 'Developer';
            this.log('info', `GitLab push event with ${commits.length} commit(s) by ${user}`);

            return {
                processed: true,
                eventType: 'push',
                user,
                commitsCount: commits.length,
                branch: payload.ref
            };
        }

        if (eventType === 'Merge Request Hook' || payload.object_kind === 'merge_request') {
            const mr = payload.object_attributes || {};
            const state = mr.state || 'opened';

            return {
                processed: true,
                eventType: 'merge_request',
                title: mr.title,
                state
            };
        }

        return {
            processed: true,
            eventType,
            status: 'RECEIVED'
        };
    }
}

module.exports = new GitLabConnector();
