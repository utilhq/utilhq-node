import UtilHQ from '../../index'
import { sleep } from '../utils/helpers'
import env from '../../env'

const utilhq = new UtilHQ({
  apiKey: env.DEMO_API_KEY,
  logLevel: 'debug',
  endpoint: 'ws://localhost:3000/websocket',
  routes: {
    wait_a_while: async (io, ctx) => {
      await ctx.loading.start('Waiting...')
      await sleep(5000)
      return 'Done!'
    },
  },
})

utilhq.listen()

process.on('SIGINT', () => {
  utilhq
    .safelyClose()
    .then(() => {
      console.log('Shut down!')
      process.exit(0)
    })
    .catch(err => {
      console.error(
        'Failed shutting down gracefully, forcibly closing connection'
      )
      utilhq.immediatelyClose()
      process.exit(0)
    })
})
