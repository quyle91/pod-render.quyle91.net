const EventEmitter = require('events');

/**
 * Class TemplateJobQueue
 * In-memory job queue for tracking PSD upload, assembly, and parsing progress.
 */
class TemplateJobQueue extends EventEmitter {
    constructor() {
        super();
        this.jobs = new Map();

        // Run cleanup every 30 minutes for jobs older than 2 hours
        setInterval(() => this.cleanupOldJobs(), 30 * 60 * 1000);
    }

    /**
     * Create a new Job.
     *
     * @param {string} uploadId
     * @param {string} filename
     * @param {string} filePath
     * @returns {object} Job object
     */
    createJob(uploadId, filename, filePath, options = {}) {
        const jobId = `job_psd_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
        const now = new Date().toISOString();

        const job = {
            job_id: jobId,
            upload_id: uploadId,
            product_id: options.productId || null,
            filename: filename,
            file_path: filePath,
            status: 'queued',
            progress: 0,
            stage: 'queued',
            message: 'Tác vụ đã được đưa vào hàng đợi xử lý.',
            result: null,
            error: null,
            created_at: now,
            updated_at: now,
        };

        this.jobs.set(jobId, job);
        this.emit('job_created', job);
        return job;
    }

    /**
     * Get job by ID.
     *
     * @param {string} jobId
     * @returns {object|null}
     */
    getJob(jobId) {
        return this.jobs.get(jobId) || null;
    }

    /**
     * Update job progress and state.
     *
     * @param {string} jobId
     * @param {object} updates
     * @returns {object|null}
     */
    updateJob(jobId, updates = {}) {
        const job = this.jobs.get(jobId);
        if (!job) return null;

        Object.assign(job, updates, { updated_at: new Date().toISOString() });
        this.jobs.set(jobId, job);
        this.emit('job_updated', job);
        return job;
    }

    /**
     * Mark job as completed.
     *
     * @param {string} jobId
     * @param {object} result
     * @returns {object|null}
     */
    completeJob(jobId, result) {
        return this.updateJob(jobId, {
            status: 'completed',
            progress: 100,
            stage: 'completed',
            message: 'Phân tích file PSD và sinh Template thành công!',
            result: result,
        });
    }

    /**
     * Mark job as failed.
     *
     * @param {string} jobId
     * @param {string} errorMessage
     * @returns {object|null}
     */
    failJob(jobId, errorMessage) {
        return this.updateJob(jobId, {
            status: 'failed',
            stage: 'failed',
            message: errorMessage,
            error: errorMessage,
        });
    }

    /**
     * Cleanup jobs older than 2 hours.
     */
    cleanupOldJobs() {
        const twoHoursAgo = Date.now() - (2 * 60 * 60 * 1000);
        for (const [jobId, job] of this.jobs.entries()) {
            const createdAt = new Date(job.created_at).getTime();
            if (createdAt < twoHoursAgo) {
                this.jobs.delete(jobId);
            }
        }
    }
}

module.exports = new TemplateJobQueue();
