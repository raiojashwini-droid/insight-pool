const prisma = require('../../config/db');

/**
 * Save consolidated tracking data from the agent
 */
const saveTracking = async (data) => {
    const { employeeId, screenshotUrl, videoUrl, activityStatus, location } = data;

    return await prisma.tracking.create({
        data: {
            employeeId,
            screenshotUrl,
            videoUrl,
            activityStatus,
            location,
            source: 'AGENT',
            timestamp: new Date()
        }
    });
};

/**
 * Get tracking history for an employee
 */
const getTrackingHistory = async (employeeId, params = {}) => {
    const { startDate, endDate } = params;
    
    return await prisma.tracking.findMany({
        where: {
            employeeId,
            timestamp: {
                gte: startDate ? new Date(startDate) : undefined,
                lte: endDate ? new Date(endDate) : undefined,
            }
        },
        orderBy: { timestamp: 'desc' }
    });
};

/**
 * Get all tracking profiles for an organization
 */
const getProfiles = async (organizationId) => {
    return await prisma.trackingSetting.findMany({
        where: { organizationId },
        orderBy: { createdAt: 'asc' }
    });
};

/**
 * Create a new tracking profile
 */
const createProfile = async (organizationId, data) => {
    return await prisma.trackingSetting.create({
        data: {
            title: data.title || 'Standard Profile',
            computerType: data.computerType || 'company',
            isDefault: Boolean(data.isDefault),
            visibility: data.visibility || 'visible',
            screenshotsPerHour: Number(data.screenshotsPerHour || 0),
            allowAccessScreenshots: Boolean(data.allowAccessScreenshots),
            allowRemoveScreenshots: Boolean(data.allowRemoveScreenshots),
            breakTime: Number(data.breakTime || 0),
            allowOverBreak: Boolean(data.allowOverBreak),
            allowNewBreaks: Boolean(data.allowNewBreaks),
            idleTime: Number(data.idleTime || 2),
            trackingScenario: data.trackingScenario || 'unlimited',
            workingDays: data.workingDays || ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
            trackTasks: Boolean(data.trackTasks),
            allowAddTasks: Boolean(data.allowAddTasks),
            permissions: data.permissions || { canAnalyze: false, canSeeApps: false, canAddManual: false },
            organizationId
        }
    });
};

/**
 * Update an existing tracking profile
 */
const updateProfile = async (id, organizationId, data) => {
    return await prisma.trackingSetting.update({
        where: { id, organizationId },
        data: {
            title: data.title,
            computerType: data.computerType,
            isDefault: data.isDefault !== undefined ? Boolean(data.isDefault) : undefined,
            visibility: data.visibility,
            screenshotsPerHour: data.screenshotsPerHour !== undefined ? Number(data.screenshotsPerHour) : undefined,
            allowAccessScreenshots: data.allowAccessScreenshots !== undefined ? Boolean(data.allowAccessScreenshots) : undefined,
            allowRemoveScreenshots: data.allowRemoveScreenshots !== undefined ? Boolean(data.allowRemoveScreenshots) : undefined,
            breakTime: data.breakTime !== undefined ? Number(data.breakTime) : undefined,
            allowOverBreak: data.allowOverBreak !== undefined ? Boolean(data.allowOverBreak) : undefined,
            allowNewBreaks: data.allowNewBreaks !== undefined ? Boolean(data.allowNewBreaks) : undefined,
            idleTime: data.idleTime !== undefined ? Number(data.idleTime) : undefined,
            trackingScenario: data.trackingScenario,
            workingDays: data.workingDays,
            trackTasks: data.trackTasks !== undefined ? Boolean(data.trackTasks) : undefined,
            allowAddTasks: data.allowAddTasks !== undefined ? Boolean(data.allowAddTasks) : undefined,
            permissions: data.permissions
        }
    });
};

/**
 * Delete a tracking profile
 */
const deleteProfile = async (id, organizationId) => {
    return await prisma.trackingSetting.delete({
        where: { id, organizationId }
    });
};

/**
 * Get advanced tracking settings for an organization (creates default if not found)
 */
const getAdvancedSettings = async (organizationId) => {
    let settings = await prisma.advancedTrackingSetting.findUnique({
        where: { organizationId }
    });

    if (!settings && organizationId) {
        settings = await prisma.advancedTrackingSetting.create({
            data: {
                organizationId,
                shiftThreshold: 4,
                strictTime: false,
                inactivityPopups: true,
                identificationMode: 'hwid',
                showEngagement: false,
                useActiveDirectory: true,
                adEmail: true,
                adTeam: true,
                adTrackingSettings: false
            }
        });
    }

    return settings;
};

/**
 * Update advanced tracking settings for an organization
 */
const updateAdvancedSettings = async (organizationId, data) => {
    return await prisma.advancedTrackingSetting.upsert({
        where: { organizationId },
        create: {
            organizationId,
            shiftThreshold: Number(data.shiftThreshold || 4),
            strictTime: Boolean(data.strictTime),
            inactivityPopups: Boolean(data.inactivityPopups),
            identificationMode: data.identificationMode || 'hwid',
            showEngagement: Boolean(data.showEngagement),
            useActiveDirectory: Boolean(data.useActiveDirectory),
            adEmail: Boolean(data.adEmail),
            adTeam: Boolean(data.adTeam),
            adTrackingSettings: Boolean(data.adTrackingSettings)
        },
        update: {
            shiftThreshold: data.shiftThreshold !== undefined ? Number(data.shiftThreshold) : undefined,
            strictTime: data.strictTime !== undefined ? Boolean(data.strictTime) : undefined,
            inactivityPopups: data.inactivityPopups !== undefined ? Boolean(data.inactivityPopups) : undefined,
            identificationMode: data.identificationMode,
            showEngagement: data.showEngagement !== undefined ? Boolean(data.showEngagement) : undefined,
            useActiveDirectory: data.useActiveDirectory !== undefined ? Boolean(data.useActiveDirectory) : undefined,
            adEmail: data.adEmail !== undefined ? Boolean(data.adEmail) : undefined,
            adTeam: data.adTeam !== undefined ? Boolean(data.adTeam) : undefined,
            adTrackingSettings: data.adTrackingSettings !== undefined ? Boolean(data.adTrackingSettings) : undefined
        }
    });
};

module.exports = {
    saveTracking,
    getTrackingHistory,
    getProfiles,
    createProfile,
    updateProfile,
    deleteProfile,
    getAdvancedSettings,
    updateAdvancedSettings,
};
