import { z } from 'zod'
import component, { ComponentType } from '../component'
import type { T_IO_METHOD } from '../ioSchema'
import { COLUMN_DEFS } from '../utils/spreadsheet'

export default function spreadsheet(
  renderer: (
    componentInstances: ComponentType<'INPUT_SPREADSHEET'>[]
  ) => Promise<T_IO_METHOD<'INPUT_SPREADSHEET', 'returns'>[]>
) {
  return <
    Props extends T_IO_METHOD<'INPUT_SPREADSHEET', 'props'>,
    Columns extends Props['columns']
  >(
    label: string,
    props: Props
  ) => {
    type ReturnValue = {
      [key in keyof Columns]: z.infer<typeof COLUMN_DEFS[Columns[key]]>
    }[]

    const c = component('INPUT_SPREADSHEET', label, {
      ...props,
    })

    return {
      component: c,
      then(resolve: (input: ReturnValue) => void) {
        renderer([c]).then(([result]) => {
          resolve(result as ReturnValue)
        })
      },
    }
  }
}
