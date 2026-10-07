const { test } = require('brittle')
const b4a = require('b4a')
const DHT = require('hyperdht')
const createTestnet = require('hyperdht/testnet')
const Discovery = require('..')
const { toHex } = b4a

test('basic api', async (t) => {
  const testnet = await createTestnet()
  const { bootstrap } = testnet
  const peer = await spawnPeer(bootstrap)

  const topic = b4a.alloc(32, 1)
  const disc = new Discovery(peer.dht, topic, {
    seed: seed(0),
    relayAddresses: () => peer.server.relayAddresses,
    onpeer: noop
  })

  t.is(disc.active, false, 'inactive')
  disc.setAnnounce(true)

  const ts = Date.now()
  disc.refresh()
  await disc.flush()

  t.is(disc.active, true, 'active')
  t.ok(disc.lastRefreshed >= ts)
  t.ok(disc.lastRefreshed <= Date.now())

  await disc.destroy()
  t.is(disc.active, false, 'deactivated')

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
  const disc = new Discovery(peer.dht, topic, {
    seed: seed(0),
    relayAddresses: () => peer.server.relayAddresses,
    onpeer: noop
  })

  t.is(disc.active, false, 'inactive')
  disc.setAnnounce(true)

  disc.refresh()
  t.is(disc.active, true, 'active')

  await disc.abort()
  t.is(disc.active, false, 'deactivated')

  disc.refresh()

  t.is(disc.active, true, 'reactivated')

  await disc.destroy()
  t.is(disc.active, false, 'destroyed')

  await peer.destroy()
  await testnet.destroy()
})

test('bump api', async (t) => {
  const testnet = await createTestnet()
  const { bootstrap } = testnet
  const peer = await spawnPeer(bootstrap)

  const topic = b4a.alloc(32, 1)
  const disc = new Discovery(peer.dht, topic, {
    seed: seed(0),
    relayAddresses: () => peer.server.relayAddresses,
    onpeer: noop
  })

  t.is(disc.bump.announced, -1)
  t.is(disc.bump.local, -1)
  t.is(disc.bump.seen, -1)

  disc.setAnnounce(true, 0)
  t.is(disc.bump.local, 0)

  disc.update(77)
  t.is(disc.bump.local, 77)
  t.is(disc.bump.announced, -1)

  await disc.refresh()
  await disc.flush()
  t.is(disc.bump.announced, 77)

  await disc.destroy()
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
  await discovery.abort()

  let announced = new Set()
  for (const n of [...oldNodes, ...newNodes]) {
    announced.add(toHex(n.id))
  }
  announced = Array.from(announced)

  const unannounced = unannounceCalls.map((n) => toHex(n.id))

  t.alike(unannounced, announced, 'unannounces old and new closest nodes')
})

test.solo('refresh() and flush()', async (t) => {
  const testnet = await createTestnet()
  const { bootstrap } = testnet
  const topic = b4a.alloc(32, 4)
  const peer = await spawnPeer(bootstrap, topic, { announce: true, seed: seed(7) })

  const disc = peer.discovery
  t.is(disc._queued, 0)

  disc.refresh()
  t.is(disc._queued, 1, 'queued')

  disc.refresh()
  t.is(disc._queued, 1, 'debounced')

  t.is(disc._applied, 0, 'work pending')
  const flushed = disc.flush()

  disc.refresh()
  t.is(disc._queued, 2, 're-queued')

  const cursor = await flushed

  t.is(disc._applied, 1, 'work done')
  t.is(cursor, 1, 'flush snapshots')

  await peer.destroy()
  await testnet.destroy()
})

test.solo('refresh(), abort() and flush()', async (t) => {
  const testnet = await createTestnet()
  const { bootstrap } = testnet
  const topic = b4a.alloc(32, 4)
  const peer = await spawnPeer(bootstrap, topic, { announce: true, seed: seed(7) })
  const disc = peer.discovery

  const order = []
  const recordEvent = (ev) => {
    console.log(ev)
    order.push(ev)
  }

  disc.refresh()
  const announced = disc.flush().then((cursor) => {
    recordEvent('announce')
    t.is(cursor, 1)
  })

  t.is(disc._queued, 1)

  // TODO: abort midflight (delay prior query)
  // TODO: HIGH PRIO - abort should be sync
  disc.abort()

  t.is(disc._queued, 2, 'abort counts as work')

  const aborted = disc.flush().then((cursor) => {
    recordEvent('abort')
    t.is(cursor, 2, 'flush snapshots abort')
  })

  await announced
  t.is(disc._applied, 1, 'annouced')
  t.is(disc._queued, 2, 'abort is inflight')

  disc.refresh()
  t.is(disc._queued, 3, 'reannounce queued')

  const reannounced = disc.flush().then((cursor) => {
    recordEvent('reannounced')
    t.is(cursor, 3, 'reannounce done')
  })

  await aborted

  await reannounced

  console.log(order)
  t.alike(order, ['announce', 'abort', 'reannounce'])

  await peer.destroy()
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

function seed(byte) {
  return b4a.alloc(32, byte)
}

function hasPeer(peers, publicKey) {
  return peers.some((peer) => b4a.equals(peer.publicKey, publicKey))
}

function noop() {}
