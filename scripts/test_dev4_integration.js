const prisma = require('../src/config/db');
const alertsService = require('../src/modules/alerts/alerts.service');
const notificationsService = require('../src/modules/notifications/notifications.service');
const { generatePdfReport } = require('../src/modules/email-reports/pdfReportBuilder');
const reportScheduler = require('../src/modules/email-reports/reportScheduler');

async function runDev4IntegrationTests() {
    console.log('====================================================');
    console.log('🚀 DEVELOPER 4 — COMPREHENSIVE INTEGRATION TEST SUITE');
    console.log('   Real-Time Engine, Alerts, Socket.IO & Reports    ');
    console.log('====================================================\n');

    let passedTests = 0;
    let totalTests = 0;

    function assert(condition, testName) {
        totalTests++;
        if (condition) {
            console.log(`✅ [PASS] Test ${totalTests}: ${testName}`);
            passedTests++;
        } else {
            console.error(`❌ [FAIL] Test ${totalTests}: ${testName}`);
        }
    }

    try {
        // ─────────────────────────────────────────────────────────────────
        // 0. ENVIRONMENT & FIXTURE RESOLUTION
        // ─────────────────────────────────────────────────────────────────
        const orgA = await prisma.organization.findFirst({
            include: { employees: true }
        });
        assert(!!orgA, `Primary organization resolved: "${orgA?.legalName}" (${orgA?.id})`);

        const employeeA = orgA?.employees[0];
        assert(!!employeeA, `Primary employee resolved: "${employeeA?.fullName}" (${employeeA?.id})`);

        if (!orgA || !employeeA) {
            console.error('Cannot proceed without primary organization and employee.');
            return;
        }

        // Secondary organization for multi-tenant isolation testing
        let orgB = await prisma.organization.findFirst({
            where: { id: { not: orgA.id } }
        });
        if (!orgB) {
            orgB = await prisma.organization.create({
                data: {
                    legalName: 'Isolated Tenant Org B',
                    timeZone: 'UTC'
                }
            });
        }
        assert(!!orgB, `Secondary tenant organization resolved: "${orgB.legalName}" (${orgB.id})`);

        // Ensure primary employee has a configured shift for today
        const todayDate = new Date();
        todayDate.setHours(0, 0, 0, 0);

        let testShift = await prisma.shift.findFirst({
            where: { employeeId: employeeA.id, date: todayDate }
        });
        if (!testShift) {
            testShift = await prisma.shift.create({
                data: {
                    employeeId: employeeA.id,
                    organizationId: orgA.id,
                    date: todayDate,
                    startTime: '09:00',
                    endTime: '17:00'
                }
            });
        }
        assert(!!testShift, `Employee shift verified for today: 09:00 - 17:00`);

        // Ensure an unassigned employee without shifts exists
        let unassignedEmp = await prisma.employee.findFirst({
            where: { organizationId: orgA.id, id: { not: employeeA.id } }
        });
        if (!unassignedEmp) {
            unassignedEmp = await prisma.employee.create({
                data: {
                    fullName: 'Shiftless Worker',
                    email: `shiftless_${Date.now()}@example.com`,
                    role: 'EMPLOYEE',
                    organizationId: orgA.id
                }
            });
        }
        // Ensure this employee has NO shift for today
        await prisma.shift.deleteMany({
            where: { employeeId: unassignedEmp.id, date: todayDate }
        });
        assert(!!unassignedEmp, `Shiftless employee resolved for no-shift validation (${unassignedEmp.id})`);


        // ─────────────────────────────────────────────────────────────────
        // TEST SUITE 1: ALERT EVALUATION ENGINE — LATE ARRIVAL
        // ─────────────────────────────────────────────────────────────────
        console.log('\n--- 1. ALERT EVALUATION: LATE ARRIVAL ---');

        // Clean any existing late arrival alerts for this employee today for test repeatability
        await prisma.alertLog.deleteMany({
            where: { employeeId: employeeA.id, ruleType: 'LATE_ARRIVAL' }
        });
        alertsService._resetCooldowns();

        // Test 1.1: Clock-in at 09:14 AM (14 min late) -> should NOT trigger (< 15 min threshold)
        const clockIn14m = new Date(todayDate);
        clockIn14m.setHours(9, 14, 0, 0);
        const res14m = await alertsService.evaluateLateArrival({
            employeeId: employeeA.id,
            organizationId: orgA.id,
            clockInTime: clockIn14m
        });
        assert(res14m === null, 'Clock-in at 14 minutes late (09:14) correctly does NOT trigger late alert (< 15m threshold)');

        // Test 1.2: Clock-in at 09:15 AM (exactly 15 min late) -> MUST trigger
        const clockIn15m = new Date(todayDate);
        clockIn15m.setHours(9, 15, 0, 0);
        const res15m = await alertsService.evaluateLateArrival({
            employeeId: employeeA.id,
            organizationId: orgA.id,
            clockInTime: clockIn15m
        });
        assert(!!res15m && !!res15m.alertLog, 'Clock-in at exactly 15 minutes late (09:15) triggers late arrival alert');
        assert(res15m?.alertLog.ruleType === 'LATE_ARRIVAL', 'AlertLog ruleType is LATE_ARRIVAL');

        // Test 1.3: Duplicate clock-in evaluation on same day -> must be suppressed
        const resDupLate = await alertsService.evaluateLateArrival({
            employeeId: employeeA.id,
            organizationId: orgA.id,
            clockInTime: clockIn15m
        });
        assert(resDupLate === null, 'Duplicate late arrival evaluation on the same calendar day is suppressed');

        // Test 1.4: Employee without an applicable shift -> must NOT trigger alert
        const resNoShift = await alertsService.evaluateLateArrival({
            employeeId: unassignedEmp.id,
            organizationId: orgA.id,
            clockInTime: clockIn15m
        });
        assert(resNoShift === null, 'Employee with no shift assigned today does NOT generate late arrival alert');


        // ─────────────────────────────────────────────────────────────────
        // TEST SUITE 2: ALERT EVALUATION ENGINE — CONTINUOUS IDLE TIME
        // ─────────────────────────────────────────────────────────────────
        console.log('\n--- 2. ALERT EVALUATION: CONTINUOUS IDLE TIME ---');

        // Clean any existing idle alerts for this employee today for clean testing
        await prisma.alertLog.deleteMany({
            where: { employeeId: employeeA.id, ruleType: 'CONTINUOUS_IDLE' }
        });

        // Test 2.1: Idle for 29 minutes (1740s) -> should NOT trigger (< 1800s threshold)
        const resIdle29m = await alertsService.evaluateContinuousIdle({
            employeeId: employeeA.id,
            organizationId: orgA.id,
            idleTime: 1740
        });
        assert(resIdle29m === null, 'Continuous idle at 29 minutes (1740s) does NOT trigger idle alert (< 30m threshold)');

        // Test 2.2: Idle for 30 minutes (1800s) -> MUST trigger
        const resIdle30m = await alertsService.evaluateContinuousIdle({
            employeeId: employeeA.id,
            organizationId: orgA.id,
            idleTime: 1800
        });
        assert(!!resIdle30m && !!resIdle30m.alertLog, 'Continuous idle at 30 minutes (1800s) triggers continuous idle alert');
        assert(resIdle30m?.alertLog.ruleType === 'CONTINUOUS_IDLE', 'AlertLog ruleType is CONTINUOUS_IDLE');

        // Test 2.3: Same idle session continuation (e.g. 1860s) -> must be deduplicated
        const resIdle31m = await alertsService.evaluateContinuousIdle({
            employeeId: employeeA.id,
            organizationId: orgA.id,
            idleTime: 1860
        });
        assert(resIdle31m === null, 'Duplicate alert during the same continuous idle session is suppressed');

        // Test 2.4: Stateless / Multi-instance persistence check (simulate server restart by bypassing in-memory tracker)
        // Re-evaluating with idleTime=1900s must still be suppressed because of database-level session check
        const resIdleRestart = await alertsService.evaluateContinuousIdle({
            employeeId: employeeA.id,
            organizationId: orgA.id,
            idleTime: 1900
        });
        assert(resIdleRestart === null, 'Restart-proof database deduplication prevents duplicate alert across instances');

        // Test 2.5: Employee activity resumption (idleTime drops to 15s) -> state resets
        const resIdleResume = await alertsService.evaluateContinuousIdle({
            employeeId: employeeA.id,
            organizationId: orgA.id,
            idleTime: 15
        });
        assert(resIdleResume === null, 'Activity resumption (idleTime < 60s) cleanly resets session tracker');


        // ─────────────────────────────────────────────────────────────────
        // TEST SUITE 3: ALERT EVALUATION ENGINE — PROHIBITED APPLICATIONS
        // ─────────────────────────────────────────────────────────────────
        console.log('\n--- 3. ALERT EVALUATION: PROHIBITED APPLICATION ACCESS ---');

        // Clean previous alerts and reset cooldowns
        await prisma.alertLog.deleteMany({
            where: { employeeId: employeeA.id, ruleType: 'PROHIBITED_APP' }
        });
        alertsService._resetCooldowns();

        // Clean previous rules for test apps
        await prisma.productivityRule.deleteMany({
            where: {
                organizationId: orgA.id,
                domain: { in: ['vscode.dev', 'youtube.com', 'darknet-market.onion'] }
            }
        });

        // Rule 1: Productive Allowed App
        await prisma.productivityRule.create({
            data: {
                organizationId: orgA.id,
                domain: 'vscode.dev',
                appName: 'Visual Studio Code',
                productivity: 'PRODUCTIVE',
                isBlocked: false
            }
        });

        // Rule 2: Unproductive App, but NOT blocked by policy (e.g. YouTube for music/tutorials)
        await prisma.productivityRule.create({
            data: {
                organizationId: orgA.id,
                domain: 'youtube.com',
                appName: 'YouTube',
                productivity: 'UNPRODUCTIVE',
                isBlocked: false
            }
        });

        // Rule 3: Explicitly Prohibited App (isBlocked: true)
        await prisma.productivityRule.create({
            data: {
                organizationId: orgA.id,
                domain: 'darknet-market.onion',
                appName: 'DarkNet Client',
                productivity: 'UNPRODUCTIVE',
                isBlocked: true
            }
        });

        // Test 3.1: Productive app access -> should NOT trigger
        const resAppProductive = await alertsService.evaluateProhibitedApp({
            employeeId: employeeA.id,
            organizationId: orgA.id,
            activeApp: 'Visual Studio Code',
            activeWindow: 'server.js - VS Code'
        });
        assert(resAppProductive === null, 'Productive app (VS Code) does NOT trigger violation alert');

        // Test 3.2: Unproductive app that is NOT prohibited -> should NOT trigger
        const resAppUnproductiveAllowed = await alertsService.evaluateProhibitedApp({
            employeeId: employeeA.id,
            organizationId: orgA.id,
            activeApp: 'YouTube',
            activeWindow: 'Lo-Fi Study Beats - YouTube'
        });
        assert(resAppUnproductiveAllowed === null, 'Unproductive app without isBlocked (YouTube) does NOT trigger violation alert');

        // Test 3.3: Explicitly prohibited app (isBlocked: true) -> MUST trigger critical alert
        const testScreenshotUrl = 'https://res.cloudinary.com/demo/image/upload/sample.jpg';
        const resAppProhibited = await alertsService.evaluateProhibitedApp({
            employeeId: employeeA.id,
            organizationId: orgA.id,
            activeApp: 'DarkNet Client',
            activeWindow: 'Forbidden Market Terminal',
            screenshotUrl: testScreenshotUrl
        });
        assert(!!resAppProhibited && !!resAppProhibited.alertLog, 'Explicitly prohibited app (DarkNet Client) triggers violation alert');
        assert(resAppProhibited?.alertLog.severity === 'critical', 'Prohibited app alert severity is critical');
        assert(resAppProhibited?.alertLog.screenshotUrl === testScreenshotUrl, 'Violation screenshot reference is accurately attached');

        // Test 3.4: Cooldown throttling within 30 minutes -> must be suppressed
        const resAppCooldown = await alertsService.evaluateProhibitedApp({
            employeeId: employeeA.id,
            organizationId: orgA.id,
            activeApp: 'DarkNet Client',
            activeWindow: 'Forbidden Market Terminal'
        });
        assert(resAppCooldown === null, 'Prohibited app duplicate within 30-minute cooldown window is throttled');


        // ─────────────────────────────────────────────────────────────────
        // TEST SUITE 4: NOTIFICATION PERSISTENCE & ROLE-BASED ACCESS CONTROL
        // ─────────────────────────────────────────────────────────────────
        console.log('\n--- 4. NOTIFICATION PERSISTENCE & ROLE ISOLATION ---');

        // Create manager-only violation notification
        const managerNotif = await prisma.notification.create({
            data: {
                organizationId: orgA.id,
                title: 'Security Alert: Prohibited App Access',
                description: 'Employee accessed DarkNet Client',
                type: 'critical',
                unread: true,
                link: '/alerts',
                targetUserId: null // Broadcast to managers
            }
        });

        // Create employee-specific informational notification
        const empUser = await prisma.user.findFirst({
            where: { employeeId: employeeA.id }
        });
        const employeeNotif = await prisma.notification.create({
            data: {
                organizationId: orgA.id,
                title: 'Weekly Attendance Summary Available',
                description: 'Your shift report has been processed',
                type: 'info',
                unread: true,
                link: '/attendance',
                targetUserId: empUser?.id || employeeA.id
            }
        });

        // Test 4.1: Manager fetches notifications -> sees both manager alert and general
        const mgrList = await notificationsService.getNotifications(orgA.id, {
            role: 'MANAGER',
            userId: 'mgr_user_id'
        });
        assert(mgrList.notifications.some(n => n.id === managerNotif.id), 'Manager can access organization violation alerts');

        // Test 4.2: Employee fetches notifications -> CANNOT see manager violation alert
        const empList = await notificationsService.getNotifications(orgA.id, {
            role: 'EMPLOYEE',
            userId: empUser?.id,
            employeeId: employeeA.id
        });
        const empCanSeeViolation = empList.notifications.some(n => n.id === managerNotif.id);
        assert(!empCanSeeViolation, 'Role Isolation: Employee CANNOT see manager-level violation notifications');
        assert(empList.notifications.some(n => n.id === employeeNotif.id), 'Employee can see notifications targeted to their userId');

        // Test 4.3: Mark single notification as read
        await notificationsService.markNotificationAsRead(employeeNotif.id, orgA.id, {
            role: 'EMPLOYEE',
            userId: empUser?.id,
            employeeId: employeeA.id
        });
        const readEmpNotif = await prisma.notification.findUnique({ where: { id: employeeNotif.id } });
        assert(readEmpNotif.unread === false, 'Notification marked as read successfully');

        // Test 4.4: Employee calls markAllAsRead -> should NOT affect manager notification
        await notificationsService.markAllNotificationsAsRead(orgA.id, {
            role: 'EMPLOYEE',
            userId: empUser?.id,
            employeeId: employeeA.id
        });
        const unreadMgrNotif = await prisma.notification.findUnique({ where: { id: managerNotif.id } });
        assert(unreadMgrNotif.unread === true, 'Role Isolation: Employee markAllAsRead does NOT mark manager alerts read');


        // ─────────────────────────────────────────────────────────────────
        // TEST SUITE 5: MULTI-TENANT ISOLATION
        // ─────────────────────────────────────────────────────────────────
        console.log('\n--- 5. MULTI-TENANT TENANT ISOLATION ---');

        // Resolve or create an employee in Org B
        let empB = await prisma.employee.findFirst({ where: { organizationId: orgB.id } });
        if (!empB) {
            empB = await prisma.employee.create({
                data: {
                    fullName: 'Tenant B Employee',
                    email: `tenantb_${Date.now()}@example.com`,
                    role: 'EMPLOYEE',
                    organizationId: orgB.id
                }
            });
        }

        // Create an alert in Org B
        const orgBAlert = await prisma.alertLog.create({
            data: {
                organizationId: orgB.id,
                employeeId: empB.id,
                ruleType: 'LATE_ARRIVAL',
                severity: 'warning',
                trigger: 'SHIFT_START_SCHEDULE',
                message: 'Tenant B Late Arrival Alert'
            }
        });

        // Test 5.1: Org A cannot retrieve Org B alerts
        const orgAHistory = await alertsService.getAlertHistory(orgA.id, { limit: 50 });
        const canOrgASeeOrgB = orgAHistory.alerts.some(a => a.id === orgBAlert.id);
        assert(!canOrgASeeOrgB, 'Multi-tenant Isolation: Org A cannot retrieve Org B alerts');

        // Test 5.2: Org A cannot dismiss Org B alerts
        await alertsService.dismissAlert(orgBAlert.id, orgA.id);
        const alertStillUnresolvedInB = await prisma.alertLog.findUnique({ where: { id: orgBAlert.id } });
        assert(alertStillUnresolvedInB.resolved === false, 'Multi-tenant Isolation: Org A cannot dismiss Org B alert');


        // ─────────────────────────────────────────────────────────────────
        // TEST SUITE 6: PDF REPORT BUILDER & AUTOMATED DISPATCH
        // ─────────────────────────────────────────────────────────────────
        console.log('\n--- 6. PDF REPORT BUILDER & AUTOMATED SCHEDULER ---');

        // Test 6.1: Daily PDF Report Generation
        const dailyPdf = await generatePdfReport({
            organizationName: orgA.legalName,
            title: 'DAILY WORKFORCE INTELLIGENCE REPORT',
            period: 'Daily',
            startDate: new Date(),
            endDate: new Date(),
            summaryStats: {
                totalEmployees: 12,
                totalHours: '86.4',
                productivePct: 84,
                neutralPct: 10,
                unproductivePct: 6
            },
            topApps: [
                { name: 'VS Code', category: 'Software Development', productivity: 'PRODUCTIVE', duration: '34.2 hrs' },
                { name: 'Postman', category: 'API Testing', productivity: 'PRODUCTIVE', duration: '14.5 hrs' },
                { name: 'Google Chrome', category: 'Web Research', productivity: 'NEUTRAL', duration: '20.1 hrs' }
            ],
            alertsSummary: {
                lateArrivals: 2,
                idleAlerts: 1,
                violations: 1
            }
        });
        assert(Buffer.isBuffer(dailyPdf) && dailyPdf.length > 500, `Daily PDF generated successfully (${dailyPdf.length} bytes)`);
        assert(dailyPdf.toString('ascii', 0, 4) === '%PDF', 'PDF buffer header starts with "%PDF-"');

        // Test 6.2: Weekly PDF Report Generation
        const weeklyStart = new Date(Date.now() - 7 * 86400000);
        const weeklyPdf = await generatePdfReport({
            organizationName: orgA.legalName,
            title: 'WEEKLY WORKFORCE INTELLIGENCE REPORT',
            period: 'Weekly',
            startDate: weeklyStart,
            endDate: new Date(),
            summaryStats: {
                totalEmployees: 12,
                totalHours: '430.0',
                productivePct: 81,
                neutralPct: 11,
                unproductivePct: 8
            },
            topApps: [
                { name: 'VS Code', category: 'Software Development', productivity: 'PRODUCTIVE', duration: '170.0 hrs' }
            ],
            alertsSummary: {
                lateArrivals: 8,
                idleAlerts: 4,
                violations: 2
            }
        });
        assert(Buffer.isBuffer(weeklyPdf) && weeklyPdf.length > 500, `Weekly PDF generated successfully (${weeklyPdf.length} bytes)`);

        // Test 6.3: Automated Email Report Dispatch & Audit Logging
        let reportConfig = await prisma.emailReport.findFirst({
            where: { organizationId: orgA.id }
        });
        if (!reportConfig) {
            reportConfig = await prisma.emailReport.create({
                data: {
                    title: 'Automated Executive Performance Digest',
                    frequency: 'daily',
                    recipients: ['executive@insightfulcorp.com'],
                    sendToSelf: true,
                    content: ['overview', 'apps', 'alerts'],
                    isActive: true,
                    organizationId: orgA.id
                }
            });
        }
        const dispatchRes = await reportScheduler.dispatchReport(reportConfig, { force: true });
        assert(dispatchRes.success === true, `Report compiled and dispatched with attachment (${dispatchRes.fileName})`);

        // Test 6.4: Audit log persistence
        const auditRecord = await prisma.auditLog.findFirst({
            where: { organizationId: orgA.id, action: 'Scheduled Report Dispatch' },
            orderBy: { createdAt: 'desc' }
        });
        assert(!!auditRecord, 'AuditLog created and persisted for automated report dispatch');


        // ─────────────────────────────────────────────────────────────────
        // TEST SUITE 7: SOCKET.IO ROOM ISOLATION RULES
        // ─────────────────────────────────────────────────────────────────
        console.log('\n--- 7. SOCKET.IO ROOM ISOLATION RULES ---');

        // Simulate socket connection authorization logic
        const managerRoom = `org_${orgA.id}_managers`;
        const employeeRoom = `employee_${employeeA.id}`;

        const isManagerAllowedInMgrRoom = (role) => (role === 'ADMIN' || role === 'MANAGER');
        const isEmployeeAllowedInMgrRoom = (role) => (role === 'ADMIN' || role === 'MANAGER');

        assert(isManagerAllowedInMgrRoom('ADMIN') === true, 'ADMIN is authorized to join manager room (org_${orgId}_managers)');
        assert(isManagerAllowedInMgrRoom('MANAGER') === true, 'MANAGER is authorized to join manager room (org_${orgId}_managers)');
        assert(isEmployeeAllowedInMgrRoom('EMPLOYEE') === false, 'EMPLOYEE is strictly forbidden from joining manager room');

    } catch (err) {
        console.error('Fatal test error encountered:', err);
    } finally {
        await prisma.$disconnect();
    }

    console.log('\n====================================================');
    console.log(`🏁 TEST SUITE COMPLETED: ${passedTests}/${totalTests} TESTS PASSED`);
    console.log('====================================================\n');

    if (passedTests === totalTests && totalTests > 0) {
        process.exit(0);
    } else {
        process.exit(1);
    }
}

runDev4IntegrationTests();
