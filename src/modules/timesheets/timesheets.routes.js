const express = require('express');
const router = express.Router();
const timesheetsController = require('./timesheets.controller');
const authMiddleware = require('../../middlewares/auth.middleware');

// All timesheets routes require authentication
router.use(authMiddleware);

router.get('/week', timesheetsController.getWeek);
router.post('/submit', timesheetsController.submit);
router.get('/approvals/queue', timesheetsController.getApprovalQueue);
router.post('/:id/approve', timesheetsController.approve);
router.post('/:id/reject', timesheetsController.reject);
router.post('/:id/reopen', timesheetsController.reopen);
router.post('/bulk-approve', timesheetsController.bulkApprove);
router.get('/export-csv', timesheetsController.exportPayrollCsv);

module.exports = router;
