const prisma = require('../../config/db');
const { getIO } = require('../../socket/server');

class ProjectsService {
    async createProject(data, organizationId) {
        const { name, billRate, employeeIds } = data;

        return await prisma.$transaction(async (tx) => {
            const project = await tx.project.create({
                data: {
                    name,
                    description: data.description,
                    billableRate: parseFloat(billRate) || 0,
                    budget: parseFloat(data.budget) || 0,
                    organizationId,
                },
            });

            if (employeeIds && employeeIds.length > 0) {
                await tx.projectAssignment.createMany({
                    data: employeeIds.map(employeeId => ({
                        projectId: project.id,
                        employeeId,
                    })),
                });
            }

            const result = {
                id: project.id,
                projectName: project.name,
                assignees: employeeIds?.length || 0,
                tasks: 0,
                totalTime: '00:00',
                clockedTime: '00:00',
                manualTime: '00:00',
                billRate: project.billableRate,
                totalCosts: (parseFloat(data.budget) || 0).toFixed(2),
            };

            // Emit real-time event
            const io = getIO();
            if (io) {
                io.to(`org_${organizationId}`).emit('project:update', { projectId: project.id, type: 'new' });
            }

            return result;
        });
    }

    async getProjects(organizationId, filter = {}) {
        let where = {};
        
        if (filter.employeeId) {
            // Find employee to check their actual organizationId and name
            const emp = await prisma.employee.findUnique({
                where: { id: filter.employeeId },
                select: { id: true, organizationId: true, fullName: true, email: true }
            });

            // Primary filter: match projects where this employee is directly assigned OR has tasks assigned
            where = {
                OR: [
                    { assignments: { some: { employeeId: filter.employeeId } } },
                    { tasks: { some: { employeeId: filter.employeeId } } }
                ]
            };
        } else if (organizationId) {
            where = { organizationId };
        }

        let projects = await prisma.project.findMany({
            where,
            include: {
                assignments: {
                    include: {
                        employee: true,
                    },
                },
                tasks: {
                    include: {
                        employee: {
                            select: {
                                id: true,
                                fullName: true,
                                avatar: true
                            }
                        },
                        timeLogs: true
                    }
                },
                timeLogs: true,
                _count: {
                    select: { tasks: true }
                }
            },
        });

        // Fallback for employee: If nothing matched, check employee's organization
        if (filter.employeeId && projects.length === 0) {
            const emp = await prisma.employee.findUnique({
                where: { id: filter.employeeId },
                select: { id: true, organizationId: true, fullName: true }
            });

            if (emp) {
                // Check if any project exists in their organization
                const orgProjects = await prisma.project.findMany({
                    where: { organizationId: emp.organizationId },
                    include: {
                        assignments: { include: { employee: true } },
                        tasks: { include: { employee: { select: { id: true, fullName: true, avatar: true } }, timeLogs: true } },
                        timeLogs: true,
                        _count: { select: { tasks: true } }
                    }
                });

                // Check if any task in org matched employee's name (case-insensitive)
                const nameMatched = orgProjects.filter(p => 
                    p.tasks.some(t => t.employee && t.employee.fullName?.toLowerCase() === emp.fullName?.toLowerCase())
                );

                if (nameMatched.length > 0) {
                    projects = nameMatched;
                } else if (orgProjects.length > 0) {
                    // If projects exist in the org, ensure the employee is assigned so they can view and work on them
                    for (const p of orgProjects) {
                        await prisma.projectAssignment.create({
                            data: {
                                projectId: p.id,
                                employeeId: filter.employeeId
                            }
                        }).catch(() => {});
                    }

                    // Re-fetch assigned projects
                    projects = await prisma.project.findMany({
                        where: { id: { in: orgProjects.map(p => p.id) } },
                        include: {
                            assignments: { include: { employee: true } },
                            tasks: { include: { employee: { select: { id: true, fullName: true, avatar: true } }, timeLogs: true } },
                            timeLogs: true,
                            _count: { select: { tasks: true } }
                        }
                    });
                }
            }
        }

        return projects.map(project => {
            const projectTimeLogsSec = (project.timeLogs || []).reduce((acc, log) => acc + (log.duration || 0), 0);
            const taskTimeLogsSec = (project.tasks || []).reduce((acc, t) => {
                const logsSec = (t.timeLogs || []).reduce((sum, tl) => sum + (tl.duration || 0), 0);
                return acc + logsSec;
            }, 0);
            const totalSeconds = projectTimeLogsSec + taskTimeLogsSec;
            const clockedSeconds = (project.timeLogs || [])
                .filter(log => log.type === 'CLOCKED')
                .reduce((acc, log) => acc + (log.duration || 0), 0) + taskTimeLogsSec;
            const manualSeconds = (project.timeLogs || [])
                .filter(log => log.type === 'MANUAL')
                .reduce((acc, log) => acc + (log.duration || 0), 0);

            const totalHours = totalSeconds / 3600;
            const billableCost = totalHours * (project.billableRate || 0);

            // Combine both project assignments and task assignees
            const allAssigneeIds = new Set([
                ...project.assignments.map(a => a.employeeId),
                ...project.tasks.map(t => t.employeeId).filter(Boolean)
            ]);

            const completedTasks = (project.tasks || []).filter(t => t.status === 'FINALIZED').length;
            const totalTasks = project.tasks?.length || project._count?.tasks || 0;
            const inProgressTasks = (project.tasks || []).filter(t => t.status === 'IN_OPERATIONS' || t.status === 'QUALITY_ASSURANCE').length;
            const progress = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;
            const efficiency = totalTasks > 0 ? Math.min(100, Math.round(((completedTasks + (inProgressTasks * 0.7)) / totalTasks) * 100)) : 100;

            const assignedEmployees = [
                ...project.assignments.map(a => a.employee?.fullName).filter(Boolean),
                ...project.tasks.map(t => t.employee?.fullName).filter(Boolean)
            ];
            const uniqueAssigneeNames = Array.from(new Set(assignedEmployees));

            return {
                id: project.id,
                projectName: project.name,
                name: project.name,
                assignees: allAssigneeIds.size || (project.assignments.length > 0 ? project.assignments.length : 1),
                assignedEmployeeIds: Array.from(allAssigneeIds),
                assignedEmployees: uniqueAssigneeNames,
                leadStakeholder: uniqueAssigneeNames[0] || 'Unassigned',
                tasks: totalTasks,
                completedTasks,
                inProgressTasks,
                progress,
                efficiency,
                tasksData: project.tasks,
                totalSeconds,
                totalTime: this.formatDuration(totalSeconds),
                clockedTime: this.formatDuration(clockedSeconds),
                manualTime: this.formatDuration(manualSeconds),
                billRate: project.billableRate || 0,
                billableRate: project.billableRate || 0,
                totalCosts: (project.budget ?? 0).toFixed(2),
                description: project.description,
            };
        });
    }

    async assignEmployees(projectId, employeeIds) {
        if (employeeIds && employeeIds.length > 0) {
            const deactivated = await prisma.employee.findMany({
                where: { id: { in: employeeIds }, status: 'DEACTIVATED' },
                select: { fullName: true }
            });
            if (deactivated.length > 0) {
                const names = deactivated.map(e => e.fullName).join(', ');
                const err = new Error(`Cannot assign deactivated employee(s) to project: ${names}`);
                err.code = 'ACCOUNT_DEACTIVATED';
                err.statusCode = 403;
                throw err;
            }
        }

        return await prisma.projectAssignment.createMany({
            data: employeeIds.map(employeeId => ({
                projectId,
                employeeId,
            })),
            skipDuplicates: true,
        });
    }

    async logTime(data) {
        const { projectId, employeeId, duration, type } = data;

        const emp = await prisma.employee.findUnique({ where: { id: employeeId }, select: { status: true } });
        if (!emp) throw new Error('Employee not found');
        if (emp.status === 'DEACTIVATED') {
            const err = new Error('Cannot log time for a deactivated employee');
            err.code = 'ACCOUNT_DEACTIVATED';
            err.statusCode = 403;
            throw err;
        }

        return await prisma.projectTimeLog.create({
            data: {
                projectId,
                employeeId,
                duration: parseInt(duration),
                type: type || 'CLOCKED',
            },
        });
    }

    async updateProject(id, data) {
        const { name, billRate, employeeIds } = data;

        return await prisma.$transaction(async (tx) => {
            // Update project basic info
            const project = await tx.project.update({
                where: { id },
                data: {
                    name,
                    description: data.description,
                    billableRate: parseFloat(billRate) || 0,
                    budget: parseFloat(data.budget) || 0,
                },
            });

            // Update assignments - simple way: delete all and re-add
            if (employeeIds) {
                await tx.projectAssignment.deleteMany({
                    where: { projectId: id },
                });

                if (employeeIds.length > 0) {
                    await tx.projectAssignment.createMany({
                        data: employeeIds.map(employeeId => ({
                            projectId: id,
                            employeeId,
                        })),
                    });
                }
            }

            // Return the full project object as the frontend expects it
            const fullProject = await tx.project.findUnique({
                where: { id },
                include: {
                    assignments: { include: { employee: true } },
                    tasks: {
                        include: {
                            employee: {
                                select: {
                                    id: true,
                                    fullName: true,
                                    avatar: true
                                }
                            }
                        }
                    },
                    timeLogs: true,
                    _count: { select: { tasks: true } }
                }
            });

            const totalSeconds = fullProject.timeLogs.reduce((acc, log) => acc + log.duration, 0);
            const clockedSeconds = fullProject.timeLogs
                .filter(log => log.type === 'CLOCKED')
                .reduce((acc, log) => acc + log.duration, 0);
            const manualSeconds = fullProject.timeLogs
                .filter(log => log.type === 'MANUAL')
                .reduce((acc, log) => acc + log.duration, 0);

            const taskAssigneeIds = new Set(fullProject.tasks.map(t => t.employeeId).filter(id => !!id));

            const result = {
                id: fullProject.id,
                projectName: fullProject.name,
                assignees: fullProject.assignments.length, // FIXED: use ProjectAssignment count
                assignedEmployeeIds: fullProject.assignments.map(a => a.employeeId), // For frontend use
                tasks: fullProject._count.tasks,
                tasksData: fullProject.tasks,
                totalTime: this.formatDuration(totalSeconds),
                clockedTime: this.formatDuration(clockedSeconds),
                manualTime: this.formatDuration(manualSeconds),
                billRate: fullProject.billableRate,
                totalCosts: (fullProject.budget ?? 0).toFixed(2),
                description: fullProject.description,
            };

            // Emit real-time event
            const io = getIO();
            if (io) {
                io.to(`org_${fullProject.organizationId}`).emit('project:update', { projectId: id, type: 'update' });
            }

            return result;
        });
    }

    async deleteProject(id) {
        return await prisma.$transaction(async (tx) => {
            // Delete related entries first
            await tx.projectAssignment.deleteMany({ where: { projectId: id } });
            await tx.projectTimeLog.deleteMany({ where: { projectId: id } });
            await tx.task.deleteMany({ where: { projectId: id } }); // Optional, but tasks usually belong to projects
            
            const project = await tx.project.delete({
                where: { id },
            });

            // Emit real-time event
            const io = getIO();
            if (io) {
                io.to(`org_${project.organizationId}`).emit('project:update', { projectId: id, type: 'delete' });
            }

            return project;
        });
    }

    formatDuration(seconds) {
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
    }
}

module.exports = new ProjectsService();
