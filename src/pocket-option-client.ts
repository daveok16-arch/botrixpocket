import { WebSocket } from 'ws';
import { EventEmitter } from 'events';
import { Page, Browser, chromium, BrowserContext, Route, Request, Response, Frame } from 'playwright';

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
  maxLoginRetries?: number;
  maxAuthRetries?: number;
  loginRetryDelay?: number;
  authRetryDelay?: number;
  navigationTimeout?: number;
  debugNavigation?: boolean;
}

export interface WsMessage {
  type: string;
  payload?: any;
  sid?: string;
  pingInterval?: number;
  pingTimeout?: number;
}

interface NavigationTiming {
  dnsLookup: number;
  tcpConnect: number;
  tlsHandshake: number;
  firstByte: number;
  responseHeaders: number;
  totalTime: number;
  httpStatus: number;
  redirectChain: string[];
}

interface NavigationDiagnostics {
  timing: NavigationTiming;
  redirects: string[];
  finalUrl: string;
  httpStatus: number;
  contentLength: number;
  contentType: string;
  isCloudflare: boolean;
  isCaptcha: boolean;
  is403: boolean;
  is429: boolean;
  htmlLength: number;
  screenshotPath?: string;
  htmlPath?: string;
  errors: string[];
  consoleLogs: string[];
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
  private mockTickInterval: NodeJS.Timeout | null = null;
  private basePrices: Map<string, number> = new Map();
  private navigationDiagnostics: NavigationDiagnostics | null = null;
  private requestStartTime: number = 0;
  private dnsStartTime: number = 0;
  private tcpStartTime: number = 0;
  private tlsStartTime: number = 0;
  private firstByteTime: number = 0;
  private redirectChain: string[] = [];
  private lastCaptchaCheck: any = null;

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
      authRetryDelay: config.authRetryDelay ?? 3000,
      navigationTimeout: config.navigationTimeout ?? 120000,
      debugNavigation: config.debugNavigation ?? true
    };
    this.assets = this.config.assets || ['EUR/USD OTC'];
  }

  async initialize(): Promise<void> {
    console.log('[Init] Config mockMode:', this.config.mockMode);
    console.log('[Init] Config debugNavigation:', this.config.debugNavigation);
    console.log('[Init] Config navigationTimeout:', this.config.navigationTimeout);
    
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
    console.log('[Browser] Launching Chromium with stealth configuration...');
    
    const launchArgs = [
      '--disable-blink-features=AutomationControlled',
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process',
      '--disable-site-isolation-trials',
      '--disable-dev-shm-usage',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-gpu',
      '--disable-software-rasterizer',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-features=TranslateUI',
      '--disable-ipc-flooding-protection',
      '--window-size=1920,1080',
      '--start-maximized',
      '--force-device-scale-factor=1',
      '--disable-extensions',
      '--disable-component-extensions-with-background-pages',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-infobars',
      '--disable-notifications',
      '--disable-popup-blocking',
      '--disable-default-apps',
      '--hide-scrollbars',
      '--mute-audio',
      '--disable-breakpad',
      '--disable-component-update',
      '--disable-domain-reliability',
      '--disable-sync',
      '--metrics-recording-only',
      '--no-report-upload',
      '--disable-background-networking',
      '--disable-client-side-phishing-detection',
      '--disable-hang-monitor',
      '--disable-prompt-on-repost',
      '--disable-domain-reliability',
      '--disable-component-extensions-with-background-pages',
      '--enable-features=NetworkService,NetworkServiceInProcess',
      '--disable-features=NetworkService',
      '--disable-features=NetworkServiceInProcess'
    ];

    this.browser = await chromium.launch({
      headless: this.config.headless ?? true,
      slowMo: this.config.slowMo ?? 0,
      args: launchArgs
    });

    console.log('[Browser] Chromium launched successfully');

    this.context = await this.browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 },
      deviceScaleFactor: 1,
      isMobile: false,
      hasTouch: false,
      locale: 'en-US',
      timezoneId: 'America/New_York',
      permissions: ['geolocation'],
      ignoreHTTPSErrors: true,
      javaScriptEnabled: true,
      bypassCSP: true,
      extraHTTPHeaders: {
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-User': '?1',
        'Sec-Fetch-Dest': 'document',
        'Cache-Control': 'max-age=0'
      }
    });

    console.log('[Browser] Context created with stealth configuration');

    // Anti-detection scripts
    this.context.addInitScript(() => {
      // Hide webdriver property
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      
      // Mock plugins
      Object.defineProperty(navigator, 'plugins', { 
        get: () => [
          { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer' },
          { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai' },
          { name: 'Native Client', filename: 'internal-nacl-plugin' }
        ] 
      });
      
      // Mock languages
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
      
      // Mock platform
      Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
      
      // Mock hardware concurrency
      Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
      
      // Mock device memory
      Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
      
      // Mock screen
      Object.defineProperty(screen, 'width', { get: () => 1920 });
      Object.defineProperty(screen, 'height', { get: () => 1080 });
      Object.defineProperty(screen, 'availWidth', { get: () => 1920 });
      Object.defineProperty(screen, 'availHeight', { get: () => 1040 });
      Object.defineProperty(screen, 'colorDepth', { get: () => 24 });
      Object.defineProperty(screen, 'pixelDepth', { get: () => 24 });
      
      // Remove automation indicators
      delete (window as any).__webdriverAsyncExecutor;
      delete (window as any).__webdriverScriptFn;
      delete (window as any).__webdriverTestRunner;
    });

    this.page = await this.context.newPage();
    this.page.on('console', msg => console.log('[Browser Console]', msg.text()));
    this.page.on('pageerror', err => console.error('[Browser Error]', err.message));

    // Request interception: abort analytics/tracking requests
    await this.setupRequestInterception();
  }

  private async setupRequestInterception(): Promise<void> {
    if (!this.page) return;

    const blockPatterns = [
      'googleads',
      'doubleclick',
      'facebook.net',
      'fbcdn.net',
      'googletagmanager',
      'gtm.',
      'analytics',
      'appsflyer',
      'googlesyndication',
      'googletagservices',
      'adnxs',
      'adroll',
      'taboola',
      'outbrain',
      'criteo',
      'hotjar',
      'mixpanel',
      'segment',
      'intercom',
      'zendesk',
      'drift',
      'crisp.chat',
      'tawk.to'
    ];

    await this.page.route('**/*', (route) => {
      const url = route.request().url().toLowerCase();
      const resourceType = route.request().resourceType();
      
      // CRITICAL: Never block Pocket Option's own resources or WebSocket-related requests
      const pocketOptionPatterns = [
        'pocketoption.com',
        'socket.io',
        'engine.io',
        'pocket-option',
        '/api/',
        '/ws',
        '/wss'
      ];
      
      const isPocketOption = pocketOptionPatterns.some(p => route.request().url().toLowerCase().includes(p));
      const isDocument = route.request().resourceType() === 'document';
      const isScript = route.request().resourceType() === 'script';
      const isStylesheet = route.request().resourceType() === 'stylesheet';
      const isXHR = route.request().resourceType() === 'xhr';
      const isFetch = route.request().resourceType() === 'fetch';
      const isWebSocket = route.request().resourceType() === 'websocket';
      
      // NEVER block Pocket Option resources or critical resource types
      if (isPocketOption || isDocument || isScript || isStylesheet || isXHR || isFetch || isWebSocket) {
        route.continue();
        return;
      }

      const shouldBlock = blockPatterns.some(pattern => url.includes(pattern));

      if (shouldBlock) {
        console.log('[Request Blocked] Blocked tracking resource:', route.request().url());
        route.abort('blockedbyclient');
      } else {
        route.continue();
      }
    });

    console.log('[Browser] Request interception enabled - blocking analytics/tracking (Pocket Option resources allowed)');
  }

  private async captureWebSocketEndpoint(): Promise<void> {
    if (!this.page) throw new Error('Page not initialized');

    const wsUrlPromise = new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('WebSocket capture timeout after 120s')), 120000);

      this.page!.on('websocket', ws => {
        const url = ws.url();
        console.log('[Phase 4] WebSocket detected:', url);
        if (url.includes('socket.io') || url.includes('engine.io') || url.includes('pocketoption') || url.includes('wss://')) {
          clearTimeout(timeout);
          console.log('[Phase 4] WebSocket URL captured:', url);
          (window as any).__WEBSOCKET_CREATED = true;
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

    // Try multiple URLs in order of preference
    const urlsToTry = [
      'https://pocketoption.com/en/',
      'https://pocketoption.com/en/demo/',
      'https://pocketoption.com/en/login/'
    ];

    let wsCaptured = false;
    let lastError: Error | null = null;

    for (const demoUrl of urlsToTry) {
      console.log(`[Phase 1] Trying URL: ${demoUrl}`);
      
      try {
        // Reset diagnostics for each attempt
        this.redirectChain = [];
        
        // Try navigation with instrumentation
        await this.navigateWithInstrumentation(demoUrl);
        
        // Phase 2: Wait for page ready
        await this.waitForPageReady();

        // Phase 3: Wait for trading app initialization
        await this.waitForTradingAppInit();

        // If we have credentials and not demo, login
        if (this.config.email && this.config.password && !this.config.isDemo) {
          await this.performLogin();
          await this.waitForPageReady();
        }

        // Wait for WebSocket to be established
        console.log('[Phase 4] Waiting for WebSocket connection...');
        const capturedWsUrl = await wsUrlPromise;
        this.wsUrl = this.extractWebSocketUrl(capturedWsUrl);
        console.log('[Phase 4] Final WebSocket URL:', this.wsUrl);
        wsCaptured = true;
        break;

      } catch (e) {
        lastError = e as Error;
        console.error(`[Navigation] Failed for ${demoUrl}:`, (e as Error).message);
        console.log('[Navigation] Trying next URL...');
        
        // Brief pause before retry
        await this.page!.waitForTimeout(3000);
      }
    }

    if (!wsCaptured) {
      // Final diagnostic capture
      const diag = await this.collectDiagnosticInfo();
      console.error('[Browser] All navigation attempts failed');
      console.error('[Browser] Final diagnostic:', JSON.stringify(diag, null, 2));
      throw new Error(`Failed to capture WebSocket after trying all URLs. Last error: ${lastError?.message}`);
    }
  }

  private async navigateWithInstrumentation(url: string): Promise<void> {
    if (!this.page) throw new Error('Page not initialized');
    
    console.log(`[Navigation] ===== PHASE 1: INITIAL NAVIGATION =====`);
    console.log(`[Navigation] Target URL: ${url}`);
    console.log('[Navigation] Using commit -> load -> domcontentloaded navigation strategy');
    
    // Reset timing for this navigation
    this.requestStartTime = Date.now();
    this.redirectChain = [];
    
    // Set up comprehensive event logging
    const requestStartTimes = new Map<string, number>();
    
    this.page!.on('request', request => {
      const url = request.url();
      requestStartTimes.set(url, Date.now());
      
      if (this.config.debugNavigation) {
        console.log(`[Navigation] Request: ${request.method()} ${url} (${request.resourceType()})`);
      }
    });

    this.page!.on('response', response => {
      const url = response.url();
      const startTime = requestStartTimes.get(url) || 0;
      const duration = Date.now() - startTime;
      
      if (this.config.debugNavigation) {
        console.log(`[Navigation] Response: ${response.status()} ${url} (${duration}ms)`);
      }
      
      // Track redirects
      if (response.status() >= 300 && response.status() < 400) {
        const redirectUrl = response.headers()['location'];
        if (redirectUrl) {
          this.redirectChain.push(redirectUrl);
          console.log(`[Navigation] Redirect: ${response.status()} -> ${redirectUrl}`);
        }
      }
    });

    this.page!.on('requestfailed', request => {
      console.error(`[Navigation] Request failed: ${request.method()} ${request.url()} - ${request.failure()?.errorText}`);
    });

    this.page!.on('framenavigated', frame => {
      console.log(`[Navigation] Frame navigated: ${frame.url()}`);
    });

    this.page!.on('console', msg => {
      if (this.config.debugNavigation) {
        console.log('[Browser Console]', msg.text());
      }
    });

    this.page!.on('pageerror', err => {
      console.error('[Browser Page Error]', err.message);
    });

    // Capture timing data
    this.requestStartTime = Date.now();
    this.dnsStartTime = Date.now();

    try {
      // Try multiple waitUntil strategies in order of robustness
      const waitStrategies: Array<'commit' | 'load' | 'domcontentloaded'> = ['commit', 'load', 'domcontentloaded'];
      let navigationSuccess = false;
      let lastError: Error | null = null;

      for (const waitUntil of waitStrategies) {
        try {
          console.log(`[Navigation] Attempting with waitUntil: ${waitUntil}`);
          
          const response = await this.page!.goto(url, { 
            waitUntil, 
            timeout: this.config.navigationTimeout 
          });

          if (response) {
            const timing = await this.captureTimingMetrics(response);
            this.logNavigationTiming(timing);
            
            // Check for anti-bot challenges
            await this.detectAntiBotChallenges();
            
            navigationSuccess = true;
            console.log(`[Navigation] Success with ${waitUntil}: ${response.status()} ${response.url()}`);
            break;
          }
        } catch (e) {
          lastError = e as Error;
          console.log(`[Navigation] ${waitUntil} failed:`, (e as Error).message);
        }
      }

      if (!navigationSuccess) {
        throw lastError || new Error('All navigation strategies failed');
      }

      // Final URL after all redirects
      const finalUrl = this.page!.url();
      console.log(`[Navigation] Final URL: ${finalUrl}`);
      console.log(`[Navigation] Redirect chain: ${this.redirectChain.join(' -> ') || 'none'}`);

      // CRITICAL: Check for CAPTCHA/challenge pages after navigation
      await this.detectCaptchaAndChallengePages();
      
      // Capture screenshot and HTML for diagnostics
      await this.captureDiagnostics();

    } catch (e) {
      console.error('[Navigation] Fatal navigation error:', (e as Error).message);
      await this.captureDiagnostics();
      throw e;
    }
  }

  private async captureTimingMetrics(response: Response): Promise<any> {
    if (!this.page) return null;
    
    try {
      const timing = await this.page.evaluate(() => {
        const entries = performance.getEntriesByType('navigation') as PerformanceNavigationTiming[];
        if (entries.length > 0) {
          const nav = entries[0];
          return {
            dnsLookup: nav.domainLookupEnd - nav.domainLookupStart,
            tcpConnect: nav.connectEnd - nav.connectStart,
            tlsHandshake: nav.secureConnectionStart > 0 ? nav.connectEnd - nav.secureConnectionStart : 0,
            firstByte: nav.responseStart - nav.requestStart,
            responseHeaders: nav.responseEnd - nav.responseStart,
            totalTime: nav.loadEventEnd - nav.fetchStart,
            httpStatus: 0, // Not available in Navigation Timing API
            redirectCount: performance.navigation?.redirectCount || 0
          };
        }
        return null;
      });
      return timing;
    } catch (e) {
      return { error: String(e) };
    }
  }

  private logNavigationTiming(timing: any): void {
    if (!timing || timing.error) {
      console.log('[Navigation] Timing unavailable:', timing?.error);
      return;
    }
    
    console.log('[Navigation] Timing Metrics:');
    console.log(`  DNS Lookup: ${timing.dnsLookup}ms`);
    console.log(`  TCP Connect: ${timing.tcpConnect}ms`);
    console.log(`  TLS Handshake: ${timing.tlsHandshake}ms`);
    console.log(`  First Byte: ${timing.firstByte}ms`);
    console.log(`  Response Headers: ${timing.responseHeaders}ms`);
    console.log(`  Total Time: ${timing.totalTime}ms`);
    console.log(`  Redirects: ${timing.redirectCount}`);
  }

  private async detectAntiBotChallenges(): Promise<void> {
    if (!this.page) return;

    try {
      const checks = await this.page.evaluate(() => {
        const body = document.body?.innerText || '';
        const html = document.documentElement.outerHTML;
        
        return {
          isCloudflare: html.includes('cloudflare') || html.includes('__cf_') || document.title.includes('Cloudflare'),
          isCaptcha: html.includes('captcha') || document.querySelector('iframe[src*="captcha"]') !== null || document.querySelector('[id*="captcha"]') !== null || document.querySelector('[data-sitekey]') !== null,
          is403: document.body?.innerText.includes('403') || document.title.includes('403'),
          is429: document.body?.innerText.includes('429') || document.title.includes('429'),
          isBlocked: body.includes('blocked') || body.includes('access denied') || body.includes('unusual traffic'),
          title: document.title,
          url: window.location.href,
          readyState: document.readyState,
          bodyLength: document.body?.innerText?.length || 0
        };
      });

      this.lastCaptchaCheck = checks;
      console.log('[Anti-Bot Check]:', JSON.stringify(checks, null, 2));
      
      if (checks.isCloudflare) {
        console.warn('[Anti-Bot] Cloudflare challenge detected!');
      }
      if (checks.isCaptcha) {
        console.warn('[Anti-Bot] CAPTCHA detected!');
      }
      if (checks.is403) {
        console.warn('[Anti-Bot] 403 Forbidden detected!');
      }
      if (checks.is429) {
        console.warn('[Anti-Bot] 429 Rate Limited!');
      }
      if (checks.isBlocked) {
        console.warn('[Anti-Bot] Possible blocking detected!');
      }
    } catch (e) {
      console.log('[Anti-Bot Check] Error:', (e as Error).message);
    }
  }

  private async detectCaptchaAndChallengePages(): Promise<void> {
    if (!this.page) return;
    
    console.log('[Navigation] ===== PHASE 2: CAPTCHA/CHALLENGE DETECTION =====');
    
    try {
      const checks = await this.page.evaluate(() => {
        const html = document.documentElement.outerHTML;
        const body = document.body?.innerText || '';
        const scripts = Array.from(document.querySelectorAll('script')).map(s => s.src).filter(Boolean);
        
        return {
          // CAPTCHA detection
          hasRecaptcha: document.querySelector('iframe[src*="recaptcha"]') !== null ||
                       document.querySelector('[data-sitekey]') !== null ||
                       html.includes('recaptcha') || html.includes('grecaptcha'),
          hasHCaptcha: html.includes('hcaptcha') || document.querySelector('iframe[src*="hcaptcha"]') !== null,
          hasTurnstile: html.includes('turnstile') || document.querySelector('[data-sitekey*="turnstile"]') !== null,
          
          // Challenge pages
          isCloudflare: document.documentElement.outerHTML.includes('cloudflare') || 
                       document.title.includes('Cloudflare') ||
                       document.querySelector('meta[name="cf-ray"]') !== null,
          isChallengePage: document.body?.innerText.includes('challenge') ||
                          document.title.includes('Challenge') ||
                          document.title.includes('Cloudflare') ||
                          document.body?.innerText.includes('Checking your browser') ||
                          document.body?.innerText.includes('Please wait'),
          
          // HTTP errors
          is403: document.body?.innerText.includes('403') || document.title.includes('403'),
          is429: document.body?.innerText.includes('429') || document.title.includes('429'),
          
          // Generic blocking
          isBlocked: document.body?.innerText.includes('blocked') || 
                    document.body?.innerText.includes('access denied') || 
                    document.body?.innerText.includes('unusual traffic') ||
                    document.body?.innerText.includes('automated'),
          
          // JavaScript frameworks
          hasReact: typeof (window as any).React !== 'undefined' || document.querySelector('[data-reactroot]') !== null,
          hasVue: typeof (window as any).Vue !== 'undefined' || document.querySelector('[data-v-]') !== null,
          
          // Socket.IO/Engine.IO
          hasSocketIO: typeof (window as any).io !== 'undefined',
          hasEngineIO: typeof (window as any).eio !== 'undefined',
          
          // Page state
          title: document.title,
          url: window.location.href,
          readyState: document.readyState,
          bodyLength: document.body?.innerText?.length || 0,
          scriptCount: document.scripts.length,
          
          // External scripts loaded
          externalScripts: Array.from(document.querySelectorAll('script[src]')).map(s => (s as HTMLScriptElement).src)
        };
      });

      console.log('[CAPTCHA/Challenge Detection]:', JSON.stringify(checks, null, 2));
      
      // Log critical findings
      if (checks.isCloudflare) console.warn('[CAPTCHA] Cloudflare challenge detected!');
      if (checks.hasRecaptcha) console.warn('[CAPTCHA] reCAPTCHA detected!');
      if (checks.hasHCaptcha) console.warn('[CAPTCHA] hCaptcha detected!');
      if (checks.hasTurnstile) console.warn('[CAPTCHA] Turnstile detected!');
      if (checks.isChallengePage) console.warn('[CAPTCHA] Challenge page detected!');
      if (checks.is403) console.warn('[CAPTCHA] 403 Forbidden!');
      if (checks.is429) console.warn('[CAPTCHA] 429 Rate Limited!');
      if (checks.isBlocked) console.warn('[CAPTCHA] Possible blocking detected!');
      
      // Check for Pocket Option app initialization
      if (checks.hasSocketIO || checks.hasReact || checks.hasVue) {
        console.log('[App Init] Pocket Option application scripts detected');
      } else {
        console.warn('[App Init] Pocket Option application NOT detected - CAPTCHA/challenge likely blocking');
      }
      
      // Store for later use
      this.lastCaptchaCheck = checks;

    } catch (e) {
      console.log('[CAPTCHA Detection] Error:', (e as Error).message);
    }
  }

  private async captureDiagnostics(): Promise<void> {
    if (!this.page) return;
    
    try {
      console.log('[Diagnostics] Capturing page state...');
      
      // Screenshot
      const screenshotBuffer = await this.page.screenshot({ fullPage: true });
      const fs = require('fs');
      const screenshotPath = `/tmp/pocketoption-diagnostic-${Date.now()}.png`;
      fs.writeFileSync(screenshotPath, screenshotBuffer);
      console.log(`[Diagnostics] Screenshot saved: ${screenshotPath}`);

      // HTML snapshot
      const html = await this.page.content();
      const htmlPath = `/tmp/pocketoption-diagnostic-${Date.now()}.html`;
      fs.writeFileSync(htmlPath, html);
      console.log(`[Diagnostics] HTML saved: ${htmlPath} (${html.length} bytes)`);

      // Include CAPTCHA check info
      if (this.lastCaptchaCheck) {
        console.log('[Diagnostics] CAPTCHA check:', JSON.stringify(this.lastCaptchaCheck, null, 2));
      }

    } catch (e) {
      console.error('[Diagnostics] Error capturing diagnostics:', (e as Error).message);
    }
  }

  private async waitForPageReady(): Promise<void> {
    if (!this.page) return;

    console.log('[Phase 2] Waiting for document ready and localStorage...');

    try {
      // Wait for document ready state
      await this.page.waitForFunction(() => document.readyState === 'complete', { timeout: 30000 });
      console.log('[Phase 2] Document readyState: complete');

      // Wait for localStorage to be accessible and have token
      await this.page.waitForFunction(() => {
        try {
          const token = localStorage.getItem('token') || localStorage.getItem('token_demo') || sessionStorage.getItem('token');
          return !!token;
        } catch (e) {
          return false;
        }
      }, { timeout: 30000 });
      console.log('[Phase 2] localStorage/sessionStorage token found');

      // Wait for body to be present
      await this.page.waitForSelector('body', { timeout: 10000 });
      
    } catch (e) {
      // Log diagnostic info on failure
      const diag = await this.collectDiagnosticInfo();
      console.error('[Phase 2] waitForPageReady failed:', e);
      console.error('[Phase 2] Diagnostic info:', JSON.stringify(diag, null, 2));
      throw e;
    }
  }

  private async waitForTradingAppInit(): Promise<void> {
    if (!this.page) return;

    console.log('[Phase 3] Waiting for trading application initialization...');

    try {
      // Wait for Socket.IO or Engine.IO scripts to load
      console.log('[Phase 3] Waiting for Socket.IO/Engine.IO scripts...');
      await this.page.waitForFunction(() => {
        return typeof (window as any).io !== 'undefined' || 
               typeof (window as any).eio !== 'undefined' ||
               document.querySelector('script[src*="socket.io"]') !== null ||
               document.querySelector('script[src*="engine.io"]') !== null;
      }, { timeout: 60000 });
      console.log('[Phase 3] Socket.IO/Engine.IO scripts loaded');

      // Wait for Pocket Option app to initialize (look for trading interface or WebSocket creation)
      console.log('[Phase 3] Waiting for trading interface or WebSocket initialization...');
      await Promise.race([
        this.page.waitForSelector('canvas, .chart-container, .trading-chart, [class*="chart"]', { timeout: 30000 }),
        this.page.waitForFunction(() => {
          // Check if WebSocket was created by the page
          return (window as any).__WEBSOCKET_CREATED === true ||
                 (window as any).__POCKET_OPTION_INITIALIZED === true;
        }, { timeout: 30000 })
      ]).catch(() => {
        console.log('[Phase 3] Trading interface/WS initialization timeout - continuing anyway');
      });

      console.log('[Phase 3] Trading application initialization complete');

    } catch (e) {
      console.error('[Phase 3] waitForTradingAppInit failed:', (e as Error).message);
      // Don't throw - continue and let WebSocket capture attempt
    }
  }

  private async collectDiagnosticInfo(): Promise<any> {
    if (!this.page) return {};

    try {
      return await this.page.evaluate(() => {
        const info: any = {
          readyState: document.readyState,
          url: window.location.href,
          title: document.title,
          localStorage: {},
          sessionStorage: {},
          cookies: document.cookie,
          bodyExists: !!document.body,
          bodyChildren: document.body?.children.length || 0,
          scripts: document.scripts.length,
          errors: (window as any).__pageErrors || []
        };

        // Safe localStorage dump
        try {
          for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key) info.localStorage[key] = localStorage.getItem(key)?.substring(0, 50) + '...';
          }
        } catch (e) {
          info.localStorageError = String(e);
        }

        try {
          for (let i = 0; i < sessionStorage.length; i++) {
            const key = sessionStorage.key(i);
            if (key) info.sessionStorage[key] = sessionStorage.getItem(key)?.substring(0, 50) + '...';
          }
        } catch (e) {
          info.sessionStorageError = String(e);
        }

        return info;
      });
    } catch (e) {
      return { error: String(e) };
    }
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