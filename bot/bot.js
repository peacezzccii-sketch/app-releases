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
    // 1. Download from Telegram to Local Storage (Reliable & prevents stream errors)
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

    // 2. Setup the "Rolling" Release
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
      
      // 3. Auto-healing: Delete old assets to prevent "Validation Failed"
      await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, null, '🧹 Cleaning up old assets and clearing cache...');
      for (const asset of release.assets) {
        if (asset.name === 'app.apk') {
          await githubRequest(`/releases/assets/${asset.id}`, { method: 'DELETE' });
        }
      }
    }

    await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, null, '🚀 Uploading new APK to GitHub CDN...');

    // 4. Upload the new asset
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

    // 5. Level 3 Healing: Save a local persistent backup for autonomous restoration
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
    // 5. Cleanup local temp file
    if (fs.existsSync(tmpFilePath)) {
      fs.unlinkSync(tmpFilePath);
    }
  }
});

// ─── LEVEL 3 GUARDIAN LAYER: AUTONOMOUS SELF-HEALING ────────────────
async function runGuardianCycle() {
  console.log('🛡️ Guardian: Starting health check cycle...');
  try {
    // Check GitHub Release Asset
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

// Run Guardian every 5 minutes
setInterval(runGuardianCycle, 5 * 60 * 1000);

console.log('🔍 Checking bot identity...');
bot.telegram.getMe().then(me => {
  console.log(`✅ Bot is online: @${me.username} (${me.id})`);
  
  // Run Guardian immediately on startup
  runGuardianCycle();
  
  console.log('🚀 Attempting to launch Telegram bot...');

  bot.launch().then(() => {
    console.log('🤖 Auto-Healing Telegram Bot is running...');
    if (ADMIN_ID !== 0) {
      console.log(`📩 Sending startup message to admin (${ADMIN_ID})...`);
      bot.telegram.sendMessage(ADMIN_ID, '🟢 System is running. Auto-healing bot online.').then(() => {
          console.log('✅ Startup message sent.');
      }).catch(err => {
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
