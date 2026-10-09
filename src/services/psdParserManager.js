const { fork } = require('child_process');
const path = require('path');
const jobQueue = require('./templateJobQueue');

/**
 * Class PsdParserManager
 * Dispatches PSD parsing tasks into dedicated Child Processes for memory isolation.
 */
class PsdParserManager {
    /**
     * Dispatch a PSD parsing job to an isolated Child Process.
     *
     * @param {object} job
     * @returns {ChildProcess}
     */
    dispatchJob(job) {
        if (!job || !job.job_id) {
            console.error('[PsdParserManager] Invalid job object provided');
            return null;
        }

        console.log(`[PsdParserManager] Spawning isolated Child Process for Job ${job.job_id} (${job.filename})...`);

        jobQueue.updateJob(job.job_id, {
            status: 'processing',
            stage: 'initializing',
            progress: 5,
            message: 'Tiến trình Worker đang khởi tạo bộ nhớ cách ly...'
        });

        const workerScript = path.join(__dirname, 'psdParserWorker.js');
        const child = fork(workerScript, [], {
            execArgv: ['--max-old-space-size=2048'], // 2GB memory limit per worker
            stdio: ['inherit', 'inherit', 'inherit', 'ipc']
        });

        child.send({
            type: 'start',
            jobId: job.job_id,
            filePath: job.file_path,
            filename: job.filename,
            productId: job.product_id
        });

        child.on('message', (msg) => {
            if (!msg || !msg.type) return;

            if (msg.type === 'progress') {
                jobQueue.updateJob(job.job_id, {
                    progress: msg.progress,
                    stage: msg.stage,
                    message: msg.message
                });
            } else if (msg.type === 'completed') {
                console.log(`[PsdParserManager] Job ${job.job_id} completed successfully! Template ID: ${msg.result?.template_id}`);
                jobQueue.completeJob(job.job_id, msg.result);
            } else if (msg.type === 'error') {
                console.error(`[PsdParserManager] Job ${job.job_id} reported error:`, msg.error);
                jobQueue.failJob(job.job_id, msg.error);
            }
        });

        child.on('error', (err) => {
            console.error(`[PsdParserManager] Child process error for Job ${job.job_id}:`, err);
            jobQueue.failJob(job.job_id, 'Lỗi tiến trình Worker: ' + err.message);
        });

        child.on('exit', (code, signal) => {
            console.log(`[PsdParserManager] Worker process for Job ${job.job_id} exited (code: ${code}, signal: ${signal}). 100% RAM reclaimed.`);
            const currentJob = jobQueue.getJob(job.job_id);
            if (currentJob && currentJob.status !== 'completed' && currentJob.status !== 'failed') {
                jobQueue.failJob(job.job_id, `Tiến trình Worker kết thúc đột ngột với mã thoát ${code}`);
            }
        });

        return child;
    }
}

module.exports = new PsdParserManager();
