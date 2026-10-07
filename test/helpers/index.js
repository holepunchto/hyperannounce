exports.throttleDHT = function throttleDHT(t, dht) {
  const query = dht.query
  let corked = false
  let pending = false

  dht.query = function (...args) {
    if (corked && pending) {
      const err = new Error('DHT query entered while another corked query is running')
      t.fail(err.message)
      throw err
    }

    const result = query.call(this, ...args)
    if (!corked) return result

    pending = true
    return throttleQuery(result, () => {
      pending = false
    })
  }

  return {
    cork () {
      corked = true
    },
    uncork () {
      corked = false
    }
  }
}

function throttleQuery(query, done) {
  return new Proxy(query, {
    get (target, prop, receiver) {
      if (prop !== Symbol.asyncIterator) return Reflect.get(target, prop, receiver)

      return function () {
        return throttleIterator(target[Symbol.asyncIterator](), done)
      }
    }
  })
}

function throttleIterator(iterator, done) {
  return {
    async next () {
      try {
        const result = await iterator.next()
        if (result.done) done()
        return result
      } catch (err) {
        done()
        throw err
      }
    },
    async return () {
      try {
        return await iterator.return()
      } finally {
        done()
      }
    },
    [Symbol.asyncIterator] () {
      return this
    }
  }
}
