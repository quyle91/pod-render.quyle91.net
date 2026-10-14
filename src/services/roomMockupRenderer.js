const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const axios = require('axios');
const crypto = require('crypto');

/**
 * Cấu hình 2 Bối Cảnh Chuẩn Vàng Cố Định Trong Render Server (Zero-Config)
 * - Tường phòng khách: Mảng tường trống phía trên sofa kem cong, thuật toán tự động khống chế trần nhà.
 * - Mặt bàn làm việc: Bàn gỗ sồi Scandinavian, mặt bàn sạch không có sổ, góc xoay phối cảnh ăn khớp thớ gỗ.
 */
const PRESETS = {
    wall: {
        bgPath: path.join(__dirname, '../assets/backgrounds/wall_clean.jpg'),
        minCeilingMargin: 150, // Khoảng cách trần nhà an toàn (mép trên tranh luôn >= 150px)
        maxSofaMargin: 520,    // Khoảng cách an toàn lưng ghế sofa (mép dưới tranh luôn <= 520px)
        maxSafeWidth: 420,     // Chiều rộng tối đa an toàn giữa cửa sổ và cây cảnh
        anchorXRatio: 0.50,    // Chính giữa bề ngang phòng khách
        shadowDx: 12,          // Ánh sáng tự nhiên từ cửa sổ lớn bên trái
        shadowDy: 18,
        shadowBlur: 20,
        shadowOpacity: 0.35
    },
    desk: {
        bgPath: path.join(__dirname, '../assets/backgrounds/desk_clean.jpg'),
        anchorXRatio: 0.44,    // Đặt trên mặt bàn gỗ sồi bên cạnh chậu sen đá
        bottomYRatio: 0.54,    // Đáy khung chạm mặt bàn gỗ sồi (54% chiều cao ảnh)
        maxSafeWidth: 220,     // Khổ khung để bàn thanh lịch vừa vặn
        maxSafeHeight: 280,    // Chiều cao tối đa khung để bàn
        angleDeg: -3.2,        // Góc xoay phối cảnh ăn khớp chiều nghiêng thớ gỗ mặt bàn
        shadowDx: -8,          // Ánh sáng từ cửa sổ ban công bên phải
        shadowDy: 14,
        shadowBlur: 16,
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

        // 4. Thuật toán Đa Kích Thước Bounding Box & Chống Đụng Trần Tuyệt Đối
        const framedMeta = await sharp(framedArtworkBuffer).metadata();
        const aspect = framedMeta.width / (framedMeta.height || 1);

        let finalW, finalH, left, top;

        if (presetKey === 'wall') {
            // Bối cảnh tường phòng khách: Khống chế nghiêm ngặt khoảng an toàn trần nhà
            const minCeiling = preset.minCeilingMargin || 150;
            const maxSofa = preset.maxSofaMargin || 520;
            const maxSafeH = maxSofa - minCeiling; // 370px
            const maxSafeW = preset.maxSafeWidth || 420;

            let targetW = maxSafeW;
            let targetH = Math.round(targetW / aspect);

            // Nếu chiều cao vượt quá khoảng an toàn trần-sofa: scale nhỏ lại theo chiều cao
            if (targetH > maxSafeH) {
                targetH = maxSafeH;
                targetW = Math.round(targetH * aspect);
            }
            // Nếu chiều rộng vượt quá: scale nhỏ lại theo chiều rộng
            if (targetW > maxSafeW) {
                targetW = maxSafeW;
                targetH = Math.round(targetW / aspect);
            }

            finalW = targetW;
            finalH = targetH;

            // Tâm cân đối chính giữa khoảng cách trần và sofa
            const centerY = Math.round((minCeiling + maxSofa) / 2); // 335px
            const centerX = Math.round(bgW * preset.anchorXRatio);  // 512px

            left = Math.round(centerX - (finalW / 2));
            top = Math.round(centerY - (finalH / 2));

            // Chốt an toàn kép: Luôn đảm bảo top >= minCeiling
            if (top < minCeiling) {
                top = minCeiling;
            }
        } else {
            // Bối cảnh bàn làm việc: Khung để bàn nhỏ xinh, tựa trên mặt bàn gỗ sồi
            const maxSafeW = preset.maxSafeWidth || 220;
            const maxSafeH = preset.maxSafeHeight || 280;

            finalW = maxSafeW;
            finalH = Math.round(finalW / aspect);

            if (finalH > maxSafeH) {
                finalH = maxSafeH;
                finalW = Math.round(finalH * aspect);
            }
            if (finalW > maxSafeW) {
                finalW = maxSafeW;
                finalH = Math.round(finalW / aspect);
            }

            const bottomY = Math.round(bgH * preset.bottomYRatio);
            const anchorX = Math.round(bgW * preset.anchorXRatio);
            left = Math.round(anchorX - (finalW / 2));
            top = Math.round(bottomY - finalH);
        }

        // Co giãn khung tranh thành phẩm bằng thuật toán nội suy Lanczos3 siêu sắc nét
        let scaledFramed = await sharp(framedArtworkBuffer)
            .resize(finalW, finalH, { fit: 'fill', kernel: 'lanczos3' })
            .png()
            .toBuffer();

        // Áp dụng góc xoay phối cảnh (Angle Adjustment) nếu có
        let actualW = finalW;
        let actualH = finalH;

        if (preset.angleDeg) {
            scaledFramed = await sharp(scaledFramed)
                .rotate(preset.angleDeg, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
                .png()
                .toBuffer();

            const rotatedMeta = await sharp(scaledFramed).metadata();
            actualW = rotatedMeta.width;
            actualH = rotatedMeta.height;

            // Điều chỉnh lại left, top sau khi xoay để tâm giữ nguyên
            left = left - Math.round((actualW - finalW) / 2);
            top = top - Math.round((actualH - finalH) / 2);
        }

        // Ràng buộc không tràn khỏi mép ảnh nền
        left = Math.max(10, Math.min(bgW - actualW - 10, left));
        top = Math.max(10, Math.min(bgH - actualH - 10, top));

        // 5. Tạo bóng đổ tự nhiên đa tầng (Soft Realistic Drop-Shadow xoay theo phối cảnh)
        const shadowPadding = 50;
        const svgW = actualW + shadowPadding * 2;
        const svgH = actualH + shadowPadding * 2;
        const centerX = svgW / 2;
        const centerY = svgH / 2;
        const angle = preset.angleDeg || 0;

        const rectX = centerX + preset.shadowDx - (finalW / 2);
        const rectY = centerY + preset.shadowDy - (finalH / 2);
        const rotCenterX = centerX + preset.shadowDx;
        const rotCenterY = centerY + preset.shadowDy;

        const shadowSvg = Buffer.from(`
            <svg width="${svgW}" height="${svgH}" xmlns="http://www.w3.org/2000/svg">
                <defs>
                    <filter id="softShadow" x="-50%" y="-50%" width="200%" height="200%">
                        <feGaussianBlur in="SourceGraphic" stdDeviation="${preset.shadowBlur}"/>
                    </filter>
                </defs>
                <rect x="${rectX}" y="${rectY}" width="${finalW}" height="${finalH}" rx="4"
                      transform="rotate(${angle}, ${rotCenterX}, ${rotCenterY})"
                      fill="rgba(0, 0, 0, ${preset.shadowOpacity})"
                      filter="url(#softShadow)"/>
            </svg>
        `);

        const shadowLeft = Math.max(0, left - shadowPadding);
        const shadowTop = Math.max(0, top - shadowPadding);

        const compositeLayers = [
            { input: shadowSvg, top: shadowTop, left: shadowLeft },
            { input: scaledFramed, top: top, left: left }
        ];

        // 6. Hòa trộn ghép đè lên ảnh nền và nén xuất file JPEG chất lượng cao
        const finalComposite = await sharp(bgBuffer)
            .composite(compositeLayers)
            .jpeg({ quality: 92, mozjpeg: true })
            .toBuffer();

        // 7. Lưu file thành phẩm vào thư mục lưu trữ prints
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
