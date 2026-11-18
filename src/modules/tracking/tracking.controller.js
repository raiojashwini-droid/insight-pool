const trackingService = require('./tracking.service');
const { successResponse, errorResponse } = require('../../utils/response');

const upload = async (req, res) => {
    try {
        const { employeeId, screenshotUrl, videoUrl, activityStatus, location } = req.body;
        
        const tracking = await trackingService.saveTracking({
            employeeId: employeeId || req.user?.employeeId,
            screenshotUrl,
            videoUrl,
            activityStatus,
            location
        });

        return successResponse(res, tracking, 'Tracking data uploaded');
    } catch (error) {
        console.error('Tracking upload error:', error);
        return errorResponse(res, error.message || 'Upload failed', 500);
    }
};

const getHistory = async (req, res) => {
    try {
        const { employeeId } = req.params;
        const { startDate, endDate } = req.query;
        
        const history = await trackingService.getTrackingHistory(employeeId, { startDate, endDate });
        return successResponse(res, history, 'Tracking history retrieved');
    } catch (error) {
        console.error('Get tracking history error:', error);
        return errorResponse(res, error.message || 'Failed to get history', 500);
    }
};

const getProfiles = async (req, res) => {
    try {
        const orgId = req.user.organizationId;
        const profiles = await trackingService.getProfiles(orgId);
        return successResponse(res, profiles, 'Tracking profiles retrieved');
    } catch (error) {
        console.error('Get tracking profiles error:', error);
        return errorResponse(res, error.message || 'Failed to get profiles', 500);
    }
};

const createProfile = async (req, res) => {
    try {
        const orgId = req.user.organizationId;
        const profile = await trackingService.createProfile(orgId, req.body);
        return successResponse(res, profile, 'Tracking profile created', 201);
    } catch (error) {
        console.error('Create tracking profile error:', error);
        return errorResponse(res, error.message || 'Failed to create profile', 500);
    }
};

const updateProfile = async (req, res) => {
    try {
        const orgId = req.user.organizationId;
        const profile = await trackingService.updateProfile(req.params.id, orgId, req.body);
        return successResponse(res, profile, 'Tracking profile updated');
    } catch (error) {
        console.error('Update tracking profile error:', error);
        return errorResponse(res, error.message || 'Failed to update profile', 500);
    }
};

const deleteProfile = async (req, res) => {
    try {
        const orgId = req.user.organizationId;
        await trackingService.deleteProfile(req.params.id, orgId);
        return successResponse(res, null, 'Tracking profile deleted');
    } catch (error) {
        console.error('Delete tracking profile error:', error);
        return errorResponse(res, error.message || 'Failed to delete profile', 500);
    }
};

const getAdvancedSettings = async (req, res) => {
    try {
        const orgId = req.user.organizationId;
        const settings = await trackingService.getAdvancedSettings(orgId);
        return successResponse(res, settings, 'Advanced tracking settings retrieved');
    } catch (error) {
        console.error('Get advanced tracking settings error:', error);
        return errorResponse(res, error.message || 'Failed to get advanced settings', 500);
    }
};

const updateAdvancedSettings = async (req, res) => {
    try {
        const orgId = req.user.organizationId;
        const settings = await trackingService.updateAdvancedSettings(orgId, req.body);
        return successResponse(res, settings, 'Advanced tracking settings updated');
    } catch (error) {
        console.error('Update advanced tracking settings error:', error);
        return errorResponse(res, error.message || 'Failed to update advanced settings', 500);
    }
};

module.exports = {
    upload,
    getHistory,
    getProfiles,
    createProfile,
    updateProfile,
    deleteProfile,
    getAdvancedSettings,
    updateAdvancedSettings,
};
