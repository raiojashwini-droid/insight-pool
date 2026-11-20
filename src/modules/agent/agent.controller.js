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

        // 2. Check if employee already has an agent in the DB (e.g. DEV-TEST-0C3B)
        const existingEmployeeAgent = await prisma.agent.findUnique({
            where: { employeeId: targetEmployeeId }
        });

        // Use existing assigned device ID from database if it exists, otherwise use deviceId from client
        const effectiveDeviceId = (existingEmployeeAgent && existingEmployeeAgent.deviceId)
            ? existingEmployeeAgent.deviceId
            : (deviceId || `DEV-${targetEmployeeId.substring(0, 8).toUpperCase()}`);

        // Clear any other agent registered with this effectiveDeviceId (to prevent unique constraint failure)
        const existingDeviceAgent = await prisma.agent.findUnique({
            where: { deviceId: effectiveDeviceId }
        });

        if (existingDeviceAgent && existingDeviceAgent.employeeId !== targetEmployeeId) {
            console.log(`Removing old agent record for device: ${effectiveDeviceId} (previously employee: ${existingDeviceAgent.employeeId})`);
            await prisma.agent.delete({ where: { deviceId: effectiveDeviceId } });
        }

        // 3. Register Agent
        const formattedSystemInfo = typeof systemInfo === 'object' && systemInfo !== null
            ? JSON.stringify(systemInfo)
            : (systemInfo ? String(systemInfo) : null);

        const agent = await agentService.registerAgent(targetEmployeeId, effectiveDeviceId, formattedSystemInfo);

        // Simple token for agent security
        const agentToken = Buffer.from(`${targetEmployeeId}:${effectiveDeviceId}:INSIGHTFUL`).toString('base64');

        return successResponse(res, { agent, token: agentToken }, 'Agent registration received and approved');
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
        if (agent.status === 'rejected' || agent.status === 'pending') {
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

        if (agent.status === 'rejected' || agent.status === 'pending') {
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

const GITHUB_AGENT_DOWNLOAD_URL = 'https://raw.githubusercontent.com/ashilata62/employee-monitoring/main/employee-monitoirng-backend/public/agent/EMS-Tracker-latest.exe';

const downloadAgent = async (req, res) => {
    try {
        const primaryPath = path.join(__dirname, '../../../public/agent/EMS-Tracker-latest.exe');
        const altPath = path.join(__dirname, '../../../public/agent/Insightful Agent Setup 1.0.2.exe');
        const targetPath = fs.existsSync(primaryPath) ? primaryPath : (fs.existsSync(altPath) ? altPath : null);

        if (targetPath) {
            return res.download(targetPath, 'EMS-Tracker-latest.exe');
        }

        // If executable not present in local container disk, redirect to GitHub global CDN
        return res.redirect(GITHUB_AGENT_DOWNLOAD_URL);
    } catch (error) {
        console.error('Agent download error:', error);
        return res.redirect(GITHUB_AGENT_DOWNLOAD_URL);
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
        const { employeeId, taskId, status, idleDuration, timestamp, idleStartTime, source } = req.body;
        const authHeader = req.headers['x-agent-auth'] || req.headers['X-Agent-Auth'] || req.headers.authorization;

        if (!employeeId || !status) {
            return errorResponse(res, 'Employee ID and Status are required', 400);
        }

        // Validate and sanitize taskId
        const validatedTaskId = (typeof taskId === 'string' && taskId.trim().length > 0)
            ? taskId.trim()
            : null;

        // Token verification (supports both Desktop Agent Base64 token and Web Browser JWT token)
        if (authHeader) {
            const raw = authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : authHeader;
            let isAuthorized = false;

            // 1. Check if Desktop Agent token
            try {
                const decoded = Buffer.from(raw, 'base64').toString('ascii');
                if (decoded.includes('INSIGHTFUL') && decoded.includes(employeeId)) {
                    isAuthorized = true;
                }
            } catch (e) { }

            // 2. Check if valid JWT (Web browser session)
            if (!isAuthorized) {
                try {
                    const { verifyToken } = require('../../utils/jwt');
                    const jwtUser = verifyToken(raw);
                    if (jwtUser) {
                        isAuthorized = true;
                    }
                } catch (jwtErr) { }
            }

            // 3. Allow WEB_AGENT source
            if (!isAuthorized && source === 'WEB_AGENT') {
                isAuthorized = true;
            }

            if (!isAuthorized) {
                return errorResponse(res, 'Unauthorized agent request', 401);
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

        // Bypassing inactivity and idle tracking for administrators and managers
        const empRole = (employee.role || '').toUpperCase();
        if (empRole === 'ADMIN' || empRole === 'MANAGER') {
            return successResponse(res, { message: 'Inactivity tracking is bypassed for administrative and managerial roles.' });
        }

        const organizationId = employee.organizationId;
        const parsedIdleDuration = parseInt(idleDuration, 10) || 0;
        const now = new Date();
        const io = getIO();
        const room = organizationId ? `org_${organizationId}` : null;
        const effectiveSource = source || 'DESKTOP_AGENT';
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

        if (status === 'PASSIVE') {
            // Initial 1-min inactivity detection
            if (io && room) {
                io.to(room).emit('employee:status', {
                    employeeId,
                    status: 'passive',
                    idleDuration: parsedIdleDuration,
                    lastActiveAt: employee.lastActiveAt || now
                });
            }
        } else if (status === 'IDLE_WARNING') {
            // 5-min warning threshold reached
            if (io && room) {
                io.to(room).emit('employee:status', {
                    employeeId,
                    status: 'idle_warning',
                    idleDuration: parsedIdleDuration,
                    idleStartTime: idleStartTime ? new Date(idleStartTime) : now
                });
            }
        } else if (status === 'IDLE') {
            // 10-min idle threshold reached
            const parsedStartTime = idleStartTime
                ? new Date(idleStartTime)
                : new Date(now.getTime() - parsedIdleDuration * 1000);

            // 1. Check if an open idle session already exists
            let openSession = await prisma.idleSession.findFirst({
                where: { employeeId, idleEndTime: null },
                orderBy: { createdAt: 'desc' }
            });

            if (!openSession) {
                openSession = await prisma.idleSession.create({
                    data: {
                        employeeId,
                        organizationId,
                        activityStatus: 'IDLE',
                        lastActivityAt: employee.lastActiveAt || parsedStartTime,
                        idleStartTime: parsedStartTime,
                        idleDuration: parsedIdleDuration,
                        notificationType: 'IDLE_ALERT_10MIN',
                        notificationSentAt: now,
                        agentConnectionStatus: 'CONNECTED',
                        source: effectiveSource
                    }
                });
            }

            // 2. Update Employee status in DB
            await prisma.employee.update({
                where: { id: employeeId },
                data: {
                    status: 'IDLE',
                    idleStartTime: parsedStartTime
                }
            });

            // 3. Save in ActivityLog for timesheet compatibility
            await prisma.activityLog.create({
                data: {
                    activityType: 'IDLE',
                    productivity: 'UNPRODUCTIVE',
                    duration: parsedIdleDuration,
                    timestamp: timestamp ? new Date(timestamp) : now,
                    appWebsite: 'Away from Computer (Idle)',
                    employeeId,
                    taskId: validTaskIdForDb,
                    organizationId
                }
            });

            // 4. Log Alert in AlertLog
            let alertRecord = null;
            try {
                alertRecord = await prisma.alertLog.create({
                    data: {
                        organizationId,
                        employeeId,
                        ruleType: 'IDLE_TIMEOUT',
                        trigger: '10_MIN_INACTIVITY',
                        severity: 'warning',
                        message: `Employee ${employee.fullName} has been inactive for 10 minutes.`,
                        metadata: JSON.stringify({
                            idleDuration: parsedIdleDuration,
                            idleStartTime: parsedStartTime,
                            lastActivityAt: employee.lastActiveAt || parsedStartTime,
                            source: effectiveSource
                        })
                    }
                });
            } catch (alertErr) {
                console.error('[AgentController] Error creating AlertLog:', alertErr.message);
            }

            // 5. Find assigned Manager or Admin for Email Alert
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

            // 6. Send Email Notification via Nodemailer
            try {
                emailResult = await sendIdleAlertEmail({
                    employee,
                    manager,
                    idleDuration: parsedIdleDuration,
                    taskId: validatedTaskId,
                    timestamp: timestamp || now.toISOString()
                });
            } catch (emailErr) {
                console.error('[AgentController] Error sending idle notification email:', emailErr.message);
            }

            // 7. Emit Socket.IO real-time events to update Admin Dashboard
            if (io && room) {
                io.to(room).emit('employee:status', {
                    employeeId,
                    status: 'idle',
                    idleStartTime: parsedStartTime,
                    idleDuration: parsedIdleDuration
                });
                io.to(room).emit('activity:update', {
                    employeeId,
                    activeApp: 'Away from Computer (Idle)',
                    idleTime: parsedIdleDuration,
                    productivity: 'UNPRODUCTIVE',
                    taskId: validatedTaskId,
                    timestamp: now
                });
                io.to(room).emit('alert:idle', {
                    employeeId,
                    employeeName: employee.fullName,
                    idleDuration: parsedIdleDuration,
                    idleStartTime: parsedStartTime,
                    managerEmail: manager?.email || null,
                    timestamp: now
                });
                io.to(room).emit('alert:new', {
                    id: alertRecord?.id || `idle-${Date.now()}`,
                    employeeId,
                    employeeName: employee.fullName,
                    title: 'Employee Inactivity Alert',
                    message: `Employee ${employee.fullName} has been inactive for 10 minutes.`,
                    severity: 'warning',
                    ruleType: 'IDLE_TIMEOUT',
                    trigger: '10_MIN_INACTIVITY',
                    idleDuration: parsedIdleDuration,
                    createdAt: now
                });
                io.to(room).emit('admin:idle_alert', {
                    employeeId,
                    employeeName: employee.fullName,
                    idleDuration: parsedIdleDuration,
                    idleStartTime: parsedStartTime,
                    lastActivityAt: employee.lastActiveAt || parsedStartTime,
                    status: 'IDLE'
                });
            }

            console.log(`[AgentController] IDLE event recorded for ${employee.fullName} (${parsedIdleDuration}s). Alert email sent: ${emailResult?.sent ? 'Yes' : 'Simulated'}`);
        } else if (status === 'RESUMED' || status === 'ACTIVE') {
            // Employee resumed activity: genuine mouse/keyboard input detected
            const openSession = await prisma.idleSession.findFirst({
                where: { employeeId, idleEndTime: null },
                orderBy: { createdAt: 'desc' }
            });

            let finalDuration = parsedIdleDuration;
            if (openSession) {
                finalDuration = Math.max(
                    openSession.idleDuration || 0,
                    Math.round((now.getTime() - new Date(openSession.idleStartTime).getTime()) / 1000)
                );
                await prisma.idleSession.update({
                    where: { id: openSession.id },
                    data: {
                        idleEndTime: now,
                        idleDuration: finalDuration,
                        activityStatus: 'ACTIVE'
                    }
                });
            }

            // Update Employee status and timestamps in DB
            await prisma.employee.update({
                where: { id: employeeId },
                data: {
                    status: 'ACTIVE',
                    lastActiveAt: now,
                    idleStartTime: null,
                    totalIdleSeconds: { increment: Math.max(0, finalDuration) }
                }
            });

            if (io && room) {
                io.to(room).emit('employee:status', {
                    employeeId,
                    status: 'online',
                    lastActiveAt: now
                });
                io.to(room).emit('activity:update', {
                    employeeId,
                    activeApp: 'Desktop Activity',
                    idleTime: 0,
                    productivity: 'PRODUCTIVE',
                    taskId: validatedTaskId,
                    timestamp: now
                });
                io.to(room).emit('employee:idle_resumed', {
                    employeeId,
                    employeeName: employee.fullName,
                    idleDuration: finalDuration,
                    resumedAt: now
                });
            }

            console.log(`[AgentController] RESUMED activity event recorded for ${employee.fullName} after ${finalDuration}s idle. Status: ACTIVE.`);
        } else if (status === 'AUTO_CLOCKED_OUT') {
            console.log(`[AgentController] AUTO_CLOCKED_OUT received for ${employee.fullName} (${employeeId}).`);
            try {
                const attendanceService = require('../attendance/attendance.service');
                await attendanceService.clockOut(employeeId);
            } catch (cErr) {
                // If already clocked out, ignore
            }
            await prisma.employee.update({
                where: { id: employeeId },
                data: { status: 'OFFLINE' }
            });
            if (io && room) {
                io.to(room).emit('employee:status', {
                    employeeId,
                    status: 'OFFLINE'
                });
                io.to(room).emit('attendance:update', {
                    employeeId,
                    type: 'clock-out',
                    auto: true
                });
            }
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

const handleIdleResponse = async (req, res) => {
    try {
        const { employeeId, response, taskId } = req.body;
        if (!employeeId || !response) {
            return errorResponse(res, 'Employee ID and Response (WORKING or BREAK) are required', 400);
        }

        const employee = await prisma.employee.findUnique({
            where: { id: employeeId }
        });
        if (!employee) return errorResponse(res, 'Employee not found', 404);

        const now = new Date();
        const organizationId = employee.organizationId;
        const room = organizationId ? `org_${organizationId}` : null;
        const io = getIO();

        // Update latest idle session
        const latestSession = await prisma.idleSession.findFirst({
            where: { employeeId },
            orderBy: { createdAt: 'desc' }
        });

        if (latestSession) {
            await prisma.idleSession.update({
                where: { id: latestSession.id },
                data: {
                    employeeResponse: response,
                    employeeResponseAt: now,
                    ...(latestSession.idleEndTime ? {} : {
                        idleEndTime: now,
                        activityStatus: response === 'WORKING' ? 'ACTIVE' : 'BREAK'
                    })
                }
            });
        }

        if (response === 'BREAK') {
            await prisma.employee.update({
                where: { id: employeeId },
                data: { status: 'BREAK' }
            });
            if (io && room) {
                io.to(room).emit('employee:status', { employeeId, status: 'break' });
            }
        } else if (response === 'WORKING') {
            await prisma.employee.update({
                where: { id: employeeId },
                data: { status: 'ACTIVE', lastActiveAt: now, idleStartTime: null }
            });
            if (io && room) {
                io.to(room).emit('employee:status', { employeeId, status: 'online', lastActiveAt: now });
                io.to(room).emit('employee:idle_resumed', {
                    employeeId,
                    employeeName: employee.fullName,
                    idleDuration: latestSession?.idleDuration || 0,
                    resumedAt: now
                });
            }
        }

        return successResponse(res, {
            employeeId,
            response,
            recordedAt: now
        }, `Idle confirmation '${response}' recorded successfully`);
    } catch (error) {
        console.error('handleIdleResponse error:', error);
        return errorResponse(res, error.message || 'Failed to record idle confirmation', 500);
    }
};

const getIdleSessions = async (req, res) => {
    try {
        const { employeeId } = req.params;
        const sessions = await prisma.idleSession.findMany({
            where: { employeeId },
            orderBy: { createdAt: 'desc' },
            take: 50
        });

        const employee = await prisma.employee.findUnique({
            where: { id: employeeId },
            select: {
                id: true,
                fullName: true,
                status: true,
                lastActiveAt: true,
                idleStartTime: true,
                totalIdleSeconds: true
            }
        });

        return successResponse(res, {
            employee,
            sessions
        }, 'Idle sessions retrieved successfully');
    } catch (error) {
        console.error('getIdleSessions error:', error);
        return errorResponse(res, error.message || 'Failed to retrieve idle sessions', 500);
    }
};

const getActivitySummary = async (req, res) => {
    try {
        const { employeeId } = req.params;
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);

        const employee = await prisma.employee.findUnique({
            where: { id: employeeId },
            include: { agent: true }
        });
        if (!employee) return errorResponse(res, 'Employee not found', 404);

        const idleSessions = await prisma.idleSession.findMany({
            where: {
                employeeId,
                createdAt: { gte: todayStart }
            },
            orderBy: { createdAt: 'asc' }
        });

        const activityLogs = await prisma.activityLog.findMany({
            where: {
                employeeId,
                timestamp: { gte: todayStart }
            }
        });

        const totalIdleTime = idleSessions.reduce((acc, s) => acc + (s.idleDuration || 0), 0);
        const totalActiveTime = activityLogs
            .filter(l => l.productivity === 'PRODUCTIVE' || l.activityType === 'ACTIVE')
            .reduce((acc, l) => acc + (l.duration || 0), 0);

        const firstActivity = activityLogs.length > 0 ? activityLogs[0].timestamp : employee.lastActiveAt;
        const lastActivity = employee.lastActiveAt || (activityLogs.length > 0 ? activityLogs[activityLogs.length - 1].timestamp : null);

        return successResponse(res, {
            employeeId,
            fullName: employee.fullName,
            status: employee.status,
            lastActiveAt: employee.lastActiveAt,
            idleStartTime: employee.idleStartTime,
            agentConnected: employee.agent?.status === 'active',
            summary: {
                totalActiveTime,
                totalIdleTime,
                totalBreakTime: 0,
                idleSessionCount: idleSessions.length,
                notificationsSent: idleSessions.filter(s => !!s.notificationType).length,
                firstActivityTime: firstActivity,
                lastActivityTime: lastActivity
            },
            recentSessions: idleSessions.slice(-10)
        }, 'Activity summary generated successfully');
    } catch (error) {
        console.error('getActivitySummary error:', error);
        return errorResponse(res, error.message || 'Failed to generate activity summary', 500);
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
    handleIdleResponse,
    getIdleSessions,
    getActivitySummary,
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
