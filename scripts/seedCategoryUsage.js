const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function seedCategoryUsageLogs() {
    console.log('Seeding rich category usage logs in DB...');
    const orgId = 'default-org-id';

    const employees = await prisma.employee.findMany({
        where: { organizationId: orgId }
    });

    if (!employees || employees.length === 0) {
        console.log('No employees found to seed.');
        return;
    }

    const officeEmployees = employees.filter(e => (e.location || '').toLowerCase() === 'office' || (e.workMode || '').toLowerCase() === 'office');
    const remoteEmployees = employees.filter(e => (e.location || '').toLowerCase() !== 'office' && (e.workMode || '').toLowerCase() !== 'office');

    const defaultOfficeEmp = officeEmployees[0] || employees[0];
    const defaultRemoteEmp = remoteEmployees[0] || employees[1] || employees[0];

    // Standard categories matching Image 1
    const categoryConfigs = [
        {
            category: 'Development tools',
            apps: [
                { name: 'VS Code', domain: 'visualstudio.com', prod: 'PRODUCTIVE' },
                { name: 'Cursor', domain: 'cursor.sh', prod: 'PRODUCTIVE' },
                { name: 'GitHub Desktop', domain: 'github.com', prod: 'PRODUCTIVE' },
                { name: 'Terminal', domain: 'terminal', prod: 'PRODUCTIVE' }
            ],
            baseHours: 25.5
        },
        {
            category: 'Collaborative software',
            apps: [
                { name: 'Zoom', domain: 'zoom.us', prod: 'PRODUCTIVE' },
                { name: 'Microsoft Teams', domain: 'teams.microsoft.com', prod: 'PRODUCTIVE' },
                { name: 'Google Meet', domain: 'meet.google.com', prod: 'PRODUCTIVE' }
            ],
            baseHours: 22.0
        },
        {
            category: 'AI tools',
            apps: [
                { name: 'ChatGPT', domain: 'chatgpt.com', prod: 'PRODUCTIVE' },
                { name: 'Claude', domain: 'claude.ai', prod: 'PRODUCTIVE' },
                { name: 'Antigravity AI', domain: 'antigravity.ai', prod: 'PRODUCTIVE' }
            ],
            baseHours: 19.5
        },
        {
            category: 'PM tools',
            apps: [
                { name: 'Jira', domain: 'atlassian.net', prod: 'PRODUCTIVE' },
                { name: 'Linear', domain: 'linear.app', prod: 'PRODUCTIVE' },
                { name: 'Notion', domain: 'notion.so', prod: 'PRODUCTIVE' },
                { name: 'Trello', domain: 'trello.com', prod: 'PRODUCTIVE' }
            ],
            baseHours: 18.0
        },
        {
            category: 'Communication',
            apps: [
                { name: 'Slack', domain: 'slack.com', prod: 'PRODUCTIVE' },
                { name: 'Gmail', domain: 'gmail.com', prod: 'NEUTRAL' },
                { name: 'Outlook', domain: 'outlook.com', prod: 'NEUTRAL' }
            ],
            baseHours: 16.5
        },
        {
            category: 'Education',
            apps: [
                { name: 'Stack Overflow', domain: 'stackoverflow.com', prod: 'PRODUCTIVE' },
                { name: 'MDN Web Docs', domain: 'developer.mozilla.org', prod: 'PRODUCTIVE' },
                { name: 'Coursera', domain: 'coursera.org', prod: 'PRODUCTIVE' }
            ],
            baseHours: 14.0
        },
        {
            category: 'Advertising tools',
            apps: [
                { name: 'Google Ads', domain: 'ads.google.com', prod: 'NEUTRAL' },
                { name: 'Google Analytics', domain: 'analytics.google.com', prod: 'PRODUCTIVE' }
            ],
            baseHours: 11.5
        },
        {
            category: 'Social & Professional network',
            apps: [
                { name: 'LinkedIn', domain: 'linkedin.com', prod: 'NEUTRAL' },
                { name: 'Twitter / X', domain: 'x.com', prod: 'UNPRODUCTIVE' },
                { name: 'Reddit', domain: 'reddit.com', prod: 'UNPRODUCTIVE' }
            ],
            baseHours: 10.0
        },
        {
            category: 'Adult / Illegal',
            apps: [
                { name: 'Blocked Gaming Domain', domain: 'bet365.com', prod: 'UNPRODUCTIVE' },
                { name: 'Restricted Media', domain: 'restricted.net', prod: 'UNPRODUCTIVE' }
            ],
            baseHours: 8.5
        },
        {
            category: 'Art & Entertainment',
            apps: [
                { name: 'YouTube', domain: 'youtube.com', prod: 'UNPRODUCTIVE' },
                { name: 'Spotify', domain: 'spotify.com', prod: 'UNPRODUCTIVE' },
                { name: 'Netflix', domain: 'netflix.com', prod: 'UNPRODUCTIVE' }
            ],
            baseHours: 7.5
        },
        {
            category: 'Services',
            apps: [
                { name: 'AWS Management Console', domain: 'aws.amazon.com', prod: 'PRODUCTIVE' },
                { name: 'Cloudflare', domain: 'cloudflare.com', prod: 'PRODUCTIVE' },
                { name: 'Stripe Dashboard', domain: 'stripe.com', prod: 'PRODUCTIVE' }
            ],
            baseHours: 6.0
        },
        {
            category: 'News',
            apps: [
                { name: 'Hacker News', domain: 'news.ycombinator.com', prod: 'NEUTRAL' },
                { name: 'TechCrunch', domain: 'techcrunch.com', prod: 'NEUTRAL' }
            ],
            baseHours: 3.5
        }
    ];

    // Seed logs for the past 14 days (including today, yesterday, and past 2 weeks)
    const now = new Date();
    let recordsCreated = 0;

    for (const conf of categoryConfigs) {
        // Distribute across days 0 to 13
        for (let dayOffset = 0; dayOffset < 14; dayOffset++) {
            const logDate = new Date(now.getTime() - dayOffset * 86400000);
            
            // Choose app
            const app = conf.apps[dayOffset % conf.apps.length];
            
            // Allocate office vs remote
            const isOffice = dayOffset % 2 === 0;
            const emp = isOffice ? defaultOfficeEmp : defaultRemoteEmp;

            // Duration in seconds (e.g. 15 to 45 minutes per log)
            const duration = Math.round((conf.baseHours * 3600 / 14) * (0.8 + (dayOffset % 5) * 0.1));

            await prisma.appUsageLog.create({
                data: {
                    employeeId: emp.id,
                    organizationId: orgId,
                    appName: app.name,
                    domain: app.domain,
                    category: conf.category,
                    productivity: app.prod,
                    duration: duration,
                    timestamp: logDate
                }
            });
            recordsCreated++;
        }
    }

    console.log(`Successfully created ${recordsCreated} category usage records in the database.`);
}

seedCategoryUsageLogs()
    .catch(console.error)
    .finally(() => prisma.$disconnect());
