const cloudPayrollService = require('./cloudPayroll.service');
const { successResponse, errorResponse } = require('../../utils/response');

const cloudPayrollController = {
    getAllStatus: async (req, res) => {
        try {
            const organizationId = req.user?.organizationId || req.organizationId || 'default-org-id';
            const data = await cloudPayrollService.getAllStatus(organizationId);
            return successResponse(res, data, 'Cloud payroll integrations status fetched');
        } catch (err) {
            return errorResponse(res, err.message, 500);
        }
    },

    getProviderStatus: async (req, res) => {
        try {
            const organizationId = req.user?.organizationId || req.organizationId || 'default-org-id';
            const { provider } = req.params;
            const data = await cloudPayrollService.getProviderConfig(organizationId, provider);
            return successResponse(res, data, `${provider} status fetched`);
        } catch (err) {
            return errorResponse(res, err.message, 500);
        }
    },

    saveConfig: async (req, res) => {
        try {
            const organizationId = req.user?.organizationId || req.organizationId || 'default-org-id';
            const { provider } = req.params;
            const credentials = req.body;
            const result = await cloudPayrollService.saveProviderConfig(organizationId, provider, credentials);
            return successResponse(res, result, result.message);
        } catch (err) {
            return errorResponse(res, err.message, 500);
        }
    },

    testConnection: async (req, res) => {
        try {
            const organizationId = req.user?.organizationId || req.organizationId || 'default-org-id';
            const { provider } = req.params;
            const result = await cloudPayrollService.testConnection(organizationId, provider);
            return successResponse(res, result, `Connected to ${provider.toUpperCase()} successfully!`);
        } catch (err) {
            return errorResponse(res, err.message, 400);
        }
    },

    syncPayroll: async (req, res) => {
        try {
            const organizationId = req.user?.organizationId || req.organizationId || 'default-org-id';
            const { provider } = req.params;
            const result = await cloudPayrollService.syncPayroll(organizationId, provider);
            return successResponse(res, result.data, result.message);
        } catch (err) {
            return errorResponse(res, err.message, 400);
        }
    }
};

module.exports = cloudPayrollController;
