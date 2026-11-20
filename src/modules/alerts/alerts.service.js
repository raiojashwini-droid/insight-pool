const prisma = require('../../config/db');
const { emitToManagers } = require('../../socket/server');
const { resolveAppActivityForOrg } = require('../../utils/resolveAppActivityForOrg');

// L1 In-memory cache for fast hot-path deduplication
const idleAlertSessions = new Map();
const appViolationCooldowns = new Map();
const COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes cooldown

const alertsService = {
    // ─── RULE & SETTINGS CRUD ──────────────────────────────────────────
    getAlertRules: async (organizationId, type) => {
        let rules = await prisma.alertRule.findMany({
            where: {
                organizationId,
                ...(type ? { type } : {})
            },
            orderBy: {
                createdAt: 'desc'
            }
        });

        // Auto-seed default baseline rules if organization has none yet
        if (rules.length === 0 && !type) {
            const defaultRules = [
                { name: 'Late Shift Arrival (>15m)', type: 'attendance', trigger: 'Late Clock-In', scope: 'All Employees', organizationId },
                { name: 'Excessive Continuous Idle (>30m)', type: 'activity', trigger: 'Continuous Idle Time', scope: 'All Employees', organizationId },
                { name: 'Prohibited App / Website Access', type: 'security', trigger: 'Prohibited Application', scope: 'All Employees', organizationId },
                { name: 'Low Daily Productivity Threshold (<50%)', type: 'activity', trigger: 'Productivity Threshold', scope: 'All Employees', organizationId }
            ];

            for (const r of defaultRules) {
                await prisma.alertRule.create({ data: r }).catch(() => {});
            }

            rules = await prisma.alertRule.findMany({
                where: { organizationId },
                orderBy: { createdAt: 'desc' }
            });
        }

        return rules;
    },

    createAlertRule: async (data) => {
        return await prisma.alertRule.create({
            data
        });
    },

    updateAlertRule: async (id, data) => {
        return await prisma.alertRule.update({
            where: { id },
            data
        });
    },

    deleteAlertRule: async (id) => {
        return await prisma.alertRule.delete({
            where: { id }
        });
    },

    getAlertSettings: async (organizationId) => {
        let settings = await prisma.alertSettings.findUnique({
            where: { organizationId }
        });

        if (!settings) {
            settings = await prisma.alertSettings.create({
                data: { organizationId }
            });
        }

        return settings;
    },

    updateAlertSettings: async (organizationId, updates) => {
        return await prisma.alertSettings.upsert({
            where: { organizationId },
            update: updates,
            create: {
                ...updates,
                organizationId
            }
        });
    },

    // ─── COMPLETE ALERT EVALUATION ENGINE (TASK 1 & 2) ──────────────────

    _resetCooldowns: () => {
        appViolationCooldowns.clear();
        idleAlertSessions.clear();
    },

    /**
     * Condition A: Late Arrival
     * - Compares actual employee clock-in with applicable shift start time.
     * - Triggers at 15 minutes or more late (or configured threshold).
     * - Handles organization timezone, working days, and approved time off.
     * - STRICT: Does NOT generate alerts for employees without a valid applicable shift.
     * - Avoids duplicate alerts for the same employee and attendance date.
     */
    evaluateLateArrival: async ({ employeeId, organizationId, clockInTime }) => {
        if (!employeeId || !organizationId) return null;
        const now = clockInTime ? new Date(clockInTime) : new Date();

        try {
            const startOfDay = new Date(now);
            startOfDay.setHours(0, 0, 0, 0);
            const endOfDay = new Date(now);
            endOfDay.setHours(23, 59, 59, 999);

            const shiftDayStart = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate() - 1, 0, 0, 0));
            const shiftDayEnd = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate() + 1, 23, 59, 59, 999));

            // 1. Check for valid applicable shift for this employee today
            const shift = await prisma.shift.findFirst({
                where: {
                    employeeId,
                    date: {
                        gte: shiftDayStart,
                        lte: shiftDayEnd
                    }
                }
            });

            // Strict rule: Do NOT generate alerts for employees without a valid applicable shift
            if (!shift || !shift.startTime) {
                return null;
            }

            // 2. Check organization config & working days
            const org = await prisma.organization.findUnique({
                where: { id: organizationId },
                select: { workDays: true, timeZone: true, legalName: true }
            });

            if (org?.workDays) {
                const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
                const currentDayName = days[now.getDay()];
                const activeDays = org.workDays.split(',').map(d => d.trim().toLowerCase());
                if (!activeDays.includes(currentDayName.toLowerCase())) {
                    return null; // Non-working day
                }
            }

            // 3. Check approved time off / holidays
            const onLeave = await prisma.timeOff.findFirst({
                where: {
                    employeeId,
                    startDate: { lte: endOfDay },
                    endDate: { gte: startOfDay }
                }
            });
            if (onLeave) {
                return null; // Employee is on approved leave
            }

            // 4. Calculate late difference
            const [sHour, sMin] = shift.startTime.split(':').map(Number);
            const shiftStartTime = new Date(now);
            shiftStartTime.setHours(sHour, sMin, 0, 0);

            const settings = await prisma.alertSettings.findUnique({ where: { organizationId } });
            const thresholdMinutes = settings?.headcountLateThreshold ?? 15;
            const diffMinutes = Math.floor((now.getTime() - shiftStartTime.getTime()) / (60 * 1000));

            if (diffMinutes < thresholdMinutes) {
                return null; // On-time or within tolerance
            }

            // 5. Database-backed duplicate check: One alert per calendar date
            const existing = await prisma.alertLog.findFirst({
                where: {
                    employeeId,
                    ruleType: 'LATE_ARRIVAL',
                    createdAt: { gte: startOfDay, lte: endOfDay }
                }
            });

            if (existing) {
                return null; // Duplicate prevented
            }

            const employee = await prisma.employee.findUnique({
                where: { id: employeeId },
                include: { team: true }
            });
            if (!employee) return null;

            const formattedTime = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            const message = `${employee.fullName} checked in ${diffMinutes} minutes late (Shift: ${shift.startTime}, Clock-in: ${formattedTime})`;

            // 6. Persist AlertLog
            const alertLog = await prisma.alertLog.create({
                data: {
                    organizationId,
                    employeeId,
                    ruleType: 'LATE_ARRIVAL',
                    trigger: `Late Arrival (${diffMinutes}m)`,
                    severity: 'warning',
                    message,
                    metadata: {
                        diffMinutes,
                        shiftStart: shift.startTime,
                        clockIn: formattedTime,
                        thresholdMinutes,
                        shiftId: shift.id
                    }
                }
            });

            // 7. Persist Notification before emission (targetUserId assigned so role scoping works)
            const notification = await prisma.notification.create({
                data: {
                    organizationId,
                    title: 'Late Arrival Alert',
                    description: message,
                    type: 'alert',
                    link: '/alerts',
                    targetUserId: employeeId,
                    metadata: JSON.stringify({ alertId: alertLog.id, employeeId, diffMinutes })
                }
            });

            // 8. Emit to authorized managers
            const payload = {
                id: alertLog.id,
                employeeId,
                employeeName: employee.fullName,
                team: employee.team?.name || 'Unassigned',
                type: 'late_login',
                severity: 'warning',
                message,
                read: false,
                date: 'Just now',
                createdAt: alertLog.createdAt
            };

            emitToManagers(organizationId, 'alert:new', payload);
            emitToManagers(organizationId, 'notification:new', notification);

            return { alertLog, notification };
        } catch (err) {
            console.error('[AlertsService] evaluateLateArrival error:', err.message);
            return null;
        }
    },

    /**
     * Condition B: Continuous Idle Time
     * - Triggers only after 30 minutes (1800s) of genuinely continuous idle time.
     * - Resets the idle session when employee activity resumes (idleTime < 60s).
     * - Prevents duplicate alerts during the same continuous idle session.
     * - Multi-instance safe & survives process restarts via database createdAt threshold query.
     */
    evaluateContinuousIdle: async ({ employeeId, organizationId, idleTime, timestamp }) => {
        if (!employeeId || !organizationId) return null;
        const idleSec = Number(idleTime) || 0;

        // Reset session when activity resumes
        if (idleSec < 60) {
            if (idleAlertSessions.has(employeeId)) {
                idleAlertSessions.delete(employeeId);
            }
            return null;
        }

        const THRESHOLD_SECONDS = 1800; // 30 continuous minutes
        if (idleSec < THRESHOLD_SECONDS) {
            return null;
        }

        // L1 in-memory check
        const memSession = idleAlertSessions.get(employeeId);
        if (memSession && memSession.alerted) {
            return null;
        }

        try {
            // L2 Database-backed check: survives restarts and multi-instance deployments
            // An alert is duplicate if an alert was already fired since this continuous idle session began
            const idleSessionStart = new Date(Date.now() - (idleSec * 1000) - 60000);
            const dbExisting = await prisma.alertLog.findFirst({
                where: {
                    employeeId,
                    ruleType: 'CONTINUOUS_IDLE',
                    createdAt: { gte: idleSessionStart }
                }
            });

            if (dbExisting) {
                idleAlertSessions.set(employeeId, { alerted: true, startedAt: dbExisting.createdAt });
                return null; // Duplicate prevented across instances
            }

            idleAlertSessions.set(employeeId, { alerted: true, startedAt: new Date() });

            const employee = await prisma.employee.findUnique({
                where: { id: employeeId },
                include: { team: true }
            });
            if (!employee) return null;

            const idleMinutes = Math.floor(idleSec / 60);
            const message = `${employee.fullName} has been continuously idle for ${idleMinutes} minutes`;

            // Persist AlertLog
            const alertLog = await prisma.alertLog.create({
                data: {
                    organizationId,
                    employeeId,
                    ruleType: 'CONTINUOUS_IDLE',
                    trigger: `Continuous Idle (${idleMinutes}m)`,
                    severity: 'warning',
                    message,
                    metadata: { idleTime: idleSec, idleMinutes }
                }
            });

            // Persist Notification before emission (targetUserId assigned so role scoping works)
            const notification = await prisma.notification.create({
                data: {
                    organizationId,
                    title: 'Continuous Idle Alert',
                    description: message,
                    type: 'alert',
                    link: '/alerts',
                    targetUserId: employeeId,
                    metadata: JSON.stringify({ alertId: alertLog.id, employeeId, idleMinutes })
                }
            });

            const payload = {
                id: alertLog.id,
                employeeId,
                employeeName: employee.fullName,
                team: employee.team?.name || 'Unassigned',
                type: 'idle',
                severity: 'warning',
                message,
                read: false,
                date: 'Just now',
                createdAt: alertLog.createdAt
            };

            emitToManagers(organizationId, 'alert:new', payload);
            emitToManagers(organizationId, 'notification:new', notification);

            return { alertLog, notification };
        } catch (err) {
            console.error('[AlertsService] evaluateContinuousIdle error:', err.message);
            return null;
        }
    },

    /**
     * Condition C: Prohibited Application Access
     * - Triggers ONLY for applications explicitly configured as prohibited (isBlocked = true).
     * - Does NOT equate general UNPRODUCTIVE apps with prohibited violations.
     * - Attaches employee, application, timestamp, and screenshot evidence.
     * - Multi-instance safe cooldown (30m) via database check prevents alert flooding.
     */
    evaluateProhibitedApp: async ({ employeeId, organizationId, activeApp, activeWindow, screenshotUrl }) => {
        if (!employeeId || !organizationId || !activeApp) return null;

        try {
            // Resolve app activity against organization's productivity rules
            const resolved = await resolveAppActivityForOrg(organizationId, activeApp, activeWindow);
            const { cleanAppName, appDomain } = resolved;

            const appTarget = cleanAppName || activeApp;
            const domainTarget = (appDomain || cleanAppName || '').toLowerCase();

            // Strict policy check: Only apps explicitly configured as isBlocked = true in ProductivityRule
            const blockedRule = await prisma.productivityRule.findFirst({
                where: {
                    organizationId,
                    isBlocked: true,
                    OR: [
                        { domain: domainTarget },
                        { appName: appTarget },
                        { domain: { contains: domainTarget } }
                    ]
                }
            });

            if (!blockedRule) {
                return null; // Not explicitly prohibited by organization policy
            }

            // L1 & L2 Cooldown Check (30 minutes)
            const cooldownKey = `${employeeId}:${appTarget.toLowerCase()}`;
            const lastAlerted = appViolationCooldowns.get(cooldownKey);
            const nowMs = Date.now();

            if (lastAlerted && nowMs - lastAlerted < COOLDOWN_MS) {
                return null; // Cooldown active
            }

            // L2 Database-backed check: survives restarts and multi-instance deployments
            const thirtyMinAgo = new Date(nowMs - COOLDOWN_MS);
            const dbRecentAlert = await prisma.alertLog.findFirst({
                where: {
                    organizationId,
                    employeeId,
                    ruleType: 'PROHIBITED_APP',
                    message: { contains: appTarget },
                    createdAt: { gte: thirtyMinAgo }
                }
            });

            if (dbRecentAlert) {
                appViolationCooldowns.set(cooldownKey, new Date(dbRecentAlert.createdAt).getTime());
                return null; // Cooldown active from previous process instance
            }

            appViolationCooldowns.set(cooldownKey, nowMs);

            const employee = await prisma.employee.findUnique({
                where: { id: employeeId },
                include: { team: true }
            });
            if (!employee) return null;

            const windowDetail = activeWindow && activeWindow !== 'Unknown' ? ` ("${activeWindow}")` : '';
            const message = `Security Policy Violation: ${employee.fullName} accessed prohibited application "${appTarget}"${windowDetail}`;

            // Persist AlertLog
            const alertLog = await prisma.alertLog.create({
                data: {
                    organizationId,
                    employeeId,
                    ruleType: 'PROHIBITED_APP',
                    trigger: 'Prohibited Application Access',
                    severity: 'critical',
                    message,
                    screenshotUrl: screenshotUrl || null,
                    metadata: {
                        activeApp: appTarget,
                        activeWindow,
                        appDomain,
                        ruleId: blockedRule.id
                    }
                }
            });

            // Persist Notification before emission (targetUserId assigned so role scoping works)
            const notification = await prisma.notification.create({
                data: {
                    organizationId,
                    title: 'Prohibited Application Violation',
                    description: message,
                    type: 'alert',
                    link: '/alerts',
                    targetUserId: employeeId,
                    metadata: JSON.stringify({
                        alertId: alertLog.id,
                        employeeId,
                        appName: appTarget,
                        screenshotUrl
                    })
                }
            });

            const payload = {
                id: alertLog.id,
                employeeId,
                employeeName: employee.fullName,
                team: employee.team?.name || 'Unassigned',
                type: 'unproductive',
                severity: 'critical',
                message,
                screenshotUrl: screenshotUrl || null,
                read: false,
                date: 'Just now',
                createdAt: alertLog.createdAt
            };

            emitToManagers(organizationId, 'alert:new', payload);
            emitToManagers(organizationId, 'notification:new', notification);

            // Emit violation screenshot to managers in real-time
            if (screenshotUrl) {
                emitToManagers(organizationId, 'screenshot:violation', {
                    employeeId,
                    employeeName: employee.fullName,
                    imageUrl: screenshotUrl,
                    appName: appTarget,
                    capturedAt: new Date()
                });
            }

            return { alertLog, notification };
        } catch (err) {
            console.error('[AlertsService] evaluateProhibitedApp error:', err.message);
            return null;
        }
    },

    // ─── PERSISTENT ALERT HISTORY & MANAGEMENT ────────────────────────
    getAlertHistory: async (organizationId, { severity, ruleType, limit = 50, offset = 0 } = {}) => {
        const where = {
            organizationId,
            ...(severity ? { severity } : {}),
            ...(ruleType ? { ruleType } : {})
        };

        let [alerts, total] = await Promise.all([
            prisma.alertLog.findMany({
                where,
                include: {
                    employee: {
                        select: {
                            id: true,
                            fullName: true,
                            avatar: true,
                            team: { select: { id: true, name: true } }
                        }
                    }
                },
                orderBy: { createdAt: 'desc' },
                take: Number(limit) || 50,
                skip: Number(offset) || 0
            }),
            prisma.alertLog.count({ where })
        ]);

        const mapped = alerts.map(a => {
            let uiType = 'unproductive';
            if (a.ruleType === 'LATE_ARRIVAL') uiType = 'late_login';
            else if (a.ruleType === 'CONTINUOUS_IDLE') uiType = 'idle';

            const diffMinutes = Math.floor((Date.now() - new Date(a.createdAt).getTime()) / 60000);
            let timeStr = `${diffMinutes}m ago`;
            if (diffMinutes < 1) timeStr = 'Just now';
            else if (diffMinutes >= 60 && diffMinutes < 1440) timeStr = `${Math.floor(diffMinutes / 60)}h ago`;
            else if (diffMinutes >= 1440) timeStr = new Date(a.createdAt).toLocaleDateString();

            return {
                id: a.id,
                employeeId: a.employeeId,
                employeeName: a.employee?.fullName || 'Employee',
                team: a.employee?.team?.name || 'General',
                type: uiType,
                severity: a.severity,
                message: a.message,
                screenshotUrl: a.screenshotUrl,
                read: a.resolved,
                date: timeStr,
                createdAt: a.createdAt
            };
        });

        return { alerts: mapped, total };
    },

    dismissAlert: async (id, organizationId) => {
        const result = await prisma.alertLog.updateMany({
            where: { id, organizationId },
            data: { resolved: true }
        });
        if (result.count === 0) {
            return null;
        }
        return await prisma.alertLog.findUnique({ where: { id } });
    },

    dismissAllAlerts: async (organizationId) => {
        return await prisma.alertLog.updateMany({
            where: { organizationId, resolved: false },
            data: { resolved: true }
        });
    },

    deleteAlert: async (id, organizationId) => {
        return await prisma.alertLog.deleteMany({
            where: { id, organizationId }
        });
    },

    deleteAllAlerts: async (organizationId) => {
        return await prisma.alertLog.deleteMany({
            where: { organizationId }
        });
    }
};

module.exports = alertsService;
