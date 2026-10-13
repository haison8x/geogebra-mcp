// Owns the browser that shows GeoGebra Calculator. Launches lazily on the first tool call,
// relaunches (and restores the last known figure) if the user closes the window, serializes
// all page access, and keeps an XML history for undo plus named snapshots.
import { chromium, type BrowserContext, type Page } from 'playwright';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

export type Config = {
  url: string;
  headless: boolean;
  channel: string | undefined;
  profileDir: string;
};

export function loadConfig(): Config {
  return {
    url: process.env.GGB_URL || 'https://www.geogebra.org/calculator',
    headless: /^(1|true|yes)$/i.test(process.env.GGB_HEADLESS || ''),
    channel: process.env.GGB_BROWSER || undefined,
    profileDir: process.env.GGB_PROFILE_DIR || join(homedir(), '.geogebra-mcp', 'profile'),
  };
}

const HISTORY_LIMIT = 50;

export class GeoGebraSession {
  private ctx: BrowserContext | null = null;
  private page: Page | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private lastXml: string | null = null;
  private history: string[] = [];
  private snapshots = new Map<string, string>();
  /** Set when the page was (re)opened and the last known figure was restored into it. */
  private notice: string | null = null;

  constructor(private readonly config: Config) {}

  /** Run `fn` with exclusive access to a ready GeoGebra page. */
  run<T>(fn: (page: Page) => Promise<T>): Promise<T> {
    const next = this.queue.then(async () => {
      const page = await this.ensurePage();
      const result = await fn(page);
      await this.remember(page);
      return result;
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Like run(), but first pushes the current figure onto the undo history. */
  mutate<T>(fn: (page: Page) => Promise<T>): Promise<T> {
    return this.run(async (page) => {
      this.history.push(await this.getXml(page));
      if (this.history.length > HISTORY_LIMIT) this.history.shift();
      return fn(page);
    });
  }

  /** Message to surface to the AI once (e.g. "browser was reopened"). */
  takeNotice(): string | null {
    const n = this.notice;
    this.notice = null;
    return n;
  }

  undo(steps: number): Promise<number> {
    return this.run(async (page) => {
      let xml: string | undefined;
      let done = 0;
      while (done < steps && this.history.length > 0) {
        xml = this.history.pop();
        done++;
      }
      if (xml !== undefined) await this.setXml(page, xml);
      return done;
    });
  }

  saveSnapshot(name: string): Promise<void> {
    return this.run(async (page) => {
      this.snapshots.set(name, await this.getXml(page));
    });
  }

  restoreSnapshot(name: string): Promise<boolean> {
    const xml = this.snapshots.get(name);
    if (xml === undefined) return Promise.resolve(false);
    return this.mutate(async (page) => {
      await this.setXml(page, xml);
      return true;
    });
  }

  listSnapshots(): string[] {
    return [...this.snapshots.keys()];
  }

  async close(): Promise<void> {
    const ctx = this.ctx;
    this.ctx = null;
    this.page = null;
    await ctx?.close().catch(() => undefined);
  }

  getXml(page: Page): Promise<string> {
    return page.evaluate(() => window.ggbApplet.getXML() as string);
  }

  async setXml(page: Page, xml: string): Promise<void> {
    await page.evaluate((x) => window.ggbApplet.setXML(x), xml);
  }

  private async remember(page: Page): Promise<void> {
    try {
      this.lastXml = await this.getXml(page);
    } catch {
      // Page went away mid-call; keep the previous copy.
    }
  }

  private async ensurePage(): Promise<Page> {
    if (this.page && !this.page.isClosed()) {
      const alive = await this.page
        .evaluate(() => !!(window.ggbApplet && typeof window.ggbApplet.evalCommand === 'function'))
        .catch(() => false);
      if (alive) return this.page;
      // The user navigated away or reloaded: go back to the calculator in the same window.
      return this.openCalculator(this.page);
    }
    if (!this.ctx) this.ctx = await this.launch();
    const page = this.ctx.pages()[0] ?? (await this.ctx.newPage());
    return this.openCalculator(page);
  }

  private async openCalculator(page: Page): Promise<Page> {
    if (!page.url().startsWith(this.config.url)) {
      await page.goto(this.config.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    }
    await page.waitForFunction(
      () => !!(window.ggbApplet && typeof window.ggbApplet.evalCommand === 'function'),
      null,
      { timeout: 60_000 },
    );
    await page.evaluate(() => window.ggbApplet.setErrorDialogsActive(false));
    page.on('close', () => {
      if (this.page === page) this.page = null;
    });
    this.page = page;
    if (this.lastXml) {
      await this.setXml(page, this.lastXml);
      this.notice =
        'The GeoGebra window had been closed or reloaded; it was reopened and the last figure known to this server was restored. ' +
        'Edits made by hand after the last tool call may be lost — call ggb_get_state to see the current figure.';
    }
    return page;
  }

  private async launch(): Promise<BrowserContext> {
    mkdirSync(this.config.profileDir, { recursive: true });
    // Prefer a browser already installed on the machine; fall back to Playwright's Chromium.
    const channels = this.config.channel ? [this.config.channel] : ['chrome', 'msedge', undefined];
    let lastError: unknown;
    for (const channel of channels) {
      try {
        const ctx = await chromium.launchPersistentContext(this.config.profileDir, {
          channel,
          headless: this.config.headless,
          viewport: this.config.headless ? { width: 1280, height: 800 } : null,
          args: this.config.headless ? [] : ['--window-size=1280,860'],
        });
        ctx.on('close', () => {
          if (this.ctx === ctx) {
            this.ctx = null;
            this.page = null;
          }
        });
        console.error(`[geogebra-mcp] browser launched (${channel ?? 'playwright chromium'})`);
        return ctx;
      } catch (e) {
        lastError = e;
        const msg = String((e as Error)?.message ?? e);
        // A locked profile will fail for every channel — no point trying the others.
        if (/ProcessSingleton|profile.*in use|user data directory is already in use/i.test(msg)) {
          throw new Error(
            `The browser profile ${this.config.profileDir} is already in use (another geogebra-mcp instance?). ` +
              `Close it or set GGB_PROFILE_DIR to a different folder.`,
          );
        }
      }
    }
    throw new Error(
      `Could not launch a browser (tried Chrome, Edge, Playwright Chromium). Install Chrome, or run "npx playwright install chromium". ` +
        `Last error: ${String((lastError as Error)?.message ?? lastError)}`,
    );
  }
}
