const timesheetsService = require('./timesheets.service');
const { successResponse, errorResponse } = require('../../utils/response');
const { getOrganizationId } = require('../../utils/orgId');

const timesheetsController = {
    /**
     * Get weekly timesheet(s)
     */
    getWeek: async (req, res) => {
        try {
            const organizationId = await getOrganizationId(req);
            const { role, employeeId } = req.user;
            const weekStart = req.query.week_start;

            if (role === 'EMPLOYEE') {
                if (!employeeId) {
                    return errorResponse(res, 'User profile is not linked to an employee record', 400);
                }
                const timesheet = await timesheetsService.getWeeklyTimesheet(organizationId, employeeId, weekStart);
                return successResponse(res, timesheet, 'Weekly timesheet fetched successfully');
            }

            // Manager or Admin
            if (req.query.employee_id) {
                const timesheet = await timesheetsService.getWeeklyTimesheet(organizationId, req.query.employee_id, weekStart);
                return successResponse(res, timesheet, 'Weekly timesheet fetched successfully');
            }

            const allTimesheets = await timesheetsService.getWeeklyTimesheetsAll(
                organizationId,
                weekStart,
                { teamId: req.query.team_id },
                req.user
            );
            return successResponse(res, allTimesheets, 'Weekly timesheets fetched successfully');
        } catch (error) {
            return errorResponse(res, error.message, 500);
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
            const status = error.message.includes('already approved') ? 409 : 400;
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

            const { csvContent, weekStart } = await timesheetsService.exportPayrollCsv(
                organizationId,
                req.query.week_start,
                req.user
            );

            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', `attachment; filename="payroll-${weekStart}.csv"`);
            return res.status(200).send(csvContent);
        } catch (error) {
            return errorResponse(res, error.message, 500);
        }
    }
};

module.exports = timesheetsController;
