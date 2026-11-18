const prisma = require('../../config/db');
const bcrypt = require('bcrypt');

/**
 * Get all employees for an organization with optional filtering
 */
const getEmployees = async (organizationId, filter = {}) => {
    return await prisma.employee.findMany({
        where: {
            organizationId,
            ...filter
        },
        include: {
            team: true,
            user: {
                select: {
                    id: true,
                    email: true,
                    role: true
                }
            },
            agent: true,
            tracking: {
                orderBy: { timestamp: 'desc' },
                take: 1
            },
            liveActivities: {
                orderBy: { createdAt: 'desc' },
                take: 1
            }
        },
        orderBy: {
            fullName: 'asc'
        }
    });
};

/**
 * Get a single employee by ID
 */
const getEmployeeById = async (id) => {
    return await prisma.employee.findUnique({
        where: { id },
        include: {
            team: true,
            user: {
                select: {
                    id: true,
                    email: true,
                    role: true
                }
            }
        }
    });
};

/**
 * Invite a new employee (creates employee record with INVITED status)
 */
const inviteEmployee = async (data) => {
    // 1. Check if employee already exists with this email
    const existing = await prisma.employee.findUnique({
        where: { email: data.email }
    });
    if (existing) {
        const error = new Error(`Employee with email "${data.email}" already exists.`);
        error.statusCode = 409;
        throw error;
    }

    // 2. Resolve teamId - if not provided or invalid, fallback to first team of org
    let teamId = data.teamId;
    if (teamId) {
        const teamExists = await prisma.team.findUnique({ where: { id: teamId } });
        if (!teamExists) teamId = null;
    }
    if (!teamId) {
        const defaultTeam = await prisma.team.findFirst({
            where: { organizationId: data.organizationId }
        });
        teamId = defaultTeam ? defaultTeam.id : null;
    }

    // 3. Resolve default tracking setting
    const computerType = (data.computerType || 'PERSONAL').toLowerCase();
    let trackingSetting = await prisma.trackingSetting.findFirst({
        where: {
            organizationId: data.organizationId,
            computerType,
            isDefault: true
        }
    });

    if (!trackingSetting) {
        trackingSetting = await prisma.trackingSetting.findFirst({
            where: {
                organizationId: data.organizationId
            }
        });
    }

    const workMode = data.location || 'Remote';
    const status = data.status || 'ACTIVE';

    const employee = await prisma.employee.create({
        data: {
            fullName: data.fullName,
            email: data.email,
            organizationId: data.organizationId,
            teamId,
            workMode,
            location: data.location || 'Remote',
            computerType: data.computerType || 'PERSONAL',
            trackingSettingId: trackingSetting?.id,
            role: data.role || 'EMPLOYEE',
            status,
            hourlyRate: (data.hourlyRate !== undefined && data.hourlyRate !== null) ? Number(data.hourlyRate) : 0,
            avatar: `https://ui-avatars.com/api/?name=${encodeURIComponent(data.fullName)}&background=random`
        },
        include: {
            team: true,
            user: true
        }
    });

    // 4. If password is provided, create linked User login account
    if (data.password) {
        const hashedPassword = await bcrypt.hash(data.password, 10);
        await prisma.user.create({
            data: {
                email: employee.email,
                password: hashedPassword,
                role: employee.role,
                name: employee.fullName,
                employeeId: employee.id
            }
        });
    }

    return employee;
};

/**
 * Update an existing employee and their linked user record
 */
const updateEmployee = async (id, data) => {
    const { password, ...employeeData } = data;

    // Filter and prepare employee update data
    const updateData = {};
    if (employeeData.fullName !== undefined) updateData.fullName = employeeData.fullName;
    
    // Sanitize teamId: if empty string, none, or invalid, set to null to avoid foreign key failure
    if (employeeData.teamId !== undefined) {
        if (!employeeData.teamId || employeeData.teamId === '' || employeeData.teamId === 'none') {
            updateData.teamId = null;
        } else {
            const teamExists = await prisma.team.findUnique({ where: { id: employeeData.teamId } });
            updateData.teamId = teamExists ? employeeData.teamId : null;
        }
    }

    if (employeeData.location !== undefined) {
        updateData.location = employeeData.location;
        const cleanLoc = (employeeData.location || '').toLowerCase();
        if (cleanLoc.includes('office')) updateData.workMode = 'Office';
        else if (cleanLoc.includes('remote')) updateData.workMode = 'Remote';
        else if (cleanLoc.includes('hybrid')) updateData.workMode = 'Hybrid';
    }

    if (employeeData.status !== undefined) updateData.status = employeeData.status;
    if (employeeData.hourlyRate !== undefined) updateData.hourlyRate = employeeData.hourlyRate;
    if (employeeData.avatar !== undefined) updateData.avatar = employeeData.avatar;

    // Update employee record
    const employee = await prisma.employee.update({
        where: { id },
        data: updateData,
        include: { user: true }
    });

    // Keep linked User name in sync with Employee fullName
    if (employeeData.fullName && employee.user) {
        await prisma.user.update({
            where: { id: employee.user.id },
            data: { name: employeeData.fullName }
        }).catch(() => {});
    }

    // Lifecycle Hook: If employee is deactivated, close active sessions & deactivate agent
    if (updateData.status === 'DEACTIVATED') {
        const activeAtt = await prisma.attendance.findFirst({
            where: { employeeId: id, clockOut: null }
        });
        if (activeAtt) {
            const now = new Date();
            const duration = Math.max(0, Math.floor((now - activeAtt.clockIn) / 1000));
            await prisma.attendance.update({
                where: { id: activeAtt.id },
                data: { clockOut: now, duration }
            });
        }

        // Auto-stop any running task timer
        try {
            const tasksService = require('../tasks/tasks.service');
            await tasksService.stopActiveTimerForEmployee(id, new Date());
        } catch (e) {
            console.error('[EmployeeService] Auto-stopping task timer on deactivation failed:', e.message);
        }

        // Deactivate agent
        await prisma.agent.updateMany({
            where: { employeeId: id },
            data: { status: 'inactive' }
        });
    }

    // Handle password update or creation of User record
    if (password && password.trim() !== '') {
        const hashedPassword = await bcrypt.hash(password, 10);

        if (employee.user) {
            // Update existing user
            await prisma.user.update({
                where: { id: employee.user.id },
                data: {
                    password: hashedPassword,
                    email: employee.email,
                    name: employee.fullName
                }
            });
        } else {
            // Check if user already exists by email to prevent duplicate email unique constraint error
            const existingUser = await prisma.user.findUnique({ where: { email: employee.email } });
            if (existingUser) {
                await prisma.user.update({
                    where: { id: existingUser.id },
                    data: {
                        password: hashedPassword,
                        employeeId: employee.id,
                        name: employee.fullName,
                        role: employee.role
                    }
                });
            } else {
                await prisma.user.create({
                    data: {
                        email: employee.email,
                        password: hashedPassword,
                        role: employee.role,
                        name: employee.fullName,
                        employeeId: employee.id
                    }
                });
            }
        }
    }

    return await getEmployeeById(id);
};

/**
 * Permanently delete an employee and cascade-clean all associated records.
 */
const deleteEmployee = async (id) => {
    const employee = await prisma.employee.findUnique({
        where: { id },
        include: { user: true }
    });

    if (!employee) {
        throw new Error('Employee not found');
    }

    // Step-by-step cleanup of all related records to ensure zero foreign key constraint violations
    await prisma.activityLog.deleteMany({ where: { employeeId: id } }).catch(() => { });
    await prisma.appUsageLog.deleteMany({ where: { employeeId: id } }).catch(() => { });
    await prisma.attendance.deleteMany({ where: { employeeId: id } }).catch(() => { });
    await prisma.manualTime.deleteMany({ where: { employeeId: id } }).catch(() => { });
    await prisma.projectTimeLog.deleteMany({ where: { employeeId: id } }).catch(() => { });
    await prisma.taskTimeLog.deleteMany({ where: { employeeId: id } }).catch(() => { });
    await prisma.payrollRecord.deleteMany({ where: { employeeId: id } }).catch(() => { });
    await prisma.locationLog.deleteMany({ where: { employeeId: id } }).catch(() => { });
    await prisma.screenshot.deleteMany({ where: { employeeId: id } }).catch(() => { });
    await prisma.liveActivity.deleteMany({ where: { employeeId: id } }).catch(() => { });
    await prisma.shift.deleteMany({ where: { employeeId: id } }).catch(() => { });
    await prisma.projectAssignment.deleteMany({ where: { employeeId: id } }).catch(() => { });
    await prisma.timeOff.deleteMany({ where: { employeeId: id } }).catch(() => { });
    await prisma.auditLog.deleteMany({ where: { userId: id } }).catch(() => { });
    await prisma.goalStakeholder.deleteMany({ where: { employeeId: id } }).catch(() => { });
    await prisma.alertLog.deleteMany({ where: { employeeId: id } }).catch(() => { });
    await prisma.agent.deleteMany({ where: { employeeId: id } }).catch(() => { });
    await prisma.tracking.deleteMany({ where: { employeeId: id } }).catch(() => { });
    await prisma.videoRecording.deleteMany({ where: { employeeId: id } }).catch(() => { });
    try {
    await prisma.timesheet.deleteMany({ where: { employeeId: id } });
} catch (e) { }

// De-assign from tasks instead of deleting tasks
await prisma.task.updateMany({
    where: { employeeId: id },
    data: { employeeId: null }
    }).catch (() => { });

// Delete User record if exists
if (employee.user) {
    await prisma.user.delete({
        where: { id: employee.user.id }
}).catch (() => { });
    } else {
    await prisma.user.deleteMany({
        where: { employeeId: id }
    }).catch(() => { });
}

// Finally delete the employee record from database
return await prisma.employee.delete({
    where: { id }
});
};

module.exports = {
    getEmployees,
    getEmployeeById,
    inviteEmployee,
    updateEmployee,
    deleteEmployee
};
