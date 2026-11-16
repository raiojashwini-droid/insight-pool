-- ==============================================================================
-- PHASE 3: TIMESHEETS & TIMESHEET APPROVALS MIGRATION SCRIPT
-- Target Database: employee-monitoring-fatima-07-08-26
-- Engine: MariaDB 10.4.32 / MySQL 5.7+
-- Safe, additive-only, idempotent migration.
-- Preserves all approval and timesheet audit history with ON DELETE RESTRICT.
-- ==============================================================================

CREATE TABLE IF NOT EXISTS `timesheets` (
  `id` VARCHAR(191) NOT NULL,
  `organizationId` VARCHAR(191) NOT NULL,
  `employeeId` VARCHAR(191) NOT NULL,
  `weekStart` VARCHAR(191) NOT NULL,
  `status` ENUM('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED') NOT NULL DEFAULT 'DRAFT',
  `submittedAt` DATETIME(3) NULL,
  `totalMinutes` INT NOT NULL DEFAULT 0,
  `regularMinutes` INT NOT NULL DEFAULT 0,
  `overtimeMinutes` INT NOT NULL DEFAULT 0,
  `totalPay` DOUBLE NOT NULL DEFAULT 0.0,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_timesheet_org_emp_week` (`organizationId`, `employeeId`, `weekStart`),
  INDEX `idx_timesheets_org_week` (`organizationId`, `weekStart`),
  INDEX `idx_timesheets_emp_week` (`employeeId`, `weekStart`),
  CONSTRAINT `fk_timesheets_org` FOREIGN KEY (`organizationId`) REFERENCES `organizations` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `fk_timesheets_emp` FOREIGN KEY (`employeeId`) REFERENCES `employees` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `timesheet_approvals` (
  `id` VARCHAR(191) NOT NULL,
  `timesheetId` VARCHAR(191) NOT NULL,
  `approverId` VARCHAR(191) NOT NULL,
  `approverName` VARCHAR(191) NOT NULL,
  `decision` VARCHAR(191) NOT NULL,
  `comment` TEXT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  INDEX `idx_timesheet_approvals_ts` (`timesheetId`),
  CONSTRAINT `fk_ts_approvals_ts` FOREIGN KEY (`timesheetId`) REFERENCES `timesheets` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
