import { Evt } from 'evt'
import { AccessControlDefinition } from '../internalRpcSchema'
import {
  UtilHQActionDefinition,
  UtilHQPageHandler,
  UtilHQRouteDefinitions,
} from '../types'

export interface PageConfig {
  name: string
  description?: string
  unlisted?: boolean
  actions?: Record<string, UtilHQActionDefinition>
  groups?: Record<string, Page>
  routes?: UtilHQRouteDefinitions
  handler?: UtilHQPageHandler
  access?: AccessControlDefinition
}

export default class Page {
  name: string
  description?: string
  unlisted?: boolean
  routes: UtilHQRouteDefinitions
  handler?: UtilHQPageHandler
  access?: AccessControlDefinition

  onChange: Evt<void>
  #groupChangeCtx = Evt.newCtx()

  constructor(config: PageConfig) {
    this.name = config.name
    this.description = config.description
    this.unlisted = config.unlisted
    this.routes = {
      ...config.routes,
      ...config.actions,
      ...config.groups,
    }
    this.access = config.access
    this.handler = config.handler
    this.onChange = new Evt()

    for (const actionOrGroup of Object.values(this.routes)) {
      if (actionOrGroup instanceof Page) {
        actionOrGroup.onChange.attach(this.#groupChangeCtx, this.onChange.post)
      }
    }
  }

  add(slug: string, route: UtilHQActionDefinition | Page) {
    this.routes[slug] = route

    if (route instanceof Page) {
      route.onChange.attach(this.#groupChangeCtx, this.onChange.post)
    }

    this.onChange.post()
  }

  remove(slug: string) {
    const route = this.routes[slug]
    if (route) {
      if (route instanceof Page) {
        route.onChange.detach(this.#groupChangeCtx)
      }

      delete this.routes[slug]
      this.onChange.post()
    }
  }
}
