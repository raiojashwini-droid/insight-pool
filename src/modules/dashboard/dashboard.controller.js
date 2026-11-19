const dashboardService = require('./dashboard.service');

const getAdminDashboard = async (req, res) => {
  try {
    const { organizationId } = req.user;
    const { startDate, endDate, compareStartDate, compareEndDate, employeeId, teamId, role } = req.query;
    if (req.user.role !== 'ADMIN') {
      return res.status(403).json({ message: 'Forbidden: Admin access required' });
    }
    const data = await dashboardService.getAdminDashboard(
      organizationId,
      startDate,
      endDate,
      compareStartDate,
      compareEndDate,
      employeeId || null,
      teamId || null,
      role || null
    );
    res.json(data);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getManagerDashboard = async (req, res) => {
  try {
    const { organizationId, teamId: userTeamId, role: userRole } = req.user;
    const { startDate, endDate, compareStartDate, compareEndDate, employeeId, teamId, role } = req.query;
    if (userRole !== 'MANAGER') {
      return res.status(403).json({ message: 'Forbidden: Manager access required' });
    }
    const effectiveTeamId = userTeamId || teamId || null;
    const data = await dashboardService.getManagerDashboard(
      organizationId,
      effectiveTeamId,
      startDate,
      endDate,
      compareStartDate,
      compareEndDate,
      employeeId || null,
      role || null
    );
    res.json(data);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const getEmployeeDashboard = async (req, res) => {
  try {
    const { organizationId, employeeId } = req.user;
    const { startDate, endDate, compareStartDate, compareEndDate } = req.query;
    const data = await dashboardService.getEmployeeDashboard(organizationId, employeeId, startDate, endDate, compareStartDate, compareEndDate);
    res.json(data);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

module.exports = {
  getAdminDashboard,
  getManagerDashboard,
  getEmployeeDashboard
};
