require('dotenv').config();
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const path = require('path');

const renderRouter = require('./routes/render');
const storageCleaner = require('./services/storageCleaner');
const licenseManager = require('./services/licenseManager');

const app = express();
const PORT = process.env.PORT || 3001;

// Middlewares
app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));
app.use(morgan('combined'));

// Protected Render Studio & QA Tool route (Must have valid domain license & secret)
app.get(['/', '/test', '/test-render', '/test-render.html'], async (req, res) => {
    const domain = req.query.domain || req.headers['x-pod-domain'] || 'pod.localhost';
    const providedSecret = req.query.secret || req.headers['x-pod-secret'] || '';

    const check = await licenseManager.verifyLicense(domain, providedSecret);
    if (!check.valid) {
        let reasonTitle = '403 Forbidden';
        let reasonDesc = check.error;
        if (check.error_code === 'LICENSE_EXPIRED') {
            reasonTitle = '403 License Expired';
            reasonDesc = `Domain <strong>${domain}</strong> có gói giấy phép đã hết hạn vào ngày <strong>${new Date(check.license?.expires_at || '').toLocaleDateString()}</strong>.<br><br>Vui lòng gia hạn bản quyền để tiếp tục sử dụng Render Studio và hệ thống Render POD.`;
        } else if (check.error_code === 'DOMAIN_UNREGISTERED') {
            reasonTitle = '403 Domain Chưa Đăng Ký';
            reasonDesc = `Domain <strong>${domain}</strong> chưa được đăng ký trong hệ thống bản quyền Render.<br><br>Vui lòng kiểm tra lại cấu hình domain hoặc liên hệ quản trị viên.`;
        } else if (check.error_code === 'INVALID_SECRET' || check.error_code === 'MISSING_SECRET') {
            reasonTitle = '401 Unauthorized';
            reasonDesc = `Secret token không hợp lệ hoặc bị thiếu. Vui lòng mở công cụ này từ nút liên kết trong <strong>WordPress Admin &gt; Settings &gt; POD Customizer</strong>.`;
        }

        return res.status(check.status || 403).send(`
<!DOCTYPE html>
<html lang="vi">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${reasonTitle} - POD Render Studio</title>
    <style>
        body {
            background: #0b0f19;
            color: #f1f5f9;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            display: flex;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            margin: 0;
            padding: 20px;
            box-sizing: border-box;
        }
        .box {
            background: #1e293b;
            border: 1px solid rgba(255,255,255,0.1);
            border-radius: 16px;
            padding: 40px 32px;
            max-width: 480px;
            text-align: center;
            box-shadow: 0 20px 40px rgba(0,0,0,0.5);
        }
        .icon { font-size: 48px; margin-bottom: 16px; }
        h1 { font-size: 22px; margin: 0 0 12px; color: #f87171; font-weight: 700; }
        p { font-size: 14px; color: #94a3b8; line-height: 1.6; margin: 0 0 28px; }
        a.btn {
            background: #4f46e5;
            color: #fff;
            padding: 12px 24px;
            border-radius: 8px;
            text-decoration: none;
            font-weight: 600;
            font-size: 14px;
            display: inline-block;
            transition: background 0.2s;
        }
        a.btn:hover { background: #4338ca; }
    </style>
</head>
<body>
    <div class="box">
        <div class="icon">⛔</div>
        <h1>${reasonTitle}</h1>
        <p>${reasonDesc}</p>
        <a class="btn" href="http://${domain}/wp-admin/options-general.php?page=pod-customizer-settings">Về trang Cài đặt WordPress ↗</a>
    </div>
</body>
</html>
        `);
    }

    res.sendFile(path.join(__dirname, 'public', 'test-render.html'));
});

// Static serving for generated print files
const printsDir = process.env.OUTPUT_DIR || path.join(__dirname, '../storage/prints');
app.use('/prints', express.static(printsDir));
app.use(express.static(path.join(__dirname, 'public')));

// Health check and Live Connection Diagnostics
app.get('/health', async (req, res) => {
    try {
        const domain = req.headers['x-pod-domain'] || req.query.domain || 'pod.localhost';
        const secret = req.headers['x-pod-secret'] || req.query.secret || '';
        const licenseInfo = await licenseManager.getLicenseDiagnostics(domain, secret);

        // Crucial requirement: Test Connection ALWAYS returns HTTP 200 regardless of expiration
        res.status(200).json({
            status: 'healthy',
            service: 'pod-backend-render-engine',
            timestamp: new Date().toISOString(),
            license: licenseInfo
        });
    } catch (err) {
        console.error('[POD Backend] Health check error:', err);
        res.status(200).json({
            status: 'healthy',
            service: 'pod-backend-render-engine',
            timestamp: new Date().toISOString(),
            license: {
                found: false,
                domain: req.headers['x-pod-domain'] || 'unknown',
                secret_valid: false,
                status: 'error',
                starts_at: null,
                expires_at: null,
                days_remaining: 0,
                is_expired: true,
                message: 'License check error: ' + err.message
            }
        });
    }
});

// API Routes
const templatesRouter = require('./routes/templates');
app.use('/api/v1', renderRouter);
app.use('/api/templates', templatesRouter);

// Start server
app.listen(PORT, '0.0.0.0', async () => {
    console.log(`[POD Backend] Render engine listening on http://0.0.0.0:${PORT}`);
    // Initialize SQLite License Manager
    try {
        await licenseManager.getDb();
    } catch (dbErr) {
        console.error('[POD Backend] Failed to initialize License Database:', dbErr);
    }
    // Start automatic storage cleaner worker (runs every 30 minutes, deletes test & expired files)
    storageCleaner.startScheduledCleanup(30);
});
