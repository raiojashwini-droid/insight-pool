const tasksService = require('./tasks.service');
const { successResponse, errorResponse } = require('../../utils/response');
const { getOrganizationId } = require('../../utils/orgId');

class TasksController {
    async createTask(req, res) {
        try {
            const organizationId = await getOrganizationId(req);
            const task = await tasksService.createTask(req.body, organizationId);
            return successResponse(res, task, 'Task created successfully', 201);
        } catch (error) {
            return errorResponse(res, error.message);
        }
    }

    async getTasks(req, res) {
        try {
            const organizationId = await getOrganizationId(req);
            let { role, employeeId, userId } = req.user;
            const queryEmployeeId = req.query.employeeId;
            
            // Priority 1: Query param override (requested by user)
            // Priority 2: Token employeeId
            // Priority 3: Database lookup via userId
            let effectiveEmployeeId = (queryEmployeeId && queryEmployeeId !== 'null' && queryEmployeeId !== 'undefined') ? queryEmployeeId : employeeId;

            if (!effectiveEmployeeId && role === 'EMPLOYEE') {
                const user = await require('../../config/db').user.findUnique({
                    where: { id: userId },
                    select: { employeeId: true }
                });
                effectiveEmployeeId = user?.employeeId;
            }

            console.log(`[TasksController] Role: ${role}, Org: ${organizationId}, Resolved Emp: ${effectiveEmployeeId}`);

            let filter = {};
            if (role === 'EMPLOYEE' || (queryEmployeeId && queryEmployeeId !== 'null')) {
                filter.employeeId = effectiveEmployeeId;
            }

            const tasks = await tasksService.getTasks(organizationId, filter);
            return successResponse(res, tasks, 'Tasks retrieved successfully');
        } catch (error) {
            return errorResponse(res, error.message);
        }
    }

    async getBoardTasks(req, res) {
        try {
            const organizationId = await getOrganizationId(req);
            let { role, employeeId, userId } = req.user;
            const queryEmployeeId = req.query.employeeId;
            
            let effectiveEmployeeId = (queryEmployeeId && queryEmployeeId !== 'null' && queryEmployeeId !== 'undefined') ? queryEmployeeId : employeeId;

            if (!effectiveEmployeeId && role === 'EMPLOYEE') {
                const user = await require('../../config/db').user.findUnique({
                    where: { id: userId },
                    select: { employeeId: true }
                });
                effectiveEmployeeId = user?.employeeId;
            }
            
            let filter = {};
            if (role === 'EMPLOYEE' || (queryEmployeeId && queryEmployeeId !== 'null')) {
                filter.employeeId = effectiveEmployeeId;
            }

            const board = await tasksService.getBoardTasks(organizationId, filter);
            return successResponse(res, board, 'Board tasks retrieved successfully');
        } catch (error) {
            return errorResponse(res, error.message);
        }
    }

    async updateTask(req, res) {
        try {
            const { id } = req.params;
            const task = await tasksService.updateTask(id, req.body);
            return successResponse(res, task, 'Task updated successfully');
        } catch (error) {
            return errorResponse(res, error.message);
        }
    }

    async updateTaskStatus(req, res) {
        try {
            const { id } = req.params;
            const { status } = req.body;
            const task = await tasksService.updateTaskStatus(id, status);
            return successResponse(res, task, 'Task status updated successfully');
        } catch (error) {
            return errorResponse(res, error.message);
        }
    }

    async deleteTask(req, res) {
        try {
            if (req.user.role !== 'ADMIN' && req.user.role !== 'MANAGER') {
                return res.status(403).json({ success: false, message: "Only admins and managers can delete tasks" });
            }
            const { id } = req.params;
            await tasksService.deleteTask(id);
            return successResponse(res, null, 'Task deleted successfully');
        } catch (error) {
            return errorResponse(res, error.message, error.statusCode || 500);
        }
    }

    async startTimer(req, res) {
        try {
            const organizationId = await getOrganizationId(req);
            const taskId = req.params.id || req.body.taskId;
            if (!taskId) {
                return errorResponse(res, 'Task ID is required', 400);
            }

            let effectiveEmployeeId = req.user.employeeId;
            if (!effectiveEmployeeId && req.user.userId) {
                const user = await require('../../config/db').user.findUnique({
                    where: { id: req.user.userId },
                    select: { employeeId: true }
                });
                effectiveEmployeeId = user?.employeeId;
            }

            if (!effectiveEmployeeId) {
                return errorResponse(res, 'Employee profile required to start task timer', 400);
            }

            const source = req.body.source || 'WEB';
            const timer = await tasksService.startTimer(
                taskId,
                effectiveEmployeeId,
                organizationId,
                source,
                req.user.role
            );
            return successResponse(res, timer, 'Task timer started successfully', 201);
        } catch (error) {
            if (error.code === 'ACCOUNT_DEACTIVATED') {
                return res.status(403).json({
                    success: false,
                    code: 'ACCOUNT_DEACTIVATED',
                    message: error.message
                });
            }
            return errorResponse(res, error.message, error.statusCode || 500);
        }
    }

    async stopTimer(req, res) {
        try {
            const organizationId = await getOrganizationId(req);
            const taskId = req.params.id || req.body.taskId;

            let effectiveEmployeeId = req.user.employeeId;
            if (!effectiveEmployeeId && req.user.userId) {
                const user = await require('../../config/db').user.findUnique({
                    where: { id: req.user.userId },
                    select: { employeeId: true }
                });
                effectiveEmployeeId = user?.employeeId;
            }

            if (!effectiveEmployeeId) {
                return errorResponse(res, 'Employee profile required to stop task timer', 400);
            }

            const timer = await tasksService.stopTimer(taskId, effectiveEmployeeId, organizationId);
            return successResponse(res, timer, 'Task timer stopped successfully');
        } catch (error) {
            return errorResponse(res, error.message, error.statusCode || 500);
        }
    }

    async getActiveTimer(req, res) {
        try {
            const organizationId = await getOrganizationId(req);
            let effectiveEmployeeId = req.user.employeeId;
            if (!effectiveEmployeeId && req.user.userId) {
                const user = await require('../../config/db').user.findUnique({
                    where: { id: req.user.userId },
                    select: { employeeId: true }
                });
                effectiveEmployeeId = user?.employeeId;
            }

            // Allow manager/admin to view active timer of a specific employee via query
            if (req.query.employeeId && (req.user.role === 'ADMIN' || req.user.role === 'MANAGER')) {
                effectiveEmployeeId = req.query.employeeId;
            }

            if (!effectiveEmployeeId) {
                return errorResponse(res, 'Employee profile required to query task timer', 400);
            }

            const session = await tasksService.getActiveTimer(effectiveEmployeeId, organizationId);
            return successResponse(res, session, 'Active timer session retrieved');
        } catch (error) {
            return errorResponse(res, error.message, error.statusCode || 500);
        }
    }

    async getTaskTimeLogs(req, res) {
        try {
            const organizationId = await getOrganizationId(req);
            const { id } = req.params;
            const data = await tasksService.getTaskTimeLogs(id, organizationId);
            return successResponse(res, data, 'Task time logs retrieved successfully');
        } catch (error) {
            return errorResponse(res, error.message, error.statusCode || 500);
        }
    }

    async getCycleTimeAnalytics(req, res) {
        try {
            const organizationId = await getOrganizationId(req);
            const { projectId, employeeId, status, startDate, endDate } = req.query;
            const filter = {};
            if (projectId) filter.projectId = projectId;
            if (employeeId) filter.employeeId = employeeId;
            if (status) filter.status = status;
            if (startDate) filter.startDate = startDate;
            if (endDate) filter.endDate = endDate;

            const analytics = await tasksService.getCycleTimeAnalytics(organizationId, filter);
            return successResponse(res, analytics, 'Cycle time and bottleneck analytics retrieved successfully');
        } catch (error) {
            console.error('Cycle time analytics error:', error);
            return errorResponse(res, error.message);
        }
    }
}

module.exports = new TasksController();
