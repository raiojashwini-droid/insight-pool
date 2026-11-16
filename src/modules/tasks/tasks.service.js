const prisma = require('../../config/db');
const { getIO } = require('../../socket/server');
const crypto = require('crypto');

class TasksService {
    /**
     * Record a stage transition in task_status_history
     */
    async recordStatusTransition(taskId, organizationId, fromStatus, toStatus, durationSeconds = 0) {
        try {
            await prisma.$executeRawUnsafe(
                `INSERT INTO task_status_history (id, taskId, organizationId, fromStatus, toStatus, changedAt, durationSeconds) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                crypto.randomUUID(),
                taskId,
                organizationId,
                fromStatus,
                toStatus,
                new Date(),
                Math.max(0, Math.round(durationSeconds))
            );
        } catch (error) {
            console.error('[TasksService] Failed to record status transition:', error.message);
        }
    }

    async createTask(data, organizationId) {
        const { name, projectId, employeeId, priority, dueDate, status } = data;

        if (!organizationId) {
            throw new Error('Organization ID is required to create a task');
        }

        if (employeeId) {
            const emp = await prisma.employee.findUnique({ where: { id: employeeId }, select: { status: true } });
            if (!emp) throw new Error('Employee not found');
            if (emp.status === 'DEACTIVATED') {
                const err = new Error('Cannot assign task to a deactivated employee');
                err.code = 'ACCOUNT_DEACTIVATED';
                err.statusCode = 403;
                throw err;
            }
        }
        const taskStatus = status || 'BACKLOG';

        const task = await prisma.task.create({
            data: {
                name,
                priority: priority || 'MEDIUM',
                status: taskStatus,
                dueDate: dueDate ? new Date(dueDate) : null,
                project: {
                    connect: { id: projectId }
                },
                organization: {
                    connect: { id: organizationId }
                },
                ...(employeeId && {
                    employee: {
                        connect: { id: employeeId }
                    }
                })
            },
            include: {
                project: true,
                employee: true,
            }
        });

        // Record initial status in transition history
        await this.recordStatusTransition(task.id, organizationId, null, taskStatus, 0);

        // Emit real-time event
        const io = getIO();
        if (io) {
            io.to(`org_${organizationId}`).emit('task:update', { taskId: task.id, type: 'new' });
        }

        return task;
    }

    async getTasks(organizationId, filter = {}) {
        return await prisma.task.findMany({
            where: { 
                organizationId,
                ...filter
            },
            include: {
                project: true,
                employee: true,
            },
            orderBy: { createdAt: 'desc' }
        });
    }

    async updateTask(id, data) {
        const { name, priority, dueDate, status, employeeId } = data;
        
        if (employeeId) {
            const emp = await prisma.employee.findUnique({ where: { id: employeeId }, select: { status: true } });
            if (!emp) throw new Error('Employee not found');
            if (emp.status === 'DEACTIVATED') {
                const err = new Error('Cannot assign task to a deactivated employee');
                err.code = 'ACCOUNT_DEACTIVATED';
                err.statusCode = 403;
                throw err;
            }
        }

        // Check existing status to track transition if status changes
        const existingTask = await prisma.task.findUnique({ where: { id } });

        const updateData = {};
        if (name) updateData.name = name;
        if (priority) updateData.priority = priority;
        if (dueDate) updateData.dueDate = new Date(dueDate);
        if (status) updateData.status = status;
        if (employeeId !== undefined) updateData.employeeId = employeeId;

        const task = await prisma.task.update({
            where: { id },
            data: updateData,
            include: {
                project: true,
                employee: true,
            }
        });

        if (status && existingTask && existingTask.status !== status) {
            const durationSeconds = Math.max(0, Math.round((Date.now() - new Date(existingTask.updatedAt).getTime()) / 1000));
            await this.recordStatusTransition(id, task.organizationId, existingTask.status, status, durationSeconds);
        }

        // Emit real-time event
        const io = getIO();
        if (io && task) {
            io.to(`org_${task.organizationId}`).emit('task:update', { taskId: id, type: 'update' });
        }

        return task;
    }

    async updateTaskStatus(id, status) {
        const existingTask = await prisma.task.findUnique({ where: { id } });

        const task = await prisma.task.update({
            where: { id },
            data: { status },
        });

        if (existingTask && existingTask.status !== status) {
            const durationSeconds = Math.max(0, Math.round((Date.now() - new Date(existingTask.updatedAt).getTime()) / 1000));
            await this.recordStatusTransition(id, task.organizationId, existingTask.status, status, durationSeconds);
        }

        // Emit real-time event
        const io = getIO();
        if (io && task) {
            io.to(`org_${task.organizationId}`).emit('task:update', { taskId: id, type: 'status' });
        }

        return task;
    }

    formatDuration(seconds) {
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = seconds % 60;
        return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }

    async deleteTask(id) {
        // Guard: Prevent deleting task with recorded work history
        const hasLogs = await prisma.taskTimeLog.count({ where: { taskId: id } });
        if (hasLogs > 0) {
            const err = new Error('Cannot delete task with recorded work history');
            err.statusCode = 400;
            throw err;
        }

        const task = await prisma.task.delete({
            where: { id },
        });

        // Clean up history records
        try {
            await prisma.$executeRawUnsafe(`DELETE FROM task_status_history WHERE taskId = ?`, id);
        } catch (e) {
            // ignore
        }

        // Emit real-time event
        const io = getIO();
        if (io && task) {
            io.to(`org_${task.organizationId}`).emit('task:update', { taskId: id, type: 'delete' });
        }

        return task;
    }

    async startTimer(taskId, employeeId, organizationId, source = 'WEB', userRole = 'EMPLOYEE') {
        if (!employeeId) {
            const err = new Error('Employee ID is required to start a task timer');
            err.statusCode = 400;
            throw err;
        }
        if (!organizationId) {
            const err = new Error('Organization ID is required');
            err.statusCode = 400;
            throw err;
        }

        // 1. Guard: Check employee status
        const employee = await prisma.employee.findUnique({
            where: { id: employeeId },
            select: { id: true, status: true, organizationId: true }
        });
        if (!employee) {
            const err = new Error('Employee not found');
            err.statusCode = 404;
            throw err;
        }
        if (employee.status === 'DEACTIVATED') {
            const err = new Error('Cannot start timer: Employee account is deactivated');
            err.code = 'ACCOUNT_DEACTIVATED';
            err.statusCode = 403;
            throw err;
        }
        if (employee.status === 'BREAK') {
            const err = new Error('Cannot start a task timer while on break');
            err.statusCode = 400;
            throw err;
        }

        // 2. Guard: Must be clocked in (open attendance record)
        const activeAttendance = await prisma.attendance.findFirst({
            where: { employeeId, clockOut: null },
            orderBy: { clockIn: 'desc' }
        });
        if (!activeAttendance) {
            const err = new Error('You must be clocked in to start a task timer');
            err.statusCode = 400;
            throw err;
        }

        // 3. Guard: Task existence and tenant isolation
        const task = await prisma.task.findFirst({
            where: { id: taskId, organizationId },
            include: {
                project: { select: { id: true, name: true } }
            }
        });
        if (!task) {
            const err = new Error('Task not found in this organization');
            err.statusCode = 404;
            throw err;
        }

        // 4. Guard: Employee assignment (for EMPLOYEE role)
        if (userRole === 'EMPLOYEE' && task.employeeId && task.employeeId !== employeeId) {
            const err = new Error('Cannot track time on a task assigned to another employee');
            err.statusCode = 403;
            throw err;
        }

        // 5. Atomic transaction: auto-stop existing timers & create new one
        const now = new Date();
        const newTimer = await prisma.$transaction(async (tx) => {
            // Auto-stop any active timer for this employee
            const existingActive = await tx.taskTimeLog.findMany({
                where: { employeeId, isRunning: true }
            });

            for (const active of existingActive) {
                const segDuration = Math.max(0, Math.floor((now.getTime() - new Date(active.startTime).getTime()) / 1000));
                await tx.taskTimeLog.update({
                    where: { id: active.id },
                    data: {
                        isRunning: false,
                        endTime: now,
                        duration: segDuration
                    }
                });
            }

            // Create new active timer
            return await tx.taskTimeLog.create({
                data: {
                    taskId,
                    employeeId,
                    organizationId,
                    startTime: now,
                    isRunning: true,
                    source
                },
                include: {
                    task: {
                        select: {
                            id: true,
                            name: true,
                            priority: true,
                            status: true,
                            projectId: true,
                            project: { select: { id: true, name: true } }
                        }
                    }
                }
            });
        });

        // Emit real-time event
        const io = getIO();
        if (io) {
            io.to(`org_${organizationId}`).emit('task:timer:started', {
                employeeId,
                taskId,
                timerId: newTimer.id,
                taskName: task.name,
                startTime: newTimer.startTime
            });
        }

        return newTimer;
    }

    async stopTimer(taskId, employeeId, organizationId) {
        if (!employeeId) {
            const err = new Error('Employee ID is required to stop a task timer');
            err.statusCode = 400;
            throw err;
        }

        const activeTimer = await prisma.taskTimeLog.findFirst({
            where: {
                ...(taskId ? { taskId } : {}),
                employeeId,
                ...(organizationId ? { organizationId } : {}),
                isRunning: true
            },
            include: {
                task: {
                    select: {
                        id: true,
                        name: true,
                        projectId: true,
                        project: { select: { id: true, name: true } }
                    }
                }
            },
            orderBy: { startTime: 'desc' }
        });

        if (!activeTimer) {
            const err = new Error('No active task timer found');
            err.statusCode = 400;
            throw err;
        }

        const now = new Date();
        const duration = Math.max(0, Math.floor((now.getTime() - new Date(activeTimer.startTime).getTime()) / 1000));

        const stopped = await prisma.taskTimeLog.update({
            where: { id: activeTimer.id },
            data: {
                isRunning: false,
                endTime: now,
                duration
            },
            include: {
                task: {
                    select: {
                        id: true,
                        name: true,
                        projectId: true,
                        project: { select: { id: true, name: true } }
                    }
                }
            }
        });

        // Calculate task total tracked seconds on demand
        const totalAgg = await prisma.taskTimeLog.aggregate({
            where: { taskId: activeTimer.taskId, isRunning: false },
            _sum: { duration: true }
        });
        const totalTrackedSeconds = totalAgg._sum.duration || 0;

        // Emit real-time event
        const io = getIO();
        if (io) {
            io.to(`org_${activeTimer.organizationId}`).emit('task:timer:stopped', {
                employeeId,
                taskId: activeTimer.taskId,
                timerId: stopped.id,
                duration,
                formattedDuration: this.formatDuration(duration)
            });
        }

        return {
            ...stopped,
            formattedDuration: this.formatDuration(duration),
            taskTotalTrackedSeconds: totalTrackedSeconds,
            formattedTotalTracked: this.formatDuration(totalTrackedSeconds)
        };
    }

    async getActiveTimer(employeeId, organizationId) {
        if (!employeeId) {
            return { active: false, session: null };
        }

        const activeTimer = await prisma.taskTimeLog.findFirst({
            where: {
                employeeId,
                ...(organizationId ? { organizationId } : {}),
                isRunning: true
            },
            include: {
                task: {
                    include: {
                        project: { select: { id: true, name: true } }
                    }
                }
            },
            orderBy: { startTime: 'desc' }
        });

        if (!activeTimer) {
            return { active: false, session: null };
        }

        const now = Date.now();
        const elapsedSeconds = Math.max(0, Math.floor((now - new Date(activeTimer.startTime).getTime()) / 1000));

        return {
            active: true,
            session: {
                id: activeTimer.id,
                taskId: activeTimer.taskId,
                taskName: activeTimer.task.name,
                priority: activeTimer.task.priority,
                status: activeTimer.task.status,
                projectId: activeTimer.task.projectId,
                projectName: activeTimer.task.project?.name || null,
                startTime: activeTimer.startTime,
                elapsedSeconds,
                formattedElapsed: this.formatDuration(elapsedSeconds),
                source: activeTimer.source,
                isRunning: true
            }
        };
    }

    async getTaskTimeLogs(taskId, organizationId) {
        const task = await prisma.task.findFirst({
            where: { id: taskId, organizationId },
            include: {
                project: { select: { id: true, name: true } }
            }
        });
        if (!task) {
            const err = new Error('Task not found in this organization');
            err.statusCode = 404;
            throw err;
        }

        const logs = await prisma.taskTimeLog.findMany({
            where: { taskId, organizationId },
            include: {
                employee: {
                    select: { id: true, fullName: true, avatar: true }
                }
            },
            orderBy: { startTime: 'desc' }
        });

        const totalAgg = await prisma.taskTimeLog.aggregate({
            where: { taskId, isRunning: false },
            _sum: { duration: true }
        });
        const totalTrackedSeconds = totalAgg._sum.duration || 0;

        return {
            taskId,
            taskName: task.name,
            projectName: task.project?.name || null,
            totalTrackedSeconds,
            formattedTotal: this.formatDuration(totalTrackedSeconds),
            logs: logs.map(l => ({
                ...l,
                formattedDuration: this.formatDuration(l.duration)
            }))
        };
    }

    async stopActiveTimerForEmployee(employeeId, endTime = new Date()) {
        if (!employeeId) return [];

        const activeTimers = await prisma.taskTimeLog.findMany({
            where: { employeeId, isRunning: true }
        });
        if (!activeTimers.length) return [];

        const now = new Date(endTime);
        const stoppedList = [];
        for (const timer of activeTimers) {
            const duration = Math.max(0, Math.floor((now.getTime() - new Date(timer.startTime).getTime()) / 1000));
            const updated = await prisma.taskTimeLog.update({
                where: { id: timer.id },
                data: {
                    isRunning: false,
                    endTime: now,
                    duration
                }
            });
            stoppedList.push(updated);

            // Emit real-time event
            const io = getIO();
            if (io) {
                io.to(`org_${timer.organizationId}`).emit('task:timer:stopped', {
                    employeeId,
                    taskId: timer.taskId,
                    timerId: timer.id,
                    duration,
                    autoStopped: true
                });
            }
        }
        return stoppedList;
    }

    async getBoardTasks(organizationId, filter = {}) {
        const tasks = await this.getTasks(organizationId, filter);
        
        // Group tasks by status for the Kanban board
        const board = {
            BACKLOG: [],
            IN_OPERATIONS: [],
            QUALITY_ASSURANCE: [],
            FINALIZED: []
        };

        tasks.forEach(task => {
            if (board[task.status]) {
                board[task.status].push({
                    id: task.id,
                    title: task.name,
                    project: task.project.name,
                    projectId: task.projectId,
                    priority: task.priority,
                    assignee: task.employee ? task.employee.fullName : 'Unassigned',
                    assigneeId: task.employeeId,
                    status: task.status,
                    dueDate: task.dueDate ? task.dueDate.toISOString().split('T')[0] : 'No Date',
                    createdAt: task.createdAt
                });
            }
        });

        return board;
    }

    /**
     * Workflow Bottleneck & Cycle Time Analytics
     */
    async getCycleTimeAnalytics(organizationId, filter = {}) {
        // Query tasks matching filter
        const taskWhere = { organizationId };
        if (filter.projectId) taskWhere.projectId = filter.projectId;
        if (filter.employeeId) taskWhere.employeeId = filter.employeeId;
        if (filter.status) taskWhere.status = filter.status;
        if (filter.startDate || filter.endDate) {
            taskWhere.createdAt = {};
            if (filter.startDate) taskWhere.createdAt.gte = new Date(filter.startDate);
            if (filter.endDate) taskWhere.createdAt.lte = new Date(filter.endDate);
        }

        const tasks = await prisma.task.findMany({
            where: taskWhere,
            include: {
                project: { select: { id: true, name: true } },
                employee: { select: { id: true, fullName: true, teamId: true } },
            },
            orderBy: { createdAt: 'desc' }
        });

        if (tasks.length === 0) {
            return {
                tasksAnalyzed: 0,
                averageCycleTime: { seconds: 0, hours: 0, days: 0 },
                averageStageDuration: [
                    { stage: 'BACKLOG', label: 'Backlog', seconds: 0, hours: 0, days: 0 },
                    { stage: 'IN_OPERATIONS', label: 'In Operations', seconds: 0, hours: 0, days: 0 },
                    { stage: 'QUALITY_ASSURANCE', label: 'Quality Assurance', seconds: 0, hours: 0, days: 0 },
                    { stage: 'FINALIZED', label: 'Finalized', seconds: 0, hours: 0, days: 0 },
                ],
                bottleneckStage: null,
                stageDistribution: [],
                taskMetrics: []
            };
        }

        const taskIds = tasks.map(t => t.id);

        // Fetch transition history
        let history = [];
        try {
            history = await prisma.$queryRawUnsafe(
                `SELECT * FROM task_status_history WHERE organizationId = ? ORDER BY changedAt ASC`,
                organizationId
            );
        } catch (e) {
            console.error('[TasksService] Could not fetch task_status_history:', e.message);
        }

        // Group history by taskId
        const historyByTask = new Map();
        history.forEach(h => {
            if (!historyByTask.has(h.taskId)) {
                historyByTask.set(h.taskId, []);
            }
            historyByTask.get(h.taskId).push(h);
        });

        const STAGES = ['BACKLOG', 'IN_OPERATIONS', 'QUALITY_ASSURANCE', 'FINALIZED'];
        const STAGE_LABELS = {
            BACKLOG: 'Backlog',
            IN_OPERATIONS: 'In Operations',
            QUALITY_ASSURANCE: 'Quality Assurance',
            FINALIZED: 'Finalized',
        };

        const stageTotals = {
            BACKLOG: { totalSeconds: 0, count: 0 },
            IN_OPERATIONS: { totalSeconds: 0, count: 0 },
            QUALITY_ASSURANCE: { totalSeconds: 0, count: 0 },
            FINALIZED: { totalSeconds: 0, count: 0 },
        };

        let totalCycleTimeSeconds = 0;
        let completedTasksCount = 0;

        const taskMetrics = tasks.map(task => {
            const taskHistory = historyByTask.get(task.id) || [];
            const stageDurations = {
                BACKLOG: 0,
                IN_OPERATIONS: 0,
                QUALITY_ASSURANCE: 0,
                FINALIZED: 0,
            };

            let firstActiveTimestamp = null;
            let finalizedTimestamp = null;

            if (taskHistory.length > 0) {
                // Calculate durations from recorded transitions
                taskHistory.forEach(h => {
                    if (h.fromStatus && stageDurations[h.fromStatus] !== undefined) {
                        stageDurations[h.fromStatus] += Number(h.durationSeconds || 0);
                    }
                    if (['IN_OPERATIONS', 'QUALITY_ASSURANCE'].includes(h.toStatus) && !firstActiveTimestamp) {
                        firstActiveTimestamp = new Date(h.changedAt).getTime();
                    }
                    if (h.toStatus === 'FINALIZED' && !finalizedTimestamp) {
                        finalizedTimestamp = new Date(h.changedAt).getTime();
                    }
                });

                // Add ongoing duration for currently active stage
                const lastTransition = taskHistory[taskHistory.length - 1];
                if (task.status !== 'FINALIZED' && lastTransition) {
                    const ongoingSeconds = Math.max(0, Math.round((Date.now() - new Date(lastTransition.changedAt).getTime()) / 1000));
                    stageDurations[task.status] += ongoingSeconds;
                }
            } else {
                // Safe backward-compatible fallback using task timestamps
                const createdTime = new Date(task.createdAt).getTime();
                const updatedTime = new Date(task.updatedAt).getTime();
                const duration = Math.max(0, Math.round((updatedTime - createdTime) / 1000));

                if (task.status === 'FINALIZED') {
                    stageDurations.IN_OPERATIONS = Math.round(duration * 0.7);
                    stageDurations.QUALITY_ASSURANCE = Math.round(duration * 0.3);
                    firstActiveTimestamp = createdTime;
                    finalizedTimestamp = updatedTime;
                } else {
                    stageDurations[task.status] = duration;
                    if (['IN_OPERATIONS', 'QUALITY_ASSURANCE'].includes(task.status)) {
                        firstActiveTimestamp = createdTime;
                    }
                }
            }

            // Calculate task cycle time (from first active to finalization or now)
            let cycleTimeSeconds = 0;
            if (firstActiveTimestamp) {
                const end = finalizedTimestamp || Date.now();
                cycleTimeSeconds = Math.max(0, Math.round((end - firstActiveTimestamp) / 1000));
            } else if (task.status === 'FINALIZED') {
                cycleTimeSeconds = stageDurations.IN_OPERATIONS + stageDurations.QUALITY_ASSURANCE;
            }

            if (task.status === 'FINALIZED') {
                totalCycleTimeSeconds += cycleTimeSeconds;
                completedTasksCount += 1;
            }

            // Accumulate stage totals
            STAGES.forEach(s => {
                if (stageDurations[s] > 0) {
                    stageTotals[s].totalSeconds += stageDurations[s];
                    stageTotals[s].count += 1;
                }
            });

            return {
                id: task.id,
                title: task.name,
                status: task.status,
                priority: task.priority,
                project: task.project?.name || 'General',
                assignee: task.employee?.fullName || 'Unassigned',
                stageDurations: {
                    BACKLOG: {
                        seconds: stageDurations.BACKLOG,
                        hours: Math.round((stageDurations.BACKLOG / 3600) * 10) / 10,
                        days: Math.round((stageDurations.BACKLOG / 86400) * 10) / 10,
                    },
                    IN_OPERATIONS: {
                        seconds: stageDurations.IN_OPERATIONS,
                        hours: Math.round((stageDurations.IN_OPERATIONS / 3600) * 10) / 10,
                        days: Math.round((stageDurations.IN_OPERATIONS / 86400) * 10) / 10,
                    },
                    QUALITY_ASSURANCE: {
                        seconds: stageDurations.QUALITY_ASSURANCE,
                        hours: Math.round((stageDurations.QUALITY_ASSURANCE / 3600) * 10) / 10,
                        days: Math.round((stageDurations.QUALITY_ASSURANCE / 86400) * 10) / 10,
                    },
                    FINALIZED: {
                        seconds: stageDurations.FINALIZED,
                        hours: Math.round((stageDurations.FINALIZED / 3600) * 10) / 10,
                        days: Math.round((stageDurations.FINALIZED / 86400) * 10) / 10,
                    },
                },
                cycleTime: {
                    seconds: cycleTimeSeconds,
                    hours: Math.round((cycleTimeSeconds / 3600) * 10) / 10,
                    days: Math.round((cycleTimeSeconds / 86400) * 10) / 10,
                },
            };
        });

        // Compute average per stage
        const averageStageDuration = STAGES.map(stage => {
            const item = stageTotals[stage];
            const avgSec = item.count > 0 ? Math.round(item.totalSeconds / item.count) : 0;
            return {
                stage,
                label: STAGE_LABELS[stage],
                seconds: avgSec,
                hours: Math.round((avgSec / 3600) * 10) / 10,
                days: Math.round((avgSec / 86400) * 10) / 10,
                tasksThroughStage: item.count,
            };
        });

        // Identify bottleneck stage (highest avg duration among active stages: BACKLOG, IN_OPERATIONS, QUALITY_ASSURANCE)
        const activeStages = averageStageDuration.filter(s => ['BACKLOG', 'IN_OPERATIONS', 'QUALITY_ASSURANCE'].includes(s.stage));
        let bottleneckStage = null;
        if (activeStages.length > 0) {
            bottleneckStage = [...activeStages].sort((a, b) => b.seconds - a.seconds)[0];
        }

        // Average cycle time across completed tasks (or all tasks with cycle time)
        const avgCycleSec = completedTasksCount > 0 
            ? Math.round(totalCycleTimeSeconds / completedTasksCount)
            : (tasks.length > 0 ? Math.round(taskMetrics.reduce((acc, curr) => acc + curr.cycleTime.seconds, 0) / tasks.length) : 0);

        // Stage distribution (% of total active cycle time)
        const activeDurationSum = averageStageDuration
            .filter(s => s.stage !== 'FINALIZED')
            .reduce((acc, curr) => acc + curr.seconds, 0) || 1;

        const stageDistribution = averageStageDuration
            .filter(s => s.stage !== 'FINALIZED')
            .map(s => ({
                stage: s.stage,
                label: s.label,
                hours: s.hours,
                percentage: Math.round((s.seconds / activeDurationSum) * 100),
            }));

        return {
            tasksAnalyzed: tasks.length,
            completedTasksCount,
            averageCycleTime: {
                seconds: avgCycleSec,
                hours: Math.round((avgCycleSec / 3600) * 10) / 10,
                days: Math.round((avgCycleSec / 86400) * 10) / 10,
            },
            averageStageDuration,
            bottleneckStage: bottleneckStage ? {
                stage: bottleneckStage.stage,
                label: bottleneckStage.label,
                hours: bottleneckStage.hours,
                days: bottleneckStage.days,
            } : null,
            stageDistribution,
            taskMetrics,
        };
    }
}

module.exports = new TasksService();
