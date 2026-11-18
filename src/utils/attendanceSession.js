const prisma = require('../config/db');
const attendanceService = require('../modules/attendance/attendance.service');

/** No agent signal for this long → auto clock-out */
const STALE_MS = 10 * 60 * 1000;

async function touchAgentLastSeen(employeeId) {
    if (!employeeId) return;
    await prisma.agent.updateMany({
        where: { employeeId },
        data: { lastSeen: new Date(), status: 'active' },
    });
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
 * Clock out if agent has been silent for 10+ minutes.
 */
async function processStaleAttendanceForEmployee(employeeId) {
    if (!employeeId) return false;

    const agent = await prisma.agent.findFirst({
        where: { employeeId },
        select: { lastSeen: true, status: true },
    });

    if (!agent || agent.status !== 'active') return false;

    const lastSeenMs = agent.lastSeen ? new Date(agent.lastSeen).getTime() : 0;
    if (Date.now() - lastSeenMs < STALE_MS) return false;

    // Agent has been silent for > STALE_MS, mark agent status offline so it won't be picked up again
    await prisma.agent.updateMany({
        where: { employeeId },
        data: { status: 'offline' },
    });

    const open = await prisma.attendance.findFirst({
        where: { employeeId, clockOut: null },
    });
    if (!open) return false;

    // Guard 1: If employee is on BREAK, do NOT auto clock-out
    const emp = await prisma.employee.findUnique({
        where: { id: employeeId },
        select: { status: true }
    });
    if (emp?.status === 'BREAK') {
        return false;
    }

    // Guard 2: If the open session was started recently (< STALE_MS), do NOT auto clock-out
    const clockInMs = open.clockIn ? new Date(open.clockIn).getTime() : 0;
    if (Date.now() - clockInMs < STALE_MS) {
        return false;
    }

    try {
        try {
            const tasksService = require('../modules/tasks/tasks.service');
            await tasksService.stopActiveTimerForEmployee(employeeId, agent.lastSeen || new Date());
        } catch (tErr) {
            console.error(`[AttendanceSession] Auto-stopping task timer on stale session failed for ${employeeId}:`, tErr.message);
        }
        await attendanceService.clockOut(employeeId);
        return true;
    } catch (err) {
        if (!err.message.includes('No active clock-in')) {
            console.error(`[AttendanceSession] Stale clock-out failed for ${employeeId}:`, err.message);
        }
        return false;
    }
}

/**
 * Background sweep — all employees with stale agents.
 */
async function processAllStaleSessions() {
    const staleBefore = new Date(Date.now() - STALE_MS);

    const agents = await prisma.agent.findMany({
        where: {
            status: 'active',
            lastSeen: { lt: staleBefore },
        },
        select: { employeeId: true },
    });

    let closed = 0;
    for (const agent of agents) {
        const did = await processStaleAttendanceForEmployee(agent.employeeId);
        if (did) closed += 1;
    }
    return closed;
}

module.exports = {
    STALE_MS,
    touchAgentLastSeen,
    onAgentPulse,
    processStaleAttendanceForEmployee,
    processAllStaleSessions,
};
