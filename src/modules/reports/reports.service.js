const prisma = require('../../config/db');
const { getOrganizationId } = require('../../utils/orgId');

/**
 * Builds a generic filter object for reports.
 */
const buildReportFilter = (organizationId, startDate, endDate, params = {}) => {
    const { userId, teamId } = params;
    const where = { organizationId };

    if (startDate || endDate) {
        where.timestamp = {};
        if (startDate) {
            const parsedStart = new Date(startDate);
            where.timestamp.gte = isNaN(parsedStart.getTime()) ? startDate : parsedStart;
        }
        if (endDate) {
            const parsedEnd = new Date(endDate);
            where.timestamp.lte = isNaN(parsedEnd.getTime()) ? endDate : parsedEnd;
        }
    }

    if (userId) {
        where.employeeId = userId;
    } else if (teamId) {
        where.employee = { teamId: teamId };
    }

    return where;
};

const STANDARD_REPORT_CATEGORIES = [
    'Development tools',
    'Collaborative software',
    'AI tools',
    'PM tools',
    'Communication',
    'Education',
    'Advertising tools',
    'Social & Professional network',
    'Adult / Illegal',
    'Art & Entertainment',
    'Services',
    'News',
];

function normalizeCategoryName(rawCategory, appName = '', domain = '') {
    const cat = (rawCategory || '').trim();
    const lower = `${cat} ${appName} ${domain}`.toLowerCase();

    if (lower.includes('development') || lower.includes('vs code') || lower.includes('cursor') || lower.includes('terminal') || lower.includes('github') || lower.includes('visualstudio') || lower.includes('code')) {
        return 'Development tools';
    }
    if (lower.includes('collaborative') || lower.includes('zoom') || lower.includes('teams') || lower.includes('meet') || lower.includes('webex') || lower.includes('miro') || lower.includes('meeting')) {
        return 'Collaborative software';
    }
    if (lower.includes('ai') || lower.includes('chatgpt') || lower.includes('claude') || lower.includes('antigravity') || lower.includes('gemini') || lower.includes('copilot') || lower.includes('openai')) {
        return 'AI tools';
    }
    if (lower.includes('pm') || lower.includes('project management') || lower.includes('jira') || lower.includes('linear') || lower.includes('trello') || lower.includes('asana') || lower.includes('notion')) {
        return 'PM tools';
    }
    if (lower.includes('communication') || lower.includes('slack') || lower.includes('gmail') || lower.includes('outlook') || lower.includes('mail') || lower.includes('discord')) {
        return 'Communication';
    }
    if (lower.includes('education') || lower.includes('learning') || lower.includes('stack overflow') || lower.includes('coursera') || lower.includes('udemy') || lower.includes('docs')) {
        return 'Education';
    }
    if (lower.includes('advertising') || lower.includes('ads') || lower.includes('analytics') || lower.includes('marketing')) {
        return 'Advertising tools';
    }
    if (lower.includes('social') || lower.includes('linkedin') || lower.includes('twitter') || lower.includes('x.com') || lower.includes('reddit') || lower.includes('facebook') || lower.includes('instagram')) {
        return 'Social & Professional network';
    }
    if (lower.includes('adult') || lower.includes('illegal') || lower.includes('gambling') || lower.includes('bet') || lower.includes('restricted')) {
        return 'Adult / Illegal';
    }
    if (lower.includes('entertainment') || lower.includes('youtube') || lower.includes('spotify') || lower.includes('netflix') || lower.includes('media') || lower.includes('music') || lower.includes('video')) {
        return 'Art & Entertainment';
    }
    if (lower.includes('services') || lower.includes('aws') || lower.includes('cloudflare') || lower.includes('stripe') || lower.includes('azure') || lower.includes('cloud')) {
        return 'Services';
    }
    if (lower.includes('news') || lower.includes('hacker news') || lower.includes('techcrunch') || lower.includes('cnn') || lower.includes('bbc')) {
        return 'News';
    }
    if (lower.includes('design') || lower.includes('figma') || lower.includes('canva') || lower.includes('adobe') || lower.includes('photoshop')) {
        return 'Design';
    }
    return cat || 'Other tools';
}

function formatHM(totalSeconds) {
    if (!totalSeconds || totalSeconds <= 0) return '00:00 h';
    const hours = Math.floor(totalSeconds / 3600);
    const mins = Math.floor((totalSeconds % 3600) / 60);
    return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')} h`;
}

function formatPrettyDate(d) {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

/**
 * Work Type — Category tab: Comprehensive dynamic category usage overview
 * matching Image 1 (Total hours, Locations Office vs Remote, Productivity Level,
 * and Comparison periods with hover popovers).
 */
const getWorkTypeByCategory = async (organizationId, startDate, endDate, params = {}) => {
    const start = new Date(startDate);
    const end = new Date(endDate);
    const durationMs = Math.max(86400000, end.getTime() - start.getTime() + 1);

    const compEnd = params.compareEndDate ? new Date(params.compareEndDate) : new Date(start.getTime() - 1);
    const compStart = params.compareStartDate ? new Date(params.compareStartDate) : new Date(compEnd.getTime() - durationMs + 1);

    const currentWhere = buildReportFilter(organizationId, start, end, params);
    const compWhere = buildReportFilter(organizationId, compStart, compEnd, params);

    // Fetch current and comparison logs in parallel from MySQL
    const [currentLogs, compLogs, currentActivity, compActivity] = await Promise.all([
        prisma.appUsageLog.findMany({
            where: currentWhere,
            include: { employee: { select: { id: true, fullName: true, location: true, workMode: true } } }
        }),
        prisma.appUsageLog.findMany({
            where: compWhere,
            include: { employee: { select: { id: true, fullName: true, location: true, workMode: true } } }
        }),
        prisma.activityLog.findMany({
            where: currentWhere,
            include: { employee: { select: { id: true, fullName: true, location: true, workMode: true } } }
        }),
        prisma.activityLog.findMany({
            where: compWhere,
            include: { employee: { select: { id: true, fullName: true, location: true, workMode: true } } }
        })
    ]);

    // Data accumulator per category
    const categoryStats = {};
    const getInitBucket = () => ({
        totalSeconds: 0,
        officeSeconds: 0,
        remoteSeconds: 0,
        productiveSeconds: 0,
        unproductiveSeconds: 0,
        neutralSeconds: 0
    });

    STANDARD_REPORT_CATEGORIES.forEach(cat => {
        categoryStats[cat] = {
            name: cat,
            current: getInitBucket(),
            comparison: getInitBucket()
        };
    });

    const uniqueApps = new Set();

    // Process logs helper
    const processItem = (item, isComparison = false) => {
        const catName = normalizeCategoryName(item.category || item.appWebsite, item.appName || item.appWebsite, item.domain);
        if (!categoryStats[catName]) {
            categoryStats[catName] = {
                name: catName,
                current: getInitBucket(),
                comparison: getInitBucket()
            };
        }

        const bucket = isComparison ? categoryStats[catName].comparison : categoryStats[catName].current;
        const dur = Number(item.duration) || 0;
        bucket.totalSeconds += dur;

        // Track unique apps
        if (!isComparison && (item.appName || item.appWebsite)) {
            uniqueApps.add(item.appName || item.appWebsite);
        }

        // Location: Office vs Remote
        const empLoc = `${item.employee?.location || ''} ${item.employee?.workMode || ''}`.toLowerCase();
        const isOffice = empLoc.includes('office');
        if (isOffice) {
            bucket.officeSeconds += dur;
        } else {
            bucket.remoteSeconds += dur;
        }

        // Productivity
        const prod = (item.productivity || 'NEUTRAL').toUpperCase();
        if (prod === 'PRODUCTIVE') bucket.productiveSeconds += dur;
        else if (prod === 'UNPRODUCTIVE') bucket.unproductiveSeconds += dur;
        else bucket.neutralSeconds += dur;
    };

    // Aggregate Current Period
    currentLogs.forEach(l => processItem(l, false));
    // If app logs were minimal, aggregate active work sessions from activityLog
    if (currentLogs.length === 0) {
        currentActivity.forEach(a => processItem(a, false));
    }

    // Aggregate Comparison Period
    compLogs.forEach(l => processItem(l, true));
    if (compLogs.length === 0) {
        compActivity.forEach(a => processItem(a, true));
    }

    let grandTotalSeconds = 0;
    let grandProductiveSeconds = 0;
    let maxCategorySeconds = 1;

    // Compute metrics and percentages for each category
    const categoriesArray = Object.values(categoryStats).map(cat => {
        const cur = cat.current;
        const comp = cat.comparison;

        grandTotalSeconds += cur.totalSeconds;
        grandProductiveSeconds += cur.productiveSeconds;
        if (cur.totalSeconds > maxCategorySeconds) {
            maxCategorySeconds = cur.totalSeconds;
        }

        // Current Location breakdown
        const curLocTotal = cur.totalSeconds || 1;
        const curOfficePct = Math.round((cur.officeSeconds / curLocTotal) * 100);
        const curRemotePct = 100 - curOfficePct;
        const curDominantLoc = curOfficePct >= curRemotePct ? 'Office' : 'Remote';
        const curDominantLocPct = curDominantLoc === 'Office' ? curOfficePct : curRemotePct;

        // Current Productivity breakdown
        const curProdTotal = cur.totalSeconds || 1;
        const curProdPct = Math.round((cur.productiveSeconds / curProdTotal) * 100);
        const curUnprodPct = Math.round((cur.unproductiveSeconds / curProdTotal) * 100);
        const curNeutPct = Math.max(0, 100 - curProdPct - curUnprodPct);

        let curDominantProd = 'Productive';
        let curDominantProdSec = cur.productiveSeconds;
        if (cur.unproductiveSeconds > curDominantProdSec) {
            curDominantProd = 'Unproductive';
            curDominantProdSec = cur.unproductiveSeconds;
        }
        if (cur.neutralSeconds > curDominantProdSec) {
            curDominantProd = 'Neutral';
            curDominantProdSec = cur.neutralSeconds;
        }

        // Comparison Location breakdown
        const compLocTotal = comp.totalSeconds || 1;
        const compOfficePct = Math.round((comp.officeSeconds / compLocTotal) * 100);
        const compRemotePct = 100 - compOfficePct;
        const compDominantLoc = compOfficePct >= compRemotePct ? 'Office' : 'Remote';
        const compDominantLocPct = compDominantLoc === 'Office' ? compOfficePct : compRemotePct;

        // Comparison Productivity breakdown
        const compProdTotal = comp.totalSeconds || 1;
        const compProdPct = Math.round((comp.productiveSeconds / compProdTotal) * 100);
        const compUnprodPct = Math.round((comp.unproductiveSeconds / compProdTotal) * 100);
        const compNeutPct = Math.max(0, 100 - compProdPct - compUnprodPct);

        let compDominantProd = 'Productive';
        let compDominantProdSec = comp.productiveSeconds;
        if (comp.unproductiveSeconds > compDominantProdSec) {
            compDominantProd = 'Unproductive';
            compDominantProdSec = comp.unproductiveSeconds;
        }
        if (comp.neutralSeconds > compDominantProdSec) {
            compDominantProd = 'Neutral';
            compDominantProdSec = comp.neutralSeconds;
        }

        return {
            name: cat.name,
            current: {
                totalSeconds: cur.totalSeconds,
                formattedTotal: formatHM(cur.totalSeconds),
                locations: {
                    officeSeconds: cur.officeSeconds,
                    remoteSeconds: cur.remoteSeconds,
                    formattedOffice: formatHM(cur.officeSeconds),
                    formattedRemote: formatHM(cur.remoteSeconds),
                    officePct: curOfficePct,
                    remotePct: curRemotePct,
                    dominant: curDominantLoc,
                    dominantLabel: `${curDominantLocPct}% ${curDominantLoc}`
                },
                productivity: {
                    productiveSeconds: cur.productiveSeconds,
                    unproductiveSeconds: cur.unproductiveSeconds,
                    neutralSeconds: cur.neutralSeconds,
                    formattedProductive: formatHM(cur.productiveSeconds),
                    formattedUnproductive: formatHM(cur.unproductiveSeconds),
                    formattedNeutral: formatHM(cur.neutralSeconds),
                    productivePct: curProdPct,
                    unproductivePct: curUnprodPct,
                    neutralPct: curNeutPct,
                    dominant: curDominantProd,
                    dominantLabel: `${formatHM(curDominantProdSec)} ${curDominantProd}`
                }
            },
            comparison: {
                totalSeconds: comp.totalSeconds,
                formattedTotal: formatHM(comp.totalSeconds),
                locations: {
                    officeSeconds: comp.officeSeconds,
                    remoteSeconds: comp.remoteSeconds,
                    formattedOffice: formatHM(comp.officeSeconds),
                    formattedRemote: formatHM(comp.remoteSeconds),
                    officePct: compOfficePct,
                    remotePct: compRemotePct,
                    dominant: compDominantLoc,
                    dominantLabel: `${compDominantLocPct}% ${compDominantLoc}`
                },
                productivity: {
                    productiveSeconds: comp.productiveSeconds,
                    unproductiveSeconds: comp.unproductiveSeconds,
                    neutralSeconds: comp.neutralSeconds,
                    formattedProductive: formatHM(comp.productiveSeconds),
                    formattedUnproductive: formatHM(comp.unproductiveSeconds),
                    formattedNeutral: formatHM(comp.neutralSeconds),
                    productivePct: compProdPct,
                    unproductivePct: compUnprodPct,
                    neutralPct: compNeutPct,
                    dominant: compDominantProd,
                    dominantLabel: `${formatHM(compDominantProdSec)} ${compDominantProd}`
                }
            }
        };
    });

    // Sort by Total Hours descending
    categoriesArray.sort((a, b) => b.current.totalSeconds - a.current.totalSeconds);

    // Compute relative width percentage for visual bars
    categoriesArray.forEach(c => {
        c.current.barWidthPct = maxCategorySeconds > 0 ? Math.max(4, Math.round((c.current.totalSeconds / maxCategorySeconds) * 100)) : 0;
        c.comparison.barWidthPct = maxCategorySeconds > 0 ? Math.max(4, Math.round((c.comparison.totalSeconds / maxCategorySeconds) * 100)) : 0;
    });

    // Return standard object structure with categories array, summary, and dateRanges
    return {
        categories: categoriesArray,
        summary: {
            totalHours: Math.round((grandTotalSeconds / 3600) * 10) / 10,
            totalSeconds: grandTotalSeconds,
            formattedTotal: formatHM(grandTotalSeconds),
            productivityScore: grandTotalSeconds > 0 ? Math.round((grandProductiveSeconds / grandTotalSeconds) * 100) : 0,
            trackedAppsCount: uniqueApps.size || 1
        },
        dateRanges: {
            current: {
                start: start.toISOString().split('T')[0],
                end: end.toISOString().split('T')[0],
                formatted: `${formatPrettyDate(start)} - ${formatPrettyDate(end)}`
            },
            comparison: {
                start: compStart.toISOString().split('T')[0],
                end: compEnd.toISOString().split('T')[0],
                formatted: `${formatPrettyDate(compStart)} - ${formatPrettyDate(compEnd)}`
            }
        }
    };
};

/**
 * Work Type — Tags tab: Focus, Collaborative, Distraction, etc. (admin labels).
 */
const getWorkTypeByTags = async (organizationId, startDate, endDate, params) => {
    const where = buildReportFilter(organizationId, startDate, endDate, params);

    let [logs, rules] = await Promise.all([
        prisma.appUsageLog.findMany({
            where,
            select: { duration: true, domain: true, appName: true },
        }),
        prisma.productivityRule.findMany({
            where: { organizationId },
            include: { tag: true },
        }),
    ]);

    // Fallback: If no AppUsageLogs, fallback to ActivityLog appWebsite
    if (!logs || logs.length === 0) {
        const actLogs = await prisma.activityLog.findMany({
            where,
            select: { duration: true, appWebsite: true },
        });
        logs = actLogs.map((l) => ({
            duration: l.duration,
            domain: l.appWebsite || '',
            appName: l.appWebsite || '',
        }));
    }

    const ruleByDomain = new Map(rules.map((r) => [r.domain, r]));
    const ruleByApp = new Map(
        rules.filter((r) => r.appName).map((r) => [r.appName.toLowerCase(), r])
    );

    const tagTotals = {};

    logs.forEach((log) => {
        const rule =
            ruleByDomain.get(log.domain) ||
            ruleByApp.get((log.appName || '').toLowerCase());
        const tagName = rule?.tag?.name || 'Unassigned';
        const tagColor = rule?.tag?.color || '#94a3b8';
        const tagId = rule?.tag?.id || null;

        if (!tagTotals[tagName]) {
            tagTotals[tagName] = { tagName, tagColor, tagId, duration: 0 };
        }
        tagTotals[tagName].duration += log.duration || 0;
    });

    return Object.values(tagTotals)
        .map((t) => ({
            tagName: t.tagName,
            tagColor: t.tagColor,
            tagId: t.tagId,
            duration: t.duration,
        }))
        .sort((a, b) => b.duration - a.duration);
};

/** @deprecated use getWorkTypeByCategory */
const getWorkTypeReport = getWorkTypeByCategory;

const categorizeApp = (name) => {
    const n = (name || '').toLowerCase();
    if (n.includes('code') || n.includes('visual studio') || n.includes('cursor') || n.includes('github') || n.includes('terminal') || n.includes('git') || n.includes('stack overflow')) return 'Development';
    if (n.includes('slack') || n.includes('teams') || n.includes('zoom') || n.includes('meet') || n.includes('discord')) return 'Communication';
    if (n.includes('chrome') || n.includes('google') || n.includes('notion') || n.includes('docs') || n.includes('sheets') || n.includes('excel')) return 'Productivity';
    if (n.includes('figma') || n.includes('canva') || n.includes('photoshop')) return 'Design';
    if (n.includes('chatgpt') || n.includes('claude') || n.includes('copilot') || n.includes('ai')) return 'AI tools';
    if (n.includes('youtube') || n.includes('netflix') || n.includes('spotify')) return 'Entertainment';
    return 'Uncategorized';
};

const formatSeconds = (secs) => {
    if (!secs || isNaN(secs) || secs < 0) return '00:00 h';
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} h`;
};

/**
 * Apps & Websites Report: Detailed usage per app from MySQL DB
 */
const getAppsReport = async (organizationId, startDate, endDate, params) => {
    const where = buildReportFilter(organizationId, startDate, endDate, params);

    // Fetch from both AppUsageLog and ActivityLog to ensure comprehensive real usage
    const [appLogs, actLogs] = await Promise.all([
        prisma.appUsageLog.findMany({
            where,
            select: { appName: true, category: true, productivity: true, duration: true, employeeId: true, timestamp: true }
        }),
        prisma.activityLog.findMany({
            where: {
                organizationId,
                timestamp: { gte: startDate, lte: endDate },
                ...(params?.userId ? { employeeId: params.userId } : {}),
                ...(params?.teamId ? { employee: { teamId: params.teamId } } : {})
            },
            select: { appWebsite: true, productivity: true, duration: true, employeeId: true, timestamp: true }
        })
    ]);

    const appMap = {};
    let totalSec = 0;
    let prodSec = 0;
    let neutralSec = 0;
    let unprodSec = 0;
    const dailySecMap = {};
    const daysSet = new Set();

    const processEntry = (name, category, productivity, duration, employeeId, timestamp) => {
        if (!name || name === 'Unknown') return;
        const dur = Number(duration) || 0;
        if (dur <= 0) return;

        totalSec += dur;
        if (productivity === 'PRODUCTIVE') prodSec += dur;
        else if (productivity === 'UNPRODUCTIVE') unprodSec += dur;
        else neutralSec += dur;

        if (timestamp) {
            const d = new Date(timestamp);
            const dateKey = d.toISOString().split('T')[0];
            daysSet.add(dateKey);
            dailySecMap[dateKey] = (dailySecMap[dateKey] || 0) + dur;
        }

        const cat = category && category !== 'Uncategorized' ? category : categorizeApp(name);

        if (!appMap[name]) {
            appMap[name] = {
                name,
                category: cat,
                productivity: productivity || 'NEUTRAL',
                duration: 0,
                employees: new Set()
            };
        }
        appMap[name].duration += dur;
        if (employeeId) appMap[name].employees.add(employeeId);
    };

    // If appLogs exist, use them
    if (appLogs.length > 0) {
        appLogs.forEach(l => processEntry(l.appName, l.category, l.productivity, l.duration, l.employeeId, l.timestamp));
    }
    // Also merge activityLogs to ensure all tracked software is represented
    actLogs.forEach(l => {
        // Skip idle marker from app rankings
        if (l.appWebsite === 'Away from Computer' || l.appWebsite === 'Away from Computer (Idle)') {
            totalSec += (l.duration || 0);
            unprodSec += (l.duration || 0);
            return;
        }
        processEntry(l.appWebsite, null, l.productivity, l.duration, l.employeeId, l.timestamp);
    });

    const activeDaysCount = Math.max(daysSet.size, 1);
    const avgSec = Math.round(totalSec / activeDaysCount);
    const avgProdSec = Math.round(prodSec / activeDaysCount);
    const avgNeutralSec = Math.round(neutralSec / activeDaysCount);
    const avgUnprodSec = Math.round(unprodSec / activeDaysCount);

    const appsList = Object.values(appMap).map((a, idx) => ({
        id: String(idx + 1),
        name: a.name,
        category: a.category,
        productivity: a.productivity,
        duration: a.duration,
        timeFormatted: formatSeconds(a.duration),
        userCount: a.employees.size || 1,
        usagePercent: totalSec > 0 ? Number(((a.duration / totalSec) * 100).toFixed(1)) : 0
    })).sort((a, b) => b.duration - a.duration);

    const trend = Object.keys(dailySecMap).sort().map(d => {
        const dObj = new Date(d + 'T00:00:00');
        const monthName = dObj.toLocaleString('en-US', { month: 'short' });
        const dayNum = dObj.getDate();
        return {
            label: `${monthName} ${dayNum}`,
            hours: Number((dailySecMap[d] / 3600).toFixed(1)),
            date: d
        };
    });

    return {
        summary: {
            totalHours: formatSeconds(totalSec),
            totalAvg: `${formatSeconds(avgSec)} average`,
            productiveHours: formatSeconds(prodSec),
            productiveAvg: `${formatSeconds(avgProdSec)} average`,
            neutralHours: formatSeconds(neutralSec),
            neutralAvg: `${formatSeconds(avgNeutralSec)} average`,
            unproductiveHours: formatSeconds(unprodSec),
            unproductiveAvg: `${formatSeconds(avgUnprodSec)} average`,
            rawSeconds: {
                total: totalSec,
                productive: prodSec,
                neutral: neutralSec,
                unproductive: unprodSec
            }
        },
        apps: appsList,
        trend,
        categories: ['All Apps', 'Development', 'Communication', 'Productivity', 'Design', 'AI tools', 'Entertainment', 'Uncategorized']
    };
};

/**
 * Schedule Adherence Report: Compare Attendance with Shifts.
 */
const getAdherenceReport = async (organizationId, startDate, endDate, params, options = {}) => {
    const { userId, teamId } = params || {};
    const { maskNames = false } = options;

    const employeeWhere = { organizationId, role: 'EMPLOYEE' };
    if (userId) {
        employeeWhere.id = userId;
    } else if (teamId) {
        employeeWhere.teamId = teamId;
    }

    const employees = await prisma.employee.findMany({
        where: employeeWhere,
        include: {
            attendance: {
                where: { date: { gte: startDate, lte: endDate } }
            },
            agent: { select: { status: true, lastSeen: true } },
            liveActivities: {
                orderBy: { createdAt: 'desc' },
                take: 1
            }
        }
    });

    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);

    const data = employees.map(emp => {
        const totalAttendance = emp.attendance.length;
        const lateAttendance = emp.attendance.filter(a => a.late).length;
        const adherenceScore = totalAttendance > 0
            ? Math.round(((totalAttendance - lateAttendance) / totalAttendance) * 100)
            : 0;

        const lastSeen = emp.agent?.lastSeen ? new Date(emp.agent.lastSeen) : null;
        const isOnline = emp.agent?.status === 'active' && lastSeen && lastSeen > fiveMinAgo;
        const currentApp = emp.liveActivities[0]?.activeApp || null;

        return {
            id: emp.id,
            employee: emp.fullName,
            isOnline,
            currentApp: currentApp && currentApp !== 'Unknown' ? currentApp : null,
            status: totalAttendance === 0 ? 'No Attendance' : adherenceScore >= 90 ? 'Excellent' : adherenceScore >= 80 ? 'Good' : 'Needs Improvement',
            adherence: adherenceScore
        };
    });

    data.sort((a, b) => {
        if (a.isOnline !== b.isOnline) return Number(b.isOnline) - Number(a.isOnline);
        return a.employee.localeCompare(b.employee);
    });

    if (maskNames) {
        return await maskPII(organizationId, data, 'employee');
    }
    return data;
};

/**
 * Helper to mask PII according to GDPR settings
 */
const maskPII = async (organizationId, data, nameField = 'employee') => {
    const settings = await prisma.complianceSetting.findUnique({
        where: { organizationId }
    });

    if (!settings || !settings.gdprEnabled) {
        return data;
    }

    return data.map(item => ({
        ...item,
        [nameField]: `Employee #${item.id?.substring(0, 4) || Math.random().toString(36).substring(7).toUpperCase()}`,
        email: '***@***.***',
        phone: '**********'
    }));
};

/**
 * Location Insights Report: Work hours and employee counts per location.
 */
const getLocationInsights = async (organizationId, startDate, endDate, params) => {
    const { userId, teamId } = params || {};
    
    const employeeWhere = { organizationId };
    if (userId) {
        employeeWhere.id = userId;
    } else if (teamId) {
        employeeWhere.teamId = teamId;
    }

    const employees = await prisma.employee.findMany({
        where: employeeWhere,
        include: {
            activityLogs: {
                where: { timestamp: { gte: startDate, lte: endDate } },
                select: { duration: true, productivity: true, activityType: true, timestamp: true }
            },
            attendance: {
                where: { date: { gte: startDate, lte: endDate } },
                select: { duration: true, date: true }
            }
        }
    });

    let officeWorkSec = 0, officeProdSec = 0, officeActSec = 0, officeCount = 0;
    let remoteWorkSec = 0, remoteProdSec = 0, remoteActSec = 0, remoteCount = 0;

    const employeeCards = [];
    const dayMap = {};

    employees.forEach(emp => {
        const isOffice = String(emp.location || '').toLowerCase().includes('office');
        if (isOffice) officeCount++;
        else remoteCount++;

        let empWorkSec = 0;
        let empProdSec = 0;
        let empActSec = 0;

        emp.activityLogs.forEach(log => {
            const d = log.duration || 0;
            empWorkSec += d;
            if (log.productivity === 'PRODUCTIVE') empProdSec += d;
            if (log.activityType === 'ACTIVE') empActSec += d;

            const dayKey = log.timestamp ? log.timestamp.toISOString().split('T')[0] : 'unknown';
            if (!dayMap[dayKey]) dayMap[dayKey] = { office: 0, remote: 0 };
            if (isOffice) dayMap[dayKey].office += d / 3600;
            else dayMap[dayKey].remote += d / 3600;
        });

        // If activity logs are 0 for range but attendance exists, use attendance
        if (empWorkSec === 0 && emp.attendance.length > 0) {
            emp.attendance.forEach(att => {
                const d = att.duration || 0;
                empWorkSec += d;
                // real productive time comes only from activity logs
                
            });
        }

        if (isOffice) {
            officeWorkSec += empWorkSec;
            officeProdSec += empProdSec;
            officeActSec += empActSec;
        } else {
            remoteWorkSec += empWorkSec;
            remoteProdSec += empProdSec;
            remoteActSec += empActSec;
        }

        const empUtil = empWorkSec > 0 ? Math.round((empProdSec / empWorkSec) * 100) : 0;
        employeeCards.push({
            id: emp.id,
            name: emp.fullName,
            location: isOffice ? 'Office' : 'Remote',
            avatar: emp.avatar || null,
            workTime: formatSeconds(empWorkSec),
            productiveTime: formatSeconds(empProdSec),
            utilization: empUtil
        });
    });

    const officeUtil = officeWorkSec > 0 ? Math.round((officeProdSec / officeWorkSec) * 100) : 0;
    const remoteUtil = remoteWorkSec > 0 ? Math.round((remoteProdSec / remoteWorkSec) * 100) : 0;

    const timeline = Object.keys(dayMap).sort().map(k => {
        const dObj = new Date(k + 'T00:00:00');
        const monthName = dObj.toLocaleString('en-US', { month: 'short' });
        const dayNum = dObj.getDate();
        return {
            day: `${monthName} ${dayNum}`,
            office: Number(dayMap[k].office.toFixed(1)),
            remote: Number(dayMap[k].remote.toFixed(1))
        };
    });

    return {
        office: {
            count: officeCount,
            utilization: officeUtil,
            workHours: formatSeconds(officeWorkSec),
            productiveHours: formatSeconds(officeProdSec),
            activeHours: formatSeconds(officeActSec),
            workVal: Number((officeWorkSec / 3600).toFixed(2)),
            prodVal: Number((officeProdSec / 3600).toFixed(2)),
            actVal: Number((officeActSec / 3600).toFixed(2))
        },
        remote: {
            count: remoteCount,
            utilization: remoteUtil,
            workHours: formatSeconds(remoteWorkSec),
            productiveHours: formatSeconds(remoteProdSec),
            activeHours: formatSeconds(remoteActSec),
            workVal: Number((remoteWorkSec / 3600).toFixed(2)),
            prodVal: Number((remoteProdSec / 3600).toFixed(2)),
            actVal: Number((remoteActSec / 3600).toFixed(2))
        },
        employees: employeeCards,
        timeline
    };
};

/**
 * Workload Distribution Report: Hours worked vs optimal range.
 */
const getWorkloadReport = async (organizationId, startDate, endDate, params) => {
    const { userId, teamId } = params || {};
    
    const teamWhere = { organizationId };
    if (teamId) {
        teamWhere.id = teamId;
    }

    const employeeWhere = {};
    if (userId) {
        employeeWhere.id = userId;
    }

    const teams = await prisma.team.findMany({
        where: teamWhere,
        include: {
            employees: {
                where: employeeWhere,
                include: {
                    attendance: {
                        where: { date: { gte: startDate, lte: endDate } }
                    }
                }
            }
        }
    });

    const data = teams.map(team => {
        let totalHours = 0;
        let totalCapacity = team.employees.length * 40; // Assuming 40h per week capacity for now

        team.employees.forEach(emp => {
            const hours = emp.attendance.reduce((acc, curr) => acc + (curr.duration || 0), 0) / 3600;
            totalHours += hours;
        });

        return {
            team: team.name,
            hours: Math.round(totalHours * 10) / 10,
            capacity: totalCapacity || 1,
            employeeCount: team.employees.length
        };
    });

    return data; // No employee names here, so no masking needed
};

module.exports = {
    getWorkTypeReport,
    getWorkTypeByCategory,
    getWorkTypeByTags,
    getAppsReport,
    getAdherenceReport,
    getLocationInsights,
    getWorkloadReport
};
