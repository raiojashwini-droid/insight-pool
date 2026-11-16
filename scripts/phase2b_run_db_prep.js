/**
 * PHASE 2B-1 DATABASE PREPARATION RUNNER
 * Target Database: employee-monitoring-fatima-07-08-26
 * 
 * STRICT RULES:
 * - NEVER runs automatically during application startup.
 * - Requires explicit '--execute' flag to apply additive migration.
 * - Supports '--rollback' flag to execute data-preserving archival rollback.
 * - Zero destructive operations (NO DROP TABLE, NO RESET).
 */

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const prisma = require('../src/config/db');

async function applyMigration() {
    console.log('--- PHASE 2B-1: APPLYING ADDITIVE MIGRATION ---');
    console.log('1. Checking database connection and baseline table count...');
    const baselineTables = await prisma.$queryRawUnsafe('SHOW TABLES');
    console.log(`   Baseline table count: ${baselineTables.length}`);

    const sqlPath = path.join(__dirname, 'phase2b_task_time_logs_migration.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');

    console.log('2. Applying additive-only table creation for task_time_logs...');
    await prisma.$queryRawUnsafe(sql);
    console.log('   Table task_time_logs created / verified successfully.');

    console.log('3. Verifying updated table count...');
    const updatedTables = await prisma.$queryRawUnsafe('SHOW TABLES');
    console.log(`   Updated table count: ${updatedTables.length}`);

    console.log('4. Inspecting task_time_logs table columns...');
    const cols = await prisma.$queryRawUnsafe('DESCRIBE task_time_logs');
    console.table(cols);

    console.log('--- MIGRATION COMPLETE: ZERO DATA LOSS ---');
    await prisma.$disconnect();
}

async function rollbackMigration() {
    console.log('--- PHASE 2B-1: DATA-PRESERVING ROLLBACK ---');
    console.log('1. Checking if task_time_logs exists...');
    const tables = await prisma.$queryRawUnsafe("SHOW TABLES LIKE 'task_time_logs'");
    if (tables.length === 0) {
        console.log('   task_time_logs does not exist. Nothing to archive.');
        await prisma.$disconnect();
        return;
    }

    const sqlPath = path.join(__dirname, 'phase2b_task_time_logs_rollback.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');

    console.log('2. Safely archiving task_time_logs to preserve historical work data...');
    await prisma.$queryRawUnsafe(sql);
    console.log('   Table successfully archived to task_time_logs_archived.');

    const remainingTables = await prisma.$queryRawUnsafe('SHOW TABLES');
    console.log(`   Total tables remaining: ${remainingTables.length}`);
    console.log('--- ROLLBACK COMPLETE: DATA PRESERVED IN task_time_logs_archived ---');
    await prisma.$disconnect();
}

if (process.argv.includes('--execute')) {
    applyMigration().catch(err => {
        console.error('Migration failed:', err);
        process.exit(1);
    });
} else if (process.argv.includes('--rollback')) {
    rollbackMigration().catch(err => {
        console.error('Rollback failed:', err);
        process.exit(1);
    });
} else {
    console.log('DRY RUN: No database changes executed.');
    console.log('Usage:');
    console.log('  node scripts/phase2b_run_db_prep.js --execute   (Apply additive migration)');
    console.log('  node scripts/phase2b_run_db_prep.js --rollback  (Safely archive task_time_logs without data loss)');
}
