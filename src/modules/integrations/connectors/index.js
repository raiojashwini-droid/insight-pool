const jiraConnector = require('./JiraConnector');
const clickupConnector = require('./ClickUpConnector');

const connectors = {
    jira: jiraConnector,
    clickup: clickupConnector,
};

/**
 * Get connector instance by provider name
 */
function getConnector(providerName) {
    const key = (providerName || '').toLowerCase().trim();
    const connector = connectors[key];
    if (!connector) {
        throw new Error(`Unsupported integration provider: "${providerName}". Supported providers: ${Object.keys(connectors).join(', ')}`);
    }
    return connector;
}

module.exports = {
    jiraConnector,
    clickupConnector,
    getConnector,
    supportedProviders: Object.keys(connectors),
};
