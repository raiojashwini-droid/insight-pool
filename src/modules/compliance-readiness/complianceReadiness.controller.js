const complianceReadinessService = require('./complianceReadiness.service');
const { successResponse, errorResponse } = require('../../utils/response');

class ComplianceReadinessController {
    /**
     * GET /api/compliance-readiness/assessment
     * Returns live technical controls assessment for SOC 2 and ISO 27001
     */
    async getAssessment(req, res) {
        try {
            const orgId = req.user?.organizationId || req.query.organizationId || null;
            const data = await complianceReadinessService.getComplianceAssessment(orgId);
            return successResponse(res, data, 'Compliance assessment retrieved successfully', 200);
        } catch (error) {
            console.error('Compliance Readiness Assessment Error:', error);
            return errorResponse(res, error.message || 'Failed to retrieve compliance assessment', 500);
        }
    }

    /**
     * GET /api/compliance-readiness/evidence-package
     * Generates downloadable JSON evidence package
     */
    async downloadEvidencePackage(req, res) {
        try {
            const orgId = req.user?.organizationId || req.query.organizationId || null;
            const packageData = await complianceReadinessService.generateEvidencePackage(orgId);
            return successResponse(res, packageData, 'Evidence package generated successfully', 200);
        } catch (error) {
            console.error('Compliance Evidence Package Error:', error);
            return errorResponse(res, error.message || 'Failed to generate evidence package', 500);
        }
    }
}

module.exports = new ComplianceReadinessController();
