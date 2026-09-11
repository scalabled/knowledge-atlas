import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { BrowserKind } from '../lib/env'

type BrandedBrowser = Exclude<BrowserKind, 'chromium'>

const LABELS: Record<BrowserKind, string> = { chromium: 'Chromium', chrome: 'Google Chrome', edge: 'Microsoft Edge' }

export function browserLabel(browser: BrowserKind): string {
  return LABELS[browser]
}

/** Where Chrome / Edge keep user data on this OS. */
export function defaultUserDataDir(browser: BrandedBrowser): string {
  const home = os.homedir()
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local')
    return browser === 'chrome' ? path.join(local, 'Google', 'Chrome', 'User Data') : path.join(local, 'Microsoft', 'Edge', 'User Data')
  }
  if (process.platform === 'darwin') {
    const support = path.join(home, 'Library', 'Application Support')
    return browser === 'chrome' ? path.join(support, 'Google', 'Chrome') : path.join(support, 'Microsoft Edge')
  }
  const configHome = process.env.XDG_CONFIG_HOME ?? path.join(home, '.config')
  return browser === 'chrome' ? path.join(configHome, 'google-chrome') : path.join(configHome, 'microsoft-edge')
}

function copyIfExists(src: string, dest: string): void {
  if (!fs.existsSync(src)) return
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.cpSync(src, dest, { recursive: true, force: true })
}

/**
 * Copy the session files of a signed-in profile into ./profiles so Playwright can
 * use it while the real browser stays open (a live profile is locked).
 */
export function cloneBrowserProfile(browser: BrandedBrowser, profileName: string, sourceRoot: string, cloneLabel: string): string {
  const safeProfileName = profileName.replace(/[^a-z0-9_-]+/gi, '-')
  const cloneRoot = path.resolve(process.cwd(), 'profiles', `${cloneLabel}-${safeProfileName}-clone`)
  const sourceProfile = path.join(sourceRoot, profileName)
  const cloneProfile = path.join(cloneRoot, profileName)
  if (!fs.existsSync(sourceProfile)) {
    throw new Error(`${browserLabel(browser)} profile not found: ${sourceProfile}. Pass --browser-profile "Profile 1" (the folder name shown in ${browser}://version), or use --browser chromium to sign in once in a dedicated profile.`)
  }

  fs.rmSync(cloneRoot, { recursive: true, force: true })
  fs.mkdirSync(cloneProfile, { recursive: true })
  copyIfExists(path.join(sourceRoot, 'Local State'), path.join(cloneRoot, 'Local State'))
  for (const file of ['Preferences', 'Secure Preferences', 'Cookies', 'Cookies-journal']) {
    copyIfExists(path.join(sourceProfile, file), path.join(cloneProfile, file))
  }
  // Newer Chromium builds keep cookies under Network/.
  for (const dir of ['Network', 'Local Storage', 'Session Storage']) {
    copyIfExists(path.join(sourceProfile, dir), path.join(cloneProfile, dir))
  }
  return cloneRoot
}

/** User data dir for a crawl: a dedicated Playwright profile for chromium, else the (cloned) branded profile. */
export function resolveProfileDir(input: {
  browser: BrowserKind
  profileName: string
  clone: boolean
  cloneLabel: string
  chromiumDir: string
  profileDir?: string
}): string {
  if (input.browser === 'chromium') return input.profileDir ?? input.chromiumDir
  const root = input.profileDir ?? defaultUserDataDir(input.browser)
  return input.clone ? cloneBrowserProfile(input.browser, input.profileName, root, input.cloneLabel) : root
}

/** Launch options that let branded browsers decrypt cloned cookies via the OS keychain. */
export function browserLaunchOptions(browser: BrowserKind, profileName: string): { channel?: string; ignoreDefaultArgs?: string[]; args: string[] } {
  if (browser === 'chromium') return { args: [] }
  return {
    channel: browser === 'edge' ? 'msedge' : 'chrome',
    ignoreDefaultArgs: ['--use-mock-keychain', '--password-store=basic'],
    args: profileName ? [`--profile-directory=${profileName}`] : [],
  }
}
