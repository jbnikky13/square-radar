# SquareRadar

SquareRadar is an automated crypto-news research and publishing engine for Binance Square.

It runs three times a day, pulls fresh public crypto stories from multiple RSS/news feeds, removes duplicate feed items, checks stories against recent published history, selects a sufficiently novel story, turns it into a conversational post, tags the related token, publishes to Binance Square, and sends the result to Telegram.

## What SquareRadar is designed to sound like

The goal is **not** to make every post look like a rigid news template or a "$10 experiment."

Posts should feel like one crypto-aware person telling friends about something interesting they just discovered:

- conversational and natural
- based on a current, verifiable story
- built around one interesting fact or development
- explains why the detail is worth noticing
- ends with a genuine conversation prompt
- uses a relevant token tag such as `$BTC`, `$ETH`, `$SOL`, `$ZEC`, etc.
- never invents a token tag when the story cannot be linked to an identifiable token
- avoids unnecessary predictions or forced investment advice

The "$10 Experiment" is no longer the default writing format. It remains only as one of the scheduled editorial themes.

## Editorial schedule

SquareRadar publishes **three posts per day, Monday–Saturday**:

| Day | Morning | Afternoon | Evening |
|---|---|---|---|
| Monday | 🔎 Crypto Investigation | 🔥 What's Changing | 👀 Open Question |
| Tuesday | 🧪 I Tested It | 🔥 What's Changing | 👀 Open Question |
| Wednesday | 🌍 Africa Crypto Lens | 🔥 What's Changing | 👀 Open Question |
| Thursday | 🧠 Crypto Nobody Explained Properly | 🔥 What's Changing | 👀 Open Question |
| Friday | 👀 What I'm Watching | 🔥 What's Changing | 💬 Open Question |
| Saturday | 💰 $10 Experiment | 🔥 What's Changing | 👀 Open Question |
| Sunday | — | — | — |

The editorial theme changes the angle, not the requirement for natural, original storytelling.

## Duplicate-story protection

SquareRadar keeps a persistent `data/story-history.json` file.

Before publishing, it:

1. Removes duplicate stories from the current news batch.
2. Checks candidates against recent published stories.
3. Blocks stories that are too similar to recent posts.
4. Uses recent history for up to four days.
5. Saves the newly published story after a successful Binance Square post.
6. Commits the updated history back to the repository through GitHub Actions.

This prevents the same story from being selected again simply because it remains the highest-scoring item in the news feeds.

If no sufficiently novel story passes the filter, SquareRadar skips the post rather than recycling an old story.

## Sources

Current feeds include:

- CoinDesk
- Cointelegraph
- Decrypt
- Google News Crypto
- Google News Nigeria/Africa Crypto on Wednesday

Stories are scored using freshness, source quality, concrete developments, numbers, security events, adoption signals, and relevance to the day's editorial series.

## Binance Square publishing

SquareRadar can publish directly to Binance Square using:

`BINANCE_SQUARE_OPENAPI_KEY`

The publisher is intentionally separated into `binance-square/post-text.mjs`.

## Telegram

Add these GitHub Actions secrets:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- `BINANCE_SQUARE_OPENAPI_KEY`

Telegram receives the generated research/post package and the Binance Square publication result.

## GitHub Actions

The workflow runs automatically at:

- **06:30 WAT**
- **13:30 WAT**
- **19:30 WAT**

Monday through Saturday.

It also supports manual runs through GitHub Actions.

The workflow requires write permission because it persists `data/story-history.json` after successful posts.

## Local development

Install dependencies and run:

```bash
npm install
npm start
```

Required environment variables:

```text
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
BINANCE_SQUARE_OPENAPI_KEY=
```

## Project structure

```text
square-radar/
├── src/
│   └── index.mjs
├── binance-square/
│   └── post-text.mjs
├── data/
│   ├── schedule.json
│   └── story-history.json
├── output/
└── .github/
    └── workflows/
        └── daily.yml
```

## Core principle

**Find something interesting. Understand it. Tell the story like a human. Tag the relevant token. Start a conversation. Don't repeat yesterday's story just because the algorithm liked it.**
