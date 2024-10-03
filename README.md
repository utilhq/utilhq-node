<a href="https://utilhq.com">
  <img alt="utilhq" width="100" height="100" style="border-radius: 6px;" src="https://utilhq.com/img/readme-assets/utilhq-avatar.png">
</a>

# utilhq Node.js SDK

[![npm version](https://img.shields.io/npm/v/@utilhq/sdk?style=flat)](https://www.npmjs.com/package/@utilhq/sdk) [![Documentation](https://img.shields.io/badge/documentation-informational)](https://utilhq.com/docs) [![Twitter](https://img.shields.io/twitter/follow/useutilhq.svg?color=%2338A1F3&label=twitter&style=flat)](https://twitter.com/useutilhq) [![Discord](https://img.shields.io/badge/discord-join-blueviolet)](https://utilhq.com/discord)

[utilhq](https://utilhq.com) lets you quickly build internal web apps (think: customer support tools, admin panels, etc.) just by writing backend Node.js code.

This is our Node.js SDK which connects to the utilhq.com web app. If you don't have an utilhq account, you can [create one here](https://utilhq.com/signup). All core features are free to use.

## Why choose utilhq?

_"Node code > no-code"_

utilhq is an alternative to no-code/low-code UI builders. Modern frontend development is inherently complicated, and teams rightfully want to spend minimal engineering resources on internal dashboards. No-code tools attempt to solve this problem by allowing you to build UIs in a web browser without writing any frontend code.

We don't think this is the right solution. **Building UIs for mission-critical tools in your web browser** — often by non-technical teammates, outside of your codebase, without versioning or code review — **is an anti-pattern.** Apps built in this manner are brittle and break in unexpected ways.

With utilhq, **all of the code for generating your web UIs lives within your app's codebase.** Tools built with utilhq (we call these [actions](https://utilhq.com/docs/concepts/actions)) are just asynchronous functions that run in your backend. Because these are plain old functions, you can access the complete power of your Node app. You can loop, conditionally branch, access shared functions, and so on. When you need to request input or display output, `await` any of our [I/O methods](https://utilhq.com/docs/io-methods/) to present a form to the user and your script will pause execution until input is received.

Here's a simple app with a single "Hello, world" action:

```ts
import UtilHQ from '@utilhq/sdk'

const utilhq = new UtilHQ({
  apiKey: '<YOUR API KEY>',
  actions: {
    hello_world: async () => {
      const name = await io.input.text('Your name')
      return `Hello, ${name}`
    },
  },
})

utilhq.listen()
```

utilhq:

- Makes creating full-stack apps as easy as writing CLI scripts.
- Can scale from a handful of scripts to robust multi-user dashboards.
- Lets you build faster than no-code, without leaving your codebase & IDE.

With utilhq, you do not need to:

- Write REST or GraphQL API endpoints to connect internal functionality to no-code tools.
- Give utilhq write access to your database (or give us _any_ of your credentials, for that matter).
- Build web UIs with a drag-and-drop interface.

<img alt="An image containing a code sample alongside a screenshot of the utilhq app it generates." src="https://utilhq.com/img/readme-assets/screenshot.png">

## More about utilhq

- 📖 [Documentation](https://utilhq.com/docs)
- 🌐 [utilhq website](https://utilhq.com)
- 💬 [Discord community](https://utilhq.com/discord)
- 📰 [Product updates](https://utilhq.com/blog)
