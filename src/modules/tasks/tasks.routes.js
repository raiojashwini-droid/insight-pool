const express = require('express');
const router = express.Router();
const tasksController = require('./tasks.controller');
const authMiddleware = require('../../middlewares/auth.middleware');

router.use(authMiddleware);

// Task Timer Routes (Declared before generic /:id routes)
router.get('/timer/active', tasksController.getActiveTimer);
router.post('/timer/start', tasksController.startTimer);
router.post('/timer/stop', tasksController.stopTimer);
router.post('/:id/timer/start', tasksController.startTimer);
router.post('/:id/timer/stop', tasksController.stopTimer);
router.get('/:id/time-logs', tasksController.getTaskTimeLogs);

router.post('/', tasksController.createTask);
router.get('/', tasksController.getTasks);
router.get('/board', tasksController.getBoardTasks);
router.get('/analytics/cycle-time', tasksController.getCycleTimeAnalytics);
router.patch('/:id/status', tasksController.updateTaskStatus);
router.patch('/:id', tasksController.updateTask);
router.delete('/:id', tasksController.deleteTask);

module.exports = router;
