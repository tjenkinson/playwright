/**
 * Copyright Microsoft Corporation. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { config } from '@playwright/test-runner';
import assert from 'assert';
import childProcess from 'child_process';
import fs from 'fs';
import path from 'path';
import util from 'util';
import type { Browser, BrowserContext, BrowserType, Page } from '../index';
import { Connection } from '../lib/client/connection';
import { Transport } from '../lib/protocol/transport';
import { installCoverageHooks } from './coverage';
import { fixtures as httpFixtures } from './http.fixtures';
import { fixtures as implFixtures } from './impl.fixtures';
import { fixtures as platformFixtures } from './platform.fixtures';
import { fixtures as playwrightFixtures } from './playwright.fixtures';
export { expect } from '@playwright/test/out/matcher.fixtures';
export { config } from '@playwright/test-runner';

const removeFolderAsync = util.promisify(require('rimraf'));

type AllParameters = {
  wire: boolean;
};

type AllWorkerFixtures = {
  golden: (path: string) => string;
};

type AllTestFixtures = {
  createUserDataDir: () => Promise<string>;
  launchPersistent: (options?: Parameters<BrowserType<Browser>['launchPersistentContext']>[1]) => Promise<{context: BrowserContext, page: Page}>;
};

export const fixtures = playwrightFixtures
    .union(httpFixtures)
    .union(platformFixtures)
    .union(implFixtures)
    .declareParameters<AllParameters>()
    .declareWorkerFixtures<AllWorkerFixtures>()
    .declareTestFixtures<AllTestFixtures>();

export const it = fixtures.it;
export const fit = fixtures.fit;
export const xit = fixtures.xit;
export const describe = fixtures.describe;
export const fdescribe = fixtures.fdescribe;
export const xdescribe = fixtures.xdescribe;
export const beforeEach = fixtures.beforeEach;
export const afterEach = fixtures.afterEach;
export const beforeAll = fixtures.beforeAll;
export const afterAll = fixtures.afterAll;

fixtures.defineParameter('wire', 'Wire testing mode', !!process.env.PWWIRE || false);

const getExecutablePath = browserName => {
  if (browserName === 'chromium' && process.env.CRPATH)
    return process.env.CRPATH;
  if (browserName === 'firefox' && process.env.FFPATH)
    return process.env.FFPATH;
  if (browserName === 'webkit' && process.env.WKPATH)
    return process.env.WKPATH;
};

fixtures.overrideWorkerFixture('defaultBrowserOptions', async ({ browserName, headful, slowMo }, runTest) => {
  const executablePath = getExecutablePath(browserName);
  if (executablePath)
    console.error(`Using executable at ${executablePath}`);
  await runTest({
    executablePath,
    handleSIGINT: false,
    slowMo,
    headless: !headful,
    artifactsPath: config.outputDir,
  });
});

fixtures.overrideWorkerFixture('playwright', async ({ browserName, testWorkerIndex, platform, wire }, runTest) => {
  assert(platform); // Depend on platform to generate all tests.
  const {coverage, uninstall} = installCoverageHooks(browserName);
  if (wire) {
    require('../lib/utils/utils').setUnderTest();
    const connection = new Connection();
    const spawnedProcess = childProcess.fork(path.join(__dirname, '..', 'lib', 'server.js'), [], {
      stdio: 'pipe',
      detached: true,
    });
    spawnedProcess.unref();
    const onExit = (exitCode, signal) => {
      throw new Error(`Server closed with exitCode=${exitCode} signal=${signal}`);
    };
    spawnedProcess.on('exit', onExit);
    const transport = new Transport(spawnedProcess.stdin, spawnedProcess.stdout);
    connection.onmessage = message => transport.send(JSON.stringify(message));
    transport.onmessage = message => connection.dispatch(JSON.parse(message));
    const playwrightObject = await connection.waitForObjectWithKnownName('Playwright');
    await runTest(playwrightObject);
    spawnedProcess.removeListener('exit', onExit);
    spawnedProcess.stdin.destroy();
    spawnedProcess.stdout.destroy();
    spawnedProcess.stderr.destroy();
    await teardownCoverage();
  } else {
    const playwright = require('../index');
    await runTest(playwright);
    await teardownCoverage();
  }

  async function teardownCoverage() {
    uninstall();
    const coveragePath = path.join(__dirname, 'coverage-report', testWorkerIndex + '.json');
    const coverageJSON = [...coverage.keys()].filter(key => coverage.get(key));
    await fs.promises.mkdir(path.dirname(coveragePath), { recursive: true });
    await fs.promises.writeFile(coveragePath, JSON.stringify(coverageJSON, undefined, 2), 'utf8');
  }
});

fixtures.defineWorkerFixture('golden', async ({browserName}, test) => {
  await test(p => path.join(browserName, p));
});

fixtures.defineTestFixture('createUserDataDir', async ({testOutputDir}, runTest) => {
  let counter = 0;
  const dirs: string[] = [];
  async function createUserDataDir() {
    const dir = path.join(testOutputDir, `user-data-dir-${counter++}`);
    dirs.push(dir);
    await fs.promises.mkdir(dir, { recursive: true });
    return dir;
  }
  await runTest(createUserDataDir);
  // Remove user data dirs, because we cannot upload them as test result artifacts.
  // - Firefox removes lock file later, repsumably from another watchdog process?
  // - WebKit has circular symlinks that makes CI go crazy.
  await Promise.all(dirs.map(dir => removeFolderAsync(dir).catch(e => {})));
});

fixtures.defineTestFixture('launchPersistent', async ({createUserDataDir, defaultBrowserOptions, browserType}, test) => {
  let context;
  async function launchPersistent(options) {
    if (context)
      throw new Error('can only launch one persitent context');
    const userDataDir = await createUserDataDir();
    context = await browserType.launchPersistentContext(userDataDir, {...defaultBrowserOptions, ...options});
    const page = context.pages()[0];
    return {context, page};
  }
  await test(launchPersistent);
  if (context)
    await context.close();
});
