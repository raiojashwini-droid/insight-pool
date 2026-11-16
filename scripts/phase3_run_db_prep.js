/**
 * PHASE 3 DATABASE PREPARATION RUNNER
 * Target Database: employee-monitoring-fatima-07-08-26
 * 
 * STRICT RULES:
 * - Requires explicit '--execute' flag.
 * - Supports '--rollback' for data-preserving archival.
 * - Zero destructive commands.
 */

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const prisma = require('../src/config/db');

async function applyMigration() {
    console.log('--- PHASE 3: APPLYING ADDITIVE TIMESHEET MIGRATION ---');
    console.log('1. Checking database connection and baseline table count...');
    const baselineTables = await prisma.$queryRawUnsafe('SHOW TABLES');
    console.log(`   Baseline table count: ${baselineTables.length}`);

    const sqlPath = path.join(__dirname, 'phase3_timesheets_migration.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');

    console.log('2. Applying additive table creation for timesheets & timesheet_approvals...');
    // Strip single-line comments properly, then split by semicolon
    const cleanSql = sql.replace(/--.*$/gm, '').trim();
    const statements = cleanSql
        .split(';')
        .map(s => s.trim())
        .filter(s => s.length > 0);

    for (const stmt of statements) {
        console.log('   Executing DDL statement...');
        await prisma.$queryRawUnsafe(stmt);
    }
    console.log('   Tables created / verified successfully.');

    console.log('3. Verifying updated table count...');
    const updatedTables = await prisma.$queryRawUnsafe('SHOW TABLES');
    console.log(`   Updated table count: ${updatedTables.length}`);

    console.log('--- PHASE 3 DATABASE MIGRATION COMPLETE ---');
    await prisma.$disconnect();
}

async function rollbackMigration() {
    console.log('--- PHASE 3: DATA-PRESERVING ROLLBACK ---');
    const sqlPath = path.join(__dirname, 'phase3_timesheets_rollback.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');

    const cleanSql = sql.replace(/--.*$/gm, '').trim();
    const statements = cleanSql
        .split(';')
        .map(s => s.trim())
        .filter(s => s.length > 0);

    for (const stmt of statements) {
        try {
            await prisma.$queryRawUnsafe(stmt);
        } catch (e) {
            console.warn('Rollback statement warning:', e.message);
        }
    }
    console.log('--- ROLLBACK COMPLETE: TABLES ARCHIVED ---');
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
    console.log('DRY RUN: Pass --execute flag to run Phase 3 migration after approval.');
}
