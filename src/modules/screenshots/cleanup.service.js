/**
 * Cleanup service - PERMANENT RETENTION POLICY
 * Screenshots are kept permanently and never auto-deleted.
 * Only manual deletion by user/admin removes records and assets.
 */
class CleanupService {
    init() {
        console.log('[CleanupService] Permanent screenshot retention active: automated cleanup is disabled (manual deletion only).');
    }

    async performCleanup() {
        // Kept permanent as requested: screenshots remain until manually deleted
        console.log('[CleanupService] Automated cleanup skipped (permanent retention policy).');
    }
}

module.exports = new CleanupService();
