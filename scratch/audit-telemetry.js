// scratch/audit-telemetry.js
const https = require('https');
const fs = require('fs');
const path = require('path');

// 1. SIMPLE DOTENV PARSER
function loadDotenv(filePath) {
    if (!fs.existsSync(filePath)) return;
    const content = fs.readFileSync(filePath, 'utf8');
    content.split('\n').forEach(line => {
        const match = line.match(/^([^=]+)=(.*)$/);
        if (match) {
            const key = match[1].trim();
            let value = match[2].trim();
            if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
            process.env[key] = value;
        }
    });
}

loadDotenv('./bot/.env');

// 2. MOCK NETLIFY BLOBS
const blobsMock = {
    getStore: () => ({
        get: async () => '100',
        set: async (k, v) => console.log(`💾 [DB MOCK] Set ${k} to ${v}`)
    })
};

// 3. MINIMAL FETCH REPLACEMENT (using https)
const fetchMock = (url, options) => {
    return new Promise((resolve, reject) => {
        const req = https.request(url, options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => resolve({
                ok: res.statusCode >= 200 && res.statusCode < 300,
                status: res.statusCode,
                json: async () => JSON.parse(data)
            }));
        });
        req.on('error', reject);
        if (options.body) req.write(options.body);
        req.end();
    });
};

// 4. MODULE OVERRIDES
const Module = require('module');
const originalRequire = Module.prototype.require;
Module.prototype.require = function(id) {
    if (id === '@netlify/blobs') return blobsMock;
    if (id === 'node-fetch') return fetchMock;
    return originalRequire.apply(this, arguments);
};

// 5. LOAD HANDLER
const { handler } = require('../netlify/functions/track-download');

async function runLiveAudit() {
    console.log("🔍 Starting ZERO-DEPENDENCY LIVE Telemetry Audit...");
    console.log(`🤖 Bot Token: ${process.env.TELEGRAM_BOT_TOKEN ? 'LOADED' : 'MISSING'}`);
    console.log(`👤 Admin ID: ${process.env.ADMIN_TELEGRAM_ID ? 'LOADED' : 'MISSING'}`);

    if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.ADMIN_TELEGRAM_ID) {
        console.error("❌ ERROR: Missing credentials in ./bot/.env");
        process.exit(1);
    }

    process.env.TRACKING_SECRET = 'SUPER_SECRET_TRACKING_KEY_123';

    const mockEvent = {
        httpMethod: 'POST',
        headers: {
            'x-api-key': 'SUPER_SECRET_TRACKING_KEY_123',
            'x-forwarded-for': '127.0.0.1',
            'user-agent': 'Zero-Dep-Audit-Bot/1.0 (Live-Test!)'
        }
    };

    const result = await handler(mockEvent, {});
    console.log("\n🏁 Audit Result Status:", result.statusCode);
    console.log("🏁 Audit Result Body:", result.body);
    process.exit(0);
}

runLiveAudit().catch(err => {
    console.error("💥 AUDIT CRASHED:", err);
    process.exit(1);
});
