const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const jobQueue = require('../services/templateJobQueue');
const psdParserManager = require('../services/psdParserManager');

// Base storage paths
const STORAGE_DIR = path.resolve(__dirname, '../../storage');
const CHUNKS_DIR = path.join(STORAGE_DIR, 'chunks');
const UPLOADS_DIR = path.join(STORAGE_DIR, 'uploads');

// Ensure directories exist
fs.mkdirSync(CHUNKS_DIR, { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Configure Multer for chunk uploads (temp memory or disk)
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 20 * 1024 * 1024 }, // Max 20MB per chunk
});

/**
 * Assemble chunks in numerical order into destination file.
 */
async function assembleChunks(uploadId, totalChunks, targetPath) {
    const chunkDir = path.join(CHUNKS_DIR, uploadId);
    const writeStream = fs.createWriteStream(targetPath);

    for (let i = 0; i < totalChunks; i++) {
        const chunkPath = path.join(chunkDir, `chunk_${i}`);
        if (!fs.existsSync(chunkPath)) {
            throw new Error(`Missing chunk index ${i} for upload ${uploadId}`);
        }

        const chunkBuffer = fs.readFileSync(chunkPath);
        writeStream.write(chunkBuffer);
    }

    await new Promise((resolve, reject) => {
        writeStream.end();
        writeStream.on('finish', resolve);
        writeStream.on('error', reject);
    });

    // Clean up chunks folder
    try {
        fs.rmSync(chunkDir, { recursive: true, force: true });
    } catch (e) {
        console.warn(`[Template Upload] Warning cleaning chunks for ${uploadId}:`, e.message);
    }
}

/**
 * POST /api/templates/upload-chunk
 * Receives a single chunk of a large PSD file.
 */
router.post('/upload-chunk', upload.single('file_chunk'), async (req, res) => {
    try {
        const uploadId = req.body.upload_id || req.headers['x-upload-id'];
        const chunkIndex = parseInt(req.body.chunk_index ?? req.headers['x-chunk-index'], 10);
        const totalChunks = parseInt(req.body.total_chunks ?? req.headers['x-total-chunks'], 10);
        const totalSize = parseInt(req.body.total_size ?? req.headers['x-total-size'], 10);
        const filename = req.body.filename || req.headers['x-filename'] || 'template.psd';
        const productId = req.body.product_id || req.headers['x-product-id'] || null;

        if (!uploadId || isNaN(chunkIndex) || isNaN(totalChunks)) {
            return res.status(400).json({
                success: false,
                error: 'Missing required chunk parameters (upload_id, chunk_index, total_chunks).'
            });
        }

        // Get chunk buffer from multer or raw body
        let chunkBuffer = null;
        if (req.file && req.file.buffer) {
            chunkBuffer = req.file.buffer;
        } else if (req.body && Buffer.isBuffer(req.body)) {
            chunkBuffer = req.body;
        }

        if (!chunkBuffer || chunkBuffer.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'Empty or missing chunk data.'
            });
        }

        // Save chunk to disk
        const chunkDir = path.join(CHUNKS_DIR, uploadId);
        fs.mkdirSync(chunkDir, { recursive: true });

        const chunkPath = path.join(chunkDir, `chunk_${chunkIndex}`);
        fs.writeFileSync(chunkPath, chunkBuffer);

        // Check how many chunks have been received
        const existingChunks = fs.readdirSync(chunkDir).filter(f => f.startsWith('chunk_'));
        const receivedCount = existingChunks.length;

        // If all chunks received, assemble the file
        if (receivedCount === totalChunks) {
            const assembledFilename = `psd_${uploadId}.psd`;
            const assembledPath = path.join(UPLOADS_DIR, assembledFilename);

            await assembleChunks(uploadId, totalChunks, assembledPath);

            const assembledStats = fs.statSync(assembledPath);
            console.log(`[Template Upload] Assembled file ${filename} (${(assembledStats.size / 1024 / 1024).toFixed(2)} MB) for Product ${productId || 'N/A'}`);

            // Register in Job Queue and dispatch asynchronous parsing worker
            const job = jobQueue.createJob(uploadId, filename, assembledPath, { productId });
            psdParserManager.dispatchJob(job);

            return res.status(200).json({
                success: true,
                status: 'completed',
                upload_id: uploadId,
                job_id: job.job_id,
                filename: filename,
                file_size: assembledStats.size,
                message: 'Tải lên hoàn tất và đã ghép file PSD thành công. Bắt đầu đưa vào hàng đợi phân tích.'
            });
        }

        // Chunks still remaining
        return res.status(200).json({
            success: true,
            status: 'uploading',
            upload_id: uploadId,
            chunk_index: chunkIndex,
            total_chunks: totalChunks,
            received_chunks: receivedCount,
            percentage: Math.round((receivedCount / totalChunks) * 100),
        });

    } catch (err) {
        console.error('[Template Upload] Error processing chunk:', err);
        return res.status(500).json({
            success: false,
            error: 'Lỗi trong quá trình xử lý phân mảnh: ' + err.message
        });
    }
});

/**
 * GET /api/templates/upload-status
 * Resumable upload check: returns list of chunks already received on server.
 */
router.get('/upload-status', (req, res) => {
    const uploadId = req.query.upload_id;
    if (!uploadId) {
        return res.status(400).json({ success: false, error: 'upload_id is required' });
    }

    const chunkDir = path.join(CHUNKS_DIR, uploadId);
    if (!fs.existsSync(chunkDir)) {
        return res.status(200).json({
            success: true,
            upload_id: uploadId,
            received_chunks: []
        });
    }

    const chunks = fs.readdirSync(chunkDir)
        .filter(f => f.startsWith('chunk_'))
        .map(f => parseInt(f.replace('chunk_', ''), 10))
        .sort((a, b) => a - b);

    return res.status(200).json({
        success: true,
        upload_id: uploadId,
        received_chunks: chunks
    });
});

/**
 * GET /api/templates/jobs/:job_id/status
 * Polling endpoint for checking PSD parsing progress.
 */
router.get('/jobs/:job_id/status', (req, res) => {
    const jobId = req.params.job_id;
    const job = jobQueue.getJob(jobId);

    if (!job) {
        return res.status(404).json({
            success: false,
            error: 'Job not found or expired.'
        });
    }

    return res.status(200).json({
        success: true,
        data: job
    });
});

/**
 * POST /api/templates/parse-file
 * Directly parse an existing PSD file on server.
 */
router.post('/parse-file', (req, res) => {
    try {
        const { file_path, filename } = req.body;
        if (!file_path || !fs.existsSync(file_path)) {
            return res.status(400).json({ success: false, error: 'Tệp PSD không tồn tại tại đường dẫn chỉ định: ' + file_path });
        }

        const name = filename || path.basename(file_path);
        const uploadId = `local_${Date.now()}`;
        const job = jobQueue.createJob(uploadId, name, file_path);
        psdParserManager.dispatchJob(job);

        return res.status(200).json({
            success: true,
            job_id: job.job_id,
            status: 'queued',
            message: 'Bắt đầu tiến trình phân tích file PSD.'
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;
