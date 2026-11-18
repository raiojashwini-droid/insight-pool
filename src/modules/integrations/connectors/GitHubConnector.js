const axios = require('axios');
const crypto = require('crypto');
const BaseConnector = require('./BaseConnector');
const prisma = require('../../../config/db');

/**
 * GitHubConnector
 * Integration with GitHub REST API v3 & Webhooks
 */
class GitHubConnector extends BaseConnector {
    constructor() {
        super('github');
    }

    validateConfig(config = {}) {
        const errors = [];
        if (!config.token) errors.push('GitHub Personal Access Token is required.');
        return { isValid: errors.length === 0, errors };
    }

    async testConnection(config = {}) {
        const token = config.token;
        if (!token) throw new Error('GitHub token is required');
        try {
            const res = await axios.get('https://api.github.com/user', {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'User-Agent': 'Insightful-Employee-Monitor'
                },
                timeout: 8000
            });
            return {
                connected: true,
                user: res.data?.login,
                name: res.data?.name,
                publicRepos: res.data?.public_repos
            };
        } catch (err) {
            throw new Error(`GitHub authentication failed: ${err.response?.data?.message || err.message}`);
        }
    }

    async fetchTasks(config = {}, options = {}) {
        const token = config.token;
        const repo = options.repo || config.repo;
        if (!repo) throw new Error('GitHub repository (owner/repo) is required to fetch issues');

        const res = await axios.get(`https://api.github.com/repos/${repo}/issues`, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'User-Agent': 'Insightful-Employee-Monitor'
            },
            params: { state: 'all', per_page: options.limit || 50 }
        });

        const tasks = (res.data || []).map(issue => ({
            externalId: `github-${issue.id}`,
            number: issue.number,
            title: issue.title,
            description: issue.body || '',
            status: issue.state === 'closed' ? 'FINALIZED' : 'IN_OPERATIONS',
            assignee: issue.assignee?.login || 'Unassigned',
            externalUrl: issue.html_url,
            source: 'github'
        }));

        return { tasks, total: tasks.length };
    }

    validateWebhookSignature(req, secret) {
        if (!secret) return true;
        const signature = req.headers['x-hub-signature-256'];
        if (!signature) return false;
        const hmac = crypto.createHmac('sha256', secret);
        const digest = 'sha256=' + hmac.update(JSON.stringify(req.body)).digest('hex');
        return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest));
    }

    async handleWebhook(payload = {}, headers = {}) {
        const event = headers['x-github-event'] || 'push';
        this.log('info', `GitHub Webhook event received: ${event}`);
        return { processed: true, event, status: 'PROCESSED' };
    }
}

module.exports = new GitHubConnector();
