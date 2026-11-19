const complianceService = require('./compliance.service');
const { successResponse, errorResponse } = require('../../utils/response');
const { getOrganizationId } = require('../../utils/orgId');

class ComplianceController {
    async getSettings(req, res) {
        try {
            const organizationId = await getOrganizationId(req);
            const settings = await complianceService.getSettings(organizationId);
            return successResponse(res, settings, 'Compliance settings retrieved successfully');
        } catch (error) {
            return errorResponse(res, error.message);
        }
    }

    async updateSettings(req, res) {
        try {
            const organizationId = await getOrganizationId(req);
            const userId = req.user.employeeId; // Correctly using employeeId for AuditLog
            const ipAddress = req.ip || req.connection.remoteAddress;
            const settings = await complianceService.updateSettings(organizationId, userId, req.body, ipAddress);
            return successResponse(res, settings, 'Compliance settings updated successfully');
        } catch (error) {
            return errorResponse(res, error.message);
        }
    }

    async getAuditLogs(req, res) {
        try {
            const organizationId = await getOrganizationId(req);
            const { search } = req.query;
            const logs = await complianceService.getAuditLogs(organizationId, search);
            
            // Format logs to match frontend expectations
            const formattedLogs = logs.map(log => {
                let parsedMetadata = {};
                if (typeof log.metadata === 'string') {
                    try { parsedMetadata = JSON.parse(log.metadata); } catch (e) { parsedMetadata = {}; }
                } else if (log.metadata && typeof log.metadata === 'object') {
                    parsedMetadata = log.metadata;
                }

                const displayName = log.user?.fullName || log.user?.email || 'System Administrator';

                return {
                    id: log.id,
                    action: log.action,
                    user: displayName,
                    userName: displayName,
                    time: log.createdAt,
                    createdAt: log.createdAt,
                    dateTime: log.createdAt,
                    status: log.status,
                    ipAddress: log.ipAddress || '127.0.0.1',
                    metadata: parsedMetadata,
                    userRole: parsedMetadata?.userRole || 'Admin'
                };
            });

            return successResponse(res, formattedLogs, 'Audit logs retrieved successfully');
        } catch (error) {
            return errorResponse(res, error.message);
        }
    }
}

module.exports = new ComplianceController();
