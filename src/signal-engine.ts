import { EventEmitter } from 'events';
import { AssetData } from './pocket-option-client.js';

export interface Candle {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  timestamp: number;
  timeframe: string;
  asset: string;
  complete: boolean;
}

export interface TechnicalIndicators {
  sma: number[];
  ema: number[];
  rsi: number;
  macd: { macd: number; signal: number; histogram: number };
  bollinger: { upper: number; middle: number; lower: number };
  atr: number;
  stoch: { k: number; d: number };
  adx: number;
  cci: number;
  williamsR: number;
}

export interface SignalConditions {
  trend: { bullish: boolean; bearish: boolean; strength: number };
  momentum: { bullish: boolean; bearish: boolean; strength: number };
  volatility: { high: boolean; low: boolean; strength: number };
  volume: { bullish: boolean; bearish: boolean; strength: number };
  pattern: { bullish: boolean; bearish: boolean; strength: number; patterns: string[] };
  supportResistance: { atSupport: boolean; atResistance: boolean; strength: number };
}

export interface Signal {
  id: string;
  asset: string;
  timestamp: number;
  type: 'BUY' | 'SELL';
  strength: number;
  price: number;
  indicators: TechnicalIndicators;
  conditions: SignalConditions;
  pattern?: string;
  confidence: number;
  expiry: number;
  expirationTime: number;  // milliseconds from now (e.g., 60000 = 1 min, 300000 = 5 min)
  expirationLabel: string;  // human readable (e.g., "1m", "5m", "15m")
  timeframe: string;
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
  adxPeriod: number;
  cciPeriod: number;
  williamsPeriod: number;
  minConfidence: number;
  lookbackPeriod: number;
  timeframes: string[];
  minConditionsRequired: number;
  trendWeight: number;
  momentumWeight: number;
  volatilityWeight: number;
  patternWeight: number;
  srWeight: number;
  // Pocket Option expiration intervals (in milliseconds)
  expirations: number[];
}

const TIMEFRAME_MS: Record<string, number> = {
  '1s': 1000,
  '5s': 5000,
  '15s': 15000,
  '1m': 60000,
  '5m': 300000
};

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
  srWeight: 1.0,
  // Pocket Option expiration intervals: 30s, 1m, 3m, 5m
  expirations: [30000, 60000, 180000, 300000]
};

export class CandleBuilder {
  private candles: Map<string, Map<string, Candle[]>> = new Map();
  private currentCandle: Map<string, Map<string, Candle | null>> = new Map();

  constructor(private timeframes: string[] = ['1s', '5s', '15s', '1m', '5m']) {}

  public processTick(tick: AssetData): Candle[] {
    const completedCandles: Candle[] = [];
    const asset = tick.asset;

    if (!this.candles.has(asset)) {
      this.candles.set(asset, new Map());
      this.currentCandle.set(asset, new Map());
      for (const tf of this.timeframes) {
        this.candles.get(asset)!.set(tf, []);
        this.currentCandle.get(asset)!.set(tf, null);
      }
    }

    for (const timeframe of this.timeframes) {
      const tfMs = TIMEFRAME_MS[timeframe];
      const candleStart = Math.floor(tick.timestamp / tfMs) * tfMs;
      let current = this.currentCandle.get(asset)!.get(timeframe)!;

      if (!current || current.timestamp !== candleStart) {
        if (current && current.complete === false) {
          current.complete = true;
          this.candles.get(asset)!.get(timeframe)!.push(current);
          completedCandles.push({ ...current });
        }

        current = {
          open: tick.price,
          high: tick.price,
          low: tick.price,
          close: tick.price,
          volume: 1,
          timestamp: candleStart,
          timeframe,
          asset,
          complete: false
        };
        this.currentCandle.get(asset)!.set(timeframe, current);
      } else {
        current.high = Math.max(current.high, tick.price);
        current.low = Math.min(current.low, tick.price);
        current.close = tick.price;
        current.volume += 1;
      }
    }

    return completedCandles;
  }

  public getCandles(asset: string, timeframe: string, limit: number = 100): Candle[] {
    const assetCandles = this.candles.get(asset);
    if (!assetCandles) return [];
    const tfCandles = assetCandles.get(timeframe);
    if (!tfCandles) return [];
    return tfCandles.slice(-limit);
  }

  public getCurrentCandle(asset: string, timeframe: string): Candle | null {
    return this.currentCandle.get(asset)?.get(timeframe) || null;
  }

  public getAllTimeframes(asset: string): Map<string, Candle[]> {
    const result = new Map<string, Candle[]>();
    const assetCandles = this.candles.get(asset);
    if (!assetCandles) return result;

    for (const [tf, candles] of assetCandles) {
      result.set(tf, [...candles]);
    }
    return result;
  }
}

export class SignalEngine extends EventEmitter {
  private candleBuilder: CandleBuilder;
  private priceHistory: Map<string, number[]> = new Map();
  private highHistory: Map<string, number[]> = new Map();
  private lowHistory: Map<string, number[]> = new Map();
  private closeHistory: Map<string, number[]> = new Map();
  private volumeHistory: Map<string, number[]> = new Map();
  private config: EngineConfig;
  private signals: Signal[] = [];
  private signalId = 0;
  private lastSignalTime: Map<string, number> = new Map();
  private signalCooldown = 30000;

  constructor(config: Partial<EngineConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.candleBuilder = new CandleBuilder(this.config.timeframes);
  }

  public processTick(tick: AssetData): void {
    const asset = tick.asset;
    const completedCandles = this.candleBuilder.processTick(tick);

    this.updatePriceHistory(asset, tick);

    for (const candle of completedCandles) {
      this.emit('candle', candle);
    }

    if (this.hasEnoughData(asset)) {
      this.analyzeAsset(asset, tick);
    }
  }

  private updatePriceHistory(asset: string, tick: AssetData): void {
    if (!this.priceHistory.has(asset)) {
      this.priceHistory.set(asset, []);
      this.highHistory.set(asset, []);
      this.lowHistory.set(asset, []);
      this.closeHistory.set(asset, []);
      this.volumeHistory.set(asset, []);
    }

    const prices = this.priceHistory.get(asset)!;
    const highs = this.highHistory.get(asset)!;
    const lows = this.lowHistory.get(asset)!;
    const closes = this.closeHistory.get(asset)!;
    const volumes = this.volumeHistory.get(asset)!;

    prices.push(tick.price);
    highs.push(tick.price);
    lows.push(tick.price);
    closes.push(tick.price);
    volumes.push(1);

    const maxLen = this.config.lookbackPeriod;
    if (prices.length > maxLen) {
      prices.shift();
      highs.shift();
      lows.shift();
      closes.shift();
      volumes.shift();
    }
  }

  private hasEnoughData(asset: string): boolean {
    const prices = this.priceHistory.get(asset);
    return prices !== undefined && prices.length >= Math.max(this.config.rsiPeriod, this.config.bbPeriod, this.config.macdSlow, this.config.adxPeriod);
  }

  private analyzeAsset(asset: string, currentTick: AssetData): void {
    const prices = this.priceHistory.get(asset)!;
    const highs = this.highHistory.get(asset)!;
    const lows = this.lowHistory.get(asset)!;
    const closes = this.closeHistory.get(asset)!;
    const volumes = this.volumeHistory.get(asset)!;

    const currentPrice = currentTick.price;
    const now = Date.now();

    const lastSignal = this.lastSignalTime.get(asset) || 0;
    if (now - lastSignal < this.signalCooldown) return;

    const primaryTf = this.config.timeframes[this.config.timeframes.length - 1];
    const candles = this.candleBuilder.getCandles(asset, primaryTf, 100);
    if (candles.length < 20) return;

    const indicators = this.calculateIndicators(prices, highs, lows, closes);
    const conditions = this.evaluateConditions(asset, indicators, candles, currentPrice);
    const patterns = this.detectPatterns(candles);

    const signal = this.generateSignal(asset, currentTick, indicators, conditions, patterns);

    if (signal) {
      this.lastSignalTime.set(asset, now);
      this.signals.push(signal);
      if (this.signals.length > 1000) this.signals.shift();
      this.emit('signal', signal);
      console.log(`[SignalEngine] ${signal.type} ${signal.asset} @ ${signal.price} | Conf: ${signal.confidence}% | Conditions: ${this.countMetConditions(conditions)}/${Object.keys(conditions).length}`);
    }

    this.emit('analysis', { asset, price: currentPrice, indicators, conditions, patterns });
  }

  private calculateIndicators(prices: number[], highs: number[], lows: number[], closes: number[]): TechnicalIndicators {
    const sma = this.calculateSMA(closes, this.config.bbPeriod);
    const ema = this.calculateEMA(closes, this.config.rsiPeriod);
    const rsi = this.calculateRSI(closes, this.config.rsiPeriod);
    const macd = this.calculateMACD(closes, this.config.macdFast, this.config.macdSlow, this.config.macdSignal);
    const bollinger = this.calculateBollingerBands(closes, this.config.bbPeriod, this.config.bbStdDev);
    const atr = this.calculateATR(highs, lows, closes, this.config.atrPeriod);
    const stoch = this.calculateStochastic(highs, lows, closes, this.config.stochPeriod);
    const adx = this.calculateADX(highs, lows, closes, this.config.adxPeriod);
    const cci = this.calculateCCI(highs, lows, closes, this.config.cciPeriod);
    const williamsR = this.calculateWilliamsR(highs, lows, closes, this.config.williamsPeriod);

    return { sma, ema, rsi, macd, bollinger, atr, stoch, adx, cci, williamsR };
  }

  private evaluateConditions(asset: string, indicators: TechnicalIndicators, candles: Candle[], currentPrice: number): SignalConditions {
    const conditions: SignalConditions = {
      trend: this.evaluateTrend(indicators, candles),
      momentum: this.evaluateMomentum(indicators),
      volatility: this.evaluateVolatility(indicators, candles),
      volume: this.evaluateVolume(candles),
      pattern: this.evaluatePatterns(candles),
      supportResistance: this.evaluateSupportResistance(asset, indicators, currentPrice)
    };
    return conditions;
  }

  private evaluateTrend(indicators: TechnicalIndicators, candles: Candle[]): SignalConditions['trend'] {
    let bullish = 0, bearish = 0;

    if (indicators.macd.macd > indicators.macd.signal && indicators.macd.histogram > 0) bullish++;
    else if (indicators.macd.macd < indicators.macd.signal && indicators.macd.histogram < 0) bearish++;

    const ema = indicators.ema[indicators.ema.length - 1];
    const price = candles[candles.length - 1].close;
    if (price > ema) bullish++;
    else if (price < ema) bearish++;

    if (indicators.adx > 25) {
      const prevCandle = candles[candles.length - 2];
      const lastCandle = candles[candles.length - 1];
      if (lastCandle.close > prevCandle.close) bullish++;
      else if (lastCandle.close < prevCandle.close) bearish++;
    }

    if (indicators.cci > 100) bullish++;
    else if (indicators.cci < -100) bearish++;

    const strength = Math.abs(bullish - bearish) / 4;
    return { bullish: bullish > bearish, bearish: bearish > bullish, strength: Math.min(1, strength) };
  }

  private evaluateMomentum(indicators: TechnicalIndicators): SignalConditions['momentum'] {
    let bullish = 0, bearish = 0;

    if (indicators.rsi < 30) bullish++;
    else if (indicators.rsi > 70) bearish++;
    else if (indicators.rsi < 45) bullish += 0.5;
    else if (indicators.rsi > 55) bearish += 0.5;

    if (indicators.stoch.k < 20 && indicators.stoch.k > indicators.stoch.d) bullish++;
    else if (indicators.stoch.k > 80 && indicators.stoch.k < indicators.stoch.d) bearish++;

    if (indicators.williamsR < -80) bullish++;
    else if (indicators.williamsR > -20) bearish++;

    if (indicators.macd.histogram > 0 && indicators.macd.macd > indicators.macd.signal) bullish++;
    else if (indicators.macd.histogram < 0 && indicators.macd.macd < indicators.macd.signal) bearish++;

    const total = bullish + bearish;
    const strength = total > 0 ? Math.abs(bullish - bearish) / total : 0;
    return { bullish: bullish > bearish, bearish: bearish > bullish, strength };
  }

  private evaluateVolatility(indicators: TechnicalIndicators, candles: Candle[]): SignalConditions['volatility'] {
    const bbWidth = (indicators.bollinger.upper - indicators.bollinger.lower) / indicators.bollinger.middle;
    const atrRatio = indicators.atr / candles[candles.length - 1].close;

    const highVol = bbWidth > 0.04 || atrRatio > 0.01;
    const lowVol = bbWidth < 0.015 && atrRatio < 0.005;

    let bullish = 0, bearish = 0;
    if (lowVol) bullish += 0.5;
    if (highVol) bearish += 0.3;

    const strength = Math.min(1, (bbWidth * 20 + atrRatio * 100));
    return { high: highVol, low: lowVol, strength };
  }

  private evaluateVolume(candles: Candle[]): SignalConditions['volume'] {
    if (candles.length < 10) return { bullish: false, bearish: false, strength: 0 };

    const recentVolumes = candles.slice(-5).map(c => c.volume);
    const avgVolume = candles.slice(-20).reduce((sum, c) => sum + c.volume, 0) / 20;
    const currentVolume = recentVolumes[recentVolumes.length - 1];
    const volumeRatio = currentVolume / avgVolume;

    const bullish = volumeRatio > 1.5;
    const bearish = volumeRatio < 0.5;
    const strength = Math.min(1, Math.abs(volumeRatio - 1));

    return { bullish, bearish, strength };
  }

  private evaluatePatterns(candles: Candle[]): SignalConditions['pattern'] {
    const patterns = this.detectPatterns(candles);
    let bullish = 0, bearish = 0;

    for (const pattern of patterns) {
      switch (pattern) {
        case 'hammer': case 'bullish_engulfing': case 'piercing': case 'morning_star':
          bullish++;
          break;
        case 'shooting_star': case 'bearish_engulfing': case 'dark_cloud': case 'evening_star':
          bearish++;
          break;
        case 'doji':
          bullish += 0.5;
          bearish += 0.5;
          break;
      }
    }

    const total = bullish + bearish;
    const strength = total > 0 ? Math.abs(bullish - bearish) / total : 0;
    return { bullish: bullish > bearish, bearish: bearish > bullish, strength, patterns };
  }

  private evaluateSupportResistance(asset: string, indicators: TechnicalIndicators, currentPrice: number): SignalConditions['supportResistance'] {
    const bb = indicators.bollinger;
    const atSupport = currentPrice <= bb.lower * 1.001;
    const atResistance = currentPrice >= bb.upper * 0.999;

    const nearSupport = currentPrice <= bb.middle && currentPrice > bb.lower;
    const nearResistance = currentPrice >= bb.middle && currentPrice < bb.upper;

    const strength = atSupport || atResistance ? 1 : (nearSupport || nearResistance ? 0.5 : 0);

    return { atSupport, atResistance, strength };
  }

  private detectPatterns(candles: Candle[]): string[] {
    const patterns: string[] = [];
    if (candles.length < 5) return patterns;

    const last = candles[candles.length - 1];
    const prev = candles[candles.length - 2];
    const prev2 = candles[candles.length - 3];

    const bodySize = Math.abs(last.close - last.open);
    const candleRange = last.high - last.low;
    const upperWick = last.high - Math.max(last.open, last.close);
    const lowerWick = Math.min(last.open, last.close) - last.low;
    const isBullish = last.close > last.open;
    const isBearish = last.close < last.open;

    if (candleRange > 0 && bodySize / candleRange < 0.1) {
      patterns.push('doji');
    }

    if (lowerWick > bodySize * 2 && upperWick < bodySize * 0.5) {
      patterns.push(isBullish ? 'hammer' : 'hanging_man');
    }

    if (upperWick > bodySize * 2 && lowerWick < bodySize * 0.5) {
      patterns.push(isBearish ? 'shooting_star' : 'inverted_hammer');
    }

    if (candles.length >= 2) {
      const prevBody = Math.abs(prev.close - prev.open);
      const currBody = bodySize;

      if (isBullish && prev.close <= prev.open && currBody > prevBody &&
          last.open < prev.close && last.close > prev.open) {
        patterns.push('bullish_engulfing');
      }
      if (isBearish && prev.close > prev.open && currBody > prevBody &&
          last.open > prev.close && last.close < prev.open) {
        patterns.push('bearish_engulfing');
      }

      if (isBearish && prev.close > prev.open && last.open > prev.close && last.close < (prev.open + prev.close) / 2) {
        patterns.push('dark_cloud');
      }
      if (isBullish && prev.close <= prev.open && last.open < prev.close && last.close > (prev.open + prev.close) / 2) {
        patterns.push('piercing');
      }
    }

    if (candles.length >= 3) {
      const c1 = candles[candles.length - 3];
      const c2 = candles[candles.length - 2];
      const c3 = last;

      if (c1.close <= c1.open && Math.abs(c2.close - c2.open) < (c2.high - c2.low) * 0.1 && c3.close > c3.open && c3.close > (c1.open + c1.close) / 2) {
        patterns.push('morning_star');
      }
      if (c1.close > c1.open && Math.abs(c2.close - c2.open) < (c2.high - c2.low) * 0.1 && c3.close <= c3.open && c3.close < (c1.open + c1.close) / 2) {
        patterns.push('evening_star');
      }
    }

    return patterns;
  }

  private generateSignal(asset: string, tick: AssetData, indicators: TechnicalIndicators, conditions: SignalConditions, patterns: string[]): Signal | null {
    let buyScore = 0;
    let sellScore = 0;
    const metConditions: string[] = [];

    if (conditions.trend.bullish) {
      buyScore += conditions.trend.strength * this.config.trendWeight * 25;
      metConditions.push('trend');
    } else if (conditions.trend.bearish) {
      sellScore += conditions.trend.strength * this.config.trendWeight * 25;
      metConditions.push('trend');
    }

    if (conditions.momentum.bullish) {
      buyScore += conditions.momentum.strength * this.config.momentumWeight * 20;
      metConditions.push('momentum');
    } else if (conditions.momentum.bearish) {
      sellScore += conditions.momentum.strength * this.config.momentumWeight * 20;
      metConditions.push('momentum');
    }

    if (conditions.volatility.low && conditions.trend.bullish) {
      buyScore += conditions.volatility.strength * this.config.volatilityWeight * 15;
      metConditions.push('volatility');
    } else if (conditions.volatility.high) {
      sellScore += conditions.volatility.strength * this.config.volatilityWeight * 10;
      metConditions.push('volatility');
    }

    if (conditions.volume.bullish) {
      buyScore += conditions.volume.strength * 10;
      metConditions.push('volume');
    }

    if (conditions.pattern.bullish) {
      buyScore += conditions.pattern.strength * this.config.patternWeight * 20;
      metConditions.push('pattern');
    } else if (conditions.pattern.bearish) {
      sellScore += conditions.pattern.strength * this.config.patternWeight * 20;
      metConditions.push('pattern');
    }

    if (conditions.supportResistance.atSupport && conditions.trend.bullish) {
      buyScore += this.config.srWeight * 15;
      metConditions.push('support');
    } else if (conditions.supportResistance.atResistance && conditions.trend.bearish) {
      sellScore += this.config.srWeight * 15;
      metConditions.push('resistance');
    }

    const totalConditions = ['trend', 'momentum', 'volatility', 'volume', 'pattern', 'supportResistance'].length;
    const metCount = metConditions.length;

    if (metCount < this.config.minConditionsRequired) return null;

    const type = buyScore > sellScore ? 'BUY' : 'SELL';
    const strength = type === 'BUY' ? buyScore : sellScore;

    const baseConfidence = Math.min(95, strength * (metCount / totalConditions) * 1.2);
    const conditionBonus = (metCount / totalConditions) * 15;
    const confidence = Math.round(Math.min(95, baseConfidence + conditionBonus));

    if (confidence < this.config.minConfidence) return null;

    // Select expiration from configured intervals based on confidence and signal strength
    // Higher confidence/strength -> longer expiration
    const expirations = this.config.expirations || [30000, 60000, 180000, 300000];
    
    // Determine which expiration tier to use based on confidence
    // 70-79% -> 30s or 1m
    // 80-84% -> 1m or 3m
    // 85-89% -> 3m or 5m
    // 90%+ -> 5m
    let expirationIndex: number;
    if (confidence >= 90) expirationIndex = 3;      // 5m
    else if (confidence >= 85) expirationIndex = 2;  // 3m
    else if (confidence >= 80) expirationIndex = 1;  // 1m
    else expirationIndex = 0;                         // 30s

    // Clamp to available expirations
    expirationIndex = Math.min(expirationIndex, expirations.length - 1);
    const expirationMs = expirations[expirationIndex];
    const expirationTime = tick.timestamp + expirationMs;
    const expirationLabel = this.formatExpiration(expirationMs);

    const signal: Signal = {
      id: `sig_${++this.signalId}_${Date.now()}`,
      asset,
      timestamp: tick.timestamp,
      type,
      strength: Math.round(strength),
      price: tick.price,
      indicators,
      conditions,
      pattern: patterns.join(', ') || undefined,
      confidence,
      expiry: expirationTime,
      expirationTime: expirationMs,
      expirationLabel,
      timeframe: this.config.timeframes[this.config.timeframes.length - 1]
    };

    return signal;
  }

  private getTimeframeMs(timeframe: string): number {
    const map: Record<string, number> = {
      '1s': 1000,
      '5s': 5000,
      '15s': 15000,
      '1m': 60000,
      '5m': 300000
    };
    return map[timeframe] || 60000;
  }

  private formatExpiration(ms: number): string {
    if (ms >= 300000) return `${ms / 60000}m`;
    if (ms >= 60000) return `${ms / 60000}m`;
    if (ms >= 1000) return `${ms / 1000}s`;
    return `${ms}ms`;
  }

  private countMetConditions(conditions: SignalConditions): number {
    let count = 0;
    if (conditions.trend.bullish || conditions.trend.bearish) count++;
    if (conditions.momentum.bullish || conditions.momentum.bearish) count++;
    if (conditions.volatility.high || conditions.volatility.low) count++;
    if (conditions.volume.bullish || conditions.volume.bearish) count++;
    if (conditions.pattern.bullish || conditions.pattern.bearish) count++;
    if (conditions.supportResistance.atSupport || conditions.supportResistance.atResistance) count++;
    return count;
  }

  public getSignals(asset?: string, limit = 50): Signal[] {
    let filtered = this.signals;
    if (asset) filtered = filtered.filter(s => s.asset === asset);
    return filtered.slice(-limit).reverse();
  }

  public getCandles(asset: string, timeframe: string, limit = 100): Candle[] {
    return this.candleBuilder.getCandles(asset, timeframe, limit);
  }

  public getAllTimeframes(asset: string): Map<string, Candle[]> {
    return this.candleBuilder.getAllTimeframes(asset);
  }

  public getLatestAnalysis(asset: string): { price: number; indicators: TechnicalIndicators; conditions: SignalConditions; patterns: string[] } | null {
    const prices = this.priceHistory.get(asset);
    if (!prices || prices.length < 50) return null;

    const highs = this.highHistory.get(asset)!;
    const lows = this.lowHistory.get(asset)!;
    const closes = this.closeHistory.get(asset)!;

    const indicators = this.calculateIndicators(prices, highs, lows, closes);
    const primaryTf = this.config.timeframes[this.config.timeframes.length - 1];
    const candles = this.candleBuilder.getCandles(asset, primaryTf, 50);
    const currentPrice = prices[prices.length - 1];
    const conditions = this.evaluateConditions(asset, indicators, candles, currentPrice);
    const patterns = this.detectPatterns(candles);

    return { price: currentPrice, indicators, conditions, patterns };
  }

  public getConfig(): EngineConfig {
    return { ...this.config };
  }

  public updateConfig(config: Partial<EngineConfig>): void {
    this.config = { ...this.config, ...config };
    this.candleBuilder = new CandleBuilder(this.config.timeframes);
  }

  private calculateSMA(prices: number[], period: number): number[] {
    const result: number[] = [];
    for (let i = 0; i < prices.length; i++) {
      if (i < period - 1) result.push(NaN);
      else result.push(prices.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period);
    }
    return result;
  }

  private calculateEMA(prices: number[], period: number): number[] {
    const result: number[] = [];
    const mult = 2 / (period + 1);
    let ema = prices[0];
    for (let i = 0; i < prices.length; i++) {
      ema = i === 0 ? prices[0] : (prices[i] - ema) * mult + ema;
      result.push(ema);
    }
    return result;
  }

  private calculateRSI(prices: number[], period: number): number {
    if (prices.length < period + 1) return 50;
    let gains = 0, losses = 0;
    for (let i = prices.length - period; i < prices.length; i++) {
      const change = prices[i] - prices[i - 1];
      if (change >= 0) gains += change; else losses -= change;
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
    const macdLine = emaFast.map((v, i) => v - emaSlow[i]);
    const signalLine = this.calculateEMA(macdLine.filter(n => !isNaN(n)), signal);
    return {
      macd: isNaN(macdLine[macdLine.length - 1]) ? 0 : macdLine[macdLine.length - 1],
      signal: isNaN(signalLine[signalLine.length - 1]) ? 0 : signalLine[signalLine.length - 1],
      histogram: isNaN(macdLine[macdLine.length - 1]) || isNaN(signalLine[signalLine.length - 1]) ? 0 : macdLine[macdLine.length - 1] - signalLine[signalLine.length - 1]
    };
  }

  private calculateBollingerBands(prices: number[], period: number, stdDev: number): { upper: number; middle: number; lower: number } {
    const sma = this.calculateSMA(prices, period);
    const lastSma = sma[sma.length - 1];
    if (isNaN(lastSma)) return { upper: 0, middle: 0, lower: 0 };
    const slice = prices.slice(-period);
    const variance = slice.reduce((sum, p) => sum + Math.pow(p - lastSma, 2), 0) / period;
    const std = Math.sqrt(variance);
    return { middle: lastSma, upper: lastSma + std * stdDev, lower: lastSma - std * stdDev };
  }

  private calculateATR(highs: number[], lows: number[], closes: number[], period: number): number {
    if (highs.length < period + 1) return 0;
    const trs: number[] = [];
    for (let i = highs.length - period; i < highs.length; i++) {
      const tr = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
      trs.push(tr);
    }
    return trs.reduce((a, b) => a + b, 0) / period;
  }

  private calculateStochastic(highs: number[], lows: number[], closes: number[], period: number): { k: number; d: number } {
    if (closes.length < period) return { k: 50, d: 50 };
    const slice = closes.slice(-period);
    const highest = Math.max(...highs.slice(-period));
    const lowest = Math.min(...lows.slice(-period));
    const current = closes[closes.length - 1];
    const k = ((current - lowest) / (highest - lowest)) * 100;
    return { k: isNaN(k) ? 50 : k, d: 50 };
  }

  private calculateADX(highs: number[], lows: number[], closes: number[], period: number): number {
    if (highs.length < period + 1) return 0;
    let plusDM = 0, minusDM = 0, trSum = 0;
    for (let i = highs.length - period; i < highs.length; i++) {
      const upMove = highs[i] - highs[i - 1];
      const downMove = lows[i - 1] - lows[i];
      plusDM += upMove > downMove && upMove > 0 ? upMove : 0;
      minusDM += downMove > upMove && downMove > 0 ? downMove : 0;
      const tr = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
      trSum += tr;
    }
    const plusDI = (plusDM / trSum) * 100;
    const minusDI = (minusDM / trSum) * 100;
    const dx = Math.abs(plusDI - minusDI) / (plusDI + minusDI) * 100;
    return isNaN(dx) ? 0 : dx;
  }

  private calculateCCI(highs: number[], lows: number[], closes: number[], period: number): number {
    if (closes.length < period) return 0;
    const typicalPrices = highs.slice(-period).map((h, i) => (h + lows[lows.length - period + i] + closes[closes.length - period + i]) / 3);
    const sma = typicalPrices.reduce((a, b) => a + b, 0) / period;
    const meanDev = typicalPrices.reduce((sum, tp) => sum + Math.abs(tp - sma), 0) / period;
    const currentTP = (highs[highs.length - 1] + lows[lows.length - 1] + closes[closes.length - 1]) / 3;
    return meanDev === 0 ? 0 : (currentTP - sma) / (0.015 * meanDev);
  }

  private calculateWilliamsR(highs: number[], lows: number[], closes: number[], period: number): number {
    if (closes.length < period) return -50;
    const highest = Math.max(...highs.slice(-period));
    const lowest = Math.min(...lows.slice(-period));
    const current = closes[closes.length - 1];
    return ((highest - current) / (highest - lowest)) * -100;
  }
}

export default SignalEngine;