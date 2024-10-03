import { z, ZodError } from 'zod'
import { v4 } from 'uuid'
import { WebSocket } from 'ws'
import fetch from 'cross-fetch'
import superjson from '../utils/superjson'
import { JSONValue } from 'superjson/dist/types'

import ISocket, { TimeoutError, NotConnectedError } from './ISocket'
import {
  DuplexRPCClient,
  DuplexRPCHandlers,
  MethodDef,
} from './DuplexRPCClient'
import IOError from './IOError'
import Logger from './Logger'
import {
  wsServerSchema,
  hostSchema,
  TRANSACTION_RESULT_SCHEMA_VERSION,
  ActionEnvironment,
  LoadingState,
  DECLARE_HOST,
  ActionDefinition,
  PageDefinition,
  HostSchema,
  WSServerSchema,
} from '../internalRpcSchema'
import {
  ActionResultSchema,
  IOFunctionReturnType,
  IO_RESPONSE,
  LegacyLinkProps,
  T_IO_METHOD_NAMES,
  T_IO_RENDER_INPUT,
  T_IO_RESPONSE,
} from '../ioSchema'
import { IOClient } from './IOClient'
import * as pkg from '../../package.json'
import { deserializeDates } from '../utils/deserialize'
import type {
  ActionCtx,
  PageCtx,
  UtilHQActionHandler,
  UtilHQActionStore,
  UtilHQPageStore,
  InternalButtonItem,
  PageError,
  UtilHQRouteDefinitions,
  UtilHQPageHandler,
  UtilHQErrorHandler,
} from '../types'
import TransactionLoadingState from './TransactionLoadingState'
import { UtilHQ, InternalConfig, UtilHQError } from '..'
import Page from './Page'
import Action from './Action'
import {
  Layout,
  BasicLayout,
  LayoutSchemaInput,
  BasicLayoutConfig,
} from './Layout'

import type { AsyncLocalStorage } from 'async_hooks'
let actionLocalStorage: AsyncLocalStorage<UtilHQActionStore> | undefined
let pageLocalStorage: AsyncLocalStorage<UtilHQPageStore> | undefined

async function initAsyncLocalStorage() {
  try {
    if (typeof window === 'undefined') {
      const {
        default: { AsyncLocalStorage },
      } = await import('async_hooks')
      actionLocalStorage = new AsyncLocalStorage<UtilHQActionStore>()
      pageLocalStorage = new AsyncLocalStorage<UtilHQPageStore>()
    }
  } catch (err) {
    console.error('Failed initializing AsyncLocalStorage stores')
  }
}

initAsyncLocalStorage()

export { actionLocalStorage, pageLocalStorage }

export function getHttpEndpoint(wsEndpoint: string) {
  const url = new URL(wsEndpoint)
  url.protocol = url.protocol.replace('ws', 'http')
  url.pathname = ''
  const str = url.toString()

  return str.endsWith('/') ? str.slice(0, -1) : str
}

export const sleep = (ms: number) =>
  new Promise(resolve => setTimeout(resolve, ms))

interface SetupConfig {
  instanceId?: string
}

export default class UtilHQClient {
  #utilhq: UtilHQ
  #apiKey: string | undefined
  #endpoint: string
  #httpEndpoint: string
  #logger: Logger
  #completeHttpRequestDelayMs: number = 3000
  #completeShutdownDelayMs: number = 3000
  #retryIntervalMs: number = 3000
  #maxResendAttempts: number = 10
  #pingIntervalMs: number = 30_000
  #closeUnresponsiveConnectionTimeoutMs: number = 3 * 60 * 1000 // 3 minutes
  #reinitializeBatchTimeoutMs: number = 200
  #pingIntervalHandle: NodeJS.Timeout | undefined
  #intentionallyClosed = false
  #resolveShutdown: (() => void) | undefined
  #config: InternalConfig

  #routes: Map<string, Action | Page> = new Map()
  #actionDefinitions: ActionDefinition[] = []
  #pageDefinitions: PageDefinition[] = []
  #actionHandlers: Map<string, UtilHQActionHandler> = new Map()
  #pageHandlers: Map<string, UtilHQPageHandler> = new Map()

  organization:
    | {
        name: string
        slug: string
      }
    | undefined
  environment: ActionEnvironment | undefined

  #verboseMessageLogs = false
  #onError: UtilHQErrorHandler | undefined

  constructor(utilhq: UtilHQ, config: InternalConfig) {
    this.#utilhq = utilhq
    this.#apiKey = config.apiKey
    this.#logger = new Logger(config.logLevel)
    this.#config = config
    this.#endpoint = config.endpoint

    if (config.retryIntervalMs && config.retryIntervalMs > 0) {
      this.#retryIntervalMs = config.retryIntervalMs
    }

    if (config.pingIntervalMs && config.pingIntervalMs > 0) {
      this.#pingIntervalMs = config.pingIntervalMs
    }

    if (
      config.closeUnresponsiveConnectionTimeoutMs &&
      config.closeUnresponsiveConnectionTimeoutMs > 0
    ) {
      this.#closeUnresponsiveConnectionTimeoutMs =
        config.closeUnresponsiveConnectionTimeoutMs
    }

    if (
      config.reinitializeBatchTimeoutMs &&
      config.reinitializeBatchTimeoutMs > 0
    ) {
      this.#reinitializeBatchTimeoutMs = config.reinitializeBatchTimeoutMs
    }

    if (
      config.completeHttpRequestDelayMs &&
      config.completeHttpRequestDelayMs > 0
    ) {
      this.#completeHttpRequestDelayMs = config.completeHttpRequestDelayMs
    }

    if (config.maxResendAttempts && config.maxResendAttempts > 0) {
      this.#maxResendAttempts = config.maxResendAttempts
    }

    this.#httpEndpoint = getHttpEndpoint(this.#endpoint)

    if (config.setHostHandlers) {
      config.setHostHandlers(this.#createRPCHandlers())
    }

    if (config.onError) {
      this.#onError = config.onError
    }

    if (config.verboseMessageLogs) {
      this.#verboseMessageLogs = config.verboseMessageLogs
    }
  }

  async #walkRoutes() {
    const routes = new Map<string, Action | Page>()

    const pageDefinitions: PageDefinition[] = []
    const actionDefinitions: (ActionDefinition & { handler: undefined })[] = []
    const actionHandlers = new Map<string, UtilHQActionHandler>()
    const pageHandlers = new Map<string, UtilHQPageHandler>()

    function walkRouter(groupSlug: string, page: Page) {
      routes.set(groupSlug, page)

      pageDefinitions.push({
        slug: groupSlug,
        name: page.name,
        description: page.description,
        hasHandler: !!page.handler,
        unlisted: page.unlisted,
        access: page.access,
      })

      if (page.handler) {
        pageHandlers.set(groupSlug, page.handler)
      }

      for (let [slug, def] of Object.entries(page.routes)) {
        if (def instanceof Page) {
          walkRouter(`${groupSlug}/${slug}`, def)
        } else {
          const fullSlug = `${groupSlug}/${slug}`

          if (!(def instanceof Action)) {
            def = new Action(def)
            routes.set(fullSlug, def)
          }

          actionDefinitions.push({
            groupSlug,
            slug,
            ...def,
            handler: undefined,
          })

          actionHandlers.set(fullSlug, def.handler)
        }
      }
    }

    let fileSystemRoutes: UtilHQRouteDefinitions | undefined

    if (typeof window === 'undefined' && this.#config.routesDirectory) {
      try {
        const { loadRoutesFromFileSystem } = await import(
          '../utils/fileActionLoader'
        )
        fileSystemRoutes = await loadRoutesFromFileSystem(
          this.#config.routesDirectory,
          this.#logger
        )
      } catch (err) {
        this.#logger.error(
          `Failed loading routes from filesystem at ${
            this.#config.routesDirectory
          }`,
          err
        )
      }
    }

    const allRoutes = {
      ...this.#config.actions,
      ...this.#config.groups,
      ...fileSystemRoutes,
      ...this.#config.routes,
    }

    for (let [slug, def] of Object.entries(allRoutes)) {
      if (def instanceof Page) {
        walkRouter(slug, def)
      } else {
        if (!(def instanceof Action)) {
          def = new Action(def)
        }

        actionDefinitions.push({
          slug,
          ...def,
          handler: undefined,
        })

        routes.set(slug, def)
        actionHandlers.set(slug, def.handler)
      }
    }

    this.#routes = routes
    this.#pageDefinitions = pageDefinitions
    this.#actionDefinitions = actionDefinitions
    this.#actionHandlers = actionHandlers
    this.#pageHandlers = pageHandlers
  }

  get #log() {
    return this.#logger
  }

  #ioClients = new Map<string, IOClient>()
  #ioResponseHandlers = new Map<string, (value: T_IO_RESPONSE) => void>()
  #pendingIOCalls = new Map<string, string>()
  #openPages = new Set<string>()
  #pendingPageLayouts = new Map<string, string>()
  #transactionLoadingStates = new Map<string, LoadingState>()
  #httpRequestCompleteCallbacks = new Map<
    string,
    [(output?: any) => void, (err?: any) => void]
  >()

  #ws: ISocket | undefined = undefined

  #serverRpc:
    | DuplexRPCClient<typeof wsServerSchema, typeof hostSchema>
    | undefined = undefined
  #isInitialized = false
  #isReconnecting = false

  get isConnected() {
    return this.#ws?.isOpen ?? false
  }

  #reinitializeTimeout: NodeJS.Timeout | null = null

  handleActionsChange(config?: InternalConfig) {
    if (config !== undefined) {
      this.#config = config
    }

    if (this.#isInitialized && !this.#reinitializeTimeout) {
      this.#reinitializeTimeout = setTimeout(async () => {
        try {
          await this.#initializeHost()
        } catch (err) {
          this.#logger.error('Failed to reinitialize on routes change', err)
        } finally {
          this.#reinitializeTimeout = null
        }
      }, this.#reinitializeBatchTimeoutMs)
    }
  }

  async listen() {
    if (this.#config.setHostHandlers && this.#config.getClientHandlers) {
      // in browser demo mode, we don't need to initialize the connection
      this.organization = {
        name: 'Demo Organization',
        slug: 'demo',
      }
      this.environment = 'development'

      await this.#walkRoutes()

      const isInitialInitialization = !this.#isInitialized
      this.#isInitialized = true
      if (isInitialInitialization) {
        this.#log.prod(
          `🔗 Connected! Access your actions within the demo dashboard nearby.`
        )
      }
    } else {
      await this.initializeConnection()
      await this.#initializeHost()
    }
  }

  private async initializeConnection() {
    await this.#createSocketConnection()
    this.#serverRpc = this.#createRPCClient({
      canCall: wsServerSchema,
    })
  }

  async respondToRequest(requestId: string) {
    if (!requestId) {
      throw new Error('Missing request ID')
    }

    if (!this.#ws) {
      await this.#createSocketConnection()
    }

    if (!this.#serverRpc) {
      this.#serverRpc = this.#createRPCClient({
        requestId,
        canCall: wsServerSchema,
      })
    }

    const result = new Promise((resolve, reject) => {
      this.#httpRequestCompleteCallbacks.set(requestId, [resolve, reject])
    })

    if (!this.#isInitialized) {
      await this.#initializeHost(requestId)
    }

    return await result
  }

  immediatelyClose() {
    this.#resolveShutdown = undefined
    this.#intentionallyClosed = true

    if (this.#serverRpc) {
      this.#serverRpc = undefined
    }

    if (this.#ws) {
      this.#ws.close()
      this.#ws = undefined
    }
  }

  async safelyClose(): Promise<void> {
    const response = await this.#send('BEGIN_HOST_SHUTDOWN', {})

    if (response.type === 'error') {
      throw new UtilHQError(
        response.message ?? 'Unknown error sending shutdown request.'
      )
    }

    if (this.#ioResponseHandlers.size === 0) {
      this.immediatelyClose()
      return
    }

    return new Promise<void>(resolve => {
      this.#resolveShutdown = resolve
    }).then(() => {
      // doing this here and in #close just to be extra sure
      // it's not missed in any future code paths
      this.#resolveShutdown = undefined
      this.immediatelyClose()
    })
  }

  async declareHost(httpHostId: string) {
    await this.#walkRoutes()

    const body: z.infer<(typeof DECLARE_HOST)['inputs']> = {
      httpHostId,
      actions: this.#actionDefinitions,
      groups: this.#pageDefinitions,
      sdkName: pkg.name,
      sdkVersion: pkg.version,
    }

    const response = await fetch(`${this.#httpEndpoint}/api/hosts/declare`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.#apiKey}`,
      },
      body: JSON.stringify(body),
    })
      .then(r => r.json())
      .then(r => DECLARE_HOST.returns.parseAsync(r))
      .catch(err => {
        this.#logger.debug(err)
        throw new UtilHQError('Received invalid API response.')
      })

    if (response.type === 'error') {
      throw new UtilHQError(
        `There was a problem declaring the host: ${response.message}`
      )
    }

    if (response.sdkAlert) {
      this.#log.handleSdkAlert(response.sdkAlert)
    }

    if (response.warnings.length) {
      for (const warning of response.warnings) {
        this.#log.warn(warning)
      }
    }

    if (response.invalidSlugs.length > 0) {
      this.#log.warn('[utilhq]', '⚠ Invalid slugs detected:\n')

      for (const slug of response.invalidSlugs) {
        this.#log.warn(`  - ${slug}`)
      }

      this.#log.warn(
        '\nAction slugs must contain only letters, numbers, underscores, periods, and hyphens.'
      )

      if (response.invalidSlugs.length === this.#actionDefinitions.length) {
        throw new UtilHQError('No valid slugs provided')
      }
    }
  }

  /**
   * Resends pending IO calls upon reconnection.
   */
  async #resendPendingIOCalls(resendToTransactionIds?: string[]) {
    if (!this.isConnected) return

    const toResend = resendToTransactionIds
      ? new Map(
          resendToTransactionIds
            .map(id => [id, this.#pendingIOCalls.get(id)])
            .filter(([, state]) => !!state) as [string, string][]
        )
      : new Map(this.#pendingIOCalls)

    let attemptNumber = 1
    while (toResend.size > 0 && attemptNumber <= this.#maxResendAttempts) {
      await Promise.allSettled(
        Array.from(toResend.entries()).map(([transactionId, ioCall]) =>
          this.#send('SEND_IO_CALL', {
            transactionId,
            ioCall,
          })
            .then(response => {
              toResend.delete(transactionId)

              if (
                !response ||
                (typeof response === 'object' && response.type === 'ERROR')
              ) {
                // Unsuccessful response, don't try again
                this.#pendingIOCalls.delete(transactionId)
              }
            })
            .catch(async err => {
              if (err instanceof IOError) {
                this.#logger.warn(
                  'Failed resending pending IO call: ',
                  err.kind
                )

                if (
                  err.kind === 'CANCELED' ||
                  err.kind === 'TRANSACTION_CLOSED'
                ) {
                  this.#logger.debug('Aborting resending pending IO call')
                  toResend.delete(transactionId)
                  this.#pendingIOCalls.delete(transactionId)
                  return
                }
              } else {
                this.#logger.debug('Failed resending pending IO call:', err)
              }

              const retrySleepMs = this.#retryIntervalMs * attemptNumber
              this.#logger.debug(
                `Trying again in ${Math.round(retrySleepMs / 1000)}s...`
              )
              await sleep(retrySleepMs)
            })
        )
      )

      attemptNumber++
    }
  }

  /**
   * Resends pending IO calls upon reconnection.
   */
  async #resendPendingPageLayouts(resendToPageKeys?: string[]) {
    if (!this.isConnected) return

    const toResend = resendToPageKeys
      ? new Map(
          resendToPageKeys
            .map(id => [id, this.#pendingPageLayouts.get(id)])
            .filter(([, state]) => !!state) as [string, string][]
        )
      : new Map(this.#pendingPageLayouts)

    let attemptNumber = 1
    while (toResend.size > 0 && attemptNumber <= this.#maxResendAttempts) {
      await Promise.allSettled(
        Array.from(toResend.entries()).map(([pageKey, page]) =>
          this.#send('SEND_PAGE', {
            pageKey,
            page,
          })
            .then(response => {
              toResend.delete(pageKey)

              if (!response) {
                // Unsuccessful response, don't try again
                this.#pendingPageLayouts.delete(pageKey)
              }
            })
            .catch(async err => {
              if (err instanceof IOError) {
                this.#logger.warn(
                  'Failed resending pending IO call: ',
                  err.kind
                )

                if (
                  err.kind === 'CANCELED' ||
                  err.kind === 'TRANSACTION_CLOSED'
                ) {
                  this.#logger.debug('Aborting resending pending page layout')
                  toResend.delete(pageKey)
                  this.#pendingPageLayouts.delete(pageKey)
                  return
                }
              } else {
                this.#logger.debug('Failed resending pending page layout:', err)
              }

              const retrySleepMs = this.#retryIntervalMs * attemptNumber
              this.#logger.debug(
                `Trying again in ${Math.round(retrySleepMs / 1000)}s...`
              )
              await sleep(retrySleepMs)
            })
        )
      )

      attemptNumber++
    }
  }

  /**
   * Resends pending transaction loading states upon reconnection.
   */
  async #resendTransactionLoadingStates(resendToTransactionIds?: string[]) {
    if (!this.isConnected) return

    const toResend = resendToTransactionIds
      ? new Map(
          resendToTransactionIds
            .map(id => [id, this.#transactionLoadingStates.get(id)])
            .filter(([, state]) => !!state) as [string, LoadingState][]
        )
      : new Map(this.#transactionLoadingStates)

    let attemptNumber = 0
    while (toResend.size > 0 && attemptNumber <= this.#maxResendAttempts) {
      await Promise.allSettled(
        Array.from(toResend.entries()).map(([transactionId, loadingState]) =>
          this.#send('SEND_LOADING_CALL', {
            transactionId,
            ...loadingState,
          })
            .then(response => {
              toResend.delete(transactionId)

              if (!response) {
                // Unsuccessful response, don't try again
                this.#transactionLoadingStates.delete(transactionId)
              }
            })
            .catch(async err => {
              if (err instanceof IOError) {
                this.#logger.warn(
                  'Failed resending transaction loading state: ',
                  err.kind
                )

                if (
                  err.kind === 'CANCELED' ||
                  err.kind === 'TRANSACTION_CLOSED'
                ) {
                  this.#logger.debug(
                    'Aborting resending transaction loading state'
                  )
                  this.#transactionLoadingStates.delete(transactionId)
                  return
                }
              } else {
                this.#logger.debug('Failed resending pending IO call:', err)
              }

              const retrySleepMs = this.#retryIntervalMs * attemptNumber
              this.#logger.debug(
                `Trying again in ${Math.round(retrySleepMs / 1000)}s...`
              )
              await sleep(retrySleepMs)
            })
        )
      )

      attemptNumber++
    }
  }

  #closeTransaction(transactionId: string) {
    this.#log.debug('Closing transaction', transactionId)

    this.#pendingIOCalls.delete(transactionId)
    this.#transactionLoadingStates.delete(transactionId)
    this.#ioResponseHandlers.delete(transactionId)
    const client = this.#ioClients.get(transactionId)
    if (client) {
      this.#ioClients.delete(transactionId)
      for (const key of client.inlineActionKeys.values()) {
        this.#actionHandlers.delete(key)
      }
    }

    if (this.#resolveShutdown && this.#ioResponseHandlers.size === 0) {
      setTimeout(() => {
        this.#resolveShutdown?.()
      }, this.#completeShutdownDelayMs)
    }
  }

  /**
   * Establishes the underlying ISocket connection to utilhq.
   */
  async #createSocketConnection(connectConfig?: SetupConfig) {
    const id = connectConfig?.instanceId ?? v4()

    const headers: Record<string, string> = { 'x-instance-id': id }
    if (this.#apiKey) {
      headers['x-api-key'] = this.#apiKey
    }

    const ws = new ISocket(
      new WebSocket(this.#endpoint, {
        headers,
        followRedirects: true,
      }),
      {
        id,
        connectTimeout: this.#config.connectTimeoutMs,
        sendTimeout: this.#config.sendTimeoutMs,
        pingTimeout: this.#config.pingTimeoutMs,
      }
    )

    if (this.#verboseMessageLogs) {
      ws.onMessage.attach(message => {
        this.#logger.debug('Message received:', message)
      })
    }

    ws.onClose.attach(async ([code, reason]) => {
      if (this.#intentionallyClosed) {
        this.#intentionallyClosed = false
        return
      }

      if (this.#pingIntervalHandle) {
        clearInterval(this.#pingIntervalHandle)
        this.#pingIntervalHandle = undefined
      }

      // don't initialize retry process again if already started
      if (this.#isReconnecting) return

      this.#log.error(`❗ Connection to utilhq closed (code ${code})`)

      if (reason) {
        this.#log.error('Reason:', reason)
      }

      // don't reconnect if the initial connection failed, likely a config problem
      // and maintains previous behavior
      if (!this.#isInitialized) return

      this.#isReconnecting = true
      this.#log.prod('🔌 Reconnecting...')

      while (!this.isConnected) {
        this.#createSocketConnection({ instanceId: ws.id })
          .then(() => {
            this.#isReconnecting = false
            this.#log.prod('⚡ Reconnection successful')
            this.#resendPendingIOCalls()
            this.#resendTransactionLoadingStates()
            this.#resendPendingPageLayouts()
          })
          .catch(err => {
            this.#logger.debug('Failed reestablishing connection', err)
          })

        this.#log.prod(
          `Unable to reconnect. Retrying in ${Math.round(
            this.#retryIntervalMs / 1000
          )}s...`
        )
        await sleep(this.#retryIntervalMs)
      }
    })

    await ws.connect()

    this.#ws = ws

    let lastSuccessfulPing = new Date()
    this.#pingIntervalHandle = setInterval(async () => {
      if (!this.isConnected) {
        if (this.#pingIntervalHandle) {
          clearInterval(this.#pingIntervalHandle)
          this.#pingIntervalHandle = undefined
        }

        return
      }

      try {
        await ws.ping()
        lastSuccessfulPing = new Date()
      } catch (err) {
        this.#logger.warn('Pong not received in time')
        if (!(err instanceof TimeoutError)) {
          this.#logger.warn(err)
        }

        if (
          lastSuccessfulPing.getTime() <
          new Date().getTime() - this.#closeUnresponsiveConnectionTimeoutMs
        ) {
          this.#logger.warn(
            `No pong received in last ${
              this.#closeUnresponsiveConnectionTimeoutMs
            }ms, closing connection to utilhq and retrying...`
          )
          if (this.#pingIntervalHandle) {
            clearInterval(this.#pingIntervalHandle)
            this.#pingIntervalHandle = undefined
          }
          ws.close()
        }
      }
    }, this.#pingIntervalMs)

    if (!this.#serverRpc) return

    this.#serverRpc.setCommunicator(ws)

    await this.#initializeHost()
  }

  async ping(): Promise<boolean> {
    if (!this.#ws) throw new NotConnectedError()

    await this.#ws.ping()

    return true
  }

  #createRPCHandlers(requestId?: string): DuplexRPCHandlers<HostSchema> {
    const utilhqClient = this
    return {
      START_TRANSACTION: async inputs => {
        if (this.#resolveShutdown) {
          this.#logger.debug(
            'In process of closing, refusing to start transaction'
          )
          return
        }

        if (!utilhqClient.organization) {
          utilhqClient.#log.error('No organization defined')
          return
        }

        const { action, transactionId } = inputs

        if (this.#ioResponseHandlers.has(transactionId)) {
          this.#logger.debug('Transaction already started, not starting again')
          return
        }

        const actionHandler = utilhqClient.#actionHandlers.get(action.slug)

        utilhqClient.#log.debug(actionHandler)

        if (!actionHandler) {
          utilhqClient.#log.debug('No actionHandler called', action.slug)
          return
        }

        const client = new IOClient({
          logger: utilhqClient.#logger,
          send: async ioRenderInstruction => {
            const ioCall = JSON.stringify(ioRenderInstruction)
            utilhqClient.#pendingIOCalls.set(transactionId, ioCall)

            if (this.#config.getClientHandlers) {
              await this.#config.getClientHandlers()?.RENDER({
                transactionId,
                toRender: ioCall,
              })
            } else {
              const response = await utilhqClient.#send('SEND_IO_CALL', {
                transactionId,
                ioCall,
              })

              if (
                !response ||
                (typeof response === 'object' && response.type === 'ERROR')
              ) {
                let message = 'Error sending IO call.'
                if (
                  typeof response === 'object' &&
                  response.type === 'ERROR' &&
                  response.message
                ) {
                  message = response.message
                }
                throw new IOError('RENDER_ERROR', message)
              }
            }

            utilhqClient.#transactionLoadingStates.delete(transactionId)
          },
          isDemo: !!this.#config.getClientHandlers,
          displayResolvesImmediately: inputs.displayResolvesImmediately,
          // onAddInlineAction: handler => {
          //   const key = v4()
          //   utilhqClient.#actionHandlers.set(key, handler)
          //   return key
          // },
        })

        utilhqClient.#ioResponseHandlers.set(
          transactionId,
          client.onResponse.bind(client)
        )

        // To maintain consistent ordering for logs despite network race conditions
        let logIndex = 0
        let { params, paramsMeta } = inputs

        if (params && paramsMeta) {
          params = superjson.deserialize({
            json: params as JSONValue,
            meta: paramsMeta,
          })
        }

        const ctx: ActionCtx = {
          user: inputs.user,
          // TODO: Remove this when all active SDKs support superjson
          params: deserializeDates(params),
          environment: inputs.environment,
          organization: utilhqClient.organization,
          action,
          log: (...args) =>
            utilhqClient.#sendLog(transactionId, logIndex++, ...args),
          notify: async config => {
            await utilhqClient.#utilhq.notify({
              ...config,
              transactionId: inputs.transactionId,
            })
          },
          loading: new TransactionLoadingState({
            logger: utilhqClient.#logger,
            send: async loadingState => {
              utilhqClient.#transactionLoadingStates.set(
                transactionId,
                loadingState
              )
              if (this.#config.getClientHandlers) {
                await this.#config.getClientHandlers()?.LOADING_STATE({
                  transactionId,
                  ...loadingState,
                })
              } else {
                await utilhqClient.#send('SEND_LOADING_CALL', {
                  transactionId,
                  ...loadingState,
                })
              }
            },
          }),
          redirect: (props: LegacyLinkProps) =>
            utilhqClient.#sendRedirect(transactionId, props),
        }

        this.#ioClients.set(transactionId, client)
        const { io } = client

        const handleAction = () => {
          actionHandler(client.io, ctx)
            .then(res => {
              // Allow actions to return data even after being canceled

              const { json, meta } = superjson.serialize(res)
              const result: ActionResultSchema = {
                schemaVersion: TRANSACTION_RESULT_SCHEMA_VERSION,
                status: 'SUCCESS',
                data: (json as IOFunctionReturnType) ?? null,
                meta,
              }

              return result
            })
            .catch(err => {
              // Action did not catch the cancellation error
              if (err instanceof IOError && err.kind === 'CANCELED') throw err

              utilhqClient.#logger.error(err)

              let data: IOFunctionReturnType = null
              if (err instanceof IOError && err.cause) {
                err = err.cause
              }

              if (err instanceof Error) {
                data = {
                  error: err.name,
                  message: err.message,
                  cause:
                    err.cause && err.cause instanceof Error
                      ? `${err.cause.name}: ${err.cause.message}`
                      : undefined,
                  // TODO: Maybe show stack traces in the future?
                  // stack: err.stack,
                }
              }

              this.#onError?.({
                error: err,
                route: action.slug,
                routeDefinition: this.#routes.get(action.slug),
                params: ctx.params,
                environment: ctx.environment,
                user: ctx.user,
                organization: ctx.organization,
              })

              const result: ActionResultSchema = {
                schemaVersion: TRANSACTION_RESULT_SCHEMA_VERSION,
                status: 'FAILURE',
                data,
              }

              return result
            })
            .then(async (res: ActionResultSchema) => {
              if (this.#config.getClientHandlers) {
                this.#config.getClientHandlers()?.TRANSACTION_COMPLETED({
                  transactionId,
                  resultStatus: res.status,
                  result: JSON.stringify(res),
                })
              } else {
                await utilhqClient.#send('MARK_TRANSACTION_COMPLETE', {
                  transactionId,
                  resultStatus: res.status,
                  result: JSON.stringify(res),
                })
              }

              if (requestId) {
                setTimeout(() => {
                  const callbacks =
                    utilhqClient.#httpRequestCompleteCallbacks.get(requestId)
                  if (callbacks) {
                    const [resolve] = callbacks
                    resolve()
                  } else {
                    utilhqClient.#log.debug(
                      'No HTTP request complete callbacks found for requestId',
                      requestId
                    )
                  }
                }, this.#completeHttpRequestDelayMs)
              }
            })
            .catch(err => {
              if (err instanceof IOError) {
                switch (err.kind) {
                  case 'CANCELED':
                    utilhqClient.#log.debug(
                      'Transaction canceled for action',
                      action.slug
                    )
                    break
                  case 'TRANSACTION_CLOSED':
                    utilhqClient.#log.debug(
                      'Attempted to make IO call after transaction already closed in action',
                      action.slug
                    )
                    break
                }
              } else {
                utilhqClient.#log.error('Error sending action response', err)
              }

              if (requestId) {
                setTimeout(() => {
                  const callbacks =
                    utilhqClient.#httpRequestCompleteCallbacks.get(requestId)
                  if (callbacks) {
                    const [_, reject] = callbacks
                    reject(err)
                  } else {
                    utilhqClient.#log.debug(
                      'No HTTP request complete callbacks found for requestId',
                      requestId
                    )
                  }
                }, this.#completeHttpRequestDelayMs)
              }
            })
            .finally(() => {
              if (!inputs.displayResolvesImmediately) {
                this.#closeTransaction(transactionId)
              }
            })
        }

        if (actionLocalStorage) {
          actionLocalStorage.run({ io, ctx }, () => {
            handleAction()
          })
        } else {
          handleAction()
        }

        return
      },
      IO_RESPONSE: async inputs => {
        this.#log.debug('Got io response', inputs)

        try {
          const ioResp = IO_RESPONSE.parse(JSON.parse(inputs.value))
          const responseHandler = this.#ioResponseHandlers.get(
            ioResp.transactionId
          )

          if (!responseHandler) {
            this.#log.debug(
              'Missing response handler for transaction ID',
              inputs.transactionId
            )
            return
          }

          responseHandler(ioResp)
        } catch (err) {
          if (err instanceof ZodError) {
            this.#log.error('Received invalid IO response:', inputs)
            this.#log.debug(err)
          } else {
            this.#log.error('Failed handling IO response:', err)
          }
        }
      },
      CLOSE_TRANSACTION: async ({ transactionId }) => {
        this.#closeTransaction(transactionId)
      },
      OPEN_PAGE: async inputs => {
        if (this.#resolveShutdown) {
          return { type: 'ERROR' as const, message: 'Host shutting down.' }
        }

        if (!this.organization) {
          this.#log.error('No organization defined')

          const error = new UtilHQError('No organization defined.')
          if (requestId) {
            setTimeout(() => {
              const callbacks =
                utilhqClient.#httpRequestCompleteCallbacks.get(requestId)
              if (callbacks) {
                const [_, reject] = callbacks
                reject(error)
              } else {
                utilhqClient.#log.debug(
                  'No HTTP request complete callbacks found for requestId',
                  requestId
                )
              }
            }, this.#completeHttpRequestDelayMs)
          }

          return { type: 'ERROR' as const, message: error.message }
        }

        const { pageKey } = inputs
        const pageHandler = this.#pageHandlers.get(inputs.page.slug)

        if (!pageHandler) {
          this.#log.debug('No page handler found', inputs.page.slug)

          const error = new UtilHQError('No page handler found.')
          if (requestId) {
            setTimeout(() => {
              const callbacks =
                utilhqClient.#httpRequestCompleteCallbacks.get(requestId)
              if (callbacks) {
                const [_, reject] = callbacks
                reject(error)
              } else {
                utilhqClient.#log.debug(
                  'No HTTP request complete callbacks found for requestId',
                  requestId
                )
              }
            }, this.#completeHttpRequestDelayMs)
          }

          return { type: 'ERROR' as const, message: error.message }
        }

        this.#openPages.add(pageKey)

        let { params, paramsMeta } = inputs

        if (params && paramsMeta) {
          params = superjson.deserialize({
            json: params as JSONValue,
            meta: paramsMeta,
          })
        }
        const ctx: PageCtx = {
          user: inputs.user,
          params: deserializeDates(params),
          environment: inputs.environment,
          organization: this.organization,
          page: inputs.page,
          redirect: (props: LegacyLinkProps) =>
            utilhqClient.#sendRedirect(pageKey, props),
          loading: new TransactionLoadingState({
            logger: utilhqClient.#logger,
            send: async loadingState => {
              if (!this.#openPages.has(pageKey)) return
              utilhqClient.#transactionLoadingStates.set(
                pageKey,
                loadingState
              )
              if (this.#config.getClientHandlers) {
                await this.#config.getClientHandlers()?.LOADING_STATE({
                  transactionId: pageKey,
                  ...loadingState,
                })
              } else {
                await utilhqClient.#send('SEND_LOADING_CALL', {
                  transactionId: pageKey,
                  ...loadingState,
                })
              }
            },
          }),
        }

        let page: Layout | undefined = undefined
        let menuItems: InternalButtonItem[] | undefined = undefined
        let renderInstruction: T_IO_RENDER_INPUT | undefined = undefined
        let errors: PageError[] = []

        const MAX_PAGE_RETRIES = 5

        const sendPage = async () => {
          if (!this.#openPages.has(pageKey)) return
          let pageLayout: LayoutSchemaInput | undefined
          if (page instanceof BasicLayout) {
            pageLayout = {
              kind: 'BASIC',
              title:
                page.title === undefined
                  ? undefined
                  : typeof page.title === 'string'
                  ? page.title
                  : null,
              description:
                page.description === undefined
                  ? undefined
                  : typeof page.description === 'string'
                  ? page.description
                  : null,
              menuItems,
              children: renderInstruction,
              errors,
            }

            if ('metadata' in page) {
              this.#logger.warn(
                'The `metadata` property on `Layout` is deprecated. Please use `io.display.metadata` in the `children` array instead.'
              )
            }
          }

          if (this.#config.getClientHandlers) {
            await this.#config.getClientHandlers()?.RENDER_PAGE({
              pageKey,
              page: pageLayout ? JSON.stringify(pageLayout) : undefined,
              hostInstanceId: 'demo',
            })
          } else {
            for (let i = 0; i < MAX_PAGE_RETRIES; i++) {
              try {
                const page = pageLayout ? JSON.stringify(pageLayout) : undefined
                if (page) {
                  this.#pendingPageLayouts.set(pageKey, page)
                }
                await this.#send('SEND_PAGE', {
                  pageKey,
                  page,
                })
                return
              } catch (err) {
                this.#logger.debug('Failed sending page', err)
                this.#logger.debug('Retrying in', this.#retryIntervalMs)
                await sleep(this.#retryIntervalMs)
              }
            }
            throw new UtilHQError(
              'Unsuccessful sending page, max retries exceeded.'
            )
          }
        }

        // What follows is a pretty convoluted way to coalesce
        // `scheduleSendPage` calls into non-clobbering/overlapping
        // `sendPage `calls. This can probably be simplified but I
        // can't think of a better way at the moment.

        // Tracks whether a send is currently in progress
        let sendPagePromise: Promise<void> | null = null

        // Keeps track of a brief timeout to coalesce rapid send calls
        let pageSendTimeout: NodeJS.Timeout | null = null

        // Tracks whether a new send needs to happen after the current one
        let newPageScheduled = false

        const processSendPage = () => {
          if (!this.#openPages.has(pageKey)) return
          newPageScheduled = false
          pageSendTimeout = null
          sendPagePromise = sendPage()
            .catch(err => {
              this.#logger.debug(`Failed sending page with key ${pageKey}`, err)
            })
            .finally(() => {
              sendPagePromise = null

              if (newPageScheduled) {
                scheduleSendPage()
              }
            })
        }

        const scheduleSendPage = () => {
          if (!this.#openPages.has(pageKey)) return
          newPageScheduled = true

          if (sendPagePromise) return
          if (pageSendTimeout) return

          pageSendTimeout = setTimeout(processSendPage, 0)
        }

        const client = new IOClient({
          logger: this.#logger,
          send: async instruction => {
            if (!this.#openPages.has(pageKey)) return
            renderInstruction = instruction
            scheduleSendPage()
          },
          isDemo: !!this.#config.getClientHandlers,
          // onAddInlineAction: () => {
          //   const key = v4()
          //   this.#actionHandlers.set(key, handler)
          //   return key
          // },
        })

        const {
          io: { group, display },
        } = client

        if (this.#openPages.has(pageKey)) {
          this.#ioClients.set(pageKey, client)
          this.#ioResponseHandlers.set(pageKey, client.onResponse.bind(client))
        }

        const pageError = (
          error: unknown,
          layoutKey?: keyof BasicLayoutConfig
        ) => {
          if (error instanceof Error) {
            return {
              layoutKey,
              error: error.name,
              message: error.message,
              cause:
                error.cause && error.cause instanceof Error
                  ? `${error.cause.name}: ${error.cause.message}`
                  : undefined,
              // TODO: Maybe show stack traces in the future?
              // stack: error.stack,
            }
          } else {
            return {
              layoutKey,
              error: 'Unknown error',
              message: String(error),
            }
          }
        }

        const handlePage = () => {
          pageHandler(display, ctx)
            .then(res => {
              page = res

              if (!page) {
                scheduleSendPage()
                return
              }

              if (typeof page.title === 'function') {
                try {
                  page.title = page.title()
                } catch (err) {
                  this.#logger.error(err)
                  this.#onError?.({
                    error: err,
                    route: ctx.page.slug,
                    routeDefinition: this.#routes.get(ctx.page.slug),
                    params: ctx.params,
                    environment: ctx.environment,
                    user: ctx.user,
                    organization: ctx.organization,
                  })
                  errors.push(pageError(err, 'title'))
                }
              }

              if (page.title instanceof Promise) {
                page.title
                  .then(title => {
                    if (page) {
                      page.title = title
                      scheduleSendPage()
                    }
                  })
                  .catch(err => {
                    this.#logger.error(err)
                    this.#onError?.({
                      error: err,
                      route: ctx.page.slug,
                      routeDefinition: this.#routes.get(ctx.page.slug),
                      params: ctx.params,
                      environment: ctx.environment,
                      user: ctx.user,
                      organization: ctx.organization,
                    })
                    errors.push(pageError(err, 'title'))
                    scheduleSendPage()
                  })
              }

              if (page.description) {
                if (typeof page.description === 'function') {
                  try {
                    page.description = page.description()
                  } catch (err) {
                    this.#logger.error(err)
                    this.#onError?.({
                      error: err,
                      route: ctx.page.slug,
                      routeDefinition: this.#routes.get(ctx.page.slug),
                      params: ctx.params,
                      environment: ctx.environment,
                      user: ctx.user,
                      organization: ctx.organization,
                    })
                    errors.push(pageError(err, 'description'))
                  }
                }

                if (page.description instanceof Promise) {
                  page.description
                    .then(description => {
                      if (page) {
                        page.description = description
                        scheduleSendPage()
                      }
                    })
                    .catch(err => {
                      this.#logger.error(err)
                      this.#onError?.({
                        error: err,
                        route: ctx.page.slug,
                        routeDefinition: this.#routes.get(ctx.page.slug),
                        params: ctx.params,
                        environment: ctx.environment,
                        user: ctx.user,
                        organization: ctx.organization,
                      })
                      errors.push(pageError(err, 'description'))
                      scheduleSendPage()
                    })
                }
              }

              if (page.menuItems) {
                menuItems = page.menuItems
                // menuItems = page.menuItems.map(menuItem => {
                //   if (
                //     'action' in menuItem &&
                //     typeof menuItem['action'] === 'function'
                //   ) {
                //     const inlineAction = client.addInlineAction(menuItem.action)
                //     return {
                //       ...menuItem,
                //       inlineAction,
                //     }
                //   }
                //
                //   return menuItem
                // })
              }

              if ('metadata' in page) {
                this.#logger.warn(
                  'The `metadata` property on `Layout` is deprecated. Please use `io.display.metadata` in the `children` array instead.'
                )
              }

              if (page.children?.length) {
                group(page.children).then(
                  () => {
                    this.#logger.debug(
                      'Initial children render complete for pageKey',
                      pageKey
                    )
                  },
                  // We use the reject callback form because it's an IOGroupPromise,
                  // not a real Promise and we don't currently implement `.catch()`
                  // (I don't know how or if it's possbile right now, thenable objects aren't documented well)
                  // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise#thenables
                  err => {
                    this.#logger.error(err)
                    this.#onError?.({
                      error: err,
                      route: ctx.page.slug,
                      routeDefinition: this.#routes.get(ctx.page.slug),
                      params: ctx.params,
                      environment: ctx.environment,
                      user: ctx.user,
                      organization: ctx.organization,
                    })

                    if (err instanceof IOError && err.cause) {
                      errors.push(pageError(err.cause, 'children'))
                    } else {
                      errors.push(pageError(err, 'children'))
                    }

                    scheduleSendPage()
                  }
                )
              } else {
                scheduleSendPage()
              }
            })
            .catch(async err => {
              this.#logger.error('Error in page:', err)
              errors.push(pageError(err))

              this.#onError?.({
                error: err,
                route: ctx.page.slug,
                routeDefinition: this.#routes.get(ctx.page.slug),
                params: ctx.params,
                environment: ctx.environment,
                user: ctx.user,
                organization: ctx.organization,
              })

              if (!this.#openPages.has(pageKey)) return

              const pageLayout: LayoutSchemaInput = {
                kind: 'BASIC',
                errors,
              }

              await this.#send('SEND_PAGE', {
                pageKey,
                page: JSON.stringify(pageLayout),
              })
            })
        }

        if (this.#openPages.has(pageKey)) {
          if (pageLocalStorage) {
            pageLocalStorage.run({ display, ctx }, () => {
              handlePage()
            })
          } else {
            handlePage()
          }
        }

        return {
          type: 'SUCCESS' as const,
          pageKey,
        }
      },
      CLOSE_PAGE: async inputs => {
        this.#openPages.delete(inputs.pageKey)
        const client = this.#ioClients.get(inputs.pageKey)
        if (client) {
          for (const key of client.inlineActionKeys.values()) {
            this.#actionHandlers.delete(key)
          }

          client.inlineActionKeys.clear()
          this.#ioClients.delete(inputs.pageKey)
        }

        this.#pendingPageLayouts.delete(inputs.pageKey)
        this.#ioResponseHandlers.delete(inputs.pageKey)
        this.#transactionLoadingStates.delete(inputs.pageKey)

        // Do this after a small delay so that this function can return before shutdown
        if (requestId) {
          setTimeout(() => {
            const callbacks =
              utilhqClient.#httpRequestCompleteCallbacks.get(requestId)
            if (callbacks) {
              const [resolve] = callbacks
              resolve()
            } else {
              utilhqClient.#log.debug(
                'No HTTP request complete callbacks found for requestId',
                requestId
              )
            }
          }, this.#completeHttpRequestDelayMs)
        }

        if (this.#resolveShutdown && this.#ioResponseHandlers.size === 0) {
          setTimeout(() => {
            this.#resolveShutdown?.()
          }, this.#completeShutdownDelayMs)
        }
      },
    }
  }

  /**
   * Creates the DuplexRPCClient responsible for sending
   * messages to utilhq.
   */
  #createRPCClient<CallerSchema extends MethodDef>({
    communicator = this.#ws,
    requestId,
    canCall,
  }: {
    communicator?: ISocket
    requestId?: string
    canCall: CallerSchema
  }) {
    if (!communicator) {
      throw new Error('Communicator not initialized')
    }

    return new DuplexRPCClient({
      communicator,
      canCall,
      canRespondTo: hostSchema,
      handlers: this.#createRPCHandlers(requestId),
      retryChunkIntervalMs: this.#config.retryChunkIntervalMs,
    })
  }

  /**
   * Sends the `INITIALIZE_HOST` RPC call to utilhq,
   * declaring the actions that this host is responsible for handling.
   */
  async #initializeHost(requestId?: string) {
    if (!this.#ws) {
      throw new UtilHQError('ISocket not initialized')
    }

    if (!this.#serverRpc) {
      throw new UtilHQError('serverRpc not initialized')
    }

    const isInitialInitialization = !this.#isInitialized
    this.#isInitialized = true

    await this.#walkRoutes()

    const response = await this.#send('INITIALIZE_HOST', {
      actions: this.#actionDefinitions,
      groups: this.#pageDefinitions,
      sdkName: pkg.name,
      sdkVersion: pkg.version,
      requestId,
      timestamp: new Date().valueOf(),
    })

    if (!response) {
      throw new UtilHQError('Unknown error')
    }

    if (response.sdkAlert) {
      this.#log.handleSdkAlert(response.sdkAlert)
    }

    if (response.type === 'error') {
      throw new UtilHQError(response.message)
    } else {
      if (response.invalidSlugs.length > 0) {
        this.#log.warn('[utilhq]', '⚠ Invalid slugs detected:\n')

        for (const slug of response.invalidSlugs) {
          this.#log.warn(`  - ${slug}`)
        }

        this.#log.warn(
          '\nAction slugs must contain only letters, numbers, underscores, periods, and hyphens.'
        )
      }

      if (response.warnings.length) {
        for (const warning of response.warnings) {
          this.#log.warn(warning)
        }
      }

      this.organization = response.organization
      this.environment = response.environment

      if (isInitialInitialization) {
        this.#log.prod(
          `🔗 Connected! Access your actions at: ${response.dashboardUrl}`
        )
        this.#log.debug('Host ID:', this.#ws.id)
      }
    }

    return response
  }

  async #send<MethodName extends keyof WSServerSchema>(
    methodName: MethodName,
    inputs: z.input<WSServerSchema[MethodName]['inputs']>
  ) {
    if (!this.#serverRpc) throw new UtilHQError('serverRpc not initialized')

    for (
      let attemptNumber = 1;
      attemptNumber <= this.#maxResendAttempts;
      attemptNumber++
    ) {
      try {
        this.#logger.debug('Sending via server', methodName, inputs)
        return await this.#serverRpc.send(methodName, inputs, {
          timeoutFactor: attemptNumber,
        })
      } catch (err) {
        const sleepTimeBeforeRetrying = this.#retryIntervalMs * attemptNumber

        if (err instanceof TimeoutError) {
          this.#log.debug(
            `RPC call timed out, retrying in ${Math.round(
              sleepTimeBeforeRetrying / 1000
            )}s...`
          )
          this.#log.debug(err)
          sleep(sleepTimeBeforeRetrying)
        } else {
          throw err
        }
      }
    }

    throw new UtilHQError('Maximum failed resend attempts reached, aborting.')
  }

  /**
   * This is used for testing and intentionally non-private.
   * Do not use unless you're absolutely sure what you're doing.
   */
  protected async __dangerousInternalSend(methodName: any, inputs: any) {
    if (!this.#serverRpc) throw new UtilHQError('serverRpc not initialized')

    return await this.#serverRpc.send(methodName, inputs)
  }

  async #sendLog(transactionId: string, index: number, ...args: any[]) {
    if (!args.length) return

    let data = args
      .map(arg => {
        if (arg === undefined) return 'undefined'
        if (typeof arg === 'string') return arg
        return JSON.stringify(arg, undefined, 2)
      })
      .join(' ')

    if (data.length > 10_000) {
      data =
        data.slice(0, 10_000) +
        '...' +
        '\n^ Warning: 10k logline character limit reached.\nTo avoid this error, try separating your data into multiple ctx.log() calls.'
    }

    if (this.#config.getClientHandlers) {
      await this.#config.getClientHandlers()?.LOG({
        transactionId,
        data,
        timestamp: new Date().valueOf(),
        index,
      })
    } else {
      await this.#send('SEND_LOG', {
        transactionId,
        data,
        index,
        timestamp: new Date().valueOf(),
      }).catch(err => {
        this.#logger.error('Failed sending log to utilhq', err)
      })
    }
  }

  async #sendRedirect(transactionId: string, props: LegacyLinkProps) {
    if (this.#config.getClientHandlers) {
      throw new UtilHQError(
        `The ctx.redirect method isn't supported in demo mode`
      )
    }

    const response = await this.#send('SEND_REDIRECT', {
      transactionId,
      ...props,
    })

    if (!response) {
      throw new UtilHQError('Failed sending redirect')
    }
  }
}
