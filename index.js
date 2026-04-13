const safetyCatch = require('safety-catch')
const DHT = require('hyperdht')

const b4a = require('b4a')

const REFRESH_INTERVAL = 1000 * 60 * 10 // 10 min
const RANDOM_JITTER = 1000 * 60 * 2 // 2 min
const DELAY_GRACE_PERIOD = 1000 * 30 // 30s

const MAX_DISCOVERY_CACHE = 64

module.exports = class PeerDiscovery {
  constructor(
    dht,
    topic,
    {
      announce = false,
      limit = Infinity,
      wait = null,
      suspended = false,
      onpeer = noop,
      onerror = safetyCatch,
      seed = null,
      keyPair = DHT.keyPair(seed),
      relayAddresses = () => [],
      verbose = false
    } = {}
  ) {
    this.dht = dht
    this.keyPair = keyPair
    this._relayAddresses = relayAddresses
    this._announce = !!announce

    this.limit = limit
    this.topic = topic
    this.destroyed = false
    this.destroying = null
    this.suspended = suspended
    this.lastRefreshed = -1
    this.bump = -1

    this._onpeer = onpeer
    this._onerror = onerror

    this._discovered = new Set()
    this._activeQuery = null
    this._timer = null
    this._currentRefresh = null
    this._closestNodes = null
    this._firstAnnounce = true
    this._needsUnannounce = false
    this._refreshes = 0
    this._wait = wait
    this._verbose = verbose
  }

  get announce() {
    return this._announce
  }

  setAnnounce(announce) {
    announce = !!announce
    if (announce === this._announce) return

    this._announce = announce

    if (this._activeQuery) this._activeQuery.destroy()
  }

  _refreshLater(eager) {
    const jitter = Math.round(Math.random() * RANDOM_JITTER)
    const delay = !eager ? REFRESH_INTERVAL + jitter : jitter

    if (this._timer) clearTimeout(this._timer)

    const startTime = Date.now()
    this._timer = setTimeout(() => {
      // If your laptop went to sleep, and is coming back online...
      const overdue = Date.now() - startTime > delay + DELAY_GRACE_PERIOD
      if (overdue) this._refreshLater(true)
      else this.refresh().catch(this._onerror)
    }, delay)
  }

  _isActive() {
    return !this.destroyed && !this.suspended
  }

  async _refresh() {
    if (this.suspended) return
    const clock = ++this._refreshes

    if (this._wait) {
      await this._wait
      this._wait = null
      if (clock !== this._refreshes || !this._isActive()) return
    }

    const clear = this.announce && this._firstAnnounce
    if (clear) this._firstAnnounce = false

    const opts = {
      clear,
      closestNodes: this._closestNodes
    }

    if (this.announce) this._needsUnannounce = true

    let limit = this.limit

    this._discovered.clear()

    const announcing = this.announce

    let query
    if (announcing) {
      query = this.dht.announce(this.topic, this.keyPair, this._relayAddresses(), opts)
    } else if (this._needsUnannounce) {
      query = this.dht.lookupAndUnannounce(this.topic, this.keyPair, opts)
    } else {
      query = this.dht.lookup(this.topic, opts)
    }

    this._activeQuery = query

    try {
      for await (const data of query) {
        if (!this._isActive()) continue
        if (typeof data.bump === 'number' && data.bump > this.bump) {
          this.bump = data.bump
        }

        for (const peer of data.peers) {
          const id = b4a.toString(peer.publicKey, 'hex')
          const duplicate = this._discovered.has(id)

          if (this._discovered.size < MAX_DISCOVERY_CACHE) {
            this._discovered.add(id)
          }

          if (duplicate) continue

          if (limit < Infinity) {
            if (limit === 0) continue
            limit--
          }

          this._onpeer(peer, data)
        }
      }
    } catch (err) {
      if (this._isActive()) throw err
    } finally {
      if (this._activeQuery === query) {
        this._activeQuery = null
        if (!this.destroyed && !this.suspended) this._refreshLater(false)
      }
    }

    this._closestNodes = query.closestNodes
    this.lastRefreshed = Date.now()

    if (clock !== this._refreshes) return
    if (!announcing) this._needsUnannounce = false
  }

  async refresh() {
    if (this.destroyed) throw new Error('PeerDiscovery is destroyed')

    if (this.suspended) return

    if (this._currentRefresh) return this._currentRefresh
    const refresh = (this._currentRefresh = this._refresh())

    try {
      await refresh
<<<<<<< Updated upstream
    } catch {
      // NOTE: handler squelches errors from onpeer (copy of original)
=======
    } catch (err) {
      // TODO: do not silence onpeer errors
      // https://github.com/holepunchto/hyperswarm/blob/6abaa28a2f3b76b7802b57ff2c677cb63c9131b9/lib/peer-discovery.js#L181
      if (this._verbose) console.error(err)

>>>>>>> Stashed changes
      return false
    } finally {
      if (refresh === this._currentRefresh) {
        this._currentRefresh = null
      }
    }

    return true
  }

  async flushed() {
    await this._wait

    try {
      await this._currentRefresh
      return true
    } catch {
      return false
    }
  }

  destroy() {
    if (this.destroying) return this.destroying
    this.destroying = this._destroy()
    return this.destroying
  }

  async _abort(log = noop) {
    const id = log === noop ? '' : b4a.toString(this.topic, 'hex')

    log('Aborting discovery', id)
    if (this._wait) await this._wait
    log('Aborting discovery (post wait)', id)

    if (this._activeQuery) {
      this._activeQuery.destroy()
      this._activeQuery = null
    }
    if (this._timer) {
      clearTimeout(this._timer)
      this._timer = null
    }

    let nodes = this._closestNodes

    if (this._currentRefresh) {
      try {
        await this._currentRefresh
      } catch {
        // If the destroy causes the refresh to fail, suppress it.
      }
    }

    log('Aborting discovery (post refresh)', id)
    if (this._isActive()) return

    if (!nodes) nodes = this._closestNodes
    else if (this._closestNodes && this._closestNodes !== nodes) {
      const len = nodes.length
      for (const newer of this._closestNodes) {
        if (newer.id && !hasNode(nodes, len, newer)) nodes.push(newer)
      }
    }

    if (this._needsUnannounce) {
      log('Unannouncing discovery', id)
      if (nodes && nodes.length) {
        await this.dht.unannounce(this.topic, this.keyPair, {
          closestNodes: nodes,
          onlyClosestNodes: true,
          force: true
        })
      }
      this._needsUnannounce = false
      log('Unannouncing discovery (done)', id)
    }
  }

  _destroy() {
    if (this.destroyed) return
    this.destroyed = true
    return this._abort(noop)
  }

  async suspend({ log = noop } = {}) {
    if (this.suspended) return
    this.suspended = true
    try {
      await this._abort(log)
    } catch {
      // ignore
    }
  }

  async resume() {
    if (!this.suspended) return
    this.suspended = false
    return this.refresh()
  }
}

function hasNode(nodes, len, node) {
  for (let i = 0; i < len; i++) {
    const existing = nodes[i]
    if (existing.id && b4a.equals(existing.id, node.id)) return true
  }

  return false
}

function noop() {}
