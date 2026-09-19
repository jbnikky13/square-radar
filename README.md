# SquareRadar

A daily research assistant for Binance Square content.

It chooses the day's editorial series, pulls current public crypto stories, scores and deduplicates them, creates a research pack, and optionally sends it to Telegram.

It intentionally does NOT auto-publish. Review sources and rewrite in your own voice before posting.

## Schedule
Monday — 🔎 Crypto Investigation
Tuesday — 🧪 I Tested It
Wednesday — 🌍 Africa Crypto Lens
Thursday — 🧠 Crypto Nobody Explained Properly
Friday — 👀 What I'm Watching
Saturday — 💰 $10 Experiment
Sunday — 📊 5 Things I Learned This Week

## Setup
Add GitHub Actions secrets:
- TELEGRAM_BOT_TOKEN
- TELEGRAM_CHAT_ID

The workflow runs daily at 08:30 UTC (09:30 WAT) and supports manual runs.

## Local
npm start
