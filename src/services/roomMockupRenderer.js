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
        anchorXRatio: 0.65,    // Đặt ở vị trí 65% bên phải mặt bàn (chuẩn xác theo mẫu của Đạo Huynh)
        bottomYRatio: 0.645,   // Đáy khung tranh tựa vững vàng trên mặt bàn gỗ sồi
        maxSafeWidth: 240,     // Khổ khung để bàn cân đối, viền đầm chắc tương xứng với tường
        maxSafeHeight: 320,    // Chiều cao tối đa khung để bàn
        shadowDx: -8,          // Ánh sáng tự nhiên từ rèm cửa sổ bên phải
        shadowDy: 10,
        shadowBlur: 8,
        shadowOpacity: 0.35
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
    async renderMockup({ context = 'wall', orientation = 'portrait', canvas_size_code, width_cm, height_cm, background_url, frame_url, artwork_base64, transform = {} }) {
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
            let activeFrameBuffer = frameBuffer;
            let frameMeta = await sharp(activeFrameBuffer).metadata();

            // Tự động xoay phôi khung 90 độ nếu hướng tranh (orientation) không khớp với hướng phôi khung
            if (orientation === 'landscape' && frameMeta.width < frameMeta.height) {
                activeFrameBuffer = await sharp(activeFrameBuffer).rotate(90).png().toBuffer();
                frameMeta = await sharp(activeFrameBuffer).metadata();
            } else if (orientation === 'portrait' && frameMeta.width > frameMeta.height) {
                activeFrameBuffer = await sharp(activeFrameBuffer).rotate(90).png().toBuffer();
                frameMeta = await sharp(activeFrameBuffer).metadata();
            }

            const fW = frameMeta.width;
            const fH = frameMeta.height;

            const resizedArtwork = await sharp(artworkBuffer)
                .resize(fW, fH, { fit: 'cover' })
                .toBuffer();

            // Lớp dưới: Artwork tranh của khách
            // Lớp trên: Phôi khung viền PNG (đục thủng lòng trong)
            framedArtworkBuffer = await sharp(resizedArtwork)
                .composite([{ input: activeFrameBuffer, top: 0, left: 0 }])
                .png()
                .toBuffer();
        } else {
            // Trường hợp Chassis (Tranh tràn viền không khung)
            framedArtworkBuffer = await sharp(artworkBuffer).png().toBuffer();
        }

        // 4. Thuật toán Đa Kích Thước Bounding Box & Tỷ Lệ Thực Tế Tường Phòng Khách
        const framedMeta = await sharp(framedArtworkBuffer).metadata();
        const aspect = framedMeta.width / (framedMeta.height || 1);

        let finalW, finalH, left, top;

        if (presetKey === 'wall') {
            // Khống chế nghiêm ngặt khoảng an toàn trần nhà và ghế sofa
            const minCeiling = preset.minCeilingMargin || 150;
            const maxSofa = preset.maxSofaMargin || 520;
            const maxSafeH = maxSofa - minCeiling; // 370px (dành cho khổ đại sảnh 80x120 hoặc 100x100)
            const maxSafeW = preset.maxSafeWidth || 420;

            // Phân giải kích thước thực tế theo cm từ width_cm, height_cm hoặc canvas_size_code
            let wCm = Number(width_cm) || 0;
            let hCm = Number(height_cm) || 0;

            if ((!wCm || !hCm) && canvas_size_code) {
                const codeStr = String(canvas_size_code).trim();
                if (codeStr.length === 4) {
                    wCm = parseInt(codeStr.substring(0, 2), 10);
                    hCm = parseInt(codeStr.substring(2, 4), 10);
                } else if (codeStr.length === 5) {
                    if (codeStr.endsWith('100') || codeStr.endsWith('120')) {
                        wCm = parseInt(codeStr.substring(0, 2), 10);
                        hCm = parseInt(codeStr.substring(2), 10);
                    } else {
                        wCm = parseInt(codeStr.substring(0, 2), 10);
                        hCm = parseInt(codeStr.substring(2), 10);
                    }
                } else if (codeStr.length === 6) {
                    wCm = parseInt(codeStr.substring(0, 3), 10);
                    hCm = parseInt(codeStr.substring(3), 10);
                }
            }

            if (wCm > 0 && hCm > 0) {
                if (orientation === 'landscape' && wCm < hCm) {
                    [wCm, hCm] = [hCm, wCm];
                } else if (orientation === 'portrait' && wCm > hCm) {
                    [wCm, hCm] = [hCm, wCm];
                }
            }

            let targetW, targetH;

            // Hệ số tỷ lệ chuẩn phòng khách: 3.65 px/cm
            // Khổ 40x60: chiều cao ~219px (nhỏ gọn, thanh thoát, cân xứng với sofa 2.1m)
            // Khổ 80x120: chiều cao ~370px (chạm trần an toàn)
            if (wCm > 0 && hCm > 0) {
                const pxPerCm = 3.65;
                targetW = Math.round(wCm * pxPerCm);
                targetH = Math.round(hCm * pxPerCm);
            } else {
                // Fallback nếu không có kích thước: mặc định khổ trung bình thanh thoát
                if (aspect < 0.9) {
                    // Dọc (Portrait) - chuẩn 40x60
                    targetH = 220;
                    targetW = Math.round(targetH * aspect);
                } else if (aspect > 1.15) {
                    // Ngang (Landscape) - chuẩn 60x40
                    targetW = 240;
                    targetH = Math.round(targetW / aspect);
                } else {
                    // Vuông (Square) - chuẩn 50x50
                    targetW = 190;
                    targetH = 190;
                }
            }

            // Chốt chặn trần và tường an toàn
            if (targetH > maxSafeH) {
                targetH = maxSafeH;
                targetW = Math.round(targetH * aspect);
            }
            if (targetW > maxSafeW) {
                targetW = maxSafeW;
                targetH = Math.round(targetW / aspect);
            }

            finalW = targetW;
            finalH = targetH;

            // Tâm cân đối mảng tường phòng khách (ngay tầm mắt tự nhiên)
            const centerY = Math.round((minCeiling + maxSofa) / 2) + 10; // ~345px
            const centerX = Math.round(bgW * preset.anchorXRatio);       // 512px

            left = Math.round(centerX - (finalW / 2));
            top = Math.round(centerY - (finalH / 2));

            // Đảm bảo không đụng trần hoặc chạm sát sofa
            if (top < minCeiling) top = minCeiling;
            if (top + finalH > maxSofa) top = maxSofa - finalH;
        } else {
            // Bối cảnh bàn làm việc: Khung để bàn (Tự động thích ứng Khổ Dọc / Ngang / Vuông)
            let maxSafeW = preset.maxSafeWidth || 240;
            let maxSafeH = preset.maxSafeHeight || 320;

            if (aspect > 1.15) {
                // Khung ngang để bàn
                maxSafeW = 320;
                maxSafeH = 240;
            } else if (aspect >= 0.9 && aspect <= 1.15) {
                // Khung vuông để bàn
                maxSafeW = 270;
                maxSafeH = 270;
            }

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

        // 5. Tạo bóng đổ chuyên biệt theo bối cảnh (Treo Tường vs Mặt Bàn)
        left = Math.max(10, Math.min(bgW - finalW - 10, left));
        top = Math.max(10, Math.min(bgH - finalH - 10, top));

        let compositeLayers = [];

        if (presetKey === 'wall') {
            // ========================================================
            // BỐI CẢNH TREO TƯỜNG (WALL):
            // Bóng nhỏ gọn hơn, đậm nét hơn và đổ rõ rệt về bên phải (do cửa sổ bên trái chiếu sáng)
            // Tầng 1: Contact shadow sắc nét sát gáy khung (dx=4, dy=3, blur=2.5, opacity=0.60)
            // Tầng 2: Directional shadow đổ mạnh về bên phải (dx=14, dy=8, blur=8, opacity=0.42)
            // ========================================================
            const shadowPadding = 35;
            const svgW = finalW + shadowPadding * 2;
            const svgH = finalH + shadowPadding * 2;

            const wallShadowSvg = Buffer.from(`
                <svg width="${svgW}" height="${svgH}" xmlns="http://www.w3.org/2000/svg">
                    <defs>
                        <filter id="wallShadowCompact" x="-30%" y="-30%" width="160%" height="160%">
                            <feDropShadow dx="4" dy="3" stdDeviation="2.5" flood-color="#020617" flood-opacity="0.60"/>
                            <feDropShadow dx="14" dy="8" stdDeviation="8" flood-color="#0f172a" flood-opacity="0.42"/>
                        </filter>
                    </defs>
                    <rect x="${shadowPadding}" y="${shadowPadding}" width="${finalW}" height="${finalH}" rx="2" fill="black" filter="url(#wallShadowCompact)"/>
                </svg>
            `);

            const shadowLeft = left - shadowPadding;
            const shadowTop = top - shadowPadding;

            compositeLayers = [
                { input: wallShadowSvg, top: shadowTop, left: shadowLeft },
                { input: scaledFramed, top: top, left: left }
            ];
        } else {
            // ========================================================
            // BỐI CẢNH BÀN LÀM VIỆC (DESK):
            // 1. Duy nhất 1 hình mờ đổ lên bàn về phía sau (mờ êm dịu, không shadow viền)
            // 2. Chân chống phía sau tựa xuống bàn (không shadow)
            // ========================================================
            const bottomY = top + finalH;

            // A. Duy nhất 1 hình mờ đổ lên mặt bàn lùi về phía sau (Rear Tabletop Soft Blur)
            const shadowDepth = Math.round(Math.min(95, Math.max(45, finalH * 0.30)));
            const shadowSkewLeft = Math.round(Math.min(90, Math.max(45, finalW * 0.36)));
            const shadowSkewRight = Math.round(Math.min(25, Math.max(10, finalW * 0.10)));

            const shadowPad = 40;
            const deskShadowW = finalW + shadowSkewLeft + shadowSkewRight + shadowPad * 2;
            const deskShadowH = shadowDepth + shadowPad * 2;

            const deskShadowTop = (bottomY - shadowDepth) - shadowPad;
            const deskShadowLeft = (left - shadowSkewLeft) - shadowPad;

            // Tọa độ các đỉnh bóng đổ hình thang trên mặt bàn:
            const sFrontLeftX = shadowPad + shadowSkewLeft;
            const sFrontRightX = shadowPad + shadowSkewLeft + finalW;
            const sFrontY = shadowPad + shadowDepth;

            const sBackLeftX = shadowPad;
            const sBackRightX = shadowPad + shadowSkewLeft + finalW - shadowSkewRight;
            const sBackY = shadowPad;

            const deskShadowSvg = Buffer.from(`
                <svg width="${deskShadowW}" height="${deskShadowH}" xmlns="http://www.w3.org/2000/svg">
                    <defs>
                        <!-- Gradient bóng mờ êm dịu từ chân tranh lùi về phía sau -->
                        <linearGradient id="rearGroundShadow" x1="70%" y1="100%" x2="20%" y2="0%">
                            <stop offset="0%" stop-color="#14100c" stop-opacity="0.55"/>
                            <stop offset="35%" stop-color="#1e1812" stop-opacity="0.38"/>
                            <stop offset="70%" stop-color="#2a221a" stop-opacity="0.18"/>
                            <stop offset="100%" stop-color="#2a221a" stop-opacity="0.0"/>
                        </linearGradient>
                        <filter id="rearDeskBlur" x="-30%" y="-30%" width="160%" height="160%">
                            <feGaussianBlur stdDeviation="7.5"/>
                        </filter>
                    </defs>

                    <!-- Duy nhất 1 hình mờ đổ bóng trên mặt bàn lùi về phía sau -->
                    <polygon points="${sFrontLeftX},${sFrontY} 
                                     ${sFrontRightX},${sFrontY} 
                                     ${sBackRightX},${sBackY} 
                                     ${sBackLeftX},${sBackY}" 
                             fill="url(#rearGroundShadow)" filter="url(#rearDeskBlur)"/>
                </svg>
            `);

            // B. Chân Chống (Kickstand) phía sau tranh tựa xuống bàn (thuần túy, không có shadow)
            const legTopX = Math.round(left + finalW * 0.38);
            const legTopY = Math.round(top + finalH * 0.46);
            const legFootX = Math.round(left - Math.min(32, finalW * 0.16));
            const legFootY = Math.round(bottomY - shadowDepth * 0.45);

            const legSvgW = Math.max(50, (legTopX - legFootX) + 35);
            const legSvgH = Math.max(50, (bottomY - legTopY) + 25);
            const legOriginX = legFootX - 10;
            const legOriginY = legTopY - 5;

            const relTopX1 = Math.max(0, (legTopX - legOriginX) - 5);
            const relTopX2 = (legTopX - legOriginX) + 7;
            const relTopY = (legTopY - legOriginY);
            const relFootX1 = Math.max(2, (legFootX - legOriginX));
            const relFootX2 = relFootX1 + 10;
            const relFootY = (legFootY - legOriginY);

            const kickstandSvg = Buffer.from(`
                <svg width="${legSvgW}" height="${legSvgH}" xmlns="http://www.w3.org/2000/svg">
                    <polygon points="${relTopX1},${relTopY} ${relTopX2},${relTopY} ${relFootX2},${relFootY} ${relFootX1},${relFootY}" 
                             fill="#242933"/>
                    <polygon points="${relFootX1},${relFootY} ${relFootX2},${relFootY} ${relFootX2 + 3},${relFootY + 2} ${relFootX1 - 2},${relFootY + 2}" 
                             fill="#11151c"/>
                </svg>
            `);

            // Thứ tự composite:
            // 1. Duy nhất 1 hình mờ đổ lên bàn về phía sau
            // 2. Chân chống không bóng
            // 3. Khung tranh đè lên trên
            compositeLayers = [
                { input: deskShadowSvg, top: deskShadowTop, left: deskShadowLeft },
                { input: kickstandSvg, top: legOriginY, left: legOriginX },
                { input: scaledFramed, top: top, left: left }
            ];
        }

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
