# Pocket Option Signal Bot

**Signal-only bot** for Pocket Option with real-time WebSocket data, multi-timeframe technical analysis, and Telegram notifications.

> ⚠️ **This bot generates trading signals only. It does NOT execute trades automatically.** You receive signals via Telegram and decide whether to act on them.

## Features

- **Signal Only (No Auto-Trading)**: Generates BUY/SELL signals with confidence scores, SL/TP, risk:reward — you decide to trade
- **Real-time WebSocket Connection**: Connects to Pocket Option via Playwright browser automation to capture live WebSocket endpoints
- **Multi-timeframe Candles**: Builds 1s, 5s, 15s, 1m, 5m candles from raw ticks
- **10 Technical Indicators**: RSI, MACD, Bollinger Bands, ATR, Stochastic, ADX, CCI, Williams %R, SMA, EMA
- **8+ Candlestick Patterns**: Hammer, Doji, Engulfing, Morning/Evening Star, Piercing, Dark Cloud, Shooting Star
- **6-Condition Signal Logic**: Trend, Momentum, Volatility, Volume, Patterns, Support/Resistance
- **Confidence Scoring**: Minimum 3 conditions required, 70%+ confidence threshold
- **Risk Management**: ATR-based Stop Loss / Take Profit with Risk:Reward ratios
- **Telegram Notifications**: Real-time signals, errors, and stats
- **Auto-reconnection**: Exponential backoff reconnection
- **Mock Mode**: Test without live connection

## Quick Start

### Local Development

```bash
# Install dependencies
npm install

# Install Playwright browsers
npx playwright install chromium

# Build TypeScript
npm run build

# Run in mock mode (no internet required)
npm run dev

# Or run compiled version
node dist/index.js
```

### Environment Variables

Create `.env` file:
```env
# Telegram (optional)
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_chat_id

# Pocket Option (for live mode)
POCKET_EMAIL=your_email
POCKET_PASSWORD=your_password
POCKET_TOKEN=your_token
POCKET_USER_ID=your_user_id
```

## Configuration

Edit `src/index.ts` to configure:

```typescript
const config: BotConfig = {
  pocketOption: {
    isDemo: true,
    assets: ['EUR/USD OTC', 'GBP/USD OTC', 'USD/JPY OTC'],
    headless: true,
    mockMode: true,  // Set false for live signals
  },
  signalEngine: {
    minConfidence: 70,
    minConditionsRequired: 3,
    timeframes: ['1s', '5s', '15s', '1m', '5m'],
  },
  telegram: {
    enabled: true,
    botToken: process.env.TELEGRAM_BOT_TOKEN!,
    chatId: process.env.TELEGRAM_CHAT_ID!,
  },
  autoTrade: false,  // SIGNAL ONLY - never executes trades
  logLevel: 'info'
};
```

> **Note**: `autoTrade: false` is hardcoded as default. This bot only sends signals to Telegram — you manually execute trades on Pocket Option platform.

## Telegram Commands

- `/start` - Show help
- `/stats` - Bot statistics
- `/signals` - Recent signals
- `/assets` - Subscribed assets
- `/pause` - Pause notifications
- `/resume` - Resume notifications
- `/config` - Show configuration

## Deployment on Render

### Option 1: Web Service (Recommended)

1. Connect your GitHub repo to Render
2. Create new **Web Service**
3. Render will auto-detect `render.yaml`
4. Add environment variables in Render dashboard:
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_CHAT_ID`
   - `POCKET_EMAIL` (for live mode)
   - `POCKET_PASSWORD` (for live mode)

### Option 2: Background Worker

For continuous bot operation, use **Background Worker** service type.

## Project Structure

```
src/
├── index.ts                 # Entry point
├── bot.ts                   # Main bot orchestrator
├── pocket-option-client.ts  # WebSocket client with Playwright
├── signal-engine.ts         # Technical analysis & signals
├── trading-engine.ts        # Legacy engine (reference)
└── telegram-notifier.ts     # Telegram bot integration
```

## Signal Format

```
🟢 BUY EUR/USD OTC 📈

💰 Price: 1.08542
🎯 Confidence: 78%
📊 Risk:Reward: 2.0
🛑 Stop Loss: 1.08420
🎯 Take Profit: 1.08780
⏱ Timeframe: 5m
🕐 Expiry: 2:30:45 PM

Indicators:
• RSI: 28.5
• MACD: 0.00012 / 0.00008
• ADX: 32.1
• CCI: -145.2
• Williams %R: -85.5

📝 Pattern: hammer, uptrend
```

## Requirements

- Node.js 18+
- Playwright Chromium (for live mode)
- Internet access to pocketoption.com (live mode only)

## License

MIT