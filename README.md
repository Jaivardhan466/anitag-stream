# AniTAG Streaming Engine

Production-ready cross-platform streaming application powered by CloudStream multi-provider streaming architecture and almost anitag UI.

## Features
- **Almost AniTAG Glassmorphic UI**: Pastel mood switcher, Liquid Volume Capsule, segmented timeline, 100-episode chunks.
- **CloudStream Engine**: Multi-provider direct HLS stream extraction (Anikoto, AnimeGG, AniBD, 2DHiVE, Mkissa, Reanime, AllAnime).
- **Zero Ads & Zero Popups**: Server-side stream proxy with strict adblocker and request sanitizer.
- **Google Account Cloud Sync**: Live sync over native RFC-6455 WebSockets (<50ms latency).
- **Cross-Platform**: Deployable on Web (Render / Node.js), Windows Desktop (Electron), and Android Mobile (Native APK).

## Deployment on Render
1. Create a new Web Service on [Render](https://dashboard.render.com/).
2. Connect your GitHub repository.
3. Configure settings:
   - **Environment**: Node
   - **Build Command**: `npm install --omit=dev`
   - **Start Command**: `npm start`
4. Or use the included `render.yaml` Blueprint for automatic deployment.
