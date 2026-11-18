const prisma = require('../../config/db');
const teamsService = require('./teams.service');
const { createTeamSchema, updateTeamSchema } = require('./teams.validation');
const { getOrganizationId } = require('../../utils/orgId');

const getTeams = async (req, res, next) => {
    try {
        const orgId = await getOrganizationId(req);
        const { role, employeeId: currentEmployeeId } = req.user;

        if (!orgId) {
            console.error(`[TeamsController] No organizationId found for user: ${req.user.userId}`);
            return res.status(400).json({ success: false, message: "Organization ID is required" });
        }

        let filter = {};

        const teams = await teamsService.getTeams(orgId, filter);

        // Map to industry/insightful format with real productivity computation from database logs
        const formattedTeams = await Promise.all(teams.map(async (team) => {
            const teamEmpIds = (team.employees || []).map(e => e.id);
            let productivity = 0;
            if (teamEmpIds.length > 0) {
                const logs = await prisma.activityLog.findMany({
                    where: {
                        employeeId: { in: teamEmpIds }
                    },
                    select: {
                        activityType: true,
                        productivity: true,
                        duration: true
                    }
                });
                let activeSec = 0;
                let prodSec = 0;
                logs.forEach(l => {
                    const d = l.duration || 0;
                    if (l.activityType === 'ACTIVE') activeSec += d;
                    if (l.productivity === 'PRODUCTIVE') prodSec += d;
                });
                productivity = activeSec > 0 ? Math.round((prodSec / activeSec) * 100) : 0;
            }

            return {
                id: team.id,
                name: team.name,
                description: team.description,
                color: team.color,
                memberCount: team._count?.employees || 0,
                onlineCount: (team.employees || []).filter(e => e.status === 'ACTIVE').length,
                productivity,
                organizationId: team.organizationId
            };
        }));

        res.status(200).json({
            success: true,
            data: formattedTeams
        });
    } catch (error) {
        next(error);
    }
};

const createTeam = async (req, res, next) => {
    try {
        if (req.user.role !== 'ADMIN' && req.user.role !== 'MANAGER') {
            return res.status(403).json({ success: false, message: "Only admins and managers can create teams" });
        }
        const orgId = await getOrganizationId(req);
        const validatedData = createTeamSchema.parse(req.body);
        
        // Securely bind team to authenticated user's organization so it never desyncs or disappears
        const teamData = {
            ...validatedData,
            organizationId: orgId
        };

        const team = await teamsService.createTeam(teamData);
        res.status(201).json({
            success: true,
            message: "Team created successfully",
            data: {
                id: team.id,
                name: team.name,
                description: team.description,
                color: team.color || 'bg-blue-500',
                memberCount: 0,
                onlineCount: 0,
                productivity: 0,
                organizationId: team.organizationId
            }
        });
    } catch (error) {
        next(error);
    }
};

const updateTeam = async (req, res, next) => {
    try {
        const { id } = req.params;
        const validatedData = updateTeamSchema.parse(req.body);
        const team = await teamsService.updateTeam(id, validatedData);
        res.status(200).json({
            success: true,
            message: "Team updated successfully",
            data: team
        });
    } catch (error) {
        next(error);
    }
};

const deleteTeam = async (req, res, next) => {
    try {
        if (req.user.role !== 'ADMIN' && req.user.role !== 'MANAGER') {
            return res.status(403).json({ success: false, message: "Only admins and managers can delete teams" });
        }
        const { id } = req.params;
        await teamsService.deleteTeam(id);
        res.status(200).json({
            success: true,
            message: "Team deleted successfully"
        });
    } catch (error) {
        next(error);
    }
};

module.exports = {
    getTeams,
    createTeam,
    updateTeam,
    deleteTeam
};
