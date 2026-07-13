import { Telegraf, Markup, Context } from 'telegraf';
import { Signal, Candle, TechnicalIndicators } from './signal-engine';
import { AssetData } from './pocket-option-client';

export interface TelegramConfig {
  botToken: string;
  chatId: string | number;
  enabled: boolean;
  notifyOnSignal: boolean;
  notifyOnError: boolean;
  notifyOnStats: boolean;
  statsIntervalMinutes: number;
}

export class TelegramNotifier {
  private bot: Telegraf | null = null;
  private config: TelegramConfig;
  private statsInterval: NodeJS.Timeout | null = null;
  private lastSignalTime: Map<string, number> = new Map();
  private signalCooldown = 5000;

  constructor(config: Partial<TelegramConfig> = {}) {
    this.config = {
      botToken: '',
      chatId: '',
      enabled: false,
      notifyOnSignal: true,
      notifyOnError: true,
      notifyOnStats: true,
      statsIntervalMinutes: 30,
      ...config
    };
  }

  public start(): boolean {
    return this.initialize();
  }

  public initialize(): boolean {
    if (!this.config.enabled || !this.config.botToken) {
      console.log('[Telegram] Not configured or disabled');
      return false;
    }

    try {
      this.bot = new Telegraf(this.config.botToken);
      this.setupCommands();
      this.bot.launch();
      console.log('[Telegram] Bot started successfully');
      
      if (this.config.notifyOnStats) {
        this.startStatsInterval();
      }
      
      this.sendMessage('🤖 <b>Pocket Option Bot Started</b>\n\nSignals will be sent here.');
      return true;
    } catch (error) {
      console.error('[Telegram] Failed to start:', error);
      return false;
    }
  }

  private setupCommands(): void {
    if (!this.bot) return;

    this.bot.command('start', (ctx) => this.handleStart(ctx));
    this.bot.command('stats', (ctx) => this.handleStats(ctx));
    this.bot.command('signals', (ctx) => this.handleRecentSignals(ctx));
    this.bot.command('assets', (ctx) => this.handleAssets(ctx));
    this.bot.command('pause', (ctx) => this.handlePause(ctx));
    this.bot.command('resume', (ctx) => this.handleResume(ctx));
    this.bot.command('config', (ctx) => this.handleConfig(ctx));
    this.bot.on('callback_query', (ctx) => this.handleCallback(ctx));
  }

  private async handleStart(ctx: Context): Promise<void> {
    await ctx.reply(
      '🤖 <b>Pocket Option Signal Bot</b>\n\n' +
      'Commands:\n' +
      '/stats - Show current statistics\n' +
      '/signals - Recent signals\n' +
      '/assets - Subscribed assets\n' +
      '/pause - Pause notifications\n' +
      '/resume - Resume notifications\n' +
      '/config - Show configuration',
      { parse_mode: 'HTML' }
    );
  }

  private async handleStats(ctx: Context): Promise<void> {
    const stats = this.getStatsSnapshot();
    await ctx.reply(this.formatStats(stats), { parse_mode: 'HTML' });
  }

  private async handleRecentSignals(ctx: Context): Promise<void> {
    // This would need access to the bot's signal history
    await ctx.reply('Recent signals feature - connect to bot instance', { parse_mode: 'HTML' });
  }

  private async handleAssets(ctx: Context): Promise<void> {
    await ctx.reply('Assets: EUR/USD OTC, GBP/USD OTC, USD/JPY OTC, AUD/USD OTC', { parse_mode: 'HTML' });
  }

  private async handlePause(ctx: Context): Promise<void> {
    this.config.notifyOnSignal = false;
    await ctx.reply('⏸ Notifications paused', { parse_mode: 'HTML' });
  }

  private async handleResume(ctx: Context): Promise<void> {
    this.config.notifyOnSignal = true;
    await ctx.reply('▶️ Notifications resumed', { parse_mode: 'HTML' });
  }

  private async handleConfig(ctx: Context): Promise<void> {
    const config = `
<b>Configuration:</b>
• Signals: ${this.config.notifyOnSignal ? '✅' : '❌'}
• Errors: ${this.config.notifyOnError ? '✅' : '❌'}
• Stats: ${this.config.notifyOnStats ? '✅' : '❌'} (every ${this.config.statsIntervalMinutes}min)
• Cooldown: ${this.signalCooldown}ms
    `;
    await ctx.reply(config, { parse_mode: 'HTML' });
  }

  private async handleCallback(ctx: Context): Promise<void> {
    await ctx.answerCbQuery();
  }

  public sendSignal(signal: Signal): void {
    if (!this.config.enabled || !this.config.notifyOnSignal || !this.bot) return;

    const now = Date.now();
    const lastTime = this.lastSignalTime.get(signal.asset) || 0;
    if (now - lastTime < this.signalCooldown) return;
    this.lastSignalTime.set(signal.asset, now);

    const emoji = signal.type === 'BUY' ? '🟢' : '🔴';
    const trendEmoji = this.getTrendEmoji(signal.indicators);
    
    const message = 
      `${emoji} <b>${signal.type} ${signal.asset}</b> ${trendEmoji}\n\n` +
      `💰 <b>Price:</b> ${signal.price.toFixed(5)}\n` +
      `🎯 <b>Confidence:</b> ${signal.confidence}%\n` +
      `📊 <b>Risk:Reward:</b> ${signal.riskReward}\n` +
      `🛑 <b>Stop Loss:</b> ${signal.stopLoss.toFixed(5)}\n` +
      `🎯 <b>Take Profit:</b> ${signal.takeProfit.toFixed(5)}\n` +
      `⏱ <b>Timeframe:</b> ${signal.timeframe}\n` +
      `🕐 <b>Expiry:</b> ${new Date(signal.expiry).toLocaleTimeString()}\n\n` +
      `<b>Indicators:</b>\n` +
      `• RSI: ${signal.indicators.rsi.toFixed(1)}\n` +
      `• MACD: ${signal.indicators.macd.macd.toFixed(5)} / ${signal.indicators.macd.signal.toFixed(5)}\n` +
      `• ADX: ${signal.indicators.adx.toFixed(1)}\n` +
      `• CCI: ${signal.indicators.cci.toFixed(1)}\n` +
      `• Williams %R: ${signal.indicators.williamsR.toFixed(1)}\n\n` +
      `📝 <b>Pattern:</b> ${signal.pattern || 'None'}`;

    this.sendMessage(message);
  }

  public sendError(error: Error, context?: string): void {
    if (!this.config.enabled || !this.config.notifyOnError || !this.bot) return;
    
    const message = 
      `⚠️ <b>Error</b>\n\n` +
      `<b>Context:</b> ${context || 'Unknown'}\n` +
      `<b>Message:</b> ${error.message}\n` +
      `<b>Time:</b> ${new Date().toLocaleString()}`;
    
    this.sendMessage(message);
  }

  public sendStatus(status: string, details?: string): void {
    if (!this.config.enabled || !this.bot) return;
    
    const message = `ℹ️ <b>Status Update</b>\n\n${status}\n${details ? `\n${details}` : ''}`;
    this.sendMessage(message);
  }

  public sendCustomMessage(message: string): void {
    if (!this.config.enabled || !this.bot) return;
    this.sendMessage(message);
  }

  private sendMessage(text: string): void {
    if (!this.bot || !this.config.chatId) return;
    
    this.bot.telegram.sendMessage(this.config.chatId, text, { 
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true }
    }).catch(err => console.error('[Telegram] Send failed:', err.message));
  }

  private startStatsInterval(): void {
    if (this.statsInterval) clearInterval(this.statsInterval);
    
    this.statsInterval = setInterval(() => {
      const stats = this.getStatsSnapshot();
      this.sendMessage(this.formatStats(stats));
    }, this.config.statsIntervalMinutes * 60 * 1000);
  }

  private getStatsSnapshot(): any {
    return {
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      timestamp: Date.now()
    };
  }

  private formatStats(stats: any): string {
    const uptime = this.formatUptime(stats.uptime);
    const mem = (stats.memory.heapUsed / 1024 / 1024).toFixed(1);
    
    return `
📊 <b>Bot Statistics</b>
⏱ Uptime: ${uptime}
💾 Memory: ${mem} MB
🕐 ${new Date().toLocaleString()}
    `.trim();
  }

  private formatUptime(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return `${h}h ${m}m ${s}s`;
  }

  private getTrendEmoji(indicators: TechnicalIndicators): string {
    if (indicators.macd.macd > indicators.macd.signal && indicators.rsi > 50) return '📈';
    if (indicators.macd.macd < indicators.macd.signal && indicators.rsi < 50) return '📉';
    return '➡️';
  }

  public stop(): void {
    if (this.statsInterval) clearInterval(this.statsInterval);
    if (this.bot) this.bot.stop();
    console.log('[Telegram] Bot stopped');
  }

  public updateConfig(config: Partial<TelegramConfig>): void {
    this.config = { ...this.config, ...config };
  }

  public isEnabled(): boolean {
    return this.config.enabled && !!this.bot;
  }
}

export default TelegramNotifier;