const express = require('express');
const router = express.Router();
const payrollController = require('./payroll.controller');
const invoiceController = require('./invoice.controller');
const cloudPayrollController = require('./cloudPayroll.controller');
const authMiddleware = require('../../middlewares/auth.middleware');

router.use(authMiddleware);

router.get('/summary', payrollController.getPayrollSummary);
router.get('/records', payrollController.getPayrollRecords);

// Direct Cloud Payroll Integrations (Gusto, ADP, QuickBooks)
router.get('/integrations/status', cloudPayrollController.getAllStatus);
router.get('/integrations/:provider/status', cloudPayrollController.getProviderStatus);
router.post('/integrations/:provider/config', cloudPayrollController.saveConfig);
router.post('/integrations/:provider/test', cloudPayrollController.testConnection);
router.post('/integrations/:provider/sync', cloudPayrollController.syncPayroll);

// Invoice Routes
router.get('/invoices', invoiceController.getInvoices);
router.post('/invoices', invoiceController.createInvoice);

module.exports = router;
