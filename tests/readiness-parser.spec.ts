import { describe, expect, it } from 'vitest'
import { createReadinessParser } from '../src/host-supervisor.ts'

describe('createReadinessParser', () => {
  it('parses the canonical readiness line and returns the origin', () => {
    const parser = createReadinessParser()
    expect(parser.push('dsh web: http://127.0.0.1:59273\n')).toBe('http://127.0.0.1:59273')
    expect(parser.finalize()).toBe('http://127.0.0.1:59273')
  })

  it('accumulates partial lines across chunk boundaries', () => {
    const parser = createReadinessParser()
    expect(parser.push('noise\n')).toBeUndefined()
    expect(parser.push('dsh web: http://127.0.0.1:12')).toBeUndefined()
    expect(parser.push('345\n')).toBe('http://127.0.0.1:12345')
  })

  it('ignores a trailing carriage return', () => {
    const parser = createReadinessParser()
    expect(parser.push('dsh web: http://127.0.0.1:3080\r\n')).toBe('http://127.0.0.1:3080')
  })

  it('accepts localhost with an explicit port', () => {
    const parser = createReadinessParser()
    expect(parser.push('dsh web: http://localhost:59273\n')).toBe('http://localhost:59273')
  })

  it('rejects a non-loopback hostname', () => {
    const parser = createReadinessParser()
    expect(() => parser.push('dsh web: http://192.168.1.10:3080\n')).toThrow(/loopback/)
  })

  it('rejects a non-root path, query, or hash', () => {
    for (const url of [
      'dsh web: http://127.0.0.1:3080/session\n',
      'dsh web: http://127.0.0.1:3080/?x=1\n',
      'dsh web: http://127.0.0.1:3080/#a\n',
    ]) {
      const parser = createReadinessParser()
      expect(() => parser.push(url)).toThrow(/loopback HTTP with an explicit port/)
    }
  })

  it('rejects an out-of-range or missing port', () => {
    for (const url of [
      'dsh web: http://127.0.0.1:99999\n',
      'dsh web: http://127.0.0.1:0\n',
      'dsh web: http://127.0.0.1\n',
    ]) {
      const parser = createReadinessParser()
      expect(() => parser.push(url)).toThrow()
    }
  })

  it('rejects an invalid URL token', () => {
    const parser = createReadinessParser()
    expect(() => parser.push('dsh web: not-a-url\n')).toThrow(/invalid/)
  })

  it('rejects conflicting readiness URLs', () => {
    const parser = createReadinessParser()
    parser.push('dsh web: http://127.0.0.1:1000\n')
    expect(() => parser.push('dsh web: http://127.0.0.1:2000\n')).toThrow(/conflicting/)
  })

  it('finalize throws when no readiness line was observed', () => {
    const parser = createReadinessParser()
    parser.push('some noise\n')
    expect(() => parser.finalize()).toThrow(/before emitting/)
  })
})
