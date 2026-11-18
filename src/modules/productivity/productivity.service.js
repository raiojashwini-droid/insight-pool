const prisma = require('../../config/db');
const {
    ensureDefaultTags,
    productivityFromTagName,
    ruleDomainKey,
    backfillProductivityForApp,
    autoLabelOrganization,
} = require('../../utils/productivityRules');

const productivityService = {
    // ── Tags ────────────────────────────────────────────────────────
    getTags: async (organizationId) => {
        await ensureDefaultTags(organizationId);
        return await prisma.productivityTag.findMany({
            where: { organizationId },
            include: { _count: { select: { rules: true } } }
        });
    },

    createTag: async (organizationId, data) => {
        return await prisma.productivityTag.create({
            data: {
                ...data,
                organizationId
            }
        });
    },

    updateTag: async (tagId, data) => {
        return await prisma.productivityTag.update({
            where: { id: tagId },
            data
        });
    },

    deleteTag: async (tagId) => {
        return await prisma.productivityTag.delete({
            where: { id: tagId }
        });
    },

    // ── Rules (Branding/Classification) ──────────────────────────────
    getRules: async (organizationId, teamId = null) => {
        const where = { organizationId };
        if (teamId) {
            // Return both team-specific and global rules
            where.OR = [
                { teamId },
                { teamId: null }
            ];
            delete where.organizationId;
            return await prisma.productivityRule.findMany({
                where: {
                    organizationId,
                    OR: [
                        { teamId },
                        { teamId: null }
                    ]
                },
                include: { tag: true, team: true }
            });
        }
        return await prisma.productivityRule.findMany({
            where: { organizationId },
            include: { tag: true, team: true }
        });
    },

    getRulesByTeam: async (organizationId, teamId) => {
        return await prisma.productivityRule.findMany({
            where: { organizationId, teamId },
            include: { tag: true, team: true }
        });
    },

    upsertRule: async (organizationId, data) => {
        const { domain, appName, tagId, category, productivity: explicitProductivity, teamId } = data;
        const domainKey = ruleDomainKey(domain, appName);

        // Resolve teamId - null means global rule
        const resolvedTeamId = teamId || null;

        let productivity = explicitProductivity || 'NEUTRAL';
        let resolvedTagId = tagId || null;

        if (tagId) {
            const tag = await prisma.productivityTag.findFirst({
                where: { id: tagId, organizationId },
            });
            if (tag) {
                productivity = productivityFromTagName(tag.name);
                resolvedTagId = tag.id;
            }
        } else if (tagId === null) {
            resolvedTagId = null;
        }

        // Look for existing rule matching organization, domain, and specific team (or global null)
        const existingRule = await prisma.productivityRule.findFirst({
            where: {
                organizationId,
                domain: domainKey,
                teamId: resolvedTeamId,
            },
        });

        let rule;
        if (existingRule) {
            rule = await prisma.productivityRule.update({
                where: { id: existingRule.id },
                data: {
                    appName: appName || undefined,
                    tagId: resolvedTagId,
                    productivity,
                    category: category || 'Uncategorized',
                },
                include: { tag: true, team: true },
            });
        } else {
            rule = await prisma.productivityRule.create({
                data: {
                    organizationId,
                    domain: domainKey,
                    appName: appName || null,
                    tagId: resolvedTagId,
                    productivity,
                    category: category || 'Uncategorized',
                    teamId: resolvedTeamId,
                },
                include: { tag: true, team: true },
            });
        }

        // Only backfill for global rules (no teamId) to avoid overwriting
        // department-specific data in shared tables
        if (appName && !resolvedTeamId) {
            await backfillProductivityForApp(
                organizationId,
                domainKey,
                appName,
                productivity,
                rule.category
            );
        }

        return rule;
    },

    autoLabelApps: async (organizationId) => autoLabelOrganization(organizationId),

    // ── Usage ────────────────────────────────────────────────────────
    getAppsUsage: async (organizationId, startDate, endDate, teamId = null) => {
        const where = { organizationId };
        if (startDate || endDate) {
            where.timestamp = {};
            if (startDate) where.timestamp.gte = new Date(startDate);
            if (endDate) where.timestamp.lte = new Date(endDate);
        }

        // If teamId filter, only get logs for employees in that team
        if (teamId) {
            where.employee = { teamId };
        }

        // Fetch all rules - both global and team-specific if teamId given
        const rulesWhere = { organizationId };
        let teamRules = [];
        let globalRules = [];

        const [logs, allRules, actLogs] = await Promise.all([
            prisma.appUsageLog.findMany({
                where,
                include: teamId ? { employee: { select: { teamId: true } } } : undefined
            }),
            prisma.productivityRule.findMany({
                where: { organizationId },
                include: { tag: true }
            }),
            prisma.activityLog.findMany({
                where: {
                    organizationId,
                    ...(startDate || endDate ? { timestamp: where.timestamp } : {})
                },
                select: { appWebsite: true, duration: true, productivity: true }
            })
        ]);

        // Separate rules into team-specific and global
        if (teamId) {
            teamRules = allRules.filter(r => r.teamId === teamId);
            globalRules = allRules.filter(r => !r.teamId);
        } else {
            globalRules = allRules.filter(r => !r.teamId);
        }

        // Build lookup maps
        const buildMaps = (rules) => ({
            byDomain: new Map(rules.map((r) => [r.domain, r])),
            byApp: new Map(
                rules.filter((r) => r.appName).map((r) => [r.appName.toLowerCase(), r])
            )
        });

        const teamMaps = buildMaps(teamRules);
        const globalMaps = buildMaps(globalRules);

        const appMap = {};

        // 1. Process AppUsageLog entries
        logs.forEach(log => {
            const key = log.appName;
            if (!appMap[key]) {
                let rule = null;
                if (teamId) {
                    rule =
                        teamMaps.byDomain.get(log.domain) ||
                        teamMaps.byDomain.get(ruleDomainKey(log.domain, log.appName)) ||
                        teamMaps.byApp.get((log.appName || '').toLowerCase());
                }
                if (!rule) {
                    rule =
                        globalMaps.byDomain.get(log.domain) ||
                        globalMaps.byDomain.get(ruleDomainKey(log.domain, log.appName)) ||
                        globalMaps.byApp.get((log.appName || '').toLowerCase());
                }

                const productivity = rule?.productivity || log.productivity;
                appMap[key] = {
                    id: ruleDomainKey(log.domain, log.appName),
                    appName: log.appName,
                    domain: log.domain || ruleDomainKey(log.domain, log.appName),
                    category: rule?.category || log.category,
                    productivity,
                    productivityLabel: productivity,
                    tagId: rule?.tagId || null,
                    tag: rule?.tag || null,
                    teamId: rule?.teamId || null,
                    isTeamSpecific: rule?.teamId ? true : false,
                    totalUsage: 0,
                };
            }
            appMap[key].totalUsage += log.duration || 0;
        });

        // 2. Process ActivityLog entries (fallback / supplemental)
        actLogs.forEach(act => {
            const key = act.appWebsite || 'Unknown';
            if (key === 'Unknown') return;
            if (!appMap[key]) {
                let rule = teamMaps.byApp.get(key.toLowerCase()) || globalMaps.byApp.get(key.toLowerCase());
                const productivity = rule?.productivity || act.productivity;
                appMap[key] = {
                    id: ruleDomainKey('', key),
                    appName: key,
                    domain: key.toLowerCase().replace(/\s+/g, '-'),
                    category: rule?.category || 'General',
                    productivity,
                    productivityLabel: productivity,
                    tagId: rule?.tagId || null,
                    tag: rule?.tag || null,
                    teamId: rule?.teamId || null,
                    isTeamSpecific: rule?.teamId ? true : false,
                    totalUsage: 0,
                };
            }
            appMap[key].totalUsage += act.duration || 0;
        });

        // 3. Include any configured rules that haven't registered usage yet
        allRules.forEach(rule => {
            const key = rule.appName || rule.domain;
            if (key && !appMap[key]) {
                appMap[key] = {
                    id: rule.domain || rule.appName,
                    appName: rule.appName || rule.domain,
                    domain: rule.domain || '',
                    category: rule.category || 'Uncategorized',
                    productivity: rule.productivity || 'NEUTRAL',
                    productivityLabel: rule.productivity || 'NEUTRAL',
                    tagId: rule.tagId || null,
                    tag: rule.tag || null,
                    teamId: rule.teamId || null,
                    isTeamSpecific: rule.teamId ? true : false,
                    totalUsage: 0,
                };
            }
        });

        // 4. Default Seed if brand new organization
        if (Object.keys(appMap).length === 0) {
            APPS.forEach(defaultApp => {
                const key = defaultApp.name;
                appMap[key] = {
                    id: defaultApp.domain,
                    appName: defaultApp.name,
                    domain: defaultApp.domain,
                    category: defaultApp.category,
                    productivity: defaultApp.productivity,
                    productivityLabel: defaultApp.productivity,
                    tagId: null,
                    tag: null,
                    teamId: null,
                    isTeamSpecific: false,
                    totalUsage: 0,
                };
            });
        }

        return Object.values(appMap)
            .map(app => ({
                ...app,
                totalUsageHours: Math.round((app.totalUsage / 3600) * 10) / 10,
                totalUsage: Math.round((app.totalUsage / 3600) * 10) / 10,
            }))
            .sort((a, b) => b.totalUsage - a.totalUsage);
    },
};

const APPS = [
    { name: 'VS Code', domain: 'visualstudio.com', category: 'Development', productivity: 'PRODUCTIVE' },
    { name: 'Google Chrome', domain: 'google.com', category: 'Research', productivity: 'PRODUCTIVE' },
    { name: 'Slack', domain: 'slack.com', category: 'Communication', productivity: 'PRODUCTIVE' },
    { name: 'Zoom', domain: 'zoom.us', category: 'Meeting', productivity: 'NEUTRAL' },
    { name: 'Spotify', domain: 'spotify.com', category: 'Entertainment', productivity: 'UNPRODUCTIVE' },
    { name: 'YouTube', domain: 'youtube.com', category: 'Entertainment', productivity: 'UNPRODUCTIVE' },
    { name: 'Terminal', domain: 'iterm2.com', category: 'Development', productivity: 'PRODUCTIVE' }
];

module.exports = { ...productivityService, APPS };
