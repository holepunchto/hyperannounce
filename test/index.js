const { test } = require('brittle')
const b4a = require('b4a')
const DHT = require('hyperdht')
const createTestnet = require('hyperdht/testnet')
const Discovery = require('..')

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

  disc.setAnnounce(true)

  const ts = Date.now()
  await disc.refresh()
  t.ok(disc.lastRefreshed >= ts)
  t.ok(disc.lastRefreshed <= Date.now())
  t.ok(typeof disc.bump, 'number')

  await disc.suspend()
  await disc.resume()
  await disc.destroy()
  await peer.destroy()
  await testnet.destroy()
})

test('announce and emit peers', async (t) => {
  const testnet = await createTestnet()
  const { bootstrap } = testnet

  const topic = b4a.alloc(32, 1)
  const server = await spawnPeer(bootstrap, topic, { announce: true, seed: seed(1) })
  const client = await spawnPeer(bootstrap, topic)

  await server.discovery.refresh()
  client.seen.length = 0
  await client.discovery.refresh()

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

  await server.discovery.refresh()

  clientA.seen.length = 0
  await clientA.discovery.refresh()
  t.is(hasPeer(clientA.seen, server.discovery.keyPair.publicKey), true)

  await server.discovery.suspend()
  t.is(server.discovery.suspended, true)

  clientB.seen.length = 0
  await clientB.discovery.refresh()
  t.is(hasPeer(clientB.seen, server.discovery.keyPair.publicKey), false, 'unannounced')

  await server.discovery.resume()

  clientB.seen.length = 0
  await clientB.discovery.refresh()
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

  await discovery.refresh()
  await discovery.destroy()
  await discovery.destroy()

  let err = null
  try {
    await discovery.refresh()
  } catch (error) {
    err = error
  }

  t.is(discovery.destroyed, true)
  t.is(err && err.message, 'PeerDiscovery is destroyed')

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
