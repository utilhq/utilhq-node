import {
  BackwardCompatibleLoadingOptions,
  BackwardCompatibleLoadingState,
} from '../internalRpcSchema'
import Logger from './Logger'

export interface TransactionLoadingStateConfig {
  logger: Logger
  send: (loadingState: BackwardCompatibleLoadingState) => Promise<void>
}

export default class TransactionLoadingState {
  #logger: Logger
  #sender: TransactionLoadingStateConfig['send']
  #state: BackwardCompatibleLoadingState | undefined
  #sendTimeout: NodeJS.Timeout | null = null
  #sendTimeoutMs = 100

  constructor(config: TransactionLoadingStateConfig) {
    this.#sender = config.send
    this.#logger = config.logger
  }

  async #sendState() {
    if (!this.#sendTimeout) {
      // Buffer send calls for 100ms to prevent accidental DoSing with
      // many loading calls
      this.#sendTimeout = setTimeout(() => {
        this.#sender(this.#state ?? {}).catch(err => {
          this.#logger.error('Failed sending loading state to utilhq')
          this.#logger.debug(err)
        })
        this.#sendTimeout = null
      }, this.#sendTimeoutMs)
    }
  }

  get state() {
    return { ...this.#state }
  }

  /**
   * Kicks off a loading spinner to provide context during any long-running action work. Can also be called with a single string argument as the label, or with no arguments to display only a spinner.
   *
   * **Usage:**
   *
   *```typescript
   * await ctx.loading.start({
   *   label: "Reticulating splines...",
   * });
   *
   * await ctx.loading.start("Label only shorthand");
   *```
   */
  async start(options?: string | BackwardCompatibleLoadingOptions) {
    if (typeof options === 'string') {
      options = { label: options }
    } else if (options === undefined) {
      options = {}
    }

    this.#state = { ...options }
    if (this.#state.itemsInQueue) {
      this.#state.itemsCompleted = 0
    }

    return this.#sendState()
  }

  /**
   * Updates any existing loading spinner initated with `ctx.loading.start` to dynamically provide new loading information to the action runner.
   *
   * **Usage:**
   *
   *```typescript
   * await ctx.loading.start({
   *   label: "Something is loading",
   *   description: "Mapping all the things",
   * });
   *
   * await ctx.loading.update({
   *   label: "Something is loading",
   *   description: "Now reducing all the things",
   * });
   *```
   */
  async update(options?: string | BackwardCompatibleLoadingOptions) {
    if (!this.#state) {
      this.#logger.warn('Please call `loading.start` before `loading.update`')
      return this.start(options)
    }

    if (typeof options === 'string') {
      options = { label: options }
    } else if (options === undefined) {
      options = {}
    }

    Object.assign(this.#state, options)

    if (this.#state?.itemsInQueue && this.#state.itemsCompleted === undefined) {
      this.#state.itemsCompleted = 0
    }

    return this.#sendState()
  }

  /**
   * Marks a chunk of work as completed to dynamically provide granular loading progress. Can only be used after `ctx.loading.start` was called with `itemsInQueue`.
   *
   * **Usage:**
   *
   *```typescript
   * await ctx.loading.start({
   *   label: "Migrating users",
   *   description: "Enabling edit button for selected users",
   *   itemsInQueue: 100,
   * });
   *
   * for (const user of users) {
   *   migrateUser(user);
   *   await ctx.loading.completeOne();
   * }
   *```
   */
  async completeOne() {
    if (!this.#state || !this.#state.itemsInQueue) {
      this.#logger.warn(
        'Please call `loading.start` with `itemsInQueue` before `loading.completeOne`, nothing to complete.'
      )
      return
    }

    if (this.#state.itemsCompleted === undefined) {
      this.#state.itemsCompleted = 0
    }

    this.#state.itemsCompleted++
    return this.#sendState()
  }
}
