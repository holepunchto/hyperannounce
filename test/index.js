const { test } = require('brittle')
const b4a = require('b4a')
const DHT = require('hyperdht')
const createTestnet = require('hyperdht/testnet')
const Discovery = require('..')
const { toHex } = b4a
const { throttleDHT } = require('./helpers')

test('basic api', async (t) => {
  const testnet = await createTestnet()
  const { bootstrap } = testnet
  const peer = await spawnPeer(bootstrap)

  const topic = b4a.alloc(32, 1)
  const discovery = new Discovery(peer.dht, topic, {
    seed: seed(0),
    relayAddresses: () => peer.server.relayAddresses,
    onpeer: noop
  })

  t.is(discovery.active, false, 'inactive')
  discovery.setAnnounce(true)

  const ts = Date.now()
  discovery.refresh()
  await discovery.flush()

  t.is(discovery.active, true, 'active')
  t.ok(discovery.lastRefreshed >= ts)
  t.ok(discovery.lastRefreshed <= Date.now())

  await discovery.destroy()
  t.is(discovery.active, false, 'deactivated')

  await peer.destroy()
  await testnet.destroy()
})

test('announce and emit peers', async (t) => {
  const testnet = await createTestnet()
  const { bootstrap } = testnet

  const topic = b4a.alloc(32, 1)
  const server = await spawnPeer(bootstrap, topic, { announce: true, seed: seed(1) })
  const client = await spawnPeer(bootstrap, topic)

  server.discovery.refresh()

  client.seen.length = 0
  client.discovery.refresh()
  await client.discovery.flush()

  t.is(client.seen.length, 1)
  t.alike(client.seen[0].publicKey, server.discovery.keyPair.publicKey)

  const closestNodes = client.discovery._closestNodes
  const bufferSizes = closestNodes.map((node) => node.id.buffer.byteLength)

  t.ok(bufferSizes.length > 1)

  t.is(bufferSizes[0], 32, 'unslabbed closestNodes entry')
  t.is(
    bufferSizes.filter((size) => size !== 32).length,
    0,
    'sanity check: all closestNodes are unslabbed'
  )

  await client.destroy()
  await server.destroy()
  await testnet.destroy()
})

test('limit option caps number of discovered peers', async (t) => {
  const testnet = await createTestnet()
  const { bootstrap } = testnet

  const topic = b4a.alloc(32, 9)
  const serverA = await spawnPeer(bootstrap, topic, { announce: true, seed: seed(9) })
  const serverB = await spawnPeer(bootstrap, topic, { announce: true, seed: seed(10) })

  serverA.discovery.refresh()
  serverB.discovery.refresh()
  await Promise.all([serverA.discovery.flush(), serverB.discovery.flush()])

  const client = await spawnPeer(bootstrap, topic, { limit: 1 })

  client.discovery.refresh()
  await client.discovery.flush()

  t.is(client.discovery.limit, 1)
  t.is(client.seen.length, 1, 'only one peer discovered due to limit')

  await client.destroy()
  await serverB.destroy()
  await serverA.destroy()
  await testnet.destroy()
})

test('suspend & resume', async (t) => {
  const testnet = await createTestnet()
  const { bootstrap } = testnet

  const topic = b4a.alloc(32, 2)
  const server = await spawnPeer(bootstrap, topic, { announce: true, seed: seed(3) })
  const clientA = await spawnPeer(bootstrap, topic)
  const clientB = await spawnPeer(bootstrap, topic)

  server.discovery.refresh()

  clientA.seen.length = 0
  clientA.discovery.refresh()
  await clientA.discovery.flush()

  t.is(hasPeer(clientA.seen, server.discovery.keyPair.publicKey), true)

  await server.discovery.suspend()
  t.is(server.discovery.suspended, true)

  clientB.seen.length = 0
  clientB.discovery.refresh()
  await clientB.discovery.flush()

  t.is(hasPeer(clientB.seen, server.discovery.keyPair.publicKey), false, 'unannounced')

  await server.discovery.resume()
  await server.discovery.flush()

  clientB.seen.length = 0
  clientB.discovery.refresh()
  await clientB.discovery.flush()

  t.is(hasPeer(clientB.seen, server.discovery.keyPair.publicKey), true, 'reannounced')
  t.is(server.discovery.suspended, false)

  await clientB.destroy()
  await clientA.destroy()
  await server.destroy()
  await testnet.destroy()
})

test('refresh rejects on destroy', async (t) => {
  const testnet = await createTestnet()
  const { bootstrap } = testnet

  const topic = b4a.alloc(32, 3)
  const peer = await spawnPeer(bootstrap, topic, { announce: true, seed: seed(6) })
  const { discovery } = peer

  discovery.refresh()
  await discovery.destroy()

  let err = null
  try {
    discovery.refresh()
  } catch (error) {
    err = error
  }

  t.is(discovery.destroyed, true)
  t.is(err && err.message, 'PeerDiscovery is destroyed')

  await peer.destroy()
  await testnet.destroy()
})

test('abort and restart', async (t) => {
  const testnet = await createTestnet()
  const { bootstrap } = testnet
  const peer = await spawnPeer(bootstrap)

  const topic = b4a.alloc(32, 1)
  const discovery = new Discovery(peer.dht, topic, {
    seed: seed(0),
    relayAddresses: () => peer.server.relayAddresses,
    onpeer: noop
  })

  t.is(discovery.active, false, 'inactive')
  discovery.setAnnounce(true)

  discovery.refresh()
  await discovery.flush()
  t.is(discovery.active, true, 'active')

  discovery.abort(true)
  await discovery.flush()
  t.is(discovery.active, false, 'deactivated')

  discovery.refresh()

  t.is(discovery.active, true, 'reactivated')
  await discovery.flush()

  await discovery.destroy()
  t.is(discovery.active, false, 'destroyed')

  await peer.destroy()
  await testnet.destroy()
})

test('bump api', async (t) => {
  const testnet = await createTestnet()
  const { bootstrap } = testnet
  const peer = await spawnPeer(bootstrap)

  const topic = b4a.alloc(32, 1)
  const discovery = new Discovery(peer.dht, topic, {
    seed: seed(0),
    relayAddresses: () => peer.server.relayAddresses,
    onpeer: noop
  })

  t.is(discovery.bump.announced, -1)
  t.is(discovery.bump.local, -1)
  t.is(discovery.bump.seen, -1)

  discovery.setAnnounce(true, 0)
  t.is(discovery.bump.local, 0)

  discovery.update(77)
  t.is(discovery.bump.local, 77)
  t.is(discovery.bump.announced, -1)

  discovery.refresh()
  await discovery.flush()
  t.is(discovery.bump.announced, 77)

  await discovery.destroy()
  await peer.destroy()
  await testnet.destroy()
})

test('stats', async (t) => {
  const testnet = await createTestnet()
  const { bootstrap } = testnet
  const actions = []
  const peer = await spawnPeer(bootstrap, b4a.alloc(32, 4), {
    onstats(_, action) {
      actions.push(action)
    }
  })

  const { discovery } = peer

  discovery.refresh()
  await discovery.flush()

  t.is(discovery.stats.lookup, 2)
  t.is(discovery.stats.announce, 0)
  t.is(discovery.stats.unannounce, 0)

  discovery.setAnnounce(true)

  discovery.refresh()
  await discovery.flush()
  t.is(discovery.stats.lookup, 2)
  t.is(discovery.stats.announce, 1)
  t.is(discovery.stats.unannounce, 0)

  discovery.setAnnounce(false)

  discovery.refresh()
  await discovery.flush()
  t.is(discovery.stats.lookup, 2)
  t.is(discovery.stats.announce, 1)
  t.is(discovery.stats.unannounce, 1)

  t.alike(actions, ['lookup', 'lookup', 'announce', 'unannounce'])

  await peer.destroy()
  await testnet.destroy()
})

test('parallel announces performs one-time fast-refresh', async (t) => {
  const testnet = await createTestnet()
  const { bootstrap } = testnet
  const topic = b4a.alloc(32, 4)
  const peerA = await spawnPeer(bootstrap, topic, { announce: true, seed: seed(7) })
  const peerB = await spawnPeer(bootstrap, topic, { announce: true, seed: seed(8) })

  peerA.discovery.refresh()
  peerB.discovery.refresh()

  t.is(peerA.seen.length, 0, 'first query misses peer B')
  t.is(peerB.seen.length, 0, 'first query misses peer A')

  await Promise.all([peerA.discovery.flush(), peerB.discovery.flush()])

  t.ok(hasPeer(peerA.seen, peerB.discovery.keyPair.publicKey), 'fastRetry finds B')
  t.ok(hasPeer(peerB.seen, peerA.discovery.keyPair.publicKey), 'fastRetry finds A')

  await peerB.destroy()
  await peerA.destroy()
  await testnet.destroy()
})

test('abort() does not leak dht announces', async (t) => {
  const topic = b4a.alloc(32, 4)
  const oldNodes = [{ id: b4a.alloc(32, 1) }]
  const newNodes = [{ id: b4a.alloc(32, 2) }]

  let release = null
  let onquery = null
  const queryStarted = new Promise((resolve) => {
    onquery = resolve
  })

  const query = {
    closestNodes: newNodes,
    destroy() {
      release()
    },
    async *[Symbol.asyncIterator]() {
      onquery()

      await new Promise((resolve) => {
        release = resolve
      })
    }
  }

  let unannounceCalls = null
  const dht = {
    announce() {
      return query
    },
    async unannounce(topic, keyPair, opts) {
      unannounceCalls = opts.closestNodes
    }
  }

  const discovery = new Discovery(dht, topic, { announce: true, seed: seed(7) })

  discovery._closestNodes = oldNodes
  discovery.refresh()
  await queryStarted

  discovery.suspended = true
  await discovery.abort(true)

  let announced = new Set()
  for (const n of [...oldNodes, ...newNodes]) {
    announced.add(toHex(n.id))
  }
  announced = Array.from(announced)

  const unannounced = unannounceCalls.map((n) => toHex(n.id))

  t.alike(unannounced, announced, 'unannounces old and new closest nodes')
})

test('refresh() and flush()', async (t) => {
  const testnet = await createTestnet()
  const { bootstrap } = testnet
  const topic = b4a.alloc(32, 4)
  const peer = await spawnPeer(bootstrap, topic, { announce: true, seed: seed(7) })

  const { discovery } = peer
  t.is(discovery._queued, 0)

  discovery.refresh()
  t.is(discovery._queued, 1, 'queued')

  discovery.refresh()
  t.is(discovery._queued, 1, 'debounced')

  t.is(discovery._applied, 0, 'work pending')

  const cursor = await discovery.flush()

  t.is(discovery._applied, 1, 'work done')
  t.is(cursor, 1, 'flush snapshots')

  discovery.refresh()
  t.is(discovery._queued, 2, 're-queued')

  await peer.destroy()
  await testnet.destroy()
})

test('refresh(), abort() and flush()', async (t) => {
  const testnet = await createTestnet()
  const { bootstrap } = testnet
  const topic = b4a.alloc(32, 4)
  const peer = await spawnPeer(bootstrap, topic, { announce: true, seed: seed(7) })
  const { discovery } = peer

  const { cork, uncork } = throttleDHT(t, discovery.dht)

  const order = []
  const recordEvent = (ev) => {
    t.comment('event:', ev)
    order.push(ev)
  }

  discovery.refresh()
  const announced = discovery.flush().then((cursor) => {
    recordEvent('announce')
    t.is(cursor, 1)
  })

  t.is(discovery._queued, 1)

  cork()
  discovery.abort(true)

  t.is(discovery._queued, 2, 'abort counts as work')

  const aborted = discovery.flush().then((cursor) => {
    recordEvent('abort')
    t.is(cursor, 2, 'flush snapshots abort')
  })

  await announced
  t.is(discovery._applied, 1, 'announced')
  t.is(discovery._queued, 2, 'abort is inflight')

  discovery.refresh()
  t.is(discovery._queued, 3, 'reannounce queued')

  const reannounced = discovery.flush().then((cursor) => {
    recordEvent('reannounced')
    t.is(cursor, 3, 'reannounce done')
  })

  await aborted

  uncork()

  await reannounced

  t.alike(order, ['announce', 'abort', 'reannounced'])

  await peer.destroy()
  await testnet.destroy()
})

test('abort() noops when inactive', async (t) => {
  t.plan(5)

  const testnet = await createTestnet()
  const { bootstrap } = testnet
  const topic = b4a.alloc(32, 4)
  const peer = await spawnPeer(bootstrap, topic, { announce: true, seed: seed(7) })
  const { discovery } = peer

  t.is(discovery._queued, 0, 'discovery._queued = 0')
  t.absent(discovery.active, 'discovery is inactive')
  await discovery.abort(false, (msg) => t.is(msg, 'Abort skipped', 'got expected log for skipping'))
  t.is(discovery._queued, 0, 'discovery._queued untouched')
  t.absent(discovery.active, 'discovery still inactive')

  await peer.destroy()
  await testnet.destroy()
})

test('abort(false) then destroy() still unannounces', async (t) => {
  const testnet = await createTestnet()
  const { bootstrap } = testnet

  const topic = b4a.alloc(32, 5)
  const server = await spawnPeer(bootstrap, topic, { announce: true, seed: seed(8) })
  const client = await spawnPeer(bootstrap, topic)

  server.discovery.refresh()
  await server.discovery.flush()
  t.is(server.discovery.active, true, 'announce cycle scheduled its next refresh')
  t.is(server.discovery._needsUnannounce, true, 'still owes an unannounce')

  client.discovery.refresh()
  await client.discovery.flush()
  t.is(hasPeer(client.seen, server.discovery.keyPair.publicKey), true, 'announced')

  // stop the refresh cycle without unannouncing, like e.g. a caller pausing discovery
  await server.discovery.abort(false)
  t.is(server.discovery.active, false, 'inactive after abort(false)')
  t.is(server.discovery._needsUnannounce, true, 'unannounce is still owed')

  // destroy()/suspend() both call abort(true, ...) internally to flush that debt
  await server.discovery.destroy()

  client.seen.length = 0
  client.discovery.refresh()
  await client.discovery.flush()
  t.is(hasPeer(client.seen, server.discovery.keyPair.publicKey), false, 'unannounced by destroy()')

  await client.destroy()
  await server.destroy()
  await testnet.destroy()
})

test('setAnnounce() toggle mid-query must not be treated as a failed query', async (t) => {
  const topic = b4a.alloc(32, 12)
  const { dht, started } = makeAbortableDHT()

  const discovery = new Discovery(dht, topic, { announce: true, seed: seed(12) })

  discovery.refresh()
  await started // query is now in flight, holding the mutex

  t.is(discovery.stats.errors, 0, 'no error counted before the toggle')

  // an ordinary, voluntary state change - not a network failure
  discovery.setAnnounce(false)

  await discovery.flush()

  t.is(discovery.stats.errors, 0, 'a voluntary announce toggle is not a query error')

  await discovery.destroy()
})

test('abort() mid-query must not be treated as a failed query', async (t) => {
  const topic = b4a.alloc(32, 13)
  const { dht, started } = makeAbortableDHT()

  const discovery = new Discovery(dht, topic, { announce: true, seed: seed(13) })

  discovery.refresh()
  await started // query is now in flight, holding the mutex

  t.is(discovery.stats.errors, 0, 'no error counted before the abort')

  // abort() is the documented way to pause/cancel discovery - not a failure signal
  await discovery.abort(false)

  t.is(discovery.stats.errors, 0, 'a voluntary abort() is not a query error')

  await discovery.destroy()
})

test('a throwing onpeer must not be treated as a failed query', async (t) => {
  const testnet = await createTestnet()
  const topic = b4a.alloc(32, 14)

  const announcer = await spawnPeer(testnet.bootstrap, topic, { announce: true })
  announcer.discovery.refresh()
  await announcer.discovery.flush()

  const dht = new DHT({ bootstrap: testnet.bootstrap })
  await dht.ready()
  const server = dht.createServer(() => {})
  await server.listen()

  const discovery = new Discovery(dht, topic, {
    relayAddresses: () => server.relayAddresses,
    onpeer: () => {
      throw new Error('consumer bug')
    }
  })

  discovery.refresh()
  await discovery.flush()

  t.is(discovery.stats.errors, 0, 'a consumer callback throwing is not a query error')
  t.is(discovery.stats.refresh, 1, 'the query still completed')

  await discovery.destroy()
  await server.close()
  await dht.destroy()
  await announcer.destroy()
  await testnet.destroy()
})

async function spawnPeer(bootstrap, topic, opts = {}) {
  const dht = new DHT({ bootstrap })
  await dht.ready()

  const server = dht.createServer(() => {})
  await server.listen()

  const seen = []
  const onpeer = (peerInfo) => seen.push(peerInfo)

  const discovery = new Discovery(dht, topic, {
    relayAddresses: () => server.relayAddresses,
    fastRetry: 100,
    ...opts,
    onpeer
  })

  return {
    dht,
    server,
    seen,
    discovery,
    async destroy() {
      await discovery.destroy()
      await server.close()
      if (!dht.destroyed) await dht.destroy()
    }
  }
}

// Mirrors how a real hyperdht/streamx query behaves: destroy() with no error
// still rejects a read that hasn't completed yet, it does not resolve quietly.
function makeAbortableDHT() {
  let rejectCurrent = null
  let onStarted = null
  const started = new Promise((resolve) => {
    onStarted = resolve
  })

  const dht = {
    announce() {
      return {
        closestNodes: [],
        destroy(err) {
          if (rejectCurrent) {
            rejectCurrent(err || new Error('STREAM_DESTROYED (destroy() called without an error)'))
          }
        },
        [Symbol.asyncIterator]() {
          return {
            next() {
              onStarted()
              return new Promise((resolve, reject) => {
                rejectCurrent = reject
              })
            }
          }
        }
      }
    }
  }

  return { dht, started }
}

function seed(byte) {
  return b4a.alloc(32, byte)
}

function hasPeer(peers, publicKey) {
  return peers.some((peer) => b4a.equals(peer.publicKey, publicKey))
}

function noop() {}
