const prisma = require('../../config/db');

/**
 * Build a role-scoped WHERE clause for notification access control:
 * - ADMIN: Can view and manage all notifications across the organization.
 * - MANAGER: Can only view and manage notifications targeting themselves,
 *   members of their team, or general broadcasts/announcements.
 * - EMPLOYEE: Can only view and manage notifications targeting their own user/employee ID,
 *   or general broadcasts/announcements. Cannot see other employees' notifications.
 */
const getScopedNotificationWhere = async (organizationId, userContext = {}) => {
    const { role = 'ADMIN', userId, employeeId, teamId } = userContext;
    const currentRole = (role || 'ADMIN').toUpperCase();

    if (currentRole === 'ADMIN') {
        return { organizationId };
    }

    if (currentRole === 'EMPLOYEE') {
        const myTargetIds = [userId, employeeId].filter(Boolean);
        return {
            organizationId,
            OR: [
                ...(myTargetIds.length > 0 ? [{ targetUserId: { in: myTargetIds } }] : []),
                {
                    targetUserId: null,
                    type: { in: ['announcement', 'broadcast', 'general'] }
                },
                ...(myTargetIds.length > 0 ? myTargetIds.map(id => ({ targetUserId: null, metadata: { contains: id } })) : [])
            ]
        };
    }

    if (currentRole === 'MANAGER') {
        // Resolve manager's teamId if not present directly in the token
        let resolvedTeamId = teamId;
        if (!resolvedTeamId && (employeeId || userId)) {
            try {
                const managerEmp = await prisma.employee.findFirst({
                    where: {
                        organizationId,
                        OR: [
                            ...(employeeId ? [{ id: employeeId }] : []),
                            ...(userId ? [{ id: userId }] : [])
                        ]
                    },
                    select: { id: true, teamId: true }
                });
                if (managerEmp?.teamId) {
                    resolvedTeamId = managerEmp.teamId;
                }
            } catch (e) {}
        }

        // Fetch team members' employee IDs and user IDs
        let teamEmpIds = [];
        let teamUserIds = [];
        if (resolvedTeamId) {
            try {
                const teamEmps = await prisma.employee.findMany({
                    where: { organizationId, teamId: resolvedTeamId },
                    select: { id: true }
                });
                teamEmpIds = teamEmps.map(e => e.id);
                if (teamEmpIds.length > 0) {
                    const teamUsers = await prisma.user.findMany({
                        where: { employeeId: { in: teamEmpIds } },
                        select: { id: true }
                    });
                    teamUserIds = teamUsers.map(u => u.id);
                }
            } catch (e) {}
        }

        const allManagedIds = Array.from(new Set([...teamEmpIds, ...teamUserIds]));
        const allManagerTargetIds = [userId, employeeId].filter(Boolean);

        const managerOrConditions = [
            ...(allManagerTargetIds.length > 0 ? [{ targetUserId: { in: allManagerTargetIds } }] : []),
            ...(allManagedIds.length > 0 ? [{ targetUserId: { in: allManagedIds } }] : []),
            {
                targetUserId: null,
                type: { in: ['announcement', 'broadcast', 'general'] }
            }
        ];

        // Also match legacy notifications where team member's employeeId was stored in metadata
        for (const empId of allManagedIds) {
            managerOrConditions.push({
                targetUserId: null,
                metadata: { contains: empId }
            });
        }

        return {
            organizationId,
            OR: managerOrConditions
        };
    }

    return { organizationId };
};

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
        const scoped = await getScopedNotificationWhere(organizationId, { role, userId, employeeId, teamId });
        const where = {
            ...scoped,
            ...(unreadOnly === 'true' || unreadOnly === true ? { unread: true } : {}),
            ...(type && type !== 'all' ? { type } : {})
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
                targetUserId: n.targetUserId,
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
        const scoped = await getScopedNotificationWhere(organizationId, userContext);
        const where = {
            id,
            ...scoped
        };
        return await prisma.notification.updateMany({
            where,
            data: { unread: false }
        });
    },

    markAllNotificationsAsRead: async (organizationId, userContext = {}) => {
        const scoped = await getScopedNotificationWhere(organizationId, userContext);
        const where = {
            unread: true,
            ...scoped
        };
        return await prisma.notification.updateMany({
            where,
            data: { unread: false }
        });
    },

    deleteNotification: async (id, organizationId, userContext = {}) => {
        const scoped = await getScopedNotificationWhere(organizationId, userContext);
        const where = {
            id,
            ...scoped
        };
        return await prisma.notification.deleteMany({
            where
        });
    },

    deleteAllNotifications: async (organizationId, userContext = {}) => {
        const scoped = await getScopedNotificationWhere(organizationId, userContext);
        return await prisma.notification.deleteMany({
            where: scoped
        });
    }
};

module.exports = notificationsService;
