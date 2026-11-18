const prisma = require('../../config/db');

function getDateRangeFilter(startDate, endDate) {
    let start, end;
    if (startDate && endDate) {
        start = new Date(startDate);
        start.setHours(0, 0, 0, 0);
        end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
    } else {
        start = new Date();
        start.setHours(0, 0, 0, 0);
        end = new Date();
        end.setHours(23, 59, 59, 999);
    }
    return { gte: start, lte: end };
}

// Helper to format seconds to 00h 00m 00s
function formatToHM(seconds) {
    if (!seconds) return '00h 00m 00s';
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    return `${hrs.toString().padStart(2, '0')}h ${mins.toString().padStart(2, '0')}m ${secs.toString().padStart(2, '0')}s`;
}

// Calculate summary metrics
async function calculateMetrics(organizationId, employeeId = null, teamId = null, startDate = null, endDate = null) {
    const dateFilter = getDateRangeFilter(startDate, endDate);

    const whereClause = { organizationId, timestamp: dateFilter };
    if (employeeId) whereClause.employeeId = employeeId;
    if (teamId) whereClause.employee = { teamId };

    const logs = await prisma.activityLog.findMany({ where: whereClause });
    
    let activeTime = 0;
    let idleTime = 0;
    let productiveTime = 0;
    let unproductiveTime = 0;
    let neutralTime = 0;
    
    logs.forEach(log => {
        if (log.activityType === 'ACTIVE') activeTime += log.duration;
        if (log.activityType === 'IDLE') idleTime += log.duration;

        if (log.productivity === 'PRODUCTIVE') productiveTime += log.duration;
        else if (log.productivity === 'UNPRODUCTIVE') unproductiveTime += log.duration;
        else if (log.productivity === 'NEUTRAL') neutralTime += log.duration;
    });

    const manualWhere = { organizationId, startTime: dateFilter };
    if (employeeId) manualWhere.employeeId = employeeId;
    if (teamId) manualWhere.employee = { teamId };
    
    const manualLogs = await prisma.manualTime.findMany({ where: manualWhere });
    const manualTime = manualLogs.reduce((acc, log) => acc + log.duration, 0);
    // manualTime is typically productive or neutral. We'll count it towards productive
    productiveTime += manualTime;

    // Incorporate persistent attendance sessions
    const attWhere = {
        organizationId,
        OR: [
            { date: dateFilter },
            { clockIn: dateFilter }
        ]
    };
    if (employeeId) attWhere.employeeId = employeeId;
    if (teamId) attWhere.employee = { teamId };

    const attendances = await prisma.attendance.findMany({ where: attWhere });
    let attendanceWorkTime = 0;
    attendances.forEach(att => {
        if (att.duration && att.duration > 0) {
            attendanceWorkTime += att.duration;
        } else if (att.clockIn && !att.clockOut) {
            attendanceWorkTime += Math.max(0, Math.floor((Date.now() - new Date(att.clockIn).getTime()) / 1000));
        } else if (att.clockIn && att.clockOut) {
            attendanceWorkTime += Math.max(0, Math.floor((new Date(att.clockOut).getTime() - new Date(att.clockIn).getTime()) / 1000));
        }
    });

    if (attendanceWorkTime > activeTime) {
        const delta = attendanceWorkTime - activeTime;
        activeTime = attendanceWorkTime;
        productiveTime += delta;
    }

    const workTime = activeTime + manualTime + idleTime;
    
    const utilization = workTime > 0 ? Math.round((productiveTime / workTime) * 100) : 0;
    
    return {
        workTime: formatToHM(workTime),
        activeTime: formatToHM(activeTime),
        idleTime: formatToHM(idleTime),
        manualTime: formatToHM(manualTime),
        productiveTime: formatToHM(productiveTime),
        unproductiveTime: formatToHM(unproductiveTime || idleTime), // Use actual UNPRODUCTIVE or fallback roughly to idle
        neutralTime: formatToHM(neutralTime),
        utilization,
        totalWorkHours: Number((workTime / 3600).toFixed(2)),
        rawSeconds: {
            workTime,
            activeTime,
            idleTime,
            manualTime,
            productiveTime,
            unproductiveTime: unproductiveTime || idleTime,
            neutralTime,
            utilization
        }
    };
}

// Helper to compute delta % and formatted diff hours between reference and compared periods
function calculateDeltaKPI(currentVal, previousVal, isPercentage = false) {
    const diff = currentVal - previousVal;
    let percent = 0;
    if (previousVal > 0) {
        percent = Number(((diff / previousVal) * 100).toFixed(1));
    } else if (currentVal > 0) {
        percent = 100.0;
    }

    const sign = diff >= 0 ? '+' : '-';
    let formattedDiff = '';

    if (isPercentage) {
        formattedDiff = `${sign}${Math.abs(diff)}%`;
    } else {
        const absSec = Math.abs(diff);
        const h = Math.floor(absSec / 3600);
        const m = Math.floor((absSec % 3600) / 60);
        formattedDiff = `${sign}${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')} h`;
    }

    return {
        diff,
        percent,
        percentFormatted: `${diff >= 0 ? '+' : ''}${percent}%`,
        diffHoursFormatted: formattedDiff,
        direction: diff >= 0 ? 'up' : 'down'
    };
}

// Compute comprehensive comparison across all 8 KPIs
async function getMetricsComparison(organizationId, employeeId = null, teamId = null, startDate = null, endDate = null, compareStartDate = null, compareEndDate = null) {
    const refMetrics = await calculateMetrics(organizationId, employeeId, teamId, startDate, endDate);

    // If explicit compare range not given, compute prior duration of equal length
    let compStart = compareStartDate;
    let compEnd = compareEndDate;
    if (!compStart || !compEnd) {
        const refRange = getDateRangeFilter(startDate, endDate);
        const durationMs = refRange.lte.getTime() - refRange.gte.getTime();
        const prevEnd = new Date(refRange.gte.getTime() - 1);
        const prevStart = new Date(prevEnd.getTime() - durationMs);
        compStart = prevStart.toISOString();
        compEnd = prevEnd.toISOString();
    }

    const compMetrics = await calculateMetrics(organizationId, employeeId, teamId, compStart, compEnd);

    const ref = refMetrics.rawSeconds;
    const comp = compMetrics.rawSeconds;

    return {
        referencePeriod: { startDate, endDate, summary: refMetrics },
        comparedPeriod: { startDate: compStart, endDate: compEnd, summary: compMetrics },
        deltas: {
            workTime: calculateDeltaKPI(ref.workTime, comp.workTime),
            activeTime: calculateDeltaKPI(ref.activeTime, comp.activeTime),
            idleTime: calculateDeltaKPI(ref.idleTime, comp.idleTime),
            manualTime: calculateDeltaKPI(ref.manualTime, comp.manualTime),
            productiveTime: calculateDeltaKPI(ref.productiveTime, comp.productiveTime),
            unproductiveTime: calculateDeltaKPI(ref.unproductiveTime, comp.unproductiveTime),
            neutralTime: calculateDeltaKPI(ref.neutralTime, comp.neutralTime),
            utilization: calculateDeltaKPI(ref.utilization, comp.utilization, true)
        }
    };
}

// Compute daily stacked productivity breakdown (Productive, Unproductive, Neutral)
async function getDailyProductivityBreakdown(organizationId, employeeId = null, teamId = null, startDate = null, endDate = null) {
    const dateFilter = getDateRangeFilter(startDate, endDate);
    const whereClause = { organizationId, timestamp: dateFilter };
    if (employeeId) whereClause.employeeId = employeeId;
    if (teamId) whereClause.employee = { teamId };

    const logs = await prisma.activityLog.findMany({
        where: whereClause,
        select: { timestamp: true, duration: true, productivity: true }
    });

    // Group logs by YYYY-MM-DD
    const dayMap = {};
    logs.forEach(log => {
        const d = new Date(log.timestamp);
        const dayKey = d.toISOString().split('T')[0];
        if (!dayMap[dayKey]) {
            dayMap[dayKey] = { productive: 0, unproductive: 0, neutral: 0 };
        }
        const durHours = (log.duration || 0) / 3600;
        if (log.productivity === 'PRODUCTIVE') dayMap[dayKey].productive += durHours;
        else if (log.productivity === 'UNPRODUCTIVE') dayMap[dayKey].unproductive += durHours;
        else dayMap[dayKey].neutral += durHours;
    });

    // Also include attendance sessions in daily breakdown
    const attWhere = {
        organizationId,
        OR: [
            { date: dateFilter },
            { clockIn: dateFilter }
        ]
    };
    if (employeeId) attWhere.employeeId = employeeId;
    if (teamId) attWhere.employee = { teamId };

    const attendances = await prisma.attendance.findMany({ where: attWhere });
    attendances.forEach(att => {
        const attDate = att.date || att.clockIn;
        const dayKey = new Date(attDate).toISOString().split('T')[0];
        if (!dayMap[dayKey]) {
            dayMap[dayKey] = { productive: 0, unproductive: 0, neutral: 0 };
        }
        let dur = 0;
        if (att.duration && att.duration > 0) {
            dur = att.duration;
        } else if (att.clockIn && !att.clockOut) {
            dur = Math.max(0, Math.floor((Date.now() - new Date(att.clockIn).getTime()) / 1000));
        } else if (att.clockIn && att.clockOut) {
            dur = Math.max(0, Math.floor((new Date(att.clockOut).getTime() - new Date(att.clockIn).getTime()) / 1000));
        }
        const durHours = dur / 3600;
        if (durHours > dayMap[dayKey].productive) {
            dayMap[dayKey].productive = Number(durHours.toFixed(2));
        }
    });

    const result = Object.keys(dayMap).sort().map(key => {
        const dateObj = new Date(key + 'T00:00:00');
        const monthName = dateObj.toLocaleString('en-US', { month: 'short' });
        const dayNum = dateObj.getDate();
        const p = Number(dayMap[key].productive.toFixed(2));
        const u = Number(dayMap[key].unproductive.toFixed(2));
        const n = Number(dayMap[key].neutral.toFixed(2));
        return {
            date: key,
            name: `${monthName} ${dayNum}`,
            productive: p,
            unproductive: u,
            neutral: n,
            total: Number((p + u + n).toFixed(2))
        };
    });

    return result;
}

// Calculate intraday chart data
async function getIntradayActivity(organizationId, employeeId = null, teamId = null, startDate = null, endDate = null) {
    const dateFilter = getDateRangeFilter(startDate, endDate);

    const whereClause = { organizationId, timestamp: dateFilter };
    if (employeeId) whereClause.employeeId = employeeId;
    if (teamId) whereClause.employee = { teamId };

    const logs = await prisma.activityLog.findMany({ where: whereClause });
    
    const manualWhere = { organizationId, startTime: dateFilter };
    if (employeeId) manualWhere.employeeId = employeeId;
    if (teamId) manualWhere.employee = { teamId };
    
    const manualLogs = await prisma.manualTime.findMany({ where: manualWhere });

    const attWhere = {
        organizationId,
        OR: [
            { date: dateFilter },
            { clockIn: dateFilter }
        ]
    };
    if (employeeId) attWhere.employeeId = employeeId;
    if (teamId) attWhere.employee = { teamId };
    const attendances = await prisma.attendance.findMany({ where: attWhere });

    // Group by hour
    const hourlyData = {};
    for (let i = 0; i < 24; i++) {
        hourlyData[i] = { active: 0, idle: 0, break: 0, manual: 0 };
    }

    logs.forEach(log => {
        const hour = new Date(log.timestamp).getHours();
        if (log.activityType === 'ACTIVE') hourlyData[hour].active += log.duration;
        else if (log.activityType === 'IDLE') hourlyData[hour].idle += log.duration;
        else if (log.activityType === 'BREAK') hourlyData[hour].break += log.duration;
    });

    manualLogs.forEach(log => {
        const hour = new Date(log.startTime).getHours();
        hourlyData[hour].manual += log.duration;
    });

    // Also distribute attendance sessions into intraday hours
    attendances.forEach(att => {
        const start = new Date(att.clockIn);
        const end = att.clockOut ? new Date(att.clockOut) : new Date();
        const startHour = start.getHours();
        const endHour = end.getHours();
        for (let h = startHour; h <= Math.min(23, endHour); h++) {
            if (hourlyData[h]) {
                const hourSeconds = (startHour === endHour)
                    ? Math.max(300, Math.floor((end - start) / 1000))
                    : 3600;
                hourlyData[h].active = Math.max(hourlyData[h].active, hourSeconds);
            }
        }
    });

    // Format for Recharts
    const result = [];
    for (let i = 8; i <= 20; i += 2) { // 8 AM to 8 PM roughly
        result.push({
            name: `${i.toString().padStart(2, '0')}:00`,
            active: Number((hourlyData[i].active / 3600).toFixed(2)),
            idle: Number((hourlyData[i].idle / 3600).toFixed(2)),
            break: Number((hourlyData[i].break / 3600).toFixed(2)),
            manual: Number((hourlyData[i].manual / 3600).toFixed(2)),
        });
    }

    return result;
}

// Calculate top/bottom employees
async function getEmployeeRankings(organizationId, teamId = null, startDate = null, endDate = null) {
    const dateFilter = getDateRangeFilter(startDate, endDate);

    const whereClause = { organizationId, timestamp: dateFilter };
    if (teamId) whereClause.employee = { teamId };

    const logs = await prisma.activityLog.findMany({ 
        where: whereClause,
        include: { employee: { include: { team: true } } }
    });

    const manualWhere = { organizationId, startTime: dateFilter };
    if (teamId) manualWhere.employee = { teamId };

    const manualLogs = await prisma.manualTime.findMany({ 
        where: manualWhere,
        include: { employee: true }
    });

    const empStats = {};
    
    const initEmp = (emp) => {
        if (!empStats[emp.id]) {
            empStats[emp.id] = {
                name: emp.fullName,
                initials: emp.fullName.substring(0, 2).toUpperCase(),
                team: emp.team?.name || 'Unassigned',
                status: emp.status, // Include status here
                active: 0,
                idle: 0,
                manual: 0,
                productive: 0, 
                unproductive: 0 
            };
        }
    };

    logs.forEach(log => {
        initEmp(log.employee);
        if (log.activityType === 'ACTIVE') empStats[log.employee.id].active += log.duration;
        if (log.activityType === 'IDLE') empStats[log.employee.id].idle += log.duration;

        if (log.productivity === 'PRODUCTIVE') empStats[log.employee.id].productive += log.duration;
        if (log.productivity === 'UNPRODUCTIVE') empStats[log.employee.id].unproductive += log.duration;
    });

    manualLogs.forEach(log => {
        initEmp(log.employee);
        empStats[log.employee.id].manual += log.duration;
        empStats[log.employee.id].productive += log.duration; // manual assumed productive
    });

    const attWhere = {
        organizationId,
        OR: [
            { date: dateFilter },
            { clockIn: dateFilter }
        ]
    };
    if (teamId) attWhere.employee = { teamId };

    const attendances = await prisma.attendance.findMany({ 
        where: attWhere,
        include: { employee: { include: { team: true } } }
    });

    attendances.forEach(att => {
        if (!att.employee) return;
        initEmp(att.employee);
        let dur = 0;
        if (att.duration && att.duration > 0) {
            dur = att.duration;
        } else if (att.clockIn && !att.clockOut) {
            dur = Math.max(0, Math.floor((Date.now() - new Date(att.clockIn).getTime()) / 1000));
        } else if (att.clockIn && att.clockOut) {
            dur = Math.max(0, Math.floor((new Date(att.clockOut).getTime() - new Date(att.clockIn).getTime()) / 1000));
        }
        if (dur > empStats[att.employee.id].active) {
            const delta = dur - empStats[att.employee.id].active;
            empStats[att.employee.id].active = dur;
            empStats[att.employee.id].productive += delta;
        }
    });

    const rankings = Object.values(empStats).map(e => {
        const total = e.active + e.manual + e.idle; // Total logged tracking time
        const util = total > 0 ? Math.round((e.productive / total) * 100) : 0;
        return {
            ...e,
            productive: formatToHM(e.productive),
            unproductive: formatToHM(e.unproductive || e.idle), // Fallback to idle if none specific
            utilization: util,
            _rawUtil: util // For sorting
        };
    });

    rankings.sort((a, b) => b._rawUtil - a._rawUtil);

    return {
        topProductive: rankings.slice(0, 5),
        topUnproductive: [...rankings].reverse().slice(0, 5)
    };
}

const getAdminDashboard = async (organizationId, startDate = null, endDate = null, compareStartDate = null, compareEndDate = null) => {
    const [employees, teams, totalAttendance] = await Promise.all([
        prisma.employee.findMany({ where: { organizationId } }),
        prisma.team.findMany({ where: { organizationId } }),
        prisma.attendance.count({ where: { organizationId } })
    ]);

    const summary = await calculateMetrics(organizationId, null, null, startDate, endDate);
    const intradayActivity = await getIntradayActivity(organizationId, null, null, startDate, endDate);
    const rankings = await getEmployeeRankings(organizationId, null, startDate, endDate);
    const comparison = await getMetricsComparison(organizationId, null, null, startDate, endDate, compareStartDate, compareEndDate);
    const productivityBreakdown = await getDailyProductivityBreakdown(organizationId, null, null, startDate, endDate);

    // Calculate real team stats
    const teamStats = teams.map(t => {
        const teamEmployees = rankings.topProductive.filter(emp => emp.team === t.name)
            .concat(rankings.topUnproductive.filter(emp => emp.team === t.name));
        
        // Remove duplicates from rank concat
        const uniqueTeamEmps = Array.from(new Set(teamEmployees.map(e => e.id)))
            .map(id => teamEmployees.find(e => e.id === id));

        const avgProductivity = uniqueTeamEmps.length > 0 
            ? Math.round(uniqueTeamEmps.reduce((acc, emp) => acc + emp.utilization, 0) / uniqueTeamEmps.length)
            : 0;

        return {
            id: t.id,
            name: t.name,
            productivity: avgProductivity,
        };
    });

    return {
        employees,
        teams: teamStats,
        totalAttendance,
        workHours: summary.totalWorkHours,
        productivityScore: summary.utilization,
        summary,
        intradayActivity,
        topProductive: rankings.topProductive,
        topUnproductive: rankings.topUnproductive,
        comparison,
        productivityBreakdown
    };
};

const getManagerDashboard = async (organizationId, teamId, startDate = null, endDate = null, compareStartDate = null, compareEndDate = null) => {
    const [employees, activityLogs, tasks, attendance] = await Promise.all([
        prisma.employee.findMany({ where: { organizationId, teamId } }),
        prisma.activityLog.findMany({
            where: { organizationId, employee: { teamId } },
            take: 10,
            orderBy: { timestamp: 'desc' }
        }),
        prisma.task.findMany({ where: { organizationId, employee: { teamId } } }),
        prisma.attendance.count({ where: { organizationId, employee: { teamId } } })
    ]);

    const summary = await calculateMetrics(organizationId, null, teamId, startDate, endDate);
    const intradayActivity = await getIntradayActivity(organizationId, null, teamId, startDate, endDate);
    const rankings = await getEmployeeRankings(organizationId, teamId, startDate, endDate);
    const comparison = await getMetricsComparison(organizationId, null, teamId, startDate, endDate, compareStartDate, compareEndDate);
    const productivityBreakdown = await getDailyProductivityBreakdown(organizationId, null, teamId, startDate, endDate);

    // Provide contextTeams for the manager UI to avoid crashes if UI expects an array
    const contextTeams = await prisma.team.findMany({ where: { id: teamId } });

    return {
        employees,
        activityLogs,
        tasks,
        totalAttendance: attendance,
        workHours: summary.totalWorkHours,
        productivityScore: summary.utilization,
        summary,
        intradayActivity,
        topProductive: rankings.topProductive,
        topUnproductive: rankings.topUnproductive,
        teams: contextTeams,
        comparison,
        productivityBreakdown
    };
};

const getEmployeeDashboard = async (organizationId, employeeId, startDate = null, endDate = null, compareStartDate = null, compareEndDate = null) => {
    const [activityLogs, attendanceList, tasks, screenshots] = await Promise.all([
        prisma.activityLog.findMany({
            where: { organizationId, employeeId },
            take: 20,
            orderBy: { timestamp: 'desc' }
        }),
        prisma.attendance.findMany({
            where: { organizationId, employeeId },
            take: 5,
            orderBy: { date: 'desc' }
        }),
        prisma.task.findMany({ where: { organizationId, employeeId } }),
        prisma.screenshot.findMany({
            where: { 
                organizationId, 
                employeeId,
                imageUrl: {
                    startsWith: '/uploads' // Only fetch real screenshots, ignore simulator dummy data
                }
            },
            take: 5,
            orderBy: { capturedAt: 'desc' }
        })
    ]);

    const summary = await calculateMetrics(organizationId, employeeId, null, startDate, endDate);
    const intradayActivity = await getIntradayActivity(organizationId, employeeId, null, startDate, endDate);
    const comparison = await getMetricsComparison(organizationId, employeeId, null, startDate, endDate, compareStartDate, compareEndDate);
    const productivityBreakdown = await getDailyProductivityBreakdown(organizationId, employeeId, null, startDate, endDate);

    return {
        activityLogs,
        attendance: attendanceList,
        tasks,
        screenshots,
        workHours: summary.totalWorkHours,
        productivityScore: summary.utilization,
        summary,
        intradayActivity,
        // RBAC: Empty peer data for Employees
        topProductive: [],
        topUnproductive: [],
        teams: [],
        comparison,
        productivityBreakdown
    };
};

module.exports = {
  getAdminDashboard,
  getManagerDashboard,
  getEmployeeDashboard
};
