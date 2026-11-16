const prisma = require('../src/config/db');
const crypto = require('crypto');

async function initTaskHistory() {
    console.log('Initializing task_status_history table...');
    await prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS task_status_history (
            id VARCHAR(191) NOT NULL,
            taskId VARCHAR(191) NOT NULL,
            organizationId VARCHAR(191) NOT NULL,
            fromStatus VARCHAR(191) NULL,
            toStatus VARCHAR(191) NOT NULL,
            changedAt DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
            durationSeconds INT NOT NULL DEFAULT 0,
            PRIMARY KEY (id),
            INDEX task_status_history_taskId_idx (taskId),
            INDEX task_status_history_organizationId_idx (organizationId)
        ) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
    `);
    console.log('task_status_history table ready.');

    // Check existing history
    const existing = await prisma.$queryRawUnsafe(`SELECT COUNT(*) as count FROM task_status_history`);
    const count = Number(existing[0]?.count || 0);
    console.log(`Current history records: ${count}`);

    if (count === 0) {
        // Populate baseline history for existing tasks from their createdAt/updatedAt
        const tasks = await prisma.task.findMany();
        console.log(`Found ${tasks.length} tasks to initialize history for.`);

        for (const task of tasks) {
            const orgId = task.organizationId || 'default-org-id';
            const created = new Date(task.createdAt);
            const updated = new Date(task.updatedAt);
            const totalDuration = Math.max(0, Math.round((updated.getTime() - created.getTime()) / 1000));

            // Record initial creation entry
            await prisma.$executeRawUnsafe(
                `INSERT INTO task_status_history (id, taskId, organizationId, fromStatus, toStatus, changedAt, durationSeconds) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                crypto.randomUUID(),
                task.id,
                orgId,
                null,
                'BACKLOG',
                created,
                0
            );

            // If task progressed beyond BACKLOG, record the transition
            if (task.status !== 'BACKLOG') {
                await prisma.$executeRawUnsafe(
                    `INSERT INTO task_status_history (id, taskId, organizationId, fromStatus, toStatus, changedAt, durationSeconds) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    crypto.randomUUID(),
                    task.id,
                    orgId,
                    'BACKLOG',
                    task.status,
                    updated,
                    totalDuration > 0 ? totalDuration : 86400 // fallback 1 day in seconds if same
                );
            }
        }
        console.log('Baseline history initialized for existing tasks.');
    }
}

initTaskHistory()
    .then(() => {
        console.log('Task history init complete.');
        process.exit(0);
    })
    .catch((err) => {
        console.error('Init failed:', err);
        process.exit(1);
    });
