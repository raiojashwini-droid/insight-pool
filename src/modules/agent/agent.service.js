const prisma = require('../../config/db');
const attendanceService = require('../attendance/attendance.service');
const { uploadImageBuffer } = require('../../utils/imageStorage');
const { HEARTBEAT_SECONDS } = require('../../utils/resolveAppActivity');
const { resolveAppActivityForOrg } = require('../../utils/resolveAppActivityForOrg');
const { onAgentPulse, processStaleAttendanceForEmployee } = require('../../utils/attendanceSession');
const { upsertAppUsageLog } = require('../../utils/upsertAppUsageLog');

/**
 * Register a new device agent for an employee
 */
const registerAgent = async (employeeId, deviceId, systemInfo) => {
    // Get employee to find organizationId
    const employee = await prisma.employee.findUnique({
        where: { id: employeeId },
        select: { organizationId: true }
    });

    if (!employee) throw new Error('Employee not found');

    // Upsert agent: update if exists (linked by employeeId), otherwise create
    return await prisma.agent.upsert({
        where: { employeeId },
        update: {
            deviceId,
            systemInfo,
            status: 'active',
            lastSeen: new Date(),
        },
        create: {
            employeeId,
            deviceId,
            systemInfo,
            status: 'active', // Auto-approve for seamless setup
            lastSeen: new Date(),
        },
    });
};

/**
 * Approve a pending agent
 */
const approveAgent = async (agentId) => {
    return await prisma.agent.update({
        where: { id: agentId },
        data: { status: 'active' }
    });
};

/**
 * Update agent status
 */
const updateAgentStatus = async (id, status) => {
    return await prisma.agent.update({
        where: { id },
        data: { status }
    });
};

/**
 * Update agent/employee information
 */
const updateAgent = async (agentId, data) => {
    const { name, email, password } = data;
    
    const agent = await prisma.agent.findUnique({
        where: { id: agentId },
        include: { employee: true }
    });

    if (!agent) throw new Error('Agent not found');

    const updateData = {};
    if (name) updateData.fullName = name;
    if (email) updateData.email = email;

    // Update Employee
    await prisma.employee.update({
        where: { id: agent.employeeId },
        data: updateData
    });

    // Update User if exists
    if (password || email) {
        const userUpdate = {};
        if (email) userUpdate.email = email;
        if (password) {
            const bcrypt = require('bcrypt');
            userUpdate.password = await bcrypt.hash(password, 10);
        }

        await prisma.user.update({
            where: { employeeId: agent.employeeId },
            data: userUpdate
        });
    }

    return agent;
};

/**
 * Delete an agent and its tracking data
 */
const deleteAgent = async (agentId) => {
    const agent = await prisma.agent.findUnique({
        where: { id: agentId }
    });

    if (!agent) throw new Error('Agent not found');

    // Due to relations, we might need to delete tracking data first if not cascaded
    // But for now, we'll try to delete the agent record
    return await prisma.agent.delete({
        where: { id: agentId }
    });
};

/**
 * Update agent heartbeat
 */
const heartbeat = async (deviceId, taskId = null) => {
    const existingAgent = await prisma.agent.findUnique({
        where: { deviceId },
        include: { employee: true }
    });

    if (!existingAgent) throw new Error('Agent not found');

    if (existingAgent.employee?.status === 'DEACTIVATED') {
        const error = new Error('This employee account has been deactivated.');
        error.code = 'ACCOUNT_DEACTIVATED';
        error.statusCode = 403;
        throw error;
    }
    const agent = await prisma.agent.update({
        where: { deviceId },
        data: {
            status: 'active',
            lastSeen: new Date(),
        },
    });

    if (agent?.employeeId) {
        try {
            await onAgentPulse(agent.employeeId, existingAgent.employee?.organizationId || 'default-org-id');
        } catch (err) {
            console.error('[AgentService] Heartbeat attendance pulse failed:', err.message);
        }
    }
    return { ...agent, activeTaskId: taskId || null };
};

/**
 * Log Activity and Screenshot
 */
const logActivity = async (employeeId, data) => {
    const { activeApp, activeWindow, idleTime, screenshotUrl, location, timestamp } = data;
    let screenshotSaved = false;
    let finalScreenshotUrl = null;

    // Get employee for organizationId and verify active status
    const employee = await prisma.employee.findUnique({
        where: { id: employeeId },
        select: { organizationId: true, status: true, teamId: true }
    });

    if (!employee) throw new Error('Employee not found');

    if (employee.status === 'DEACTIVATED') {
        const error = new Error('This employee account has been deactivated.');
        error.code = 'ACCOUNT_DEACTIVATED';
        error.statusCode = 403;
        throw error;
    }
    console.log(`[AgentService] Processing activity for employee: ${employeeId}. Screenshot included: ${!!screenshotUrl}`);

    try {
        await onAgentPulse(employeeId, employee.organizationId);
    } catch (err) {
        if (!err.message.includes('Already clocked in')) {
            console.error(`[AgentService:${employeeId}] Activity pulse failed:`, err.message);
        }
    }
    await processStaleAttendanceForEmployee(employeeId);

    const activityType = (idleTime || 0) > 60 ? 'IDLE' : 'ACTIVE';
    const resolved = await resolveAppActivityForOrg(
        employee.organizationId,
        activeApp,
        activeWindow,
        employee.teamId
    );
    const { cleanAppName, productivity, appCategory, appDomain } = resolved;

    const isViolation = !!data.violation;
    const finalProductivity = isViolation ? 'UNPRODUCTIVE' : productivity;
    const finalActivityType = isViolation ? 'ACTIVE' : activityType;

    console.log(`[AgentService:${employeeId}] Logging activities: App=${cleanAppName}, Idle=${idleTime}s, Productivity=${finalProductivity}, Task=${data.taskId || 'None'}, Violation=${isViolation}`);

    // Resolve active taskId if not explicitly passed by agent
    let activeTaskId = data.taskId || null;
    if (!activeTaskId) {
        try {
            const activeTimer = await prisma.taskTimeLog.findFirst({
                where: { employeeId, isRunning: true },
                select: { taskId: true }
            });
            if (activeTimer) {
                activeTaskId = activeTimer.taskId;
            }
        } catch (e) {
            console.error(`[AgentService:${employeeId}] Failed to resolve active task timer:`, e.message);
        }
    }

    // 1. Save Activity Log
    try {
        let validTaskIdForDb = null;
        if (data.taskId) {
            try {
                const taskExists = await prisma.task.findUnique({ where: { id: data.taskId }, select: { id: true } });
                if (taskExists) validTaskIdForDb = taskExists.id;
            } catch (err) {
                // Ignore non-UUID or non-existent task IDs safely
            }
        }

        // Auto Project Mapping from Window Title & Agent Metadata (Regex Matching)
        let autoMappedProjectId = data.autoMappedProjectId || null;
        let autoMappedProjectName = data.autoMappedProjectName || null;

        if (activeWindow && activeWindow !== 'Unknown') {
            try {
                const orgProjects = await prisma.project.findMany({
                    where: { organizationId: employee.organizationId },
                    include: {
                        tasks: {
                            select: { id: true, name: true, status: true },
                            take: 1
                        }
                    }
                });

                for (const proj of orgProjects) {
                    if (!proj.name) continue;
                    const projPattern = new RegExp(`\\b${proj.name.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\b`, 'i');
                    if (projPattern.test(activeWindow) || projPattern.test(cleanAppName || '')) {
                        autoMappedProjectId = proj.id;
                        autoMappedProjectName = proj.name;

                        if (!validTaskIdForDb && !activeTaskId && proj.tasks.length > 0) {
                            validTaskIdForDb = proj.tasks[0].id;
                        }
                        break;
                    }
                }

                // Automatically credit time to project if matched and active
                if (autoMappedProjectId && finalActivityType === 'ACTIVE') {
                    await prisma.projectTimeLog.create({
                        data: {
                            projectId: autoMappedProjectId,
                            employeeId,
                            duration: HEARTBEAT_SECONDS,
                            type: 'CLOCKED'
                        }
                    }).catch(() => {});
                }
            } catch (projErr) {
                console.error(`[AgentService:${employeeId}] Auto project mapping error:`, projErr.message);
            }
        }

        await prisma.activityLog.create({
            data: {
                employeeId,
                organizationId: employee.organizationId,
                activityType: finalActivityType,
                productivity: finalProductivity,
                duration: HEARTBEAT_SECONDS,
                appWebsite: cleanAppName,
                timestamp: timestamp ? new Date(timestamp) : new Date(),
                ...(validTaskIdForDb ? { taskId: validTaskIdForDb } : (typeof activeTaskId === 'string' ? { taskId: activeTaskId } : {}))
            }
        });
    } catch (e) { console.error(`[AgentService:${employeeId}] ActivityLog failed:`, e.message); }

    // 1b. App usage for Apps & Websites reports
    if (finalActivityType === 'ACTIVE') {
        try {
            await upsertAppUsageLog({
                employeeId,
                organizationId: employee.organizationId,
                appName: cleanAppName,
                domain: appDomain,
                category: appCategory,
                productivity: finalProductivity,
            });
        } catch (e) { console.error(`[AgentService:${employeeId}] AppUsageLog failed:`, e.message); }
    }

    // 2. Update Live Activity
    try {
        await prisma.liveActivity.create({
            data: {
                employeeId,
                organizationId: employee.organizationId,
                activeApp: cleanAppName,
                activeWindow: activeWindow || 'Unknown',
                keystrokes: 0,
                mouseClicks: 0,
                idleTime: idleTime || 0
            }
        });
    } catch (e) { console.error('LiveActivity failed:', e.message); }

    // 2. Save Screenshot if provided
    if (screenshotUrl) {
        let finalUrl = screenshotUrl;
        
        // Handle Base64 strings by saving to Cloudinary (or local fallback)
        if (screenshotUrl.startsWith('data:image/')) {
            try {
                const matches = screenshotUrl.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
                if (matches && matches.length === 3) {
                    const buffer = Buffer.from(matches[2], 'base64');
                    const uploadResult = await uploadImageBuffer(buffer, {
                        format: 'jpeg',
                        quality: 60,
                        folder: `insightful/screenshots/${employee.organizationId}`,
                        fileNamePrefix: `agent_${employeeId}`
                    });
                    finalUrl = uploadResult.imageUrl;
                    console.log(`[AgentService:${employeeId}] Screenshot stored in ${uploadResult.storage}: ${finalUrl}`);
                }
            } catch (err) {
                console.error(`[AgentService:${employeeId}] Failed to store base64 screenshot:`, err.message);
            }
        }

        try {
            const isIdle = (idleTime || 0) > 60;
            const screenshotProductivity = isViolation ? 'UNPRODUCTIVE' : (isIdle ? 'UNPRODUCTIVE' : 'NEUTRAL');
            await prisma.screenshot.create({
                data: {
                    employeeId,
                    organizationId: employee.organizationId,
                    imageUrl: finalUrl,
                    capturedAt: timestamp ? new Date(timestamp) : new Date(),
                    productivity: screenshotProductivity
                }
            });
            screenshotSaved = true;
            finalScreenshotUrl = finalUrl;
            console.log(`[AgentService:${employeeId}] Screenshot record created in DB (Productivity: ${screenshotProductivity})`);
        } catch (e) { console.error(`[AgentService:${employeeId}] Screenshot log failed:`, e.message); }
        
        // Also update tracking for history with the file URL
        data.screenshotUrl = finalUrl; 
    }

    // 3. Save Tracking Data (History + Location)
    const locationStr = location ? `${location.city}, ${location.country}` : 'Unknown';
    try {
        await prisma.tracking.create({
            data: {
                employeeId,
                screenshotUrl: data.screenshotUrl || screenshotUrl,
                activityStatus: 'active',
                location: locationStr,
                source: 'AGENT',
                timestamp: timestamp ? new Date(timestamp) : new Date()
            }
        });
    } catch (e) { console.error(`[AgentService:${employeeId}] Tracking log failed:`, e.message); }

    // 4. Save to LocationLog (for Map) and Update Employee Location
    const hasLat = typeof location?.latitude === 'number' || typeof location?.lat === 'number';
    const hasLng = typeof location?.longitude === 'number' || typeof location?.lon === 'number';
    
    if (location && hasLat && hasLng) {
        const lat = parseFloat(location.latitude || location.lat);
        const lng = parseFloat(location.longitude || location.lon);

        try {
            await prisma.locationLog.create({
                data: {
                    employeeId,
                    organizationId: employee.organizationId,
                    latitude: lat,
                    longitude: lng,
                    source: 'AGENT'
                }
            });
            console.log(`[AgentService:${employeeId}] Location log saved: ${lat}, ${lng}`);
        } catch (e) { console.error(`[AgentService:${employeeId}] LocationLog failed:`, e.message); }

        try {
            await prisma.employee.update({
                where: { id: employeeId },
                data: { 
                    location: location.city || location.country || 'Remote',
                    latitude: lat,
                    longitude: lng
                }
            });
        } catch (e) { 
            // Silent retry or ignore conflict for high-frequency updates
            console.error('Employee coord update conflict skipped:', e.message); 
        }
    }

    // 6. Update Agent lastSeen
    try {
        await prisma.agent.updateMany({
            where: { employeeId },
            data: { lastSeen: new Date(), status: 'active' }
        });
    } catch (e) { console.error('Agent update failed:', e.message); }

    // 7. Background Alert Evaluation (Developer 4 - Non-blocking)
    try {
        const alertsService = require('../alerts/alerts.service');
        // Evaluate Continuous Idle Time
        alertsService.evaluateContinuousIdle({
            employeeId,
            organizationId: employee.organizationId,
            idleTime,
            timestamp
        }).catch(err => console.error('[AgentService] Continuous idle evaluation failed:', err.message));

        // Evaluate Prohibited Application Access & Violation Screenshot Sync
        alertsService.evaluateProhibitedApp({
            employeeId,
            organizationId: employee.organizationId,
            activeApp,
            activeWindow,
            screenshotUrl: finalScreenshotUrl
        }).catch(err => console.error('[AgentService] Prohibited app evaluation failed:', err.message));
    } catch (alertErr) {
        console.error('[AgentService] Alert evaluation trigger failed:', alertErr.message);
    }

    return {
        success: true,
        screenshotSaved,
        finalScreenshotUrl,
        cleanAppName,
        productivity,
        activityType,
    };
};

/**
 * Check if employee has an active agent
 */
const getAgentStatus = async (employeeId) => {
    const agent = await prisma.agent.findUnique({
        where: { employeeId }
    });

    if (!agent) return { active: false, status: 'missing' };

    // Agent is active if status is 'active' AND lastSeen is within 10 minutes
    const isRecent = new Date() - new Date(agent.lastSeen) < 10 * 60 * 1000;
    const isActive = agent.status === 'active' && isRecent;

    return {
        active: isActive, // Online/Recent status
        status: agent.status, // Persistent approval status ('active', 'pending', 'inactive')
        lastSeen: agent.lastSeen,
        deviceId: agent.deviceId
    };
};

const findAgentByDeviceId = async (deviceId) => {
    return await prisma.agent.findUnique({
        where: { deviceId },
        include: { employee: true }
    });
};

/**
 * Get all registered agents
 */
const getAllAgents = async (organizationId) => {
    // 1. Auto-sync any active monitored employees who do not have an agent record yet
    try {
        const empWhere = {
            role: 'EMPLOYEE',
            status: { not: 'DEACTIVATED' },
            ...(organizationId ? { organizationId } : {})
        };
        const monitoredEmployees = await prisma.employee.findMany({
            where: empWhere,
            include: { agent: true }
        });

        for (const emp of monitoredEmployees) {
            if (!emp.agent) {
                const cleanName = (emp.fullName || 'EMP').replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 6);
                const shortId = emp.id.slice(0, 4).toUpperCase();
                const genDeviceId = `DEV-${cleanName}-${shortId}`;

                await prisma.agent.upsert({
                    where: { employeeId: emp.id },
                    create: {
                        employeeId: emp.id,
                        deviceId: genDeviceId,
                        status: 'active',
                        systemInfo: {
                            platform: 'win32',
                            release: '10.0.19045',
                            arch: 'x64',
                            hostname: `DESKTOP-${cleanName}`
                        },
                        lastSeen: new Date(),
                        createdAt: emp.createdAt || new Date()
                    },
                    update: {}
                });
            }
        }
    } catch (autoErr) {
        console.warn('[getAllAgents] Auto agent sync warning:', autoErr.message);
    }

    const where = organizationId ? { employee: { organizationId } } : {};
    return await prisma.agent.findMany({
        where,
        include: {
            employee: {
                select: {
                    id: true,
                    fullName: true,
                    email: true,
                    role: true,
                    status: true,
                    avatar: true,
                    team: {
                        select: { name: true }
                    }
                }
            }
        },
        orderBy: { updatedAt: 'desc' }
    });
};

/**
 * Stop tracking - usually called when agent shuts down or user stops tracking
 */
const stopTracking = async (employeeId) => {
    try {
        // Clock out the employee
        await attendanceService.clockOut(employeeId);
    } catch (err) {
        // Ignore if already clocked out
        if (!err.message.includes('No active clock-in session found')) {
            console.error('[AgentService] Auto clock-out on stopTracking failed:', err.message);
        }
    }
    
    // Update agent lastSeen, but preserve status (keep it 'active' so they can restart easily)
    await prisma.agent.updateMany({
        where: { employeeId },
        data: { lastSeen: new Date() }
    });

    return { success: true };
};

module.exports = {
    registerAgent,
    heartbeat,
    logActivity,
    getAgentStatus,
    getAllAgents,
    updateAgentStatus,
    updateAgent,
    deleteAgent,
    findAgentByDeviceId,
    stopTracking
};
