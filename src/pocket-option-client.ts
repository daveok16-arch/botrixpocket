import { WebSocket } from 'ws';
import { EventEmitter } from 'events';
import { Page, Browser, chromium, BrowserContext } from 'playwright';

export interface AssetData {
  asset: string;
  timestamp: number;
  price: number;
  bid?: number;
  ask?: number;
}

export interface AuthPayload {
  token: string;
  userId: string;
  isDemo: boolean;
  platform: string;
  timestamp: number;
}

export interface PocketOptionConfig {
  isDemo: boolean;
  email?: string;
  password?: string;
  token?: string;
  userId?: string;
  assets?: string[];
  headless?: boolean;
  slowMo?: number;
  mockMode?: boolean;
  // Auth retry configuration
  maxLoginRetries?: number;
  maxAuthRetries?: number;
  loginRetryDelay?: number;
  authRetryDelay?: number;
}

export interface WsMessage {
  type: string;
  payload?: any;
  sid?: string;
  pingInterval?: number;
  pingTimeout?: number;
}

export class PocketOptionClient extends EventEmitter {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private ws: WebSocket | null = null;
  private wsUrl: string = '';
  private authPayload: AuthPayload | null = null;
  private assets: string[] = [];
  private pingInterval: NodeJS.Timeout | null = null;
  private pingTimeout: NodeJS.Timeout | null = null;
  private pingIntervalMs: number = 25000;
  private pingTimeoutMs: number = 60000;
  private sid: string = '';
  private connected = false;
  private authenticated = false;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectDelay = 5000;
  private config: PocketOptionConfig;

  constructor(config: PocketOptionConfig) {
    super();
    this.config = {
      isDemo: config.isDemo ?? true,
      assets: config.assets || ['EUR/USD OTC', 'GBP/USD OTC', 'USD/JPY OTC'],
      headless: config.headless ?? true,
      slowMo: config.slowMo ?? 0,
      email: config.email,
      password: config.password,
      token: config.token,
      userId: config.userId,
      mockMode: config.mockMode ?? false,
      maxLoginRetries: config.maxLoginRetries ?? 3,
      maxAuthRetries: config.maxAuthRetries ?? 3,
      loginRetryDelay: config.loginRetryDelay ?? 5000,
      authRetryDelay: config.authRetryDelay ?? 3000
    };
    this.assets = this.config.assets || ['EUR/USD OTC'];
  }

  async initialize(): Promise<void> {
    console.log('[Init] Config mockMode:', this.config.mockMode);
    if (this.config.mockMode) {
      console.log('[Mock Mode] Starting mock WebSocket client...');
      this.connected = true;
      this.authenticated = true;
      this.wsUrl = 'mock://pocketoption.com';
      this.startMockTicks();
      this.subscribeToAssets();
      return;
    }

    await this.launchBrowser();
    await this.captureWebSocketEndpoint();
    await this.connectWebSocket();
    await this.performHandshake();
    await this.authenticate();
    await this.subscribeToAssets();
    this.startPingPong();
    this.setupReconnectHandler();
  }

  private async launchBrowser(): Promise<void> {
    this.browser = await chromium.launch({
      headless: this.config.headless ?? true,
      slowMo: this.config.slowMo ?? 0,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process',
        '--disable-site-isolation-trials',
        '--disable-dev-shm-usage',
        '--no-sandbox',
        '--disable-setuid-sandbox'
      ]
    });

    this.context = await this.browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 },
      locale: 'en-US',
      timezoneId: 'America/New_York',
      permissions: ['geolocation'],
      ignoreHTTPSErrors: true
    });

    this.context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    });

    this.page = await this.context.newPage();
    this.page.on('console', msg => console.log('[Browser Console]', msg.text()));
    this.page.on('pageerror', err => console.error('[Browser Error]', err.message));
  }

  private async captureWebSocketEndpoint(): Promise<void> {
    if (!this.page) throw new Error('Page not initialized');

    const wsUrlPromise = new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('WebSocket capture timeout')), 120000);

      this.page!.on('websocket', ws => {
        const url = ws.url();
        console.log('[WS Capture] WebSocket detected:', url);
        if (url.includes('socket.io') || url.includes('engine.io') || url.includes('pocketoption') || url.includes('wss://')) {
          clearTimeout(timeout);
          console.log('[WS Capture] WebSocket URL captured:', url);
          resolve(url);
        }
      });

      this.page!.on('response', response => {
        const url = response.url();
        if (url.includes('socket.io') || url.includes('engine.io') || url.includes('pocketoption') || url.includes('ws')) {
          console.log('[Network] Relevant request:', url, response.status(), response.request().method());
        }
      });

      this.page!.on('request', request => {
        const url = request.url();
        if (url.includes('socket.io') || url.includes('engine.io') || url.includes('pocketoption')) {
          console.log('[Network] Request:', request.method(), url);
        }
      });
    });

    const demoUrl = this.config.isDemo 
      ? 'https://pocketoption.com/en/demo/' 
      : 'https://pocketoption.com/en/login/';

    console.log('[Browser] Navigating to:', demoUrl);
    await this.page!.goto(demoUrl, { waitUntil: 'networkidle', timeout: 90000 });

    await this.page!.waitForTimeout(5000);

    if (this.config.email && this.config.password && !this.config.isDemo) {
      await this.performLogin();
    }

    console.log('[Browser] Waiting for trading interface to load...');
    await this.waitForTradingInterface();

    await this.page!.waitForTimeout(15000);

    const capturedWsUrl = await wsUrlPromise;
    this.wsUrl = this.extractWebSocketUrl(capturedWsUrl);
    console.log('[WS] Final WebSocket URL:', this.wsUrl);
  }

  private async waitForTradingInterface(): Promise<void> {
    if (!this.page) return;

    try {
      const startButtonSelectors = [
        'button:has-text("Start")',
        'button:has-text("Trade")',
        'button:has-text("Demo")',
        'button:has-text("Start Trading")',
        'a:has-text("Start")',
        'a:has-text("Trade")',
        '[data-testid="start-trading"]',
        '.start-trading-btn',
        '#start-trading',
        'button.start-btn'
      ];

      for (const selector of startButtonSelectors) {
        try {
          const element = await this.page!.waitForSelector(selector, { timeout: 3000 });
          if (element) {
            console.log('[Browser] Clicking start button:', selector);
            await element.click();
            await this.page!.waitForTimeout(3000);
            break;
          }
        } catch (e) {
          // Selector not found, continue
        }
      }

      await this.page!.waitForTimeout(5000);

      const canvasOrChart = await this.page!.waitForSelector('canvas, .chart-container, .trading-chart, [class*="chart"]', { timeout: 10000 }).catch(() => null);
      if (canvasOrChart) {
        console.log('[Browser] Trading chart detected');
      }
    } catch (e) {
      console.log('[Browser] Trading interface wait completed or not found');
    }
  }

  private async performLogin(): Promise<void> {
    if (!this.page) return;

    try {
      await this.page.fill('input[name="email"], input[type="email"]', this.config.email!);
      await this.page.fill('input[name="password"], input[type="password"]', this.config.password!);
      await this.page.click('button[type="submit"], button:has-text("Sign in"), button:has-text("Log in")');
      await this.page.waitForTimeout(5000);
    } catch (e) {
      console.log('[Login] Login form not found or already logged in');
    }
  }

  private extractWebSocketUrl(capturedUrl: string): string {
    const url = new URL(capturedUrl);
    if (url.searchParams.has('EIO')) {
      return capturedUrl;
    }

    const params = new URLSearchParams({
      EIO: '4',
      transport: 'websocket',
      t: Date.now().toString()
    });

    if (this.authPayload?.token) {
      params.set('token', this.authPayload.token);
    }

    return `${url.origin}/socket.io/?${params.toString()}`;
  }

  private async connectWebSocket(): Promise<void> {
    const cookies = await this.getCookies();
    console.log('[WS] Cookies for WS:', cookies.substring(0, 200) + '...');

    return new Promise((resolve, reject) => {
      console.log('[WS] Connecting to:', this.wsUrl);

      const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Origin': 'https://pocketoption.com',
        'Referer': 'https://pocketoption.com/',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'Sec-WebSocket-Extensions': 'permessage-deflate; client_max_window_bits',
        'Cookie': cookies
      };

      this.ws = new WebSocket(this.wsUrl, { headers });

      this.ws.on('open', () => {
        console.log('[WS] Connected');
        this.connected = true;
        this.reconnectAttempts = 0;
        resolve();
      });

      this.ws.on('message', (data: Buffer) => this.handleMessage(data));
      this.ws.on('close', (code, reason) => this.handleClose(code, reason.toString()));
      this.ws.on('error', (err) => {
        console.error('[WS] Error:', err.message);
        if (!this.connected) reject(err);
      });
    });
  }

  private async getCookies(): Promise<string> {
    if (!this.context) return '';
    try {
      const cookies = await this.context.cookies();
      return cookies.map(c => `${c.name}=${c.value}`).join('; ');
    } catch (e) {
      return '';
    }
  }

  private async performHandshake(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Handshake timeout')), 10000);

      const handleHandshake = (data: Buffer) => {
        const msg = data.toString();
        console.log('[WS] Handshake response:', msg);

        if (msg.startsWith('0')) {
          try {
            const data = JSON.parse(msg.substring(1));
            this.sid = data.sid;
            this.pingIntervalMs = data.pingInterval || 25000;
            this.pingTimeoutMs = data.pingTimeout || 60000;
            console.log('[WS] Handshake complete, SID:', this.sid, 'Ping interval:', this.pingIntervalMs);
            clearTimeout(timeout);
            this.ws!.off('message', handleHandshake);
            resolve();
          } catch (e) {
            console.error('[WS] Handshake parse error:', e);
          }
        } else if (msg === '2') {
          console.log('[WS] Received pong during handshake');
        }
      };

      this.ws!.on('message', handleHandshake);

      const handshakeMsg = '40/socket.io,EIO=4,transport=websocket';
      this.send(handshakeMsg);
    });
  }

  private async authenticate(): Promise<void> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= this.config.maxAuthRetries!; attempt++) {
      console.log(`[Auth] Attempt ${attempt}/${this.config.maxAuthRetries}...`);

      if (!this.config.token || !this.config.userId) {
        console.log('[Auth] No token/userId provided, attempting to extract from browser...');
        await this.extractAuthFromBrowser();
      }

      if (!this.authPayload) {
        lastError = new Error('[Auth] Failed to extract authentication from browser after login');
        
        // Try to re-login if we have credentials
        if (this.config.email && this.config.password && !this.config.isDemo) {
          console.log(`[Auth] Attempting re-login (attempt ${attempt})...`);
          await this.performLoginWithRetry(attempt);
          await this.extractAuthFromBrowser();
          
          if (this.authPayload) {
            console.log('[Auth] Successfully extracted auth after re-login');
            break;
          }
        }
        
        if (attempt < this.config.maxAuthRetries!) {
          console.log(`[Auth] Retrying in ${this.config.authRetryDelay}ms...`);
          await this.sleep(this.config.authRetryDelay!);
          continue;
        }
      } else {
        console.log('[Auth] Auth payload ready, attempting WebSocket authentication...');
        break;
      }
    }

    if (!this.authPayload) {
      throw new Error(
        `[Auth] Failed after ${this.config.maxAuthRetries} attempts. ` +
        `Last error: ${lastError?.message || 'No auth payload available'}. ` +
        `Ensure POCKET_EMAIL and POCKET_PASSWORD are set correctly, ` +
        `and the demo/live account is accessible.`
      );
    }

    const payload = this.authPayload;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Auth timeout: Server did not respond')), 15000);

      const handleAuth = (data: Buffer) => {
        const msg = data.toString();
        console.log('[WS] Auth response:', msg);

        if (msg.includes('"auth"') || msg.includes('"authorized"') || msg.includes('"ok"')) {
          clearTimeout(timeout);
          this.authenticated = true;
          console.log('[WS] Authentication successful');
          this.ws!.off('message', handleAuth);
          resolve();
        } else if (msg.includes('"error"') || msg.includes('"unauthorized"')) {
          clearTimeout(timeout);
          this.ws!.off('message', handleAuth);
          reject(new Error(`Authentication rejected by server: ${msg}`));
        }
      };

      this.ws!.on('message', handleAuth);

      const authPayload = {
        token: payload.token,
        userId: payload.userId,
        isDemo: payload.isDemo,
        platform: 'web',
        timestamp: Date.now()
      };

      const msg = `42/socket.io,["auth",${JSON.stringify(authPayload)}]`;
      this.send(msg);
    });
  }

  private async performLoginWithRetry(attempt: number): Promise<void> {
    for (let loginAttempt = 1; loginAttempt <= this.config.maxLoginRetries!; loginAttempt++) {
      console.log(`[Login] Attempt ${loginAttempt}/${this.config.maxLoginRetries}...`);
      
      try {
        await this.performLogin();
        
        // Wait for login to process and page to load
        await this.page!.waitForTimeout(this.config.loginRetryDelay!);
        
        // Verify we're logged in by checking for trading interface
        const loggedIn = await this.verifyLoginSuccess();
        if (loggedIn) {
          console.log('[Login] Successfully logged in');
          return;
        }
      } catch (e) {
        console.error(`[Login] Attempt ${loginAttempt} failed:`, e);
      }

      if (loginAttempt < this.config.maxLoginRetries!) {
        console.log(`[Login] Retrying in ${this.config.loginRetryDelay}ms...`);
        await this.sleep(this.config.loginRetryDelay!);
      }
    }

    throw new Error(`Failed to login after ${this.config.maxLoginRetries} attempts`);
  }

  private async verifyLoginSuccess(): Promise<boolean> {
    if (!this.page) return false;
    
    try {
      // Check for trading interface elements that indicate successful login
      const indicators = [
        'canvas',
        '.chart-container',
        '.trading-chart',
        '[class*="chart"]',
        'button:has-text("Trade")',
        'button:has-text("Start")'
      ];

      for (const selector of indicators) {
        const element = await this.page!.waitForSelector(selector, { timeout: 3000 }).catch(() => null);
        if (element) {
          console.log('[Login] Verified: Found trading interface element:', selector);
          return true;
        }
      }
    } catch (e) {
      // Ignore verification errors
    }
    return false;
  }

  private async extractAuthFromBrowser(): Promise<void> {
    if (!this.page || !this.context) {
      console.error('[Auth] Cannot extract auth: page or context not initialized');
      return;
    }

    try {
      console.log('[Auth] Extracting authentication from browser...');
      
      const cookies = await this.context.cookies();
      const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
      console.log('[Auth] Cookies count:', cookies.length);

      // Extract token from multiple possible storage locations
      const token = await this.page.evaluate(() => {
        return localStorage.getItem('token') || 
               localStorage.getItem('token_demo') || 
               sessionStorage.getItem('token') ||
               document.cookie.split('; ').find((c: string) => c.startsWith('token='))?.split('=')[1];
      });

      // Extract user ID from multiple possible storage locations
      const userId = await this.page.evaluate(() => {
        return localStorage.getItem('user_id') || 
               localStorage.getItem('user_id_demo') || 
               sessionStorage.getItem('user_id');
      });

      const isDemo = this.config.isDemo;

      console.log('[Auth] Token found:', token ? 'YES (length: ' + token.length + ')' : 'NO');
      console.log('[Auth] User ID found:', userId ? 'YES (' + userId + ')' : 'NO');

      if (token && userId) {
        this.authPayload = { token, userId, isDemo, platform: 'web', timestamp: Date.now() };
        console.log('[Auth] Successfully extracted auth payload from browser');
      } else {
        const missing = [];
        if (!token) missing.push('token');
        if (!userId) missing.push('userId');
        throw new Error(`Missing authentication data from browser: ${missing.join(', ')}. Page may not be fully loaded or login failed.`);
      }
    } catch (e) {
      console.error('[Auth] Failed to extract authentication from browser:', e);
      throw e;
    }
  }

  private async subscribeToAssets(): Promise<void> {
    for (const asset of this.assets) {
      const subscribeMsg = {
        asset: asset,
        timeframe: 1,
        period: 1
      };

      const msg = `42/socket.io,["subscribe",${JSON.stringify(subscribeMsg)}]`;
      this.send(msg);
      console.log('[WS] Subscribed to:', asset);
      await this.sleep(100);
    }
  }

  private startPingPong(): void {
    this.pingInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.send('2');
        console.log('[WS] Ping sent');

        this.pingTimeout = setTimeout(() => {
          console.log('[WS] Ping timeout, reconnecting...');
          this.ws?.close(1000, 'Ping timeout');
        }, this.pingTimeoutMs);
      }
    }, this.pingIntervalMs);
  }

  private handleMessage(data: Buffer): void {
    const msg = data.toString();
    console.log('[WS] Received:', msg.substring(0, 200));

    if (msg === '3') {
      console.log('[WS] Pong received');
      if (this.pingTimeout) clearTimeout(this.pingTimeout);
      return;
    }

    if (msg === '2') {
      console.log('[WS] Ping received, sending pong');
      this.send('3');
      return;
    }

    if (msg.startsWith('42')) {
      try {
        const payload = JSON.parse(msg.substring(2));
        const [event, data] = payload;
        this.emit('message', event, data);
        this.handleEvent(event, data);
      } catch (e) {
        console.error('[WS] Parse error:', e);
      }
    } else if (msg.startsWith('43')) {
      console.log('[WS] Binary message');
    } else if (msg.startsWith('40')) {
      console.log('[WS] Connect response');
    }
  }

  private handleEvent(event: string, data: any): void {
    switch (event) {
      case 'price':
      case 'price_update':
      case 'tick':
      case 'quote':
        this.parseMarketData(data);
        break;
      case 'candle':
      case 'candle_update':
        this.emit('candle', data);
        break;
      case 'auth':
      case 'authorized':
        this.authenticated = true;
        this.emit('authenticated', data);
        break;
      case 'subscribed':
        console.log('[WS] Subscription confirmed:', data);
        break;
      case 'error':
        console.error('[WS] Server error:', data);
        this.emit('error', data);
        break;
      case 'pong':
        if (this.pingTimeout) clearTimeout(this.pingTimeout);
        break;
      default:
        this.emit(event, data);
    }
  }

  private parseMarketData(data: any): void {
    try {
      let ticks: AssetData[] = [];

      if (Array.isArray(data)) {
        ticks = data.map(this.parseTick.bind(this)).filter(Boolean) as AssetData[];
      } else if (typeof data === 'object' && data !== null) {
        const tick = this.parseTick(data);
        if (tick) ticks.push(tick);
      }

      for (const tick of ticks) {
        this.emit('tick', tick);
      }
    } catch (e) {
      console.error('[Parse] Error parsing market data:', e);
    }
  }

  private parseTick(data: any): AssetData | null {
    try {
      const asset = data.asset || data.symbol || data.pair || data.name;
      const price = parseFloat(data.price || data.p || data.bid || data.ask || data.close || data.c);
      const timestamp = data.timestamp || data.t || data.time || Date.now();
      const bid = data.bid ? parseFloat(data.bid) : undefined;
      const ask = data.ask ? parseFloat(data.ask) : undefined;

      if (!asset || isNaN(price)) return null;

      return {
        asset: String(asset),
        timestamp: Number(timestamp),
        price,
        bid,
        ask
      };
    } catch (e) {
      return null;
    }
  }

  private handleClose(code: number, reason: string): void {
    console.log('[WS] Closed:', code, reason);
    this.connected = false;
    this.authenticated = false;
    this.cleanup();
    this.emit('close', code, reason);
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('[WS] Max reconnect attempts reached');
      this.emit('error', new Error('Max reconnect attempts reached'));
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.pow(1.5, this.reconnectAttempts - 1);
    console.log(`[WS] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

    setTimeout(async () => {
      try {
        await this.connectWebSocket();
        await this.performHandshake();
        await this.authenticate();
        await this.subscribeToAssets();
        this.startPingPong();
      } catch (e) {
        console.error('[WS] Reconnect failed:', e);
        this.scheduleReconnect();
      }
    }, delay);
  }

  private setupReconnectHandler(): void {
    this.on('close', () => this.scheduleReconnect());
    this.on('error', () => this.scheduleReconnect());
  }

  private cleanup(): void {
    if (this.pingInterval) clearInterval(this.pingInterval);
    if (this.pingTimeout) clearTimeout(this.pingTimeout);
    if (this.mockTickInterval) clearInterval(this.mockTickInterval);
    this.pingInterval = null;
    this.pingTimeout = null;
    this.mockTickInterval = null;
  }

  private send(data: string): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private mockTickInterval: NodeJS.Timeout | null = null;
  private basePrices: Map<string, number> = new Map();

  private startMockTicks(): void {
    console.log('[Mock] Starting mock tick generator for assets:', this.assets.join(', '));
    
    for (const asset of this.assets) {
      const basePrice = this.getBasePrice(asset);
      this.basePrices.set(asset, basePrice);
    }

    this.mockTickInterval = setInterval(() => {
      for (const asset of this.assets) {
        const basePrice = this.basePrices.get(asset) || this.getBasePrice(asset);
        const volatility = basePrice * 0.0002;
        const change = (Math.random() - 0.5) * 2 * volatility;
        const newPrice = basePrice + change;
        
        this.basePrices.set(asset, newPrice);
        
        const tick: AssetData = {
          asset,
          timestamp: Date.now(),
          price: parseFloat(newPrice.toFixed(5)),
          bid: parseFloat((newPrice - basePrice * 0.0001).toFixed(5)),
          ask: parseFloat((newPrice + basePrice * 0.0001).toFixed(5))
        };
        
        this.emit('tick', tick);
      }
    }, 1000);
  }

  private getBasePrice(asset: string): number {
    const prices: Record<string, number> = {
      'EUR/USD OTC': 1.0850,
      'GBP/USD OTC': 1.2650,
      'USD/JPY OTC': 149.50,
      'AUD/USD OTC': 0.6550,
      'USD/CHF OTC': 0.8950,
      'NZD/USD OTC': 0.6050,
      'EUR/GBP OTC': 0.8580,
      'EUR/JPY OTC': 162.20
    };
    return prices[asset] || 1.0000;
  }

  public sendTickToEngine(tick: AssetData): void {
    this.emit('engineTick', tick);
  }

  public async close(): Promise<void> {
    this.cleanup();
    this.removeAllListeners('close');
    this.removeAllListeners('error');

    if (this.ws) {
      this.ws.close(1000, 'Client closing');
      this.ws = null;
    }

    if (this.page) await this.page.close();
    if (this.context) await this.context.close();
    if (this.browser) await this.browser.close();

    this.connected = false;
    this.authenticated = false;
    console.log('[WS] Client closed');
  }

  public isReady(): boolean {
    return this.connected && this.authenticated;
  }

  public getAssets(): string[] {
    return this.assets;
  }

  public setAssets(assets: string[]): void {
    this.assets = assets;
    if (this.isReady()) {
      this.subscribeToAssets();
    }
  }

  public isConnected(): boolean {
    return this.connected;
  }

  public isAuthenticated(): boolean {
    return this.authenticated;
  }

  public getSubscribedAssets(): string[] {
    return this.assets;
  }

  public async subscribeAsset(asset: string): Promise<void> {
    if (!this.assets.includes(asset)) {
      this.assets.push(asset);
    }
    const subscribeMsg = { asset, timeframe: 1, period: 1 };
    const msg = `42/socket.io,["subscribe",${JSON.stringify(subscribeMsg)}]`;
    this.send(msg);
    console.log('[WS] Subscribed to:', asset);
  }

  public async unsubscribeAsset(asset: string): Promise<void> {
    this.assets = this.assets.filter(a => a !== asset);
    const unsubscribeMsg = { asset };
    const msg = `42/socket.io,["unsubscribe",${JSON.stringify(unsubscribeMsg)}]`;
    this.send(msg);
    console.log('[WS] Unsubscribed from:', asset);
  }

  public async disconnect(): Promise<void> {
    await this.close();
  }
}

export default PocketOptionClient;