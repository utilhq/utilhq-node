import { AccessControlDefinition } from '../internalRpcSchema'
import {
  ExplicitUtilHQActionDefinition,
  UtilHQActionDefinition,
  UtilHQActionHandler,
} from '../types'

export default class Action implements ExplicitUtilHQActionDefinition {
  handler: UtilHQActionHandler
  backgroundable?: boolean
  unlisted?: boolean
  warnOnClose?: boolean
  name?: string
  description?: string
  access?: AccessControlDefinition

  constructor(
    def: ExplicitUtilHQActionDefinition | UtilHQActionDefinition
  ) {
    if (typeof def === 'function') {
      this.handler = def
    } else {
      Object.assign(this, def)
      // to appease typescript
      this.handler = def.handler
    }
  }
}
