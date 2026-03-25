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
- `seed` seed `keyPair`
- `keyPair` announced keyPair
- `relayAddresses()` getter for relay addresses during announce
- `onerror(err)` (`safetycatch`) handler for internal timers
- `limit` (`Infinity`) max peers emitted per refresh
- `suspended` (`false`) initialize as suspended
- `wait` (`null`) promise awaited before refresh starts

Attributes:

- `topic`
- `keyPair`
- `destroyed`
- `suspended`
- `announce`
- `lastRefreshed` timestamp
- `bump` max seen value on dht

### `discovery.setAnnounce(bool)`

Switch mode:

- `true` => announce
- `false` => lookup

### `await discovery.refresh()`

Run the current announce or lookup cycle.

Returns `true` on success, `false` on internal failure.
Throws if called after destroy.

### `await discovery.flushed()`

Wait for the current in-flight refresh.

### `await discovery.suspend()`

Abort the active query and unannounce if needed.

### `await discovery.resume()`

Resume and immediately refresh.

### `await discovery.destroy()`

Destroy permanently.

After destroy, `refresh()` throws `Error('PeerDiscovery is destroyed')`.

## License

Apache-2.0
