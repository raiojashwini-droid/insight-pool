const agentService = require('./agent.service');
const { successResponse, errorResponse } = require('../../utils/response');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcrypt');
const prisma = require('../../config/db');
const { getIO } = require('../../socket/server');
const { getOrganizationId } = require('../../utils/orgId');

const invitationService = require('../auth/invitation.service');
const { sendIdleAlertEmail } = require('../../utils/email.service');

const register = async (req, res) => {
    try {
        const { employeeId, email, password, name, deviceId, systemInfo, inviteToken } = req.body;
        
        let targetEmployeeId = employeeId;
        let user = null;
        let invitedEmployee = null;

        if (!email || !password || !deviceId) {
            return errorResponse(res, 'Email, Password and Device ID are required', 400);
        }

        if (inviteToken) {
            try {
                invitedEmployee = await invitationService.consumeInvitationForAgent(inviteToken, email);
                targetEmployeeId = invitedEmployee.id;
            } catch (invErr) {
                return errorResponse(res, invErr.message, 400);
            }
        }

        // 1. Find or Create User/Employee
        user = await prisma.user.findUnique({
            where: { email },
            include: { employee: true }
        });

        // CRITICAL CHECK: Reject deactivated employee immediately
        if (user?.employee?.status === 'DEACTIVATED') {
            return res.status(403).json({
                success: false,
                code: 'ACCOUNT_DEACTIVATED',
                message: 'This employee account has been deactivated. Please contact your administrator.'
            });
        }

        const existingEmpCheck = await prisma.employee.findUnique({ where: { email } });
        if (existingEmpCheck && existingEmpCheck.status === 'DEACTIVATED') {
            return res.status(403).json({
                success: false,
                code: 'ACCOUNT_DEACTIVATED',
                message: 'This employee account has been deactivated. Please contact your administrator.'
            });
        }

        if (!user) {
            console.log(`User record not found for: ${email}. Checking for existing employee...`);
            
            let existingEmployee = invitedEmployee || existingEmpCheck;
            
            if (!existingEmployee) {
                console.log(`Creating new employee for: ${email}`);
                let org = await prisma.organization.findUnique({ where: { id: 'default-org-id' } });
                if (!org) {
                    org = await prisma.organization.findFirst();
                }
                if (!org) throw new Error('No organization found in system. Please setup organization first.');

                existingEmployee = await prisma.employee.create({
                    data: {
                        fullName: name || email.split('@')[0],
                        email,
                        organizationId: org.id,
                        role: 'EMPLOYEE',
                        status: 'ACTIVE',
                        computerType: 'COMPANY',
                    }
                });
            }

            console.log(`Creating user record for employee: ${existingEmployee.fullName}`);
            // Create User linked to the employee
            const hashedPassword = await bcrypt.hash(password, 10);
            user = await prisma.user.create({
                data: {
                    email,
                    password: hashedPassword,
                    role: 'EMPLOYEE',
                    employeeId: existingEmployee.id
                },
                include: { employee: true }
            });
            
            targetEmployeeId = existingEmployee.id;

            await prisma.employee.update({
                where: { id: existingEmployee.id },
                data: {
                    fullName: name || existingEmployee.fullName,
                    ...(existingEmployee.status === 'INVITED' ? { status: 'ACTIVE' } : {}),
                },
            });
        } else {
            // User exists, verify password
            const isPasswordValid = await bcrypt.compare(password, user.password);
            if (!isPasswordValid) {
                return errorResponse(res, 'Invalid password. Please use your portal login password.', 401);
            }
            
            if (!user.employee) {
                // If user exists but has no employee record (shouldn't happen with our schema but good to handle)
                let existingEmployee = await prisma.employee.findUnique({ where: { email } });
                if (existingEmployee && existingEmployee.status === 'DEACTIVATED') {
                    return res.status(403).json({
                        success: false,
                        code: 'ACCOUNT_DEACTIVATED',
                        message: 'This employee account has been deactivated. Please contact your administrator.'
                    });
                }
                if (!existingEmployee) {
                    const org = await prisma.organization.findFirst();
                    existingEmployee = await prisma.employee.create({
                        data: {
                            fullName: name || email.split('@')[0],
                            email,
                            organizationId: org ? org.id : 1,
                            role: 'EMPLOYEE',
                            status: 'ACTIVE'
                        }
                    });
                }
                
                await prisma.user.update({
                    where: { id: user.id },
                    data: { employeeId: existingEmployee.id }
                });
                targetEmployeeId = existingEmployee.id;
            } else {
                targetEmployeeId = user.employee.id;
            }

            if (name && user.employee) {
                await prisma.employee.update({
                    where: { id: user.employee.id },
                    data: {
                        fullName: name,
                        ...(user.employee.status === 'INVITED' ? { status: 'ACTIVE' } : {})
                    },
                });
            }
        }

        // 2. Clear Any Existing Agent on this Device (to prevent unique constraint failure)
        const existingDeviceAgent = await prisma.agent.findUnique({
            where: { deviceId }
        });
        
        if (existingDeviceAgent && existingDeviceAgent.employeeId !== targetEmployeeId) {
            console.log(`Removing old agent record for device: ${deviceId} (previously employee: ${existingDeviceAgent.employeeId})`);
            await prisma.agent.delete({ where: { deviceId } });
        }

        // 3. Register Agent (will be 'pending' by default)
        const agent = await agentService.registerAgent(targetEmployeeId, deviceId, systemInfo);
        
        // Simple token for agent security
        const agentToken = Buffer.from(`${targetEmployeeId}:${deviceId}:INSIGHTFUL`).toString('base64');
        
        return successResponse(res, { agent, token: agentToken }, 'Agent registration received and pending approval');
    } catch (error) {
        console.error('Agent register error:', error);
        return errorResponse(res, error.message || 'Failed to register agent', 500);
    }
};

const heartbeat = async (req, res) => {
    try {
        const { deviceId, taskId } = req.body;
        if (!deviceId) return errorResponse(res, 'Device ID is required', 400);

        const agent = await prisma.agent.findUnique({ 
            where: { deviceId },
            include: { employee: true }
        });
        if (!agent) return errorResponse(res, 'Agent not found', 404);

        // Check if Employee is Deactivated
        if (agent.employee?.status === 'DEACTIVATED') {
            return res.status(403).json({
                success: false,
                code: 'ACCOUNT_DEACTIVATED',
                message: 'This employee account has been deactivated. Tracking stopped.'
            });
        }

        // Check if Approved
        if (agent.status !== 'active') {
            return errorResponse(res, 'Agent is not approved. Please contact admin.', 403);
        }

        // Validate and sanitize taskId safely (Requirement 2 & 4)
        const validatedTaskId = (typeof taskId === 'string' && taskId.trim().length > 0)
            ? taskId.trim()
            : null;

        await agentService.heartbeat(deviceId, validatedTaskId);
        return successResponse(res, { deviceId, taskId: validatedTaskId }, 'Heartbeat received');
    } catch (error) {
        if (error.code === 'ACCOUNT_DEACTIVATED') {
            return res.status(403).json({
                success: false,
                code: 'ACCOUNT_DEACTIVATED',
                message: error.message
            });
        }
        console.error('Agent heartbeat error:', error);
        return errorResponse(res, error.message || 'Heartbeat failed', 500);
    }
};

const logActivity = async (req, res) => {
    try {
        const { employeeId, data, taskId } = req.body;
        const authHeader = req.headers['x-agent-auth'] || req.headers['X-Agent-Auth'];

        if (!employeeId || !data) return errorResponse(res, 'Employee ID and Data are required', 400);

        // Validate and sanitize taskId safely (Requirement 2 & 4)
        const rawTaskId = taskId || data.taskId;
        const validatedTaskId = (typeof rawTaskId === 'string' && rawTaskId.trim().length > 0)
            ? rawTaskId.trim()
            : null;
        data.taskId = validatedTaskId;

        // Check Agent Status
        const agent = await prisma.agent.findUnique({ 
            where: { employeeId },
            include: { employee: true }
        });
        if (!agent) return errorResponse(res, 'Agent not found', 404);

        // Check if Employee is Deactivated
        if (agent.employee?.status === 'DEACTIVATED') {
            return res.status(403).json({
                success: false,
                code: 'ACCOUNT_DEACTIVATED',
                message: 'This employee account has been deactivated. Tracking stopped.'
            });
        }

        if (agent.status !== 'active') {
            return errorResponse(res, 'Agent is not active or approved', 403);
        }

        const organizationId = agent.employee.organizationId;

        // Token verification
        if (!authHeader) return errorResponse(res, 'Unauthorized', 401);
        const decoded = Buffer.from(authHeader, 'base64').toString('ascii');
        if (!decoded.includes(employeeId) || !decoded.includes('INSIGHTFUL')) {
            return errorResponse(res, 'Unauthorized', 401);
        }

        const logResult = await agentService.logActivity(employeeId, data);

        // Emit Real-time Socket Events
        const io = getIO();
        if (io && organizationId) {
            const room = `org_${organizationId}`;
            
            // 1. Notify about new screenshot (with taskId & violation metadata)
            if (logResult?.screenshotSaved && logResult?.finalScreenshotUrl) {
                io.to(room).emit('screenshot:new', {
                    employeeId,
                    imageUrl: logResult.finalScreenshotUrl,
                    capturedAt: data.timestamp || new Date(),
                    productivity: data.violation ? 'UNPRODUCTIVE' : (logResult?.productivity || 'NEUTRAL'),
                    employeeName: agent.employee.fullName,
                    taskId: validatedTaskId,
                    violation: !!data.violation,
                    violationType: data.violationType || null
                });
            } else if (data.screenshotUrl) {
                // Helps debug live mismatch: agent sent screenshot but DB/storage save failed.
                console.warn(`[AgentController] Screenshot event skipped (not persisted) for employee ${employeeId}`);
            }

            // 1b. If activity violation detected, emit alert
            if (data.violation) {
                io.to(room).emit('alert:violation', {
                    employeeId,
                    employeeName: agent.employee.fullName,
                    appName: data.activeApp,
                    windowTitle: data.activeWindow,
                    violationType: data.violationType || 'BLACKLISTED_ACTIVITY',
                    taskId: validatedTaskId,
                    timestamp: data.timestamp || new Date()
                });
            }

            // 2. Update activity stream (with taskId)
            io.to(room).emit('activity:update', {
                employeeId,
                activeApp: logResult?.cleanAppName || data.activeApp || 'Unknown',
                activeWindow: data.activeWindow || 'Unknown',
                idleTime: data.idleTime || 0,
                productivity: data.violation ? 'UNPRODUCTIVE' : (logResult?.productivity || 'NEUTRAL'),
                location: data.location ? `${data.location.city}, ${data.location.country}` : 'Remote',
                taskId: validatedTaskId,
                timestamp: new Date()
            });

            // 3. Ensure employee shows as ONLINE
            io.to(room).emit('employee:status', {
                employeeId,
                status: (data.idleTime || 0) > 60 ? 'idle' : 'online'
            });
        }

        return successResponse(res, { taskId: validatedTaskId, violation: !!data.violation }, 'Activity logged');
    } catch (error) {
        console.error('Agent logActivity error:', error);
        return errorResponse(res, error.message || 'Failed to log activity', 500);
    }
};

const getVersion = async (req, res) => {
    try {
        const packageJsonPath = path.join(__dirname, '../../../../agent-source/package.json');
        let version = '1.0.2';
        if (fs.existsSync(packageJsonPath)) {
            const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
            version = pkg.version || '1.0.2';
        }
        
        return successResponse(res, {
            version,
            buildNumber: '1',
            releaseDate: '2026-06-01',
            downloadUrl: '/api/agent/download'
        }, 'Agent version retrieved');
    } catch (error) {
        console.error('Agent getVersion error:', error);
        return errorResponse(res, 'Failed to get version metadata', 500);
    }
};

const getHealth = async (req, res) => {
    return successResponse(res, { status: 'healthy' }, 'Agent health checked successfully');
};

const downloadAgent = async (req, res) => {
    try {
        const filePath = path.join(__dirname, '../../../public/agent/EMS-Tracker-latest.exe');
        
        if (!fs.existsSync(filePath)) {
            return errorResponse(res, 'Agent installer not found. Please contact administrator.', 404);
        }
        
        res.download(filePath, 'EMS-Tracker-latest.exe');
    } catch (error) {
        console.error('Agent download error:', error);
        return errorResponse(res, 'Failed to download agent', 500);
    }
};

const getStatus = async (req, res) => {
    try {
        const employeeId = req.params.employeeId || req.user.employeeId;
        const status = await agentService.getAgentStatus(employeeId);
        
        if (status.status === 'missing') {
            return errorResponse(res, 'Agent record not found', 404);
        }
        
        return successResponse(res, status, 'Agent status retrieved');
    } catch (error) {
        console.error('Get agent status error:', error);
        return errorResponse(res, error.message || 'Failed to get status', 500);
    }
};

const listAgents = async (req, res) => {
    try {
        const organizationId = await getOrganizationId(req);
        const agents = await agentService.getAllAgents(organizationId);
        return successResponse(res, agents, 'Agents list retrieved');
    } catch (error) {
        console.error('List agents error:', error);
        return errorResponse(res, error.message || 'Failed to list agents', 500);
    }
};

const checkDevice = async (req, res) => {
    try {
        const { deviceId } = req.params;
        const agent = await agentService.findAgentByDeviceId(deviceId);
        
        if (!agent) {
            return errorResponse(res, 'Device not registered', 404);
        }

        const agentToken = Buffer.from(`${agent.employeeId}:${agent.deviceId}:INSIGHTFUL`).toString('base64');

        return successResponse(res, {
            employeeId: agent.employeeId,
            employeeName: agent.employee.fullName,
            employeeEmail: agent.employee.email,
            status: agent.status,
            token: agentToken
        }, 'Device recognized');
    } catch (error) {
        console.error('Check device error:', error);
        return errorResponse(res, error.message || 'Check failed', 500);
    }
};

const updateStatus = async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;

        if (!['active', 'rejected', 'pending'].includes(status)) {
            return res.status(400).json({ success: false, message: 'Invalid status' });
        }

        const agent = await agentService.updateAgentStatus(id, status);
        
        // If approved, notify the agent immediately via socket
        if (status === 'active') {
            const io = getIO();
            if (io) {
                console.log(`Emitting agent:approved for employee: ${agent.employeeId}`);
                io.to(`employee_${agent.employeeId}`).emit('agent:approved');
                
                // Also notify dashboard
                io.to(`org_${agent.organizationId || 'default'}`).emit('employee:status', {
                    employeeId: agent.employeeId,
                    status: 'online'
                });
            }
        }

        res.status(200).json({ success: true, data: agent });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

const update = async (req, res) => {
    try {
        const { id } = req.params;
        const agent = await agentService.updateAgent(id, req.body);
        return successResponse(res, agent, 'Agent and employee updated successfully');
    } catch (error) {
        return errorResponse(res, error.message || 'Update failed', 500);
    }
};

const remove = async (req, res) => {
    try {
        const { id } = req.params;
        let agent = await prisma.agent.findUnique({ where: { id } });
        if (!agent) {
            agent = await prisma.agent.findFirst({ where: { employeeId: id } });
        }
        if (!agent) {
            return errorResponse(res, 'Agent device not found', 404);
        }
        await agentService.deleteAgent(agent.id);
        return successResponse(res, null, 'Agent device removed successfully');
    } catch (error) {
        return errorResponse(res, error.message || 'Failed to remove agent', 500);
    }
};

const stopTracking = async (req, res) => {
    try {
        const { employeeId } = req.body;
        if (!employeeId) return errorResponse(res, 'Employee ID is required', 400);

        await agentService.stopTracking(employeeId);
        return successResponse(res, null, 'Tracking stopped and employee clocked out');
    } catch (error) {
        console.error('Agent stopTracking error:', error);
        return errorResponse(res, error.message || 'Stop tracking failed', 500);
    }
};

const handleIdleActivity = async (req, res) => {
    try {
        const { employeeId, taskId, status, idleDuration, timestamp, idleStartTime } = req.body;
        const authHeader = req.headers['x-agent-auth'] || req.headers['X-Agent-Auth'] || req.headers.authorization;

        if (!employeeId || !status) {
            return errorResponse(res, 'Employee ID and Status are required', 400);
        }

        // Validate and sanitize taskId
        const validatedTaskId = (typeof taskId === 'string' && taskId.trim().length > 0)
            ? taskId.trim()
            : null;

        // Token verification
        if (authHeader) {
            const raw = authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : authHeader;
            try {
                const decoded = Buffer.from(raw, 'base64').toString('ascii');
                if (!decoded.includes(employeeId) || !decoded.includes('INSIGHTFUL')) {
                    return errorResponse(res, 'Unauthorized agent request', 401);
                }
            } catch (e) {
                // Ignore base64 decode error if jwt used
            }
        }

        // Find Employee with organization, team, and agent info
        const employee = await prisma.employee.findUnique({
            where: { id: employeeId },
            include: { team: true, organization: true, agent: true }
        });

        if (!employee) {
            return errorResponse(res, 'Employee not found', 404);
        }

        const organizationId = employee.organizationId;
        const parsedIdleDuration = parseInt(idleDuration, 10) || 600;
        let emailResult = null;

        // Safely check if taskId exists in DB to satisfy foreign key constraint
        let validTaskIdForDb = null;
        if (validatedTaskId) {
            try {
                const taskExists = await prisma.task.findUnique({ where: { id: validatedTaskId }, select: { id: true } });
                if (taskExists) validTaskIdForDb = taskExists.id;
            } catch (e) {
                // Ignore non-UUID or non-existent taskId safely
            }
        }

        if (status === 'IDLE') {
            // 1. Update Employee status in DB
            await prisma.employee.update({
                where: { id: employeeId },
                data: { status: 'IDLE' }
            });

            // 2. Save Idle Session in ActivityLog
            await prisma.activityLog.create({
                data: {
                    activityType: 'IDLE',
                    productivity: 'UNPRODUCTIVE',
                    duration: parsedIdleDuration,
                    timestamp: timestamp ? new Date(timestamp) : new Date(),
                    appWebsite: 'Away from Computer (Idle)',
                    employeeId,
                    taskId: validTaskIdForDb,
                    organizationId
                }
            });

            // 3. Find assigned Manager or Admin for Email Alert
            let manager = null;
            if (employee.teamId) {
                manager = await prisma.employee.findFirst({
                    where: { teamId: employee.teamId, role: 'MANAGER' }
                });
            }
            if (!manager) {
                manager = await prisma.employee.findFirst({
                    where: { organizationId, role: 'MANAGER' }
                });
            }
            if (!manager) {
                const adminUser = await prisma.user.findFirst({
                    where: { role: 'ADMIN' }
                });
                if (adminUser) {
                    manager = { fullName: adminUser.name || 'Administrator', email: adminUser.email };
                }
            }

            // 4. Send Email Notification via Nodemailer
            try {
                emailResult = await sendIdleAlertEmail({
                    employee,
                    manager,
                    idleDuration: parsedIdleDuration,
                    taskId: validatedTaskId,
                    timestamp: timestamp || new Date().toISOString()
                });
            } catch (emailErr) {
                console.error('[AgentController] Error sending idle notification email:', emailErr.message);
            }

            // 5. Emit Socket.IO real-time events to update Admin Dashboard
            const io = getIO();
            if (io && organizationId) {
                const room = `org_${organizationId}`;
                io.to(room).emit('employee:status', {
                    employeeId,
                    status: 'idle'
                });
                io.to(room).emit('activity:update', {
                    employeeId,
                    activeApp: 'Away from Computer (Idle)',
                    idleTime: parsedIdleDuration,
                    productivity: 'UNPRODUCTIVE',
                    taskId: validatedTaskId,
                    timestamp: new Date()
                });
                io.to(room).emit('alert:idle', {
                    employeeId,
                    employeeName: employee.fullName,
                    idleDuration: parsedIdleDuration,
                    managerEmail: manager?.email || null,
                    timestamp: new Date()
                });
            }

            console.log(`[AgentController] IDLE event recorded for ${employee.fullName} (${parsedIdleDuration}s). Alert email sent: ${emailResult?.sent ? 'Yes' : 'Simulated'}`);
        } else if (status === 'RESUMED' || status === 'ACTIVE') {
            // Employee resumed activity
            await prisma.employee.update({
                where: { id: employeeId },
                data: { status: 'ACTIVE' }
            });

            const io = getIO();
            if (io && organizationId) {
                const room = `org_${organizationId}`;
                io.to(room).emit('employee:status', {
                    employeeId,
                    status: 'online'
                });
                io.to(room).emit('activity:update', {
                    employeeId,
                    activeApp: 'Desktop Activity',
                    idleTime: 0,
                    productivity: 'PRODUCTIVE',
                    taskId: validatedTaskId,
                    timestamp: new Date()
                });
            }

            console.log(`[AgentController] RESUMED activity event recorded for ${employee.fullName}. Employee is now ACTIVE.`);
        }

        return successResponse(res, {
            employeeId,
            status,
            taskId: validatedTaskId,
            idleDuration: parsedIdleDuration,
            emailSent: emailResult?.sent || false,
            simulated: emailResult?.simulated || false
        }, `Idle activity status '${status}' processed successfully`);
    } catch (error) {
        console.error('handleIdleActivity error:', error);
        return errorResponse(res, error.message || 'Failed to process idle activity', 500);
    }
};

/**
 * Get active projects and window-title regex patterns for auto project mapping
 */
const getAgentProjects = async (req, res) => {
    try {
        const employeeId = req.user?.employeeId;
        if (!employeeId) return errorResponse(res, 'Employee ID is required', 400);

        const employee = await prisma.employee.findUnique({
            where: { id: employeeId },
            select: { organizationId: true }
        });

        if (!employee) return errorResponse(res, 'Employee not found', 404);

        const projects = await prisma.project.findMany({
            where: { organizationId: employee.organizationId },
            select: {
                id: true,
                name: true,
                description: true,
                tasks: {
                    select: { id: true, name: true, status: true }
                }
            }
        });

        const mapped = projects.map(p => ({
            id: p.id,
            name: p.name,
            regexPattern: `\\b${p.name.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\b`,
            tasks: p.tasks
        }));

        return successResponse(res, mapped, 'Projects for agent auto-mapping retrieved successfully');
    } catch (error) {
        console.error('getAgentProjects error:', error);
        return errorResponse(res, error.message || 'Failed to retrieve projects for agent', 500);
    }
};

module.exports = {
    register,
    heartbeat,
    logActivity,
    handleIdleActivity,
    getAgentProjects,
    downloadAgent,
    getVersion,
    getHealth,
    getStatus,
    listAgents,
    updateStatus,
    update,
    remove,
    checkDevice,
    stopTracking
};
