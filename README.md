# hyperannounce

Stateful hyperdht topic

## Usage

```js
const DHT = require('hyperdht')
const Topic = require('hyperannounce')

const dht = new DHT({ bootstrap })
await dht.ready()

const server = dht.createServer()
await server.listen()

const topic = new Topic(dht, discoveryKey, {
  announce: true,
  seed,
  relayAddresses: () => server.relayAddresses,
  onpeer(peer) {
    console.log(peer.publicKey)
  }
})

topic.refresh()
await topic.flush()

await topic.suspend()
topic.resume()
await topic.destroy()

await server.close()
await dht.destroy()
```

## API

### `new Topic(dht, discoveryKey, opts)`

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

### `topic.setAnnounce(bool, bump = -1)`

Switch mode:

- `true` => announce
- `false` => lookup

For `bump` see `update()`

### `topic.update(bump)`

Updates the local bump value.
The local value will be published on next refresh when announcing.

### `topic.refresh()`

Queues an announce or lookup, also starts background discovery cycle.

### `await topic.flush()`

Waits for any in-flight queries or aborts to settle.

### `topic.abort()`

Abort the active query and stop discovery cycle.
Use `refresh()` to restart.

### `await topic.suspend()`

Abort the active query and unannounce if needed.

### `topic.resume()`

Resume and refresh.

### `await topic.destroy()`

Destroy permanently.

After destroy, `refresh()` throws `Error('Topic is destroyed')`.

## License

Apache-2.0
