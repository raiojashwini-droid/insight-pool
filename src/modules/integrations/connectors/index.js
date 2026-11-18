const jiraConnector = require('./JiraConnector');
const clickupConnector = require('./ClickUpConnector');
const gitlabConnector = require('./GitLabConnector');
const githubConnector = require('./GitHubConnector');

const connectors = {
    jira: jiraConnector,
    clickup: clickupConnector,
    gitlab: gitlabConnector,
    github: githubConnector,
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
    gitlabConnector,
    githubConnector,
    getConnector,
    supportedProviders: Object.keys(connectors),
};
