const { resolveAppActivity } = require('./resolveAppActivity');
const { getRulesWithTags, findMatchingRule, applyRuleToResolved } = require('./productivityRules');

async function resolveAppActivityForOrg(organizationId, activeApp, activeWindow, teamId = null) {
    const base = resolveAppActivity(activeApp, activeWindow);
    if (!organizationId) return base;

    try {
        const rules = await getRulesWithTags(organizationId);
        const rule = findMatchingRule(rules, base.cleanAppName, base.appDomain, activeWindow, teamId);
        return applyRuleToResolved(base, rule);
    } catch (err) {
        console.error('[resolveAppActivityForOrg] Rule lookup failed:', err.message);
        return base;
    }
}

module.exports = { resolveAppActivityForOrg };
