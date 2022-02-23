import { z } from 'zod'
import component from '../component'
import type { T_IO_METHOD } from '../ioSchema'
import type { IOPromiseConstructor, IOPromise } from '../io'
import { COLUMN_DEFS } from '../utils/spreadsheet'

export default function spreadsheet(
  constructor: IOPromiseConstructor<'INPUT_SPREADSHEET'>
) {
  return <
    Props extends T_IO_METHOD<'INPUT_SPREADSHEET', 'props'>,
    Columns extends Props['columns']
  >(
    label: string,
    props: Props
  ) => {
    const c = component('INPUT_SPREADSHEET', label, {
      ...props,
    })

    return constructor(c) as IOPromise<
      'INPUT_SPREADSHEET',
      {
        [key in keyof Columns]: z.infer<typeof COLUMN_DEFS[Columns[key]]>
      }[]
    >
  }
}
