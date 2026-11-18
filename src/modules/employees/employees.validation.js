const { z } = require('zod');

const inviteEmployeeSchema = z.object({
    fullName: z.string().min(2, "Full name must be at least 2 characters"),
    email: z.string().email("Valid email is required"),
    teamId: z.string().optional().nullable(),
    location: z.string().optional().default('Remote'),
    computerType: z.enum(['COMPANY', 'PERSONAL']).default('PERSONAL'),
    organizationId: z.string().optional().nullable(),
    role: z.enum(['ADMIN', 'MANAGER', 'EMPLOYEE']).default('EMPLOYEE'),
    hourlyRate: z.number().optional().nullable(),
    password: z.string().min(6).optional().nullable(),
    status: z.enum(['INVITED', 'ACTIVE', 'OFFLINE', 'IDLE', 'DEACTIVATED', 'MERGED']).optional().default('ACTIVE')
});

const updateEmployeeSchema = z.object({
    fullName: z.string().optional(),
    teamId: z.string().optional().nullable(),
    location: z.string().optional(),
    status: z.enum(['INVITED', 'ACTIVE', 'OFFLINE', 'IDLE', 'DEACTIVATED', 'MERGED']).optional(),
    hourlyRate: z.number().optional(),
    avatar: z.string().optional(),
    password: z.string().min(6).optional(),
});

module.exports = {
    inviteEmployeeSchema,
    updateEmployeeSchema,
};
