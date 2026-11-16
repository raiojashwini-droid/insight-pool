const emailReportsService = require('./email-reports.service');
const { getOrganizationId } = require('../../utils/orgId');
const prisma = require('../../config/db');

exports.createReport = async (req, res) => {
    try {
        const organizationId = await getOrganizationId(req);
        if (!organizationId) {
            return res.status(400).json({ success: false, message: 'Organization ID is required' });
        }
        
        const report = await emailReportsService.createReport({ ...req.body, organizationId });
        res.status(201).json({ success: true, data: report });
    } catch (error) {
        console.error('Error creating email report:', error);
        res.status(500).json({ success: false, message: 'Failed to create email report' });
    }
};

exports.getReports = async (req, res) => {
    try {
        const organizationId = await getOrganizationId(req);
        if (!organizationId) {
            return res.status(400).json({ success: false, message: 'Organization ID is required' });
        }

        const reports = await emailReportsService.getReports(organizationId);
        res.json({ success: true, data: reports });
    } catch (error) {
        console.error('Error fetching email reports:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch email reports' });
    }
};

exports.updateReport = async (req, res) => {
    try {
        const organizationId = await getOrganizationId(req);
        const report = await emailReportsService.updateReport(req.params.id, req.body, organizationId);
        res.json({ success: true, data: report });
    } catch (error) {
        console.error('Error updating email report:', error);
        res.status(500).json({ success: false, message: 'Failed to update email report' });
    }
};

exports.deleteReport = async (req, res) => {
    try {
        const organizationId = await getOrganizationId(req);
        await emailReportsService.deleteReport(req.params.id, organizationId);
        res.json({ success: true, message: 'Email report deleted successfully' });
    } catch (error) {
        console.error('Error deleting email report:', error);
        res.status(500).json({ success: false, message: 'Failed to delete email report' });
    }
};

exports.triggerReport = async (req, res) => {
    try {
        const organizationId = await getOrganizationId(req);
        const report = await prisma.emailReport.findFirst({
            where: { id: req.params.id, organizationId },
            include: { organization: true }
        });

        if (!report) {
            return res.status(404).json({ success: false, message: 'Email report configuration not found' });
        }

        const reportScheduler = require('./reportScheduler');
        const result = await reportScheduler.dispatchReport(report, { force: true });
        res.json({ success: true, data: result });
    } catch (error) {
        console.error('Error triggering email report:', error);
        res.status(500).json({ success: false, message: error.message });
    }
};
