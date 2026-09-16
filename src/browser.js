// Browser automation engines that can be used to run the storefront scripts.
// Each entry maps the value of the AUTOMATION option to the npm package to load
// and the browser type to launch. Adding another Playwright-compatible library
// only requires a new entry here - the storefront scripts stay the same.
const ENGINES = {
  patchright: {
    package: 'patchright',
    browser: 'chromium',
    install: 'npm install && npx patchright install chrome',
  },
  playwright: {
    package: 'playwright',
    browser: 'chromium',
    install: 'npm install playwright && npx playwright install chrome',
  },
};

/**
 * Launches a persistent browser context with the automation engine selected via
 * the AUTOMATION option (default: patchright). Options are passed through as-is,
 * so the storefront scripts don't need to know which library is used.
 * `cfg` is passed in by the caller (instead of importing src/config.js here) to
 * avoid a circular import while config.js and util.js are still initializing.
 * @param {object} cfg the loaded configuration (src/config.js)
 * @param {object} options options for `launchPersistentContext` (without the user data dir)
 * @returns {Promise<object>} the launched browser context
 */
export const launchContext = async (cfg, options) => {
  const engine = ENGINES[cfg.automation];
  if (!engine) {
    throw new Error(`Unknown AUTOMATION "${cfg.automation}". Supported values: ${Object.keys(ENGINES).join(', ')}.`);
  }
  let module;
  try {
    module = await import(engine.package);
  } catch (error) {
    // Give a clear error instead of the obscure "Cannot find package" module error
    if (error?.code == 'ERR_MODULE_NOT_FOUND') {
      throw new Error(`Browser automation "${cfg.automation}" is not installed. Install it with: ${engine.install}`);
    }
    throw error;
  }
  const browser = module[engine.browser];
  if (!browser) {
    throw new Error(`Package "${engine.package}" does not export "${engine.browser}".`);
  }
  return browser.launchPersistentContext(cfg.dir.browser, options);
};
