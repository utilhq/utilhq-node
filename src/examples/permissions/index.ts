import { UtilHQActionDefinition } from '@utilhq/sdk/src/types'
import UtilHQ, { Layout, Page, io } from '../..'
import { UtilHQRouteDefinitions } from '../../types'
import env from '../../env'

const actions: Record<string, UtilHQActionDefinition> = {
  engineers: {
    name: 'Engineers action',
    description: 'This action can only be run by the Engineers team.',
    handler: async () => {
      return 'Hello, world!'
    },
    access: {
      teams: ['engineers'],
    },
  },
  support: {
    name: 'Support action',
    description: 'This action can only be run by the Support team.',
    handler: async () => {
      return 'Hello, world!'
    },
    access: {
      teams: ['support'],
    },
  },
  organization: {
    name: 'Organization action',
    description: 'This action can be run by anyone in the organization.',
    handler: async () => {
      return 'Hello, world!'
    },
    // this is the default setting, just showing it here for clarity
    access: 'entire-organization',
  },
  no_access: {
    name: 'No-access action',
    description:
      "This action can't be run by anyone in the organization except admins.",
    handler: async () => {
      return 'Hello, world!'
    },
    access: {
      teams: [],
    },
  },
  inherited: {
    name: 'Inherited access action',
    description: 'This action inherits access from its parent group.',
    handler: async () => {
      return 'Hello, world!'
    },
  },
}

const routes: UtilHQRouteDefinitions = {
  ...actions,
  engineersGroup: new Page({
    name: 'Engineers actions',
    description: 'Can only be seen and accessed by the Engineers group',
    access: {
      teams: ['engineers'],
    },
    routes: {
      action: actions['inherited'],
    },
  }),
  supportGroup: new Page({
    name: 'Support actions',
    description: 'Can only be seen and accessed by the Support group',
    access: {
      teams: ['support'],
    },
    routes: {
      action: actions['inherited'],
    },
  }),
  mixedAccess: new Page({
    name: 'Mixed access',
    description:
      'This is a support-only group, but engineers can access an action within it.',
    access: {
      teams: ['support'],
    },
    handler: async () => {
      return new Layout({
        title: 'Mixed access handler',
        children: [io.display.markdown('')],
      })
    },
    routes: {
      engAction: {
        name: 'Engineers can run this',
        description: 'This action can only be run by the Engineers team.',
        access: {
          teams: ['engineers'],
        },
        handler: async () => {
          return 'Hello, world!'
        },
      },
      supportAction: {
        name: "Engineers can't run this",
        description: 'Inherits access from the group',
        handler: async () => {
          return 'Hello, world!'
        },
      },
      orgAction: actions.organization,
    },
  }),
  deeplyNested: new Page({
    name: 'Deeply nested access',
    description:
      'Engineers do not have access to this group, but can access an action within the group',
    access: {
      teams: ['support'],
    },
    routes: {
      level2: new Page({
        name: 'Level 2',
        routes: {
          engAction: actions['engineers'],
        },
      }),
      action: actions['inherited'],
    },
  }),
}

const utilhq = new UtilHQ({
  apiKey: env.DEMO_API_KEY,
  logLevel: 'debug',
  endpoint: 'ws://localhost:3000/websocket',
  routes,
})

utilhq.listen()

const prod = new UtilHQ({
  apiKey: env.DEMO_PROD_API_KEY,
  logLevel: 'debug',
  endpoint: 'ws://localhost:3000/websocket',
  routes,
})

prod.listen()
