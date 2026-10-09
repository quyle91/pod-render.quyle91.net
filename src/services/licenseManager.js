const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

let dbInstance = null;
let SQL = null;
let lastDbMtimeMs = 0;
const dbPath = process.env.LICENSE_DB_PATH || path.join(__dirname, '../../storage/licenses.sqlite');

/**
 * Normalize domain string by stripping protocol, port, and trailing slashes.
 */
function normalizeDomain(rawDomain) {
    if (!rawDomain || typeof rawDomain !== 'string') return '';
    let domain = rawDomain.trim().toLowerCase();
    domain = domain.replace(/^https?:\/\//, '');
    domain = domain.split('/')[0];
    domain = domain.split(':')[0];
    return domain;
}

/**
 * Synchronize in-memory SQLite DB state to physical disk file.
 */
function persistDb() {
    if (!dbInstance) return;
    try {
        fs.mkdirSync(path.dirname(dbPath), { recursive: true });
        const binaryArray = dbInstance.export();
        fs.writeFileSync(dbPath, Buffer.from(binaryArray));
        if (fs.existsSync(dbPath)) {
            lastDbMtimeMs = fs.statSync(dbPath).mtimeMs;
        }
    } catch (err) {
        console.error('[POD Backend LicenseManager] Failed to persist SQLite DB:', err.message);
    }
}

/**
 * Initialize SQLite Database connection, schema, and initial seed.
 */
async function getDb() {
    if (!SQL) {
        SQL = await initSqlJs();
    }

    let fileMtime = 0;
    if (fs.existsSync(dbPath)) {
        try {
            fileMtime = fs.statSync(dbPath).mtimeMs;
        } catch (e) {
            fileMtime = 0;
        }
    }

    if (dbInstance && fileMtime > 0 && fileMtime <= lastDbMtimeMs) {
        return dbInstance;
    }

    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    if (fs.existsSync(dbPath)) {
        try {
            const fileBuffer = fs.readFileSync(dbPath);
            dbInstance = new SQL.Database(fileBuffer);
            lastDbMtimeMs = fileMtime;
        } catch (err) {
            console.warn('[POD Backend LicenseManager] Corrupted or empty sqlite file, creating fresh DB:', err.message);
            dbInstance = new SQL.Database();
            lastDbMtimeMs = Date.now();
        }
    } else {
        dbInstance = new SQL.Database();
        lastDbMtimeMs = Date.now();
    }

    // Create schema
    dbInstance.run(`
        CREATE TABLE IF NOT EXISTS licenses (
            domain TEXT PRIMARY KEY,
            secret_token TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'active',
            starts_at TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
    `);

    // Ensure default license exists for 'pod.localhost'
    const defaultDomain = 'pod.localhost';
    const stmt = dbInstance.prepare('SELECT domain FROM licenses WHERE domain = :domain');
    stmt.bind({ ':domain': defaultDomain });
    const exists = stmt.step();
    stmt.free();

    if (!exists) {
        const now = new Date();
        const oneYearLater = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);
        const secret = process.env.SHARED_SECRET || 'pod_secret_token_123456';

        const insertStmt = dbInstance.prepare(`
            INSERT INTO licenses (domain, secret_token, status, starts_at, expires_at, created_at, updated_at)
            VALUES (:domain, :secret, 'active', :starts_at, :expires_at, :created_at, :updated_at)
        `);
        insertStmt.run({
            ':domain': defaultDomain,
            ':secret': secret,
            ':starts_at': now.toISOString(),
            ':expires_at': oneYearLater.toISOString(),
            ':created_at': now.toISOString(),
            ':updated_at': now.toISOString(),
        });
        insertStmt.free();
        persistDb();
        console.log(`[POD Backend LicenseManager] Initialized default license for ${defaultDomain} (Expires: ${oneYearLater.toISOString()})`);
    }

    return dbInstance;
}

/**
 * Retrieve license record for domain.
 */
async function getLicense(rawDomain) {
    const db = await getDb();
    const domain = normalizeDomain(rawDomain);
    if (!domain) return null;

    const stmt = db.prepare('SELECT * FROM licenses WHERE domain = :domain');
    stmt.bind({ ':domain': domain });
    if (stmt.step()) {
        const row = stmt.getAsObject();
        stmt.free();
        return row;
    }
    stmt.free();
    return null;
}

/**
 * Calculate remaining days until expiration.
 */
function calculateDaysRemaining(expiresAtStr) {
    try {
        const now = new Date();
        const exp = new Date(expiresAtStr);
        const diffMs = exp.getTime() - now.getTime();
        if (diffMs <= 0) return 0;
        return Math.ceil(diffMs / (1000 * 60 * 60 * 24));
    } catch {
        return 0;
    }
}

/**
 * Diagnostics check for Test Connection (non-blocking, detailed info).
 */
async function getLicenseDiagnostics(rawDomain, providedSecret) {
    const domain = normalizeDomain(rawDomain);
    const license = await getLicense(domain);

    if (!license) {
        return {
            found: false,
            domain: domain || rawDomain,
            secret_valid: false,
            status: 'unregistered',
            starts_at: null,
            expires_at: null,
            days_remaining: 0,
            is_expired: true,
            message: `Domain "${domain || rawDomain}" is not registered in the license database.`
        };
    }

    const secretMatches = Boolean(providedSecret && providedSecret === license.secret_token);
    const daysRemaining = calculateDaysRemaining(license.expires_at);
    const now = new Date();
    const expDate = new Date(license.expires_at);
    const isExpired = now >= expDate || license.status === 'expired';

    let currentStatus = license.status;
    if (isExpired && currentStatus === 'active') {
        currentStatus = 'expired';
    }

    let message = 'License is valid and active.';
    if (!secretMatches) {
        message = 'Secret token does not match registered domain license.';
    } else if (isExpired) {
        message = `License has expired on ${expDate.toLocaleDateString()}.`;
    } else if (currentStatus !== 'active') {
        message = `License is currently ${currentStatus}.`;
    }

    return {
        found: true,
        domain: license.domain,
        license_key: secretMatches ? license.secret_token : (providedSecret || null),
        secret_valid: secretMatches,
        status: currentStatus,
        starts_at: license.starts_at,
        expires_at: license.expires_at,
        days_remaining: daysRemaining,
        is_expired: isExpired,
        message: message
    };
}

/**
 * Strict verification for functional APIs (/render, /test-render, etc.).
 */
async function verifyLicense(rawDomain, providedSecret) {
    const domain = normalizeDomain(rawDomain);
    if (!domain) {
        return {
            valid: false,
            status: 400,
            error_code: 'MISSING_DOMAIN',
            error: 'Missing domain identification (X-POD-DOMAIN header or domain parameter required).'
        };
    }

    if (!providedSecret) {
        return {
            valid: false,
            status: 401,
            error_code: 'MISSING_SECRET',
            error: 'Unauthorized: Missing secret token (X-POD-SECRET header required).'
        };
    }

    const license = await getLicense(domain);
    if (!license) {
        return {
            valid: false,
            status: 403,
            error_code: 'DOMAIN_UNREGISTERED',
            error: `Domain "${domain}" is not authorized or registered on this render server.`
        };
    }

    if (providedSecret !== license.secret_token) {
        return {
            valid: false,
            status: 401,
            error_code: 'INVALID_SECRET',
            error: 'Unauthorized: Secret token does not match domain license.'
        };
    }

    const now = new Date();
    const expDate = new Date(license.expires_at);
    if (now >= expDate || license.status === 'expired') {
        return {
            valid: false,
            status: 403,
            error_code: 'LICENSE_EXPIRED',
            license: license,
            error: `License for domain "${domain}" expired on ${license.expires_at}. Service suspended.`
        };
    }

    if (license.status !== 'active') {
        return {
            valid: false,
            status: 403,
            error_code: 'LICENSE_INACTIVE',
            license: license,
            error: `License for domain "${domain}" is currently ${license.status}.`
        };
    }

    return {
        valid: true,
        license: license
    };
}

/**
 * Upsert or update a license (for admin / management).
 */
async function upsertLicense({ domain, secret_token, status = 'active', starts_at, expires_at }) {
    const db = await getDb();
    const normDomain = normalizeDomain(domain);
    const nowIso = new Date().toISOString();

    const stmt = db.prepare(`
        INSERT INTO licenses (domain, secret_token, status, starts_at, expires_at, created_at, updated_at)
        VALUES (:domain, :secret, :status, :starts_at, :expires_at, :created_at, :updated_at)
        ON CONFLICT(domain) DO UPDATE SET
            secret_token = excluded.secret_token,
            status = excluded.status,
            starts_at = excluded.starts_at,
            expires_at = excluded.expires_at,
            updated_at = excluded.updated_at
    `);

    stmt.run({
        ':domain': normDomain,
        ':secret': secret_token,
        ':status': status,
        ':starts_at': starts_at || nowIso,
        ':expires_at': expires_at,
        ':created_at': nowIso,
        ':updated_at': nowIso
    });
    stmt.free();
    persistDb();

    return getLicense(normDomain);
}

module.exports = {
    getDb,
    getLicense,
    getLicenseDiagnostics,
    verifyLicense,
    upsertLicense,
    normalizeDomain,
    calculateDaysRemaining
};
