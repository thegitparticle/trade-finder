const http = require('http')
const fs = require('fs')
const path = require('path')
const url = require('url')

const port = process.env.PORT ? Number(process.env.PORT) : 5173
const rootDir = __dirname

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
}

const server = http.createServer((req, res) => {
  if (!req.url) {
    res.writeHead(400)
    res.end('Bad request')
    return
  }

  const { pathname } = url.parse(req.url)

  if (pathname === '/api/random') {
    const payload = {
      value: Math.floor(Math.random() * 1000),
      generatedAt: new Date().toISOString(),
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(payload))
    return
  }

  const safePath = pathname === '/' ? '/index.html' : pathname
  const filePath = path.join(rootDir, decodeURIComponent(safePath))

  if (!filePath.startsWith(rootDir)) {
    res.writeHead(403)
    res.end('Forbidden')
    return
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404)
      res.end('Not found')
      return
    }

    const ext = path.extname(filePath)
    res.writeHead(200, { 'Content-Type': contentTypes[ext] || 'application/octet-stream' })
    res.end(data)
  })
})

server.listen(port, () => {
  console.log(`Dev server running at http://localhost:${port}`)
})
