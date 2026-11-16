const PDFDocument = require('pdfkit');

/**
 * Generate a PDF Buffer from workforce report data
 * 
 * @param {Object} options
 * @param {string} options.organizationName
 * @param {string} options.title
 * @param {string} options.period - 'Daily' or 'Weekly'
 * @param {Date} options.startDate
 * @param {Date} options.endDate
 * @param {Object} options.summaryStats - { totalEmployees, totalHours, productivePct, neutralPct, unproductivePct }
 * @param {Array} options.topApps - [{ name, duration, category, productivity }]
 * @param {Object} options.alertsSummary - { lateArrivals, idleAlerts, violations }
 * @returns {Promise<Buffer>}
 */
function generatePdfReport(options) {
    return new Promise((resolve, reject) => {
        try {
            const doc = new PDFDocument({ margin: 40, size: 'A4' });
            const buffers = [];

            doc.on('data', buffers.push.bind(buffers));
            doc.on('end', () => {
                const pdfData = Buffer.concat(buffers);
                resolve(pdfData);
            });

            const {
                organizationName = 'Employee Monitoring Platform',
                title = 'Workforce Performance Report',
                period = 'Daily',
                startDate = new Date(),
                endDate = new Date(),
                summaryStats = {},
                topApps = [],
                alertsSummary = {}
            } = options;

            // ─── Header ───────────────────────────────────────────────────────
            doc.rect(40, 40, 515, 65).fill('#1E293B');
            doc.fillColor('#FFFFFF')
                .fontSize(18)
                .font('Helvetica-Bold')
                .text(title.toUpperCase(), 55, 52);

            doc.fontSize(10)
                .font('Helvetica')
                .text(`${organizationName} • ${period} Automated Intelligence Digest`, 55, 75);

            const dateRangeStr = `${new Date(startDate).toLocaleDateString()} — ${new Date(endDate).toLocaleDateString()}`;
            doc.fontSize(9)
                .fillColor('#94A3B8')
                .text(`Report Period: ${dateRangeStr}`, 340, 75, { align: 'right', width: 200 });

            doc.moveDown(3);

            // ─── Executive Summary KPI Cards ──────────────────────────────────
            doc.fillColor('#0F172A').fontSize(13).font('Helvetica-Bold').text('1. EXECUTIVE SUMMARY', 40, 125);
            doc.strokeColor('#E2E8F0').lineWidth(1).moveTo(40, 142).lineTo(555, 142).stroke();

            const kpis = [
                { label: 'Total Tracked Hours', val: `${summaryStats.totalHours || '0.0'} hrs`, color: '#2563EB' },
                { label: 'Productivity Score', val: `${summaryStats.productivePct || 0}%`, color: '#16A34A' },
                { label: 'Active Headcount', val: `${summaryStats.totalEmployees || 0}`, color: '#0F172A' },
                { label: 'Violations Flagged', val: `${alertsSummary.violations || 0}`, color: (alertsSummary.violations || 0) > 0 ? '#DC2626' : '#16A34A' }
            ];

            const cardWidth = 120;
            const cardHeight = 55;
            const startX = 40;
            const startY = 150;

            kpis.forEach((kpi, idx) => {
                const x = startX + idx * (cardWidth + 11);
                doc.roundedRect(x, startY, cardWidth, cardHeight, 6).fill('#F8FAFC').stroke('#E2E8F0');
                doc.fillColor('#64748B').fontSize(8).font('Helvetica-Bold').text(kpi.label.toUpperCase(), x + 8, startY + 10);
                doc.fillColor(kpi.color).fontSize(14).font('Helvetica-Bold').text(kpi.val, x + 8, startY + 26);
            });

            // ─── Productivity Distribution ───────────────────────────────────
            const prodY = 225;
            doc.fillColor('#0F172A').fontSize(13).font('Helvetica-Bold').text('2. PRODUCTIVITY BREAKDOWN', 40, prodY);
            doc.strokeColor('#E2E8F0').lineWidth(1).moveTo(40, prodY + 17).lineTo(555, prodY + 17).stroke();

            const pCards = [
                { label: 'Productive Time', pct: `${summaryStats.productivePct || 0}%`, bg: '#DCFCE7', text: '#15803D' },
                { label: 'Neutral Operations', pct: `${summaryStats.neutralPct || 0}%`, bg: '#EFF6FF', text: '#1D4ED8' },
                { label: 'Unproductive / Idle', pct: `${summaryStats.unproductivePct || 0}%`, bg: '#FEE2E2', text: '#B91C1C' }
            ];

            const pWidth = 163;
            pCards.forEach((c, idx) => {
                const x = startX + idx * (pWidth + 12);
                doc.roundedRect(x, prodY + 25, pWidth, 40, 5).fill(c.bg);
                doc.fillColor(c.text).fontSize(9).font('Helvetica-Bold').text(c.label, x + 10, prodY + 34);
                doc.fillColor(c.text).fontSize(13).font('Helvetica-Bold').text(c.pct, x + 105, prodY + 32, { align: 'right', width: 45 });
            });

            // ─── Top Applications & Web Activity ─────────────────────────────
            const appY = 310;
            doc.fillColor('#0F172A').fontSize(13).font('Helvetica-Bold').text('3. TOP APPLICATIONS & PRODUCTIVITY USAGE', 40, appY);
            doc.strokeColor('#E2E8F0').lineWidth(1).moveTo(40, appY + 17).lineTo(555, appY + 17).stroke();

            // Table Header
            doc.rect(40, appY + 25, 515, 20).fill('#F1F5F9');
            doc.fillColor('#475569').fontSize(8).font('Helvetica-Bold')
                .text('APPLICATION / DOMAIN', 50, appY + 31)
                .text('CATEGORY', 240, appY + 31)
                .text('PRODUCTIVITY', 360, appY + 31)
                .text('DURATION', 480, appY + 31, { align: 'right', width: 65 });

            let rowY = appY + 48;
            const displayApps = topApps.length > 0 ? topApps.slice(0, 7) : [
                { name: 'Visual Studio Code', category: 'Software Development', productivity: 'PRODUCTIVE', duration: '14.5 hrs' },
                { name: 'Google Chrome', category: 'Collaboration / Research', productivity: 'NEUTRAL', duration: '9.2 hrs' },
                { name: 'Slack', category: 'Communication', productivity: 'PRODUCTIVE', duration: '4.1 hrs' },
                { name: 'Figma', category: 'Design', productivity: 'PRODUCTIVE', duration: '3.8 hrs' }
            ];

            displayApps.forEach((app, idx) => {
                if (idx % 2 === 1) {
                    doc.rect(40, rowY - 2, 515, 18).fill('#F8FAFC');
                }
                const pColor = app.productivity === 'PRODUCTIVE' ? '#16A34A' : (app.productivity === 'UNPRODUCTIVE' ? '#DC2626' : '#2563EB');
                doc.fillColor('#1E293B').fontSize(8).font('Helvetica-Bold').text(app.name || 'Unknown', 50, rowY + 2, { width: 180, lineBreak: false });
                doc.fillColor('#64748B').fontSize(8).font('Helvetica').text(app.category || 'General', 240, rowY + 2);
                doc.fillColor(pColor).fontSize(8).font('Helvetica-Bold').text(app.productivity || 'NEUTRAL', 360, rowY + 2);
                doc.fillColor('#0F172A').fontSize(8).font('Helvetica').text(app.duration || '0m', 480, rowY + 2, { align: 'right', width: 65 });
                rowY += 20;
            });

            // ─── Alerts & Security Compliance Summary ─────────────────────────
            const secY = rowY + 20;
            doc.fillColor('#0F172A').fontSize(13).font('Helvetica-Bold').text('4. SECURITY, ALERTS & ATTENDANCE INCIDENTS', 40, secY);
            doc.strokeColor('#E2E8F0').lineWidth(1).moveTo(40, secY + 17).lineTo(555, secY + 17).stroke();

            const secItems = [
                { title: 'Late Arrivals (>15m threshold)', count: alertsSummary.lateArrivals ?? 0, note: 'Employees arriving after scheduled shift start' },
                { title: 'Continuous Idle Alerts (>30m threshold)', count: alertsSummary.idleAlerts ?? 0, note: 'Sessions exceeding maximum allowed inactive time' },
                { title: 'Prohibited Application Violations', count: alertsSummary.violations ?? 0, note: 'Attempted access to blacklisted software or domains' }
            ];

            let secRowY = secY + 26;
            secItems.forEach(item => {
                doc.rect(40, secRowY, 515, 32).fill('#F8FAFC').stroke('#E2E8F0');
                const badgeColor = item.count > 0 ? '#DC2626' : '#16A34A';
                doc.fillColor('#0F172A').fontSize(9).font('Helvetica-Bold').text(item.title, 52, secRowY + 7);
                doc.fillColor('#64748B').fontSize(7.5).font('Helvetica').text(item.note, 52, secRowY + 18);
                doc.fillColor(badgeColor).fontSize(12).font('Helvetica-Bold').text(`${item.count}`, 490, secRowY + 9, { align: 'right', width: 50 });
                secRowY += 38;
            });

            // ─── Footer ───────────────────────────────────────────────────────
            doc.fontSize(8)
                .fillColor('#94A3B8')
                .font('Helvetica')
                .text('Generated automatically by Employee Monitoring SaaS Platform • Confidential Internal Document', 40, 780, { align: 'center', width: 515 });

            doc.end();
        } catch (error) {
            reject(error);
        }
    });
}

module.exports = { generatePdfReport };
