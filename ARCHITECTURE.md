# utilhq JS SDK

The utilhq SDK is a fork of [@interval/interval-node](https://github.com/interval/interval-node)
and intended to be a drop-in replacement. The utilhq SDK consists of
several high-level actors responsible for handling communication between
the defined actions and utilhq.

## Architecture

What follows is a high-level overview of how the underlying actors interact
with each other and with utilhq.

### `utilhq`

The default export `utilhq` class is the entrypoint to connecting
to utilhq. Upon calling `listen()`, the `utilhq` class does the
following:

1. Establishes an `ISocket` connection to utilhq
2. Creates a `DuplexRPCClient`, defining methods for sending
   and responding to high-level RPC messages from utilhq.
3. Sends the `INITIALIZE_HOST` RPC message to utilhq,
   letting it know what actions this host is defining
   and the handlers to call when those actions are run.

### `ISocket`

A relatively thin wrapper around an underlying WebSocket connection.
ISocket connections can be thought of as a TCP layer over WebSockets,
each `MESSAGE` message must followed by an `ACK` message from the recipient.
If the `ACK` is not received for a given `MESSAGE`, the Promise for that
message is rejected and a `TimeoutError` is thrown.

### `DuplexRPCClient`

Responsible for exchanging high-level RPC messages with another `DuplexRPCClient`.
Schemas that define the messages that the client can send and respond to are
defined ahead of time, providing static guarantees that the messages are
acceptable for the given connection. Uses an `ISocket` object to exchange data.

### `IOClient`

When a transaction is created for a given transaction, the SDK host
`DuplexRPCClient` receives a `START_TRANSACTION` call, detailing the action
and some additional metadata about the transaction. Upon receiving the
`START_TRANSACTION` call, the call handler creates an `IOClient` object
for the new transaction, passing a `send` argument to the `IOClient`
constructor which translates the `IOClient`'s IO render instruction into
an RPC message to be sent by the `DuplexRPCClient`.

The `IOClient`'s primary purpose is to pass the `IO` namespace of IO methods to
the action handler. These methods return `IOPromise` objects which detail
translating the user-provided properties into the properties that make up an IO
render instruction.
The `IOPromise` objects can be `await`ed directly,
rendering only the single component to the action runner, or in an `io.group`,
which can render multiple `IOPromise` components in a single call.

The `IOClient` defines the internal `renderComponents` method, which
handles the render loop for a given IO call.
Given a list of `IOComponent`s (potentially only one if not rendering a group)
this method is responsible for sending the initial render call and handling
responses (returns, state updates, or cancellations) from utilhq.
Resolves when each `IOComponent`'s `returnValue` Promise is resolved via
response from utilhq, or throws an IOError of kind `CANCELED` if canceled.

### `IOPromise`

A custom wrapper class that handles creating the underlying component
model when the IO call is to be rendered, and optionally transforming
the value received from utilhq to a custom component return type.
A relatively thin wrapper around the internal `IOComponent` which is primarily
responsible for being `await`able and transforming the network-level
props and return values to the values expected by the IO method caller.
If `await`ed, resolves when the internal `IOComponent`'s `returnValue` Promise
is resolved.

### `IOComponent`

The internal model underlying each `IOPromise`, responsible for constructing
the data transmitted to utilhq for an IO component, and handling responses
received from utilhq for the current component: resolving its `returnValue`
when receiving a final response from the action runner, or constructing a new
set of props when receiving new state.
