# replicator-discovery

DHT discovery session for [`replicator`](https://github.com/holepunchto/replicator)

## Usage

```js
const DHT = require('hyperdht')
const Discovery = require('@holepunchto/replicator-discovery')

const dht = new DHT({ bootstrap })
await dht.ready()

const server = dht.createServer()
await server.listen()

const discovery = new Discovery(dht, topic, {
  announce: true,
  seed,
  relayAddresses: () => server.relayAddresses,
  onpeer(peer) {
    console.log(peer.publicKey)
  }
})

discovery.refresh()
await discovery.flush()

await discovery.suspend()
discovery.resume()
await discovery.destroy()

await server.close()
await dht.destroy()
```

## API

### `new Discovery(dht, topic, opts)`

Options:

- `announce` (`false`) see `setAnnounce`
- `onpeer(peer, data)` peer info callback during lookup
- `onstats(stats, action)` invoked before DHT query, `action` is `lookup|announce|unannounce`
- `seed` seed `keyPair`
- `keyPair` announced keyPair
- `relayAddresses()` getter for relay addresses during announce
- `onerror(err)` error-handler for internal timers
- `onbump(number)` invoked when higher number is seen
- `limit` (`Infinity`) max peers emitted per refresh
- `suspended` (`false`) initialize as suspended
- `wait` (`null`) promise awaited before refresh starts

Attributes:

- `topic`
- `keyPair`
- `destroyed`
- `suspended`
- `announce`
- `active` refresh cycle is alive
- `lastRefreshed` timestamp
- `bump.local` local value
- `bump.announced` announced value
- `bump.seen` max seen remote value
- `stats.lookup` number of DHT lookups
- `stats.announce` number of DHT announces
- `stats.unannounce` number of DHT unannounces
- `stats.refresh` number of completed refresh queries
- `stats.errors` number of errors on refresh()

### `discovery.setAnnounce(bool, bump = -1)`

Switch mode:

- `true` => announce
- `false` => lookup

For `bump` see `update()`

### `discovery.update(bump)`

Updates the local bump value.
The local value will be published on next refresh when announcing.

### `discovery.refresh()`

Queues an announce or lookup, also starts background discovery cycle.

### `await discovery.flush()`

Waits for any in-flight queries or aborts to settle.

### `discovery.abort()`

Abort the active query and stop discovery cycle.
Use `refresh()` to restart.

### `await discovery.suspend()`

Abort the active query and unannounce if needed.

### `discovery.resume()`

Resume and refresh.

### `await discovery.destroy()`

Destroy permanently.

After destroy, `refresh()` throws `Error('PeerDiscovery is destroyed')`.

## License

Apache-2.0
