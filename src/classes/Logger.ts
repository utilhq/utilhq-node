import type { SdkAlert } from '../internalRpcSchema'
import {
  detectPackageManager,
  getInstallCommand,
} from '../utils/packageManager'
import * as pkg from '../../package.json'

export type LogLevel =
  | 'quiet'
  | 'info'
  | 'prod' /* @deprecated, alias for 'info' */
  | 'debug'

export const CHANGELOG_URL = 'https://utilhq.com/changelog'

export default class Logger {
  logLevel: LogLevel = 'info'

  constructor(logLevel?: LogLevel) {
    if (logLevel) {
      this.logLevel = logLevel
    }
  }

  /* Important messages, always emitted */
  prod(...args: any[]) {
    console.log('[utilhq] ', ...args)
  }

  /* Same as prod, but without the [utilhq] prefix */
  prodNoPrefix(...args: any[]) {
    console.log(...args)
  }

  /* Fatal errors or errors in user code, always emitted */
  error(...args: any[]) {
    console.error('[utilhq] ', ...args)
  }

  /* Informational messages, not emitted in "quiet" logLevel */
  info(...args: any[]) {
    if (this.logLevel !== 'quiet') {
      console.info('[utilhq] ', ...args)
    }
  }

  /* Same as info, but without the [utilhq] prefix */
  infoNoPrefix(...args: any[]) {
    if (this.logLevel !== 'quiet') {
      console.log(...args)
    }
  }

  /* Non-fatal warnings, not emitted in "quiet" logLevel */
  warn(...args: any[]) {
    if (this.logLevel !== 'quiet') {
      console.warn('[utilhq] ', ...args)
    }
  }

  /* Debugging/tracing information, only emitted in "debug" logLevel */
  debug(...args: any[]) {
    if (this.logLevel === 'debug') {
      console.debug('[utilhq] ', ...args)
    }
  }

  handleSdkAlert(sdkAlert: SdkAlert) {
    this.infoNoPrefix()

    const WARN_EMOJI = '\u26A0\uFE0F'
    const ERROR_EMOJI = '‼️'

    const { severity, message } = sdkAlert

    switch (severity) {
      case 'INFO':
        this.info('🆕\tA new utilhq SDK version is available.')
        if (message) {
          this.info(message)
        }
        break
      case 'WARNING':
        this.warn(
          `${WARN_EMOJI}\tThis version of the utilhq SDK has been deprecated. Please update as soon as possible, it will not work in a future update.`
        )
        if (message) {
          this.warn(message)
        }
        break
      case 'ERROR':
        this.error(
          `${ERROR_EMOJI}\tThis version of the utilhq SDK is no longer supported. Your app will not work until you update.`
        )
        if (message) {
          this.error(message)
        }
        break
      default:
        if (message) {
          this.prod(message)
        }
    }

    this.info("\t- See what's new at:", CHANGELOG_URL)
    this.info(
      '\t- Update now by running:',
      getInstallCommand(`${pkg.name}@latest`, detectPackageManager())
    )

    this.infoNoPrefix()
  }
}
