-- ==============================================================================
-- PHASE 2B-1: TASK TIME LOGS MIGRATION SCRIPT
-- Target Database: employee-monitoring-fatima-07-08-26
-- Engine: MariaDB 10.4.32 / MySQL 5.7+
-- Safe, additive-only, idempotent migration. Does NOT modify existing 40 tables.
-- ==============================================================================

CREATE TABLE IF NOT EXISTS `task_time_logs` (
  `id` VARCHAR(191) NOT NULL,
  `taskId` VARCHAR(191) NOT NULL,
  `employeeId` VARCHAR(191) NOT NULL,
  `organizationId` VARCHAR(191) NOT NULL,
  `startTime` DATETIME(3) NOT NULL,
  `endTime` DATETIME(3) NULL,
  `duration` INT NOT NULL DEFAULT 0,
  `isRunning` TINYINT(1) NOT NULL DEFAULT 1,
  `source` VARCHAR(50) NOT NULL DEFAULT 'WEB',
  `activeEmployeeId` VARCHAR(191) GENERATED ALWAYS AS (IF(`isRunning` = 1, `employeeId`, NULL)) STORED,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  INDEX `idx_task_time_logs_employee_running` (`employeeId`, `isRunning`),
  INDEX `idx_task_time_logs_task` (`taskId`),
  INDEX `idx_task_time_logs_org` (`organizationId`),
  UNIQUE KEY `uq_task_time_logs_active_employee` (`activeEmployeeId`),
  CONSTRAINT `fk_ttl_task` FOREIGN KEY (`taskId`) REFERENCES `tasks` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `fk_ttl_employee` FOREIGN KEY (`employeeId`) REFERENCES `employees` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `fk_ttl_org` FOREIGN KEY (`organizationId`) REFERENCES `organizations` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
