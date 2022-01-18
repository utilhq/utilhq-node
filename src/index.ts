import { WebSocket } from 'ws'
import ISocket from './ISocket'
import { createDuplexRPCClient } from './rpc'
import { wsServerSchema, hostSchema } from './internalRpcSchema'
import { IOResponse, IO_RESPONSE } from './ioSchema'
import createIOClient, { IOClient } from './io'

type ActionFunction = (io: IOClient) => Promise<any>

interface InternalConfig {
  apiKey: string
  actions: Record<string, ActionFunction>
  endpoint?: string
  logLevel?: 'prod' | 'debug'
}

export default async function createIntervalHost(config: InternalConfig) {
  const log = {
    prod: (...args: any[]) => {
      console.log('[Interval] ', ...args)
    },
    debug: (...args: any[]) => {
      if (config.logLevel === 'debug') {
        console.log(...args)
      }
    },
  }

  log.debug('Create Interval Host :)', config)

  const pendingIO = new Map<string, (value: IOResponse) => void>()

  async function setup() {
    const ws = new ISocket(
      new WebSocket(config.endpoint || 'ws://localhost:3001')
    )

    ws.on('close', () => {
      log.debug('Closed')
      // auto retry connect here?
    })

    await ws.connect()

    const serverRpc = createDuplexRPCClient({
      communicator: ws,
      canCall: wsServerSchema,
      canRespondTo: hostSchema,
      handlers: {
        START_TRANSACTION: async inputs => {
          log.debug('action called', inputs)

          const fn = config.actions[inputs.actionName]
          log.debug(fn)

          if (!fn) {
            log.debug('No fn called', inputs.actionName)
            return
          }

          const client = createIOClient(async callToSend => {
            log.debug('emitting', callToSend)
            await serverRpc('SEND_IO_CALL', {
              transactionId: inputs.transactionId,
              ioCall: JSON.stringify(callToSend),
            })
            log.debug('sent')

            return new Promise(resolve => {
              pendingIO.set(callToSend.id, resp => {
                resolve(resp)
              })
            })
          })

          fn(client).then(() =>
            serverRpc('MARK_TRANSACTION_COMPLETE', {
              transactionId: inputs.transactionId,
            })
          )

          return
        },
        IO_RESPONSE: async inputs => {
          log.debug('got io response', inputs)

          const parsed = IO_RESPONSE.parse(JSON.parse(inputs.value))
          const replyHandler = pendingIO.get(parsed.id)

          if (!replyHandler) {
            log.debug(
              'Missing reply handler for',
              parsed.id,
              inputs.transactionId
            )
            return
          }

          replyHandler(parsed)
          pendingIO.delete(parsed.id)
        },
      },
    })

    const loggedIn = await serverRpc('INITIALIZE_HOST', {
      apiKey: config.apiKey,
      callableActionNames: Object.keys(config.actions),
    })

    if (!loggedIn) throw new Error('The provided API key is not valid')

    log.prod(`🔗 Connected! Access your actions at: ${loggedIn.dashboardUrl}`)
  }

  setup()

  return true
}
