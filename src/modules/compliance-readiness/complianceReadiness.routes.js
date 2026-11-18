const express = require('express');
const router = express.Router();
const complianceReadinessController = require('./complianceReadiness.controller');
const authMiddleware = require('../../middlewares/auth.middleware');

router.get('/assessment', authMiddleware, complianceReadinessController.getAssessment);
router.get('/evidence-package', authMiddleware, complianceReadinessController.downloadEvidencePackage);

module.exports = router;
