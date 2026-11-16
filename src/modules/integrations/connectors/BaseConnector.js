const logger = require('../../../utils/logger');

/**
 * BaseConnector
 * Abstract contract for external project management integrations (Jira, ClickUp, etc.)
 */
class BaseConnector {
    constructor(providerName) {
        if (new.target === BaseConnector) {
            throw new TypeError('Cannot construct BaseConnector instances directly.');
        }
        this.provider = providerName;
    }

    /**
     * Log structured message with provider tag
     */
    log(level, message, meta = {}) {
        const payload = { provider: this.provider, timestamp: new Date().toISOString(), ...meta };
        if (logger[level]) {
            logger[level](`[${this.provider.toUpperCase()} CONNECTOR] ${message}`, payload);
        } else {
            console.log(`[${this.provider.toUpperCase()} CONNECTOR] [${level.toUpperCase()}] ${message}`, payload);
        }
    }

    /**
     * Validate credentials and connection configuration
     */
    validateConfig(config) {
        throw new Error('validateConfig() must be implemented by subclass.');
    }

    /**
     * Test connection to external API with credentials
     */
    async testConnection(config) {
        throw new Error('testConnection() must be implemented by subclass.');
    }

    /**
     * Fetch external tasks
     */
    async fetchTasks(config, options = {}) {
        throw new Error('fetchTasks() must be implemented by subclass.');
    }

    /**
     * Normalize an external task into internal schema
     */
    normalizeTask(externalTask) {
        throw new Error('normalizeTask() must be implemented by subclass.');
    }

    /**
     * Validate incoming webhook request signature
     */
    validateWebhookSignature(req, secret) {
        throw new Error('validateWebhookSignature() must be implemented by subclass.');
    }

    /**
     * Process webhook payload
     */
    async handleWebhook(payload, headers) {
        throw new Error('handleWebhook() must be implemented by subclass.');
    }

    /**
     * Standard error parser for network and rate limit handling
     */
    handleApiError(error, context = '') {
        const status = error.response?.status;
        const data = error.response?.data;

        if (status === 401 || status === 403) {
            this.log('error', `Authentication failure in ${context}`, { status, data });
            return new Error(`Authentication failed for ${this.provider}. Please verify API tokens and permissions.`);
        }

        if (status === 429) {
            const retryAfter = error.response?.headers?.['retry-after'] || error.response?.headers?.['x-ratelimit-reset'] || 'unknown';
            this.log('warn', `Rate limit exceeded in ${context}`, { retryAfter });
            return new Error(`Rate limit exceeded for ${this.provider}. Retry after ${retryAfter}s.`);
        }

        if (error.code === 'ECONNABORTED' || error.code === 'ENOTFOUND' || !error.response) {
            this.log('error', `Network connection failure in ${context}: ${error.message}`);
            return new Error(`Network failure connecting to ${this.provider} API: ${error.message}`);
        }

        this.log('error', `API error in ${context}`, { status, message: error.message, data });
        return new Error(`${this.provider} API error: ${data?.message || data?.errorMessages?.[0] || error.message}`);
    }
}

module.exports = BaseConnector;
