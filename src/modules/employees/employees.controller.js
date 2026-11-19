const employeesService = require('./employees.service');
const invitationService = require('../auth/invitation.service');
const { inviteEmployeeSchema, updateEmployeeSchema } = require('./employees.validation');
const { getOrganizationId } = require('../../utils/orgId');

const getEmployees = async (req, res, next) => {
    try {
        const orgId = await getOrganizationId(req);
        const { role, employeeId: currentEmployeeId } = req.user;

        let filter = {};
        if (role === 'EMPLOYEE') {
            // Employees see only themselves
            filter = { id: currentEmployeeId };
        } else if (role === 'MANAGER') {
            filter = { role: 'EMPLOYEE' };
        }
        // ADMIN sees all members in the organization

        const employees = await employeesService.getEmployees(orgId, filter);

        // Map to industry/insightful format
        const formattedEmployees = employees.map(emp => {
            let agentStatus = 'inactive';
            let lastSeen = null;
            let currentActivity = 'Idle';
            let activeApp = '';
            let activeWindow = '';

            if (emp.liveActivities && emp.liveActivities.length > 0) {
                activeApp = emp.liveActivities[0].activeApp;
                activeWindow = emp.liveActivities[0].activeWindow;
            }

            if (emp.agent) {
                lastSeen = emp.agent.lastSeen;
                const isRecent = new Date() - new Date(lastSeen) < 5 * 60 * 1000;
                if (emp.agent.status === 'active' && isRecent) {
                    agentStatus = 'active';
                }
            }

            if (emp.tracking && emp.tracking.length > 0) {
                currentActivity = emp.tracking[0].activityStatus || 'Idle';
            }

            const WORK_MODES = ['Remote', 'Office', 'Hybrid'];
            const workMode = emp.workMode || (WORK_MODES.includes(emp.location) ? emp.location : 'Remote');
            const liveLocation = emp.location && !WORK_MODES.includes(emp.location)
                ? emp.location
                : (emp.tracking?.[0]?.location?.split(',')[0]?.trim() || null);
            const locationDisplay = `${liveLocation || '—'} (${workMode})`;

            return {
                id: emp.id,
                name: emp.fullName, // Map fullName to name for frontend compatibility
                email: emp.email,
                team: emp.team ? emp.team.name : 'Unassigned',
                location: locationDisplay,
                liveLocation,
                workMode,
                status: emp.status.toLowerCase(),
                avatar: emp.avatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(emp.fullName)}&background=random`,
                role: emp.role,
                organizationId: emp.organizationId,
                teamId: emp.teamId,
                computerType: emp.computerType,
                hourlyRate: emp.hourlyRate,
                agentStatus,
                lastSeen,
                currentActivity,
                activeApp,
                activeWindow
            };
        });

        res.status(200).json({
            success: true,
            data: formattedEmployees
        });
    } catch (error) {
        next(error);
    }
};

const getEmployeeById = async (req, res, next) => {
    try {
        const { id } = req.params;
        const employee = await employeesService.getEmployeeById(id);

        if (!employee) {
            return res.status(404).json({
                success: false,
                message: "Employee not found"
            });
        }

        if (req.user.role === 'MANAGER' && employee.role === 'ADMIN') {
            return res.status(403).json({
                success: false,
                message: "Access denied: You cannot view admin profile"
            });
        }

        const formattedEmployee = {
            ...employee,
            name: employee.fullName,
            team: employee.team ? employee.team.name : 'Unassigned',
            status: employee.status.toLowerCase()
        };

        res.status(200).json({
            success: true,
            data: formattedEmployee
        });
    } catch (error) {
        next(error);
    }
};

const inviteEmployee = async (req, res, next) => {
    try {
        if (req.user.role !== 'ADMIN' && req.user.role !== 'MANAGER') {
            return res.status(403).json({ success: false, message: "Unauthorized" });
        }
        const userOrgId = req.user?.organizationId || (req.user?.employeeId ? (await prisma.employee.findUnique({ where: { id: req.user.employeeId }, select: { organizationId: true } }))?.organizationId : null);
        const orgId = userOrgId || req.body.organizationId || await getOrganizationId(req);
        const validatedData = inviteEmployeeSchema.parse({
            ...req.body,
            organizationId: orgId
        });
        
        const role = validatedData.role || 'EMPLOYEE';
        
        // 1. Create employee in DB (status: ACTIVE or INVITED)
        const employee = await employeesService.inviteEmployee(validatedData);
        
        let inviteResult = {};
        try {
            if (role === 'EMPLOYEE' && validatedData.computerType === 'PERSONAL') {
                inviteResult = await invitationService.sendEmployeeAgentInvitation({
                    email: validatedData.email,
                    fullName: validatedData.fullName,
                    organizationId: validatedData.organizationId,
                    workMode: validatedData.location || 'Remote',
                });
            } else {
                const { setupLink } = await invitationService.sendInvitation(
                    validatedData.email,
                    role,
                    validatedData.organizationId,
                    validatedData.fullName,
                    employee.id
                );
                inviteResult = { setupLink };
            }
        } catch (inviteErr) {
            console.warn('[InviteEmployee] Email delivery skipped/simulated:', inviteErr.message);
            inviteResult = { emailSent: false, emailSimulated: true };
        }

        return res.status(201).json({
            success: true,
            message: 'Employee created and saved to database successfully',
            data: employee,
            ...inviteResult,
        });
    } catch (error) {
        console.error('[EmployeeController] Error creating employee:', error);
        return res.status(error.statusCode || 400).json({
            success: false,
            message: error.message || 'Failed to add employee'
        });
    }
};

const updateEmployee = async (req, res, next) => {
    try {
        if (req.user.role !== 'ADMIN' && req.user.role !== 'MANAGER') {
            return res.status(403).json({ success: false, message: "Only admins and managers can update employees" });
        }
        const { id } = req.params;
        const validatedData = updateEmployeeSchema.parse(req.body);
        const employee = await employeesService.updateEmployee(id, validatedData);
        
        // Map to industry/insightful format for frontend consistency
        const formattedEmployee = {
            ...employee,
            name: employee.fullName,
            status: employee.status.toLowerCase(),
            avatar: employee.avatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(employee.fullName)}&background=random`
        };

        res.status(200).json({
            success: true,
            message: "Employee updated successfully",
            data: formattedEmployee
        });
    } catch (error) {
        next(error);
    }
};

const deleteEmployee = async (req, res, next) => {
    try {
        if (req.user.role !== 'ADMIN' && req.user.role !== 'MANAGER') {
            return res.status(403).json({ success: false, message: "Only admins and managers can delete employees" });
        }
        const { id } = req.params;
        await employeesService.deleteEmployee(id);
        res.status(200).json({
            success: true,
            message: "Employee deleted successfully (deactivated)"
        });
    } catch (error) {
        next(error);
    }
};

module.exports = {
    getEmployees,
    getEmployeeById,
    inviteEmployee,
    updateEmployee,
    deleteEmployee
};
