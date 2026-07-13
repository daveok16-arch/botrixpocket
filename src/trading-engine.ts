import { EventEmitter } from 'events';
import { AssetData } from './pocket-option-client.js';

export interface TechnicalIndicators {
  sma: number[];
  ema: number[];
  rsi: number;
  macd: { macd: number; signal: number; histogram: number };
  bollinger: { upper: number; middle: number; lower: number };
  atr: number;
  stoch: { k: number; d: number };
}

export interface Signal {
  id: string;
  asset: string;
  timestamp: number;
  type: 'BUY' | 'SELL';
  strength: number;
  price: number;
  indicators: TechnicalIndicators;
  pattern?: string;
  confidence: number;
  expiry: number;
}

export interface EngineConfig {
  rsiPeriod: number;
  rsiOverbought: number;
  rsiOversold: number;
  macdFast: number;
  macdSlow: number;
  macdSignal: number;
  bbPeriod: number;
  bbStdDev: number;
  atrPeriod: number;
  stochPeriod: number;
  minConfidence: number;
  lookbackPeriod: number;
}

const DEFAULT_CONFIG: EngineConfig = {
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
  minConfidence: 65,
  lookbackPeriod: 100
};

export class TradingEngine extends EventEmitter {
  private priceHistory: Map<string, number[]> = new Map();
  private tickHistory: Map<string, AssetData[]> = new Map();
  private config: EngineConfig;
  private signals: Signal[] = [];
  private signalId = 0;

  constructor(config: Partial<EngineConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  public processTick(tick: AssetData): void {
    const asset = tick.asset;
    
    if (!this.priceHistory.has(asset)) {
      this.priceHistory.set(asset, []);
      this.tickHistory.set(asset, []);
    }

    const prices = this.priceHistory.get(asset)!;
    const ticks = this.tickHistory.get(asset)!;

    prices.push(tick.price);
    ticks.push(tick);

    if (prices.length > this.config.lookbackPeriod) {
      prices.shift();
      ticks.shift();
    }

    if (prices.length >= Math.max(this.config.rsiPeriod, this.config.bbPeriod, this.config.macdSlow)) {
      this.analyzeAsset(asset);
    }
  }

  private analyzeAsset(asset: string): void {
    const prices = this.priceHistory.get(asset)!;
    const ticks = this.tickHistory.get(asset)!;
    const currentPrice = prices[prices.length - 1];
    const currentTick = ticks[ticks.length - 1];

    const indicators = this.calculateIndicators(prices);
    const patterns = this.detectPatterns(prices);
    const signal = this.generateSignal(asset, currentTick, indicators, patterns);

    if (signal) {
      this.signals.push(signal);
      if (this.signals.length > 1000) this.signals.shift();
      this.emit('signal', signal);
      console.log(`[Engine] Signal generated: ${signal.type} ${signal.asset} @ ${signal.price} (conf: ${signal.confidence}%)`);
    }

    this.emit('analysis', { asset, price: currentPrice, indicators, patterns });
  }

  private calculateIndicators(prices: number[]): TechnicalIndicators {
    const sma = this.calculateSMA(prices, this.config.bbPeriod);
    const ema = this.calculateEMA(prices, this.config.rsiPeriod);
    const rsi = this.calculateRSI(prices, this.config.rsiPeriod);
    const macd = this.calculateMACD(prices, this.config.macdFast, this.config.macdSlow, this.config.macdSignal);
    const bollinger = this.calculateBollingerBands(prices, this.config.bbPeriod, this.config.bbStdDev);
    const atr = this.calculateATR(prices, this.config.atrPeriod);
    const stoch = this.calculateStochastic(prices, this.config.stochPeriod);

    return { sma, ema, rsi, macd, bollinger, atr, stoch };
  }

  private calculateSMA(prices: number[], period: number): number[] {
    const result: number[] = [];
    for (let i = 0; i < prices.length; i++) {
      if (i < period - 1) {
        result.push(NaN);
      } else {
        const sum = prices.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0);
        result.push(sum / period);
      }
    }
    return result;
  }

  private calculateEMA(prices: number[], period: number): number[] {
    const result: number[] = [];
    const multiplier = 2 / (period + 1);
    let ema = prices[0];
    
    for (let i = 0; i < prices.length; i++) {
      if (i === 0) {
        result.push(prices[0]);
      } else {
        ema = (prices[i] - ema) * multiplier + ema;
        result.push(ema);
      }
    }
    return result;
  }

  private calculateRSI(prices: number[], period: number): number {
    if (prices.length < period + 1) return 50;

    let gains = 0;
    let losses = 0;

    for (let i = prices.length - period; i < prices.length; i++) {
      const change = prices[i] - prices[i - 1];
      if (change >= 0) gains += change;
      else losses -= change;
    }

    const avgGain = gains / period;
    const avgLoss = losses / period;
    
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
  }

  private calculateMACD(prices: number[], fast: number, slow: number, signal: number): { macd: number; signal: number; histogram: number } {
    const emaFast = this.calculateEMA(prices, fast);
    const emaSlow = this.calculateEMA(prices, slow);
    
    const macdLine: number[] = [];
    for (let i = 0; i < prices.length; i++) {
      macdLine.push(emaFast[i] - emaSlow[i]);
    }

    const signalLine = this.calculateEMA(macdLine.filter(n => !isNaN(n)), signal);
    const lastMacd = macdLine[macdLine.length - 1];
    const lastSignal = signalLine[signalLine.length - 1];

    return {
      macd: isNaN(lastMacd) ? 0 : lastMacd,
      signal: isNaN(lastSignal) ? 0 : lastSignal,
      histogram: isNaN(lastMacd) || isNaN(lastSignal) ? 0 : lastMacd - lastSignal
    };
  }

  private calculateBollingerBands(prices: number[], period: number, stdDev: number): { upper: number; middle: number; lower: number } {
    const sma = this.calculateSMA(prices, period);
    const lastSma = sma[sma.length - 1];
    
    if (isNaN(lastSma)) return { upper: 0, middle: 0, lower: 0 };

    const slice = prices.slice(-period);
    const variance = slice.reduce((sum, p) => sum + Math.pow(p - lastSma, 2), 0) / period;
    const std = Math.sqrt(variance);

    return {
      middle: lastSma,
      upper: lastSma + (std * stdDev),
      lower: lastSma - (std * stdDev)
    };
  }

  private calculateATR(prices: number[], period: number): number {
    if (prices.length < period + 1) return 0;

    const trueRanges: number[] = [];
    for (let i = prices.length - period; i < prices.length; i++) {
      const high = prices[i];
      const low = prices[i];
      const prevClose = prices[i - 1];
      const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
      trueRanges.push(tr);
    }

    return trueRanges.reduce((a, b) => a + b, 0) / period;
  }

  private calculateStochastic(prices: number[], period: number): { k: number; d: number } {
    if (prices.length < period) return { k: 50, d: 50 };

    const slice = prices.slice(-period);
    const highest = Math.max(...slice);
    const lowest = Math.min(...slice);
    const current = prices[prices.length - 1];

    const k = ((current - lowest) / (highest - lowest)) * 100;
    return { k: isNaN(k) ? 50 : k, d: 50 };
  }

  private detectPatterns(prices: number[]): string[] {
    const patterns: string[] = [];
    const len = prices.length;
    if (len < 10) return patterns;

    const recent = prices.slice(-5);
    
    if (this.isHammer(recent)) patterns.push('hammer');
    if (this.isDoji(recent)) patterns.push('doji');
    if (this.isEngulfing(prices.slice(-6))) patterns.push('engulfing');
    if (this.isTrend(recent, 'up')) patterns.push('uptrend');
    if (this.isTrend(recent, 'down')) patterns.push('downtrend');
    if (this.isSupportResistance(prices)) patterns.push('support_resistance');

    return patterns;
  }

  private isHammer(candles: number[]): boolean {
    if (candles.length < 3) return false;
    const body = Math.abs(candles[candles.length - 1] - candles[candles.length - 2]);
    const lowerWick = candles[candles.length - 2] - Math.min(...candles.slice(-3));
    return lowerWick > body * 2;
  }

  private isDoji(candles: number[]): boolean {
    if (candles.length < 2) return false;
    const body = Math.abs(candles[candles.length - 1] - candles[candles.length - 2]);
    const range = Math.max(...candles.slice(-2)) - Math.min(...candles.slice(-2));
    return range > 0 && body / range < 0.1;
  }

  private isEngulfing(candles: number[]): boolean {
    if (candles.length < 4) return false;
    const prevOpen = candles[candles.length - 4];
    const prevClose = candles[candles.length - 3];
    const currOpen = candles[candles.length - 2];
    const currClose = candles[candles.length - 1];
    
    const prevBullish = prevClose > prevOpen;
    const currBullish = currClose > currOpen;
    
    return prevBullish !== currBullish &&
           Math.abs(currClose - currOpen) > Math.abs(prevClose - prevOpen);
  }

  private isTrend(candles: number[], direction: 'up' | 'down'): boolean {
    if (candles.length < 3) return false;
    const changes = candles.slice(1).map((c, i) => c - candles[i]);
    const positive = changes.filter(c => c > 0).length;
    const negative = changes.filter(c => c < 0).length;
    return direction === 'up' ? positive >= 3 : negative >= 3;
  }

  private isSupportResistance(prices: number[]): boolean {
    if (prices.length < 20) return false;
    const current = prices[prices.length - 1];
    const recent = prices.slice(-20);
    const min = Math.min(...recent);
    const max = Math.max(...recent);
    const threshold = (max - min) * 0.02;
    return Math.abs(current - min) < threshold || Math.abs(current - max) < threshold;
  }

  private generateSignal(asset: string, tick: AssetData, indicators: TechnicalIndicators, patterns: string[]): Signal | null {
    let buyScore = 0;
    let sellScore = 0;
    const reasons: string[] = [];

    if (indicators.rsi < this.config.rsiOversold) {
      buyScore += 25;
      reasons.push(`RSI oversold (${indicators.rsi.toFixed(1)})`);
    } else if (indicators.rsi > this.config.rsiOverbought) {
      sellScore += 25;
      reasons.push(`RSI overbought (${indicators.rsi.toFixed(1)})`);
    }

    if (indicators.macd.histogram > 0 && indicators.macd.macd > indicators.macd.signal) {
      buyScore += 20;
      reasons.push('MACD bullish crossover');
    } else if (indicators.macd.histogram < 0 && indicators.macd.macd < indicators.macd.signal) {
      sellScore += 20;
      reasons.push('MACD bearish crossover');
    }

    if (tick.price < indicators.bollinger.lower) {
      buyScore += 20;
      reasons.push('Price below lower Bollinger Band');
    } else if (tick.price > indicators.bollinger.upper) {
      sellScore += 20;
      reasons.push('Price above upper Bollinger Band');
    }

    if (indicators.stoch.k < 20) {
      buyScore += 15;
      reasons.push('Stochastic oversold');
    } else if (indicators.stoch.k > 80) {
      sellScore += 15;
      reasons.push('Stochastic overbought');
    }

    if (patterns.includes('hammer')) buyScore += 10;
    if (patterns.includes('doji')) { buyScore += 5; sellScore += 5; }
    if (patterns.includes('engulfing')) {
      const lastPattern = patterns[patterns.length - 1];
      if (lastPattern === 'engulfing') buyScore += 10;
    }
    if (patterns.includes('support_resistance')) {
      if (tick.price < indicators.bollinger.middle) buyScore += 10;
      else sellScore += 10;
    }

    const type = buyScore > sellScore ? 'BUY' : 'SELL';
    const strength = type === 'BUY' ? buyScore : sellScore;
    const confidence = Math.min(95, strength + Math.random() * 10);

    if (confidence < this.config.minConfidence) return null;

    const signal: Signal = {
      id: `sig_${++this.signalId}_${Date.now()}`,
      asset,
      timestamp: tick.timestamp,
      type,
      strength,
      price: tick.price,
      indicators,
      pattern: patterns.join(', ') || undefined,
      confidence: Math.round(confidence),
      expiry: tick.timestamp + 60000
    };

    return signal;
  }

  public getSignals(asset?: string, limit = 50): Signal[] {
    let filtered = this.signals;
    if (asset) filtered = filtered.filter(s => s.asset === asset);
    return filtered.slice(-limit).reverse();
  }

  public getLatestAnalysis(asset: string): { price: number; indicators: TechnicalIndicators; patterns: string[] } | null {
    const prices = this.priceHistory.get(asset);
    if (!prices || prices.length < 20) return null;

    const indicators = this.calculateIndicators(prices);
    const patterns = this.detectPatterns(prices);

    return {
      price: prices[prices.length - 1],
      indicators,
      patterns
    };
  }

  public getConfig(): EngineConfig {
    return { ...this.config };
  }

  public updateConfig(config: Partial<EngineConfig>): void {
    this.config = { ...this.config, ...config };
  }
}

export default TradingEngine;