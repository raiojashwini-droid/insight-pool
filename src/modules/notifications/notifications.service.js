const prisma = require('../../config/db');

const notificationsService = {
    createNotification: async (organizationId, { title, description, type = 'info', targetUserId, link, metadata } = {}) => {
        if (!organizationId || !title) return null;
        try {
            const notif = await prisma.notification.create({
                data: {
                    organizationId,
                    title,
                    description: description || null,
                    type: type || 'info',
                    targetUserId: targetUserId || null,
                    link: link || null,
                    metadata: metadata ? (typeof metadata === 'string' ? metadata : JSON.stringify(metadata)) : null,
                    unread: true
                }
            });
            return notif;
        } catch (err) {
            console.error('Error creating notification in DB:', err);
            return null;
        }
    },

    getNotifications: async (organizationId, { unreadOnly = false, type, limit = 50, offset = 0, role = 'ADMIN', userId, employeeId, teamId } = {}) => {
        const currentRole = (role || 'ADMIN').toUpperCase();
        const where = {
            organizationId,
            ...(unreadOnly === 'true' || unreadOnly === true ? { unread: true } : {}),
            ...(type && type !== 'all' ? { type } : {})
        };

        if (currentRole === 'EMPLOYEE') {
            where.OR = [
                ...(userId ? [{ targetUserId: userId }] : []),
                ...(employeeId ? [{ targetUserId: employeeId }] : []),
                {
                    targetUserId: null,
                    type: { in: ['announcement', 'broadcast', 'general'] }
                }
            ];
        } else if (currentRole === 'MANAGER') {
            let teamEmpIds = [];
            if (teamId) {
                try {
                    const teamEmps = await prisma.employee.findMany({
                        where: { organizationId, teamId },
                        select: { id: true }
                    });
                    teamEmpIds = teamEmps.map(e => e.id);
                } catch (e) {}
            }
            where.OR = [
                ...(userId ? [{ targetUserId: userId }] : []),
                ...(employeeId ? [{ targetUserId: employeeId }] : []),
                ...(teamEmpIds.length > 0 ? [{ targetUserId: { in: teamEmpIds } }] : []),
                {
                    targetUserId: null,
                    NOT: [
                        { title: { contains: 'Compliance setting' } },
                        { title: { contains: 'Geofence' } },
                        { title: { contains: 'Setting updated' } }
                    ]
                }
            ];
        }

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
        const currentRole = (role || 'ADMIN').toUpperCase();
        const where = {
            id,
            organizationId,
            ...(currentRole === 'EMPLOYEE' ? {
                OR: [
                    ...(userId ? [{ targetUserId: userId }] : []),
                    ...(employeeId ? [{ targetUserId: employeeId }] : [])
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
        const currentRole = (role || 'ADMIN').toUpperCase();
        const where = {
            organizationId,
            unread: true,
            ...(currentRole === 'EMPLOYEE' ? {
                OR: [
                    ...(userId ? [{ targetUserId: userId }] : []),
                    ...(employeeId ? [{ targetUserId: employeeId }] : [])
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
        const currentRole = (role || 'ADMIN').toUpperCase();
        const where = {
            id,
            organizationId,
            ...(currentRole === 'EMPLOYEE' ? {
                OR: [
                    ...(userId ? [{ targetUserId: userId }] : []),
                    ...(employeeId ? [{ targetUserId: employeeId }] : [])
                ]
            } : {})
        };
        return await prisma.notification.deleteMany({
            where
        });
    },

    deleteAllNotifications: async (organizationId, userContext = {}) => {
        const { role = 'ADMIN', userId, employeeId } = userContext;
        const currentRole = (role || 'ADMIN').toUpperCase();
        const where = {
            organizationId,
            ...(currentRole === 'EMPLOYEE' ? {
                OR: [
                    ...(userId ? [{ targetUserId: userId }] : []),
                    ...(employeeId ? [{ targetUserId: employeeId }] : [])
                ]
            } : {})
        };
        return await prisma.notification.deleteMany({
            where
        });
    }
};

module.exports = notificationsService;
