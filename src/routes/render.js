const express = require('express');
const router = express.Router();
const sharpRenderer = require('../services/sharpRenderer');
const { verifySecret, verifyLicense } = require('../middleware/auth');
const axios = require('axios');

/**
 * POST /api/v1/render
 * Initiates render task for a custom order item.
 */
router.post('/render', verifyLicense, async (req, res) => {
    try {
        const payload = req.body;
        if (!payload || !payload.order_id) {
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

        // If a callback URL is provided, notify WordPress asynchronously
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
                // If WordPress confirmed storing files locally, delete temporary files on the render worker
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
                console.error('[POD Backend] Failed to dispatch webhook callback to WordPress:', err.message);
            });
        }

        return res.status(200).json({
            success: true,
            data: renderResult
        });
    } catch (error) {
        console.error('[POD Backend] Error during render:', error);
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
                const wpUrl = process.env.WP_URL || 'http://pod.localhost';
                const wpRes = await axios.get(`${wpUrl}/wp-json/pod-customizer/v1/order-state/${orderId}`, {
                    headers: { 'X-POD-SECRET': process.env.SHARED_SECRET || 'pod_secret_token_123456' },
                    timeout: 8000
                });
                if (wpRes.data && wpRes.data.success && wpRes.data.data && wpRes.data.data.length > 0) {
                    const itemData = wpRes.data.data[0];
                    payload.order_id = itemData.order_id;
                    payload.item_id = itemData.item_id;
                    payload.product_name = payload.product_name || itemData.product_name;
                    payload.recipient_name = payload.recipient_name || itemData.recipient_name;
                    payload.preview_url = itemData.preview_url;
                    canvasState = itemData.canvas_state;
                }
            } catch (wpErr) {
                console.warn(`[POD Backend] Could not query WP for order #${orderId}:`, wpErr.message);
                return res.status(404).json({
                    success: false,
                    error: `Order #${orderId} could not be retrieved: ` + (wpErr.response?.data?.error || wpErr.message)
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
 * POST /api/v1/cleanup
 * Manually trigger storage garbage collection. Protected by verifySecret.
 */
router.post('/cleanup', verifySecret, async (req, res) => {
    try {
        const storageCleaner = require('../services/storageCleaner');
        const stats = await storageCleaner.runCleanup();
        return res.status(200).json({
            success: true,
            data: stats
        });
    } catch (err) {
        return res.status(500).json({
            success: false,
            error: err.message
        });
    }
});

module.exports = router;

