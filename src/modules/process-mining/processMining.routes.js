const express = require('express');
const router = express.Router();
const processMiningController = require('./processMining.controller');
const authMiddleware = require('../../middlewares/auth.middleware');

router.get('/discovery', authMiddleware, processMiningController.getProcessDiscovery);
router.get('/export', authMiddleware, processMiningController.exportProcessReport);

module.exports = router;
