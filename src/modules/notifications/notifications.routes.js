const express = require('express');
const router = express.Router();
const notificationsController = require('./notifications.controller');
const authMiddleware = require('../../middlewares/auth.middleware');

router.use(authMiddleware);

router.get('/', notificationsController.getNotifications);
router.post('/', notificationsController.createNotification);
router.patch('/mark-all-read', notificationsController.markAllAsRead);
router.delete('/delete-all', notificationsController.deleteAllNotifications);
router.patch('/:id/read', notificationsController.markAsRead);
router.delete('/:id', notificationsController.deleteNotification);

module.exports = router;
