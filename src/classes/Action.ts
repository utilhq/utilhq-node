import { AccessControlDefinition } from '../internalRpcSchema'
import {
  ExplicitIntervalActionDefinition,
  IntervalActionDefinition,
  IntervalActionHandler,
} from '../types'

export default class Action implements ExplicitIntervalActionDefinition {
  handler: IntervalActionHandler
  backgroundable?: boolean
  unlisted?: boolean
  name?: string
  description?: string
  accessControl?: AccessControlDefinition

  constructor(
    def: ExplicitIntervalActionDefinition | IntervalActionDefinition
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
