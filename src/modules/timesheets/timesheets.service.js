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
     * Get or create weekly timesheet for a single employee
     */
    getWeeklyTimesheet: async (organizationId, employeeId, weekInput) => {
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

        // Fetch Attendance sessions for this week
        const attendance = await prisma.attendance.findMany({
            where: {
                employeeId,
                organizationId,
                date: { gte: startMs, lt: endMs }
            },
            orderBy: { clockIn: 'asc' }
        });

        // Fetch Manual Time entries for this week
        const manualTimes = await prisma.manualTime.findMany({
            where: {
                employeeId,
                organizationId,
                startTime: { gte: startMs, lt: endMs }
            },
            orderBy: { startTime: 'asc' }
        });

        // Compute 7-day breakdown and week rollup
        const days = buildDailyBreakdown(attendance, manualTimes, weekStart);
        const summary = summarizeWeek(days, 2400); // 40h regular threshold
        const pay = calculatePay(summary.regularMinutes, summary.overtimeMinutes, employee.hourlyRate, 150);

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
        } else if (timesheet.status === 'DRAFT') {
            // Keep DRAFT timesheet metrics synchronized with current live tracked hours
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
            totalMinutes: timesheet.status === 'DRAFT' ? summary.totalMinutes : timesheet.totalMinutes,
            regularMinutes: timesheet.status === 'DRAFT' ? summary.regularMinutes : timesheet.regularMinutes,
            overtimeMinutes: timesheet.status === 'DRAFT' ? summary.overtimeMinutes : timesheet.overtimeMinutes,
            overThreshold: (timesheet.status === 'DRAFT' ? summary.overtimeMinutes : timesheet.overtimeMinutes) > 0,
            regularPay: pay.regularPay,
            overtimePay: pay.overtimePay,
            totalPay: timesheet.status === 'DRAFT' ? pay.totalPay : timesheet.totalPay,
            approvals: timesheet.approvals
        };
    },

    /**
     * Get weekly timesheets for all employees (filtered by team/employee)
     */
    getWeeklyTimesheetsAll: async (organizationId, weekInput, filters = {}, requester = {}) => {
        const weekStart = mondayOf(weekInput || new Date());
        const employeeWhere = { organizationId, status: { not: 'DEACTIVATED' } };

        if (filters.employeeId) {
            employeeWhere.id = filters.employeeId;
        }

        // If requester is a Manager, scope to their team
        if (requester.role === 'MANAGER') {
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
            employees.map(emp => timesheetsService.getWeeklyTimesheet(organizationId, emp.id, weekStart))
        );

        return list;
    },

    /**
     * Submit timesheet for approval
     */
    submitTimesheet: async (organizationId, employeeId, weekInput) => {
        const weekStart = mondayOf(weekInput || new Date());

        // Compute current metrics before locking submission
        const currentPayload = await timesheetsService.getWeeklyTimesheet(organizationId, employeeId, weekStart);

        if (currentPayload.status === 'APPROVED') {
            throw new Error('Timesheet is already approved and cannot be re-submitted');
        }

        const updated = await prisma.timesheet.update({
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

        return {
            ...currentPayload,
            status: updated.status,
            submittedAt: updated.submittedAt,
            approvals: updated.approvals
        };
    },

    /**
     * Manager/Admin Approval Queue
     */
    getApprovalQueue: async (organizationId, requester = {}) => {
        const where = {
            organizationId,
            status: 'SUBMITTED'
        };

        if (requester.role === 'MANAGER') {
            const manager = await prisma.employee.findUnique({
                where: { id: requester.employeeId },
                select: { teamId: true }
            });

            where.employee = {
                teamId: manager?.teamId || null,
                id: { not: requester.employeeId } // Manager cannot approve self
            };
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
            orderBy: { submittedAt: 'asc' }
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
                    approvals: ts.approvals
                };
            })
        );

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
    exportPayrollCsv: async (organizationId, weekInput, requester) => {
        const weekStart = mondayOf(weekInput || new Date());
        const timesheets = await timesheetsService.getWeeklyTimesheetsAll(organizationId, weekStart, {}, requester);

        const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
        const headers = [
            'Employee Name',
            'Employee Email',
            'Team',
            'Period Start',
            'Period End',
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
    }
};

module.exports = timesheetsService;
