import { z } from 'zod'
import fetch from 'cross-fetch'
import Routes from './classes/Routes'
import IOError from './classes/IOError'
import Logger, { LogLevel } from './classes/Logger'
import Page from './classes/Page'
import {
  NOTIFY,
  ClientSchema,
  HostSchema,
  ICE_CONFIG,
  IceConfig,
  ENQUEUE_ACTION,
  DEQUEUE_ACTION,
} from './internalRpcSchema'
import { DuplexRPCHandlers } from './classes/DuplexRPCClient'
import { SerializableRecord } from './ioSchema'
import type {
  ActionCtx,
  ActionLogFn,
  IO,
  IntervalActionHandler,
  IntervalActionStore,
  NotifyConfig,
  IntervalRouteDefinitions,
  IntervalPageStore,
  PageCtx,
  IntervalActionDefinition,
} from './types'
import IntervalError from './classes/IntervalError'
import IntervalClient, {
  DEFAULT_WEBSOCKET_ENDPOINT,
  getHttpEndpoint,
  actionLocalStorage,
  pageLocalStorage,
} from './classes/IntervalClient'
import Action from './classes/Action'
import { BasicLayout } from './classes/Layout'
import { Evt } from 'evt'
import superjson from './utils/superjson'

export type {
  ActionCtx,
  ActionLogFn,
  IO,
  IntervalActionHandler,
  IntervalActionDefinition,
  IntervalActionStore,
}

export interface InternalConfig {
  apiKey?: string
  routes?: IntervalRouteDefinitions
  routesDirectory?: string
  // TODO: Mark as deprecated soon, remove soon afterward
  actions?: Record<string, IntervalActionDefinition>
  // TODO: Mark as deprecated soon, remove soon afterward
  groups?: Record<string, Page>
  endpoint?: string
  logLevel?: LogLevel
  retryIntervalMs?: number
  retryChunkIntervalMs?: number
  pingIntervalMs?: number
  connectTimeoutMs?: number
  sendTimeoutMs?: number
  pingTimeoutMs?: number
  completeHttpRequestDelayMs?: number

  closeUnresponsiveConnectionTimeoutMs?: number
  reinitializeBatchTimeoutMs?: number
  /* @internal */ getClientHandlers?: () =>
    | DuplexRPCHandlers<ClientSchema>
    | undefined
  /* @internal */ setHostHandlers?: (
    handlers: DuplexRPCHandlers<HostSchema>
  ) => void
}

export interface QueuedAction {
  id: string
  assignee?: string
  params?: SerializableRecord
}

export function getActionStore(): IntervalActionStore {
  if (!actionLocalStorage) {
    throw new IntervalError(
      'Global io and ctx objects are only available in a Node.js context.'
    )
  }

  const store = actionLocalStorage.getStore()
  if (!store) {
    throw new IntervalError(
      'Global io and ctx objects can only be used inside a Page or Action.'
    )
  }

  return store
}

export function getPageStore(): IntervalPageStore {
  if (!pageLocalStorage) {
    throw new IntervalError(
      'Global io and ctx objects are only available in a Node.js context.'
    )
  }

  const store = pageLocalStorage.getStore()
  if (!store) {
    throw new IntervalError(
      'Global io and ctx objects can only be used inside a Page or Action.'
    )
  }

  return store
}

export function getSomeStore(): IntervalActionStore | IntervalPageStore {
  try {
    return getPageStore()
  } catch (err) {
    return getActionStore()
  }
}

// prettier-ignore
export const io: IO = {
  get group() { return getActionStore().io.group },
  get confirm() { return getActionStore().io.confirm },
  get confirmIdentity() { return getActionStore().io.confirmIdentity },
  get search() { return getActionStore().io.search },
  get input() { return getActionStore().io.input },
  get select() { return getActionStore().io.select },
  get display() {
    try {
      return getPageStore().display
    } catch (err) {
      return getActionStore().io.display
    }
  },
  get experimental() { return getActionStore().io.experimental },
}

// prettier-ignore
export const ctx: ActionCtx & PageCtx = {
  get user() { return getSomeStore().ctx.user },
  get params() { return getSomeStore().ctx.params },
  get environment() { return getSomeStore().ctx.environment },
  get loading() { return getActionStore().ctx.loading },
  get log() { return getActionStore().ctx.log },
  get organization() { return getSomeStore().ctx.organization },
  get action() { return getActionStore().ctx.action },
  get page() { return getPageStore().ctx.page },
  get notify() { return getActionStore().ctx.notify },
  get redirect() { return getActionStore().ctx.redirect },
}

export default class Interval {
  config: InternalConfig
  #logger: Logger
  #client: IntervalClient | undefined
  #apiKey: string | undefined
  #httpEndpoint: string
  #groupChangeCtx = Evt.newCtx()
  routes: Routes

  constructor(config: InternalConfig) {
    this.config = config
    this.#apiKey = config.apiKey
    this.#logger = new Logger(config.logLevel)

    this.#httpEndpoint = getHttpEndpoint(
      config.endpoint ?? DEFAULT_WEBSOCKET_ENDPOINT
    )

    this.routes = new Routes(
      this,
      this.#httpEndpoint,
      this.#logger,
      this.#groupChangeCtx,
      this.#apiKey
    )

    const routes = {
      ...this.config.actions,
      ...this.config.groups,
      ...this.config.routes,
    }

    if (routes) {
      for (const group of Object.values(routes)) {
        if (group instanceof Page) {
          group.onChange.attach(this.#groupChangeCtx, () => {
            this.client?.handleActionsChange(this.config)
          })
        }
      }
    }
  }

  // TODO: Mark as deprecated soon, remove soon afterward
  get actions(): Routes {
    return this.routes
  }

  protected get apiKey(): string | undefined {
    return this.#apiKey
  }

  protected get httpEndpoint(): string {
    return this.#httpEndpoint
  }

  get #log() {
    return this.#logger
  }

  protected get log() {
    return this.#logger
  }

  get isConnected(): boolean {
    return this.#client?.isConnected ?? false
  }

  /**
   * Establish the persistent connection to Interval.
   */
  async listen() {
    if (!this.#client) {
      this.#client = new IntervalClient(this, this.config)
    }
    return this.#client.listen()
  }

  /**
   * Immediately terminate the connection to interval, terminating any actions currently in progress.
   */
  immediatelyClose() {
    return this.#client?.immediatelyClose()
  }

  /**
   * Safely close the connection to Interval, preventing new actions from being launched and closing the persistent connection afterward. Resolves when the connection is successfully safely closed.
   */
  async safelyClose(): Promise<void> {
    return this.#client?.safelyClose()
  }

  /* @internal */ get client() {
    return this.#client
  }

  async fetchIceConfig(): Promise<IceConfig> {
    const response = await fetch(`${this.#httpEndpoint}/api/ice-config`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${this.#apiKey}`,
      },
    }).then(r => r.json())

    const parsed = ICE_CONFIG.parse(response)

    return parsed
  }

  /**
   * Sends a custom notification to Interval users via email or Slack. To send Slack notifications, you'll need to connect your Slack workspace to the Interval app in your organization settings.
   *
   * **Usage:**
   *
   * ```typescript
   * await ctx.notify({
   *   message: "A charge of $500 was refunded",
   *   title: "Refund over threshold",
   *   delivery: [
   *     {
   *       to: "#interval-notifications",
   *       method: "SLACK",
   *     },
   *     {
   *       to: "foo@example.com",
   *     },
   *   ],
   * });
   * ```
   */
  async notify(config: NotifyConfig): Promise<void> {
    if (
      !config.transactionId &&
      (this.#client?.environment === 'development' ||
        (!this.#client?.environment && !this.#apiKey?.startsWith('live_')))
    ) {
      this.#log.warn(
        'Calls to notify() outside of a transaction currently have no effect when Interval is instantiated with a development API key. Please use a live key to send notifications.'
      )
    }

    const clientHandlers = this.config.getClientHandlers?.()
    if (clientHandlers) {
      clientHandlers.NOTIFY({
        ...config,
        transactionId: config.transactionId ?? 'demo',
        deliveries: config.delivery || [
          {
            method: 'EMAIL',
            to: 'demo@interval.com',
          },
        ],
      })
      return
    }

    let body: z.infer<(typeof NOTIFY)['inputs']>
    try {
      body = NOTIFY.inputs.parse({
        ...config,
        deliveryInstructions: config.delivery,
        createdAt: new Date().toISOString(),
      })
    } catch (err) {
      this.#logger.debug(err)
      throw new IntervalError('Invalid input.')
    }

    const response = await fetch(`${this.#httpEndpoint}/api/notify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.#apiKey}`,
      },
      body: JSON.stringify(body),
    })
      .then(r => r.json())
      .then(r => NOTIFY.returns.parseAsync(r))
      .catch(err => {
        this.#logger.debug(err)
        throw new IntervalError('Received invalid API response.')
      })

    if (response.type === 'error') {
      throw new IntervalError(
        `There was a problem sending the notification: ${response.message}`
      )
    }
  }

  #getQueueAddress(path: string): string {
    if (path.startsWith('/')) {
      path = path.substring(1)
    }

    return `${this.#httpEndpoint}/api/actions/${path}`
  }

  /**
   * Enqueue an action to be completed, with an optional `assignee` email to assign the action to, and optional `params` which will be passed to the action as `ctx.params`. Assigned actions will be displayed in users' dashboards as a task list.
   */
  async enqueue(
    slug: string,
    { assignee, params }: Pick<QueuedAction, 'assignee' | 'params'> = {}
  ): Promise<QueuedAction> {
    let body: z.infer<(typeof ENQUEUE_ACTION)['inputs']>
    try {
      const { json, meta } = params
        ? superjson.serialize(params)
        : { json: undefined, meta: undefined }
      body = ENQUEUE_ACTION.inputs.parse({
        assignee,
        slug,
        params: json,
        paramsMeta: meta,
      })
    } catch (err) {
      this.#logger.debug(err)
      throw new IntervalError('Invalid input.')
    }

    const response = await fetch(this.#getQueueAddress('enqueue'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.#apiKey}`,
      },
      body: JSON.stringify(body),
    })
      .then(r => r.json())
      .then(r => ENQUEUE_ACTION.returns.parseAsync(r))
      .catch(err => {
        this.#logger.debug(err)
        throw new IntervalError('Received invalid API response.')
      })

    if (response.type === 'error') {
      throw new IntervalError(
        `There was a problem enqueuing the action: ${response.message}`
      )
    }

    return {
      id: response.id,
      assignee,
      params,
    }
  }

  /**
   * Dequeue a previously assigned action which was created with `interval.enqueue()`.
   */
  async dequeue(id: string): Promise<QueuedAction> {
    let body: z.infer<(typeof DEQUEUE_ACTION)['inputs']>
    try {
      body = DEQUEUE_ACTION.inputs.parse({
        id,
      })
    } catch (err) {
      this.#logger.debug(err)
      throw new IntervalError('Invalid input.')
    }

    const response = await fetch(this.#getQueueAddress('dequeue'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.#apiKey}`,
      },
      body: JSON.stringify(body),
    })
      .then(r => r.json())
      .then(r => DEQUEUE_ACTION.returns.parseAsync(r))
      .catch(err => {
        this.#logger.debug(err)
        throw new IntervalError('Received invalid API response.')
      })

    if (response.type === 'error') {
      throw new IntervalError(
        `There was a problem enqueuing the action: ${response.message}`
      )
    }

    let { type, params, paramsMeta, ...rest } = response

    if (paramsMeta && params) {
      params = superjson.deserialize({ json: params, meta: paramsMeta })
    }

    return {
      ...rest,
      params,
    }
  }
}

export { Interval, IOError, IntervalError, Action, Page, BasicLayout as Layout }
