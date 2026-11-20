const alertsService = require('./alerts.service');
const { getOrganizationId } = require('../../utils/orgId');

const alertsController = {
    getAlertRules: async (req, res) => {
        try {
            const { type } = req.query;
            const organizationId = await getOrganizationId(req);
            const rules = await alertsService.getAlertRules(organizationId, type);
            res.json(rules);
        } catch (error) {
            res.status(500).json({ message: error.message });
        }
    },

    createAlertRule: async (req, res) => {
        try {
            const organizationId = await getOrganizationId(req);
            const { name, type, trigger, scope } = req.body;
            const rule = await alertsService.createAlertRule({
                name: (name || '').trim() || 'Untitled Alert Rule',
                type: (type || 'activity').toLowerCase(),
                trigger: trigger || type || 'Activity Level',
                scope: scope || 'All Employees',
                organizationId
            });
            res.status(201).json(rule);
        } catch (error) {
            console.error('[AlertsController] createAlertRule error:', error);
            res.status(400).json({ message: error.message });
        }
    },

    updateAlertRule: async (req, res) => {
        try {
            const rule = await alertsService.updateAlertRule(req.params.id, req.body);
            res.json(rule);
        } catch (error) {
            res.status(400).json({ message: error.message });
        }
    },

    deleteAlertRule: async (req, res) => {
        try {
            await alertsService.deleteAlertRule(req.params.id);
            res.json({ message: 'Alert rule deleted' });
        } catch (error) {
            res.status(500).json({ message: error.message });
        }
    },

    getSettings: async (req, res) => {
        try {
            const organizationId = await getOrganizationId(req);
            const settings = await alertsService.getAlertSettings(organizationId);
            res.json(settings);
        } catch (error) {
            res.status(500).json({ message: error.message });
        }
    },

    updateSettings: async (req, res) => {
        try {
            const organizationId = await getOrganizationId(req);
            const settings = await alertsService.updateAlertSettings(organizationId, req.body);
            res.json(settings);
        } catch (error) {
            res.status(400).json({ message: error.message });
        }
    },

    // ─── PERSISTENT ALERT HISTORY ──────────────────────────────────────
    getAlertHistory: async (req, res) => {
        try {
            const organizationId = await getOrganizationId(req);
            const { severity, ruleType, limit, offset } = req.query;
            const result = await alertsService.getAlertHistory(organizationId, {
                severity,
                ruleType,
                limit,
                offset
            });
            res.json(result);
        } catch (error) {
            res.status(500).json({ message: error.message });
        }
    },

    dismissAlert: async (req, res) => {
        try {
            const organizationId = await getOrganizationId(req);
            const updated = await alertsService.dismissAlert(req.params.id, organizationId);
            res.json(updated);
        } catch (error) {
            res.status(500).json({ message: error.message });
        }
    },

    dismissAllAlerts: async (req, res) => {
        try {
            const organizationId = await getOrganizationId(req);
            const result = await alertsService.dismissAllAlerts(organizationId);
            res.json({ message: 'All alerts marked as read', count: result.count });
        } catch (error) {
            res.status(500).json({ message: error.message });
        }
    },

    deleteAlert: async (req, res) => {
        try {
            const organizationId = await getOrganizationId(req);
            const result = await alertsService.deleteAlert(req.params.id, organizationId);
            res.json({ success: true, count: result.count });
        } catch (error) {
            res.status(500).json({ message: error.message });
        }
    },

    deleteAllAlerts: async (req, res) => {
        try {
            const organizationId = await getOrganizationId(req);
            const result = await alertsService.deleteAllAlerts(organizationId);
            res.json({ success: true, count: result.count });
        } catch (error) {
            res.status(500).json({ message: error.message });
        }
    }
};

module.exports = alertsController;
