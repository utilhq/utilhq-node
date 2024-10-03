import { UtilHQActionHandler } from '../..'
import { faker } from '@faker-js/faker'

const charges = [
  {
    id: 'b717a9cf-4a3e-41ab-bcda-e2f3ff35c974',
    name: 'Ye 001',
    email: 'ye+001@utilhq.com',
    amount: 15000,
    purchasedAt: new Date(2022, 0, 15),
  },
  // need 3 rows so pagination is perceptible at 20 per page
  // {
  //   id: 'acc14b04-60d8-4f9d-9907-10ea1ed05fe2',
  //   name: 'Dan Philibin',
  //   email: 'dan@utilhq.com',
  //   amount: 0,
  //   promoCode: 'APPLE',
  //   purchasedAt: new Date(2015, 3, 22),
  // },
  {
    id: '91032195-6836-4573-9cd5-0b06ea2379ec',
    name: 'Ye 002',
    email: 'ye+002@utilhq.com',
    amount: 1200,
    promoCode: 'BANANA',
    arr: [1, 2, 3],
    purchasedAt: new Date(2018, 10, 7),
  },
  {
    id: '48d10a1a-9c8c-4426-8d0c-796610c652f3',
    name: 'Ye 003',
    email: 'ye+003@utilhq.com',
    amount: 2022,
    promoCode: 'ORANGE',
    nested: {
      a: 'b',
    },
    purchasedAt: new Date(2000, 12, 15),
  },
]

function formatCurrency(amount: number) {
  return amount.toLocaleString('en-US', { currency: 'usd', style: 'currency' })
}

export const table_basic: UtilHQActionHandler = async io => {
  const simpleCharges = charges.map(ch => ({
    name: ch.name,
    email: faker.internet.email(),
    amount: ch.amount,
  }))

  const [name, phone, selections] = await io.group([
    io.input.text('Full name'),
    io.input.text('Phone number'),
    io.select.table('Select a person', {
      data: [...simpleCharges, ...simpleCharges],
      minSelections: 1,
      maxSelections: 3,
    }),
  ])

  await io.display.object('Selected', { data: selections })
}

export const table_actions: UtilHQActionHandler = async io => {
  const simpleCharges = charges.map((ch, idx) => ({
    id: idx,
    name: ch.name,
    email: faker.internet.email(),
    amount: ch.amount,
    address1: faker.address.streetAddress(),
    address2: faker.address.secondaryAddress(),
    city: faker.address.city(),
    state: faker.address.state(),
    zip: faker.address.zipCode(),
  }))

  const selections = await io.display.table('Charges', {
    data: simpleCharges,
    rowMenuItems: row => [
      {
        label: 'Edit',
        route: 'edit_user',
        params: { email: row.email },
      },
    ],
  })

  await io.display.object('Selected', { data: selections })
}

export const table_custom: UtilHQActionHandler = async io => {
  const options = [
    'id',
    'name',
    'email',
    'url',
    'number',
    'paragraph',
    'address1',
    'address2',
    'city',
    'state',
    'zip',
  ].map(f => ({ label: f, value: f }))

  const [rowsCount, fields, tableType, orientation, defaultPageSize] =
    await io.group([
      io.input.number('Number of rows', { defaultValue: 50 }),
      io.select.multiple('Fields', {
        options: options,
        defaultValue: options,
      }),
      io.select.single('Table type', {
        options: [
          { label: 'Display', value: 'display' },
          { label: 'Select', value: 'select' },
        ],
        defaultValue: { label: 'Select', value: 'select' },
      }),
      io.select.single('Orientation', {
        options: [
          { label: 'Horizontal', value: 'horizontal' },
          { label: 'Vertical', value: 'vertical' },
        ],
        defaultValue: { label: 'Horizontal', value: 'horizontal' },
        helpText:
          'Warning: Vertical orientation is not supported for select tables; it will be ignored',
      }),
      io.input
        .number('Default page size', {
          defaultValue: 20,
        })
        .optional(),
    ])

  const rows: { [key: string]: any }[] = []
  for (let i = 0; i < rowsCount; i++) {
    const row: typeof rows[0] = {}
    for (const field of fields) {
      switch (field.value) {
        case 'id':
          row[field.value] = faker.datatype.uuid()
          break
        case 'name':
          row[field.value] = faker.name.findName()
          break
        case 'email':
          row[field.value] = faker.internet.email()
          break
        case 'url':
          row[field.value] = faker.internet.url()
          break
        case 'number':
          row[field.value] = faker.datatype.number()
          break
        case 'paragraph':
          row[field.value] = faker.lorem.paragraph()
          break
        case 'address1':
          row[field.value] = faker.address.streetAddress()
          break
        case 'address2':
          row[field.value] = faker.address.secondaryAddress()
          break
        case 'city':
          row[field.value] = faker.address.city()
          break
        case 'state':
          row[field.value] = faker.address.state()
          break
        case 'zip':
          row[field.value] = faker.address.zipCode()
          break
        default:
          break
      }
    }
    rows.push(row)
  }

  if (tableType.value === 'display') {
    await io.display.table('Table', {
      data: rows,
      orientation: orientation.value as 'horizontal' | 'vertical',
      defaultPageSize,
    })
  } else {
    const [selections] = await io.select.table('Select a person', {
      data: rows,
      minSelections: 1,
      maxSelections: 3,
      defaultPageSize,
    })
    await io.display.object('Selected', { data: selections })
  }
}

export const table_custom_columns: UtilHQActionHandler = async io => {
  type Charge = typeof charges[0]
  const selections = await io.select
    .table('Select from this table', {
      data: [
        ...charges,
        ...charges,
        ...charges,
        ...charges,
        ...charges,
        ...charges,
        ...charges,
        ...charges,
        ...charges,
        ...charges,
        ...charges,
        ...charges,
        ...charges,
        ...charges,
      ],
      columns: [
        {
          label: 'ID',
          renderCell: row => ({
            label:
              row.name === 'Dan Philibin'
                ? 'b49db41314a645edabee-1c5eae1255df'
                : row.name === 'Jacob Mischka'
                ? `https://dashboard.stripe.com/${row.id}`
                : 'This is a long string of multiline text that is linked in a table column',
            url: `https://dashboard.stripe.com/${row.id}`,
          }),
        },
        {
          label: 'Name',
          renderCell: row => row.name,
        },
        {
          label: 'Email',
          renderCell: row => row.email,
        },
        {
          label: 'Number',
          renderCell: row => row.amount,
        },
        {
          label: 'Price',
          renderCell: row => ({
            label: formatCurrency(row.amount ? row.amount / 100 : 0),
            value: row.amount,
          }),
        },
        {
          label: 'Promo code',
          renderCell: (row: Charge) => ({
            label: row.promoCode,
          }),
        },
        {
          label: 'Purchased at',
          renderCell: (row: Charge) => ({
            label: row.purchasedAt.toLocaleString(),
            value: row.purchasedAt,
          }),
        },
      ],
      minSelections: 1,
      maxSelections: 2,
      defaultPageSize: Infinity,
    })
    .optional()

  await io.display.object('Selected', { data: selections })
}
