# 💻 Codebase Reference: Core Implementations

This document bundles the complete, production-grade source code of the Telegram APK Pipeline. Upload this to NotebookLM so the model understands exactly how the code is structured and written.

---

## 1. Netlify Infrastructure Configuration (`netlify.toml`)
This configuration file instructs Netlify where the static frontend build lives and where to locate serverless functions.

```toml
[build]
  publish = "landing_page"
  functions = "netlify/functions"
```

---

## 2. Serverless Analytics Track Download (`netlify/functions/track-download.js`)
This serverless function intercepts the download, updates the persistent Netlify Blobs database, and pings the Telegram admin about the new download.

```javascript
const fetch = require('node-fetch');
const { getStore } = require('@netlify/blobs');

// Escapes characters that break Telegram's MarkdownV2
const escapeMarkdown = (text) => {
    return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
};

exports.handler = async (event, context) => {
    // 1. HARDENED AUTH: Validate the secret tracking key
    const apiKey = event.headers['x-api-key'];
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
        const targetIp = event.headers['x-forwarded-for'] || event.headers['client-ip'] || 'Unknown IP';
        const userAgent = event.headers['user-agent'] || 'Unknown Device';

        // 3. PERSISTENCE: Increment the Netlify Blob counter
        const store = getStore('analytics');
        let currentHits = parseInt(await store.get('total_downloads') || '0');
        currentHits += 1;
        await store.set('total_downloads', currentHits.toString());

        // 4. TELEMETRY PING: Send sanitized alert to Telegram
        const botToken = process.env.TELEGRAM_BOT_TOKEN;
        const adminId = process.env.ADMIN_TELEGRAM_ID;

        const message = `🔥 *NEW HIT: Payload Downloaded*\n\n` +
                        `👤 *Target IP:* \`${escapeMarkdown(targetIp)}\`\n` +
                        `📱 *Device:* \`${escapeMarkdown(userAgent.substring(0, 40))}...\`\n\n` +
                        `📊 *Total Downloads:* ${currentHits}`;

        const tgUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;
        
        // Fire-and-forget for production speed
        fetch(tgUrl, {
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
```

---

## 3. Serverless Analytics Stats Retrieval (`netlify/functions/get-stats.js`)
Exposes the total download count to external components.

```javascript
import { getStore } from "@netlify/blobs";

export default async (req, context) => {
  try {
    const store = getStore('analytics');
    const count = await store.get('total_downloads');
    
    return new Response(JSON.stringify({ 
      count: count === null ? 0 : parseInt(count, 10) 
    }), {
      status: 200,
      headers: { 
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*"
      }
    });
  } catch (error) {
    console.error("Error in get-stats:", error);
    return new Response(JSON.stringify({ count: 0, error: error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}

export const config = {
  path: "/get-stats"
};
```

---

## 4. Control Bot & Autonomous Healing Engine (`bot/bot.js`)
This is the core daemon that monitors GitHub Releases and processes uploads from Telegram.

```javascript
import { Telegraf } from 'telegraf';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import os from 'os';

dotenv.config();

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_ID = parseInt(process.env.ADMIN_TELEGRAM_ID || '0', 10);
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_OWNER = process.env.GITHUB_OWNER;
const GITHUB_REPO = process.env.GITHUB_REPO;
const LANDING_PAGE_URL = process.env.LANDING_PAGE_URL || 'https://indiastreamhub.netlify.app';

const BACKUP_DIR = path.join(os.homedir(), '.apk_backups');
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
const LATEST_BACKUP = path.join(BACKUP_DIR, 'latest_healer_backup.apk');

const bot = new Telegraf(BOT_TOKEN);

// Global Error Handlers to prevent process crashes
process.on('unhandledRejection', (reason, promise) => {
  console.error('🛡️ Guardian: Unhandled Rejection at:', promise, 'reason:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('🛡️ Guardian: Uncaught Exception:', err);
});

async function githubRequest(endpoint, options = {}) {
  const url = endpoint.startsWith('http') ? endpoint : `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}${endpoint}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `token ${GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github.v3+json',
      ...options.headers
    }
  });
  if (!res.ok && res.status !== 404) {
    const text = await res.text();
    throw new Error(`GitHub API Error: ${res.status} ${res.statusText} - ${text}`);
  }
  return res;
}

bot.start((ctx) => ctx.reply('Admin authenticated. Robust auto-healing bot online. Drop an .apk file. Type /stats to see downloads.'));

const TRACKING_SECRET = process.env.TRACKING_SECRET || "change_this_immediately";

const statsHandler = async (ctx) => {
  if (ctx.from.id !== ADMIN_ID && ADMIN_ID !== 0) return ctx.reply('Unauthorized.');
  
  try {
    const statsUrl = `${LANDING_PAGE_URL}/track-download?action=stats`;
    const res = await fetch(statsUrl, {
      headers: { 'x-api-key': TRACKING_SECRET }
    });
    if (!res.ok) throw new Error(`Failed to fetch stats: ${res.statusText}`);
    
    const data = await res.json();
    const count = data.count || 0;
    
    ctx.reply(`📊 *Download Statistics*\n\nTotal APK Downloads: \`${count}\`\n\n_Note: This data is synced from Netlify Blobs._`, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error('Stats Error:', err);
    ctx.reply('❌ Error: Could not retrieve download statistics. Make sure the landing page is online and the secret is correct.');
  }
};

bot.command('stats', statsHandler);
bot.command('howmany', statsHandler);

bot.on('document', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID && ADMIN_ID !== 0) return ctx.reply('Unauthorized.');
  
  const doc = ctx.message.document;
  if (!doc.file_name.endsWith('.apk')) return ctx.reply('Error: Please send an .apk file.');

  const waitMsg = await ctx.reply('📥 Downloading APK from Telegram to local cache...');
  const tmpFilePath = path.join(os.tmpdir(), `app_${Date.now()}.apk`);

  try {
    const fileUrl = await ctx.telegram.getFileLink(doc.file_id);
    const tgRes = await fetch(fileUrl);
    if (!tgRes.ok) throw new Error('Failed to download from Telegram');
    
    const fileStream = fs.createWriteStream(tmpFilePath);
    await new Promise((resolve, reject) => {
      tgRes.body.pipe(fileStream);
      tgRes.body.on('error', reject);
      fileStream.on('finish', resolve);
    });

    const stats = fs.statSync(tmpFilePath);

    await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, null, '🔍 Checking GitHub for existing rolling release...');

    const tagName = 'latest-rolling';
    let release;
    const getRelRes = await githubRequest(`/releases/tags/${tagName}`);
    
    if (getRelRes.status === 404) {
      await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, null, '📦 Creating new rolling release...');
      const createRelRes = await githubRequest(`/releases`, {
        method: 'POST',
        body: JSON.stringify({
          tag_name: tagName,
          name: 'Live Rolling Update',
          body: 'Auto-uploaded rolling release. Always serves the newest APK.',
          draft: false,
          prerelease: false
        })
      });
      release = await createRelRes.json();
    } else {
      release = await getRelRes.json();
      
      await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, null, '🧹 Cleaning up old assets and clearing cache...');
      for (const asset of release.assets) {
        if (asset.name === 'app.apk') {
          await githubRequest(`/releases/assets/${asset.id}`, { method: 'DELETE' });
        }
      }
    }

    await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, null, '🚀 Uploading new APK to GitHub CDN...');

    const uploadUrl = release.upload_url.replace('{?name,label}', '?name=app.apk');
    const assetRes = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        'Authorization': `token ${GITHUB_TOKEN}`,
        'Content-Type': 'application/vnd.android.package-archive',
        'Accept': 'application/vnd.github.v3+json',
        'Content-Length': stats.size.toString()
      },
      body: fs.createReadStream(tmpFilePath)
    });

    if (!assetRes.ok) {
      const errText = await assetRes.text();
      throw new Error(`Upload Failed: ${errText}`);
    }

    fs.copyFileSync(tmpFilePath, LATEST_BACKUP);

    const directLink = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/download/${tagName}/app.apk`;

    await ctx.telegram.editMessageText(
      ctx.chat.id, 
      waitMsg.message_id, 
      null, 
      `✅ **Update Complete!**\n\nThe old APK was destroyed and the new one is live. The system healed itself.\n\nPermanent Link:\n${directLink}`,
      { parse_mode: 'Markdown' }
    );

  } catch (error) {
    console.error(error);
    ctx.reply('❌ Error: ' + error.message);
  } finally {
    if (fs.existsSync(tmpFilePath)) {
      fs.unlinkSync(tmpFilePath);
    }
  }
});

// ─── LEVEL 3 GUARDIAN LAYER: AUTONOMOUS SELF-HEALING ────────────────
async function runGuardianCycle() {
  console.log('🛡️ Guardian: Starting health check cycle...');
  try {
    const tagName = 'latest-rolling';
    const relRes = await githubRequest(`/releases/tags/${tagName}`);
    
    let needsHeal = false;
    if (relRes.status === 404) {
      console.log('⚠️ Guardian: Rolling release GONE. GitHub probably nuked it. Healing...');
      needsHeal = true;
    } else {
      const release = await relRes.json();
      const hasAsset = release.assets.some(a => a.name === 'app.apk');
      if (!hasAsset) {
        console.log('⚠️ Guardian: Release exists but app.apk is MISSING. Healing...');
        needsHeal = true;
      }
    }

    if (needsHeal) {
      if (!fs.existsSync(LATEST_BACKUP)) {
        console.log('❌ Guardian Error: No local backup found to restore. Cannot heal.');
        if (ADMIN_ID !== 0) bot.telegram.sendMessage(ADMIN_ID, '🚨 **Critical:** Guardian failed to heal. No backup APK found.').catch(() => {});
      } else {
        console.log('🩹 Guardian: Restoring latest APK from backup...');
        let release;
        const getRelRes = await githubRequest(`/releases/tags/${tagName}`);
        if (getRelRes.status === 404) {
          const createRelRes = await githubRequest(`/releases`, {
            method: 'POST',
            body: JSON.stringify({
              tag_name: tagName, name: 'Live Rolling Update',
              body: 'Autonomous restoration by Guardian. Always serves the newest APK.',
              draft: false, prerelease: false
            })
          });
          release = await createRelRes.json();
        } else {
          release = await getRelRes.json();
          for (const asset of release.assets) {
            if (asset.name === 'app.apk') await githubRequest(`/releases/assets/${asset.id}`, { method: 'DELETE' });
          }
        }

        const stats = fs.statSync(LATEST_BACKUP);
        const uploadUrl = release.upload_url.replace('{?name,label}', '?name=app.apk');
        const assetRes = await fetch(uploadUrl, {
          method: 'POST',
          headers: {
            'Authorization': `token ${GITHUB_TOKEN}`,
            'Content-Type': 'application/vnd.android.package-archive',
            'Accept': 'application/vnd.github.v3+json',
            'Content-Length': stats.size.toString()
          },
          body: fs.createReadStream(LATEST_BACKUP)
        });

        if (assetRes.ok) {
          console.log('✅ Guardian: Successfully healed GitHub Release.');
          if (ADMIN_ID !== 0) bot.telegram.sendMessage(ADMIN_ID, '🛡️ **Guardian Action:** GitHub release was restored autonomously. Link is back live.').catch(() => {});
        } else {
          throw new Error('Guardian Restoration Failed: ' + await assetRes.text());
        }
      }
    }

    const netRes = await fetch(LANDING_PAGE_URL).catch(() => ({ ok: false }));
    if (!netRes.ok) {
      console.log('⚠️ Guardian: Landing page is DOWN or UNREACHABLE.');
      if (ADMIN_ID !== 0) bot.telegram.sendMessage(ADMIN_ID, `🚨 **Warning:** Landing page (${LANDING_PAGE_URL}) is down or returning an error.`).catch(() => {});
    }

  } catch (err) {
    console.error('❌ Guardian Cycle Error:', err.message);
  }
}

setInterval(runGuardianCycle, 5 * 60 * 1000);

console.log('🔍 Checking bot identity...');
bot.telegram.getMe().then(me => {
  console.log(`✅ Bot is online: @${me.username} (${me.id})`);
  runGuardianCycle();
  console.log('🚀 Attempting to launch Telegram bot...');
  bot.launch().then(() => {
    console.log('🤖 Auto-Healing Telegram Bot is running...');
    if (ADMIN_ID !== 0) {
      bot.telegram.sendMessage(ADMIN_ID, '🟢 System is running. Auto-healing bot online.').catch(err => {
          console.error('❌ Failed to send startup message:', err.message);
      });
    }
  }).catch(err => {
    console.error('❌ Failed to launch bot:', err);
    process.exit(1);
  });
}).catch(err => {
  console.error('❌ Failed to get bot identity. Check your token:', err.message);
  process.exit(1);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
```
