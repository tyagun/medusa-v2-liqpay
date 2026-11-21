/** Bounded, process-local admission control. Hosts must also enforce cluster-wide limits. */
export class RequestLimit {
  private readonly buckets = new Map<string, { count: number; until: number }>()
  constructor(private readonly limit: number, private readonly windowMs: number,
    private readonly capacity = 4096) {}

  allow(key: string, now = Date.now()): boolean {
    const bucket = this.buckets.get(key)
    if (bucket && bucket.until > now) {
      if (bucket.count >= this.limit) return false
      bucket.count++
      return true
    }
    if (this.buckets.size >= this.capacity) {
      for (const [id, value] of this.buckets) if (value.until <= now) this.buckets.delete(id)
      if (this.buckets.size >= this.capacity) return false
    }
    this.buckets.set(key, { count: 1, until: now + this.windowMs })
    return true
  }
}
