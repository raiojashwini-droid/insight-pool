const prisma = require('../src/config/db');

async function fixIndex() {
    console.log('1. Creating index on organizationId so foreign key constraint is satisfied...');
    try {
        await prisma.$executeRawUnsafe(`CREATE INDEX idx_productivity_rules_org ON productivity_rules (organizationId)`);
        console.log('✓ Created idx_productivity_rules_org');
    } catch (e) {
        console.log('Note on creating idx_productivity_rules_org:', e.message);
    }

    console.log('2. Dropping old 2-column unique index...');
    try {
        await prisma.$executeRawUnsafe(`ALTER TABLE productivity_rules DROP INDEX productivity_rules_organizationId_domain_key`);
        console.log('✓ Dropped productivity_rules_organizationId_domain_key');
    } catch (e) {
        console.log('Note on drop index:', e.message);
    }

    console.log('3. Ensuring 3-column composite unique index...');
    try {
        await prisma.$executeRawUnsafe(`ALTER TABLE productivity_rules ADD UNIQUE INDEX productivity_rules_org_domain_team_idx (organizationId, domain, teamId)`);
        console.log('✓ Created 3-column unique index');
    } catch (e) {
        console.log('Note on 3-column unique index:', e.message);
    }

    const indexes = await prisma.$queryRawUnsafe(`SHOW INDEX FROM productivity_rules`);
    console.log('Current indexes on productivity_rules:', indexes.map(i => ({ Key_name: i.Key_name, Column_name: i.Column_name })));
}

fixIndex()
    .then(() => process.exit(0))
    .catch(e => {
        console.error(e);
        process.exit(1);
    });
