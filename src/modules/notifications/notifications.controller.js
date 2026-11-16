const notificationsService = require('./notifications.service');
const { getOrganizationId } = require('../../utils/orgId');

const notificationsController = {
    getNotifications: async (req, res) => {
        try {
            const organizationId = await getOrganizationId(req);
            const { unreadOnly, type, limit, offset } = req.query;
            const data = await notificationsService.getNotifications(organizationId, {
                unreadOnly,
                type,
                limit,
                offset,
                role: req.user?.role,
                userId: req.user?.userId || req.user?.id,
                employeeId: req.user?.employeeId
            });
            res.json(data);
        } catch (error) {
            res.status(500).json({ message: error.message });
        }
    },

    markAsRead: async (req, res) => {
        try {
            const organizationId = await getOrganizationId(req);
            await notificationsService.markNotificationAsRead(req.params.id, organizationId, {
                role: req.user?.role,
                userId: req.user?.userId || req.user?.id,
                employeeId: req.user?.employeeId
            });
            res.json({ success: true, message: 'Notification marked as read' });
        } catch (error) {
            res.status(500).json({ message: error.message });
        }
    },

    markAllAsRead: async (req, res) => {
        try {
            const organizationId = await getOrganizationId(req);
            const result = await notificationsService.markAllNotificationsAsRead(organizationId, {
                role: req.user?.role,
                userId: req.user?.userId || req.user?.id,
                employeeId: req.user?.employeeId
            });
            res.json({ success: true, message: 'All notifications marked as read', count: result.count });
        } catch (error) {
            res.status(500).json({ message: error.message });
        }
    },

    deleteNotification: async (req, res) => {
        try {
            const organizationId = await getOrganizationId(req);
            await notificationsService.deleteNotification(req.params.id, organizationId, {
                role: req.user?.role,
                userId: req.user?.userId || req.user?.id,
                employeeId: req.user?.employeeId
            });
            res.json({ success: true, message: 'Notification deleted' });
        } catch (error) {
            res.status(500).json({ message: error.message });
        }
    },

    deleteAllNotifications: async (req, res) => {
        try {
            const organizationId = await getOrganizationId(req);
            const result = await notificationsService.deleteAllNotifications(organizationId, {
                role: req.user?.role,
                userId: req.user?.userId || req.user?.id,
                employeeId: req.user?.employeeId
            });
            res.json({ success: true, message: 'All notifications deleted', count: result.count });
        } catch (error) {
            res.status(500).json({ message: error.message });
        }
    }
};

module.exports = notificationsController;
