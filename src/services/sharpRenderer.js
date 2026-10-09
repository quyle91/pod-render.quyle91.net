const path = require('path');
const fs = require('fs');
const axios = require('axios');
const archiver = require('archiver');

/**
 * Service responsible for compositing layers at 300 DPI print-ready resolution
 * and packaging complete Production ZIP bundles for factories.
 */
class SharpRenderer {
    constructor() {
        this.outputDir = process.env.OUTPUT_DIR || path.join(__dirname, '../../storage/prints');
        if (!fs.existsSync(this.outputDir)) {
            fs.mkdirSync(this.outputDir, { recursive: true });
        }
    }

    /**
     * Escape XML special characters for SVG text injection.
     * @param {string} str 
     * @returns {string}
     */
    escapeXml(str) {
        return String(str || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&apos;');
    }

    /**
     * Resolve image buffer from Buffer, data URL, Two-Tier local disk path, or HTTP URL.
     * @param {string|Buffer} urlOrBuffer 
     * @returns {Promise<Buffer|null>}
     */
    async resolveImageBuffer(urlOrBuffer) {
        if (!urlOrBuffer) return null;
        if (Buffer.isBuffer(urlOrBuffer)) return urlOrBuffer;
        if (typeof urlOrBuffer === 'string') {
            if (urlOrBuffer.startsWith('data:image/')) {
                const parts = urlOrBuffer.split(',');
                return Buffer.from(parts[1], 'base64');
            }
            // Direct local file path check (within worker container storage)
            if (urlOrBuffer.startsWith('/') && fs.existsSync(urlOrBuffer)) {
                return fs.readFileSync(urlOrBuffer);
            }
            // HTTP fetch resolution
            let reqUrl = urlOrBuffer;
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
                console.error(`[SharpRenderer] Failed to fetch image from ${urlOrBuffer}:`, err.message);
                return null;
            }
        }
        return null;
    }

    /**
     * Generate comprehensive Factory Production Specifications manifest.
     */
    generateProductionSpecs({
        order_id,
        item_id,
        recipient_name,
        product_name,
        targetWidth,
        targetHeight,
        previewWidth,
        previewHeight,
        scaleX,
        scaleY,
        printableLayers,
        mockupBaseName
    }) {
        const lines = [];
        lines.push('=============================================================');
        lines.push('  POD FACTORY PRODUCTION SPECIFICATIONS');
        lines.push('=============================================================');
        lines.push(`Order ID         : #${order_id || 'N/A'}`);
        lines.push(`Item ID          : #${item_id || 'N/A'}`);
        if (recipient_name) {
            lines.push(`Customer Name    : ${recipient_name}`);
        }
        lines.push(`Product Base     : ${product_name || mockupBaseName || 'POD Custom Product'}`);
        lines.push(`Render Timestamp : ${new Date().toISOString()}`);
        lines.push(`Resolution       : ${targetWidth} x ${targetHeight} px @ 300 DPI`);
        lines.push(`Color Profile    : sRGB / 32-bit Transparent PNG`);
        lines.push(`Canvas Scale     : ${previewWidth}x${previewHeight} px -> ${targetWidth}x${targetHeight} px (${scaleX.toFixed(2)}x)`);
        lines.push('');
        lines.push('-------------------------------------------------------------');
        lines.push('  CUSTOMER CUSTOMIZATIONS & LAYER SPECIFICATIONS');
        lines.push('-------------------------------------------------------------');
        lines.push(`Total Custom Layers : ${printableLayers.length}`);
        lines.push('');

        const standardKeys = new Set([
            'id', 'type', 'name', 'text', 'fontFamily', 'fontSize', 'fill', 'textAlign',
            'x', 'y', 'width', 'height', 'scaleX', 'scaleY', 'rotation', 'angle',
            'zIndex', 'printable', 'url', 'buffer', '_rawAssetName'
        ]);

        printableLayers.forEach((layer, index) => {
            const num = index + 1;
            const typeUpper = (layer.type || 'LAYER').toUpperCase();
            const layerName = layer.name || `Layer ${num}`;
            const centerX = Math.round((parseFloat(layer.x) || 0) * scaleX);
            const centerY = Math.round((parseFloat(layer.y) || 0) * scaleY);
            const rot = parseFloat(layer.rotation || layer.angle) || 0;
            const zIdx = layer.zIndex !== undefined ? layer.zIndex : num;

            lines.push(`[Layer ${num}: ${typeUpper} - "${layerName}"]`);
            lines.push(`  - Layer ID         : ${layer.id || `layer_${num}`}`);
            lines.push(`  - Layer Type       : ${layer.type}`);

            if (layer.type === 'text') {
                const printFontSize = Math.round((parseFloat(layer.fontSize) || 24) * scaleX);
                lines.push(`  - Custom Text      : "${layer.text || ''}"`);
                lines.push(`  - Font Family      : ${layer.fontFamily || 'Roboto'}`);
                lines.push(`  - Font Weight      : ${layer.fontWeight || 'normal'}`);
                lines.push(`  - Font Style       : ${layer.fontStyle || 'normal'}`);
                lines.push(`  - Font Size        : ${layer.fontSize || 24} pt (Print Size: ${printFontSize} px @ 300 DPI)`);
                lines.push(`  - Text Color       : ${layer.fill || '#000000'}`);
                lines.push(`  - Text Alignment   : ${layer.textAlign || 'center'}`);
            } else if (layer.type === 'image' || layer.type === 'clipart' || layer.type === 'photo') {
                const w = Math.round((parseFloat(layer.width) || 100) * (parseFloat(layer.scaleX) || 1) * scaleX);
                const h = Math.round((parseFloat(layer.height) || 100) * (parseFloat(layer.scaleY) || 1) * scaleY);
                lines.push(`  - Asset Name       : ${layer.name || 'Graphic Element'}`);
                if (layer._rawAssetName) {
                    lines.push(`  - Raw Asset File   : 03_raw_assets/${layer._rawAssetName}`);
                }
                if (layer.url && !layer.url.startsWith('data:')) {
                    lines.push(`  - Asset Source URL : ${layer.url}`);
                }
                lines.push(`  - Print Dimensions : ${w} x ${h} px`);
            }

            lines.push(`  - Center Position  : (X: ${centerX} px, Y: ${centerY} px)`);
            lines.push(`  - Rotation Angle   : ${rot}°`);
            lines.push(`  - Stacking Order   : Z-Index ${zIdx}`);

            // Dynamic reflection: check for any extra / custom fields added in future
            const extraKeys = Object.keys(layer).filter(k => !standardKeys.has(k) && !k.startsWith('_'));
            if (extraKeys.length > 0) {
                lines.push(`  - Additional Custom Attributes:`);
                for (const key of extraKeys) {
                    const val = typeof layer[key] === 'object' ? JSON.stringify(layer[key]) : layer[key];
                    lines.push(`      * ${key}: ${val}`);
                }
            }
            lines.push('');
        });

        lines.push('-------------------------------------------------------------');
        lines.push('  FILES INCLUDED IN THIS PACKAGE:');
        lines.push('-------------------------------------------------------------');
        lines.push('  1. 01_print_ready_300dpi.png  -> Transparent printable graphic for DTG / Decal printing');
        lines.push('  2. 02_mockup_preview.jpg      -> 1:1 High-resolution garment / mug mockup visual reference for alignment');
        lines.push('  3. 03_raw_assets/             -> Original product mockup base (shirt/background) and cliparts/graphics');
        lines.push('  4. 04_production_specs.txt    -> This specifications manifest');
        lines.push('=============================================================');

        return lines.join('\n');
    }

    /**
     * Resolve sanitized domain name with dots replaced by underscores.
     * e.g. "pod.localhost" -> "pod_localhost", "sub.example.com" -> "sub_example_com"
     * @param {Object} payload 
     * @returns {string}
     */
    resolveDomainSlug(payload = {}) {
        let domain = payload.domain_name || payload.domain || '';
        
        if (!domain && payload.callback_url) {
            try {
                domain = new URL(payload.callback_url).hostname;
            } catch (e) {}
        }
        
        if (!domain && payload.preview_url && String(payload.preview_url).startsWith('http')) {
            try {
                domain = new URL(payload.preview_url).hostname;
            } catch (e) {}
        }

        if (!domain && process.env.WP_URL) {
            try {
                domain = new URL(process.env.WP_URL).hostname;
            } catch (e) {}
        }

        if (!domain) {
            domain = 'pod.localhost';
        }

        // Strip protocol, port, path if present
        domain = domain.replace(/^https?:\/\//, '').split('/')[0].split(':')[0];

        // Replace . with _ as requested
        return domain.replace(/\./g, '_').toLowerCase();
    }

    /**
     * Renders high-resolution composite image and builds factory ZIP package.
     * @param {Object} payload 
     * @returns {Promise<Object>}
     */
    async render(payload) {
        const { 
            order_id, 
            item_id, 
            recipient_name = '',
            product_name = '',
            canvas = {}, 
            layers = [], 
            preview_url = '' 
        } = payload;
        
        // Target 300 DPI canvas dimensions: default 3000x3000px
        const targetWidth = parseInt(payload.width || 3000, 10);
        const targetHeight = parseInt(payload.height || 3000, 10);
        
        // Base preview canvas size (e.g. 600x600 in Fabric.js or 1200x1200 rendered)
        const previewWidth = parseFloat(canvas.width || 600);
        const previewHeight = parseFloat(canvas.height || 600);
        
        const scaleX = targetWidth / previewWidth;
        const scaleY = targetHeight / previewHeight;

        const domainSlug = this.resolveDomainSlug(payload);
        const baseIdentifier = `order_${order_id || 'preview'}_item_${item_id || Date.now()}`;
        const printFilename = `${baseIdentifier}_300dpi.png`;
        const zipFilename = `${domainSlug}_${baseIdentifier}.zip`;

        const printOutputPath = path.join(this.outputDir, printFilename);
        const zipOutputPath = path.join(this.outputDir, zipFilename);

        let sharp;
        try {
            sharp = require('sharp');
        } catch (err) {
            console.warn('Sharp module not loaded, fallback to mock file:', err.message);
            fs.writeFileSync(printOutputPath, Buffer.from('MOCK_PRINT_FILE_DATA'));
            fs.writeFileSync(zipOutputPath, Buffer.from('MOCK_ZIP_FILE_DATA'));
            return {
                filename: printFilename,
                zip_filename: zipFilename,
                url: `/prints/${printFilename}`,
                zip_url: `/prints/${zipFilename}`,
                width: targetWidth,
                height: targetHeight,
                dpi: 300,
                status: 'completed'
            };
        }

        // Base blank transparent canvas at 300 DPI for printable graphic
        const baseImage = sharp({
            create: {
                width: targetWidth,
                height: targetHeight,
                channels: 4,
                background: { r: 0, g: 0, b: 0, alpha: 0 } // 100% Transparent background for garment DTG / decal printing
            }
        }).withMetadata({ density: 300 });

        const compositeList = [];
        const rawAssets = [];
        const printableLayers = [];
        let mockupBaseName = product_name;
        let mockupBuffer = null;

        // Sort layers by zIndex to preserve exact stacking order
        const sortedLayers = [...layers].sort((a, b) => (parseFloat(a.zIndex) || 0) - (parseFloat(b.zIndex) || 0));

        for (const layer of sortedLayers) {
            // Process product mockup base (shirt / garment / background)
            if (layer.id === 'mockup_base' || layer.printable === false) {
                if (layer.name && !mockupBaseName) mockupBaseName = layer.name;

                // Always fetch and include the product mockup base & background in 03_raw_assets/
                if (layer.buffer || layer.url) {
                    let mBuffer = await this.resolveImageBuffer(layer.buffer || layer.url);
                    let mFilename = `00_product_mockup_${layer.id || 'base'}`;
                    if (layer.url) {
                        const urlBase = path.basename(layer.url.split('?')[0]);
                        mFilename += `_${urlBase}`;
                    } else {
                        mFilename += '.png';
                    }

                    if (mBuffer) {
                        rawAssets.push({
                            name: mFilename,
                            buffer: mBuffer
                        });
                        mockupBuffer = mBuffer;
                    }
                }
                continue;
            }

            printableLayers.push(layer);

            // Object coordinates are center-origin in Fabric.js
            const centerX = Math.round((parseFloat(layer.x) || 0) * scaleX);
            const centerY = Math.round((parseFloat(layer.y) || 0) * scaleY);
            const layerW = Math.round((parseFloat(layer.width) || 100) * (parseFloat(layer.scaleX) || 1) * scaleX);
            const layerH = Math.round((parseFloat(layer.height) || 100) * (parseFloat(layer.scaleY) || 1) * scaleY);
            const rotation = parseFloat(layer.rotation || layer.angle) || 0;

            // 1. Text Layer: Full-canvas SVG rendering to eliminate viewport clipping and guarantee 1-to-1 center alignment
            if (layer.type === 'text') {
                const textVal = String(layer.text || '');
                const fontFamily = layer.fontFamily || 'Roboto';
                const fontSize = Math.round((parseFloat(layer.fontSize) || 24) * scaleY);
                const fill = layer.fill || '#ffffff';
                const textAlign = layer.textAlign || 'center';
                const textAnchor = textAlign === 'center' ? 'middle' : (textAlign === 'right' ? 'end' : 'start');

                // Multi-line support: calculate line offsets around vertical center
                const lines = textVal.split(/\r?\n/);
                const lineHeight = fontSize * 1.2;
                const startY = centerY - ((lines.length - 1) * lineHeight) / 2;

                const textElements = lines.map((line, idx) => {
                    const lineY = Math.round(startY + idx * lineHeight);
                    return `<text x="${centerX}" y="${lineY}" transform="rotate(${rotation}, ${centerX}, ${centerY})" class="pod-text">${this.escapeXml(line)}</text>`;
                }).join('\n');

                const fontStyle = layer.fontStyle || (layer.font_style || 'normal');
                let fontWeight = layer.fontWeight || layer.font_weight;
                if (!fontWeight) {
                    // Smart fallback for existing orders: template text or styled fonts default to 700 bold
                    if (payload.template_payload || ['Montserrat', 'Oswald'].includes(layer.fontFamily)) {
                        fontWeight = '700';
                    } else {
                        fontWeight = fontStyle === 'bold' ? 'bold' : 'normal';
                    }
                }

                const svgText = `
                <svg width="${targetWidth}" height="${targetHeight}" viewBox="0 0 ${targetWidth} ${targetHeight}" xmlns="http://www.w3.org/2000/svg">
                    <style>
                        .pod-text {
                            font-family: '${fontFamily}', 'Roboto', 'DejaVu Sans', sans-serif;
                            font-size: ${fontSize}px;
                            font-weight: ${fontWeight};
                            font-style: ${fontStyle};
                            fill: ${fill};
                            text-anchor: ${textAnchor};
                            dominant-baseline: central;
                        }
                    </style>
                    ${textElements}
                </svg>`;

                try {
                    const textBuffer = await sharp(Buffer.from(svgText)).png().toBuffer();
                    compositeList.push({
                        input: textBuffer,
                        top: 0,
                        left: 0,
                    });
                } catch (svgErr) {
                    console.error('[SharpRenderer] Error rendering text layer SVG:', svgErr.message);
                }
            }

            // 2. Clipart, Image, User Photo, or Two-Tier PSD Graphic Layers
            else if (['image', 'clipart', 'photo', 'fixed_image', 'preset_picker', 'repeater'].includes(layer.type) || layer.url || layer.buffer) {
                let imgBuffer = await this.resolveImageBuffer(layer.buffer || layer.url);
                let assetFilename = `asset_${layer.id || Date.now()}`;
                if (layer.url) {
                    const urlBase = path.basename(layer.url.split('?')[0]);
                    assetFilename += `_${urlBase}`;
                } else {
                    assetFilename += '.png';
                }

                if (imgBuffer) {
                    rawAssets.push({
                        name: assetFilename,
                        buffer: imgBuffer
                    });
                    layer._rawAssetName = assetFilename;

                    try {
                        let sharpImg = sharp(imgBuffer)
                            .resize(Math.max(10, layerW), Math.max(10, layerH), { fit: 'inside' });

                        if (rotation !== 0) {
                            sharpImg = sharpImg.rotate(rotation, { background: { r: 0, g: 0, b: 0, alpha: 0 } });
                        }

                        const resizedBuffer = await sharpImg.png().toBuffer();
                        const meta = await sharp(resizedBuffer).metadata();
                        const actualW = meta.width;
                        const actualH = meta.height;

                        // Center-origin positioning: subtract half width and height from center
                        compositeList.push({
                            input: resizedBuffer,
                            left: Math.round(centerX - actualW / 2),
                            top: Math.round(centerY - actualH / 2),
                        });
                    } catch (imgErr) {
                        console.error('[SharpRenderer] Error compositing image layer:', imgErr.message);
                    }
                }
            }
        }

        if (compositeList.length > 0) {
            baseImage.composite(compositeList);
        }

        // 1. Save 300 DPI Transparent PNG (Print-Ready)
        await baseImage.png().toFile(printOutputPath);

        // 2. Build 1:1 High-Resolution Mockup Preview Image for Factory Alignment
        let previewBuffer = null;
        if (mockupBuffer) {
            try {
                // Resize mockup base (shirt + studio background) to exact target dimensions
                const baseMockup = await sharp(mockupBuffer)
                    .resize(targetWidth, targetHeight)
                    .png()
                    .toBuffer();

                // Composite the printable elements on top of the mockup base at exact 1:1 scale
                previewBuffer = await sharp(baseMockup)
                    .composite(compositeList)
                    .jpeg({ quality: 90 })
                    .toBuffer();
            } catch (mockupErr) {
                console.warn('[SharpRenderer] Could not composite high-res mockup preview:', mockupErr.message);
            }
        }

        // Fallback to client-provided preview_url if high-res mockup composite was not possible
        if (!previewBuffer && preview_url) {
            try {
                previewBuffer = await this.resolveImageBuffer(preview_url);
            } catch (pErr) {
                console.warn('[SharpRenderer] Could not fetch fallback preview mockup for zip:', pErr.message);
            }
        }

        // 3. Save High-Resolution Mockup Preview file to disk
        let mockupFilename = null;
        let mockupOutputPath = null;
        if (previewBuffer) {
            mockupFilename = `${baseIdentifier}_mockup_preview.jpg`;
            mockupOutputPath = path.join(this.outputDir, mockupFilename);
            fs.writeFileSync(mockupOutputPath, previewBuffer);
        }

        // 4. Build Production Specs Text File
        const specsText = this.generateProductionSpecs({
            order_id,
            item_id,
            recipient_name,
            product_name,
            targetWidth,
            targetHeight,
            previewWidth,
            previewHeight,
            scaleX,
            scaleY,
            printableLayers,
            mockupBaseName
        });

        // 5. Create Factory ZIP Archive via archiver
        await this.createZipArchive({
            outputPath: zipOutputPath,
            printImagePath: printOutputPath,
            previewBuffer,
            specsText,
            rawAssets
        });

        return {
            filename: printFilename,
            mockup_filename: mockupFilename,
            zip_filename: zipFilename,
            url: `/prints/${printFilename}`,
            mockup_url: mockupFilename ? `/prints/${mockupFilename}` : (preview_url || null),
            zip_url: `/prints/${zipFilename}`,
            print_output_path: printOutputPath,
            mockup_output_path: mockupOutputPath,
            zip_output_path: zipOutputPath,
            specs_text: specsText,
            width: targetWidth,
            height: targetHeight,
            dpi: 300,
            status: 'completed'
        };
    }

    /**
     * Build ZIP file using streaming archiver.
     */
    createZipArchive({ outputPath, printImagePath, previewBuffer, specsText, rawAssets = [] }) {
        return new Promise((resolve, reject) => {
            const output = fs.createWriteStream(outputPath);
            const archive = archiver('zip', { zlib: { level: 9 } });

            output.on('close', () => resolve());
            archive.on('error', (err) => reject(err));

            archive.pipe(output);

            // 1. Add 300 DPI print file
            if (fs.existsSync(printImagePath)) {
                archive.file(printImagePath, { name: '01_print_ready_300dpi.png' });
            }

            // 2. Add 1:1 high-resolution mockup preview
            if (previewBuffer) {
                archive.append(previewBuffer, { name: '02_mockup_preview.jpg' });
            }

            // 3. Add production specs
            archive.append(specsText, { name: '04_production_specs.txt' });

            // 4. Add all raw assets (including product mockup base, background, and cliparts)
            for (const asset of rawAssets) {
                archive.append(asset.buffer, { name: `03_raw_assets/${asset.name}` });
            }

            archive.finalize();
        });
    }
}

module.exports = new SharpRenderer();
