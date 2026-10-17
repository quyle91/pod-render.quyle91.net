const express = require('express');
const router = express.Router();
const sharpRenderer = require('../services/sharpRenderer');
const renderLogger = require('../services/renderLogger');
const { verifySecret, verifyLicense } = require('../middleware/auth');
const axios = require('axios');

/**
 * POST /api/v1/render
 * Initiates render task for a custom order item.
 */
router.post('/render', verifyLicense, async (req, res) => {
    const startTime = Date.now();
    const payload = req.body;
    const clientIp = req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    try {
        if (!payload || !payload.order_id) {
            renderLogger.logRender({
                type: 'render',
                status: 'failed',
                order_id: payload?.order_id,
                item_id: payload?.item_id,
                client_ip: clientIp,
                duration_ms: Date.now() - startTime,
                payload,
                error_message: 'Strict Data Contract Violation: order_id is required'
            });
            return res.status(422).json({
                success: false,
                error: 'Strict Data Contract Violation: order_id is required'
            });
        }

        const renderResult = await sharpRenderer.render(payload);

        // Build absolute public download URLs for client/admin/factories
        const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
        const absolutePrintUrl = `${baseUrl}${renderResult.url}`;
        const absoluteZipUrl = `${baseUrl}${renderResult.zip_url}`;
        renderResult.public_url = absolutePrintUrl;
        renderResult.public_zip_url = absoluteZipUrl;

        // Log successful render into SQLite
        renderLogger.logRender({
            type: 'render',
            status: 'success',
            order_id: payload.order_id,
            item_id: payload.item_id,
            client_ip: clientIp,
            duration_ms: Date.now() - startTime,
            output_path: renderResult.print_output_path,
            output_url: absolutePrintUrl,
            payload
        });

        // If a callback URL is provided, notify client asynchronously
        if (payload.callback_url) {
            axios.post(payload.callback_url, {
                order_id: payload.order_id,
                item_id: payload.item_id,
                print_url: absolutePrintUrl,
                zip_url: absoluteZipUrl,
                dpi: 300,
                status: 'completed'
            }, {
                headers: { 'X-POD-SECRET': process.env.SHARED_SECRET }
            }).then(response => {
                // If client confirmed storing files locally, delete temporary files on the render worker
                if (response.data && response.data.stored_locally) {
                    const fs = require('fs');
                    if (renderResult.print_output_path && fs.existsSync(renderResult.print_output_path)) {
                        fs.unlink(renderResult.print_output_path, (err) => {
                            if (err) console.error('[POD Backend] Failed to remove temp print file:', err.message);
                        });
                    }
                    if (renderResult.zip_output_path && fs.existsSync(renderResult.zip_output_path)) {
                        fs.unlink(renderResult.zip_output_path, (err) => {
                            if (err) console.error('[POD Backend] Failed to remove temp zip file:', err.message);
                        });
                    }
                    console.log(`[POD Backend] Order #${payload.order_id} Item #${payload.item_id}: Production files transferred to client. Worker temp storage cleaned.`);
                }
            }).catch(err => {
                console.error('[POD Backend] Failed to dispatch webhook callback to client:', err.message);
            });
        }

        return res.status(200).json({
            success: true,
            data: renderResult
        });
    } catch (error) {
        console.error('[POD Backend] Error during render:', error);
        renderLogger.logRender({
            type: 'render',
            status: 'failed',
            order_id: payload?.order_id,
            item_id: payload?.item_id,
            client_ip: clientIp,
            duration_ms: Date.now() - startTime,
            payload,
            error_message: error.message
        });
        return res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * POST /api/v1/test-render
 * Fast developer & QA test endpoint.
 * Accepts order_id (fetches state automatically from WP) OR raw canvas_state / _pod_canvas_state.
 * Protected by verifyLicense to prevent unauthorized access, expired domain abuse.
 */
router.post('/test-render', verifyLicense, async (req, res) => {
    try {
        let payload = req.body || {};
        let orderId = payload.order_id;
        let canvasState = payload.canvas_state || payload._pod_canvas_state;

        // If order_id is provided and no direct canvasState:
        if (orderId && (!canvasState || !canvasState.layers)) {
            try {
                const clientUrl = process.env.CLIENT_URL || process.env.APP_URL || 'http://pod.localhost';
                const clientRes = await axios.get(`${clientUrl}/api/orders/${orderId}/state`, {
                    headers: { 'X-POD-SECRET': process.env.SHARED_SECRET || 'pod_secret_token_123456' },
                    timeout: 8000
                });
                if (clientRes.data && clientRes.data.success && clientRes.data.data) {
                    const itemData = Array.isArray(clientRes.data.data) ? clientRes.data.data[0] : clientRes.data.data;
                    payload.order_id = itemData.order_id;
                    payload.item_id = itemData.item_id;
                    payload.product_name = payload.product_name || itemData.product_name;
                    payload.recipient_name = payload.recipient_name || itemData.recipient_name;
                    payload.preview_url = itemData.preview_url;
                    canvasState = itemData.canvas_state;
                }
            } catch (queryErr) {
                console.warn(`[POD Backend] Could not query client for order #${orderId}:`, queryErr.message);
                return res.status(404).json({
                    success: false,
                    error: `Order #${orderId} could not be retrieved: ` + (queryErr.response?.data?.error || queryErr.message)
                });
            }
        }

        // Parse canvasState if it's a string
        if (typeof canvasState === 'string') {
            try {
                canvasState = JSON.parse(canvasState);
            } catch (pErr) {
                return res.status(400).json({ success: false, error: 'Invalid JSON format in canvas_state' });
            }
        }

        if (!canvasState || !canvasState.layers) {
            return res.status(400).json({
                success: false,
                error: 'Missing canvas state: Please provide an order_id or valid _pod_canvas_state with layers.'
            });
        }

        // Assemble render payload
        const renderPayload = {
            order_id: payload.order_id || 'test',
            item_id: payload.item_id || 'test_item',
            domain_name: payload.domain_name || payload.domain || '',
            recipient_name: payload.recipient_name || 'Test Customer',
            product_name: payload.product_name || 'POD Custom Product',
            preview_url: payload.preview_url || '',
            canvas: canvasState.canvas || { width: 1200, height: 1200 },
            layers: canvasState.layers || [],
            width: payload.width || 3000,
            height: payload.height || 3000,
        };

        const renderResult = await sharpRenderer.render(renderPayload);

        const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
        renderResult.public_print_url = `${baseUrl}${renderResult.url}`;
        renderResult.public_mockup_url = renderResult.mockup_url ? `${baseUrl}${renderResult.mockup_url}` : null;
        renderResult.public_zip_url = `${baseUrl}${renderResult.zip_url}`;

        return res.status(200).json({
            success: true,
            data: {
                ...renderResult,
                frontend_preview_url: payload.preview_url || null,
                input_payload: renderPayload
            }
        });
    } catch (error) {
        console.error('[POD Backend] Test render error:', error);
        return res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * GET /api/v1/verify-auth
 * Validates the provided secret token.
 */
router.get('/verify-auth', verifySecret, (req, res) => {
    return res.status(200).json({
        success: true,
        message: 'Authenticated successfully'
    });
});

/**
 * POST /api/v1/mockup-preview
 * Dựng ảnh phối cảnh không gian nội thất phòng khách / bàn làm việc
 * lồng ghép tranh canvas tùy biến và phôi khung viền PNG.
 */
router.post('/mockup-preview', verifySecret, async (req, res) => {
    const startTime = Date.now();
    const payload = req.body || {};
    const clientIp = req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    try {
        if (!payload.artwork_base64) {
            renderLogger.logRender({
                type: 'mockup-preview',
                status: 'failed',
                context: payload.context || 'wall',
                orientation: payload.orientation || 'portrait',
                canvas_size_code: payload.canvas_size_code,
                client_ip: clientIp,
                duration_ms: Date.now() - startTime,
                payload,
                error_message: 'Thiếu tham số bắt buộc: artwork_base64'
            });
            return res.status(422).json({
                success: false,
                error: 'Thiếu tham số bắt buộc: artwork_base64'
            });
        }
        if (!payload.context) {
            payload.context = 'wall';
        }

        const roomMockupRenderer = require('../services/roomMockupRenderer');
        const result = await roomMockupRenderer.renderMockup(payload);

        const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
        result.public_mockup_url = `${baseUrl}${result.mockup_url}`;

        // Log successful preview to SQLite
        renderLogger.logRender({
            type: 'mockup-preview',
            status: 'success',
            context: payload.context,
            orientation: payload.orientation || 'portrait',
            canvas_size_code: payload.canvas_size_code,
            client_ip: clientIp,
            duration_ms: Date.now() - startTime,
            output_path: result.output_path,
            output_url: result.public_mockup_url,
            payload
        });

        return res.status(200).json({
            success: true,
            data: result
        });
    } catch (error) {
        console.error('[POD Backend] Lỗi render mockup phòng khách:', error);
        renderLogger.logRender({
            type: 'mockup-preview',
            status: 'failed',
            context: payload.context || 'wall',
            orientation: payload.orientation || 'portrait',
            canvas_size_code: payload.canvas_size_code,
            client_ip: clientIp,
            duration_ms: Date.now() - startTime,
            payload,
            error_message: error.message
        });
        return res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * GET /api/v1/render-logs
 * Xem nhật ký kiểm toán Render (Audit Logs) từ SQLite
 */
router.get('/render-logs', verifySecret, async (req, res) => {
    try {
        const { limit = 50, offset = 0, type, status } = req.query;
        const result = await renderLogger.getLogs({ limit, offset, type, status });
        const stats = await renderLogger.getStats();
        return res.status(200).json({
            success: true,
            stats,
            data: result
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

module.exports = router;

