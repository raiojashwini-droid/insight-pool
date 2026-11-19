const prisma = require('../../config/db');
const {
    mondayOf,
    addDays,
    buildDailyBreakdown,
    summarizeWeek,
    calculatePay
} = require('../../utils/timesheetCalc');

const timesheetsService = {
    /**
     * Get configurable overtime settings from organization schedule or explicit parameters
     */
    getOvertimeConfig: async (organizationId, employeeId = null, options = {}) => {
        let thresholdMinutes = options.overtimeThreshold || options.overtime_threshold;
        let multiplierPct = options.overtimeMultiplier || options.overtime_multiplier;

        if (thresholdMinutes) {
            thresholdMinutes = Number(thresholdMinutes);
            // If in hours (e.g. 40, 35, 48), convert to minutes
            if (thresholdMinutes <= 168) thresholdMinutes = Math.round(thresholdMinutes * 60);
        }

        if (multiplierPct) {
            multiplierPct = Number(multiplierPct);
            // If passed as decimal (e.g. 1.5, 2.0), convert to percentage (150, 200)
            if (multiplierPct <= 5) multiplierPct = Math.round(multiplierPct * 100);
        }

        if (thresholdMinutes && multiplierPct) {
            return { thresholdMinutes, multiplierPct };
        }

        // Check organization settings
        const org = await prisma.organization.findUnique({
            where: { id: organizationId },
            select: { workStartTime: true, workEndTime: true, workDays: true }
        });

        if (org && !thresholdMinutes) {
            try {
                const daysList = (org.workDays || 'Monday,Tuesday,Wednesday,Thursday,Friday').split(',').map(s => s.trim()).filter(Boolean);
                const [sH, sM] = (org.workStartTime || '09:00').split(':').map(Number);
                const [eH, eM] = (org.workEndTime || '18:00').split(':').map(Number);
                let dailyHours = (eH + (eM || 0) / 60) - (sH + (sM || 0) / 60);
                if (dailyHours > 5) dailyHours -= 1; // 1 hr standard break
                if (dailyHours > 0 && daysList.length > 0) {
                    thresholdMinutes = Math.round(daysList.length * dailyHours * 60);
                }
            } catch (e) {
                // fallback
            }
        }

        return {
            thresholdMinutes: thresholdMinutes || 2400, // 40h standard
            multiplierPct: multiplierPct || 150        // 1.5x standard
        };
    },

    /**
     * Get or create weekly timesheet for a single employee
     */
    getWeeklyTimesheet: async (organizationId, employeeId, weekInput, options = {}) => {
        const weekStart = mondayOf(weekInput || new Date());
        const weekEnd = addDays(weekStart, 7);

        const employee = await prisma.employee.findFirst({
            where: { id: employeeId, organizationId },
            include: { team: { select: { id: true, name: true } } }
        });

        if (!employee) {
            throw new Error('Employee not found in organization');
        }

        const startMs = new Date(weekStart + 'T00:00:00Z');
        const endMs = new Date(weekEnd + 'T00:00:00Z');
        const bufferStart = new Date(startMs.getTime() - 86400000);
        const bufferEnd = new Date(endMs.getTime() + 86400000);

        // Fetch Attendance sessions for this week (buffered for cross-midnight coverage)
        const attendance = await prisma.attendance.findMany({
            where: {
                employeeId,
                organizationId,
                OR: [
                    { date: { gte: startMs, lt: endMs } },
                    { clockIn: { gte: bufferStart, lt: bufferEnd } }
                ]
            },
            orderBy: { clockIn: 'asc' }
        });

        // Fetch Manual Time entries for this week
        const manualTimes = await prisma.manualTime.findMany({
            where: {
                employeeId,
                organizationId,
                startTime: { gte: bufferStart, lt: bufferEnd }
            },
            orderBy: { startTime: 'asc' }
        });

        // Fetch ActivityLog break entries for this week
        const breakLogs = await prisma.activityLog.findMany({
            where: {
                employeeId,
                organizationId,
                activityType: 'BREAK',
                timestamp: { gte: bufferStart, lt: bufferEnd }
            },
            orderBy: { timestamp: 'asc' }
        });

        // Overtime configuration (organization schedule or explicit parameters)
        const otConfig = await timesheetsService.getOvertimeConfig(organizationId, employeeId, options);

        // Compute 7-day breakdown and week rollup with break deductions & interval merging
        const days = buildDailyBreakdown(attendance, manualTimes, breakLogs, weekStart);
        const summary = summarizeWeek(days, otConfig.thresholdMinutes);
        const pay = calculatePay(summary.regularMinutes, summary.overtimeMinutes, employee.hourlyRate, otConfig.multiplierPct);

        // Find or create Timesheet record
        let timesheet = await prisma.timesheet.findUnique({
            where: {
                organizationId_employeeId_weekStart: {
                    organizationId,
                    employeeId,
                    weekStart
                }
            },
            include: {
                approvals: {
                    orderBy: { createdAt: 'desc' }
                }
            }
        });

        if (!timesheet) {
            timesheet = await prisma.timesheet.create({
                data: {
                    organizationId,
                    employeeId,
                    weekStart,
                    status: 'DRAFT',
                    totalMinutes: summary.totalMinutes,
                    regularMinutes: summary.regularMinutes,
                    overtimeMinutes: summary.overtimeMinutes,
                    totalPay: pay.totalPay
                },
                include: {
                    approvals: {
                        orderBy: { createdAt: 'desc' }
                    }
                }
            });
        } else if (timesheet.status === 'DRAFT' || timesheet.status === 'REJECTED') {
            // Keep DRAFT / REJECTED timesheet metrics synchronized with current live tracked hours
            timesheet = await prisma.timesheet.update({
                where: { id: timesheet.id },
                data: {
                    totalMinutes: summary.totalMinutes,
                    regularMinutes: summary.regularMinutes,
                    overtimeMinutes: summary.overtimeMinutes,
                    totalPay: pay.totalPay
                },
                include: {
                    approvals: {
                        orderBy: { createdAt: 'desc' }
                    }
                }
            });
        }

        const isLive = timesheet.status === 'DRAFT' || timesheet.status === 'REJECTED';

        return {
            timesheetId: timesheet.id,
            employeeId: employee.id,
            employeeName: employee.fullName,
            employeeEmail: employee.email,
            teamName: employee.team?.name || 'General',
            hourlyRate: employee.hourlyRate,
            weekStart,
            weekEnd: addDays(weekStart, 6),
            status: timesheet.status,
            submittedAt: timesheet.submittedAt,
            days,
            totalMinutes: isLive ? summary.totalMinutes : timesheet.totalMinutes,
            regularMinutes: isLive ? summary.regularMinutes : timesheet.regularMinutes,
            overtimeMinutes: isLive ? summary.overtimeMinutes : timesheet.overtimeMinutes,
            overThreshold: (isLive ? summary.overtimeMinutes : timesheet.overtimeMinutes) > 0,
            regularPay: pay.regularPay,
            overtimePay: pay.overtimePay,
            totalPay: isLive ? pay.totalPay : timesheet.totalPay,
            totalGrossMinutes: summary.totalGrossMinutes,
            totalBreakMinutes: summary.totalBreakMinutes,
            otThresholdMinutes: otConfig.thresholdMinutes,
            otMultiplierPct: otConfig.multiplierPct,
            approvals: timesheet.approvals
        };
    },

    /**
     * Get weekly timesheets for all employees (filtered by team/employee)
     */
    getWeeklyTimesheetsAll: async (organizationId, weekInput, filters = {}, requester = {}) => {
        const weekStart = mondayOf(weekInput || new Date());
        const employeeWhere = { organizationId, status: { not: 'DEACTIVATED' }, role: { not: 'ADMIN' } };

        if (filters.employeeId) {
            employeeWhere.id = filters.employeeId;
        }

        // If requester is a Manager, scope to role EMPLOYEE and their team
        if (requester.role === 'MANAGER') {
            employeeWhere.role = 'EMPLOYEE';
            const manager = await prisma.employee.findUnique({
                where: { id: requester.employeeId },
                select: { teamId: true }
            });
            if (manager && manager.teamId) {
                employeeWhere.teamId = manager.teamId;
            }
        } else if (filters.teamId) {
            employeeWhere.teamId = filters.teamId;
        }

        const employees = await prisma.employee.findMany({
            where: employeeWhere,
            orderBy: { fullName: 'asc' }
        });

        const list = await Promise.all(
            employees.map(emp => timesheetsService.getWeeklyTimesheet(organizationId, emp.id, weekStart, filters))
        );

        return list;
    },

    /**
     * Submit timesheet for approval (supports initial submission and resubmission after rejection)
     */
    submitTimesheet: async (organizationId, employeeId, weekInput) => {
        const weekStart = mondayOf(weekInput || new Date());

        // Guard: Prevent deactivated employees from submitting timesheets
        const emp = await prisma.employee.findUnique({
            where: { id: employeeId },
            select: { status: true, fullName: true }
        });
        if (!emp) throw new Error('Employee not found');
        if (emp.status === 'DEACTIVATED') {
            const err = new Error('Cannot submit timesheet: Employee account is deactivated');
            err.code = 'ACCOUNT_DEACTIVATED';
            err.statusCode = 403;
            throw err;
        }

        // Compute current metrics before locking submission
        const currentPayload = await timesheetsService.getWeeklyTimesheet(organizationId, employeeId, weekStart);

        if (currentPayload.status === 'APPROVED') {
            const err = new Error('Timesheet is already approved and cannot be re-submitted');
            err.statusCode = 409;
            throw err;
        }

        const isResubmission = currentPayload.status === 'REJECTED';

        const updated = await prisma.$transaction(async (tx) => {
            const ts = await tx.timesheet.update({
                where: { id: currentPayload.timesheetId },
                data: {
                    status: 'SUBMITTED',
                    submittedAt: new Date(),
                    totalMinutes: currentPayload.totalMinutes,
                    regularMinutes: currentPayload.regularMinutes,
                    overtimeMinutes: currentPayload.overtimeMinutes,
                    totalPay: currentPayload.totalPay
                },
                include: {
                    approvals: {
                        orderBy: { createdAt: 'desc' }
                    }
                }
            });

            if (isResubmission) {
                await tx.timesheetApproval.create({
                    data: {
                        timesheetId: currentPayload.timesheetId,
                        approverId: employeeId,
                        approverName: emp.fullName,
                        decision: 'RESUBMITTED',
                        comment: 'Timesheet resubmitted with corrections'
                    }
                });
            }

            return ts;
        });

        // Refetch latest approvals
        const latestApprovals = await prisma.timesheetApproval.findMany({
            where: { timesheetId: currentPayload.timesheetId },
            orderBy: { createdAt: 'desc' }
        });

        return {
            ...currentPayload,
            status: updated.status,
            submittedAt: updated.submittedAt,
            approvals: latestApprovals
        };
    },

    /**
     * Manager/Admin Approval Queue
     */
    getApprovalQueue: async (organizationId, requester = {}) => {
        const where = {
            organizationId
        };

        const filterStatus = (requester.filterStatus || 'ALL').toUpperCase();
        if (filterStatus === 'SUBMITTED' || filterStatus === 'APPROVED' || filterStatus === 'REJECTED') {
            where.status = filterStatus;
        } else {
            where.status = { in: ['SUBMITTED', 'APPROVED', 'REJECTED'] };
        }

        if (requester.role === 'MANAGER') {
            const manager = await prisma.employee.findUnique({
                where: { id: requester.employeeId },
                select: { teamId: true }
            });

            const empCondition = {
                role: 'EMPLOYEE',
                id: { not: requester.employeeId } // Manager cannot approve self
            };
            if (manager?.teamId) {
                empCondition.teamId = manager.teamId;
            }

            where.employee = empCondition;
        }

        const submittedTimesheets = await prisma.timesheet.findMany({
            where,
            include: {
                employee: {
                    include: {
                        team: { select: { id: true, name: true } }
                    }
                },
                approvals: {
                    orderBy: { createdAt: 'desc' }
                }
            },
            orderBy: { updatedAt: 'desc' }
        });

        // Enrich with weekly breakdown
        const queue = await Promise.all(
            submittedTimesheets.map(async (ts) => {
                const payload = await timesheetsService.getWeeklyTimesheet(organizationId, ts.employeeId, ts.weekStart);
                return {
                    ...payload,
                    timesheetId: ts.id,
                    status: ts.status,
                    submittedAt: ts.submittedAt,
                    updatedAt: ts.updatedAt,
                    approvals: ts.approvals
                };
            })
        );

        // Sort: SUBMITTED (pending action) first, then REJECTED, then APPROVED (by latest updatedAt/submittedAt)
        const statusPriority = { SUBMITTED: 1, REJECTED: 2, APPROVED: 3 };
        queue.sort((a, b) => {
            const pA = statusPriority[a.status] || 99;
            const pB = statusPriority[b.status] || 99;
            if (pA !== pB) return pA - pB;
            return new Date(b.updatedAt || b.submittedAt || 0) - new Date(a.updatedAt || a.submittedAt || 0);
        });

        return queue;
    },

    /**
     * Approve or Reject a Timesheet
     */
    decideTimesheet: async (organizationId, timesheetId, approverUser, decision, comment = '') => {
        const timesheet = await prisma.timesheet.findUnique({
            where: { id: timesheetId },
            include: {
                employee: {
                    select: { id: true, fullName: true, teamId: true }
                }
            }
        });

        if (!timesheet || timesheet.organizationId !== organizationId) {
            throw new Error('Timesheet not found');
        }

        if (timesheet.status !== 'SUBMITTED') {
            throw new Error(`Timesheet is '${timesheet.status}' and cannot be processed in this state`);
        }

        // Scope check for manager
        if (approverUser.role === 'MANAGER') {
            const manager = await prisma.employee.findUnique({
                where: { id: approverUser.employeeId },
                select: { teamId: true }
            });

            if (!manager?.teamId || manager.teamId !== timesheet.employee.teamId) {
                throw new Error('Access denied: You can only approve timesheets for your assigned team members');
            }

            if (timesheet.employeeId === approverUser.employeeId) {
                throw new Error('Access denied: You cannot approve your own timesheet');
            }
        }

        const normalizedDecision = decision.toUpperCase();
        if (normalizedDecision !== 'APPROVED' && normalizedDecision !== 'REJECTED') {
            throw new Error("Decision must be either 'APPROVED' or 'REJECTED'");
        }

        const cleanComment = String(comment || '').trim();
        if (normalizedDecision === 'REJECTED' && !cleanComment) {
            throw new Error('A rejection comment is required when rejecting a timesheet');
        }

        // Update status and append approval record in a transaction
        await prisma.$transaction([
            prisma.timesheet.update({
                where: { id: timesheet.id },
                data: { status: normalizedDecision }
            }),
            prisma.timesheetApproval.create({
                data: {
                    timesheetId: timesheet.id,
                    approverId: approverUser.employeeId || approverUser.userId,
                    approverName: approverUser.name || approverUser.email || (approverUser.role === 'ADMIN' ? 'Administrator' : 'Manager'),
                    decision: normalizedDecision,
                    comment: cleanComment
                }
            })
        ]);

        return await timesheetsService.getWeeklyTimesheet(organizationId, timesheet.employeeId, timesheet.weekStart);
    },

    /**
     * Bulk Approve multiple submitted timesheets
     */
    bulkApprove: async (organizationId, timesheetIds = [], approverUser) => {
        if (!Array.isArray(timesheetIds) || timesheetIds.length === 0) {
            return { ok: true, approvedCount: 0 };
        }

        let approvedCount = 0;
        for (const id of timesheetIds) {
            try {
                await timesheetsService.decideTimesheet(organizationId, id, approverUser, 'APPROVED', 'Bulk Approved');
                approvedCount++;
            } catch (err) {
                // Continue batch for remaining items
                console.warn(`Bulk approve skipped ${id}:`, err.message);
            }
        }

        return { ok: true, approvedCount };
    },

    /**
     * Payroll CSV Export
     */
    exportPayrollCsv: async (organizationId, weekInput, requester, options = {}) => {
        const weekStart = mondayOf(weekInput || new Date());
        const timesheets = await timesheetsService.getWeeklyTimesheetsAll(organizationId, weekStart, options, requester);

        const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
        const headers = [
            'Employee Name',
            'Employee Email',
            'Team',
            'Period Start',
            'Period End',
            'Gross Hours',
            'Break Hours',
            'Regular Hours',
            'Overtime Hours',
            'Total Hours',
            'Hourly Rate',
            'Regular Pay',
            'Overtime Pay',
            'Total Pay',
            'Status'
        ];

        const rows = timesheets.map(t => [
            esc(t.employeeName),
            esc(t.employeeEmail),
            esc(t.teamName),
            t.weekStart,
            t.weekEnd,
            (((t.totalGrossMinutes != null ? t.totalGrossMinutes : t.totalMinutes)) / 60).toFixed(2),
            (((t.totalBreakMinutes || 0)) / 60).toFixed(2),
            (t.regularMinutes / 60).toFixed(2),
            (t.overtimeMinutes / 60).toFixed(2),
            (t.totalMinutes / 60).toFixed(2),
            t.hourlyRate.toFixed(2),
            t.regularPay.toFixed(2),
            t.overtimePay.toFixed(2),
            t.totalPay.toFixed(2),
            t.status
        ]);

        const csvContent = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
        return { csvContent, weekStart };
    },

    /**
     * Controlled Reopening of a Timesheet with Audit Trail
     */
    reopenTimesheet: async (organizationId, timesheetId, requester, reason = '') => {
        if (!reason || !String(reason).trim()) {
            const err = new Error('A reason is required to reopen a timesheet');
            err.statusCode = 400;
            throw err;
        }

        const timesheet = await prisma.timesheet.findUnique({
            where: { id: timesheetId },
            include: {
                employee: { select: { id: true, fullName: true, teamId: true } }
            }
        });

        if (!timesheet || timesheet.organizationId !== organizationId) {
            const err = new Error('Timesheet not found');
            err.statusCode = 404;
            throw err;
        }

        // Permissions: Only Admin or Manager can reopen
        if (requester.role === 'EMPLOYEE') {
            const err = new Error('Access denied: Only administrators or managers can reopen timesheets');
            err.statusCode = 403;
            throw err;
        }

        if (requester.role === 'MANAGER') {
            const manager = await prisma.employee.findUnique({
                where: { id: requester.employeeId },
                select: { teamId: true }
            });
            if (!manager?.teamId || manager.teamId !== timesheet.employee.teamId) {
                const err = new Error('Access denied: You can only reopen timesheets for your assigned team members');
                err.statusCode = 403;
                throw err;
            }
        }

        if (timesheet.status === 'DRAFT') {
            const err = new Error('Timesheet is already in DRAFT status');
            err.statusCode = 400;
            throw err;
        }

        const cleanReason = String(reason).trim();

        // Transaction: update status back to DRAFT and append approval audit record
        await prisma.$transaction([
            prisma.timesheet.update({
                where: { id: timesheet.id },
                data: { status: 'DRAFT' }
            }),
            prisma.timesheetApproval.create({
                data: {
                    timesheetId: timesheet.id,
                    approverId: requester.employeeId || requester.userId || 'admin',
                    approverName: requester.name || requester.email || (requester.role === 'ADMIN' ? 'Administrator' : 'Manager'),
                    decision: 'REOPENED',
                    comment: cleanReason
                }
            })
        ]);

        return await timesheetsService.getWeeklyTimesheet(organizationId, timesheet.employeeId, timesheet.weekStart);
    },

    /**
     * Check if a specific date period is locked by an approved timesheet
     */
    isPeriodLocked: async (organizationId, employeeId, targetDate) => {
        if (!targetDate || !employeeId) return false;
        try {
            const d = typeof targetDate === 'string' && !targetDate.includes('T') ? `${targetDate}T00:00:00Z` : targetDate;
            const parsed = new Date(d);
            if (isNaN(parsed.getTime())) return false;
            const weekStart = mondayOf(parsed);

            const approvedTimesheet = await prisma.timesheet.findUnique({
                where: {
                    organizationId_employeeId_weekStart: {
                        organizationId,
                        employeeId,
                        weekStart
                    }
                },
                select: { id: true, status: true }
            });

            return approvedTimesheet?.status === 'APPROVED';
        } catch (e) {
            return false;
        }
    }
};

module.exports = timesheetsService;
