import { PocketOptionBot, BotConfig } from './bot.js';
import { createServer } from 'http';

const config: BotConfig = {
  pocketOption: {
    isDemo: true,
    assets: ['EUR/USD OTC', 'GBP/USD OTC', 'USD/JPY OTC', 'AUD/USD OTC'],
    headless: true,
    slowMo: 50,
    mockMode: false
  },
  signalEngine: {
    rsiPeriod: 14,
    rsiOverbought: 70,
    rsiOversold: 30,
    macdFast: 12,
    macdSlow: 26,
    macdSignal: 9,
    bbPeriod: 20,
    bbStdDev: 2,
    atrPeriod: 14,
    stochPeriod: 14,
    adxPeriod: 14,
    cciPeriod: 20,
    williamsPeriod: 14,
    minConfidence: 70,
    lookbackPeriod: 500,
    timeframes: ['1s', '5s', '15s', '1m', '5m'],
    minConditionsRequired: 3,
    trendWeight: 1.2,
    momentumWeight: 1.0,
    volatilityWeight: 0.8,
    patternWeight: 1.0,
    srWeight: 1.0
  },
  telegram: {
    enabled: true,
    botToken: '8214823027:AAHVfjk9KxRGGlS9svqKaiw4Qg0DFhx0o-8',
    chatId: '7779937295',
    notifyOnSignal: true,
    notifyOnError: true,
    notifyOnStats: true,
    statsIntervalMinutes: 30
  },
  autoTrade: false,
  logLevel: 'info'
};

const bot = new PocketOptionBot(config);

bot.on('started', () => {
  console.log('✅ Bot started successfully');
});

bot.on('connected', () => {
  console.log('🔌 WebSocket connected');
});

bot.on('authenticated', () => {
  console.log('🔐 Authenticated');
});

bot.on('subscribed', (asset: string) => {
  console.log(`📊 Subscribed to ${asset}`);
});

bot.on('tick', (tick) => {
  if (Math.random() < 0.01) {
    console.log(`💹 ${tick.asset}: ${tick.price} (bid: ${tick.bid}, ask: ${tick.ask})`);
  }
});

bot.on('signal', (signal) => {
  const timeToExpiry = Math.round((signal.expiry - Date.now()) / 1000 / 60);
  const expiryTime = new Date(signal.expiry);
  console.log(`\n🚨 SIGNAL: ${signal.type} ${signal.asset}`);
  console.log(`   Price: ${signal.price}`);
  console.log(`   Confidence: ${signal.confidence}%`);
  console.log(`   Pattern: ${signal.pattern || 'N/A'}`);
  console.log(`   RSI: ${signal.indicators.rsi.toFixed(2)}`);
  console.log(`   MACD: ${signal.indicators.macd.macd.toFixed(5)} / ${signal.indicators.macd.signal.toFixed(5)}`);
  console.log(`   ADX: ${signal.indicators.adx.toFixed(2)} | CCI: ${signal.indicators.cci.toFixed(2)} | Williams %R: ${signal.indicators.williamsR.toFixed(2)}`);
  console.log(`   ⏱ Timeframe: ${signal.timeframe}`);
  console.log(`   🕐 Expiration: ${signal.expirationLabel} (${timeToExpiry} min)`);
  console.log(`   ⏰ Expires at: ${expiryTime.toLocaleTimeString()}\n`);
});

bot.on('error', (error: Error) => {
  console.error('❌ Error:', error.message);
});

bot.on('disconnected', (reason: string) => {
  console.warn('⚠️ Disconnected:', reason);
});

bot.on('reconnecting', (attempt: number) => {
  console.log(`🔄 Reconnecting... (attempt ${attempt})`);
});

process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down...');
  await bot.stop();
  process.exit(0);
});

// Start HTTP server for Render health check (free Web Service requirement)
const PORT = process.env.PORT || 3000;
createServer((req, res) => {
  if (req.url === '/' || req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 
      status: 'ok', 
      bot: 'running',
      uptime: process.uptime(),
      timestamp: new Date().toISOString()
    }));
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
}).listen(PORT, () => {
  console.log(`🌐 Health check server listening on port ${PORT}`);
});

async function main() {
  try {
    await bot.start();
    
    setInterval(() => {
      const stats = bot.getStats();
      console.log(`\n📈 Stats: Ticks: ${stats.tickCount} | Signals: ${stats.signalCount} | Connected: ${stats.connected} | Auth: ${stats.authenticated}`);
      console.log(`   Assets: ${stats.subscribedAssets.join(', ')}`);
    }, 30000);
    
  } catch (error) {
    console.error('Failed to start bot:', error);
    process.exit(1);
  }
}

main();