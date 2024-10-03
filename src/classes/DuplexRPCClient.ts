import { z, ZodError } from 'zod'
import { Evt } from 'evt'
import type { DuplexMessage } from '../internalRpcSchema'
import { DUPLEX_MESSAGE_SCHEMA } from '../internalRpcSchema'
import { sleep } from './UtilHQClient'
import ISocket, { TimeoutError } from './ISocket'

let count = 0
function generateId() {
  count = count + 1
  return count.toString()
}

export interface MethodDef {
  [key: string]: {
    inputs: z.ZodFirstPartySchemaTypes | z.ZodDiscriminatedUnion<any, any>
    returns: z.ZodFirstPartySchemaTypes | z.ZodDiscriminatedUnion<any, any>
  }
}

type OnReplyFn = (anyObject: any) => void

export type DuplexRPCHandlers<ResponderSchema extends MethodDef> = {
  [Property in keyof ResponderSchema]: (
    inputs: z.infer<ResponderSchema[Property]['inputs']>
  ) => Promise<z.infer<ResponderSchema[Property]['returns']>>
}

interface CreateDuplexRPCClientProps<
  CallerSchema extends MethodDef,
  ResponderSchema extends MethodDef
> {
  communicator: ISocket
  canCall: CallerSchema
  canRespondTo: ResponderSchema
  handlers: DuplexRPCHandlers<ResponderSchema>
  retryChunkIntervalMs?: number
}

/**
 * Responsible for making RPC calls to another DuplexRPCClient.
 * Can send messages from CallerSchema and respond to messages
 * from ResponderSchema.
 *
 * @property communicator - The ISocket instance responsible for
 * sending the RPC messages.
 * @property handlers - Defines the actions taken when receiving
 * a given message, an object keyed by the message schema key.
 */
export class DuplexRPCClient<
  CallerSchema extends MethodDef,
  ResponderSchema extends MethodDef
> {
  communicator: ISocket
  canCall: CallerSchema
  canRespondTo: ResponderSchema
  handlers: {
    [Property in keyof ResponderSchema]: (
      inputs: z.infer<ResponderSchema[Property]['inputs']>
    ) => Promise<z.infer<ResponderSchema[Property]['returns']>>
  }
  pendingCalls = new Map<string, OnReplyFn>()
  messageChunks = new Map<string, string[]>()
  #retryChunkIntervalMs: number = 100

  onMessageReceived: Evt<DuplexMessage>

  constructor({
    communicator,
    canCall,
    canRespondTo,
    handlers,
    retryChunkIntervalMs,
  }: CreateDuplexRPCClientProps<CallerSchema, ResponderSchema>) {
    this.communicator = communicator
    this.communicator.onMessage.attach(this.onmessage.bind(this))
    this.canCall = canCall
    this.canRespondTo = canRespondTo
    this.handlers = handlers
    this.onMessageReceived = new Evt()

    if (retryChunkIntervalMs && retryChunkIntervalMs > 0) {
      this.#retryChunkIntervalMs = retryChunkIntervalMs
    }
  }

  private packageResponse({
    id,
    methodName,
    data,
  }: Omit<DuplexMessage & { kind: 'RESPONSE' }, 'kind'>) {
    const preparedResponseText: DuplexMessage = {
      id: id,
      kind: 'RESPONSE',
      methodName: methodName,
      data,
    }
    return JSON.stringify(preparedResponseText)
  }

  private packageCall({
    id,
    methodName,
    data,
  }: Omit<DuplexMessage & { kind: 'CALL' }, 'kind'>): string | string[] {
    const callerData: DuplexMessage = {
      id,
      kind: 'CALL',
      data,
      methodName: methodName as string, // ??
    }

    return JSON.stringify(callerData)
  }

  public setCommunicator(newCommunicator: ISocket): void {
    this.communicator.onMessage.detach()
    this.communicator = newCommunicator
    this.communicator.onMessage.attach(this.onmessage.bind(this))
  }

  private handleReceivedResponse(parsed: DuplexMessage & { kind: 'RESPONSE' }) {
    const onReplyFn = this.pendingCalls.get(parsed.id)
    if (!onReplyFn) return

    onReplyFn(parsed.data)
    this.pendingCalls.delete(parsed.id)
  }

  private async handleReceivedCall(parsed: DuplexMessage & { kind: 'CALL' }) {
    type MethodKeys = keyof typeof this.canRespondTo

    const methodName = parsed.methodName as MethodKeys
    const method: ResponderSchema[MethodKeys] | undefined =
      this.canRespondTo[methodName]

    if (!method) {
      throw new Error(`There is no method for ${parsed.methodName}`)
    }

    // struggling to get real inference here
    const inputs = method.inputs.parse(parsed.data)
    const handler = this.handlers[methodName]

    const returnValue = await handler(inputs)

    const preparedResponseText = this.packageResponse({
      id: parsed.id,
      methodName: methodName as string, //??
      data: returnValue,
    })

    try {
      await this.communicator.send(preparedResponseText)
    } catch (err) {
      console.error('Failed sending response', preparedResponseText, err)
    }

    return
  }

  private async onmessage(data: unknown) {
    const txt = data as string
    try {
      let inputParsed = DUPLEX_MESSAGE_SCHEMA.parse(JSON.parse(txt))

      this.onMessageReceived.post(inputParsed)

      if (inputParsed.kind === 'CALL') {
        try {
          await this.handleReceivedCall(inputParsed)
        } catch (err) {
          if (err instanceof ZodError) {
            console.error(
              '[DuplexRPCClient] Received invalid call:',
              inputParsed
            )
          } else {
            console.error(
              '[DuplexRPCClient] Failed handling call: ',
              inputParsed
            )
          }
          console.error(err)
        }
      } else if (inputParsed.kind === 'RESPONSE') {
        try {
          this.handleReceivedResponse(inputParsed)
        } catch (err) {
          if (err instanceof ZodError) {
            console.error(
              '[DuplexRPCClient] Received invalid response:',
              inputParsed
            )
          } else {
            console.error(
              '[DuplexRPCClient] Failed handling response: ',
              inputParsed
            )
          }

          console.error(err)
        }
      }
    } catch (err) {
      console.error('[DuplexRPCClient] Received invalid message:', data)
      console.error(err)
    }
  }

  public async send<MethodName extends keyof CallerSchema>(
    methodName: MethodName,
    inputs: z.input<CallerSchema[MethodName]['inputs']>,
    options: {
      timeoutFactor?: number
    } = {}
  ) {
    const id = generateId()

    const msg = this.packageCall({
      id,
      data: inputs,
      methodName: methodName as string, // ??
    })

    type ReturnType = z.infer<CallerSchema[MethodName]['returns']>

    return new Promise<ReturnType>((resolve, reject) => {
      this.pendingCalls.set(id, (rawResponseText: string) => {
        try {
          const parsed =
            this.canCall[methodName]['returns'].parse(rawResponseText)
          return resolve(parsed)
        } catch (err) {
          reject(err)
        }
      })

      if (Array.isArray(msg)) {
        Promise.allSettled(
          msg.map(async chunk => {
            const NUM_TRIES_PER_CHUNK = 3

            // If a chunk times out, retry it a few times
            for (let i = 0; i <= NUM_TRIES_PER_CHUNK; i++) {
              try {
                return await this.communicator.send(chunk)
              } catch (err) {
                if (err instanceof TimeoutError) {
                  // console.debug(
                  //   `Chunk timed out, retrying in ${
                  //     this.#retryChunkIntervalMs
                  //   }ms...`
                  // )
                  await sleep(this.#retryChunkIntervalMs)
                } else {
                  throw err
                }
              }
            }

            throw new TimeoutError()
          })
        ).then(responses => {
          // reject the first failed promise, if any
          for (const response of responses) {
            if (response.status === 'rejected') {
              reject(response.reason)
            }
          }
        })
      } else {
        this.communicator.send(msg, options).catch(err => {
          reject(err)
        })
      }
    })
  }
}
