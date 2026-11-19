const prisma = require('../../config/db');
const { getIO, updateSessionStatus } = require('../../socket/server');

const attendanceService = {
    clockIn: async (employeeId, organizationId) => {
        // Check if employee is deactivated
        const employee = await prisma.employee.findUnique({ where: { id: employeeId }, select: { status: true } });
        if (!employee) throw new Error('Employee not found');
        if (employee.status === 'DEACTIVATED') {
            const err = new Error('Cannot clock in: Employee account is deactivated');
            err.code = 'ACCOUNT_DEACTIVATED';
            err.statusCode = 403;
            throw err;
        }

        const now = new Date();
        // Set today to noon to prevent timezone shifts from changing the calendar date in MySQL
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0);

        // Check if there is an active (unclosed) session - auto-close previous open session if re-clocking in
        const active = await prisma.attendance.findFirst({
            where: {
                employeeId,
                clockOut: null,
            },
            orderBy: { clockIn: 'desc' }
        });
        
        if (active) {
            console.log(`[Attendance] Auto-closing previous unclosed session ${active.id} for employee ${employeeId}`);
            const prevClockIn = new Date(active.clockIn);
            const durationSec = Math.max(0, Math.floor((now.getTime() - prevClockIn.getTime()) / 1000));
            const cappedDuration = Math.min(durationSec, 8 * 3600);
            await prisma.attendance.update({
                where: { id: active.id },
                data: {
                    clockOut: new Date(prevClockIn.getTime() + cappedDuration * 1000),
                    duration: cappedDuration
                }
            });
        }

        // Guard: Prevent clocking in if a PAST period's timesheet is already approved and locked
        try {
            const timesheetsService = require('../timesheets/timesheets.service');
            const currentWeekMonday = timesheetsService.getMondayOf(now);
            const isLocked = await timesheetsService.isPeriodLocked(organizationId, employeeId, today);
            if (isLocked) {
                const weekStartOfToday = timesheetsService.getMondayOf(today);
                // If this is the current active week, auto-reopen to DRAFT so employee can clock in and work
                if (weekStartOfToday === currentWeekMonday) {
                    await prisma.timesheet.updateMany({
                        where: { organizationId, employeeId, weekStart: weekStartOfToday, status: 'APPROVED' },
                        data: { status: 'DRAFT' }
                    });
                    console.log(`[AttendanceService] Reopened current week's approved timesheet to DRAFT for clock-in: ${employeeId}`);
                } else {
                    const err = new Error('Cannot clock in: The timesheet for this past period has already been approved and locked');
                    err.statusCode = 409;
                    throw err;
                }
            }
        } catch (lErr) {
            if (lErr.statusCode === 409) throw lErr;
        }

        // Get employee's shift for today or overnight shift starting yesterday
        const yesterday = new Date(today);
        yesterday.setDate(yesterday.getDate() - 1);

        const shift = await prisma.shift.findFirst({
            where: {
                employeeId,
                OR: [
                    { date: today },
                    { date: yesterday }
                ]
            },
            orderBy: { date: 'desc' }
        });

        let late = false;
        if (shift) {
            const [sHour, sMin] = shift.startTime.split(':').map(Number);
            const [eHour, eMin] = shift.endTime.split(':').map(Number);
            const isOvernight = sHour > eHour || (sHour === eHour && sMin > eMin);

            const shiftStartTime = new Date(shift.date);
            shiftStartTime.setHours(sHour, sMin, 0, 0);

            if (isOvernight && shift.date.toISOString().slice(0, 10) === yesterday.toISOString().slice(0, 10)) {
                if (now > shiftStartTime) {
                    late = true;
                }
            } else if (!isOvernight && shift.date.toISOString().slice(0, 10) === today.toISOString().slice(0, 10)) {
                if (now > shiftStartTime) {
                    late = true;
                }
            }
        }

        const attendance = await prisma.attendance.create({
            data: {
                employeeId,
                organizationId,
                date: today,
                clockIn: now,
                status: 'PRESENT',
                late,
            }
        });

        // Record persistent active work log in database
        try {
            await prisma.activityLog.create({
                data: {
                    employeeId,
                    organizationId,
                    activityType: 'ACTIVE',
                    productivity: 'PRODUCTIVE',
                    duration: 0,
                    timestamp: now,
                    appWebsite: 'Work Session'
                }
            });
        } catch (actErr) {
            console.error('[AttendanceService] Could not create initial active activity log:', actErr.message);
        }

        // Update employee status to ACTIVE (Guard: Ensure not deactivated)
        if (employee && employee.status !== 'DEACTIVATED') {
            await prisma.employee.update({
                where: { id: employeeId },
                data: { status: 'ACTIVE' }
            });
        }

        // Emit real-time events
        const io = getIO();
        if (io) {
            io.to(`org_${organizationId}`).emit('attendance:update', { employeeId, type: 'clock-in' });
            io.to(`org_${organizationId}`).emit('employee:status', { employeeId, status: 'ACTIVE' });
        }

        // Persist notification for attendance event
        try {
            const empUser = await prisma.employee.findUnique({ where: { id: employeeId }, include: { user: true } });
            const empName = empUser?.user?.name || `Employee ${empUser?.employeeCode || employeeId}`;
            await prisma.notification.create({
                data: {
                    organizationId,
                    title: 'Work session started',
                    description: `${empName} clocked in`,
                    type: 'success',
                    targetUserId: empUser?.userId || null,
                    unread: true
                }
            });
        } catch (ne) {
            console.error('[AttendanceService] Notification create error on clock-in:', ne.message);
        }

        // Evaluate Late Arrival Alert in background (non-blocking)
        try {
            const alertsService = require('../alerts/alerts.service');
            alertsService.evaluateLateArrival({
                employeeId,
                organizationId,
                clockInTime: now
            }).catch(err => console.error('[AttendanceService] Late alert evaluation failed:', err.message));
        } catch (e) {
            console.error('[AttendanceService] Could not trigger late alert:', e.message);
        }

        return { ...attendance, openBreak: null, totalBreakSeconds: 0 };
    },

    clockOut: async (employeeId) => {
        const now = new Date();

        // Find the most recent active session regardless of date
        const attendance = await prisma.attendance.findFirst({
            where: {
                employeeId,
                clockOut: null,
            },
            orderBy: {
                clockIn: 'desc'
            }
        });

        if (!attendance) {
            throw new Error('No active clock-in session found');
        }

        // If employee is on break, close open break log
        const employeeInfo = await prisma.employee.findUnique({ where: { id: employeeId }, select: { status: true, organizationId: true } });
        if (employeeInfo?.status === 'BREAK') {
            const lastBreak = await prisma.activityLog.findFirst({
                where: {
                    employeeId,
                    activityType: 'BREAK',
                    duration: 0
                },
                orderBy: { timestamp: 'desc' }
            });

            if (lastBreak) {
                const bDuration = Math.floor((now - lastBreak.timestamp) / 1000);
                await prisma.activityLog.update({
                    where: { id: lastBreak.id },
                    data: { duration: bDuration }
                });
            }
        }

        // Close any open ACTIVE work log
        try {
            const openActive = await prisma.activityLog.findFirst({
                where: { employeeId, activityType: 'ACTIVE', duration: 0 },
                orderBy: { timestamp: 'desc' }
            });
            if (openActive) {
                const aDuration = Math.max(1, Math.floor((now - new Date(openActive.timestamp).getTime()) / 1000));
                await prisma.activityLog.update({
                    where: { id: openActive.id },
                    data: { duration: aDuration }
                });
            }
        } catch (actErr) {
            console.error('[AttendanceService] Could not close active activity log:', actErr.message);
        }

        // Calculate unpaid breaks during this attendance session
        const breakLogs = await prisma.activityLog.findMany({
            where: {
                employeeId,
                activityType: 'BREAK',
                timestamp: { gte: attendance.clockIn, lte: now }
            }
        });
        const breakSeconds = breakLogs.reduce((acc, b) => acc + (b.duration || 0), 0);
        const grossDuration = Math.floor((now - attendance.clockIn) / 1000); // in seconds
        const netDuration = Math.max(0, grossDuration - breakSeconds);

        const updatedAttendance = await prisma.attendance.update({
            where: { id: attendance.id },
            data: {
                clockOut: now,
                duration: netDuration,
            }
        });

        // Update employee status to OFFLINE (Guard: Ensure not deactivated)
        if (employeeInfo && employeeInfo.status !== 'DEACTIVATED') {
            await prisma.employee.update({
                where: { id: employeeId },
                data: { status: 'OFFLINE' }
            });
        }

        // Auto-stop any running task timer
        try {
            const tasksService = require('../tasks/tasks.service');
            await tasksService.stopActiveTimerForEmployee(employeeId, now);
        } catch (e) {
            console.error('[AttendanceService] Auto-stopping task timer on clock-out failed:', e.message);
        }

        // Emit real-time events
        const io = getIO();
        if (io) {
            io.to(`org_${attendance.organizationId}`).emit('attendance:update', { employeeId, type: 'clock-out' });
            io.to(`org_${attendance.organizationId}`).emit('employee:status', { employeeId, status: 'OFFLINE' });
        }

        // Persist notification for clock-out
        try {
            const empUser = await prisma.employee.findUnique({ where: { id: employeeId }, include: { user: true } });
            const empName = empUser?.user?.name || `Employee ${empUser?.employeeCode || employeeId}`;
            await prisma.notification.create({
                data: {
                    organizationId: attendance.organizationId,
                    title: 'Work session ended',
                    description: `${empName} clocked out`,
                    type: 'info',
                    targetUserId: empUser?.userId || null,
                    unread: true
                }
            });
        } catch (ne) {
            console.error('[AttendanceService] Notification create error on clock-out:', ne.message);
        }

        return updatedAttendance;
    },

    getTimesheets: async (organizationId, filters = {}) => {
        const where = {
            organizationId
        };

        const roleFilter = filters.role ? filters.role : { not: 'ADMIN' };
        where.employee = { role: roleFilter };
        if (filters.employeeId) where.employeeId = filters.employeeId;
        if (filters.teamId) where.employee = { ...(where.employee || {}), teamId: filters.teamId };
        if (filters.startDate && filters.endDate) {
            const start = new Date(filters.startDate);
            start.setHours(0, 0, 0, 0);
            const end = new Date(filters.endDate);
            end.setHours(23, 59, 59, 999);
            where.OR = [
                { date: { gte: start, lte: end } },
                { clockIn: { gte: start, lte: end } }
            ];
        }

        return await prisma.attendance.findMany({
            where,
            include: {
                employee: {
                    select: {
                        fullName: true,
                        location: true,
                        role: true,
                        teamId: true,
                        team: {
                            select: { name: true, description: true },
                        },
                    },
                },
            },
            orderBy: [{ date: 'desc' }, { clockIn: 'desc' }],
        });
    },

    /**
     * One row per employee per day (merged sessions, correct total hours).
     */
    getTimesheetsGrouped: async (organizationId, filters = {}) => {
        const where = {
            organizationId
        };
        const roleFilter = filters.role ? filters.role : { not: 'ADMIN' };
        where.employee = { role: roleFilter };
        if (filters.employeeId) where.employeeId = filters.employeeId;
        if (filters.teamId) where.employee = { ...(where.employee || {}), teamId: filters.teamId };
        if (filters.startDate && filters.endDate) {
            const start = new Date(filters.startDate);
            start.setHours(0, 0, 0, 0);
            const end = new Date(filters.endDate);
            end.setHours(23, 59, 59, 999);
            where.OR = [
                { date: { gte: start, lte: end } },
                { clockIn: { gte: start, lte: end } }
            ];
        }

        const records = await prisma.attendance.findMany({
            where,
            include: {
                employee: {
                    select: {
                        fullName: true,
                        location: true,
                        role: true,
                        teamId: true,
                        team: { select: { name: true, description: true } },
                    },
                },
            },
            orderBy: [{ date: 'desc' }, { clockIn: 'asc' }],
        });

        const map = new Map();
        const now = Date.now();

        records.forEach((row) => {
            const dateKey = new Date(row.date).toISOString().split('T')[0];
            const key = `${row.employeeId}_${dateKey}`;

            if (!map.has(key)) {
                map.set(key, {
                    id: key,
                    employeeId: row.employeeId,
                    organizationId: row.organizationId,
                    employee: row.employee,
                    date: row.date,
                    clockIn: row.clockIn,
                    clockOut: null,
                    duration: 0,
                    sessionCount: 0,
                    late: false,
                    hasOpen: false,
                });
            }

            const agg = map.get(key);
            agg.sessionCount += 1;
            if (row.late) agg.late = true;

            if (row.clockIn && (!agg.clockIn || new Date(row.clockIn) < new Date(agg.clockIn))) {
                agg.clockIn = row.clockIn;
            }

            if (!row.clockOut) {
                agg.hasOpen = true;
                agg.clockOut = null;
                agg.duration += Math.floor((now - new Date(row.clockIn).getTime()) / 1000);
            } else {
                const seg =
                    row.duration ||
                    Math.floor((new Date(row.clockOut) - new Date(row.clockIn)) / 1000);
                agg.duration += seg;
                if (!agg.hasOpen) {
                    if (!agg.clockOut || new Date(row.clockOut) > new Date(agg.clockOut)) {
                        agg.clockOut = row.clockOut;
                    }
                }
            }
        });

        return Array.from(map.values())
            .map(({ hasOpen, ...agg }) => ({
                ...agg,
                isGrouped: true,
            }))
            .sort((a, b) => new Date(b.date) - new Date(a.date));
    },

    addManualTime: async (data) => {
        const { employeeId, organizationId, startDate, startTime, endDate, endTime, timezone, type, description } = data;

        // Guard: Reject deactivated employee
        const emp = await prisma.employee.findUnique({ where: { id: employeeId }, select: { status: true } });
        if (!emp) throw new Error('Employee not found');
        if (emp.status === 'DEACTIVATED') {
            const err = new Error('Cannot add manual time: Employee account is deactivated');
            err.code = 'ACCOUNT_DEACTIVATED';
            err.statusCode = 403;
            throw err;
        }

        // Guard: Prevent adding manual time if timesheet for this period is already approved and locked
        try {
            const timesheetsService = require('../timesheets/timesheets.service');
            const targetDate = startDate || (startTime ? (String(startTime).includes('T') ? String(startTime).slice(0, 10) : startTime) : null) || data.date;
            const isLocked = await timesheetsService.isPeriodLocked(organizationId, employeeId, targetDate);
            if (isLocked) {
                const err = new Error('Cannot add manual time: The timesheet for this period has already been approved and locked. Reopen the timesheet to make adjustments.');
                err.statusCode = 409;
                throw err;
            }
        } catch (lErr) {
            if (lErr.statusCode === 409) throw lErr;
        }

        const start = new Date(`${startDate} ${startTime}`);
        const end = new Date(`${endDate} ${endTime}`);
        const duration = Math.floor((end - start) / 1000);

        const manualTime = await prisma.manualTime.create({
            data: {
                employeeId,
                organizationId,
                startTime: start,
                endTime: end,
                timezone,
                type: type || 'Regular',
                duration: duration > 0 ? duration : 0,
                note: description,
            }
        });

        // Emit real-time event
        const io = getIO();
        if (io) {
            io.to(`org_${organizationId}`).emit('attendance:update', { employeeId, type: 'manual-time' });
        }

        return manualTime;
    },

    getManualTimes: async (filters) => {
        const where = { organizationId: filters.organizationId };
        if (filters.employeeId) where.employeeId = filters.employeeId;
        if (filters.teamId) where.employee = { teamId: filters.teamId };
        
        if (filters.startDate && filters.endDate) {
            where.startTime = {
                gte: new Date(filters.startDate),
            };
            where.endTime = {
                lte: new Date(`${filters.endDate} 23:59:59`),
            };
        }

        return await prisma.manualTime.findMany({
            where,
            include: {
                employee: {
                    select: { fullName: true }
                }
            },
            orderBy: { startTime: 'desc' }
        });
    },

    getShifts: async (organizationId, filters = {}) => {
        const where = { organizationId };
        if (filters.employeeId) where.employeeId = filters.employeeId;
        if (filters.startDate && filters.endDate) {
            where.date = {
                gte: new Date(filters.startDate),
                lte: new Date(filters.endDate),
            };
        }

        return await prisma.shift.findMany({
            where,
            include: {
                employee: { select: { fullName: true } }
            },
            orderBy: { date: 'asc' }
        });
    },

    createShift: async (data) => {
        // Guard: Reject deactivated employee
        const emp = await prisma.employee.findUnique({ where: { id: data.employeeId }, select: { status: true } });
        if (!emp) throw new Error('Employee not found');
        if (emp.status === 'DEACTIVATED') {
            const err = new Error('Cannot schedule shifts for a deactivated employee');
            err.code = 'ACCOUNT_DEACTIVATED';
            err.statusCode = 403;
            throw err;
        }

        const shift = await prisma.shift.create({
            data: {
                employeeId: data.employeeId,
                organizationId: data.organizationId,
                startTime: data.startTime,
                endTime: data.endTime,
                date: new Date(data.date),
            },
            include: { employee: { select: { fullName: true } } }
        });

        // Emit real-time event
        const io = getIO();
        if (io) {
            io.to(`org_${data.organizationId}`).emit('attendance:update', { employeeId: data.employeeId, type: 'shift-new' });
        }

        return shift;
    },

    createTimeOff: async (data) => {
        // Guard: Reject deactivated employee
        const emp = await prisma.employee.findUnique({ where: { id: data.employeeId }, select: { status: true } });
        if (!emp) throw new Error('Employee not found');
        if (emp.status === 'DEACTIVATED') {
            const err = new Error('Cannot request or schedule time off for a deactivated employee');
            err.code = 'ACCOUNT_DEACTIVATED';
            err.statusCode = 403;
            throw err;
        }

        const timeOff = await prisma.timeOff.create({
            data: {
                employeeId: data.employeeId,
                organizationId: data.organizationId,
                startDate: new Date(data.startDate),
                endDate: new Date(data.endDate),
                type: data.type || 'Days',
                timeOffType: data.timeOffType || null,
                timezone: data.timezone || null,
                note: data.note || null,
                singleDay: data.singleDay || false,
            },
            include: { employee: { select: { fullName: true } } }
        });

        // Emit real-time event
        const io = getIO();
        if (io) {
            io.to(`org_${data.organizationId}`).emit('attendance:update', { employeeId: data.employeeId, type: 'time-off-new' });
        }

        return timeOff;
    },

    getTimeOffs: async (organizationId, filters = {}) => {
        const where = { organizationId };
        if (filters.employeeId) where.employeeId = filters.employeeId;
        if (filters.startDate && filters.endDate) {
            where.startDate = { lte: new Date(filters.endDate) };
            where.endDate = { gte: new Date(filters.startDate) };
        }

        return await prisma.timeOff.findMany({
            where,
            include: { employee: { select: { fullName: true } } },
            orderBy: { startDate: 'asc' }
        });
    },

    startBreak: async (employeeId, organizationId) => {
        // Validation: Ensure valid IDs are passed
        if (!employeeId || employeeId === '') {
            console.error('[AttendanceService] startBreak failed: employeeId is missing or empty');
            throw new Error('Employee ID is required to start a break');
        }
        if (!organizationId) {
            console.warn('[AttendanceService] startBreak: organizationId is missing, using default');
        }

        console.log(`[AttendanceService] Starting break for employee: ${employeeId}, org: ${organizationId}`);

        try {
            // Update employee status to BREAK (Must match Enum exactly: BREAK)
            // Guard: Ensure not deactivated
            const emp = await prisma.employee.findUnique({ where: { id: employeeId }, select: { status: true } });
            if (emp && emp.status === 'DEACTIVATED') {
                throw new Error('Deactivated employees cannot start a break');
            }

            await prisma.employee.update({
                where: { id: employeeId },
                data: { status: 'BREAK' }
            });

            // Close any open ACTIVE activity log so work duration up to break is locked
            try {
                const openActive = await prisma.activityLog.findFirst({
                    where: { employeeId, activityType: 'ACTIVE', duration: 0 },
                    orderBy: { timestamp: 'desc' }
                });
                if (openActive) {
                    const dur = Math.max(1, Math.floor((Date.now() - new Date(openActive.timestamp).getTime()) / 1000));
                    await prisma.activityLog.update({
                        where: { id: openActive.id },
                        data: { duration: dur }
                    });
                }
            } catch (aErr) {
                console.error('[AttendanceService] Could not close open active log on break:', aErr.message);
            }

            // Create an activity log for the break start
            const log = await prisma.activityLog.create({
                data: {
                    employeeId,
                    organizationId: organizationId || 'default-org-id',
                    activityType: 'BREAK',
                    productivity: 'NEUTRAL',
                    duration: 0,
                    timestamp: new Date(),
                    appWebsite: 'Break'
                }
            });

            // Auto-stop any running task timer
            try {
                const tasksService = require('../tasks/tasks.service');
                await tasksService.stopActiveTimerForEmployee(employeeId, new Date());
            } catch (e) {
                console.error('[AttendanceService] Auto-stopping task timer on break failed:', e.message);
            }

            // Notify real-time
            updateSessionStatus(employeeId, 'BREAK');

            const io = getIO();
            if (io) {
                // We still emit these for backward compatibility or direct listeners
                io.to(`org_${organizationId}`).emit('attendance:update', { employeeId, type: 'break-start' });
                io.to(`org_${organizationId}`).emit('employee:status', { employeeId, status: 'BREAK' });
            }

            // Persist notification for start break
            try {
                const empUser = await prisma.employee.findUnique({ where: { id: employeeId }, include: { user: true } });
                const empName = empUser?.user?.name || `Employee ${empUser?.employeeCode || employeeId}`;
                await prisma.notification.create({
                    data: {
                        organizationId,
                        title: 'Break started',
                        description: `${empName} started a break`,
                        type: 'warning',
                        targetUserId: empUser?.userId || null,
                        unread: true
                    }
                });
            } catch (ne) {
                console.error('[AttendanceService] Notification create error on break-start:', ne.message);
            }

            return { ...log, openBreak: log.timestamp };
        } catch (error) {
            console.error('[AttendanceService] startBreak Error:', error);
            // Hint for common enum error
            if (error.message.includes('Value \'\' not found in enum')) {
                console.error('[AttendanceService] Critical error: An enum field (likely EmployeeStatus) is being set to an empty string. Please check database data.');
            }
            throw error;
        }
    },

    endBreak: async (employeeId) => {
        if (!employeeId || employeeId === '') {
            console.error('[AttendanceService] endBreak failed: employeeId is missing or empty');
            throw new Error('Employee ID is required to end a break');
        }

        // Fetch employee to get organizationId for socket
        const employee = await prisma.employee.findUnique({
            where: { id: employeeId },
            select: { organizationId: true }
        });

        if (!employee) {
            throw new Error('Employee not found');
        }

        console.log(`[AttendanceService] Ending break for employee: ${employeeId}, org: ${employee.organizationId}`);

        try {
            // Update employee status back to ACTIVE (Guard: Ensure not deactivated)
            const empInfo = await prisma.employee.findUnique({ where: { id: employeeId }, select: { status: true } });
            if (empInfo && empInfo.status !== 'DEACTIVATED') {
                await prisma.employee.update({
                    where: { id: employeeId },
                    data: { status: 'ACTIVE' }
                });
            }

            // Find the last BREAK activity log for this employee that has 0 duration
            const lastBreak = await prisma.activityLog.findFirst({
                where: {
                    employeeId,
                    activityType: 'BREAK',
                    duration: 0
                },
                orderBy: { timestamp: 'desc' }
            });

            let duration = 0;
            if (lastBreak) {
                const now = new Date();
                duration = Math.max(1, Math.floor((now - lastBreak.timestamp) / 1000));
                await prisma.activityLog.update({
                    where: { id: lastBreak.id },
                    data: { duration }
                });
            }

            // Start a new open ACTIVE activity log now that work has resumed
            try {
                await prisma.activityLog.create({
                    data: {
                        employeeId,
                        organizationId: employee.organizationId || 'default-org-id',
                        activityType: 'ACTIVE',
                        productivity: 'PRODUCTIVE',
                        duration: 0,
                        timestamp: new Date(),
                        appWebsite: 'Work Session',
                        title: 'Active Work Session'
                    }
                });
            } catch (aErr) {
                console.error('[AttendanceService] Could not start new active log on resume:', aErr.message);
            }

            // Notify real-time
            updateSessionStatus(employeeId, 'ACTIVE');

            const io = getIO();
            if (io) {
                io.to(`org_${employee.organizationId}`).emit('attendance:update', { employeeId, type: 'break-end' });
                io.to(`org_${employee.organizationId}`).emit('employee:status', { employeeId, status: 'ACTIVE' });
            }

            // Persist notification for end break
            try {
                const empName = employee?.user?.name || `Employee ${employee?.employeeCode || employeeId}`;
                await prisma.notification.create({
                    data: {
                        organizationId: employee.organizationId,
                        title: 'Break ended',
                        description: `${empName} resumed work`,
                        type: 'success',
                        targetUserId: employee?.userId || null,
                        unread: true
                    }
                });
            } catch (ne) {
                console.error('[AttendanceService] Notification create error on break-end:', ne.message);
            }

            return { success: true, duration };
        } catch (error) {
            console.error('[AttendanceService] endBreak Error:', error);
            throw error;
        }
    }
};

module.exports = attendanceService;
