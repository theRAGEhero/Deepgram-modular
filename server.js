const { createServer } = require('http')
const { parse } = require('url')
const next = require('next')
const WebSocket = require('ws')
const { handleConnection, getSessionStats } = require('./lib/websocket/handler.js')

const dev = process.env.NODE_ENV !== 'production'
const hostname = 'localhost'
const port = parseInt(process.env.PORT || '3000', 10)

const app = next({ dev, hostname, port })
const handle = app.getRequestHandler()

app.prepare().then(() => {
  const server = createServer(async (req, res) => {
    try {
      const parsedUrl = parse(req.url, true)
      if (parsedUrl.pathname === '/api/stream-audio/stats' && req.method === 'GET') {
        const stats = getSessionStats()
        res.statusCode = 200
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify(stats))
        return
      }
      await handle(req, res, parsedUrl)
    } catch (err) {
      console.error('Error occurred handling', req.url, err)
      res.statusCode = 500
      res.end('internal server error')
    }
  })

  // WebSocket server attached to same HTTP server
  const wss = new WebSocket.Server({ noServer: true })

  server.on('upgrade', (request, socket, head) => {
    const { pathname } = parse(request.url || '', true)

    // Only handle our audio streaming WebSocket
    if (pathname === '/api/stream-audio') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request)
      })
    }
    // For all other WebSocket connections (including HMR), do nothing
    // This allows Next.js to handle them through its normal flow
  })

  wss.on('connection', (ws) => {
    handleConnection(ws)
  })

  server.listen(port, (err) => {
    if (err) throw err
    console.log(`> Ready on http://${hostname}:${port}`)
    console.log(`> WebSocket available at ws://${hostname}:${port}/api/stream-audio`)
  })
})
