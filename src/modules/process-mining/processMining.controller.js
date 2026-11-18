const processMiningService = require('./processMining.service');
const { successResponse, errorResponse } = require('../../utils/response');

class ProcessMiningController {
    /**
     * GET /api/process-mining/discovery
     * Returns discovered process graph, PCE, variants, and bottlenecks
     */
    async getProcessDiscovery(req, res) {
        try {
            const orgId = req.user?.organizationId || req.query.organizationId || null;
            const data = await processMiningService.discoverProcess(orgId, req.query);
            return successResponse(res, data, 'Process model discovered successfully', 200);
        } catch (error) {
            console.error('Process Mining Error:', error);
            return errorResponse(res, error.message || 'Failed to discover process model', 500);
        }
    }

    /**
     * GET /api/process-mining/export
     * Returns complete export of mined process data
     */
    async exportProcessReport(req, res) {
        try {
            const orgId = req.user?.organizationId || req.query.organizationId || null;
            const report = await processMiningService.exportProcessReport(orgId);
            return successResponse(res, report, 'Process report exported successfully', 200);
        } catch (error) {
            console.error('Process Mining Export Error:', error);
            return errorResponse(res, error.message || 'Failed to export process report', 500);
        }
    }
}

module.exports = new ProcessMiningController();
