import Logger from './Logger'
import UtilHQ, { UtilHQActionDefinition, Page, QueuedAction } from '..'
import { Ctx } from 'evt'

/**
 * This is effectively a namespace inside of utilhq with a little bit of its own state.
 */
export default class Routes {
  protected utilhq: UtilHQ
  #logger: Logger
  #apiKey?: string
  #endpoint: string
  #groupChangeCtx: Ctx<void>

  constructor(
    utilhq: UtilHQ,
    endpoint: string,
    logger: Logger,
    ctx: Ctx<void>,
    apiKey?: string
  ) {
    this.utilhq = utilhq
    this.#apiKey = apiKey
    this.#logger = logger
    this.#endpoint = endpoint + '/api/actions'
    this.#groupChangeCtx = ctx
  }

  /**
   * @deprecated Use `utilhq.enqueue()` instead.
   */
  async enqueue(
    slug: string,
    args: Pick<QueuedAction, 'assignee' | 'params'> = {}
  ): Promise<QueuedAction> {
    return this.utilhq.enqueue(slug, args)
  }

  /**
   * @deprecated Use `utilhq.dequeue()` instead.
   */
  async dequeue(id: string): Promise<QueuedAction> {
    return this.utilhq.dequeue(id)
  }

  add(slug: string, route: UtilHQActionDefinition | Page) {
    if (!this.utilhq.config.routes) {
      this.utilhq.config.routes = {}
    }

    if (route instanceof Page) {
      route.onChange.attach(this.#groupChangeCtx, () => {
        this.utilhq.client?.handleActionsChange(this.utilhq.config)
      })
    }

    this.utilhq.config.routes[slug] = route
    this.utilhq.client?.handleActionsChange(this.utilhq.config)
  }

  remove(slug: string) {
    for (const key of ['routes', 'actions', 'groups'] as const) {
      const routes = this.utilhq.config[key]

      if (!routes) continue
      const route = routes[slug]
      if (!route) continue

      if (route instanceof Page) {
        route.onChange.detach(this.#groupChangeCtx)
      }

      delete routes[slug]

      this.utilhq.client?.handleActionsChange(this.utilhq.config)
      return
    }
  }
}
