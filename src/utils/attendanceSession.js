const prisma = require('../config/db');
const attendanceService = require('../modules/attendance/attendance.service');

/** 15 minutes of inactivity / offline / freeze → auto clock-out */
const STALE_MS = 15 * 60 * 1000;

async function touchAgentLastSeen(employeeId) {
    if (!employeeId) return;
    const now = new Date();
    try {
        await prisma.agent.updateMany({
            where: { employeeId },
            data: { lastSeen: now, status: 'active' },
        });
        await prisma.employee.update({
            where: { id: employeeId },
            data: { lastActiveAt: now }
        });
    } catch (e) {
        // Safe ignore
    }
}

/**
 * Called on agent heartbeat / first activity — one open session per employee.
 */
async function onAgentPulse(employeeId, organizationId) {
    if (!employeeId) return;

    // Guard: Never pulse attendance or update status for deactivated employees
    const emp = await prisma.employee.findUnique({
        where: { id: employeeId },
        select: { status: true }
    });
    if (emp?.status === 'DEACTIVATED') {
        return;
    }

    await touchAgentLastSeen(employeeId);

    try {
        await attendanceService.clockIn(employeeId, organizationId || 'default-org-id');
    } catch (err) {
        if (!err.message.includes('Already clocked in') && err.statusCode !== 409) {
            throw err;
        }
    }
}

/**
 * Auto Clock-Out if employee has been offline, frozen, or inactive for 15+ minutes.
 */
async function processStaleAttendanceForEmployee(employeeId, openAttendance = null) {
    if (!employeeId) return false;

    // 1. Find the open attendance record
    const open = openAttendance || await prisma.attendance.findFirst({
        where: { employeeId, clockOut: null },
        orderBy: { clockIn: 'desc' }
    });
    if (!open) return false;

    // 2. Fetch employee details
    const emp = await prisma.employee.findUnique({
        where: { id: employeeId },
        select: { id: true, status: true, organizationId: true, fullName: true, lastActiveAt: true }
    });
    if (!emp || emp.status === 'DEACTIVATED') return false;

    // 3. Check active socket live sessions
    let liveSession = null;
    let liveSessionsMap = null;
    let ioInstance = null;
    try {
        const socketServer = require('../socket/server');
        if (socketServer.getLiveSessions) {
            liveSessionsMap = socketServer.getLiveSessions();
            liveSession = liveSessionsMap.get(employeeId);
        }
        if (socketServer.getIO) {
            ioInstance = socketServer.getIO();
        }
    } catch (sErr) {}

    const now = Date.now();

    // If socket is actively communicating within the last 15 minutes and working, not stale
    if (liveSession && (liveSession.status === 'ONLINE' || liveSession.status === 'ACTIVE')) {
        const lastActivityMs = liveSession.lastActivity ? new Date(liveSession.lastActivity).getTime() : 0;
        if (now - lastActivityMs < STALE_MS) {
            return false;
        }
    }

    // 4. Gather all recent activity timestamps across all channels
    const agent = await prisma.agent.findFirst({
        where: { employeeId },
        select: { lastSeen: true, status: true }
    });

    const latestLiveActivity = await prisma.liveActivity.findFirst({
        where: { employeeId },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true }
    });

    const latestActivityLog = await prisma.activityLog.findFirst({
        where: { employeeId },
        orderBy: { timestamp: 'desc' },
        select: { timestamp: true }
    });

    const candidateTimestamps = [
        open.clockIn ? new Date(open.clockIn).getTime() : 0,
        emp.lastActiveAt ? new Date(emp.lastActiveAt).getTime() : 0,
        agent?.lastSeen ? new Date(agent.lastSeen).getTime() : 0,
        latestLiveActivity?.createdAt ? new Date(latestLiveActivity.createdAt).getTime() : 0,
        latestActivityLog?.timestamp ? new Date(latestActivityLog.timestamp).getTime() : 0,
        liveSession?.lastActivity ? new Date(liveSession.lastActivity).getTime() : 0
    ].filter(t => t > 0);

    const lastActiveMs = candidateTimestamps.length > 0 ? Math.max(...candidateTimestamps) : 0;

    // If activity detected within 15 minutes, do not clock out
    if (lastActiveMs > 0 && (now - lastActiveMs) < STALE_MS) {
        return false;
    }

    // 5. Employee has been offline / inactive for >= 15 minutes! Auto clock-out.
    console.log(`[AttendanceSession] Auto-clocking out employee ${employeeId} (${emp.fullName}) due to 15m inactivity.`);

    // Cap clockOut at last active time + 15 min grace (or current time if closer)
    const effectiveClockOut = new Date(Math.min(now, (lastActiveMs > 0 ? lastActiveMs + STALE_MS : now)));

    try {
        // Stop active task timers
        try {
            const tasksService = require('../modules/tasks/tasks.service');
            await tasksService.stopActiveTimerForEmployee(employeeId, effectiveClockOut);
        } catch (tErr) {
            console.error(`[AttendanceSession] Auto-stopping task timer failed for ${employeeId}:`, tErr.message);
        }

        // Close attendance session
        await attendanceService.clockOut(employeeId, effectiveClockOut);

        // Mark agent offline in DB
        await prisma.agent.updateMany({
            where: { employeeId },
            data: { status: 'offline' }
        });

        // Clean liveSessions cache
        if (liveSessionsMap && liveSessionsMap.has(employeeId)) {
            liveSessionsMap.delete(employeeId);
        }

        // Emit real-time WebSocket events to Admin/Manager dashboard
        const orgId = emp.organizationId || open.organizationId;
        if (ioInstance && orgId) {
            ioInstance.to(`org_${orgId}`).emit('employee:status', {
                employeeId,
                status: 'OFFLINE'
            });
            ioInstance.to(`org_${orgId}`).emit('attendance:update', {
                employeeId,
                type: 'clock-out',
                auto: true
            });
        }

        // Create persistent in-app notification
        try {
            const empUser = await prisma.employee.findUnique({ where: { id: employeeId }, include: { user: true } });
            await prisma.notification.create({
                data: {
                    organizationId: orgId,
                    title: 'Auto Clock-Out (15m Inactivity)',
                    description: `${emp.fullName} was automatically clocked out after 15 minutes of inactivity/offline state.`,
                    type: 'warning',
                    targetUserId: empUser?.userId || null,
                    unread: true
                }
            });
        } catch (nErr) {}

        return true;
    } catch (err) {
        if (!err.message.includes('No active clock-in')) {
            console.error(`[AttendanceSession] Stale auto clock-out failed for ${employeeId}:`, err.message);
        }
        return false;
    }
}

/**
 * Background sweep — checks all open attendance sessions and auto clocks out inactive employees.
 */
async function processAllStaleSessions() {
    try {
        const openAttendances = await prisma.attendance.findMany({
            where: { clockOut: null },
            select: { id: true, employeeId: true, clockIn: true, organizationId: true }
        });

        let closed = 0;
        for (const open of openAttendances) {
            const did = await processStaleAttendanceForEmployee(open.employeeId, open);
            if (did) closed += 1;
        }
        return closed;
    } catch (err) {
        console.error('[AttendanceSession] Sweep error:', err.message);
        return 0;
    }
}

module.exports = {
    STALE_MS,
    touchAgentLastSeen,
    onAgentPulse,
    processStaleAttendanceForEmployee,
    processAllStaleSessions,
};
