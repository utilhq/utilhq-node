import UtilHQ, { Page, io, Layout } from '../..'
import { UtilHQRouteDefinitions } from '../../types'
import { sleep } from '../utils/helpers'
import * as db from './db'
import env from '../../env'

const routes: UtilHQRouteDefinitions = {
  // root-level action
  hello_world: async () => {
    return 'Hello, world!'
  },
  // empty router
  emptyRouter: new Page({
    name: 'Empty router',
  }),
  // router with actions but no index page
  actionsOnly: new Page({
    name: 'Actions only',
    routes: {
      action_one: async () => {
        return 'Hello, world!'
      },
      action_two: async () => {
        return 'Hello, world!'
      },
    },
  }),
  // router with index page, no routes
  indexOnly: new Page({
    name: 'Index only',
    async handler() {
      return new Layout({
        title: 'Index only',
        children: [io.display.markdown('Hello, world!')],
      })
    },
  }),
  // router with actions and a nested router with an index page
  users: new Page({
    name: 'Users',
    async handler() {
      const allUsers = db.getUsers()

      return new Layout({
        title: 'Users',
        description:
          'This is a multi-level router with multiple nested routers',
        menuItems: [
          {
            label: 'Create user',
            route: 'users/create',
          },
        ],
        children: [
          io.display.table('Users', {
            data: allUsers,
            rowMenuItems: row => [
              {
                label: 'Edit',
                route: 'users/edit',
                params: { id: row.id },
              },
            ],
          }),
        ],
      })
    },
    routes: {
      create: {
        name: 'Create user',
        handler: async () => {
          const [firstName, lastName, email] = await io.group(
            [
              io.input.text('First name'),
              io.input.text('Last name'),
              io.input.email('Email address'),
            ],
            {
              continueButton: {
                label: 'Create user',
              },
            }
          )

          await sleep(1000)

          return { firstName, lastName, email }
        },
      },
      subscriptions: new Page({
        name: 'Subscriptions',
        async handler() {
          const data = db.getSubscriptions()

          return new Layout({
            title: 'Subscriptions',
            children: [
              io.display.table('Subscriptions', {
                data,
                rowMenuItems: row => [
                  {
                    label: 'Edit',
                    route: 'users/subscriptions/edit',
                    params: { id: row.id },
                  },
                  {
                    label: 'Cancel',
                    route: 'users/subscriptions/cancel',
                    theme: 'danger',
                    params: { id: row.id },
                  },
                ],
              }),
            ],
          })
        },
        routes: {
          edit: {
            name: 'Edit subscription',
            unlisted: true,
            handler: async () => {
              return 'Hello, world!'
            },
          },
          cancel: {
            name: 'Cancel subscription',
            unlisted: true,
            handler: async () => {
              return 'Hello, world!'
            },
          },
        },
      }),
      comments: new Page({
        name: 'Comments',
        async handler() {
          const data = db.getComments()

          return new Layout({
            title: 'Comments',
            menuItems: [
              {
                label: 'Create comment',
                route: 'users/comments/create',
              },
            ],
            children: [
              io.display.table('Comments', {
                data,
                rowMenuItems: row => [
                  {
                    label: 'Edit',
                    route: 'users/comments/edit',
                    params: { id: row.id },
                  },
                ],
              }),
            ],
          })
        },
        routes: {
          create: {
            name: 'Create comment',
            handler: async () => {
              return '👋'
            },
          },
          edit: {
            name: 'Edit comment',
            unlisted: true,
            handler: async () => {
              return '👋'
            },
          },
          nested: new Page({
            name: 'Nested L1',
            async handler() {
              return new Layout({})
            },
            routes: {
              create: {
                name: 'Create L1',
                handler: async () => {
                  return '👋'
                },
              },
              nested_2: new Page({
                name: 'Nested L2',
                async handler() {
                  return new Layout({})
                },
                routes: {
                  create: {
                    name: 'Create L2',
                    handler: async () => {
                      return '👋'
                    },
                  },
                },
              }),
            },
          }),
        },
      }),
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
