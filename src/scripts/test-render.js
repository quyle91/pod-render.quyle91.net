#!/usr/bin/env node

/**
 * Fast Test Harness CLI for POD Render Engine
 * 
 * Usage:
 *   node src/scripts/test-render.js --order=281
 *   node src/scripts/test-render.js --state='{"canvas":{"width":1200,"height":1200},"layers":[...]}'
 *   node src/scripts/test-render.js --file=path/to/state.json
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const sharpRenderer = require('../services/sharpRenderer');

const ARTIFACT_DIR = '/home/quyle91/.gemini/antigravity-ide/brain/110de5af-5596-43f8-98c4-d7c81693a068';

function parseArgs() {
    const args = process.argv.slice(2);
    const options = {};
    for (const arg of args) {
        if (arg.startsWith('--order=')) {
            options.order = parseInt(arg.split('=')[1], 10);
        } else if (arg.startsWith('--state=')) {
            options.state = arg.substring('--state='.length);
        } else if (arg.startsWith('--file=')) {
            options.file = arg.substring('--file='.length);
        } else if (arg.startsWith('--width=')) {
            options.width = parseInt(arg.split('=')[1], 10);
        } else if (arg.startsWith('--height=')) {
            options.height = parseInt(arg.split('=')[1], 10);
        }
    }
    return options;
}

async function main() {
    const options = parseArgs();

    if (!options.order && !options.state && !options.file) {
        console.log(`
[POD Fast Test CLI]
Usage:
  node src/scripts/test-render.js --order=<ORDER_ID>
  node src/scripts/test-render.js --state='<JSON_STRING>'
  node src/scripts/test-render.js --file=<PATH_TO_JSON>

Example:
  node src/scripts/test-render.js --order=281
        `);
        process.exit(1);
    }

    let payload = {
        order_id: options.order || 'cli_test',
        item_id: 'test_item',
        recipient_name: 'Test Customer',
        product_name: 'Custom T-Shirt',
        width: options.width || 3000,
        height: options.height || 3000,
        preview_url: ''
    };

    let canvasState = null;

    if (options.file) {
        const raw = fs.readFileSync(path.resolve(options.file), 'utf8');
        canvasState = JSON.parse(raw);
    } else if (options.state) {
        canvasState = JSON.parse(options.state);
    } else if (options.order) {
        console.log(`[POD Fast Test] Fetching order state for Order #${options.order}...`);
        const wpUrl = process.env.WP_URL || 'http://pod.localhost';
        const secret = process.env.SHARED_SECRET || 'pod_secret_token_123456';
        try {
            const res = await axios.get(`${wpUrl}/wp-json/pod-customizer/v1/order-state/${options.order}`, {
                headers: { 'X-POD-SECRET': secret },
                timeout: 8000
            });
            if (res.data && res.data.success && res.data.data && res.data.data.length > 0) {
                const item = res.data.data[0];
                payload.order_id = item.order_id;
                payload.item_id = item.item_id;
                payload.product_name = item.product_name;
                payload.recipient_name = item.recipient_name;
                payload.preview_url = item.preview_url;
                canvasState = item.canvas_state;
                console.log(`[POD Fast Test] Retrieved Line Item #${item.item_id} ("${item.product_name}")`);
            } else {
                throw new Error('No custom POD items found in order');
            }
        } catch (err) {
            console.error(`[POD Fast Test] Failed to fetch order #${options.order}:`, err.response?.data || err.message);
            process.exit(1);
        }
    }

    payload.canvas = canvasState.canvas || { width: 1200, height: 1200 };
    payload.layers = canvasState.layers || [];

    console.log(`[POD Fast Test] Executing SharpRenderer composite pipeline (Target: ${payload.width}x${payload.height} px @ 300 DPI)...`);
    const startTime = Date.now();
    const result = await sharpRenderer.render(payload);
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);

    console.log(`[POD Fast Test] Render completed in ${duration}s!`);
    console.log('---------------------------------------------------------');
    console.log(`  Print Ready PNG   : ${result.print_output_path} (${(fs.statSync(result.print_output_path).size / 1024).toFixed(1)} KB)`);
    if (result.mockup_output_path && fs.existsSync(result.mockup_output_path)) {
        console.log(`  Mockup Preview JPG: ${result.mockup_output_path} (${(fs.statSync(result.mockup_output_path).size / 1024).toFixed(1)} KB)`);
    }
    console.log(`  Production ZIP    : ${result.zip_output_path} (${(fs.statSync(result.zip_output_path).size / 1024).toFixed(1)} KB)`);
    console.log('---------------------------------------------------------');

    // Copy to IDE artifact directory if exists
    if (fs.existsSync(ARTIFACT_DIR)) {
        const destPrint = path.join(ARTIFACT_DIR, `test_order_${payload.order_id}_print_300dpi.png`);
        const destMockup = path.join(ARTIFACT_DIR, `test_order_${payload.order_id}_mockup_preview.jpg`);
        fs.copyFileSync(result.print_output_path, destPrint);
        if (result.mockup_output_path && fs.existsSync(result.mockup_output_path)) {
            fs.copyFileSync(result.mockup_output_path, destMockup);
        }
        console.log(`[POD Fast Test] Artifacts copied to IDE workspace for instant viewing:`);
        console.log(`  -> file://${destPrint}`);
        console.log(`  -> file://${destMockup}`);

        // Generate self-contained HTML comparison report in scratch
        const scratchDir = path.join(ARTIFACT_DIR, 'scratch');
        if (!fs.existsSync(scratchDir)) fs.mkdirSync(scratchDir, { recursive: true });

        const htmlReport = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Fast Test Report - Order #${payload.order_id}</title>
  <style>
    body { background: #0b0f19; color: #f3f4f6; font-family: -apple-system, sans-serif; padding: 24px; }
    h1 { font-size: 20px; margin-bottom: 8px; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-top: 20px; }
    .box { background: #1f2937; padding: 16px; border-radius: 12px; }
    .img-wrap { width: 100%; aspect-ratio: 1; border-radius: 8px; overflow: hidden; display: flex; align-items: center; justify-content: center; }
    .bg-dark { background: #18181b; }
    img { max-width: 100%; max-height: 100%; object-fit: contain; }
  </style>
</head>
<body>
  <h1>POD Fast Test Render: Order #${payload.order_id} Item #${payload.item_id}</h1>
  <p style="color:#9ca3af;">Generated in ${duration}s @ 300 DPI (${payload.width}x${payload.height}px)</p>
  <div class="grid">
    <div class="box">
      <h3>Mockup Preview (Garment + Background)</h3>
      <div class="img-wrap" style="background:#1e293b;">
        <img src="file://${destMockup}">
      </div>
    </div>
    <div class="box">
      <h3>Print-Ready 300 DPI Transparent PNG (On Dark Shirt)</h3>
      <div class="img-wrap bg-dark">
        <img src="file://${destPrint}">
      </div>
    </div>
  </div>
</body>
</html>`;
        fs.writeFileSync(path.join(scratchDir, `test_report_order_${payload.order_id}.html`), htmlReport);
        console.log(`  -> HTML Report: file://${path.join(scratchDir, `test_report_order_${payload.order_id}.html`)}`);
    }
}

main().catch(err => {
    console.error('[POD Fast Test] Fatal error:', err);
    process.exit(1);
});
