const fetch = require('node-fetch');
const { getStore } = require('@netlify/blobs');

// Escapes characters that break Telegram's MarkdownV2
const escapeMarkdown = (text) => {
    return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
};

// Escapes only backslashes and backticks inside MarkdownV2 inline code blocks
const escapeCodeBlock = (text) => {
    return text.replace(/[\`\\]/g, '\\$&');
};

exports.handler = async (event, context) => {
    // 1. HARDENED AUTH: Validate the secret tracking key
    const headers = event.headers || {};
    const apiKey = headers['x-api-key'] || headers['X-API-Key'] || headers['x-api-key'.toLowerCase()];
    if (apiKey !== process.env.TRACKING_SECRET) {
        return { statusCode: 401, body: 'Unauthorized' };
    }

    // 2. STATS ROUTE: Quick read for the bot's /stats command
    if (event.httpMethod === 'GET' && event.queryStringParameters && event.queryStringParameters.action === 'stats') {
        try {
            const store = getStore('analytics');
            const currentHits = await store.get('total_downloads') || '0';
            return { statusCode: 200, body: JSON.stringify({ hits: parseInt(currentHits), count: parseInt(currentHits) }) };
        } catch (err) {
            return { statusCode: 500, body: JSON.stringify({ error: 'DB Read Failed' }) };
        }
    }

    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    try {
        const targetIp = headers['x-forwarded-for'] || headers['client-ip'] || 'Unknown IP';
        const userAgent = headers['user-agent'] || 'Unknown Device';

        // 3. PERSISTENCE: Increment the Netlify Blob counter
        const store = getStore('analytics');
        let currentHits = parseInt(await store.get('total_downloads') || '0');
        currentHits += 1;
        await store.set('total_downloads', currentHits.toString());

        // 4. TELEMETRY PING: Send sanitized alert to Telegram
        const botToken = process.env.TELEGRAM_BOT_TOKEN;
        const adminId = process.env.ADMIN_TELEGRAM_ID;

        const message = `🔥 *NEW HIT: Payload Downloaded*\n\n` +
                        `👤 *Target IP:* \`${escapeCodeBlock(targetIp)}\`\n` +
                        `📱 *Device:* \`${escapeCodeBlock(userAgent.substring(0, 40))}...\`\n\n` +
                        `📊 *Total Downloads:* ${currentHits}`;

        const tgUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;
        
        // Await the promise to ensure the lambda container doesn't terminate before the fetch finishes
        await fetch(tgUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: adminId,
                text: message,
                parse_mode: 'MarkdownV2'
            })
        }).catch(err => console.error("[TELEMETRY] Telegram ping failed:", err));

        return { 
            statusCode: 200, 
            body: JSON.stringify({ status: 'tracked', currentHits, count: currentHits, hits: currentHits }) 
        };

    } catch (err) {
        console.error("[ERROR] Tracker failed:", err);
        return { statusCode: 500, body: 'Internal Server Error' };
    }
};
