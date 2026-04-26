export async function onRequest(context: { request: Request }) {
  const value = Math.floor(Math.random() * 1000)
  const payload = { value, generatedAt: new Date().toISOString() }
  return new Response(JSON.stringify(payload), {
    headers: {
      'Content-Type': 'application/json',
    },
  })
}
