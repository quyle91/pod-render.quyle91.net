const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const axios = require('axios');
const crypto = require('crypto');

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
     * Dựng phối cảnh tranh + khung lên bối cảnh phòng khách
     * @param {Object} params
     * @param {string|Buffer} params.background_url Ảnh nền phòng khách
     * @param {string|Buffer} params.frame_url Ảnh phôi khung viền PNG trong suốt
     * @param {string|Buffer} params.artwork_base64 Ảnh canvas cá nhân hóa của khách
     * @param {Object} params.transform { anchor_x, anchor_y, max_width, skew_y, rotate_deg }
     */
    async renderMockup({ background_url, frame_url, artwork_base64, transform = {} }) {
        const bgBuffer = await this.resolveBuffer(background_url);
        if (!bgBuffer) throw new Error('Không thể tải ảnh nền phòng khách (background_url).');

        const artworkBuffer = await this.resolveBuffer(artwork_base64);
        if (!artworkBuffer) throw new Error('Không thể tải ảnh tác phẩm canvas (artwork_base64).');

        const frameBuffer = await this.resolveBuffer(frame_url);

        // Đọc metadata của ảnh nền phòng khách
        const bgMeta = await sharp(bgBuffer).metadata();
        const bgW = bgMeta.width || 1200;
        const bgH = bgMeta.height || 896;

        let framedArtworkBuffer = null;

        if (frameBuffer) {
            // Lồng artwork vào lòng phôi khung PNG
            const frameMeta = await sharp(frameBuffer).metadata();
            const fW = frameMeta.width;
            const fH = frameMeta.height;

            // Co giãn artwork vừa khít lòng khung
            const resizedArtwork = await sharp(artworkBuffer)
                .resize(fW, fH, { fit: 'cover' })
                .toBuffer();

            // Ghép: Tranh ở lớp dưới, phôi khung (đục thủng lòng trong) ở lớp trên
            framedArtworkBuffer = await sharp(resizedArtwork)
                .composite([{ input: frameBuffer, top: 0, left: 0 }])
                .png()
                .toBuffer();
        } else {
            // Trường hợp không có khung (Canvas tràn viền / Chassis)
            framedArtworkBuffer = await sharp(artworkBuffer).png().toBuffer();
        }

        // Đọc metadata tranh sau khi lồng khung
        const framedMeta = await sharp(framedArtworkBuffer).metadata();
        const aspect = framedMeta.width / (framedMeta.height || 1);

        // Phân tích và chuẩn hóa transform config (hỗ trợ cả JSON string và corners 4 góc)
        let tf = transform || {};
        if (typeof tf === 'string') {
            try { tf = JSON.parse(tf); } catch (e) { tf = {}; }
        }

        if (tf.corners && (!tf.anchor_x || !tf.anchor_y || !tf.max_width)) {
            const tl = tf.corners.top_left;
            const tr = tf.corners.top_right;
            const br = tf.corners.bottom_right;
            const bl = tf.corners.bottom_left;
            if (tl && tr && br && bl) {
                if (!tf.anchor_x) tf.anchor_x = Math.round((tl[0] + tr[0] + br[0] + bl[0]) / 4);
                if (!tf.anchor_y) tf.anchor_y = Math.round((tl[1] + tr[1] + br[1] + bl[1]) / 4);
                if (!tf.max_width) tf.max_width = Math.round(Math.max(tr[0] - tl[0], br[0] - bl[0]));
                if (tf.rotate_deg === undefined) {
                    tf.rotate_deg = Math.round(Math.atan2(tr[1] - tl[1], tr[0] - tl[0]) * 180 / Math.PI * 10) / 10;
                }
            }
        }

        // Tính kích thước hiển thị trên tường (mặc định 310px ~ 30% bề ngang không gian)
        const targetMaxWidth = Math.max(100, Math.min(bgW, parseInt(tf.max_width) || 310));
        let finalW = targetMaxWidth;
        let finalH = Math.round(finalW / aspect);

        // Resize tranh có khung về kích thước hiển thị
        let scaledFramed = await sharp(framedArtworkBuffer)
            .resize(finalW, finalH, { fit: 'fill' })
            .png()
            .toBuffer();

        // Xử lý góc xoay nếu có
        const rotateDeg = parseFloat(tf.rotate_deg) || 0;
        if (Math.abs(rotateDeg) > 0.05) {
            scaledFramed = await sharp(scaledFramed)
                .rotate(rotateDeg, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
                .png()
                .toBuffer();
        }

        const rotatedMeta = await sharp(scaledFramed).metadata();
        const actualW = rotatedMeta.width;
        const actualH = rotatedMeta.height;

        // Tọa độ tâm (anchor_x, anchor_y) chuyển thành tọa độ top-left
        const anchorX = parseInt(tf.anchor_x) || Math.round(bgW * 0.65);
        const anchorY = parseInt(tf.anchor_y) || Math.round(bgH * 0.30);

        let left = Math.round(anchorX - (actualW / 2));
        let top = Math.round(anchorY - (actualH / 2));

        // Ràng buộc không vượt quá mép ảnh nền
        left = Math.max(0, Math.min(bgW - actualW, left));
        top = Math.max(0, Math.min(bgH - actualH, top));

        // Tạo shadow mềm (đổ bóng chân thực) bên dưới khung tranh
        const shadowPadding = 20;
        const shadowSvg = Buffer.from(`
            <svg width="${actualW + shadowPadding * 2}" height="${actualH + shadowPadding * 2}">
                <defs>
                    <filter id="shadow" x="-20%" y="-20%" width="150%" height="150%">
                        <feDropShadow dx="0" dy="12" stdDeviation="15" flood-color="#000000" flood-opacity="0.35"/>
                    </filter>
                </defs>
                <rect x="${shadowPadding}" y="${shadowPadding}" width="${actualW}" height="${actualH}" rx="4" fill="black" filter="url(#shadow)"/>
            </svg>
        `);

        // Ghép shadow và tranh lên nền phòng khách
        const shadowLeft = Math.max(0, left - shadowPadding);
        const shadowTop = Math.max(0, top - shadowPadding);

        const compositeLayers = [
            { input: shadowSvg, top: shadowTop, left: shadowLeft },
            { input: scaledFramed, top: top, left: left }
        ];

        const finalComposite = await sharp(bgBuffer)
            .composite(compositeLayers)
            .jpeg({ quality: 90, mozjpeg: true })
            .toBuffer();

        // Lưu file vào thư mục prints
        const hash = crypto.randomBytes(8).toString('hex');
        const filename = `mockup_room_${Date.now()}_${hash}.jpg`;
        const outputPath = path.join(this.outputDir, filename);

        fs.writeFileSync(outputPath, finalComposite);

        return {
            filename,
            output_path: outputPath,
            mockup_url: `/prints/${filename}`,
            width: bgW,
            height: bgH
        };
    }
}

module.exports = new RoomMockupRenderer();
