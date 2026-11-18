const express = require('express');
const router = express.Router();
const trackingController = require('./tracking.controller');
const authMiddleware = require('../../middlewares/auth.middleware');

router.use(authMiddleware);

// Agent uploads
router.post('/upload', trackingController.upload);

// History
router.get('/history/:employeeId', trackingController.getHistory);

// Profiles CRUD
router.get('/profiles', trackingController.getProfiles);
router.post('/profiles', trackingController.createProfile);
router.put('/profiles/:id', trackingController.updateProfile);
router.delete('/profiles/:id', trackingController.deleteProfile);

// Advanced tracking settings
router.get('/advanced', trackingController.getAdvancedSettings);
router.put('/advanced', trackingController.updateAdvancedSettings);

module.exports = router;
