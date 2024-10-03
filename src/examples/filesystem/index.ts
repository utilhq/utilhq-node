import path from 'path'
import UtilHQ from '../..'
import env from '../../env'

const utilhq = new UtilHQ({
  apiKey: env.DEMO_API_KEY,
  logLevel: 'debug',
  endpoint: 'ws://localhost:3000/websocket',
  routesDirectory: path.resolve(__dirname, 'routes'),
})

utilhq.listen()
