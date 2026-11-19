const activityService = require('./activity.service');
const { successResponse, errorResponse } = require('../../utils/response');
const { getOrganizationId } = require('../../utils/orgId');

const activityController = {
    createActivityLog: async (req, res) => {
        try {
            const { employeeId, activityType, duration, productivity, timestamp, appWebsite } = req.body;
            const organizationId = await getOrganizationId(req); // From auth middleware

            const log = await activityService.createActivityLog({
                employeeId,
                organizationId,
                activityType,
                duration,
                productivity,
                timestamp,
                appWebsite
            });

            return successResponse(res, log, 'Activity log created successfully');
        } catch (error) {
            console.error('Error creating activity log:', error);
            return errorResponse(res, error.message);
        }
    },

    getEmployeeActivity: async (req, res) => {
        try {
            const { employeeId } = req.params;
            const { startDate, endDate } = req.query;
            const { role, employeeId: currentEmployeeId } = req.user;

            // RBAC Filtering
            if (role === 'EMPLOYEE' && employeeId !== currentEmployeeId) {
                console.warn(`[ActivityController] Access denied for employee ${currentEmployeeId} trying to view ${employeeId}`);
                return errorResponse(res, 'Access denied: You can only view your own activity', 403);
            }

            if (role === 'MANAGER') {
                const targetEmp = await require('../../config/db').employee.findUnique({
                    where: { id: employeeId },
                    select: { role: true }
                });
                if (targetEmp?.role === 'ADMIN') {
                    return errorResponse(res, 'Access denied: You cannot view admin activity', 403);
                }
            }

            const logs = await activityService.getEmployeeActivity(employeeId, startDate, endDate);
            return successResponse(res, logs, 'Employee activity fetched successfully');
        } catch (error) {
            return errorResponse(res, error.message);
        }
    },

    getTeamActivity: async (req, res) => {
        try {
            const { teamId } = req.params;
            const { startDate, endDate } = req.query;
            const { role, employeeId: currentEmployeeId } = req.user;

            // RBAC Filtering
            if (role === 'EMPLOYEE') {
                return errorResponse(res, 'Access denied: Employees cannot view team activity', 403);
            }

            // Manager and Admin can view any team activity

            const logs = await activityService.getTeamActivity(teamId, startDate, endDate);
            return successResponse(res, logs, 'Team activity fetched successfully');
        } catch (error) {
            return errorResponse(res, error.message);
        }
    },

    getOrganizationActivity: async (req, res) => {
        try {
            const organizationId = await getOrganizationId(req);
            const { startDate, endDate } = req.query;
            const { role } = req.user;

            // RBAC Filtering
            if (role !== 'ADMIN' && role !== 'MANAGER') {
                return errorResponse(res, 'Access denied: Admin or Manager access required', 403);
            }

            const logs = await activityService.getOrganizationActivity(organizationId, startDate, endDate);
            return successResponse(res, logs, 'Organization activity fetched successfully');
        } catch (error) {
            return errorResponse(res, error.message);
        }
    },

    getOrganizationSummary: async (req, res) => {
        try {
            const organizationId = await getOrganizationId(req);
            const { startDate, endDate, teamId, employeeId } = req.query;

            if (!organizationId) {
                console.warn('[ActivityController] Missing organizationId in request user');
                // Return empty summary instead of 500
                return successResponse(res, [], 'No organization activity found');
            }

            const targetEmployeeId = req.user.role === 'EMPLOYEE' ? (req.user.employeeId || employeeId) : employeeId;
            const summary = await activityService.getOrganizationSummary(organizationId, startDate, endDate, { teamId, employeeId: targetEmployeeId });
            return successResponse(res, summary, 'Organization summary fetched successfully');
        } catch (error) {
            console.error('[ActivityController] Summary Error:', error);
            return errorResponse(res, error.message);
        }
    },
    getEmployeeSummary: async (req, res) => {
        try {
            const { employeeId } = req.params;
            const { startDate, endDate } = req.query;
            const { role, employeeId: currentEmployeeId } = req.user;

            // RBAC Filtering - Security Enhancement
            if (role === 'EMPLOYEE' && employeeId !== currentEmployeeId) {
                console.warn(`[ActivityController] Summary access denied for employee ${currentEmployeeId} trying to view ${employeeId}`);
                return errorResponse(res, 'Access denied: You can only view your own summary', 403);
            }

            if (role === 'MANAGER') {
                const targetEmp = await require('../../config/db').employee.findUnique({
                    where: { id: employeeId },
                    select: { role: true }
                });
                if (targetEmp?.role === 'ADMIN') {
                    return errorResponse(res, 'Access denied: You cannot view admin summary', 403);
                }
            }

            const summary = await activityService.getEmployeeSummary(employeeId, startDate, endDate);
            return successResponse(res, summary, 'Employee summary fetched successfully');
        } catch (error) {
            return errorResponse(res, error.message);
        }
    },
    getTeamSummary: async (req, res) => {
        try {
            const { teamId } = req.params;
            const { startDate, endDate } = req.query;

            const summary = await activityService.getTeamSummary(teamId, startDate, endDate);
            return successResponse(res, summary, 'Team summary fetched successfully');
        } catch (error) {
            return errorResponse(res, error.message);
        }
    },

    getTimelineReport: async (req, res) => {
        try {
            const organizationId = await getOrganizationId(req);
            const { date, employeeId, teamId } = req.query;
            const { role, employeeId: currentEmployeeId } = req.user;

            const targetEmployeeId = role === 'EMPLOYEE' ? currentEmployeeId : employeeId;

            const report = await activityService.getTimelineReport(
                organizationId,
                date,
                targetEmployeeId,
                teamId,
                req.user
            );
            return successResponse(res, report, 'Activities timeline report fetched successfully');
        } catch (error) {
            console.error('[ActivityController] Timeline Error:', error);
            return errorResponse(res, error.message);
        }
    },
};

module.exports = activityController;
