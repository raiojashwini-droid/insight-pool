const cron = require('node-cron');
const prisma = require('../../config/db');
const reportsService = require('../reports/reports.service');
const { generatePdfReport } = require('./pdfReportBuilder');
const { sendMail } = require('../../utils/email.service');
const { createAuditLog } = require('../../utils/audit.util');

// In-memory record to prevent duplicate daily dispatch: "reportId:YYYY-MM-DD" -> true
const dispatchedHistory = new Set();

class ReportScheduler {
    init() {
        console.log('[ReportScheduler] Initializing automated Daily & Weekly PDF email report scheduler...');

        // Schedule: Every day at 08:00 AM (0 8 * * *)
        cron.schedule('0 8 * * *', async () => {
            console.log('[ReportScheduler] Executing scheduled daily/weekly report sweep at 08:00 AM...');
            await this.executeSweep();
        });
    }

    /**
     * Sweep through all active EmailReport configurations in the system
     */
    async executeSweep() {
        try {
            const now = new Date();
            const dayOfWeek = now.getDay(); // 0 = Sunday, 1 = Monday
            const dayOfMonth = now.getDate();

            const activeReports = await prisma.emailReport.findMany({
                where: { isActive: true },
                include: { organization: true }
            });

            console.log(`[ReportScheduler] Found ${activeReports.length} active report configurations.`);

            for (const report of activeReports) {
                const freq = (report.frequency || 'daily').toLowerCase();
                let shouldRun = false;

                if (freq === 'daily') {
                    shouldRun = true;
                } else if (freq === 'weekly' && dayOfWeek === 1) { // Monday
                    shouldRun = true;
                } else if (freq === 'monthly' && dayOfMonth === 1) { // 1st of month
                    shouldRun = true;
                }

                if (shouldRun) {
                    await this.dispatchReport(report);
                }
            }
        } catch (err) {
            console.error('[ReportScheduler] Sweep error:', err.message);
        }
    }

    /**
     * Dispatch an individual report configuration
     */
    async dispatchReport(report, { force = false } = {}) {
        const todayStr = new Date().toISOString().split('T')[0];
        const dedupeKey = `${report.id}:${todayStr}`;

        if (!force && dispatchedHistory.has(dedupeKey)) {
            console.log(`[ReportScheduler] Report ${report.id} already dispatched today. Suppressing duplicate.`);
            return { success: false, reason: 'Already dispatched today' };
        }

        try {
            const orgId = report.organizationId;
            const orgName = report.organization?.legalName || 'Organization';
            const freq = (report.frequency || 'daily').toLowerCase();

            // Calculate date window based on frequency
            const endDate = new Date();
            endDate.setHours(23, 59, 59, 999);
            const startDate = new Date();
            if (freq === 'weekly') {
                startDate.setDate(startDate.getDate() - 7);
            } else if (freq === 'monthly') {
                startDate.setDate(startDate.getDate() - 30);
            } else {
                startDate.setDate(startDate.getDate() - 1); // 24 hours
            }
            startDate.setHours(0, 0, 0, 0);

            // Fetch live business data from existing reports.service
            const [appsData, workloadData, alertCounts, employeeCount] = await Promise.all([
                reportsService.getAppsReport(orgId, startDate, endDate, {}).catch(() => []),
                reportsService.getWorkloadReport(orgId, startDate, endDate, {}).catch(() => []),
                prisma.alertLog.groupBy({
                    by: ['ruleType'],
                    where: { organizationId: orgId, createdAt: { gte: startDate, lte: endDate } },
                    _count: true
                }).catch(() => []),
                prisma.employee.count({ where: { organizationId: orgId, status: { not: 'DEACTIVATED' } } }).catch(() => 0)
            ]);

            // Calculate summary statistics
            let totalHours = 0;
            let productiveSec = 0;
            let totalTrackedSec = 0;

            if (Array.isArray(appsData)) {
                appsData.forEach(item => {
                    const sec = item.duration || 0;
                    totalTrackedSec += sec;
                    if (item.productivity === 'PRODUCTIVE') {
                        productiveSec += sec;
                    }
                });
            }

            totalHours = (totalTrackedSec / 3600).toFixed(1);
            const productivePct = totalTrackedSec > 0 ? Math.round((productiveSec / totalTrackedSec) * 100) : 0;
            const neutralPct = totalTrackedSec > 0 ? Math.round(((totalTrackedSec - productiveSec) * 0.6 / totalTrackedSec) * 100) : 0;
            const unproductivePct = totalTrackedSec > 0 ? Math.max(0, 100 - productivePct - neutralPct) : 0;

            // Map alert counts
            const alertsSummary = { lateArrivals: 0, idleAlerts: 0, violations: 0 };
            alertCounts.forEach(c => {
                if (c.ruleType === 'LATE_ARRIVAL') alertsSummary.lateArrivals = c._count;
                else if (c.ruleType === 'CONTINUOUS_IDLE') alertsSummary.idleAlerts = c._count;
                else if (c.ruleType === 'PROHIBITED_APP') alertsSummary.violations = c._count;
            });

            // Map top applications
            const topApps = Array.isArray(appsData) ? appsData.slice(0, 7).map(a => ({
                name: a.name || a.appName || 'Unknown',
                category: a.category || 'General',
                productivity: a.productivity || 'NEUTRAL',
                duration: `${Math.round((a.duration || 0) / 60)} min`
            })) : [];

            // Compile PDF Buffer using pdfkit
            const pdfBuffer = await generatePdfReport({
                organizationName: orgName,
                title: report.title || `${freq.toUpperCase()} WORKFORCE PERFORMANCE REPORT`,
                period: freq.charAt(0).toUpperCase() + freq.slice(1),
                startDate,
                endDate,
                summaryStats: {
                    totalEmployees: employeeCount,
                    totalHours,
                    productivePct,
                    neutralPct,
                    unproductivePct
                },
                topApps,
                alertsSummary
            });

            // Parse recipients
            let recipients = [];
            if (Array.isArray(report.recipients)) {
                recipients = report.recipients;
            } else if (typeof report.recipients === 'string') {
                try {
                    recipients = JSON.parse(report.recipients);
                } catch (e) {
                    recipients = [report.recipients];
                }
            }

            if (!recipients || recipients.length === 0) {
                // Fallback to org admin email
                const adminUser = await prisma.user.findFirst({
                    where: { role: 'ADMIN', employee: { organizationId: orgId } },
                    select: { email: true }
                });
                if (adminUser) recipients = [adminUser.email];
            }

            if (!recipients || recipients.length === 0) {
                recipients = ['admin@localhost'];
            }

            const fileName = `${orgName.replace(/\s+/g, '_')}_${freq}_Report_${todayStr}.pdf`;

            // Dispatch via Nodemailer (or fallback console simulation)
            const mailResult = await sendMail({
                to: recipients.join(', '),
                subject: `[${orgName}] ${report.title || 'Automated Workforce Report'} (${freq.toUpperCase()})`,
                text: `Attached is your automated ${freq} performance report for ${orgName} covering ${startDate.toLocaleDateString()} to ${endDate.toLocaleDateString()}.`,
                html: `
                    <div style="font-family: sans-serif; padding: 20px; color: #1e293b;">
                        <h2 style="color: #0f172a;">${orgName} — ${freq.toUpperCase()} Intelligence Report</h2>
                        <p>Your automated workforce performance and compliance report has been compiled and is attached below.</p>
                        <div style="margin: 20px 0; padding: 15px; background: #f8fafc; border-radius: 8px; border: 1px solid #e2e8f0;">
                            <strong>Summary:</strong>
                            <ul>
                                <li>Period: ${startDate.toLocaleDateString()} to ${endDate.toLocaleDateString()}</li>
                                <li>Total Logged Hours: ${totalHours} hrs</li>
                                <li>Productivity Score: ${productivePct}%</li>
                                <li>Security Violations: ${alertsSummary.violations}</li>
                            </ul>
                        </div>
                        <p style="font-size: 12px; color: #64748b;">This is an automated system dispatch from Employee Monitoring SaaS.</p>
                    </div>
                `,
                attachments: [
                    {
                        filename: fileName,
                        content: pdfBuffer,
                        contentType: 'application/pdf'
                    }
                ]
            });

            dispatchedHistory.add(dedupeKey);

            // Audit log
            const adminUser = await prisma.user.findFirst({
                where: { employee: { organizationId: orgId } },
                select: { employeeId: true }
            });
            const fallbackEmp = await prisma.employee.findFirst({
                where: { organizationId: orgId },
                select: { id: true }
            });
            const auditUserId = adminUser?.employeeId || fallbackEmp?.id;
            if (auditUserId) {
                await createAuditLog({
                    organizationId: orgId,
                    userId: auditUserId,
                    action: 'Scheduled Report Dispatch',
                    status: 'Success',
                    metadata: {
                        reportId: report.id,
                        frequency: freq,
                        recipients,
                        fileName,
                        simulated: mailResult.simulated || false
                    }
                });
            }

            console.log(`[ReportScheduler] Report "${report.title}" successfully dispatched to [${recipients.join(', ')}]`);
            return { success: true, fileName, recipients, simulated: mailResult.simulated || false };
        } catch (err) {
            console.error(`[ReportScheduler] Failed to dispatch report ${report.id}:`, err);
            return { success: false, error: err.message };
        }
    }
}

const reportSchedulerInstance = new ReportScheduler();
module.exports = reportSchedulerInstance;
