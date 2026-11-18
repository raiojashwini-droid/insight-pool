const { getOrganizationId } = require('../../utils/orgId');
const projectsService = require('./projects.service');
const prisma = require('../../config/db');
const { successResponse, errorResponse } = require('../../utils/response');

class ProjectsController {
    async createProject(req, res, next) {
        try {
            const organizationId = await getOrganizationId(req);

            if (!organizationId) {
                return errorResponse(res, 'Organization ID is required', 400);
            }

            const project = await projectsService.createProject(req.body, organizationId);
            return successResponse(res, project, 'Project created successfully', 201);
        } catch (error) {
            next(error);
        }
    }

    async getProjects(req, res, next) {
        try {
            const organizationId = await getOrganizationId(req);
            let { role, employeeId, userId, email } = req.user || {};
            const queryEmployeeId = req.query.employeeId;

            let effectiveEmployeeId = (queryEmployeeId && queryEmployeeId !== 'null' && queryEmployeeId !== 'undefined')
                ? queryEmployeeId
                : employeeId;

            const isEmployeeRole = String(role).toUpperCase() === 'EMPLOYEE';

            if (!effectiveEmployeeId && isEmployeeRole) {
                if (userId) {
                    const u = await prisma.user.findUnique({
                        where: { id: userId },
                        select: { employeeId: true }
                    });
                    effectiveEmployeeId = u?.employeeId;
                }
                if (!effectiveEmployeeId && email) {
                    const emp = await prisma.employee.findFirst({
                        where: { email },
                        select: { id: true }
                    });
                    effectiveEmployeeId = emp?.id;
                }
            }

            let filter = {};
            if (isEmployeeRole || (queryEmployeeId && queryEmployeeId !== 'null')) {
                filter.employeeId = effectiveEmployeeId;
            }

            console.log(`[ProjectsController.getProjects] userRole: ${role}, effectiveEmployeeId: ${effectiveEmployeeId}, org: ${organizationId}`);

            const projects = await projectsService.getProjects(organizationId, filter);
            return successResponse(res, projects, 'Projects fetched successfully');
        } catch (error) {
            next(error);
        }
    }

    async assignEmployees(req, res, next) {
        try {
            const { projectId, employeeIds } = req.body;
            const result = await projectsService.assignEmployees(projectId, employeeIds);
            return successResponse(res, result, 'Employees assigned successfully');
        } catch (error) {
            next(error);
        }
    }

    async logTime(req, res, next) {
        try {
            const log = await projectsService.logTime(req.body);
            return successResponse(res, log, 'Time logged successfully', 201);
        } catch (error) {
            next(error);
        }
    }

    async updateProject(req, res, next) {
        try {
            const { id } = req.params;
            const project = await projectsService.updateProject(id, req.body);
            return successResponse(res, project, 'Project updated successfully');
        } catch (error) {
            next(error);
        }
    }

    async deleteProject(req, res, next) {
        try {
            const { id } = req.params;
            await projectsService.deleteProject(id);
            return successResponse(res, null, 'Project deleted successfully');
        } catch (error) {
            next(error);
        }
    }
}

module.exports = new ProjectsController();
