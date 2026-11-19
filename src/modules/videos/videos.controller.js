const { successResponse, errorResponse } = require('../../utils/response');
const { getOrganizationId } = require('../../utils/orgId');
const prisma = require('../../config/db');
const fs = require('fs');
const path = require('path');

const videosController = {
    // POST /api/videos — Upload a video recording from the WebTrackerAgent or Screen Recorder
    uploadVideo: async (req, res) => {
        try {
            let { employeeId } = req.body;
            const organizationId = await getOrganizationId(req);

            // Resilient employee resolution:
            // 1. Check passed employeeId
            // 2. Fallback to authenticated user's employeeId
            // 3. Fallback to first non-deactivated employee in the organization
            if (!employeeId || employeeId === 'null' || employeeId === 'undefined' || employeeId === 'All') {
                employeeId = req.user?.employeeId;
            }

            let emp = null;
            if (employeeId) {
                emp = await prisma.employee.findUnique({
                    where: { id: employeeId },
                    select: { id: true, status: true }
                });
            }

            if (!emp) {
                emp = await prisma.employee.findFirst({
                    where: { organizationId, status: { not: 'DEACTIVATED' } },
                    select: { id: true, status: true }
                });
            }

            if (!emp) {
                return errorResponse(res, 'No active employee found for recording upload', 404);
            }

            if (emp.status === 'DEACTIVATED') {
                return res.status(403).json({
                    success: false,
                    code: 'ACCOUNT_DEACTIVATED',
                    message: 'Cannot upload video for a deactivated employee'
                });
            }

            employeeId = emp.id;

            if (!req.file) {
                return errorResponse(res, 'video file is required', 400);
            }

            // Save video file to disk
            const ext = req.file.mimetype.includes('mp4') ? 'mp4' : 'webm';
            const filename = `${Date.now()}-${Math.round(Math.random() * 1e9)}.${ext}`;
            const uploadDir = path.join(__dirname, '../../../public/uploads/videos');

            if (!fs.existsSync(uploadDir)) {
                fs.mkdirSync(uploadDir, { recursive: true });
            }

            const filepath = path.join(uploadDir, filename);
            fs.writeFileSync(filepath, req.file.buffer);

            const sizeMb = parseFloat((req.file.size / (1024 * 1024)).toFixed(2));
            const fileUrl = `/uploads/videos/${filename}`;

            // Persist to DB
            const record = await prisma.videoRecording.create({
                data: {
                    employeeId,
                    organizationId,
                    fileUrl,
                    sizeMb,
                },
                include: {
                    employee: { select: { id: true, fullName: true, avatar: true } },
                },
            });

            // Real-time broadcast to admin and managers
            try {
                const { getIO } = require('../../socket/server');
                const io = getIO();
                if (io) {
                    io.to(`org_${organizationId}`).emit('video:new', record);
                }
            } catch (sockErr) {
                console.warn('[VideosController] Socket broadcast error:', sockErr.message);
            }

            return successResponse(res, record, 'Video recording uploaded successfully');
        } catch (error) {
            console.error('[VideosController] Error uploading video:', error);
            return errorResponse(res, error.message);
        }
    },

    // GET /api/videos — Fetch video recordings (role-based)
    getVideos: async (req, res) => {
        try {
            const organizationId = await getOrganizationId(req);
            const { role, employeeId: userId } = req.user;
            const { employeeId, date, startDate, endDate, limit = 100, offset = 0 } = req.query;

            let where = { organizationId };

            if (role === 'EMPLOYEE') {
                where.employeeId = userId;
            } else if (employeeId && employeeId !== 'All') {
                where.employeeId = employeeId;
            }

            // Date filtering
            if (date) {
                const start = new Date(date);
                start.setHours(0, 0, 0, 0);
                const end = new Date(date);
                end.setHours(23, 59, 59, 999);
                where.createdAt = { gte: start, lte: end };
            } else if (startDate || endDate) {
                where.createdAt = {};
                if (startDate) {
                    const start = new Date(startDate);
                    start.setHours(0, 0, 0, 0);
                    where.createdAt.gte = start;
                }
                if (endDate) {
                    const end = new Date(endDate);
                    end.setHours(23, 59, 59, 999);
                    where.createdAt.lte = end;
                }
            }

            const parsedLimit = parseInt(limit, 10) || 100;
            const parsedOffset = parseInt(offset, 10) || 0;

            const videos = await prisma.videoRecording.findMany({
                where,
                orderBy: { createdAt: 'desc' },
                take: parsedLimit,
                skip: parsedOffset,
                include: {
                    employee: { select: { id: true, fullName: true, avatar: true } },
                },
            });

            return successResponse(res, videos, 'Videos fetched successfully');
        } catch (error) {
            console.error('[VideosController] Error fetching videos:', error);
            return errorResponse(res, error.message);
        }
    },

    // DELETE /api/videos/:id
    deleteVideo: async (req, res) => {
        try {
            const { id } = req.params;
            const { role, employeeId: userId } = req.user;

            const video = await prisma.videoRecording.findUnique({ where: { id } });
            if (!video) return errorResponse(res, 'Video not found', 404);

            if (role === 'EMPLOYEE' && video.employeeId !== userId) {
                return errorResponse(res, 'Forbidden', 403);
            }

            // Delete file from disk
            try {
                const filepath = path.join(__dirname, '../../../public', video.fileUrl);
                if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
            } catch (fsErr) {
                console.warn('[VideosController] Could not delete file:', fsErr.message);
            }

            await prisma.videoRecording.delete({ where: { id } });

            // Real-time broadcast deletion
            try {
                const { getIO } = require('../../socket/server');
                const io = getIO();
                if (io) {
                    io.to(`org_${video.organizationId}`).emit('video:deleted', { id });
                }
            } catch (sockErr) {
                console.warn('[VideosController] Socket broadcast error:', sockErr.message);
            }

            return successResponse(res, null, 'Video deleted successfully');
        } catch (error) {
            console.error('[VideosController] Error deleting video:', error);
            return errorResponse(res, error.message);
        }
    },
};

module.exports = videosController;
