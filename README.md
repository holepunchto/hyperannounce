# replicator-discovery

DHT discovery session for [`replicator`](https://github.com:holepunchto/replicator)

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

await discovery.refresh()
await discovery.suspend()
await discovery.resume()
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

### `discovery.setAnnounce(bool, bump = -1)`

Switch mode:

- `true` => announce
- `false` => lookup

For `bump` see `update()`

### `discovery.update(bump)`

Updates the local bump value.
The local value will be published on next refresh when announcing.

### `await discovery.refresh()`

Performs announce/lookup and starts background discovery cycle.

### `await discovery.flushed()`

Wait for the current in-flight refresh.

### `await discovery.abort()`

Abort the active query and stop discovery cycle.
Use `refresh()` to restart.

### `await discovery.suspend()`

Abort the active query and unannounce if needed.

### `await discovery.resume()`

Resume and refresh.

### `await discovery.destroy()`

Destroy permanently.

After destroy, `refresh()` throws `Error('PeerDiscovery is destroyed')`.

## License

Apache-2.0
