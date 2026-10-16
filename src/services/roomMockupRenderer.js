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
            // Ánh sáng tự nhiên từ cửa sổ lớn bên phải chiếu sang
            // => Bóng đổ tự nhiên dạt sang BÊN TRÁI trên mặt bàn gỗ
            // 1. Contact Shadow: Rãnh bóng tiếp xúc chân khung và chân chống siêu đậm sát mặt bàn
            // 2. Umbra (Core Shadow): Lõi bóng đổ chính dạt sang trái, độ đậm đà tương đương bóng chiếc cốc
            // 3. Penumbra (Soft Halo): Viền bóng mờ êm dịu khuếch tán tự nhiên theo thớ gỗ sồi
            // 4. Chân chống phía sau tựa xuống bàn vững chãi
            // ========================================================
            const bottomY = top + finalH;

            const castLen = Math.round(finalH * 0.85); // Chiều dài bóng đổ sang trái tỷ lệ theo chiều cao khung
            const pad = 70;

            const minX = left - castLen - pad;
            const maxX = left + finalW + pad;
            const minY = bottomY - 90 - pad;
            const maxY = bottomY + 40 + pad;

            const svgW = maxX - minX;
            const svgH = maxY - minY;

            const toSvg = (x, y) => `${(x - minX).toFixed(1)},${(y - minY).toFixed(1)}`;

            const kickstandFootX = Math.round(left - Math.min(32, Math.max(20, finalW * 0.15)));
            const kickstandFootY = Math.round(bottomY - Math.min(45, Math.max(28, finalH * 0.14)));

            // 1. Umbra (Lõi bóng chính - đậm, gọn hơn, blur chặt)
            const uCastLen = castLen * 0.85;
            const uPtBaseUnder = toSvg(left + finalW * 0.45, bottomY);
            const uPtBaseFront = toSvg(left + 15, bottomY + 3);
            const uPtBaseLeft = toSvg(left, bottomY + 8);
            const uPtFrontMid = toSvg(left - uCastLen * 0.35, bottomY + 11);
            const uPtTipBottom = toSvg(left - uCastLen * 0.82, bottomY - 2);
            const uPtTip = toSvg(left - uCastLen, bottomY - 14);
            const uPtTipTop = toSvg(left - uCastLen * 0.82, bottomY - 28);
            const uPtRearMid = toSvg(left - uCastLen * 0.40, bottomY - 42);
            const uPtRearKickstand = toSvg(kickstandFootX - 12, kickstandFootY - 6);
            const uPtRearFrame = toSvg(left + finalW * 0.20, kickstandFootY + 5);

            // 2. Penumbra (Viền bóng mềm - tỏa rộng, chuyển êm)
            const pPtBaseUnder = toSvg(left + finalW * 0.55, bottomY);
            const pPtBaseFront = toSvg(left + 25, bottomY + 5);
            const pPtBaseLeft = toSvg(left, bottomY + 12);
            const pPtFrontMid = toSvg(left - castLen * 0.35, bottomY + 16);
            const pPtTipBottom = toSvg(left - castLen * 0.80, bottomY);
            const pPtTip = toSvg(left - castLen, bottomY - 14);
            const pPtTipTop = toSvg(left - castLen * 0.82, bottomY - 34);
            const pPtRearMid = toSvg(left - castLen * 0.40, bottomY - 54);
            const pPtRearKickstand = toSvg(kickstandFootX - 22, kickstandFootY - 12);
            const pPtRearFrame = toSvg(left + finalW * 0.30, kickstandFootY + 5);

            // Tọa độ gradient userSpaceOnUse chuẩn xác
            const gx1 = (left + 15 - minX).toFixed(1);
            const gy1 = (bottomY - minY).toFixed(1);
            const gx2 = (left - castLen - minX).toFixed(1);
            const gy2 = (bottomY - 15 - minY).toFixed(1);

            const deskShadowSvg = Buffer.from(`
                <svg width="${svgW}" height="${svgH}" xmlns="http://www.w3.org/2000/svg">
                    <defs>
                        <!-- Penumbra Gradient: viền ngoài mềm mượt -->
                        <linearGradient id="penumbraGrad" x1="${gx1}" y1="${gy1}" x2="${gx2}" y2="${gy2}" gradientUnits="userSpaceOnUse">
                            <stop offset="0%" stop-color="#080402" stop-opacity="0.65"/>
                            <stop offset="25%" stop-color="#080402" stop-opacity="0.55"/>
                            <stop offset="55%" stop-color="#080402" stop-opacity="0.32"/>
                            <stop offset="80%" stop-color="#080402" stop-opacity="0.14"/>
                            <stop offset="100%" stop-color="#080402" stop-opacity="0.0"/>
                        </linearGradient>

                        <!-- Umbra Gradient: lõi bóng đậm đà khớp sắc độ bóng chiếc cốc -->
                        <linearGradient id="umbraGrad" x1="${gx1}" y1="${gy1}" x2="${gx2}" y2="${gy2}" gradientUnits="userSpaceOnUse">
                            <stop offset="0%" stop-color="#060301" stop-opacity="0.88"/>
                            <stop offset="20%" stop-color="#060301" stop-opacity="0.80"/>
                            <stop offset="48%" stop-color="#060301" stop-opacity="0.55"/>
                            <stop offset="75%" stop-color="#060301" stop-opacity="0.22"/>
                            <stop offset="100%" stop-color="#060301" stop-opacity="0.0"/>
                        </linearGradient>

                        <filter id="penumbraBlur" x="-30%" y="-30%" width="160%" height="160%">
                            <feGaussianBlur stdDeviation="12.0"/>
                        </filter>
                        <filter id="umbraBlur" x="-30%" y="-30%" width="160%" height="160%">
                            <feGaussianBlur stdDeviation="5.0"/>
                        </filter>
                        <filter id="contactBlur" x="-20%" y="-50%" width="140%" height="200%">
                            <feGaussianBlur stdDeviation="2.0"/>
                        </filter>
                    </defs>

                    <!-- 1. Penumbra: Vùng tỏa mềm bên ngoài -->
                    <path d="M ${pPtBaseUnder} 
                             L ${pPtBaseFront} 
                             L ${pPtBaseLeft} 
                             Q ${pPtFrontMid} ${pPtTipBottom} 
                             Q ${pPtTip} ${pPtTipTop} 
                             Q ${pPtRearMid} ${pPtRearKickstand} 
                             L ${pPtRearFrame} Z" 
                          fill="url(#penumbraGrad)" filter="url(#penumbraBlur)"/>

                    <!-- 2. Umbra: Lõi bóng đổ đậm đà tương đương bóng cốc -->
                    <path d="M ${uPtBaseUnder} 
                             L ${uPtBaseFront} 
                             L ${uPtBaseLeft} 
                             Q ${uPtFrontMid} ${uPtTipBottom} 
                             Q ${uPtTip} ${uPtTipTop} 
                             Q ${uPtRearMid} ${uPtRearKickstand} 
                             L ${uPtRearFrame} Z" 
                          fill="url(#umbraGrad)" filter="url(#umbraBlur)"/>

                    <!-- 3. Bóng tiếp xúc chân chống (kickstand contact) -->
                    <ellipse cx="${(kickstandFootX - minX + 5).toFixed(1)}" cy="${(kickstandFootY - minY + 2).toFixed(1)}" rx="13" ry="5" fill="#060301" opacity="0.90" filter="url(#contactBlur)"/>

                    <!-- 4. Rãnh bóng tiếp xúc chân khung (Contact Shadow) siêu đậm sát mặt bàn -->
                    <rect x="${(left - minX - 1).toFixed(1)}" y="${(bottomY - minY - 2).toFixed(1)}" width="${finalW + 2}" height="6.5" rx="3" fill="#060301" opacity="0.95" filter="url(#contactBlur)"/>
                </svg>
            `);

            // B. Chân Chống (Kickstand) phía sau tranh tựa xuống bàn
            const legTopX = Math.round(left + finalW * 0.38);
            const legTopY = Math.round(top + finalH * 0.46);
            const legFootX = kickstandFootX;
            const legFootY = kickstandFootY;

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
            // 1. Bóng đổ dạt sang bên trái trên mặt bàn (Umbra + Penumbra + Contact)
            // 2. Chân chống tựa bàn
            // 3. Khung tranh đè lên trên cùng
            compositeLayers = [
                { input: deskShadowSvg, top: minY, left: minX },
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
