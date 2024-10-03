import fs from 'fs'
import { UtilHQActionDefinition } from '../../../types'

const action: UtilHQActionDefinition = {
  name: 'File-based object-based action',
  description: 'Defined in a file, as a plain object',
  handler: async io => {
    await io.display.code("This file's source code", {
      code: fs.readFileSync(__filename, { encoding: 'utf8' }),
    })
  },
}

export default action
