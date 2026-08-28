/*
 * Purpose: Small FIFO async mutex with a high-priority lane for lifecycle/settings barriers.
 */
class PriorityMutex {
  constructor() {
    this.locked = false;
    this.priorityQueue = [];
    this.normalQueue = [];
  }

  get pending() {
    return this.priorityQueue.length + this.normalQueue.length;
  }

  runExclusive(fn, { priority = false } = {}) {
    if (typeof fn !== 'function') {
      return Promise.reject(new TypeError('PriorityMutex requires a function'));
    }

    return new Promise((resolve, reject) => {
      const entry = { fn, resolve, reject };
      if (priority) {
        this.priorityQueue.push(entry);
      } else {
        this.normalQueue.push(entry);
      }
      this.#drain();
    });
  }

  #drain() {
    if (this.locked) {
      return;
    }
    const entry = this.priorityQueue.shift() || this.normalQueue.shift();
    if (!entry) {
      return;
    }

    this.locked = true;
    Promise.resolve()
      .then(entry.fn)
      .then(entry.resolve, entry.reject)
      .finally(() => {
        this.locked = false;
        this.#drain();
      });
  }
}

module.exports = { PriorityMutex };
