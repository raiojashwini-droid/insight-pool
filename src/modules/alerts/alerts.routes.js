const express = require('express');
const router = express.Router();
const alertsController = require('./alerts.controller');
const authMiddleware = require('../../middlewares/auth.middleware');

router.use(authMiddleware);

// Alert History & Dismissal
router.get('/history', alertsController.getAlertHistory);
router.patch('/dismiss-all', alertsController.dismissAllAlerts);
router.patch('/:id/dismiss', alertsController.dismissAlert);

// Rules
router.get('/rules', alertsController.getAlertRules);
router.post('/rules', alertsController.createAlertRule);
router.put('/rules/:id', alertsController.updateAlertRule);
router.delete('/rules/:id', alertsController.deleteAlertRule);

// Settings
router.get('/settings', alertsController.getSettings);
router.put('/settings', alertsController.updateSettings);

module.exports = router;
