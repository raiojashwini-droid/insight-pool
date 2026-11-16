const nodemailer = require('nodemailer');

function createTransport() {
    if (!process.env.SMTP_HOST) return null;
    return nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT || '587', 10),
        secure: process.env.SMTP_SECURE === 'true',
        auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS,
        },
    });
}

async function sendMail({ to, subject, html, text, attachments }) {
    const transport = createTransport();
    const from = process.env.SMTP_FROM || 'Employee Monitoring <noreply@localhost>';

    if (!transport) {
        console.log('\n========== EMAIL (SMTP not configured) ==========');
        console.log(`To: ${to}`);
        console.log(`Subject: ${subject}`);
        console.log(`Attachments: ${attachments ? attachments.map(a => a.filename).join(', ') : 'None'}`);
        console.log(text || html);
        console.log('=================================================\n');
        return { sent: false, simulated: true };
    }

    await transport.sendMail({ from, to, subject, html, text, attachments });
    return { sent: true };
}

module.exports = { sendMail };
