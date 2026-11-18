const nodemailer = require('nodemailer');

function createTransport() {
    const host = process.env.EMAIL_HOST || process.env.SMTP_HOST;
    if (!host) return null;

    const user = process.env.EMAIL_USER || process.env.SMTP_USER;
    const pass = process.env.EMAIL_PASS || process.env.SMTP_PASS;

    // Check if user has dummy placeholder values
    if (!user || user.includes('your_email') || !pass || pass.includes('your_app_password') || pass.includes('your_google_app_password')) {
        return null;
    }

    return nodemailer.createTransport({
        host,
        port: parseInt(process.env.EMAIL_PORT || process.env.SMTP_PORT || '587', 10),
        secure: (process.env.EMAIL_SECURE === 'true' || process.env.SMTP_SECURE === 'true'),
        auth: {
            user,
            pass,
        },
    });
}

async function sendMail({ to, subject, html, text, attachments }) {
    const transport = createTransport();
    const from = process.env.EMAIL_FROM || process.env.SMTP_FROM || 'Employee Monitoring <noreply@localhost>';

    if (!transport) {
        console.log('\n================== EMAIL ALERT (Simulated / SMTP Not Configured) ==================');
        console.log(`From:    ${from}`);
        console.log(`To:      ${to}`);
        console.log(`Subject: ${subject}`);
        console.log(`Attachments: ${attachments ? attachments.map(a => a.filename).join(', ') : 'None'}`);
        console.log(`Body:\n${text || html}`);
        console.log('===================================================================================\n');
        return { sent: false, simulated: true };
    }

    try {
        const info = await transport.sendMail({ from, to, subject, html, text, attachments });
        console.log(`[EmailService] Real Email sent successfully to ${to}. MessageId: ${info.messageId}`);
        return { sent: true, messageId: info.messageId };
    } catch (err) {
        console.error(`[EmailService] Failed to send email to ${to}:`, err.message);
        return { sent: false, error: err.message };
    }
}

/**
 * Send Inactivity / Idle Alert Email to Employee's Assigned Manager or Admin
 */
async function sendIdleAlertEmail({ employee, manager, idleDuration, taskId, timestamp }) {
    const managerEmail = manager?.email || process.env.ADMIN_ALERT_EMAIL || 'admin@gmail.com';
    const managerName = manager?.fullName || manager?.name || 'Manager';
    const employeeName = employee?.fullName || employee?.name || 'Employee';
    const employeeEmail = employee?.email || 'N/A';
    const teamName = employee?.team?.name || 'General Team';
    const idleMinutes = Math.round((idleDuration || 600) / 60);

    const subject = `⚠️ Inactivity Alert: ${employeeName} is Idle (${idleMinutes} mins)`;
    
    const html = `
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="utf-8">
        <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f8fafc; color: #1e293b; padding: 24px; margin: 0; }
            .container { max-width: 580px; margin: 0 auto; background: #ffffff; border-radius: 16px; border: 1px solid #e2e8f0; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05); }
            .header { background: #4f46e5; padding: 24px; color: #ffffff; text-align: left; }
            .header h1 { margin: 0; font-size: 20px; font-weight: 800; letter-spacing: -0.5px; }
            .badge { display: inline-block; background: rgba(255, 255, 255, 0.2); padding: 4px 10px; border-radius: 20px; font-size: 11px; font-weight: 700; text-transform: uppercase; margin-top: 8px; }
            .content { padding: 24px; }
            .alert-box { background: #fef2f2; border: 1px solid #fecaca; border-left: 4px solid #ef4444; border-radius: 10px; padding: 14px 16px; margin-bottom: 20px; }
            .alert-title { font-size: 13px; font-weight: 800; color: #991b1b; margin-bottom: 4px; }
            .alert-desc { font-size: 12px; color: #b91c1c; line-height: 1.5; margin: 0; }
            .details-table { width: 100%; border-collapse: collapse; margin-bottom: 24px; font-size: 13px; }
            .details-table td { padding: 10px 12px; border-bottom: 1px solid #f1f5f9; }
            .details-table td.label { font-weight: 700; color: #64748b; width: 38%; }
            .details-table td.value { font-weight: 800; color: #0f172a; }
            .btn { display: inline-block; background: #4f46e5; color: #ffffff; text-decoration: none; padding: 12px 24px; border-radius: 10px; font-size: 13px; font-weight: 700; text-align: center; }
            .footer { padding: 16px 24px; background: #f8fafc; border-top: 1px solid #e2e8f0; font-size: 11px; color: #94a3b8; text-align: center; }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="header">
                <h1>EMS Smart Inactivity Alert</h1>
                <div class="badge">Mouse & Keyboard Inactivity Detected</div>
            </div>
            <div class="content">
                <p style="font-size: 14px; margin-top: 0;">Hello <strong>${managerName}</strong>,</p>
                <div class="alert-box">
                    <div class="alert-title">Prolonged Inactivity Detected</div>
                    <p class="alert-desc">Employee <strong>${employeeName}</strong> has been inactive with no mouse or keyboard input for over <strong>${idleMinutes} minutes</strong>.</p>
                </div>

                <table class="details-table">
                    <tr>
                        <td class="label">Employee Name</td>
                        <td class="value">${employeeName}</td>
                    </tr>
                    <tr>
                        <td class="label">Email Address</td>
                        <td class="value">${employeeEmail}</td>
                    </tr>
                    <tr>
                        <td class="label">Department / Team</td>
                        <td class="value">${teamName}</td>
                    </tr>
                    <tr>
                        <td class="label">Linked Active Task</td>
                        <td class="value">${taskId || 'None (No active task linked)'}</td>
                    </tr>
                    <tr>
                        <td class="label">Idle Duration</td>
                        <td class="value" style="color: #ef4444;">${idleMinutes} minutes (${idleDuration} seconds)</td>
                    </tr>
                    <tr>
                        <td class="label">Detection Timestamp</td>
                        <td class="value">${new Date(timestamp).toLocaleString()}</td>
                    </tr>
                    <tr>
                        <td class="label">Detection Method</td>
                        <td class="value">Windows Native Inactivity (powerMonitor)</td>
                    </tr>
                </table>

                <div style="text-align: center; margin-top: 20px;">
                    <a href="${process.env.FRONTEND_URL || 'http://localhost:5173'}/admin/activities" class="btn" style="color:#ffffff;">
                        View Live Workforce Dashboard
                    </a>
                </div>
            </div>
            <div class="footer">
                Automated Security & Productivity Alert • Employee Performance Software
            </div>
        </div>
    </body>
    </html>
    `;

    return sendMail({
        to: managerEmail,
        subject,
        html,
        text: `Inactivity Alert: ${employeeName} has been idle for ${idleMinutes} minutes with no mouse/keyboard input. Timestamp: ${timestamp}. Active Task: ${taskId || 'None'}.`
    });
}

module.exports = { sendMail, sendIdleAlertEmail };