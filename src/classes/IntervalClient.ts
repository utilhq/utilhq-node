import { z, ZodError } from 'zod'
import { v4 } from 'uuid'
import { WebSocket } from 'ws'
import fetch from 'node-fetch'
import * as superjson from 'superjson'
import { JSONValue } from 'superjson/dist/types'
import ISocket, { TimeoutError } from './ISocket'
import type { DescriptionType, IceServer } from 'node-datachannel'
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
  ClientSchema,
  WSServerSchema,
  PeerCandidate,
} from '../internalRpcSchema'
import {
  ActionResultSchema,
  IOFunctionReturnType,
  IO_RESPONSE,
  LegacyLinkProps,
  requiresServer,
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
  IntervalActionHandler,
  IntervalActionStore,
  IntervalPageStore,
  InternalButtonItem,
  PageError,
  IntervalRouteDefinitions,
  IntervalPageHandler,
} from '../types'
import type DataChannelConnection from './DataChannelConnection'
import TransactionLoadingState from './TransactionLoadingState'
import { Interval, InternalConfig, IntervalError } from '..'
import Page from './Page'
import {
  Layout,
  BasicLayout,
  LayoutSchemaInput,
  BasicLayoutConfig,
} from './Layout'

import type { AsyncLocalStorage } from 'async_hooks'
let actionLocalStorage: AsyncLocalStorage<IntervalActionStore> | undefined
let pageLocalStorage: AsyncLocalStorage<IntervalPageStore> | undefined

async function initAsyncLocalStorage() {
  try {
    if (typeof window === 'undefined') {
      const {
        default: { AsyncLocalStorage },
      } = await import('async_hooks')
      actionLocalStorage = new AsyncLocalStorage<IntervalActionStore>()
      pageLocalStorage = new AsyncLocalStorage<IntervalPageStore>()
    }
  } catch (err) {
    console.error('Failed initializing AsyncLocalStorage stores')
  }
}

initAsyncLocalStorage()

export { actionLocalStorage, pageLocalStorage }

export const DEFAULT_WEBSOCKET_ENDPOINT = 'wss://interval.com/websocket'

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

export default class IntervalClient {
  #interval: Interval
  #apiKey: string | undefined
  #endpoint: string = DEFAULT_WEBSOCKET_ENDPOINT
  #httpEndpoint: string
  #logger: Logger
  #retryIntervalMs: number = 3000
  #pingIntervalMs: number = 30_000
  #closeUnresponsiveConnectionTimeoutMs: number = 3 * 60 * 1000 // 3 minutes
  #reinitializeBatchTimeoutMs: number = 200
  #pingIntervalHandle: NodeJS.Timeout | undefined
  #intentionallyClosed = false
  #config: InternalConfig

  #actionDefinitions: ActionDefinition[] = []
  #pageDefinitions: PageDefinition[] = []
  #actionHandlers: Map<string, IntervalActionHandler> = new Map()
  #pageHandlers: Map<string, IntervalPageHandler> = new Map()

  organization:
    | {
        name: string
        slug: string
      }
    | undefined
  environment: ActionEnvironment | undefined
  #forcePeerMessages = false

  constructor(interval: Interval, config: InternalConfig) {
    this.#interval = interval
    this.#apiKey = config.apiKey
    this.#logger = new Logger(config.logLevel)
    this.#config = config

    if (config.endpoint) {
      this.#endpoint = config.endpoint
    }

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

    this.#httpEndpoint = getHttpEndpoint(this.#endpoint)

    if (config.setHostHandlers) {
      config.setHostHandlers(this.#createRPCHandlers())
    }
  }

  async #walkRoutes() {
    const pageDefinitions: PageDefinition[] = []
    const actionDefinitions: (ActionDefinition & { handler: undefined })[] = []
    const actionHandlers = new Map<string, IntervalActionHandler>()
    const pageHandlers = new Map<string, IntervalPageHandler>()

    function walkRouter(groupSlug: string, router: Page) {
      pageDefinitions.push({
        slug: groupSlug,
        name: router.name,
        description: router.description,
        hasHandler: !!router.handler,
        unlisted: router.unlisted,
        access: router.access,
      })

      if (router.handler) {
        pageHandlers.set(groupSlug, router.handler)
      }

      for (const [slug, def] of Object.entries(router.routes)) {
        if (def instanceof Page) {
          walkRouter(`${groupSlug}/${slug}`, def)
        } else {
          actionDefinitions.push({
            groupSlug,
            slug,
            ...('handler' in def ? def : {}),
            handler: undefined,
          })

          actionHandlers.set(
            `${groupSlug}/${slug}`,
            'handler' in def ? def.handler : def
          )
        }
      }
    }

    let fileSystemRoutes: IntervalRouteDefinitions | undefined

    if (typeof window === 'undefined' && this.#config.routesDirectory) {
      try {
        const { default: loadRoutesFromFileSystem } = await import(
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

    const routes = {
      ...this.#config.actions,
      ...this.#config.groups,
      ...fileSystemRoutes,
      ...this.#config.routes,
    }

    if (routes) {
      for (const [slug, def] of Object.entries(routes)) {
        if (def instanceof Page) {
          walkRouter(slug, def)
        } else {
          actionDefinitions.push({
            slug,
            ...('handler' in def ? def : {}),
            handler: undefined,
          })
          actionHandlers.set(slug, 'handler' in def ? def.handler : def)
        }
      }
    }

    this.#pageDefinitions = pageDefinitions
    this.#actionDefinitions = actionDefinitions
    this.#actionHandlers = actionHandlers
    this.#pageHandlers = pageHandlers
  }

  get #log() {
    return this.#logger
  }

  #pageIOClients = new Map<string, IOClient>()
  #ioResponseHandlers = new Map<string, (value: T_IO_RESPONSE) => void>()
  #pendingIOCalls = new Map<string, string>()
  #transactionLoadingStates = new Map<string, LoadingState>()
  #transactionCompleteCallbacks = new Map<
    string,
    [(output?: any) => void, (err?: any) => void]
  >()

  #ws: ISocket | undefined = undefined
  #dccMap = new Map<string, DataChannelConnection>()
  #pendingCandidatesMap = new Map<string, PeerCandidate[]>()
  #peerIdMap = new Map<string, string>()
  #peerIdToTransactionIdsMap = new Map<string, Set<string>>()

  #serverRpc:
    | DuplexRPCClient<typeof wsServerSchema, typeof hostSchema>
    | undefined = undefined
  #isConnected = false
  #isInitialized = false

  get isConnected() {
    return this.#isConnected
  }

  #reinitializeTimeout: NodeJS.Timeout | null = null

  handleActionsChange(config?: InternalConfig) {
    if (config !== undefined) {
      this.#config = config
    }

    if (this.#isInitialized && !this.#reinitializeTimeout) {
      this.#reinitializeTimeout = setTimeout(async () => {
        await this.#initializeHost()
        this.#reinitializeTimeout = null
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
      this.#transactionCompleteCallbacks.set(requestId, [resolve, reject])
    })

    if (!this.#isInitialized) {
      await this.#initializeHost(requestId)
    }

    return await result
  }

  close() {
    this.#intentionallyClosed = true

    if (this.#serverRpc) {
      this.#serverRpc = undefined
    }

    if (this.#ws) {
      this.#ws.close()
      this.#ws = undefined
    }

    for (const dcc of this.#dccMap.values()) {
      dcc.ds?.close()
      dcc.peer.close()
    }
    this.#dccMap.clear()

    this.#isConnected = false
  }

  async declareHost(httpHostId: string) {
    await this.#walkRoutes()

    const body: z.infer<typeof DECLARE_HOST['inputs']> = {
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
        throw new IntervalError('Received invalid API response.')
      })

    if (response.type === 'error') {
      throw new IntervalError(
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
      this.#log.warn('[Interval]', '⚠ Invalid slugs detected:\n')

      for (const slug of response.invalidSlugs) {
        this.#log.warn(`  - ${slug}`)
      }

      this.#log.warn(
        '\nAction slugs must contain only letters, numbers, underscores, periods, and hyphens.'
      )

      if (response.invalidSlugs.length === this.#actionDefinitions.length) {
        throw new IntervalError('No valid slugs provided')
      }
    }
  }

  /**
   * Resends pending IO calls upon reconnection.
   */
  async #resendPendingIOCalls(resendToTransactionIds?: string[]) {
    if (!this.#isConnected) return

    const toResend = resendToTransactionIds
      ? new Map(
          resendToTransactionIds
            .map(id => [id, this.#pendingIOCalls.get(id)])
            .filter(([, state]) => !!state) as [string, string][]
        )
      : new Map(this.#pendingIOCalls)

    while (toResend.size > 0) {
      await Promise.allSettled(
        Array.from(toResend.entries()).map(([transactionId, ioCall]) =>
          this.#send('SEND_IO_CALL', {
            transactionId,
            ioCall,
          })
            .then(response => {
              toResend.delete(transactionId)

              if (!response) {
                // Unsuccessful response, don't try again
                this.#pendingIOCalls.delete(transactionId)
              }
            })
            .catch(async err => {
              if (err instanceof IOError) {
                this.#logger.error(
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

              this.#logger.debug(
                `Trying again in ${Math.round(
                  this.#retryIntervalMs / 1000
                )}s...`
              )
              await sleep(this.#retryIntervalMs)
            })
        )
      )
    }
  }

  /**
   * Resends pending transaction loading states upon reconnection.
   */
  async #resendTransactionLoadingStates(resendToTransactionIds?: string[]) {
    if (!this.#isConnected) return

    const toResend = resendToTransactionIds
      ? new Map(
          resendToTransactionIds
            .map(id => [id, this.#transactionLoadingStates.get(id)])
            .filter(([, state]) => !!state) as [string, LoadingState][]
        )
      : new Map(this.#transactionLoadingStates)

    while (toResend.size > 0) {
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
                this.#logger.error(
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

              this.#logger.debug(
                `Trying again in ${Math.round(
                  this.#retryIntervalMs / 1000
                )}s...`
              )
              await sleep(this.#retryIntervalMs)
            })
        )
      )
    }
  }

  /**
   * Establishes the underlying ISocket connection to Interval.
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

    ws.onClose.attach(async ([code, reason]) => {
      if (this.#intentionallyClosed) {
        this.#intentionallyClosed = false
        return
      }

      this.#log.error(`❗ Could not connect to Interval (code ${code})`)

      if (reason) {
        this.#log.error('Reason:', reason)
      }

      if (this.#pingIntervalHandle) {
        clearInterval(this.#pingIntervalHandle)
        this.#pingIntervalHandle = undefined
      }
      // don't initialize retry process again if already started
      if (!this.#isConnected) return

      this.#log.prod('🔌 Reconnecting...')

      this.#isConnected = false

      while (!this.#isConnected) {
        this.#createSocketConnection({ instanceId: ws.id })
          .then(() => {
            this.#log.prod('⚡ Reconnection successful')
            this.#isConnected = true
            this.#resendPendingIOCalls()
            this.#resendTransactionLoadingStates()
          })
          .catch(() => {
            /* */
          })

        this.#log.prod(
          `Unable to connect. Retrying in ${Math.round(
            this.#retryIntervalMs / 1000
          )}s...`
        )
        await sleep(this.#retryIntervalMs)
      }
    })

    await ws.connect()

    this.#ws = ws
    this.#isConnected = true

    let lastSuccessfulPing = new Date()
    this.#pingIntervalHandle = setInterval(async () => {
      if (!this.#isConnected) {
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
          this.#logger.error(err)
        }

        if (
          lastSuccessfulPing.getTime() <
          new Date().getTime() - this.#closeUnresponsiveConnectionTimeoutMs
        ) {
          this.#logger.error(
            'No pong received in last three minutes, closing connection to Interval and retrying...'
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

  #createRPCHandlers(requestId?: string): DuplexRPCHandlers<HostSchema> {
    const intervalClient = this
    return {
      INITIALIZE_PEER_CONNECTION: async inputs => {
        if (typeof window !== 'undefined') return

        try {
          this.#logger.debug('INITIALIZE_PEER_CONNECTION:', inputs)
          switch (inputs.type) {
            case 'offer': {
              const { default: DataChannelConnection } = await import(
                './DataChannelConnection'
              )

              const iceConfig = await this.#interval.fetchIceConfig()

              const dcc = new DataChannelConnection({
                id: inputs.id,
                // TypeScript an enum and not a string, though they're equivalent
                iceServers: iceConfig.iceServers as IceServer[],
                send: inputs =>
                  this.#send('INITIALIZE_PEER_CONNECTION', inputs).catch(
                    err => {
                      this.#logger.debug(
                        'Failed sending initialize peer connection',
                        err
                      )
                    }
                  ),
                rpcConstructor: props => {
                  const rpc = this.#createRPCClient(props)
                  rpc.communicator.onOpen.attach(() => {
                    const set = this.#peerIdToTransactionIdsMap.get(inputs.id)
                    if (set) {
                      this.#resendTransactionLoadingStates(
                        Array.from(set.values())
                      )
                      this.#resendPendingIOCalls(Array.from(set.values()))
                    }
                  })
                  return rpc
                },
                isocketConfig: {
                  sendTimeout: this.#config.sendTimeoutMs,
                  connectTimeout: this.#config.connectTimeoutMs,
                  pingTimeout: this.#config.pingTimeoutMs,
                },
              })
              this.#dccMap.set(inputs.id, dcc)
              dcc.peer.setRemoteDescription(
                inputs.description,
                inputs.type as DescriptionType
              )
              dcc.peer.onStateChange(state => {
                this.#logger.debug('Peer state change:', state)
                if (
                  state === 'failed' ||
                  state === 'closed' ||
                  state === 'disconnected'
                ) {
                  this.#dccMap.delete(inputs.id)
                }
              })

              const pendingCandidates = this.#pendingCandidatesMap.get(
                inputs.id
              )
              if (pendingCandidates) {
                for (const candidate of pendingCandidates) {
                  dcc.peer.addRemoteCandidate(
                    candidate.candidate,
                    candidate.mid
                  )
                }
                this.#pendingCandidatesMap.delete(inputs.id)
              }

              break
            }
            case 'answer': {
              const dcc = this.#dccMap.get(inputs.id)

              if (dcc) {
                dcc.peer.setRemoteDescription(
                  inputs.description,
                  inputs.type as DescriptionType
                )
              } else {
                this.#logger.warn(
                  'INITIALIZE_PEER_CONNECTION:',
                  'DCC not found for inputs',
                  inputs
                )
              }
              break
            }
            case 'candidate': {
              const dcc = this.#dccMap.get(inputs.id)

              if (dcc) {
                dcc.peer.addRemoteCandidate(inputs.candidate, inputs.mid)
              } else {
                let pendingCandidates = this.#pendingCandidatesMap.get(
                  inputs.id
                )
                if (!pendingCandidates) {
                  pendingCandidates = []
                  this.#pendingCandidatesMap.set(inputs.id, pendingCandidates)
                }
                pendingCandidates.push(inputs)
              }
              break
            }
          }
        } catch (err) {
          this.#logger.error('Failed initializing peer connection', err)
        }
      },
      START_TRANSACTION: async inputs => {
        if (!intervalClient.organization) {
          intervalClient.#log.error('No organization defined')
          return
        }

        const { action, transactionId, clientId } = inputs
        const prevClientId = this.#peerIdMap.get(transactionId)

        if (clientId && clientId !== prevClientId) {
          this.#peerIdMap.set(transactionId, clientId)
          let set = this.#peerIdToTransactionIdsMap.get(clientId)
          if (!set) {
            set = new Set()
            this.#peerIdToTransactionIdsMap.set(clientId, set)
          }
          set.add(transactionId)
        }

        if (this.#ioResponseHandlers.has(transactionId)) {
          this.#logger.debug('Transaction already started, not starting again')

          if (clientId !== prevClientId) {
            // only resend if is a new peer connection
            this.#resendPendingIOCalls([transactionId])
            this.#resendTransactionLoadingStates([transactionId])
          }

          return
        }

        const actionHandler = intervalClient.#actionHandlers.get(action.slug)

        intervalClient.#log.debug(actionHandler)

        if (!actionHandler) {
          intervalClient.#log.debug('No actionHandler called', action.slug)
          return
        }

        const client = new IOClient({
          logger: intervalClient.#logger,
          send: async ioRenderInstruction => {
            const ioCall = JSON.stringify(ioRenderInstruction)
            intervalClient.#pendingIOCalls.set(transactionId, ioCall)

            if (this.#config.getClientHandlers) {
              await this.#config.getClientHandlers()?.RENDER({
                transactionId,
                toRender: ioCall,
              })
            } else {
              let attemptPeerSend = true
              for (const renderMethod of ioRenderInstruction.toRender) {
                const methodName = renderMethod.methodName as T_IO_METHOD_NAMES
                if (requiresServer(methodName)) {
                  attemptPeerSend = false
                  break
                }
              }

              await intervalClient.#send(
                'SEND_IO_CALL',
                {
                  transactionId,
                  ioCall,
                },
                {
                  attemptPeerSend,
                }
              )
            }

            intervalClient.#transactionLoadingStates.delete(transactionId)
          },
          isDemo: !!this.#config.getClientHandlers,
          // onAddInlineAction: handler => {
          //   const key = v4()
          //   intervalClient.#actionHandlers.set(key, handler)
          //   return key
          // },
        })

        intervalClient.#ioResponseHandlers.set(
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
          organization: intervalClient.organization,
          action,
          log: (...args) =>
            intervalClient.#sendLog(transactionId, logIndex++, ...args),
          notify: async config => {
            await intervalClient.#interval.notify({
              ...config,
              transactionId: inputs.transactionId,
            })
          },
          loading: new TransactionLoadingState({
            logger: intervalClient.#logger,
            send: async loadingState => {
              intervalClient.#transactionLoadingStates.set(
                transactionId,
                loadingState
              )
              if (this.#config.getClientHandlers) {
                await this.#config.getClientHandlers()?.LOADING_STATE({
                  transactionId,
                  ...loadingState,
                })
              } else {
                await intervalClient.#send('SEND_LOADING_CALL', {
                  transactionId,
                  ...loadingState,
                })
              }
            },
          }),
          redirect: (props: LegacyLinkProps) =>
            intervalClient.#sendRedirect(transactionId, props),
        }

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

              intervalClient.#logger.error(err)

              let data: IOFunctionReturnType = null
              if (err instanceof IOError && err.cause) {
                err = err.cause
              }

              if (err instanceof Error) {
                data = {
                  error: err.name,
                  message: err.message,
                }
              }

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
                await intervalClient.#send('MARK_TRANSACTION_COMPLETE', {
                  transactionId,
                  resultStatus: res.status,
                  result: JSON.stringify(res),
                })
              }

              if (requestId) {
                const callbacks =
                  intervalClient.#transactionCompleteCallbacks.get(requestId)
                if (callbacks) {
                  const [resolve] = callbacks
                  resolve()
                } else {
                  intervalClient.#log.debug(
                    'No transaction complete callbacks found for requestId',
                    requestId
                  )
                }
              }
            })
            .catch(err => {
              if (err instanceof IOError) {
                switch (err.kind) {
                  case 'CANCELED':
                    intervalClient.#log.prod(
                      'Transaction canceled for action',
                      action.slug
                    )
                    break
                  case 'TRANSACTION_CLOSED':
                    intervalClient.#log.prod(
                      'Attempted to make IO call after transaction already closed in action',
                      action.slug
                    )
                    break
                }
              } else {
                intervalClient.#log.error('Error sending action response', err)
              }

              if (requestId) {
                const callbacks =
                  intervalClient.#transactionCompleteCallbacks.get(requestId)
                if (callbacks) {
                  const [_, reject] = callbacks
                  reject(err)
                } else {
                  intervalClient.#log.debug(
                    'No transaction complete callbacks found for requestId',
                    requestId
                  )
                }
              }
            })
            .finally(() => {
              intervalClient.#pendingIOCalls.delete(transactionId)
              intervalClient.#transactionLoadingStates.delete(transactionId)
              intervalClient.#ioResponseHandlers.delete(transactionId)
              for (const key of client.inlineActionKeys.values()) {
                intervalClient.#actionHandlers.delete(key)
              }

              const peerId = this.#peerIdMap.get(transactionId)
              if (peerId) {
                this.#peerIdMap.delete(transactionId)
                this.#peerIdToTransactionIdsMap
                  .get(peerId)
                  ?.delete(transactionId)
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
        this.#log.debug('got io response', inputs)

        try {
          const ioResp = IO_RESPONSE.parse(JSON.parse(inputs.value))
          const replyHandler = this.#ioResponseHandlers.get(
            ioResp.transactionId
          )

          if (!replyHandler) {
            this.#log.debug('Missing reply handler for', inputs.transactionId)
            return
          }

          replyHandler(ioResp)
        } catch (err) {
          if (err instanceof ZodError) {
            this.#log.error('Received invalid IO response:', inputs)
            this.#log.debug(err)
          } else {
            this.#log.error('Failed handling IO response:', err)
          }
        }
      },
      OPEN_PAGE: async inputs => {
        if (!this.organization) {
          this.#log.error('No organization defined')
          return { type: 'ERROR' as const }
        }

        const { pageKey, clientId } = inputs
        const pageHandler = this.#pageHandlers.get(inputs.page.slug)

        if (clientId) {
          this.#peerIdMap.set(pageKey, clientId)
        }

        if (!pageHandler) {
          this.#log.debug('No app handler called', inputs.page.slug)
          return { type: 'ERROR' as const }
        }

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
        }

        let page: Layout
        let menuItems: InternalButtonItem[] | undefined = undefined
        let renderInstruction: T_IO_RENDER_INPUT | undefined = undefined
        let errors: PageError[] = []

        const MAX_PAGE_RETRIES = 5

        const sendPage = async () => {
          if (page instanceof BasicLayout) {
            const pageLayout: LayoutSchemaInput = {
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

            if (this.#config.getClientHandlers) {
              await this.#config.getClientHandlers()?.RENDER_PAGE({
                pageKey,
                page: JSON.stringify(pageLayout),
                hostInstanceId: 'demo',
              })
            } else {
              for (let i = 0; i < MAX_PAGE_RETRIES; i++) {
                try {
                  await this.#send('SEND_PAGE', {
                    pageKey,
                    page: JSON.stringify(pageLayout),
                  })
                  return
                } catch (err) {
                  this.#logger.debug('Failed sending page', err)
                  this.#logger.debug('Retrying in', this.#retryIntervalMs)
                  await sleep(this.#retryIntervalMs)
                }
              }
              throw new IntervalError(
                'Unsuccessful sending page, max retries exceeded.'
              )
            }
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
          newPageScheduled = false
          pageSendTimeout = null
          sendPagePromise = sendPage()
            .catch(err => {
              this.#logger.error(`Failed sending page with key ${pageKey}`, err)
            })
            .finally(() => {
              sendPagePromise = null

              if (newPageScheduled) {
                scheduleSendPage()
              }
            })
        }

        const scheduleSendPage = () => {
          newPageScheduled = true

          if (sendPagePromise) return
          if (pageSendTimeout) return

          pageSendTimeout = setTimeout(processSendPage, 0)
        }

        const client = new IOClient({
          logger: this.#logger,
          send: async instruction => {
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

        this.#pageIOClients.set(pageKey, client)
        this.#ioResponseHandlers.set(pageKey, client.onResponse.bind(client))

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

              if (typeof page.title === 'function') {
                try {
                  page.title = page.title()
                } catch (err) {
                  this.#logger.error(err)
                  errors.push(pageError(err, 'title'))
                }
              }

              if (page.title instanceof Promise) {
                page.title
                  .then(title => {
                    page.title = title
                    scheduleSendPage()
                  })
                  .catch(err => {
                    this.#logger.error(err)
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
                    errors.push(pageError(err, 'description'))
                  }
                }

                if (page.description instanceof Promise) {
                  page.description
                    .then(description => {
                      page.description = description
                      scheduleSendPage()
                    })
                    .catch(err => {
                      this.#logger.error(err)
                      errors.push(pageError(err, 'description'))
                      scheduleSendPage()
                    })
                }
              }

              if (page.menuItems) {
                menuItems = page.menuItems.map(menuItem => {
                  // if (
                  //   'action' in menuItem &&
                  //   typeof menuItem['action'] === 'function'
                  // ) {
                  //   const inlineAction = client.addInlineAction(menuItem.action)
                  //   return {
                  //     ...menuItem,
                  //     inlineAction,
                  //   }
                  // }

                  return menuItem
                })
              }

              if ('metadata' in page) {
                this.#logger.warn(
                  'The `metadata` property on `Layout` is deprecated. Please use `io.display.metadata` in the `children` array instead.'
                )
              }

              if (page.children) {
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
                    if (err instanceof IOError && err.cause) {
                      errors.push(pageError(err.cause))
                    } else {
                      errors.push(pageError(err))
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

        if (pageLocalStorage) {
          pageLocalStorage.run({ display, ctx }, () => {
            handlePage()
          })
        } else {
          handlePage()
        }

        return {
          type: 'SUCCESS' as const,
          pageKey,
        }
      },
      CLOSE_PAGE: async inputs => {
        const client = this.#pageIOClients.get(inputs.pageKey)
        if (client) {
          for (const key of client.inlineActionKeys.values()) {
            this.#actionHandlers.delete(key)
          }

          client.inlineActionKeys.clear()
          this.#pageIOClients.delete(inputs.pageKey)
        }

        this.#peerIdMap.delete(inputs.pageKey)
        this.#ioResponseHandlers.delete(inputs.pageKey)
      },
    }
  }

  /**
   * Creates the DuplexRPCClient responsible for sending
   * messages to Interval.
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
   * Sends the `INITIALIZE_HOST` RPC call to Interval,
   * declaring the actions that this host is responsible for handling.
   */
  async #initializeHost(requestId?: string) {
    if (!this.#ws) {
      throw new IntervalError('ISocket not initialized')
    }

    if (!this.#serverRpc) {
      throw new IntervalError('serverRpc not initialized')
    }

    const isInitialInitialization = !this.#isInitialized
    this.#isInitialized = true

    await this.#walkRoutes()

    const response = await this.#send('INITIALIZE_HOST', {
      apiKey: this.#apiKey,
      actions: this.#actionDefinitions,
      groups: this.#pageDefinitions,
      sdkName: pkg.name,
      sdkVersion: pkg.version,
      requestId,
    })

    if (!response) {
      throw new IntervalError('Unknown error')
    }

    if (response.sdkAlert) {
      this.#log.handleSdkAlert(response.sdkAlert)
    }

    if (response.type === 'error') {
      throw new IntervalError(response.message)
    } else {
      if (response.invalidSlugs.length > 0) {
        this.#log.warn('[Interval]', '⚠ Invalid slugs detected:\n')

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
      this.#forcePeerMessages = response.forcePeerMessages ?? false

      if (isInitialInitialization) {
        this.#log.prod(
          `🔗 Connected! Access your actions at: ${response.dashboardUrl}`
        )
        this.#log.debug('Host ID:', this.#ws.id)
      }
    }

    return response
  }

  async #sendToClientPeer<MethodName extends keyof ClientSchema>(
    rpc: NonNullable<DataChannelConnection['rpc']>,
    methodName: MethodName,
    inputs: z.input<ClientSchema[MethodName]['inputs']>
  ) {
    const NUM_P2P_TRIES = 3
    for (let i = 0; i <= NUM_P2P_TRIES; i++) {
      try {
        return await rpc.send(methodName, inputs)
      } catch (err) {
        if (err instanceof TimeoutError) {
          this.#log.debug(
            `Peer RPC call timed out, retrying in ${Math.round(
              this.#retryIntervalMs / 1000
            )}s...`
          )
          this.#log.debug(err)
          sleep(this.#retryIntervalMs)
        } else {
          throw err
        }
      }
    }

    throw new TimeoutError()
  }

  /**
   * @returns undefined if was unsent, null if was sent but should send via server anyway,
   * and true/false if was sent but should not send. This is obviously pretty bad code, should be fixed.
   */
  async #attemptPeerSend<MethodName extends keyof WSServerSchema>(
    methodName: MethodName,
    serverInputs: z.input<WSServerSchema[MethodName]['inputs']>
  ): Promise<
    z.input<WSServerSchema[MethodName]['returns']> | undefined | null
  > {
    const hostInstanceId = this.#ws?.id
    let dcc: DataChannelConnection | undefined
    const sessionKey = serverInputs
      ? 'transactionId' in serverInputs
        ? serverInputs.transactionId
        : 'pageKey' in serverInputs
        ? serverInputs.pageKey
        : undefined
      : undefined

    if (sessionKey) {
      const key = this.#peerIdMap.get(sessionKey)
      if (key) {
        dcc = this.#dccMap.get(key)
      }
    }

    if (hostInstanceId && dcc?.rpc) {
      this.#logger.debug(
        'Sending with peer connection',
        methodName,
        serverInputs
      )

      switch (methodName) {
        case 'SEND_LOG': {
          const inputs = serverInputs as z.input<
            WSServerSchema['SEND_LOG']['inputs']
          >

          await this.#sendToClientPeer(dcc.rpc, 'LOG', {
            ...inputs,
            index: inputs.index as number,
            timestamp: inputs.timestamp as number,
          })

          // send to backend too
          return null
        }
        case 'SEND_PAGE': {
          const inputs = serverInputs as z.input<
            WSServerSchema['SEND_PAGE']['inputs']
          >
          return await this.#sendToClientPeer(dcc.rpc, 'RENDER_PAGE', {
            ...inputs,
            hostInstanceId,
          })
        }
        case 'SEND_IO_CALL': {
          const inputs = serverInputs as z.input<
            WSServerSchema['SEND_IO_CALL']['inputs']
          >
          const response = await this.#sendToClientPeer(dcc.rpc, 'RENDER', {
            transactionId: inputs.transactionId,
            toRender: inputs.ioCall,
          })

          if (this.#forcePeerMessages) {
            return response
          } else {
            // send to backend too
            return null
          }
        }
        case 'MARK_TRANSACTION_COMPLETE': {
          const inputs = serverInputs as z.input<
            WSServerSchema['MARK_TRANSACTION_COMPLETE']['inputs']
          >
          await this.#sendToClientPeer(dcc.rpc, 'TRANSACTION_COMPLETED', {
            transactionId: inputs.transactionId,
            resultStatus: inputs.resultStatus ?? 'SUCCESS',
            result: inputs.result,
          })

          // send to backend too
          return null
        }
        case 'SEND_REDIRECT': {
          const inputs = serverInputs as z.input<
            WSServerSchema['SEND_REDIRECT']['inputs']
          >

          if ('url' in inputs) {
            await this.#sendToClientPeer(dcc.rpc, 'REDIRECT', {
              transactionId: inputs.transactionId,
              url: inputs.url,
            })
          } else if ('route' in inputs) {
            await this.#sendToClientPeer(dcc.rpc, 'REDIRECT', {
              transactionId: inputs.transactionId,
              route: inputs.route,
              params: inputs.params,
            })
          } else {
            await this.#sendToClientPeer(dcc.rpc, 'REDIRECT', {
              transactionId: inputs.transactionId,
              route: inputs.action,
              params: inputs.params,
            })
          }

          // send to backend too
          return null
        }
        case 'SEND_LOADING_CALL': {
          const inputs = serverInputs as z.input<
            WSServerSchema['SEND_LOADING_CALL']['inputs']
          >
          const response = await this.#sendToClientPeer(
            dcc.rpc,
            'LOADING_STATE',
            {
              ...inputs,
            }
          )

          if (this.#forcePeerMessages) {
            return response
          } else {
            // send to backend too
            return null
          }
        }
        default:
          this.#logger.debug(
            'Unsupported peer method',
            methodName,
            'sending via server'
          )
      }
    } else {
      if (
        this.#forcePeerMessages &&
        ['SEND_LOADING_CALL', 'SEND_IO_CALL', 'SEND_PAGE'].includes(methodName)
      )
        this.#logger.debug(
          'No peer connection established, skipping',
          methodName,
          serverInputs
        )
    }

    return undefined
  }

  async #send<MethodName extends keyof WSServerSchema>(
    methodName: MethodName,
    inputs: z.input<WSServerSchema[MethodName]['inputs']>,
    { attemptPeerSend = true }: { attemptPeerSend?: boolean } = {}
  ) {
    if (!this.#serverRpc) throw new IntervalError('serverRpc not initialized')

    let skipClientCall = false

    try {
      if (attemptPeerSend) {
        const peerResponse = await this.#attemptPeerSend(methodName, inputs)

        if (peerResponse != null) {
          return peerResponse
        } else if (peerResponse === null) {
          skipClientCall = true
        }
      }
    } catch (err) {
      this.#logger.debug('Error from peer RPC', err)
    }

    while (true) {
      try {
        this.#logger.debug('Sending via server', methodName, inputs)
        return await this.#serverRpc.send(methodName, {
          ...inputs,
          skipClientCall,
        })
      } catch (err) {
        if (err instanceof TimeoutError) {
          this.#log.debug(
            `RPC call timed out, retrying in ${Math.round(
              this.#retryIntervalMs / 1000
            )}s...`
          )
          this.#log.debug(err)
          sleep(this.#retryIntervalMs)
        } else {
          throw err
        }
      }
    }
  }

  /**
   * This is used for testing and intentionally non-private.
   * Do not use unless you're absolutely sure what you're doing.
   */
  protected async __dangerousInternalSend(methodName: any, inputs: any) {
    if (!this.#serverRpc) throw new IntervalError('serverRpc not initialized')

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
        this.#logger.error('Failed sending log to Interval', err)
      })
    }
  }

  async #sendRedirect(transactionId: string, props: LegacyLinkProps) {
    if (this.#config.getClientHandlers) {
      throw new IntervalError(
        `The ctx.redirect method isn't supported in demo mode`
      )
    }

    const response = await this.#send('SEND_REDIRECT', {
      transactionId,
      ...props,
    })

    if (!response) {
      throw new IntervalError('Failed sending redirect')
    }
  }
}
