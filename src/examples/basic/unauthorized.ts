import { UtilHQActionHandler } from '../..'

const unauthorized: UtilHQActionHandler = async io => {
  const email = await io.input.email('Email address')

  if (!email.includes('@utilhq.com')) {
    throw new Error('Unauthorized')
  }

  const name = await io.input.text('Name')

  return {
    name,
    email,
    'Download data': 'https://utilhq.com/export.zip',
  }
}

export default unauthorized
