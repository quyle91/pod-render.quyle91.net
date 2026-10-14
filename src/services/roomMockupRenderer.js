const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const axios = require('axios');
const crypto = require('crypto');

/**
 * Cấu hình 2 Bối Cảnh Chuẩn Vàng Cố Định Trong Render Server (Zero-Config)
 * - Tường phòng khách: Mảng tường trống phía trên sofa kem cong, ánh sáng từ cửa sổ lớn bên trái.
 * - Mặt bàn làm việc: Bàn gỗ sồi Scandinavian, ánh sáng từ cửa sổ bên phải, đáy khung tựa trên mặt bàn.
 */
const PRESETS = {
    wall: {
        bgPath: path.join(__dirname, '../assets/backgrounds/wall_clean.jpg'),
        anchorXRatio: 0.50, // Căn giữa phòng khách
        anchorYRatio: 0.29, // Treo thông thoáng phía trên sofa (cách sofa 65px)
        maxWRatio: 0.36,    // Chiều rộng tối đa 36% ảnh nền
        maxHRatio: 0.42,    // Chiều cao tối đa 42% ảnh nền
        shadowDx: 12,       // Ánh sáng từ cửa sổ lớn bên trái
        shadowDy: 18,
        shadowBlur: 24,
        shadowOpacity: 0.35
    },
    desk: {
        bgPath: path.join(__dirname, '../assets/backgrounds/desk_clean.jpg'),
        anchorXRatio: 0.48, // Nằm giữa mặt bàn
        bottomYRatio: 0.64, // Đáy khung tựa lùi sâu vào giữa mặt bàn gỗ sồi
        maxWRatio: 0.24,    // Tỷ lệ khung để bàn thanh lịch (24% ảnh)
        maxHRatio: 0.40,    // Chiều cao tối đa khung để bàn
        shadowDx: -10,      // Ánh sáng từ cửa sổ bên phải
        shadowDy: 14,
        shadowBlur: 18,
        shadowOpacity: 0.38
    }
};

class RoomMockupRenderer {
    constructor() {
        this.outputDir = process.env.OUTPUT_DIR || path.join(__dirname, '../../storage/prints');
        if (!fs.existsSync(this.outputDir)) {
            fs.mkdirSync(this.outputDir, { recursive: true });
        }
    }

    /**
     * Tải hoặc phân giải Buffer ảnh từ Base64 dataURL, file cục bộ hoặc URL HTTP
     */
    async resolveBuffer(input) {
        if (!input) return null;
        if (Buffer.isBuffer(input)) return input;
        if (typeof input === 'string') {
            if (input.startsWith('data:image/')) {
                const parts = input.split(',');
                return Buffer.from(parts[1], 'base64');
            }
            if (input.startsWith('/') && fs.existsSync(input)) {
                return fs.readFileSync(input);
            }
            let reqUrl = input;
            const headers = {};
            if (reqUrl.includes('//pod.localhost')) {
                reqUrl = reqUrl.replace('//pod.localhost', '//pod_web');
                headers['Host'] = 'pod.localhost';
            } else if (reqUrl.startsWith('/')) {
                const baseUrl = process.env.FRONTEND_INTERNAL_URL || 'http://pod_web';
                reqUrl = baseUrl + reqUrl;
            }
            try {
                const res = await axios.get(reqUrl, { responseType: 'arraybuffer', timeout: 15000, headers });
                return Buffer.from(res.data);
            } catch (err) {
                console.error(`[RoomMockupRenderer] Failed to fetch image from ${input}:`, err.message);
                return null;
            }
        }
        return null;
    }

    /**
     * Dựng phối cảnh tranh + khung lên bối cảnh phòng khách hoặc bàn làm việc
     * @param {Object} params
     * @param {string} [params.context] 'wall' hoặc 'desk'
     * @param {string|Buffer} [params.background_url] Ảnh nền tùy biến (nếu có)
     * @param {string|Buffer} [params.frame_url] Ảnh phôi khung viền PNG trong suốt chất lượng cao
     * @param {string|Buffer} params.artwork_base64 Ảnh canvas cá nhân hóa của khách
     * @param {Object} [params.transform] Cấu hình tùy biến thêm (nếu có)
     */
    async renderMockup({ context = 'wall', background_url, frame_url, artwork_base64, transform = {} }) {
        const presetKey = (context === 'desk') ? 'desk' : 'wall';
        const preset = PRESETS[presetKey];

        // 1. Tải ảnh nền bối cảnh (ưu tiên ảnh preset cục bộ cực nhanh, fallback qua URL)
        let bgBuffer = null;
        if (fs.existsSync(preset.bgPath)) {
            bgBuffer = fs.readFileSync(preset.bgPath);
        } else if (background_url) {
            bgBuffer = await this.resolveBuffer(background_url);
        }
        if (!bgBuffer) {
            throw new Error(`Không thể nạp ảnh nền bối cảnh cho context: ${presetKey}`);
        }

        const bgMeta = await sharp(bgBuffer).metadata();
        const bgW = bgMeta.width || 1200;
        const bgH = bgMeta.height || 896;

        // 2. Tải tác phẩm canvas của khách
        const artworkBuffer = await this.resolveBuffer(artwork_base64);
        if (!artworkBuffer) {
            throw new Error('Không thể tải ảnh tác phẩm canvas (artwork_base64).');
        }

        // 3. Tải phôi khung PNG chất lượng cao (nếu khách chọn có khung)
        const frameBuffer = await this.resolveBuffer(frame_url);

        let framedArtworkBuffer = null;
        if (frameBuffer) {
            // Lồng artwork vào lòng phôi khung PNG chất lượng cao ở độ phân giải gốc
            const frameMeta = await sharp(frameBuffer).metadata();
            const fW = frameMeta.width;
            const fH = frameMeta.height;

            const resizedArtwork = await sharp(artworkBuffer)
                .resize(fW, fH, { fit: 'cover' })
                .toBuffer();

            // Lớp dưới: Artwork tranh của khách
            // Lớp trên: Phôi khung viền PNG (đục thủng lòng trong)
            framedArtworkBuffer = await sharp(resizedArtwork)
                .composite([{ input: frameBuffer, top: 0, left: 0 }])
                .png()
                .toBuffer();
        } else {
            // Trường hợp Chassis (Tranh tràn viền không khung)
            framedArtworkBuffer = await sharp(artworkBuffer).png().toBuffer();
        }

        // 4. Thuật toán Đa Kích Thước Bounding Box (Aspect-Ratio Aware Scaling)
        // Cân trọn vẹn: Khổ dọc (2:3, 3:4), Khổ ngang (3:2, 4:3, 16:9), Khổ vuông (1:1)
        const framedMeta = await sharp(framedArtworkBuffer).metadata();
        const aspect = framedMeta.width / (framedMeta.height || 1);

        const maxW = Math.round(bgW * preset.maxWRatio);
        const maxH = Math.round(bgH * preset.maxHRatio);

        let finalW, finalH;
        if (aspect >= 1) {
            // Tranh ngang hoặc vuông: ưu tiên bung chiều rộng trong maxW, khống chế maxH
            finalW = maxW;
            finalH = Math.round(finalW / aspect);
            if (finalH > maxH) {
                finalH = maxH;
                finalW = Math.round(finalH * aspect);
            }
        } else {
            // Tranh dọc: ưu tiên bung chiều cao trong maxH, khống chế maxW
            finalH = maxH;
            finalW = Math.round(finalH * aspect);
            if (finalW > maxW) {
                finalW = maxW;
                finalH = Math.round(finalW / aspect);
            }
        }

        // Co giãn khung tranh thành phẩm bằng thuật toán nội suy Lanczos3 siêu sắc nét
        let scaledFramed = await sharp(framedArtworkBuffer)
            .resize(finalW, finalH, { fit: 'fill', kernel: 'lanczos3' })
            .png()
            .toBuffer();

        // 5. Xác định tọa độ đặt tranh
        let left, top;
        if (preset.bottomYRatio) {
            // Bối cảnh bàn: Neo cạnh đáy tựa vững vàng trên mặt bàn
            const bottomY = Math.round(bgH * preset.bottomYRatio);
            const anchorX = Math.round(bgW * preset.anchorXRatio);
            left = Math.round(anchorX - (finalW / 2));
            top = Math.round(bottomY - finalH);
        } else {
            // Bối cảnh tường: Căn giữa mảng tường trên sofa
            const anchorX = Math.round(bgW * preset.anchorXRatio);
            const anchorY = Math.round(bgH * preset.anchorYRatio);
            left = Math.round(anchorX - (finalW / 2));
            top = Math.round(anchorY - (finalH / 2));
        }

        // Ràng buộc không tràn khỏi mép ảnh nền
        left = Math.max(10, Math.min(bgW - finalW - 10, left));
        top = Math.max(10, Math.min(bgH - finalH - 10, top));

        // 6. Tạo bóng đổ tự nhiên đa tầng (Soft Realistic Drop-Shadow)
        const shadowPadding = 40;
        const shadowSvg = Buffer.from(`
            <svg width="${finalW + shadowPadding * 2}" height="${finalH + shadowPadding * 2}">
                <defs>
                    <filter id="wallShadow" x="-30%" y="-30%" width="170%" height="170%">
                        <feDropShadow dx="${preset.shadowDx}" dy="${preset.shadowDy}" stdDeviation="${preset.shadowBlur}" flood-color="#000000" flood-opacity="${preset.shadowOpacity}"/>
                    </filter>
                </defs>
                <rect x="${shadowPadding}" y="${shadowPadding}" width="${finalW}" height="${finalH}" rx="3" fill="black" filter="url(#wallShadow)"/>
            </svg>
        `);

        const shadowLeft = Math.max(0, left - shadowPadding);
        const shadowTop = Math.max(0, top - shadowPadding);

        const compositeLayers = [
            { input: shadowSvg, top: shadowTop, left: shadowLeft },
            { input: scaledFramed, top: top, left: left }
        ];

        // 7. Hòa trộn ghép đè lên ảnh nền và nén xuất file JPEG chất lượng cao
        const finalComposite = await sharp(bgBuffer)
            .composite(compositeLayers)
            .jpeg({ quality: 92, mozjpeg: true })
            .toBuffer();

        // 8. Lưu file thành phẩm vào thư mục lưu trữ prints
        const hash = crypto.randomBytes(8).toString('hex');
        const filename = `mockup_room_${Date.now()}_${hash}.jpg`;
        const outputPath = path.join(this.outputDir, filename);

        fs.writeFileSync(outputPath, finalComposite);

        return {
            filename,
            output_path: outputPath,
            mockup_url: `/prints/${filename}`,
            width: bgW,
            height: bgH,
            context: presetKey
        };
    }
}

module.exports = new RoomMockupRenderer();
