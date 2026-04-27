// Legacy Pages Function preserved to reduce merge conflicts on long-lived branches.
// Worker-based deployment uses `worker.js` and `/api/markets`.
export async function onRequest() {
  return new Response(
    JSON.stringify({
      message: 'Use /api/markets from Worker runtime',
      generatedAt: new Date().toISOString(),
    }),
    { headers: { 'Content-Type': 'application/json' } }
  )
}
