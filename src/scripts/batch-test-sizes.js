const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const roomMockupRenderer = require('../services/roomMockupRenderer');

const testDir = path.join(__dirname, '../../storage/prints/test_sizes');
if (!fs.existsSync(testDir)) {
    fs.mkdirSync(testDir, { recursive: true });
}

// Danh sách các khổ cần test cả dọc, ngang và vuông
const testCases = [
    // 1. Khổ nhỏ & Để bàn / Treo tường
    { code: '2030', name: '20x30', w: 20, h: 30, orientations: ['portrait', 'landscape'], contexts: ['desk', 'wall'] },
    { code: '3030', name: '30x30', w: 30, h: 30, orientations: ['square'], contexts: ['desk', 'wall'] },
    { code: '3040', name: '30x40', w: 30, h: 40, orientations: ['portrait', 'landscape'], contexts: ['desk', 'wall'] },
    { code: '4040', name: '40x40', w: 40, h: 40, orientations: ['square'], contexts: ['wall'] },
    
    // 2. Khổ vừa treo tường phổ biến
    { code: '4050', name: '40x50', w: 40, h: 50, orientations: ['portrait', 'landscape'], contexts: ['wall'] },
    { code: '4060', name: '40x60', w: 40, h: 60, orientations: ['portrait', 'landscape'], contexts: ['wall'] },
    { code: '5050', name: '50x50', w: 50, h: 50, orientations: ['square'], contexts: ['wall'] },
    { code: '4560', name: '45x60', w: 45, h: 60, orientations: ['portrait', 'landscape'], contexts: ['wall'] },
    { code: '5070', name: '50x70', w: 50, h: 70, orientations: ['portrait', 'landscape'], contexts: ['wall'] },
    { code: '6060', name: '60x60', w: 60, h: 60, orientations: ['square'], contexts: ['wall'] },
    
    // 3. Khổ lớn & Đại sảnh
    { code: '6080', name: '60x80', w: 60, h: 80, orientations: ['portrait', 'landscape'], contexts: ['wall'] },
    { code: '6090', name: '60x90', w: 60, h: 90, orientations: ['portrait', 'landscape'], contexts: ['wall'] },
    { code: '70100', name: '70x100', w: 70, h: 100, orientations: ['portrait', 'landscape'], contexts: ['wall'] },
    { code: '8080', name: '80x80', w: 80, h: 80, orientations: ['square'], contexts: ['wall'] },
    { code: '80120', name: '80x120', w: 80, h: 120, orientations: ['portrait', 'landscape'], contexts: ['wall'] },
    { code: '40120', name: '40x120', w: 40, h: 120, orientations: ['portrait', 'landscape'], contexts: ['wall'] },
    { code: '100100', name: '100x100', w: 100, h: 100, orientations: ['square'], contexts: ['wall'] }
];

async function generateSampleArtwork(wCm, hCm, label) {
    const pxW = wCm * 15;
    const pxH = hCm * 15;
    const minDim = Math.min(pxW, pxH);
    const circleR = Math.round(minDim * 0.28);
    const fontSize = Math.max(14, Math.round(minDim * 0.08));

    const svg = Buffer.from(`
        <svg width="${pxW}" height="${pxH}" xmlns="http://www.w3.org/2000/svg">
            <rect width="100%" height="100%" fill="#f8fafc"/>
            <circle cx="${pxW/2}" cy="${pxH*0.42}" r="${circleR}" fill="#fb923c" fill-opacity="0.9"/>
            <circle cx="${pxW/2}" cy="${pxH*0.42}" r="${circleR*0.62}" fill="#1e293b"/>
            <text x="${pxW/2}" y="${pxH*0.82}" font-size="${fontSize}" font-family="sans-serif" font-weight="bold" text-anchor="middle" fill="#0f172a">${label}</text>
        </svg>
    `);

    const png = await sharp(svg).png().toBuffer();
    return 'data:image/png;base64,' + png.toString('base64');
}

async function run() {
    console.log('Bắt đầu sinh hàng loạt mockup test đa kích thước...');
    const results = [];

    for (const item of testCases) {
        for (const orient of item.orientations) {
            for (const ctx of item.contexts) {
                let actualW = item.w;
                let actualH = item.h;
                if (orient === 'landscape') {
                    actualW = item.h;
                    actualH = item.w;
                }

                const label = `${actualW}x${actualH} cm`;
                const artworkBase64 = await generateSampleArtwork(actualW, actualH, label);

                // Khung viền composite nếu có
                const frameFile = `/home/quyle91/projects/pod.quyle91.net/source/storage/app/public/frame-types/composite/frame_composite_${item.code}.png`;
                const hasFrame = fs.existsSync(frameFile);

                const renderRes = await roomMockupRenderer.renderMockup({
                    context: ctx,
                    orientation: orient,
                    canvas_size_code: item.code,
                    width_cm: actualW,
                    height_cm: actualH,
                    frame_url: hasFrame ? frameFile : null,
                    artwork_base64: artworkBase64
                });

                // Copy thành tên dễ đọc: vd wall_40x60_portrait.jpg
                const targetFilename = `${ctx}_${item.name}_${orient}.jpg`;
                const targetPath = path.join(testDir, targetFilename);
                fs.copyFileSync(renderRes.output_path, targetPath);

                results.push({
                    file: targetFilename,
                    path: targetPath,
                    size: label,
                    context: ctx,
                    orientation: orient
                });
            }
        }
    }

    console.log('HOAN_THANH_TEST_RENDER: ' + results.length + ' ảnh đã sinh tại storage/prints/test_sizes/');
}

run().catch(console.error);
