const path = require('path');
const fs = require('fs');

/**
 * StorageCleaner Service
 * Tự động ngăn chặn cạn kiệt dung lượng đĩa trên máy chủ Render (Auto Cleanup & Lifecycle Management).
 * 
 * Quy tắc phân cấp vòng đời lưu trữ (Storage Tiering):
 *  1. File Mockup Preview (mockup_room_*, preview_*): Tuổi thọ tối đa 30 phút, tối đa giữ 30 files gần nhất (FIFO).
 *  2. File Test Render Studio (order_test_*): Tuổi thọ tối đa 2 giờ.
 *  3. File Lệnh In Thực Tế Của Khách (order_print_*, order_zip_*): Tuổi thọ 24 giờ để xưởng in tải về.
 *  4. Hạn mức tổng dung lượng (Quota Cap): Mặc định tối đa 2GB, tự động thanh lý các file cũ nhất nếu chạm trần.
 *  5. Tiến trình quét ngầm định kỳ: Mặc định mỗi 15 phút quét một lần.
 */
class StorageCleaner {
    constructor() {
        this.printsDir = process.env.OUTPUT_DIR || path.join(__dirname, '../../storage/prints');
        this.maxAgeHours = parseInt(process.env.STORAGE_MAX_AGE_HOURS || '24', 10);
        this.testMaxAgeHours = parseInt(process.env.STORAGE_TEST_MAX_AGE_HOURS || '2', 10);
        this.previewMaxAgeMinutes = parseInt(process.env.STORAGE_PREVIEW_MAX_AGE_MINUTES || '30', 10); // 30 phút cho preview
        this.maxPreviewFiles = parseInt(process.env.STORAGE_MAX_PREVIEW_FILES || '30', 10);             // Tối đa 30 ảnh preview
        this.maxStorageMb = parseInt(process.env.STORAGE_MAX_MB || '2048', 10);                         // 2GB default cap
        this.timer = null;
    }

    /**
     * Khởi động tiến trình quét ngầm định kỳ
     * @param {number} intervalMinutes Mặc định 15 phút
     */
    startScheduledCleanup(intervalMinutes = 15) {
        if (this.timer) {
            clearInterval(this.timer);
        }

        // Quét ngay một lần sau 3 giây khi server khởi động
        setTimeout(() => {
            this.runCleanup().catch(err => console.error('[StorageCleaner] Startup cleanup error:', err.message));
        }, 3000);

        // Lập lịch quét định kỳ
        const ms = Math.max(5, intervalMinutes) * 60 * 1000;
        this.timer = setInterval(() => {
            this.runCleanup().catch(err => console.error('[StorageCleaner] Scheduled sweep error:', err.message));
        }, ms);

        console.log(`[StorageCleaner] Background worker started: sweeps every ${intervalMinutes} min (Preview max-age: ${this.previewMaxAgeMinutes}m, Max preview files: ${this.maxPreviewFiles}, Quota: ${this.maxStorageMb}MB).`);
    }

    /**
     * Thực thi một chu kỳ quét và dọn rác hoàn chỉnh
     * @returns {Promise<{deletedFiles: number, freedBytes: number, remainingFiles: number, remainingMb: number}>}
     */
    async runCleanup() {
        if (!fs.existsSync(this.printsDir)) {
            return { deletedFiles: 0, freedBytes: 0, remainingFiles: 0, remainingMb: 0 };
        }

        const now = Date.now();
        const maxAgeMs = this.maxAgeHours * 60 * 60 * 1000;
        const testMaxAgeMs = this.testMaxAgeHours * 60 * 60 * 1000;
        const previewMaxAgeMs = this.previewMaxAgeMinutes * 60 * 1000;

        const dirents = fs.readdirSync(this.printsDir, { withFileTypes: true });
        let deletedFiles = 0;
        let freedBytes = 0;

        const fileStats = [];
        const previewStats = [];

        for (const dirent of dirents) {
            if (!dirent.isFile()) continue;

            const filePath = path.join(this.printsDir, dirent.name);
            try {
                const stat = fs.statSync(filePath);
                const ageMs = now - stat.mtimeMs;

                const isMockupPreview = dirent.name.startsWith('mockup_room_') || 
                                        dirent.name.startsWith('preview_') || 
                                        dirent.name.includes('_preview');
                const isTestFile = dirent.name.includes('order_test_');

                // 1. Phân loại tuổi thọ tối đa cho phép theo từng loại file
                let fileAllowedAgeMs = maxAgeMs;
                if (isMockupPreview) {
                    fileAllowedAgeMs = previewMaxAgeMs;
                } else if (isTestFile) {
                    fileAllowedAgeMs = testMaxAgeMs;
                }

                // Nếu đã quá hạn tuổi thọ: xóa ngay lập tức
                if (ageMs > fileAllowedAgeMs) {
                    fs.unlinkSync(filePath);
                    deletedFiles++;
                    freedBytes += stat.size;
                    continue;
                }

                const fileItem = {
                    name: dirent.name,
                    path: filePath,
                    size: stat.size,
                    mtime: stat.mtimeMs,
                    isMockupPreview
                };

                fileStats.push(fileItem);
                if (isMockupPreview) {
                    previewStats.push(fileItem);
                }
            } catch (err) {
                // Bỏ qua nếu file đang bị lock tạm thời
            }
        }

        // 2. Chốt chặn số lượng file Mockup Preview (Tối đa chỉ giữ maxPreviewFiles = 30 files gần nhất)
        if (previewStats.length > this.maxPreviewFiles) {
            // Sắp xếp theo mtime tăng dần: file cũ nhất lên đầu
            previewStats.sort((a, b) => a.mtime - b.mtime);
            const excessCount = previewStats.length - this.maxPreviewFiles;

            for (let i = 0; i < excessCount; i++) {
                const victim = previewStats[i];
                try {
                    fs.unlinkSync(victim.path);
                    deletedFiles++;
                    freedBytes += victim.size;

                    // Loại khỏi fileStats
                    const idx = fileStats.findIndex(f => f.path === victim.path);
                    if (idx !== -1) fileStats.splice(idx, 1);
                } catch (err) {}
            }
        }

        // 3. Chốt chặn tổng dung lượng đĩa (FIFO Quota enforcement: nếu vượt quá maxStorageMb)
        let currentTotalBytes = fileStats.reduce((sum, f) => sum + f.size, 0);
        const maxQuotaBytes = this.maxStorageMb * 1024 * 1024;
        const targetQuotaBytes = Math.round(maxQuotaBytes * 0.7); // Dọn về 70% dung lượng

        if (currentTotalBytes > maxQuotaBytes) {
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
