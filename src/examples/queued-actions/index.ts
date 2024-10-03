import UtilHQ from '../../index'
import env from '../../env'

const utilhq = new UtilHQ({
  apiKey: env.DEMO_API_KEY,
  logLevel: 'debug',
  endpoint: 'ws://localhost:3000/websocket',
  routes: {
    helloCurrentUser: async (io, ctx) => {
      console.log(ctx.params)

      let heading = `Hello, ${ctx.user.firstName} ${ctx.user.lastName}`

      if (ctx.params.message) {
        heading += ` (Message: ${ctx.params.message})`
      }

      await io.display.heading(heading)
    },
  },
})

utilhq.listen()

setTimeout(async () => {
  await utilhq.enqueue('helloCurrentUser', {
    assignee: 'ye@utilhq.com',
    params: {
      message: 'Hello, queue!',
    },
  })

  const queuedAction = await utilhq.enqueue('helloCurrentUser', {
    params: {
      message: 'Hello, anyone!',
    },
  })

  await utilhq.dequeue(queuedAction.id)
}, 1000)
