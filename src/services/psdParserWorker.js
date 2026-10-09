const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { readPsd, initializeCanvas } = require('ag-psd');

// Initialize ag-psd without native canvas dependency (pure JS TypedArray buffer)
initializeCanvas(null, (width, height) => ({
    width,
    height,
    data: new Uint8ClampedArray(width * height * 4)
}));

/**
 * Determine the base directory for WordPress uploads.
 * Checks container mount first, then local host directory.
 */
function getUploadsBaseDir() {
    const containerPodTemplates = '/app/pod-templates';
    if (fs.existsSync(containerPodTemplates)) {
        return containerPodTemplates;
    }

    const hostPodTemplates = path.resolve(__dirname, '../../../pod.localhost/source/public/pod-templates');
    if (fs.existsSync(hostPodTemplates)) {
        return hostPodTemplates;
    }

    const containerWpUploads = '/app/wp-uploads';
    if (fs.existsSync(containerWpUploads)) {
        return containerWpUploads;
    }

    const hostWpUploads = path.resolve(__dirname, '../../../pod.localhost/source/wp-content/uploads');
    if (fs.existsSync(hostWpUploads)) {
        return hostWpUploads;
    }

    const fallbackDir = path.resolve(__dirname, '../../storage/pod');
    fs.mkdirSync(fallbackDir, { recursive: true });
    return fallbackDir;
}

/**
 * Sanitize string into a safe identifier/filename slug.
 */
function slugify(text) {
    return String(text || '')
        .toLowerCase()
        .replace(/\[.*?\]/g, '') // remove prefix tags like [fixed], [group:xxx]
        .trim()
        .replace(/[^\w\s-]/g, '')
        .replace(/[\s_-]+/g, '_')
        .replace(/^-+|-+$/g, '') || 'layer';
}

/**
 * Convert RGB/RGBA object to #RRGGBB hex string.
 */
function rgbToHex(fillColor) {
    if (!fillColor) return '#1F2937';
    const r = Math.min(255, Math.max(0, Math.round(fillColor.r ?? 0)));
    const g = Math.min(255, Math.max(0, Math.round(fillColor.g ?? 0)));
    const b = Math.min(255, Math.max(0, Math.round(fillColor.b ?? 0)));
    return '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
}

/**
 * Parse PSD binary file and extract layers into Product-Centric storage.
 *
 * @param {string} jobId
 * @param {string} filePath
 * @param {string} originalFilename
 * @param {function} progressCallback (progress, stage, message)
 * @param {object} options Options object containing optional productId
 * @returns {Promise<object>} Complete Product/Template JSON
 */
async function parsePsd(jobId, filePath, originalFilename, progressCallback = () => {}, options = {}) {
    const productId = options.productId || null;
    const timestamp = Date.now();
    const cleanBasename = path.basename(originalFilename, path.extname(originalFilename));
    const templateId = productId ? `prod_${productId}` : `tpl_${slugify(cleanBasename)}_${timestamp}`;

    progressCallback(10, 'reading_psd', 'Đang đọc cấu trúc nhị phân file PSD...');

    if (!fs.existsSync(filePath)) {
        throw new Error(`File PSD không tồn tại tại đường dẫn: ${filePath}`);
    }

    const psdBuffer = fs.readFileSync(filePath);

    progressCallback(25, 'decoding_layers', 'Đang giải mã cây layer và tối ưu hóa bộ nhớ (skip composite)...');

    // Memory-efficient reading of PSD
    const psd = readPsd(psdBuffer, {
        skipThumbnail: true,
        skipCompositeImageData: true,
        useImageData: true
    });

    const canvasWidth = psd.width || 2400;
    const canvasHeight = psd.height || 3000;

    progressCallback(40, 'preparing_storage', 'Đang khởi tạo thư mục lưu trữ sản phẩm...');

    const uploadsBaseDir = getUploadsBaseDir();
    const isPodTemplates = uploadsBaseDir.includes('pod-templates');
    const targetFolder = productId ? String(productId) : templateId;
    const templateDir = isPodTemplates ? path.join(uploadsBaseDir, targetFolder) : path.join(uploadsBaseDir, 'pod', targetFolder);
    const layersDir = path.join(templateDir, 'layers');
    const thumbsDir = path.join(templateDir, 'thumbs');
    const urlBase = isPodTemplates ? `/pod-templates/${targetFolder}` : `/wp-content/uploads/pod/${targetFolder}`;

    fs.mkdirSync(layersDir, { recursive: true });
    fs.mkdirSync(thumbsDir, { recursive: true });

    const fields = [];
    const layers = [];
    let mockupConfig = null;
    let zIndexCounter = 1;

    progressCallback(50, 'extracting_layers', 'Bắt đầu bóc tách từng layer đồ họa 300 DPI...');

    const children = psd.children || [];
    const totalItems = children.length;

    for (let i = 0; i < totalItems; i++) {
        const item = children[i];
        const itemName = (item.name || '').trim();
        const itemProgress = 50 + Math.round(((i + 1) / totalItems) * 40);

        progressCallback(itemProgress, 'processing_layer', `Đang xử lý layer [${i + 1}/${totalItems}]: ${itemName}`);

        // Case 1: Folder Group with variants [group:slug]
        const groupMatch = itemName.match(/^\[group:([^\]]+)\]\s*(.*)$/i);
        if (groupMatch || item.children) {
            const groupSlug = groupMatch ? groupMatch[1].trim() : slugify(itemName);
            const groupLabel = (groupMatch && groupMatch[2].trim()) ? groupMatch[2].trim() : itemName.replace(/^\[.*?\]\s*/, '');

            const groupChildren = item.children || [];
            const selectorOptions = [];
            let defaultLayerId = null;

            for (let cIdx = 0; cIdx < groupChildren.length; cIdx++) {
                const child = groupChildren[cIdx];
                const childName = (child.name || `variant_${cIdx + 1}`).trim();
                const childSlug = slugify(childName);
                const childLayerId = `layer_${groupSlug}_${childSlug}`;

                if (!defaultLayerId) {
                    defaultLayerId = childLayerId;
                }

                const layerFilename = `${groupSlug}_${childSlug}.png`;
                const layerFilePath = path.join(layersDir, layerFilename);
                const layerUrl = `${urlBase}/layers/${layerFilename}`;

                const thumbFilename = `thumb_${groupSlug}_${childSlug}.png`;
                const thumbFilePath = path.join(thumbsDir, thumbFilename);
                const thumbUrl = `${urlBase}/thumbs/${thumbFilename}`;

                // Extract full PNG (300 DPI)
                if (child.imageData && child.imageData.width > 0 && child.imageData.height > 0) {
                    await sharp(Buffer.from(child.imageData.data), {
                        raw: {
                            width: child.imageData.width,
                            height: child.imageData.height,
                            channels: 4
                        }
                    })
                    .png()
                    .withMetadata({ density: 300 })
                    .toFile(layerFilePath);

                    // Generate small swatch thumbnail (150x150)
                    await sharp(layerFilePath)
                        .resize(150, 150, {
                            fit: 'contain',
                            background: { r: 0, g: 0, b: 0, alpha: 0 }
                        })
                        .png()
                        .toFile(thumbFilePath);
                }

                const childWidth = (child.right ?? 0) - (child.left ?? 0) || (child.imageData ? child.imageData.width : 0);
                const childHeight = (child.bottom ?? 0) - (child.top ?? 0) || (child.imageData ? child.imageData.height : 0);

                layers.push({
                    id: childLayerId,
                    type: 'image',
                    name: childName.replace(/^\[.*?\]\s*/, '') || childName,
                    group_id: groupSlug,
                    url: layerUrl,
                    x: child.left ?? 0,
                    y: child.top ?? 0,
                    width: childWidth,
                    height: childHeight,
                    rotation: 0,
                    z_index: zIndexCounter,
                    printable: true,
                    always_visible: cIdx === 0 // default visible is first variant
                });

                selectorOptions.push({
                    id: childSlug,
                    label: childName.replace(/^\[.*?\]\s*/, ''),
                    layer_id: childLayerId,
                    thumbnail_url: thumbUrl
                });
            }

            zIndexCounter++;

            // 100% Layer-driven layer_selector field (No hex colors, no color tinting)
            fields.push({
                id: groupSlug,
                type: 'layer_selector',
                label: groupLabel || 'Chọn tùy chọn',
                default_value: defaultLayerId,
                display_type: selectorOptions.length <= 6 ? 'swatches' : 'dropdown',
                options: selectorOptions
            });

            continue;
        }

        // Coordinates & dimensions for loose layers
        const layerWidth = (item.right ?? 0) - (item.left ?? 0) || (item.imageData ? item.imageData.width : 0);
        const layerHeight = (item.bottom ?? 0) - (item.top ?? 0) || (item.imageData ? item.imageData.height : 0);
        const layerX = item.left ?? 0;
        const layerY = item.top ?? 0;

        // Case 2: Text Layer [text]
        if (item.text || itemName.toLowerCase().startsWith('[text]')) {
            const cleanLabel = itemName.replace(/^\[text\]\s*/i, '').trim();
            const textSlug = slugify(cleanLabel || 'text');
            const layerId = `layer_text_${textSlug}`;
            const textData = item.text || {};

            const fontName = textData.style?.font?.name || textData.styleRuns?.[0]?.style?.font?.name || 'Montserrat';
            const fontSize = textData.style?.fontSize || 48;
            const fontColor = rgbToHex(textData.style?.fillColor || textData.styleRuns?.[0]?.style?.fillColor);
            const justification = textData.paragraphStyle?.justification || 'left';
            const defaultText = textData.text || cleanLabel || 'Custom Text';

            layers.push({
                id: layerId,
                type: 'text',
                name: cleanLabel || defaultText || itemName,
                default_value: defaultText,
                font_family: fontName,
                font_size_pt: fontSize,
                color: fontColor,
                text_align: justification,
                x: layerX,
                y: layerY,
                width: layerWidth,
                height: layerHeight,
                rotation: 0,
                z_index: zIndexCounter++,
                printable: true,
                behavior: {
                    auto_shrink: true,
                    min_font_size_pt: 18
                }
            });

            fields.push({
                id: `slot_${textSlug}`,
                type: 'text',
                label: cleanLabel || 'Nhập văn bản',
                default_value: defaultText,
                target_layer: layerId
            });

            continue;
        }

        // Case 3: Icon / Preset Slot [slot:icon] or [slot]
        const slotMatch = itemName.match(/^\[slot(?::([^\]]+))?\]\s*(.*)$/i);
        if (slotMatch) {
            const slotCategory = (slotMatch[1] || 'icon').trim();
            const cleanLabel = (slotMatch[2] || 'Icon').trim();
            const slotSlug = slugify(cleanLabel);
            const layerId = `layer_slot_${slotSlug}`;

            let placeholderUrl = '';
            if (item.imageData && item.imageData.width > 0 && item.imageData.height > 0) {
                const placeholderFilename = `slot_${slotSlug}_placeholder.png`;
                const placeholderFilePath = path.join(layersDir, placeholderFilename);
                await sharp(Buffer.from(item.imageData.data), {
                    raw: {
                        width: item.imageData.width,
                        height: item.imageData.height,
                        channels: 4
                    }
                })
                .png()
                .withMetadata({ density: 300 })
                .toFile(placeholderFilePath);

                placeholderUrl = `${urlBase}/layers/${placeholderFilename}`;
            }

            layers.push({
                id: layerId,
                type: 'preset_picker',
                name: cleanLabel || itemName,
                placeholder_url: placeholderUrl,
                is_icon_slot: true,
                x: layerX,
                y: layerY,
                width: layerWidth,
                height: layerHeight,
                rotation: 0,
                z_index: zIndexCounter++,
                printable: true
            });

            fields.push({
                id: `slot_${slotSlug}`,
                type: 'preset_picker',
                label: cleanLabel || 'Chọn Biểu Tượng',
                target_layer: layerId,
                category_slug: slotCategory === 'icon' ? 'pod_icon_category' : slotCategory
            });

            continue;
        }

        // Case 4: Repeater Layer [repeater]
        if (itemName.toLowerCase().startsWith('[repeater]')) {
            const cleanLabel = itemName.replace(/^\[repeater\]\s*/i, '').trim();
            const repSlug = slugify(cleanLabel);
            const layerId = `layer_repeater_${repSlug}`;

            let repUrl = '';
            if (item.imageData && item.imageData.width > 0 && item.imageData.height > 0) {
                const repFilename = `repeater_${repSlug}.png`;
                const repFilePath = path.join(layersDir, repFilename);
                await sharp(Buffer.from(item.imageData.data), {
                    raw: {
                        width: item.imageData.width,
                        height: item.imageData.height,
                        channels: 4
                    }
                })
                .png()
                .withMetadata({ density: 300 })
                .toFile(repFilePath);

                repUrl = `${urlBase}/layers/${repFilename}`;
            }

            layers.push({
                id: layerId,
                type: 'repeater',
                name: itemName,
                url: repUrl,
                x: layerX,
                y: layerY,
                width: layerWidth,
                height: layerHeight,
                rotation: 0,
                z_index: zIndexCounter++,
                printable: true
            });

            fields.push({
                id: `repeater_${repSlug}`,
                type: 'repeater_counter',
                label: cleanLabel || 'Số lượng phần tử',
                target_layer: layerId,
                min: 1,
                max: 10,
                default_value: 3
            });

            continue;
        }

        // Case 5: Mockup Base Layer [mockup]
        if (itemName.toLowerCase().startsWith('[mockup]')) {
            const cleanLabel = itemName.replace(/^\[mockup\]\s*/i, '').trim();
            const mockupSlug = slugify(cleanLabel);
            const mockupFilename = `mockup_${mockupSlug}.png`;
            const mockupFilePath = path.join(layersDir, mockupFilename);

            if (item.imageData && item.imageData.width > 0 && item.imageData.height > 0) {
                await sharp(Buffer.from(item.imageData.data), {
                    raw: {
                        width: item.imageData.width,
                        height: item.imageData.height,
                        channels: 4
                    }
                })
                .png()
                .toFile(mockupFilePath);

                mockupConfig = {
                    base_url: `${urlBase}/layers/${mockupFilename}`,
                    width: layerWidth,
                    height: layerHeight
                };
            }
            continue;
        }

        // Case 6: Fixed Background / Fixed Graphic [fixed] or loose layer
        const cleanLabel = itemName.replace(/^\[fixed\]\s*/i, '').trim();
        const fixedSlug = slugify(cleanLabel || `fixed_${i}`);
        const layerId = `layer_fixed_${fixedSlug}`;
        const fixedFilename = `fixed_${fixedSlug}.png`;
        const fixedFilePath = path.join(layersDir, fixedFilename);
        const fixedUrl = `${urlBase}/layers/${fixedFilename}`;

        if (item.imageData && item.imageData.width > 0 && item.imageData.height > 0) {
            await sharp(Buffer.from(item.imageData.data), {
                raw: {
                    width: item.imageData.width,
                    height: item.imageData.height,
                    channels: 4
                }
            })
            .png()
            .withMetadata({ density: 300 })
            .toFile(fixedFilePath);
        }

        layers.push({
            id: layerId,
            type: 'fixed_image',
            name: cleanLabel || itemName,
            url: fixedUrl,
            x: layerX,
            y: layerY,
            width: layerWidth,
            height: layerHeight,
            rotation: 0,
            z_index: zIndexCounter++,
            printable: true,
            always_visible: true
        });
    }

    progressCallback(92, 'generating_json', 'Đang hoàn tất Template JSON Contract...');

    const templateConfig = {
        template_id: templateId,
        source_file: originalFilename,
        created_at: new Date().toISOString(),
        print_spec: {
            width_px: canvasWidth,
            height_px: canvasHeight,
            dpi: 300,
            safe_zone_margin_px: Math.round(canvasWidth * 0.02)
        },
        mockup: mockupConfig || {
            base_url: layers.find(l => l.type === 'fixed_image')?.url || '',
            width: Math.round(canvasWidth / 4),
            height: Math.round(canvasHeight / 4)
        },
        fields: fields,
        layers: layers
    };

    // Save product/template config into storage folder
    const configFilename = productId ? 'product_config.json' : 'template_config.json';
    const configPath = path.join(templateDir, configFilename);
    fs.writeFileSync(configPath, JSON.stringify(templateConfig, null, 2), 'utf8');
    if (productId) {
        fs.writeFileSync(path.join(templateDir, 'template_config.json'), JSON.stringify(templateConfig, null, 2), 'utf8');
    }

    // Auto-cleanup temporary uploaded PSD file to reclaim disk space (TASK-912)
    progressCallback(98, 'cleaning_up', 'Đang dọn dẹp file PSD tạm trên đĩa...');
    try {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            console.log(`[PsdParserWorker] Auto-cleaned temporary PSD file: ${filePath}`);
        }
    } catch (cleanupErr) {
        console.warn(`[PsdParserWorker] Warning cleaning up temp PSD: ${cleanupErr.message}`);
    }

    progressCallback(100, 'completed', 'Bóc tách PSD thành công!');

    return {
        template_id: templateId,
        product_id: productId,
        template_config: templateConfig,
        config_url: `${urlBase}/${configFilename}`,
        total_layers: layers.length,
        total_fields: fields.length
    };
}

// Child Process Handler (for fork execution)
if (process.send) {
    process.on('message', async (msg) => {
        if (msg && msg.type === 'start') {
            try {
                const result = await parsePsd(
                    msg.jobId,
                    msg.filePath,
                    msg.filename,
                    (progress, stage, message) => {
                        process.send({
                            type: 'progress',
                            progress,
                            stage,
                            message
                        });
                    },
                    { productId: msg.productId }
                );

                process.send({
                    type: 'completed',
                    result
                });

                // Immediate exit to release 100% RAM back to OS
                process.exit(0);
            } catch (err) {
                console.error('[PsdParserWorker Child] Error:', err);
                process.send({
                    type: 'error',
                    error: err.message,
                    stack: err.stack
                });
                process.exit(1);
            }
        }
    });
}

module.exports = {
    parsePsd,
    getUploadsBaseDir,
    slugify,
    rgbToHex
};
