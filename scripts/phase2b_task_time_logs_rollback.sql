-- ==============================================================================
-- PHASE 2B-1: TASK TIME LOGS DATA-PRESERVING ROLLBACK SCRIPT
-- Target Database: employee-monitoring-fatima-07-08-26
--
-- STRICT SAFETY POLICY: ZERO DATA LOSS.
-- This rollback script NEVER executes destructive 'DROP TABLE'.
-- If task time tracking needs to be rolled back or retired:
-- 1. It preserves all recorded work sessions, timestamps, durations, and employee
--    audit history by renaming 'task_time_logs' to 'task_time_logs_archived'.
-- 2. Foreign keys and row data remain intact in the archived table.
-- ==============================================================================

RENAME TABLE `task_time_logs` TO `task_time_logs_archived`;
