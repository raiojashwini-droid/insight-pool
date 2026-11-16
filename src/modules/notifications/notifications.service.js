const prisma = require('../../config/db');

const notificationsService = {
    getNotifications: async (organizationId, { unreadOnly = false, type, limit = 50, offset = 0, role = 'ADMIN', userId, employeeId } = {}) => {
        const isManager = role === 'ADMIN' || role === 'MANAGER';
        const where = {
            organizationId,
            ...(unreadOnly === 'true' || unreadOnly === true ? { unread: true } : {}),
            ...(type && type !== 'all' ? { type } : {}),
            ...(!isManager ? {
                OR: [
                    ...(userId ? [{ targetUserId: userId }] : []),
                    ...(employeeId ? [{ targetUserId: employeeId }] : []),
                    { type: 'info', targetUserId: null }
                ]
            } : {})
        };

        const [notifications, total, unreadCount] = await Promise.all([
            prisma.notification.findMany({
                where,
                orderBy: { createdAt: 'desc' },
                take: Number(limit) || 50,
                skip: Number(offset) || 0
            }),
            prisma.notification.count({ where }),
            prisma.notification.count({ where: { ...where, unread: true } })
        ]);

        const mapped = notifications.map(n => {
            const diffMinutes = Math.floor((Date.now() - new Date(n.createdAt).getTime()) / 60000);
            let timeStr = `${diffMinutes}m ago`;
            if (diffMinutes < 1) timeStr = 'Just now';
            else if (diffMinutes >= 60 && diffMinutes < 1440) timeStr = `${Math.floor(diffMinutes / 60)}h ago`;
            else if (diffMinutes >= 1440) timeStr = new Date(n.createdAt).toLocaleDateString();

            return {
                id: n.id,
                title: n.title,
                description: n.description || '',
                type: n.type,
                unread: n.unread,
                link: n.link,
                metadata: n.metadata,
                time: timeStr,
                createdAt: n.createdAt
            };
        });

        return { notifications: mapped, total, unreadCount };
    },

    markNotificationAsRead: async (id, organizationId, userContext = {}) => {
        const { role = 'ADMIN', userId, employeeId } = userContext;
        const isManager = role === 'ADMIN' || role === 'MANAGER';
        const where = {
            id,
            organizationId,
            ...(!isManager ? {
                OR: [
                    ...(userId ? [{ targetUserId: userId }] : []),
                    ...(employeeId ? [{ targetUserId: employeeId }] : []),
                    { type: 'info', targetUserId: null }
                ]
            } : {})
        };
        return await prisma.notification.updateMany({
            where,
            data: { unread: false }
        });
    },

    markAllNotificationsAsRead: async (organizationId, userContext = {}) => {
        const { role = 'ADMIN', userId, employeeId } = userContext;
        const isManager = role === 'ADMIN' || role === 'MANAGER';
        const where = {
            organizationId,
            unread: true,
            ...(!isManager ? {
                OR: [
                    ...(userId ? [{ targetUserId: userId }] : []),
                    ...(employeeId ? [{ targetUserId: employeeId }] : []),
                    { type: 'info', targetUserId: null }
                ]
            } : {})
        };
        return await prisma.notification.updateMany({
            where,
            data: { unread: false }
        });
    },

    deleteNotification: async (id, organizationId, userContext = {}) => {
        const { role = 'ADMIN', userId, employeeId } = userContext;
        const isManager = role === 'ADMIN' || role === 'MANAGER';
        const where = {
            id,
            organizationId,
            ...(!isManager ? {
                OR: [
                    ...(userId ? [{ targetUserId: userId }] : []),
                    ...(employeeId ? [{ targetUserId: employeeId }] : []),
                    { type: 'info', targetUserId: null }
                ]
            } : {})
        };
        return await prisma.notification.deleteMany({
            where
        });
    },

    deleteAllNotifications: async (organizationId, userContext = {}) => {
        const { role = 'ADMIN', userId, employeeId } = userContext;
        const isManager = role === 'ADMIN' || role === 'MANAGER';
        const where = {
            organizationId,
            ...(!isManager ? {
                OR: [
                    ...(userId ? [{ targetUserId: userId }] : []),
                    ...(employeeId ? [{ targetUserId: employeeId }] : []),
                    { type: 'info', targetUserId: null }
                ]
            } : {})
        };
        return await prisma.notification.deleteMany({
            where
        });
    }
};

module.exports = notificationsService;
