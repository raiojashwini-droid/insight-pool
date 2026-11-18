const express = require('express');
const router = express.Router();
const activityController = require('./activity.controller');
const authenticate = require('../../middlewares/auth.middleware');
const authorize = require('../../middlewares/role.middleware');

// All activity routes require authentication
router.use(authenticate);

router.post('/log', activityController.createActivityLog);
router.get('/employee/:employeeId', activityController.getEmployeeActivity);
router.get('/team/:teamId', activityController.getTeamActivity);
router.get('/team/:teamId/summary', activityController.getTeamSummary);
router.get('/employee/:employeeId/summary', activityController.getEmployeeSummary);
router.get('/timeline', activityController.getTimelineReport);
router.get('/organization', authorize(['ADMIN', 'MANAGER']), activityController.getOrganizationActivity);
router.get('/summary', authorize(['ADMIN', 'MANAGER', 'EMPLOYEE']), activityController.getOrganizationSummary);

module.exports = router;
