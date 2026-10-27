import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { listModels } from '../src/buddy.ts'
import { CN } from '../src/products.ts'
import { OPENCODE } from '../src/opencode.ts'
import { createDirectUpstream } from '../src/upstreams.ts'

test(
  'Tencent model endpoints must start together and preserve enterprise-first ordering',
  { timeout: 3000 },
  async t => {
    const requests: string[] = []
    let release: () => void = () => {}
    const barrier = new Promise<void>(resolve => {
      release = resolve
    })
    const server = http.createServer(async (req, res) => {
      requests.push(req.url ?? '')
      if (requests.length === 2) release()
      await barrier
      const name = req.url?.includes('/v3/config') ? 'config-model' : 'enterprise-model'
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: { models: [{ id: name }] } }))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    t.after(() => {
      release()
      server.close()
    })
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const result = await listModels({ ...CN, endpoint }, { accessToken: 'test' }, { signal: AbortSignal.timeout(1000) })
    assert.equal(requests.length, 2)
    assert.deepEqual(
      result.map(model => model.id),
      ['enterprise-model', 'config-model'],
    )
  },
)

test('model sources must load concurrently while preserving configured source order', { timeout: 3000 }, async t => {
  const requests: string[] = []
  let metadataRequests = 0
  let release: () => void = () => {}
  const barrier = new Promise<void>(resolve => {
    release = resolve
  })
  t.after(() => release())
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
    const value = String(url)
    if (value === 'https://models.dev/api.json') {
      metadataRequests++
      return Response.json({ opencode: { models: {} } })
    }
    requests.push(value)
    if (requests.length === 2) release()
    await barrier
    return Response.json({ data: [{ id: value.includes('first') ? 'first-model' : 'second-model' }] })
  })
  const products = [
    { ...OPENCODE, id: 'first', baseUrl: 'https://first.invalid', modelsPath: '/models' },
    { ...OPENCODE, id: 'second', baseUrl: 'https://second.invalid', modelsPath: '/models' },
  ]
  const rows = await Promise.race([
    createDirectUpstream({ products }).loadModels(),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('sources were loaded sequentially')), 1000)),
  ])
  assert.deepEqual(
    rows.map(row => row.id),
    ['first/first-model', 'second/second-model'],
  )
  assert.equal(metadataRequests, 1, 'concurrent sources must share one capability fetch')
})
