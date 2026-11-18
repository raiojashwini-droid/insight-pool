const prisma = require('../../config/db');

const activityService = {
    createActivityLog: async (data) => {
        // Guard: Reject deactivated employee
        const emp = await prisma.employee.findUnique({ where: { id: data.employeeId }, select: { status: true } });
        if (!emp) throw new Error('Employee not found');
        if (emp.status === 'DEACTIVATED') {
            const err = new Error('Cannot log activity for a deactivated employee');
            err.code = 'ACCOUNT_DEACTIVATED';
            err.statusCode = 403;
            throw err;
        }

        const settings = await prisma.complianceSetting.findUnique({
            where: { organizationId: data.organizationId }
        });

        if (settings && !settings.activityMonitoring) {
            return null;
        }

        return await prisma.activityLog.create({
            data: {
                employeeId: data.employeeId,
                organizationId: data.organizationId,
                activityType: data.activityType,
                productivity: data.productivity,
                duration: data.duration,
                timestamp: data.timestamp ? new Date(data.timestamp) : new Date(),
                appWebsite: data.appWebsite || 'Unknown',
                taskId: data.taskId || null,
            },
        });
    },

    getEmployeeActivity: async (employeeId, startDate, endDate) => {
        const where = {
            employeeId,
        };

        if (startDate && endDate) {
            where.timestamp = {
                gte: new Date(startDate),
                lte: new Date(endDate),
            };
        }

        return await prisma.activityLog.findMany({
            where,
            orderBy: { timestamp: 'desc' },
        });
    },

    getTeamActivity: async (teamId, startDate, endDate) => {
        const where = {
            employee: {
                teamId,
            },
        };

        if (startDate && endDate) {
            where.timestamp = {
                gte: new Date(startDate),
                lte: new Date(endDate),
            };
        }

        return await prisma.activityLog.findMany({
            where,
            include: {
                employee: {
                    select: {
                        fullName: true,
                        email: true,
                    },
                },
            },
            orderBy: { timestamp: 'desc' },
        });
    },

    getOrganizationActivity: async (organizationId, startDate, endDate) => {
        const where = {
            organizationId,
        };

        if (startDate && endDate) {
            where.timestamp = {
                gte: new Date(startDate),
                lte: new Date(endDate),
            };
        }

        return await prisma.activityLog.findMany({
            where,
            include: {
                employee: {
                    select: {
                        fullName: true,
                        team: {
                            select: {
                                name: true,
                            },
                        },
                    },
                },
            },
            orderBy: { timestamp: 'desc' },
        });
    },

    getOrganizationSummary: async (organizationId, startDate, endDate, params) => {
        const where = {
            organizationId,
        };

        if (startDate && endDate) {
            const start = new Date(startDate);
            start.setHours(0, 0, 0, 0);
            const end = new Date(endDate);
            end.setHours(23, 59, 59, 999);

            where.timestamp = {
                gte: start,
                lte: end,
            };
        }

        const logs = await prisma.activityLog.findMany({
            where,
            include: {
                employee: {
                    select: {
                        id: true,
                        fullName: true,
                        team: {
                            select: { name: true }
                        }
                    },
                },
            },
        });

        console.log(`[ActivityService] Found ${logs.length} logs for org ${organizationId}`);

        // Group by Date and Employee
        const summaryMap = {};

        logs.forEach(log => {
            if (!log.employee) {
                console.warn(`[ActivityService] Missing employee for log ID ${log.id}`);
                return;
            }

            const date = log.timestamp ? log.timestamp.toISOString().split('T')[0] : new Date().toISOString().split('T')[0];
            const empId = log.employeeId;
            const key = `${date}_${empId}`;

            if (!summaryMap[key]) {
                summaryMap[key] = {
                    id: key,
                    employeeId: empId,
                    name: log.employee.fullName || 'Unknown',
                    team: log.employee.team?.name || 'General',
                    date: date,
                    workHours: 0,
                    activeHours: 0,
                    idleHours: 0,
                    breakHours: 0,
                    manualHours: 0,
                    productiveHours: 0,
                    unproductiveHours: 0,
                    neutralHours: 0,
                    taskHours: {}, // { taskId: duration }
                    breakStartedAt: null,
                    intradayBuckets: Array.from({ length: 24 }, (_, i) => ({
                        name: `${String(i).padStart(2, '0')}:00`,
                        active: 0,
                        idle: 0,
                        manual: 0,
                        break: 0
                    }))
                };
            }

            const item = summaryMap[key];
            const durationHrs = log.duration / 3600;

            // Types
            if (log.activityType === 'ACTIVE') item.activeHours += durationHrs;
            if (log.activityType === 'IDLE') item.idleHours += durationHrs;
            if (log.activityType === 'MANUAL') item.manualHours += durationHrs;
            if (log.activityType === 'BREAK') {
                item.breakHours += durationHrs;
                if (log.duration === 0) {
                    // Current active break
                    if (!item.breakStartedAt || new Date(log.timestamp) > new Date(item.breakStartedAt)) {
                        item.breakStartedAt = log.timestamp;
                    }
                }
            }

            // Productivity
            if (log.productivity === 'PRODUCTIVE') item.productiveHours += durationHrs;
            if (log.productivity === 'UNPRODUCTIVE') item.unproductiveHours += durationHrs;
            if (log.productivity === 'NEUTRAL') item.neutralHours += durationHrs;
            
            // Task Specific Time
            if (log.taskId) {
                if (!item.taskHours[log.taskId]) item.taskHours[log.taskId] = 0;
                item.taskHours[log.taskId] += durationHrs;
            }

            // Total Work Hours (Active + Idle + Manual)
            item.workHours = item.activeHours + item.idleHours + item.manualHours;

            // Hourly bucket
            const hour = log.timestamp.getHours();
            if (log.activityType === 'ACTIVE') item.intradayBuckets[hour].active += durationHrs;
            if (log.activityType === 'IDLE') item.intradayBuckets[hour].idle += durationHrs;
            if (log.activityType === 'BREAK') item.intradayBuckets[hour].break += durationHrs;
        });

        // Calculate percentages
        return Object.values(summaryMap).map(item => {
            const productivityPct = item.activeHours > 0 ? Math.round((item.productiveHours / item.activeHours) * 100) : 0;
            const utilizationPct = item.workHours > 0 ? Math.round((item.activeHours / item.workHours) * 100) : 0;

            return {
                ...item,
                productivityPct,
                utilizationPct
            };
        });
    },
    getEmployeeSummary: async (employeeId, startDate, endDate) => {
        const where = {
            employeeId,
        };

        if (startDate && endDate) {
            const start = new Date(startDate);
            start.setHours(0, 0, 0, 0);
            const end = new Date(endDate);
            end.setHours(23, 59, 59, 999);

            where.timestamp = {
                gte: start,
                lte: end,
            };
        }

        const logs = await prisma.activityLog.findMany({
            where,
            include: {
                employee: {
                    select: {
                        id: true,
                        fullName: true,
                        team: { select: { name: true } }
                    }
                }
            }
        });

        // Group by Date
        const summaryMap = {};

        logs.forEach(log => {
            const date = log.timestamp ? log.timestamp.toISOString().split('T')[0] : new Date().toISOString().split('T')[0];
            const key = date;

            if (!summaryMap[key]) {
                summaryMap[key] = {
                    id: `${date}_${employeeId}`,
                    employeeId: employeeId,
                    name: log.employee?.fullName || 'Unknown',
                    team: log.employee?.team?.name || 'General',
                    date: date,
                    workHours: 0,
                    activeHours: 0,
                    idleHours: 0,
                    breakHours: 0,
                    manualHours: 0,
                    productiveHours: 0,
                    unproductiveHours: 0,
                    neutralHours: 0,
                    taskHours: {},
                    intradayBuckets: Array.from({ length: 24 }, (_, i) => ({
                        name: `${String(i).padStart(2, '0')}:00`,
                        active: 0,
                        idle: 0,
                        manual: 0,
                        break: 0
                    }))
                };
            }

            const item = summaryMap[key];
            const durationHrs = log.duration / 3600;

            if (log.activityType === 'ACTIVE') item.activeHours += durationHrs;
            if (log.activityType === 'IDLE') item.idleHours += durationHrs;
            if (log.activityType === 'MANUAL') item.manualHours += durationHrs;
            if (log.activityType === 'BREAK') item.breakHours += durationHrs;

            if (log.productivity === 'PRODUCTIVE') item.productiveHours += durationHrs;
            if (log.productivity === 'UNPRODUCTIVE') item.unproductiveHours += durationHrs;
            if (log.productivity === 'NEUTRAL') item.neutralHours += durationHrs;
            
            if (log.taskId) {
                if (!item.taskHours[log.taskId]) item.taskHours[log.taskId] = 0;
                item.taskHours[log.taskId] += durationHrs;
            }

            const hour = log.timestamp.getHours();
            if (log.activityType === 'ACTIVE') item.intradayBuckets[hour].active += durationHrs;
            if (log.activityType === 'IDLE') item.intradayBuckets[hour].idle += durationHrs;
            if (log.activityType === 'BREAK') item.intradayBuckets[hour].break += durationHrs;
        });

        return Object.values(summaryMap).map(item => {
            item.workHours = item.activeHours + item.idleHours + item.manualHours;
            const productivityPct = item.activeHours > 0 ? Math.round((item.productiveHours / item.activeHours) * 100) : 0;
            const utilizationPct = item.workHours > 0 ? Math.round((item.activeHours / item.workHours) * 100) : 0;

            return {
                ...item,
                productivityPct,
                utilizationPct
            };
        });
    },
    getTeamSummary: async (teamId, startDate, endDate) => {
        const where = {
            employee: { teamId: teamId },
        };

        if (startDate && endDate) {
            where.timestamp = {
                gte: new Date(startDate),
                lte: new Date(endDate),
            };
        }

        const logs = await prisma.activityLog.findMany({
            where,
        });

        const summary = {
            activeHours: 0,
            idleHours: 0,
            manualHours: 0,
            productiveHours: 0,
            unproductiveHours: 0,
            neutralHours: 0,
            totalWorkHours: 0,
        };

        logs.forEach(log => {
            const durationHrs = log.duration / 3600;
            if (log.activityType === 'ACTIVE') summary.activeHours += durationHrs;
            if (log.activityType === 'IDLE') summary.idleHours += durationHrs;
            if (log.activityType === 'MANUAL') summary.manualHours += durationHrs;
            
            if (log.productivity === 'PRODUCTIVE') summary.productiveHours += durationHrs;
            if (log.productivity === 'UNPRODUCTIVE') summary.unproductiveHours += durationHrs;
            if (log.productivity === 'NEUTRAL') summary.neutralHours += durationHrs;
        });

        summary.totalWorkHours = summary.activeHours + summary.idleHours + summary.manualHours;
        summary.productivityPct = summary.activeHours > 0 ? Math.round((summary.productiveHours / summary.activeHours) * 100) : 0;

        return summary;
    },

    getTimelineReport: async (organizationId, dateStr = null, employeeId = null, teamId = null) => {
        const targetDate = dateStr ? new Date(dateStr) : new Date();
        const startOfDay = new Date(targetDate);
        startOfDay.setHours(0, 0, 0, 0);
        const endOfDay = new Date(targetDate);
        endOfDay.setHours(23, 59, 59, 999);

        const empWhere = { organizationId };
        if (employeeId) empWhere.id = employeeId;
        if (teamId) empWhere.teamId = teamId;

        const employees = await prisma.employee.findMany({
            where: empWhere,
            include: {
                team: true,
                user: { select: { email: true, role: true } },
                attendance: {
                    where: {
                        OR: [
                            { date: { gte: startOfDay, lte: endOfDay } },
                            { clockIn: { gte: startOfDay, lte: endOfDay } }
                        ]
                    },
                    orderBy: { clockIn: 'asc' }
                }
            }
        });

        const logWhere = {
            organizationId,
            timestamp: { gte: startOfDay, lte: endOfDay }
        };
        if (employeeId) logWhere.employeeId = employeeId;

        let logs = await prisma.activityLog.findMany({
            where: logWhere,
            orderBy: { timestamp: 'asc' },
            include: { employee: true }
        });

        // Fallback: If no logs exist on targetDate and no explicit date was requested, load the most recent active date with logs
        let activeDateDisplay = startOfDay.toISOString().split('T')[0];
        if (!dateStr && logs.length === 0) {
            const latestLog = await prisma.activityLog.findFirst({
                where: { organizationId },
                orderBy: { timestamp: 'desc' }
            });
            if (latestLog) {
                const latestDateStart = new Date(latestLog.timestamp);
                latestDateStart.setHours(0, 0, 0, 0);
                const latestDateEnd = new Date(latestLog.timestamp);
                latestDateEnd.setHours(23, 59, 59, 999);
                activeDateDisplay = latestDateStart.toISOString().split('T')[0];

                logs = await prisma.activityLog.findMany({
                    where: {
                        organizationId,
                        timestamp: { gte: latestDateStart, lte: latestDateEnd }
                    },
                    orderBy: { timestamp: 'asc' },
                    include: { employee: true }
                });
            }
        }

        // Build per-employee timelines
        const employeeTimelines = employees.map(emp => {
            const empLogs = logs.filter(l => l.employeeId === emp.id);
            let activeSeconds = 0;
            let idleSeconds = 0;
            let manualSeconds = 0;
            let productiveSeconds = 0;
            let unproductiveSeconds = 0;
            let neutralSeconds = 0;

            const appDurationMap = {};

            const segments = empLogs.map(log => {
                const dur = log.duration || 300;
                const logTime = new Date(log.timestamp);
                const startMins = logTime.getHours() * 60 + logTime.getMinutes();
                const durMins = Math.max(5, Math.round(dur / 60));
                const startPercent = Math.min(99.5, Math.max(0, (startMins / 1440) * 100));
                const widthPercent = Math.min(100 - startPercent, Math.max(0.6, (durMins / 1440) * 100));

                if (log.activityType === 'ACTIVE') activeSeconds += dur;
                else if (log.activityType === 'IDLE') idleSeconds += dur;
                else if (log.activityType === 'MANUAL') manualSeconds += dur;

                if (log.productivity === 'PRODUCTIVE') productiveSeconds += dur;
                else if (log.productivity === 'UNPRODUCTIVE') unproductiveSeconds += dur;
                else neutralSeconds += dur;

                const app = log.appWebsite || 'General Software';
                if (!appDurationMap[app]) {
                    appDurationMap[app] = { name: app, duration: 0, productivity: log.productivity || 'PRODUCTIVE' };
                }
                appDurationMap[app].duration += dur;

                let segmentType = 'ACTIVE';
                if (log.activityType === 'IDLE') segmentType = 'IDLE';
                else if (log.activityType === 'MANUAL') segmentType = 'MANUAL';
                else if (log.activityType === 'BREAK') segmentType = dur > 3600 ? 'BREAK_OVERAGE' : 'BREAK';

                return {
                    id: log.id,
                    type: segmentType,
                    productivity: log.productivity,
                    appWebsite: log.appWebsite,
                    startPercent: parseFloat(startPercent.toFixed(2)),
                    widthPercent: parseFloat(widthPercent.toFixed(2)),
                    timeFormatted: logTime.toTimeString().substring(0, 5),
                    durationMinutes: durMins
                };
            });

            // Incorporate real persistent attendance sessions for this employee
            const empAttendances = emp.attendance || [];
            let attendanceDurationSeconds = 0;

            empAttendances.forEach(att => {
                let dur = 0;
                if (att.duration && att.duration > 0) {
                    dur = att.duration;
                } else if (att.clockIn && !att.clockOut) {
                    dur = Math.max(0, Math.floor((Date.now() - new Date(att.clockIn).getTime()) / 1000));
                } else if (att.clockIn && att.clockOut) {
                    dur = Math.max(0, Math.floor((new Date(att.clockOut).getTime() - new Date(att.clockIn).getTime()) / 1000));
                }
                attendanceDurationSeconds += dur;

                // If no active segments were generated by activity logs, generate visual timeline segments from attendance
                if (!segments.some(s => s.type === 'ACTIVE') && dur > 0) {
                    const clockInDate = new Date(att.clockIn);
                    const startMins = clockInDate.getHours() * 60 + clockInDate.getMinutes();
                    const durMins = Math.max(5, Math.round(dur / 60));
                    const startPercent = Math.min(99.5, Math.max(0, (startMins / 1440) * 100));
                    const widthPercent = Math.min(100 - startPercent, Math.max(1, (durMins / 1440) * 100));

                    segments.push({
                        id: `att-${att.id}`,
                        type: 'ACTIVE',
                        productivity: 'PRODUCTIVE',
                        appWebsite: 'Work Session',
                        startPercent: parseFloat(startPercent.toFixed(2)),
                        widthPercent: parseFloat(widthPercent.toFixed(2)),
                        timeFormatted: clockInDate.toTimeString().substring(0, 5),
                        durationMinutes: durMins
                    });
                }
            });

            if (attendanceDurationSeconds > activeSeconds) {
                const diff = attendanceDurationSeconds - activeSeconds;
                activeSeconds = attendanceDurationSeconds;
                productiveSeconds += diff;
            }

            const topApps = Object.values(appDurationMap)
                .sort((a, b) => b.duration - a.duration)
                .slice(0, 3)
                .map(a => {
                    const hrs = Math.floor(a.duration / 3600);
                    const mins = Math.floor((a.duration % 3600) / 60);
                    return {
                        name: a.name,
                        productivity: a.productivity === 'PRODUCTIVE' ? 'Productive' : a.productivity === 'UNPRODUCTIVE' ? 'Unproductive' : 'Neutral',
                        durationFormatted: `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')} h`
                    };
                });

            // No fake default apps - strictly real apps from database logs

            const totalWorkSeconds = activeSeconds + idleSeconds + manualSeconds;
            const activeHours = Math.floor(activeSeconds / 3600);
            const activeMinutes = Math.floor((activeSeconds % 3600) / 60);
            const activeHoursFormatted = `${String(activeHours).padStart(2, '0')}:${String(activeMinutes).padStart(2, '0')} h`;

            const workHours = Math.floor(totalWorkSeconds / 3600);
            const workMinutes = Math.floor((totalWorkSeconds % 3600) / 60);
            const workHoursFormatted = `${String(workHours).padStart(2, '0')}:${String(workMinutes).padStart(2, '0')} h`;

            const productivityPct = activeSeconds > 0 ? Math.min(100, Math.round((productiveSeconds / activeSeconds) * 100)) : (attendanceDurationSeconds > 0 ? 100 : 0);

            // Shift timings from real attendance or logs
            const firstAttendance = empAttendances[0];
            const lastAttendance = empAttendances[empAttendances.length - 1];
            const firstLog = empLogs[0];
            const lastLog = empLogs[empLogs.length - 1];

            let startShift = '--:--';
            if (firstAttendance?.clockIn) {
                startShift = new Date(firstAttendance.clockIn).toTimeString().substring(0, 5);
            } else if (firstLog) {
                startShift = new Date(firstLog.timestamp).toTimeString().substring(0, 5);
            }

            let endShift = '--:--';
            if (lastAttendance) {
                endShift = lastAttendance.clockOut ? new Date(lastAttendance.clockOut).toTimeString().substring(0, 5) : 'Working Now';
            } else if (lastLog) {
                endShift = new Date(new Date(lastLog.timestamp).getTime() + (lastLog.duration || 300) * 1000).toTimeString().substring(0, 5);
            }
            
            const isLate = firstAttendance?.clockIn
                ? (new Date(firstAttendance.clockIn).getHours() > 9 || (new Date(firstAttendance.clockIn).getHours() === 9 && new Date(firstAttendance.clockIn).getMinutes() > 15))
                : (firstLog ? (new Date(firstLog.timestamp).getHours() > 9 || (new Date(firstLog.timestamp).getHours() === 9 && new Date(firstLog.timestamp).getMinutes() > 15)) : false);

            return {
                id: emp.id,
                name: emp.fullName || emp.user?.email || 'Employee',
                initials: (emp.fullName || 'E').split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase(),
                team: emp.team?.name || 'General Team',
                role: emp.designation || 'Specialist',
                activeHoursFormatted,
                workHoursFormatted,
                productivityPct,
                startShift,
                endShift,
                isLate,
                scheduledStartPercent: 37.5, // 09:00 AM (9/24)
                scheduledEndPercent: 75.0,   // 06:00 PM (18/24)
                segments,
                topApps
            };
        });

        // Compute 24-hour distribution histogram strictly from real activity logs
        const hourlyDistribution = Array.from({ length: 24 }).map((_, h) => {
            const hourLogs = logs.filter(l => new Date(l.timestamp).getHours() === h);
            const activeEmps = new Set(hourLogs.filter(l => l.activityType === 'ACTIVE').map(l => l.employeeId)).size;
            const breakEmps = new Set(hourLogs.filter(l => l.activityType === 'BREAK').map(l => l.employeeId)).size;
            const productiveLogs = hourLogs.filter(l => l.productivity === 'PRODUCTIVE').length;
            const unproductiveLogs = hourLogs.filter(l => l.productivity === 'UNPRODUCTIVE').length;
            const neutralLogs = hourLogs.filter(l => l.productivity === 'NEUTRAL').length;

            return {
                hour: h,
                hourLabel: `${String(h).padStart(2, '0')}:00`,
                activeCount: activeEmps,
                totalEmployees: employees.length,
                onBreakCount: breakEmps,
                breakOverageCount: Math.max(0, breakEmps - 1),
                manualTimeCount: hourLogs.filter(l => l.activityType === 'MANUAL').length,
                productiveCount: productiveLogs,
                unproductiveCount: unproductiveLogs,
                neutralCount: neutralLogs
            };
        });

        // Projects & Billable Costs Summary computed dynamically from database
        const projects = await prisma.project.findMany({
            where: { organizationId },
            include: {
                tasks: {
                    select: {
                        id: true,
                        name: true,
                        status: true,
                        activityLogs: {
                            where: { organizationId },
                            select: { duration: true }
                        }
                    }
                }
            }
        });

        let totalOrgProjectSecs = 0;
        const projectsList = projects.map((p) => {
            let projSecs = 0;
            (p.tasks || []).forEach(t => {
                (t.activityLogs || []).forEach(al => {
                    projSecs += (al.duration || 0);
                });
            });
            totalOrgProjectSecs += projSecs;
            const hours = (projSecs / 3600);
            const hoursFormatted = `${String(Math.floor(hours)).padStart(2, '0')}:${String(Math.floor((projSecs % 3600) / 60)).padStart(2, '0')} h`;
            const cost = (hours * 25).toFixed(2);

            return {
                id: p.id,
                name: p.name,
                status: p.status || 'Active',
                employeesCount: employees.length,
                tasksCount: p.tasks.length,
                hoursFormatted,
                costFormatted: `$${cost}`
            };
        });

        const totalOrgHours = (totalOrgProjectSecs / 3600);
        const totalBillableCost = `$${(totalOrgHours * 25).toFixed(2)}`;

        const projectsSummary = {
            totalBillableCost,
            projectsList
        };

        return {
            date: activeDateDisplay,
            totalEmployees: employees.length,
            employeeTimelines,
            hourlyDistribution,
            projectsSummary
        };
    }
};

module.exports = activityService;
