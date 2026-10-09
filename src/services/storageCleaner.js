const path = require('path');
const fs = require('fs');

/**
 * StorageCleaner Service
 * Automatically prevents disk exhaustion on the render worker.
 * Features:
 *  1. Age-based eviction: Purges temp files older than MAX_AGE_HOURS.
 *  2. Quota-based FIFO eviction: If directory size exceeds MAX_STORAGE_MB, removes oldest files first.
 *  3. Periodic background worker: Runs cleanup on a configurable schedule (default: every 30 minutes).
 */
class StorageCleaner {
    constructor() {
        this.printsDir = process.env.OUTPUT_DIR || path.join(__dirname, '../../storage/prints');
        this.maxAgeHours = parseInt(process.env.STORAGE_MAX_AGE_HOURS || '24', 10);
        this.testMaxAgeHours = parseInt(process.env.STORAGE_TEST_MAX_AGE_HOURS || '2', 10);
        this.maxStorageMb = parseInt(process.env.STORAGE_MAX_MB || '2048', 10); // 2GB default cap
        this.timer = null;
    }

    /**
     * Start scheduled background cleanup.
     * @param {number} intervalMinutes 
     */
    startScheduledCleanup(intervalMinutes = 30) {
        if (this.timer) {
            clearInterval(this.timer);
        }

        // Run once immediately at startup
        setTimeout(() => {
            this.runCleanup().catch(err => console.error('[StorageCleaner] Startup cleanup error:', err.message));
        }, 5000);

        // Schedule periodic sweeps
        const ms = Math.max(5, intervalMinutes) * 60 * 1000;
        this.timer = setInterval(() => {
            this.runCleanup().catch(err => console.error('[StorageCleaner] Scheduled sweep error:', err.message));
        }, ms);

        console.log(`[StorageCleaner] Background worker started: sweeps every ${intervalMinutes} min, max age: ${this.maxAgeHours}h, quota cap: ${this.maxStorageMb}MB.`);
    }

    /**
     * Perform complete cleanup sweep.
     * @returns {Promise<{deletedFiles: number, freedBytes: number, remainingFiles: number, remainingMb: number}>}
     */
    async runCleanup() {
        if (!fs.existsSync(this.printsDir)) {
            return { deletedFiles: 0, freedBytes: 0, remainingFiles: 0, remainingMb: 0 };
        }

        const now = Date.now();
        const maxAgeMs = this.maxAgeHours * 60 * 60 * 1000;
        const testMaxAgeMs = this.testMaxAgeHours * 60 * 60 * 1000;

        const dirents = fs.readdirSync(this.printsDir, { withFileTypes: true });
        let deletedFiles = 0;
        let freedBytes = 0;

        const fileStats = [];

        for (const dirent of dirents) {
            if (!dirent.isFile()) continue;

            const filePath = path.join(this.printsDir, dirent.name);
            try {
                const stat = fs.statSync(filePath);
                const ageMs = now - stat.mtimeMs;
                const isTestFile = dirent.name.includes('order_test_') || dirent.name.includes('preview');

                // 1. Evict files older than max allowed age (test files purged faster)
                const fileAllowedAge = isTestFile ? testMaxAgeMs : maxAgeMs;
                if (ageMs > fileAllowedAge) {
                    fs.unlinkSync(filePath);
                    deletedFiles++;
                    freedBytes += stat.size;
                    continue;
                }

                fileStats.push({
                    name: dirent.name,
                    path: filePath,
                    size: stat.size,
                    mtime: stat.mtimeMs
                });
            } catch (err) {
                // Ignore transient file locks
            }
        }

        // 2. FIFO Quota enforcement: if remaining storage exceeds maxStorageMb
        let currentTotalBytes = fileStats.reduce((sum, f) => sum + f.size, 0);
        const maxQuotaBytes = this.maxStorageMb * 1024 * 1024;
        const targetQuotaBytes = Math.round(maxQuotaBytes * 0.7); // Purge down to 70% capacity

        if (currentTotalBytes > maxQuotaBytes) {
            // Sort oldest files first
            fileStats.sort((a, b) => a.mtime - b.mtime);

            while (currentTotalBytes > targetQuotaBytes && fileStats.length > 0) {
                const oldest = fileStats.shift();
                try {
                    fs.unlinkSync(oldest.path);
                    deletedFiles++;
                    freedBytes += oldest.size;
                    currentTotalBytes -= oldest.size;
                } catch (err) {}
            }
        }

        const remainingMb = (currentTotalBytes / (1024 * 1024)).toFixed(2);
        if (deletedFiles > 0) {
            const freedMb = (freedBytes / (1024 * 1024)).toFixed(2);
            console.log(`[StorageCleaner] Sweep completed: Deleted ${deletedFiles} files (freed ${freedMb}MB). Current storage: ${remainingMb}MB.`);
        }

        return {
            deletedFiles,
            freedBytes,
            remainingFiles: fileStats.length,
            remainingMb: parseFloat(remainingMb)
        };
    }
}

module.exports = new StorageCleaner();
