// Steam periodically runs "Free to Keep" promotions: a normally paid game is 100% off for a few days
// and can permanently be added to your account while the promotion lasts. This script signs in
// interactively (with Steam Guard support), finds those games and claims them.
// Permanently free-to-play games are not claimed (excluded via `hidef2p=1`).

import { launchContext } from './src/browser.js';
import { jsonDb, datetime, filenamify, prompt, confirm, notify, html_game_list, handleSIGINT } from './src/util.js';
import { cfg } from './src/config.js';

// using https://github.com/apify/fingerprint-suite worked, but has no launchPersistentContext...
// from https://github.com/apify/fingerprint-suite/issues/162
import { FingerprintInjector } from 'fingerprint-injector';
import { FingerprintGenerator } from 'fingerprint-generator';

console.log(datetime(), 'started checking steam');

const db = await jsonDb('steam.json', {});

const URL_STORE = 'https://store.steampowered.com/?cc=us&l=english';
const URL_LOGIN = 'https://store.steampowered.com/login/';
// `specials=1` + `maxprice=free` -> only items that are currently 100% off; `hidef2p=1` excludes permanently
// free-to-play games, `category1=998` limits the results to games (no software/soundtracks)
const URL_FREE = 'https://store.steampowered.com/search/?sort_by=Reviews_DESC&maxprice=free&specials=1&hidef2p=1&ndl=1&category1=998&cc=us&l=english';

const { fingerprint, headers } = new FingerprintGenerator().getFingerprint({
  devices: ['desktop'],
  operatingSystems: ['windows'],
});

const context = await launchContext(cfg, {
  channel: 'chrome',
  headless: cfg.headless,
  locale: 'en-US', // ignore OS locale to be sure to have english text for locators -> done via /en in URL
  userAgent: fingerprint.navigator.userAgent,
  viewport: {
    width: fingerprint.screen.width,
    height: fingerprint.screen.height,
  },
  extraHTTPHeaders: {
    'accept-language': headers['accept-language'],
  },
  recordVideo: cfg.record ? { dir: 'data/record/', size: { width: cfg.width, height: cfg.height } } : undefined, // will record a .webm video for each page navigated; without size, video would be scaled down to fit 800x800
  recordHar: cfg.record ? { path: `data/record/steam-${filenamify(datetime())}.har` } : undefined, // will record a HAR file with network requests and responses; can be imported in Chrome devtools
  handleSIGINT: false, // have to handle ourselves and call context.close(), otherwise recordings from above won't be saved
});
handleSIGINT(context);
await new FingerprintInjector().attachFingerprintToPlaywright(context, { fingerprint, headers });

if (!cfg.debug) context.setDefaultTimeout(cfg.timeout);

const page = context.pages().length ? context.pages()[0] : await context.newPage(); // should always exist

// The store's global header shows the account when signed in and a "sign in" link when not
const isSignedIn = async () => await page.locator('#account_pulldown').count() > 0;

// Steam's new login form uses hashed CSS-module classes, but the visible label texts are stable,
// so use accessible names instead of the generated class names
const signIn = async () => {
  console.error('Not signed in anymore.');
  await page.goto(URL_LOGIN, { waitUntil: 'domcontentloaded' });
  if (!cfg.debug) context.setDefaultTimeout(cfg.login_timeout); // give the user extra time to log in
  console.info(`Login timeout is ${cfg.login_timeout / 1000} seconds!`);
  if (cfg.steam_username && cfg.steam_password) console.info('Using account name and password from environment.');
  else console.info('Press ESC to skip the prompts if you want to login in the browser (not possible in headless mode).');
  const username = cfg.steam_username || await prompt({ message: 'Enter Steam account name' });
  const password = username && (cfg.steam_password || await prompt({ type: 'password', message: 'Enter password' }));
  if (!password) {
    console.log('Waiting for you to login in the browser.');
    await notify('steam: no longer signed in and not enough options set for automatic login.');
  } else {
    await page.getByLabel(/account name/i).fill(username);
    await page.getByLabel('Password').fill(password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    // Steam Guard can require a code sent by email (#authcode), a code from the mobile authenticator
    // (#twofactorcode_entry), or an approval in the Steam mobile app (no input field at all).
    console.log('Waiting for Steam Guard: approve the logon in your Steam mobile app, or enter the code if Steam asks for one.');
    await Promise.any([
      page.locator('#authcode').waitFor({ state: 'visible' }),
      page.locator('#twofactorcode_entry').waitFor({ state: 'visible' }),
      page.locator('#account_pulldown').waitFor({ state: 'attached' }), // no Steam Guard required
    ]).catch(_ => { }); // none appeared (yet), e.g. waiting for approval in the mobile app or a wrong password
    const twoFactor = page.locator('#twofactorcode_entry');
    const emailCode = page.locator('#authcode');
    if (await twoFactor.isVisible().catch(_ => false) || await emailCode.isVisible().catch(_ => false)) {
      const useEmailCode = !await twoFactor.isVisible().catch(_ => false);
      console.log(useEmailCode ? 'Steam Guard - Enter the code sent to your email.' : 'Steam Guard - Enter the code from your mobile authenticator.');
      const code = await prompt({ message: 'Enter Steam Guard code' });
      const field = useEmailCode ? emailCode : twoFactor;
      await field.fill(code);
      await field.press('Enter');
    } else if (!await isSignedIn()) {
      console.log('No code requested - approve the logon in your Steam mobile app. Waiting until signed in...');
    }
  }
  // wait until we are signed in again, no matter whether automatically or manually in the browser
  await page.waitForSelector('#account_pulldown', { timeout: cfg.login_timeout }).catch(_ => { });
};

try {
  await page.goto(URL_STORE, { waitUntil: 'domcontentloaded' });
  if (!await isSignedIn()) await signIn();
  if (!await isSignedIn()) throw new Error('Steam: not signed in.');
  const user = (await page.locator('#account_pulldown').innerText()).trim();
  console.log(`Signed in as ${user}`);
  db.data[user] ||= {};

  await page.goto(URL_FREE, { waitUntil: 'domcontentloaded' });
  const rows = page.locator('a.search_result_row');
  await rows.first().waitFor().catch(_ => { }); // there may be no free to keep game at the moment
  const games = [];
  for (const row of await rows.all()) {
    const discount = await row.locator('.discount_pct').first().innerText().catch(_ => '');
    if (!discount.includes('-100%')) continue; // free to keep games are 100% off, currently discounted ones may be listed as well
    games.push({
      appid: (await row.getAttribute('data-ds-appid') || '').split(',')[0], // may hold several ids for bundles
      title: (await row.locator('.title').first().innerText()).trim(),
      url: await row.getAttribute('href'),
    });
  }
  console.log('Free to keep games:', games.length);

  const notify_games = []; // collect games for notification
  for (const game of games) {
    console.log('Current free game:', game.title);
    if (db.data[user][game.title]?.status == 'claimed') {
      console.log('  Already claimed.');
      continue; // don't notify or touch the db entry again
    }
    const notify_game = { title: game.title, url: game.url, status: 'failed: not claimed' };
    notify_games.push(notify_game);
    await page.goto(game.url, { waitUntil: 'domcontentloaded' });
    if (cfg.debug) await page.pause();
    // when already owned, the purchase area shows a different block and there is no claim button
    const claim = page.locator('.btn_addtocart a[href*="addToCart"], #add_to_cart');
    if (!await claim.count()) {
      notify_game.status = 'existed';
      continue;
    }
    // free to keep games use "Add to Account" instead of "Add to Cart"
    const claimText = (await claim.first().innerText()).trim();
    console.log('  Claim button:', claimText);
    if (!(/add to account/i).test(claimText)) {
      notify_game.status = 'failed: not free to keep anymore';
      continue;
    }
    if (cfg.dryrun) {
      notify_game.status = 'skipped (dryrun)';
      continue;
    }
    if (cfg.interactive && !await confirm({ message: `Claim "${game.title}"?` })) {
      notify_game.status = 'skipped (interactive)';
      continue;
    }
    // the button runs `javascript:addToCart(<packageid>)`, which posts to /checkout/addfreelicense/
    const response = page.waitForResponse(r => r.url().includes('/checkout/addfreelicense/'), { timeout: cfg.timeout }).catch(_ => null);
    await claim.first().click();
    const result = await response;
    if (result) {
      const json = await result.json().catch(_ => null);
      console.log('  Response:', JSON.stringify(json));
      notify_game.status = json?.success == 1 ? 'claimed' : `failed: ${JSON.stringify(json)}`;
    } else {
      notify_game.status = 'failed: no response from addfreelicense';
    }
  }

  if (notify_games.length) await notify(html_game_list(notify_games));
  for (const g of notify_games) db.data[user][g.title] = { title: g.title, time: datetime(), url: g.url, status: g.status };
} catch (error) {
  process.exitCode ||= 1;
  console.error('--- Exception:');
  console.error(error); // .toString()?
} finally {
  await db.write(); // write out json db
}
if (page.video()) console.log('Recorded video:', await page.video().path());
await context.close();
