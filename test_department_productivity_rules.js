const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { resolveAppActivityForOrg } = require('./src/utils/resolveAppActivityForOrg');
const agentService = require('./src/modules/agent/agent.service');
const productivityService = require('./src/modules/productivity/productivity.service');

async function runTests() {
    console.log('--- Starting Role & Department-Specific Productivity Rules Verification ---');
    let passed = 0;
    let failed = 0;

    function assert(condition, message) {
        if (condition) {
            console.log(`✅ PASS: ${message}`);
            passed++;
        } else {
            console.error(`❌ FAIL: ${message}`);
            failed++;
        }
    }

    try {
        // 1. Find or create an Organization
        let org = await prisma.organization.findFirst();
        if (!org) {
            org = await prisma.organization.create({
                data: {
                    name: 'Test Org for Rules',
                    domain: 'testrules.com'
                }
            });
        }
        const organizationId = org.id;

        // 2. Find or create two different teams: Marketing and Engineering
        let mktTeam = await prisma.team.findFirst({
            where: { organizationId, name: 'Marketing Dept Test' }
        });
        if (!mktTeam) {
            mktTeam = await prisma.team.create({
                data: {
                    organizationId,
                    name: 'Marketing Dept Test'
                }
            });
        }

        let engTeam = await prisma.team.findFirst({
            where: { organizationId, name: 'Engineering Dept Test' }
        });
        if (!engTeam) {
            engTeam = await prisma.team.create({
                data: {
                    organizationId,
                    name: 'Engineering Dept Test'
                }
            });
        }

        // 3. Setup Productivity Rules:
        // Global rule: linkedin.com is UNPRODUCTIVE
        // Marketing team rule: linkedin.com is PRODUCTIVE (Override)
        const domain = 'linkedin.com';
        const appName = 'LinkedIn';

        // Clean up any existing rules for this test domain
        await prisma.productivityRule.deleteMany({
            where: {
                organizationId,
                domain
            }
        });

        // Create Global Rule
        const globalRule = await prisma.productivityRule.create({
            data: {
                organizationId,
                domain,
                appName,
                productivity: 'UNPRODUCTIVE',
                category: 'Social Media',
                teamId: null
            }
        });
        assert(globalRule && globalRule.teamId === null, 'Global rule created with teamId=null');

        // Create Team Override Rule for Marketing
        const mktRule = await prisma.productivityRule.create({
            data: {
                organizationId,
                domain,
                appName,
                productivity: 'PRODUCTIVE',
                category: 'Recruiting & Marketing',
                teamId: mktTeam.id
            }
        });
        assert(mktRule && mktRule.teamId === mktTeam.id, 'Department override rule created with Marketing teamId');

        // 4. Test resolveAppActivityForOrg with different team contexts
        const mktResolved = await resolveAppActivityForOrg(organizationId, 'LinkedIn', 'LinkedIn - Feed', mktTeam.id);
        assert(mktResolved.productivity === 'PRODUCTIVE', `Marketing team sees LinkedIn as PRODUCTIVE (got ${mktResolved.productivity})`);

        const engResolved = await resolveAppActivityForOrg(organizationId, 'LinkedIn', 'LinkedIn - Feed', engTeam.id);
        assert(engResolved.productivity === 'UNPRODUCTIVE', `Engineering team falls back to global rule: UNPRODUCTIVE (got ${engResolved.productivity})`);

        const noTeamResolved = await resolveAppActivityForOrg(organizationId, 'LinkedIn', 'LinkedIn - Feed', null);
        assert(noTeamResolved.productivity === 'UNPRODUCTIVE', `No team context falls back to global rule: UNPRODUCTIVE (got ${noTeamResolved.productivity})`);

        // 5. Test Live Employee Activity Logging with Department Context
        // Find or create employee in Marketing
        let mktEmployee = await prisma.employee.findFirst({
            where: { organizationId, teamId: mktTeam.id }
        });
        if (!mktEmployee) {
            mktEmployee = await prisma.employee.create({
                data: {
                    organizationId,
                    teamId: mktTeam.id,
                    fullName: 'Sarah Marketing',
                    email: `sarah.mkt.${Date.now()}@testrules.com`,
                    status: 'ACTIVE'
                }
            });
        }

        // Find or create employee in Engineering
        let engEmployee = await prisma.employee.findFirst({
            where: { organizationId, teamId: engTeam.id }
        });
        if (!engEmployee) {
            engEmployee = await prisma.employee.create({
                data: {
                    organizationId,
                    teamId: engTeam.id,
                    fullName: 'Alex Engineer',
                    email: `alex.eng.${Date.now()}@testrules.com`,
                    status: 'ACTIVE'
                }
            });
        }

        // Log activity for Marketing employee on LinkedIn
        await agentService.logActivity(mktEmployee.id, {
            activeApp: 'LinkedIn',
            activeWindow: 'LinkedIn - Candidates Profile',
            idleTime: 0,
            timestamp: new Date()
        });

        const latestMktLog = await prisma.activityLog.findFirst({
            where: { employeeId: mktEmployee.id, appWebsite: 'LinkedIn' },
            orderBy: { timestamp: 'desc' }
        });
        assert(latestMktLog && latestMktLog.productivity === 'PRODUCTIVE', `ActivityLog for Marketing employee is marked PRODUCTIVE (got ${latestMktLog?.productivity})`);

        // Log activity for Engineering employee on LinkedIn
        await agentService.logActivity(engEmployee.id, {
            activeApp: 'LinkedIn',
            activeWindow: 'LinkedIn - Feed',
            idleTime: 0,
            timestamp: new Date()
        });

        const latestEngLog = await prisma.activityLog.findFirst({
            where: { employeeId: engEmployee.id, appWebsite: 'LinkedIn' },
            orderBy: { timestamp: 'desc' }
        });
        assert(latestEngLog && latestEngLog.productivity === 'UNPRODUCTIVE', `ActivityLog for Engineering employee is marked UNPRODUCTIVE (got ${latestEngLog?.productivity})`);

        // 6. Test Productivity Service API with Department Filter
        const mktAppsUsage = await productivityService.getAppsUsage(organizationId, null, null, mktTeam.id);
        const mktAppEntry = mktAppsUsage.find(a => a.domain === 'linkedin.com' || a.appName === 'LinkedIn');
        assert(mktAppEntry && mktAppEntry.productivity === 'PRODUCTIVE', `Productivity API for Marketing returns PRODUCTIVE for LinkedIn (got ${mktAppEntry?.productivity})`);
        assert(mktAppEntry && mktAppEntry.isTeamSpecific === true, 'Productivity API correctly flags isTeamSpecific=true for Marketing');

        const globalAppsUsage = await productivityService.getAppsUsage(organizationId, null, null, null);
        const globalAppEntry = globalAppsUsage.find(a => a.domain === 'linkedin.com' || a.appName === 'LinkedIn');
        assert(globalAppEntry && globalAppEntry.productivity === 'UNPRODUCTIVE', `Productivity API for Global returns UNPRODUCTIVE for LinkedIn (got ${globalAppEntry?.productivity})`);
        assert(globalAppEntry && globalAppEntry.isTeamSpecific === false, 'Productivity API correctly flags isTeamSpecific=false for Global view');

        console.log(`\n=========================================`);
        console.log(`Department-Specific Productivity Rules: ${passed} PASSED, ${failed} FAILED`);
        console.log(`=========================================`);

    } catch (err) {
        console.error('Fatal error during test run:', err);
    } finally {
        await prisma.$disconnect();
    }
}

runTests();
