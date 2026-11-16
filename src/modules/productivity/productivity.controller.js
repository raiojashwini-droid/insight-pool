const productivityService = require('./productivity.service');
const { successResponse, errorResponse } = require('../../utils/response');
const { getOrganizationId } = require('../../utils/orgId');

const productivityController = {
    getApps: async (req, res) => {
        try {
            const organizationId = await getOrganizationId(req);
            const { startDate, endDate, productivity, teamId } = req.query;
            let data = await productivityService.getAppsUsage(organizationId, startDate, endDate, teamId || null);
            if (productivity) {
                data = data.filter(a => a.productivity === productivity.toUpperCase());
            }
            return successResponse(res, data, 'App usage fetched successfully');
        } catch (error) {
            return errorResponse(res, error.message);
        }
    },

    // ── Tags ────────────────────────────────────────────────────────
    getTags: async (req, res) => {
        try {
            const organizationId = await getOrganizationId(req);
            const tags = await productivityService.getTags(organizationId);
            return successResponse(res, tags, 'Tags fetched successfully');
        } catch (error) {
            return errorResponse(res, error.message);
        }
    },

    createTag: async (req, res) => {
        try {
            const organizationId = await getOrganizationId(req);
            const tag = await productivityService.createTag(organizationId, req.body);
            return successResponse(res, tag, 'Tag created successfully');
        } catch (error) {
            return errorResponse(res, error.message);
        }
    },

    updateTag: async (req, res) => {
        try {
            const { id } = req.params;
            const tag = await productivityService.updateTag(id, req.body);
            return successResponse(res, tag, 'Tag updated successfully');
        } catch (error) {
            return errorResponse(res, error.message);
        }
    },

    deleteTag: async (req, res) => {
        try {
            const { id } = req.params;
            await productivityService.deleteTag(id);
            return successResponse(res, null, 'Tag deleted successfully');
        } catch (error) {
            return errorResponse(res, error.message);
        }
    },

    // ── Rules ────────────────────────────────────────────────────────
    getRules: async (req, res) => {
        try {
            const organizationId = await getOrganizationId(req);
            const { teamId } = req.query;
            const rules = await productivityService.getRules(organizationId, teamId || null);
            return successResponse(res, rules, 'Rules fetched successfully');
        } catch (error) {
            return errorResponse(res, error.message);
        }
    },

    updateRule: async (req, res) => {
        try {
            const organizationId = await getOrganizationId(req);
            const rule = await productivityService.upsertRule(organizationId, req.body);
            return successResponse(res, rule, 'Rule updated successfully');
        } catch (error) {
            return errorResponse(res, error.message);
        }
    },

    autoLabel: async (req, res) => {
        try {
            const organizationId = await getOrganizationId(req);
            const result = await productivityService.autoLabelApps(organizationId);
            return successResponse(res, result, 'Auto-labeling completed');
        } catch (error) {
            return errorResponse(res, error.message);
        }
    },
};

module.exports = productivityController;
