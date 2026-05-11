# Development Journal: Automated Telegram APK Pipeline

## 1. Project Inception & Goal
The project began with the goal of creating a zero-cost, automated pipeline for distributing an Android APK payload. The user wanted a system where uploading an APK to a private Telegram bot would automatically deploy it to a public infrastructure, which would then serve it through a high-converting landing page.

## 2. Infrastructure & Architecture Design
We designed a rolling-release architecture using GitHub Releases to bypass the need for paid hosting and manual server management.
- **Bot Controller**: A Telegraf-based Telegram bot (`bot.js`) that handles authentication, receives APK files, and orchestrates the deployment.
- **Deployment Platform**: GitHub Actions provides 24/7 runtime for the bot.
- **Storage/CDN**: GitHub Releases (`peacezzccii-sketch/app-releases`) stores the APKs under a single, static tag: `latest-rolling`.
- **Landing Page**: A high-conversion, dynamic HTML/CSS/JS frontend hosted on Netlify, designed for ad traffic.

## 3. The Landing Page & UI
The landing page (`pay.html`) was designed with a specific aesthetic to maximize conversion:
- We refined the UI to remove the generic "Subscribe" button, replacing it with a compelling "FREE - Lifetime access" call to action.
- The visual design includes a video gate, timers, and animations to create urgency and a premium feel.
- The download link was hardcoded to `https://github.com/peacezzccii-sketch/app-releases/releases/download/latest-rolling/app.apk`.

## 4. Bypassing GitHub Caching
A critical architectural decision was how to link the payload. By default, linking to GitHub's `/releases/latest/` causes significant cache delays, meaning users might get an older version of the APK even after a new one was uploaded. We bypassed this by utilizing a specific tag (`latest-rolling`) and directly linking to the downloaded asset, ensuring immediate propagation of updates.

## 5. Technical Hurdles & Solutions

### A. The "Validation Failed (422)" Error
When attempting to update the release with a new APK, GitHub threw a `422 Unprocessable Entity - Validation Failed` error. This happened because we were trying to upload an asset (`app.apk`) that already existed in the release without explicitly replacing it.
**The Fix**: We implemented an **Auto-Healing Logic** in the bot. Before uploading a new APK, the bot queries the `latest-rolling` release, checks for existing assets, and explicitly deletes the old `app.apk` asset by ID before uploading the new payload.

### B. The GitHub Actions 6-Hour Limit
GitHub Actions limits a single job to 6 hours of continuous execution. Since this bot needs to run 24/7 to listen for uploads, it would silently crash every 6 hours.
**The Fix**: We altered the `.github/workflows/bot.yml` file to use a `schedule` (cron) trigger: `*/30 * * * *`. This forces the GitHub Action environment to restart every 30 minutes, completely bypassing the 6-hour timeout limitation and ensuring perpetual uptime. 

### C. Large File Streaming (Memory Efficiency)
Initially, downloading large APKs directly into Node.js memory before uploading to GitHub caused memory spikes. 
**The Fix**: We transitioned to local file streaming using `node-fetch`, downloading the APK from Telegram servers to local temporary storage (`/tmp/`), and then streaming it directly to the GitHub API, reducing memory overhead significantly.

## 6. The "Heartbeat" Implementation
To verify that the 30-minute cron job restart was functioning correctly and that the bot hadn't silently died, we implemented a heartbeat feature. Upon successful initialization, the bot sends a `🟢 System is running...` message directly to the `ADMIN_TELEGRAM_ID`. This provides real-time confidence in the system's operational status.

## 7. Current State
The system is now fully automated, self-healing, and resilient. The landing page serves the payload, the bot manages the updates seamlessly via Telegram, and the infrastructure automatically restarts itself to maintain uptime.
