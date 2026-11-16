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
    // Find the default tracking setting for this computer type in the organization
    let trackingSetting = await prisma.trackingSetting.findFirst({
        where: {
            organizationId: data.organizationId,
            computerType: data.computerType.toLowerCase(),
            isDefault: true
        }
    });

    // Fallback: If no default, pick the first one of that type
    if (!trackingSetting) {
        trackingSetting = await prisma.trackingSetting.findFirst({
            where: {
                organizationId: data.organizationId,
                computerType: data.computerType.toLowerCase()
            }
        });
    }

    const workMode = data.location || 'Remote';

    return await prisma.employee.create({
        data: {
            fullName: data.fullName,
            email: data.email,
            organizationId: data.organizationId,
            teamId: data.teamId,
            workMode,
            location: null,
            computerType: data.computerType || 'PERSONAL',
            trackingSettingId: trackingSetting?.id,
            role: 'EMPLOYEE',
            status: 'INVITED'
        }
    });
};

/**
 * Update an existing employee and their linked user record
 */
const updateEmployee = async (id, data) => {
    const { password, ...employeeData } = data;

    // Filter and prepare employee update data
    const updateData = {};
    if (employeeData.fullName !== undefined) updateData.fullName = employeeData.fullName;
    if (employeeData.teamId !== undefined) updateData.teamId = employeeData.teamId;
    if (employeeData.location !== undefined) updateData.location = employeeData.location;
    if (employeeData.status !== undefined) updateData.status = employeeData.status;
    if (employeeData.hourlyRate !== undefined) updateData.hourlyRate = employeeData.hourlyRate;
    if (employeeData.avatar !== undefined) updateData.avatar = employeeData.avatar;

    // Update employee record
    const employee = await prisma.employee.update({
        where: { id },
        data: updateData,
        include: { user: true }
    });

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
    if (password) {
        const hashedPassword = await bcrypt.hash(password, 10);
        
        if (employee.user) {
            // Update existing user
            await prisma.user.update({
                where: { id: employee.user.id },
                data: { 
                    password: hashedPassword,
                    email: employee.email // Ensure email stays in sync
                }
            });
        } else {
            // Create new user for this employee if none exists
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

    return await getEmployeeById(id);
};

/**
 * Permanently delete an employee ONLY if no historical records exist.
 * Preserves compliance and prevents accidental deletion of work history.
 */
const deleteEmployee = async (id) => {
    const employee = await prisma.employee.findUnique({
        where: { id },
        include: { user: true }
    });

    if (!employee) {
        throw new Error('Employee not found');
    }

    // Safety check: Prevent deletion if historical attendance, payroll, timesheet, manual time, task time or activity logs exist
    const [attCount, payrollCount, manualCount, ptlCount, actCount, ttlCount] = await Promise.all([
        prisma.attendance.count({ where: { employeeId: id } }),
        prisma.payrollRecord.count({ where: { employeeId: id } }),
        prisma.manualTime.count({ where: { employeeId: id } }),
        prisma.projectTimeLog.count({ where: { employeeId: id } }),
        prisma.activityLog.count({ where: { employeeId: id } }),
        prisma.taskTimeLog.count({ where: { employeeId: id } }),
    ]);

    let timesheetCount = 0;
    try {
        const check = await prisma.$queryRawUnsafe("SHOW TABLES LIKE 'timesheets'");
        if (check && check.length > 0) {
            timesheetCount = await prisma.timesheet.count({ where: { employeeId: id } });
        }
    } catch (e) {
        // Table might not exist yet
    }

    const totalHistoricalRecords = attCount + payrollCount + manualCount + ptlCount + timesheetCount + actCount + ttlCount;

    if (totalHistoricalRecords > 0) {
        const error = new Error(
            `Cannot delete employee with existing historical records (${attCount} attendance, ${timesheetCount} timesheets, ${manualCount} manual time entries, ${payrollCount} payroll records, ${ttlCount} task time logs, ${actCount} activity logs). Please deactivate the employee instead to preserve historical and audit data.`
        );
        error.statusCode = 400;
        throw error;
    }

    // Step-by-step cleanup of non-work relation records for clean/empty employee
    await prisma.locationLog.deleteMany({ where: { employeeId: id } });
    await prisma.screenshot.deleteMany({ where: { employeeId: id } });
    await prisma.liveActivity.deleteMany({ where: { employeeId: id } });
    await prisma.shift.deleteMany({ where: { employeeId: id } });
    await prisma.projectAssignment.deleteMany({ where: { employeeId: id } });
    await prisma.timeOff.deleteMany({ where: { employeeId: id } });
    await prisma.auditLog.deleteMany({ where: { userId: id } });
    await prisma.agent.deleteMany({ where: { employeeId: id } });
    await prisma.tracking.deleteMany({ where: { employeeId: id } });
    await prisma.videoRecording.deleteMany({ where: { employeeId: id } });
    
    // De-assign from tasks instead of deleting tasks
    await prisma.task.updateMany({
        where: { employeeId: id },
        data: { employeeId: null }
    });

    // Delete User record if exists
    if (employee.user) {
        await prisma.user.delete({
            where: { id: employee.user.id }
        });
    }

    // Finally delete the employee
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
