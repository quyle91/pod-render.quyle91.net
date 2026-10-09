const licenseManager = require('../services/licenseManager');

/**
 * Basic secret token verification (backward compatibility).
 */
function verifySecret(req, res, next) {
    const secret = req.headers['x-pod-secret'] || req.query.secret || (req.body && req.body.secret);
    const expectedSecret = process.env.SHARED_SECRET || 'pod_secret_token_123456';

    if (!secret || secret !== expectedSecret) {
        return res.status(401).json({
            success: false,
            error: 'Unauthorized: Invalid or missing secret token (X-POD-SECRET)'
        });
    }

    next();
}

/**
 * Strict License & Domain Gatekeeper middleware.
 * Verifies that the incoming request has a registered, active, unexpired license.
 */
async function verifyLicense(req, res, next) {
    try {
        const domain = req.headers['x-pod-domain']
            || (req.body && (req.body.domain_name || req.body.domain))
            || req.query.domain
            || 'pod.localhost';

        const secret = req.headers['x-pod-secret']
            || req.query.secret
            || (req.body && (req.body.secret || req.body.shared_secret));

        const result = await licenseManager.verifyLicense(domain, secret);

        if (!result.valid) {
            return res.status(result.status || 403).json({
                success: false,
                error_code: result.error_code,
                error: result.error
            });
        }

        req.license = result.license;
        next();
    } catch (err) {
        console.error('[POD Auth Middleware] License verification error:', err);
        return res.status(500).json({
            success: false,
            error: 'Internal license verification error: ' + err.message
        });
    }
}

module.exports = {
    verifySecret,
    verifyLicense
};
