const timesheetsService = require('./timesheets.service');
const { successResponse, errorResponse } = require('../../utils/response');
const { getOrganizationId } = require('../../utils/orgId');
const { isValidDate } = require('../../utils/timesheetCalc');
const prisma = require('../../config/db');

const timesheetsController = {
    /**
     * Get weekly timesheet(s)
     */
    getWeek: async (req, res) => {
        try {
            const organizationId = await getOrganizationId(req);
            const { role, employeeId } = req.user;
            const weekStart = req.query.week_start;
            const options = {
                teamId: req.query.team_id,
                overtimeThreshold: req.query.overtime_threshold,
                overtimeMultiplier: req.query.overtime_multiplier
            };

            // Fix 2: Validate week_start format before date conversion
            if (weekStart && !isValidDate(weekStart)) {
                return errorResponse(res, `Invalid week_start date format: "${weekStart}". Expected valid date (e.g. YYYY-MM-DD)`, 400);
            }

            if (role === 'EMPLOYEE') {
                if (!employeeId) {
                    return errorResponse(res, 'User profile is not linked to an employee record', 400);
                }
                const timesheet = await timesheetsService.getWeeklyTimesheet(organizationId, employeeId, weekStart, options);
                return successResponse(res, timesheet, 'Weekly timesheet fetched successfully');
            }

            // Fix 1: Manager or Admin querying single employee
            if (req.query.employee_id) {
                const targetEmployeeId = req.query.employee_id;

                // Validate target employee exists within organization (prevent cross-organization access)
                const targetEmployee = await prisma.employee.findFirst({
                    where: { id: targetEmployeeId, organizationId },
                    select: { id: true, teamId: true }
                });

                if (!targetEmployee) {
                    return errorResponse(res, 'Employee not found in organization', 404);
                }

                // If requester is a Manager, enforce team-level authorization
                if (role === 'MANAGER') {
                    const manager = await prisma.employee.findUnique({
                        where: { id: employeeId },
                        select: { teamId: true }
                    });

                    if (!manager?.teamId || manager.teamId !== targetEmployee.teamId) {
                        return errorResponse(res, 'Access denied: You can only access timesheets for employees in your assigned team', 403);
                    }
                }

                const timesheet = await timesheetsService.getWeeklyTimesheet(organizationId, targetEmployeeId, weekStart, options);
                return successResponse(res, timesheet, 'Weekly timesheet fetched successfully');
            }

            const allTimesheets = await timesheetsService.getWeeklyTimesheetsAll(
                organizationId,
                weekStart,
                options,
                req.user
            );
            return successResponse(res, allTimesheets, 'Weekly timesheets fetched successfully');
        } catch (error) {
            const status = error.statusCode || (error.message?.includes('Invalid date') ? 400 : 500);
            return errorResponse(res, error.message, status);
        }
    },

    /**
     * Submit timesheet for approval
     */
    submit: async (req, res) => {
        try {
            const organizationId = await getOrganizationId(req);
            const { role, employeeId: userEmployeeId } = req.user;
            const { week_start, employee_id } = req.body || {};

            // Fix 2: Validate week_start format
            if (week_start && !isValidDate(week_start)) {
                return errorResponse(res, `Invalid week_start date format: "${week_start}". Expected valid date (e.g. YYYY-MM-DD)`, 400);
            }

            let targetEmployeeId = userEmployeeId;
            if (role === 'ADMIN' && employee_id) {
                targetEmployeeId = employee_id;
            }

            if (!targetEmployeeId) {
                return errorResponse(res, 'User profile is not linked to an employee record', 400);
            }

            const submitted = await timesheetsService.submitTimesheet(organizationId, targetEmployeeId, week_start);
            return successResponse(res, submitted, 'Timesheet submitted for approval successfully');
        } catch (error) {
            const status = error.statusCode || (error.message.includes('already approved') ? 409 : 400);
            if (error.code) {
                return res.status(status).json({
                    success: false,
                    message: error.message,
                    code: error.code
                });
            }
            return errorResponse(res, error.message, status);
        }
    },

    /**
     * Get Manager/Admin Approval Queue
     */
    getApprovalQueue: async (req, res) => {
        try {
            const organizationId = await getOrganizationId(req);
            const { role } = req.user;

            if (role !== 'ADMIN' && role !== 'MANAGER') {
                return errorResponse(res, 'Access denied: Admin or Manager permission required', 403);
            }

            const queue = await timesheetsService.getApprovalQueue(organizationId, req.user);
            return successResponse(res, queue, 'Approval queue fetched successfully');
        } catch (error) {
            return errorResponse(res, error.message, 500);
        }
    },

    /**
     * Approve single timesheet
     */
    approve: async (req, res) => {
        try {
            const organizationId = await getOrganizationId(req);
            const { role } = req.user;

            if (role !== 'ADMIN' && role !== 'MANAGER') {
                return errorResponse(res, 'Access denied: Admin or Manager permission required', 403);
            }

            const timesheetId = req.params.id;
            const comment = req.body?.comment || 'Approved';
            const result = await timesheetsService.decideTimesheet(organizationId, timesheetId, req.user, 'APPROVED', comment);
            return successResponse(res, result, 'Timesheet approved successfully');
        } catch (error) {
            const status = error.message.includes('Access denied') ? 403 : 400;
            return errorResponse(res, error.message, status);
        }
    },

    /**
     * Reject single timesheet with mandatory comment
     */
    reject: async (req, res) => {
        try {
            const organizationId = await getOrganizationId(req);
            const { role } = req.user;

            if (role !== 'ADMIN' && role !== 'MANAGER') {
                return errorResponse(res, 'Access denied: Admin or Manager permission required', 403);
            }

            const timesheetId = req.params.id;
            const comment = req.body?.comment;

            if (!comment || !String(comment).trim()) {
                return errorResponse(res, 'A rejection comment is required when rejecting a timesheet', 400);
            }

            const result = await timesheetsService.decideTimesheet(organizationId, timesheetId, req.user, 'REJECTED', comment);
            return successResponse(res, result, 'Timesheet rejected successfully');
        } catch (error) {
            const status = error.message.includes('Access denied') ? 403 : 400;
            return errorResponse(res, error.message, status);
        }
    },

    /**
     * Bulk approve timesheets
     */
    bulkApprove: async (req, res) => {
        try {
            const organizationId = await getOrganizationId(req);
            const { role } = req.user;

            if (role !== 'ADMIN' && role !== 'MANAGER') {
                return errorResponse(res, 'Access denied: Admin or Manager permission required', 403);
            }

            const ids = req.body?.ids || [];
            if (!Array.isArray(ids) || ids.length === 0) {
                return errorResponse(res, 'Array of timesheet IDs is required', 400);
            }

            const result = await timesheetsService.bulkApprove(organizationId, ids, req.user);
            return successResponse(res, result, `${result.approvedCount} timesheet(s) approved successfully`);
        } catch (error) {
            return errorResponse(res, error.message, 400);
        }
    },

    /**
     * Export payroll CSV
     */
    exportPayrollCsv: async (req, res) => {
        try {
            const organizationId = await getOrganizationId(req);
            const { role } = req.user;

            if (role !== 'ADMIN' && role !== 'MANAGER') {
                return errorResponse(res, 'Access denied: Admin or Manager permission required', 403);
            }

            const rawWeekStart = req.query.week_start;
            if (rawWeekStart && !isValidDate(rawWeekStart)) {
                return errorResponse(res, `Invalid week_start date format: "${rawWeekStart}". Expected valid date (e.g. YYYY-MM-DD)`, 400);
            }

            const options = {
                teamId: req.query.team_id,
                overtimeThreshold: req.query.overtime_threshold,
                overtimeMultiplier: req.query.overtime_multiplier
            };

            const { csvContent, weekStart } = await timesheetsService.exportPayrollCsv(
                organizationId,
                rawWeekStart,
                req.user,
                options
            );

            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', `attachment; filename="payroll-${weekStart}.csv"`);
            return res.status(200).send(csvContent);
        } catch (error) {
            const status = error.statusCode || (error.message?.includes('Invalid date') ? 400 : 500);
            return errorResponse(res, error.message, status);
        }
    },

    /**
     * Reopen an approved/rejected timesheet (Admin or Manager with reason)
     */
    reopen: async (req, res) => {
        try {
            const organizationId = await getOrganizationId(req);
            const timesheetId = req.params.id;
            const { reason } = req.body || {};

            if (!reason || !String(reason).trim()) {
                return errorResponse(res, 'A reason is required to reopen a timesheet', 400);
            }

            const result = await timesheetsService.reopenTimesheet(organizationId, timesheetId, req.user, reason);
            return successResponse(res, result, 'Timesheet reopened successfully');
        } catch (error) {
            const status = error.statusCode || (error.message.includes('Access denied') ? 403 : 400);
            return errorResponse(res, error.message, status);
        }
    }
};

module.exports = timesheetsController;
