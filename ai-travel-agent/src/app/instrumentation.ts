export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./util/instrumentation.node.js')
  }
}