import { PocketOptionClient, PocketOptionConfig, AssetData } from './pocket-option-client.js';
import { SignalEngine, Signal, EngineConfig, Candle } from './signal-engine.js';
import { TelegramNotifier, TelegramConfig } from './telegram-notifier.js';
import { EventEmitter } from 'events';

export interface BotConfig {
  pocketOption: PocketOptionConfig;
  signalEngine: Partial<EngineConfig>;
  telegram?: TelegramConfig;
  autoTrade?: boolean;
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
}

export class PocketOptionBot extends EventEmitter {
  private client: PocketOptionClient;
  private engine: SignalEngine;
  private telegram: TelegramNotifier | null = null;
  private config: BotConfig;
  private isRunning = false;
  private tickCount = 0;
  private signalCount = 0;
  private startTime: number = 0;

  constructor(config: BotConfig) {
    super();
    this.config = {
      logLevel: 'info',
      autoTrade: false,
      ...config
    };

    this.client = new PocketOptionClient(this.config.pocketOption);
    this.engine = new SignalEngine(this.config.signalEngine);

    if (this.config.telegram?.enabled && this.config.telegram.botToken && this.config.telegram.chatId) {
      this.telegram = new TelegramNotifier(this.config.telegram);
      this.telegram.start();
      this.log('info', 'Telegram notifier enabled');
    }

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    this.client.on('message', (event: string, data: any) => {
      this.handleSocketMessage(event, data);
    });

    this.client.on('tick', (tick: AssetData) => {
      this.handleTick(tick);
    });

    this.client.on('connected', () => {
      this.log('info', 'Connected to Pocket Option WebSocket');
      this.emit('connected');
    });

    this.client.on('authenticated', () => {
      this.log('info', 'Authenticated successfully');
      this.emit('authenticated');
    });

    this.client.on('subscribed', (asset: string) => {
      this.log('info', `Subscribed to ${asset}`);
      this.emit('subscribed', asset);
    });

    this.client.on('error', (error: Error) => {
      this.log('error', `Client error: ${error.message}`);
      this.emit('error', error);
    });

    this.client.on('disconnected', (reason: string) => {
      this.log('warn', `Disconnected: ${reason}`);
      this.emit('disconnected', reason);
    });

    this.client.on('reconnecting', (attempt: number) => {
      this.log('info', `Reconnecting... (attempt ${attempt})`);
      this.emit('reconnecting', attempt);
    });

    this.engine.on('signal', (signal: Signal) => {
      this.handleSignal(signal);
    });

    this.engine.on('candle', (candle: Candle) => {
      this.emit('candle', candle);
    });
  }

  private handleSocketMessage(event: string, data: any): void {
    this.log('debug', `Socket event: ${event}`, data);

    switch (event) {
      case 'tick':
      case 'quote':
      case 'price':
        this.handlePriceUpdate(data);
        break;
      case 'candle':
      case 'candles':
        this.handleCandleData(data);
        break;
      case 'auth':
      case 'authorized':
        this.client.emit('authenticated');
        break;
      case 'subscribe':
      case 'subscribed':
        this.client.emit('subscribed', data?.asset || data);
        break;
      case 'unsubscribe':
      case 'unsubscribed':
        this.log('info', `Unsubscribed from ${data?.asset || data}`);
        break;
      case 'error':
        this.log('error', `Server error: ${JSON.stringify(data)}`);
        break;
      case 'pong':
        break;
      default:
        this.log('debug', `Unhandled event: ${event}`, data);
    }
  }

  private handlePriceUpdate(data: any): void {
    const asset = data.asset || data.symbol || data.name;
    const price = data.price || data.bid || data.ask || data.p || data.c;
    const timestamp = data.timestamp || data.time || data.t || Date.now();
    const bid = data.bid || data.b;
    const ask = data.ask || data.a;

    if (!asset || price === undefined) return;

    const tick: AssetData = {
      asset,
      timestamp: typeof timestamp === 'number' ? timestamp : Date.parse(timestamp),
      price: typeof price === 'number' ? price : parseFloat(price),
      bid: bid !== undefined ? (typeof bid === 'number' ? bid : parseFloat(bid)) : undefined,
      ask: ask !== undefined ? (typeof ask === 'number' ? ask : parseFloat(ask)) : undefined
    };

    this.client.emit('tick', tick);
  }

  private handleCandleData(data: any): void {
    this.log('debug', 'Candle data received', data);
  }

  private handleTick(tick: AssetData): void {
    this.tickCount++;
    this.engine.processTick(tick);

    if (this.config.logLevel === 'debug' || this.tickCount % 100 === 0) {
      this.log('debug', `Tick #${this.tickCount}: ${tick.asset} @ ${tick.price}`);
    }

    this.emit('tick', tick);
  }

  private handleSignal(signal: Signal): void {
    this.signalCount++;
    this.log('info', `🚀 SIGNAL #${this.signalCount}: ${signal.type} ${signal.asset} @ ${signal.price} | Conf: ${signal.confidence}% | R:R ${signal.riskReward} | SL: ${signal.stopLoss} | TP: ${signal.takeProfit}`);
    
    // Send Telegram notification
    if (this.telegram?.isEnabled()) {
      this.telegram.sendSignal(signal);
    }

    this.emit('signal', signal);

    if (this.config.autoTrade) {
      this.executeTrade(signal);
    }
  }

  private async executeTrade(signal: Signal): Promise<void> {
    this.log('info', `Executing ${signal.type} trade for ${signal.asset}`);
    this.emit('trade', signal);
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      this.log('warn', 'Bot is already running');
      return;
    }

    this.log('info', 'Starting Pocket Option Bot...');
    this.startTime = Date.now();
    this.isRunning = true;

    try {
      await this.client.initialize();
      this.emit('started');
      this.log('info', 'Bot started successfully');
    } catch (error) {
      this.isRunning = false;
      this.log('error', `Failed to start bot: ${error}`);
      this.emit('error', error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.isRunning) return;

    this.log('info', 'Stopping bot...');
    this.isRunning = false;

    if (this.telegram) {
      this.telegram.stop();
    }

    await this.client.disconnect();
    this.emit('stopped');
    this.log('info', 'Bot stopped');
  }

  async subscribeAsset(asset: string): Promise<void> {
    await this.client.subscribeAsset(asset);
  }

  async unsubscribeAsset(asset: string): Promise<void> {
    await this.client.unsubscribeAsset(asset);
  }

  getSignals(asset?: string, limit = 50): Signal[] {
    return this.engine.getSignals(asset, limit);
  }

  getCandles(asset: string, timeframe: string, limit = 100): Candle[] {
    return this.engine.getCandles(asset, timeframe, limit);
  }

  getAllTimeframes(asset: string) {
    return this.engine.getAllTimeframes(asset);
  }

  getLatestAnalysis(asset: string) {
    return this.engine.getLatestAnalysis(asset);
  }

  getStats() {
    return {
      isRunning: this.isRunning,
      uptime: this.startTime ? Date.now() - this.startTime : 0,
      tickCount: this.tickCount,
      signalCount: this.signalCount,
      connected: this.client.isConnected(),
      authenticated: this.client.isAuthenticated(),
      subscribedAssets: this.client.getSubscribedAssets(),
      engineConfig: this.engine.getConfig()
    };
  }

  updateEngineConfig(config: Partial<EngineConfig>): void {
    this.engine.updateConfig(config);
  }

  private log(level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: any): void {
    const levels = { debug: 0, info: 1, warn: 2, error: 3 };
    const configLevel = levels[this.config.logLevel || 'info'];
    const msgLevel = levels[level];
    
    if (msgLevel >= configLevel) {
      const timestamp = new Date().toISOString();
      const prefix = `[${timestamp}] [${level.toUpperCase()}]`;
      console.log(`${prefix} ${message}`, data !== undefined ? data : '');
    }
  }
}

export default PocketOptionBot;