-- ==============================================================================
-- PHASE 3: TIMESHEETS DATA-PRESERVING ROLLBACK SCRIPT
-- Target Database: employee-monitoring-fatima-07-08-26
--
-- STRICT SAFETY POLICY: ZERO DATA LOSS.
-- This rollback script NEVER executes destructive 'DROP TABLE'.
-- Safely archives tables to preserve audit records.
-- ==============================================================================

RENAME TABLE `timesheet_approvals` TO `timesheet_approvals_archived`;
RENAME TABLE `timesheets` TO `timesheets_archived`;
