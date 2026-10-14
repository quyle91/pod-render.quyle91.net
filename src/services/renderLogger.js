const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

let dbInstance = null;
let SQL = null;
let lastDbMtimeMs = 0;
const dbPath = process.env.RENDER_LOGS_DB_PATH || path.join(__dirname, '../../storage/render_logs.sqlite');

/**
 * Persist in-memory SQLite DB state to disk
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
        console.error('[POD RenderLogger] Failed to persist SQLite DB:', err.message);
    }
}

/**
 * Initialize or get SQLite Database instance
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
            console.warn('[POD RenderLogger] Corrupted or empty sqlite file, creating fresh DB:', err.message);
            dbInstance = new SQL.Database();
            lastDbMtimeMs = Date.now();
        }
    } else {
        dbInstance = new SQL.Database();
        lastDbMtimeMs = Date.now();
    }

    // Initialize Schema
    dbInstance.run(`
        CREATE TABLE IF NOT EXISTS render_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            type TEXT NOT NULL,
            status TEXT NOT NULL,
            context TEXT,
            orientation TEXT,
            canvas_size_code TEXT,
            order_id TEXT,
            item_id TEXT,
            client_ip TEXT,
            duration_ms INTEGER,
            output_path TEXT,
            output_url TEXT,
            payload_summary TEXT,
            error_message TEXT,
            created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_render_logs_type ON render_logs(type);
        CREATE INDEX IF NOT EXISTS idx_render_logs_status ON render_logs(status);
        CREATE INDEX IF NOT EXISTS idx_render_logs_created_at ON render_logs(created_at);
    `);

    persistDb();
    return dbInstance;
}

/**
 * Extract clean, sanitized summary of payload without gigantic base64 payloads
 */
function sanitizePayload(type, payload = {}) {
    try {
        const summary = { ...payload };
        if (summary.artwork_base64) {
            summary.artwork_base64 = `[Base64 Data ~${Math.round(summary.artwork_base64.length / 1024)} KB]`;
        }
        if (summary.layers && Array.isArray(summary.layers)) {
            summary.layers_count = summary.layers.length;
            summary.layer_types = summary.layers.map(l => l.type || 'unknown');
            delete summary.layers;
        }
        return JSON.stringify(summary);
    } catch (e) {
        return '{}';
    }
}

/**
 * Record a render log entry
 */
async function logRender({
    type = 'mockup-preview',
    status = 'success',
    context = null,
    orientation = null,
    canvas_size_code = null,
    order_id = null,
    item_id = null,
    client_ip = null,
    duration_ms = 0,
    output_path = null,
    output_url = null,
    payload = {},
    error_message = null
}) {
    try {
        const db = await getDb();
        const payloadSummary = sanitizePayload(type, payload);
        const createdAt = new Date().toISOString();

        db.run(
            `INSERT INTO render_logs (
                type, status, context, orientation, canvas_size_code,
                order_id, item_id, client_ip, duration_ms,
                output_path, output_url, payload_summary, error_message, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                type,
                status,
                context,
                orientation,
                canvas_size_code,
                order_id ? String(order_id) : null,
                item_id ? String(item_id) : null,
                client_ip,
                duration_ms,
                output_path,
                output_url,
                payloadSummary,
                error_message,
                createdAt
            ]
        );

        persistDb();
    } catch (err) {
        console.error('[POD RenderLogger] Failed to insert render log:', err.message);
    }
}

/**
 * Query render logs with pagination and filters
 */
async function getLogs({ limit = 50, offset = 0, type = null, status = null } = {}) {
    try {
        const db = await getDb();
        let query = 'SELECT * FROM render_logs';
        const conditions = [];
        const params = [];

        if (type) {
            conditions.push('type = ?');
            params.push(type);
        }
        if (status) {
            conditions.push('status = ?');
            params.push(status);
        }

        if (conditions.length > 0) {
            query += ' WHERE ' + conditions.join(' AND ');
        }

        query += ' ORDER BY id DESC LIMIT ? OFFSET ?';
        params.push(Math.min(Number(limit) || 50, 200));
        params.push(Math.max(Number(offset) || 0, 0));

        const stmt = db.prepare(query);
        stmt.bind(params);

        const logs = [];
        while (stmt.step()) {
            logs.push(stmt.getAsObject());
        }
        stmt.free();

        // Get total count
        let countQuery = 'SELECT COUNT(*) as total FROM render_logs';
        const countParams = [];
        if (conditions.length > 0) {
            countQuery += ' WHERE ' + conditions.join(' AND ');
            if (type) countParams.push(type);
            if (status) countParams.push(status);
        }
        const countStmt = db.prepare(countQuery);
        countStmt.bind(countParams);
        countStmt.step();
        const total = countStmt.getAsObject().total || 0;
        countStmt.free();

        return { total, limit, offset, logs };
    } catch (err) {
        console.error('[POD RenderLogger] Failed to query render logs:', err.message);
        return { total: 0, limit, offset, logs: [], error: err.message };
    }
}

/**
 * Get summary statistics for dashboard / diagnostics
 */
async function getStats() {
    try {
        const db = await getDb();
        const stmt = db.prepare(`
            SELECT 
                COUNT(*) as total_requests,
                SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as successful_requests,
                SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed_requests,
                AVG(duration_ms) as avg_duration_ms
            FROM render_logs
        `);
        stmt.step();
        const stats = stmt.getAsObject();
        stmt.free();

        return {
            total_requests: stats.total_requests || 0,
            successful_requests: stats.successful_requests || 0,
            failed_requests: stats.failed_requests || 0,
            avg_duration_ms: Math.round(stats.avg_duration_ms || 0)
        };
    } catch (err) {
        return { total_requests: 0, successful_requests: 0, failed_requests: 0, avg_duration_ms: 0 };
    }
}

module.exports = {
    getDb,
    logRender,
    getLogs,
    getStats
};
